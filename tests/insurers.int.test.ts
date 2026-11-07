/**
 * Module 5 Stage 3 — P-07 Add insurers and agent codes. Test names cite the BPD acceptance checks.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, as, err, login, newMobile, registerAdvisor, resetState, seedAdmin, startTestEnv, stepUp, stopTestEnv } from './helpers.js';
import { AuditLog } from '../src/modules/audit/audit.model.js';
import { Insurer } from '../src/modules/insurers/insurer.model.js';
import { InsurerMapping } from '../src/modules/insurers/mapping.model.js';
import { quoteReadiness } from '../src/modules/insurers/myInsurers.service.js';
import { istToday } from '../src/lib/clock.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

let n = 0;
async function insurer(name = `Test Insurer ${++n}`, status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE') {
  const doc = await Insurer.create({ name, nameKey: name.toLowerCase(), shortCode: `T${Date.now().toString(36)}${n}`.toUpperCase(), category: 'General', irdaiRegNo: `REG-${n}`, paymentDomains: ['example.com'], status });
  return doc._id as string;
}
const dmy = (days: number) => { const d = new Date(`${istToday()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`; };
const fieldIds = (res: request.Response) => Object.fromEntries((res.body.error?.fields ?? []).map((f: { field: string; messageId: string }) => [f.field, f.messageId]));

async function setup() {
  const adv = await registerAdvisor('Asha Rao');
  const c = as(adv.token);
  const add = (insurerId: string, extra: object = {}) => c.post('/my-insurers', { insurerId, agentCode: 'AG-1001', declaration: true, ...extra });
  return { adv, c, add };
}

describe('P-07 insurers and agent codes', () => {
  it('AC-P07-1: an advisor can add many insurers, each with its own code (PRF-08)', async () => {
    const { c, add } = await setup();
    const a = await insurer('Alpha General');
    const b = await insurer('Beta Life');
    const r1 = await add(a, { agentCode: 'ag/1001' });
    expect(r1.status).toBe(201);
    expect(r1.body.meta.message).toBe('Alpha General added with agent code AG/1001.');
    expect((await add(b, { agentCode: 'BL-77' })).status).toBe(201);
    const list = (await c.get('/my-insurers')).body.data;
    expect(list.map((m: { insurer: { name: string }; agentCode: string; status: string }) => `${m.insurer.name}:${m.agentCode}:${m.status}`)).toEqual(['Alpha General:AG/1001:ACTIVE', 'Beta Life:BL-77:ACTIVE']);
    // the picker no longer offers added insurers
    const avail = (await c.get('/my-insurers/available')).body.data.map((i: { id: string }) => i.id);
    expect(avail).not.toContain(a);
    expect(avail).not.toContain(b);
  });

  it('AC-P07-2: the same insurer cannot be added twice (PRF-09), even from two tabs at once', async () => {
    const { add } = await setup();
    const a = await insurer('Alpha General');
    const [x, y] = await Promise.all([add(a), add(a, { agentCode: 'AG-2002' })]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    const second = x.status === 409 ? x : y;
    expect(err(second)).toMatchObject({ messageId: 'PRF-09' });
    expect(second.body.error.message).toBe('You have already added Alpha General. Edit the existing entry instead.');
    expect(await InsurerMapping.countDocuments({ insurerId: a })).toBe(1);
  });

  it('AC-P07-3: an INACTIVE catalogue insurer cannot be added (VAL-22) and is not offered', async () => {
    const { c, add } = await setup();
    const off = await insurer('Gamma Health', 'INACTIVE');
    expect(fieldIds(await add(off))).toMatchObject({ insurerId: 'VAL-22' });
    expect((await c.get('/my-insurers/available')).body.data.map((i: { id: string }) => i.id)).not.toContain(off);
  });

  it('validation: agent code (VAL-18), past validity (VAL-07), declaration (VAL-29), insurer required (GEN-01)', async () => {
    const { c } = await setup();
    const res = await c.post('/my-insurers', { agentCode: 'a', validUntil: dmy(-1), declaration: false });
    expect(fieldIds(res)).toEqual({ insurerId: 'GEN-01', agentCode: 'VAL-18', validUntil: 'VAL-07', declaration: 'VAL-29' });
  });

  it('P-07 step 4: editing changes the code or validity, is audited, and a stale edit gets GEN-05', async () => {
    const { c, add } = await setup();
    const m = (await add(await insurer())).body.data;
    const e = await c.patch(`/my-insurers/${m.id}`, { version: m.version, agentCode: 'NEW-9', validUntil: dmy(100) });
    expect(e.body.data).toMatchObject({ agentCode: 'NEW-9' });
    const audit = await AuditLog.findOne({ action: 'INSURER_MAPPING_EDITED' }).lean();
    expect(audit).toMatchObject({ before: { agentCode: 'AG-1001' }, after: { agentCode: 'NEW-9' } });
    expect(err(await c.patch(`/my-insurers/${m.id}`, { version: m.version, agentCode: 'OLD-1' }))).toMatchObject({ status: 409, messageId: 'GEN-05' });
  });

  it('AC-P07-4: deactivating asks PRF-12 first, then blocks new quotations; Activate reverses it', async () => {
    const { adv, c, add } = await setup();
    const a = await insurer('Alpha General');
    const m = (await add(a)).body.data;
    const ask = await c.post(`/my-insurers/${m.id}/deactivate`, { version: m.version });
    expect(err(ask)).toMatchObject({ status: 409, messageId: 'PRF-12' });
    expect(ask.body.error.message).toBe('You will not be able to create new quotations for Alpha General. Existing quotations and policies are not affected. Continue?');
    const off = await c.post(`/my-insurers/${m.id}/deactivate`, { version: m.version, confirm: ['PRF-12'] });
    expect(off.body.data.status).toBe('INACTIVE');
    expect(await quoteReadiness(adv.user.accountId!, a)).toMatchObject({ ok: false, reason: 'MAPPING_INACTIVE' });
    const on = await c.post(`/my-insurers/${m.id}/activate`, { version: off.body.data.version });
    expect(on.body.data.status).toBe('ACTIVE');
    expect(await quoteReadiness(adv.user.accountId!, a)).toMatchObject({ ok: true, agentCode: 'AG-1001' });
  });

  it('AC-P07-5: an expired code date blocks new quotations with PRF-11, and the list shows it', async () => {
    const { adv, c, add } = await setup();
    const a = await insurer('Alpha General');
    const m = (await add(a)).body.data;
    await InsurerMapping.updateOne({ _id: m.id }, { $set: { validUntil: '2020-01-31' } }); // time has passed
    const r = await quoteReadiness(adv.user.accountId!, a);
    expect(r).toMatchObject({ ok: false, reason: 'CODE_EXPIRED', messageId: 'PRF-11', message: 'Your agent code for Alpha General expired on 31-01-2020. Update it to create new quotations.' });
    expect((await c.get('/my-insurers')).body.data[0].warnings.map((w: { messageId: string }) => w.messageId)).toEqual(['PRF-11']);
  });

  it('PRF-10: when SkyUp makes an insurer INACTIVE, the mapping shows PRF-10, quotations are blocked and it cannot be re-activated', async () => {
    const { adv, c, add } = await setup();
    const a = await insurer('Alpha General');
    const m = (await add(a)).body.data;
    const off = await c.post(`/my-insurers/${m.id}/deactivate`, { version: m.version, confirm: ['PRF-12'] });
    await Insurer.updateOne({ _id: a }, { $set: { status: 'INACTIVE' } });
    expect((await c.get('/my-insurers')).body.data[0].warnings[0].message).toBe('Alpha General is no longer available in Bimayantra. You cannot create new quotations for it.');
    expect(await quoteReadiness(adv.user.accountId!, a)).toMatchObject({ ok: false, messageId: 'PRF-10' });
    expect(err(await c.post(`/my-insurers/${m.id}/activate`, { version: off.body.data.version }))).toMatchObject({ status: 409, messageId: 'PRF-10' });
  });

  it('P-05: an ACTIVE insurer adds the Insurers 15%, and a full profile reaches 100%', async () => {
    const { adv, c, add } = await setup();
    let p = (await c.get('/profile')).body.data;
    expect(p.completion.missing.map((g: { section: string }) => g.section)).toContain('Insurers');
    const m = (await add(await insurer())).body.data;
    p = (await c.get('/profile')).body.data;
    expect(p.completion.percent).toBe(15);
    // deactivating the only insurer takes the 15% away again
    await c.post(`/my-insurers/${m.id}/deactivate`, { version: m.version, confirm: ['PRF-12'] });
    expect((await c.get('/profile')).body.data.completion.percent).toBe(0);
    // everything filled → 100%
    await c.post(`/my-insurers/${m.id}/activate`, { version: m.version + 1 });
    p = (await c.get('/profile')).body.data;
    await c.put('/profile/personal', { version: p.sections.personal.version, dob: '15-04-1988' });
    await c.put('/profile/contact', { version: p.sections.contact.version, email: 'asha@example.com', address1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' });
    await c.put('/profile/professional', { version: p.sections.professional.version, advisorType: 'POSP', licenceNumber: 'POSP-1', licenceValidUntil: dmy(400), categories: ['Health'] });
    await c.put('/profile/business', { version: p.sections.business.version });
    const up = (purpose: string, body: Buffer) => request(app).post(`/v1/files?purpose=${purpose}`).set('Authorization', `Bearer ${adv.token}`).set('Content-Type', 'application/octet-stream').send(body);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const pdf = Buffer.from('%PDF-1.4\ntrailer << >>\n%%EOF\n');
    const k = (await c.get('/kyc')).body.data;
    await c.put('/kyc', { version: k.version, pan: 'ABCPE1234F', nameOnPan: 'Asha Rao', panFileId: (await up('KYC_PAN', png)).body.data.id, licenceFileId: (await up('KYC_LICENCE', pdf)).body.data.id, declaration: true });
    expect((await c.get('/profile')).body.data.completion.percent).toBe(100);
  });

  it('DEC-09: the same insurer and code in two accounts flags both for STF, without telling either advisor', async () => {
    const a = await insurer('Alpha General');
    const one = await setup();
    const two = await setup();
    const r1 = await one.add(a, { agentCode: 'SHARED-1' });
    const r2 = await two.add(a, { agentCode: 'shared-1' });
    expect(r2.status).toBe(201);
    expect(JSON.stringify([r1.body, r2.body, (await two.c.get('/my-insurers')).body])).not.toMatch(/flag/i); // silent
    const admin = await seedAdmin();
    const flags = (await as(admin.token).get('/admin/agent-code-flags')).body.data;
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ insurer: 'Alpha General', agentCode: 'SHARED-1' });
    expect(flags[0].accounts.map((x: { accountId: string }) => x.accountId).sort()).toEqual([one.adv.user.accountId, two.adv.user.accountId].sort());
    expect(err(await one.c.get('/admin/agent-code-flags'))).toMatchObject({ status: 403 });
  });

  it('GR-20: another advisor cannot see, edit or deactivate a mapping; an assistant cannot manage insurers', async () => {
    const { c, add, adv } = await setup();
    const m = (await add(await insurer())).body.data;
    const other = as((await registerAdvisor('Ravi Kumar')).token);
    expect((await other.get('/my-insurers')).body.data).toEqual([]);
    expect(err(await other.patch(`/my-insurers/${m.id}`, { version: m.version, agentCode: 'X-1' }))).toMatchObject({ status: 404, messageId: 'GEN-11' });
    expect(err(await other.post(`/my-insurers/${m.id}/deactivate`, { version: m.version, confirm: ['PRF-12'] }))).toMatchObject({ status: 404 });
    expect((await c.get('/my-insurers')).body.data[0]).toMatchObject({ agentCode: 'AG-1001', status: 'ACTIVE' });
    const mob = newMobile();
    await c.post('/assistants', { name: 'Priya Shah', mobile: mob }, { 'X-Step-Up-Token': await stepUp(adv.token, adv.mobile) });
    expect(err(await as((await login(mob)).token).get('/my-insurers'))).toMatchObject({ status: 403, messageId: 'GEN-03' });
  });

  it('the appointment letter must be the advisor\u2019s own appointment-letter file', async () => {
    const { adv, add } = await setup();
    const pdf = Buffer.from('%PDF-1.4\ntrailer << >>\n%%EOF\n');
    const otherAdv = await registerAdvisor('Ravi Kumar');
    const theirs = (await request(app).post('/v1/files?purpose=APPOINTMENT_LETTER').set('Authorization', `Bearer ${otherAdv.token}`).set('Content-Type', 'application/octet-stream').send(pdf)).body.data.id;
    expect(fieldIds(await add(await insurer(), { appointmentLetterFileId: theirs }))).toMatchObject({ appointmentLetterFileId: 'VAL-22' });
    const mine = (await request(app).post('/v1/files?purpose=APPOINTMENT_LETTER').set('Authorization', `Bearer ${adv.token}`).set('Content-Type', 'application/octet-stream').send(pdf)).body.data.id;
    expect((await add(await insurer(), { appointmentLetterFileId: mine })).body.data.appointmentLetter).toMatchObject({ type: 'PDF' });
  });
});