import type { Request } from 'express';
import { createHash, randomInt } from 'node:crypto';
import { cfgBool, cfgList, cfgNum } from '../../config/cfg.js';
import { clock, istToday } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { hitCounter } from '../../lib/rateCounter.js';
import { isDuplicateKey, withTx } from '../../lib/mongo.js';
import { Account } from '../accounts/account.model.js';
import { nextNumber } from '../accounts/numbers.js';
import { effectiveStatus } from '../accounts/subscription.js';
import { audit } from '../audit/audit.service.js';
import { endSessions } from '../auth/sessions.service.js';
import { Consent, Customer } from '../customers/customer.model.js';
import { InsuranceType } from '../catalogue/types.model.js';
import { Lead } from '../leads/lead.model.js';
import { notify } from '../notifications/notifications.service.js';
import { Policy } from '../policies/policy.model.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { User, USER_MOBILE_INDEX } from '../users/user.model.js';
import { ReferralCode, ReferralSubmission, type CodeDoc, type SubmissionDoc } from './referral.model.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // FLD-26: no 0/O or 1/I look-alikes
const dmy = (iso: string) => iso.split('-').reverse().join('-');
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const link = (code: string) => `${process.env.PUBLIC_APP_URL ?? 'http://localhost:5173'}/r/${code}`;
const masked = (m: string) => `${m.slice(0, m.length - 10)}${m.slice(-10, -8)}XXXXXX${m.slice(-2)}`;

