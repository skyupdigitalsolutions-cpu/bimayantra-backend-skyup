/** Module 10 Stage 1 — P-27 create a normal quotation, and the pricing engine (Section 11, GR-24). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, err, login, newMobile, registerAdvisor, resetState, startTestEnv, stepUp, stopTestEnv } from './helpers.js';
import { clock, istToday } from '../src/lib/clock.js';
import { calculate, roundHalfUp } from '../src/modules/quotations/engine.js';
import { Insurer } from '../src/modules/insurers/insurer.model.js';
import { InsuranceType, TemplateVersion } from '../src/modules/catalogue/types.model.js';
import { StoredFile } from '../src/modules/files/file.model.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(async () => { clock.setOffset(0); await resetState(); });

const day = (n: number) => { const d = new Date(`${istToday()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); const iso = d.toISOString().slice(0, 10); return iso.split('-').reverse().join('-'); };
const year = Number(istToday().slice(0, 4));

describe('engine (GR-24)', () => {
  it('order base → riders → override → discount → GST; rounded once, half-up, to the paisa (AC-P27-2)', () => {
    const b = calculate({ mode: 'RATE_TABLE', base: 12345.67, riders: [{ name: 'OPD', priceType: 'PERCENT', value: 7.5 }, { name: 'Room', priceType: 'FIXED', value: 999.99 }], taxPercent: 18, discount: { kind: 'PERCENT', value: 2.5, reference: 'Diwali' } });
    // by hand: riders 925.92525 + 999.99 = 1925.91525; before 14271.58525; discount 356.78963125; after 13914.79561875; tax 2504.663211375; total 16419.458830125 → 16419.46
    expect(b.ridersTotal).toBeCloseTo(1925.91525, 9);
    expect(b.final).toBe(16419.46);
    expect(roundHalfUp(1.005)).toBe(1.01);
    expect(roundHalfUp(2.675)).toBe(2.68);
  });
  it('override replaces base + riders and keeps the calculated amount; discount limits QT-09, QT-37', () => {
    const b = calculate({ mode: 'RATE_TABLE', base: 10000, riders: [], taxPercent: 18, override: { amount: 9000, reason: 'Insurer portal' } });
    expect(b).toMatchObject({ calculated: 10000, override: 9000, beforeDiscount: 9000, final: 10620 });
    expect(() => calculate({ mode: 'RATE_TABLE', base: 1000, riders: [], taxPercent: 18, discount: { kind: 'AMOUNT', value: 1500, reference: 'x' } })).toThrow('QT-09');
    expect(() => calculate({ mode: 'RATE_TABLE', base: 1000, riders: [], taxPercent: 18, discount: { kind: 'AMOUNT', value: 100, reference: ' ' } })).toThrow('QT-37');
    expect(calculate({ mode: 'MANUAL_ENTRY', base: 21000, riders: [], taxAmount: 3780 }).final).toBe(24780);
  });
});

async function world() {
  const ins = await Insurer.create({ name: 'Alpha Health', nameKey: 'alpha health', shortCode: 'ALPHA', category: 'Standalone Health', irdaiRegNo: 'R-1', paymentDomains: ['alpha.in'], status: 'ACTIVE' });
  const other = await Insurer.create({ name: 'Beta Health', nameKey: 'beta health', shortCode: 'BETA', category: 'Standalone Health', irdaiRegNo: 'R-2', paymentDomains: ['beta.in'], status: 'ACTIVE' });
  const type = await InsuranceType.create({ name: 'Health', nameKey: 'health' });
  await TemplateVersion.create({ typeId: type._id, number: 1, status: 'ACTIVE', isOpen: null, makerId: 'x', features: [],
    factors: [{ key: 'age', name: 'Age of eldest', kind: 'BAND', source: 'Age of the eldest insured person', bands: [{ from: 18, to: 35 }, { from: 36, to: 65 }] }],
    questions: [{ key: 'smoker', label: 'Does anyone smoke?', dataType: 'Yes/No', required: true }] });
  const adv = await registerAdvisor('Asha Rao');
  const A = as(adv.token);
  const p = (await A.get('/profile')).body.data;
  await A.put('/profile/professional', { version: p.sections.professional.version, categories: ['Health'], licenceNumber: 'IRDA-123', licenceValidUntil: day(400) });
  await A.post('/my-insurers', { insurerId: ins._id, agentCode: 'AG-77', declaration: true });
  const data = { name: 'Family Shield', uin: 'UIN0001', launchDate: '01-01-2026', adultMin: 18, adultMax: 65, coversChildren: true, childMin: 0, childMax: 25, sumInsured: { options: [500000, 1000000] }, policyTerms: [1, 2], taxPercent: 18,
    addOns: [{ name: 'OPD cover', priceType: 'PERCENT', value: 10 }, { name: 'Room upgrade', priceType: 'FIXED', value: 1200 }] };
  const prod = (await A.post('/my-products', { insurerId: ins._id, typeId: type._id, code: 'FS', data: { ...data, pricingMode: 'RATE_TABLE' } })).body.data;
  await A.post(`/products/${prod.id}/prices`, { effectiveFrom: day(0), taxPercent: 18, rows: [{ factors: { age: '18-35' }, basePremium: 12000 }, { factors: { age: '36-65' }, basePremium: 21000.5 }] });
  const manual = (await A.post('/my-products', { insurerId: ins._id, typeId: type._id, code: 'MAN', data: { ...data, name: 'Manual Plan', pricingMode: 'MANUAL_ENTRY' } })).body.data;
  const cus = (await A.post('/customers', { name: 'Meena Iyer', mobile: newMobile(), dob: `15-04-${year - 40}` })).body.data;
  const son = (await A.post(`/customers/${cus.id}/family`, { name: 'Arjun Iyer', relationship: 'Son', dob: `10-06-${year - 9}` })).body.data;
  const grandpa = (await A.post(`/customers/${cus.id}/family`, { name: 'Ravi Iyer', relationship: 'Father', dob: `01-01-${year - 70}` })).body.data;
  return { adv, A, ins: ins._id as string, other: other._id as string, typeId: type._id as string, productId: prod.id as string, manualId: manual.id as string, cus, son, grandpa };
}
type W = Awaited<ReturnType<typeof world>>;
const INPUTS = (w: W) => ({ typeId: w.typeId, insurerId: w.ins, productId: w.productId, people: [`C:${w.cus.id}`, `F:${w.son.id}`], sumInsured: 500000, policyTerm: 1, startDate: day(1), answers: { smoker: false }, riders: ['OPD cover', 'Room upgrade'] });
async function draft(w: W, inputs: object, step = 9) {
  const q = (await w.A.post('/quotations', { customerId: w.cus.id })).body.data;
  return w.A.patch(`/quotations/${q.id}`, { version: q.version, step, inputs });
}

describe('P-27 create a normal quotation', () => {
  it('AC-P27-1 / AC-P27-2: Generate gives QT-YYYYMM-00001 R1, a frozen snapshot and a PDF; the premium matches the rate table to the paisa', async () => {
    const w = await world();
    const d = (await draft(w, INPUTS(w))).body.data;
    expect(d.step).toBe(9);
    const c = (await w.A.post(`/quotations/${d.id}/calculate`, {})).body.data;
    // eldest 40 → 21,000.50; OPD 10% 2,100.05; room 1,200 → 24,300.55; GST 18% 4,374.099 → 28,674.649 → 28,674.65
    expect(c.calc.breakdown).toMatchObject({ base: 21000.5, ridersTotal: 3300.05, final: 28674.65 }); // riders 2,100.05 + 1,200
    const g = await w.A.post(`/quotations/${d.id}/generate`, {});
    expect(g.status).toBe(200);
    const num = `QT-${istToday().slice(0, 4)}${istToday().slice(5, 7)}-00001`;
    expect(g.body.meta.message).toBe(`Quotation ${num} R1 is ready. Share it with Meena Iyer.`);
    expect(g.body.data).toMatchObject({ number: num, status: 'READY', revisions: [{ revision: 1, status: 'READY', final: 28674.65 }] });
    const snap = (await w.A.get(`/quotations/${d.id}/revisions/1`)).body.data;
    expect(snap).toMatchObject({ number: num, revision: 1, insurer: { name: 'Alpha Health' }, advisor: { agentCode: 'AG-77', licenceNumber: 'IRDA-123' }, product: { uin: 'UIN0001' } });
    expect(snap.people.map((x: { name: string; age: number }) => `${x.name}:${x.age}`)).toEqual(expect.arrayContaining([expect.stringMatching(/^Meena Iyer:(39|40)$/), expect.stringMatching(/^Arjun Iyer:(8|9)$/)]));
    expect(snap.disclaimer).toMatch(/^This quotation is based on the details you shared/);
    const pdf = await StoredFile.findById(g.body.data.revisions[0].pdfFileId).lean();
    expect(pdf).toMatchObject({ purpose: 'QUOTATION_PDF', type: 'PDF' });
  });

  it('AC-P27-3: changing an add-on after the premium was shown clears it, so it is worked out again', async () => {
    const w = await world();
    const d = (await draft(w, INPUTS(w))).body.data;
    const c = (await w.A.post(`/quotations/${d.id}/calculate`, {})).body.data;
    const changed = (await w.A.patch(`/quotations/${d.id}`, { version: c.version, step: 9, inputs: { riders: ['Room upgrade'] } })).body.data;
    expect(changed.calc).toBeNull();
    const g = await w.A.post(`/quotations/${d.id}/generate`, {});
    expect(err(g)).toMatchObject({ status: 409, messageId: 'QT-10' }); // never generated on a premium nobody saw
  });

  it('AC-P27-4 (QT-06) a person outside the entry ages; QT-05 without a date of birth; AC-P27-7 the draft keeps its step', async () => {
    const w = await world();
    const r = await draft(w, { ...INPUTS(w), people: [`C:${w.cus.id}`, `F:${w.grandpa.id}`] }, 7);
    expect(r.body.error.fields[0]).toMatchObject({ field: 'people', messageId: 'QT-06' });
    expect(r.body.error.fields[0].message).toMatch(/^Ravi Iyer is (69|70)\. This product accepts ages 18 to 65\.$/);
    const id = (await w.A.get('/quotations')).body.data[0].id;
    expect((await w.A.get(`/quotations/${id}`)).body.data).toMatchObject({ step: 2, inputs: { people: [`C:${w.cus.id}`, `F:${w.grandpa.id}`] } }); // saved, still at step 2
  });

  it('AC-P27-5: a discount above the premium is QT-09; without a reference QT-37; assistants cannot override or discount (GEN-03)', async () => {
    const w = await world();
    const d = (await draft(w, { ...INPUTS(w), discount: { kind: 'AMOUNT', value: 999999, reference: 'Special' } })).body.data;
    expect(err(await w.A.post(`/quotations/${d.id}/calculate`, {}))).toMatchObject({ messageId: 'QT-09' });
    const d2 = (await draft(w, { ...INPUTS(w), discount: { kind: 'PERCENT', value: 5, reference: '' } })).body.data;
    expect(err(await w.A.post(`/quotations/${d2.id}/calculate`, {}))).toMatchObject({ messageId: 'QT-37' });
    const m = newMobile();
    await w.A.post('/assistants', { name: 'Priya Shah', mobile: m }, { 'X-Step-Up-Token': await stepUp(w.adv.token, w.adv.mobile) });
    const ast = as((await login(m)).token);
    const q = (await ast.post('/quotations', { customerId: w.cus.id })).body.data;
    expect(err(await ast.patch(`/quotations/${q.id}`, { version: q.version, step: 9, inputs: { ...INPUTS(w), override: { amount: 1000, reason: 'x' } } }))).toMatchObject({ status: 403, messageId: 'GEN-03' });
  });

  it('AC-P27-6: a price version starting between calculation and Generate gives QT-10 with old and new', async () => {
    const w = await world();
    const d = (await draft(w, INPUTS(w))).body.data;
    await w.A.post(`/quotations/${d.id}/calculate`, {});
    await w.A.post(`/products/${w.productId}/prices`, { effectiveFrom: day(1), taxPercent: 18, rows: [{ factors: { age: '18-35' }, basePremium: 13000 }, { factors: { age: '36-65' }, basePremium: 23000 }] });
    clock.setOffset(86_400_000);
    const s = await login(w.adv.mobile);
    const g = await as(s.token).post(`/quotations/${d.id}/generate`, {});
    expect(err(g)).toMatchObject({ status: 409, messageId: 'QT-10' });
    expect(g.body.error.details).toMatchObject({ old: 28674.65 });
    expect(g.body.error.details.new).toBeGreaterThan(28674.65);
  });

  it('AC-P27-8: an insurer without an active agent code is not offered and is refused (QT-12); a double click on Generate gives one quotation', async () => {
    const w = await world();
    const ch = (await w.A.get('/quotations/choices')).body.data;
    expect(ch.insurers.map((i: { name: string }) => i.name)).toEqual(['Alpha Health']);
    const bad = await draft(w, { ...INPUTS(w), insurerId: w.other }, 5);
    expect(bad.body.error.fields[0]).toMatchObject({ messageId: 'QT-12' });
    expect(bad.body.error.fields[0].message).toBe('You have not added Beta Health with an active agent code. Add it in Settings → My insurers.');
    const d = (await draft(w, INPUTS(w))).body.data;
    await w.A.post(`/quotations/${d.id}/calculate`, {});
    const key = { 'Idempotency-Key': 'gen-0001' };
    const [a, b] = [await w.A.post(`/quotations/${d.id}/generate`, {}, key), await w.A.post(`/quotations/${d.id}/generate`, {}, key)];
    expect(a.status).toBe(200);
    expect(err(b)).toMatchObject({ messageId: 'GEN-06' });
    expect((await w.A.get(`/quotations/${d.id}`)).body.data.revisions).toHaveLength(1);
  });

  it('MANUAL_ENTRY: the net premium and tax typed from the insurer portal', async () => {
    const w = await world();
    const d = (await draft(w, { ...INPUTS(w), productId: w.manualId, riders: [], manual: { netPremium: 21000, taxAmount: 3780 } })).body.data;
    expect((await w.A.post(`/quotations/${d.id}/calculate`, {})).body.data.calc.breakdown.final).toBe(24780);
    expect((await w.A.post(`/quotations/${d.id}/generate`, {})).body.data.status).toBe('READY');
  });
});