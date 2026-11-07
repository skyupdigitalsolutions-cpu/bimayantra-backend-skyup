import type { Request } from 'express';
import { cfgList, cfgNum } from '../../config/cfg.js';
import { clock, istToday } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { msg } from '../../lib/messages.js';
import { isDuplicateKey, withTx } from '../../lib/mongo.js';
import { logger } from '../../lib/logger.js';
import { Account } from '../accounts/account.model.js';
import { audit } from '../audit/audit.service.js';
import { Outbox } from '../comms/outbox.model.js';
import { Consent, Customer } from '../customers/customer.model.js';
import { Insurer } from '../insurers/insurer.model.js';
import { notify } from '../notifications/notifications.service.js';
import { Payment } from '../payments/payment.model.js';
import { Policy, type PolicyDoc } from '../policies/policy.model.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { User } from '../users/user.model.js';
import { JobRun, RenewalCycle, type CycleDoc } from './renewal.model.js';

const OPEN = ['DUE', 'IN_FOLLOW_UP'];
const dmy = (iso: string) => iso.split('-').reverse().join('-');
const iso = (d: string) => (/^\d{2}-\d{2}-\d{4}$/.test(d) ? d.split('-').reverse().join('-') : d);
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** The skip rules for a customer reminder (P-37; checked when queued and again on every run). */
export async function skipReason(c: CycleDoc, channel: 'EMAIL' | 'WHATSAPP'): Promise<string | null> {
  if (!OPEN.includes(c.status)) return `Renewal ${c.status.replace('_', ' ').toLowerCase()}`;
  if (c.remindersPaused) return 'Reminders paused';
  const cus = await Customer.findById(c.customerId, { status: 1, email: 1 }).lean<{ status: string; email: string | null }>();
  if (!cus || cus.status !== 'ACTIVE') return 'Customer inactive';
  const pol = await Policy.findById(c.policyId, { status: 1 }).lean<{ status: string }>();
  if (pol?.status === 'CANCELLED') return 'Policy cancelled';
  const consent = await Consent.findOne({ accountId: c.accountId, personKey: `C:${c.customerId}`, channel }, { status: 1 }).lean<{ status: string }>();
  if (channel === 'EMAIL') {
    if (!cus.email) return 'No email address';
    if (consent?.status === 'WITHDRAWN') return 'Consent withdrawn'; // AC-P37-3
  } else {
    const acc = await Account.findById(c.accountId, { 'subscription.plan': 1 }).lean<{ subscription: { plan: string | null } }>();
    if (acc?.subscription.plan !== 'PREMIUM') return 'Not on the Premium plan'; // AC-P37-2
    if (consent?.status !== 'GIVEN') return consent?.status === 'WITHDRAWN' ? 'Consent withdrawn' : 'Consent missing';
  }
  return null;
}

/** Recheck queued messages (and stop them when a rule now applies): withdrawn consent, paused, not renewing… */
export async function recheckQueued(filter: Record<string, unknown> = {}) {
  const queued = await Outbox.find({ status: 'QUEUED', 'related.cycleId': { $exists: true }, ...filter }).lean<Array<{ _id: string; channel: 'EMAIL' | 'WHATSAPP'; related: { cycleId: string } }>>();
  let n = 0;
  for (const m of queued) {
    const c = await RenewalCycle.findById(m.related.cycleId).lean<CycleDoc>();
    const why = c ? await skipReason(c, m.channel) : 'Renewal removed';
    if (why) { await Outbox.updateOne({ _id: m._id, status: 'QUEUED' }, { $set: { status: 'SKIPPED', skipReason: why } }); n++; }
  }
  return n;
}

/** Reminder offsets due today: exactly on the day, or missed by no more than CFG-137 days (never older). */
const dueOffsets = (offsets: number[], daysLeft: number) => offsets.filter((o) => daysLeft <= o && o - daysLeft <= cfgNum('CFG-137'));

/**
 * SYS-03 daily renewal job (P-37). Safe to run more than once a day: occurrence keys (customer messages) and dedupe
 * keys (advisor reminders) stop duplicates (AC-P37-1). Works in batches; IST calendar dates throughout (GR-25).
 */
