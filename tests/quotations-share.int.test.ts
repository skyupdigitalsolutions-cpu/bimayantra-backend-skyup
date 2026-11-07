/** Module 10 Stage 2 — P-28 share a quotation; P-29 revise, accept, reject, cancel, expire. */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, as, err, login, newMobile, registerAdvisor, resetState, startTestEnv, stopTestEnv } from './helpers.js';
import { clock, istToday } from '../src/lib/clock.js';
import { Insurer } from '../src/modules/insurers/insurer.model.js';
import { InsuranceType, TemplateVersion } from '../src/modules/catalogue/types.model.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { expireDue } from '../src/modules/quotations/lifecycle.service.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(async () => { clock.setOffset(0); await resetState(); });

const day = (n: number, iso = false) => { const d = new Date(`${istToday()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); const s = d.toISOString().slice(0, 10); return iso ? s : s.split('-').reverse().join('-'); };
const year = Number(istToday().slice(0, 4));

async function world(completeProfile = true) {
  const ins = await Insurer.create({ name: 'Alpha Health', nameKey: 'alpha health', shortCode: 'ALPHA', category: 'Standalone Health', irdaiRegNo: 'R-1', paymentDomains: ['alpha.in'], status: 'ACTIVE' });
  const type = await InsuranceType.create({ name: 'Health', nameKey: 'health' });
  await TemplateVersion.create({ typeId: type._id, number: 1, status: 'ACTIVE', isOpen: null, makerId: 'x', features: [], factors: [{ key: 'age', name: 'Age', kind: 'BAND', source: 'Age of the eldest insured person', bands: [{ from: 18, to: 65 }] }] });
  const adv = await registerAdvisor('Asha Rao');
  const A = as(adv.token);
  let p = (await A.get('/profile')).body.data;
  await A.put('/profile/professional', { version: p.sections.professional.version, advisorType: 'POSP', categories: ['Health'], licenceNumber: 'POSP-1', licenceValidUntil: day(400) });
  if (completeProfile) {
    p = (await A.get('/profile')).body.data;
    await A.put('/profile/personal', { version: p.sections.personal.version, dob: '15-04-1988' });
    await A.put('/profile/contact', { version: p.sections.contact.version, email: 'asha@example.com', address1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' });
  }
  await A.post('/my-insurers', { insurerId: ins._id, agentCode: 'AG-77', declaration: true });
  const prod = (await A.post('/my-products', { insurerId: ins._id, typeId: type._id, code: 'FS', data: { name: 'Family Shield', uin: 'UIN0001', launchDate: '01-01-2026', adultMin: 18, adultMax: 65, sumInsured: { options: [500000] }, policyTerms: [1], taxPercent: 18, pricingMode: 'RATE_TABLE' } })).body.data;
  await A.post(`/products/${prod.id}/prices`, { effectiveFrom: day(0), taxPercent: 18, rows: [{ factors: { age: '18-65' }, basePremium: 10000 }] });
  const cus = (await A.post('/customers', { name: 'Meena Iyer', mobile: newMobile(), email: 'meena@example.com', dob: `15-04-${year - 40}` })).body.data;
  const q0 = (await A.post('/quotations', { customerId: cus.id })).body.data;
  const d = (await A.patch(`/quotations/${q0.id}`, { version: q0.version, step: 9, inputs: { typeId: type._id, insurerId: ins._id, productId: prod.id, people: [`C:${cus.id}`], sumInsured: 500000, policyTerm: 1, startDate: day(1) } })).body.data;
  await A.post(`/quotations/${d.id}/calculate`, {});
  const q = (await A.post(`/quotations/${d.id}/generate`, {})).body.data;
  return { adv, A, q, productId: prod.id as string };
}
const share = (w: { A: ReturnType<typeof as>; q: { id: string } }, channel: string) => w.A.post(`/quotations/${w.q.id}/share`, { channel });

describe('P-28 share', () => {
  it('AC-P28-1 / AC-P28-2: the first share sets SHARED and the expiry (end of day +15); a later share keeps it; Download does not start it', async () => {
    const w = await world();
    const dl = await share(w, 'DOWNLOAD');
    expect(dl.body.data.quotation.status).toBe('READY');
    const first = await share(w, 'LINK');
    expect(first.body.meta.message).toBe('Copied.');
    expect(first.body.data.quotation).toMatchObject({ status: 'SHARED', revisions: [{ validUntil: day(15, true) }] });
    const firstExpiry = first.body.data.quotation.revisions[0].validUntil;
    expect(first.body.data.link).toMatch(/\/q\/[A-Za-z0-9_-]{43}$/);
    clock.setOffset(3 * 86_400_000);
    const s = await login(w.adv.mobile);
    const wa = await as(s.token).post(`/quotations/${w.q.id}/share`, { channel: 'WHATSAPP' });
    expect(wa.body.meta.message).toBe('WhatsApp opened with your message. Press send in WhatsApp to share it.');
    expect(wa.body.data.whatsappUrl).toMatch(/^https:\/\/wa\.me\/91\d{10}\?text=/);
    expect(wa.body.data.quotation.revisions[0].validUntil).toBe(firstExpiry); // a later share never extends it
  });

  it('AC-P28-3: missing profile items block sharing with PRF-03', async () => {
    const w = await world(false);
    const r = await share(w, 'LINK');
    expect(err(r)).toMatchObject({ status: 409, messageId: 'PRF-03' });
    expect(r.body.error.message).toMatch(/^To share quotations, first add: .*Date of birth.*Email/);
  });

  it('AC-P28-4: the customer view link shows the quotation, records the view, and shows QT-20 after expiry', async () => {
    const w = await world();
    const token = (await share(w, 'LINK')).body.data.link.split('/q/')[1];
    const v = await request(app).get(`/v1/public/q/${token}`);
    expect(v.headers['x-robots-tag']).toContain('noindex');
    expect(v.body.data).toMatchObject({ valid: true, customer: 'Meena Iyer', breakdown: { final: 11800 } });
    expect((await w.A.get(`/quotations/${w.q.id}`)).body.data.revisions[0].viewed).toBe(1);
    clock.setOffset(16 * 86_400_000);
    const late = await request(app).get(`/v1/public/q/${token}`);
    expect(late.body.data).toMatchObject({ valid: false, messageId: 'QT-20' });
    expect(late.body.data.message).toMatch(/^This quotation is no longer valid\. Please contact Asha Rao on \+91\d{10} for an updated quotation\.$/);
  });

  it('AC-P28-6: email is recorded (QUEUED until Communications) and the quotation is SHARED', async () => {
    const w = await world();
    const em = await share(w, 'EMAIL');
    expect(em.body.meta.message).toBe('Quotation emailed to meena@example.com.');
    expect(em.body.data.quotation.status).toBe('SHARED');
  });

  it('AC-P28-5: a READY revision whose price version has closed cannot be shared (QT-14)', async () => {
    const w2 = await world();
    const changedOn = day(2); // before the clock moves
    await w2.A.post(`/products/${w2.productId}/prices`, { effectiveFrom: changedOn, taxPercent: 18, rows: [{ factors: { age: '18-65' }, basePremium: 11000 }] });
    clock.setOffset(3 * 86_400_000);
    const s = await login(w2.adv.mobile);
    const r = await as(s.token).post(`/quotations/${w2.q.id}/share`, { channel: 'LINK' });
    expect(err(r)).toMatchObject({ messageId: 'QT-14' });
    expect(r.body.error.message).toBe(`The price for this product changed on ${changedOn}. Revise the quotation before sharing it.`);
  });
});

describe('P-29 revise, accept, reject, cancel, expire', () => {
  it('AC-P29-1: revising keeps R1 live until R2 is generated; then R1 is SUPERSEDED and its link stops', async () => {
    const w = await world();
    const token = (await share(w, 'LINK')).body.data.link.split('/q/')[1];
    const cur = (await w.A.get(`/quotations/${w.q.id}`)).body.data;
    const rv = await w.A.post(`/quotations/${w.q.id}/revise`, { version: cur.version });
    expect(rv.body.meta.message).toBe('Revision R2 created. Generate it to replace R1.');
    expect((await request(app).get(`/v1/public/q/${token}`)).body.data.valid).toBe(true); // R1 still live
    await w.A.post(`/quotations/${w.q.id}/calculate`, {});
    const g = (await w.A.post(`/quotations/${w.q.id}/generate`, {})).body.data;
    expect(g.revisions.map((r: { revision: number; status: string }) => `R${r.revision}:${r.status}`)).toEqual(['R1:SUPERSEDED', 'R2:READY']);
    expect((await request(app).get(`/v1/public/q/${token}`)).body.data.valid).toBe(false);
  });

  it('AC-P29-4: reject and cancel need reasons; accept (QT-26); cancel stops the link (QT-28)', async () => {
    const w = await world();
    const token = (await share(w, 'LINK')).body.data.link.split('/q/')[1];
    let v = (await w.A.get(`/quotations/${w.q.id}`)).body.data.version;
    expect(err(await w.A.post(`/quotations/${w.q.id}/reject`, { version: v }))).toMatchObject({ status: 400 });
    expect(err(await w.A.post(`/quotations/${w.q.id}/cancel`, { version: v }))).toMatchObject({ status: 400 });
    const acc = await w.A.post(`/quotations/${w.q.id}/accept`, { version: v });
    expect(acc.body.meta.message).toBe('Quotation marked as accepted. Add the payment link or update the payment status next.');
    v = acc.body.data.version;
    const c = await w.A.post(`/quotations/${w.q.id}/cancel`, { version: v, reason: 'Customer bought elsewhere' });
    expect(c.body.meta.message).toBe("Quotation cancelled. The customer's link no longer works.");
    expect((await request(app).get(`/v1/public/q/${token}`)).body.data.valid).toBe(false);
  });

  it('AC-P29-3: the expiry job running twice expires each quotation once and sends DSH-15 once', async () => {
    const w = await world();
    await share(w, 'LINK');
    clock.setOffset(16 * 86_400_000);
    expect(await expireDue()).toBe(1);
    expect(await expireDue()).toBe(0);
    expect(await Notification.countDocuments({ messageId: 'DSH-15' })).toBe(1);
    const s = await login(w.adv.mobile);
    expect((await as(s.token).get(`/quotations/${w.q.id}`)).body.data.status).toBe('EXPIRED');
  });

  it('a READY quotation can be edited back to DRAFT at step 9; a never-generated draft can be deleted (QT-29)', async () => {
    const w = await world();
    const cur = (await w.A.get(`/quotations/${w.q.id}`)).body.data;
    const e = (await w.A.post(`/quotations/${w.q.id}/edit`, { version: cur.version })).body.data;
    expect(e).toMatchObject({ status: 'DRAFT', step: 9, revisions: [] });
    const fresh = (await w.A.post('/quotations', { customerId: (await w.A.get(`/quotations/${w.q.id}`)).body.data.customerId })).body.data;
    expect((await request(app).delete(`/v1/quotations/${fresh.id}`).set('Authorization', `Bearer ${w.adv.token}`)).body.meta.message).toBe('Draft deleted.');
  });
});