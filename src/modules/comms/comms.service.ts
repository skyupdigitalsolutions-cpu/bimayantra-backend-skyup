import type { Request } from 'express';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { cfgNum, cfgRange } from '../../config/cfg.js';
import { env } from '../../config/env.js';
import { clock, istToday } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { msg } from '../../lib/messages.js';
import { isDuplicateKey, withTx } from '../../lib/mongo.js';
import { normalizeMobile } from '../../lib/phone.js';
import { logger } from '../../lib/logger.js';
import { Account } from '../accounts/account.model.js';
import { audit } from '../audit/audit.service.js';
import { Consent, Customer, FamilyMember } from '../customers/customer.model.js';
import { notify, notifySkyUp } from '../notifications/notifications.service.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { User } from '../users/user.model.js';
import { JobRun } from '../renewals/renewal.model.js';
import { BouncedAddress, MessageTemplate, Outbox, WalletTxn, WebhookEvent, type OutboxDoc, type TemplateRow } from './outbox.model.js';
import { BrevoPermanent, brevoEvent, sendEmail } from './brevo.js';
import * as rzp from '../../lib/razorpay.js';
import * as msg91 from '../../lib/msg91.js';

type Channel = 'EMAIL' | 'WHATSAPP';
const AUTOMATED_WA = ['RENEWAL_REMINDER', 'BIRTHDAY', 'FAMILY_BIRTHDAY', 'ANNIVERSARY'];
const GREETINGS = ['BIRTHDAY', 'FAMILY_BIRTHDAY', 'ANNIVERSARY'];
const RANK: Record<string, number> = { QUEUED: 0, SENT: 1, STATUS_UNKNOWN: 1, DELIVERED: 2, READ: 3 };
const rupees = (p: number) => (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Providers (dev: a test inbox; real providers implement the same three calls) ──
export class TemporaryFailure extends Error {}
export class PermanentFailure extends Error {}
let failMode: 'none' | 'temporary' | 'permanent' = 'none';
export const devProvider = {
  inbox: [] as Array<{ id: string; channel: Channel; to: string; subject: string | null; text: string; at: Date }>,
  setFailMode(m: typeof failMode) { failMode = m; },
  async send(channel: Channel, to: string, subject: string | null, text: string) {
    if (failMode === 'temporary') throw new TemporaryFailure('Provider unavailable');
    if (failMode === 'permanent') throw new PermanentFailure('Rejected by provider');
    const id = `dev_${randomUUID()}`;
    devProvider.inbox.unshift({ id, channel, to, subject, text, at: clock.now() });
    devProvider.inbox.splice(200);
    return { id };
  },
  async submitTemplate(_t: TemplateRow) { /* Meta replies later through the webhook */ },
};
/** Brevo for email (EMAIL_PROVIDER=brevo): failures become our Temporary / Permanent kinds so retries work the same. */
const brevoProvider = {
  async send(_channel: Channel, to: string, subject: string | null, text: string) {
    try { return await sendEmail(to, subject, text); } catch (e) { if (e instanceof BrevoPermanent) throw new PermanentFailure((e as Error).message); throw new TemporaryFailure((e as Error).message); }
  },
  async submitTemplate(_t: TemplateRow) { /* email templates need no outside approval */ },
};
/** What a real provider may need beyond the rendered text (WhatsApp templates send variables, not text). */
interface SendExtra { template: TemplateRow; params: Record<string, unknown>; accountId: string }
/** MSG91 WhatsApp (WHATSAPP_PROVIDER=msg91): template messages from the advisor's dedicated number, or SkyUp's. */
const msg91WhatsApp = {
  async send(_channel: Channel, to: string, _subject: string | null, _text: string, x?: SendExtra) {
    if (!x) throw new PermanentFailure('No template');
    const name = (x.template as { providerTemplateName?: string | null }).providerTemplateName;
    if (!name) throw new PermanentFailure('Template is not set up at MSG91');
    const acc = await Account.findById(x.accountId, { 'subscription.waNumber': 1 }).lean<{ subscription?: { waNumber?: { status?: string; number?: string | null } | null } }>();
    const own = acc?.subscription?.waNumber;
    const from = own?.status === 'ACTIVE' && own.number ? own.number : env.MSG91_WA_NUMBER!;
    try { return await msg91.sendWhatsAppTemplate({ from, to, templateName: name, language: x.template.language, body: x.template.body, params: x.params }); }
    catch (e) { if (e instanceof msg91.Msg91Permanent) throw new PermanentFailure((e as Error).message); throw new TemporaryFailure((e as Error).message); }
  },
  /** Create the template at MSG91 for Meta's review; the decision is read back by syncWhatsAppTemplates(). */
  async submitTemplate(t: TemplateRow) {
    const { name } = await msg91.submitWhatsAppTemplate({ ...t, version: t.version });
    await MessageTemplate.updateOne({ _id: t._id }, { $set: { providerTemplateName: name, providerStatus: 'PENDING' } });
  },
};
/** One provider per channel: email → Brevo or the test inbox; WhatsApp → MSG91 or the test inbox. */
const providerFor = (channel: Channel): { send: (c: Channel, to: string, subject: string | null, text: string, x?: SendExtra) => Promise<{ id: string }>; submitTemplate: (t: TemplateRow) => Promise<void> } => {
  if (channel === 'EMAIL') return env.EMAIL_PROVIDER === 'brevo' ? brevoProvider : devProvider;
  return env.WHATSAPP_PROVIDER === 'msg91' ? msg91WhatsApp : devProvider;
};

/**
 * MSG91 does not push Meta's template decisions: every 10 minutes the templates waiting for Meta are checked, and an
 * approval or rejection goes through the same path as the old TEMPLATE webhook (rejections ring SkyUp with the reason).
 */
export async function syncWhatsAppTemplates(now = clock.now()) {
  if (env.WHATSAPP_PROVIDER !== 'msg91') return { registered: 0, checked: 0 };
  const slot = Math.floor(now.getTime() / 600_000);
  try { await JobRun.create({ _id: `WA-TPL|${slot}`, at: now }); } catch (e) { if (isDuplicateKey(e)) return { registered: 0, checked: 0 }; throw e; }
  // 1. Templates already in use (the built-in ones, or approved before MSG91) are registered at MSG91 once.
  const unregistered = await MessageTemplate.find({ channel: 'WHATSAPP', status: 'ACTIVE', providerTemplateName: null }).limit(20).lean<TemplateRow[]>();
  let registered = 0;
  for (const t of unregistered) {
    try { await msg91WhatsApp.submitTemplate(t); registered++; } catch (e) { logger.warn({ template: t._id, reason: (e as Error).message }, 'MSG91 template registration failed; retried in 10 minutes'); }
  }
  // 2. Meta's decisions for everything waiting.
  const waiting = await MessageTemplate.find({ channel: 'WHATSAPP', providerStatus: 'PENDING', providerTemplateName: { $ne: null } }).limit(50).lean<TemplateRow[]>();
  for (const t of waiting) {
    const s = await msg91.whatsAppTemplateStatus((t as { providerTemplateName: string }).providerTemplateName, t.language).catch(() => ({ status: 'PENDING' as const, reason: undefined }));
    if (s.status === 'PENDING') continue;
    await MessageTemplate.updateOne({ _id: t._id }, { $set: { providerStatus: s.status, ...(s.status === 'REJECTED' ? { metaReason: s.reason ?? 'Rejected by Meta' } : {}) } });
    if (t.metaStatus === 'SUBMITTED') {
      // a template published from Admin → Message templates: becomes ACTIVE, or REJECTED with SkyUp told the reason
      await applyMessageEvent({ eventId: `msg91-tpl|${t._id}|${s.status}|${t.version}`, type: 'TEMPLATE', templateId: t._id, decision: s.status, reason: s.reason } as MessageEvent, 'msg91');
    } else if (s.status === 'REJECTED') {
      await notifySkyUp({ kind: 'TEMPLATE_REJECTED_BY_META', messageId: 'DSH-28', params: { name: t.name, reason: s.reason ?? 'Not stated' }, dedupeKey: `DSH-28|${t._id}|${t.version}`, link: { type: 'MESSAGE_TEMPLATE', id: t._id } });
    }
  }
  return { registered, checked: waiting.length };
}

/** MSG91 WhatsApp webhook: POST /webhooks/msg91/<MSG91_WEBHOOK_TOKEN> (delivery reports and inbound STOP). */
export async function msg91Webhook(req: Request, token: string) {
  const want = env.MSG91_WEBHOOK_TOKEN ?? '';
  if (!want || token.length !== want.length || !timingSafeEqual(Buffer.from(token), Buffer.from(want))) throw AppError.forbidden();
  const items = (Array.isArray(req.body) ? req.body : Array.isArray(req.body?.data) ? req.body.data : [req.body]) as Array<Record<string, unknown>>;
  let processed = 0;
  for (const b of items.slice(0, 200)) {
    const e = msg91.msg91Event(b ?? {});
    if (e && (await applyMessageEvent(e as MessageEvent, 'msg91')).processed) processed++;
  }
  return { received: items.length, processed };
}

/** HMAC-SHA256 of the raw body with WEBHOOK_SECRET (AC-P42-1: a forged webhook changes nothing). */
export const sign = (raw: Buffer | string) => createHmac('sha256', env.WEBHOOK_SECRET).update(raw).digest('hex');
export function verify(req: Request) {
  const got = String(req.headers['x-bimayantra-signature'] ?? '');
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from('');
  const want = sign(raw);
  if (got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) throw AppError.forbidden();
}

// ── Templates (P-39) ──
export const VARIABLES: Record<string, string[]> = {
  RENEWAL_REMINDER: ['customer first name', 'product', 'policy last 4', 'renewal date', 'advisor name', 'advisor mobile'],
  QUOTATION_EMAIL: ['customer name', 'quotation number', 'link', 'advisor name', 'advisor mobile'],
  BIRTHDAY: ['name', 'advisor name'], FAMILY_BIRTHDAY: ['customer name', 'member name', 'advisor name'], ANNIVERSARY: ['name', 'advisor name'],
  KYC_RESULT: ['advisor name', 'result'], SUBSCRIPTION: ['advisor name', 'plan', 'date'],
};
const SYSTEM: Array<{ code: string; name: string; channel: Channel; purpose: string; subject?: string; body: string }> = [
  { code: 'REN-T1', name: 'Renewal reminder (email)', channel: 'EMAIL', purpose: 'RENEWAL_REMINDER', subject: 'Your policy is due for renewal', body: 'Dear {customer first name}, your {product} policy ending {policy last 4} is due for renewal on {renewal date}. Please contact {advisor name} on {advisor mobile} to renew it on time.' },
  { code: 'REN-T1', name: 'Renewal reminder (WhatsApp)', channel: 'WHATSAPP', purpose: 'RENEWAL_REMINDER', body: 'Dear {customer first name}, your {product} policy ending {policy last 4} is due for renewal on {renewal date}. Please contact {advisor name} on {advisor mobile} to renew it on time.' },
  { code: 'QT-EMAIL', name: 'Quotation email', channel: 'EMAIL', purpose: 'QUOTATION_EMAIL', subject: 'Your insurance quotation {quotation number}', body: 'Dear {customer name}, here is your quotation {quotation number}: {link}. For any questions, contact {advisor name} on {advisor mobile}.' },
  { code: 'BDAY', name: 'Birthday greeting', channel: 'WHATSAPP', purpose: 'BIRTHDAY', body: 'Happy birthday, {name}! Wishing you good health and happiness. – {advisor name}' },
  { code: 'FAM-BDAY', name: 'Family birthday greeting', channel: 'WHATSAPP', purpose: 'FAMILY_BIRTHDAY', body: 'Dear {customer name}, wishing {member name} a very happy birthday! – {advisor name}' },
  { code: 'SUB-EMAIL', name: 'Subscription invoice email', channel: 'EMAIL', purpose: 'SUBSCRIPTION', subject: 'Your Bimayantra {plan} plan', body: 'Hello {advisor name}, payment received. Your {plan} plan is active until {date}. Your GST invoice is in Settings, My plan, Billing history.' },
  { code: 'ANNIV', name: 'Anniversary greeting', channel: 'WHATSAPP', purpose: 'ANNIVERSARY', body: 'Happy anniversary, {name}! Wishing you many happy years together. – {advisor name}' },
];
let seeded = false;
/** System templates, ACTIVE, so system purposes always have one (P-39 step 5). */
export async function ensureSystemTemplates() {
  if (seeded) return;
  for (const t of SYSTEM) {
    if (await MessageTemplate.exists({ code: t.code, channel: t.channel })) continue;
    try { await MessageTemplate.create({ ...t, status: 'ACTIVE', metaStatus: t.channel === 'WHATSAPP' ? 'APPROVED' : null, makerId: 'SYSTEM', approverId: 'SYSTEM' }); }
    catch (e) { if (!isDuplicateKey(e)) throw e; }
  }
  seeded = true;
}
export const resetSeeded = () => { seeded = false; };
export const render = (body: string, params: Record<string, unknown>) => body.replace(/\{([^{}]+)\}/g, (_m, k: string) => String(params[k] ?? ''));

function checkTemplate(b: { channel: Channel; purpose: string; body: string; subject?: string | null }) {
  const allowed = VARIABLES[b.purpose] ?? [];
  const used = [...`${b.subject ?? ''} ${b.body}`.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]!);
  if (used.some((v) => !allowed.includes(v))) throw AppError.field('body', 'COM-03', { purpose: b.purpose.replace(/_/g, ' ').toLowerCase(), list: allowed.map((v) => `{${v}}`).join(', ') });
  if (b.channel === 'WHATSAPP' && b.body.length > cfgNum('CFG-138')) throw AppError.field('body', 'COM-04', { 'CFG-138': cfgNum('CFG-138') });
}
export async function listTemplates() { await ensureSystemTemplates(); return MessageTemplate.find({}).sort({ purpose: 1, channel: 1, createdAt: -1 }).lean(); }
export async function createTemplate(ctx: AuthContext, b: { name: string; channel: Channel; purpose: string; language?: string; subject?: string | null; body: string }, req: Request) {
  checkTemplate(b);
  const t = await MessageTemplate.create({ ...b, code: `T-${Date.now().toString(36).toUpperCase()}`, makerId: ctx.userId });
  await audit({ entity: 'template', entityId: t._id, action: 'TEMPLATE_CREATED', after: { purpose: b.purpose, channel: b.channel } }, { req });
  return t.toObject();
}
async function tpl(id: string) { const t = await MessageTemplate.findById(id).lean<TemplateRow>(); if (!t) throw AppError.notFound(); return t; }
export async function submitTemplate(ctx: AuthContext, id: string, req: Request) {
  const t = await tpl(id);
  if (!['DRAFT', 'REJECTED'].includes(t.status)) throw AppError.invalidState('template', t.status);
  await MessageTemplate.updateOne({ _id: id }, { $set: { status: 'PENDING_APPROVAL', makerId: ctx.userId, metaStatus: null, metaReason: null }, $inc: { version: 1 } });
  await audit({ entity: 'template', entityId: id, action: 'TEMPLATE_SUBMITTED' }, { req });
  // No admin approval (Q92): email goes live now; WhatsApp goes to Meta now. A failed check (COM-05) returns it to DRAFT.
  try { return await approveTemplate(ctx, id, req, { direct: true }); }
  catch (e) { await MessageTemplate.updateOne({ _id: id, status: 'PENDING_APPROVAL' }, { $set: { status: 'DRAFT' } }); throw e; }
}
/** A different ADM approves with OTP (AC-P39-4). Email: ACTIVE. WhatsApp: sent to Meta (COM-01), ACTIVE only on Meta's approval. */
export async function approveTemplate(ctx: AuthContext, id: string, req: Request, opts: { direct?: boolean } = {}) {
  const t = await tpl(id);
  if (t.status !== 'PENDING_APPROVAL' || t.metaStatus === 'SUBMITTED') throw AppError.invalidState('template', t.status);
  if (t.makerId === ctx.userId && !opts.direct) throw new AppError(403, 'FORBIDDEN', 'CAT-05'); // only items left waiting from before
  if (await MessageTemplate.exists({ _id: { $ne: id }, purpose: t.purpose, channel: t.channel, language: t.language, status: 'ACTIVE' })) throw new AppError(409, 'INVALID_STATE', 'COM-05', { purpose: t.purpose.replace(/_/g, ' ').toLowerCase() });
  if (t.channel === 'EMAIL') {
    await MessageTemplate.updateOne({ _id: id }, { $set: { status: 'ACTIVE', approverId: ctx.userId } });
    await audit({ entity: 'template', entityId: id, action: 'TEMPLATE_APPROVED' }, { req });
    return { template: await tpl(id), messageId: (opts.direct ? 'CAT-42' : 'GEN-07') as 'CAT-42' | 'GEN-07', params: { Item: t.name } };
  }
  await providerFor('WHATSAPP').submitTemplate(t);
  await MessageTemplate.updateOne({ _id: id }, { $set: { metaStatus: 'SUBMITTED', approverId: ctx.userId } });
  await audit({ entity: 'template', entityId: id, action: 'TEMPLATE_SENT_TO_META' }, { req });
  return { template: await tpl(id), messageId: 'COM-01' as const };
}
/** Deactivate: queued messages that needed it are skipped at send time (AC-P39-3). */
export async function deactivateTemplate(ctx: AuthContext, id: string, req: Request) {
  const t = await tpl(id);
  if (t.status !== 'ACTIVE') throw AppError.invalidState('template', t.status);
  await MessageTemplate.updateOne({ _id: id }, { $set: { status: 'INACTIVE' } });
  await audit({ entity: 'template', entityId: id, action: 'TEMPLATE_DEACTIVATED', after: { by: ctx.userId } }, { req });
  return tpl(id);
}