export async function runRenewalJob(today = istToday()) {
  const result = { due: 0, advisorReminders: 0, queued: 0, skipped: 0, expired: 0, lapsed: 0, stopped: 0 };
  // 1. UPCOMING → DUE within CFG-59 days
  result.due = (await RenewalCycle.updateMany({ status: 'UPCOMING', dueDate: { $lte: addDays(today, cfgNum('CFG-59')) } }, { $set: { status: 'DUE' }, $inc: { version: 1 } })).modifiedCount;
  // Queued reminders that a rule now stops
  result.stopped = await recheckQueued();
  const advisorOffsets = cfgList('CFG-60') as unknown as number[];
  const customerOffsets = cfgList('CFG-61') as unknown as number[];
  for await (const c of RenewalCycle.find({ status: { $in: OPEN } }).lean<CycleDoc>().cursor({ batchSize: 200 })) {
    const daysLeft = daysBetween(today, c.dueDate);
    const pol = await Policy.findById(c.policyId, { productName: 1, policyNumber: 1 }).lean<PolicyDoc>();
    const cus = await Customer.findById(c.customerId, { name: 1, email: 1, mobile: 1 }).lean<{ name: string; email: string | null; mobile: string }>();
    if (!pol || !cus) continue;
    const adv = await User.findOne({ accountId: c.accountId, role: 'ADV' }, { name: 1, mobile: 1 }).lean<{ _id: string; name: string; mobile: string }>();
    // 2. Advisor reminders (DSH-14), one per cycle and offset
    for (const o of dueOffsets(advisorOffsets, daysLeft)) {
      if (!adv) break;
      await notify({ userId: adv._id, accountId: c.accountId, kind: 'RENEWAL_DUE', messageId: 'DSH-14', params: { Customer: cus.name, product: pol.productName ?? '', date: dmy(c.dueDate) }, dedupeKey: `DSH-14|${c._id}|${o}`, link: { type: 'RENEWAL', id: c._id } }).catch(() => undefined);
      result.advisorReminders++;
    }
    // 3. Customer reminders (REN-T1), one per cycle, offset and channel
    for (const o of dueOffsets(customerOffsets, daysLeft)) {
      for (const channel of ['EMAIL', 'WHATSAPP'] as const) {
        const why = await skipReason(c, channel);
        if (why === 'Not on the Premium plan' || why === 'No email address' || why === 'Consent missing') continue; // never applicable: nothing to record
        const sentToday = await Outbox.countDocuments({ accountId: c.accountId, day: today, channel, status: { $ne: 'SKIPPED' } });
        const limit = channel === 'EMAIL' ? cfgNum('CFG-70') : cfgNum('CFG-69');
        const reason = why ?? (sentToday >= limit ? 'Daily limit' : null);
        const text = `Dear ${cus.name.split(' ')[0]}, your ${pol.productName ?? ''} policy ending ${(pol.policyNumber ?? '').slice(-4)} is due for renewal on ${dmy(c.dueDate)}. Please contact ${adv?.name ?? 'your advisor'} on ${adv?.mobile ?? ''} to renew it on time.`;
        try {
          const params = { 'customer first name': cus.name.split(' ')[0], product: pol.productName ?? '', 'policy last 4': (pol.policyNumber ?? '').slice(-4), 'renewal date': dmy(c.dueDate), 'advisor name': adv?.name ?? 'your advisor', 'advisor mobile': adv?.mobile ?? '' };
          await Outbox.create({ accountId: c.accountId, customerId: c.customerId, personKey: `C:${c.customerId}`, channel, purpose: 'RENEWAL_REMINDER', template: 'REN-T1', params, to: channel === 'EMAIL' ? cus.email! : cus.mobile, text, occurrenceKey: `${c._id}|${o}|${channel}`,
            status: reason ? 'SKIPPED' : 'QUEUED', skipReason: reason, related: { cycleId: c._id, policyId: c.policyId }, day: today });
          if (reason) result.skipped++; else result.queued++;
        } catch (e) { if (!isDuplicateKey(e)) throw e; } // already handled on an earlier run
      }
    }
  }
  // 4. Policies past their end date → EXPIRED (AC-P37-4)
  result.expired = (await Policy.updateMany({ status: 'ISSUED', endDate: { $lt: today } }, { $set: { status: 'EXPIRED' }, $inc: { version: 1 } })).modifiedCount;
  // 5. Past grace → LAPSED, with DSH-25 to the advisor
  for await (const c of RenewalCycle.find({ status: { $in: OPEN }, graceUntil: { $lt: today } }).lean<CycleDoc>().cursor({ batchSize: 200 })) {
    const u = await RenewalCycle.updateOne({ _id: c._id, status: { $in: OPEN } }, { $set: { status: 'LAPSED' }, $inc: { version: 1 } });
    if (!u.modifiedCount) continue;
    result.lapsed++;
    const [pol, cus, adv] = await Promise.all([Policy.findById(c.policyId, { productName: 1 }).lean<PolicyDoc>(), Customer.findById(c.customerId, { name: 1 }).lean<{ name: string }>(), User.findOne({ accountId: c.accountId, role: 'ADV' }, { _id: 1 }).lean<{ _id: string }>()]);
    if (adv) await notify({ userId: adv._id, accountId: c.accountId, kind: 'RENEWAL_LAPSED', messageId: 'DSH-25', params: { Customer: cus?.name ?? '', product: pol?.productName ?? '', date: dmy(c.graceUntil) }, dedupeKey: `DSH-25|${c._id}`, link: { type: 'RENEWAL', id: c._id } }).catch(() => undefined);
  }
  return result;
}

