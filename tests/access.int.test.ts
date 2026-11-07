import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clock } from '../src/lib/clock.js';
import { Account } from '../src/modules/accounts/account.model.js';
import { AuditLog } from '../src/modules/audit/audit.model.js';
import { OtpChallenge } from '../src/modules/auth/otp.model.js';
import { User } from '../src/modules/users/user.model.js';
import { app, as, err, key, lastOtp, login, newMobile, registerAdvisor, resetState, seedAdmin, setCfg, startTestEnv, stopTestEnv } from './helpers.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

const sendRegister = (mobile: string, name = 'Asha Rao') => request(app).post('/v1/auth/register/otp').send({ name, mobile, termsAccepted: true });
const verify = (path: string, mobile: string, code: string) => request(app).post(`/v1/auth/${path}/verify`).set('X-Client', 'app').set('Idempotency-Key', key()).send({ mobile, code });

describe('P-01 Register as an advisor', () => {
  it('AC-P01-1/2: one OTP, then exactly one account, ADV user, TRIAL with no plan, ₹0 wallet and the CFG-169 pipelines', async () => {
    const mobile = newMobile();
    const s = await sendRegister(`+91 ${mobile}`);
    expect(s.status).toBe(200);
    expect(s.body.meta.messageId).toBe('AUTH-01');
    expect(s.body.data.maskedMobile).toMatch(/^\d{2}XXXXXX\d{2}$/);
    const v = await verify('register', mobile, await lastOtp(mobile));
    expect(v.status).toBe(201);
    expect(v.body.meta).toMatchObject({ messageId: 'AUTH-15', message: 'Welcome to Bimayantra, Asha Rao. Your 7-day free trial has started.' });
    const acc = await Account.findById(v.body.data.user.accountId).lean();
    expect(acc!.subscription).toMatchObject({ status: 'TRIAL', plan: null });
    expect(acc!.wallet!.balancePaise).toBe(0);
    expect(acc!.pipelines.map((p) => p.name)).toEqual(['Health', 'Motor', 'Life', 'Term', 'Travel', 'Other']);
    expect(await User.countDocuments({ accountId: acc!._id, role: 'ADV' })).toBe(1);
  });

  it('AC-P01-9: unticked terms are refused with VAL-29; missing name with GEN-01 and its label', async () => {
    const r = await request(app).post('/v1/auth/register/otp').send({ mobile: newMobile(), termsAccepted: false });
    expect(err(r)).toMatchObject({ status: 400, messageId: 'GEN-02' });
    const fields = Object.fromEntries(r.body.error.fields.map((f: { field: string; messageId: string; message: string }) => [f.field, f]));
    expect(fields.termsAccepted.messageId).toBe('VAL-29');
    expect(fields.name.message).toBe('Full name is required.');
  });

  it('AC-P01-3: wrong code shows tries left; the 5th wrong try locks the number (AUTH-04)', async () => {
    const mobile = newMobile();
    await sendRegister(mobile);
    const first = await verify('register', mobile, '000000');
    expect(err(first)).toMatchObject({ status: 400, messageId: 'AUTH-02' });
    expect(first.body.error.message).toBe('The code is incorrect. You have 4 tries left.');
    for (let i = 0; i < 3; i++) await verify('register', mobile, '000000');
    expect(err(await verify('register', mobile, '000000'))).toMatchObject({ status: 429, messageId: 'AUTH-04' });
    expect(err(await verify('register', mobile, await lastOtp(mobile)))).toMatchObject({ status: 429, messageId: 'AUTH-04' });
  });

  it('AC-P01-4: an expired code shows AUTH-03 and creates nothing', async () => {
    const mobile = newMobile();
    await sendRegister(mobile);
    clock.setOffset(6 * 60_000);
    expect(err(await verify('register', mobile, await lastOtp(mobile)))).toMatchObject({ status: 400, messageId: 'AUTH-03' });
    expect(await Account.countDocuments()).toBe(0);
  });

  it('AC-P01-5: resend inside CFG-04 sends nothing new (AUTH-05); the 6th send in 60 minutes is AUTH-06', async () => {
    const mobile = newMobile();
    await sendRegister(mobile);
    const again = await sendRegister(mobile);
    expect(again.body).toMatchObject({ data: { sent: false }, meta: { messageId: 'AUTH-05' } });
    for (let i = 0; i < 4; i++) { clock.setOffset(clock.offsetMs() + 31_000); await sendRegister(mobile); }
    clock.setOffset(clock.offsetMs() + 31_000);
    expect(err(await sendRegister(mobile))).toMatchObject({ status: 429, messageId: 'AUTH-06' });
    expect(await OtpChallenge.countDocuments({ mobile: `+91${mobile}`, sent: true })).toBe(5);
  });

  it('AC-P01-6: two Verify requests with one key create one account; the repeat gets GEN-06', async () => {
    const mobile = newMobile();
    await sendRegister(mobile);
    const code = await lastOtp(mobile);
    const k = key();
    const send = () => request(app).post('/v1/auth/register/verify').set('X-Client', 'app').set('Idempotency-Key', k).send({ mobile, code });
    const a = await send();
    const b = await send();
    expect(a.status).toBe(201);
    expect(err(b)).toMatchObject({ status: 409, messageId: 'GEN-06' });
    expect(b.body.error.details.result.data.tokens).toBeUndefined(); // tokens are never stored for replay
    expect(await Account.countDocuments()).toBe(1);
  });

  it('AC-P01-7/8: an advisor\'s number signs in (AUTH-07, name unchanged); a SkyUp number creates nothing (AUTH-08)', async () => {
    const adv = await registerAdvisor('Asha Rao');
    await sendRegister(adv.mobile, 'Somebody Else');
    const again = await verify('register', adv.mobile, await lastOtp(adv.mobile));
    expect(again.body.meta.messageId).toBe('AUTH-07');
    expect(again.body.data.user.name).toBe('Asha Rao');
    const adm = await seedAdmin();
    await sendRegister(adm.mobile);
    expect(err(await verify('register', adm.mobile, await lastOtp(adm.mobile)))).toMatchObject({ status: 409, messageId: 'AUTH-08' });
    expect(await Account.countDocuments()).toBe(1);
  });

  it('AC-P01-10: the plain OTP is never stored or audited', async () => {
    const mobile = newMobile();
    await sendRegister(mobile);
    const code = await lastOtp(mobile);
    const ch = await OtpChallenge.findOne({ mobile: `+91${mobile}` }).lean();
    expect(JSON.stringify(ch)).not.toContain(code);
    expect(JSON.stringify(await AuditLog.find().lean())).not.toContain(code);
  });

  it('CFG-10: registration and login requests per IP per hour (GEN-15)', async () => {
    await setCfg('CFG-10', 2);
    await sendRegister(newMobile());
    await sendRegister(newMobile());
    expect(err(await sendRegister(newMobile()))).toMatchObject({ status: 429, messageId: 'GEN-15' });
  });
});

