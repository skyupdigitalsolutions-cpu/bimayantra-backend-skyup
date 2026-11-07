/** Stage G: quotations, comparisons, payments and renewals (changes #2, #8 to #16; defaults for Q2, Q3, Q5). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, err, newMobile, registerAdvisor, resetState, startTestEnv, stopTestEnv } from './helpers.js';
import { clock, istToday } from '../src/lib/clock.js';
import { calculate } from '../src/modules/quotations/engine.js';
import { Insurer } from '../src/modules/insurers/insurer.model.js';
import { InsuranceType, TemplateVersion } from '../src/modules/catalogue/types.model.js';
import { AccountFlag, loadFlags } from '../src/modules/flags/flags.js';
import { Quotation } from '../src/modules/quotations/quotation.model.js';
import { Customer } from '../src/modules/customers/customer.model.js';
import { RenewalCycle } from '../src/modules/renewals/renewal.model.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(async () => { clock.setOffset(0); await resetState(); });

const day = (n: number) => { const d = new Date(`${istToday()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10).split('-').reverse().join('-'); };
const year = Number(istToday().slice(0, 4));

async function world() {
  const ins = await Insurer.create({ name: 'Alpha Health', nameKey: 'alpha health', shortCode: 'ALPHA', category: 'Standalone Health', irdaiRegNo: 'R-1', paymentDomains: ['alpha.in'], status: 'ACTIVE' });
  const beta = await Insurer.create({ name: 'Beta Health', nameKey: 'beta health', shortCode: 'BETA', category: 'Standalone Health', irdaiRegNo: 'R-2', paymentDomains: ['beta.in'], status: 'ACTIVE' });
  const type = await InsuranceType.create({ name: 'Health', nameKey: 'health' });
  await TemplateVersion.create({ typeId: type._id, number: 1, status: 'ACTIVE', isOpen: null, makerId: 'x', features: [], factors: [{ key: 'age', name: 'Age of eldest', kind: 'BAND', source: 'Age of the eldest insured person', bands: [{ from: 0, to: 75 }] }] });
  const adv = await registerAdvisor('Asha Rao');
  const A = as(adv.token);
  let p = (await A.get('/profile')).body.data;
  await A.put('/profile/professional', { version: p.sections.professional.version, advisorType: 'POSP', categories: ['Health'], licenceNumber: 'IRDA-123', licenceValidUntil: day(400) });
  p = (await A.get('/profile')).body.data; // sharing needs a complete profile (PRF-03)
  await A.put('/profile/personal', { version: p.sections.personal.version, dob: '15-04-1988' });
  await A.put('/profile/contact', { version: p.sections.contact.version, email: 'asha@example.com', address1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' });
  await A.post('/my-insurers', { insurerId: ins._id, agentCode: 'AG-77', declaration: true });
  await A.post('/my-insurers', { insurerId: beta._id, agentCode: 'BT-1', declaration: true });
  const data = { name: 'Family Shield', uin: 'UIN0001', launchDate: '01-01-2026', adultMin: 0, adultMax: 75, sumInsured: { min: 300000, max: 1500000 }, policyTerms: [1], taxPercent: 18,
    addOns: [{ name: 'OPD cover', priceType: 'PERCENT', value: 10 }, { name: 'Room upgrade', priceType: 'FIXED', value: 1200 }] };
  const prod = (await A.post('/my-products', { insurerId: ins._id, typeId: type._id, code: 'FS', data: { ...data, pricingMode: 'RATE_TABLE' },
    variants: [{ name: 'Silver', sumInsuredMin: 300000, sumInsuredMax: 500000 }, { name: 'Gold', sumInsuredMin: 500000, sumInsuredMax: 1500000 }] })).body.data;
  await A.post(`/products/${prod.id}/prices`, { effectiveFrom: day(0), taxPercent: 18, rows: [{ factors: { age: '0-75' }, basePremium: 10000 }] });
  const manual = (await A.post('/my-products', { insurerId: ins._id, typeId: type._id, code: 'MAN', data: { ...data, name: 'Manual Plan', pricingMode: 'MANUAL_ENTRY' } })).body.data;
  const betaProd = (await A.post('/my-products', { insurerId: beta._id, typeId: type._id, code: 'BP', data: { ...data, name: 'Beta Plan', addOns: [], pricingMode: 'MANUAL_ENTRY' } })).body.data;
  const cus = (await A.post('/customers', { name: 'Meena Iyer', mobile: newMobile(), dob: `15-04-${year - 40}` })).body.data;
  const son = (await A.post(`/customers/${cus.id}/family`, { name: 'Arjun Iyer', relationship: 'Son', dob: `10-06-${year - 9}` })).body.data;
  const [silver, gold] = prod.variants as Array<{ id: string; name: string }>;
  return { adv, A, ins: ins._id as string, beta: beta._id as string, typeId: type._id as string, productId: prod.id as string, manualId: manual.id as string, betaId: betaProd.id as string, cus, son, silver: silver!, gold: gold! };
}
type W = Awaited<ReturnType<typeof world>>;
const BASE = (w: W, extra: object = {}) => ({ typeId: w.typeId, insurerId: w.ins, productId: w.productId, people: [`C:${w.cus.id}`, `F:${w.son.id}`], sumInsured: 500000, policyTerm: 1, startDate: day(1), ...extra });
async function draft(w: W, inputs: object, step = 9) {
  const q = (await w.A.post('/quotations', { customerId: w.cus.id })).body.data;
  return w.A.patch(`/quotations/${q.id}`, { version: q.version, step, inputs });
}

describe('engine (Stage G)', () => {
  it('a typed base keeps the calculated one; typed rider prices replace the calculated; custom add-ons are added and taxed', () => {
    const b = calculate({ mode: 'RATE_TABLE', base: 15000, typedBase: true, calculatedBase: 10000, taxPercent: 18,
      riders: [{ name: 'OPD cover', priceType: 'PERCENT', value: 10, typed: 900 }, { name: 'Air ambulance', priceType: 'FIXED', value: 800, custom: true }] });
    expect(b).toMatchObject({ entryMode: 'TYPED', calculatedBase: 10000, base: 15000, ridersTotal: 1700, final: 19706 }); // (15000 + 900 + 800) × 1.18
    expect(b.riders).toEqual([{ name: 'OPD cover', amount: 900, calculated: 1500, typed: true }, { name: 'Air ambulance', amount: 800, custom: true, calculated: null }]);
    // manual entry: the net premium holds the product's riders; only typed-price riders and custom add-ons are added
    const m = calculate({ mode: 'MANUAL_ENTRY', base: 20000, taxAmount: 3600, riders: [{ name: 'OPD cover', priceType: 'PERCENT', value: 10 }, { name: 'Air ambulance', priceType: 'FIXED', value: 800, custom: true }] });
    expect(m).toMatchObject({ ridersTotal: 800, final: 24400, entryMode: 'CALCULATED', calculatedBase: null });
  });
});

describe('#8 #9 #10 #12 the quotation', () => {
  it('typed base for two people overrides the rate table; one person or manual entry is refused (QT-49)', async () => {
    const w = await world();
    const d = (await draft(w, BASE(w, { typedBasePremium: 14500 }))).body.data;
    const c = (await w.A.post(`/quotations/${d.id}/calculate`, {})).body.data.calc.breakdown;
    expect(c).toMatchObject({ entryMode: 'TYPED', base: 14500, calculatedBase: 10000, final: 17110 });
    expect((await draft(w, BASE(w, { people: [`C:${w.cus.id}`], typedBasePremium: 14500 }))).body.error.fields[0]).toMatchObject({ field: 'typedBasePremium', messageId: 'QT-49' });
    expect((await draft(w, BASE(w, { productId: w.manualId, typedBasePremium: 14500, manual: { netPremium: 1, taxAmount: 0 } }))).body.error.fields[0]).toMatchObject({ field: 'typedBasePremium', messageId: 'QT-49' });
  });

  it('typed rider prices, own add-ons and benefits reach the snapshot and the PDF; the variant is kept beside the snapshot', async () => {
    const w = await world();
    const bad = await draft(w, BASE(w, { riders: ['OPD cover'], riderPrices: { 'Room upgrade': 100 } }));
    expect(bad.body.error.fields[0]).toMatchObject({ field: 'riderPrices.Room upgrade', messageId: 'VAL-22' });
    expect((await draft(w, BASE(w, { customAddOns: [{ name: 'opd COVER', price: 10 }] }))).body.error.fields[0]).toMatchObject({ field: 'customAddOns.0.name', messageId: 'QT-48' });
    const d = (await draft(w, BASE(w, {
      variantId: w.silver.id, riders: ['OPD cover'], riderPrices: { 'OPD cover': 900 }, customAddOns: [{ name: 'Air ambulance cover', price: 800 }],
      benefits: [{ name: 'Free health check-up', description: 'Once a year', cost: 1500, showOnPdf: true }, { name: 'Internal note', showOnPdf: false }],
      discount: { kind: 'AMOUNT', value: 500, reference: 'Family of three', preset: 'FAMILY' },
    }))).body.data;
    const calc = (await w.A.post(`/quotations/${d.id}/calculate`, {})).body.data.calc.breakdown;
    expect(calc).toMatchObject({ base: 10000, ridersTotal: 1700, discount: 500, discountPreset: 'FAMILY', final: 13216 }); // (10000 + 900 + 800 − 500) × 1.18; benefits are not added
    expect((await w.A.post(`/quotations/${d.id}/generate`, {})).status).toBe(200);
    const q = (await Quotation.findById(d.id).lean())!;
    const rev = q.revisions[0]!;
    expect(rev.variantId).toBe(w.silver.id);
    expect(rev.snapshot).toMatchObject({ product: { variantName: 'Silver' }, benefits: [{ name: 'Free health check-up' }, { name: 'Internal note', showOnPdf: false }] });
    // the discount reference is still required with a preset (Q5 default, QT-37)
    expect((await draft(w, BASE(w, { discount: { kind: 'AMOUNT', value: 500, preset: 'LONG_TERM' } }), 9).then(async (r) => w.A.post(`/quotations/${r.body.data.id}/calculate`, {}))).body.error.fields[0]).toMatchObject({ messageId: 'QT-37' });
  });

  it('the variant must be one of the product\'s, and the sum insured inside its range (QT-46)', async () => {
    const w = await world();
    const other = (await w.A.get(`/products/${w.manualId}`)).body.data.variants[0].id;
    expect((await draft(w, BASE(w, { variantId: other }))).body.error.fields[0]).toMatchObject({ field: 'variantId', messageId: 'VAL-22' });
    const r = await draft(w, BASE(w, { variantId: w.gold.id, sumInsured: 400000 }));
    expect(r.body.error.fields[0]).toMatchObject({ field: 'sumInsured', messageId: 'QT-46', message: 'Gold covers a sum insured from 500000 to 1500000.' });
  });
});

describe('#11 accept only after payment (switches)', () => {
  it('with both switches on: Mark accepted needs a PAID payment (QT-45); recording a payment no longer accepts', async () => {
    const w = await world();
    for (const flag of ['quotation_accept_requires_payment', 'payment_skips_auto_accept']) await AccountFlag.create({ _id: `${flag}|${w.adv.user.accountId}`, flag, accountId: w.adv.user.accountId, enabled: true, reason: 'test', updatedBy: 'x' });
    await loadFlags();
    const d = (await draft(w, BASE(w))).body.data;
    await w.A.post(`/quotations/${d.id}/calculate`, {});
    await w.A.post(`/quotations/${d.id}/generate`, {});
    const sh = await w.A.post(`/quotations/${d.id}/share`, { channel: 'LINK' });
    expect(sh.status).toBe(200);
    let q = (await w.A.get(`/quotations/${d.id}`)).body.data;
    expect(q.status).toBe('SHARED');
    expect(err(await w.A.post(`/quotations/${d.id}/accept`, { version: q.version }))).toMatchObject({ status: 409, messageId: 'QT-45' });
    const paid = await w.A.post(`/quotations/${d.id}/payments`, { mode: 'UPI', amount: q.revisions[0].final, paymentDate: day(0), reference: 'UTR-123456', declaration: true });
    expect(paid.status).toBe(201);
    q = (await w.A.get(`/quotations/${d.id}`)).body.data;
    expect(q.status).toBe('SHARED'); // not accepted automatically
    expect((await w.A.post(`/quotations/${d.id}/accept`, { version: q.version })).body.data.status).toBe('ACCEPTED');
  });

  it('with the switches off (default) nothing changes: payment accepts', async () => {
    const w = await world();
    const d = (await draft(w, BASE(w))).body.data;
    await w.A.post(`/quotations/${d.id}/calculate`, {});
    await w.A.post(`/quotations/${d.id}/generate`, {});
    await w.A.post(`/quotations/${d.id}/share`, { channel: 'LINK' });
    const q = (await w.A.get(`/quotations/${d.id}`)).body.data;
    await w.A.post(`/quotations/${d.id}/payments`, { mode: 'UPI', amount: q.revisions[0].final, paymentDate: day(0), reference: 'UTR-654321', declaration: true });
    expect((await w.A.get(`/quotations/${d.id}`)).body.data.status).toBe('ACCEPTED');
  });
});

describe('#13 comparisons', () => {
  it('variants of one product are separate options, each with its own typed premium and add-ons; choosing carries the variant', async () => {
    const w = await world();
    const c = (await w.A.post('/comparisons', { customerId: w.cus.id })).body.data;
    const inputs = { typeId: w.typeId, people: [`C:${w.cus.id}`, `F:${w.son.id}`], sumInsured: 500000, policyTerm: 1, startDate: day(1) };
    const dup = await w.A.put(`/comparisons/${c.id}`, { version: c.version, inputs, options: [{ productId: w.productId, variantId: w.silver.id }, { productId: w.productId, variantId: w.silver.id }] });
    expect(dup.body.error.fields[0].messageId).toBe('QT-36');
    const s = await w.A.put(`/comparisons/${c.id}`, { version: c.version, inputs, options: [
      { productId: w.productId, variantId: w.silver.id },
      { productId: w.productId, variantId: w.gold.id, typedBasePremium: 12000, customAddOns: [{ name: 'Air ambulance cover', price: 800 }] },
    ] });
    expect(s.status).toBe(200);
    const pv = (await w.A.post(`/comparisons/${c.id}/preview`, {})).body.data;
    const cols = pv.columns as Array<{ name: string; premium: number; variantId: string }>;
    expect(cols.map((x) => [x.name, x.premium])).toEqual([['Family Shield · Silver', 11800], ['Family Shield · Gold', 15104]]); // 10000 × 1.18; (12000 + 800) × 1.18
    await w.A.post(`/comparisons/${c.id}/generate`, {});
    const g = (await w.A.get(`/comparisons/${c.id}`)).body.data;
    const ch = await w.A.post(`/comparisons/${c.id}/choose`, { version: g.version, productId: w.productId, variantId: w.gold.id });
    expect(ch.body.data.chosenVariantId ?? ch.body.data.comparison?.chosenVariantId).toBe(w.gold.id);
    const made = (await w.A.post(`/comparisons/${c.id}/create-quotation`, {})).body.data;
    expect((await Quotation.findById(made.id).lean())!.inputs).toMatchObject({ variantId: w.gold.id, typedBasePremium: 12000, customAddOns: [{ name: 'Air ambulance cover', price: 800 }] });
  });
});

describe('#14 #15 #16 renewal modes', () => {
  async function renewing() {
    const w = await world();
    const pol = (await w.A.post('/policies/existing', { customerId: w.cus.id, insurerId: w.ins, productId: w.productId, typeId: w.typeId, soldByMe: true, insured: [`C:${w.cus.id}`, `F:${w.son.id}`], policyNumber: 'FS-OLD-1',
      issueDate: day(-334), startDate: day(-334), endDate: day(30), frequency: 'Yearly', sumInsured: 500000, premium: 11800 })).body.data;
    const cycleId = (await RenewalCycle.findOne({ policyId: pol.id }).lean())!._id;
    return { ...w, pol, cycleId };
  }
  it('same policy (default): the notice premium typed; last year vs this year', async () => {
    const w = await renewing();
    const r = await w.A.post(`/renewals/${w.cycleId}/renewal-quotation`, { mode: 'SAME_POLICY', typedRenewalPremium: 12500 });
    expect(r.status).toBe(201);
    const q = r.body.data;
    expect(q.inputs).toMatchObject({ typedBasePremium: 12500, renewalOf: w.pol.id, productId: w.productId });
    const c = (await w.A.post(`/quotations/${q.id}/calculate`, {})).body.data;
    expect(c.renewal).toMatchObject({ mode: 'SAME_POLICY', previousPremium: 11800, thisYear: 14750, changePercent: 25 }); // 12,500 × 1.18
    expect((await RenewalCycle.findById(w.cycleId).lean())).toMatchObject({ renewalMode: 'SAME_POLICY', renewalQuotationId: q.id });
    // the earlier call with no body still works
    expect((await w.A.post(`/renewals/${w.cycleId}/renewal-quotation`, {})).status).toBe(201);
  });

  it('new quotation: another insurer with portability; portability with the same insurer is refused (QT-50)', async () => {
    const w = await renewing();
    expect((await w.A.post(`/renewals/${w.cycleId}/renewal-quotation`, { mode: 'NEW_QUOTATION', portabilityRequested: true })).body.error.fields[0]).toMatchObject({ field: 'portabilityRequested', messageId: 'QT-50' });
    const r = await w.A.post(`/renewals/${w.cycleId}/renewal-quotation`, { mode: 'NEW_QUOTATION', insurerId: w.beta, productId: w.betaId, sumInsured: 1000000, portabilityRequested: true });
    expect(r.status).toBe(201);
    expect(r.body.data.inputs).toMatchObject({ insurerId: w.beta, productId: w.betaId, sumInsured: 1000000, renewalOf: w.pol.id });
    expect(r.body.data.renewal).toMatchObject({ mode: 'NEW_QUOTATION', portabilityRequested: true, fromInsurerId: w.ins });
  });

  it('compare options: a comparison with the same people and sum insured, linked to the cycle', async () => {
    const w = await renewing();
    const r = await w.A.post(`/renewals/${w.cycleId}/renewal-quotation`, { mode: 'COMPARISON' });
    expect(r.status).toBe(201);
    const cmp = r.body.data.comparison;
    expect(cmp.inputs).toMatchObject({ people: [`C:${w.cus.id}`, `F:${w.son.id}`], sumInsured: 500000, renewalOf: w.pol.id });
    expect((await RenewalCycle.findById(w.cycleId).lean())).toMatchObject({ renewalMode: 'COMPARISON', renewalComparisonId: cmp.id, status: 'IN_FOLLOW_UP' });
    void Customer;
  });
});