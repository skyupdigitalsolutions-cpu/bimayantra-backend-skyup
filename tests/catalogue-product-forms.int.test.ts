/**
 * Client requirement (Nov 2026):
 *  1. Features live under the insurance type (Health, Motor…); a new product on a type gets all of that type's features.
 *  2. The product details asked for change with the category (Health, Motor car/two-wheeler, Term Life, Travel…).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, err, newMobile, registerAdvisor, resetState, seedAdmin, startTestEnv, stepUp, stopTestEnv } from './helpers.js';
import { istToday } from '../src/lib/clock.js';
import { Insurer } from '../src/modules/insurers/insurer.model.js';
import { InsuranceType, TemplateVersion } from '../src/modules/catalogue/types.model.js';
import { ProductVersion } from '../src/modules/catalogue/product.model.js';
import { fitsEntryAge } from '../src/modules/catalogue/products.service.js';
import { seedCategoryTemplates } from '../src/modules/catalogue/defaultTemplates.js';
import { guessProductForm } from '../src/modules/catalogue/productForms.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

const fieldIds = (r: { body: { error?: { fields?: Array<{ field: string; messageId: string }> } } }) => Object.fromEntries((r.body.error?.fields ?? []).map((f) => [f.field, f.messageId]));
const day = (n: number) => { const d = new Date(`${istToday()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10).split('-').reverse().join('-'); };
const year = Number(istToday().slice(0, 4));

/** The starting types, each with its default feature template; a live SkyUp insurer. */
async function seeded() {
  const report = await seedCategoryTemplates({ apply: true });
  const ins = await Insurer.create({ name: 'Alpha General', nameKey: 'alpha general', shortCode: 'ALPHA', category: 'General', irdaiRegNo: 'R-1', paymentDomains: ['alpha.in'], status: 'ACTIVE' });
  const types = Object.fromEntries((await InsuranceType.find({ ownerAccountId: null }).lean<Array<{ _id: string; name: string }>>()).map((t) => [t.name, t._id]));
  return { report, insurerId: ins._id as string, types: types as Record<string, string> };
}

const BASE = { uin: 'ALPHMOT21001V012122', launchDate: '01-01-2026', pricingMode: 'MANUAL_ENTRY', taxPercent: 18 };
const MOTOR_DATA = {
  ...BASE, name: 'Car Secure', sumInsured: { min: 100000, max: 5000000 }, policyTerms: [1, 3],
  details: { coverTypes: ['Comprehensive', 'Third-party only'], fuelTypes: ['Petrol', 'Diesel', 'CNG'], maxVehicleAgeYears: 15, zeroDepreciation: true, maxNcbPercent: 50 },
};

