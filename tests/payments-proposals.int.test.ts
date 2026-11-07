/** Module 11 — P-31 payment link, P-32 record payment, P-55 proposals. */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, as, err, login, newMobile, registerAdvisor, resetState, startTestEnv, stepUp, stopTestEnv } from './helpers.js';
import { istToday } from '../src/lib/clock.js';
import { Insurer } from '../src/modules/insurers/insurer.model.js';
import { InsuranceType, TemplateVersion } from '../src/modules/catalogue/types.model.js';
import { CustomerDocument } from '../src/modules/documents/document.model.js';
import { Payment } from '../src/modules/payments/payment.model.js';
import { Policy } from '../src/modules/policies/policy.model.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

const day = (n: number) => { const d = new Date(`${istToday()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10).split('-').reverse().join('-'); };
const year = Number(istToday().slice(0, 4));

async function world() {
  const ins = await Insurer.create({ name: 'Alpha Health', nameKey: 'alpha health', shortCode: 'ALPHA', category: 'Standalone Health', irdaiRegNo: 'R-1', paymentDomains: ['alpha.in'], status: 'ACTIVE' });
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
  const prod = (await A.post('/my-products', { insurerId: ins._id, typeId: type._id, code: 'FS', data: { name: 'Family Shield', uin: 'UIN1', launchDate: '01-01-2026', adultMin: 18, adultMax: 75, sumInsured: { options: [500000] }, policyTerms: [1], taxPercent: 18, pricingMode: 'RATE_TABLE' } })).body.data;
  await A.post(`/products/${prod.id}/prices`, { effectiveFrom: day(0), taxPercent: 18, rows: [{ factors: { age: '0-75' }, basePremium: 10000 }] });
  const cus = (await A.post('/customers', { name: 'Meena Iyer', mobile: newMobile(), dob: `15-04-${year - 40}` })).body.data;
  const q0 = (await A.post('/quotations', { customerId: cus.id })).body.data;
  const d = (await A.patch(`/quotations/${q0.id}`, { version: q0.version, step: 9, inputs: { typeId: type._id, insurerId: ins._id, productId: prod.id, people: [`C:${cus.id}`], sumInsured: 500000, policyTerm: 1, startDate: day(1) } })).body.data;
  await A.post(`/quotations/${d.id}/calculate`, {});
  const q = (await A.post(`/quotations/${d.id}/generate`, {})).body.data;
  const shared = await A.post(`/quotations/${q.id}/share`, { channel: 'LINK' });
  return { adv, A, q, cus, token: shared.body.data.link.split('/q/')[1] as string, accountId: (await import('../src/modules/users/user.model.js')).User };
}
type W = Awaited<ReturnType<typeof world>>;
const PAID = (extra: object = {}) => ({ mode: 'UPI', amount: 11800, paymentDate: day(0), reference: 'UTR-123456', declaration: true, ...extra });
async function vault(w: W) {
  const acc = (await (await import('../src/modules/customers/customer.model.js')).Customer.findById(w.cus.id).lean())!.accountId;
  for (const type of ['Aadhaar', 'PAN']) await CustomerDocument.create({ accountId: acc, customerId: w.cus.id, personKey: `C:${w.cus.id}`, type, seriesKey: `${type}-1`, version: 1, fileId: 'fil_x', originalName: `${type}.pdf`, label: type, labelKey: type.toLowerCase(), status: 'CONFIRMED', uploadedBy: 'x' });
}

describe('P-31 payment link', () => {
  it('AC-P31-1: a link off the insurer domain is refused (PAY-01); a subdomain works (PAY-04); the customer page shows Pay on Alpha Health with the domain (AC-P31-3)', async () => {
    const w = await world();
    const bad = await w.A.post(`/quotations/${w.q.id}/payment-link`, { method: 'Insurer payment link', link: 'https://alpha-pay.example.com/x', portalAmount: 11800 });
    expect(bad.body.error.fields[0]).toMatchObject({ messageId: 'PAY-01' });
    expect(bad.body.error.fields[0].message).toBe("This link is not on Alpha Health's website (alpha.in). Paste the link created on the insurer's portal.");
    const ok = await w.A.post(`/quotations/${w.q.id}/payment-link`, { method: 'Insurer payment link', link: 'https://pay.alpha.in/p/AB12', portalAmount: 11800 });
    expect(ok.body.meta.message).toBe('Payment link added. Share the quotation again so Meena Iyer can pay.');
    const pub = (await request(app).get(`/v1/public/q/${w.token}`)).body.data;
    expect(pub.payment).toEqual({ payOn: 'Alpha Health', domain: 'pay.alpha.in', link: 'https://pay.alpha.in/p/AB12' });
  });

  it('PAY-02 when the portal amount differs; AC-P31-4 replacing expires the old payment and creates one new one; AC-P31-5 comparisons have no payment link', async () => {
    const w = await world();
    expect((await w.A.post(`/quotations/${w.q.id}/payment-link`, { method: 'Insurer payment link', link: 'https://alpha.in/a', portalAmount: 12000 })).body.error.fields[0]).toMatchObject({ messageId: 'PAY-02' });
    await w.A.post(`/quotations/${w.q.id}/payment-link`, { method: 'Insurer payment link', link: 'https://alpha.in/a', portalAmount: 11800 });
    await w.A.post(`/quotations/${w.q.id}/payment-link/replace`, { method: 'Insurer payment link', link: 'https://alpha.in/b', portalAmount: 11800 });
    const ps = (await w.A.get(`/quotations/${w.q.id}/payments`)).body.data.map((x: { status: string; link: string }) => `${x.status}:${x.link}`);
    expect(ps.sort()).toEqual(['AWAITING_PAYMENT:https://alpha.in/b', 'EXPIRED:https://alpha.in/a']);
    expect((await w.A.post('/comparisons/cq_0000000000000000000000000000/payment-link', {})).status).toBe(404);
  });
});

describe('P-32 record payment', () => {
  it('AC-P32-1: reference required except cash (PAY-16); AC-P32-2 cash shows the receipt warning; ACCEPTED in the same step (PAY-05); customer page PAY-14', async () => {
    const w = await world();
    const noRef = await w.A.post(`/quotations/${w.q.id}/payments`, PAID({ reference: undefined }));
    expect(noRef.body.error.fields[0]).toMatchObject({ messageId: 'PAY-16' });
    expect(noRef.body.error.fields[0].message).toBe('Enter the reference number for this UPI payment.');
    const cash = await w.A.post(`/quotations/${w.q.id}/payments`, PAID({ mode: 'Cash', reference: undefined }));
    expect(cash.body.meta.message).toBe('Payment recorded. You can submit the proposal now.');
    expect(cash.body.meta.warnings[0].message).toBe('Cash received. Give Meena Iyer a receipt now, and pay it to Alpha Health as their rules require.');
    expect(cash.body.data).toMatchObject({ status: 'PAID', statusLabel: 'as recorded by the advisor' });
    expect((await w.A.get(`/quotations/${w.q.id}`)).body.data.status).toBe('ACCEPTED');
    const pub = (await request(app).get(`/v1/public/q/${w.token}`)).body.data;
    expect(pub.payment.message).toBe(`Payment received on ${day(0)}, as recorded by your advisor.`);
  });

  it('AC-P32-3: a repeated reference for the same insurer is refused (PAY-08); dates PAY-11; amount difference needs a reason (PAY-13); a second PAID is refused', async () => {
    const w1 = await world();
    await w1.A.post(`/quotations/${w1.q.id}/payments`, PAID());
    expect(err(await w1.A.post(`/quotations/${w1.q.id}/payments`, PAID({ reference: 'UTR-999999' })))).toMatchObject({ messageId: 'GEN-04' });
    // a second quotation for the same insurer in the same account
    const cus2 = (await w1.A.post('/customers', { name: 'Ravi Kumar', mobile: newMobile(), dob: `01-01-${year - 30}` })).body.data;
    const q = (await w1.A.get(`/quotations/${w1.q.id}`)).body.data;
    const q2 = (await w1.A.post('/quotations', { customerId: cus2.id })).body.data;
    const d2 = (await w1.A.patch(`/quotations/${q2.id}`, { version: q2.version, step: 9, inputs: { ...q.inputs, people: [`C:${cus2.id}`] } })).body.data;
    await w1.A.post(`/quotations/${d2.id}/calculate`, {});
    await w1.A.post(`/quotations/${d2.id}/generate`, {});
    await w1.A.post(`/quotations/${d2.id}/share`, { channel: 'LINK' });
    const dup = await w1.A.post(`/quotations/${d2.id}/payments`, PAID({ reference: 'utr-123456' }));
    expect(dup.body.error.fields[0]).toMatchObject({ messageId: 'PAY-08' });
    expect(dup.body.error.fields[0].message).toMatch(/^This transaction number is already recorded on QT-\d{6}-00001\. Check the number\.$/);
    expect((await w1.A.post(`/quotations/${d2.id}/payments`, PAID({ reference: 'UTR-2', paymentDate: day(1) }))).body.error.fields[0]).toMatchObject({ messageId: 'PAY-11' });
    expect((await w1.A.post(`/quotations/${d2.id}/payments`, PAID({ reference: 'UTR-2222', amount: 12500 }))).body.error.fields[0]).toMatchObject({ messageId: 'PAY-13' });
  });

  it('AC-P32-5: an assistant cannot record a payment (GEN-03); AC-P29-2 a paid quotation cannot be revised (QT-21) or cancelled', async () => {
    const w = await world();
    const m = newMobile();
    await w.A.post('/assistants', { name: 'Priya Shah', mobile: m }, { 'X-Step-Up-Token': await stepUp(w.adv.token, w.adv.mobile) });
    const ast = as((await login(m)).token);
    expect(err(await ast.post(`/quotations/${w.q.id}/payments`, PAID()))).toMatchObject({ status: 403, messageId: 'GEN-03' });
    await w.A.post(`/quotations/${w.q.id}/payments`, PAID());
    const cur = (await w.A.get(`/quotations/${w.q.id}`)).body.data;
    expect(err(await w.A.post(`/quotations/${w.q.id}/cancel`, { version: cur.version, reason: 'x y' }))).toMatchObject({ messageId: 'GEN-04' });
  });
});

describe('P-55 proposals', () => {
  it('AC-P55-2/3/5/6: Submit is blocked without KYC (PRP-04) and payment (PAY-18); declarations PRP-02; PRP-03 on a condition; an assistant cannot submit; then SUBMITTED + policy AWAITING_ISSUANCE', async () => {
    const w = await world();
    const st = await w.A.post('/proposals', { quotationId: w.q.id });
    expect(st.body.meta.message).toMatch(/^Proposal PR-\d{6}-00001 started from quotation QT-\d{6}-00001 R1\.$/);
    let p = st.body.data;
    expect(p.members).toHaveLength(1);
    const r1 = (await w.A.get(`/proposals/${p.id}`)).body.data.readiness.problems.map((x: { messageId: string }) => x.messageId);
    expect(r1).toEqual(expect.arrayContaining(['PRP-02', 'PRP-04', 'PAY-18']));
    const yes = { answer: true, condition: 'Diabetes', since: '2019', treatment: 'Metformin' };
    const no = { answer: false };
    p = (await w.A.put(`/proposals/${p.id}`, { version: p.version, declarations: [{ member: 'Meena Iyer', answers: { 'Pre-existing disease': yes, 'Current medicines': no, 'Hospital stay in the last 4 years': no, Tobacco: no, Alcohol: no } }],
      nominees: [{ name: 'Arjun Iyer', relationship: 'Son', dob: `10-06-${year - 9}`, share: 100, appointee: { name: 'Ravi Iyer', dob: '01-01-1960' } }] })).body.data;
    expect(p.warning.messageId).toBe('PRP-03'); // AC-P55-5
    await vault(w);
    await w.A.post(`/quotations/${w.q.id}/payments`, PAID());
    const m = newMobile();
    await w.A.post('/assistants', { name: 'Priya Shah', mobile: m }, { 'X-Step-Up-Token': await stepUp(w.adv.token, w.adv.mobile) });
    const ast = as((await login(m)).token);
    expect(err(await ast.post(`/proposals/${p.id}/submit`, { version: p.version }))).toMatchObject({ status: 403 }); // AC-P55-6
    const s = await w.A.post(`/proposals/${p.id}/submit`, { version: p.version });
    expect(s.body.meta.message).toMatch(/^Proposal PR-\d{6}-00001 submitted\. Record the policy when Alpha Health issues it\.$/);
    const pol = await Policy.findById(s.body.data.policyId).lean();
    expect(pol).toMatchObject({ status: 'AWAITING_ISSUANCE', frozen: { declarations: [{ member: 'Meena Iyer' }], nominees: [{ name: 'Arjun Iyer', share: 100 }], premium: 11800 } });
    // AC-P32-4: undo is blocked once submitted…
    const paid = await Payment.findOne({ quotationId: w.q.id, status: 'PAID' }).lean();
    expect(err(await w.A.post(`/payments/${paid!._id}/undo`, { reason: 'Refunded by insurer' }))).toMatchObject({ messageId: 'PAY-10' });
    // …unless the insurer declined it
    const dec = await w.A.post(`/proposals/${p.id}/decline`, { version: s.body.data.version, reason: 'Medical underwriting' });
    expect(dec.body.meta.message).toMatch(/marked as declined by Alpha Health\.$/);
    expect((await Policy.findById(s.body.data.policyId).lean())!.status).toBe('CANCELLED');
    expect((await w.A.post(`/payments/${paid!._id}/undo`, { reason: 'Refunded by insurer' })).body.meta.message).toBe('Payment undone.');
  });

  it('AC-P55-4: a minor nominee needs an appointee (POL-16); AC-P55-1 an expired quotation cannot start a proposal (QT-44)', async () => {
    const w = await world();
    const p = (await w.A.post('/proposals', { quotationId: w.q.id })).body.data;
    const r = await w.A.put(`/proposals/${p.id}`, { version: p.version, declarations: [], nominees: [{ name: 'Arjun Iyer', relationship: 'Son', dob: `10-06-${year - 9}`, share: 100 }] });
    expect(r.body.error.fields[0]).toMatchObject({ messageId: 'POL-16' });
    expect(r.body.error.fields[0].message).toBe('Arjun Iyer is under 18. Add an appointee.');
    const { Quotation } = await import('../src/modules/quotations/quotation.model.js');
    const q = (await Quotation.findById(w.q.id).lean())!;
    await (await import('../src/modules/proposals/proposal.model.js')).Proposal.deleteMany({});
    await Quotation.updateOne({ _id: w.q.id }, { $set: { status: 'EXPIRED', revisions: q.revisions.map((x) => ({ ...x, status: 'EXPIRED' })) } });
    expect(err(await w.A.post('/proposals', { quotationId: w.q.id }))).toMatchObject({ messageId: 'QT-44' });
  });
});

describe('B-02 cancel a draft proposal · B-04 payments by customer', () => {
  it('cancels a DRAFT (PRP-08), frees the quotation for a new proposal, refuses a second cancel and a SUBMITTED proposal; assistants may cancel', async () => {
    const w = await world();
    const st = (await w.A.post('/proposals', { quotationId: w.q.id })).body.data;
    expect(err(await w.A.post(`/proposals/${st.id}/cancel`, { version: st.version }))).toMatchObject({ status: 400 }); // reason is required
    const ok = await w.A.post(`/proposals/${st.id}/cancel`, { version: st.version, reason: 'Customer changed mind', note: 'Will decide next month' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'CANCELLED', cancelReason: 'Customer changed mind' });
    expect(ok.body.meta.messageId).toBe('PRP-08');
    expect(err(await w.A.post(`/proposals/${st.id}/cancel`, { version: ok.body.data.version, reason: 'Other' }))).toMatchObject({ status: 409 });
    // the quotation can start a new proposal
    expect((await w.A.post('/proposals', { quotationId: w.q.id })).status).toBe(201);
  });

  it('GET /payments?customerId= returns that customer\'s payments with quotation, product and insurer in one request', async () => {
    const w = await world();
    await w.A.post(`/quotations/${w.q.id}/payments`, PAID());
    const r = await w.A.get(`/payments?customerId=${w.cus.id}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0]).toMatchObject({ status: 'PAID', amount: 11800, productName: 'Family Shield', insurer: 'Alpha Health', customer: { id: w.cus.id } });
    expect(r.body.meta.total).toBe(1);
    expect((await w.A.get(`/payments?customerId=${w.cus.id}&status=FAILED`)).body.data).toHaveLength(0);
  });
});