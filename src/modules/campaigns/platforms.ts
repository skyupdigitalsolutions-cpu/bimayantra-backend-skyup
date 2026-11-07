/**
 * Meta (Graph API) and LinkedIn (Lead Sync API) clients. Credentials are read from the environment when used, so the
 * channels switch on as soon as the client's approved app details are added (no deploy needed beyond the .env).
 * Errors that mean "sign in again" are raised as ReconnectNeeded.
 */
import { appValue } from './platformApps.js';

export class ReconnectNeeded extends Error {}
export class PlatformError extends Error {}

// App details: saved by a SkyUp Admin (Admin → Ad platform apps, platformApps.ts), else from .env
export const metaConfig = () => ({ appId: appValue('META', 'appId'), appSecret: appValue('META', 'appSecret'), verifyToken: appValue('META', 'verifyToken'), version: appValue('META', 'graphVersion') || 'v22.0' });
export const googleConfig = () => ({ clientId: appValue('GOOGLE', 'clientId'), clientSecret: appValue('GOOGLE', 'clientSecret'), developerToken: appValue('GOOGLE', 'developerToken'), loginCustomerId: appValue('GOOGLE', 'loginCustomerId').replace(/-/g, ''), version: appValue('GOOGLE', 'apiVersion') || 'v25' });
export const linkedinConfig = () => ({ clientId: appValue('LINKEDIN', 'clientId'), clientSecret: appValue('LINKEDIN', 'clientSecret'), version: appValue('LINKEDIN', 'apiVersion') || '202609' });
export const isConfigured = (channel: 'META' | 'LINKEDIN' | 'GOOGLE') => (channel === 'META' ? !!(metaConfig().appId && metaConfig().appSecret && metaConfig().verifyToken) : channel === 'GOOGLE' ? !!(googleConfig().clientId && googleConfig().clientSecret && googleConfig().developerToken) : !!(linkedinConfig().clientId && linkedinConfig().clientSecret));
export const redirectUri = (channel: 'META' | 'LINKEDIN' | 'GOOGLE') => `${process.env.PUBLIC_API_URL ?? 'http://localhost:4000'}/v1/hooks/oauth/${channel.toLowerCase()}/callback`;

async function call(url: string, init: RequestInit & { channel: 'META' | 'LINKEDIN' | 'GOOGLE' }) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await r.text();
  let j: Record<string, any> = {};
  try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text.slice(0, 200) }; }
  if (r.ok) return { json: j, headers: r.headers };
  const code = j?.error?.code;
  if ((init.channel === 'META' && (code === 190 || code === 102 || r.status === 401)) || (init.channel === 'LINKEDIN' && (r.status === 401 || r.status === 403 && /token|expired|revoked/i.test(text))) || (init.channel === 'GOOGLE' && (r.status === 401 || j?.error === 'invalid_grant'))) throw new ReconnectNeeded(j?.error?.message ?? j?.message ?? `HTTP ${r.status}`);
  throw new PlatformError(j?.error?.message ?? j?.message ?? `HTTP ${r.status}`);
}

