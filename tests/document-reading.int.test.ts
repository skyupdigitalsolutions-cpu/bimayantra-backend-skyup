/**
 * P-18 step 5 with GR-26: reading runs in the background AFTER the save. The reader is a stand-in here
 * (Document AI is not reachable from tests); the live check is `npm run ocr:check <file>`.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let behaviour: 'ok' | 'fail' | 'hang' = 'ok';
vi.mock('../src/modules/documents/reader.js', () => ({
  readerEnabled: () => true,
  readDocument: async (type: string) => {
    await new Promise((r) => setTimeout(r, 50));
    if (behaviour === 'fail') throw new Error('Document AI unavailable');
    if (behaviour === 'hang') return new Promise(() => undefined);
    return { text: 'Alpha General Insurance', values: type === 'PAN' ? { pan: 'ABCPE1234F', name: 'Meena Iyer', dob: '15-04-1988' } : { policyNumber: 'P-100' } };
  },
}));

const h = await import('./helpers.js'); // h.app is assigned when the test environment starts: read it through h
const { as, newMobile, registerAdvisor, resetState, startTestEnv, stopTestEnv } = h;
const { Consent, Customer } = await import('../src/modules/customers/customer.model.js');
const { CustomerDocument } = await import('../src/modules/documents/document.model.js');
const { Insurer } = await import('../src/modules/insurers/insurer.model.js');

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(async () => { await resetState(); behaviour = 'ok'; });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function setup() {
  const adv = await registerAdvisor('Asha Rao');
  const c = as(adv.token);
  const cus = (await c.post('/customers', { name: 'Meena Iyer', mobile: newMobile() })).body.data as { id: string };
  await Consent.create({ accountId: adv.user.accountId, personKey: `C:${cus.id}`, customerId: cus.id, channel: 'PERSONAL_DATA', status: 'GIVEN', recordedAt: new Date() });
  const up = async (type: string) => {
    const fileId = (await request(h.app).post('/v1/files?purpose=CUSTOMER_DOCUMENT').set('Authorization', `Bearer ${adv.token}`).set('Content-Type', 'application/octet-stream').send(PNG)).body.data.id;
    return c.post('/documents', { customerId: cus.id, personKey: `C:${cus.id}`, type, fileId });
  };
  const until = async (id: string) => {
    for (let i = 0; i < 40; i++) {
      const d = (await c.get(`/documents/${id}`)).body.data;
      if (d.readStatus !== 'PENDING') return d;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('still reading');
  };
  return { adv, c, cus, up, until };
}

describe('P-18 background reading (GR-26)', () => {
  it('the upload returns at once with reading in progress; the values arrive afterwards with DOC-04', async () => {
    const { up, until } = await setup();
    const r = await up('PAN');
    expect(r.status).toBe(201);
    expect(r.body.data.verify).toEqual({ reading: true, values: {} });
    const d = await until(r.body.data.id);
    expect(d).toMatchObject({ readStatus: 'DONE', messageId: 'DOC-04', readValues: { pan: 'ABCPE1234F', name: 'Meena Iyer', dob: '15-04-1988' } });
  });

  it('AC-P18-4: read values are NOT applied anywhere before Confirm', async () => {
    const { cus, up, until } = await setup();
    const r = await up('PAN');
    await until(r.body.data.id);
    expect((await CustomerDocument.findById(r.body.data.id).lean())!.status).toBe('UNCONFIRMED');
    expect((await Customer.findById(cus.id).select('+identity.panEnc').lean())!.identity?.panEnc ?? null).toBeNull();
  });

  it('a reader failure only means manual entry (DOC-10); the saved document is untouched', async () => {
    behaviour = 'fail';
    const { up, until } = await setup();
    const r = await up('PAN');
    const d = await until(r.body.data.id);
    expect(d).toMatchObject({ readStatus: 'FAILED', messageId: 'DOC-10', status: 'UNCONFIRMED', version: 1 });
  });

  it('a reading stuck past CFG-38 (for example after a restart) counts as failed', async () => {
    behaviour = 'hang';
    const { c, up } = await setup();
    const r = await up('PAN');
    await CustomerDocument.updateOne({ _id: r.body.data.id }, { $set: { readStartedAt: new Date(Date.now() - 6 * 60_000) } });
    expect((await c.get(`/documents/${r.body.data.id}`)).body.data).toMatchObject({ readStatus: 'FAILED', messageId: 'DOC-10' });
  });

  it('old policy: the insurer is found by a catalogue name printed on the policy', async () => {
    const ins = await Insurer.create({ name: 'Alpha General Insurance', nameKey: 'alpha general insurance', shortCode: 'ALPH9', category: 'General', irdaiRegNo: 'R-9', paymentDomains: ['a.com'], status: 'ACTIVE' });
    const { up, until } = await setup();
    const d = await until((await up('Old policy')).body.data.id);
    expect(d.readValues).toEqual({ policyNumber: 'P-100', insurerId: ins._id });
  });

  it('a reading never overwrites a document that was confirmed meanwhile', async () => {
    const { c, up } = await setup();
    const r = await up('PAN');
    await c.post(`/documents/${r.body.data.id}/confirm`, { rev: r.body.data.rev, values: { name: 'Meena Iyer', pan: 'ZYXPW9876K' } });
    await new Promise((res) => setTimeout(res, 150));
    const d = (await c.get(`/documents/${r.body.data.id}`)).body.data;
    expect(d.status).toBe('CONFIRMED');
    expect(d.confirmedValues.pan).toBe('ZYXPW9876K');
  });
});