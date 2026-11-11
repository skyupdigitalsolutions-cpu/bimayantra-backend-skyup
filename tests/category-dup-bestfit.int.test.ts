/**
 * Duplicate categories are refused by meaning ("Health insurance" = Health), old private duplicates are hidden or
 * merged, and Best fit lists every product it leaves out with the reason.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, newMobile, registerAdvisor, resetState, startTestEnv, stopTestEnv } from './helpers.js';
import { importCatalogue, readCatalogue } from '../src/modules/catalogue/catalogueImport.js';
import { demoAgentCodes } from '../src/modules/demo/demoAgentCodes.js';
import { InsuranceType, TemplateVersion } from '../src/modules/catalogue/types.model.js';
import { Product } from '../src/modules/catalogue/product.model.js';
import { mergeDuplicateCategories } from '../src/modules/catalogue/private.service.js';
import { categoryKey } from '../src/modules/catalogue/categoryNames.js';
import { Account } from '../src/modules/accounts/account.model.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

async function setup(categories = ['Health', 'Motor Private Car', 'Term Life']) {
  await importCatalogue(await readCatalogue('tests/fixtures/bimayantra-catalogue-demo.xlsx'), { apply: true, publish: true });
  const adv = await registerAdvisor('Asha Rao');
  const A = as(adv.token);
  let p = (await A.get('/profile')).body.data;
  await A.put('/profile/professional', { version: p.sections.professional.version, advisorType: 'POSP', categories, licenceNumber: 'POSP-1', licenceValidUntil: '31-12-2030' });
  p = (await A.get('/profile')).body.data;
  await A.put('/profile/personal', { version: p.sections.personal.version, dob: '15-04-1988' });
  const cus = (await A.post('/customers', { name: 'David', mobile: newMobile(), dob: '10-06-1990' })).body.data;
  const types = Object.fromEntries((await InsuranceType.find({ ownerAccountId: null }).lean<Array<{ _id: string; name: string }>>()).map((t) => [t.name, t._id])) as Record<string, string>;
  return { adv, A, cus, types };
}

describe('duplicate categories', () => {
  it('category names are compared by meaning', () => {
    expect(categoryKey('Health')).toBe(categoryKey(' HEALTH  insurance '));
    expect(categoryKey('Health')).toBe(categoryKey('Health-Cover'));
    expect(categoryKey('Home & Contents')).toBe(categoryKey('home and contents plan'));
    expect(categoryKey('Health')).not.toBe(categoryKey('Critical illness'));
    expect(categoryKey('Insurance')).toBe('insurance');
  });

  it('a private category that means a SkyUp category or one of the advisor’s own is refused', async () => {
    const w = await setup();
    for (const name of ['Health insurance', '  HEALTH  ', 'health-plan', 'Term Life Policy']) {
      const r = await w.A.post('/my-products/types', { name });
      expect(r.status).toBe(400);
      expect(r.body.error.fields[0]).toMatchObject({ field: 'name', messageId: 'CAT-52' });
    }
    expect((await w.A.post('/my-products/types', { name: 'Pet' })).status).toBe(201);
    const again = await w.A.post('/my-products/types', { name: 'Pet insurance' });
    expect(again.body.error.fields[0]).toMatchObject({ field: 'name', messageId: 'CAT-50' });
  });

  it('an old private "Health" is hidden while empty; with products it shows until merged; the merge moves them', async () => {
    const w = await setup();
    const accountId = w.adv.user.accountId!;
    const [dup] = await InsuranceType.create([{ name: 'Health', nameKey: 'health', ownerAccountId: accountId, status: 'ACTIVE', productForm: 'HEALTH' }]);
    await TemplateVersion.create([{ typeId: dup!._id, number: 1, status: 'ACTIVE', isOpen: null, features: [], factors: [], questions: [], makerId: w.adv.user.id, approvedAt: new Date() }]);
    const names = async () => ((await w.A.get('/my-products/types')).body.data as Array<{ name: string; private: boolean }>).filter((t) => t.name === 'Health');
    expect(await names()).toEqual([expect.objectContaining({ private: false })]); // empty duplicate hidden

    const some = await Product.findOne({ typeId: w.types.Health }).lean<{ insurerId: string }>();
    const [own] = await Product.create([{ kind: 'OWN', accountId, insurerId: some!.insurerId, typeId: dup!._id, code: 'MY-H1', name: 'My Health', makerId: w.adv.user.id }]);
    expect((await names()).length).toBe(2); // shown while it holds a product

    const dry = await mergeDuplicateCategories({ apply: false });
    expect(dry).toEqual([expect.objectContaining({ category: 'Health', into: 'Health', products: 1, result: 'would merge' })]);
    expect((await Product.findById(own!._id).lean())!.typeId).toBe(dup!._id);
    const done = await mergeDuplicateCategories({ apply: true });
    expect(done[0]!.result).toBe('merged');
    expect((await Product.findById(own!._id).lean())!.typeId).toBe(w.types.Health);
    expect((await InsuranceType.findById(dup!._id).lean())!.status).toBe('INACTIVE');
    expect(await names()).toEqual([expect.objectContaining({ private: false })]);
    expect(await mergeDuplicateCategories({ apply: true })).toEqual([]); // nothing left
  });
});

describe('Best fit explains every product it leaves out', () => {
  const rank = (w: Awaited<ReturnType<typeof setup>>, si = 500000) =>
    w.A.post(`/customers/${w.cus.id}/best-fit`, { typeId: w.types.Health, people: [`C:${w.cus.id}`], budget: 20000, priority: 'BEST_COVERAGE', sumInsured: si });

  it('no agent codes → each product says so', async () => {
    const w = await setup();
    const r = await rank(w);
    expect(r.status).toBe(200);
    expect(r.body.data.results).toEqual([]);
    expect(r.body.data.excluded.length).toBeGreaterThan(0);
    expect(r.body.data.excluded.every((x: { reason: string }) => x.reason.startsWith('No active agent code for'))).toBe(true);
    expect(r.body.data.profileBlock).toBeNull();
  });

  it('category not in the profile → said once per product; sum insured not on offer → said with what is offered', async () => {
    const w = await setup(['Motor Private Car']);
    let r = await rank(w);
    expect(r.body.data.profileBlock).toContain('Health is not one of the insurance categories in your profile');
    // each product still shows its own problem (here: no agent codes yet), not only the profile one
    expect(r.body.data.excluded.length).toBeGreaterThan(0);
    expect(r.body.data.excluded.every((x: { reason: string }) => x.reason.startsWith('No active agent code for'))).toBe(true);
    await demoAgentCodes(w.adv.mobile, { apply: true });
    r = await rank(w);
    expect(r.body.data.results).toEqual([]);
    expect(r.body.data.excluded.some((x: { reason: string }) => x.reason.includes('it will rank once Health is in your profile'))).toBe(true);
    const w2 = await setup();
    await demoAgentCodes(w2.adv.mobile, { apply: true });
    r = await rank(w2, 990000000);
    expect(r.body.data.results).toEqual([]);
    expect(r.body.data.excluded[0].reason).toMatch(/sum insured is not on offer \(offers: /);
    r = await rank(w2, 500000);
    expect(r.body.data.results.length).toBeGreaterThan(0);
  });

  it('a profile category written differently ("health insurance") still authorises Health', async () => {
    const w = await setup();
    // e.g. saved before SkyUp renamed the category, or changed in Admin → Configuration
    await Account.updateOne({ _id: w.adv.user.accountId }, { $set: { 'profile.professional.categories': ['health insurance', 'Term Life'] } });
    await demoAgentCodes(w.adv.mobile, { apply: true });
    const r = await rank(w, 500000);
    expect(r.body.data.profileBlock).toBeNull();
    expect(r.body.data.results.length).toBeGreaterThan(0);
  });
});

describe('+ My product, step 2: companies that sell the chosen category', () => {
  it('Health → general and health insurers; Travel → no life insurers; Term Life → only life insurers; own companies always', async () => {
    const w = await setup();
    const { Insurer } = await import('../src/modules/insurers/insurer.model.js');
    const cls = new Map((await Insurer.find({}, { name: 1, category: 1 }).lean<Array<{ name: string; category: string | null }>>()).map((i) => [i.name, i.category]));
    await w.A.post('/my-products/insurers', { name: 'Shree Ram Mutual Benefit' }); // a company the advisor added
    const types = Object.fromEntries((await InsuranceType.find({ ownerAccountId: null }).lean<Array<{ _id: string; name: string }>>()).map((t) => [t.name, t._id])) as Record<string, string>;
    const list = async (type: string) => ((await w.A.get(`/my-products/insurers?typeId=${types[type]}`)).body.data as Array<{ name: string; private: boolean }>);

    const health = await list('Health');
    expect(health.map((i) => i.name)).toEqual(expect.arrayContaining(['Care Health Insurance Ltd.', 'HDFC ERGO General Insurance Co. Ltd.', 'Shree Ram Mutual Benefit']));
    expect(health.filter((i) => !i.private).every((i) => cls.get(i.name) !== 'Life')).toBe(true);

    const travel = await list('Travel');
    expect(travel.filter((i) => !i.private).every((i) => cls.get(i.name) !== 'Life')).toBe(true);
    expect(travel.some((i) => i.name === 'Acko Life Insurance Ltd.')).toBe(false);

    const term = await list('Term Life');
    expect(term.filter((i) => !i.private).every((i) => cls.get(i.name) === 'Life')).toBe(true);
    expect(term.map((i) => i.name)).toEqual(expect.arrayContaining(['HDFC Life Insurance Co. Ltd.', 'Shree Ram Mutual Benefit']));
    expect(term.some((i) => i.name === 'Care Health Insurance Ltd.')).toBe(false);

    const motor = await list('Motor Private Car');
    expect(motor.filter((i) => !i.private).every((i) => cls.get(i.name) === 'General')).toBe(true);
    // without a category: everything, as before
    expect(((await w.A.get('/my-products/insurers')).body.data as unknown[]).length).toBeGreaterThan(term.length);
  });
});

describe('Repair: products whose category no longer exists', () => {
  it('finds them, says where each old category goes (by recorded kind or features), and moves them on --apply', async () => {
    const w = await setup();
    const { repairOrphanCategories } = await import('../src/modules/catalogue/private.service.js');
    const { ProductVersion } = await import('../src/modules/catalogue/product.model.js');
    expect(await repairOrphanCategories({ apply: false })).toEqual([]); // nothing to do
    // Simulate: Term Life and Health deleted and created again with new IDs (same templates)
    const recreate = async (name: string) => {
      const old = (await InsuranceType.findOne({ ownerAccountId: null, name }).lean<{ _id: string; productForm: string | null }>())!;
      const tpl = (await TemplateVersion.findOne({ typeId: old._id, status: 'ACTIVE' }).lean<Record<string, unknown>>())!;
      await InsuranceType.deleteOne({ _id: old._id });
      await TemplateVersion.updateOne({ _id: tpl._id }, { $set: { status: 'RETIRED', isOpen: null } });
      const [nt] = await InsuranceType.create([{ name, nameKey: name.toLowerCase(), ownerAccountId: null, status: 'ACTIVE', productForm: old.productForm }]);
      const { _id: _x, typeId: _t, ...rest } = tpl;
      await TemplateVersion.create([{ ...rest, typeId: nt!._id, status: 'ACTIVE', isOpen: null }]);
      return { oldId: old._id, newId: nt!._id as string };
    };
    const term = await recreate('Term Life');
    const health = await recreate('Health');
    // Health products lost their recorded kind: they must be matched by their features instead
    const hp = await Product.find({ typeId: health.oldId }, { _id: 1 }).lean<Array<{ _id: string }>>();
    await ProductVersion.updateMany({ productId: { $in: hp.map((p) => p._id) } }, { $set: { 'data.form': 'GENERIC' } });
    const termCount = await Product.countDocuments({ typeId: term.oldId });
    expect(termCount).toBeGreaterThan(0);
    // the products page shows no category for them
    const listed = (await w.A.get('/products')).body.data as Array<{ type: string | null; kind: string }>;
    expect(listed.filter((p) => p.kind === 'VERIFIED' && p.type === null).length).toBe(termCount + hp.length);

    const dry = await repairOrphanCategories({ apply: false });
    expect(dry).toEqual(expect.arrayContaining([
      expect.objectContaining({ oldCategoryId: term.oldId, into: 'Term Life', by: 'recorded kind TERM_LIFE', result: 'would move to Term Life' }),
      expect.objectContaining({ oldCategoryId: health.oldId, into: 'Health', result: 'would move to Health' }),
    ]));
    expect(dry.find((r) => r.oldCategoryId === health.oldId)!.by).toMatch(/^feature template/);
    expect(await Product.countDocuments({ typeId: term.oldId })).toBe(termCount); // dry run wrote nothing

    await repairOrphanCategories({ apply: true });
    expect(await Product.countDocuments({ typeId: term.newId })).toBe(termCount);
    expect(await Product.countDocuments({ typeId: health.newId })).toBe(hp.length);
    const after = (await w.A.get('/products')).body.data as Array<{ type: string | null; kind: string }>;
    expect(after.filter((p) => p.kind === 'VERIFIED' && p.type === null)).toEqual([]);
    expect(await repairOrphanCategories({ apply: false })).toEqual([]);
  });
});