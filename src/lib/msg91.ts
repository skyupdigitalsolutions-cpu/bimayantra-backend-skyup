/**
 * MSG91 (SMS_PROVIDER=msg91, WHATSAPP_PROVIDER=msg91). One auth key (header "authkey") for both.
 *
 * SMS (TRAI DLT): the OTP goes through MSG91's SMS (Flow) API with our own code (we still create, hash and check it).
 * Other SMS (the mobile-change notice) use a Flow / SMS template with named variables.
 *
 * WhatsApp: business-initiated messages must use templates approved by Meta.
 *   - Our template body "Hi {name}, … {advisor name}" is sent to MSG91 as "Hi {{1}}, … {{2}}" (variables in order of
 *     first appearance) under a stable template name, and Meta's decision is read back by polling MSG91.
 *   - Sending fills body_1 … body_n from the message's parameters in the same order.
 *
 * Failures: 4xx (except 429) and MSG91 "error"/"hasError" answers are permanent (no retry); 429, 5xx and network errors
 * are temporary (the outbox retries). Both error classes now carry `detail` — the path, HTTP status, round-trip time
 * and the first 1000 characters of MSG91's raw body — so a refused send can be read straight out of the logs instead
 * of being flattened into "MSG91 400".
 */
import { env } from '../config/env.js';
import { logger } from './logger.js';

const BASE = 'https://control.msg91.com/api/v5';

/** What MSG91 actually said, attached to every thrown error. */
export interface Msg91Detail {
  path: string;
  status: number | null;
  ms: number;
  body: string;
}

export class Msg91Temporary extends Error {
  constructor(message: string, readonly detail?: Msg91Detail) { super(message); }
}
export class Msg91Permanent extends Error {
  constructor(message: string, readonly status = 400, readonly detail?: Msg91Detail) { super(message); }
}

/**
 * An advisor's own MSG91 account (Settings → Integrations). Without it, SkyUp's account from the environment is used.
 * namespace: optional WhatsApp namespace some MSG91 accounts need on template messages.
 */
export interface Msg91Creds { authKey: string; number: string; namespace?: string | null }

/** MSG91 puts the reason in different keys and sometimes as an object; render whichever is there. */
const describe = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
};

async function call<T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown, authKey?: string): Promise<T> {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { authkey: authKey ?? env.MSG91_AUTH_KEY ?? '', accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new Msg91Temporary(`MSG91 unreachable: ${(e as Error).message}`, { path, status: null, ms: Date.now() - started, body: '' });
  }

  // Read as text first: a non-JSON answer (an HTML error page, an empty body) is then still visible in the log.
  const raw = await res.text().catch(() => '');
  let json: Record<string, unknown> = {};
  if (raw) { try { json = JSON.parse(raw) as Record<string, unknown>; } catch { /* keep the raw text in `detail` */ } }

  const detail: Msg91Detail = { path, status: res.status, ms: Date.now() - started, body: raw.slice(0, 1000) };
  logger.debug({ msg91: detail }, 'MSG91 response');

  const why = describe(json.message ?? json.errors ?? json.error) || `MSG91 ${res.status}`;
  if (res.status === 429 || res.status >= 500) throw new Msg91Temporary(why, detail);
  if (!res.ok || json.type === 'error' || json.hasError === true || json.status === 'fail') {
    throw new Msg91Permanent(why, res.ok ? 400 : res.status, detail);
  }
  return json as T;
}

/** "+919876543210" | "9876543210" → "919876543210" (MSG91 wants the country code, no plus). */
export const msisdn = (mobile: string) => {
  const d = String(mobile).replace(/\D/g, '');
  return d.length === 10 ? `91${d}` : d;
};

/* ───────────────────────── SMS ───────────────────────── */

