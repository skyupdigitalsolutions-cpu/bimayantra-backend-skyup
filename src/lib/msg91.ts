/**
 * MSG91 (SMS_PROVIDER=msg91, WHATSAPP_PROVIDER=msg91). One auth key (header "authkey") for both.
 *
 * SMS (TRAI DLT): the OTP goes through MSG91's OTP API with our own code (we still create, hash and check it), so it
 * rides MSG91's priority OTP route. Other SMS (the mobile-change notice) use a Flow / SMS template with named variables.
 *
 * WhatsApp: business-initiated messages must use templates approved by Meta.
 *   - Our template body "Hi {name}, … {advisor name}" is sent to MSG91 as "Hi {{1}}, … {{2}}" (variables in order of
 *     first appearance) under a stable template name, and Meta's decision is read back by polling MSG91.
 *   - Sending fills body_1 … body_n from the message's parameters in the same order.
 *
 * Failures: 4xx (except 429) and MSG91 "error"/"hasError" answers are permanent (no retry); 429, 5xx and network errors
 * are temporary (the outbox retries).
 */
import { env } from '../config/env.js';

const BASE = 'https://control.msg91.com/api/v5';

export class Msg91Temporary extends Error {}
export class Msg91Permanent extends Error {}

async function call<T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { authkey: env.MSG91_AUTH_KEY ?? '', accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new Msg91Temporary(`MSG91 unreachable: ${(e as Error).message}`);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const why = String(json.message ?? json.errors ?? json.error ?? `MSG91 ${res.status}`);
  if (res.status === 429 || res.status >= 500) throw new Msg91Temporary(why);
  if (!res.ok || json.type === 'error' || json.hasError === true || json.status === 'fail') throw new Msg91Permanent(why);
  return json as T;
}

/** "+919876543210" | "9876543210" → "919876543210" (MSG91 wants the country code, no plus). */
export const msisdn = (mobile: string) => {
  const d = String(mobile).replace(/\D/g, '');
  return d.length === 10 ? `91${d}` : d;
};

/* ───────────────────────── SMS ───────────────────────── */

/** OTP via MSG91's OTP API, with our code and validity. The DLT template (with ##OTP##) is chosen in MSG91. */
export async function sendOtp(mobile: string, code: string, validMinutes: number, name = 'Customer') {
  const q = new URLSearchParams({ template_id: env.MSG91_OTP_TEMPLATE_ID ?? '', mobile: msisdn(mobile), otp: code, otp_expiry: String(validMinutes) });
  const r = await call<{ request_id?: string; message?: string }>('POST', `/otp?${q.toString()}`, { name });
  return { id: String(r.request_id ?? r.message ?? '') };
}

/** Any other DLT SMS through a Flow / SMS template; `vars` are the template's variable names and values. */
export async function sendFlowSms(templateId: string, mobile: string, vars: Record<string, string>) {
  const r = await call<{ message?: string }>('POST', '/flow', { template_id: templateId, short_url: '0', recipients: [{ mobiles: msisdn(mobile), ...vars }] });
  return { id: String(r.message ?? '') };
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
};
/** Transactional purposes are UTILITY; greetings are MARKETING (Meta's categories). */
const CATEGORY: Record<string, 'UTILITY' | 'MARKETING'> = { RENEWAL_REMINDER: 'UTILITY', QUOTATION_EMAIL: 'UTILITY', KYC_RESULT: 'UTILITY', SUBSCRIPTION: 'UTILITY', BIRTHDAY: 'MARKETING', FAMILY_BIRTHDAY: 'MARKETING', ANNIVERSARY: 'MARKETING' };

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
  const components = Object.fromEntries(variablesOf(o.body).map((v, i) => [`body_${i + 1}`, { type: 'text', value: String(o.params[v] ?? '').slice(0, 1000) || '-' }]));
  const r = await call<{ request_id?: string; data?: unknown }>('POST', '/whatsapp/whatsapp-outbound-message/bulk/', {
    integrated_number: msisdn(o.from),
    content_type: 'template',
    payload: {
      messaging_product: 'whatsapp',
      type: 'template',
      template: { name: o.templateName, language: { code: languageCode(o.language), policy: 'deterministic' }, to_and_components: [{ to: [msisdn(o.to)], components }] },
    },
  });
  return { id: String(r.request_id ?? '') };
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