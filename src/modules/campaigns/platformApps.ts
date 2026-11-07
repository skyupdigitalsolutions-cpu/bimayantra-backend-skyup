/**
 * SkyUp's ad-platform apps (Meta, LinkedIn, Google), set up once by a SkyUp Admin on the Admin → Ad platform apps
 * screen instead of in .env. Every advisor then connects their own ads by signing in with their own Meta / LinkedIn /
 * Google account (the platforms require one approved app per product, not one per advisor).
 *
 * Secrets are stored encrypted (AES-256-GCM, lib/crypto). Values saved here win over the .env ones, which stay as a
 * fallback. Reads are synchronous from memory (platforms.ts); the instance that saves reloads at once, others within
 * 30 seconds, like feature switches.
 */
import type { Request } from 'express';
import { Schema, model } from 'mongoose';
import { decryptField, encryptField } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../audit/audit.service.js';
import { useStepUp } from '../auth/stepUp.js';
import type { AuthContext } from '../rbac/capabilities.js';

export const APP_CHANNELS = ['META', 'LINKEDIN', 'GOOGLE'] as const;
export type AppChannel = (typeof APP_CHANNELS)[number];

/** What each app needs; `env` is the .env fallback; secrets are never sent back in full. */
export const APP_FIELDS: Record<AppChannel, Array<{ key: string; label: string; secret: boolean; required: boolean; env: string; hint?: string }>> = {
  META: [
    { key: 'appId', label: 'App ID', secret: false, required: true, env: 'META_APP_ID', hint: 'Meta for Developers → your app → App settings → Basic' },
    { key: 'appSecret', label: 'App secret', secret: true, required: true, env: 'META_APP_SECRET', hint: 'Same page, "Show"' },
    { key: 'verifyToken', label: 'Webhook verify token', secret: true, required: true, env: 'META_VERIFY_TOKEN', hint: 'Any random text; type the same in Meta → Webhooks → Page' },
    { key: 'graphVersion', label: 'Graph API version', secret: false, required: false, env: 'META_GRAPH_VERSION', hint: 'e.g. v22.0' },
  ],
  LINKEDIN: [
    { key: 'clientId', label: 'Client ID', secret: false, required: true, env: 'LINKEDIN_CLIENT_ID', hint: 'LinkedIn Developers → your app → Auth' },
    { key: 'clientSecret', label: 'Client secret', secret: true, required: true, env: 'LINKEDIN_CLIENT_SECRET', hint: 'Same page' },
    { key: 'apiVersion', label: 'API version (YYYYMM)', secret: false, required: false, env: 'LINKEDIN_API_VERSION', hint: 'e.g. 202609' },
  ],
  GOOGLE: [
    { key: 'clientId', label: 'OAuth client ID', secret: false, required: true, env: 'GOOGLE_OAUTH_CLIENT_ID', hint: 'Google Cloud → APIs & Services → Credentials' },
    { key: 'clientSecret', label: 'OAuth client secret', secret: true, required: true, env: 'GOOGLE_OAUTH_CLIENT_SECRET' },
    { key: 'developerToken', label: 'Google Ads developer token', secret: true, required: true, env: 'GOOGLE_ADS_DEVELOPER_TOKEN', hint: 'Google Ads → Tools → API Center' },
    { key: 'loginCustomerId', label: 'Manager (MCC) customer ID', secret: false, required: false, env: 'GOOGLE_ADS_LOGIN_CUSTOMER_ID' },
    { key: 'apiVersion', label: 'Google Ads API version', secret: false, required: false, env: 'GOOGLE_ADS_API_VERSION', hint: 'e.g. v25' },
  ],
};

const PlatformApp = model('PlatformApp', new Schema({
  _id: { type: String, enum: APP_CHANNELS },
  /** key → "v1:…" encrypted value (every value is encrypted, secret or not, to keep one rule) */
  values: { type: Schema.Types.Mixed, default: {} },
  reason: { type: String, default: null },
  updatedBy: { type: String, default: null },
}, { timestamps: true, versionKey: false }), 'platform_apps');

const cache = new Map<AppChannel, Record<string, string>>();
const savedAt = new Map<AppChannel, { at: Date; by: string | null }>();

/** The value in force: the one saved by an Admin, else the .env value, else ''. */
export function appValue(channel: AppChannel, key: string): string {
  const v = cache.get(channel)?.[key];
  if (v) return v;
  const f = APP_FIELDS[channel].find((x) => x.key === key);
  return (f ? process.env[f.env] : undefined)?.trim() ?? '';
}

