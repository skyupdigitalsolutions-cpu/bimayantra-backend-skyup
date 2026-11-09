/**
 * Client requirement (Nov 2026): brochure reading (P-23 / change #6) reads the features of the chosen category, and a
 * brochure of another kind of insurance (a Motor brochure for a Health product) is refused with OCR-09.
 * The OCR reader is a stand-in (Document AI is not reachable from tests); detection and matching run for real.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, as, err, login, newMobile, registerAdvisor, resetState, startTestEnv, stopTestEnv } from './helpers.js';
import { Insurer } from '../src/modules/insurers/insurer.model.js';
import { InsuranceType } from '../src/modules/catalogue/types.model.js';
import { ProductVersion } from '../src/modules/catalogue/product.model.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { User } from '../src/modules/users/user.model.js';
import { normalizeMobile } from '../src/lib/phone.js';
import { seedCategoryTemplates } from '../src/modules/catalogue/defaultTemplates.js';
import { categoryMismatch, detectCategory } from '../src/modules/catalogue/brochureCategory.js';
import { detailValue, readFormDetails } from '../src/modules/catalogue/ocr.service.js';
import { productForm } from '../src/modules/catalogue/productForms.js';

type Page = { number: number; confidence: number; text: string };
const HEALTH_BROCHURE: Page[] = [
  { number: 1, confidence: 0.96, text: 'CareFirst Family Health Plan\nUIN: CAREHLIP26001V012526\nFamily floater and individual cover\nSum insured: 5 lakh, 10 lakh\nEntry age: 18 years to 65 years\nPolicy term: 1 or 2 years' },
  { number: 2, confidence: 0.95, text: 'In-patient hospitalisation covered\nRoom rent limit: Single private room\nPre-existing disease waiting period: 3 years\nDay care procedures: Covered\nAYUSH treatment: Covered\nCashless hospitals: 10,000 network hospitals\nAmbulance cover: Rs 2,000\nAccidental hospitalisation from day one' },
];
const CAR_BROCHURE: Page[] = [
  { number: 1, confidence: 0.95, text: 'DriveSafe Private Car Package Policy\nUIN: DRIVMOT26001V012526\nComprehensive cover and Third-party only cover for your car\nInsured Declared Value (IDV) as per the Motor Vehicles Act\nPolicy period: 1 or 3 years\nPetrol, Diesel and CNG cars covered' },
  { number: 2, confidence: 0.94, text: 'Own damage cover: Covered\nThird-party liability: Covered\nZero depreciation: Available\nEngine protection: Available\nRoadside assistance: Available\nNo claim bonus up to 50%\n6,000 cashless garages\nRegistration certificate needed at claim' },
];
const BIKE_BROCHURE: Page[] = [
  { number: 1, confidence: 0.95, text: 'RideOn Two-wheeler Package Policy\nComprehensive cover for your bike or scooter\nOwn damage cover: Covered\nThird-party liability: Covered\nInsured Declared Value (IDV)\nZero depreciation: Available\nRoadside assistance: Available\nMotorcycles and scooters, Petrol and Electric' },
];
const SAVINGS_BROCHURE: Page[] = [
  { number: 1, confidence: 0.95, text: 'Assured Wealth Endowment Plan\nLife insurance with maturity benefit\nSum assured from 5 lakh\nPremium payment term: 5, 10 or 12 years\nGuaranteed additions every year\nSurrender value after 2 years\nDeath benefit to the nominee' },
];
let brochure: Page[] = HEALTH_BROCHURE;
vi.mock('../src/modules/documents/reader.js', () => ({
  readerEnabled: () => true,
  readDocument: async () => null,
  ocrText: async () => '',
  ocrPages: async () => ({ text: brochure.map((p) => p.text).join('\n'), pages: brochure }),
}));

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(async () => { brochure = HEALTH_BROCHURE; await resetState(); });

const text = (pages: Page[]) => pages.map((p) => p.text).join('\n');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n2 0 obj << /Type /Page >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
const upload = async (token: string) => (await request(app).post('/v1/files?purpose=BROCHURE').set('Authorization', `Bearer ${token}`).set('Content-Type', 'application/octet-stream').set('X-File-Name', 'b.pdf').send(PDF)).body.data.id as string;
/** Poll a reading until it leaves QUEUED / PROCESSING. */
async function settled(get: () => Promise<{ body: { data: { status: string } } }>) {
  let job = (await get()).body.data;
  for (let i = 0; i < 100 && ['QUEUED', 'PROCESSING'].includes(job.status); i++) { await new Promise((r) => setTimeout(r, 20)); job = (await get()).body.data; }
  return job as Record<string, any>;
}

