import type { Request } from 'express';
import { flagOn } from '../flags/flags.js';
import { randomBytes } from 'node:crypto';
import { cfgBool, cfgNum } from '../../config/cfg.js';
import { clock, istToday } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { msg } from '../../lib/messages.js';
import { audit } from '../audit/audit.service.js';
import { Consent } from '../customers/customer.model.js';
import { notify } from '../notifications/notifications.service.js';
import { getProfile } from '../profile/profile.service.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { PriceVersion } from '../catalogue/price.model.js';
import { User } from '../users/user.model.js';
import { Quotation, type QuotationDoc } from './quotation.model.js';
import { loadQuotation, quotationChecks, quotationContext, quotationView, type Inputs } from './quotations.service.js';

type Rev = QuotationDoc['revisions'][number];
type RevPatch = Record<string, unknown>;
const LIVE = ['READY', 'SHARED', 'ACCEPTED'];
const current = (q: QuotationDoc) => q.revisions[q.revisions.length - 1] as Rev | undefined;
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dmy = (iso: string) => iso.split('-').reverse().join('-');

/** Write the current (last) revision back, conditional on the version (another tab: GEN-05). */
async function setCurrent(q: QuotationDoc, patch: RevPatch, quotationStatus?: string) {
  const revisions = q.revisions.map((r, i) => (i === q.revisions.length - 1 ? { ...r, ...patch } : r));
  const u = await Quotation.findOneAndUpdate({ _id: q._id, version: q.version }, { $set: { revisions, ...(quotationStatus ? { status: quotationStatus } : {}) }, $inc: { version: 1 } }, { new: true }).lean<QuotationDoc>();
  if (!u) throw AppError.versionConflict('quotation', quotationView((await Quotation.findById(q._id).lean<QuotationDoc>())!));
  return u;
}

/**
 * P-28 share: Email, WhatsApp, Copy link or Download PDF. All checks first; the first share (not a download) sets SHARED
 * and validity to the end of the day CFG-46 days later (AC-P28-1); later shares never extend it (AC-P28-2).
 * Email: the outgoing message is recorded as QUEUED; sending arrives with Communications (Module 14). It never changes
 * the quotation's status (AC-P28-6).
 */
