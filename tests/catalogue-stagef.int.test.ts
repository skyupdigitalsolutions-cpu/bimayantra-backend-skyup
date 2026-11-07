/** Stage F: catalogue changes #2 to #6 (variants, private insurer and category, own features, advisor brochure reading, Best fit per variant). */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, as, err, login, newMobile, registerAdvisor, resetState, seedAdmin, startTestEnv, stepUp, stopTestEnv } from './helpers.js';
import { Account } from '../src/modules/accounts/account.model.js';
import { OcrJob, readDetails, readVariantNames, rupeesIn, suggestFeatures } from '../src/modules/catalogue/ocr.service.js';
import { Product, ProductVersion } from '../src/modules/catalogue/product.model.js';
import { InsuranceType, TemplateVersion } from '../src/modules/catalogue/types.model.js';
import { ProductVariant } from '../src/modules/catalogue/variant.model.js';
import { Insurer } from '../src/modules/insurers/insurer.model.js';
import { User } from '../src/modules/users/user.model.js';
import { normalizeMobile } from '../src/lib/phone.js';

const BROCHURE = [
  { number: 1, confidence: 0.96, text: 'CareFirst Family Health Plan\nUIN: CAREHLIP26001V012526\nAvailable as Silver, Gold and Platinum plans\nSum insured: 5 lakh, 10 lakh, 25 lakh\nEntry age: 18 years to 65 years\nPolicy term: 1, 2 or 3 years' },
  { number: 2, confidence: 0.92, text: 'Room rent limit: Rs 5,000 per day\nAir ambulance cover: Covered\nDomiciliary treatment: Not covered' },
];
vi.mock('../src/modules/documents/reader.js', () => ({
  readerEnabled: () => true,
  readDocument: async () => null,
  ocrText: async () => '',
  ocrPages: async () => ({ text: BROCHURE.map((p) => p.text).join('\n'), pages: BROCHURE }),
}));

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

const FEATURES = [
  { key: 'room_rent', name: 'Room rent limit', group: 'Limits and sub-limits', dataType: 'Amount in ₹', requiredToPublish: true, order: 1 },
  { key: 'co_pay', name: 'Co-pay', group: 'Limits and sub-limits', dataType: 'Percentage', requiredToPublish: false, order: 2 },
];
const DATA = { name: 'Family Shield', uin: 'ALPHLIP21001V012122', launchDate: '01-01-2026', adultMin: 18, adultMax: 65, sumInsured: { min: 300000, max: 2500000 }, policyTerms: [1, 2], pricingMode: 'MANUAL_ENTRY', taxPercent: 18 };
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n2 0 obj << /Type /Page >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');

async function world() {
  const ins = await Insurer.create({ name: 'Alpha Health', nameKey: 'alpha health', shortCode: 'ALPHA', category: 'Standalone Health', irdaiRegNo: 'R-1', paymentDomains: ['alpha.in'], status: 'ACTIVE' });
  const health = await InsuranceType.create({ name: 'Health', nameKey: 'health' });
  await TemplateVersion.create({ typeId: health._id, number: 1, status: 'ACTIVE', isOpen: null, makerId: 'x', features: FEATURES, factors: [] });
  const adv = await registerAdvisor('Asha Rao');
  const other = await registerAdvisor('Ravi Kumar');
  return { insurerId: ins._id as string, typeId: health._id as string, adv, A: as(adv.token), other, O: as(other.token) };
}
const own = (w: Awaited<ReturnType<typeof world>>, body: object) => w.A.post('/my-products', { insurerId: w.insurerId, typeId: w.typeId, code: 'MY-1', data: { ...DATA, features: { room_rent: { value: 5000 } } }, ...body });