// ── Consent and skip rules, checked when queued and again just before sending (P-37, P-41 step 4) ──
async function consentOf(accountId: string, personKey: string | null, channel: Channel) {
  if (!personKey) return null;
  return (await Consent.findOne({ accountId, personKey, channel }, { status: 1 }).lean<{ status: string }>())?.status ?? null;
}
async function planOf(accountId: string) {
  return Account.findById(accountId, { subscription: 1, greetings: 1, wallet: 1 }).lean<{ subscription: { plan: string | null }; greetings?: { on?: boolean; excluded?: string[] }; wallet: { balancePaise: number } }>();
}
export async function skipFor(m: OutboxDoc): Promise<string | null> {
  const accStatus = (await Account.findById(m.accountId, { status: 1 }).lean<{ status: string }>())?.status;
  if (accStatus && accStatus !== 'ACTIVE') return accStatus === 'SUSPENDED' ? 'Account suspended' : 'Account closed'; // AC-P51-1
  if (m.channel === 'EMAIL' && (await BouncedAddress.exists({ _id: m.to.toLowerCase() }))) return 'Email address bounced'; // AC-P42-4
  const related = m.related as { cycleId?: string } | null;
  if (related?.cycleId) {
    const { RenewalCycle } = await import('../renewals/renewal.model.js');
    const { skipReason } = await import('../renewals/renewals.service.js');
    const c = await RenewalCycle.findById(related.cycleId).lean();
    return c ? skipReason(c as never, m.channel as Channel) : 'Renewal removed';
  }
  const consent = await consentOf(m.accountId, m.personKey ?? null, m.channel as Channel);
  if (GREETINGS.includes(m.purpose)) {
    const acc = await planOf(m.accountId);
    if (acc?.subscription.plan !== 'PREMIUM') return 'Not on the Premium plan'; // AC-P41-3
    if (!acc.greetings?.on) return 'Greetings are off';
    if (acc.greetings.excluded?.includes(String((m.params as { occasionPerson?: string }).occasionPerson ?? m.personKey))) return 'Person excluded';
    if (consent !== 'GIVEN') return consent === 'WITHDRAWN' ? 'Consent withdrawn' : 'Consent missing'; // AC-P41-2
    const cus = m.customerId ? await Customer.findById(m.customerId, { status: 1 }).lean<{ status: string }>() : null;
    if (cus && cus.status !== 'ACTIVE') return 'Customer inactive';
    return null;
  }
  if (consent === 'WITHDRAWN') return 'Consent withdrawn';
  if (m.channel === 'WHATSAPP' && consent !== 'GIVEN') return 'Consent missing';
  return null;
}

