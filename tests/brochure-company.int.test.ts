/**
 * Client requirement (Nov 2026): a brochure from another company than the one chosen is refused (OCR-10); a brochure of
 * the right company is read and every value found is accepted at once (advisor readings).
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, as, registerAdvisor, resetState, startTestEnv, stopTestEnv } from './helpers.js';
import { Insurer } from '../src/modules/insurers/insurer.model.js';
import { InsuranceType, TemplateVersion } from '../src/modules/catalogue/types.model.js';
import { Product, ProductVersion } from '../src/modules/catalogue/product.model.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { checkCompany, nameKey } from '../src/modules/catalogue/brochureInsurer.js';

type Page = { number: number; confidence: number; text: string };
const HDFC: Page[] = [
  { number: 1, confidence: 0.96, text: 'HDFC ERGO General Insurance Company Limited\nmy:health Suraksha Top-Up Plus\nUIN: HDFHLIP21467V022021\nwww.hdfcergo.com\nSum insured: 2 lakh, 5 lakh\nRoom rent limit: No limit\nIn-patient hospitalisation: Covered\nPre-existing disease waiting period: 36 months\nCashless hospitals: 13,000+ network hospitals' },
];
const NOBODY: Page[] = [{ number: 1, confidence: 0.95, text: 'Family health plan\nRoom rent limit: No limit\nIn-patient hospitalisation: Covered\nHospitalisation and day care covered' }];
let brochure = HDFC;
vi.mock('../src/modules/documents/reader.js', () => ({
  readerEnabled: () => true, readDocument: async () => null, ocrText: async () => '',
  ocrPages: async () => ({ text: brochure.map((p) => p.text).join('\n'), pages: brochure }),
}));

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(async () => { brochure = HDFC; await resetState(); });

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n2 0 obj << /Type /Page >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
const upload = async (token: string) => (await request(app).post('/v1/files?purpose=BROCHURE').set('Authorization', `Bearer ${token}`).set('Content-Type', 'application/octet-stream').set('X-File-Name', 'b.pdf').send(PDF)).body.data.id as string;
async function settled(get: () => Promise<{ body: { data: { status: string } } }>) {
  let job = (await get()).body.data;
  for (let i = 0; i < 100 && ['QUEUED', 'PROCESSING'].includes(job.status); i++) { await new Promise((r) => setTimeout(r, 20)); job = (await get()).body.data; }
  return job as Record<string, any>;
}

async function world() {
  const hdfc = await Insurer.create({ name: 'HDFC ERGO General Insurance Co. Ltd.', nameKey: 'hdfc ergo general insurance co. ltd.', shortCode: 'HDFCERGO', category: 'General', irdaiRegNo: '146', website: 'https://www.hdfcergo.com', paymentDomains: ['hdfcergo.com'], status: 'ACTIVE' });
  const star = await Insurer.create({ name: 'Star Health and Allied Insurance Co. Ltd.', nameKey: 'star health and allied insurance co. ltd.', shortCode: 'STAR', category: 'Standalone Health', irdaiRegNo: '129', website: 'https://www.starhealth.in', paymentDomains: ['starhealth.in'], status: 'ACTIVE' });
  const health = await InsuranceType.create({ name: 'Health', nameKey: 'health', productForm: 'HEALTH' });
  const tpl = await TemplateVersion.create({ typeId: health._id, number: 1, status: 'ACTIVE', isOpen: null, makerId: 'x', features: [
    { key: 'room_rent', name: 'Room rent limit', group: 'Limits and sub-limits', dataType: 'Text', requiredToPublish: false, order: 1 },
    { key: 'in_patient_hospitalisation', name: 'In-patient hospitalisation', group: 'Coverage', dataType: 'Yes/No', requiredToPublish: false, order: 2 },
    { key: 'opd_cover', name: 'OPD cover', group: 'Coverage', dataType: 'Yes/No', requiredToPublish: false, order: 3 },
  ] });
  // an HDFC ERGO product already in the catalogue teaches the UIN prefix HDF
  const p = await Product.create({ kind: 'VERIFIED', insurerId: hdfc._id, typeId: health._id, code: 'OPTIMA', makerId: 'x', status: 'ACTIVE' });
  const v = await ProductVersion.create({ productId: p._id, number: 1, templateId: tpl._id, makerId: 'x', status: 'PUBLISHED', isOpen: null, data: { name: 'Optima Secure', uin: 'HDFHLIP25041V062425' } });
  await Product.updateOne({ _id: p._id }, { $set: { publishedVersionId: v._id } });
  const adv = await registerAdvisor('Asha Rao');
  return { hdfc: hdfc._id as string, star: star._id as string, typeId: health._id as string, adv, A: as(adv.token) };
}
const read = async (w: Awaited<ReturnType<typeof world>>, insurerId?: string) => {
  const start = await w.A.post('/my-products/brochure-reading', { typeId: w.typeId, fileId: await upload(w.adv.token), ...(insurerId ? { insurerId } : {}) });
  expect(start.status).toBe(202);
  return settled(() => w.A.get(`/my-products/brochure-reading/${start.body.data.id}`));
};

describe('brochure company check', () => {
  it('name keys', () => {
    expect(nameKey('HDFC ERGO General Insurance Co. Ltd.')).toBe('hdfc ergo');
    expect(nameKey('star health')).toBe('star health');
  });

  it('Star Health chosen, HDFC ERGO brochure: WRONG_COMPANY with OCR-10, nothing to use', async () => {
    const w = await world();
    const job = await read(w, w.star);
    expect(job.status).toBe('WRONG_COMPANY');
    expect(job.messageId).toBe('OCR-10');
    expect(job.message).toBe('This brochure looks like it is from HDFC ERGO General Insurance Co. Ltd., but the company chosen is Star Health and Allied Insurance Co. Ltd.. Go back and choose HDFC ERGO General Insurance Co. Ltd. as the company, or upload a Star Health and Allied Insurance Co. Ltd. brochure.');
    expect(job.detectedCompany).toEqual({ id: w.hdfc, name: 'HDFC ERGO General Insurance Co. Ltd.' });
    expect(job.rows).toEqual([]);
    expect((await Notification.findOne({ messageId: 'OCR-10' }).lean())).toBeTruthy();
    expect((await w.A.post(`/my-products/brochure-reading/${job.id}/result`)).status).toBe(409);
  });

  it('the advisor\'s own company "star health" is refused for an HDFC ERGO brochure too', async () => {
    const w = await world();
    const mine = (await w.A.post('/my-products/insurers', { name: 'star health' })).body.data;
    expect((await read(w, mine.id)).status).toBe('WRONG_COMPANY');
  });

  it('HDFC ERGO chosen: read, and every value found is accepted at once; feature rows carry their name as label', async () => {
    const w = await world();
    const job = await read(w, w.hdfc);
    expect(job.status).toBe('REVIEW_REQUIRED');
    const row = (k: string) => job.rows.find((r: { key: string }) => r.key === k);
    expect(row('room_rent')).toMatchObject({ found: true, decision: 'ACCEPT', label: 'Room rent limit' });
    expect(row('in_patient_hospitalisation')).toMatchObject({ found: true, decision: 'ACCEPT', value: 'Yes' });
    expect(row('opd_cover')).toMatchObject({ found: false, decision: null, label: 'OPD cover' }); // not in the brochure: open
    expect(job.details.find((r: { key: string }) => r.key === 'uin')).toMatchObject({ value: 'HDFHLIP21467V022021', decision: 'ACCEPT' });
    const result = (await w.A.post(`/my-products/brochure-reading/${job.id}/result`)).body.data;
    expect(result.data).toMatchObject({ uin: 'HDFHLIP21467V022021', features: { room_rent: { value: 'No limit' }, in_patient_hospitalisation: { value: true } } });
  });

  it('no company sent (older screens) or a brochure that names nobody: read as before', async () => {
    const w = await world();
    expect((await read(w)).status).toBe('REVIEW_REQUIRED');
    brochure = NOBODY;
    expect((await read(w, w.star)).status).toBe('REVIEW_REQUIRED');
  });

  it('checkCompany: the chosen one with any evidence passes', async () => {
    const w = await world();
    const text = HDFC.map((p) => p.text).join('\n');
    expect(await checkCompany(text, w.hdfc, null)).toMatchObject({ mismatch: false });
    expect(await checkCompany(`${text}\nIn partnership with Star Health`, w.star, null)).toMatchObject({ mismatch: false });
  });
});