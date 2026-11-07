/**
 * Module 8 Stage 3b — what an advisor needs to add an own product (P-22 step 2): the usable insurance types and
 * the live template's features, read-only. Also: own-product writes in read-only mode (GR-33) and the status
 * change's double-submit protection (GR-10).
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, as, err, login, newMobile, registerAdvisor, resetState, seedAdmin, startTestEnv, stepUp, stopTestEnv } from './helpers.js';
import { clock } from '../src/lib/clock.js';
import { Insurer } from '../src/modules/insurers/insurer.model.js';
import { InsuranceType, TemplateVersion } from '../src/modules/catalogue/types.model.js';
import { Product } from '../src/modules/catalogue/product.model.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

const FEATURES = [
  // Stored out of order on purpose: the endpoint returns them by `order`.
  { key: 'ped_wait', name: 'Pre-existing disease waiting period', group: 'Waiting periods', dataType: 'Months', requiredToPublish: true, order: 2 },
  { key: 'room_rent', name: 'Room rent limit', group: 'Limits and sub-limits', dataType: 'Amount in ₹', requiredToPublish: true, order: 1, help: 'Per day' },
  { key: 'ambulance', name: 'Ambulance cover', group: 'Benefits', dataType: 'Yes/No', requiredToPublish: false, order: 3 },
];
const FACTORS = [{ key: 'age', name: 'Age', kind: 'BAND', source: 'Age of the eldest insured person', bands: [{ from: 18, to: 65 }] }];
const QUESTIONS = [{ key: 'smoker', label: 'Does anyone smoke?', dataType: 'Yes/No', required: true }];

/** A live insurer; Health (live template v1); Motor (DRAFT template only); Travel (INACTIVE, live template). */
async function catalogue() {
  const ins = await Insurer.create({ name: 'Alpha Health', nameKey: 'alpha health', shortCode: 'ALPHA', category: 'Standalone Health', irdaiRegNo: 'R-1', paymentDomains: ['alpha.in'], status: 'ACTIVE' });
  const health = await InsuranceType.create({ name: 'Health', nameKey: 'health' });
  const motor = await InsuranceType.create({ name: 'Motor', nameKey: 'motor' });
  const travel = await InsuranceType.create({ name: 'Travel', nameKey: 'travel', status: 'INACTIVE' });
  const tpl = await TemplateVersion.create({ typeId: health._id, number: 1, status: 'ACTIVE', isOpen: null, makerId: 'usr_maker', features: FEATURES, factors: FACTORS, questions: QUESTIONS });
  await TemplateVersion.create({ typeId: motor._id, number: 1, status: 'DRAFT', makerId: 'usr_maker', features: FEATURES.slice(0, 1) });
  await TemplateVersion.create({ typeId: travel._id, number: 1, status: 'ACTIVE', isOpen: null, makerId: 'usr_maker', features: FEATURES, factors: FACTORS });
  return { insurerId: ins._id, healthId: health._id, motorId: motor._id, travelId: travel._id, tplId: tpl._id };
}
const DATA = {
  name: 'Family Shield', uin: 'ALPHLIP21001V012122', launchDate: '01-01-2026', adultMin: 18, adultMax: 65,
  sumInsured: { options: [500000, 1000000] }, policyTerms: [1, 2], pricingMode: 'MANUAL_ENTRY', taxPercent: 18,
};

async function advisorWithAssistant() {
  const adv = await registerAdvisor('Asha Rao');
  const m = newMobile();
  await as(adv.token).post('/assistants', { name: 'Priya Shah', mobile: m }, { 'X-Step-Up-Token': await stepUp(adv.token, adv.mobile) });
  return { adv, ast: await login(m) };
}

