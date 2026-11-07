/**
 * Module 8 Stage 3a — P-22 products and commercials, P-25 approve, publish and withdraw.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, err, login, newMobile, registerAdvisor, resetState, seedAdmin, startTestEnv, stepUp, stopTestEnv } from './helpers.js';
import { User } from '../src/modules/users/user.model.js';
import { normalizeMobile } from '../src/lib/phone.js';
import { Insurer } from '../src/modules/insurers/insurer.model.js';
import { InsuranceType, TemplateVersion } from '../src/modules/catalogue/types.model.js';
import { ProductVersion } from '../src/modules/catalogue/product.model.js';
import { fitsEntryAge } from '../src/modules/catalogue/products.service.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

const fieldIds = (r: { body: { error?: { fields?: Array<{ field: string; messageId: string }> } } }) => Object.fromEntries((r.body.error?.fields ?? []).map((f) => [f.field, f.messageId]));

/** A live insurer and a Health type whose ACTIVE template has two required features. */
async function catalogue() {
  const ins = await Insurer.create({ name: 'Alpha Health', nameKey: 'alpha health', shortCode: 'ALPHA', category: 'Standalone Health', irdaiRegNo: 'R-1', paymentDomains: ['alpha.in'], status: 'ACTIVE' });
  const type = await InsuranceType.create({ name: 'Health', nameKey: 'health' });
  const tpl = await TemplateVersion.create({ typeId: type._id, number: 1, status: 'ACTIVE', isOpen: null, makerId: 'x', features: [
    { key: 'room_rent', name: 'Room rent limit', group: 'Limits and sub-limits', dataType: 'Amount in ₹', requiredToPublish: true, order: 1 },
    { key: 'ped_wait', name: 'Pre-existing disease waiting period', group: 'Waiting periods', dataType: 'Months', requiredToPublish: true, order: 2 },
  ], factors: [{ key: 'age', name: 'Age', kind: 'BAND', source: 'Age of the eldest insured person', bands: [{ from: 18, to: 65 }] }] });
  return { insurerId: ins._id, typeId: type._id, tplId: tpl._id };
}
const DATA = {
  name: 'Family Shield', description: 'Family floater', uin: 'ALPHLIP21001V012122', launchDate: '01-01-2026',
  adultMin: 18, adultMax: 65, coversChildren: true, childMin: 0, childMax: 25,
  sumInsured: { options: [500000, 1000000] }, policyTerms: [1, 2], pricingMode: 'MANUAL_ENTRY', taxPercent: 18,
  nomineeRequired: true, maxNominees: 2, sourceLink: 'https://alpha.in/family-shield', sourceCheckedOn: '01-10-2026',
  features: { room_rent: { value: 5000, page: 3 }, ped_wait: { notStated: true } },
};

async function people() {
  const a = await seedAdmin();
  const b = await seedAdmin();
  const sm = newMobile();
  await User.create({ accountId: null, role: 'STF', name: 'Meena Staff', mobile: normalizeMobile(sm), status: 'ACTIVE', activatedAt: new Date() });
  const staff = { mobile: sm, ...(await login(sm)) };
  const decide = async (who: { token: string; mobile: string }, path: string, body: object) => as(who.token).post(path, body, { 'X-Step-Up-Token': await stepUp(who.token, who.mobile) });
  return { a, b, staff, decide };
}

/** Staff creates a verified product and saves DATA as a draft (not published). */
async function drafted(staff: { token: string }, cat: { insurerId: string; typeId: string }, data: object = DATA, code = 'FAM-SHIELD') {
  const c = (await as(staff.token).post('/admin/products', { insurerId: cat.insurerId, typeId: cat.typeId, code })).body.data;
  const saved = (await as(staff.token).put(`/admin/product-versions/${c.version.id}`, { rev: c.version.rev, data })).body.data;
  return { productId: c.productId as string, vid: c.version.id as string, rev: saved.rev as number };
}
/** …and publishes it with the OTP (no admin approval): returns the response (published, or the publish checks' errors). */
async function submitted(staff: { token: string; mobile: string }, cat: { insurerId: string; typeId: string }, data: object = DATA, code = 'FAM-SHIELD') {
  const d = await drafted(staff, cat, data, code);
  const sub = await as(staff.token).post(`/admin/product-versions/${d.vid}/submit`, { rev: d.rev }, { 'X-Step-Up-Token': await stepUp(staff.token, staff.mobile) });
  return { productId: d.productId, vid: d.vid, sub };
}

