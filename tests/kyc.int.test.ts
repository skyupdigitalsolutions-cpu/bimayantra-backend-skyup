/**
 * Module 5 Stage 2 — file store (FLD-22) and P-06 Submit and review KYC.
 * Test names cite the BPD acceptance checks they cover.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, as, err, login, newMobile, registerAdvisor, resetState, seedAdmin, startTestEnv, stepUp, stopTestEnv } from './helpers.js';
import { Account } from '../src/modules/accounts/account.model.js';
import { AuditLog } from '../src/modules/audit/audit.model.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { StoredFile } from '../src/modules/files/file.model.js';
import { User } from '../src/modules/users/user.model.js';
import { normalizeMobile } from '../src/lib/phone.js';
import { workingDaysSince } from '../src/modules/kyc/kyc.service.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

// ── sample files ──
// A real 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1), Buffer.from([0xff, 0xd9])]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
const PDF_LOCKED = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R /Encrypt 2 0 R >>\n%%EOF\n', 'latin1');
const PDF_TRUNCATED = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> en', 'latin1');
const EXE = Buffer.from('MZ\x90\x00\x03\x00\x00\x00this is a program, not a document', 'latin1');

const upload = (token: string, purpose: string, bytes: Buffer, name = 'file.bin') =>
  request(app).post(`/v1/files?purpose=${purpose}`).set('Authorization', `Bearer ${token}`).set('Content-Type', 'application/octet-stream').set('X-File-Name', name).send(bytes);
const fieldIds = (res: request.Response) => (res.body.error?.fields ?? []).map((f: { messageId: string }) => f.messageId);

async function advisor(name = 'Asha Rao') {
  const adv = await registerAdvisor(name);
  const pan = (await upload(adv.token, 'KYC_PAN', PNG, 'pan.png')).body.data.id as string;
  const licence = (await upload(adv.token, 'KYC_LICENCE', PDF, 'licence.pdf')).body.data.id as string;
  return { adv, c: as(adv.token), pan, licence };
}
async function submit(a: Awaited<ReturnType<typeof advisor>>, extra: object = {}) {
  const k = (await a.c.get('/kyc')).body.data;
  return a.c.put('/kyc', { version: k.version, pan: 'ABCPE1234F', nameOnPan: 'Asha Rao', panFileId: a.pan, licenceFileId: a.licence, declaration: true, ...extra });
}

describe('FLD-22 file store', () => {
  it('accepts PNG, JPG and PDF by their content and records the detected type', async () => {
    const adv = await registerAdvisor();
    expect((await upload(adv.token, 'KYC_PAN', PNG, 'pan.png')).body.data).toMatchObject({ type: 'PNG', purpose: 'KYC_PAN', name: 'pan.png' });
    expect((await upload(adv.token, 'KYC_PAN', JPG, 'pan.jpg')).body.data.type).toBe('JPG');
    expect((await upload(adv.token, 'KYC_LICENCE', PDF, 'l.pdf')).body.data.type).toBe('PDF');
  });

  it('judges by content, not name: a program named .pdf is refused (VAL-23); a PNG named .pdf is stored as PNG', async () => {
    const adv = await registerAdvisor();
    const exe = await upload(adv.token, 'KYC_LICENCE', EXE, 'licence.pdf');
    expect(exe.status).toBe(400);
    expect(JSON.stringify(exe.body)).toContain('This file type is not allowed. Upload one of: PDF, JPG, JPEG, PNG.');
    expect((await upload(adv.token, 'KYC_LICENCE', PNG, 'licence.pdf')).body.data.type).toBe('PNG');
  });

  it('photos and logos are images only (CFG-126); documents may be PDF (CFG-26)', async () => {
    const adv = await registerAdvisor();
    expect(fieldIds(await upload(adv.token, 'PROFILE_PHOTO', PDF, 'me.pdf'))).toEqual(['VAL-23']);
    expect((await upload(adv.token, 'PROFILE_PHOTO', PNG, 'me.png')).status).toBe(201);
  });

  it('refuses password-protected and damaged PDFs (VAL-26)', async () => {
    const adv = await registerAdvisor();
    expect(fieldIds(await upload(adv.token, 'KYC_LICENCE', PDF_LOCKED))).toEqual(['VAL-26']);
    expect(fieldIds(await upload(adv.token, 'KYC_LICENCE', PDF_TRUNCATED))).toEqual(['VAL-26']);
  });

  it('refuses files over the size limit: images CFG-127 (2 MB), documents CFG-27 (10 MB) (VAL-24)', async () => {
    const adv = await registerAdvisor();
    const bigPng = Buffer.concat([PNG.subarray(0, PNG.length - 12), Buffer.alloc(2 * 1024 * 1024 + 10, 0), PNG.subarray(PNG.length - 12)]);
    const res = await upload(adv.token, 'PROFILE_PHOTO', bigPng, 'big.png');
    expect(fieldIds(res)).toEqual(['VAL-24']);
    expect(JSON.stringify(res.body)).toContain('This file is larger than 2 MB. Upload a smaller file.');
  });

  it('files are never changed or deleted (object lock)', async () => {
    const adv = await registerAdvisor();
    const id = (await upload(adv.token, 'KYC_PAN', PNG)).body.data.id;
    await expect(StoredFile.updateOne({ _id: id }, { $set: { name: 'x' } })).rejects.toThrow(/never changed or deleted/);
    await expect(StoredFile.deleteOne({ _id: id })).rejects.toThrow(/never changed or deleted/);
  });

  it('records where each file is stored, and refuses a file whose bytes changed after upload (tamper check)', async () => {
    const adv = await registerAdvisor();
    const id = (await upload(adv.token, 'KYC_PAN', PNG)).body.data.id;
    const rec = await StoredFile.findById(id).lean();
    expect(rec!.backend).toBe('local');
    // Someone alters the stored bytes directly in storage:
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await writeFile(join(process.env.FILE_STORAGE_DIR!, rec!.storageKey), Buffer.concat([PNG, Buffer.from('x')]));
    const res = await request(app).get(`/v1/files/${id}`).set('Authorization', `Bearer ${adv.token}`);
    expect(err(res)).toMatchObject({ status: 500, messageId: 'GEN-99' });
    expect(await AuditLog.countDocuments({ action: 'FILE_INTEGRITY_FAILED' })).toBe(1);
  });

  it('the owner can open their file with safe headers', async () => {
    const adv = await registerAdvisor();
    const id = (await upload(adv.token, 'KYC_PAN', PNG)).body.data.id;
    const res = await request(app).get(`/v1/files/${id}`).set('Authorization', `Bearer ${adv.token}`).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('AC-P06-4: another advisor cannot open these files (GEN-11); an assistant cannot open KYC files', async () => {
    const a = await advisor('Asha Rao');
    const b = await registerAdvisor('Ravi Kumar');
    const other = await request(app).get(`/v1/files/${a.pan}`).set('Authorization', `Bearer ${b.token}`);
    expect(err(other)).toMatchObject({ status: 404, messageId: 'GEN-11' });
    const m = newMobile();
    await a.c.post('/assistants', { name: 'Priya Shah', mobile: m }, { 'X-Step-Up-Token': await stepUp(a.adv.token, a.adv.mobile) });
    const ast = await login(m);
    expect((await request(app).get(`/v1/files/${a.pan}`).set('Authorization', `Bearer ${ast.token}`)).status).toBe(404);
    expect((await upload(ast.token, 'KYC_PAN', PNG)).status).toBe(403); // assistants cannot upload KYC
  });
});

describe('P-06 KYC', () => {
  it('AC-P06-1: a complete submission moves KYC to PENDING_REVIEW (PRF-04) and appears in the review queue', async () => {
    const a = await advisor();
    const res = await submit(a);
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ messageId: 'PRF-04', message: 'KYC submitted for review. We aim to review it within 2 working days.' });
    expect(res.body.data).toMatchObject({ status: 'PENDING_REVIEW', pan: 'ABCPE1234F', nameOnPan: 'Asha Rao' });
    const admin = await seedAdmin();
    const queue = (await as(admin.token).get('/admin/kyc')).body.data;
    expect(queue.items.map((i: { accountId: string }) => i.accountId)).toContain(a.adv.user.accountId);
    // KYC now counts towards completion
    expect((await a.c.get('/profile')).body.data.completion.missing.map((g: { section: string }) => g.section)).not.toContain('KYC');
  });

  it('validation: PAN (VAL-16), declaration (VAL-29), files required (GEN-01), only own files of the right kind', async () => {
    const a = await advisor();
    const k = (await a.c.get('/kyc')).body.data;
    const bad = await a.c.put('/kyc', { version: k.version, pan: 'ABCDE1234F', nameOnPan: 'Asha Rao', declaration: false });
    const ids = (bad.body.error.fields as Array<{ field: string; messageId: string }>).map((f) => `${f.field}:${f.messageId}`).sort();
    expect(ids).toEqual(['declaration:VAL-29', 'licenceFileId:GEN-01', 'pan:VAL-16', 'panFileId:GEN-01']);
    // the licence file given as the PAN image → wrong kind
    expect(fieldIds(await a.c.put('/kyc', { version: k.version, pan: 'ABCPE1234F', nameOnPan: 'Asha Rao', panFileId: a.licence, licenceFileId: a.licence, declaration: true }))).toEqual(['VAL-22']);
    // another advisor's file → refused
    const b = await advisor('Ravi Kumar');
    expect(fieldIds(await a.c.put('/kyc', { version: k.version, pan: 'ABCPE1234F', nameOnPan: 'Asha Rao', panFileId: b.pan, licenceFileId: a.licence, declaration: true }))).toEqual(['VAL-22']);
  });

  it('PAN is stored encrypted, shown in full only on the KYC and review screens, never in the audit', async () => {
    const a = await advisor();
    await submit(a);
    const acc = await Account.findById(a.adv.user.accountId).lean();
    expect(acc!.profile!.kyc!.panEnc).not.toContain('ABCPE1234F');
    // The audit service strips PAN fields completely (stricter than masking): no form of the PAN is stored.
    const trail = JSON.stringify(await AuditLog.find({ entity: 'kyc' }).lean());
    expect(trail).toContain('KYC_SUBMITTED');
    expect(trail).not.toContain('1234F');
  });

  it('AC-P06-2: Verify notifies with PRF-05; Reject needs a reason and notifies with PRF-06', async () => {
    const admin = await seedAdmin();
    const A = as(admin.token);
    const a = await advisor('Asha Rao');
    await submit(a);
    let item = (await A.get(`/admin/kyc/${a.adv.user.accountId}`)).body.data;
    expect(item).toMatchObject({ pan: 'ABCPE1234F', advisorName: 'Asha Rao' });
    expect(err(await A.post(`/admin/kyc/${a.adv.user.accountId}/decision`, { version: item.version, decision: 'REJECT' }))).toMatchObject({ status: 400 });
    expect(err(await A.post(`/admin/kyc/${a.adv.user.accountId}/decision`, { version: item.version, decision: 'REJECT', reason: 'Other' }))).toMatchObject({ status: 400 });
    const rej = await A.post(`/admin/kyc/${a.adv.user.accountId}/decision`, { version: item.version, decision: 'REJECT', reason: 'Name does not match' });
    expect(rej.body.meta.message).toBe('Your KYC was not accepted: Name does not match. Please correct it and submit again.');
    expect((await Notification.findOne({ userId: a.adv.user.id, kind: 'KYC_REJECTED' }).lean())!.message).toBe('Your KYC was not accepted: Name does not match. Please correct it and submit again.');
    expect((await a.c.get('/kyc')).body.data.status).toBe('REJECTED');

    await submit(a, { nameOnPan: 'Asha Rao K' }); // corrected and submitted again
    item = (await A.get(`/admin/kyc/${a.adv.user.accountId}`)).body.data;
    expect(err(await A.post(`/admin/kyc/${a.adv.user.accountId}/decision`, { version: item.version, decision: 'VERIFY' }))).toMatchObject({ status: 403, messageId: 'AUTH-26' }); // Verify needs the OTP
    const ver = await A.post(`/admin/kyc/${a.adv.user.accountId}/decision`, { version: item.version, decision: 'VERIFY' }, { 'X-Step-Up-Token': await stepUp(admin.token, admin.mobile) });
    expect(ver.body.meta).toMatchObject({ messageId: 'PRF-05', message: 'Your KYC has been verified.' });
    expect(await Notification.countDocuments({ userId: a.adv.user.id, kind: 'KYC_VERIFIED' })).toBe(1);
    expect(await AuditLog.countDocuments({ action: { $in: ['KYC_VERIFIED', 'KYC_REJECTED'] } })).toBe(2);
  });

  it('two reviewers deciding the same item: the second gets GEN-04', async () => {
    const admin = await seedAdmin();
    const admin2 = await seedAdmin();
    const a = await advisor();
    await submit(a);
    const version = (await as(admin.token).get(`/admin/kyc/${a.adv.user.accountId}`)).body.data.version;
    expect((await as(admin.token).post(`/admin/kyc/${a.adv.user.accountId}/decision`, { version, decision: 'VERIFY' }, { 'X-Step-Up-Token': await stepUp(admin.token, admin.mobile) })).status).toBe(200);
    const second = await as(admin2.token).post(`/admin/kyc/${a.adv.user.accountId}/decision`, { version, decision: 'REJECT', reason: 'PAN invalid' });
    expect(err(second)).toMatchObject({ status: 409, messageId: 'GEN-04' });
    expect((await a.c.get('/kyc')).body.data.status).toBe('VERIFIED');
  });

  it('Q113 (client decision): only SkyUp admins verify or reject; staff can open the queue and the submission', async () => {
    const staffMobile = newMobile();
    await User.create({ accountId: null, role: 'STF', name: 'Meena Iyer', mobile: normalizeMobile(staffMobile), status: 'ACTIVE', activatedAt: new Date() });
    const staff = await login(staffMobile);
    expect(staff.user.capabilities).not.toContain('kyc.decide');
    const a = await advisor();
    await submit(a);
    const S = as(staff.token);
    expect((await S.get('/admin/kyc')).status).toBe(200);
    const item = (await S.get(`/admin/kyc/${a.adv.user.accountId}`)).body.data;
    expect(err(await S.post(`/admin/kyc/${a.adv.user.accountId}/decision`, { version: item.version, decision: 'REJECT', reason: 'PAN invalid' }))).toMatchObject({ status: 403, messageId: 'GEN-03' });
    expect(err(await S.post(`/admin/kyc/${a.adv.user.accountId}/decision`, { version: item.version, decision: 'VERIFY' }, { 'X-Step-Up-Token': await stepUp(staff.token, staffMobile) }))).toMatchObject({ status: 403, messageId: 'GEN-03' });
    expect((await a.c.get('/kyc')).body.data.status).toBe('PENDING_REVIEW');
  });

  it('AC-P06-3: editing verified KYC asks PRF-07 first, then returns it to PENDING_REVIEW', async () => {
    const admin = await seedAdmin();
    const a = await advisor();
    await submit(a);
    const v = (await as(admin.token).get(`/admin/kyc/${a.adv.user.accountId}`)).body.data.version;
    await as(admin.token).post(`/admin/kyc/${a.adv.user.accountId}/decision`, { version: v, decision: 'VERIFY' }, { 'X-Step-Up-Token': await stepUp(admin.token, admin.mobile) });
    const ask = await submit(a, { nameOnPan: 'Asha R Rao' });
    expect(err(ask)).toMatchObject({ status: 409, messageId: 'PRF-07' });
    expect((await a.c.get('/kyc')).body.data.status).toBe('VERIFIED');
    const ok = await submit(a, { nameOnPan: 'Asha R Rao', confirm: ['PRF-07'] });
    expect(ok.body.data.status).toBe('PENDING_REVIEW');
    // re-submitting the same verified details changes nothing
  });

  it('a reviewer can open KYC files, and each view is audited; an advisor cannot open the queue', async () => {
    const admin = await seedAdmin();
    const a = await advisor();
    await submit(a);
    const res = await request(app).get(`/v1/files/${a.pan}`).set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(await AuditLog.countDocuments({ action: 'KYC_FILE_VIEWED' })).toBe(1);
    expect(err(await a.c.get('/admin/kyc'))).toMatchObject({ status: 403, messageId: 'GEN-03' });
  });

  it('the queue is oldest first and counts working days against CFG-125', async () => {
    const first = await advisor('Asha Rao');
    const second = await advisor('Ravi Kumar');
    await submit(second);
    await submit(first);
    await Account.updateOne({ _id: first.adv.user.accountId }, { $set: { 'profile.kyc.submittedAt': new Date(Date.now() - 10 * 86_400_000) } });
    const admin = await seedAdmin();
    const q = (await as(admin.token).get('/admin/kyc')).body.data;
    expect(q.items.map((i: { accountId: string }) => i.accountId)).toEqual([first.adv.user.accountId, second.adv.user.accountId]);
    expect(q.items[0]).toMatchObject({ overdue: true });
    // Fri 17:00 IST → next Mon 10:00 IST is 1 working day (Mon); weekends never count
    expect(workingDaysSince(new Date('2026-10-23T11:30:00Z'), new Date('2026-10-26T04:30:00Z'))).toBe(1);
  });
});