async function world() {
  await seedCategoryTemplates({ apply: true });
  const ins = await Insurer.create({ name: 'Alpha General', nameKey: 'alpha general', shortCode: 'ALPHA', category: 'General', irdaiRegNo: 'R-1', paymentDomains: ['alpha.in'], status: 'ACTIVE' });
  const types = Object.fromEntries((await InsuranceType.find({ ownerAccountId: null }).lean<Array<{ _id: string; name: string }>>()).map((t) => [t.name, t._id])) as Record<string, string>;
  const adv = await registerAdvisor('Asha Rao'); // on the trial: brochure reading allowed
  return { insurerId: ins._id as string, types, adv, A: as(adv.token) };
}

describe('what kind of insurance a brochure describes', () => {
  it('each sample brochure is recognised', () => {
    expect(detectCategory(text(HEALTH_BROCHURE))).toMatchObject({ family: 'HEALTH', form: 'HEALTH', clear: true });
    expect(detectCategory(text(CAR_BROCHURE))).toMatchObject({ family: 'MOTOR', form: 'MOTOR_CAR', label: 'Motor (private car)', clear: true });
    expect(detectCategory(text(BIKE_BROCHURE))).toMatchObject({ family: 'MOTOR', form: 'MOTOR_TWO_WHEELER', label: 'Motor (two-wheeler)' });
    expect(detectCategory(text(SAVINGS_BROCHURE))).toMatchObject({ family: 'LIFE', form: 'LIFE_SAVINGS' });
  });

  it('a mismatch only when the evidence is clear; the right category, an unknown one, or a thin text passes', () => {
    expect(categoryMismatch('HEALTH', text(CAR_BROCHURE))).toMatchObject({ form: 'MOTOR_CAR', label: 'Motor (private car)' });
    expect(categoryMismatch('MOTOR_CAR', text(HEALTH_BROCHURE))).toMatchObject({ form: 'HEALTH', label: 'Health' });
    expect(categoryMismatch('MOTOR_CAR', text(BIKE_BROCHURE))).toMatchObject({ form: 'MOTOR_TWO_WHEELER' });
    expect(categoryMismatch('MOTOR_TWO_WHEELER', text(CAR_BROCHURE))).toMatchObject({ form: 'MOTOR_CAR' });
    expect(categoryMismatch('HEALTH', text(HEALTH_BROCHURE))).toBeNull(); // mentions accidents and ambulances: still Health
    expect(categoryMismatch('MOTOR_CAR', text(CAR_BROCHURE))).toBeNull();
    expect(categoryMismatch('TERM_LIFE', text(SAVINGS_BROCHURE))).toBeNull(); // Term and Savings are one family
    expect(categoryMismatch('GENERIC', text(CAR_BROCHURE))).toBeNull(); // nothing to compare with
    expect(categoryMismatch('HEALTH', 'Own damage cover: Covered')).toBeNull(); // too little to be sure
    expect(categoryMismatch('HEALTH', '')).toBeNull();
  });

  it('category details are read from the brochure and typed for their field', () => {
    const rows = Object.fromEntries(readFormDetails(productForm('MOTOR_CAR'), CAR_BROCHURE).map((r) => [r.key, r.value]));
    expect(rows['details.coverTypes']).toBe('Comprehensive, Third-party only');
    expect(rows['details.fuelTypes']).toBe('Petrol, Diesel, CNG');
    const f = (k: string) => productForm('MOTOR_CAR').fields.find((x) => x.key === k)!;
    expect(detailValue(f('coverTypes'), 'Third-party only, comprehensive')).toEqual(['Comprehensive', 'Third-party only']);
    expect(detailValue(f('coverTypes'), 'Comprehensive, Flood')).toBeUndefined();
    expect(detailValue(f('maxVehicleAgeYears'), '15 years'.replace(/\D/g, ''))).toBe(15);
    expect(detailValue(f('zeroDepreciation'), 'Available')).toBe(true);
    expect(detailValue(f('maxNcbPercent'), '50%')).toBe(50);
  });
});