describe('P-22 / P-25 verified products', () => {
  it('AC-P22-1: a product without a UIN cannot be saved (CAT-33); incomplete products list what is missing (CAT-13)', async () => {
    const cat = await catalogue();
    const { staff } = await people();
    const noUin = await submitted(staff, cat, { ...DATA, uin: undefined });
    expect(fieldIds(noUin.sub)).toEqual({ uin: 'CAT-33' });
    expect(JSON.stringify(noUin.sub.body)).toContain('UIN is required to save a product.');
    const thin = await submitted(staff, cat, { uin: 'ALPHLIP21001V012122', features: { room_rent: { value: 5000 } } }, 'THIN');
    expect(err(thin.sub)).toMatchObject({ status: 400, messageId: 'CAT-13' });
    expect(thin.sub.body.error.message).toBe('This product cannot be saved yet: product name, launch date, pricing mode, tax %, adult entry ages, sum insured options or range, policy term options, a value for Pre-existing disease waiting period, the insurer page link and the date it was checked.');
  });

  it('CAT-16 / CAT-34: adult minimum above maximum; a child band beyond the adult maximum', async () => {
    const cat = await catalogue();
    const { staff } = await people();
    const r = (await submitted(staff, cat, { ...DATA, adultMin: 70, adultMax: 65, childMax: 80 })).sub;
    expect(fieldIds(r)).toEqual({ adultMax: 'CAT-16', childMax: 'CAT-34' });
  });

  it('no admin approval: publishing needs the OTP (AUTH-26) and is live at once (CAT-42); the OTP verification is stored', async () => {
    const cat = await catalogue();
    const { a } = await people();
    const d = await drafted(a, cat);
    expect(err(await as(a.token).post(`/admin/product-versions/${d.vid}/submit`, { rev: d.rev }))).toMatchObject({ status: 403, messageId: 'AUTH-26' });
    expect((await ProductVersion.findById(d.vid).lean())!.status).toBe('DRAFT');
    const ok = await as(a.token).post(`/admin/product-versions/${d.vid}/submit`, { rev: d.rev }, { 'X-Step-Up-Token': await stepUp(a.token, a.mobile) });
    expect(ok.body.meta.message).toBe('Family Shield version 1 published.');
    expect(ok.body.data.status).toBe('PUBLISHED');
    expect((await ProductVersion.findById(d.vid).lean())!.approvalStepUpId).toBeTruthy(); // the OTP verification is stored
  });

  it('CAT-29 still guards a version left waiting from before: changed after it was opened, it is not approved', async () => {
    const cat = await catalogue();
    const { a, staff, decide } = await people();
    const d = await drafted(staff, cat);
    await ProductVersion.updateOne({ _id: d.vid }, { $set: { status: 'PENDING_APPROVAL', makerId: 'usr_old_maker' }, $inc: { rev: 1 } }); // waiting, then touched
    const r = await decide(a, `/admin/product-versions/${d.vid}/approve`, { rev: d.rev });
    expect(err(r)).toMatchObject({ status: 409, messageId: 'CAT-29' });
  });

  it('a draft verified product is never visible to advisors; AC-P22-5: "Not stated in source" shows as "Not stated by insurer"', async () => {
    const cat = await catalogue();
    const { staff } = await people();
    const adv = await registerAdvisor('Asha Rao');
    const d = await drafted(staff, cat);
    expect((await as(adv.token).get('/products')).body.data).toEqual([]);
    expect(err(await as(adv.token).get(`/products/${d.productId}`))).toMatchObject({ status: 404 });
    await as(staff.token).post(`/admin/product-versions/${d.vid}/submit`, { rev: d.rev }, { 'X-Step-Up-Token': await stepUp(staff.token, staff.mobile) });
    const p = (await as(adv.token).get(`/products/${d.productId}`)).body.data;
    expect(p.publishedVersion.data.features).toEqual({ room_rent: { value: 5000, page: 3 }, ped_wait: { value: 'Not stated by insurer', page: null } });
    expect(p.status).toBe('ACTIVE');
  });

  it('AC-P25-3: editing makes a new draft (CAT-27); once published, version 2 is live and version 1 kept as SUPERSEDED', async () => {
    const cat = await catalogue();
    const { a, staff, decide } = await people();
    const adv = await registerAdvisor('Asha Rao');
    const { productId, vid } = await submitted(staff, cat);
    const edit = await as(staff.token).post(`/admin/products/${productId}/versions`, {});
    expect(edit.body.meta.message).toBe('Editing creates a new draft version. The published version stays live until the new one is published.');
    expect(err(await as(staff.token).post(`/admin/products/${productId}/versions`, {}))).toMatchObject({ status: 409, messageId: 'CAT-08' });
    const v2 = edit.body.data;
    expect((await as(adv.token).get(`/products/${productId}`)).body.data.publishedVersion.number).toBe(1); // still v1 while v2 is a draft
    const saved = (await as(staff.token).put(`/admin/product-versions/${v2.id}`, { rev: v2.rev, data: { ...DATA, name: 'Family Shield Plus' } })).body.data;
    await as(staff.token).post(`/admin/product-versions/${v2.id}/submit`, { rev: saved.rev }, { 'X-Step-Up-Token': await stepUp(staff.token, staff.mobile) });
    expect((await as(a.token).get('/admin/approvals')).body.data).toEqual([]); // nothing waits
    const now = (await as(adv.token).get(`/products/${productId}`)).body.data.publishedVersion;
    expect(now).toMatchObject({ number: 2, data: { name: 'Family Shield Plus' } });
    expect(await ProductVersion.findById(vid).lean()).toMatchObject({ status: 'SUPERSEDED', data: { name: 'Family Shield' } });
  });

  it('AC-P22-4 / AC-P25-4: a withdrawn product (CAT-26) is not quotable but stays listed for renewals; Make available reverses it', async () => {
    const cat = await catalogue();
    const { a, staff, decide } = await people();
    const adv = await registerAdvisor('Asha Rao');
    const { productId } = await submitted(staff, cat);
    const p = (await as(a.token).get(`/admin/products/${productId}`)).body.data;
    expect(err(await as(a.token).post(`/admin/products/${productId}/withdraw`, { version: p.version, reason: 'Insurer stopped selling it' }))).toMatchObject({ status: 403, messageId: 'AUTH-26' }); // §9.6: OTP
    const w = await decide(a, `/admin/products/${productId}/withdraw`, { version: p.version, reason: 'Insurer stopped selling it' });
    expect(w.body.meta.message).toBe('Family Shield is withdrawn. Advisors can no longer quote it.');
    expect((await as(adv.token).get('/products?quotable=true')).body.data).toEqual([]);
    expect((await as(adv.token).get('/products')).body.data[0]).toMatchObject({ status: 'WITHDRAWN', quotable: false, renewalOnly: true });
    expect(err(await decide(staff, `/admin/products/${productId}/withdraw`, { version: w.body.data.version, reason: 'x' }))).toMatchObject({ status: 403 });
    await as(a.token).post(`/admin/products/${productId}/make-available`, { version: w.body.data.version });
    expect((await as(adv.token).get('/products?quotable=true')).body.data).toHaveLength(1);
  });

  it('a brand-new product returns its first version with empty values (data: {}), never without data', async () => {
    const cat = await catalogue();
    const { staff } = await people();
    const c = (await as(staff.token).post('/admin/products', { insurerId: cat.insurerId, typeId: cat.typeId, code: 'NEW-1' })).body.data;
    expect(c.version.data).toEqual({});
    expect((await as(staff.token).get(`/admin/products/${c.productId}`)).body.data.versions[0].data).toEqual({});
  });

  it('CAT-07: a product code is unique per insurer', async () => {
    const cat = await catalogue();
    const { staff } = await people();
    await as(staff.token).post('/admin/products', { insurerId: cat.insurerId, typeId: cat.typeId, code: 'FAM-1' });
    expect(fieldIds(await as(staff.token).post('/admin/products', { insurerId: cat.insurerId, typeId: cat.typeId, code: 'fam-1' }))).toEqual({ code: 'CAT-07' });
  });
});