/** A new code, unique by the database rule (codes are never reused). */
async function newCode(accountId: string, referrerUserId: string, note: string | null, session: import('mongoose').ClientSession | null) {
  for (let i = 0; i < 8; i++) {
    const code = Array.from({ length: cfgNum('CFG-73') }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    try { await ReferralCode.create([{ _id: code, accountId, referrerUserId, validUntil: addDays(istToday(), cfgNum('CFG-74')), note }], { session: session ?? undefined }); return code; }
    catch (e) { if (!isDuplicateKey(e)) throw e; }
  }
  throw new Error('Could not make a unique referral code');
}

function enabled() { if (!cfgBool('CFG-103')) throw AppError.invalidState('referral feature', 'switched off'); }

async function rowOf(u: { _id: string; name: string; mobile: string; status: string }) {
  const code = await ReferralCode.findOne({ referrerUserId: u._id }).sort({ createdAt: -1 }).lean<CodeDoc>();
  const subs = await ReferralSubmission.find({ referrerUserId: u._id }).select('leadId').lean<Array<{ leadId: string | null }>>();
  const converted = await Lead.countDocuments({ _id: { $in: subs.map((s) => s.leadId).filter(Boolean) }, status: 'CONVERTED' });
  return { id: u._id, name: u.name, mobile: u.mobile, status: u.status, code: code?._id ?? null, codeStatus: code ? (code.status === 'ACTIVE' && code.validUntil < istToday() ? 'EXPIRED' : code.status) : null, validUntil: code?.validUntil ?? null, note: code?.note ?? null, sent: subs.length, converted, link: code ? link(code._id) : null };
}

export async function list(ctx: AuthContext) {
  const users = await User.find({ accountId: ctx.accountId, role: 'REF' }, { name: 1, mobile: 1, status: 1 }).sort({ createdAt: -1 }).lean<Array<{ _id: string; name: string; mobile: string; status: string }>>();
  return Promise.all(users.map(rowOf));
}

function invitation(name: string, advisor: string) {
  return `Hi ${name.split(' ')[0]}, ${advisor} has invited you to refer friends and family for insurance. Sign in with your mobile number at ${process.env.PUBLIC_APP_URL ?? 'http://localhost:5173'} to get your referral link.`;
}

/** + Referrer (REF-01): the user INVITED and an ACTIVE code. A mobile that is already a user is refused (REF-02, AC-P44-1). */
export async function add(ctx: AuthContext, b: { name: string; mobile: string; note?: string | null }, req: Request) {
  enabled();
  const active = await User.countDocuments({ accountId: ctx.accountId, role: 'REF', status: { $ne: 'DISABLED' } });
  if (active >= cfgNum('CFG-76')) throw new AppError(409, 'LIMIT_REACHED', 'REF-03', { 'CFG-76': cfgNum('CFG-76') });
  if (await User.exists({ mobile: b.mobile })) throw AppError.field('mobile', 'REF-02');
  try {
    const u = await withTx(async (session) => {
      const [u] = await User.create([{ accountId: ctx.accountId, role: 'REF', name: b.name, mobile: b.mobile, status: 'INVITED', invitedBy: ctx.userId, invitedAt: clock.now() }], { session: session ?? undefined });
      await newCode(ctx.accountId!, u!._id, b.note ?? null, session);
      await audit({ entity: 'user', entityId: u!._id, action: 'REFERRER_ADDED', after: { name: b.name, mobile: b.mobile } }, { req, session });
      return u!.toObject() as { _id: string; name: string; mobile: string; status: string };
    });
    const adv = await User.findById(ctx.userId, { name: 1 }).lean<{ name: string }>();
    const text = invitation(b.name, adv?.name ?? 'Your advisor');
    return { referrer: await rowOf(u), invitation: text, whatsappUrl: `https://wa.me/${b.mobile.replace(/^\+/, '')}?text=${encodeURIComponent(text)}`, params: { name: b.name } };
  } catch (e) {
    if (isDuplicateKey(e, USER_MOBILE_INDEX)) throw AppError.field('mobile', 'REF-02');
    throw e;
  }
}

async function loadRef(ctx: AuthContext, id: string) {
  const u = await User.findOne({ _id: id, accountId: ctx.accountId, role: 'REF' }).lean<{ _id: string; name: string; mobile: string; status: string; activatedAt?: Date | null }>();
  if (!u) throw AppError.notFound();
  return u;
}

/** Disable (REF-07): the user DISABLED, sessions ended and the link revoked at once; past leads keep their referrer (AC-P44-2). */
export async function disable(ctx: AuthContext, id: string, req: Request) {
  const u = await loadRef(ctx, id);
  if (u.status === 'DISABLED') throw AppError.invalidState('referrer', 'DISABLED');
  await withTx(async (session) => {
    await User.updateOne({ _id: id }, { $set: { status: 'DISABLED', disabledAt: clock.now() }, $inc: { version: 1 } }, { session: session ?? undefined });
    await ReferralCode.updateMany({ referrerUserId: id, status: 'ACTIVE' }, { $set: { status: 'REVOKED' } }, { session: session ?? undefined });
    await endSessions({ userId: id }, 'USER_DISABLED', session);
    await audit({ entity: 'user', entityId: id, action: 'REFERRER_DISABLED' }, { req, session });
  });
  return { referrer: await rowOf({ ...u, status: 'DISABLED' }), params: { name: u.name } };
}
/** Enable: ACTIVE again (or INVITED if never signed in); a revoked code is replaced by a new one. */
export async function enable(ctx: AuthContext, id: string, req: Request) {
  enabled();
  const u = await loadRef(ctx, id);
  if (u.status !== 'DISABLED') throw AppError.invalidState('referrer', u.status);
  const active = await User.countDocuments({ accountId: ctx.accountId, role: 'REF', status: { $ne: 'DISABLED' } });
  if (active >= cfgNum('CFG-76')) throw new AppError(409, 'LIMIT_REACHED', 'REF-03', { 'CFG-76': cfgNum('CFG-76') });
  const old = await ReferralCode.findOne({ referrerUserId: id }).sort({ createdAt: -1 }).lean<CodeDoc>();
  await withTx(async (session) => {
    await User.updateOne({ _id: id }, { $set: { status: u.activatedAt ? 'ACTIVE' : 'INVITED', disabledAt: null }, $inc: { version: 1 } }, { session: session ?? undefined });
    await newCode(ctx.accountId!, id, old?.note ?? null, session);
    await audit({ entity: 'user', entityId: id, action: 'REFERRER_ENABLED' }, { req, session });
  });
  return rowOf((await User.findById(id).lean<{ _id: string; name: string; mobile: string; status: string }>())!);
}
/** New link (REF-06): a new code; the old one REVOKED (AC-P44-3). */
export async function newLink(ctx: AuthContext, id: string, req: Request) {
  enabled();
  const u = await loadRef(ctx, id);
  if (u.status === 'DISABLED') throw AppError.invalidState('referrer', 'DISABLED');
  const old = await ReferralCode.findOne({ referrerUserId: id }).sort({ createdAt: -1 }).lean<CodeDoc>();
  await withTx(async (session) => {
    await ReferralCode.updateMany({ referrerUserId: id, status: 'ACTIVE' }, { $set: { status: 'REVOKED' } }, { session: session ?? undefined });
    await newCode(ctx.accountId!, id, old?.note ?? null, session);
    await audit({ entity: 'user', entityId: id, action: 'REFERRER_NEW_LINK', before: { code: old?._id ?? null } }, { req, session });
  });
  return rowOf(u);
}

// ── P-45: the referrer's own view (only the fields listed; never premium, product, policy, document, nominee or payment) ──
const SHOWN: Record<string, string> = { NEW: 'New', CONTACTED: 'In progress', QUALIFIED: 'In progress', FOLLOW_UP: 'In progress', CONVERTED: 'Became a customer', LOST: 'Closed' };
async function shownStatus(s: SubmissionDoc) {
  if (s.status === 'LINKED_TO_EXISTING') return 'Already known to the advisor';
  const lead = s.leadId ? await Lead.findById(s.leadId, { status: 1, customerId: 1 }).lean<{ status: string; customerId: string | null }>() : null;
  if (!lead) return 'New';
  if (lead.status === 'CONVERTED' && lead.customerId && (await Policy.exists({ customerId: lead.customerId, status: 'ISSUED', issuedAt: { $gt: s.createdAt } }))) return 'Policy taken';
  return SHOWN[lead.status] ?? 'New';
}
export async function me(ctx: AuthContext) {
  const [adv, acc, code] = await Promise.all([
    User.findOne({ accountId: ctx.accountId, role: 'ADV' }, { name: 1 }).lean<{ name: string }>(),
    Account.findById(ctx.accountId, { 'profile.business.displayName': 1 }).lean<{ profile?: { business?: { displayName?: string | null } } }>(),
    ReferralCode.findOne({ referrerUserId: ctx.userId }).sort({ createdAt: -1 }).lean<CodeDoc>(),
  ]);
  const expired = !code || code.status !== 'ACTIVE' || code.validUntil < istToday();
  return {
    advisorName: adv?.name ?? '', businessName: acc?.profile?.business?.displayName ?? adv?.name ?? '',
    ...(expired ? { link: null, messageId: 'REF-12', message: (await import('../../lib/messages.js')).msg('REF-12', { date: code ? dmy(code.validUntil) : '', 'advisor name': adv?.name ?? '' }) }
      : { link: link(code._id), code: code._id, validUntil: dmy(code.validUntil) }),
  };
}
export async function myReferrals(ctx: AuthContext) {
  const subs = await ReferralSubmission.find({ referrerUserId: ctx.userId }).sort({ createdAt: -1 }).limit(500).lean<SubmissionDoc[]>();
  return Promise.all(subs.map(async (s) => ({ id: s._id, name: s.name, mobile: masked(s.mobile), date: s.createdAt, status: await shownStatus(s) })));
}

/** REF-08 on each status change (dedupe per referral and status). Runs in the minute sweep. */
export async function refreshShownStatuses() {
  const since = new Date(clock.now().getTime() - 400 * 86_400_000);
  let n = 0;
  for await (const s of ReferralSubmission.find({ createdAt: { $gte: since }, shownStatus: { $nin: ['Policy taken', 'Closed', 'Already known to the advisor'] } }).lean<SubmissionDoc>().cursor({ batchSize: 200 })) {
    const now = await shownStatus(s);
    if (now === s.shownStatus) continue;
    await ReferralSubmission.updateOne({ _id: s._id }, { $set: { shownStatus: now } });
    if (s.shownStatus !== null || now !== 'New') { // the first "New" is the submission itself
      await notify({ userId: s.referrerUserId, accountId: s.accountId, kind: 'REFERRAL_STATUS', messageId: 'REF-08', params: { 'prospect first name': s.name.split(' ')[0]!, status: now }, dedupeKey: `REF-08|${s._id}|${now}` }).catch(() => undefined);
      n++;
    }
  }
  return n;
}

// ── P-46: the public form ──
async function liveCode(code: string) {
  const c = await ReferralCode.findById(String(code).toUpperCase()).lean<CodeDoc>();
  if (!c || c.status !== 'ACTIVE' || c.validUntil < istToday() || !cfgBool('CFG-103')) return null;
  const ref = await User.findOne({ _id: c.referrerUserId, role: 'REF', status: { $in: ['ACTIVE', 'INVITED'] } }, { name: 1, status: 1 }).lean<{ _id: string; name: string; status: string }>();
  const acc = await Account.findById(c.accountId).lean<{ status: string; subscription: Parameters<typeof effectiveStatus>[0]; profile?: { business?: { displayName?: string | null } } }>();
  if (!ref || !acc || acc.status !== 'ACTIVE' || !['TRIAL', 'ACTIVE', 'GRACE'].includes(effectiveStatus(acc.subscription, clock.now()))) return null;
  const adv = await User.findOne({ accountId: c.accountId, role: 'ADV' }, { name: 1 }).lean<{ _id: string; name: string }>();
  return { c, ref, adv, businessName: acc.profile?.business?.displayName ?? adv?.name ?? '' };
}
/** The page shows the advisor's name and business only: never their mobile or any customer data. */
export async function publicPage(code: string) {
  const l = await liveCode(code);
  if (!l) return { valid: false, messageId: 'REF-04', message: (await import('../../lib/messages.js')).msg('REF-04') };
  const types = await InsuranceType.find({ status: 'ACTIVE', ownerAccountId: null }, { name: 1 }).sort({ name: 1 }).lean<Array<{ name: string }>>();
  return { valid: true, advisorName: l.adv?.name ?? '', businessName: l.businessName, referrerFirstName: l.ref.name.split(' ')[0], relations: cfgList('CFG-141'), interests: types.map((t) => t.name),
    permission: `I agree that ${l.adv?.name ?? 'the advisor'} may contact me by phone and WhatsApp about insurance.` };
}

export interface SubmitBody { name: string; mobile: string; email?: string | null; relation: string; interest: string; city?: string | null; message?: string | null; permission: true; website?: string }
/**
 * Submit (REF-05). A new mobile → one lead credited to the referrer, WhatsApp consent "Ticked on referral form" (AC-P46-1).
 * A mobile known in the last CFG-77 days → LINKED_TO_EXISTING, no new lead, the same thank-you (AC-P46-2).
 */
export async function submit(code: string, b: SubmitBody, ip: string) {
  const ipKey = createHash('sha256').update(ip).digest('hex').slice(0, 32);
  const hits = await hitCounter(`ref-form:${ipKey}`, 3600);
  if (hits.count > cfgNum('CFG-75')) throw new AppError(429, 'RATE_LIMITED', 'REF-09'); // AC-P46-4
  const l = await liveCode(code);
  if (!l) throw new AppError(409, 'INVALID_STATE', 'REF-04'); // AC-P46-3: creates nothing
  const thanks = { 'first name': b.name.split(' ')[0]!, 'Advisor name': l.adv?.name ?? '' };
  if (b.website) return { params: thanks }; // the invisible trap field: looks accepted, stores nothing
  if (!cfgList('CFG-141').includes(b.relation)) throw AppError.field('relation', 'VAL-22');
  if (!(await InsuranceType.exists({ name: b.interest, status: 'ACTIVE', ownerAccountId: null }))) throw AppError.field('interest', 'VAL-22');
  const accountId = l.c.accountId;
  const since = new Date(clock.now().getTime() - cfgNum('CFG-77') * 86_400_000);
  // A double submit (same code and mobile, a minute apart) is one submission
  if (await ReferralSubmission.exists({ code: l.c._id, mobile: b.mobile, createdAt: { $gte: new Date(clock.now().getTime() - 60_000) } })) return { params: thanks };
  const known = (await Lead.exists({ accountId, mobile: b.mobile, createdAt: { $gte: since } })) || (await Customer.exists({ accountId, mobile: b.mobile, createdAt: { $gte: since } }));
  const acc = await Account.findById(accountId, { pipelines: 1 }).lean<{ pipelines: Array<{ _id: string; position?: number }> }>();
  const pipelineId = [...(acc?.pipelines ?? [])].sort((x, y) => (x.position ?? 0) - (y.position ?? 0))[0]?._id;
  await withTx(async (session) => {
    let leadId: string | null = null;
    if (!known && pipelineId) {
      const number = await nextNumber(accountId, 'lead', session);
      const now = clock.now();
      const [lead] = await Lead.create([{ accountId, number, pipelineId, name: b.name, nameKey: b.name.trim().toLowerCase().replace(/\s+/g, ' '), mobile: b.mobile, email: b.email ?? null,
        source: 'Referred by a referrer', sourceCode: 'REFERRED_BY_REFERRER', referrerUserId: l.ref._id, interests: [b.interest], notes: [b.message, b.city ? `City: ${b.city}` : null, `Knows the referrer as: ${b.relation}`].filter(Boolean).join('\n'),
        status: 'NEW', isOpen: true, createdBy: l.ref._id, stageHistory: [{ from: null, to: 'NEW', by: l.ref._id, at: now }] }], { session: session ?? undefined });
      leadId = lead!._id as string;
      await Consent.create([{ accountId, personKey: `L:${leadId}`, channel: 'WHATSAPP', status: 'GIVEN', address: b.mobile, howGiven: 'Ticked on referral form', recordedBy: l.ref._id, recordedAt: now }], { session: session ?? undefined });
    }
    await ReferralSubmission.create([{ accountId, code: l.c._id, referrerUserId: l.ref._id, name: b.name, mobile: b.mobile, email: b.email ?? null, relation: b.relation, interest: b.interest, city: b.city ?? null, message: b.message ?? null,
      status: leadId ? 'LEAD_CREATED' : 'LINKED_TO_EXISTING', leadId, shownStatus: null, ipHash: ipKey }], { session: session ?? undefined });
  });
  if (l.adv) await notify({ userId: l.adv._id, accountId, kind: 'REFERRAL', messageId: 'DSH-16', params: { referrer: l.ref.name, 'prospect name': `${b.name}${known ? ' (existing)' : ''}` }, dedupeKey: `DSH-16|${l.c._id}|${b.mobile}|${istToday()}` }).catch(() => undefined);
  return { params: thanks }; // never says whether they were already known
}
/** + Refer someone (a referrer, signed in): the same form tied to their code. */
export async function referAsReferrer(ctx: AuthContext, b: SubmitBody, ip: string) {
  const code = await ReferralCode.findOne({ referrerUserId: ctx.userId, status: 'ACTIVE' }).sort({ createdAt: -1 }).lean<CodeDoc>();
  if (!code) throw new AppError(409, 'INVALID_STATE', 'REF-04');
  return submit(code._id, b, ip);
}