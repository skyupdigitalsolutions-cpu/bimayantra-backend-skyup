/**
 * Module 8 Stage 1 — P-20 Manage insurers. No admin approval (client decision, Q92): publishing is direct with OTP.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, as, err, login, newMobile, registerAdvisor, resetState, seedAdmin, startTestEnv, stepUp, stopTestEnv } from './helpers.js';
import { User } from '../src/modules/users/user.model.js';
import { normalizeMobile } from '../src/lib/phone.js';
import { Insurer } from '../src/modules/insurers/insurer.model.js';
import { AuditLog } from '../src/modules/audit/audit.model.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

const fieldIds = (r: { body: { error?: { fields?: Array<{ field: string; messageId: string }> } } }) => Object.fromEntries((r.body.error?.fields ?? []).map((f) => [f.field, f.messageId]));
const body = (extra: object = {}) => ({ name: 'Alpha General Insurance', shortCode: 'alpha-gen', category: 'General', irdaiRegNo: 'IRDAI-123', paymentDomains: ['alphagen.in'], ...extra });

/** Two SkyUp admins (a maker and a checker) and a staff member, each signed in. */
async function people() {
  const a = await seedAdmin();
  const b = await seedAdmin();
  const sm = newMobile();
  await User.create({ accountId: null, role: 'STF', name: 'Meena Staff', mobile: normalizeMobile(sm), status: 'ACTIVE', activatedAt: new Date() });
  const staff = { mobile: sm, ...(await login(sm)) };
  const decide = async (who: { token: string; mobile: string }, path: string, b2: object) => as(who.token).post(path, b2, { 'X-Step-Up-Token': await stepUp(who.token, who.mobile) });
  return { a, b, staff, decide };
}

