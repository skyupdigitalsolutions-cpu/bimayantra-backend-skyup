/** Module 17 step 3 — Meta Lead Ads and LinkedIn Lead Gen Forms, against simulated platform servers. */
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, as, err, registerAdvisor, resetState, startTestEnv, stopTestEnv } from './helpers.js';
import { Lead } from '../src/modules/leads/lead.model.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { Connection, Submission } from '../src/modules/campaigns/campaign.model.js';
import { catchUp } from '../src/modules/campaigns/campaigns.service.js';
import { AccountFlag, GlobalFlag, loadFlags } from '../src/modules/flags/flags.js';
import { Customer } from '../src/modules/customers/customer.model.js';

const ENV = { META_APP_ID: 'app-1', META_APP_SECRET: 'meta-secret-1', META_VERIFY_TOKEN: 'verify-me', LINKEDIN_CLIENT_ID: 'li-1', LINKEDIN_CLIENT_SECRET: 'li-secret-1', PUBLIC_API_URL: 'https://api.example.in', PUBLIC_APP_URL: 'https://app.example.in' };
beforeAll(async () => { Object.assign(process.env, ENV); await startTestEnv(); });
afterAll(stopTestEnv);
/** Both channels are switched off by default (they need the platforms' approvals); these tests switch them on. */
beforeEach(async () => {
  await resetState();
  await GlobalFlag.create([{ _id: 'campaigns_meta', enabled: true, reason: 'test', updatedBy: 'test' }, { _id: 'campaigns_linkedin', enabled: true, reason: 'test', updatedBy: 'test' }]);
  await loadFlags();
});
afterEach(() => vi.unstubAllGlobals());

/** A fake Meta + LinkedIn: each route answers like the real API; calls are recorded. */
type Route = [RegExp, (url: string, init?: RequestInit) => { status?: number; body: unknown }];
function platforms(routes: Route[]) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const r = routes.find(([re]) => re.test(url));
    const out = r ? r[1](url, init) : { status: 404, body: { error: { message: 'no route' } } };
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  });
  return calls;
}
const lead = (id: string, mobile: string) => ({ id, created_time: '2026-11-02T10:00:00+0000', form_id: 'FORM_9', ad_name: 'Family plan ad', adset_name: 'Bengaluru 30-45', campaign_name: 'Diwali Health', is_organic: false,
  field_data: [{ name: 'full_name', values: ['Leela Das'] }, { name: 'phone_number', values: [`+91${mobile}`] }, { name: 'email', values: ['leela@example.com'] }, { name: 'how_many_members?', values: ['4'] }] });
const META_BASE: Route[] = [
  [/oauth\/access_token\?.*code=/, () => ({ body: { access_token: 'SHORT_TOKEN' } })],
  [/oauth\/access_token\?.*fb_exchange_token/, () => ({ body: { access_token: 'LONG_USER_TOKEN', expires_in: 5_184_000 } })],
  [/me\/accounts/, () => ({ body: { data: [{ id: '111', name: 'Asha Insurance', access_token: 'PAGE_TOKEN' }] } })],
  [/111\/subscribed_apps/, () => ({ body: { success: true } })],
];
const signMeta = (raw: string) => `sha256=${createHmac('sha256', ENV.META_APP_SECRET).update(raw).digest('hex')}`;
const metaPost = (body: object, sig?: string) => { const raw = JSON.stringify(body); return request(app).post('/v1/hooks/meta').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sig ?? signMeta(raw)).send(raw); };
const leadgen = (leadgenId: string) => ({ object: 'page', entry: [{ id: '111', time: 1, changes: [{ field: 'leadgen', value: { leadgen_id: leadgenId, page_id: '111', form_id: 'FORM_9', ad_id: 'AD_1', created_time: 1 } }] }] });

async function connectMeta(extra: Route[] = []) {
  const adv = await registerAdvisor('Asha Rao');
  const A = as(adv.token);
  const calls = platforms([...extra, ...META_BASE]);
  const url = (await A.post('/campaigns/oauth/meta/start', {})).body.data.url as string;
  const state = new URL(url).searchParams.get('state')!;
  const cb = await request(app).get(`/v1/hooks/oauth/meta/callback?code=abc&state=${encodeURIComponent(state)}`);
  const id = /connected=(cnx_[a-f0-9]+)/.exec(cb.headers.location ?? '')![1]!;
  await A.put(`/campaigns/connections/${id}/sources`, { ids: ['111'] });
  return { adv, A, id, state, cb, calls, url };
}