/** Called from the minute sweep: runs SYS-03 once per IST day, after CFG-63 o'clock. */
export async function maybeRunDaily(now = clock.now()) {
  const ist = new Date(now.getTime() + 5.5 * 3_600_000);
  if (ist.getUTCHours() < cfgNum('CFG-63')) return null;
  const day = ist.toISOString().slice(0, 10);
  try { await JobRun.create({ _id: `SYS-03|${day}`, at: now }); } catch (e) { if (isDuplicateKey(e)) return null; throw e; }
  try { const result = await runRenewalJob(day); await JobRun.updateOne({ _id: `SYS-03|${day}` }, { $set: { result } }); return result; }
  catch (e) { logger.error({ err: e }, 'Renewal job failed; the next run continues'); await JobRun.deleteOne({ _id: `SYS-03|${day}` }); return null; }
}

// ── P-38 actions ──
async function load(ctx: AuthContext, id: string) {
  const c = await RenewalCycle.findOne({ _id: id, accountId: ctx.accountId }).lean<CycleDoc>();
  if (!c) throw AppError.notFound();
  return c;
}
async function rowOf(c: CycleDoc, today = istToday()) {
  const [pol, cus, sent] = await Promise.all([
    Policy.findById(c.policyId, { policyNumber: 1, productName: 1, insurerId: 1, typeId: 1, endDate: 1, nextDueDate: 1, frequency: 1, status: 1, premium: 1 }).lean<PolicyDoc>(),
    Customer.findById(c.customerId, { name: 1, number: 1 }).lean<{ name: string; number: string }>(),
    Outbox.countDocuments({ 'related.cycleId': c._id, status: { $in: ['QUEUED', 'SENT'] } }),
  ]);
  const insurer = pol?.insurerId ? await Insurer.findById(pol.insurerId, { name: 1 }).lean<{ name: string }>() : null;
  const last = c.contacts?.[c.contacts.length - 1];
  return {
    id: c._id, status: c.status, dueDate: c.dueDate, graceUntil: c.graceUntil, daysLeft: daysBetween(today, c.dueDate), reason: c.reason, remindersPaused: c.remindersPaused,
    lastContact: last ? { at: last.at, outcome: last.outcome, note: last.note } : null, contacts: c.contacts, remindersSent: sent, renewalQuotationId: c.renewalQuotationId, renewedBy: c.renewedBy, version: c.version,
    // Gap fix: premium (renewals list and dashboard cards)
    policy: pol ? { id: pol._id, number: pol.policyNumber, product: pol.productName, insurer: insurer?.name ?? null, insurerId: pol.insurerId, typeId: pol.typeId, endDate: pol.endDate, nextDueDate: pol.nextDueDate, frequency: pol.frequency, status: pol.status, premium: (pol as { premium?: number | null }).premium ?? null } : null,
    premium: (pol as { premium?: number | null } | null)?.premium ?? null,
    customer: cus ? { id: c.customerId, name: cus.name, number: cus.number } : null,
  };
}