describe('#3 private insurer', () => {
  it('added by name, ACTIVE at once, visible only in that account; never in the SkyUp library', async () => {
    const w = await world();
    const r = await w.A.post('/my-products/insurers', { name: 'Star Mutual' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ name: 'Star Mutual', private: true, status: 'ACTIVE' });
    expect((await w.A.get('/my-products/insurers?q=star')).body.data).toEqual([expect.objectContaining({ name: 'Star Mutual', private: true })]);
    expect((await w.O.get('/my-products/insurers?q=star')).body.data).toEqual([]);
    expect((await w.A.get('/my-insurers/available')).body.data.map((i: { name: string }) => i.name)).toContain('Star Mutual');
    expect((await w.O.get('/my-insurers/available')).body.data.map((i: { name: string }) => i.name)).not.toContain('Star Mutual');
    // its agent code can be saved (quotations need one)
    expect((await w.A.post('/my-insurers', { insurerId: r.body.data.id, agentCode: 'SM-1', declaration: true })).status).toBe(201);
    expect((await w.O.post('/my-insurers', { insurerId: r.body.data.id, agentCode: 'SM-1', declaration: true })).body.error.fields[0]).toMatchObject({ field: 'insurerId', messageId: 'VAL-22' });
    // the same name twice in the account (CAT-50); a library name is allowed (the advisor did not find it there)
    expect((await w.A.post('/my-products/insurers', { name: 'star mutual' })).body.error.fields[0]).toMatchObject({ field: 'name', messageId: 'CAT-50' });
    expect((await w.A.post('/my-products/insurers', { name: 'Alpha Health' })).status).toBe(201);
    const adm = await seedAdmin();
    expect((await as(adm.token).get('/admin/insurers')).body.data.map((i: { name: string }) => i.name)).toEqual(['Alpha Health']);
    expect((await as(adm.token).post('/admin/products', { insurerId: r.body.data.id, typeId: w.typeId, code: 'X-1' })).body.error.fields[0]).toMatchObject({ field: 'insurerId', messageId: 'VAL-22' });
    // another advisor cannot build a product on it
    expect((await w.O.post('/my-products', { insurerId: r.body.data.id, typeId: w.typeId, code: 'O-1', data: DATA })).body.error.fields[0]).toMatchObject({ field: 'insurerId', messageId: 'VAL-22' });
  });
});

describe('#4 private category', () => {
  it('no SkyUp template: own features only, manual entry; private to the account; not in Best fit or SkyUp screens', async () => {
    const w = await world();
    const c = (await w.A.post('/my-products/types', { name: 'Pet insurance' })).body.data;
    expect(c).toMatchObject({ name: 'Pet insurance', private: true, template: { number: 1 } });
    expect((await w.A.get('/my-products/types')).body.data.find((t: { name: string }) => t.name === 'Pet insurance')).toMatchObject({ private: true });
    expect((await w.O.get('/my-products/types')).body.data.map((t: { name: string }) => t.name)).not.toContain('Pet insurance');
    expect(err(await w.O.get(`/my-products/types/${c.id}/template`))).toMatchObject({ status: 404 });
    expect((await w.A.get(`/my-products/types/${c.id}/template`)).body.data).toMatchObject({ private: true, features: [] });
    const body = { insurerId: w.insurerId, typeId: c.id, code: 'PET-1', data: { ...DATA, name: 'Paw Care', customFeatures: [{ name: 'Vet visits' }] }, variants: [{ name: 'Basic', features: { cf_vet_visits: { value: true } } }] };
    expect((await w.A.post('/my-products', { ...body, data: { ...body.data, pricingMode: 'RATE_TABLE' } })).body.error.fields[0]).toMatchObject({ field: 'pricingMode', messageId: 'CAT-48' });
    expect((await w.A.post('/my-products', body)).status).toBe(201);
    expect((await w.O.post('/my-products', { ...body, code: 'PET-2' })).body.error.fields[0]).toMatchObject({ field: 'typeId', messageId: 'VAL-22' });
    const adm = await seedAdmin();
    expect((await as(adm.token).get('/admin/types')).body.data.map((t: { name: string }) => t.name)).not.toContain('Pet insurance');
    expect((await w.A.post('/my-products/types', { name: 'PET INSURANCE' })).body.error.fields[0].messageId).toBe('CAT-50');
    const cus = (await w.A.post('/customers', { name: 'Meena Iyer', mobile: newMobile(), dob: '15-04-1980' })).body.data;
    expect((await w.A.post(`/customers/${cus.id}/best-fit`, { typeId: c.id, people: [`C:${cus.id}`], budget: 25000, priority: 'LOWEST_PREMIUM', sumInsured: 500000 })).body.error.fields[0]).toMatchObject({ field: 'typeId', messageId: 'VAL-22' });
  });
});

