/**
 * The advisor journey on the demo catalogue: why compare, quotation and best fit stop without agent codes (QT-12), and
 * that they work once the advisor has them (demo:agent-codes). Plus the best-fit sum insured list for range-only
 * products, and a private category may not copy a SkyUp category's name.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, err, newMobile, registerAdvisor, resetState, startTestEnv, stopTestEnv } from './helpers.js';
import { importCatalogue, readCatalogue } from '../src/modules/catalogue/catalogueImport.js';
import { demoAgentCodes } from '../src/modules/demo/demoAgentCodes.js';
import { InsuranceType } from '../src/modules/catalogue/types.model.js';
import { Product } from '../src/modules/catalogue/product.model.js';
import { InsurerMapping } from '../src/modules/insurers/mapping.model.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

async function setup() {
  await importCatalogue(await readCatalogue('tests/fixtures/bimayantra-catalogue-demo.xlsx'), { apply: true, publish: true });
  const adv = await registerAdvisor('Asha Rao');
  const A = as(adv.token);
  let p = (await A.get('/profile')).body.data;
  await A.put('/profile/professional', { version: p.sections.professional.version, advisorType: 'POSP', categories: ['Health', 'Motor Private Car', 'Term Life'], licenceNumber: 'POSP-1', licenceValidUntil: '31-12-2030' });
  p = (await A.get('/profile')).body.data;
  await A.put('/profile/personal', { version: p.sections.personal.version, dob: '15-04-1988' });
  const cus = (await A.post('/customers', { name: 'David', mobile: newMobile(), dob: '10-06-1990' })).body.data;
  const types = Object.fromEntries((await InsuranceType.find({ ownerAccountId: null }).lean<Array<{ _id: string; name: string }>>()).map((t) => [t.name, t._id])) as Record<string, string>;
  const health = await Product.find({ typeId: types.Health, status: 'ACTIVE' }).sort({ name: 1 }).limit(3).lean<Array<{ _id: string }>>();
  return { adv, A, cus, types, health };
}
async function previewErrors(w: Awaited<ReturnType<typeof setup>>) {
  const c = (await w.A.post('/comparisons', { customerId: w.cus.id })).body.data;
  const put = await w.A.put(`/comparisons/${c.id}`, { version: c.version, inputs: { typeId: w.types.Health, people: [`C:${w.cus.id}`], sumInsured: 500000, policyTerm: 1 },
    options: w.health.map((h) => ({ productId: h._id, manual: { netPremium: 12000 } })) });
  expect(put.status).toBe(200);
  const pv = await w.A.post(`/comparisons/${c.id}/preview`);
  return (pv.body.data.columns as Array<{ error?: { message: string } }>).map((x) => x.error?.message ?? null);
}

describe('demo advisor journey', () => {
  it('without agent codes: every product says "Add agent code", compare columns fail with QT-12, no insurer for a quotation', async () => {
    const w = await setup();
    const list = (await w.A.get('/products')).body.data as Array<{ agentCode: string; canQuote: boolean }>;
    expect(list.every((p) => p.agentCode === 'MISSING' && !p.canQuote)).toBe(true);
    const errors = await previewErrors(w);
    expect(errors.every((e) => e?.includes('with an active agent code'))).toBe(true);
  });

  it('demo:agent-codes adds a code for each insurer with live products; then products can be quoted and compared', async () => {
    const w = await setup();
    const dry = await demoAgentCodes(w.adv.mobile, { apply: false });
    expect(dry.added.length).toBeGreaterThan(5);
    expect(await InsurerMapping.countDocuments({})).toBe(0);
    const r = await demoAgentCodes(w.adv.mobile, { apply: true });
    expect(r.added.map((a) => a.agentCode).every((c) => /^D-[A-Z0-9]+-[A-Z0-9]{4}$/.test(c))).toBe(true);
    expect((await demoAgentCodes(w.adv.mobile, { apply: true })).added).toEqual([]); // safe to run again
    const list = (await w.A.get('/products')).body.data as Array<{ agentCode: string; canQuote: boolean }>;
    expect(list.every((p) => p.agentCode === 'ACTIVE' && p.canQuote)).toBe(true);
    expect((await previewErrors(w)).filter((e) => e?.includes('agent code'))).toEqual([]);
    expect((await w.A.get('/my-insurers')).body.data.length).toBe(r.added.length);
  });

  it('best fit lists sum insured amounts for range-only products too (Motor IDV, Term Life)', async () => {
    const w = await setup();
    const car = (await w.A.get(`/customers/${w.cus.id}/best-fit/options?typeId=${w.types['Motor Private Car']}`)).body.data;
    expect(car.sumInsuredOptions).toEqual(expect.arrayContaining([100000, 500000, 5000000]));
    expect(car.sumInsuredRange).toEqual({ min: 100000, max: 5000000 });
    const health = (await w.A.get(`/customers/${w.cus.id}/best-fit/options?typeId=${w.types.Health}`)).body.data;
    expect(health.sumInsuredOptions).toContain(500000);
    const travel = (await w.A.get(`/customers/${w.cus.id}/best-fit/options?typeId=${w.types.Travel}`)).body.data;
    expect(travel.sumInsuredOptions).toEqual([]); // no Travel products in the catalogue
    await demoAgentCodes(w.adv.mobile, { apply: true });
    const ranked = await w.A.post(`/customers/${w.cus.id}/best-fit`, { typeId: w.types.Health, people: [`C:${w.cus.id}`], budget: 20000, priority: 'BEST_COVERAGE', sumInsured: 500000 });
    expect(ranked.status).toBe(200);
  });

  it('an advisor cannot create a private category with a SkyUp category name (two "Health" tabs)', async () => {
    const w = await setup();
    const r = await w.A.post('/my-products/types', { name: 'health' });
    expect(err(r)).toMatchObject({ status: 400 });
    expect(r.body.error.fields[0]).toMatchObject({ field: 'name', messageId: 'CAT-52' });
    expect((await w.A.post('/my-products/types', { name: 'Pet cover' })).status).toBe(201);
  });
});