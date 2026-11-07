/** Module 13 — P-37 daily renewal job and reminders; P-38 follow up and close a renewal. */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, as, err, login, newMobile, registerAdvisor, resetState, startTestEnv, stopTestEnv } from './helpers.js';
import { clock, istToday } from '../src/lib/clock.js';
import { Insurer } from '../src/modules/insurers/insurer.model.js';
import { InsuranceType, TemplateVersion } from '../src/modules/catalogue/types.model.js';
import { Account } from '../src/modules/accounts/account.model.js';
import { Consent, Customer } from '../src/modules/customers/customer.model.js';
import { CustomerDocument } from '../src/modules/documents/document.model.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { Outbox } from '../src/modules/comms/outbox.model.js';
import { Policy } from '../src/modules/policies/policy.model.js';
import { RenewalCycle } from '../src/modules/renewals/renewal.model.js';
import { runRenewalJob } from '../src/modules/renewals/renewals.service.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(async () => { clock.setOffset(0); await resetState(); });

const day = (n: number) => { const d = new Date(`${istToday()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10).split('-').reverse().join('-'); };
const iso = (dmy: string) => dmy.split('-').reverse().join('-');
const year = Number(istToday().slice(0, 4));
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\ntrailer << >>\n%%EOF\n');

async function world(endInDays = 30, extra: object = {}) {
  const ins = await Insurer.create({ name: 'Alpha Health', nameKey: 'alpha health', shortCode: 'ALPHA', category: 'Standalone Health', irdaiRegNo: 'R-1', paymentDomains: ['alpha.in'], status: 'ACTIVE' });
  const type = await InsuranceType.create({ name: 'Health', nameKey: 'health' });
  await TemplateVersion.create({ typeId: type._id, number: 1, status: 'ACTIVE', isOpen: null, makerId: 'x', features: [], factors: [{ key: 'age', name: 'Age', kind: 'BAND', source: 'Age of the eldest insured person', bands: [{ from: 0, to: 75 }] }] });
  const adv = await registerAdvisor('Asha Rao');
  const A = as(adv.token);
  let p = (await A.get('/profile')).body.data;
  await A.put('/profile/professional', { version: p.sections.professional.version, advisorType: 'POSP', categories: ['Health'], licenceNumber: 'POSP-1', licenceValidUntil: day(800) });
  p = (await A.get('/profile')).body.data;
  await A.put('/profile/personal', { version: p.sections.personal.version, dob: '15-04-1988' });
  await A.put('/profile/contact', { version: p.sections.contact.version, email: 'asha@example.com', address1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' });
  await A.post('/my-insurers', { insurerId: ins._id, agentCode: 'AG-77', declaration: true });
  const prod = (await A.post('/my-products', { insurerId: ins._id, typeId: type._id, code: 'FS', data: { name: 'Family Shield', uin: 'UIN1', launchDate: '01-01-2026', adultMin: 18, adultMax: 75, sumInsured: { options: [500000] }, policyTerms: [1], taxPercent: 18, pricingMode: 'RATE_TABLE', gracePeriodDays: 30 } })).body.data;
  await A.post(`/products/${prod.id}/prices`, { effectiveFrom: day(0), taxPercent: 18, rows: [{ factors: { age: '0-75' }, basePremium: 10000 }] });
  const cus = (await A.post('/customers', { name: 'Meena Iyer', mobile: newMobile(), email: 'meena@example.com', dob: `15-04-${year - 40}` })).body.data;
  const pol = (await A.post('/policies/existing', { customerId: cus.id, insurerId: ins._id, productId: prod.id, typeId: type._id, soldByMe: true, insured: [`C:${cus.id}`], policyNumber: 'FS-OLD-1',
    issueDate: day(endInDays - 364), startDate: day(endInDays - 364), endDate: day(endInDays), frequency: 'Yearly', sumInsured: 500000, premium: 11800, ...extra })).body.data;
  const accountId = (await Customer.findById(cus.id).lean())!.accountId;
  return { adv, A, cus, pol, cycleId: (await RenewalCycle.findOne({ policyId: pol.id }).lean())!._id, accountId, ins: ins._id as string, prod: prod.id as string };
}
type W = Awaited<ReturnType<typeof world>>;
const cycle = (w: W) => w.A.get(`/renewals/${w.cycleId}`).then((r) => r.body.data);

describe('P-37 daily renewal job', () => {
  it('AC-P37-1: running twice on one day sends each reminder once; UPCOMING → DUE; AC-P38-1 a reminder does not renew', async () => {
    const w = await world(30);
    const r1 = await runRenewalJob();
    expect(r1).toMatchObject({ due: 1, queued: 1 }); // email on the 30-day offset (Normal plan: no WhatsApp)
    const r2 = await runRenewalJob();
    expect(r2).toMatchObject({ due: 0, queued: 0 });
    expect(await Outbox.countDocuments({})).toBe(1);
    expect(await Notification.countDocuments({ messageId: 'DSH-14' })).toBe(1);
    const n = await Notification.findOne({ messageId: 'DSH-14' }).lean();
    expect(n!.message).toBe(`Meena Iyer's Family Shield policy expires on ${day(30)}.`);
    const m = await Outbox.findOne({}).lean();
    expect(m).toMatchObject({ channel: 'EMAIL', status: 'QUEUED', to: 'meena@example.com', template: 'REN-T1' });
    expect(m!.text).toMatch(/^Dear Meena, your Family Shield policy ending LD-1 is due for renewal on .* Please contact Asha Rao on \+91\d{10} to renew it on time\.$/);
    expect((await cycle(w)).status).toBe('DUE');
    // the bell item opens the renewal
    const opened = await w.A.post(`/notifications/${n!._id}/open`, {});
    expect(opened.body.data.link).toEqual({ type: 'RENEWAL', id: w.cycleId });
  });

  it('AC-P37-2: Normal plan never gets WhatsApp; Premium with WhatsApp consent GIVEN does', async () => {
    const w = await world(30);
    await Consent.create({ accountId: w.accountId, personKey: `C:${w.cus.id}`, customerId: w.cus.id, channel: 'WHATSAPP', status: 'GIVEN', recordedAt: new Date() });
    await runRenewalJob();
    expect(await Outbox.countDocuments({ channel: 'WHATSAPP' })).toBe(0);
    await Account.updateOne({ _id: w.accountId }, { $set: { 'subscription.plan': 'PREMIUM' } });
    clock.setOffset(15 * 86_400_000); // the 15-day offset
    await runRenewalJob();
    expect(await Outbox.countDocuments({ channel: 'WHATSAPP', status: 'QUEUED' })).toBe(1);
  });

  it('AC-P37-3: withdrawn consent stops a queued reminder (SKIPPED, reason kept)', async () => {
    const w = await world(30);
    await runRenewalJob();
    await Consent.create({ accountId: w.accountId, personKey: `C:${w.cus.id}`, customerId: w.cus.id, channel: 'EMAIL', status: 'WITHDRAWN', recordedAt: new Date() });
    await runRenewalJob();
    expect(await Outbox.findOne({}).lean()).toMatchObject({ status: 'SKIPPED', skipReason: 'Consent withdrawn' });
  });

  it('AC-P37-4: past grace → LAPSED with DSH-25; past end → policy EXPIRED', async () => {
    const w = await world(5);
    clock.setOffset(40 * 86_400_000); // 5 days to end + 30 grace + 5
    const r = await runRenewalJob();
    expect(r).toMatchObject({ expired: 1, lapsed: 1 });
    expect((await RenewalCycle.findById(w.cycleId).lean())!.status).toBe('LAPSED');
    expect((await Policy.findById(w.pol.id).lean())!.status).toBe('EXPIRED');
    expect((await Notification.findOne({ messageId: 'DSH-25' }).lean())!.message).toMatch(/^Meena Iyer's Family Shield policy lapsed on /);
  });

  it('AC-P37-5: a multi-year policy with yearly premiums cycles on the next premium due date', async () => {
    const w = await world(3000, { issueDate: day(-345), startDate: day(-345), endDate: day(3000), nextDueDate: day(20) });
    expect((await cycle(w)).dueDate).toBe(iso(day(20)));
  });
});