/** Renewals list (default: renewal date, soonest first), with filters. */
/** Rows for other screens (dashboard renewal cards). */
export const renewalRows = (cycles: CycleDoc[]) => Promise.all(cycles.map((c) => rowOf(c)));

export async function list(ctx: AuthContext, q: { status?: string; from?: string; to?: string; insurerId?: string; typeId?: string; customerId?: string }) {
  const rows = await RenewalCycle.find({ accountId: ctx.accountId, ...(q.customerId ? { customerId: q.customerId } : {}), ...(q.status ? { status: q.status } : { status: { $ne: 'RENEWED' } }), ...(q.from || q.to ? { dueDate: { ...(q.from ? { $gte: iso(q.from) } : {}), ...(q.to ? { $lte: iso(q.to) } : {}) } } : {}) }).sort({ dueDate: 1 }).limit(500).lean<CycleDoc[]>();
  const out = await Promise.all(rows.map((r) => rowOf(r)));
  return out.filter((r) => (!q.insurerId || r.policy?.insurerId === q.insurerId) && (!q.typeId || r.policy?.typeId === q.typeId));
}
export async function get(ctx: AuthContext, id: string) { return rowOf(await load(ctx, id)); }

async function update(c: CycleDoc, version: number, set: Record<string, unknown>, push?: Record<string, unknown>) {
  const u = await RenewalCycle.findOneAndUpdate({ _id: c._id, version }, { $set: set, ...(push ? { $push: push } : {}), $inc: { version: 1 } }, { new: true }).lean<CycleDoc>();
  if (!u) throw AppError.versionConflict('renewal', await rowOf((await RenewalCycle.findById(c._id).lean<CycleDoc>())!));
  return u;
}

/** Log contact (REN-01): DUE → IN_FOLLOW_UP. */
export async function logContact(ctx: AuthContext, id: string, b: { version: number; outcome: string; note?: string | null }, req: Request) {
  const c = await load(ctx, id);
  if (!['DUE', 'IN_FOLLOW_UP', 'LAPSED', 'UPCOMING'].includes(c.status)) throw AppError.invalidState('renewal', c.status);
  const u = await update(c, b.version, { status: c.status === 'LAPSED' ? 'LAPSED' : 'IN_FOLLOW_UP' }, { contacts: { at: clock.now(), by: ctx.userId, outcome: b.outcome, note: b.note ?? null } });
  await audit({ entity: 'renewal', entityId: id, action: 'RENEWAL_CONTACT_LOGGED', after: { outcome: b.outcome } }, { req });
  return rowOf(u);
}

/** Mark not renewing (REN-04): customer reminders stop (AC-P38-4). */
export async function notRenewing(ctx: AuthContext, id: string, b: { version: number; reason: string; note?: string | null }, req: Request) {
  const c = await load(ctx, id);
  if (!['UPCOMING', 'DUE', 'IN_FOLLOW_UP', 'LAPSED'].includes(c.status)) throw AppError.invalidState('renewal', c.status);
  const u = await update(c, b.version, { status: 'NOT_RENEWING', reason: b.reason === 'Other' ? `Other: ${b.note ?? ''}` : b.reason });
  await recheckQueued({ 'related.cycleId': id });
  await audit({ entity: 'renewal', entityId: id, action: 'RENEWAL_NOT_RENEWING', after: { reason: b.reason } }, { req });
  return rowOf(u);
}

