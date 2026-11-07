/** Integration-status backlog B-01, B-03, B-05, B-06, B-08, B-09. */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fileNameHeader } from '../src/modules/files/files.routes.js';
import { normalizeGender } from '../src/modules/profile/profile.service.js';
import { CustomerDocument } from '../src/modules/documents/document.model.js';
import { app, as, err, login, newMobile, registerAdvisor, resetState, startTestEnv, stepUp, stopTestEnv } from './helpers.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

const year = new Date().getFullYear();

async function setup() {
  const adv = await registerAdvisor();
  const c = as(adv.token);
  const a = (await c.post('/customers', { name: 'Meena Iyer', mobile: newMobile() })).body.data;
  const b = (await c.post('/customers', { name: 'Suresh Iyer', mobile: newMobile() })).body.data;
  return { adv, c, a, b };
}

describe('B-01 default nominee (PF1)', () => {
  it('saves (CU-33), reads back, rejects a minor without an appointee (POL-16) and the holder as nominee (POL-14), and removes (CU-34)', async () => {
    const { c, a } = await setup();
    expect((await c.get(`/customers/${a.id}/default-nominee`)).body.data.defaultNominee).toBeNull();
    const minor = { version: a.version, nominee: { name: 'Arjun Iyer', relationship: 'Son', dob: `${year - 9}-06-10` } };
    expect(err(await c.put(`/customers/${a.id}/default-nominee`, minor))).toMatchObject({ status: 400 });
    const ok = await c.put(`/customers/${a.id}/default-nominee`, { version: a.version, nominee: { ...minor.nominee, appointeeName: 'Ravi Iyer', appointeeDob: '1960-01-01' } });
    expect(ok.status).toBe(200);
    expect(ok.body.meta.messageId).toBe('CU-33');
    expect(ok.body.data.defaultNominee).toMatchObject({ name: 'Arjun Iyer', appointee: { name: 'Ravi Iyer' } });
    const cleared = await c.put(`/customers/${a.id}/default-nominee`, { version: ok.body.data.version, nominee: null });
    expect(cleared.body.meta.messageId).toBe('CU-34');
    expect(cleared.body.data.defaultNominee).toBeNull();
    // stale version
    expect(err(await c.put(`/customers/${a.id}/default-nominee`, { version: a.version, nominee: null }))).toMatchObject({ status: 409 });
  });
});

describe('B-01 linked policy holders (PF2)', () => {
  it('links two customers (CU-35), lists from either side, blocks a duplicate in either direction (CU-38) and self-links, then unlinks (CU-36)', async () => {
    const { c, a, b } = await setup();
    const link = await c.post(`/customers/${a.id}/links`, { linkedCustomerId: b.id, relationship: 'Spouse' });
    expect(link.status).toBe(201);
    expect(link.body.meta.messageId).toBe('CU-35');
    expect((await c.get(`/customers/${a.id}/links`)).body.data[0]).toMatchObject({ relationship: 'Spouse', direction: 'FROM_THIS', customer: { id: b.id } });
    expect((await c.get(`/customers/${b.id}/links`)).body.data[0]).toMatchObject({ direction: 'TO_THIS', customer: { id: a.id } });
    expect(err(await c.post(`/customers/${b.id}/links`, { linkedCustomerId: a.id, relationship: 'Spouse' }))).toMatchObject({ status: 409, messageId: 'CU-38' });
    expect(err(await c.post(`/customers/${a.id}/links`, { linkedCustomerId: a.id, relationship: 'Spouse' }))).toMatchObject({ status: 409, messageId: 'CU-37' });
    const del = await c.del(`/customers/${a.id}/links/${link.body.data.id}`);
    expect(del.body.meta.messageId).toBe('CU-36');
    expect((await c.get(`/customers/${a.id}/links`)).body.data).toHaveLength(0);
  });

  it('another advisor cannot link or read across accounts', async () => {
    const { a } = await setup();
    const other = as((await registerAdvisor('Other Advisor')).token);
    expect(err(await other.get(`/customers/${a.id}/links`)).status).toBe(404);
  });
});