describe('P-22 step 2: types and live features for + My product (read-only)', () => {
  it('lists only ACTIVE types with a live template, by name, with the template number', async () => {
    const cat = await catalogue();
    const adv = await registerAdvisor();
    const r = await as(adv.token).get('/my-products/types');
    expect(r.status).toBe(200);
    // Motor has only a DRAFT template; Travel is INACTIVE: an own product could not be built on either.
    expect(r.body.data).toEqual([{ id: cat.healthId, name: 'Health', private: false, template: { id: cat.tplId, number: 1 } }]); // `private`: Stage F (change #4)
  });

  it('returns the live template\'s features in order, and nothing an advisor does not need', async () => {
    const cat = await catalogue();
    const adv = await registerAdvisor();
    const r = await as(adv.token).get(`/my-products/types/${cat.healthId}/template`);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      typeId: cat.healthId, typeName: 'Health', private: false, template: { id: cat.tplId, number: 1 },
      features: [
        { key: 'room_rent', name: 'Room rent limit', group: 'Limits and sub-limits', dataType: 'Amount in ₹', requiredToPublish: true, order: 1, help: 'Per day' },
        { key: 'ped_wait', name: 'Pre-existing disease waiting period', group: 'Waiting periods', dataType: 'Months', requiredToPublish: true, order: 2, help: null },
        { key: 'ambulance', name: 'Ambulance cover', group: 'Benefits', dataType: 'Yes/No', requiredToPublish: false, order: 3, help: null },
      ],
    });
    // Rating factors, quotation questions and the maker stay on the admin endpoints.
    const body = JSON.stringify(r.body);
    for (const hidden of ['factors', 'questions', 'smoker', 'makerId', 'usr_maker']) expect(body).not.toContain(hidden);
  });

  it('follows the LIVE version: an open draft is ignored until it is approved', async () => {
    const cat = await catalogue();
    const adv = await registerAdvisor();
    const draft = await TemplateVersion.create({ typeId: cat.healthId, number: 2, status: 'DRAFT', makerId: 'usr_maker', features: [{ key: 'new_one', name: 'New feature', group: 'Other', dataType: 'Text', requiredToPublish: true, order: 1 }] });
    const before = (await as(adv.token).get(`/my-products/types/${cat.healthId}/template`)).body.data;
    expect(before.template.number).toBe(1);
    expect(before.features.map((f: { key: string }) => f.key)).not.toContain('new_one');
    await TemplateVersion.updateOne({ _id: cat.tplId }, { $set: { status: 'RETIRED', isOpen: null } });
    await TemplateVersion.updateOne({ _id: draft._id }, { $set: { status: 'ACTIVE', isOpen: null } });
    const after = (await as(adv.token).get(`/my-products/types/${cat.healthId}/template`)).body.data;
    expect(after).toMatchObject({ template: { id: draft._id, number: 2 }, features: [{ key: 'new_one' }] });
    expect((await as(adv.token).get('/my-products/types')).body.data[0].template).toEqual({ id: draft._id, number: 2 });
  });

  it('an INACTIVE type or one without a live template is GEN-04; an unknown or malformed type id is 404', async () => {
    const cat = await catalogue();
    const adv = await registerAdvisor();
    expect(err(await as(adv.token).get(`/my-products/types/${cat.travelId}/template`))).toMatchObject({ status: 409, code: 'INVALID_STATE', messageId: 'GEN-04' });
    const noLive = await as(adv.token).get(`/my-products/types/${cat.motorId}/template`);
    expect(err(noLive)).toMatchObject({ status: 409, messageId: 'GEN-04' });
    expect(noLive.body.error.message).toBe('This action is not allowed because this insurance type is without a live template.');
    expect(err(await as(adv.token).get(`/my-products/types/typ_${'0'.repeat(28)}/template`))).toMatchObject({ status: 404, messageId: 'GEN-11' });
    expect(err(await as(adv.token).get('/my-products/types/health/template'))).toMatchObject({ status: 404, messageId: 'GEN-11' }); // validate.ts: a malformed ID can't be a record you can see
  });

  it('advisor only: assistants and SkyUp users are refused (products.own)', async () => {
    const cat = await catalogue();
    const { ast } = await advisorWithAssistant();
    const admin = await seedAdmin();
    for (const who of [ast.token, admin.token]) {
      expect(err(await as(who).get('/my-products/types'))).toMatchObject({ status: 403, messageId: 'GEN-03' });
      expect(err(await as(who).get(`/my-products/types/${cat.healthId}/template`))).toMatchObject({ status: 403, messageId: 'GEN-03' });
    }
  });
});

describe('P-22 step 2: building and editing an own product from those lookups', () => {
  it('the template\'s required features are enough to publish; the product carries its ids and template', async () => {
    const cat = await catalogue();
    const adv = await registerAdvisor();
    const [type] = (await as(adv.token).get('/my-products/types')).body.data;
    const tpl = (await as(adv.token).get(`/my-products/types/${type.id}/template`)).body.data;
    const features = Object.fromEntries(tpl.features.filter((f: { requiredToPublish: boolean }) => f.requiredToPublish).map((f: { key: string }) => [f.key, { value: 6 }]));
    const own = await as(adv.token).post('/my-products', { insurerId: cat.insurerId, typeId: type.id, code: 'MY-1', data: { ...DATA, features } });
    expect(own.status).toBe(201);
    expect(own.body.data).toMatchObject({ insurerId: cat.insurerId, typeId: type.id, publishedVersion: { templateId: tpl.template.id } });
    const listed = (await as(adv.token).get('/products')).body.data[0];
    expect(listed).toMatchObject({ id: own.body.data.id, insurerId: cat.insurerId, typeId: type.id });
  });

  it('the owner edits from `entered`: a "not stated" value stays not stated (AC-P22-5 display unchanged)', async () => {
    const cat = await catalogue();
    const adv = await registerAdvisor();
    const data = { ...DATA, features: { room_rent: { value: 5000, page: 3 }, ped_wait: { notStated: true } } };
    const own = (await as(adv.token).post('/my-products', { insurerId: cat.insurerId, typeId: cat.healthId, code: 'MY-1', data })).body.data;
    expect(own.publishedVersion.data.features.ped_wait).toEqual({ value: 'Not stated by insurer', page: null });
    expect(own.publishedVersion.entered.features.ped_wait).toEqual({ notStated: true });

    const edited = await as(adv.token).put(`/my-products/${own.id}`, { version: own.version, data: { ...own.publishedVersion.entered, name: 'Family Shield Plus' } });
    expect(edited.status).toBe(200);
    expect(edited.body.data.publishedVersion).toMatchObject({ number: 2, entered: { name: 'Family Shield Plus', features: { ped_wait: { notStated: true } } } });
    expect(edited.body.data.publishedVersion.data.features.ped_wait.value).toBe('Not stated by insurer');
  });

  it('verified products never carry `entered`', async () => {
    const cat = await catalogue();
    const adv = await registerAdvisor();
    const p = await Product.create({ kind: 'VERIFIED', insurerId: cat.insurerId, typeId: cat.healthId, code: 'VER-1', makerId: 'usr_maker', status: 'ACTIVE', name: 'Verified' });
    const { ProductVersion } = await import('../src/modules/catalogue/product.model.js');
    const v = await ProductVersion.create({ productId: p._id, number: 1, status: 'PUBLISHED', isOpen: null, templateId: cat.tplId, makerId: 'usr_maker', data: { ...DATA, features: { ped_wait: { notStated: true } } } });
    await Product.updateOne({ _id: p._id }, { $set: { publishedVersionId: v._id } });
    const got = (await as(adv.token).get(`/products/${p._id}`)).body.data;
    expect(got.publishedVersion.data.features.ped_wait.value).toBe('Not stated by insurer');
    expect(got.publishedVersion).not.toHaveProperty('entered');
  });
});