/** Reopen (REN-05) only before the grace end (REN-08, AC-P38-5). */
export async function reopen(ctx: AuthContext, id: string, b: { version: number; note: string }, req: Request) {
  const c = await load(ctx, id);
  if (c.status !== 'NOT_RENEWING') throw AppError.invalidState('renewal', c.status);
  const pol = await Policy.findById(c.policyId, { status: 1 }).lean<{ status: string }>();
  if (pol?.status === 'CANCELLED') throw AppError.invalidState('policy', 'CANCELLED');
  if (istToday() > c.graceUntil) throw new AppError(409, 'INVALID_STATE', 'REN-08', { date: dmy(c.graceUntil) });
  const u = await update(c, b.version, { status: 'IN_FOLLOW_UP', reason: null }, { contacts: { at: clock.now(), by: ctx.userId, outcome: 'Reopened', note: b.note } });
  await audit({ entity: 'renewal', entityId: id, action: 'RENEWAL_REOPENED', after: { note: b.note } }, { req });
  return rowOf(u);
}

/** Pause / resume customer reminders for this cycle only (REN-06 / REN-07). */
export async function pause(ctx: AuthContext, id: string, b: { version: number }, paused: boolean, req: Request) {
  const c = await load(ctx, id);
  const u = await update(c, b.version, { remindersPaused: paused });
  if (paused) await recheckQueued({ 'related.cycleId': id });
  await audit({ entity: 'renewal', entityId: id, action: paused ? 'RENEWAL_REMINDERS_PAUSED' : 'RENEWAL_REMINDERS_RESUMED' }, { req });
  return rowOf(u);
}

/**
 * Record premium paid (regular-premium policies, REN-03): the cycle RENEWED, the policy stays ISSUED with the new due
 * date, and exactly one new cycle (AC-P38-3). A LAPSED cycle can still be closed (DEC-14).
 */
export async function premiumPaid(ctx: AuthContext, id: string, b: { version: number; paymentDate: string; receiptNumber: string; amount: number; nextDueDate: string }, req: Request) {
  const c = await load(ctx, id);
  if (!['DUE', 'IN_FOLLOW_UP', 'LAPSED', 'UPCOMING'].includes(c.status)) throw AppError.invalidState('renewal', c.status);
  const pol = await Policy.findById(c.policyId).lean<PolicyDoc>();
  if (!pol || !['ISSUED', 'EXPIRED'].includes(pol.status)) throw AppError.invalidState('policy', pol?.status ?? 'missing');
  if (iso(b.paymentDate) > istToday()) throw AppError.field('paymentDate', 'VAL-35');
  const next = iso(b.nextDueDate);
  if (next <= c.dueDate || !pol.endDate || next > pol.endDate) throw AppError.field('nextDueDate', 'REN-09', { 'old date': dmy(c.dueDate) });
  const receiptKey = `${pol.insurerId}|${b.receiptNumber.trim().toUpperCase()}`;
  const usedPay = await Payment.findOne({ accountId: ctx.accountId, referenceKey: receiptKey, status: 'PAID' }, { _id: 1 }).lean();
  const usedRen = await RenewalCycle.findOne({ accountId: ctx.accountId, receiptKey }, { policyId: 1 }).lean<{ policyId: string }>();
  if (usedPay || usedRen) throw AppError.field('receiptNumber', 'PAY-08', { record: usedRen ? `policy ${(await Policy.findById(usedRen.policyId, { policyNumber: 1 }).lean<{ policyNumber: string }>())?.policyNumber ?? ''}` : 'a quotation payment' });
  try {
    await withTx(async (session) => {
      const u = await RenewalCycle.findOneAndUpdate({ _id: id, version: b.version }, { $set: { status: 'RENEWED', receiptKey, renewedBy: { kind: 'PREMIUM', paymentDate: iso(b.paymentDate), receipt: b.receiptNumber.trim(), amount: b.amount } }, $inc: { version: 1 } }, { new: true, session: session ?? undefined }).lean<CycleDoc>();
      if (!u) throw AppError.versionConflict('renewal', null);
      await Policy.updateOne({ _id: pol._id }, { $set: { nextDueDate: next, status: 'ISSUED' }, $push: { history: { at: clock.now(), by: ctx.userId, action: 'PREMIUM_PAID', reason: null, before: { nextDueDate: pol.nextDueDate }, after: { nextDueDate: next, receipt: b.receiptNumber } } }, $inc: { version: 1 } }, { session: session ?? undefined });
      await RenewalCycle.create([{ accountId: ctx.accountId, policyId: pol._id, customerId: pol.customerId, dueDate: next, graceUntil: addDays(next, pol.gracePeriodDays ?? cfgNum('CFG-62')) }], { session: session ?? undefined });
      await Outbox.updateMany({ 'related.cycleId': id, status: 'QUEUED' }, { $set: { status: 'SKIPPED', skipReason: 'Renewal renewed' } }, { session: session ?? undefined });
      await audit({ entity: 'renewal', entityId: id, action: 'RENEWAL_PREMIUM_PAID', after: { nextDueDate: next } }, { req, session });
    });
  } catch (e) {
    if (isDuplicateKey(e, 'one_receipt_per_insurer')) throw AppError.field('receiptNumber', 'PAY-08', { record: 'another renewal' });
    throw e;
  }
  return { renewal: await rowOf((await RenewalCycle.findById(id).lean<CycleDoc>())!), params: { date: dmy(next) } };
}

