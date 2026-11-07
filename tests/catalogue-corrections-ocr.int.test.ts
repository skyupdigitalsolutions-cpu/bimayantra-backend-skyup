/**
 * Module 8 Stage 4b — P-58 corrections and P-23 brochure reading. The OCR reader is a stand-in (Document AI is not
 * reachable from tests); the matcher runs for real.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let behaviour: 'ok' | 'fail' = 'ok';
const PAGES = [
  { number: 1, confidence: 0.97, text: 'Family Shield\nRoom rent limit: Rs. 5,000 per day\nAmbulance cover: Covered up to Rs 2,000' },
  { number: 2, confidence: 0.6, text: 'Waiting periods\nPre-existing disease waiting period 3 years' },
];
vi.mock('../src/modules/documents/reader.js', () => ({
  readerEnabled: () => true,
  readDocument: async () => null,
  ocrText: async () => '',
  ocrPages: async () => {
    await new Promise((r) => setTimeout(r, 30));
    if (behaviour === 'fail') throw new Error('Document AI unavailable');
    return { text: PAGES.map((p) => p.text).join('\n'), pages: PAGES };
  },
}));

const h = await import('./helpers.js');
const { as, err, login, newMobile, registerAdvisor, resetState, seedAdmin, startTestEnv, stepUp, stopTestEnv } = h;
const { User } = await import('../src/modules/users/user.model.js');
const { normalizeMobile } = await import('../src/lib/phone.js');
const { Insurer } = await import('../src/modules/insurers/insurer.model.js');
const { InsuranceType, TemplateVersion } = await import('../src/modules/catalogue/types.model.js');
const { ProductVersion } = await import('../src/modules/catalogue/product.model.js');
const { Notification } = await import('../src/modules/notifications/notification.model.js');
const { ConfigValue, loadConfigOverrides } = await import('../src/config/cfg.js');
const { matchFeatures } = await import('../src/modules/catalogue/ocr.service.js');

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(async () => { behaviour = 'ok'; await resetState(); });

const FEATURES = [
  { key: 'room_rent', name: 'Room rent limit', group: 'Limits and sub-limits', dataType: 'Amount in ₹', requiredToPublish: true, order: 1 },
  { key: 'ped_wait', name: 'Pre-existing disease waiting period', group: 'Waiting periods', dataType: 'Months', requiredToPublish: true, order: 2 },
  { key: 'ambulance', name: 'Ambulance cover', group: 'Benefits', dataType: 'Yes/No', requiredToPublish: false, order: 3 },
  { key: 'maternity', name: 'Maternity benefit', group: 'Benefits', dataType: 'Yes/No', requiredToPublish: false, order: 4 },
];
const DATA = {
  name: 'Family Shield', uin: 'ALPHLIP21001V012122', launchDate: '01-01-2026', adultMin: 18, adultMax: 65, sumInsured: { options: [500000] }, policyTerms: [1],
  pricingMode: 'MANUAL_ENTRY', taxPercent: 18, sourceLink: 'https://alpha.in/p', sourceCheckedOn: '01-10-2026', features: { room_rent: { value: 5000 }, ped_wait: { value: 24 } },
};

async function setup() {
  const ins = await Insurer.create({ name: 'Alpha Health', nameKey: 'alpha health', shortCode: 'ALPHA', category: 'Standalone Health', irdaiRegNo: 'R-1', paymentDomains: ['alpha.in'], status: 'ACTIVE' });
  const type = await InsuranceType.create({ name: 'Health', nameKey: 'health' });
  await TemplateVersion.create({ typeId: type._id, number: 1, status: 'ACTIVE', isOpen: null, makerId: 'x', features: FEATURES, factors: [{ key: 'age', name: 'Age', kind: 'BAND', source: 'Age of the eldest insured person', bands: [{ from: 18, to: 65 }] }] });
  const sm = newMobile();
  await User.create({ accountId: null, role: 'STF', name: 'Meena Staff', mobile: normalizeMobile(sm), status: 'ACTIVE', activatedAt: new Date() });
  const staff = { mobile: sm, ...(await login(sm)) };
  const admin = await seedAdmin();
  const S = as(staff.token);
  const c = (await S.post('/admin/products', { insurerId: ins._id, typeId: type._id, code: 'FAM-1' })).body.data;
  const saved = (await S.put(`/admin/product-versions/${c.version.id}`, { rev: c.version.rev, data: DATA })).body.data;
  return { staff, admin, S, productId: c.productId as string, vid: c.version.id as string, rev: saved.rev as number };
}
/** Publish a version (no admin approval: staff publishes it with the OTP). */
async function publish(s: Awaited<ReturnType<typeof setup>>, vid = s.vid) {
  const v = await ProductVersion.findById(vid).lean();
  return s.S.post(`/admin/product-versions/${vid}/submit`, { rev: v!.rev }, { 'X-Step-Up-Token': await stepUp(s.staff.token, s.staff.mobile) });
}