// ── Meta ──
const graph = (path: string) => `https://graph.facebook.com/${metaConfig().version}/${path}`;
const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();
export const meta = {
  authUrl: (state: string) => `https://www.facebook.com/${metaConfig().version}/dialog/oauth?${qs({ client_id: metaConfig().appId, redirect_uri: redirectUri('META'), state, response_type: 'code',
    scope: 'leads_retrieval,pages_show_list,pages_read_engagement,pages_manage_metadata,pages_manage_ads,ads_read,business_management' })}`,
  /** code → short-lived token → long-lived user token (Page tokens made from it do not expire on their own). */
  async exchange(code: string) {
    const c = metaConfig();
    const short = (await call(`${graph('oauth/access_token')}?${qs({ client_id: c.appId, client_secret: c.appSecret, redirect_uri: redirectUri('META'), code })}`, { channel: 'META' })).json;
    const long = (await call(`${graph('oauth/access_token')}?${qs({ grant_type: 'fb_exchange_token', client_id: c.appId, client_secret: c.appSecret, fb_exchange_token: String(short.access_token) })}`, { channel: 'META' })).json;
    return { token: String(long.access_token ?? short.access_token), expiresIn: Number(long.expires_in ?? 0) || null };
  },
  async pages(userToken: string) {
    const j = (await call(`${graph('me/accounts')}?${qs({ fields: 'id,name,access_token', limit: '100', access_token: userToken })}`, { channel: 'META' })).json;
    return ((j.data ?? []) as Array<{ id: string; name: string; access_token: string }>).map((p) => ({ id: String(p.id), name: String(p.name), token: String(p.access_token) }));
  },
  subscribe: (pageId: string, pageToken: string) => call(`${graph(`${pageId}/subscribed_apps`)}?${qs({ subscribed_fields: 'leadgen', access_token: pageToken })}`, { channel: 'META', method: 'POST' }),
  /** Manual connections: check a pasted Page ID + Page token and read the Page's name. */
  async page(pageId: string, pageToken: string) {
    const j = (await call(`${graph(encodeURIComponent(pageId))}?${qs({ fields: 'id,name', access_token: pageToken })}`, { channel: 'META' })).json;
    return { id: String(j.id ?? pageId), name: String(j.name ?? pageId) };
  },
  async forms(pageId: string, pageToken: string) {
    const j = (await call(`${graph(`${pageId}/leadgen_forms`)}?${qs({ fields: 'id,name,status', limit: '100', access_token: pageToken })}`, { channel: 'META' })).json;
    return ((j.data ?? []) as Array<{ id: string; name: string; status: string }>).map((f) => ({ id: String(f.id), name: String(f.name), status: String(f.status ?? '') }));
  },
  /** One lead with its answers and ad attribution (ported from the previous CRM). */
  lead: async (leadgenId: string, pageToken: string) => (await call(`${graph(leadgenId)}?${qs({ fields: 'id,created_time,field_data,form_id,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,is_organic,platform', access_token: pageToken })}`, { channel: 'META' })).json,
  /** Catch-up: the form's leads created after `since` (seconds). */
  async formLeads(formId: string, pageToken: string, sinceSec: number) {
    const j = (await call(`${graph(`${formId}/leads`)}?${qs({ fields: 'id,created_time,field_data,form_id,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,is_organic', limit: '100', filtering: JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: sinceSec }]), access_token: pageToken })}`, { channel: 'META' })).json;
    return (j.data ?? []) as Array<Record<string, any>>;
  },
};
/** Meta field_data → answers (values joined; the field name is the key). */
export const metaAnswers = (lead: Record<string, any>) => ((lead.field_data ?? []) as Array<{ name: string; values?: string[] }>).slice(0, 100).map((f) => ({ key: String(f.name).slice(0, 80), label: String(f.name).replace(/_/g, ' ').slice(0, 120), value: (f.values ?? []).join(', ').slice(0, 2000) }));