/**
 * Create renewal quotation (REN-02): a normal P-27 quotation for the same customer, product, people and sum insured,
 * marked "Renewal of {policy number}" (allowed even if the product is now WITHDRAWN); the cycle → IN_FOLLOW_UP.
 */
export type RenewalMode = 'SAME_POLICY' | 'NEW_QUOTATION' | 'COMPARISON';
export interface RenewalBody {
  mode?: RenewalMode;
  /** SAME_POLICY: the premium on the insurer's renewal notice, and the notice itself (optional, Q-default). */
  typedRenewalPremium?: number | null; renewalNoticeFileId?: string | null;
  /** NEW_QUOTATION: what changes; portability only with a different insurer (QT-50). */
  insurerId?: string | null; productId?: string | null; variantId?: string | null; people?: string[]; sumInsured?: number | null; portabilityRequested?: boolean;
}

/**
 * Changes #14–#16: how to renew. SAME_POLICY (the earlier single action, still the default) opens P-27 with the same
 * customer, product, people and sum insured, plus the renewal notice's premium when typed. NEW_QUOTATION opens P-27 with
 * the insurer, product, variant, people or sum insured changed, and an optional portability request. COMPARISON opens
 * P-30 with the same people and sum insured. All three link to the cycle (IN_FOLLOW_UP) and keep last year's premium for
 * "last year vs this year". When the new policy is recorded, the old one becomes RENEWED as before, even with a new
 * insurer (Q-default).
 */