describe('#2 #5 variants and own features on an own product', () => {
  it('each variant has its own values over the product\'s; own features are ✓/✗ per variant', async () => {
    const w = await world();
    const r = await own(w, {
      data: { ...DATA, features: { room_rent: { value: 5000 }, co_pay: { notStated: true } }, customFeatures: [{ name: 'Air ambulance cover' }] },
      variants: [
        { name: 'Silver', coverType: 'INDIVIDUAL', sumInsuredMin: 300000, sumInsuredMax: 500000, features: { cf_air_ambulance_cover: { value: false } } },
        { name: 'Gold', coverType: 'FLOATER', sumInsuredMin: 500000, sumInsuredMax: 2500000, features: { room_rent: { value: 10000 }, co_pay: { value: 0 }, cf_air_ambulance_cover: { value: true } } },
      ],
    });
    expect(r.status).toBe(201);
    const p = r.body.data;
    expect(p.customFeatures).toEqual([{ key: 'cf_air_ambulance_cover', name: 'Air ambulance cover', origin: 'ADVISOR', group: 'Other', dataType: 'Yes/No' }]);
    expect(p.variants.map((v: { name: string; isDefault: boolean }) => [v.name, v.isDefault])).toEqual([['Silver', true], ['Gold', false]]);
    const [silver, gold] = p.variants;
    expect(silver.features).toMatchObject({ room_rent: { value: 5000 }, co_pay: { value: 'Not stated by insurer' }, cf_air_ambulance_cover: { value: false } }); // product values where the variant has none
    expect(gold.features).toMatchObject({ room_rent: { value: 10000 }, co_pay: { value: 0 }, cf_air_ambulance_cover: { value: true } });
    // the feature table shows own features as rows, one column per variant
    const ft = (await w.A.get(`/catalogue/feature-table?typeId=${w.typeId}`)).body.data;
    expect(ft.columns.map((c: { variantName: string }) => c.variantName)).toEqual(['Silver', 'Gold']);
    expect(ft.groups.find((g: { group: string }) => g.group === 'Own features').rows[0]).toMatchObject({ name: 'Air ambulance cover', values: [false, true], differs: true });
    // an edit without variants keeps them (copied into the new version); with variants, replaces them
    const e1 = (await w.A.put(`/my-products/${p.id}`, { version: p.version, data: { ...p.publishedVersion.entered, name: 'Family Shield Plus' } })).body.data;
    expect(e1.variants.map((v: { name: string }) => v.name)).toEqual(['Silver', 'Gold']);
    expect(e1.variants[0].id).not.toBe(silver.id); // the old version keeps its own (quotations point at them)
    expect(await ProductVariant.countDocuments({ _id: silver.id })).toBe(1);
    const e2 = (await w.A.put(`/my-products/${p.id}`, { version: e1.version, data: e1.publishedVersion.entered, variants: [{ name: 'Platinum' }] })).body.data;
    expect(e2.variants.map((v: { name: string }) => v.name)).toEqual(['Platinum']);
  });

  it('checks: names (CAT-46), sum insured inside the product\'s (CAT-47), known features (VAL-22), required values per variant (CAT-13), own feature names (CAT-51), at most 10 (CAT-49)', async () => {
    const w = await world();
    const fields = async (body: object) => (await own(w, body)).body.error;
    expect((await fields({ variants: [{ name: 'Gold' }, { name: 'gold' }] })).fields[0]).toMatchObject({ field: 'variants.1.name', messageId: 'CAT-46' });
    expect((await fields({ variants: [{ name: 'Gold', sumInsuredMin: 100000, sumInsuredMax: 500000 }] })).fields[0]).toMatchObject({ field: 'variants.0.sumInsuredMin', messageId: 'CAT-47', message: "A variant's sum insured must be within the product's range (300000 to 2500000)." });
    expect((await fields({ variants: [{ name: 'Gold', sumInsuredMin: 900000, sumInsuredMax: 500000 }] })).fields[0]).toMatchObject({ messageId: 'CAT-16' });
    expect((await fields({ variants: [{ name: 'Gold', features: { nonsense: { value: 1 } } }] })).fields[0]).toMatchObject({ field: 'variants.0.features.nonsense', messageId: 'VAL-22' });
    const missing = await fields({ data: { ...DATA, features: {} }, variants: [{ name: 'Silver', features: { room_rent: { value: 3000 } } }, { name: 'Gold' }] });
    expect(missing).toMatchObject({ messageId: 'CAT-13' });
    expect(missing.message).toContain('a value for Room rent limit in Gold');
    expect(missing.message).not.toContain('in Silver');
    expect((await fields({ data: { ...DATA, features: { room_rent: { value: 1 } }, customFeatures: [{ name: 'Vet' }, { name: 'VET' }] } })).fields[0]).toMatchObject({ field: 'customFeatures.1.name', messageId: 'CAT-51' });
    expect((await fields({ variants: Array.from({ length: 11 }, (_, i) => ({ name: `V${i}` })) })).fields[0]).toMatchObject({ field: 'variants', messageId: 'CAT-49' });
  });

  it('a product without variants gets one default "Standard" variant from its own values', async () => {
    const w = await world();
    const p = (await own(w, {})).body.data;
    expect(p.variants).toEqual([expect.objectContaining({ name: 'Standard', isDefault: true, sumInsuredMin: 300000, sumInsuredMax: 2500000, features: { room_rent: { value: 5000 } } })]);
  });
});