// ── LinkedIn ──
const li = (path: string) => `https://api.linkedin.com/rest/${path}`;
const liHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, 'LinkedIn-Version': linkedinConfig().version, 'X-Restli-Protocol-Version': '2.0.0', 'Content-Type': 'application/json' });
export const linkedin = {
  authUrl: (state: string) => `https://www.linkedin.com/oauth/v2/authorization?${qs({ response_type: 'code', client_id: linkedinConfig().clientId, redirect_uri: redirectUri('LINKEDIN'), state, scope: 'r_marketing_leadgen_automation r_ads' })}`,
  async exchange(code: string) {
    const c = linkedinConfig();
    const j = (await call('https://www.linkedin.com/oauth/v2/accessToken', { channel: 'LINKEDIN', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: qs({ grant_type: 'authorization_code', code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: redirectUri('LINKEDIN') }) })).json;
    return { token: String(j.access_token), expiresIn: Number(j.expires_in ?? 0) || null };
  },
  /** The ad accounts this person can see (owners for lead notifications). */
  async adAccounts(token: string) {
    const j = (await call(`${li('adAccountUsers')}?q=authenticatedUser`, { channel: 'LINKEDIN', headers: liHeaders(token) })).json;
    return ((j.elements ?? []) as Array<{ account: string; role?: string }>).map((e) => ({ id: String(e.account), name: String(e.account).split(':').pop() ?? String(e.account), role: e.role ?? null }));
  },
  /** An owner-level lead notification subscription (LinkedIn's recommendation), to our validated HTTPS webhook. */
  subscribe: (accountUrn: string, token: string, webhook?: string) => call(li('leadNotifications'), { channel: 'LINKEDIN', method: 'POST', headers: liHeaders(token), body: JSON.stringify({
    webhook: webhook ?? `${process.env.PUBLIC_API_URL ?? ''}/v1/hooks/linkedin`,
    // ad accounts receive SPONSORED leads; an organization (Company Page) receives ORGANIZATION_PRODUCT leads
    ...(accountUrn.startsWith('urn:li:organization:') ? { owner: { organization: accountUrn }, leadType: 'ORGANIZATION_PRODUCT' } : { owner: { sponsoredAccount: accountUrn }, leadType: 'SPONSORED' }),
  }) }),
  response: async (responseUrn: string, token: string) => (await call(`${li(`leadFormResponses/${encodeURIComponent(responseUrn)}`)}?fields=id,submittedAt,testLead,formResponse,versionedLeadGenFormUrn,owner,leadMetadataInfo,form:(name,id,content)`, { channel: 'LINKEDIN', headers: liHeaders(token) })).json,
  /** Catch-up: an owner's responses submitted after `sinceMs`. */
  async responses(accountUrn: string, token: string, sinceMs: number) {
    const q = `q=owner&owner=(sponsoredAccount:${encodeURIComponent(accountUrn)})&leadType=(leadType:SPONSORED)&submittedAtTimeRange=(start:${sinceMs},end:${Date.now()})&fields=id,submittedAt,testLead,formResponse,versionedLeadGenFormUrn,form:(name,id,content)`;
    return (((await call(`${li('leadFormResponses')}?${q}`, { channel: 'LINKEDIN', headers: liHeaders(token) })).json.elements ?? []) as Array<Record<string, any>>);
  },
};
/** LinkedIn answers: each answer joined to its question; standard questions keep their predefined field as the key. */
export function linkedinAnswers(r: Record<string, any>) {
  const questions = new Map(((r.form?.content?.questions ?? []) as Array<Record<string, any>>).map((q) => [String(q.questionId), q]));
  return ((r.formResponse?.answers ?? []) as Array<Record<string, any>>).slice(0, 100).map((a) => {
    const q = questions.get(String(a.questionId)) ?? {};
    const d = a.answerDetails ?? {};
    const value = d.textQuestionAnswer?.answer ?? (Array.isArray(d.multipleChoiceAnswer?.options) ? d.multipleChoiceAnswer.options.join(', ') : '');
    const key = String(q.predefinedField ?? q.name ?? `question_${a.questionId}`).slice(0, 80);
    return { key, label: String(q.label ?? q.name ?? key).slice(0, 120), value: String(value).slice(0, 2000) };
  });
}

// ── Stage H: campaign status and spend ──
/** Meta effective_status → our platform status (Active, In review, Paused, Not approved, Ended). */
export function metaStatus(c: { effective_status?: string; stop_time?: string | null }): { status: 'ACTIVE' | 'IN_REVIEW' | 'PAUSED' | 'NOT_APPROVED' | 'ENDED'; reason: string | null } {
  const e = String(c.effective_status ?? '').toUpperCase();
  if (c.stop_time && Date.parse(c.stop_time) < Date.now()) return { status: 'ENDED', reason: 'Past its end date' };
  if (['DELETED', 'ARCHIVED'].includes(e)) return { status: 'ENDED', reason: e.toLowerCase() };
  if (['DISAPPROVED', 'WITH_ISSUES'].includes(e)) return { status: 'NOT_APPROVED', reason: e === 'WITH_ISSUES' ? 'Has issues to fix in Meta Ads Manager' : 'Disapproved by Meta' };
  if (['IN_PROCESS', 'PENDING_REVIEW', 'PREAPPROVED', 'PENDING_BILLING_INFO'].includes(e)) return { status: 'IN_REVIEW', reason: e === 'PENDING_BILLING_INFO' ? 'Waiting for billing details' : null };
  if (e.includes('PAUSED')) return { status: 'PAUSED', reason: null };
  return { status: 'ACTIVE', reason: null };
}
export const metaCampaigns = {
  /** One campaign: name, delivery status, dates, and lifetime spend with the ad account's currency. */
  get: async (campaignId: string, userToken: string) => (await call(`${graph(campaignId)}?${qs({ fields: 'id,name,effective_status,start_time,stop_time,insights.date_preset(maximum){spend,account_currency}', access_token: userToken })}`, { channel: 'META' })).json,
};