describe('P-38 follow up and close', () => {
  it('REN-01 log contact; AC-P38-4 not renewing stops reminders; AC-P38-5 reopen refused after grace (REN-08)', async () => {
    const w = await world(30);
    await runRenewalJob();
    let c = await cycle(w);
    const lc = await w.A.post(`/renewals/${w.cycleId}/contact`, { version: c.version, outcome: 'Spoke to customer', note: 'Will decide this week' });
    expect(lc.body.meta.message).toBe('Contact logged. This renewal is now in follow-up.');
    expect(lc.body.data).toMatchObject({ status: 'IN_FOLLOW_UP', lastContact: { outcome: 'Spoke to customer' } });
    const nr = await w.A.post(`/renewals/${w.cycleId}/not-renewing`, { version: lc.body.data.version, reason: 'Bought elsewhere' });
    expect(nr.body.meta.message).toBe('Marked as not renewing. Customer reminders have stopped.');
    expect(await Outbox.findOne({}).lean()).toMatchObject({ status: 'SKIPPED', skipReason: 'Renewal not renewing' });
    c = await cycle(w);
    expect((await w.A.post(`/renewals/${w.cycleId}/reopen`, { version: c.version, note: 'Changed mind' })).body.meta.message).toBe('Renewal reopened.');
    c = await cycle(w);
    await w.A.post(`/renewals/${w.cycleId}/not-renewing`, { version: c.version, reason: 'Customer not interested' });
    await Account.updateOne({ _id: w.accountId }, { $set: { 'subscription.endsAt': new Date(Date.now() + 400 * 86_400_000) } }); // a longer trial, so read-only mode does not apply
    clock.setOffset(70 * 86_400_000);
    const s = await login(w.adv.mobile);
    c = (await as(s.token).get(`/renewals/${w.cycleId}`)).body.data;
    const late = await as(s.token).post(`/renewals/${w.cycleId}/reopen`, { version: c.version, note: 'Again' });
    expect(err(late)).toMatchObject({ messageId: 'REN-08' });
    expect(late.body.error.message).toBe(`The grace period ended on ${c.graceUntil.split('-').reverse().join('-')}. This renewal can no longer be reopened.`);
  });

  it('AC-P38-3: premium paid moves the next due date, keeps the policy ISSUED, one new cycle (REN-03); REN-09; pause/resume', async () => {
    const w = await world(3000, { issueDate: day(-345), startDate: day(-345), endDate: day(3000), nextDueDate: day(20) });
    let c = await cycle(w);
    expect((await w.A.post(`/renewals/${w.cycleId}/pause`, { version: c.version })).body.meta.message).toBe('Customer reminders for this renewal are paused.');
    c = await cycle(w);
    expect((await w.A.post(`/renewals/${w.cycleId}/resume`, { version: c.version })).body.meta.message).toBe('Customer reminders for this renewal are on again.');
    c = await cycle(w);
    const bad = await w.A.post(`/renewals/${w.cycleId}/premium-paid`, { version: c.version, paymentDate: day(0), receiptNumber: 'RCPT-1', amount: 11800, nextDueDate: day(10) });
    expect(bad.body.error.fields[0]).toMatchObject({ messageId: 'REN-09' });
    const ok = await w.A.post(`/renewals/${w.cycleId}/premium-paid`, { version: c.version, paymentDate: day(0), receiptNumber: 'RCPT-1', amount: 11800, nextDueDate: day(385) });
    expect(ok.body.meta.message).toBe(`Renewal recorded. The next renewal is due on ${day(385)}.`);
    expect(ok.body.data.status).toBe('RENEWED');
    const pol = (await w.A.get(`/policies/${w.pol.id}`)).body.data;
    expect(pol).toMatchObject({ status: 'ISSUED', nextDueDate: iso(day(385)), renewal: { status: 'UPCOMING', dueDate: iso(day(385)) } });
    expect(await RenewalCycle.countDocuments({ policyId: w.pol.id })).toBe(2);
  });

  it('AC-P38-2: a renewal quotation (REN-02) recorded as the new policy renews the old one; the new policy has exactly one cycle', async () => {
    const w = await world(30);
    const rq = await w.A.post(`/renewals/${w.cycleId}/renewal-quotation`, {});
    expect(rq.body.meta.message).toBe('Renewal quotation started for policy FS-OLD-1.');
    const q = rq.body.data;
    expect(q.inputs).toMatchObject({ renewalOf: w.pol.id, productId: w.prod, sumInsured: 500000 });
    expect((await cycle(w)).status).toBe('IN_FOLLOW_UP');
    await w.A.post(`/quotations/${q.id}/calculate`, {});
    await w.A.post(`/quotations/${q.id}/generate`, {});
    await w.A.post(`/quotations/${q.id}/share`, { channel: 'LINK' });
    await w.A.post(`/quotations/${q.id}/payments`, { mode: 'UPI', amount: 11800, paymentDate: day(0), reference: 'UTR-RENEW-1', declaration: true });
    for (const t of ['Aadhaar', 'PAN']) await CustomerDocument.create({ accountId: w.accountId, customerId: w.cus.id, personKey: `C:${w.cus.id}`, type: t, seriesKey: `${t}-1`, version: 1, fileId: 'fil_x', originalName: `${t}.pdf`, label: t, labelKey: t.toLowerCase(), status: 'CONFIRMED', uploadedBy: 'x' });
    let pr = (await w.A.post('/proposals', { quotationId: q.id })).body.data;
    pr = (await w.A.put(`/proposals/${pr.id}`, { version: pr.version, declarations: [{ member: 'Meena Iyer', answers: Object.fromEntries(pr.questions.map((x: string) => [x, { answer: false }])) }], nominees: [] })).body.data;
    const sub = (await w.A.post(`/proposals/${pr.id}/submit`, { version: pr.version })).body.data;
    const doc = (await request(app).post('/v1/files?purpose=POLICY_DOCUMENT').set('Authorization', `Bearer ${w.adv.token}`).set('Content-Type', 'application/octet-stream').set('X-File-Name', 'p.pdf').send(PDF)).body.data;
    const v = (await w.A.get(`/policies/${sub.policyId}`)).body.data.version;
    const iss = await w.A.post(`/policies/${sub.policyId}/issue`, { version: v, policyNumber: 'FS-NEW-2', issueDate: day(0), startDate: day(31), endDate: day(395), frequency: 'Yearly', sumInsured: 500000, premium: 11800, documentFileId: doc.id });
    expect(iss.body.meta.message).toBe(`Renewal recorded. The next renewal is due on ${day(395)}.`);
    expect((await Policy.findById(w.pol.id).lean())!.status).toBe('RENEWED');
    expect((await RenewalCycle.findById(w.cycleId).lean())).toMatchObject({ status: 'RENEWED', renewedBy: { kind: 'POLICY', policyId: sub.policyId } });
    expect(await RenewalCycle.countDocuments({ policyId: sub.policyId })).toBe(1);
  });
});