/** IST hour inside the WhatsApp sending window (CFG-64). */
export function inWindow(now = clock.now()) {
  const h = new Date(now.getTime() + 5.5 * 3_600_000).getUTCHours();
  const { min, max } = cfgRange('CFG-64');
  return h >= min && h < max;
}

// ── The sender (SYS-08): repeat-safe; every rule checked again just before each send ──
export async function sendDue(now = clock.now()) {
  await ensureSystemTemplates();
  const out = { sent: 0, skipped: 0, failed: 0, retry: 0, unknown: 0 };
  // SYS-09: SENT with no update after CFG-71 hours → STATUS_UNKNOWN
  out.unknown = (await Outbox.updateMany({ status: 'SENT', sentAt: { $lt: new Date(now.getTime() - cfgNum('CFG-71') * 3_600_000) } }, { $set: { status: 'STATUS_UNKNOWN', statusAt: now }, $push: { history: { at: now, status: 'STATUS_UNKNOWN', note: null } } })).modifiedCount;
  const due = await Outbox.find({ status: 'QUEUED', $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] }).sort({ createdAt: 1 }).limit(200).lean<OutboxDoc[]>();
  for (const m of due) {
    if (m.channel === 'WHATSAPP' && !inWindow(now)) continue; // AC-P41-4: never outside CFG-64
    const skip = async (reason: string) => { await Outbox.updateOne({ _id: m._id, status: 'QUEUED' }, { $set: { status: 'SKIPPED', skipReason: reason, statusAt: now }, $push: { history: { at: now, status: 'SKIPPED', note: reason } } }); out.skipped++; };
    const why = await skipFor(m);
    if (why) { await skip(why); continue; }
    const t = await MessageTemplate.findOne({ purpose: m.purpose, channel: m.channel, status: 'ACTIVE' }).lean<TemplateRow>();
    if (!t) { await skip('Template not active'); continue; } // AC-P39-3
    // MSG91: a WhatsApp message waits (stays QUEUED) until Meta has approved its template at MSG91
    if (m.channel === 'WHATSAPP' && env.WHATSAPP_PROVIDER === 'msg91' && (t as { providerStatus?: string | null }).providerStatus !== 'APPROVED') {
      if ((t as { providerStatus?: string | null }).providerStatus === 'REJECTED') { await skip('Template rejected by Meta'); continue; }
      continue;
    }
    const price = cfgNum('CFG-162');
    const automated = m.channel === 'WHATSAPP' && AUTOMATED_WA.includes(m.purpose);
    if (automated) {
      const acc = await planOf(m.accountId);
      if ((acc?.wallet.balancePaise ?? 0) < price) { // AC-P56-2: never sent on credit
        await skip('Insufficient wallet balance');
        await advisorBell(m.accountId, 'WAL-03', {}, `WAL-03|${m.accountId}|${istToday()}`);
        continue;
      }
    }
    const text = render(t.body, m.params as Record<string, unknown>);
    const subject = t.subject ? render(t.subject, m.params as Record<string, unknown>) : null;
    try {
      const r = await providerFor(m.channel as Channel).send(m.channel as Channel, m.to, subject, text, { template: t, params: m.params as Record<string, unknown>, accountId: m.accountId });
      const u = await Outbox.updateOne({ _id: m._id, status: 'QUEUED' }, { $set: { status: 'SENT', providerMessageId: r.id, sentAt: now, statusAt: now, text, subject, templateId: t._id, templateVersion: t.version, attempts: m.attempts + 1 }, $push: { history: { at: now, status: 'SENT', note: null } } });
      if (!u.modifiedCount) continue;
      out.sent++;
      if (automated) await debit(m.accountId, m._id, price);
    } catch (e) {
      const attempts = m.attempts + 1;
      const next = new Date(now.getTime() + 2 ** attempts * 60_000);
      const permanent = e instanceof PermanentFailure;
      const windowClosed = m.channel === 'WHATSAPP' && !inWindow(next);
      if (permanent || attempts >= 3 || windowClosed) {
        const reason = permanent ? (e as Error).message : windowClosed ? 'Sending window closed' : 'Provider unavailable';
        await Outbox.updateOne({ _id: m._id, status: 'QUEUED' }, { $set: { status: 'FAILED', skipReason: reason, attempts, statusAt: now }, $push: { history: { at: now, status: 'FAILED', note: reason } } });
        out.failed++;
      } else { await Outbox.updateOne({ _id: m._id, status: 'QUEUED' }, { $set: { attempts, nextAttemptAt: next } }); out.retry++; } // GR-27
    }
  }
  return out;
}