describe('Meta Lead Ads', () => {
  it('connects by sign-in: CMP-10 without app details; the token is stored encrypted; the state works once; choosing a Page subscribes it', async () => {
    const adv = await registerAdvisor('Ravi Kumar');
    delete process.env.META_APP_ID;
    expect(err(await as(adv.token).post('/campaigns/oauth/meta/start', {}))).toMatchObject({ messageId: 'CMP-10' });
    process.env.META_APP_ID = ENV.META_APP_ID;
    const w = await connectMeta();
    expect(w.url).toMatch(/^https:\/\/www\.facebook\.com\/v22\.0\/dialog\/oauth\?client_id=app-1&redirect_uri=https%3A%2F%2Fapi\.example\.in%2Fv1%2Fhooks%2Foauth%2Fmeta%2Fcallback/);
    expect(w.cb.headers.location).toMatch(/^https:\/\/app\.example\.in\/campaigns\?channel=(META|LINKEDIN)&connected=cnx_/);
    const c = await Connection.findById(w.id).lean();
    expect(JSON.stringify(c)).not.toContain('LONG_USER_TOKEN');
    expect(JSON.stringify(c)).not.toContain('PAGE_TOKEN');
    expect(c).toMatchObject({ channel: 'META', status: 'CONNECTED', sources: [{ id: '111', name: 'Asha Insurance', subscribed: true }] });
    expect(w.calls.some((x) => x.startsWith('POST') && x.includes('111/subscribed_apps'))).toBe(true);
    const again = await request(app).get(`/v1/hooks/oauth/meta/callback?code=abc&state=${encodeURIComponent(w.state)}`);
    expect(again.headers.location).toMatch(/^https:\/\/app\.example\.in\/campaigns\?channel=\w+&error=failed&reason=The\+sign-in\+link\+expired/); // single use, with the reason
  });

  it('the verify handshake; unsigned or wrongly signed webhooks change nothing; a signed one imports with ad attribution, once', async () => {
    expect((await request(app).get('/v1/hooks/meta?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345')).text).toBe('12345');
    expect((await request(app).get('/v1/hooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1')).status).toBe(403);
    const m = '9876500011';
    const w = await connectMeta([[/LEAD_1\?/, () => ({ body: lead('LEAD_1', m) })]]);
    expect((await metaPost(leadgen('LEAD_1'), 'sha256=00')).status).toBe(403);
    expect((await request(app).post('/v1/hooks/meta').set('Content-Type', 'application/json').send(JSON.stringify(leadgen('LEAD_1')))).status).toBe(403);
    expect(await Submission.countDocuments({})).toBe(0);
    const r = await metaPost(leadgen('LEAD_1'));
    expect(r.body.data.results).toEqual([{ status: 'IMPORTED', duplicate: false }]);
    expect(await Lead.findOne({ mobile: `+91${m}` }).lean()).toMatchObject({ source: 'Meta Ads', sourceCode: 'META_ADS', campaign: 'Diwali Health', name: 'Leela Das', email: 'leela@example.com' });
    expect((await metaPost(leadgen('LEAD_1'))).body.data.results).toEqual([{ status: 'IMPORTED', duplicate: true }]);
    expect(await Lead.countDocuments({ mobile: `+91${m}` })).toBe(1);
    const s = await Submission.findOne({ externalId: 'LEAD_1' }).lean();
    expect(s!.meta).toMatchObject({ adSetName: 'Bengaluru 30-45', adName: 'Family plan ad' });
    void w;
  });

  it('a failed fetch is kept as FAILED with the reason, and Retry fetches again; a revoked token sets Reconnect needed (CMP-09)', async () => {
    let down = true;
    const m = '9876500022';
    const w = await connectMeta([[/LEAD_2\?/, () => (down ? { status: 500, body: { error: { message: 'Service temporarily unavailable', code: 2 } } } : { body: lead('LEAD_2', m) })],
      [/LEAD_3\?/, () => ({ status: 400, body: { error: { message: 'Error validating access token', code: 190 } } })]]);
    const r = await metaPost(leadgen('LEAD_2'));
    expect(r.body.data.results[0].status).toBe('FAILED');
    const s = await Submission.findOne({ externalId: 'LEAD_2' }).lean();
    expect(s!.reason).toBe('Could not fetch the lead from Meta Ads: Service temporarily unavailable');
    down = false;
    expect((await w.A.post(`/campaigns/submissions/${s!._id}/retry`, {})).body.data.status).toBe('IMPORTED');
    await metaPost(leadgen('LEAD_3'));
    expect((await Connection.findById(w.id).lean())!.status).toBe('RECONNECT_NEEDED');
    expect((await Notification.findOne({ messageId: 'CMP-09' }).lean())!.message).toBe('Meta Ads needs you to sign in again: Meta Ads. New leads are paused until you reconnect.');
  });

  it('the 15-minute catch-up imports leads a webhook missed, never twice', async () => {
    const w = await connectMeta([[/111\/leadgen_forms/, () => ({ body: { data: [{ id: 'FORM_9', name: 'Health form', status: 'ACTIVE' }] } })],
      [/FORM_9\/leads/, () => ({ body: { data: [lead('LEAD_7', '9876500077'), lead('LEAD_8', '9876500088')] } })]]);
    expect(await catchUp()).toMatchObject({ connections: 1, found: 2, imported: 2 });
    expect(await catchUp()).toMatchObject({ found: 2, imported: 0 });
    expect(await Lead.countDocuments({ source: 'Meta Ads' })).toBe(2);
    void w;
  });
});