describe('P-58 corrections', () => {
  it('AC-P58-1: an advisor cannot edit a verified product, only send a correction (CAT-35); a second for the same field is CAT-08', async () => {
    const s = await setup();
    await publish(s);
    const adv = await registerAdvisor('Asha Rao');
    expect(err(await as(adv.token).put(`/admin/product-versions/${s.vid}`, { rev: 1, data: DATA }))).toMatchObject({ status: 403 });
    expect(err(await as(adv.token).put(`/my-products/${s.productId}`, { version: 1, data: DATA }))).toMatchObject({ status: 404 });
    const sent = await as(adv.token).post(`/products/${s.productId}/corrections`, { field: 'features.ped_wait', proposedValue: '36', reason: 'Brochure page 4 says 3 years' });
    expect(sent.status).toBe(201);
    expect(sent.body.meta.message).toBe('Correction sent to SkyUp for review.');
    expect(sent.body.data).toMatchObject({ status: 'SUBMITTED', currentValue: { value: 24 } });
    expect(err(await as(adv.token).post(`/products/${s.productId}/corrections`, { field: 'features.ped_wait', proposedValue: '30', reason: 'Another page says 30 months' }))).toMatchObject({ status: 409, messageId: 'CAT-08' });
  });

  it('AC-P58-2 (changed): Accept and publish needs the OTP, puts the value in a new version with its ID and makes it live at once (CAT-44)', async () => {
    const s = await setup();
    await publish(s);
    const adv = await registerAdvisor('Asha Rao');
    const cor = (await as(adv.token).post(`/products/${s.productId}/corrections`, { field: 'features.ped_wait', proposedValue: '36', reason: 'Brochure says 3 years' })).body.data;
    expect((await s.S.get('/admin/corrections')).body.data.map((x: { id: string; product: string }) => `${x.id}:${x.product}`)).toEqual([`${cor.id}:Family Shield`]);
    expect(err(await s.S.post(`/admin/corrections/${cor.id}/accept`, {}))).toMatchObject({ messageId: 'AUTH-26' });
    const acc = (await s.S.post(`/admin/corrections/${cor.id}/accept`, {}, { 'X-Step-Up-Token': await stepUp(s.staff.token, s.staff.mobile) })).body.data;
    expect(acc.published).toBe(true);
    expect(await ProductVersion.findById(acc.draftVersionId).lean()).toMatchObject({ status: 'PUBLISHED', number: 2, data: { features: { ped_wait: { value: 36 } } }, corrections: [{ correctionId: cor.id, field: 'features.ped_wait' }] });
    expect((await as(adv.token).get(`/products/${s.productId}`)).body.data.publishedVersion.data.features.ped_wait.value).toBe(36);
    expect((await Notification.findOne({ messageId: 'CAT-44' }).lean())!.message).toBe('SkyUp accepted your correction to Family Shield. It is live now.');
  });

  it('when someone already has a draft open, an accepted correction waits in that draft (CAT-39) and goes live when it is published', async () => {
    const s = await setup();
    await publish(s);
    await s.S.post(`/admin/products/${s.productId}/versions`, {}); // a colleague's draft is open
    const adv = await registerAdvisor('Asha Rao');
    const cor = (await as(adv.token).post(`/products/${s.productId}/corrections`, { field: 'features.ped_wait', proposedValue: '36', reason: 'Brochure says 3 years' })).body.data;
    const acc = (await s.S.post(`/admin/corrections/${cor.id}/accept`, {})).body.data; // nothing is published, so no OTP is needed
    expect(acc.published).toBe(false);
    const seen = async () => (await as(adv.token).get(`/products/${s.productId}`)).body.data.publishedVersion.data.features.ped_wait.value;
    expect(await seen()).toBe(24);
    expect((await Notification.findOne({ messageId: 'CAT-39' }).lean())!.message).toBe('SkyUp accepted your correction to Family Shield. It will apply when the updated version is published.');
    await publish(s, acc.draftVersionId);
    expect(await seen()).toBe(36);
  });

  it('reject needs a reason and tells the advisor (CAT-40)', async () => {
    const s = await setup();
    await publish(s);
    const adv = await registerAdvisor('Asha Rao');
    const cor = (await as(adv.token).post(`/products/${s.productId}/corrections`, { field: 'name', proposedValue: 'Family Shield Gold', reason: 'Renamed' })).body.data;
    expect((await s.S.post(`/admin/corrections/${cor.id}/reject`, {})).status).toBe(400);
    await s.S.post(`/admin/corrections/${cor.id}/reject`, { reason: 'The insurer page still says Family Shield' });
    expect((await as(adv.token).get(`/products/${s.productId}/corrections`)).body.data[0]).toMatchObject({ status: 'REJECTED' });
    expect((await Notification.findOne({ messageId: 'CAT-40' }).lean())!.message).toBe('SkyUp did not accept your correction to Family Shield: The insurer page still says Family Shield');
  });
});

