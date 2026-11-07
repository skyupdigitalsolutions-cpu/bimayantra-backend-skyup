/**
 * Module 8 Stage 4 — P-24 price versions (the advisor's private price; SkyUp's reference price).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, err, login, newMobile, registerAdvisor, resetState, seedAdmin, startTestEnv, stepUp, stopTestEnv } from './helpers.js';
import { clock, istToday } from '../src/lib/clock.js';
import { User } from '../src/modules/users/user.model.js';
import { normalizeMobile } from '../src/lib/phone.js';
import { Insurer } from '../src/modules/insurers/insurer.model.js';
import { InsuranceType, TemplateVersion } from '../src/modules/catalogue/types.model.js';
import { PriceVersion } from '../src/modules/catalogue/price.model.js';
import { priceOn } from '../src/modules/catalogue/prices.service.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(async () => { clock.setOffset(0); await resetState(); });

/** An IST day as DD-MM-YYYY and as YYYY-MM-DD, n days from today. */
const day = (n: number) => { const d = new Date(`${istToday()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); const iso = d.toISOString().slice(0, 10); return { dmy: `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`, iso }; };
const fieldIds = (r: { body: { error?: { fields?: Array<{ field: string; messageId: string }> } } }) => Object.fromEntries((r.body.error?.fields ?? []).map((f) => [f.field, f.messageId]));

const FACTORS = [
  { key: 'age', name: 'Age of eldest', kind: 'BAND', source: 'Age of the eldest insured person', bands: [{ from: 18, to: 35 }, { from: 36, to: 65 }] },
  { key: 'zone', name: 'Zone', kind: 'VALUE', source: 'Asked in the quotation', values: ['Zone A', 'Zone B'] },
];
const FULL = [
  { factors: { age: '18-35', zone: 'Zone A' }, basePremium: 9000 }, { factors: { age: '18-35', zone: 'Zone B' }, basePremium: 8000 },
  { factors: { age: '36-65', zone: 'Zone A' }, basePremium: 15000 }, { factors: { age: '36-65', zone: 'Zone B' }, basePremium: 13000 },
];
const DATA = {
  name: 'Family Shield', uin: 'ALPHLIP21001V012122', launchDate: '01-01-2026', adultMin: 18, adultMax: 65, sumInsured: { options: [500000] },
  policyTerms: [1], pricingMode: 'RATE_TABLE', taxPercent: 18, features: { room_rent: { value: 5000 } },
};

async function catalogue() {
  const ins = await Insurer.create({ name: 'Alpha Health', nameKey: 'alpha health', shortCode: 'ALPHA', category: 'Standalone Health', irdaiRegNo: 'R-1', paymentDomains: ['alpha.in'], status: 'ACTIVE' });
  const type = await InsuranceType.create({ name: 'Health', nameKey: 'health' });
  await TemplateVersion.create({ typeId: type._id, number: 1, status: 'ACTIVE', isOpen: null, makerId: 'x', factors: FACTORS,
    features: [{ key: 'room_rent', name: 'Room rent limit', group: 'Limits and sub-limits', dataType: 'Amount in ₹', requiredToPublish: true, order: 1 }] });
  return { insurerId: ins._id, typeId: type._id };
}
async function ownProduct(token: string, cat: { insurerId: string; typeId: string }, code = 'MY-1') {
  return (await as(token).post('/my-products', { insurerId: cat.insurerId, typeId: cat.typeId, code, data: DATA })).body.data as { id: string };
}
const price = (token: string, pid: string, from: string, extra: object = {}) => as(token).post(`/products/${pid}/prices`, { effectiveFrom: from, taxPercent: 18, rows: FULL, ...extra });

describe('P-24 price versions', () => {
  it('the first price starts today (CURRENT); AC-P24-1: a new price from day 5 closes it on day 4 (CAT-37), SCHEDULED until then', async () => {
    const cat = await catalogue();
    const adv = await registerAdvisor('Asha Rao');
    const p = await ownProduct(adv.token, cat);
    const v1 = await price(adv.token, p.id, day(0).dmy);
    expect(v1.status).toBe(201);
    expect(v1.body.data).toMatchObject({ name: 'v1', status: 'CURRENT', effectiveTo: null, rowCount: 4 });
    const v2 = await price(adv.token, p.id, day(5).dmy);
    expect(v2.body.meta.message).toBe(`New price from ${day(5).dmy} saved. The current price applies until ${day(4).dmy}.`);
    expect(v2.body.data.status).toBe('SCHEDULED');
    const list = (await as(adv.token).get(`/products/${p.id}/prices`)).body.data;
    expect(list.map((x: { name: string; status: string; effectiveTo: string | null }) => `${x.name}:${x.status}:${x.effectiveTo}`)).toEqual([`v2:SCHEDULED:null`, `v1:CURRENT:${day(4).iso}`]);
    // day 5 arrives: v2 applies without any job having run
    clock.setOffset(5 * 86_400_000);
    const again = await login(adv.mobile); // the earlier sign-in has expired 5 days later
    const later = (await as(again.token).get(`/products/${p.id}/prices`)).body.data;
    expect(later.map((x: { status: string }) => x.status)).toEqual(['CURRENT', 'CLOSED']);
  });

  it('AC-P24-4: the price that applied on a day stays findable after a new one starts', async () => {
    const cat = await catalogue();
    const adv = await registerAdvisor('Asha Rao');
    const p = await ownProduct(adv.token, cat);
    const v1 = (await price(adv.token, p.id, day(0).dmy)).body.data;
    const v2 = (await price(adv.token, p.id, day(3).dmy)).body.data;
    expect((await priceOn(adv.user.accountId!, p.id, day(1).iso))!._id).toBe(v1.id);
    expect((await priceOn(adv.user.accountId!, p.id, day(3).iso))!._id).toBe(v2.id);
  });

  it('CAT-18 before today; AC-P24-2 on or before the current start (CAT-38); same date as a scheduled one (CAT-17)', async () => {
    const cat = await catalogue();
    const adv = await registerAdvisor('Asha Rao');
    const p = await ownProduct(adv.token, cat);
    expect(fieldIds(await price(adv.token, p.id, day(-1).dmy))).toEqual({ effectiveFrom: 'CAT-18' });
    await price(adv.token, p.id, day(0).dmy);
    const same = await price(adv.token, p.id, day(0).dmy);
    expect(fieldIds(same)).toEqual({ effectiveFrom: 'CAT-38' });
    expect(JSON.stringify(same.body)).toContain(`The new price must start after ${day(0).dmy}, when the current price began.`);
    await price(adv.token, p.id, day(10).dmy);
    const clash = await price(adv.token, p.id, day(10).dmy);
    expect(fieldIds(clash)).toEqual({ effectiveFrom: 'CAT-17' });
    expect(JSON.stringify(clash.body)).toContain(`This price version overlaps v2 (${day(10).dmy} onwards).`);
  });

  it('AC-P24-3: two saves at the same moment never leave two open prices', async () => {
    const cat = await catalogue();
    const adv = await registerAdvisor('Asha Rao');
    const p = await ownProduct(adv.token, cat);
    await price(adv.token, p.id, day(0).dmy);
    const [a, b] = await Promise.all([price(adv.token, p.id, day(4).dmy), price(adv.token, p.id, day(6).dmy)]);
    expect([a.status, b.status].filter((s) => s === 201)).toHaveLength(1);
    expect(await PriceVersion.countDocuments({ productId: p.id, open: true })).toBe(1);
  });

  it('row checks: errors save nothing (CAT-19 with a report); repeats with different premiums (CAT-22); missing combinations only warn (CAT-21)', async () => {
    const cat = await catalogue();
    const adv = await registerAdvisor('Asha Rao');
    const p = await ownProduct(adv.token, cat);
    const bad = await price(adv.token, p.id, day(0).dmy, { rows: [...FULL.slice(0, 3), { factors: { age: '18-40', zone: 'Zone C' }, basePremium: -1 }] });
    expect(err(bad)).toMatchObject({ status: 400, messageId: 'CAT-19' });
    expect(bad.body.error.message).toBe('1 rows have errors. Download the error report, correct them and upload again.');
    expect(bad.body.error.details.errors[0]).toMatchObject({ row: 4 });
    expect(bad.body.error.details.errors[0].problems).toHaveLength(3);
    expect(await PriceVersion.countDocuments({ productId: p.id })).toBe(0);
    const rep = await price(adv.token, p.id, day(0).dmy, { rows: [...FULL, { factors: { age: '18-35', zone: 'Zone A' }, basePremium: 9500 }] });
    expect(err(rep)).toMatchObject({ messageId: 'CAT-22' });
    expect(rep.body.error.message).toBe('Rows 1, 5 repeat the same factors with different premiums.');
    const partial = await price(adv.token, p.id, day(0).dmy, { rows: FULL.slice(0, 3) });
    expect(partial.status).toBe(201);
    expect(partial.body.meta.warnings[0]).toMatchObject({ messageId: 'CAT-21', message: 'These combinations have no premium and cannot be quoted: 36-65 / Zone B. You can still submit.' });
    const dry = (await as(adv.token).post(`/products/${p.id}/prices/check`, { rows: FULL.slice(0, 2) })).body.data;
    expect(dry).toMatchObject({ accepted: 2, errors: [], missing: ['36-65 / Zone A', '36-65 / Zone B'] });
  });

  it('CSV: the template has one column per factor plus base_premium; a changed header is CAT-31', async () => {
    const cat = await catalogue();
    const adv = await registerAdvisor('Asha Rao');
    const p = await ownProduct(adv.token, cat);
    const t = (await as(adv.token).get(`/products/${p.id}/prices/template`)).body.data;
    expect(t.columns).toEqual(['age', 'zone', 'base_premium']);
    const csv = 'age,zone,base_premium\n18-35,Zone A,9000\n18-35,"Zone B",8000\n36-65,Zone A,"15,000"\n36-65,Zone B,13000\n';
    const ok = await price(adv.token, p.id, day(0).dmy, { rows: undefined, csv });
    expect(ok.body.data.rowCount).toBe(4);
    expect(err(await as(adv.token).post(`/products/${p.id}/prices/check`, { csv: 'Age,zone,premium\n' }))).toMatchObject({ messageId: 'CAT-31' });
  });

  it('a SCHEDULED price can be cancelled (CAT-25) and the previous one is open again; a CURRENT one cannot', async () => {
    const cat = await catalogue();
    const adv = await registerAdvisor('Asha Rao');
    const p = await ownProduct(adv.token, cat);
    const v1 = (await price(adv.token, p.id, day(0).dmy)).body.data;
    const v2 = (await price(adv.token, p.id, day(5).dmy)).body.data;
    const c = await as(adv.token).post(`/products/${p.id}/prices/${v2.id}/cancel`, {});
    expect(c.body.meta.message).toBe('Price version v2 cancelled.');
    expect((await PriceVersion.findById(v1.id).lean())).toMatchObject({ effectiveTo: null, open: true });
    expect(err(await as(adv.token).post(`/products/${p.id}/prices/${v1.id}/cancel`, {}))).toMatchObject({ status: 409, messageId: 'GEN-04' });
  });

  it('AC-P24-5: another advisor cannot see these prices; assistants and read-only accounts cannot write', async () => {
    const cat = await catalogue();
    const adv = await registerAdvisor('Asha Rao');
    const p = await ownProduct(adv.token, cat);
    const v1 = (await price(adv.token, p.id, day(0).dmy)).body.data;
    const other = await registerAdvisor('Ravi Kumar');
    expect(err(await as(other.token).get(`/products/${p.id}/prices`))).toMatchObject({ status: 404 }); // an own product of another account
    const m = newMobile();
    await as(adv.token).post('/assistants', { name: 'Priya Shah', mobile: m }, { 'X-Step-Up-Token': await stepUp(adv.token, adv.mobile) });
    const ast = await login(m);
    expect(err(await as(ast.token).get(`/products/${p.id}/prices`))).toMatchObject({ status: 403, messageId: 'GEN-03' });
    clock.setOffset(8 * 86_400_000); // trial over: read-only
    const ro = await login(adv.mobile);
    expect(err(await price(ro.token, p.id, day(10).dmy))).toMatchObject({ status: 403, messageId: 'SUB-03' });
    expect((await as(ro.token).get(`/products/${p.id}/prices/${v1.id}`)).status).toBe(200);
  });

  it('SkyUp reference price: a verified RATE_TABLE product can be submitted once one exists; advisors can read it to copy, never each other\u2019s', async () => {
    const cat = await catalogue();
    const sm = newMobile();
    await User.create({ accountId: null, role: 'STF', name: 'Meena Staff', mobile: normalizeMobile(sm), status: 'ACTIVE', activatedAt: new Date() });
    const staff = await login(sm);
    const S = as(staff.token);
    const c = (await S.post('/admin/products', { insurerId: cat.insurerId, typeId: cat.typeId, code: 'VER-1' })).body.data;
    const saved = (await S.put(`/admin/product-versions/${c.version.id}`, { rev: c.version.rev, data: { ...DATA, sourceLink: 'https://alpha.in/p', sourceCheckedOn: '01-10-2026' } })).body.data;
    const otp = async () => ({ 'X-Step-Up-Token': await stepUp(staff.token, sm) });
    const blocked = await S.post(`/admin/product-versions/${c.version.id}/submit`, { rev: saved.rev }, await otp());
    expect(blocked.body.error.message).toContain('a SkyUp reference price version (P-24)');
    expect((await S.post(`/admin/products/${c.productId}/prices`, { effectiveFrom: day(0).dmy, taxPercent: 18, rows: FULL })).status).toBe(201);
    const sub = await S.post(`/admin/product-versions/${c.version.id}/submit`, { rev: saved.rev }, await otp());
    expect(sub.body.meta.message).toBe('Family Shield version 1 published.'); // no admin approval
    const adv = await registerAdvisor('Asha Rao');
    const ref = (await as(adv.token).get(`/products/${c.productId}/prices/reference`)).body.data;
    expect(ref).toMatchObject({ name: 'v1', rowCount: 4 });
    expect(ref.rows).toHaveLength(4);
    expect((await as(adv.token).get(`/products/${c.productId}/prices`)).body.data).toEqual([]); // SkyUp's is not "my price"
  });
});