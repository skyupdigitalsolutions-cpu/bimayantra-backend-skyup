/** Stage E2 #48: the KYC review shows typed values beside the values read from the images; the four ticks are kept. */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, as, err, registerAdvisor, resetState, seedAdmin, startTestEnv, stepUp, stopTestEnv } from './helpers.js';
import { Account } from '../src/modules/accounts/account.model.js';
import { AuditLog } from '../src/modules/audit/audit.model.js';
import { parseLicence } from '../src/modules/documents/parsers.js';

let reading: 'ok' | 'other' | 'fail' = 'ok';
vi.mock('../src/modules/documents/reader.js', () => ({
  readerEnabled: () => true,
  readDocument: async () => {
    if (reading === 'fail') throw new Error('Document AI unavailable');
    return { text: '', values: reading === 'ok' ? { pan: 'ABCPE1234F', name: 'Asha Rao' } : { pan: 'ZZZPE9999Z', name: 'Asha R' } };
  },
  ocrText: async () => 'Insurance Regulatory and Development Authority of India\nLicence No: AB-12345\nValid up to 31/12/2027',
  ocrPages: async () => ({ text: '', pages: [] }),
}));

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(() => { reading = 'ok'; return resetState(); });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
const upload = (token: string, purpose: string, bytes: Buffer, name: string) =>
  request(app).post(`/v1/files?purpose=${purpose}`).set('Authorization', `Bearer ${token}`).set('Content-Type', 'application/octet-stream').set('X-File-Name', name).send(bytes);

async function submitted(licenceNumber = 'AB12345', validUntil = '2027-12-31') {
  const adv = await registerAdvisor('Asha Rao');
  const c = as(adv.token);
  await Account.updateOne({ _id: adv.user.accountId }, { $set: { 'profile.professional.licenceNumber': licenceNumber, 'profile.professional.licenceValidUntil': validUntil } });
  const pan = (await upload(adv.token, 'KYC_PAN', PNG, 'pan.png')).body.data.id;
  const licence = (await upload(adv.token, 'KYC_LICENCE', PDF, 'licence.pdf')).body.data.id;
  const k = (await c.get('/kyc')).body.data;
  expect((await c.put('/kyc', { version: k.version, pan: 'ABCPE1234F', nameOnPan: 'Asha Rao', panFileId: pan, licenceFileId: licence, declaration: true })).status).toBe(200);
  // reading runs after the response; wait for it
  for (let i = 0; i < 50; i++) {
    const s = (await Account.findById(adv.user.accountId).lean<{ profile: { kyc: { readStatus: string } } }>())!.profile.kyc.readStatus;
    if (s !== 'PENDING') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  return { adv, accountId: adv.user.accountId! };
}

describe('licence parser', () => {
  it('finds the number and the valid-up-to date in common layouts', () => {
    expect(parseLicence('IRDAI Licence No: AB-12345\nValid up to 31/12/2027')).toEqual({ licenceNumber: 'AB-12345', validUntil: '2027-12-31' });
    expect(parseLicence('POSP Code : POSP/KA/0042 validity till 01-04-2028')).toEqual({ licenceNumber: 'POSP/KA/0042', validUntil: '2028-04-01' });
    expect(parseLicence('nothing useful here')).toEqual({});
  });
});

describe('#48 KYC review comparison', () => {
  it('shows each typed value beside the value read, with the result; the read values are stored encrypted', async () => {
    const { accountId } = await submitted();
    const raw = (await Account.findById(accountId).lean<{ profile: { kyc: { readStatus: string; readValuesEnc: string } } }>())!.profile.kyc;
    expect(raw.readStatus).toBe('DONE');
    expect(raw.readValuesEnc).not.toContain('ABCPE1234F');
    const adm = await seedAdmin();
    const item = (await as(adm.token).get(`/admin/kyc/${accountId}`)).body.data;
    expect(item.comparison).toMatchObject({
      readStatus: 'DONE',
      pan: { typed: 'ABCPE1234F', read: 'ABCPE1234F', result: 'MATCH' },
      nameOnPan: { typed: 'Asha Rao', read: 'Asha Rao', result: 'MATCH' },
      licenceNumber: { typed: 'AB12345', read: 'AB-12345', result: 'MATCH' }, // punctuation ignored
      licenceValidUntil: { typed: '2027-12-31', read: '2027-12-31', result: 'MATCH', expired: false },
    });
    expect(item.checklistItems).toEqual(['panReadable', 'nameMatches', 'licenceValid', 'photoClear']);
  });

  it('a different reading is a MISMATCH; an expired licence is flagged', async () => {
    reading = 'other';
    const { accountId } = await submitted('XY999', '2020-01-31');
    const adm = await seedAdmin();
    const c = (await as(adm.token).get(`/admin/kyc/${accountId}`)).body.data.comparison;
    expect(c.pan.result).toBe('MISMATCH');
    expect(c.nameOnPan.result).toBe('MISMATCH');
    expect(c.licenceNumber.result).toBe('MISMATCH');
    expect(c.licenceValidUntil.expired).toBe(true);
  });

  it('when reading fails the reviewer compares by eye (FAILED, values NOT_READ); the submission is not affected', async () => {
    reading = 'fail';
    const { accountId } = await submitted();
    const adm = await seedAdmin();
    const item = (await as(adm.token).get(`/admin/kyc/${accountId}`)).body.data;
    expect(item.status).toBe('PENDING_REVIEW');
    expect(item.comparison).toMatchObject({ readStatus: 'FAILED', pan: { typed: 'ABCPE1234F', read: null, result: 'NOT_READ' } });
  });

  it('Verify keeps the four ticks with the decision and uses the OTP once', async () => {
    const { accountId } = await submitted();
    const adm = await seedAdmin();
    const A = as(adm.token);
    const item = (await A.get(`/admin/kyc/${accountId}`)).body.data;
    const tok = await stepUp(adm.token, adm.mobile);
    const checklist = { panReadable: true, nameMatches: true, licenceValid: true, photoClear: false };
    const bad = await A.post(`/admin/kyc/${accountId}/decision`, { version: item.version, decision: 'VERIFY', checklist: { panReadable: true } }, { 'X-Step-Up-Token': tok });
    expect(bad.status).toBe(400); // all four ticks or none
    const ok = await A.post(`/admin/kyc/${accountId}/decision`, { version: item.version, decision: 'VERIFY', checklist }, { 'X-Step-Up-Token': tok });
    expect(ok.status).toBe(200);
    expect((await Account.findById(accountId).lean<{ profile: { kyc: { checklist: unknown } } }>())!.profile.kyc.checklist).toEqual(checklist);
    expect((await AuditLog.findOne({ action: 'KYC_VERIFIED' }).lean<{ after: { checklist: unknown }; stepUpId: string | null }>())).toMatchObject({ after: { checklist } });
    // the same OTP cannot verify a second submission
    const second = await submitted();
    const v2 = (await A.get(`/admin/kyc/${second.accountId}`)).body.data.version;
    expect(err(await A.post(`/admin/kyc/${second.accountId}/decision`, { version: v2, decision: 'VERIFY' }, { 'X-Step-Up-Token': tok }))).toMatchObject({ status: 403, messageId: 'AUTH-26' });
  });
});