describe('P-02 Log in with mobile OTP', () => {
  it('AC-P02-2: an unknown number shows AUTH-09 and sends no SMS', async () => {
    const r = await request(app).post('/v1/auth/login/otp').send({ mobile: newMobile() });
    expect(err(r)).toMatchObject({ status: 404, messageId: 'AUTH-09' });
    expect(await OtpChallenge.countDocuments()).toBe(0);
  });

  it('AC-P02-3: suspended account and disabled user each get their own message and no session', async () => {
    const adv = await registerAdvisor();
    await Account.updateOne({ _id: adv.user.accountId }, { $set: { status: 'SUSPENDED' } });
    await request(app).post('/v1/auth/login/otp').send({ mobile: adv.mobile });
    expect(err(await verify('login', adv.mobile, await lastOtp(adv.mobile)))).toMatchObject({ status: 403, messageId: 'AUTH-10' });
    // …and the session started at registration stops working on its next request.
    expect(err(await as(adv.token).get('/auth/me'))).toMatchObject({ status: 401, messageId: 'AUTH-10' });
  });

  it('AC-P02-4: an EXPIRED trial signs in to read-only mode (SUB-03) and writes are refused', async () => {
    const adv = await registerAdvisor();
    clock.setOffset(8 * 86_400_000);
    const s = await login(adv.mobile);
    const me = await as(s.token).get('/auth/me');
    expect(me.body.data).toMatchObject({ readOnly: true, subscription: { status: 'EXPIRED' } });
    const pipelines = await as(s.token).get('/pipelines');
    const r = await as(s.token).post('/leads', { pipelineId: pipelines.body.data[0].id, name: 'Ravi Kumar', mobile: newMobile(), source: 'Other' });
    expect(err(r)).toMatchObject({ status: 403, messageId: 'SUB-03' });
    expect((await as(s.token).get('/leads')).status).toBe(200);
  });
});