describe('#2 variants on a SkyUp-verified product', () => {
  it('a draft\'s variants are saved as a set (rev-checked), published with the version, and copied into the next draft', async () => {
    const w = await world();
    const adm = await seedAdmin();
    const A = as(adm.token);
    const c = (await A.post('/admin/products', { insurerId: w.insurerId, typeId: w.typeId, code: 'VER-1' })).body.data;
    const vid = c.version.id;
    let v = (await A.put(`/admin/product-versions/${vid}`, { rev: c.version.rev, data: { ...DATA, sourceLink: 'https://alpha.in/family', sourceCheckedOn: '01-10-2026', features: { room_rent: { value: 5000 } }, customFeatures: [{ name: 'Organ donor cover' }] } })).body.data;
    expect(v.data.customFeatures[0]).toMatchObject({ key: 'cf_organ_donor_cover', origin: 'SKYUP' });
    const sv = await A.put(`/admin/product-versions/${vid}/variants`, { rev: v.rev, variants: [{ name: 'Silver' }, { name: 'Gold', features: { room_rent: { value: 9000 }, cf_organ_donor_cover: { value: true } } }] });
    expect(sv.status).toBe(200);
    expect(err(await A.put(`/admin/product-versions/${vid}/variants`, { rev: v.rev, variants: [] }))).toMatchObject({ status: 409 }); // the same rev twice
    v = sv.body.data;
    const pub = await A.post(`/admin/product-versions/${vid}/submit`, { rev: v.rev }, { 'X-Step-Up-Token': await stepUp(adm.token, adm.mobile) });
    expect(pub.status).toBe(200);
    const seen = (await w.A.get(`/products/${c.productId}`)).body.data;
    expect(seen.variants.map((x: { name: string; features: { room_rent: { value: number } } }) => [x.name, x.features.room_rent.value])).toEqual([['Silver', 5000], ['Gold', 9000]]);
    const draft = (await A.post(`/admin/products/${c.productId}/versions`)).body.data;
    expect((await A.get(`/admin/product-versions/${draft.id}/variants`)).body.data.map((x: { name: string }) => x.name)).toEqual(['Silver', 'Gold']);
    const detail = (await A.get(`/admin/products/${c.productId}`)).body.data;
    expect(detail.versions.map((x: { number: number; variants: unknown[] }) => [x.number, x.variants.length])).toEqual([[2, 2], [1, 2]]);
  });
});