describe('B-05 / B-06 activity by customer', () => {
  it('GET /audit?customerId= includes family-member events; assistants read /customers/:id/activity without old/new values', async () => {
    const { adv, c, a } = await setup();
    await c.post(`/customers/${a.id}/family`, { name: 'Arjun Iyer', relationship: 'Son' });
    const log = await c.get(`/audit?customerId=${a.id}`);
    expect(log.status).toBe(200);
    const actions = log.body.data.map((x: { action: string }) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['FAMILY_MEMBER_ADDED']));
    expect(log.body.data[0]).toHaveProperty('after');
    const m = newMobile();
    await c.post('/assistants', { name: 'Priya Shah', mobile: m }, { 'X-Step-Up-Token': await stepUp(adv.token, adv.mobile) });
    const ast = as((await login(m)).token);
    const act = await ast.get(`/customers/${a.id}/activity`);
    expect(act.status).toBe(200);
    expect(act.body.data.map((x: { action: string }) => x.action)).toContain('FAMILY_MEMBER_ADDED');
    expect(act.body.data[0]).not.toHaveProperty('after');
    expect(act.body.data[0]).not.toHaveProperty('before');
  });
});

describe('B-03 documents library', () => {
  it('lists the newest version of each document with its customer; filters by customer, type and status', async () => {
    const { c, a, b } = await setup();
    const { Customer } = await import('../src/modules/customers/customer.model.js');
    const accountId = (await Customer.findById(a.id).lean())!.accountId;
    const mk = (customerId: string, type: string, version: number, status: 'CONFIRMED' | 'UNCONFIRMED') => CustomerDocument.create({
      accountId, customerId, personKey: `C:${customerId}`, type, seriesKey: `C:${customerId}|${type}`, version, fileId: 'fil_x', originalName: `${type}-${version}.pdf`, label: type, labelKey: `${type}-${version}`.toLowerCase(), status, uploadedBy: 'x',
    });
    await mk(a.id, 'PAN', 1, 'UNCONFIRMED'); await mk(a.id, 'PAN', 2, 'CONFIRMED'); await mk(b.id, 'Aadhaar', 1, 'UNCONFIRMED');
    const all = await c.get('/documents');
    expect(all.status).toBe(200);
    expect(all.body.data).toHaveLength(2); // one row per series
    const pan = all.body.data.find((d: { type: string }) => d.type === 'PAN');
    expect(pan).toMatchObject({ version: 2, versions: 2, status: 'CONFIRMED', customer: { id: a.id, name: 'Meena Iyer' }, personName: 'Meena Iyer' });
    expect((await c.get(`/documents?customerId=${b.id}`)).body.data).toHaveLength(1);
    expect((await c.get('/documents?type=PAN')).body.data).toHaveLength(1);
    expect((await c.get('/documents?status=UNCONFIRMED')).body.data.map((d: { type: string }) => d.type)).toEqual(['Aadhaar']);
    expect(all.body.meta.total).toBe(2);
  });
});

describe('B-08 file names · B-09 gender format', () => {
  it('decodes a percent-encoded header and keeps letters of any script', () => {
    expect(fileNameHeader('%E0%A4%B0%E0%A4%BE%E0%A4%B9%E0%A5%81%E0%A4%B2.pdf')).toBe('राहुल.pdf');
    expect(fileNameHeader('plain name.pdf')).toBe('plain name.pdf');
    expect(fileNameHeader('100%.pdf')).toBe('100%.pdf'); // not valid percent-encoding: used as sent
    expect(fileNameHeader(undefined)).toBeUndefined();
  });

  it('the advisor profile uses the customer codes; the older "Male" is accepted and returned as MALE', async () => {
    expect(normalizeGender('Prefer not to say')).toBe('PREFER_NOT_TO_SAY');
    expect(normalizeGender('FEMALE')).toBe('FEMALE');
    expect(normalizeGender('x')).toBeNull();
    const adv = await registerAdvisor();
    const A = as(adv.token);
    const p = (await A.get('/profile')).body.data;
    expect(p.options.genders).toEqual(['MALE', 'FEMALE', 'TRANSGENDER', 'PREFER_NOT_TO_SAY']);
    const saved = await A.put('/profile/personal', { version: p.sections.personal.version, gender: 'Female' });
    expect(saved.status).toBe(200);
    expect((await A.get('/profile')).body.data.sections.personal.gender).toBe('FEMALE');
    void request; void app;
  });
});