async function advisorBell(accountId: string, messageId: 'WAL-01' | 'WAL-02' | 'WAL-03', params: Record<string, string>, dedupeKey: string) {
  const adv = await User.findOne({ accountId, role: 'ADV' }, { _id: 1 }).lean<{ _id: string }>();
  if (adv) await notify({ userId: adv._id, accountId, kind: 'WALLET', messageId, params, dedupeKey }).catch(() => undefined);
}

/** One debit per message (AC-P56-1), never below zero. Low balance → WAL-02 once a day. */
async function debit(accountId: string, messageId: string, price: number) {
  try {
    await withTx(async (session) => {
      const acc = await Account.findOneAndUpdate({ _id: accountId, 'wallet.balancePaise': { $gte: price } }, { $inc: { 'wallet.balancePaise': -price } }, { new: true, session: session ?? undefined }).lean<{ wallet: { balancePaise: number } }>();
      if (!acc) throw new Error('Insufficient wallet balance');
      await WalletTxn.create([{ accountId, type: 'DEBIT', amountPaise: price, messageId, balanceAfterPaise: acc.wallet.balancePaise }], { session: session ?? undefined });
    });
  } catch (e) { if (!isDuplicateKey(e, 'one_debit_per_message')) throw e; return; }
  const acc = await planOf(accountId);
  if ((acc?.wallet.balancePaise ?? 0) < cfgNum('CFG-164') * 100) await advisorBell(accountId, 'WAL-02', { balance: rupees(acc?.wallet.balancePaise ?? 0) }, `WAL-02|${accountId}|${istToday()}`);
}