describe('P-23 brochure reading', () => {
  it('the matcher reads amounts, durations (years → months) and Yes/No; a missing feature is not found', () => {
    const rows = matchFeatures(FEATURES as never, PAGES);
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.room_rent).toMatchObject({ found: true, value: '5000', page: 1, confidence: 0.97 });
    expect(by.ped_wait).toMatchObject({ found: true, value: '36', page: 2, confidence: 0.6 });
    expect(by.ambulance).toMatchObject({ found: true, value: 'Yes' });
    expect(by.maternity).toMatchObject({ found: false, value: null });
  });

  const upload = (token: string, body: Buffer, name: string) =>
    request(h.app).post('/v1/files?purpose=BROCHURE').set('Authorization', `Bearer ${token}`).set('Content-Type', 'application/octet-stream').set('X-File-Name', name).send(body);
  const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\ntrailer << >>\n%%EOF\n');
  const until = async (S: ReturnType<typeof as>, vid: string, want: string) => {
    for (let i = 0; i < 40; i++) { const j = (await S.get(`/admin/product-versions/${vid}/ocr`)).body.data; if (j?.status === want) return j; await new Promise((r) => setTimeout(r, 25)); }
    throw new Error(`no ${want}`);
  };

  it('AC-P23-1 / AC-P23-2: nothing reaches the draft without a decision; bulk accept takes only high-confidence rows; apply (OCR-06) marks values', async () => {
    const s = await setup();
    const fileId = (await upload(s.staff.token, PDF, 'brochure.pdf')).body.data.id;
    const started = await s.S.post(`/admin/product-versions/${s.vid}/ocr`, { fileId });
    expect(started.status).toBe(202);
    expect(started.body.meta.message).toBe('Reading the brochure. This can take up to 5 minutes. You can leave this page; we will notify you when it is ready.');
    const job = await until(s.S, s.vid, 'REVIEW_REQUIRED');
    expect((await Notification.findOne({ messageId: 'OCR-02' }).lean())!.message).toBe('Brochure read. 3 values found; 2 need checking.');
    expect((await ProductVersion.findById(s.vid).lean())!.data).toMatchObject({ features: { room_rent: { value: 5000 }, ped_wait: { value: 24 } } }); // unchanged
    expect(err(await s.S.post(`/admin/ocr-jobs/${job.id}/apply`, {}))).toMatchObject({ messageId: 'OCR-05' });
    const bulk = (await s.S.post(`/admin/ocr-jobs/${job.id}/accept-high`, {})).body.data;
    expect(Object.fromEntries(bulk.rows.map((r: { key: string; decision: string | null }) => [r.key, r.decision]))).toEqual({ room_rent: 'ACCEPT', ped_wait: null, ambulance: 'ACCEPT', maternity: null });
    await s.S.put(`/admin/ocr-jobs/${job.id}/decisions`, { decisions: [{ key: 'ped_wait', decision: 'EDIT', value: '30' }, { key: 'maternity', decision: 'NOT_STATED' }] });
    const applied = await s.S.post(`/admin/ocr-jobs/${job.id}/apply`, {});
    expect(applied.body.meta.message).toBe('4 values applied to the draft.');
    const v = await ProductVersion.findById(s.vid).lean();
    expect(v!.data).toMatchObject({ features: { room_rent: { value: 5000, page: 1 }, ped_wait: { value: 30 }, ambulance: { value: true }, maternity: { notStated: true } } });
    expect((v!.ocrMarks as Record<string, { checkedBy: string }>).ped_wait?.checkedBy).toBe('Meena Staff');
  });

  it('AC-P23-3: a failed job leaves the draft unchanged (OCR-03) and can be tried again', async () => {
    const s = await setup();
    behaviour = 'fail';
    const fileId = (await upload(s.staff.token, PDF, 'brochure.pdf')).body.data.id;
    await s.S.post(`/admin/product-versions/${s.vid}/ocr`, { fileId });
    const failed = await until(s.S, s.vid, 'FAILED');
    expect(await Notification.countDocuments({ messageId: 'OCR-03' })).toBe(1);
    expect((await ProductVersion.findById(s.vid).lean())!.rev).toBe(s.rev);
    behaviour = 'ok';
    expect((await s.S.post(`/admin/ocr-jobs/${failed.id}/retry`, {})).status).toBe(202);
    await until(s.S, s.vid, 'REVIEW_REQUIRED');
  });

  it('AC-P23-4: a brochure over CFG-30 pages is refused (OCR-04); OCR switched off (CFG-102) is OCR-07', async () => {
    const s = await setup();
    const big = Buffer.from(`%PDF-1.4\n${Array.from({ length: 51 }, (_, i) => `${i + 1} 0 obj << /Type /Page >> endobj`).join('\n')}\ntrailer << >>\n%%EOF\n`);
    const fileId = (await upload(s.staff.token, big, 'big.pdf')).body.data.id;
    const r = await s.S.post(`/admin/product-versions/${s.vid}/ocr`, { fileId });
    expect(JSON.stringify(r.body)).toContain('This brochure has more than 50 pages.');
    await ConfigValue.updateOne({ _id: 'CFG-102' }, { $set: { value: false, updatedBy: 'test' } }, { upsert: true });
    await loadConfigOverrides();
    try {
      expect(err(await s.S.post(`/admin/product-versions/${s.vid}/ocr`, { fileId }))).toMatchObject({ status: 409, messageId: 'OCR-07' });
    } finally { await ConfigValue.deleteOne({ _id: 'CFG-102' }); await loadConfigOverrides(); }
  });
});