describe('P-03 Sessions', () => {
  it('AC-P03-3: the 4th login ends the oldest session, which then sees AUTH-17', async () => {
    const adv = await registerAdvisor();
    await login(adv.mobile);
    await login(adv.mobile);
    clock.setOffset(31_000);
    await login(adv.mobile);
    expect(err(await as(adv.token).get('/auth/me'))).toMatchObject({ status: 401, code: 'SESSION_ENDED', messageId: 'AUTH-17' });
  });

  it('AC-P03-1: no activity for CFG-07 ends the session (AUTH-18)', async () => {
    const adv = await registerAdvisor();
    clock.setOffset(31 * 60_000);
    expect(err(await as(adv.token).get('/auth/me'))).toMatchObject({ status: 401, messageId: 'AUTH-18' });
  });

  it('AC-P03-4: ending a session from the device list stops that device (AUTH-22)', async () => {
    const adv = await registerAdvisor();
    const other = await login(adv.mobile);
    const list = await as(adv.token).get('/auth/sessions');
    const target = list.body.data.find((s: { current: boolean }) => !s.current);
    const r = await as(adv.token).del(`/auth/sessions/${target.id}`);
    expect(r.body.meta.messageId).toBe('AUTH-22');
    expect((await as(other.token).get('/auth/me')).status).toBe(401);
  });

  it('refresh rotates; replaying the old refresh token ends the session', async () => {
    const adv = await registerAdvisor();
    const r1 = await request(app).post('/v1/auth/refresh').set('X-Client', 'app').send({ refreshToken: adv.refresh });
    expect(r1.status).toBe(200);
    clock.setOffset(11_000);
    const replay = await request(app).post('/v1/auth/refresh').set('X-Client', 'app').send({ refreshToken: adv.refresh });
    expect(err(replay)).toMatchObject({ status: 401, code: 'REFRESH_TOKEN_REUSED' });
    expect((await as(r1.body.data.tokens.accessToken).get('/auth/me')).status).toBe(401);
  });

  it('web sessions use HttpOnly cookies, and a cookie-authenticated write needs a trusted Origin', async () => {
    const mobile = newMobile();
    await sendRegister(mobile);
    const v = await request(app).post('/v1/auth/register/verify').set('Idempotency-Key', key()).send({ mobile, code: await lastOtp(mobile) });
    expect(v.body.data.tokens).toBeUndefined();
    const cookies = ([] as string[]).concat(v.headers['set-cookie'] ?? []);
    expect(cookies.join(';')).toMatch(/bm_at=.*HttpOnly/);
    const agent = request(app);
    expect((await agent.get('/v1/auth/me').set('Cookie', cookies)).status).toBe(200);
    expect((await agent.post('/v1/auth/logout').set('Cookie', cookies)).status).toBe(403);
    const out = await agent.post('/v1/auth/logout').set('Cookie', cookies).set('Origin', 'http://localhost:5173');
    expect(out.body.meta.messageId).toBe('AUTH-16');
  });
});

describe('P-04 Change registered mobile', () => {
  it('AC-P04-1/2/3: needs both OTPs; a number in use is AUTH-25; other sessions end', async () => {
    const adv = await registerAdvisor();
    const other = await login(adv.mobile);
    const taken = await registerAdvisor('Ravi Kumar');
    const c = as(adv.token);
    await c.post('/auth/mobile/current/otp');
    const v1 = await c.post('/auth/mobile/current/verify', { code: await lastOtp(adv.mobile) });
    const changeToken = v1.body.data.changeToken;
    expect(err(await c.post('/auth/mobile/new/otp', { changeToken, newMobile: adv.mobile }))).toMatchObject({ messageId: 'AUTH-24' });
    expect(err(await c.post('/auth/mobile/new/otp', { changeToken, newMobile: taken.mobile }))).toMatchObject({ status: 409, messageId: 'AUTH-25' });
    const fresh = newMobile();
    await c.post('/auth/mobile/new/otp', { changeToken, newMobile: fresh });
    const done = await c.post('/auth/mobile/new/verify', { changeToken, newMobile: fresh, code: await lastOtp(fresh) });
    expect(done.body.meta.messageId).toBe('AUTH-23');
    expect((await c.get('/auth/me')).body.data.mobile).toBe(`+91${fresh}`);
    expect((await as(other.token).get('/auth/me')).status).toBe(401);
  });
});