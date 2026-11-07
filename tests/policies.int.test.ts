/** Module 12 — P-33 record an issued policy, P-34 existing policy, P-35 nominees, P-36 correct or cancel. */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, as, err, login, newMobile, registerAdvisor, resetState, startTestEnv, stepUp, stopTestEnv } from './helpers.js';
import { istToday } from '../src/lib/clock.js';
import { Insurer } from '../src/modules/insurers/insurer.model.js';
import { InsuranceType, TemplateVersion } from '../src/modules/catalogue/types.model.js';
import { CustomerDocument } from '../src/modules/documents/document.model.js';
import { Customer } from '../src/modules/customers/customer.model.js';
import { RenewalCycle } from '../src/modules/renewals/renewal.model.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

const day = (n: number) => { const d = new Date(`${istToday()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10).split('-').reverse().join('-'); };
const iso = (dmy: string) => dmy.split('-').reverse().join('-');
const year = Number(istToday().slice(0, 4));
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\ntrailer << >>\n%%EOF\n');

async function world(opts: { nomineeRequired?: boolean } = {}) {
  const ins = await Insurer.create({ name: 'Alpha Life', nameKey: 'alpha life', shortCode: 'ALPHA', category: 'Life', irdaiRegNo: 'R-1', paymentDomains: ['alpha.in'], status: 'ACTIVE' });
  const type = await InsuranceType.create({ name: 'Health', nameKey: 'health' });
  await TemplateVersion.create({ typeId: type._id, number: 1, status: 'ACTIVE', isOpen: null, makerId: 'x', features: [], factors: [{ key: 'age', name: 'Age', kind: 'BAND', source: 'Age of the eldest insured person', bands: [{ from: 0, to: 75 }] }] });
  const adv = await registerAdvisor('Asha Rao');
  const A = as(adv.token);
  let p = (await A.get('/profile')).body.data;
  await A.put('/profile/professional', { version: p.sections.professional.version, advisorType: 'POSP', categories: ['Health'], licenceNumber: 'POSP-1', licenceValidUntil: day(400) });
  p = (await A.get('/profile')).body.data;
  await A.put('/profile/personal', { version: p.sections.personal.version, dob: '15-04-1988' });
  await A.put('/profile/contact', { version: p.sections.contact.version, email: 'asha@example.com', address1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' });
  await A.post('/my-insurers', { insurerId: ins._id, agentCode: 'AG-77', declaration: true });
  const prod = (await A.post('/my-products', { insurerId: ins._id, typeId: type._id, code: 'FS', data: { name: 'Family Shield', uin: 'UIN1', launchDate: '01-01-2026', adultMin: 18, adultMax: 75, sumInsured: { options: [500000] }, policyTerms: [1, 10], taxPercent: 18, pricingMode: 'RATE_TABLE', gracePeriodDays: 30, ...(opts.nomineeRequired ? { nomineeRequired: true } : {}) } })).body.data;
  await A.post(`/products/${prod.id}/prices`, { effectiveFrom: day(0), taxPercent: 18, rows: [{ factors: { age: '0-75' }, basePremium: 10000 }] });
  const cus = (await A.post('/customers', { name: 'Meena Iyer', mobile: newMobile(), dob: `15-04-${year - 40}` })).body.data;
  const son = (await A.post(`/customers/${cus.id}/family`, { name: 'Arjun Iyer', relationship: 'Son', dob: `10-06-${year - 9}` })).body.data;
  const spouse = (await A.post(`/customers/${cus.id}/family`, { name: 'Ravi Iyer', relationship: 'Spouse', dob: `01-01-${year - 42}` })).body.data;
  const acc = (await Customer.findById(cus.id).lean())!.accountId;
  for (const t of ['Aadhaar', 'PAN']) await CustomerDocument.create({ accountId: acc, customerId: cus.id, personKey: `C:${cus.id}`, type: t, seriesKey: `${t}-1`, version: 1, fileId: 'fil_x', originalName: `${t}.pdf`, label: t, labelKey: t.toLowerCase(), status: 'CONFIRMED', uploadedBy: 'x' });
  // quotation → shared → paid → proposal → submitted (policy AWAITING_ISSUANCE)
  const q0 = (await A.post('/quotations', { customerId: cus.id })).body.data;
  const d = (await A.patch(`/quotations/${q0.id}`, { version: q0.version, step: 9, inputs: { typeId: type._id, insurerId: ins._id, productId: prod.id, people: [`C:${cus.id}`], sumInsured: 500000, policyTerm: 1, startDate: day(1) } })).body.data;
  await A.post(`/quotations/${d.id}/calculate`, {});
  await A.post(`/quotations/${d.id}/generate`, {});
  await A.post(`/quotations/${d.id}/share`, { channel: 'LINK' });
  await A.post(`/quotations/${d.id}/payments`, { mode: 'UPI', amount: 11800, paymentDate: day(0), reference: 'UTR-1000', declaration: true });
  let pr = (await A.post('/proposals', { quotationId: d.id })).body.data;
  const no = { answer: false };
  pr = (await A.put(`/proposals/${pr.id}`, { version: pr.version, declarations: [{ member: 'Meena Iyer', answers: Object.fromEntries(pr.questions.map((q: string) => [q, no])) }], nominees: [] })).body.data;
  const sub = await A.post(`/proposals/${pr.id}/submit`, { version: pr.version });
  const doc = (await request(app).post('/v1/files?purpose=POLICY_DOCUMENT').set('Authorization', `Bearer ${adv.token}`).set('Content-Type', 'application/octet-stream').set('X-File-Name', 'policy.pdf').send(PDF)).body.data;
  return { adv, A, cus, son, spouse, ins: ins._id as string, typeId: type._id as string, productId: prod.id as string, policyId: sub.body.data.policyId as string, docId: doc.id as string };
}
type W = Awaited<ReturnType<typeof world>>;
const ISSUE = (w: W, extra: object = {}) => ({ policyNumber: 'AL/2026/0001', issueDate: day(0), startDate: day(1), endDate: day(365), frequency: 'Yearly', sumInsured: 500000, premium: 11800, documentFileId: w.docId, ...extra });
const version = async (w: W) => (await w.A.get(`/policies/${w.policyId}`)).body.data.version;

describe('P-33 record an issued policy', () => {
  it('ISSUED with a renewal cycle on the end date (POL-01); AC-P33-4 a yearly-premium multi-year policy cycles on the next due date', async () => {
    const w = await world();
    expect((await w.A.get('/policies?status=AWAITING_ISSUANCE')).body.data).toHaveLength(1);
    const r = await w.A.post(`/policies/${w.policyId}/issue`, { ...ISSUE(w, { endDate: day(3650), nextDueDate: day(366) }), version: await version(w) });
    expect(r.body.meta.message).toBe('Policy AL/2026/0001 recorded. Renewal tracking has started.');
    expect(r.body.data).toMatchObject({ status: 'ISSUED', renewal: { status: 'UPCOMING', dueDate: iso(day(366)), graceUntil: iso(day(396)) } });
  });

  it('checks: document required, issue date not before payment (POL-03), next due needed and in range (POL-05), sum insured change needs a reason (POL-06)', async () => {
    const w = await world();
    const v = await version(w);
    const bad = await w.A.post(`/policies/${w.policyId}/issue`, { ...ISSUE(w, { documentFileId: undefined, issueDate: day(-1), endDate: day(3650), sumInsured: 600000 }), version: v });
    const ids = bad.body.error.fields.map((f: { messageId: string }) => f.messageId);
    expect(ids).toEqual(expect.arrayContaining(['GEN-01', 'POL-03', 'POL-06']));
    expect(ids).toContain('GEN-01'); // next premium due date (frequency Yearly, 10 years)
    const out = await w.A.post(`/policies/${w.policyId}/issue`, { ...ISSUE(w, { endDate: day(3650), nextDueDate: day(4000) }), version: v });
    expect(out.body.error.fields[0]).toMatchObject({ messageId: 'POL-05' });
  });

  it('AC-P33-3: a product that requires nominees cannot be issued without them (POL-07)', async () => {
    const w = await world({ nomineeRequired: true });
    const r = await w.A.post(`/policies/${w.policyId}/issue`, { ...ISSUE(w), version: await version(w) });
    expect(r.body.error.fields[0]).toMatchObject({ messageId: 'POL-07' });
    const ok = await w.A.post(`/policies/${w.policyId}/issue`, { ...ISSUE(w), version: await version(w), nominees: [{ personKey: `F:${w.spouse.id}`, name: 'Ravi Iyer', relationship: 'Spouse', dob: `01-01-${year - 42}`, share: 100 }] });
    expect(ok.body.data.nominees).toHaveLength(1);
  });
});

describe('P-34 existing policy', () => {
  const EXIST = (w: W, extra: object = {}) => ({ customerId: w.cus.id, insurerId: w.ins, productName: 'Old Endowment Plan', typeId: w.typeId, soldByMe: false, insured: [`C:${w.cus.id}`], policyNumber: 'OLD-555', issueDate: day(-200), startDate: day(-200), endDate: day(164), frequency: 'Yearly', sumInsured: 300000, premium: 9000, ...extra });
  it('AC-P34-1/3: saves without a quotation or payment, by product name; AC-P33-2 the same policy number for the insurer is refused (POL-02)', async () => {
    const w = await world();
    const r = await w.A.post('/policies/existing', EXIST(w));
    expect(r.body.meta.message).toBe('Existing policy OLD-555 added.');
    expect(r.body.data).toMatchObject({ status: 'ISSUED', source: 'EXISTING', productName: 'Old Endowment Plan', renewal: { status: 'UPCOMING' } });
    const dup = await w.A.post('/policies/existing', EXIST(w, { policyNumber: 'old-555' }));
    expect(dup.body.error.fields[0]).toMatchObject({ messageId: 'POL-02' });
    expect(dup.body.error.fields[0].message).toBe('Policy number old-555 is already recorded for Meena Iyer. Check the number.');
  });

  it('AC-P34-2: a past end date asks POL-08, then saves EXPIRED with its cycle DUE (or LAPSED past grace)', async () => {
    const w = await world();
    const ask = await w.A.post('/policies/existing', EXIST(w, { policyNumber: 'OLD-1', issueDate: day(-370), startDate: day(-370), endDate: day(-10) }));
    expect(err(ask)).toMatchObject({ status: 409, messageId: 'POL-08' });
    const due = await w.A.post('/policies/existing', EXIST(w, { policyNumber: 'OLD-1', issueDate: day(-370), startDate: day(-370), endDate: day(-10), confirmExpired: true }));
    expect(due.body.data).toMatchObject({ status: 'EXPIRED', renewal: { status: 'DUE' } });
    const lapsed = await w.A.post('/policies/existing', EXIST(w, { policyNumber: 'OLD-2', issueDate: day(-420), startDate: day(-420), endDate: day(-60), confirmExpired: true }));
    expect(lapsed.body.data.renewal.status).toBe('LAPSED'); // grace CFG-62 = 30 days passed
  });
});

describe('P-35 nominees', () => {
  it('AC-P35-1/2: two policies of one customer keep different nominees; AC-P35-4 a minor needs an appointee; GEN-11 for another customer\'s family member', async () => {
    const w = await world();
    const other = (await w.A.post('/policies/existing', { customerId: w.cus.id, insurerId: w.ins, productName: 'Term Cover', typeId: w.typeId, soldByMe: false, insured: [`C:${w.cus.id}`], policyNumber: 'T-9', issueDate: day(-30), startDate: day(-30), endDate: day(300), frequency: 'Yearly', sumInsured: 1000000, premium: 12000 })).body.data;
    const minor = { personKey: `F:${w.son.id}`, name: 'Arjun Iyer', relationship: 'Son', dob: `10-06-${year - 9}`, share: 100 };
    const r = await w.A.put(`/policies/${w.policyId}/nominees`, { nominees: [minor] });
    expect(r.body.error.fields[0].message).toBe('Arjun Iyer is under 18. Add an appointee.');
    await w.A.put(`/policies/${w.policyId}/nominees`, { nominees: [{ ...minor, appointee: { name: 'Ravi Iyer', relationship: 'Spouse', dob: `01-01-${year - 42}` } }] });
    const end = { endorsementRef: 'END-1', effectiveDate: day(0) };
    await w.A.put(`/policies/${other.id}/nominees`, { nominees: [{ personKey: `F:${w.spouse.id}`, name: 'Ravi Iyer', relationship: 'Spouse', dob: `01-01-${year - 42}`, share: 100 }], ...end });
    expect((await w.A.get(`/policies/${w.policyId}`)).body.data.nominees.map((n: { name: string }) => n.name)).toEqual(['Arjun Iyer']);
    expect((await w.A.get(`/policies/${other.id}`)).body.data.nominees.map((n: { name: string }) => n.name)).toEqual(['Ravi Iyer']);
    const stranger = (await w.A.post('/customers', { name: 'Kiran Rao', mobile: newMobile() })).body.data;
    const fam = (await w.A.post(`/customers/${stranger.id}/family`, { name: 'Lata Rao', relationship: 'Spouse', dob: '01-01-1980' })).body.data;
    expect(err(await w.A.put(`/policies/${w.policyId}/nominees`, { nominees: [{ personKey: `F:${fam.id}`, name: 'Lata Rao', relationship: 'Spouse', dob: '01-01-1980', share: 100 }] }))).toMatchObject({ status: 404 });
  });

  it('AC-P35-5: on an ISSUED policy a change needs the endorsement reference and makes a new version (POL-10)', async () => {
    const w = await world();
    await w.A.post(`/policies/${w.policyId}/issue`, { ...ISSUE(w), version: await version(w) });
    const n = { personKey: `F:${w.spouse.id}`, name: 'Ravi Iyer', relationship: 'Spouse', dob: `01-01-${year - 42}`, share: 100 };
    const r = await w.A.put(`/policies/${w.policyId}/nominees`, { nominees: [n] });
    expect(r.body.error.fields.map((f: { field: string }) => f.field)).toEqual(['endorsementRef', 'effectiveDate']);
    const ok = await w.A.put(`/policies/${w.policyId}/nominees`, { nominees: [n], endorsementRef: 'END-77', effectiveDate: day(0) });
    expect(ok.body.meta.message).toBe('Nominees saved for policy AL/2026/0001.');
    const half = [{ ...n, share: 50 }, { personKey: `F:${w.son.id}`, name: 'Arjun Iyer', relationship: 'Son', dob: `10-06-${year - 9}`, share: 50, appointee: { name: 'Ravi Iyer', relationship: 'Spouse', dob: `01-01-${year - 42}` } }];
    const v2 = (await w.A.put(`/policies/${w.policyId}/nominees`, { nominees: half, endorsementRef: 'END-78', effectiveDate: day(0) })).body.data;
    expect(v2.nomineeVersions.map((x: { number: number; status: string }) => `${x.number}:${x.status}`)).toEqual(['2:CURRENT', '1:PREVIOUS']);
    expect(err(await w.A.put(`/policies/${w.policyId}/nominees`, { nominees: [{ ...n, share: 60 }], endorsementRef: 'E', effectiveDate: day(0) }))).toMatchObject({ status: 400 }); // POL-13
  });
});

describe('P-36 correct or cancel', () => {
  it('AC-P36-1: correcting the end date moves the renewal date (POL-18, history kept); AC-P36-2 cancelling stops the cycle (POL-19); cancelled again is GEN-04', async () => {
    const w = await world();
    await w.A.post(`/policies/${w.policyId}/issue`, { ...ISSUE(w), version: await version(w) });
    expect(err(await w.A.post(`/policies/${w.policyId}/correct`, { version: await version(w), changes: { endDate: day(330) } }))).toMatchObject({ status: 400 }); // reason required
    const c = await w.A.post(`/policies/${w.policyId}/correct`, { version: await version(w), reason: 'Insurer schedule shows an earlier end date', changes: { endDate: day(330) } });
    expect(c.body.meta.message).toBe('Policy details corrected.');
    expect(c.body.data.renewal.dueDate).toBe(iso(day(330)));
    expect(c.body.data.history.at(-1)).toMatchObject({ action: 'CORRECTED', reason: 'Insurer schedule shows an earlier end date', before: { endDate: iso(day(365)) } });
    const x = await w.A.post(`/policies/${w.policyId}/cancel`, { version: await version(w), reason: 'Free-look cancellation', date: day(0), refund: 11000 });
    expect(x.body.meta.message).toBe('Policy cancelled. Renewal reminders for it have stopped.');
    expect(await RenewalCycle.findOne({ policyId: w.policyId }).lean()).toMatchObject({ status: 'NOT_RENEWING', reason: 'Policy cancelled' });
    expect(err(await w.A.post(`/policies/${w.policyId}/cancel`, { version: await version(w), reason: 'Free-look cancellation', date: day(0) }))).toMatchObject({ messageId: 'GEN-04' });
  });

  it('an assistant can view policies but not record or change them', async () => {
    const w = await world();
    const m = newMobile();
    await w.A.post('/assistants', { name: 'Priya Shah', mobile: m }, { 'X-Step-Up-Token': await stepUp(w.adv.token, w.adv.mobile) });
    const ast = as((await login(m)).token);
    expect((await ast.get(`/policies/${w.policyId}`)).status).toBe(200);
    expect((await ast.get(`/policies/${w.policyId}`)).body.data.expectedCommission).toBeUndefined();
    expect(err(await ast.post(`/policies/${w.policyId}/issue`, { ...ISSUE(w), version: 1 }))).toMatchObject({ status: 403 });
  });
});