export async function share(ctx: AuthContext, id: string, channel: 'EMAIL' | 'WHATSAPP' | 'LINK' | 'DOWNLOAD', req: Request) {
  const q = await loadQuotation(ctx, id);
  const rev = current(q);
  if (!rev || q.status === 'DRAFT' || !LIVE.includes(rev.status)) throw AppError.invalidState('quotation', q.status);
  // Profile items (PRF-03) and the licence date (PRF-13)
  const prof = await getProfile(ctx);
  const missing = prof.completion.missing.filter((g: { section: string }) => ['Personal', 'Contact', 'Professional'].includes(g.section)).flatMap((g: { missing: string[] }) => g.missing);
  if (missing.length) throw new AppError(409, 'INVALID_STATE', 'PRF-03', { 'missing items': missing.join(', ') });
  const until = (prof.sections as { professional?: { licenceValidUntil?: string | null } }).professional?.licenceValidUntil;
  if (until && until < istToday()) throw new AppError(409, 'INVALID_STATE', 'PRF-13');
  if (cfgBool('CFG-100') && (prof as { kycStatus?: string }).kycStatus !== 'VERIFIED') throw new AppError(409, 'INVALID_STATE', 'PRF-03', { 'missing items': 'KYC verification' });
  // Product, mapping and customer as at Generate (steps 1–5)
  const inputs = (rev.snapshot as { inputs: Inputs }).inputs;
  const c = await quotationContext(ctx, q, inputs);
  const problems = quotationChecks(ctx, c, inputs, 5);
  if (problems.length) throw new AppError(409, 'INVALID_STATE', problems[0]!.messageId, problems[0]!.params ?? {});
  // AC-P28-5: a READY revision whose price version has closed cannot be shared (QT-14)
  const pvId = (rev.snapshot as { priceVersionId?: string | null }).priceVersionId;
  if (rev.status === 'READY' && pvId) {
    const pv = await PriceVersion.findById(pvId, { effectiveTo: 1, cancelled: 1 }).lean<{ effectiveTo: string | null }>();
    if (pv?.effectiveTo && pv.effectiveTo < istToday()) throw new AppError(409, 'INVALID_STATE', 'QT-14', { date: dmy(addDays(pv.effectiveTo, 1)) });
  }
  const customer = c.customer!;
  let to: string | null = null;
  if (channel === 'EMAIL') {
    const email = (await import('../customers/customer.model.js').then((m) => m.Customer.findById(customer._id, { email: 1 }).lean<{ email: string | null }>()))?.email;
    if (!email) throw new AppError(409, 'INVALID_STATE', 'QT-23', { customer: customer.name });
    const consent = await Consent.findOne({ customerId: customer._id, channel: 'EMAIL', personKey: `C:${customer._id}` }).sort({ recordedAt: -1 }).lean<{ status: string }>();
    if (consent?.status === 'WITHDRAWN') throw new AppError(409, 'INVALID_STATE', 'QT-22', { Customer: customer.name });
    to = email;
  }
  if (channel !== 'DOWNLOAD') { // daily share limit (CFG-117)
    const start = new Date(`${istToday()}T00:00:00+05:30`);
    const today = await Quotation.aggregate<{ n: number }>([{ $match: { accountId: ctx.accountId } }, { $unwind: '$revisions' }, { $unwind: '$revisions.shares' }, { $match: { 'revisions.shares.at': { $gte: start }, 'revisions.shares.channel': { $ne: 'DOWNLOAD' } } }, { $count: 'n' }]);
    if ((today[0]?.n ?? 0) >= cfgNum('CFG-117')) throw new AppError(429, 'LIMIT_REACHED', 'QT-24');
  }
  const first = channel !== 'DOWNLOAD' && !rev.sharedAt;
  const token = rev.viewToken ?? randomBytes(32).toString('base64url');
  const patch: RevPatch = {
    viewToken: token,
    shares: [...(rev.shares ?? []), { channel, at: clock.now(), by: ctx.userId, to, status: channel === 'EMAIL' ? 'QUEUED' : channel === 'WHATSAPP' ? 'SHARED_MANUALLY' : 'DONE' }],
    ...(first ? { sharedAt: clock.now(), validUntil: addDays(istToday(), cfgNum('CFG-46')), status: rev.status === 'READY' ? 'SHARED' : rev.status } : {}),
  };
  const u = await setCurrent(q, patch, first && rev.status === 'READY' ? 'SHARED' : undefined);
  if (channel === 'EMAIL') {
    const adv = await User.findOne({ accountId: q.accountId, role: 'ADV' }, { name: 1, mobile: 1 }).lean<{ name: string; mobile: string }>();
    await (await import('../comms/comms.service.js')).queueQuotationEmail({ accountId: q.accountId, customerId: customer._id, to: to!, quotationId: id, revision: rev.revision,
      params: { 'customer name': customer.name, 'quotation number': `${q.number} R${rev.revision}`, link: `${process.env.PUBLIC_APP_URL ?? 'http://localhost:5173'}/q/${token}`, 'advisor name': adv?.name ?? '', 'advisor mobile': adv?.mobile ?? '' } });
  }
  await audit({ entity: 'quotation', entityId: id, action: 'QUOTATION_SHARED', after: { channel, revision: rev.revision, first } }, { req });
  const link = `${process.env.PUBLIC_APP_URL ?? 'http://localhost:5173'}/q/${token}`;
  const out = { quotation: quotationView(u), link, pdfFileId: rev.pdfFileId };
  if (channel === 'EMAIL') return { ...out, messageId: 'QT-15' as const, params: { email: to! } };
  if (channel === 'WHATSAPP') {
    const text = `Dear ${customer.name}, here is your insurance quotation ${q.number} R${rev.revision}: ${link}`;
    return { ...out, whatsappUrl: `https://wa.me/${customer.mobile.replace(/^\+/, '')}?text=${encodeURIComponent(text)}`, messageId: 'QT-16' as const, params: {} };
  }
  return { ...out, messageId: (channel === 'LINK' ? 'GEN-16' : 'GEN-08') as 'GEN-16' | 'GEN-08', params: channel === 'LINK' ? {} : { 'Record type': 'Download' } };
}

/**
 * The customer's view link (no login). Shows the quotation while it is live and in date; otherwise QT-20 with the
 * advisor's name and mobile. Records "Viewed by customer".
 */
