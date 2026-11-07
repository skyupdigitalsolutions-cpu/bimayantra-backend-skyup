/** Stage H — campaign list and detail, leads per campaign and ad, platform status and spend (Meta, Google). */
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, as, err, login, newMobile, registerAdvisor, resetState, startTestEnv, stepUp, stopTestEnv } from './helpers.js';
import { Lead } from '../src/modules/leads/lead.model.js';
import { AdCampaign, AdCreative, Connection } from '../src/modules/campaigns/campaign.model.js';
import { catchUp } from '../src/modules/campaigns/campaigns.service.js';
import { googleStatus, metaStatus } from '../src/modules/campaigns/platforms.js';
import { GlobalFlag, loadFlags } from '../src/modules/flags/flags.js';

const ENV = { META_APP_ID: 'app-1', META_APP_SECRET: 'meta-secret-1', META_VERIFY_TOKEN: 'verify-me', GOOGLE_OAUTH_CLIENT_ID: 'g-1', GOOGLE_OAUTH_CLIENT_SECRET: 'g-secret', GOOGLE_ADS_DEVELOPER_TOKEN: 'dev-token', PUBLIC_API_URL: 'https://api.example.in', PUBLIC_APP_URL: 'https://app.example.in' };
beforeAll(async () => { Object.assign(process.env, ENV); await startTestEnv(); });
afterAll(stopTestEnv);
beforeEach(async () => { await resetState(); await GlobalFlag.create([{ _id: 'campaigns_meta', enabled: true, reason: 'test', updatedBy: 'test' }]); await loadFlags(); });
afterEach(() => vi.unstubAllGlobals());

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
const google = (key: string, leadId: string, mobile: string, campaign = 9911, creative = 501) => request(app).post('/v1/hooks/google').send({ lead_id: leadId, form_id: 4401, campaign_id: campaign, adgroup_id: 77, creative_id: creative, google_key: key, is_test: false,
  user_column_data: [{ column_id: 'FULL_NAME', string_value: `Lead ${leadId}` }, { column_id: 'PHONE_NUMBER', string_value: `+91${mobile}` }] });
const istToday = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

async function googleWorld() {
  const adv = await registerAdvisor('Asha Rao');
  const A = as(adv.token);
  const c = (await A.post('/campaigns/connections', { channel: 'GOOGLE', name: 'Google Ads' })).body.data;
  await google(c.key, 'L1', '9876500101', 9911, 501);
  await google(c.key, 'L2', '9876500102', 9911, 502);
  await google(c.key, 'L3', '9876500103', 9922, 601);
  return { adv, A, cnx: c.connection.id as string, key: c.key as string };
}

describe('campaign list, detail and leads', () => {
  it('Google leads create and link their campaign and ad; the list shows leads, new today and converted; detail has 14 days and leads per ad; the leads page shows current status', async () => {
    const w = await googleWorld();
    expect(await AdCampaign.countDocuments({})).toBe(2);
    expect(await AdCreative.countDocuments({})).toBe(3);
    const lead1 = await Lead.findOne({ name: 'Lead L1' }).lean();
    await Lead.updateOne({ _id: lead1!._id }, { $set: { status: 'CONVERTED', isOpen: false } });
    const rows = (await w.A.get('/campaigns')).body.data as Array<Record<string, any>>;
    const c1 = rows.find((r) => r.name === 'Campaign 9911')!;
    expect(c1).toMatchObject({ kind: 'CAMPAIGN', channel: 'GOOGLE', status: 'NOT_SYNCED_YET', leads: 2, newToday: 2, converted: 1, spend: null, costPerLead: null });
    const d = (await w.A.get(`/campaigns/${c1.id}`)).body.data;
    expect(d.leadsPerDay).toHaveLength(14);
    expect(d.leadsPerDay[13]).toEqual({ date: istToday(), leads: 2 });
    expect(d.conversionRate).toBe(50);
    expect(d.leadsByAd.map((a: { adId: string; leads: number }) => [a.adId, a.leads]).sort()).toEqual([['501', 1], ['502', 1]]);
    const ls = (await w.A.get(`/campaigns/${c1.id}/leads`)).body.data;
    expect(ls.map((l: { name: string; leadStatus: string }) => `${l.name}:${l.leadStatus}`).sort()).toEqual(['Lead L1:CONVERTED', 'Lead L2:NEW']);
    expect((await w.A.get('/campaigns?channel=WEBSITE')).body.data).toEqual([]);
    const other = await registerAdvisor('Kiran Das');
    expect((await as(other.token).get(`/campaigns/${c1.id}`)).status).toBe(404);
  });

  it('website forms: Active or Turned off (set by the advisor); a disconnected channel shows Not syncing', async () => {
    const adv = await registerAdvisor('Asha Rao');
    const A = as(adv.token);
    const c = (await A.post('/campaigns/connections', { channel: 'WEBSITE', name: 'Main website' })).body.data;
    await request(app).post('/v1/hooks/website').set('X-Bimayantra-Key', c.key).send({ formName: 'Health page', name: 'Ravi Kumar', phone: '9876500201' });
    let row = (await A.get('/campaigns')).body.data[0];
    expect(row).toMatchObject({ kind: 'FORM', channel: 'WEBSITE', name: 'Health page', status: 'ACTIVE', leads: 1 });
    await A.put(`/campaigns/forms/${row.id}`, { active: false });
    expect((await A.get(`/campaigns/${row.id}`)).body.data.status).toBe('TURNED_OFF');
    await A.post(`/campaigns/connections/${c.connection.id}/disconnect`, {});
    row = (await A.get('/campaigns')).body.data[0];
    expect(row.status).toBe('NOT_SYNCING');
    expect((await A.get('/campaigns?status=NOT_SYNCING')).body.data).toHaveLength(1);
  });
});