describe('advisor: + My product brochure reading', () => {
  it('Health chosen, Motor brochure uploaded: WRONG_CATEGORY with OCR-09, a bell item, nothing to review', async () => {
    const w = await world();
    brochure = CAR_BROCHURE;
    const start = await w.A.post('/my-products/brochure-reading', { typeId: w.types.Health, fileId: await upload(w.adv.token) });
    expect(start.status).toBe(202);
    const job = await settled(() => w.A.get(`/my-products/brochure-reading/${start.body.data.id}`));
    expect(job.status).toBe('WRONG_CATEGORY');
    expect(job.messageId).toBe('OCR-09');
    expect(job.message).toBe('This brochure looks like a Motor (private car) insurance brochure, but the category chosen is Health. Choose the right category, or upload a Health brochure.');
    expect(job.category).toEqual({ form: 'HEALTH', name: 'Health' });
    expect(job.detectedCategory).toEqual({ form: 'MOTOR_CAR', label: 'Motor (private car)' });
    expect(job.rows).toEqual([]);
    expect((await Notification.findOne({ messageId: 'OCR-09' }).lean())!.message).toBe(job.message);
    expect(err(await w.A.post(`/my-products/brochure-reading/${job.id}/result`))).toMatchObject({ status: 409 });
    expect(err(await w.A.post(`/my-products/brochure-reading/${job.id}/retry`))).toMatchObject({ status: 409 });
    // the advisor is sure it is right: read it anyway
    const again = await w.A.post('/my-products/brochure-reading', { typeId: w.types.Health, fileId: job.fileId, ignoreCategoryCheck: true });
    expect((await settled(() => w.A.get(`/my-products/brochure-reading/${again.body.data.id}`))).status).toBe('REVIEW_REQUIRED');
  });

  it('Motor chosen, Motor brochure: the motor features and motor details are read and go into the product', async () => {
    const w = await world();
    brochure = CAR_BROCHURE;
    const start = await w.A.post('/my-products/brochure-reading', { typeId: w.types['Motor Private Car'], fileId: await upload(w.adv.token) });
    const job = await settled(() => w.A.get(`/my-products/brochure-reading/${start.body.data.id}`));
    expect(job.status).toBe('REVIEW_REQUIRED');
    expect(job.detectedCategory.form).toBe('MOTOR_CAR');
    const row = (k: string) => job.rows.find((r: { key: string }) => r.key === k);
    expect(row('own_damage')).toMatchObject({ found: true, value: 'Yes', page: 2 });
    expect(row('zero_dep')).toMatchObject({ found: true, value: 'Yes' });
    expect(row('roadside')).toMatchObject({ found: true, value: 'Yes' });
    const det = Object.fromEntries(job.details.map((r: { key: string; value: string }) => [r.key, r.value]));
    expect(det).toMatchObject({ 'details.coverTypes': 'Comprehensive, Third-party only', 'details.fuelTypes': 'Petrol, Diesel, CNG', policyTerms: '1, 3' });
    expect(det.adultMin).toBeUndefined(); // no entry ages for a vehicle
    // decide: accept everything found, type the one value the brochure gives in words, Not stated for the rest
    const decisions = [
      ...job.rows.map((r: { key: string; found: boolean }) => ({ key: r.key, decision: r.found ? 'ACCEPT' : 'NOT_STATED' })),
      { section: 'DETAIL', key: 'details.coverTypes', decision: 'ACCEPT' },
      { section: 'DETAIL', key: 'details.fuelTypes', decision: 'ACCEPT' },
      { section: 'DETAIL', key: 'policyTerms', decision: 'ACCEPT' },
    ];
    // a typed value that is not one of the options is refused
    const bad = await w.A.put(`/my-products/brochure-reading/${job.id}/decisions`, { decisions: [{ section: 'DETAIL', key: 'details.coverTypes', decision: 'EDIT', value: 'Flood cover' }] });
    expect(bad.body.error.fields[0]).toMatchObject({ field: 'detail.details.coverTypes', messageId: 'VAL-22' });
    expect((await w.A.put(`/my-products/brochure-reading/${job.id}/decisions`, { decisions })).status).toBe(200);
    const result = (await w.A.post(`/my-products/brochure-reading/${job.id}/result`)).body.data;
    expect(result.data.details).toEqual({ coverTypes: ['Comprehensive', 'Third-party only'], fuelTypes: ['Petrol', 'Diesel', 'CNG'] });
    expect(result.data.policyTerms).toEqual([1, 3]);
    const made = await w.A.post('/my-products', { insurerId: w.insurerId, typeId: w.types['Motor Private Car'], code: 'CAR-1', ocrJobId: job.id, data: {
      ...result.data, name: 'DriveSafe', uin: 'DRIVMOT26001V012526', launchDate: '01-01-2026', pricingMode: 'MANUAL_ENTRY', taxPercent: 18, sumInsured: { min: 100000, max: 3000000 },
      details: { ...result.data.details, maxVehicleAgeYears: 15 } } });
    expect(made.status).toBe(201);
    expect(made.body.data.publishedVersion.entered.details).toMatchObject({ coverTypes: ['Comprehensive', 'Third-party only'], maxVehicleAgeYears: 15 });
  });

  it('Motor Private Car chosen, two-wheeler brochure: refused (car and two-wheeler are different categories)', async () => {
    const w = await world();
    brochure = BIKE_BROCHURE;
    const start = await w.A.post('/my-products/brochure-reading', { typeId: w.types['Motor Private Car'], fileId: await upload(w.adv.token) });
    const job = await settled(() => w.A.get(`/my-products/brochure-reading/${start.body.data.id}`));
    expect(job).toMatchObject({ status: 'WRONG_CATEGORY', detectedCategory: { form: 'MOTOR_TWO_WHEELER' } });
    expect(job.message).toContain('Motor (two-wheeler)');
  });

  it('a private category with no known kind (GENERIC) is never refused', async () => {
    const w = await world();
    brochure = CAR_BROCHURE;
    const cat = (await w.A.post('/my-products/types', { name: 'Pet cover' })).body.data;
    const start = await w.A.post('/my-products/brochure-reading', { typeId: cat.id, fileId: await upload(w.adv.token) });
    const job = await settled(() => w.A.get(`/my-products/brochure-reading/${start.body.data.id}`));
    expect(job.status).toBe('REVIEW_REQUIRED');
    expect(job.detectedCategory.form).toBe('MOTOR_CAR'); // still shown
  });
});