// ── Webhooks (P-42, P-56): signed, idempotent by event ID ──
async function once(eventId: string, source: string) {
  try { await WebhookEvent.create({ _id: `${source}|${eventId}`, source, at: clock.now() }); return true; } catch (e) { if (isDuplicateKey(e)) return false; throw e; }
}
export interface MessageEvent { eventId: string; type: 'STATUS' | 'STOP' | 'BOUNCE' | 'TEMPLATE'; providerMessageId?: string; status?: 'DELIVERED' | 'READ' | 'FAILED'; reason?: string; from?: string; address?: string; templateId?: string }
export async function messageWebhook(req: Request) {
  verify(req);
  return applyMessageEvent(req.body as MessageEvent, 'messages');
}

/** Brevo delivery events: POST /webhooks/brevo/<BREVO_WEBHOOK_TOKEN> (Brevo does not sign; the secret path is the check). */
export async function brevoWebhook(req: Request, token: string) {
  const want = env.BREVO_WEBHOOK_TOKEN ?? '';
  if (!want || token.length !== want.length || !timingSafeEqual(Buffer.from(token), Buffer.from(want))) throw AppError.forbidden();
  const items = (Array.isArray(req.body) ? req.body : [req.body]) as Array<Record<string, unknown>>;
  let processed = 0;
  for (const b of items.slice(0, 100)) {
    const e = brevoEvent(b ?? {});
    if (e && e.providerMessageId && (await applyMessageEvent(e as MessageEvent, 'brevo')).processed) processed++;
  }
  return { received: items.length, processed };
}

async function applyMessageEvent(e: MessageEvent, source: string) {
  if (!e?.eventId || !(await once(e.eventId, source))) return { processed: false };
  const now = clock.now();
  if (e.type === 'STATUS' && e.providerMessageId && e.status) {
    const m = await Outbox.findOne({ providerMessageId: e.providerMessageId }, { status: 1 }).lean<{ _id: string; status: string }>();
    if (!m) return { processed: true };
    const forward = e.status === 'FAILED' ? (RANK[m.status] ?? 9) <= 1 : (RANK[e.status] ?? 0) > (RANK[m.status] ?? 9); // AC-P42-2: never backwards
    if (forward) await Outbox.updateOne({ _id: m._id, status: m.status }, { $set: { status: e.status, statusAt: now, ...(e.status === 'FAILED' ? { skipReason: e.reason ?? 'Failed at the provider' } : {}) }, $push: { history: { at: now, status: e.status, note: e.reason ?? null } } });
  } else if (e.type === 'STOP' && e.from) { // AC-P42-3: STOP withdraws WhatsApp consent and cancels queued WhatsApp messages
    const mobile = normalizeMobile(e.from);
    const cus = await Customer.find({ mobile }, { _id: 1, accountId: 1 }).lean<Array<{ _id: string; accountId: string }>>();
    const fam = await FamilyMember.find({ mobile }, { _id: 1, accountId: 1, customerId: 1 }).lean<Array<{ _id: string; accountId: string; customerId: string }>>();
    const keys = [...cus.map((c) => ({ accountId: c.accountId, personKey: `C:${c._id}`, customerId: c._id })), ...fam.map((f) => ({ accountId: f.accountId, personKey: `F:${f._id}`, customerId: f.customerId }))];
    for (const k of keys) {
      await Consent.updateOne({ accountId: k.accountId, personKey: k.personKey, channel: 'WHATSAPP' }, { $set: { status: 'WITHDRAWN', recordedAt: now, howGiven: 'WhatsApp STOP' }, $setOnInsert: { customerId: k.customerId }, $push: { history: { at: now, status: 'WITHDRAWN', by: 'SYSTEM', note: 'STOP from WhatsApp' } } }, { upsert: true });
      await Outbox.updateMany({ accountId: k.accountId, personKey: k.personKey, channel: 'WHATSAPP', status: 'QUEUED' }, { $set: { status: 'SKIPPED', skipReason: 'Consent withdrawn', statusAt: now } });
      await Outbox.updateMany({ accountId: k.accountId, to: mobile, channel: 'WHATSAPP', status: 'QUEUED' }, { $set: { status: 'SKIPPED', skipReason: 'Consent withdrawn', statusAt: now } });
    }
  } else if (e.type === 'BOUNCE' && e.address) { // AC-P42-4
    await BouncedAddress.updateOne({ _id: e.address.toLowerCase() }, { $set: { at: now, reason: e.reason ?? 'Hard bounce' } }, { upsert: true });
    if (e.providerMessageId) await Outbox.updateOne({ providerMessageId: e.providerMessageId, status: { $in: ['SENT', 'STATUS_UNKNOWN'] } }, { $set: { status: 'FAILED', skipReason: 'Email address bounced', statusAt: now } });
    await Outbox.updateMany({ to: e.address.toLowerCase(), channel: 'EMAIL', status: 'QUEUED' }, { $set: { status: 'SKIPPED', skipReason: 'Email address bounced', statusAt: now } });
  } else if (e.type === 'TEMPLATE' && e.templateId) { // Meta's decision (AC-P39-1)
    const approved = e.status === ('APPROVED' as never) || (e as { decision?: string }).decision === 'APPROVED';
    const u = await MessageTemplate.updateOne({ _id: e.templateId, metaStatus: 'SUBMITTED' }, { $set: approved ? { status: 'ACTIVE', metaStatus: 'APPROVED' } : { status: 'REJECTED', metaStatus: 'REJECTED', metaReason: e.reason ?? 'Not stated' } });
    if (!approved && u.modifiedCount) { // §9.6: SkyUp is told Meta refused it, with Meta's reason
      const t = await MessageTemplate.findById(e.templateId, { name: 1 }).lean<{ name?: string }>();
      await notifySkyUp({ kind: 'TEMPLATE_REJECTED_BY_META', messageId: 'DSH-28', params: { name: t?.name ?? 'template', reason: e.reason ?? 'Not stated' }, dedupeKey: `DSH-28|${e.templateId}|${now.toISOString()}`, link: { type: 'MESSAGE_TEMPLATE', id: e.templateId } }).catch(() => undefined);
    }
  }
  return { processed: true };
}