describe('GR-33 / GR-10 on own products', () => {
  it('read-only mode (EXPIRED): own-product and commission writes are refused with SUB-03; reading still works', async () => {
    const cat = await catalogue();
    const adv = await registerAdvisor();
    const own = (await as(adv.token).post('/my-products', { insurerId: cat.insurerId, typeId: cat.healthId, code: 'MY-1', data: { ...DATA, features: { room_rent: { value: 5000 }, ped_wait: { value: 24 } } } })).body.data;
    clock.setOffset(8 * 86_400_000); // past the trial: EXPIRED
    const s = await login(adv.mobile);
    expect((await as(s.token).get('/auth/me')).body.data.readOnly).toBe(true);
    const refused = [
      await as(s.token).post('/my-products', { insurerId: cat.insurerId, typeId: cat.healthId, code: 'MY-2', data: DATA }),
      await as(s.token).put(`/my-products/${own.id}`, { version: own.version, data: own.publishedVersion.entered }),
      await as(s.token).post(`/my-products/${own.id}/status`, { version: own.version, status: 'WITHDRAWN' }),
      await as(s.token).put(`/products/${own.id}/commercials`, { commissionPercent: 10 }),
    ];
    for (const r of refused) expect(err(r)).toMatchObject({ status: 403, code: 'READ_ONLY', messageId: 'SUB-03' });
    expect((await Product.findById(own.id).lean())?.version).toBe(own.version); // nothing changed
    for (const path of ['/my-products/types', `/my-products/types/${cat.healthId}/template`, '/products', `/products/${own.id}`, `/products/${own.id}/commercials`]) {
      expect((await as(s.token).get(path)).status).toBe(200);
    }
  });

  it('a repeated status change with the same Idempotency-Key is GEN-06 and applies once; no key is GEN-01', async () => {
    const cat = await catalogue();
    const adv = await registerAdvisor();
    const own = (await as(adv.token).post('/my-products', { insurerId: cat.insurerId, typeId: cat.healthId, code: 'MY-1', data: { ...DATA, features: { room_rent: { value: 5000 }, ped_wait: { value: 24 } } } })).body.data;
    const body = { version: own.version, status: 'WITHDRAWN' };
    const k = { 'Idempotency-Key': 'status-change-0001' };
    const first = await as(adv.token).post(`/my-products/${own.id}/status`, body, k);
    expect(first.status).toBe(200);
    const again = await as(adv.token).post(`/my-products/${own.id}/status`, body, k);
    expect(err(again)).toMatchObject({ status: 409, code: 'ALREADY_SUBMITTED', messageId: 'GEN-06' });
    expect(again.body.error.details.result.data).toMatchObject({ status: 'WITHDRAWN', version: own.version + 1 });
    expect((await Product.findById(own.id).lean())?.version).toBe(own.version + 1);

    const noKey = await request(app).post(`/v1/my-products/${own.id}/status`).set('Authorization', `Bearer ${adv.token}`).send({ version: own.version + 1, status: 'ACTIVE' });
    expect(err(noKey)).toMatchObject({ status: 400, messageId: 'GEN-01' });
  });
});

describe('found while building the Stage 3b screens', () => {
  it('a new verified draft returns data as {} (Mongoose drops an empty object on save)', async () => {
    const cat = await catalogue();
    const staff = await seedAdmin();
    const made = await as(staff.token).post('/admin/products', { insurerId: cat.insurerId, typeId: cat.healthId, code: 'NEW-1' });
    expect(made.body.data.version.data).toEqual({});
    const got = (await as(staff.token).get(`/admin/products/${made.body.data.productId}`)).body.data;
    expect(got.versions[0].data).toEqual({});
  });
}); 