describe('LinkedIn Lead Gen Forms', () => {
  const liSig = (raw: string) => createHmac('sha256', ENV.LINKEDIN_CLIENT_SECRET).update(`hmacsha256=${raw}`).digest('hex');
  const liPost = (body: unknown, sig?: string) => { const raw = JSON.stringify(body); return request(app).post('/v1/hooks/linkedin').set('Content-Type', 'application/json').set('X-LI-Signature', sig ?? liSig(raw)).send(raw); };
  const note = (id: string, action = 'CREATED') => ({ type: 'LEAD_ACTION', leadGenFormResponse: `urn:li:leadGenFormResponse:${id}`, leadGenForm: 'urn:li:versionedLeadGenForm:(urn:li:leadGenForm:42,1)', owner: { sponsoredAccount: 'urn:li:sponsoredAccount:555' }, leadType: 'SPONSORED', leadAction: action, occurredAt: 1 });
  const resp = (mobile: string, testLead = false) => ({ id: 'x', testLead, form: { name: 'B2B health enquiry', content: { questions: [{ questionId: 1, predefinedField: 'FIRST_NAME', name: 'First name' }, { questionId: 2, predefinedField: 'LAST_NAME', name: 'Last name' }, { questionId: 3, predefinedField: 'PHONE_NUMBER', name: 'Phone' }, { questionId: 4, name: 'Team size', label: 'Team size' }] } },
    formResponse: { answers: [{ questionId: 1, answerDetails: { textQuestionAnswer: { answer: 'Kiran' } } }, { questionId: 2, answerDetails: { textQuestionAnswer: { answer: 'Das' } } }, { questionId: 3, answerDetails: { textQuestionAnswer: { answer: mobile } } }, { questionId: 4, answerDetails: { multipleChoiceAnswer: { options: ['11-50'] } } }] } });

  it('the challenge; signed notifications import (store first, then fetch); test leads are not counted; DELETED clears the answers; wrong signatures are refused', async () => {
    const ch = await request(app).get('/v1/hooks/linkedin?challengeCode=890e4665-4dfe-4ab1-b689-ed553bceeed0');
    expect(ch.body).toEqual({ challengeCode: '890e4665-4dfe-4ab1-b689-ed553bceeed0', challengeResponse: createHmac('sha256', ENV.LINKEDIN_CLIENT_SECRET).update('890e4665-4dfe-4ab1-b689-ed553bceeed0').digest('hex') });
    const adv = await registerAdvisor('Asha Rao');
    const A = as(adv.token);
    const calls = platforms([
      [/oauth\/v2\/accessToken/, () => ({ body: { access_token: 'LI_TOKEN', expires_in: 5_184_000 } })],
      [/adAccountUsers/, () => ({ body: { elements: [{ account: 'urn:li:sponsoredAccount:555', role: 'ACCOUNT_MANAGER' }] } })],
      [/rest\/leadNotifications/, () => ({ status: 201, body: {} })],
      [/leadGenFormResponse%3AR1/, () => ({ body: resp('9876500033') })],
      [/leadGenFormResponse%3AR2/, () => ({ body: resp('9876500044', true) })],
    ]);
    const url = (await A.post('/campaigns/oauth/linkedin/start', {})).body.data.url as string;
    expect(url).toMatch(/^https:\/\/www\.linkedin\.com\/oauth\/v2\/authorization\?response_type=code&client_id=li-1/);
    const cb = await request(app).get(`/v1/hooks/oauth/linkedin/callback?code=c1&state=${encodeURIComponent(new URL(url).searchParams.get('state')!)}`);
    const id = /connected=(cnx_[a-f0-9]+)/.exec(cb.headers.location ?? '')![1]!;
    await A.put(`/campaigns/connections/${id}/sources`, { ids: ['urn:li:sponsoredAccount:555'] });
    expect(calls.some((x) => x.startsWith('POST') && x.includes('rest/leadNotifications'))).toBe(true);
    expect((await liPost(note('R1'), 'deadbeef')).status).toBe(403);
    const r = await liPost(note('R1'));
    expect(r.body.data.results).toEqual([{ status: 'IMPORTED', duplicate: false }]);
    expect(await Lead.findOne({ mobile: '+919876500033' }).lean()).toMatchObject({ source: 'LinkedIn Ads', sourceCode: 'LINKEDIN_ADS', name: 'Kiran Das' });
    const ans = (await A.get(`/campaigns/leads/${(await Lead.findOne({ mobile: '+919876500033' }).lean())!._id}/answers`)).body.data[0].answers;
    expect(ans).toContainEqual({ key: 'Team size', label: 'Team size', value: '11-50' });
    expect((await liPost(note('R2'))).body.data.results[0].status).toBe('SKIPPED');
    await liPost(note('R1', 'DELETED'));
    expect(await Submission.findOne({ externalId: 'urn:li:leadGenFormResponse:R1' }).lean()).toMatchObject({ answers: [], reason: 'Deleted by the person on LinkedIn' });
    // Q97 (client decision): only the answers are cleared; the lead stays, is marked withdrawn, and the advisor is told once
    const kiran = (await Lead.findOne({ mobile: '+919876500033' }).lean())!;
    expect(kiran.withdrawal).toMatchObject({ channel: 'LINKEDIN', decision: null });
    await liPost(note('R1', 'DELETED')); // repeated event: no second bell
    const bell = (await A.get('/notifications?filter=LEADS')).body.data.items.filter((n: { kind: string }) => n.kind === 'LEAD_WITHDRAWN');
    expect(bell).toHaveLength(1);
    expect(bell[0]).toMatchObject({ link: { type: 'LEAD', id: kiran._id } });
    expect(bell[0].message).toBe('Kiran Das withdrew their LinkedIn form. Their answers were cleared. Keep the lead or remove it.');
    const d = (await A.get(`/leads/${kiran._id}`)).body.data;
    expect(d).toMatchObject({ withdrawal: { channel: 'LINKEDIN' }, canRemove: true });
    // the option to remove the lead itself: its tasks go, the submission keeps its record without the link
    await A.post('/tasks', { title: 'Call Kiran', dueDate: '01-01-2099', dueTime: '10:00', linkedType: 'LEAD', linkedId: kiran._id });
    const rm = await A.post(`/leads/${kiran._id}/remove`, { version: d.version });
    expect(rm.status).toBe(200);
    expect(rm.body.meta.message).toBe(`Lead ${kiran.number} removed with its tasks.`);
    expect(await Lead.findById(kiran._id).lean()).toBeNull();
    expect(await (await import('../src/modules/tasks/task.model.js')).Task.countDocuments({ linkedId: kiran._id })).toBe(0);
    expect(await Submission.findOne({ externalId: 'urn:li:leadGenFormResponse:R1' }).lean()).toMatchObject({ leadId: null, answers: [] });
  });

  it('Q97: keep the lead after the person withdrew; a lead that was not withdrawn cannot be removed this way', async () => {
    const adv = await registerAdvisor('Asha Rao');
    const A = as(adv.token);
    const pipelineId = (await A.get('/pipelines')).body.data[0].id;
    const made = (await A.post('/leads', { pipelineId, name: 'Rohan Shah', mobile: '9876500077', source: 'WALK_IN' })).body.data;
    expect(err(await A.post(`/leads/${made.id}/remove`, { version: made.version }))).toMatchObject({ status: 409, messageId: 'CMP-19' });
    await Submission.create({ accountId: adv.user.accountId, connectionId: 'cnx_test', channel: 'LINKEDIN', externalId: 'urn:li:leadGenFormResponse:K1', status: 'IMPORTED', leadId: made.id, answers: [] });
    await (await import('../src/modules/leads/withdrawal.service.js')).markWithdrawn([made.id], 'LINKEDIN');
    const d = (await A.get(`/leads/${made.id}`)).body.data;
    const kept = await A.post(`/leads/${made.id}/withdrawal/keep`, { version: d.version });
    expect(kept.body.meta.message).toBe('Lead kept. Only the form answers were cleared.');
    expect((await A.get(`/leads/${made.id}`)).body.data.withdrawal).toMatchObject({ decision: 'KEPT' });
  });
});