// ── Wallet (P-56) ──
export async function wallet(ctx: AuthContext) {
  const acc = await planOf(ctx.accountId!);
  const txns = await WalletTxn.find({ accountId: ctx.accountId }).sort({ createdAt: -1 }).limit(300).lean();
  return { balance: (acc?.wallet.balancePaise ?? 0) / 100, pricePerMessage: cfgNum('CFG-162') / 100, minimumRecharge: cfgNum('CFG-163'), lowBalanceBelow: cfgNum('CFG-164'), plan: acc?.subscription.plan ?? null,
    transactions: txns.map((t) => ({ id: t._id, type: t.type, amount: t.amountPaise / 100, status: t.status, messageId: t.messageId, reason: t.reason, balanceAfter: t.balanceAfterPaise === null || t.balanceAfterPaise === undefined ? null : t.balanceAfterPaise / 100, at: t.createdAt })) };
}
/** Recharge: a PENDING transaction and a gateway order. Only the gateway's signed notification credits (AC-P56-3). */
export async function recharge(ctx: AuthContext, amount: number, req: Request) {
  if (amount < cfgNum('CFG-163')) throw AppError.field('amount', 'WAL-04', { 'CFG-163': cfgNum('CFG-163') });
  const acc = await planOf(ctx.accountId!);
  if (acc?.subscription.plan !== 'PREMIUM') throw new AppError(403, 'PLAN_REQUIRED', 'SUB-01');
  const t = await WalletTxn.create({ accountId: ctx.accountId, type: 'RECHARGE', amountPaise: Math.round(amount * 100), status: 'PENDING', by: ctx.userId });
  await audit({ entity: 'wallet', entityId: t._id, action: 'WALLET_RECHARGE_STARTED', after: { amount } }, { req });
  if (env.PAYMENT_GATEWAY === 'razorpay') {
    const o = await rzp.createOrder(t.amountPaise, t._id, { kind: 'WALLET', id: t._id, accountId: ctx.accountId! });
    await WalletTxn.updateOne({ _id: t._id }, { $set: { gatewayOrderId: o.id } });
    return { orderId: t._id, amount, ...rzp.checkoutFor(o, 'WhatsApp wallet recharge') };
  }
  return { orderId: t._id, amount, gateway: env.PAYMENT_GATEWAY, checkout: `dev-checkout:${t._id}` };
}

/** After Razorpay Checkout: check the signature, confirm (and capture) the payment, credit the wallet once. */
export async function verifyRecharge(ctx: AuthContext, id: string, b: { razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string }) {
  const t = await WalletTxn.findOne({ _id: id, accountId: ctx.accountId, type: 'RECHARGE' }).lean();
  if (!t) throw AppError.notFound();
  if (t.status === 'SUCCESS') return wallet(ctx);
  if (!t.gatewayOrderId || t.gatewayOrderId !== b.razorpayOrderId || !rzp.checkoutSignatureValid(b.razorpayOrderId, b.razorpayPaymentId, b.razorpaySignature)) throw new AppError(400, 'PAYMENT_NOT_VERIFIED', 'WAL-07');
  const p = await rzp.confirm(t.gatewayOrderId, b.razorpayPaymentId, t.amountPaise);
  if (!p) throw new AppError(402, 'PAYMENT_NOT_CAPTURED', 'WAL-07');
  await creditRecharge(t._id, p.id);
  return wallet(ctx);
}

/** Credit a PENDING recharge exactly once (unique payment id) and ring the bell. */
export async function creditRecharge(txnId: string, paymentId: string) {
  const t = await WalletTxn.findOne({ _id: txnId, type: 'RECHARGE' }).lean();
  if (!t || t.status !== 'PENDING') return false;
  let credited = false;
  try {
    await withTx(async (session) => {
      const u = await WalletTxn.updateOne({ _id: t._id, status: 'PENDING' }, { $set: { status: 'SUCCESS', gatewayPaymentId: paymentId } }, { session: session ?? undefined });
      if (!u.modifiedCount) return;
      const acc = await Account.findOneAndUpdate({ _id: t.accountId }, { $inc: { 'wallet.balancePaise': t.amountPaise } }, { new: true, session: session ?? undefined }).lean<{ wallet: { balancePaise: number } }>();
      await WalletTxn.updateOne({ _id: t._id }, { $set: { balanceAfterPaise: acc!.wallet.balancePaise } }, { session: session ?? undefined });
      credited = true;
    });
  } catch (x) { if (!isDuplicateKey(x)) throw x; }
  if (credited) {
    const acc = await planOf(t.accountId);
    await advisorBell(t.accountId, 'WAL-01', { amount: rupees(t.amountPaise), balance: rupees(acc?.wallet.balancePaise ?? 0) }, `WAL-01|${t._id}`);
  }
  return credited;
}
export async function paymentWebhook(req: Request) {
  verify(req);
  const e = req.body as { eventId: string; orderId: string; paymentId: string; status: 'captured' | 'failed' };
  if (!e?.eventId || !(await once(e.eventId, 'payments'))) return { processed: false };
  const t = await WalletTxn.findOne({ _id: e.orderId, type: 'RECHARGE' }).lean();
  if (!t || t.status !== 'PENDING') return { processed: true }; // a late success after FAILED is handled by support
  if (e.status !== 'captured') { await WalletTxn.updateOne({ _id: t._id, status: 'PENDING' }, { $set: { status: 'FAILED', gatewayPaymentId: e.paymentId } }); return { processed: true }; }
  try {
    await withTx(async (session) => {
      const u = await WalletTxn.updateOne({ _id: t._id, status: 'PENDING' }, { $set: { status: 'SUCCESS', gatewayPaymentId: e.paymentId } }, { session: session ?? undefined });
      if (!u.modifiedCount) return;
      const acc = await Account.findOneAndUpdate({ _id: t.accountId }, { $inc: { 'wallet.balancePaise': t.amountPaise } }, { new: true, session: session ?? undefined }).lean<{ wallet: { balancePaise: number } }>();
      await WalletTxn.updateOne({ _id: t._id }, { $set: { balanceAfterPaise: acc!.wallet.balancePaise } }, { session: session ?? undefined });
    });
  } catch (x) { if (!isDuplicateKey(x)) throw x; }
  const acc = await planOf(t.accountId);
  await advisorBell(t.accountId, 'WAL-01', { amount: rupees(t.amountPaise), balance: rupees(acc?.wallet.balancePaise ?? 0) }, `WAL-01|${t._id}`);
  return { processed: true };
}
/** Manual credit (ADM, OTP, reason) for goodwill or correction. */
export async function manualCredit(ctx: AuthContext, accountId: string, amount: number, reason: string, req: Request) {
  const acc = await Account.findOneAndUpdate({ _id: accountId }, { $inc: { 'wallet.balancePaise': Math.round(amount * 100) } }, { new: true }).lean<{ wallet: { balancePaise: number } }>();
  if (!acc) throw AppError.notFound();
  await WalletTxn.create({ accountId, type: 'CREDIT', amountPaise: Math.round(amount * 100), reason, by: ctx.userId, balanceAfterPaise: acc.wallet.balancePaise });
  await audit({ entity: 'wallet', entityId: accountId, action: 'WALLET_MANUAL_CREDIT', after: { amount, reason } }, { req });
  return { balance: acc.wallet.balancePaise / 100 };
}

