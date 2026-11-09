/** The catalogue workbook importer (npm run catalogue:import), run on the demo workbook in tests/fixtures. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, registerAdvisor, resetState, setCfg, startTestEnv, stopTestEnv } from './helpers.js';
import { appCode, importCatalogue, readCatalogue, sourceLink } from '../src/modules/catalogue/catalogueImport.js';
import { Insurer } from '../src/modules/insurers/insurer.model.js';
import { Product, ProductVersion } from '../src/modules/catalogue/product.model.js';
import { TemplateVersion } from '../src/modules/catalogue/types.model.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

const FILE = 'tests/fixtures/bimayantra-catalogue-demo.xlsx';
const sheets = () => readCatalogue(FILE);

describe('catalogue import', () => {
  it('helpers: long codes drop the insurer prefix; source links become https links', () => {
    expect(appCode('HDFCERGO-OPTIMASECURE', 'HDFCERGO')).toBe('OPTIMASECURE');
    expect(appCode('CARE-SUPREME', 'CARE')).toBe('CARE-SUPREME');
    expect(sourceLink('nivabupa.com (Downloads)')).toBe('https://nivabupa.com');
    expect(sourceLink('https://www.careinsurance.com/other-downloads.html')).toBe('https://www.careinsurance.com/other-downloads.html');
    expect(sourceLink('adityabirlahealthinsurance.com/assets/pdf/active-one/prospectus.pdf')).toBe('https://adityabirlahealthinsurance.com/assets/pdf/active-one/prospectus.pdf');
  });

  it('dry run: reports, writes nothing', async () => {
    const r = await importCatalogue(await sheets(), { apply: false, publish: true });
    expect(r.totals).toMatchObject({ insurersCreated: 57, productsWouldCreate: 39 });
    expect(await Insurer.countDocuments({})).toBe(0);
    expect(await Product.countDocuments({})).toBe(0);
  });

  it('apply + publish: 57 insurers, 5 templates, 38 published; the one over the add-on limit stays a draft and says why', async () => {
    const r = await importCatalogue(await sheets(), { apply: true, publish: true });
    expect(r.totals).toMatchObject({ insurersCreated: 57, insurerProblems: 0, templatesCreated: 5, productsPublished: 38, productsDraft: 1 });
    const bajaj = r.products.find((p) => p.code === 'BAJAJGEN-CAR-PACKAGE')!;
    expect(bajaj.result).toBe('created as draft');
    expect(bajaj.missing!.join()).toContain('up to 30 add-ons');

    const sbi = await Insurer.findOne({ shortCode: 'SBILIFE' }).lean();
    expect(sbi).toMatchObject({ status: 'ACTIVE', irdaiRegNo: expect.stringMatching(/^DEMO-\d+$/), paymentDomains: ['sbilife.example'] });
    expect((await Insurer.findOne({ shortCode: 'TATAAIA' }).lean())!.irdaiRegNo).toBe('110'); // real numbers kept

    const health = await TemplateVersion.findOne({ status: 'ACTIVE', 'features.name': 'In-patient hospitalisation' }).lean();
    expect(health!.features.length).toBe(28);
    expect(health!.factors.map((f) => f.name)).toContain('City zone');
    expect(health!.questions.map((q) => q.label)).toEqual(['City zone']); // asked in the quotation

    const care = await Product.findOne({ code: 'CARE-SUPREME' }).lean();
    expect(care).toMatchObject({ kind: 'VERIFIED', status: 'ACTIVE', name: 'Care Supreme' });
    const v = (await ProductVersion.findById(care!.publishedVersionId).lean<{ data: Record<string, any> }>())!.data;
    expect(v).toMatchObject({ form: 'HEALTH', adultMin: 18, adultMax: 99, uin: 'CHIHLIP27061V032627', policyTerms: [1, 2, 3], taxPercent: 0 });
    expect(Object.keys(v.features).length).toBeGreaterThan(15);
    expect(v.addOns.length).toBeGreaterThan(0);

    expect(await Product.exists({ code: 'OPTIMASECURE' })).toBeTruthy(); // shortened code
    expect(r.products.find((p) => p.code === 'ICICILOM-ELEVATE')!.warnings.join()).toContain('capped at 99');

    const car = await Product.findOne({ code: 'DIGIT-CAR-PACKAGE' }).lean();
    const cd = (await ProductVersion.findById(car!.publishedVersionId).lean<{ data: Record<string, any> }>())!.data;
    expect(cd).toMatchObject({ form: 'MOTOR_CAR', taxPercent: 18, sumInsured: { min: 100000, max: 5000000 }, details: { coverTypes: ['Comprehensive'], maxVehicleAgeYears: 15 } });
    expect(cd.adultMin).toBeUndefined();

    const term = await Product.findOne({ code: 'ICICIPRU-IPSP-LIFE' }).lean();
    const td = (await ProductVersion.findById(term!.publishedVersionId).lean<{ data: Record<string, any> }>())!.data;
    expect(td.details).toMatchObject({ premiumPaymentOptions: expect.arrayContaining(['Regular pay']), maxMaturityAge: 85 });

    // advisors see the published products
    const adv = await registerAdvisor();
    const list = (await as(adv.token).get('/products')).body.data as Array<{ code: string; status: string }>;
    expect(list.length).toBe(38);
  });

  it('safe to run again; raising CFG-40 then publishes the waiting draft', async () => {
    await importCatalogue(await sheets(), { apply: true, publish: true });
    const again = await importCatalogue(await sheets(), { apply: true, publish: false });
    expect(again.totals).toMatchObject({ insurersCreated: 0, insurersSkipped: 57, templatesCreated: 0, productsSkipped: 39 }); // without --publish an existing draft is left as it is
    expect(await Product.countDocuments({})).toBe(39);
    await setCfg('CFG-40', 40);
    const pub = await importCatalogue(await sheets(), { apply: true, publish: true });
    expect(pub.products.find((p) => p.code === 'BAJAJGEN-CAR-PACKAGE')!.result).toBe('published (was draft)');
    expect(await Product.countDocuments({ status: 'ACTIVE' })).toBe(39);
  });
});