describe('rollout switches', () => {
  it('sign-in is refused while a channel is switched off for the account (CMP-08); a lead that arrives then is kept as FAILED, not lost', async () => {
    const m = '9876500055';
    const w = await connectMeta([[/LEAD_5\?/, () => ({ body: lead('LEAD_5', m) })]]);
    const accountId = (await Connection.findById(w.id).lean())!.accountId;
    await AccountFlag.create({ _id: `campaigns_meta|${accountId}`, flag: 'campaigns_meta', accountId, enabled: false, reason: 'test', updatedBy: 'test' });
    await loadFlags();
    const off = await w.A.post('/campaigns/oauth/meta/start', {});
    expect(err(off)).toMatchObject({ messageId: 'CMP-08' });
    expect(off.body.error.message).toBe('Meta Ads leads are not switched on for this account yet.');
    expect((await metaPost(leadgen('LEAD_5'))).body.data.results[0].status).toBe('FAILED');
    expect((await Submission.findOne({ externalId: 'LEAD_5' }).lean())!.reason).toBe('Meta Ads is not switched on for this account');
    expect(await Lead.countDocuments({ mobile: `+91${m}` })).toBe(0);
    await AccountFlag.deleteMany({});
    await loadFlags();
    const s = await Submission.findOne({ externalId: 'LEAD_5' }).lean();
    expect((await w.A.post(`/campaigns/submissions/${s!._id}/retry`, {})).body.data.status).toBe('IMPORTED');
    void Customer;
  });
});
describe('sign-in result is shown on the Campaigns screen', () => {
  it('a cancelled or refused sign-in returns to /campaigns with the platform’s reason; readiness says what is missing', async () => {
    const r = await request(app).get('/v1/hooks/oauth/linkedin/callback?error=unauthorized_scope_error&error_description=Scope+%22r_marketing_leadgen_automation%22+is+not+authorized+for+your+application');
    expect(r.status).toBe(302);
    const u = new URL(String(r.headers.location));
    expect(u.pathname).toBe('/campaigns');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ channel: 'LINKEDIN', error: 'unauthorized_scope_error', reason: 'Scope "r_marketing_leadgen_automation" is not authorized for your application' });
    const adv = await registerAdvisor('Asha Rao');
    const p = (await as(adv.token).get('/campaigns/platforms')).body.data;
    expect(p.META).toMatchObject({ configured: expect.any(Boolean), on: expect.any(Boolean), redirectUri: expect.stringMatching(/\/v1\/hooks\/oauth\/meta\/callback$/) });
    expect(p.LINKEDIN.redirectUri).toMatch(/\/v1\/hooks\/oauth\/linkedin\/callback$/);
  });
});