export async function publicView(token: string) {
  const q = await Quotation.findOne({ 'revisions.viewToken': token }).lean<QuotationDoc>();
  if (!q) throw AppError.notFound();
  const rev = q.revisions.find((r) => r.viewToken === token)!;
  const snap = rev.snapshot as Record<string, any>;
  const adv = await User.findOne({ accountId: q.accountId, role: 'ADV' }, { name: 1, mobile: 1 }).lean<{ name: string; mobile: string }>();
  const alive = ['SHARED', 'ACCEPTED'].includes(rev.status) && rev.validUntil && rev.validUntil >= istToday();
  if (!alive) return { valid: false, messageId: 'QT-20', message: msg('QT-20', { 'advisor name': adv?.name ?? '', 'advisor mobile': adv?.mobile ?? '' }) };
  await Quotation.updateOne({ _id: q._id, 'revisions.viewToken': token }, { $push: { 'revisions.$.views': clock.now() } });
  const payments = await import('../payments/payments.service.js');
  const paid = await payments.paidFor(String(q._id));
  const awaiting = paid ? null : await payments.awaitingFor(String(q._id), rev.revision);
  const payment = paid ? { messageId: 'PAY-14', message: msg('PAY-14', { date: dmy(paid.paymentDate!) }) }
    : awaiting?.link ? { payOn: snap.insurer.name, domain: new URL(awaiting.link).hostname, link: awaiting.link } : null;
  return {
    valid: true, number: snap.number, revision: snap.revision, validUntil: dmy(rev.validUntil!), customer: snap.customer.name,
    people: snap.people.map((p: { name: string; age: number }) => ({ name: p.name, age: p.age })), product: snap.product, insurer: snap.insurer,
    sumInsured: snap.inputs.sumInsured, policyTerm: snap.inputs.policyTerm, startDate: snap.startDate, breakdown: snap.breakdown,
    advisor: { name: snap.advisor.name, businessName: snap.advisor.businessName, mobile: adv?.mobile ?? null }, disclaimer: snap.disclaimer, payment,
  };
}

/** Edit a READY (never shared) revision: back to DRAFT at step 9; its PDF is discarded. */
export async function edit(ctx: AuthContext, id: string, b: { version: number }, req: Request) {
  const q = await loadQuotation(ctx, id);
  const rev = current(q);
  if (q.status !== 'READY' || rev?.status !== 'READY') throw AppError.invalidState('quotation', q.status);
  const u = await Quotation.findOneAndUpdate({ _id: id, version: b.version }, { $set: { status: 'DRAFT', step: 9, revisions: q.revisions.slice(0, -1), calc: null }, $inc: { version: 1 } }, { new: true }).lean<QuotationDoc>();
  if (!u) throw AppError.versionConflict('quotation', quotationView(q));
  await audit({ entity: 'quotation', entityId: id, action: 'QUOTATION_EDITED', after: { revision: rev.revision } }, { req });
  return quotationView(u);
}

/** Revise (QT-25): a new DRAFT with the same inputs; the current revision stays live until the new one is generated. */
export async function revise(ctx: AuthContext, id: string, b: { version: number }, req: Request) {
  const q = await loadQuotation(ctx, id);
  const rev = current(q);
  if (!rev || !['SHARED', 'EXPIRED', 'REJECTED'].includes(q.status)) throw AppError.invalidState('quotation', q.status);
  if (q.revisions.length >= cfgNum('CFG-47')) throw new AppError(409, 'LIMIT_REACHED', 'QT-35', { 'CFG-47': cfgNum('CFG-47') });
  if (await (await import('../payments/payments.service.js')).paidFor(id)) throw new AppError(409, 'INVALID_STATE', 'QT-21'); // AC-P29-2
  const inputs = (rev.snapshot as { inputs: Inputs }).inputs;
  const u = await Quotation.findOneAndUpdate({ _id: id, version: b.version }, { $set: { status: 'DRAFT', step: 8, inputs, calc: null }, $inc: { version: 1 } }, { new: true }).lean<QuotationDoc>();
  if (!u) throw AppError.versionConflict('quotation', quotationView(q));
  await audit({ entity: 'quotation', entityId: id, action: 'QUOTATION_REVISED', after: { from: rev.revision } }, { req });
  return { quotation: quotationView(u), params: { n: rev.revision + 1, 'n-1': rev.revision } };
}

