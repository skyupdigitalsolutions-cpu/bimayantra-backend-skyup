/**
 * Consent requests: the customer (or a family member) gives consent themselves.
 *
 *   Advisor  POST /customers/:id/consent-requests { personType, personId, channels, via }
 *            via EMAIL    → Bimayantra emails the link (outbox, purpose CONSENT_REQUEST; the advisor's Brevo when connected)
 *            via WHATSAPP → a wa.me link with the message ready; the advisor sends it from their own WhatsApp
 *            via TELEGRAM → a t.me share link with the message ready; the advisor picks the customer's chat
 *            POST /customers/:id/consent-requests/:requestId/cancel
 *   Person   GET  /public/consent/:token  → what is asked, for which mobile / email (masked)
 *            POST /public/consent/:token { agree, channels, declaration } → consent GIVEN on the customer record
 *
 * WhatsApp is sent from the advisor's own app on purpose: Meta allows business messages through the WhatsApp API only
 * to people who already opted in, which is exactly what this request is asking for.
 */
import type { Request } from 'express';
import { createHmac } from 'node:crypto';
import { cfgNum } from '../../config/cfg.js';
import { env } from '../../config/env.js';
import { clock, istDate, istToday } from '../../lib/clock.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { msg, type MessageId, type MessageParams } from '../../lib/messages.js';
import { withTx } from '../../lib/mongo.js';
import { maskMobile } from '../../lib/phone.js';
import { hitCounter } from '../../lib/rateCounter.js';
import { accountOf } from '../../middleware/authorize.js';
import { Account } from '../accounts/account.model.js';
import { audit } from '../audit/audit.service.js';
import { Outbox } from '../comms/outbox.model.js';
import { notify } from '../notifications/notifications.service.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { User } from '../users/user.model.js';
import { CHANNEL_LABEL, personKey } from './consent.service.js';
import { ConsentRequest, type ConsentRequestDoc, type RequestVia } from './consentRequest.model.js';
import { Consent, CUSTOMER_HOW_GIVEN, Customer, FamilyMember, type ConsentChannel, type ConsentDoc } from './customer.model.js';

