/**
 * SkyUp's ad-platform apps set from the Admin screen (no .env editing): secrets stored encrypted and never returned in
 * full, saved values win over .env, every advisor then signs in with their own Meta / LinkedIn account.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, err, registerAdvisor, resetState, seedAdmin, startTestEnv, stopTestEnv, stepUp } from './helpers.js';
import { AuditLog } from '../src/modules/audit/audit.model.js';
import mongoose from 'mongoose';

beforeAll(async () => { for (const k of ['META_APP_ID', 'META_APP_SECRET', 'META_VERIFY_TOKEN', 'LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET']) delete process.env[k]; process.env.PUBLIC_API_URL = 'https://api.example.in'; await startTestEnv(); });
afterAll(stopTestEnv);
beforeEach(resetState);

describe('Admin → Ad platform apps', () => {
  it('an Admin saves the Meta app once (OTP); advisors can then connect their own Meta account; secrets are masked and encrypted; null clears', async () => {
    const admin = await seedAdmin();
    const A = as(admin.token);
    const adv = await registerAdvisor('Asha Rao');
    const V = as(adv.token);
    // nothing set: advisors see "not set up"
    expect((await V.get('/campaigns/platforms')).body.data.META.configured).toBe(false);
    const before = (await A.get('/admin/platform-apps')).body.data.find((x: { channel: string }) => x.channel === 'META');
    expect(before).toMatchObject({ configured: false });
    expect(before.urls[0]).toMatchObject({ label: 'OAuth redirect URL', value: 'https://api.example.in/v1/hooks/oauth/meta/callback' });
    expect(before.urls[1].value).toBe('https://api.example.in/v1/hooks/meta');

    const body = { values: { appId: '123456789012345', appSecret: 'super-secret-meta-value', verifyToken: 'verify-me-please' }, reason: 'Meta app created' };
    expect(err(await A.put('/admin/platform-apps/meta', body))).toMatchObject({ status: 403, code: 'STEP_UP_REQUIRED' });
    const saved = await A.put('/admin/platform-apps/meta', body).set('X-Step-Up-Token', await stepUp(admin.token, admin.mobile));
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ configured: true });
    const f = Object.fromEntries(saved.body.data.fields.map((x: { key: string }) => [x.key, x]));
    expect(f.appId).toMatchObject({ value: '123456789012345', from: 'SETTINGS' });
    expect(f.appSecret).toMatchObject({ set: true, value: '••••alue', from: 'SETTINGS' }); // never the full secret
    expect(JSON.stringify(saved.body)).not.toContain('super-secret-meta-value');
    // stored encrypted, and the audit log names the fields only
    const raw = await mongoose.connection.collection('platform_apps').findOne({ _id: 'META' as never });
    expect(JSON.stringify(raw)).not.toContain('super-secret-meta-value');
    const log = await AuditLog.findOne({ action: 'PLATFORM_APP_CHANGED' }).lean();
    expect(JSON.stringify(log)).not.toContain('super-secret');

    // every advisor now connects their own Meta account through SkyUp's app
    expect((await V.get('/campaigns/platforms')).body.data.META.configured).toBe(true);
    const { GlobalFlag, loadFlags } = await import('../src/modules/flags/flags.js');
    await GlobalFlag.create({ _id: 'campaigns_meta', enabled: true, reason: 'test', updatedBy: 'test' }); // the channel's rollout switch
    await loadFlags();
    const url = (await V.post('/campaigns/oauth/meta/start', {})).body.data?.url ?? '';
    expect(url).toContain('client_id=123456789012345');

    // keep a value by leaving it empty; clear one with null
    const tok = await stepUp(admin.token, admin.mobile);
    const cleared = await A.put('/admin/platform-apps/meta', { values: { appId: '', appSecret: null }, reason: 'Rotate' }).set('X-Step-Up-Token', tok);
    const g = Object.fromEntries(cleared.body.data.fields.map((x: { key: string }) => [x.key, x]));
    expect(g.appId.value).toBe('123456789012345');
    expect(g.appSecret.set).toBe(false);
    expect(cleared.body.data.configured).toBe(false);
  });

  it('advisors and staff cannot see or change the apps; unknown fields are refused', async () => {
    const adv = await registerAdvisor('Ravi Kumar');
    expect((await as(adv.token).get('/admin/platform-apps')).status).toBe(403);
    const admin = await seedAdmin();
    const r = await as(admin.token).put('/admin/platform-apps/linkedin', { values: { password: 'x' }, reason: 'x' }).set('X-Step-Up-Token', await stepUp(admin.token, admin.mobile));
    expect(r.status).toBe(400);
  });
});