export async function loadPlatformApps() {
  const rows = await PlatformApp.find().lean<Array<{ _id: AppChannel; values?: Record<string, string>; updatedAt?: Date; updatedBy?: string | null }>>();
  cache.clear();
  savedAt.clear();
  for (const r of rows) {
    const out: Record<string, string> = {};
    for (const [k, enc] of Object.entries(r.values ?? {})) {
      try { if (enc) out[k] = decryptField(enc); } catch (err) { logger.warn({ err, channel: r._id, key: k }, 'Could not decrypt an ad-platform app value; using .env for it'); }
    }
    cache.set(r._id, out);
    if (r.updatedAt) savedAt.set(r._id, { at: r.updatedAt, by: r.updatedBy ?? null });
  }
}
let timer: NodeJS.Timeout | undefined;
export function startPlatformAppRefresh() {
  timer ??= setInterval(() => { loadPlatformApps().catch((err) => logger.warn({ err }, 'Ad-platform app refresh failed; keeping current values')); }, 30_000);
  timer.unref();
}
export function stopPlatformAppRefresh() { if (timer) clearInterval(timer); timer = undefined; }

const api = () => process.env.PUBLIC_API_URL ?? 'http://localhost:4000';
const app = () => process.env.PUBLIC_APP_URL ?? 'http://localhost:5173';
const mask = (v: string) => (v.length <= 4 ? '••••' : `••••${v.slice(-4)}`);

/** Admin view: what is set (secrets masked), where it comes from, and the URLs to paste into each developer app. */
export function view(channel: AppChannel) {
  const own = cache.get(channel) ?? {};
  const fields = APP_FIELDS[channel].map((f) => {
    const v = appValue(channel, f.key);
    return { key: f.key, label: f.label, hint: f.hint ?? null, secret: f.secret, required: f.required, set: !!v, value: v ? (f.secret ? mask(v) : v) : null, from: own[f.key] ? 'SETTINGS' : v ? 'ENV' : null };
  });
  const urls: Array<{ label: string; value: string; where: string }> = [{ label: 'OAuth redirect URL', value: `${api()}/v1/hooks/oauth/${channel.toLowerCase()}/callback`, where: channel === 'META' ? 'Facebook Login for Business → Settings → Valid OAuth Redirect URIs' : channel === 'LINKEDIN' ? 'Auth → Authorized redirect URLs' : 'Credentials → OAuth client → Authorized redirect URIs' }];
  if (channel === 'META') urls.push({ label: 'Webhook callback URL (Page → leadgen)', value: `${api()}/v1/hooks/meta`, where: 'Webhooks → Page → Subscribe to "leadgen", with the verify token above' });
  if (channel === 'LINKEDIN') urls.push({ label: 'Lead notification webhook', value: `${api()}/v1/hooks/linkedin`, where: 'Registered for each advisor automatically when they choose an ad account' });
  if (channel === 'GOOGLE') urls.push({ label: 'Lead form webhook', value: `${api()}/v1/hooks/google`, where: 'Each advisor pastes it, with their own key, into their Google Ads lead form' });
  urls.push({ label: 'App domain / site URL', value: app(), where: channel === 'META' ? 'App settings → Basic → App domains and Website' : 'Where your app is described' });
  return {
    channel, configured: APP_FIELDS[channel].filter((f) => f.required).every((f) => !!appValue(channel, f.key)),
    fields, urls, lastSaved: savedAt.get(channel) ?? null,
  };
}
export const list = () => APP_CHANNELS.map(view);

/**
 * Save an app's details (ADM, OTP). For each field: a non-empty string replaces it, null clears the saved value
 * (the .env value, if any, applies again), a missing key or '' keeps it.
 */
export async function save(ctx: AuthContext, channel: string, b: { values: Record<string, string | null>; reason: string }, req: Request) {
  const ch = String(channel).toUpperCase() as AppChannel;
  if (!APP_CHANNELS.includes(ch)) throw AppError.notFound();
  const known = new Set(APP_FIELDS[ch].map((f) => f.key));
  const row = await PlatformApp.findById(ch).lean<{ values?: Record<string, string> }>();
  const values = { ...(row?.values ?? {}) };
  const changed: string[] = [];
  for (const [k, v] of Object.entries(b.values ?? {})) {
    if (!known.has(k)) throw AppError.field(`values.${k}`, 'VAL-22');
    if (v === null) { if (values[k]) { delete values[k]; changed.push(k); } continue; }
    const t = String(v).trim();
    if (!t) continue;
    if (t.length > 500) throw AppError.field(`values.${k}`, 'VAL-22');
    values[k] = encryptField(t);
    changed.push(k);
  }
  await PlatformApp.updateOne({ _id: ch }, { $set: { values, reason: b.reason, updatedBy: ctx.userId } }, { upsert: true });
  // never the values themselves in the audit log: only which fields changed
  await audit({ entity: 'platformApp', entityId: ch, action: 'PLATFORM_APP_CHANGED', after: { fields: changed, reason: b.reason, stepUpId: req.stepUpId ?? null } }, { req });
  await useStepUp(req.stepUpId, 'PLATFORM_APP_CHANGED', null);
  await loadPlatformApps();
  return view(ch);
}