const VIA_LABEL: Record<RequestVia, string> = { EMAIL: 'Email', WHATSAPP: 'WhatsApp', TELEGRAM: 'Telegram' };
/** What the person agrees to, in their words (shown on the page and in the message). */
const PURPOSE: Record<ConsentChannel, string> = {
  WHATSAPP: 'messages about your policies on WhatsApp',
  EMAIL: 'emails about your policies',
  SMS: 'SMS messages about your policies',
  PERSONAL_DATA: 'keeping your PAN, Aadhaar and documents on record',
};
const ORDER: ConsentChannel[] = ['WHATSAPP', 'EMAIL', 'SMS', 'PERSONAL_DATA'];
const needsMobile = (ch: ConsentChannel) => ch === 'WHATSAPP' || ch === 'SMS';
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
const listOf = (chs: string[]) => {
  const words = chs.map((c) => PURPOSE[c as ConsentChannel] ?? c);
  return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join('; ')} and ${words.at(-1)}`;
};
const labels = (chs: string[]) => chs.map((c) => CHANNEL_LABEL[c as ConsentChannel] ?? c).join(', ');
export const maskEmail = (e: string | null | undefined) => {
  if (!e) return null;
  const [u = '', d = ''] = e.split('@');
  return `${u.slice(0, 2)}${'*'.repeat(Math.max(1, Math.min(6, u.length - 2)))}@${d}`;
};
const maskTo = (r: { via: string; sentTo?: string | null }) => (r.via === 'EMAIL' ? maskEmail(r.sentTo) : r.via === 'WHATSAPP' ? maskMobile(r.sentTo) : null);
export const consentLink = (token: string) => `${env.PUBLIC_APP_URL.replace(/\/$/, '')}/consent/${token}`;
/** PENDING past its date reads as EXPIRED (no job needed). */
const effective = (r: Pick<ConsentRequestDoc, 'status' | 'expiresAt'>, now = clock.now()) => (r.status === 'PENDING' && new Date(r.expiresAt).getTime() <= now.getTime() ? 'EXPIRED' : r.status);

async function advisorOf(accountId: string) {
  return User.findOne({ accountId, role: 'ADV' }, { name: 1, mobile: 1 }).lean<{ _id: string; name: string; mobile: string | null }>();
}

/** The person the request is for, with the contacts consent would belong to. */
async function personOf(accountId: string, customer: { _id: string; name: string; mobile: string; email?: string | null }, personType: 'CUSTOMER' | 'FAMILY', personId: string) {
  if (personType === 'CUSTOMER') {
    if (personId !== customer._id) throw AppError.field('personId', 'VAL-22');
    return { type: 'CUSTOMER' as const, id: customer._id, name: customer.name, mobile: customer.mobile ?? null, email: customer.email ?? null, key: personKey('C', customer._id) };
  }
  const m = await FamilyMember.findOne({ _id: personId, accountId, customerId: customer._id, status: 'ACTIVE' }).lean<{ _id: string; name: string; mobile?: string | null; email?: string | null }>();
  if (!m) throw AppError.field('personId', 'VAL-22');
  return { type: 'FAMILY' as const, id: m._id, name: m.name, mobile: m.mobile ?? null, email: m.email ?? null, key: personKey('F', m._id) };
}

/** The message the person receives (WhatsApp, Telegram; email uses the CONSENT_REQUEST template with the same values). */
export function requestMessage(o: { name: string; advisor: string; advisorMobile?: string | null; channels: string[]; link: string | null; validUntil: string }) {
  return [
    `Dear ${firstName(o.name)},`,
    '',
    `${o.advisor}, your insurance advisor, asks for your consent to ${listOf(o.channels)}.`,
    '',
    o.link ? `Please open this link to agree or say no: ${o.link}` : 'Please open the link to agree or say no.',
    `The link works until ${o.validUntil}.`,
    '',
    `${o.advisor}${o.advisorMobile ? `, ${o.advisorMobile}` : ''}`,
  ].join('\n');
}

export interface RequestInput { personType: 'CUSTOMER' | 'FAMILY'; personId: string; channels: ConsentChannel[]; via: RequestVia }

/** Advisor: create a request and hand back the link (and the WhatsApp / Telegram link with the message ready). */
export async function createConsentRequest(ctx: AuthContext, customerId: string, b: RequestInput, req: Request) {
  const accountId = accountOf(ctx);
  const customer = await Customer.findOne({ _id: customerId, accountId }).lean<{ _id: string; number: string; name: string; mobile: string; email?: string | null; status: string }>();
  if (!customer) throw AppError.notFound();
  if (customer.status !== 'ACTIVE') throw new AppError(409, 'INVALID_STATE', 'CU-20', { Customer: customer.name });
  const person = await personOf(accountId, customer, b.personType, b.personId);
  const channels = ORDER.filter((c) => b.channels.includes(c));
  if (!channels.length) throw AppError.field('channels', 'GEN-01', { 'Field label': 'Consent' });
  if (person.type === 'FAMILY' && channels.includes('PERSONAL_DATA')) throw AppError.field('channels', 'VAL-22');
  for (const ch of channels) {
    if (needsMobile(ch) && !person.mobile) throw new AppError(409, 'INVALID_STATE', 'CU-13', { name: person.name, channel: CHANNEL_LABEL[ch] });
    if (ch === 'EMAIL' && !person.email) throw new AppError(409, 'INVALID_STATE', 'CU-14', { name: person.name });
  }
  // How it reaches them
  const current = await Consent.find({ accountId, personKey: person.key }, { channel: 1, status: 1, address: 1 }).lean<Array<Pick<ConsentDoc, 'channel' | 'status' | 'address'>>>();
  if (b.via === 'EMAIL') {
    if (!person.email) throw new AppError(409, 'INVALID_STATE', 'CU-14', { name: person.name });
    if (current.find((c) => c.channel === 'EMAIL')?.status === 'WITHDRAWN') throw new AppError(409, 'INVALID_STATE', 'CU-41', { name: person.name });
  }
  if (b.via === 'WHATSAPP' && !person.mobile) throw new AppError(409, 'INVALID_STATE', 'CU-13', { name: person.name, channel: 'WhatsApp' });
  // Nothing to ask for what is already given for the same mobile / email
  const addressFor = (ch: ConsentChannel) => (needsMobile(ch) ? person.mobile : ch === 'EMAIL' ? person.email : null);
  const already = channels.filter((ch) => current.some((c) => c.channel === ch && c.status === 'GIVEN' && (c.address ?? null) === addressFor(ch)));
  if (already.length) throw new AppError(409, 'INVALID_STATE', 'CU-42', { name: person.name, channels: labels(already) });
  // Daily limit per person (CFG-198)
  const dayStart = new Date(`${istToday()}T00:00:00+05:30`);
  if ((await ConsentRequest.countDocuments({ accountId, personKey: person.key, createdAt: { $gte: dayStart } })) >= cfgNum('CFG-198')) {
    throw new AppError(429, 'LIMIT_REACHED', 'CU-51', { name: person.name });
  }

  const now = clock.now();
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + cfgNum('CFG-197') * 86_400_000);
  const validUntil = istDate(istToday(expiresAt));
  const link = consentLink(token);
  const adv = await advisorOf(accountId);
  const advisor = adv?.name ?? 'Your advisor';
  const text = requestMessage({ name: person.name, advisor, advisorMobile: adv?.mobile ?? null, channels, link, validUntil });

  const doc = new ConsentRequest({
    accountId, customerId, personType: person.type, personId: person.id, personKey: person.key, channels, via: b.via,
    sentTo: b.via === 'EMAIL' ? person.email!.toLowerCase() : b.via === 'WHATSAPP' ? person.mobile : null,
    contacts: { mobile: person.mobile, email: person.email ? person.email.toLowerCase() : null },
    tokenHash: sha256(token), expiresAt, createdBy: ctx.userId,
  });
  await withTx(async (session) => {
    // An older open request for the same person that asks for nothing more is replaced: one live link at a time.
    const older = await ConsentRequest.find({ accountId, personKey: person.key, status: 'PENDING', expiresAt: { $gt: now } }, { channels: 1, outboxId: 1 }).session(session).lean<Array<{ _id: string; channels: string[]; outboxId: string | null }>>();
    for (const o of older.filter((x) => x.channels.every((c) => channels.includes(c as ConsentChannel)))) {
      await ConsentRequest.updateOne({ _id: o._id, status: 'PENDING' }, { $set: { status: 'CANCELLED', closedReason: 'Replaced by a newer request' }, $inc: { version: 1 } }, { session: session ?? undefined });
      if (o.outboxId) await Outbox.updateOne({ _id: o.outboxId, status: 'QUEUED' }, { $set: { status: 'CANCELLED', skipReason: 'Replaced by a newer request', statusAt: now } }, { session: session ?? undefined });
    }
    if (b.via === 'EMAIL') {
      const [m] = await Outbox.create([{
        accountId, customerId, personKey: person.key, channel: 'EMAIL', purpose: 'CONSENT_REQUEST', template: 'CONSENT-REQ',
        params: { name: firstName(person.name), 'advisor name': advisor, 'advisor mobile': adv?.mobile ?? '', link, consents: listOf(channels), 'valid until': validUntil },
        to: person.email!.toLowerCase(), text: 'Consent request', occurrenceKey: `${doc._id}|EMAIL`, related: { consentRequestId: doc._id }, day: istToday(),
        history: [{ at: now, status: 'QUEUED', note: null }],
      }], { session: session ?? undefined });
      doc.outboxId = m!._id;
    }
    await doc.save({ session: session ?? undefined });
    await audit({
      entity: 'consent', entityId: customerId, entityRef: customer.number, action: 'CONSENT_REQUESTED',
      after: { person: person.name, channels, via: b.via, request: doc._id, expiresAt },
    }, { req, session });
  });

  const out: { request: ReturnType<typeof requestView>; link: string; text: string; whatsappUrl?: string; telegramUrl?: string } = {
    request: requestView(doc.toObject() as ConsentRequestDoc, person.name, null), link, text,
  };
  if (b.via === 'WHATSAPP') out.whatsappUrl = `https://wa.me/${person.mobile!.replace(/^\+/, '')}?text=${encodeURIComponent(text)}`;
  if (b.via === 'TELEGRAM') {
    const share = requestMessage({ name: person.name, advisor, advisorMobile: adv?.mobile ?? null, channels, link: null, validUntil });
    out.telegramUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(share)}`;
  }
  const done: { messageId: MessageId; params: MessageParams } = b.via === 'EMAIL'
    ? { messageId: 'CU-39', params: { email: person.email!, name: person.name } }
    : { messageId: 'CU-40', params: { name: person.name, via: VIA_LABEL[b.via] } };
  return { ...out, ...done };
}

function requestView(r: ConsentRequestDoc, name: string | null, email: { status: string; reason: string | null } | null) {
  return {
    id: r._id, person: { type: r.personType, id: r.personId, name: name ?? 'Former family member' }, channels: r.channels, via: r.via, sentTo: maskTo(r),
    status: effective(r), createdAt: r.createdAt ?? null, expiresAt: r.expiresAt, openedAt: r.openedAt ?? null, respondedAt: r.respondedAt ?? null,
    given: r.given ?? [], declined: r.declined ?? [], closedReason: r.closedReason ?? null, email,
  };
}

/** The customer's recent requests (consent tab): newest first, with the email's delivery status. */
export async function listConsentRequests(ctx: AuthContext, customerId: string) {
  const accountId = accountOf(ctx);
  const rows = await ConsentRequest.find({ accountId, customerId }).sort({ createdAt: -1 }).limit(20).lean<ConsentRequestDoc[]>();
  if (!rows.length) return [];
  const customer = await Customer.findOne({ _id: customerId, accountId }, { name: 1 }).lean<{ _id: string; name: string }>();
  const fam = await FamilyMember.find({ accountId, customerId }, { name: 1 }).lean<Array<{ _id: string; name: string }>>();
  const names = new Map<string, string>([...(customer ? [[customer._id, customer.name] as [string, string]] : []), ...fam.map((f) => [f._id, f.name] as [string, string])]);
  const ids = rows.map((r) => r.outboxId).filter(Boolean) as string[];
  const mails = ids.length ? await Outbox.find({ _id: { $in: ids } }, { status: 1, skipReason: 1 }).lean<Array<{ _id: string; status: string; skipReason: string | null }>>() : [];
  return rows.map((r) => {
    const m = mails.find((x) => x._id === r.outboxId);
    return requestView(r, names.get(r.personId) ?? null, m ? { status: m.status, reason: m.skipReason ?? null } : null);
  });
}

/** Advisor: cancel an open request; its link stops working and a queued email is not sent. */
export async function cancelConsentRequest(ctx: AuthContext, customerId: string, requestId: string, req: Request) {
  const accountId = accountOf(ctx);
  const r = await ConsentRequest.findOne({ _id: requestId, accountId, customerId }).lean<ConsentRequestDoc>();
  if (!r) throw AppError.notFound();
  const status = effective(r);
  if (status !== 'PENDING') throw AppError.invalidState('consent request', status.toLowerCase());
  const now = clock.now();
  const u = await ConsentRequest.updateOne({ _id: r._id, status: 'PENDING' }, { $set: { status: 'CANCELLED', closedReason: 'Cancelled by advisor' }, $inc: { version: 1 } });
  if (!u.modifiedCount) throw AppError.versionConflict('consent request', null);
  if (r.outboxId) await Outbox.updateOne({ _id: r.outboxId, status: 'QUEUED' }, { $set: { status: 'CANCELLED', skipReason: 'Consent request cancelled', statusAt: now } });
  await audit({ entity: 'consent', entityId: customerId, action: 'CONSENT_REQUEST_CANCELLED', after: { request: r._id } }, { req });
}

// ── The person's page (no sign-in) ──

type Loaded = { r: ConsentRequestDoc; person: { name: string; mobile: string | null; email: string | null }; adv: { name: string; mobile: string | null } | null };
type Check = { ok: true; data: Loaded } | { ok: false; answered: boolean; messageId: MessageId; params: MessageParams; adv: Loaded['adv'] };

async function load(token: string): Promise<Check> {
  const r = await ConsentRequest.findOne({ tokenHash: sha256(token) }).lean<ConsentRequestDoc>();
  if (!r) throw AppError.notFound();
  const adv = await advisorOf(r.accountId);
  const invalid = (): Check => ({ ok: false, answered: false, messageId: 'CU-44', params: { 'advisor name': adv?.name ?? 'your advisor', 'advisor mobile': adv?.mobile ?? '' }, adv: adv ? { name: adv.name, mobile: adv.mobile } : null });
  if (r.status === 'CONFIRMED' || r.status === 'DECLINED') return { ok: false, answered: true, messageId: 'CU-45', params: {}, adv: adv ? { name: adv.name, mobile: adv.mobile } : null };
  if (effective(r) !== 'PENDING') return invalid();
  const acc = await Account.findById(r.accountId, { status: 1 }).lean<{ status: string }>();
  const customer = await Customer.findOne({ _id: r.customerId, accountId: r.accountId }, { name: 1, mobile: 1, email: 1, status: 1 }).lean<{ name: string; mobile: string; email?: string | null; status: string }>();
  if (!acc || acc.status !== 'ACTIVE' || !customer || customer.status !== 'ACTIVE') return invalid();
  let person: Loaded['person'] | null = null;
  if (r.personType === 'CUSTOMER') person = { name: customer.name, mobile: customer.mobile ?? null, email: customer.email ?? null };
  else {
    const m = await FamilyMember.findOne({ _id: r.personId, accountId: r.accountId, customerId: r.customerId, status: 'ACTIVE' }, { name: 1, mobile: 1, email: 1 }).lean<{ name: string; mobile?: string | null; email?: string | null }>();
    if (m) person = { name: m.name, mobile: m.mobile ?? null, email: m.email ?? null };
  }
  if (!person) return invalid();
  // Consent belongs to the exact mobile / email the request was made for (P-15)
  const chs = r.channels as ConsentChannel[];
  const mobileChanged = chs.some(needsMobile) && (person.mobile ?? null) !== (r.contacts?.mobile ?? null);
  const emailChanged = chs.includes('EMAIL') && (person.email?.toLowerCase() ?? null) !== (r.contacts?.email ?? null);
  if (mobileChanged || emailChanged) {
    await ConsentRequest.updateOne({ _id: r._id, status: 'PENDING' }, { $set: { status: 'EXPIRED', closedReason: 'Contact details changed' }, $inc: { version: 1 } });
    return invalid();
  }
  return { ok: true, data: { r, person, adv: adv ? { name: adv.name, mobile: adv.mobile } : null } };
}

/** GET /public/consent/:token — what is asked, of whom, for which mobile / email. Opening it is noted once. */
export async function publicConsentView(token: string) {
  const c = await load(token);
  if (!c.ok) return { valid: false, answered: c.answered, messageId: c.messageId, message: msg(c.messageId, c.params), advisor: c.adv };
  const { r, person, adv } = c.data;
  if (!r.openedAt) await ConsentRequest.updateOne({ _id: r._id, openedAt: null }, { $set: { openedAt: clock.now() } });
  return {
    valid: true, name: person.name, via: r.via, validUntil: istDate(istToday(new Date(r.expiresAt))),
    advisor: adv ? { name: adv.name, mobile: adv.mobile } : null,
    channels: (r.channels as ConsentChannel[]).map((ch) => ({
      channel: ch, label: CHANNEL_LABEL[ch], purpose: PURPOSE[ch],
      address: needsMobile(ch) ? maskMobile(person.mobile) : ch === 'EMAIL' ? maskEmail(person.email) : null,
    })),
    termsVersion: r.channels.includes('PERSONAL_DATA') ? env.TERMS_VERSION : null,
  };
}

export interface RespondInput { agree: boolean; channels?: ConsentChannel[]; declaration?: boolean }

/**
 * POST /public/consent/:token — the person answers. Agreeing records consent GIVEN for each ticked channel on the
 * customer record (source CUSTOMER, how: "Confirmed by the customer (… link)"), exactly once; the advisor is told.
 * Saying no records nothing (provisional Q-CR2) and closes the request.
 */
export async function respondConsent(token: string, b: RespondInput, req: Request) {
  const ipKey = createHmac('sha256', 'ip').update(req.ip ?? '').digest('hex').slice(0, 24);
  if ((await hitCounter(`consent-link:${ipKey}`, 3600)).count > cfgNum('CFG-199')) throw new AppError(429, 'RATE_LIMITED', 'GEN-15', { seconds: 3600 });
  const c = await load(token);
  if (!c.ok) throw new AppError(409, 'INVALID_STATE', c.messageId, c.params);
  const { r, person, adv } = c.data;
  const asked = r.channels as ConsentChannel[];
  const given = b.agree ? ORDER.filter((ch) => (b.channels ?? asked).includes(ch)) : [];
  if (b.agree) {
    if (given.some((ch) => !asked.includes(ch))) throw AppError.field('channels', 'VAL-22');
    const errs: Array<{ field: string; messageId: MessageId; params?: MessageParams }> = [];
    if (!given.length) errs.push({ field: 'channels', messageId: 'GEN-01', params: { 'Field label': 'Consent' } });
    if (b.declaration !== true) errs.push({ field: 'declaration', messageId: 'VAL-29' });
    if (errs.length) throw AppError.fields(errs);
  }
  const declined = asked.filter((ch) => !given.includes(ch));
  const status = given.length ? 'CONFIRMED' : 'DECLINED';
  const now = clock.now();
  const howGiven = CUSTOMER_HOW_GIVEN[r.via as RequestVia];
  const customer = await Customer.findById(r.customerId, { number: 1 }).lean<{ number: string }>();

  await withTx(async (session) => {
    const claim = await ConsentRequest.updateOne(
      { _id: r._id, status: 'PENDING', expiresAt: { $gt: now } },
      { $set: { status, respondedAt: now, given, declined }, $inc: { version: 1 } },
      { session: session ?? undefined },
    );
    if (!claim.modifiedCount) throw new AppError(409, 'INVALID_STATE', 'CU-45'); // a second tap, or another tab
    for (const ch of given) {
      const address = needsMobile(ch) ? person.mobile : ch === 'EMAIL' ? (person.email?.toLowerCase() ?? null) : null;
      const existing = await Consent.findOne({ accountId: r.accountId, personKey: r.personKey, channel: ch }).session(session).lean<ConsentDoc>();
      if (existing?.status === 'GIVEN' && (existing.address ?? null) === address) continue;
      const change = { from: existing?.status ?? 'NOT_RECORDED', to: 'GIVEN', address, howGiven, note: `Consent request ${r._id}`, source: 'CUSTOMER', by: null, at: now };
      const termsVersion = ch === 'PERSONAL_DATA' ? env.TERMS_VERSION : null;
      const reset = { evidenceFileId: null, withdrawReason: null, withdrawNote: null, acknowledgedEffects: null };
      if (existing) {
        const u = await Consent.updateOne(
          { _id: existing._id, version: existing.version },
          { $set: { ...reset, status: 'GIVEN', address, howGiven, termsVersion: termsVersion ?? existing.termsVersion, recordedBy: null, recordedAt: now }, $inc: { version: 1 }, $push: { history: change } },
          { session: session ?? undefined },
        );
        if (!u.modifiedCount) throw AppError.versionConflict('consent', null);
      } else {
        await new Consent({ accountId: r.accountId, personKey: r.personKey, customerId: r.customerId, channel: ch, status: 'GIVEN', address, howGiven, ...reset, termsVersion, recordedBy: null, recordedAt: now, history: [change] }).save({ session: session ?? undefined });
      }
    }
    await audit({
      entity: 'consent', entityId: r.customerId, entityRef: customer?.number ?? null, action: given.length ? 'CONSENT_GIVEN' : 'CONSENT_REQUEST_DECLINED',
      actor: { userId: null, role: null, accountId: r.accountId, label: `${person.name} (consent link)` },
      after: { person: person.name, given, declined, via: r.via, request: r._id, howGiven: given.length ? howGiven : null },
    }, { req, session });
  });

  // The advisor (and the assistant who sent it) are told in the bell.
  const bell: { messageId: MessageId; params: MessageParams } = given.length ? { messageId: 'CU-46', params: { name: person.name, channels: labels(given) } } : { messageId: 'CU-47', params: { name: person.name } };
  const advId = (await User.findOne({ accountId: r.accountId, role: 'ADV' }, { _id: 1 }).lean<{ _id: string }>())?._id;
  for (const userId of new Set([advId, r.createdBy].filter(Boolean) as string[])) {
    await notify({ userId, accountId: r.accountId, kind: 'CONSENT', ...bell, dedupeKey: `CONSENT-REQ|${r._id}`, link: { type: 'CUSTOMER', id: r.customerId } }).catch(() => undefined);
  }
  return given.length
    ? { data: { status, given }, messageId: 'CU-48' as MessageId, params: { name: firstName(person.name) } as MessageParams }
    : { data: { status, given }, messageId: 'CU-49' as MessageId, params: { 'advisor name': adv?.name ?? 'your advisor' } as MessageParams };
}

/** The sender skips a consent-request email whose request was answered, cancelled or replaced meanwhile. */
export async function consentRequestClosed(requestId: string) {
  const r = await ConsentRequest.findById(requestId, { status: 1, expiresAt: 1 }).lean<Pick<ConsentRequestDoc, 'status' | 'expiresAt'>>();
  return !r || effective(r) !== 'PENDING';
}