describe('Google status and spend', () => {
  const G: Route[] = [
    [/oauth2\.googleapis\.com\/token/, (_u, init) => (String(init?.body).includes('grant_type=authorization_code') ? { body: { access_token: 'AT', refresh_token: 'RT-123' } } : { body: { access_token: 'AT2' } })],
    [/customers:listAccessibleCustomers/, () => ({ body: { resourceNames: ['customers/1234567890'] } })],
    [/customers\/1234567890\/googleAds:search/, () => ({ body: { results: [
      { campaign: { id: '9911', name: 'Health Leads Oct', status: 'ENABLED', primaryStatus: 'ELIGIBLE', startDate: '2026-10-01' }, metrics: { costMicros: '2500000000' }, customer: { currencyCode: 'INR' } },
      { campaign: { id: '9922', name: 'Term Plans', status: 'PAUSED', primaryStatus: 'PAUSED', startDate: '2026-09-01' }, metrics: { costMicros: '1000500000' }, customer: { currencyCode: 'INR' } },
      { campaign: { id: '9933', name: 'Brand', status: 'ENABLED', primaryStatus: 'PENDING' }, metrics: { costMicros: '0' }, customer: { currencyCode: 'INR' } },
    ] } })],
  ];
  it('sign-in attaches to the Google lead connection (CMP-15 without one); sync maps status and spend; cost per lead for the advisor only; Sync now once a minute (CMP-14)', async () => {
    const w = await googleWorld();
    platforms(G);
    expect(err(await w.A.post('/campaigns/oauth/google/start', {}))).toMatchObject({ messageId: 'CMP-15' });
    const url = (await w.A.post('/campaigns/oauth/google/start', { connectionId: w.cnx })).body.data.url as string;
    expect(url).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?client_id=g-1.*scope=https%3A%2F%2Fwww\.googleapis\.com%2Fauth%2Fadwords.*access_type=offline/);
    const cb = await request(app).get(`/v1/hooks/oauth/google/callback?code=c1&state=${encodeURIComponent(new URL(url).searchParams.get('state')!)}`);
    expect(cb.headers.location).toBe(`https://app.example.in/campaigns?channel=GOOGLE&connected=${w.cnx}`);
    const conn = await Connection.findById(w.cnx).lean();
    expect(JSON.stringify(conn)).not.toContain('RT-123'); // the refresh token is stored encrypted
    expect(conn!.keyHash).toBeTruthy(); // the lead-form key keeps working
    await w.A.put(`/campaigns/connections/${w.cnx}/sources`, { ids: ['1234567890'] });
    const sync = await w.A.post(`/campaigns/connections/${w.cnx}/sync-now`, {});
    expect(sync.body.meta.message).toBe('Synced: status and spend are up to date.');
    expect(err(await w.A.post(`/campaigns/connections/${w.cnx}/sync-now`, {}))).toMatchObject({ status: 429, messageId: 'CMP-14' });
    const rows = (await w.A.get('/campaigns')).body.data as Array<Record<string, any>>;
    const by = (n: string) => rows.find((r) => r.name === n)!;
    expect(by('Health Leads Oct')).toMatchObject({ status: 'ACTIVE', spend: 2500, currency: 'INR', leads: 2, costPerLead: 1250, startedOn: '2026-10-01' });
    expect(by('Term Plans')).toMatchObject({ status: 'PAUSED', spend: 1000.5, leads: 1, costPerLead: 1000.5 });
    expect(by('Brand')).toMatchObject({ status: 'IN_REVIEW', leads: 0, costPerLead: null }); // found by the sync, no leads yet
    // an assistant sees the campaigns, not the money
    const m = newMobile();
    await w.A.post('/assistants', { name: 'Priya Shah', mobile: m }, { 'X-Step-Up-Token': await stepUp(w.adv.token, w.adv.mobile) });
    const ast = (await as((await login(m)).token).get('/campaigns')).body.data as Array<Record<string, unknown>>;
    expect(ast.length).toBe(3);
    expect(ast.every((r) => !('spend' in r) && !('costPerLead' in r))).toBe(true);
  });

  it('a revoked Google sign-in sets Reconnect needed and the campaigns show Not syncing', async () => {
    const w = await googleWorld();
    platforms(G);
    const url = (await w.A.post('/campaigns/oauth/google/start', { connectionId: w.cnx })).body.data.url as string;
    await request(app).get(`/v1/hooks/oauth/google/callback?code=c1&state=${encodeURIComponent(new URL(url).searchParams.get('state')!)}`);
    await w.A.put(`/campaigns/connections/${w.cnx}/sources`, { ids: ['1234567890'] });
    platforms([[/oauth2\.googleapis\.com\/token/, () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } })]]);
    await catchUp();
    expect((await Connection.findById(w.cnx).lean())!.status).toBe('RECONNECT_NEEDED');
    expect(((await w.A.get('/campaigns')).body.data as Array<{ status: string }>).every((r) => r.status === 'NOT_SYNCING')).toBe(true);
  });
});

