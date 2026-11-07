/**
 * Module 6 Stage 1 — P-18 Document vault. Test names cite the BPD acceptance checks they cover.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, as, err, login, newMobile, registerAdvisor, resetState, startTestEnv, stepUp, stopTestEnv } from './helpers.js';
import { Consent, Customer } from '../src/modules/customers/customer.model.js';
import { CustomerDocument, DocumentLabel } from '../src/modules/documents/document.model.js';
import { Insurer } from '../src/modules/insurers/insurer.model.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const fieldIds = (res: request.Response) => Object.fromEntries((res.body.error?.fields ?? []).map((f: { field: string; messageId: string }) => [f.field, f.messageId]));

async function setup(opts: { consent?: 'GIVEN' | 'WITHDRAWN' | null } = { consent: 'GIVEN' }) {
  const adv = await registerAdvisor('Asha Rao');
  const c = as(adv.token);
  const cus = (await c.post('/customers', { name: 'Meena Iyer', mobile: newMobile() })).body.data as { id: string; name: string };
  if (opts.consent) {
    await Consent.create({ accountId: adv.user.accountId, personKey: `C:${cus.id}`, customerId: cus.id, channel: 'PERSONAL_DATA', status: opts.consent, recordedAt: new Date() });
  }
  const file = async (token = adv.token, name = 'scan.png') =>
    (await request(app).post('/v1/files?purpose=CUSTOMER_DOCUMENT').set('Authorization', `Bearer ${token}`).set('Content-Type', 'application/octet-stream').set('X-File-Name', name).send(PNG)).body.data.id as string;
  const up = async (type: string, extra: object = {}, token = adv.token) =>
    as(token).post('/documents', { customerId: cus.id, personKey: `C:${cus.id}`, type, fileId: await file(token), ...extra });
  return { adv, c, cus, file, up };
}

describe('P-18 document vault', () => {
  it('AC-P18-1: upload needs customer, person and type (DOC-01), and a name for Other (DOC-02)', async () => {
    const { c, cus, file } = await setup();
    const none = await c.post('/documents', { fileId: await file() });
    expect(err(none)).toMatchObject({ status: 400, messageId: 'DOC-01' });
    expect(none.body.error.message).toBe('Choose the customer, person and document type first.');
    const other = await c.post('/documents', { customerId: cus.id, personKey: `C:${cus.id}`, type: 'Other', fileId: await file() });
    expect(fieldIds(other)).toEqual({ name: 'DOC-02' });
    const named = await c.post('/documents', { customerId: cus.id, personKey: `C:${cus.id}`, type: 'Other', name: 'Rent agreement', fileId: await file() });
    expect(named.status).toBe(201);
    expect(named.body.meta.message).toBe('Rent agreement saved as version 1.');
  });

  it('AC-P18-2: re-uploading a type creates version 2 and keeps version 1 (DOC-03)', async () => {
    const { c, cus, up } = await setup();
    expect((await up('Medical report')).body.meta.message).toBe('Medical report saved as version 1.');
    expect((await up('Medical report')).body.meta.message).toBe('Medical report saved as version 2.');
    const list = (await c.get(`/customers/${cus.id}/documents`)).body.data;
    const group = list.groups.find((g: { type: string }) => g.type === 'Medical report');
    expect(group.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  });

  it('two uploads of the same type at the same moment get versions 1 and 2, never two version 1s', async () => {
    const { cus, adv, file } = await setup();
    const body = async () => ({ customerId: cus.id, personKey: `C:${cus.id}`, type: 'Income proof', fileId: await file() });
    const [a, b] = await Promise.all([as(adv.token).post('/documents', await body()), as(adv.token).post('/documents', await body())]);
    expect([a.body.data.version, b.body.data.version].sort()).toEqual([1, 2]);
  });

  it('AC-P18-3: no role can delete a document, by API (DOC-07); the database refuses it too', async () => {
    const { adv, c, cus, up } = await setup();
    const d = (await up('Photo')).body.data;
    const r = await c.del(`/documents/${d.id}`);
    expect(err(r)).toMatchObject({ status: 409, messageId: 'DOC-07' });
    expect(r.body.error.message).toBe('Documents cannot be deleted. You can change the label or upload a newer version.');
    expect(err(await c.del(`/customers/${cus.id}/documents/${d.id}`))).toMatchObject({ messageId: 'DOC-07' });
    const m = newMobile();
    await c.post('/assistants', { name: 'Priya Shah', mobile: m }, { 'X-Step-Up-Token': await stepUp(adv.token, adv.mobile) });
    expect(err(await as((await login(m)).token).del(`/documents/${d.id}`))).toMatchObject({ messageId: 'DOC-07' });
    await expect(CustomerDocument.deleteOne({ _id: d.id })).rejects.toThrow(/cannot be deleted/);
    expect(await CustomerDocument.countDocuments({ _id: d.id })).toBe(1);
  });

  it('AC-P18-4: nothing read from Aadhaar/PAN is saved before Confirm; the verify screen opens for manual entry (DOC-10)', async () => {
    const { c, cus, up } = await setup();
    const res = await up('PAN');
    expect(res.body.data).toMatchObject({ status: 'UNCONFIRMED', verify: { messageId: 'DOC-10', message: 'We could not read this document. Type the details yourself, then select Confirm.' } });
    const cust = await Customer.findById(cus.id).select('+identity.panEnc').lean();
    expect(cust!.identity?.panEnc ?? null).toBeNull(); // not copied before Confirm
    expect((await c.get(`/customers/${cus.id}/documents`)).body.data.missing.message).toBe('Missing for Meena Iyer: Aadhaar, PAN (waiting to be checked).');
  });

  it('Confirm validates each field, copies PAN to an empty customer field, and a double click gets GEN-06', async () => {
    const { c, cus, up } = await setup();
    const d = (await up('PAN')).body.data;
    const bad = await c.post(`/documents/${d.id}/confirm`, { rev: d.rev, values: { name: 'Meena Iyer', pan: 'ABCDE1234F' } });
    expect(fieldIds(bad)).toEqual({ pan: 'VAL-16' });
    const [x, y] = await Promise.all([
      c.post(`/documents/${d.id}/confirm`, { rev: d.rev, values: { name: 'Meena Iyer', pan: 'ABCPE1234F' } }),
      c.post(`/documents/${d.id}/confirm`, { rev: d.rev, values: { name: 'Meena Iyer', pan: 'ABCPE1234F' } }),
    ]);
    const ok = x.status === 200 ? x : y;
    const second = x.status === 200 ? y : x;
    expect(ok.body.data).toMatchObject({ document: { status: 'CONFIRMED' }, identity: { field: 'PAN', copied: true } });
    expect(err(second)).toMatchObject({ status: 409, messageId: 'GEN-06' });
    expect((await Customer.findById(cus.id).lean())!.identity?.panMasked).toBe('ABCXX1234F');
    expect((await c.get(`/customers/${cus.id}/documents`)).body.data.missing.message).toBe('Missing for Meena Iyer: Aadhaar.');
  });

  it('a different PAN than the customer already has is NOT overwritten; the reply reports it', async () => {
    const { c, up } = await setup();
    const d1 = (await up('PAN')).body.data;
    await c.post(`/documents/${d1.id}/confirm`, { rev: d1.rev, values: { name: 'Meena Iyer', pan: 'ABCPE1234F' } });
    const d2 = (await up('PAN')).body.data;
    const r = await c.post(`/documents/${d2.id}/confirm`, { rev: d2.rev, values: { name: 'Meena Iyer', pan: 'ZYXPW9876K' } });
    expect(r.body.data.identity).toMatchObject({ copied: false, differs: true, current: 'ABCXX1234F', fromDocument: 'ZYXXX9876K' });
  });

  it('identity documents and old policies need personal-data consent (CU-23 / CU-30)', async () => {
    const none = await setup({ consent: null });
    expect(err(await none.up('Aadhaar'))).toMatchObject({ status: 409, messageId: 'CU-23' });
    expect((await none.up('Medical report')).status).toBe(201); // other types do not
    const withdrawn = await setup({ consent: 'WITHDRAWN' });
    expect(err(await withdrawn.up('Old policy'))).toMatchObject({ status: 409, messageId: 'CU-30' });
  });

  it('old policy: confirmed values come back as a prefill for "Record as existing policy" (P-34)', async () => {
    const { c, up } = await setup();
    const ins = await Insurer.create({ name: 'Alpha General', nameKey: 'alpha general', shortCode: 'ALPH1', category: 'General', irdaiRegNo: 'R-1', paymentDomains: ['a.com'], status: 'ACTIVE' });
    const d = (await up('Old policy')).body.data;
    const r = await c.post(`/documents/${d.id}/confirm`, { rev: d.rev, values: { insurerId: ins._id, policyNumber: 'pol/123-45', premium: '12,500.00', sumInsured: 500000 } });
    expect(r.body.data.existingPolicyPrefill).toMatchObject({ policyNumber: 'POL/123-45', premium: 12500, sumInsured: 500000 });
    expect(fieldIds(await c.post(`/documents/${(await up('Old policy')).body.data.id}/confirm`, { rev: 1, values: { insurerId: ins._id, policyNumber: 'P1', premium: '0' } }))).toMatchObject({ policyNumber: 'VAL-20', premium: 'VAL-10' });
  });

  it('AC-P18-5: a label change keeps the original upload name; empty or duplicate labels are refused', async () => {
    const { c, up } = await setup();
    const a = (await up('Photo')).body.data;
    const b = (await up('Address proof')).body.data;
    const ch = await c.patch(`/documents/${a.id}/label`, { rev: a.rev, label: 'Passport photo 2026' });
    expect(ch.body.meta.message).toBe('Label changed. The original upload name is kept in the history.');
    const doc = (await c.get(`/documents/${a.id}`)).body.data;
    expect(doc.history.map((h: { event: string; name?: string; to?: string }) => h.name ?? h.to)).toEqual(['scan.png', 'Passport photo 2026']);
    expect(doc.originalName).toBe('scan.png');
    expect(fieldIds(await c.patch(`/documents/${b.id}/label`, { rev: b.rev, label: ' ' }))).toEqual({ label: 'GEN-01' }); // empty: required
    expect(fieldIds(await c.patch(`/documents/${b.id}/label`, { rev: b.rev, label: 'x' }))).toEqual({ label: 'VAL-42' }); // under CFG-172
    expect(fieldIds(await c.patch(`/documents/${b.id}/label`, { rev: b.rev, label: 'passport PHOTO 2026' }))).toEqual({ label: 'DOC-06' });
    expect(await DocumentLabel.countDocuments({ documentId: a.id })).toBe(1);
  });

  it('an assistant uploads and views, but cannot change labels (P-18 Who)', async () => {
    const { adv, c, cus, file } = await setup();
    const m = newMobile();
    await c.post('/assistants', { name: 'Priya Shah', mobile: m }, { 'X-Step-Up-Token': await stepUp(adv.token, adv.mobile) });
    const ast = await login(m);
    const d = await as(ast.token).post('/documents', { customerId: cus.id, personKey: `C:${cus.id}`, type: 'Photo', fileId: await file(ast.token) });
    expect(d.status).toBe(201);
    expect((await as(ast.token).get(`/customers/${cus.id}/documents`)).status).toBe(200);
    expect(err(await as(ast.token).patch(`/documents/${d.body.data.id}/label`, { rev: 1, label: 'New label' }))).toMatchObject({ status: 403, messageId: 'GEN-03' });
  });

  it('AC-P18-7: another account cannot list, open or confirm the documents, nor open the file by its link', async () => {
    const { cus, up } = await setup();
    const d = (await up('PAN')).body.data;
    const other = await registerAdvisor('Ravi Kumar');
    const O = as(other.token);
    expect(err(await O.get(`/customers/${cus.id}/documents`))).toMatchObject({ status: 404, messageId: 'GEN-11' });
    expect(err(await O.get(`/documents/${d.id}`))).toMatchObject({ status: 404 });
    expect(err(await O.post(`/documents/${d.id}/confirm`, { rev: 1, values: { name: 'X Y', pan: 'ABCPE1234F' } }))).toMatchObject({ status: 404 });
    expect((await request(app).get(`/v1/files/${d.file.id}`).set('Authorization', `Bearer ${other.token}`)).status).toBe(404);
  });

  it('documents can be added for a household member, never for someone else\u2019s member; vehicle types are refused here', async () => {
    const { c, cus, file, up } = await setup();
    const fam = (await c.post(`/customers/${cus.id}/family`, { name: 'Arjun Iyer', relationship: 'Son' })).body.data;
    expect((await c.post('/documents', { customerId: cus.id, personKey: `F:${fam.id}`, type: 'Photo', fileId: await file() })).status).toBe(201);
    const stranger = await setup();
    const theirFam = (await stranger.c.post(`/customers/${stranger.cus.id}/family`, { name: 'Ravi Kumar', relationship: 'Son' })).body.data;
    expect(fieldIds(await c.post('/documents', { customerId: cus.id, personKey: `F:${theirFam.id}`, type: 'Photo', fileId: await file() }))).toEqual({ personKey: 'VAL-22' });
    expect(fieldIds(await up('Vehicle RC'))).toEqual({ type: 'VAL-22' });
  });
});