/** Mark accepted (QT-26), rejected (QT-27, reason) or cancelled (QT-28, reason; the view link stops). */
export async function outcome(ctx: AuthContext, id: string, b: { version: number; reason?: string | null }, to: 'ACCEPTED' | 'REJECTED' | 'CANCELLED', req: Request) {
  const q = await loadQuotation(ctx, id);
  const rev = current(q);
  const from: Record<typeof to, string[]> = { ACCEPTED: ['SHARED'], REJECTED: ['SHARED'], CANCELLED: ['READY', 'SHARED', 'ACCEPTED'] };
  if (!rev || q.status === 'DRAFT' || !from[to].includes(rev.status)) throw AppError.invalidState('quotation', q.status);
  if (to !== 'ACCEPTED' && !b.reason?.trim()) throw AppError.field('reason', 'GEN-01', { 'Field label': 'Reason' }); // AC-P29-4
  if (q.version !== b.version) throw AppError.versionConflict('quotation', quotationView(q));
  if (to === 'CANCELLED' && (await (await import('../payments/payments.service.js')).paidFor(id))) throw AppError.invalidState('quotation', 'PAID'); // AC-P29-2
  // Change #11 (Q2): with the account switch on, Mark accepted needs a PAID payment first (QT-45)
  if (to === 'ACCEPTED' && flagOn('quotation_accept_requires_payment', ctx.accountId) && !(await (await import('../payments/payments.service.js')).paidFor(id))) throw new AppError(409, 'INVALID_STATE', 'QT-45');
  const u = await setCurrent(q, { status: to, reason: b.reason ?? null }, to);
  if (to === 'CANCELLED') await (await import('../payments/payments.service.js')).cancelAwaiting(id, [rev.revision]);
  await audit({ entity: 'quotation', entityId: id, action: `QUOTATION_${to}`, after: { revision: rev.revision, reason: b.reason ?? null } }, { req });
  return quotationView(u);
}

/** Delete a draft that was never generated (QT-29); a revision draft is discarded and the earlier revision stays live. */
export async function deleteDraft(ctx: AuthContext, id: string, req: Request) {
  const q = await loadQuotation(ctx, id);
  if (q.status !== 'DRAFT') throw AppError.invalidState('quotation', q.status);
  if (!q.revisions.length) await Quotation.deleteOne({ _id: id, status: 'DRAFT' });
  else await Quotation.updateOne({ _id: id, status: 'DRAFT' }, { $set: { status: current(q)!.status === 'SUPERSEDED' ? 'READY' : current(q)!.status, calc: null }, $inc: { version: 1 } });
  await audit({ entity: 'quotation', entityId: id, action: 'QUOTATION_DRAFT_DELETED' }, { req });
}

/**
 * SYS-01 expiry: SHARED revisions past their validity become EXPIRED; the advisor gets DSH-15 in the bell. Conditional
 * updates and the bell's dedupe key make it safe to run twice (AC-P29-3).
 */
export async function expireDue(today = istToday()) {
  const due = await Quotation.find({ status: 'SHARED', 'revisions.validUntil': { $lt: today } }).lean<QuotationDoc[]>();
  let n = 0;
  for (const q of due) {
    const rev = current(q);
    if (!rev || rev.status !== 'SHARED' || !rev.validUntil || rev.validUntil >= today) continue;
    const revisions = q.revisions.map((r, i) => (i === q.revisions.length - 1 ? { ...r, status: 'EXPIRED' } : r));
    const u = await Quotation.updateOne({ _id: q._id, version: q.version, status: 'SHARED' }, { $set: { status: 'EXPIRED', revisions }, $inc: { version: 1 } });
    if (!u.modifiedCount) continue;
    n++;
    const adv = await User.findOne({ accountId: q.accountId, role: 'ADV' }, { _id: 1 }).lean<{ _id: string }>();
    if (adv) await notify({ userId: adv._id, accountId: q.accountId, kind: 'QUOTATION_EXPIRED', messageId: 'DSH-15', params: { 'Quotation number': `${q.number} R${rev.revision}`, customer: (rev.snapshot as { customer: { name: string } }).customer.name }, dedupeKey: `DSH-15|${q._id}|${rev.revision}` });
  }
  return n;
}