describe('SkyUp: brochure reading on a verified draft', () => {
  async function staffAndDraft(w: Awaited<ReturnType<typeof world>>, typeName: string) {
    const m = newMobile();
    await User.create({ accountId: null, role: 'STF', name: 'Meena Staff', mobile: normalizeMobile(m), status: 'ACTIVE', activatedAt: new Date() });
    const s = await login(m);
    const S = as(s.token);
    const c = (await S.post('/admin/products', { insurerId: w.insurerId, typeId: w.types[typeName], code: typeName.replace(/\W+/g, '-').toUpperCase() })).body.data;
    return { S, s, vid: c.version.id as string };
  }

  it('a Health draft refuses a Motor brochure (OCR-09); a Motor draft takes it and the details are merged into the draft', async () => {
    const w = await world();
    brochure = CAR_BROCHURE;
    const h = await staffAndDraft(w, 'Health');
    await h.S.post(`/admin/product-versions/${h.vid}/ocr`, { fileId: await upload(h.s.token) });
    const wrong = await settled(() => h.S.get(`/admin/product-versions/${h.vid}/ocr`));
    expect(wrong).toMatchObject({ status: 'WRONG_CATEGORY', messageId: 'OCR-09', category: { form: 'HEALTH', name: 'Health' } });
    expect(err(await h.S.post(`/admin/ocr-jobs/${wrong.id}/apply`))).toMatchObject({ status: 409 });

    const m = await staffAndDraft(w, 'Motor Private Car');
    await ProductVersion.updateOne({ _id: m.vid }, { $set: { 'data.details': { maxVehicleAgeYears: 12 } } }); // typed before reading
    await m.S.post(`/admin/product-versions/${m.vid}/ocr`, { fileId: await upload(m.s.token) });
    const job = await settled(() => m.S.get(`/admin/product-versions/${m.vid}/ocr`));
    expect(job.status).toBe('REVIEW_REQUIRED');
    await m.S.put(`/admin/ocr-jobs/${job.id}/decisions`, { decisions: [
      ...job.rows.map((r: { key: string; found: boolean }) => ({ key: r.key, decision: r.found ? 'ACCEPT' : 'NOT_STATED' })),
      { section: 'DETAIL', key: 'details.coverTypes', decision: 'EDIT', value: 'Comprehensive' },
    ] });
    expect((await m.S.post(`/admin/ocr-jobs/${job.id}/apply`)).status).toBe(200);
    const v = (await ProductVersion.findById(m.vid).lean<{ data: { details: Record<string, unknown>; features: Record<string, { value?: unknown }> } }>())!;
    expect(v.data.details).toEqual({ maxVehicleAgeYears: 12, coverTypes: ['Comprehensive'] }); // merged, not replaced
    expect(v.data.features.own_damage!.value).toBe(true);
  });
});  