describe('P-20 insurers', () => {
  it('save draft (CAT-01); publish (CAT-42) needs the OTP; fields: code uppercased, bare domain only (CAT-10), phone, https web address', async () => {
    const { staff, decide } = await people();
    const S = as(staff.token);
    const d = await S.post('/admin/insurers', body());
    expect(d.status).toBe(201);
    expect(d.body.meta.message).toBe('Alpha General Insurance saved as draft.');
    expect(d.body.data).toMatchObject({ status: 'DRAFT', shortCode: 'ALPHA-GEN' });
    const bad = await S.post('/admin/insurers', body({ name: 'Beta', shortCode: 'B E', paymentDomains: ['https://beta.in/pay'], website: 'beta.in', careNumber: '12345' }));
    expect(fieldIds(bad)).toMatchObject({ shortCode: 'VAL-33', website: 'VAL-28', careNumber: 'VAL-36' });
    expect(JSON.stringify(bad.body)).toContain('Enter a domain such as insurer.com, without https:// or any path.');
    const live = body({ name: 'Beta Life', shortCode: 'BETA', paymentDomains: ['beta.in'], website: 'https://beta.in', careNumber: '1800 123 4567', submit: true });
    expect(err(await S.post('/admin/insurers', live))).toMatchObject({ status: 403, messageId: 'AUTH-26' });
    expect(await Insurer.countDocuments({ name: 'Beta Life' })).toBe(0); // nothing saved without the OTP
    const ok = await decide(staff, '/admin/insurers', live);
    expect(ok.body.meta.message).toBe('Beta Life published.');
    expect(ok.body.data).toMatchObject({ status: 'ACTIVE', careNumber: '18001234567' });
  });

  it('AC-P20-1: a duplicate name (ignoring case) or code is refused (CAT-06, CAT-07)', async () => {
    const { staff } = await people();
    const S = as(staff.token);
    await S.post('/admin/insurers', body());
    expect(fieldIds(await S.post('/admin/insurers', body({ shortCode: 'OTHER' , name: 'ALPHA general insurance' })))).toEqual({ name: 'CAT-06' });
    expect(fieldIds(await S.post('/admin/insurers', body({ name: 'Other' })))).toEqual({ shortCode: 'CAT-07' });
  });

  it('no admin approval: the person who publishes (staff or admin) makes it live at once; the audit log records them with the OTP', async () => {
    const { a, staff, decide } = await people();
    const draft = (await as(staff.token).post('/admin/insurers', body())).body.data;
    expect(err(await as(staff.token).post(`/admin/insurers/${draft.id}/submit`, { version: draft.version }))).toMatchObject({ messageId: 'AUTH-26' });
    const pub = await decide(staff, `/admin/insurers/${draft.id}/submit`, { version: draft.version });
    expect(pub.body.data.status).toBe('ACTIVE');
    const entry = await AuditLog.findOne({ entityId: draft.id, action: 'INSURER_PUBLISHED' }).lean();
    expect(entry).toMatchObject({ actorRole: 'STF' });
    const viaAdmin = await decide(a, '/admin/insurers', body({ name: 'Gamma Health', shortCode: 'GAMMA', submit: true }));
    expect(viaAdmin.body.data.status).toBe('ACTIVE');
  });

  it('items left waiting from before the change can still be cleared: approve (another admin) or reject (CAT-04) back to DRAFT', async () => {
    const { a, b, decide } = await people();
    const raw = async (name: string, code: string) => (await Insurer.create({ ...body({ name, shortCode: code }), nameKey: name.toLowerCase(), status: 'PENDING_APPROVAL', makerId: 'usr_old_maker', submittedAt: new Date() })).toObject();
    const p1 = await raw('Old Pending One', 'OLD-1');
    const ok = await decide(b, `/admin/insurers/${p1._id}/approve`, { version: p1.version });
    expect(ok.body.data.status).toBe('ACTIVE');
    const p2 = await raw('Old Pending Two', 'OLD-2');
    const r = await decide(b, `/admin/insurers/${p2._id}/reject`, { version: p2.version, reason: 'IRDAI number does not match' });
    expect(r.body.meta.message).toBe('Old Pending Two rejected. Reason: IRDAI number does not match');
    expect(r.body.data).toMatchObject({ status: 'DRAFT', rejectReason: 'IRDAI number does not match' });
  });

  it('AC-P20-3 (changed): an edit to an ACTIVE insurer applies at once with the OTP (CAT-43), and advisors see it; the ID never changes', async () => {
    const { a, staff, decide } = await people();
    const d = (await decide(a, '/admin/insurers', body({ submit: true }))).body.data;
    const adv = await registerAdvisor('Asha Rao');
    const seen = async () => ((await as(adv.token).get('/my-insurers/available')).body.data as Array<{ id: string; name: string }>).find((i) => i.id === d.id)?.name;
    expect(await seen()).toBe('Alpha General Insurance');
    expect(err(await as(staff.token).patch(`/admin/insurers/${d.id}`, { version: d.version, name: 'Alpha General Insurance Company' }))).toMatchObject({ messageId: 'AUTH-26' });
    expect(await seen()).toBe('Alpha General Insurance'); // nothing changed without the OTP
    const ch = await request(app).patch(`/v1/admin/insurers/${d.id}`).set('Authorization', `Bearer ${staff.token}`).set('X-Client', 'app').set('X-Step-Up-Token', await stepUp(staff.token, staff.mobile)).send({ version: d.version, name: 'Alpha General Insurance Company' });
    expect(ch.body.meta.message).toBe('Change to Alpha General Insurance Company applied.');
    expect(ch.body.data).toMatchObject({ status: 'ACTIVE', name: 'Alpha General Insurance Company' });
    expect(await seen()).toBe('Alpha General Insurance Company');
    expect((await as(a.token).get('/admin/approvals')).body.data).toEqual([]); // nothing waits any more
    expect((await Insurer.findById(d.id).lean())!._id).toBe(d.id);
  });

  it('AC-P20-4: deactivation asks CAT-09 with the impact, then blocks new mappings; history is kept', async () => {
    const { a, decide } = await people();
    const live = (await decide(a, '/admin/insurers', body({ submit: true }))).body.data;
    const d = live;
    const adv = await registerAdvisor('Asha Rao');
    const map = await as(adv.token).post('/my-insurers', { insurerId: d.id, agentCode: 'AG-1', declaration: true });
    expect(map.status).toBe(201);
    // Change #40: the OTP and a reason are needed; the token is kept while the CAT-09 confirmation is asked
    expect(err(await as(a.token).post(`/admin/insurers/${d.id}/deactivate`, { version: live.version, reason: 'Merged' }))).toMatchObject({ status: 403, messageId: 'AUTH-26' });
    const tok = await stepUp(a.token, a.mobile);
    expect(fieldIds(await as(a.token).post(`/admin/insurers/${d.id}/deactivate`, { version: live.version }, { 'X-Step-Up-Token': tok }))).toEqual({ reason: 'GEN-01' });
    const ask = await as(a.token).post(`/admin/insurers/${d.id}/deactivate`, { version: live.version, reason: 'Merged with another insurer' }, { 'X-Step-Up-Token': tok });
    expect(err(ask)).toMatchObject({ status: 409, messageId: 'CAT-09' });
    expect(ask.body.error.message).toBe('Deactivating Alpha General Insurance hides 0 products from new quotations and affects 1 advisors. Existing quotations and policies do not change. Continue?');
    const off = await as(a.token).post(`/admin/insurers/${d.id}/deactivate`, { version: live.version, reason: 'Merged with another insurer', confirm: ['CAT-09'] }, { 'X-Step-Up-Token': tok });
    expect(off.body.data.status).toBe('INACTIVE');
    expect((await Insurer.findById(d.id).lean())!.deactivatedReason).toBe('Merged with another insurer');
    const on = await as(a.token).post(`/admin/insurers/${d.id}/activate`, { version: off.body.data.version }); // activate needs no OTP
    expect(on.status).toBe(200);
    expect((await Insurer.findById(d.id).lean())!.deactivatedReason).toBeNull();
    await as(a.token).post(`/admin/insurers/${d.id}/deactivate`, { version: on.body.data.version, reason: 'Again', confirm: ['CAT-09'] }, { 'X-Step-Up-Token': await stepUp(a.token, a.mobile) });
    expect((await as(adv.token).get('/my-insurers')).body.data[0].warnings[0].messageId).toBe('PRF-10'); // mapping kept, shown blocked
    const other = await registerAdvisor('Ravi Kumar');
    expect(fieldIds(await as(other.token).post('/my-insurers', { insurerId: d.id, agentCode: 'AG-2', declaration: true }))).toEqual({ insurerId: 'VAL-22' });
  });

  it('advisors and assistants cannot use the catalogue admin', async () => {
    const adv = await registerAdvisor('Asha Rao');
    expect(err(await as(adv.token).get('/admin/insurers'))).toMatchObject({ status: 403, messageId: 'GEN-03' });
    expect(err(await as(adv.token).post('/admin/insurers', body()))).toMatchObject({ status: 403 });
  });
});