describe('1. features belong to the insurance type and come with every new product', () => {
  it('the starting types get their default feature template once; a type that has one is never touched', async () => {
    const { report, types } = await seeded();
    expect(report.created.map((c) => c.type).sort()).toEqual(['Health', 'Home', 'Life Savings', 'Motor Private Car', 'Motor Two-wheeler', 'Personal Accident', 'Term Life', 'Travel']);
    const health = await TemplateVersion.findOne({ typeId: types.Health, status: 'ACTIVE' }).lean();
    expect(health!.features.map((f) => f.key)).toContain('ped_wait');
    expect(health!.features.every((f, i) => f.order === i + 1)).toBe(true);
    const again = await seedCategoryTemplates({ apply: true });
    expect(again.created).toEqual([]);
    expect(again.skipped.find((s) => s.type === 'Health')).toEqual({ type: 'Health', reason: 'already has a template' });
    expect(await TemplateVersion.countDocuments({ typeId: types.Health })).toBe(1);
  });

  it('dry run writes nothing', async () => {
    const r = await seedCategoryTemplates({ apply: false });
    expect(r.created.length).toBe(8);
    expect(await TemplateVersion.countDocuments({})).toBe(0);
  });

  it('SkyUp + Product: choosing the type returns its features and form; the new draft lists every feature', async () => {
    const { insurerId, types } = await seeded();
    const staff = await seedAdmin();
    const t = (await as(staff.token).get(`/admin/types/${types['Motor Private Car']}/template`)).body.data;
    expect(t.productForm).toBe('MOTOR_CAR');
    expect(t.features.map((f: { key: string }) => f.key)).toEqual(expect.arrayContaining(['own_damage', 'third_party', 'zero_dep']));
    const made = (await as(staff.token).post('/admin/products', { insurerId, typeId: types['Motor Private Car'], code: 'CAR-1' })).body.data;
    expect(made.template.features.length).toBe(t.features.length);
    expect(made.form.code).toBe('MOTOR_CAR');
    expect(Object.keys(made.version.data.features)).toEqual(t.features.map((f: { key: string }) => f.key));
    expect(made.version.data.form).toBe('MOTOR_CAR');
    const got = (await as(staff.token).get(`/admin/products/${made.productId}`)).body.data;
    expect(got.currentTemplate.features.length).toBe(t.features.length);
    expect(got.form.code).toBe('MOTOR_CAR');
  });

  it('advisors see the starting types in + My product once they have features', async () => {
    const adv = await registerAdvisor();
    expect((await as(adv.token).get('/my-products/types')).body.data).toEqual([]); // no templates yet: nothing to build on
    await seeded();
    const list = (await as(adv.token).get('/my-products/types')).body.data as Array<{ name: string; productForm: string }>;
    expect(list.find((x) => x.name === 'Motor Two-wheeler')!.productForm).toBe('MOTOR_TWO_WHEELER');
    expect(list.find((x) => x.name === 'Term Life')!.productForm).toBe('TERM_LIFE');
  });
});