/**
 * OTP through the SMS (Flow) API with the DLT-verified SMS template MSG91_OTP_TEMPLATE_ID.
 *
 * IMPORTANT: this must be a template from MSG91 → SMS → Templates, NOT one from MSG91's OTP section. The /flow
 * endpoint refuses OTP-section template IDs. (MSG91's separate OTP API has the mirror-image problem: it answers
 * "success" for an SMS template ID and then drops the message without any log, which is how codes silently went
 * missing.) The template text carries the variables ##otp## and ##name##, for example
 * "Dear ##name##, your OTP for Skyup login is ##otp##. Valid for 10 min…".
 *
 * Variable names are case-sensitive and must match the template exactly: a template written with ##OTP## needs the
 * recipient key `OTP`, not `otp`. MSG91_OTP_VAR_OTP / MSG91_OTP_VAR_NAME override the keys without a code change.
 *
 * realTimeResponse=1: MSG91 answers with the real outcome, so a bad template or DLT problem is an error here (AUTH-13)
 * instead of a "sent" screen with no SMS. It also means the request can take ten seconds or more — the caller's
 * timeout must allow for that.
 */
export async function sendOtp(mobile: string, code: string, name: string) {
  const otpKey = env.MSG91_OTP_VAR_OTP ?? 'otp';
  const nameKey = env.MSG91_OTP_VAR_NAME ?? 'name';
  const r = await call<{ request_id?: string; message?: unknown }>('POST', '/flow', {
    template_id: env.MSG91_OTP_TEMPLATE_ID ?? '',
    short_url: '0',
    realTimeResponse: '1',
    recipients: [{
      mobiles: msisdn(mobile),
      // DLT variables are short (30 characters is the common limit): a long name must not get the SMS rejected.
      [otpKey]: code,
      [nameKey]: (name.trim() || 'User').slice(0, 30),
    }],
  });
  return { id: String(r.request_id ?? describe(r.message) ?? '') };
}

/** Any other DLT SMS through a Flow / SMS template; `vars` are the template's variable names and values. */
export async function sendFlowSms(templateId: string, mobile: string, vars: Record<string, string>) {
  const r = await call<{ message?: unknown }>('POST', '/flow', { template_id: templateId, short_url: '0', recipients: [{ mobiles: msisdn(mobile), ...vars }] });
  return { id: describe(r.message) };
}

/* ───────────────────────── WhatsApp ───────────────────────── */

const LANG: Record<string, string> = { english: 'en', hindi: 'hi', kannada: 'kn', telugu: 'te', tamil: 'ta', marathi: 'mr', malayalam: 'ml', bengali: 'bn', gujarati: 'gu' };
export const languageCode = (language?: string | null) => LANG[String(language ?? 'English').trim().toLowerCase()] ?? 'en';

