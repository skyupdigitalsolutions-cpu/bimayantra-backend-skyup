/** Module 10 Stage 3 — P-30 comparison quotations. */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, as, err, newMobile, registerAdvisor, resetState, startTestEnv, stopTestEnv } from './helpers.js';
import { istToday } from '../src/lib/clock.js';
import { Insurer } from '../src/modules/insurers/insurer.model.js';
import { InsuranceType, TemplateVersion } from '../src/modules/catalogue/types.model.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

const day = (n: number) => { const d = new Date(`${istToday()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10).split('-').reverse().join('-'); };
const year = Number(istToday().slice(0, 4));

async function world() {
  const a = await Insurer.create({ name: 'Alpha Health', nameKey: 'alpha health', shortCode: 'ALPHA', category: 'Standalone Health', irdaiRegNo: 'R-1', paymentDomains: ['alpha.in'], status: 'ACTIVE' });
  const b = await Insurer.create({ name: 'Beta Health', nameKey: 'beta health', shortCode: 'BETA', category: 'Standalone Health', irdaiRegNo: 'R-2', paymentDomains: ['beta.in'], status: 'ACTIVE' });
  const type = await InsuranceType.create({ name: 'Health', nameKey: 'health' });
  await TemplateVersion.create({ typeId: type._id, number: 1, status: 'ACTIVE', isOpen: null, makerId: 'x',
    features: [{ key: 'room_rent', name: 'Room rent limit', group: 'Limits and sub-limits', dataType: 'Text', requiredToPublish: false, order: 1 }, { key: 'csr', name: 'Claim settlement ratio', group: 'Other', dataType: 'Percentage', requiredToPublish: false, order: 2 }],
    factors: [{ key: 'age', name: 'Age', kind: 'BAND', source: 'Age of the eldest insured person', bands: [{ from: 0, to: 35 }, { from: 36, to: 75 }] }] });
  const adv = await registerAdvisor('Asha Rao');
  const A = as(adv.token);
  let p = (await A.get('/profile')).body.data;
  await A.put('/profile/professional', { version: p.sections.professional.version, advisorType: 'POSP', categories: ['Health'], licenceNumber: 'POSP-1', licenceValidUntil: day(400) });
  p = (await A.get('/profile')).body.data;
  await A.put('/profile/personal', { version: p.sections.personal.version, dob: '15-04-1988' });
  await A.put('/profile/contact', { version: p.sections.contact.version, email: 'asha@example.com', address1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' });
  await A.post('/my-insurers', { insurerId: a._id, agentCode: 'AG-ALPHA', declaration: true });
  await A.post('/my-insurers', { insurerId: b._id, agentCode: 'AG-BETA', declaration: true });
  const base = { uin: 'UIN1', launchDate: '01-01-2026', adultMin: 18, adultMax: 75, coversChildren: true, childMin: 0, childMax: 25, sumInsured: { options: [500000] }, policyTerms: [1], taxPercent: 18, pricingMode: 'RATE_TABLE' };
  const mk = async (insurerId: string, code: string, data: object, prem: number[]) => {
    const pr = (await A.post('/my-products', { insurerId, typeId: type._id, code: code.toUpperCase().replace(/\s+/g, '-'), data: { ...base, name: code, ...data } })).body.data;
    await A.post(`/products/${pr.id}/prices`, { effectiveFrom: day(0), taxPercent: 18, rows: [{ factors: { age: '0-35' }, basePremium: prem[0] }, { factors: { age: '36-75' }, basePremium: prem[1] }] });
    return pr.id as string;
  };
  const p1 = await mk(a._id, 'Alpha Gold', { features: { room_rent: { value: 'No limit' }, csr: { value: 97 } } }, [8000, 15000]);
  const p2 = await mk(b._id, 'Beta Silver', { features: { room_rent: { value: 'Single private room' } } }, [7000, 12000]); // claim ratio missing
  const p3 = await mk(b._id, 'Beta Senior Lite', { adultMax: 60, features: {} }, [5000, 9000]); // grandma 70 is outside
  const cus = (await A.post('/customers', { name: 'Meena Iyer', mobile: newMobile(), dob: `15-04-${year - 40}` })).body.data;
  const son = (await A.post(`/customers/${cus.id}/family`, { name: 'Arjun Iyer', relationship: 'Son', dob: `10-06-${year - 9}` })).body.data;
  const gm = (await A.post(`/customers/${cus.id}/family`, { name: 'Lakshmi Iyer', relationship: 'Mother', dob: `01-01-${year - 70}` })).body.data;
  const inputs = { typeId: type._id, people: [`C:${cus.id}`, `F:${son.id}`, `F:${gm.id}`], sumInsured: 500000, policyTerm: 1, startDate: day(1) };
  return { adv, A, cus, inputs, p1, p2, p3, typeId: type._id as string };
}
type W = Awaited<ReturnType<typeof world>>;
async function draft(w: W, productIds: string[], extra: object = {}) {
  const start = await w.A.post('/comparisons', { customerId: w.cus.id });
  const c = start.body.data;
  return (await w.A.put(`/comparisons/${c.id}`, { version: c.version, inputs: w.inputs, options: productIds.map((productId) => ({ productId })), ...extra })).body;
}

describe('P-30 comparison quotations', () => {
  it('AC-P30-1: fewer than 2 or more than 3 products is refused (QT-30); the same product twice is QT-36', async () => {
    const w = await world();
    const one = (await draft(w, [w.p1])).data;
    expect(err(await w.A.post(`/comparisons/${one.id}/generate`, {}))).toMatchObject({ messageId: 'QT-30' });
    const dup = await draft(w, [w.p1, w.p1]);
    expect(dup.error.fields[0]).toMatchObject({ messageId: 'QT-36' });
  });

  it('AC-P30-2/7/8/9: one sum insured; lowest flagged among full-cover options; partial cover labelled QT-41; missing facts "Not stated by insurer"; agent codes', async () => {
    const w = await world();
    const c = (await draft(w, [w.p1, w.p2, w.p3])).data;
    const t = (await w.A.post(`/comparisons/${c.id}/preview`, {})).body.data;
    const by = Object.fromEntries(t.columns.map((x: { name: string }) => [x.name, x]));
    expect(by['Alpha Gold']).toMatchObject({ premium: 17700, agentCode: 'AG-ALPHA', covers: 3, of: 3, lowest: false });
    expect(by['Beta Silver']).toMatchObject({ premium: 14160, agentCode: 'AG-BETA', lowest: true }); // cheapest that covers everyone
    expect(by['Beta Senior Lite']).toMatchObject({ covers: 2, of: 3, lowest: false }); // cheaper, but never "cheaper" — it covers fewer
    expect(by['Beta Senior Lite'].coverage.message).toBe('Covers 2 of 3 selected people. Not covered: Lakshmi Iyer (outside its age limits).');
    expect(t.rows[0]).toEqual({ label: 'Sum insured', values: [500000, 500000, 500000] });
    const csr = t.rows.find((r: { label: string }) => r.label === 'Claim settlement ratio');
    expect(csr.values).toEqual(['97', 'Not stated by insurer', 'Not stated by insurer']);
  });

  it('AC-P30-6: a recommendation needs a reason of CFG-157 characters (QT-40); Generate gives CQ-YYYYMM-00001 with a PDF (QT-33)', async () => {
    const w = await world();
    const c = (await draft(w, [w.p1, w.p2], { recommendedProductId: w.p1, recommendedReason: 'Short' })).data;
    const r = await w.A.post(`/comparisons/${c.id}/generate`, {});
    expect(r.body.error.fields[0]).toMatchObject({ field: 'recommendedReason', messageId: 'QT-40' });
    expect(r.body.error.fields[0].message).toBe('Write the reason for recommending Alpha Gold.');
    const c2 = (await draft(w, [w.p1, w.p2], { recommendedProductId: w.p1, recommendedReason: 'No room-rent limit and a 97% claim ratio.' })).data;
    const g = await w.A.post(`/comparisons/${c2.id}/generate`, {});
    const num = `CQ-${istToday().slice(0, 4)}${istToday().slice(5, 7)}-00001`;
    expect(g.body.meta.message).toBe(`Comparison ${num} is ready. Share it with Meena Iyer.`);
    expect(g.body.data).toMatchObject({ number: num, status: 'READY' });
    expect(g.body.data.pdfFileId).toBeTruthy();
  });

  it('AC-P30-3/4/5: choosing creates a separate QT quotation (P-27 recalculates); statuses stay independent; no payment link', async () => {
    const w = await world();
    const c = (await draft(w, [w.p1, w.p2])).data;
    await w.A.post(`/comparisons/${c.id}/generate`, {});
    const shared = await w.A.post(`/comparisons/${c.id}/share`, { channel: 'LINK' });
    expect(shared.body.data.comparison.status).toBe('SHARED');
    const pub = (await request(app).get(`/v1/public/c/${shared.body.data.link.split('/c/')[1]}`)).body.data;
    expect(pub.valid).toBe(true);
    expect(JSON.stringify(pub)).not.toMatch(/payment/i); // AC-P30-5
    const cur = (await w.A.get(`/comparisons/${c.id}`)).body.data;
    const ch = await w.A.post(`/comparisons/${c.id}/choose`, { version: cur.version, productId: w.p2 });
    expect(ch.body.meta.message).toBe("Meena Iyer's choice is saved. Create the quotation for Beta Silver now?");
    const q = (await w.A.post(`/comparisons/${c.id}/create-quotation`, {})).body.data;
    expect(q).toMatchObject({ status: 'DRAFT', number: null, calc: null }); // never copies the comparison's premium
    expect(q.inputs).toMatchObject({ productId: w.p2, sumInsured: 500000 });
    await w.A.post(`/quotations/${q.id}/calculate`, {});
    const g = (await w.A.post(`/quotations/${q.id}/generate`, {})).body.data;
    expect(g.number).toMatch(/^QT-\d{6}-00001$/);
    expect((await w.A.get(`/comparisons/${c.id}`)).body.data.status).toBe('PRODUCT_CHOSEN'); // unchanged by the quotation
  });

  it('QT-31: products of a different insurance type are refused', async () => {
    const w = await world();
    const motor = await InsuranceType.create({ name: 'Motor', nameKey: 'motor' });
    const c = (await draft(w, [w.p1, w.p2])).data;
    const u = await w.A.put(`/comparisons/${c.id}`, { version: c.version, inputs: { ...w.inputs, typeId: motor._id }, options: [{ productId: w.p1 }, { productId: w.p2 }] });
    expect(err(await w.A.post(`/comparisons/${u.body.data.id}/generate`, {}))).toMatchObject({ status: 400 });
  });
});