describe('plan-based rollout (client decision: Meta and LinkedIn on for Premium while tested)', () => {
  it('a Premium account can connect without the platform switch; a trial account cannot until TRIAL is added; an account’s own value still wins', async () => {
    await GlobalFlag.deleteMany({});
    await loadFlags();
    const prem = await registerAdvisor('Asha Rao');
    const trial = await registerAdvisor('Ravi Kumar');
    const { Account } = await import('../src/modules/accounts/account.model.js');
    await Account.updateOne({ _id: prem.user.accountId }, { $set: { 'subscription.plan': 'PREMIUM', 'subscription.status': 'ACTIVE' } }); // the plan change reaches the switches at once
    const P = as(prem.token);
    const T = as(trial.token);
    expect((await P.post('/campaigns/oauth/meta/start', {})).body.data.url).toMatch(/facebook\.com/);
    expect((await P.post('/campaigns/oauth/linkedin/start', {})).body.data.url).toMatch(/linkedin\.com/);
    expect((await P.get('/campaigns/platforms')).body.data).toMatchObject({ META: { on: true }, LINKEDIN: { on: true }, GOOGLE: { on: true, configured: true } });
    expect(err(await T.post('/campaigns/oauth/meta/start', {}))).toMatchObject({ messageId: 'CMP-08' });
    // SkyUp adds trial accounts to the rollout
    await GlobalFlag.create({ _id: 'campaigns_meta', enabled: false, plans: ['PREMIUM', 'TRIAL'], reason: 'test', updatedBy: 'test' });
    await loadFlags();
    expect((await T.post('/campaigns/oauth/meta/start', {})).status).toBe(200);
    // one account switched off by hand stays off whatever its plan
    await AccountFlag.create({ _id: `campaigns_meta|${prem.user.accountId}`, flag: 'campaigns_meta', accountId: prem.user.accountId, enabled: false, reason: 'test', updatedBy: 'test' });
    await loadFlags();
    expect(err(await P.post('/campaigns/oauth/meta/start', {}))).toMatchObject({ messageId: 'CMP-08' });
  });
});