/** Google effective state: primary_status first (it reflects review and eligibility), then status, then end date. */
export function googleStatus(c: { status?: string; primaryStatus?: string; endDate?: string | null }): { status: 'ACTIVE' | 'IN_REVIEW' | 'PAUSED' | 'NOT_APPROVED' | 'ENDED'; reason: string | null } {
  const st = String(c.status ?? '').toUpperCase(); const ps = String(c.primaryStatus ?? '').toUpperCase();
  if (st === 'REMOVED' || ps === 'REMOVED' || ps === 'ENDED' || (c.endDate && c.endDate < new Date().toISOString().slice(0, 10))) return { status: 'ENDED', reason: null };
  if (st === 'PAUSED' || ps === 'PAUSED') return { status: 'PAUSED', reason: null };
  if (ps === 'PENDING') return { status: 'IN_REVIEW', reason: null };
  if (ps === 'NOT_ELIGIBLE') return { status: 'NOT_APPROVED', reason: 'Not eligible to serve' };
  return { status: 'ACTIVE', reason: ps === 'LIMITED' ? 'Limited' : null };
}
const gads = (path: string) => `https://googleads.googleapis.com/${googleConfig().version}/${path}`;
const gHeaders = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}`, 'developer-token': googleConfig().developerToken, 'Content-Type': 'application/json', ...(googleConfig().loginCustomerId ? { 'login-customer-id': googleConfig().loginCustomerId } : {}) });
export const google = {
  /** Sign in for campaign status and spend (leads keep arriving by the lead-form webhook). Offline access gives a refresh token. */
  authUrl: (state: string) => `https://accounts.google.com/o/oauth2/v2/auth?${qs({ client_id: googleConfig().clientId, redirect_uri: redirectUri('GOOGLE'), response_type: 'code', scope: 'https://www.googleapis.com/auth/adwords', access_type: 'offline', prompt: 'consent', state })}`,
  async exchange(code: string) {
    const c = googleConfig();
    const j = (await call('https://oauth2.googleapis.com/token', { channel: 'GOOGLE', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: qs({ grant_type: 'authorization_code', code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: redirectUri('GOOGLE') }) })).json;
    if (!j.refresh_token) throw new ReconnectNeeded('Google did not return offline access; sign in again');
    return { refreshToken: String(j.refresh_token), accessToken: String(j.access_token) };
  },
  /** Access tokens last about an hour: a fresh one per sync from the stored refresh token. */
  async access(refreshToken: string) {
    const c = googleConfig();
    return String((await call('https://oauth2.googleapis.com/token', { channel: 'GOOGLE', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: qs({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: c.clientId, client_secret: c.clientSecret }) })).json.access_token);
  },
  async customers(accessToken: string) {
    const j = (await call(gads('customers:listAccessibleCustomers'), { channel: 'GOOGLE', headers: gHeaders(accessToken) })).json;
    return ((j.resourceNames ?? []) as string[]).map((r) => { const id = r.split('/').pop()!; return { id, name: `Google Ads ${id.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3')}` }; });
  },
  /** Every campaign with status, dates, lifetime cost and the account currency (no date filter: all-time metrics). */
  async campaigns(customerId: string, accessToken: string) {
    const query = 'SELECT campaign.id, campaign.name, campaign.status, campaign.primary_status, campaign.start_date, campaign.end_date, metrics.cost_micros, customer.currency_code FROM campaign';
    const j = (await call(gads(`customers/${customerId}/googleAds:search`), { channel: 'GOOGLE', method: 'POST', headers: gHeaders(accessToken), body: JSON.stringify({ query }) })).json;
    return ((j.results ?? []) as Array<Record<string, any>>).map((r) => ({
      id: String(r.campaign?.id), name: String(r.campaign?.name ?? ''), status: r.campaign?.status, primaryStatus: r.campaign?.primaryStatus,
      startDate: r.campaign?.startDate ?? null, endDate: r.campaign?.endDate ?? null,
      spend: r.metrics?.costMicros !== undefined ? Math.round(Number(r.metrics.costMicros) / 10_000) / 100 : null, currency: r.customer?.currencyCode ?? null,
    }));
  },
};