describe('#6 brochure reading for advisors', () => {
  it('the reader finds details, variant names and suggested features in a brochure', () => {
    expect(rupeesIn('Sum insured: 5 lakh, 10 lakh, 1 crore, ₹3,00,000')).toEqual([500000, 1000000, 10000000, 300000]);
    const d = readDetails(BROCHURE);
    expect(Object.fromEntries(d.map((r) => [r.key, r.value]))).toMatchObject({ uin: 'CAREHLIP26001V012526', name: 'CareFirst Family Health Plan', sumInsuredOptions: '500000, 1000000, 2500000', adultMin: '18', adultMax: '65', policyTerms: '1, 2, 3' });
    expect(d.find((r) => r.key === 'name')!.confidence).toBeLessThan(0.7); // a heading is only a guess
    expect(readVariantNames(BROCHURE).map((r) => r.label)).toEqual(['Silver', 'Gold', 'Platinum']);
    expect(suggestFeatures(BROCHURE, FEATURES as never).map((r) => [r.label, r.value])).toEqual([['Air Ambulance Cover', 'Yes'], ['Domiciliary Treatment', 'No']]);
  });

  it('Normal plan sees CAT-45; trial reads; nothing is saved until the advisor publishes with the result', async () => {
    const w = await world();
    const up = async (token: string) => (await request(app).post('/v1/files?purpose=BROCHURE').set('Authorization', `Bearer ${token}`).set('Content-Type', 'application/octet-stream').set('X-File-Name', 'b.pdf').send(PDF)).body.data.id as string;
    // a Normal plan is refused
    await Account.updateOne({ _id: w.other.user.accountId }, { $set: { 'subscription.status': 'ACTIVE', 'subscription.plan': 'NORMAL', 'subscription.endsAt': new Date(Date.now() + 30 * 86_400_000) } });
    const refused = await w.O.post('/my-products/brochure-reading', { typeId: w.typeId, fileId: await up(w.other.token) });
    expect(err(refused)).toMatchObject({ status: 403, messageId: 'CAT-45' });
    // the trial reads
    const start = await w.A.post('/my-products/brochure-reading', { typeId: w.typeId, fileId: await up(w.adv.token) });
    expect(start.status).toBe(202);
    let job = start.body.data;
    for (let i = 0; i < 50 && job.status !== 'REVIEW_REQUIRED'; i++) { await new Promise((r) => setTimeout(r, 20)); job = (await w.A.get(`/my-products/brochure-reading/${job.id}`)).body.data; }
    expect(job.status).toBe('REVIEW_REQUIRED');
    expect(job.rows.find((r: { key: string }) => r.key === 'room_rent')).toMatchObject({ found: true, value: '5000', page: 2 });
    expect(job.suggestions.every((s: { ticked: boolean }) => !s.ticked)).toBe(true); // each starts unticked
    expect(err(await w.O.get(`/my-products/brochure-reading/${job.id}`))).toMatchObject({ status: 404 });
    const S = await (async () => { const m = newMobile(); await User.create({ accountId: null, role: 'STF', name: 'Meena Staff', mobile: normalizeMobile(m), status: 'ACTIVE', activatedAt: new Date() }); return as((await login(m)).token); })();
    expect(err(await S.post(`/admin/ocr-jobs/${job.id}/accept-high`))).toMatchObject({ status: 404 }); // SkyUp cannot touch an advisor's reading
    // a template feature with low confidence must be decided first (OCR-05)
    await w.A.post(`/my-products/brochure-reading/${job.id}/accept-high`);
    const coPay = job.rows.find((r: { key: string }) => r.key === 'co_pay');
    if (coPay.flagged) expect((await w.A.post(`/my-products/brochure-reading/${job.id}/result`)).body.error.messageId).toBe('OCR-05');
    await w.A.put(`/my-products/brochure-reading/${job.id}/decisions`, { decisions: [
      { key: 'co_pay', decision: 'NOT_STATED' },
      { section: 'DETAIL', key: 'name', decision: 'EDIT', value: 'CareFirst Family' },
      { section: 'DETAIL', key: 'policyTerms', decision: 'ACCEPT' }, // below the CFG-37 threshold: "accept high" left it for the advisor
      { section: 'VARIANT', key: 'platinum', decision: 'IGNORE' },
      { section: 'SUGGESTION', key: 'cf_air_ambulance_cover', decision: 'ACCEPT' },
    ] });
    expect(await Product.countDocuments()).toBe(0); // nothing saved yet
    const result = (await w.A.post(`/my-products/brochure-reading/${job.id}/result`)).body.data;
    expect(result.data).toMatchObject({ name: 'CareFirst Family', uin: 'CAREHLIP26001V012526', adultMin: 18, adultMax: 65, policyTerms: [1, 2, 3], sumInsured: { options: [500000, 1000000, 2500000] },
      features: { room_rent: { value: 5000, page: 2 }, co_pay: { notStated: true }, cf_air_ambulance_cover: { value: true } }, customFeatures: [{ key: 'cf_air_ambulance_cover', name: 'Air Ambulance Cover', origin: 'AI_SUGGESTED', dataType: 'Yes/No' }] });
    expect(result.variants).toEqual([{ name: 'Silver' }, { name: 'Gold' }]);
    // the advisor completes the form and publishes with the job: the version records what was read and checked
    const made = await w.A.post('/my-products', { insurerId: w.insurerId, typeId: w.typeId, code: 'CF-1', ocrJobId: job.id, data: { ...result.data, launchDate: '01-01-2026', pricingMode: 'MANUAL_ENTRY', taxPercent: 18 }, variants: result.variants });
    expect(made.status).toBe(201);
    const v = (await ProductVersion.findById(made.body.data.publishedVersion.id).lean<{ ocrMarks: Record<string, unknown> }>())!;
    expect(Object.keys(v.ocrMarks).sort()).toEqual(['cf_air_ambulance_cover', 'co_pay', 'room_rent']);
    expect((await OcrJob.findById(job.id).lean())!.status).toBe('REVIEWED');
    expect((await w.A.post('/my-products', { insurerId: w.insurerId, typeId: w.typeId, code: 'CF-2', ocrJobId: job.id, data: { ...DATA, features: { room_rent: { value: 1 } } } })).status).toBe(201); // a reviewed job can be reused
    expect((await w.O.post('/my-products', { insurerId: w.insurerId, typeId: w.typeId, code: 'CF-3', ocrJobId: job.id, data: { ...DATA, features: { room_rent: { value: 1 } } } })).body.error.fields[0]).toMatchObject({ field: 'ocrJobId', messageId: 'VAL-22' });
  });
});

