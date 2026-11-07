/**
 * Own-app (manual) Meta / LinkedIn connections: each advisor pastes their own Page / ad account and token; leads arrive
 * at that connection's own webhook, signed with that advisor's own secret, and only ever reach that advisor's account.
 */
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, as, err, registerAdvisor, resetState, startTestEnv, stopTestEnv } from './helpers.js';
import { Lead } from '../src/modules/leads/lead.model.js';
import { Connection } from '../src/modules/campaigns/campaign.model.js';
import { GlobalFlag, loadFlags } from '../src/modules/flags/flags.js';
import mongoose from 'mongoose';

beforeAll(async () => { process.env.PUBLIC_API_URL = 'https://api.example.in'; for (const k of ['META_APP_ID', 'META_APP_SECRET', 'META_VERIFY_TOKEN', 'LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET']) delete process.env[k]; await startTestEnv(); });
afterAll(stopTestEnv);
beforeEach(async () => {
  await resetState();
  await GlobalFlag.create([{ _id: 'campaigns_meta', enabled: true, reason: 't', updatedBy: 't' }, { _id: 'campaigns_linkedin', enabled: true, reason: 't', updatedBy: 't' }]);
  await loadFlags();
});
afterEach(() => vi.unstubAllGlobals());

type Route = [RegExp, (url: string, init?: RequestInit) => { status?: number; body: unknown }];
function platform(routes: Route[]) {
  const calls: Array<{ url: string; body?: string }> = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? String(init.body) : undefined });
    const r = routes.find(([re]) => re.test(url));
    const out = r ? r[1](url, init) : { status: 404, body: { error: { message: 'no route' } } };
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  });
  return calls;
}
const lead = (id: string, form: string, mobile: string) => ({ id, created_time: '2026-11-02T10:00:00+0000', form_id: form, campaign_name: 'Diwali Health', field_data: [{ name: 'full_name', values: ['Leela Das'] }, { name: 'phone_number', values: [`+91${mobile}`] }] });
const PAGE = '123456789012345';
const META: Route[] = [
  [new RegExp(`/${PAGE}\\?fields=id%2Cname`), () => ({ body: { id: PAGE, name: 'Asha Insurance' } })],
  [new RegExp(`/${PAGE}/subscribed_apps`), () => ({ body: { success: true } })],
  [/LEAD_1\?/, () => ({ body: lead('LEAD_1', 'FORM_9', '9876500101') })],
  [/LEAD_2\?/, () => ({ body: lead('LEAD_2', 'FORM_X', '9876500102') })],
];
const sign = (secret: string, raw: string) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
const leadgen = (leadgenId: string, form: string) => ({ object: 'page', entry: [{ id: PAGE, time: 1, changes: [{ field: 'leadgen', value: { leadgen_id: leadgenId, page_id: PAGE, form_id: form, created_time: 1 } }] }] });