describe('Meta status and spend', () => {
  it('a Meta lead links its campaign; sync reads status and lifetime spend', async () => {
    const adv = await registerAdvisor('Asha Rao');
    const A = as(adv.token);
    platforms([
      [/oauth\/access_token\?.*code=/, () => ({ body: { access_token: 'SHORT' } })],
      [/oauth\/access_token\?.*fb_exchange_token/, () => ({ body: { access_token: 'LONG', expires_in: 5_184_000 } })],
      [/me\/accounts/, () => ({ body: { data: [{ id: '111', name: 'Asha Insurance', access_token: 'PAGE' }] } })],
      [/111\/subscribed_apps/, () => ({ body: { success: true } })],
      [/LEAD_9\?/, () => ({ body: { id: 'LEAD_9', form_id: 'F9', campaign_id: 'C-777', campaign_name: 'Diwali Health', ad_id: 'AD-1', ad_name: 'Family ad', adset_id: 'AS-1', adset_name: 'Bengaluru', field_data: [{ name: 'full_name', values: ['Leela Das'] }, { name: 'phone_number', values: ['+919876500301'] }] } })],
      [/C-777\?/, () => ({ body: { id: 'C-777', name: 'Diwali Health', effective_status: 'CAMPAIGN_PAUSED', start_time: '2026-10-20T00:00:00+0530', insights: { data: [{ spend: '1234.50', account_currency: 'INR' }] } } })],
      [/111\/leadgen_forms/, () => ({ body: { data: [] } })],
    ]);
    const url = (await A.post('/campaigns/oauth/meta/start', {})).body.data.url as string;
    const cb = await request(app).get(`/v1/hooks/oauth/meta/callback?code=abc&state=${encodeURIComponent(new URL(url).searchParams.get('state')!)}`);
    const id = /connected=(cnx_[a-f0-9]+)/.exec(cb.headers.location ?? '')![1]!;
    await A.put(`/campaigns/connections/${id}/sources`, { ids: ['111'] });
    const body = JSON.stringify({ object: 'page', entry: [{ id: '111', changes: [{ field: 'leadgen', value: { leadgen_id: 'LEAD_9', page_id: '111', form_id: 'F9' } }] }] });
    await request(app).post('/v1/hooks/meta').set('Content-Type', 'application/json').set('X-Hub-Signature-256', `sha256=${createHmac('sha256', ENV.META_APP_SECRET).update(body).digest('hex')}`).send(body);
    let row = (await A.get('/campaigns?channel=META')).body.data[0];
    expect(row).toMatchObject({ name: 'Diwali Health', leads: 1, status: 'NOT_SYNCED_YET' });
    await A.post(`/campaigns/connections/${id}/sync-now`, {});
    row = (await A.get(`/campaigns/${row.id}`)).body.data;
    expect(row).toMatchObject({ status: 'PAUSED', spend: 1234.5, currency: 'INR', costPerLead: 1234.5, startedOn: '2026-10-20' });
    expect(row.leadsByAd).toEqual([{ adId: 'AD-1', name: 'Family ad', adSetName: 'Bengaluru', leads: 1 }]);
  });

  it('platform states map to Active, In review, Paused, Not approved, Ended', () => {
    expect(metaStatus({ effective_status: 'ACTIVE' }).status).toBe('ACTIVE');
    expect(metaStatus({ effective_status: 'ADSET_PAUSED' }).status).toBe('PAUSED');
    expect(metaStatus({ effective_status: 'PENDING_REVIEW' }).status).toBe('IN_REVIEW');
    expect(metaStatus({ effective_status: 'DISAPPROVED' })).toEqual({ status: 'NOT_APPROVED', reason: 'Disapproved by Meta' });
    expect(metaStatus({ effective_status: 'ACTIVE', stop_time: '2020-01-01T00:00:00+0000' }).status).toBe('ENDED');
    expect(googleStatus({ status: 'ENABLED', primaryStatus: 'LIMITED' })).toEqual({ status: 'ACTIVE', reason: 'Limited' });
    expect(googleStatus({ status: 'ENABLED', primaryStatus: 'NOT_ELIGIBLE' }).status).toBe('NOT_APPROVED');
    expect(googleStatus({ status: 'REMOVED' }).status).toBe('ENDED');
    expect(googleStatus({ status: 'ENABLED', primaryStatus: 'ELIGIBLE', endDate: '2020-01-01' }).status).toBe('ENDED');
  });
});