describe('Best fit per variant', () => {
  it('each variant is ranked on its own values; a variant whose range misses the sum insured is left out', async () => {
    const w = await world();
    const p = (await w.A.get('/profile')).body.data;
    await w.A.put('/profile/professional', { version: p.sections.professional.version, categories: ['Health'] });
    await w.A.post('/my-insurers', { insurerId: w.insurerId, agentCode: 'AG-1', declaration: true });
    await own(w, { data: { ...DATA, features: { room_rent: { value: 5000 }, co_pay: { value: 20 } } }, variants: [
      { name: 'Silver' }, { name: 'Gold', features: { co_pay: { value: 0 } } }, { name: 'Platinum', sumInsuredMin: 1000000, sumInsuredMax: 2500000, features: { co_pay: { value: 0 } } },
    ] });
    const cus = (await w.A.post('/customers', { name: 'Meena Iyer', mobile: newMobile(), dob: '15-04-1980' })).body.data;
    const r = await w.A.post(`/customers/${cus.id}/best-fit`, { typeId: w.typeId, people: [`C:${cus.id}`], budget: 25000, priority: 'LOWEST_PREMIUM', sumInsured: 500000 });
    const res = r.body.data.results as Array<{ name: string; variantName: string; parts: { coPay: { score: number } }; variantId: string }>;
    expect(res.map((x) => x.name)).toEqual(['Family Shield · Gold', 'Family Shield · Silver']);
    expect(res[0]!.parts.coPay.score).toBeGreaterThan(res[1]!.parts.coPay.score);
    const chosen = await w.A.post(`/customers/${cus.id}/best-fit/${r.body.data.rankingId}/choose`, { productId: (await Product.findOne().lean())!._id, variantId: res[0]!.variantId });
    expect(chosen.body.data).toMatchObject({ chosenVariantId: res[0]!.variantId });
  });
});