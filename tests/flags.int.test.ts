/** Feature switches (change analysis §5.3, §9.1): Admin-only, OTP and reason on every change, per-account values. */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, as, err, login, newMobile, registerAdvisor, resetState, seedAdmin, startTestEnv, stepUp, stopTestEnv } from './helpers.js';
import { normalizeMobile } from '../src/lib/phone.js';
import { AuditLog } from '../src/modules/audit/audit.model.js';
import { Submission } from '../src/modules/campaigns/campaign.model.js';
import { flagOn } from '../src/modules/flags/flags.js';
import { Lead } from '../src/modules/leads/lead.model.js';
import { User } from '../src/modules/users/user.model.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

async function admin() {
  const a = await seedAdmin();
  const A = as(a.token);
  const put = async (path: string, body: object) => A.put(path, body).set('X-Step-Up-Token', await stepUp(a.token, a.mobile));
  return { a, A, put };
}

describe('reading switches', () => {
  it('every signed-in user reads the values for their account; defaults apply until changed', async () => {
    const adv = await registerAdvisor();
    const r = await as(adv.token).get('/flags');
    expect(r.body.data).toEqual({
      quotation_accept_requires_payment: false, payment_skips_auto_accept: false,
      campaigns_website: true, campaigns_google: true, campaigns_meta: false, campaigns_linkedin: false,
    });
    expect((await request(app).get('/v1/flags')).status).toBe(401);
  });

  it('only a SkyUp Admin sees and changes them (STF and advisors refused)', async () => {
    const { A } = await admin();
    const list = (await A.get('/admin/flags')).body.data as Array<{ key: string; scope: string; enabled: boolean; accounts: unknown }>;
    expect(list.find((f) => f.key === 'skyup_direct_publish')).toBeUndefined(); // removed in Stage E2 (approval is gone for good)
    expect(list.find((f) => f.key === 'campaigns_meta')).toMatchObject({ scope: 'ACCOUNT', accounts: { on: 0, off: 0 } });
    const stfMobile = newMobile();
    await User.create({ accountId: null, role: 'STF', name: 'SkyUp Staff', mobile: normalizeMobile(stfMobile), status: 'ACTIVE', activatedAt: new Date() });
    expect(err(await as((await login(stfMobile)).token).get('/admin/flags'))).toMatchObject({ status: 403, messageId: 'GEN-03' });
    expect(err(await as((await registerAdvisor()).token).get('/admin/flags'))).toMatchObject({ status: 403 });
  });
});

describe('changing a platform value', () => {
  it('needs the step-up OTP and a reason; applies at once; audited with the reason and the OTP verification', async () => {
    const { A, put } = await admin();
    expect(err(await A.put('/admin/flags/quotation_accept_requires_payment', { enabled: true, reason: 'Go live' }))).toMatchObject({ status: 403, messageId: 'AUTH-26' });
    const noReason = await put('/admin/flags/quotation_accept_requires_payment', { enabled: true });
    expect(noReason.body.error.fields[0]).toMatchObject({ field: 'reason', messageId: 'GEN-01' });
    const r = await put('/admin/flags/quotation_accept_requires_payment', { enabled: true, reason: 'Client approved direct publish (2 Nov)' });
    expect(r.status).toBe(200);
    expect(r.body.meta.message).toBe('Feature switch saved. It applies from now on.');
    expect(r.body.data).toMatchObject({ key: 'quotation_accept_requires_payment', enabled: true, lastChange: { reason: 'Client approved direct publish (2 Nov)' } });
    expect(flagOn('quotation_accept_requires_payment')).toBe(true);
    const adv = await registerAdvisor();
    expect((await as(adv.token).get('/flags')).body.data.quotation_accept_requires_payment).toBe(true);
    const log = await AuditLog.findOne({ action: 'FEATURE_FLAG_CHANGED' }).lean<{ before: { enabled: boolean }; after: { enabled: boolean; reason: string; stepUpId: string | null } }>();
    expect(log).toMatchObject({ before: { enabled: false }, after: { enabled: true, reason: 'Client approved direct publish (2 Nov)' } });
    expect(log!.after.stepUpId).toMatch(/\S/);
  });

  it('an unknown switch is not found', async () => {
    const { put } = await admin();
    expect(err(await put('/admin/flags/no_such_switch', { enabled: true, reason: 'x reason' }))).toMatchObject({ status: 404 });
  });
});