describe('own-app Meta connection', () => {
  it('connects with a Page token; its own webhook and verify token; leads go only to that advisor; the same Page cannot be added by another account', async () => {
    const a = await registerAdvisor('Asha Rao');
    const b = await registerAdvisor('Ravi Kumar');
    const A = as(a.token); const B = as(b.token);
    platform(META);
    const appSecret = 'asha-own-meta-app-secret';
    const r = await A.post('/campaigns/connections/manual', { channel: 'META', name: 'Diwali leads', pageId: PAGE, pageToken: 'EAAB-asha-page-token-0123456789', appSecret, formIds: ['FORM_9'] });
    expect(r.status).toBe(201);
    const id = r.body.data.connection.id;
    expect(r.body.data).toMatchObject({ connection: { channel: 'META', mode: 'MANUAL', status: 'CONNECTED' }, webhookUrl: `https://api.example.in/v1/hooks/meta/c/${id}`, verifyToken: expect.any(String) });
    // tokens and secrets are stored encrypted
    const raw = JSON.stringify(await mongoose.connection.collection('campaign_connections').findOne({ _id: id as never }));
    expect(raw).not.toContain('asha-page-token'); expect(raw).not.toContain(appSecret);

    // the advisor's own Meta app checks the webhook with the verify token
    const vt = r.body.data.verifyToken;
    expect((await request(app).get(`/v1/hooks/meta/c/${id}?hub.mode=subscribe&hub.verify_token=${vt}&hub.challenge=42`)).text).toBe('42');
    expect((await request(app).get(`/v1/hooks/meta/c/${id}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`)).status).toBe(403);

    // a lead signed with the advisor's own secret is imported into their account only; another form is skipped (filter)
    const post = (body: object, secret = appSecret) => { const s = JSON.stringify(body); return request(app).post(`/v1/hooks/meta/c/${id}`).set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(secret, s)).send(s); };
    expect((await post(leadgen('LEAD_1', 'FORM_9'), 'someone-elses-secret')).status).toBe(403);
    expect((await post(leadgen('LEAD_1', 'FORM_9'))).body.data.results).toEqual([{ status: 'IMPORTED', duplicate: false }]);
    expect((await post(leadgen('LEAD_2', 'FORM_X'))).body.data.results).toEqual([{ status: 'SKIPPED', duplicate: false }]);
    const l = await Lead.findOne({ mobile: '+919876500101' }).lean();
    expect(l!.accountId).toBe(a.user.accountId);
    expect(await Lead.countDocuments({ mobile: '+919876500102' })).toBe(0);

    // isolation: B sees none of A's connections, campaigns or leads, cannot open them, and cannot take A's Page
    expect((await B.get('/campaigns/connections')).body.data).toEqual([]);
    expect((await B.get('/campaigns')).body.data).toEqual([]);
    expect((await B.get('/leads')).body.data).toEqual([]);
    expect((await B.get(`/campaigns/connections/${id}/sources`)).status).toBe(404);
    expect(err(await B.post('/campaigns/connections/manual', { channel: 'META', name: 'Mine', pageId: PAGE, pageToken: 'EAAB-ravi-page-token-0123456789', appSecret: 'ravi-own-meta-app-secret' }))).toMatchObject({ status: 409, messageId: 'CMP-21' });
    expect((await A.get('/campaigns/connections')).body.data).toHaveLength(1);
  });

  it('a token Meta refuses is a field error; an expired token can be replaced', async () => {
    const a = await registerAdvisor('Asha Rao');
    platform([[new RegExp(`/${PAGE}\\?fields`), () => ({ status: 400, body: { error: { message: 'Invalid OAuth access token', code: 190 } } })]]);
    const r = await as(a.token).post('/campaigns/connections/manual', { channel: 'META', name: 'Test page', pageId: PAGE, pageToken: 'EAAB-bad-token-0123456789012', appSecret: 'asha-own-meta-app-secret' });
    expect(r.status).toBe(400);
    expect(r.body.error.fields[0]).toMatchObject({ field: 'pageToken' });
    platform(META);
    const ok = await as(a.token).post('/campaigns/connections/manual', { channel: 'META', name: 'Test page', pageId: PAGE, pageToken: 'EAAB-good-token-0123456789012', appSecret: 'asha-own-meta-app-secret' });
    await Connection.updateOne({ _id: ok.body.data.connection.id }, { $set: { status: 'RECONNECT_NEEDED' } });
    const up = await as(a.token).put(`/campaigns/connections/${ok.body.data.connection.id}/manual`, { pageToken: 'EAAB-new-token-01234567890123' });
    expect(up.body.data.status).toBe('CONNECTED');
  });
});

describe('own-app LinkedIn connection', () => {
  it('registers lead notifications to its own webhook; the challenge and signatures use the advisor’s client secret', async () => {
    const a = await registerAdvisor('Asha Rao');
    const R = 'urn:li:leadGenFormResponse:M1';
    const calls = platform([
      [/rest\/leadNotifications/, () => ({ status: 201, body: {} })],
      [/leadGenFormResponse%3AM1/, () => ({ body: { id: 'x', form: { name: 'B2B', content: { questions: [{ questionId: 1, predefinedField: 'FIRST_NAME' }, { questionId: 2, predefinedField: 'PHONE_NUMBER' }] } }, formResponse: { answers: [{ questionId: 1, answerDetails: { textQuestionAnswer: { answer: 'Kiran' } } }, { questionId: 2, answerDetails: { textQuestionAnswer: { answer: '9876500103' } } }] } } })],
    ]);
    const secret = 'asha-linkedin-client-secret';
    const r = await as(a.token).post('/campaigns/connections/manual', { channel: 'LINKEDIN', name: 'B2B', accountUrn: 'urn:li:sponsoredAccount:777', accessToken: 'AQX-asha-linkedin-token-0123456789', clientSecret: secret });
    expect(r.status).toBe(201);
    const id = r.body.data.connection.id;
    expect(JSON.parse(calls.find((c) => c.url.includes('leadNotifications'))!.body!)).toMatchObject({ webhook: `https://api.example.in/v1/hooks/linkedin/c/${id}`, owner: { sponsoredAccount: 'urn:li:sponsoredAccount:777' } });
    const ch = await request(app).get(`/v1/hooks/linkedin/c/${id}?challengeCode=abc`);
    expect(ch.body.challengeResponse).toBe(createHmac('sha256', secret).update('abc').digest('hex'));
    const body = JSON.stringify({ type: 'LEAD_ACTION', leadGenFormResponse: R, leadGenForm: 'urn:li:versionedLeadGenForm:(urn:li:leadGenForm:5,1)', owner: { sponsoredAccount: 'urn:li:sponsoredAccount:777' }, leadAction: 'CREATED' });
    const res = await request(app).post(`/v1/hooks/linkedin/c/${id}`).set('Content-Type', 'application/json').set('X-LI-Signature', createHmac('sha256', secret).update(`hmacsha256=${body}`).digest('hex')).send(body);
    expect(res.body.data.results).toEqual([{ status: 'IMPORTED', duplicate: false }]);
    expect((await Lead.findOne({ mobile: '+919876500103' }).lean())!.accountId).toBe(a.user.accountId);
  });
});