// ── Occasion greetings (P-40, P-41) ──
const md = (d: string | null | undefined) => (d ? d.slice(5) : null); // MM-DD
async function people(accountId: string) {
  const cus = await Customer.find({ accountId, status: 'ACTIVE' }, { name: 1, dob: 1, anniversary: 1, mobile: 1 }).lean<Array<{ _id: string; name: string; dob: string | null; anniversary: string | null; mobile: string }>>();
  const fam = await FamilyMember.find({ accountId, status: 'ACTIVE', customerId: { $in: cus.map((c) => c._id) } }, { name: 1, dob: 1, anniversary: 1, mobile: 1, relationship: 1, customerId: 1 }).lean<Array<{ _id: string; name: string; dob: string | null; anniversary: string | null; mobile?: string | null; relationship: string; customerId: string }>>();
  return { cus, fam };
}
/** Recipient per the P-40 table: the person themselves, or the customer for a family birthday. */
async function occasionsOn(accountId: string, mmdd: string) {
  const { cus, fam } = await people(accountId);
  const out: Array<{ occasion: 'BIRTHDAY' | 'FAMILY_BIRTHDAY' | 'ANNIVERSARY'; person: string; personName: string; recipientKey: string; to: string; customerId: string; params: Record<string, string> }> = [];
  const byId = new Map(cus.map((c) => [c._id, c]));
  for (const c of cus) {
    if (md(c.dob) === mmdd) out.push({ occasion: 'BIRTHDAY', person: `C:${c._id}`, personName: c.name, recipientKey: `C:${c._id}`, to: c.mobile, customerId: c._id, params: { name: c.name.split(' ')[0]! } });
    if (md(c.anniversary) === mmdd) out.push({ occasion: 'ANNIVERSARY', person: `C:${c._id}`, personName: c.name, recipientKey: `C:${c._id}`, to: c.mobile, customerId: c._id, params: { name: c.name.split(' ')[0]! } });
  }
  for (const f of fam) {
    const owner = byId.get(f.customerId)!;
    const ownConsent = f.mobile ? await consentOf(accountId, `F:${f._id}`, 'WHATSAPP') : null;
    if (md(f.dob) === mmdd) {
      if (f.mobile && ownConsent === 'GIVEN') out.push({ occasion: 'BIRTHDAY', person: `F:${f._id}`, personName: f.name, recipientKey: `F:${f._id}`, to: f.mobile, customerId: f.customerId, params: { name: f.name.split(' ')[0]! } });
      else out.push({ occasion: 'FAMILY_BIRTHDAY', person: `F:${f._id}`, personName: f.name, recipientKey: `C:${owner._id}`, to: owner.mobile, customerId: f.customerId, params: { 'customer name': owner.name.split(' ')[0]!, 'member name': f.name.split(' ')[0]! } });
    }
    if (md(f.anniversary) === mmdd && f.mobile && ownConsent === 'GIVEN') out.push({ occasion: 'ANNIVERSARY', person: `F:${f._id}`, personName: f.name, recipientKey: `F:${f._id}`, to: f.mobile, customerId: f.customerId, params: { name: f.name.split(' ')[0]! } });
  }
  return out;
}
/** SYS-04: one greeting per person, occasion and year at most (occurrence key, AC-P41-1). */
export async function runGreetingJob(today = istToday()) {
  let queued = 0, skipped = 0;
  const accounts = await Account.find({ 'subscription.plan': 'PREMIUM', 'greetings.on': true }, { _id: 1 }).lean<Array<{ _id: string }>>();
  for (const a of accounts) {
    const adv = await User.findOne({ accountId: a._id, role: 'ADV' }, { name: 1 }).lean<{ name: string }>();
    for (const o of await occasionsOn(a._id, today.slice(5))) {
      const params = { ...o.params, 'advisor name': adv?.name ?? '', occasionPerson: o.person };
      const draft = { accountId: a._id, customerId: o.customerId, personKey: o.recipientKey, channel: 'WHATSAPP', purpose: o.occasion, template: o.occasion, params, to: o.to, text: o.occasion, occurrenceKey: `${a._id}|${o.person}|${o.occasion}|${today.slice(0, 4)}`, day: today };
      const why = await skipFor(draft as unknown as OutboxDoc);
      try { await Outbox.create({ ...draft, status: why ? 'SKIPPED' : 'QUEUED', skipReason: why, history: [{ at: clock.now(), status: why ? 'SKIPPED' : 'QUEUED', note: why }] }); why ? skipped++ : queued++; }
      catch (e) { if (!isDuplicateKey(e)) throw e; }
    }
  }
  return { queued, skipped };
}
export async function maybeRunGreetings(now = clock.now()) {
  const ist = new Date(now.getTime() + 5.5 * 3_600_000);
  if (ist.getUTCHours() < cfgNum('CFG-65')) return null;
  const day = ist.toISOString().slice(0, 10);
  try { await JobRun.create({ _id: `SYS-04|${day}`, at: now }); } catch (e) { if (isDuplicateKey(e)) return null; throw e; }
  return runGreetingJob(day);
}
export async function greetings(ctx: AuthContext) {
  const acc = await Account.findById(ctx.accountId, { subscription: 1, greetings: 1 }).lean<{ subscription: { plan: string | null }; greetings?: { on: boolean; templates: Record<string, string>; excluded: string[] } }>();
  if (acc?.subscription.plan !== 'PREMIUM') return { available: false, messageId: 'SUB-01', message: msg('SUB-01') };
  await ensureSystemTemplates();
  const { cus, fam } = await people(ctx.accountId!);
  const today = istToday();
  const upcoming: Array<{ date: string; person: string; name: string; occasion: string }> = [];
  for (let i = 0; i < cfgNum('CFG-139'); i++) {
    const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    for (const o of await occasionsOn(ctx.accountId!, iso.slice(5))) upcoming.push({ date: iso, person: o.person, name: o.personName, occasion: o.occasion });
  }
  const templates = await MessageTemplate.find({ status: 'ACTIVE', channel: 'WHATSAPP', purpose: { $in: GREETINGS } }, { name: 1, purpose: 1 }).lean();
  return {
    available: true, on: acc.greetings?.on ?? false, templates: acc.greetings?.templates ?? {}, excluded: acc.greetings?.excluded ?? [],
    choices: templates.map((t) => ({ id: t._id, name: t.name, purpose: t.purpose })),
    people: [...cus.map((c) => ({ key: `C:${c._id}`, name: c.name, relationship: 'Customer', birthday: c.dob, anniversary: c.anniversary })), ...fam.map((f) => ({ key: `F:${f._id}`, name: f.name, relationship: f.relationship, birthday: f.dob, anniversary: f.anniversary }))].filter((p) => p.birthday || p.anniversary),
    upcoming,
  };
}
/** Save (COM-06); ON needs a template per occasion (COM-09); OFF cancels queued greetings (COM-08). */
export async function saveGreetings(ctx: AuthContext, b: { on: boolean; templates: Record<string, string>; excluded: string[] }, req: Request) {
  const acc = await planOf(ctx.accountId!);
  if (acc?.subscription.plan !== 'PREMIUM') throw new AppError(403, 'PLAN_REQUIRED', 'SUB-01');
  if (b.on && !GREETINGS.every((g) => b.templates[g])) throw new AppError(400, 'VALIDATION_FAILED', 'COM-09');
  await Account.updateOne({ _id: ctx.accountId }, { $set: { greetings: { on: b.on, templates: b.templates, excluded: b.excluded } } });
  let cancelled = 0;
  if (!b.on) cancelled = (await Outbox.updateMany({ accountId: ctx.accountId, purpose: { $in: GREETINGS }, status: 'QUEUED' }, { $set: { status: 'CANCELLED', skipReason: 'Greetings turned off', statusAt: clock.now() } })).modifiedCount;
  await audit({ entity: 'account', entityId: ctx.accountId!, action: 'GREETINGS_SAVED', after: { on: b.on, excluded: b.excluded.length } }, { req });
  return { on: b.on, cancelled, messageId: (b.on ? 'COM-06' : 'COM-08') as 'COM-06' | 'COM-08' };
}

