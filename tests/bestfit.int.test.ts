/** Module 9 — P-26 best-fit ranking. Totals are checked by hand against CFG-179 and CFG-168. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, err, login, newMobile, registerAdvisor, resetState, startTestEnv, stepUp, stopTestEnv } from './helpers.js';
import { Insurer } from '../src/modules/insurers/insurer.model.js';
import { InsuranceType, TemplateVersion } from '../src/modules/catalogue/types.model.js';
import { RankingLog, budgetScore, claimScore, coPayScore, roomRentScore, waitingScore } from '../src/modules/bestfit/bestfit.service.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

const FEATURES = [
  { key: 'room_rent', name: 'Room rent limit', group: 'Limits and sub-limits', dataType: 'Text', requiredToPublish: false, order: 1 },
  { key: 'co_pay', name: 'Co-pay', group: 'Limits and sub-limits', dataType: 'Percentage', requiredToPublish: false, order: 2 },
  { key: 'ped_wait', name: 'Pre-existing disease waiting period', group: 'Waiting periods', dataType: 'Months', requiredToPublish: false, order: 3 },
  { key: 'csr', name: 'Claim settlement ratio', group: 'Other', dataType: 'Percentage', requiredToPublish: false, order: 4 },
];
const year = Number(new Date().toISOString().slice(0, 4));

async function world() {
  const a = await Insurer.create({ name: 'Alpha Health', nameKey: 'alpha health', shortCode: 'ALPHA', category: 'Standalone Health', irdaiRegNo: 'R-1', paymentDomains: ['alpha.in'], status: 'ACTIVE' });
  const b = await Insurer.create({ name: 'Beta Health', nameKey: 'beta health', shortCode: 'BETA', category: 'Standalone Health', irdaiRegNo: 'R-2', paymentDomains: ['beta.in'], status: 'ACTIVE' });
  const type = await InsuranceType.create({ name: 'Health', nameKey: 'health' });
  await TemplateVersion.create({ typeId: type._id, number: 1, status: 'ACTIVE', isOpen: null, makerId: 'x', features: FEATURES,
    factors: [{ key: 'age', name: 'Age of eldest', kind: 'BAND', source: 'Age of the eldest insured person', bands: [{ from: 18, to: 35 }, { from: 36, to: 65 }] }] });
  const adv = await registerAdvisor('Asha Rao');
  const A = as(adv.token);
  const p = (await A.get('/profile')).body.data;
  await A.put('/profile/professional', { version: p.sections.professional.version, categories: ['Health'] });
  await A.post('/my-insurers', { insurerId: a._id, agentCode: 'AG-1', declaration: true }); // no agent code for Beta
  const cus = (await A.post('/customers', { name: 'Meena Iyer', mobile: newMobile(), dob: `15-04-${year - 45}` })).body.data;
  const son = (await A.post(`/customers/${cus.id}/family`, { name: 'Arjun Iyer', relationship: 'Son', dob: `10-06-${year - 9}` })).body.data;
  const base = { uin: 'UIN0001', launchDate: '01-01-2026', adultMin: 18, adultMax: 65, coversChildren: true, childMin: 0, childMax: 25, sumInsured: { options: [500000] }, policyTerms: [1], taxPercent: 18 };
  const own = async (code: string, insurerId: string, data: object) => (await A.post('/my-products', { insurerId, typeId: type._id, code, data: { ...base, name: code, ...data } })).body.data as { id: string };
  const strong = await own('STRONG', a._id, { pricingMode: 'RATE_TABLE', features: { room_rent: { value: 'No limit' }, co_pay: { value: 0 }, ped_wait: { value: 24 }, csr: { value: 98 } } });
  await A.post(`/products/${strong.id}/prices`, { effectiveFrom: new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10).split('-').reverse().join('-'), taxPercent: 18,
    rows: [{ factors: { age: '18-35' }, basePremium: 10000 }, { factors: { age: '36-65' }, basePremium: 20000 }] });
  const weak = await own('WEAK', a._id, { pricingMode: 'MANUAL_ENTRY', features: { room_rent: { value: '5000' }, co_pay: { value: 20 }, ped_wait: { value: 48 }, csr: { notStated: true } } });
  const partial = await own('PARTIAL', a._id, { pricingMode: 'MANUAL_ENTRY', adultMax: 40, features: { room_rent: { value: 'No limit' }, co_pay: { value: 0 }, ped_wait: { value: 12 }, csr: { value: 99 } } });
  const noCode = await own('NOCODE', b._id, { pricingMode: 'MANUAL_ENTRY', features: {} });
  const upcoming = await own('UPCOMING', a._id, { pricingMode: 'MANUAL_ENTRY', launchDate: '01-01-2099', features: {} });
  const noPrice = await own('NOPRICE', a._id, { pricingMode: 'RATE_TABLE', features: {} });
  return { adv, A, cus, son, typeId: type._id as string, ids: { strong: strong.id, weak: weak.id, partial: partial.id, noCode: noCode.id, upcoming: upcoming.id, noPrice: noPrice.id } };
}
const ask = (w: Awaited<ReturnType<typeof world>>, extra: object = {}) => w.A.post(`/customers/${w.cus.id}/best-fit`, { typeId: w.typeId, people: [`C:${w.cus.id}`, `F:${w.son.id}`], budget: 25000, priority: 'LOWEST_PREMIUM', sumInsured: 500000, ...extra });

describe('P-26 best-fit ranking', () => {
  it('CFG-179 part scores, each with its reason', () => {
    expect(budgetScore(20000, 25000)).toMatchObject({ score: 100 });
    expect(budgetScore(30000, 25000)).toMatchObject({ score: 60, reason: '₹30,000 is 20% over the budget' });
    expect(budgetScore(40000, 25000).score).toBe(0);
    expect(roomRentScore({ value: 'Single private room' })).toEqual({ score: 80, reason: 'Room rent: single private room' });
    expect(roomRentScore({ value: 1 }, 'Percentage').score).toBe(50);
    expect(coPayScore({ value: 10 }).score).toBe(60);
    expect(waitingScore({ value: 36 }, 'Months')).toEqual({ score: 50, reason: 'Pre-existing waiting period: 3 years' });
    expect(claimScore({ value: 92 }).score).toBe(60);
    expect(claimScore({ value: 75 }).score).toBe(0);
    expect(claimScore({ notStated: true })).toEqual({ score: 0, reason: 'Claim settlement ratio: Not stated by insurer' });
  });

  it('AC-P26-1/3/4: only quotable products; full coverage first; partial labelled QT-41; missing facts 0 "Not stated by insurer" (FIT-03)', async () => {
    const w = await world();
    const r = await ask(w);
    expect(r.status).toBe(200);
    expect(r.body.meta.message).toBe('3 products ranked. Each score shows its reason.');
    const res = r.body.data.results as Array<{ productId: string; name: string; total: number; premium: number | null; covers: number; of: number; coverage?: { message: string }; parts: Record<string, { score: number; reason: string }> }>;
    expect(res.map((x) => x.name)).toEqual(['STRONG', 'WEAK', 'PARTIAL']); // PARTIAL has the best facts but covers 1 of 2
    expect(res.map((x) => x.productId)).not.toEqual(expect.arrayContaining([w.ids.noCode, w.ids.upcoming, w.ids.noPrice]));
    const [strong, weak, partial] = res;
    expect(strong).toMatchObject({ premium: 23600, total: 95.5, covers: 2, of: 2 }); // 20,000 + 18% for age 45; (100×50+100×10+100×10+75×10+90×20)/100
    expect(strong!.parts.roomRent).toEqual({ score: 100, reason: 'Room rent: no limit' });
    expect(weak!.parts.claimRatio).toEqual({ score: 0, reason: 'Claim settlement ratio: Not stated by insurer' });
    expect(weak!.parts.budget?.score).toBe(0);
    expect(partial!.coverage!.message).toBe('Covers 1 of 2 selected people. Not covered: Meena Iyer (outside its age limits).');
    expect(r.body.data.summary).toMatchObject({ messageId: 'FIT-05' }); // no AI service: the scores stand alone
  });

  it('AC-P26-2: changing the priority changes the totals exactly as the CFG-168 weights predict', async () => {
    const w = await world();
    for (const [priority, wts] of [['LOWEST_PREMIUM', [50, 10, 10, 10, 20]], ['CLAIM_RELIABILITY', [15, 10, 10, 15, 50]], ['PRE_EXISTING', [15, 10, 15, 45, 15]]] as const) {
      const res = (await ask(w, { priority })).body.data.results as Array<{ total: number; parts: Record<string, { score: number }> }>;
      for (const x of res) {
        const s = ['budget', 'roomRent', 'coPay', 'waiting', 'claimRatio'].map((k) => x.parts[k]!.score);
        expect(x.total).toBe(Math.round(s.reduce((t, v, i) => t + v * wts[i]!, 0) / 100 * 10) / 10);
      }
    }
  });

  it('QT-05 for a person without a date of birth; FIT-02 when nothing is quotable; the log keeps answers, scores and the choice', async () => {
    const w = await world();
    const nodob = (await w.A.post(`/customers/${w.cus.id}/family`, { name: 'Kavya Iyer', relationship: 'Daughter' })).body.data;
    const r = await ask(w, { people: [`C:${w.cus.id}`, `F:${nodob.id}`] });
    expect(err(r)).toMatchObject({ status: 400 });
    expect(JSON.stringify(r.body)).toContain('Add the date of birth for Kavya Iyer.');
    const none = await ask(w, { sumInsured: 900000 });
    expect(none.body.meta.message).toBe('No products you can quote match these answers. Check your agent codes, authorised categories and prices.');
    const ok = (await ask(w)).body.data;
    await w.A.post(`/customers/${w.cus.id}/best-fit/${ok.rankingId}/choose`, { productId: w.ids.strong });
    expect(await RankingLog.findById(ok.rankingId).lean()).toMatchObject({ chosenProductId: w.ids.strong, answers: { priority: 'LOWEST_PREMIUM', budget: 25000 } });
  });

  it('an assistant can rank; another account cannot use this customer', async () => {
    const w = await world();
    const m = newMobile();
    await w.A.post('/assistants', { name: 'Priya Shah', mobile: m }, { 'X-Step-Up-Token': await stepUp(w.adv.token, w.adv.mobile) });
    const ast = await login(m);
    expect((await as(ast.token).post(`/customers/${w.cus.id}/best-fit`, { typeId: w.typeId, people: [`C:${w.cus.id}`], budget: 25000, priority: 'BEST_COVERAGE', sumInsured: 500000 })).status).toBe(200);
    const other = await registerAdvisor('Ravi Kumar');
    expect(err(await as(other.token).post(`/customers/${w.cus.id}/best-fit`, { typeId: w.typeId, people: [`C:${w.cus.id}`], budget: 25000, priority: 'BEST_COVERAGE', sumInsured: 500000 }))).toMatchObject({ status: 404 });
  });

  it('authorised categories include types SkyUp added to the catalogue (P-21 + Type); unknown ones are refused (VAL-22)', async () => {
    await InsuranceType.create({ name: 'Pet', nameKey: 'pet' });
    const adv = await registerAdvisor('Asha Rao');
    const A = as(adv.token);
    const p = (await A.get('/profile')).body.data;
    expect(p.options.categories).toEqual(expect.arrayContaining(['Health', 'Pet']));
    const ok = await A.put('/profile/professional', { version: p.sections.professional.version, categories: ['Pet', 'Health'] });
    expect(ok.status).toBe(200);
    const bad = await A.put('/profile/professional', { version: ok.body.data.sections.professional.version, categories: ['Imaginary'] });
    expect(err(bad)).toMatchObject({ status: 400 });
    expect(bad.body.error.fields[0]).toMatchObject({ field: 'categories', messageId: 'VAL-22' });
  });
});