describe('per-account values', () => {
  it('an account value overrides the platform value for that account only; clearing it returns to the platform value', async () => {
    const { put, A } = await admin();
    const one = await registerAdvisor('Asha Rao'); const two = await registerAdvisor('Ravi Shah');
    const path = `/admin/flags/quotation_accept_requires_payment/accounts/${one.user.accountId}`;
    const r = await put(path, { enabled: true, reason: 'Pilot account' });
    expect(r.body.data).toEqual({ key: 'quotation_accept_requires_payment', accountId: one.user.accountId, ownValue: true, enabled: true });
    expect((await as(one.token).get('/flags')).body.data.quotation_accept_requires_payment).toBe(true);
    expect((await as(two.token).get('/flags')).body.data.quotation_accept_requires_payment).toBe(false);
    expect((await A.get('/admin/flags/quotation_accept_requires_payment/accounts')).body.data).toEqual([expect.objectContaining({ accountId: one.user.accountId, enabled: true, reason: 'Pilot account' })]);
    // platform on, this account off: the account's own value wins
    await put('/admin/flags/quotation_accept_requires_payment', { enabled: true, reason: 'Everyone' });
    await put(path, { enabled: false, reason: 'Not ready yet' });
    expect(flagOn('quotation_accept_requires_payment', one.user.accountId)).toBe(false);
    expect(flagOn('quotation_accept_requires_payment', two.user.accountId)).toBe(true);
    await put(path, { enabled: null, reason: 'Back to the platform value' });
    expect(flagOn('quotation_accept_requires_payment', one.user.accountId)).toBe(true);
  });

  // No platform-wide switch exists since Stage E2; FLG-02 stays in the code for the next one.
  it('an unknown account is not found; a removed switch is not found', async () => {
    const { put } = await admin();
    const adv = await registerAdvisor();
    expect(err(await put(`/admin/flags/skyup_direct_publish/accounts/${adv.user.accountId}`, { enabled: true, reason: 'Try it' }))).toMatchObject({ status: 404 });
    expect(err(await put(`/admin/flags/campaigns_meta/accounts/acc_${'f'.repeat(28)}`, { enabled: true, reason: 'Try it' }))).toMatchObject({ status: 404 });
  });
});

describe('campaign channel switches', () => {
  it('a switched-off channel cannot be connected (CMP-08); its submissions are kept as FAILED and Retry imports them once on', async () => {
    const { put } = await admin();
    const adv = await registerAdvisor();
    const C = as(adv.token);
    const key = (await C.post('/campaigns/connections', { channel: 'WEBSITE', name: 'Main website' })).body.data.key as string;
    await put(`/admin/flags/campaigns_website/accounts/${adv.user.accountId}`, { enabled: false, reason: 'Paused for this account' });
    expect(err(await C.post('/campaigns/connections', { channel: 'WEBSITE', name: 'Second site' }))).toMatchObject({ status: 409, messageId: 'CMP-08' });
    expect((await C.post('/campaigns/connections', { channel: 'WEBSITE', name: 'Second site' })).body.error.message).toBe('Website form leads are not switched on for this account yet.');
    const m = newMobile();
    const hook = await request(app).post('/v1/hooks/website').set('X-Forwarded-For', '10.9.9.9').set('X-Bimayantra-Key', key).send({ name: 'Leela Das', phone: m });
    expect(hook.body.data.status).toBe('FAILED');
    const sub = (await Submission.findOne({}).lean())!;
    expect(sub.reason).toBe('Website form is not switched on for this account');
    await put(`/admin/flags/campaigns_website/accounts/${adv.user.accountId}`, { enabled: null, reason: 'Resume' });
    expect((await C.post(`/campaigns/submissions/${sub._id}/retry`)).body.data.status).toBe('IMPORTED');
    expect(await Lead.findOne({ mobile: normalizeMobile(m) }).lean()).toMatchObject({ source: 'Website form', sourceCode: 'WEBSITE_FORM' });
  });
});