/** Variables in order of first appearance: "Hi {name}, {product} … {name}" → ["name", "product"]. */
export function variablesOf(body: string) {
  const out: string[] = [];
  for (const m of body.matchAll(/\{([^{}]+)\}/g)) if (!out.includes(m[1]!.trim())) out.push(m[1]!.trim());
  return out;
}
/** Our "{name}" placeholders → Meta's numbered "{{1}}". */
export function toMetaBody(body: string) {
  const vars = variablesOf(body);
  return body.replace(/\{([^{}]+)\}/g, (_m, v: string) => `{{${vars.indexOf(v.trim()) + 1}}}`);
}
/** Meta template names: lowercase letters, digits and underscores; unique per template version. */
export function templateNameFor(t: { _id: string; code?: string | null; name: string; version?: number | null }) {
  const base = String(t.code || t.name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'template';
  return `bmy_${base}_${String(t._id).slice(-6).toLowerCase()}_v${t.version ?? 1}`;
}

const SAMPLE: Record<string, string> = {
  name: 'Meena', 'customer name': 'Meena Iyer', 'customer first name': 'Meena', 'member name': 'Arjun', 'advisor name': 'Asha Rao',
  'advisor mobile': '9876543210', product: 'Family Shield', 'policy last 4': '4821', 'renewal date': '12-12-2026', link: 'https://app.bimayantra.in/q/abc',
  'quotation number': 'QT-202611-00012 R1', plan: 'Premium', date: '12-12-2026', result: 'verified',
  'follow-up date': '12-12-2026', 'follow-up time': '11:30 AM',
};
/** Transactional purposes are UTILITY; greetings are MARKETING (Meta's categories). */
const CATEGORY: Record<string, 'UTILITY' | 'MARKETING'> = { LEAD_WELCOME: 'UTILITY', FOLLOW_UP: 'UTILITY', RENEWAL_REMINDER: 'UTILITY', QUOTATION_EMAIL: 'UTILITY', KYC_RESULT: 'UTILITY', SUBSCRIPTION: 'UTILITY', BIRTHDAY: 'MARKETING', FAMILY_BIRTHDAY: 'MARKETING', ANNIVERSARY: 'MARKETING' };

/** Create the template in MSG91 for Meta's review (it is attached to the integrated number's WhatsApp business account). */
export async function submitWhatsAppTemplate(t: { _id: string; code?: string | null; name: string; version?: number | null; body: string; language?: string | null; purpose: string }) {
  const name = templateNameFor(t);
  const vars = variablesOf(t.body);
  await call('POST', '/whatsapp/client-panel-template/', {
    integrated_number: msisdn(env.MSG91_WA_NUMBER ?? ''),
    template_name: name,
    language: languageCode(t.language),
    category: CATEGORY[t.purpose] ?? 'UTILITY',
    button_url: false,
    components: [{ type: 'BODY', text: toMetaBody(t.body), ...(vars.length ? { example: { body_text: [vars.map((v) => SAMPLE[v] ?? v)] } } : {}) }],
  });
  return { name };
}

/** Meta's decision for one template as MSG91 reports it: APPROVED, REJECTED (with reason) or PENDING. */
export async function whatsAppTemplateStatus(name: string, language?: string | null): Promise<{ status: 'APPROVED' | 'REJECTED' | 'PENDING'; reason?: string }> {
  const q = new URLSearchParams({ template_name: name, template_language: languageCode(language) });
  const r = await call<Record<string, unknown>>('GET', `/whatsapp/get-template-client/${msisdn(env.MSG91_WA_NUMBER ?? '')}?${q.toString()}`);
  const list = (Array.isArray(r.data) ? r.data : Array.isArray((r.data as { data?: unknown })?.data) ? (r.data as { data: unknown[] }).data : []) as Array<Record<string, unknown>>;
  const item = list.find((x) => String(x.name ?? x.template_name ?? '') === name);
  if (!item) return { status: 'PENDING' };
  const langs = (Array.isArray(item.languages) ? item.languages : []) as Array<Record<string, unknown>>;
  const lang = langs.find((l) => String(l.language ?? l.code ?? '') === languageCode(language)) ?? langs[0] ?? item;
  const s = String(lang.status ?? item.status ?? '').toUpperCase();
  if (s === 'APPROVED') return { status: 'APPROVED' };
  if (s === 'REJECTED' || s === 'DISABLED' || s === 'PAUSED') return { status: 'REJECTED', reason: String(lang.rejection_reason ?? lang.reason ?? item.rejection_reason ?? s) };
  return { status: 'PENDING' };
}

/** Send one template message. `from` is the integrated number (an advisor's dedicated number, or SkyUp's). */
export async function sendWhatsAppTemplate(o: { from: string; to: string; templateName: string; language?: string | null; body: string; params: Record<string, unknown> }) {
  return sendTemplateValues({ from: o.from, to: o.to, templateName: o.templateName, languageCode: languageCode(o.language), values: variablesOf(o.body).map((v) => String(o.params[v] ?? '')) });
}

/**
 * Send a template by position: values[0] fills {{1}}, values[1] fills {{2}} … Used for an advisor's own MSG91 templates,
 * whose blanks the advisor matched to our values in Settings → Message templates. `creds` = the advisor's account.
 */
export async function sendTemplateValues(o: { from: string; to: string; templateName: string; languageCode: string; values: string[]; creds?: Msg91Creds | null }) {
  const components = Object.fromEntries(o.values.map((v, i) => [`body_${i + 1}`, { type: 'text', value: String(v ?? '').slice(0, 1000) || '-' }]));
  const template: Record<string, unknown> = { name: o.templateName, language: { code: o.languageCode || 'en', policy: 'deterministic' }, to_and_components: [{ to: [msisdn(o.to)], components }] };
  if (o.creds?.namespace) template.namespace = o.creds.namespace;
  const r = await call<{ request_id?: string; data?: unknown }>('POST', '/whatsapp/whatsapp-outbound-message/bulk/', {
    integrated_number: msisdn(o.creds?.number ?? o.from),
    content_type: 'template',
    payload: { messaging_product: 'whatsapp', type: 'template', template },
  }, o.creds?.authKey);
  return { id: String(r.request_id ?? '') };
}

/* ───────────────────────── An advisor's own MSG91 account ───────────────────────── */

/** One WhatsApp template as it is in the advisor's MSG91 account. */
export interface OwnTemplate {
  name: string; language: string; status: 'APPROVED' | 'PENDING' | 'REJECTED' | 'PAUSED' | string; category: string | null;
  body: string; blanks: number; headerFormat: string | null; supported: boolean;
}
const normStatus = (raw: unknown) => {
  const v = String(raw ?? '').trim().toUpperCase();
  if (['ENABLED', 'APPROVED', 'ACTIVE', 'LIVE'].includes(v)) return 'APPROVED';
  if (['PENDING', 'IN_APPEAL', 'PENDING_REVIEW', 'SUBMITTED'].includes(v)) return 'PENDING';
  if (['REJECTED', 'REFUSED', 'FLAGGED', 'DISABLED_BY_META'].includes(v)) return 'REJECTED';
  if (['PAUSED', 'DISABLED', 'INACTIVE', 'ARCHIVED'].includes(v)) return 'PAUSED';
  return v || 'PENDING';
};
/** The number of different blanks {{1}}, {{2}} … in a template body. */
export const blanksIn = (body: string) => new Set([...String(body).matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => m[1])).size;
/** MSG91 answers in several shapes ({ data: [...] }, { data: { data: [...] } }, [...]); find the template list. */
function templateArray(r: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(r)) return r as Array<Record<string, unknown>>;
  const o = (r ?? {}) as Record<string, unknown>;
  for (const k of ['data', 'templates', 'result', 'response']) {
    const v = o[k];
    if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
    if (v && typeof v === 'object') { const inner = templateArray(v); if (inner.length) return inner; }
  }
  return [];
}