describe('2. product details change with the category', () => {
  it('Health and Motor return different forms; Motor has no entry ages and calls sum insured "IDV range"', async () => {
    const { types } = await seeded();
    const adv = await registerAdvisor();
    const health = (await as(adv.token).get(`/my-products/types/${types.Health}/template`)).body.data.form;
    const motor = (await as(adv.token).get(`/my-products/types/${types['Motor Private Car']}/template`)).body.data.form;
    expect(health).toMatchObject({ code: 'HEALTH', entryAges: 'ADULT_CHILD', variantCoverTypes: true, labels: { sumInsured: 'Sum insured' } });
    expect(motor).toMatchObject({ code: 'MOTOR_CAR', entryAges: 'NONE', variantCoverTypes: false, labels: { sumInsured: 'IDV range' } });
    expect(health.fields.map((f: { key: string }) => f.key)).toContain('planType');
    expect(motor.fields.map((f: { key: string }) => f.key)).toEqual(expect.arrayContaining(['coverTypes', 'fuelTypes', 'maxVehicleAgeYears']));
    expect(motor.fields.map((f: { key: string }) => f.key)).not.toContain('planType');
    expect(motor.fields.find((f: { key: string }) => f.key === 'coverTypes')).toMatchObject({ type: 'CHOICES', required: true, options: expect.arrayContaining(['Comprehensive']) });
  });

  it('a motor product publishes without entry ages; its required details are listed in CAT-13 with motor words', async () => {
    const { insurerId, types } = await seeded();
    const adv = await registerAdvisor();
    const features = { own_damage: { value: true }, third_party: { value: true } };
    const thin = await as(adv.token).post('/my-products', { insurerId, typeId: types['Motor Private Car'], code: 'CAR-1', data: { ...BASE, name: 'Car Secure', features } });
    expect(err(thin)).toMatchObject({ status: 400, messageId: 'CAT-13' });
    expect(thin.body.error.message).toBe('This product cannot be saved yet: IDV options or range, policy period options, cover types offered, fuel types covered, oldest vehicle accepted.');
    const ok = await as(adv.token).post('/my-products', { insurerId, typeId: types['Motor Private Car'], code: 'CAR-1', data: { ...MOTOR_DATA, adultMin: 18, adultMax: 70, coversChildren: true, features } });
    expect(ok.status).toBe(201);
    expect(ok.body.data.form.code).toBe('MOTOR_CAR');
    const d = ok.body.data.publishedVersion.entered;
    expect(d.form).toBe('MOTOR_CAR');
    expect(d.adultMin).toBeUndefined(); // ages do not apply to a vehicle: cleared
    expect(d.coversChildren).toBe(false);
    expect(d.details).toEqual({ coverTypes: ['Comprehensive', 'Third-party only'], fuelTypes: ['Petrol', 'Diesel', 'CNG'], maxVehicleAgeYears: 15, zeroDepreciation: true, maxNcbPercent: 50 });
  });

  it('wrong category details are field errors: unknown key, an option not in the list, a health field on a motor product, a bad number', async () => {
    const { insurerId, types } = await seeded();
    const adv = await registerAdvisor();
    const post = (details: object) => as(adv.token).post('/my-products', { insurerId, typeId: types['Motor Private Car'], code: 'CAR-1', data: { ...MOTOR_DATA, details: { ...MOTOR_DATA.details, ...details } } });
    expect(fieldIds(await post({ planType: 'Individual' }))).toEqual({ 'details.planType': 'VAL-22' });
    expect(fieldIds(await post({ coverTypes: ['Comprehensive', 'Bogus'] }))).toEqual({ 'details.coverTypes': 'VAL-22' });
    expect(fieldIds(await post({ maxVehicleAgeYears: 75 }))).toEqual({ 'details.maxVehicleAgeYears': 'VAL-12' });
    expect(fieldIds(await post({ maxNcbPercent: 120 }))).toEqual({ 'details.maxNcbPercent': 'VAL-11' });
    expect(fieldIds(await post({ engineCcMin: 2000, engineCcMax: 1000 }))).toEqual({ 'details.engineCcMax': 'CAT-16' });
  });

  it('Term Life: adult band only (child band cleared), sum assured wording, its own required details', async () => {
    const { insurerId, types } = await seeded();
    const adv = await registerAdvisor();
    const data = { ...BASE, name: 'iTerm', adultMin: 18, adultMax: 65, coversChildren: true, childMin: 0, childMax: 17, policyTerms: [10, 20, 30], features: { death_benefit: { value: true } } };
    const thin = await as(adv.token).post('/my-products', { insurerId, typeId: types['Term Life'], code: 'TERM-1', data });
    expect(thin.body.error.message).toBe('This product cannot be saved yet: sum assured options or range, premium payment options, highest age at maturity, death benefit payout options.');
    const ok = await as(adv.token).post('/my-products', { insurerId, typeId: types['Term Life'], code: 'TERM-1', data: { ...data, sumInsured: { options: [5000000, 10000000] },
      details: { premiumPaymentOptions: ['Limited pay', 'Regular pay', 'Limited pay'], premiumPaymentTerms: [12, 5, 10, 5], maxMaturityAge: 85, payoutOptions: ['Lump sum'] } } });
    expect(ok.status).toBe(201);
    const d = ok.body.data.publishedVersion.entered;
    expect(d).toMatchObject({ form: 'TERM_LIFE', adultMin: 18, adultMax: 65, coversChildren: false, childMin: null, childMax: null });
    expect(d.details.premiumPaymentOptions).toEqual(['Regular pay', 'Limited pay']); // de-duplicated, in the form's order
    expect(d.details.premiumPaymentTerms).toEqual([5, 10, 12]);
  });

  it('Health keeps its behaviour: no required details, health details accepted and returned', async () => {
    const { insurerId, types } = await seeded();
    const adv = await registerAdvisor();
    const tpl = await TemplateVersion.findOne({ typeId: types.Health, status: 'ACTIVE' }).lean();
    const features = Object.fromEntries(tpl!.features.filter((f) => f.requiredToPublish).map((f) => [f.key, { notStated: true }]));
    const ok = await as(adv.token).post('/my-products', { insurerId, typeId: types.Health, code: 'H-1', data: { ...BASE, name: 'Family Shield', adultMin: 18, adultMax: 65, coversChildren: true, childMin: 0, childMax: 25,
      sumInsured: { options: [500000] }, policyTerms: [1], features, details: { planType: 'Family floater', coPaymentPercent: 10, lifelongRenewal: true } } });
    expect(ok.status).toBe(201);
    expect(ok.body.data.publishedVersion.entered).toMatchObject({ form: 'HEALTH', coversChildren: true, childMax: 25, details: { planType: 'Family floater', coPaymentPercent: 10, lifelongRenewal: true } });
  });

  it('SkyUp drafts: details checked on save; a draft saved before forms gets its form when published', async () => {
    const { insurerId, types } = await seeded();
    const staff = await seedAdmin();
    const made = (await as(staff.token).post('/admin/products', { insurerId, typeId: types['Motor Two-wheeler'], code: 'BIKE-1' })).body.data;
    const bad = await as(staff.token).put(`/admin/product-versions/${made.version.id}`, { rev: made.version.rev, data: { details: { fuelTypes: ['Diesel'] } } });
    expect(fieldIds(bad)).toEqual({ 'details.fuelTypes': 'VAL-22' }); // two-wheelers: petrol or electric
    const data = { ...MOTOR_DATA, name: 'Bike Secure', sourceLink: 'https://alpha.in/bike', sourceCheckedOn: '01-10-2026', features: { own_damage: { value: true }, third_party: { value: true } },
      details: { coverTypes: ['Comprehensive'], fuelTypes: ['Petrol', 'Electric'], maxVehicleAgeYears: 10 } };
    const saved = await as(staff.token).put(`/admin/product-versions/${made.version.id}`, { rev: made.version.rev, data });
    expect(saved.status).toBe(200);
    expect(saved.body.data.data.form).toBe('MOTOR_TWO_WHEELER');
    // an old draft without `form`: publishing stamps it
    await ProductVersion.updateOne({ _id: made.version.id }, { $unset: { 'data.form': 1 } });
    const sub = await as(staff.token).post(`/admin/product-versions/${made.version.id}/submit`, { rev: saved.body.data.rev }, { 'X-Step-Up-Token': await stepUp(staff.token, staff.mobile) });
    expect(sub.status).toBe(200);
    expect((await ProductVersion.findById(made.version.id).lean())!.data.form).toBe('MOTOR_TWO_WHEELER');
  });

  it('admins choose the form for a new type, or change it later; the name is the default', async () => {
    await seeded();
    const staff = await seedAdmin();
    expect((await as(staff.token).get('/admin/types/product-forms')).body.data.map((f: { code: string }) => f.code)).toContain('MOTOR_CAR');
    const bike = (await as(staff.token).post('/admin/types', { name: 'Bike Insurance' })).body.data.type;
    expect(bike.productForm).toBe('MOTOR_TWO_WHEELER');
    const pet = (await as(staff.token).post('/admin/types', { name: 'Pet', productForm: 'HEALTH' })).body.data.type;
    expect(pet.productForm).toBe('HEALTH');
    const changed = await as(staff.token).post(`/admin/types/${pet.id}/product-form`, { version: pet.version, productForm: 'GENERIC' });
    expect(changed.status).toBe(200);
    expect(changed.body.data).toMatchObject({ productForm: 'GENERIC', form: { code: 'GENERIC', fields: [] } });
    expect(err(await as(staff.token).post(`/admin/types/${pet.id}/product-form`, { version: pet.version, productForm: 'TRAVEL' }))).toMatchObject({ status: 409 }); // stale version
    expect(fieldIds(await as(staff.token).post(`/admin/types/${pet.id}/product-form`, { version: changed.body.data.version, productForm: 'BOATS' }))).toEqual({ productForm: 'VAL-22' });
    const list = (await as(staff.token).get('/admin/types')).body.data as Array<{ name: string; productForm: string; productFormSet: boolean }>;
    expect(list.find((t) => t.name === 'Pet')).toMatchObject({ productForm: 'GENERIC', productFormSet: true });
  });

  it('advisor private categories take a form too', async () => {
    const adv = await registerAdvisor();
    const c = await as(adv.token).post('/my-products/types', { name: 'My Car Plans', productForm: 'MOTOR_CAR' });
    expect(c.status).toBe(201);
    expect(c.body.data.productForm).toBe('MOTOR_CAR');
    expect((await as(adv.token).get(`/my-products/types/${c.body.data.id}/template`)).body.data.form.code).toBe('MOTOR_CAR');
    expect((await as(adv.token).post('/my-products/types', { name: 'Two wheeler cover' })).body.data.productForm).toBe('MOTOR_TWO_WHEELER');
  });

  it('name guessing and entry-age rules', () => {
    expect(['Health', 'Term Life', 'Life Savings', 'Motor Private Car', 'Motor Two-wheeler', 'Travel', 'Personal Accident', 'Home', 'Pet'].map(guessProductForm))
      .toEqual(['HEALTH', 'TERM_LIFE', 'LIFE_SAVINGS', 'MOTOR_CAR', 'MOTOR_TWO_WHEELER', 'TRAVEL', 'PERSONAL_ACCIDENT', 'HOME', 'GENERIC']);
    expect(fitsEntryAge({ form: 'MOTOR_CAR' }, 90, 'ADULT')).toBe(true);
    expect(fitsEntryAge({ form: 'MOTOR_CAR' }, 10, 'CHILD')).toBe(false);
    expect(fitsEntryAge({ form: 'TERM_LIFE', coversChildren: true, adultMin: 18, adultMax: 65 }, 10, 'CHILD')).toBe(false);
    expect(fitsEntryAge({ adultMin: 18, adultMax: 65 }, 70, 'ADULT')).toBe(false); // saved before forms: as before
  });

  it('a motor product can be quoted for a policyholder of any age (no entry-age check)', async () => {
    const { insurerId, types } = await seeded();
    const adv = await registerAdvisor();
    const A = as(adv.token);
    let p = (await A.get('/profile')).body.data;
    await A.put('/profile/professional', { version: p.sections.professional.version, advisorType: 'POSP', categories: ['Motor Private Car'], licenceNumber: 'POSP-1', licenceValidUntil: day(400) });
    p = (await A.get('/profile')).body.data;
    await A.put('/profile/personal', { version: p.sections.personal.version, dob: '15-04-1988' });
    await A.post('/my-insurers', { insurerId, agentCode: 'AG-77', declaration: true });
    const prod = (await A.post('/my-products', { insurerId, typeId: types['Motor Private Car'], code: 'CAR-1', data: { ...MOTOR_DATA, features: { own_damage: { value: true }, third_party: { value: true } } } })).body.data;
    const cus = (await A.post('/customers', { name: 'Raghu Rao', mobile: newMobile(), dob: `15-04-${year - 82}` })).body.data;
    const q0 = (await A.post('/quotations', { customerId: cus.id })).body.data;
    const r = await A.patch(`/quotations/${q0.id}`, { version: q0.version, step: 7, inputs: { typeId: types['Motor Private Car'], insurerId, productId: prod.id, people: [`C:${cus.id}`], sumInsured: 450000, policyTerm: 1, startDate: day(1), answers: { engine_cc: '1001 to 1500 cc', vehicle_age: '1 to 3 years' } } });
    expect(r.status).toBe(200); // an 82-year-old owner is fine: no QT-06
    expect(r.body.data.step).toBe(7);
  });
});