describe('P-22 own products and commercials', () => {
  it('an own product publishes at once (UPCOMING when the launch date is later); AC-P22-2: invisible to other accounts and SkyUp', async () => {
    const cat = await catalogue();
    const { a } = await people();
    const adv = await registerAdvisor('Asha Rao');
    const own = await as(adv.token).post('/my-products', { insurerId: cat.insurerId, typeId: cat.typeId, code: 'MY-1', data: { ...DATA, sourceLink: undefined, sourceCheckedOn: undefined, launchDate: '01-01-2099' } });
    expect(own.status).toBe(201);
    expect(own.body.data).toMatchObject({ kind: 'OWN', status: 'UPCOMING', publishedVersion: { number: 1 } });
    const other = await registerAdvisor('Ravi Kumar');
    expect((await as(other.token).get('/products')).body.data).toEqual([]);
    expect(err(await as(other.token).get(`/products/${own.body.data.id}`))).toMatchObject({ status: 404 });
    expect((await as(a.token).get('/admin/products')).body.data).toEqual([]); // SkyUp's list holds verified products only
  });

  it('CAT-36: commission is private to the advisor; AC-P22-6: an assistant cannot see or change it', async () => {
    const cat = await catalogue();
    const adv = await registerAdvisor('Asha Rao');
    const own = (await as(adv.token).post('/my-products', { insurerId: cat.insurerId, typeId: cat.typeId, code: 'MY-1', data: DATA })).body.data;
    const saved = await as(adv.token).put(`/products/${own.id}/commercials`, { commissionPercent: '12.5', notes: 'Year 1 rate' });
    expect(saved.body.meta.message).toBe('Your commission for Family Shield is saved. Only you can see it.');
    expect((await as(adv.token).get(`/products/${own.id}/commercials`)).body.data).toMatchObject({ commissionPercent: 12.5, notes: 'Year 1 rate' });
    expect(JSON.stringify((await as(adv.token).get(`/products/${own.id}`)).body)).not.toContain('12.5'); // never in the catalogue API
    const { login: lg, stepUp: su } = await import('./helpers.js');
    const m = newMobile();
    await as(adv.token).post('/assistants', { name: 'Priya Shah', mobile: m }, { 'X-Step-Up-Token': await su(adv.token, adv.mobile) });
    const ast = await lg(m);
    expect((await as(ast.token).get(`/products/${own.id}`)).status).toBe(200); // assistants can see the product…
    expect(err(await as(ast.token).get(`/products/${own.id}/commercials`))).toMatchObject({ status: 403 }); // …not the commission
    expect(err(await as(ast.token).put(`/products/${own.id}/commercials`, { commissionPercent: 50 }))).toMatchObject({ status: 403 });
  });

  it('AC-P22-3: a 9-year-old fits a family floater with child band 0 to 25 although adults are 18 to 65', () => {
    expect(fitsEntryAge(DATA as never, 9, 'CHILD')).toBe(true);
    expect(fitsEntryAge(DATA as never, 9, 'ADULT')).toBe(false);
    expect(fitsEntryAge({ ...DATA, coversChildren: false } as never, 9, 'CHILD')).toBe(false);
  });
});