export async function renewalQuotation(ctx: AuthContext, id: string, req: Request, b: RenewalBody = {}) {
  const c = await load(ctx, id);
  if (!['DUE', 'IN_FOLLOW_UP', 'LAPSED', 'UPCOMING'].includes(c.status)) throw AppError.invalidState('renewal', c.status);
  const pol = await Policy.findById(c.policyId).lean<PolicyDoc>();
  const mode = b.mode ?? 'SAME_POLICY';
  if (mode === 'SAME_POLICY' && !pol?.productId) throw AppError.invalidState('policy', 'not linked to a catalogue product');
  if (!pol) throw AppError.notFound();
  const people = b.people?.length ? b.people : (pol.insured as Array<{ key: string | null }>).map((x) => x.key).filter(Boolean) as string[];
  const startDate = c.dueDate > istToday() ? c.dueDate : istToday();
  const sumInsured = b.sumInsured ?? pol.sumInsured ?? undefined;
  const cycleSet = (extra: Record<string, unknown>) => RenewalCycle.updateOne({ _id: id }, { $set: { renewalMode: mode, ...extra, ...(c.status === 'DUE' || c.status === 'UPCOMING' ? { status: 'IN_FOLLOW_UP' } : {}) }, $inc: { version: 1 } });

  if (mode === 'COMPARISON') {
    const cmp = await import('../quotations/comparisons.service.js');
    const started = await cmp.start(ctx, pol.customerId, req);
    const saved = await cmp.saveDraft(ctx, started.id, { version: started.version, inputs: { typeId: pol.typeId ?? undefined, people, sumInsured, policyTerm: 1, startDate, renewalOf: pol._id } as never, options: [] });
    await cycleSet({ renewalComparisonId: started.id });
    await audit({ entity: 'renewal', entityId: id, action: 'RENEWAL_COMPARISON_STARTED', after: { comparisonId: started.id } }, { req });
    return { quotation: null, comparison: saved, params: { 'policy number': pol.policyNumber ?? '' } };
  }

  const insurerId = (mode === 'NEW_QUOTATION' ? b.insurerId : null) ?? pol.insurerId ?? undefined;
  const productId = (mode === 'NEW_QUOTATION' ? b.productId : null) ?? pol.productId ?? undefined;
  const portability = mode === 'NEW_QUOTATION' && !!b.portabilityRequested;
  if (portability && insurerId === pol.insurerId) throw AppError.field('portabilityRequested', 'QT-50');
  if (b.renewalNoticeFileId) await (await import('../files/files.service.js')).assertOwnFile(ctx, b.renewalNoticeFileId, 'CUSTOMER_DOCUMENT', 'renewalNoticeFileId');
  const q = await import('../quotations/quotations.service.js');
  const start = await q.start(ctx, pol.customerId, req);
  // The notice's premium: the typed base for a rate-table product, the net premium for manual entry
  const typed = mode === 'SAME_POLICY' ? b.typedRenewalPremium ?? null : null;
  let typedInput = {};
  if (typed) {
    const { Product, ProductVersion } = await import('../catalogue/product.model.js');
    const prod = await Product.findById(productId, { publishedVersionId: 1 }).lean<{ publishedVersionId: string | null }>();
    const mode_ = (await ProductVersion.findById(prod?.publishedVersionId, { 'data.pricingMode': 1 }).lean<{ data?: { pricingMode?: string } }>())?.data?.pricingMode;
    typedInput = mode_ === 'RATE_TABLE' ? { typedBasePremium: typed } : { manual: { netPremium: typed } };
  }
  const inputs = {
    typeId: pol.typeId ?? undefined, insurerId, productId, variantId: (mode === 'NEW_QUOTATION' ? b.variantId : null) ?? pol.variantId ?? undefined, people, sumInsured, policyTerm: 1, startDate, renewalOf: pol._id,
    ...typedInput,
  };
  const renewal = { mode, previousPremium: pol.premium ?? null, noticeFileId: b.renewalNoticeFileId ?? null, portabilityRequested: portability, fromPolicyId: pol._id, fromInsurerId: pol.insurerId ?? null };
  await (await import('../quotations/quotation.model.js')).Quotation.updateOne({ _id: start.id }, { $set: { renewal } });
  let saved;
  try { saved = await q.save(ctx, start.id, { version: start.version, step: 8, inputs: inputs as never }, req); }
  catch { saved = await q.get(ctx, start.id); } // the draft keeps its inputs; P-27 shows what to fix
  await cycleSet({ renewalQuotationId: start.id });
  await audit({ entity: 'renewal', entityId: id, action: 'RENEWAL_QUOTATION_STARTED', after: { quotationId: start.id, mode, portability } }, { req });
  return { quotation: saved, comparison: null, params: { 'policy number': pol.policyNumber ?? '' } };
}

/** P-33 on a renewal quotation: the old cycle and policy become RENEWED (AC-P38-2: the new policy has exactly one cycle). */
export async function closeByRenewalPolicy(oldPolicyId: string, newPolicyId: string, session: import('mongoose').ClientSession | null) {
  await RenewalCycle.updateOne({ policyId: oldPolicyId, status: { $in: ['UPCOMING', 'DUE', 'IN_FOLLOW_UP', 'LAPSED'] } }, { $set: { status: 'RENEWED', renewedBy: { kind: 'POLICY', policyId: newPolicyId } }, $inc: { version: 1 } }, { session: session ?? undefined });
  await Policy.updateOne({ _id: oldPolicyId }, { $set: { status: 'RENEWED' }, $inc: { version: 1 } }, { session: session ?? undefined });
  await Outbox.updateMany({ 'related.policyId': oldPolicyId, status: 'QUEUED' }, { $set: { status: 'SKIPPED', skipReason: 'Renewal renewed' } }, { session: session ?? undefined });
}
void msg;