/** Every template on the advisor's integrated number, one row per language. Throws Msg91Permanent / Msg91Temporary. */
export async function listOwnTemplates(creds: Msg91Creds): Promise<OwnTemplate[]> {
  const r = await call<Record<string, unknown>>('GET', `/whatsapp/get-template-client/${msisdn(creds.number)}`, undefined, creds.authKey);
  const out: OwnTemplate[] = [];
  for (const t of templateArray(r)) {
    const name = String(t.name ?? t.template_name ?? '').trim();
    if (!name) continue;
    const langs = (Array.isArray(t.languages) && t.languages.length ? t.languages : [t]) as Array<Record<string, unknown>>;
    for (const l of langs) {
      const comps = (Array.isArray(l.code) ? l.code : Array.isArray(l.components) ? l.components : Array.isArray(t.components) ? t.components : []) as Array<Record<string, unknown>>;
      const kind = (c: Record<string, unknown>) => String(c.type ?? c.component_type ?? '').toUpperCase();
      const bodyC = comps.find((c) => kind(c) === 'BODY');
      const header = comps.find((c) => kind(c) === 'HEADER');
      const body = String(bodyC?.text ?? l.body ?? t.body ?? '');
      const headerFormat = header ? String(header.format ?? 'TEXT').toUpperCase() : null;
      const headerText = String(header?.text ?? '');
      out.push({
        name, language: String(l.language ?? l.code_language ?? t.language ?? 'en'), status: normStatus(l.status ?? t.status),
        category: (l.category ?? t.category ?? null) as string | null, body, blanks: blanksIn(body), headerFormat,
        // Media headers (image, document, video) and text headers with a blank need values we do not have.
        supported: !headerFormat || (headerFormat === 'TEXT' && blanksIn(headerText) === 0),
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Check an advisor's MSG91 key and number before saving them. MSG91 answers 401 for a wrong key; any other refusal
 * means the number is not integrated on that account.
 */
export async function checkOwnAccount(creds: Msg91Creds): Promise<{ ok: true; templates: number } | { ok: false; reason: 'KEY' | 'NUMBER' | 'UNREACHABLE'; detail: string }> {
  try {
    const t = await listOwnTemplates(creds);
    return { ok: true, templates: t.length };
  } catch (e) {
    if (e instanceof Msg91Temporary) return { ok: false, reason: 'UNREACHABLE', detail: e.message };
    const m = (e as Msg91Permanent).message ?? '';
    const keyProblem = (e as Msg91Permanent).status === 401 || (e as Msg91Permanent).status === 403 || /auth|unauthori[sz]ed|invalid.*key|authkey/i.test(m);
    return { ok: false, reason: keyProblem ? 'KEY' : 'NUMBER', detail: m };
  }
}

/**
 * Quick self-test for the SMS path: posts the OTP template to one number and returns MSG91's own words either way.
 * Used by the dev/diagnostics route so a misconfigured template can be found without reading the API logs.
 */
export async function probeOtpTemplate(mobile: string): Promise<{ ok: true; id: string; ms: number } | { ok: false; kind: 'TEMPORARY' | 'PERMANENT'; message: string; detail?: Msg91Detail }> {
  const started = Date.now();
  try {
    const { id } = await sendOtp(mobile, '123456', 'Test');
    return { ok: true, id, ms: Date.now() - started };
  } catch (e) {
    const temporary = e instanceof Msg91Temporary;
    return { ok: false, kind: temporary ? 'TEMPORARY' : 'PERMANENT', message: (e as Error).message, detail: (e as Msg91Temporary | Msg91Permanent).detail };
  }
}

/**
 * MSG91 WhatsApp webhook payload → our message event. MSG91 sends delivery reports and inbound messages to the URL set
 * in its panel; the field names vary between report types, so the common ones are all read here.
 */
export function msg91Event(b: Record<string, unknown>) {
  const pick = (...k: string[]) => { for (const x of k) { const v = b[x]; if (v !== undefined && v !== null && v !== '') return String(v); } return ''; };
  const requestId = pick('requestId', 'request_id', 'requestid', 'uuid', 'messageId', 'message_id');
  const status = pick('status', 'eventName', 'event', 'messageStatus').toLowerCase();
  const direction = pick('direction', 'type').toLowerCase();
  const text = pick('text', 'content', 'message', 'body').trim();
  const from = pick('customerNumber', 'customer_number', 'from', 'sender', 'mobile');
  const at = pick('ts', 'timestamp', 'date', 'sentTime', 'deliveryTime', 'readTime');
  if ((direction.includes('in') || (!requestId && text)) && from && /^(stop|unsubscribe|stop all)$/i.test(text)) {
    return { eventId: `in|${from}|${at || text}`, type: 'STOP' as const, from };
  }
  if (!requestId) return null;
  const eventId = `${requestId}|${status}|${at}`;
  if (['delivered'].includes(status)) return { eventId, type: 'STATUS' as const, providerMessageId: requestId, status: 'DELIVERED' as const };
  if (['read', 'seen'].includes(status)) return { eventId, type: 'STATUS' as const, providerMessageId: requestId, status: 'READ' as const };
  if (['failed', 'rejected', 'undelivered', 'error'].includes(status)) return { eventId, type: 'STATUS' as const, providerMessageId: requestId, status: 'FAILED' as const, reason: pick('reason', 'failureReason', 'error', 'description') || 'Failed at WhatsApp' };
  return null; // sent / queued: no change
}