// ── Communications list, cancel and resend (P-43) ──
const TABS: Record<string, string[]> = { scheduled: ['QUEUED'], sent: ['SENT', 'DELIVERED', 'READ', 'STATUS_UNKNOWN'], failed: ['FAILED', 'SKIPPED', 'CANCELLED'] };
export async function list(ctx: AuthContext, q: { tab?: string; channel?: string; purpose?: string; status?: string; from?: string; to?: string }) {
  const rows = await Outbox.find({ accountId: ctx.accountId, ...(q.status ? { status: q.status } : { status: { $in: TABS[q.tab ?? 'scheduled'] ?? TABS.scheduled } }), ...(q.channel ? { channel: q.channel } : {}), ...(q.purpose ? { purpose: q.purpose } : {}),
    ...(q.from || q.to ? { day: { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) } } : {}) }).sort({ createdAt: -1 }).limit(300).lean<OutboxDoc[]>();
  const names = new Map((await Customer.find({ _id: { $in: rows.map((r) => r.customerId).filter(Boolean) } }, { name: 1 }).lean<Array<{ _id: string; name: string }>>()).map((c) => [c._id, c.name]));
  return rows.map((r) => ({ id: r._id, channel: r.channel, purpose: r.purpose, to: r.to, customer: r.customerId ? names.get(r.customerId) ?? null : null, status: r.status, reason: r.skipReason, createdAt: r.createdAt, sentAt: r.sentAt, statusAt: r.statusAt, text: r.text, history: r.history, resends: r.resends, resendOf: r.resendOf }));
}
export async function cancel(ctx: AuthContext, id: string, req: Request) {
  const u = await Outbox.findOneAndUpdate({ _id: id, accountId: ctx.accountId, status: 'QUEUED' }, { $set: { status: 'CANCELLED', skipReason: 'Cancelled by advisor', statusAt: clock.now() } }, { new: true }).lean();
  if (!u) { const m = await Outbox.findOne({ _id: id, accountId: ctx.accountId }, { status: 1 }).lean<{ status: string }>(); if (!m) throw AppError.notFound(); throw AppError.invalidState('message', m.status); }
  await audit({ entity: 'message', entityId: id, action: 'MESSAGE_CANCELLED' }, { req });
  return { id, status: 'CANCELLED' };
}
/** Resend a FAILED or STATUS_UNKNOWN quotation email or renewal reminder: at most CFG-140 times (COM-12); consent first (AC-P43-3). */
export async function resend(ctx: AuthContext, id: string, req: Request) {
  const m = await Outbox.findOne({ _id: id, accountId: ctx.accountId }).lean<OutboxDoc>();
  if (!m) throw AppError.notFound();
  if (!['FAILED', 'STATUS_UNKNOWN'].includes(m.status) || !['QUOTATION_EMAIL', 'RENEWAL_REMINDER'].includes(m.purpose)) throw AppError.invalidState('message', m.status);
  if (m.resends >= cfgNum('CFG-140')) throw new AppError(409, 'LIMIT_REACHED', 'COM-12');
  const consent = await consentOf(m.accountId, m.personKey ?? (m.customerId ? `C:${m.customerId}` : null), m.channel as Channel);
  if (consent === 'WITHDRAWN' || (m.channel === 'EMAIL' && (await BouncedAddress.exists({ _id: m.to.toLowerCase() })))) throw new AppError(409, 'INVALID_STATE', 'COM-12');
  const u = await Outbox.findOneAndUpdate({ _id: id, resends: m.resends }, { $inc: { resends: 1 } }, { new: true }).lean();
  if (!u) throw AppError.versionConflict('message', null);
  const { _id: _i, createdAt: _c, ...rest } = m as OutboxDoc & { updatedAt?: Date };
  const copy = await Outbox.create({ ...rest, status: 'QUEUED', skipReason: null, providerMessageId: null, attempts: 0, nextAttemptAt: null, sentAt: null, statusAt: null, history: [{ at: clock.now(), status: 'QUEUED', note: 'Resent' }], resendOf: id, resends: 0, occurrenceKey: `${m.occurrenceKey}|resend|${m.resends + 1}`, day: istToday() });
  await audit({ entity: 'message', entityId: id, action: 'MESSAGE_RESENT', after: { newId: copy._id } }, { req });
  return { id: copy._id, status: 'QUEUED' };
}

/** Queue a quotation email (P-28 share by email); the sender sends it. */
export async function queueQuotationEmail(o: { accountId: string; customerId: string; to: string; params: Record<string, string>; quotationId: string; revision: number }) {
  await Outbox.create({ accountId: o.accountId, customerId: o.customerId, personKey: `C:${o.customerId}`, channel: 'EMAIL', purpose: 'QUOTATION_EMAIL', template: 'QT-EMAIL', params: o.params, to: o.to.toLowerCase(), text: 'Quotation email', occurrenceKey: `${o.quotationId}|R${o.revision}|EMAIL|${randomUUID()}`, related: { quotationId: o.quotationId, revision: o.revision }, day: istToday(), history: [{ at: clock.now(), status: 'QUEUED', note: null }] });
}