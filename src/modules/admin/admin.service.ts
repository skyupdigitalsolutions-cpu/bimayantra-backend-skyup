import type { Request } from 'express';
import JSZip from 'jszip';
import { cfg, cfgList, cfgNum, isCfgId, listCfg, loadConfigOverrides, ConfigValue, validateCfgValue, type CfgId } from '../../config/cfg.js';
import { clock, istToday } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { msg } from '../../lib/messages.js';
import { isDuplicateKey, withTx } from '../../lib/mongo.js';
import { Account } from '../accounts/account.model.js';
import { effectiveStatus } from '../accounts/subscription.js';
import { audit } from '../audit/audit.service.js';
import { endSessions } from '../auth/sessions.service.js';
import { Outbox } from '../comms/outbox.model.js';
import { sign, verify } from '../comms/comms.service.js';
import { env } from '../../config/env.js';
import * as rzp from '../../lib/razorpay.js';
import { Customer, FamilyMember } from '../customers/customer.model.js';
import { CustomerDocument } from '../documents/document.model.js';
import { open as openFile, upload as storeFile } from '../files/files.service.js';
import { Lead } from '../leads/lead.model.js';
import { notify, notifySkyUp } from '../notifications/notifications.service.js';
import { useStepUp } from '../auth/stepUp.js';
import { Payment } from '../payments/payment.model.js';
import { Policy } from '../policies/policy.model.js';
import { Quotation } from '../quotations/quotation.model.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { ReferralCode } from '../referrals/referral.model.js';
import { JobRun, RenewalCycle } from '../renewals/renewal.model.js';
import { User } from '../users/user.model.js';
import { WebhookEvent } from '../comms/outbox.model.js';
import { ConfigChange, ExportJob, InvoiceCounter, PlanChange, SubscriptionOrder, SupportGrant, type GrantDoc, type OrderDoc } from './admin.model.js';

type Plan = 'NORMAL' | 'PREMIUM';
type Cycle = 'MONTHLY' | 'YEARLY';
const dmy = (iso: string) => iso.split('-').reverse().join('-');
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const addPeriod = (d: string, c: Cycle) => { const x = new Date(`${d}T00:00:00Z`); if (c === 'MONTHLY') x.setUTCMonth(x.getUTCMonth() + 1); else x.setUTCFullYear(x.getUTCFullYear() + 1); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };
const endOfDayIst = (d: string) => new Date(`${d}T23:59:59.999+05:30`);
const istDateOf = (dt: Date) => new Date(dt.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const rupees = (p: number) => (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const advisorOf = (accountId: string) => User.findOne({ accountId, role: 'ADV' }, { name: 1, mobile: 1 }).lean<{ _id: string; name: string; mobile: string }>();

// ── P-47 plans and billing ──
/** CFG-82: [Normal monthly, Normal yearly, Premium monthly, Premium yearly] in paise, before GST. */
export function price(plan: Plan, cycle: Cycle) { const p = cfg('CFG-82') as unknown as number[]; return p[(plan === 'PREMIUM' ? 2 : 0) + (cycle === 'YEARLY' ? 1 : 0)]!; }
/** CFG-160/161: CGST + SGST inside the home state, otherwise IGST (AC-P47-3). Whole paise. */
export function gstSplit(taxable: number, state: string | null) {
  const rate = cfgNum('CFG-160');
  if (state && state.toLowerCase() === String(cfg('CFG-161')).toLowerCase()) { const half = Math.round((taxable * rate) / 200); return { cgst: half, sgst: half, igst: 0 }; }
  return { cgst: 0, sgst: 0, igst: Math.round((taxable * rate) / 100) };
}
async function loadAcc(accountId: string) {
  const a = await Account.findById(accountId).lean<{ _id: string; status: string; subscription: { plan: Plan | null; status: string; startsAt: Date; endsAt: Date; cycle?: Cycle | null; nextPlan?: string | null; waNumber?: Record<string, unknown> | null }; profile?: { contact?: { state?: string | null; email?: string | null }; business?: { gstin?: string | null } } }>();
  if (!a) throw AppError.notFound();
  return a;
}
/** The review screen: price, credit for an upgrade, GST split, total and period dates. */
export async function quote(accountId: string, plan: Plan, cycle: Cycle, gstin?: string | null) {
  const a = await loadAcc(accountId);
  const today = istToday();
  const eff = effectiveStatus(a.subscription, clock.now());
  const paid = eff === 'ACTIVE' || eff === 'GRACE';
  let kind: OrderDoc['kind'] = 'NEW', start = today, credit = 0;
  if (paid && a.subscription.plan === 'NORMAL' && plan === 'PREMIUM' && eff === 'ACTIVE') {
    kind = 'UPGRADE'; // immediate; remaining days credited against the new price [TO CONFIRM DEC-06]
    const last = await SubscriptionOrder.findOne({ accountId, status: 'SUCCESS' }).sort({ periodStart: -1 }).lean<OrderDoc>();
    if (last && last.periodEnd >= today) {
      const total = (Date.parse(last.periodEnd) - Date.parse(last.periodStart)) / 86_400_000 + 1;
      const left = (Date.parse(last.periodEnd) - Date.parse(today)) / 86_400_000;
      credit = Math.min(Math.round((last.basePaise * left) / total), price(plan, cycle));
    }
  } else if (eff === 'ACTIVE') { kind = 'RENEW'; start = addDays(istDateOf(a.subscription.endsAt), 1); } // renew: the day after the current period
  const base = price(plan, cycle);
  const state = a.profile?.contact?.state ?? null;
  const gst = gstSplit(base - credit, state);
  return { plan, cycle, kind, basePaise: base, creditPaise: credit, gst, totalPaise: base - credit + gst.cgst + gst.sgst + gst.igst, periodStart: start, periodEnd: addPeriod(start, cycle), state, gstin: gstin ?? a.profile?.business?.gstin ?? null };
}
/** Pay: a PENDING order. Only the gateway's signed notification activates the plan (AC-P47-4). */
export async function createOrder(ctx: AuthContext, b: { plan: Plan; cycle: Cycle; gstin?: string | null }, req: Request) {
  const q = await quote(ctx.accountId!, b.plan, b.cycle, b.gstin);
  const o = await SubscriptionOrder.create({ accountId: ctx.accountId, ...q, status: 'PENDING', createdBy: ctx.userId });
  await audit({ entity: 'subscription', entityId: o._id, action: 'SUBSCRIPTION_ORDER_CREATED', after: { plan: b.plan, cycle: b.cycle, total: q.totalPaise } }, { req });
  if (env.PAYMENT_GATEWAY === 'razorpay') {
    const r = await rzp.createOrder(q.totalPaise, o._id, { kind: 'SUBSCRIPTION', id: o._id, accountId: ctx.accountId! });
    await SubscriptionOrder.updateOne({ _id: o._id }, { $set: { gatewayOrderId: r.id } });
    return { orderId: o._id, ...q, ...rzp.checkoutFor(r, `${b.plan === 'PREMIUM' ? 'Premium' : 'Normal'} plan · ${b.cycle === 'YEARLY' ? 'yearly' : 'monthly'}`) };
  }
  return { orderId: o._id, ...q, checkout: `dev-checkout:${o._id}` };
}

/** After Razorpay Checkout: check the signature, confirm (and capture) the payment, then activate the period once. */
export async function verifyOrder(ctx: AuthContext, id: string, b: { razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string }) {
  const o = await SubscriptionOrder.findOne({ _id: id, accountId: ctx.accountId }).lean<OrderDoc & { gatewayOrderId?: string | null }>();
  if (!o) throw AppError.notFound();
  if (o.status !== 'SUCCESS') {
    if (!o.gatewayOrderId || o.gatewayOrderId !== b.razorpayOrderId || !rzp.checkoutSignatureValid(b.razorpayOrderId, b.razorpayPaymentId, b.razorpaySignature)) throw new AppError(400, 'PAYMENT_NOT_VERIFIED', 'SUB-21');
    const p = await rzp.confirm(o.gatewayOrderId, b.razorpayPaymentId, o.totalPaise);
    if (!p) throw new AppError(402, 'PAYMENT_NOT_CAPTURED', 'SUB-21');
    await activate(o, { gatewayPaymentId: p.id });
  }
  return orderStatus(ctx, id);
}

/** Razorpay webhook (payment.captured / order.paid) for a plan purchase: same checks, activates once. */
export async function settleSubscriptionPayment(razorpayOrderId: string, paymentId: string, amountPaise: number) {
  const o = await SubscriptionOrder.findOne({ gatewayOrderId: razorpayOrderId }).lean<OrderDoc>();
  if (!o) return false;
  if (o.status === 'SUCCESS') return true;
  if (amountPaise !== o.totalPaise) return false;
  await activate(o, { gatewayPaymentId: paymentId }); // a late success after SUB-17 still activates (P-47)
  return true;
}
async function nextInvoice(session: import('mongoose').ClientSession | null) {
  const d = new Date(`${istToday()}T00:00:00Z`);
  const fy = d.getUTCMonth() >= 3 ? `${d.getUTCFullYear()}-${String(d.getUTCFullYear() + 1).slice(2)}` : `${d.getUTCFullYear() - 1}-${String(d.getUTCFullYear()).slice(2)}`;
  const c = await InvoiceCounter.findOneAndUpdate({ _id: fy }, { $inc: { n: 1 } }, { upsert: true, new: true, session: session ?? undefined }).lean<{ n: number }>();
  return `INV/${fy}/${String(c!.n).padStart(5, '0')}`;
}
/** Activate a paid period: subscription ACTIVE, invoice, Premium number set-up (AC-P47-5), SUB-14 and the invoice email. */
async function activate(o: OrderDoc, extra: { gatewayPaymentId?: string; reference?: string }) {
  const a = await loadAcc(o.accountId);
  const invoice = await withTx(async (session) => {
    const invoiceNumber = await nextInvoice(session);
    const u = await SubscriptionOrder.updateOne({ _id: o._id, status: { $ne: 'SUCCESS' } }, { $set: { status: 'SUCCESS', invoiceNumber, ...extra } }, { session: session ?? undefined });
    if (!u.modifiedCount) return null;
    const startsNow = o.kind !== 'RENEW';
    await Account.updateOne({ _id: o.accountId }, { $set: {
      'subscription.status': 'ACTIVE', 'subscription.plan': o.plan, 'subscription.cycle': o.cycle, 'subscription.endsAt': endOfDayIst(o.periodEnd), 'subscription.nextPlan': null,
      ...(startsNow ? { 'subscription.startsAt': new Date(`${o.periodStart}T00:00:00+05:30`) } : {}),
      ...(o.plan === 'PREMIUM' && !a.subscription.waNumber ? { 'subscription.waNumber': { status: 'SETTING_UP', number: null, startedAt: clock.now() } } : {}),
    } }, { session: session ?? undefined });
    await audit({ entity: 'subscription', entityId: o._id, action: 'SUBSCRIPTION_ACTIVATED', after: { plan: o.plan, until: o.periodEnd, invoiceNumber } }, { session });
    return invoiceNumber;
  });
  if (!invoice) return;
  const adv = await advisorOf(o.accountId);
  if (!adv) return;
  await notify({ userId: adv._id, accountId: o.accountId, kind: 'SUBSCRIPTION', messageId: 'SUB-14', params: { plan: o.plan === 'PREMIUM' ? 'Premium' : 'Normal', 'end date': dmy(o.periodEnd) }, dedupeKey: `SUB-14|${o._id}` }).catch(() => undefined);
  if (o.plan === 'PREMIUM' && !a.subscription.waNumber) await notify({ userId: adv._id, accountId: o.accountId, kind: 'SUBSCRIPTION', messageId: 'SUB-15', params: { 'CFG-165': cfgNum('CFG-165') }, dedupeKey: `SUB-15|${o.accountId}` }).catch(() => undefined);
  const email = a.profile?.contact?.email;
  if (email) await Outbox.create({ accountId: o.accountId, customerId: null, personKey: null, channel: 'EMAIL', purpose: 'SUBSCRIPTION', template: 'SUB-EMAIL', params: { 'advisor name': adv.name, plan: o.plan === 'PREMIUM' ? 'Premium' : 'Normal', date: dmy(o.periodEnd) }, to: email.toLowerCase(), text: 'Subscription invoice', occurrenceKey: `SUB-EMAIL|${o._id}`, day: istToday() }).catch(() => undefined);
}
/** The gateway's signed notification: processed once by event ID; the amount must match (AC-P47-4). */
export async function subscriptionWebhook(req: Request) {
  verify(req);
  const e = req.body as { eventId: string; orderId: string; paymentId: string; status: 'captured' | 'failed'; amountPaise: number };
  try { await WebhookEvent.create({ _id: `subscription|${e.eventId}`, source: 'subscription', at: clock.now() }); } catch (x) { if (isDuplicateKey(x)) return { processed: false }; throw x; }
  const o = await SubscriptionOrder.findById(e.orderId).lean<OrderDoc>();
  if (!o || o.status === 'SUCCESS') return { processed: true };
  if (e.status !== 'captured') { await SubscriptionOrder.updateOne({ _id: o._id, status: 'PENDING' }, { $set: { status: 'FAILED' } }); return { processed: true }; }
  if (e.amountPaise !== o.totalPaise) return { processed: true, ignored: 'amount does not match' };
  await activate(o, { gatewayPaymentId: e.paymentId }); // a late success after SUB-17 still activates (P-47)
  return { processed: true };
}
export async function orderStatus(ctx: AuthContext, id: string) {
  const o = await SubscriptionOrder.findOne({ _id: id, accountId: ctx.accountId }).lean<OrderDoc>();
  if (!o) throw AppError.notFound();
  const m = o.status === 'SUCCESS' ? msg('SUB-14', { plan: o.plan === 'PREMIUM' ? 'Premium' : 'Normal', 'end date': dmy(o.periodEnd) }) : o.status === 'FAILED' ? msg('SUB-12')
    : clock.now().getTime() - new Date(o.createdAt).getTime() > cfgNum('CFG-180') * 60_000 ? msg('SUB-17') : msg('SUB-13');
  return { id: o._id, status: o.status, message: m };
}
/** Downgrade to Normal at the end of the period, after SUB-09 is confirmed. */
export async function downgrade(ctx: AuthContext, confirm: boolean, req: Request) {
  const a = await loadAcc(ctx.accountId!);
  if (a.subscription.plan !== 'PREMIUM' || effectiveStatus(a.subscription, clock.now()) !== 'ACTIVE') throw AppError.invalidState('subscription', a.subscription.plan ?? 'TRIAL');
  const date = dmy(istDateOf(a.subscription.endsAt));
  if (!confirm) throw new AppError(409, 'CONFIRMATION_REQUIRED', 'SUB-09', { date });
  await Account.updateOne({ _id: ctx.accountId }, { $set: { 'subscription.nextPlan': 'NORMAL' } });
  await audit({ entity: 'subscription', entityId: ctx.accountId!, action: 'SUBSCRIPTION_DOWNGRADE_SCHEDULED', after: { on: date } }, { req });
  return billing(ctx);
}
export async function billing(ctx: AuthContext) {
  const a = await loadAcc(ctx.accountId!);
  const orders = await SubscriptionOrder.find({ accountId: ctx.accountId, status: 'SUCCESS' }).sort({ createdAt: -1 }).lean<OrderDoc[]>();
  return {
    plan: a.subscription.plan, status: effectiveStatus(a.subscription, clock.now()), cycle: a.subscription.cycle ?? null, endsAt: istDateOf(a.subscription.endsAt), nextPlan: a.subscription.nextPlan ?? null, waNumber: a.subscription.waNumber ?? null,
    prices: { NORMAL: { MONTHLY: price('NORMAL', 'MONTHLY'), YEARLY: price('NORMAL', 'YEARLY') }, PREMIUM: { MONTHLY: price('PREMIUM', 'MONTHLY'), YEARLY: price('PREMIUM', 'YEARLY') } }, gstPercent: cfgNum('CFG-160'),
    invoices: orders.map((o) => ({ id: o._id, invoiceNumber: o.invoiceNumber, plan: o.plan, cycle: o.cycle, period: `${dmy(o.periodStart)} to ${dmy(o.periodEnd)}`, base: o.basePaise / 100, credit: o.creditPaise / 100, gst: { cgst: (o.gst.cgst ?? 0) / 100, sgst: (o.gst.sgst ?? 0) / 100, igst: (o.gst.igst ?? 0) / 100 }, total: o.totalPaise / 100, gstin: o.gstin, kind: o.kind, at: o.createdAt })),
  };
}
/** ADM records an offline payment (OTP): SUB-10 repeated reference; SUB-08 overlap unless Replace. */
export async function offlinePayment(ctx: AuthContext, accountId: string, b: { plan: Plan; cycle: Cycle; amount: number; reference: string; startDate?: string | null; replace?: boolean }, req: Request) {
  const a = await loadAcc(accountId);
  const used = await SubscriptionOrder.findOne({ reference: b.reference.trim() }, { accountId: 1 }).lean<{ accountId: string }>();
  if (used) { const adv = await advisorOf(used.accountId); throw AppError.field('reference', 'SUB-10', { account: adv?.name ?? used.accountId }); }
  const start = b.startDate ? b.startDate.split('-').reverse().join('-') : istToday();
  const curEnd = istDateOf(a.subscription.endsAt);
  if (effectiveStatus(a.subscription, clock.now()) === 'ACTIVE' && start <= curEnd && !b.replace) throw new AppError(409, 'CONFIRMATION_REQUIRED', 'SUB-08', { date: dmy(curEnd), 'next date': dmy(addDays(curEnd, 1)) });
  const base = Math.round(b.amount * 100);
  const gst = gstSplit(Math.round(base / (1 + cfgNum('CFG-160') / 100)), a.profile?.contact?.state ?? null);
  const taxable = base - gst.cgst - gst.sgst - gst.igst;
  const o = await SubscriptionOrder.create({ accountId, plan: b.plan, cycle: b.cycle, kind: 'OFFLINE', basePaise: taxable, gst, totalPaise: base, periodStart: start, periodEnd: addPeriod(start, b.cycle), status: 'PENDING', reference: b.reference.trim(), createdBy: ctx.userId });
  await activate(o.toObject() as OrderDoc, { reference: b.reference.trim() });
  await audit({ entity: 'subscription', entityId: o._id, action: 'SUBSCRIPTION_OFFLINE_PAYMENT', after: { accountId, plan: b.plan, amount: b.amount, reference: b.reference } }, { req });
  return { orderId: o._id };
}

/**
 * SYS-05 (daily, repeat-safe): trial reminders (SUB-11), ACTIVE → GRACE (SUB-05) → EXPIRED (read-only), a scheduled
 * downgrade at the period end, and EXPIRED for CFG-81 days → CLOSED (archived, never deleted, AC-P47-6).
 */
export async function runSubscriptionJob(now = clock.now()) {
  const today = istDateOf(now);
  const out = { reminders: 0, grace: 0, expired: 0, downgraded: 0, archived: 0 };
  for await (const a of Account.find({ status: 'ACTIVE' }).lean<Awaited<ReturnType<typeof loadAcc>> & { _id: string }>().cursor({ batchSize: 200 })) {
    const s = a.subscription;
    const eff = effectiveStatus(s, now);
    const end = istDateOf(s.endsAt);
    const adv = await advisorOf(a._id);
    if (eff === 'TRIAL' && adv) {
      const left = (Date.parse(end) - Date.parse(today)) / 86_400_000;
      if ((cfg('CFG-178') as unknown as number[]).includes(left)) { await notify({ userId: adv._id, accountId: a._id, kind: 'SUBSCRIPTION', messageId: 'SUB-11', params: { date: dmy(end) }, dedupeKey: `SUB-11|${a._id}|${left}` }).catch(() => undefined); out.reminders++; }
    }
    if (s.nextPlan === 'NORMAL' && s.status === 'ACTIVE' && now > s.endsAt) { // the downgrade takes effect at the period end
      await applyNormalPlan(a._id, now);
      out.downgraded++;
    }
    if (eff !== s.status && ['GRACE', 'EXPIRED'].includes(eff)) {
      await Account.updateOne({ _id: a._id, 'subscription.status': s.status }, { $set: { 'subscription.status': eff } });
      if (eff === 'GRACE') { out.grace++; if (adv) await notify({ userId: adv._id, accountId: a._id, kind: 'SUBSCRIPTION', messageId: 'SUB-05', params: { date: dmy(end), days: cfgNum('CFG-79') }, dedupeKey: `SUB-05|${a._id}|${end}` }).catch(() => undefined); }
      else out.expired++;
    }
    if (eff === 'EXPIRED') {
      const expiredOn = s.status === 'TRIAL' || !s.plan ? end : addDays(end, cfgNum('CFG-79'));
      if (Date.parse(today) - Date.parse(expiredOn) > cfgNum('CFG-81') * 86_400_000) {
        const retain = new Date(now); retain.setUTCFullYear(retain.getUTCFullYear() + cfgNum('CFG-87'));
        await Account.updateOne({ _id: a._id, status: 'ACTIVE' }, { $set: { status: 'CLOSED', closedAt: now, statusReason: 'Archived after read-only period', retainUntil: retain } });
        out.archived++;
      }
    }
  }
  // §9.6: one daily summary to SkyUp of trials ending in the next 7 days (none when there are none)
  const trialsEnding = await Account.countDocuments({ status: 'ACTIVE', 'subscription.status': 'TRIAL', 'subscription.endsAt': { $gte: now, $lte: endOfDayIst(addDays(today, 7)) } });
  if (trialsEnding) await notifySkyUp({ kind: 'TRIALS_ENDING', messageId: 'DSH-29', params: { n: trialsEnding }, dedupeKey: `DSH-29|${today}` }).catch(() => undefined);
  await SupportGrant.updateMany({ status: 'ACTIVE', endsAt: { $lte: now } }, { $set: { status: 'EXPIRED' } }); // SYS-14
  await ExportJob.updateMany({ status: 'READY', expiresAt: { $lte: now } }, { $set: { status: 'EXPIRED' } });
  return out;
}
export async function maybeRunSubscriptionJob(now = clock.now()) {
  const day = istDateOf(now);
  try { await JobRun.create({ _id: `SYS-05|${day}`, at: now }); } catch (e) { if (isDuplicateKey(e)) return null; throw e; }
  return runSubscriptionJob(now);
}

// ── P-49 configuration ──
export function configList() { return listCfg(); }
export async function requestConfigChange(ctx: AuthContext, id: string, value: unknown, reason: string, req: Request) {
  if (!isCfgId(id)) throw AppError.notFound();
  const def = listCfg().find((c) => c.id === id)!;
  if (def.change !== 'ADM') throw AppError.invalidState('setting', 'changed only in a release'); // AC-P49-2
  const problem = validateCfgValue(id, value);
  if (problem) {
    const r = /from (\S+) to (\S+)\./.exec(problem);
    throw r ? AppError.field('value', 'ADM-05', { min: r[1]!, max: r[2]! }) : AppError.field('value', 'VAL-22'); // AC-P49-3
  }
  try {
    const c = await ConfigChange.create({ cfgId: id, oldValue: cfg(id as CfgId), newValue: value, reason, requestedBy: ctx.userId });
    await audit({ entity: 'config', entityId: id, action: 'CONFIG_CHANGE_REQUESTED', before: { value: cfg(id as CfgId) }, after: { value, reason } }, { req });
    // No admin approval (Q92): applied now, with the reason and the OTP; the history keeps old value, new value, who and why.
    await decideConfigChange(ctx, c._id as string, true, req, { direct: true });
    return (await ConfigChange.findById(c._id).lean())!;
  } catch (e) { if (isDuplicateKey(e)) throw new AppError(409, 'INVALID_STATE', 'CAT-08'); throw e; }
}
/** A different ADM approves with OTP; refused if the setting changed meanwhile (CAT-29). Applies at once (AC-P49-1). */
export async function decideConfigChange(ctx: AuthContext, changeId: string, approve: boolean, req: Request, opts: { direct?: boolean } = {}) {
  const c = await ConfigChange.findById(changeId).lean<{ _id: string; cfgId: CfgId; oldValue: unknown; newValue: unknown; status: string; requestedBy: string }>();
  if (!c) throw AppError.notFound();
  if (c.status !== 'PENDING_APPROVAL') throw AppError.invalidState('change', c.status);
  if (approve && c.requestedBy === ctx.userId && !opts.direct) throw new AppError(403, 'FORBIDDEN', 'CAT-05'); // only changes left waiting from before
  if (approve && JSON.stringify(cfg(c.cfgId)) !== JSON.stringify(c.oldValue)) throw new AppError(409, 'VERSION_CONFLICT', 'CAT-29');
  await ConfigChange.updateOne({ _id: changeId, status: 'PENDING_APPROVAL' }, { $set: { status: approve ? 'APPLIED' : 'REJECTED', approvedBy: ctx.userId, decidedAt: clock.now() } });
  if (approve) { await ConfigValue.updateOne({ _id: c.cfgId }, { $set: { value: c.newValue, updatedBy: ctx.userId } }, { upsert: true }); await loadConfigOverrides(); }
  await audit({ entity: 'config', entityId: c.cfgId, action: approve ? 'CONFIG_CHANGE_APPLIED' : 'CONFIG_CHANGE_REJECTED', before: { value: c.oldValue }, after: { value: c.newValue } }, { req });
  return { status: approve ? 'APPLIED' : 'REJECTED' };
}
export const configHistory = () => ConfigChange.find({}).sort({ createdAt: -1 }).limit(500).lean();

// ── P-51 accounts ──
/** P-51 suspend reasons (the BPD list). The design shows free text: both are accepted until the client decides (§9.9, Q117). */
export const SUSPEND_REASONS = ['Misuse or spam', 'Suspected fraud', 'Requested by the advisor', 'Legal request', 'Other'] as const;
export const SUPPORT_REASON_CODES = SUSPEND_REASONS; // the same list is offered for suspend and close
export type AccountReason = { reasonCode?: (typeof SUSPEND_REASONS)[number] | null; reason?: string | null };
/** The stored reason: the list item, with the note when there is one ("Other: …" needs the note). */
export function reasonText(b: AccountReason) {
  if (!b.reasonCode || b.reasonCode === 'Other') {
    if (!b.reason) throw AppError.field('reason', 'GEN-01', { 'Field label': 'Reason' });
    return b.reasonCode === 'Other' ? `Other: ${b.reason}` : b.reason;
  }
  return b.reason ? `${b.reasonCode}: ${b.reason}` : b.reasonCode;
}
/** Suspend (ADM-07): sessions ended, referral links revoked and queued messages cancelled in one step (AC-P51-1). */
export async function suspend(ctx: AuthContext, id: string, b: AccountReason, req: Request) {
  const reason = reasonText(b);
  await loadAcc(id);
  const users = (await User.find({ accountId: id }, { _id: 1 }).lean<Array<{ _id: string }>>()).map((u) => u._id);
  await withTx(async (session) => {
    const u = await Account.updateOne({ _id: id, status: 'ACTIVE' }, { $set: { status: 'SUSPENDED', statusReason: reason } }, { session: session ?? undefined });
    if (!u.modifiedCount) throw AppError.invalidState('account', 'not active');
    await endSessions({ userId: { $in: users } }, 'ACCOUNT_SUSPENDED', session);
    await ReferralCode.updateMany({ accountId: id, status: 'ACTIVE' }, { $set: { status: 'REVOKED' } }, { session: session ?? undefined });
    await Outbox.updateMany({ accountId: id, status: 'QUEUED' }, { $set: { status: 'CANCELLED', skipReason: 'Account suspended' } }, { session: session ?? undefined });
    await useStepUp(req.stepUpId, 'ACCOUNT_SUSPENDED', session);
    await audit({ entity: 'account', entityId: id, action: 'ACCOUNT_SUSPENDED', after: { reason, reasonCode: b.reasonCode ?? null }, stepUpId: req.stepUpId }, { req, session });
  });
}
/** Reactivate (ADM-08): everything resumes from the next job run; nothing missed is sent late (AC-P51-2). */
export async function reactivate(ctx: AuthContext, id: string, reason: string, req: Request) {
  const u = await Account.updateOne({ _id: id, status: 'SUSPENDED' }, { $set: { status: 'ACTIVE', statusReason: reason } });
  if (!u.modifiedCount) throw AppError.invalidState('account', 'not suspended');
  await useStepUp(req.stepUpId, 'ACCOUNT_REACTIVATED', null);
  await audit({ entity: 'account', entityId: id, action: 'ACCOUNT_REACTIVATED', after: { reason }, stepUpId: req.stepUpId }, { req });
}
/** Close on request (ADM-09): the reason, the typed word CLOSE (change #51, ADM-14) and the OTP. Kept for CFG-87 years, then deleted. */
export async function close(ctx: AuthContext, id: string, b: AccountReason & { confirmText?: string | null }, req: Request) {
  if (b.confirmText !== 'CLOSE') throw AppError.field('confirmText', 'ADM-14'); // exactly, in capitals
  const reason = reasonText(b);
  const users = (await User.find({ accountId: id }, { _id: 1 }).lean<Array<{ _id: string }>>()).map((u) => u._id);
  const retain = new Date(clock.now()); retain.setUTCFullYear(retain.getUTCFullYear() + cfgNum('CFG-87'));
  await withTx(async (session) => {
    const u = await Account.updateOne({ _id: id, status: { $in: ['ACTIVE', 'SUSPENDED'] } }, { $set: { status: 'CLOSED', statusReason: reason, closedAt: clock.now(), retainUntil: retain } }, { session: session ?? undefined });
    if (!u.modifiedCount) throw AppError.invalidState('account', 'CLOSED');
    await endSessions({ userId: { $in: users } }, 'ACCOUNT_CLOSED', session);
    await ReferralCode.updateMany({ accountId: id, status: 'ACTIVE' }, { $set: { status: 'REVOKED' } }, { session: session ?? undefined });
    await Outbox.updateMany({ accountId: id, status: 'QUEUED' }, { $set: { status: 'CANCELLED', skipReason: 'Account closed' } }, { session: session ?? undefined });
    await useStepUp(req.stepUpId, 'ACCOUNT_CLOSED', session);
    await audit({ entity: 'account', entityId: id, action: 'ACCOUNT_CLOSED', after: { reason, typedConfirmation: true }, stepUpId: req.stepUpId }, { req, session });
  });
  return { date: dmy(retain.toISOString().slice(0, 10)) };
}

/** What a change to the Normal plan does (P-47): greetings off, queued WhatsApp cancelled, assistants disabled and signed out. */
async function applyNormalPlan(accountId: string, now: Date) {
  await Account.updateOne({ _id: accountId }, { $set: { 'subscription.plan': 'NORMAL', 'subscription.nextPlan': null, 'greetings.on': false } });
  await Outbox.updateMany({ accountId, channel: 'WHATSAPP', status: 'QUEUED' }, { $set: { status: 'CANCELLED', skipReason: 'Plan changed to Normal' } });
  const asts = await User.find({ accountId, role: 'AST', status: { $ne: 'DISABLED' } }, { _id: 1 }).lean<Array<{ _id: string }>>();
  await User.updateMany({ _id: { $in: asts.map((x) => x._id) } }, { $set: { status: 'DISABLED', disabledAt: now } });
  await endSessions({ userId: { $in: asts.map((x) => x._id) } }, 'USER_DISABLED');
}

/**
 * Change #50: a SkyUp Admin changes an advisor's plan (OTP, note). Only a paid plan in force (ACTIVE or GRACE) can be
 * changed; a trial already has every feature and an expired account renews through billing.
 *  - NOW: Premium starts at once (WhatsApp number set-up as on payment); Normal applies the downgrade effects at once.
 *  - NEXT_RENEWAL: a downgrade waits for the period end (the existing scheduled downgrade). An upgrade at renewal is
 *    not offered: the advisor chooses the plan when paying for the next period.
 * No money moves and no credit is given for remaining days (DEC-06 open, Q118): the period end is unchanged.
 */
export async function changePlan(ctx: AuthContext, id: string, b: { toPlan: Plan; effective: 'NOW' | 'NEXT_RENEWAL'; note: string }, req: Request) {
  const a = await loadAcc(id);
  if (a.status !== 'ACTIVE') throw AppError.invalidState('account', a.status);
  const eff = effectiveStatus(a.subscription, clock.now());
  if (!['ACTIVE', 'GRACE'].includes(eff)) throw AppError.invalidState('subscription', eff);
  if (a.subscription.plan === b.toPlan && !(b.toPlan === 'PREMIUM' && a.subscription.nextPlan === 'NORMAL')) throw AppError.invalidState('plan', b.toPlan === 'PREMIUM' ? 'Premium' : 'Normal');
  if (b.effective === 'NEXT_RENEWAL' && b.toPlan === 'PREMIUM') throw AppError.field('effective', 'VAL-22');
  const now = clock.now();
  const from = a.subscription.plan;
  const date = b.effective === 'NOW' ? istToday() : addDays(istDateOf(a.subscription.endsAt), 1);
  if (b.toPlan === 'PREMIUM') {
    await Account.updateOne({ _id: id }, { $set: { 'subscription.plan': 'PREMIUM', 'subscription.nextPlan': null,
      ...(!a.subscription.waNumber ? { 'subscription.waNumber': { status: 'SETTING_UP', number: null, startedAt: now } } : {}) } });
  } else if (b.effective === 'NOW') await applyNormalPlan(id, now);
  else await Account.updateOne({ _id: id }, { $set: { 'subscription.nextPlan': 'NORMAL' } });
  const change = await PlanChange.create({ accountId: id, fromPlan: from, toPlan: b.toPlan, effective: b.effective, effectiveFrom: date, note: b.note, changedBy: ctx.userId, stepUpId: req.stepUpId ?? null });
  await useStepUp(req.stepUpId, 'PLAN_CHANGED_BY_SKYUP', null);
  await audit({ entity: 'subscription', entityId: id, action: 'PLAN_CHANGED_BY_SKYUP', before: { plan: from }, after: { plan: b.toPlan, effective: b.effective, from: date, note: b.note }, stepUpId: req.stepUpId }, { req });
  const label = b.toPlan === 'PREMIUM' ? 'Premium' : 'Normal';
  const adv = await advisorOf(id);
  if (adv) await notify({ userId: adv._id, accountId: id, kind: 'PLAN_CHANGED', messageId: 'SUB-18', params: { plan: label, date: dmy(date) }, dedupeKey: `SUB-18|${change._id}`, link: { type: 'PROFILE', id } }).catch(() => undefined);
  return { change: { id: change._id, fromPlan: from, toPlan: b.toPlan, effective: b.effective, effectiveFrom: date }, params: { plan: label, date: dmy(date) } };
}

// ── P-52 export my data ──
export const EXPORT_PARTS = ['customers', 'leads', 'quotations', 'policies', 'payments', 'renewals'] as const;
const csv = (rows: Array<Record<string, unknown>>) => {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]!);
  const esc = (v: unknown) => { const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
};
/** Only this account's records (AC-P52-1); works in read-only mode (AC-P52-3); at most CFG-114 a day (AC-P52-4). */
export async function requestExport(ctx: AuthContext, include: string[], req: Request) {
  const today = istToday();
  if ((await ExportJob.countDocuments({ accountId: ctx.accountId, day: today, status: { $ne: 'FAILED' } })) >= cfgNum('CFG-114')) throw new AppError(429, 'LIMIT_REACHED', 'ADM-12', { 'CFG-114': cfgNum('CFG-114') });
  const job = await ExportJob.create({ accountId: ctx.accountId, userId: ctx.userId, include, day: today });
  await audit({ entity: 'export', entityId: job._id, action: 'EXPORT_REQUESTED', after: { include } }, { req });
  setImmediate(() => { void buildExport(ctx, job._id, include, req); });
  return job.toObject();
}
async function buildExport(ctx: AuthContext, id: string, include: string[], req: Request) {
  const acc = ctx.accountId!;
  try {
    const zip = new JSZip();
    if (include.includes('customers')) {
      zip.file('customers.csv', csv((await Customer.find({ accountId: acc }).lean<Array<Record<string, any>>>()).map((c) => ({ number: c.number, name: c.name, mobile: c.mobile, email: c.email, dob: c.dob, city: c.city, status: c.status, createdAt: c.createdAt }))));
      zip.file('family.csv', csv((await FamilyMember.find({ accountId: acc }).lean<Array<Record<string, any>>>()).map((f) => ({ customerId: f.customerId, name: f.name, relationship: f.relationship, dob: f.dob, status: f.status }))));
    }
    if (include.includes('leads')) zip.file('leads.csv', csv((await Lead.find({ accountId: acc }).lean<Array<Record<string, any>>>()).map((l) => ({ number: l.number, name: l.name, mobile: l.mobile, source: l.source, status: l.status, createdAt: l.createdAt }))));
    if (include.includes('quotations')) zip.file('quotations.csv', csv((await Quotation.find({ accountId: acc }).lean<Array<Record<string, any>>>()).map((q) => ({ number: q.number, status: q.status, customerId: q.customerId, revisions: q.revisions.length, final: q.revisions.at(-1)?.snapshot?.breakdown?.final ?? null, updatedAt: q.updatedAt }))));
    if (include.includes('policies')) zip.file('policies.csv', csv((await Policy.find({ accountId: acc }).lean<Array<Record<string, any>>>()).map((p) => ({ policyNumber: p.policyNumber, product: p.productName, status: p.status, startDate: p.startDate, endDate: p.endDate, premium: p.premium, sumInsured: p.sumInsured, customerId: p.customerId }))));
    if (include.includes('payments')) zip.file('payments.csv', csv((await Payment.find({ accountId: acc }).lean<Array<Record<string, any>>>()).map((p) => ({ quotationId: p.quotationId, status: p.status, mode: p.mode, amount: p.amount, paymentDate: p.paymentDate, reference: p.reference, note: 'as recorded by the advisor' }))));
    if (include.includes('renewals')) zip.file('renewals.csv', csv((await RenewalCycle.find({ accountId: acc }).lean<Array<Record<string, any>>>()).map((r) => ({ policyId: r.policyId, dueDate: r.dueDate, status: r.status, reason: r.reason }))));
    zip.file('README.txt', 'Bimayantra account export. Document files are not included: download them from the document vault.\n');
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    const f = await storeFile(ctx, 'ACCOUNT_EXPORT', bytes, `bimayantra-export-${istToday()}.zip`, req);
    await ExportJob.updateOne({ _id: id }, { $set: { status: 'READY', fileId: f.id, readyAt: clock.now(), expiresAt: new Date(clock.now().getTime() + cfgNum('CFG-113') * 3_600_000) } });
    await notify({ userId: ctx.userId, accountId: acc, kind: 'EXPORT', messageId: 'ADM-11', params: { 'CFG-113': cfgNum('CFG-113') }, dedupeKey: `ADM-11|${id}` }).catch(() => undefined);
  } catch (e) {
    await ExportJob.updateOne({ _id: id }, { $set: { status: 'FAILED', error: (e as Error).message } });
    await notify({ userId: ctx.userId, accountId: acc, kind: 'EXPORT', messageId: 'ADM-13', params: {}, dedupeKey: `ADM-13|${id}` }).catch(() => undefined);
  }
}
export const listExports = (ctx: AuthContext) => ExportJob.find({ accountId: ctx.accountId }).sort({ createdAt: -1 }).limit(50).lean();
/** Download: only the user who asked, only before CFG-113 (AC-P52-2). */
export async function downloadExport(ctx: AuthContext, id: string, req: Request) {
  const j = await ExportJob.findOne({ _id: id, accountId: ctx.accountId, userId: ctx.userId }).lean<{ status: string; fileId: string | null; expiresAt: Date | null }>();
  if (!j) throw AppError.notFound();
  if (j.status !== 'READY' || !j.fileId || !j.expiresAt || j.expiresAt <= clock.now()) throw AppError.invalidState('export', j.status === 'READY' ? 'EXPIRED' : j.status);
  return openFile(ctx, j.fileId, req);
}

// ── P-57 support grants ──
/** Names are encrypted in the database, so the list is sorted after reading. */
export async function supportStaff() {
  const rows = await User.find({ role: { $in: ['STF', 'ADM'] }, status: 'ACTIVE' }, { name: 1, role: 1 }).lean<Array<{ _id: string; name: string; role: string }>>();
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })).map((u) => ({ id: u._id, name: u.name, role: u.role }));
}
export async function giveGrant(ctx: AuthContext, b: { granteeUserId: string; reason: string }, req: Request) {
  const g = await User.findOne({ _id: b.granteeUserId, role: { $in: ['STF', 'ADM'] }, status: 'ACTIVE' }, { name: 1 }).lean<{ name: string }>();
  if (!g) throw AppError.field('granteeUserId', 'VAL-22');
  const endsAt = new Date(clock.now().getTime() + cfgNum('CFG-159') * 3_600_000);
  const grant = await SupportGrant.create({ accountId: ctx.accountId, granteeUserId: b.granteeUserId, reason: b.reason, startsAt: clock.now(), endsAt, givenBy: ctx.userId });
  await audit({ entity: 'support', entityId: grant._id, action: 'SUPPORT_GRANT_GIVEN', after: { to: g.name, until: endsAt, reason: b.reason } }, { req });
  const time = new Date(endsAt.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
  return { grant: grant.toObject(), params: { name: g.name, time: `${dmy(time.slice(0, 10))} ${time.slice(11)}` } };
}
export async function endGrant(ctx: AuthContext, id: string, req: Request) {
  const u = await SupportGrant.updateOne({ _id: id, accountId: ctx.accountId, status: 'ACTIVE' }, { $set: { status: 'ENDED', endedAt: clock.now(), endedBy: 'ADVISOR' } });
  if (!u.modifiedCount) throw AppError.invalidState('support access', 'not active');
  await audit({ entity: 'support', entityId: id, action: 'SUPPORT_GRANT_ENDED' }, { req });
}
export async function grants(ctx: AuthContext) {
  const rows = await SupportGrant.find({ accountId: ctx.accountId }).sort({ createdAt: -1 }).limit(100).lean<GrantDoc[]>();
  const names = new Map((await User.find({ _id: { $in: rows.map((r) => r.granteeUserId) } }, { name: 1 }).lean<Array<{ _id: string; name: string }>>()).map((u) => [u._id, u.name]));
  return rows.map((r) => ({ id: r._id, to: names.get(r.granteeUserId) ?? '', reason: r.reason, status: r.status === 'ACTIVE' && r.endsAt <= clock.now() ? 'EXPIRED' : r.status, startsAt: r.startsAt, endsAt: r.endsAt, log: r.log }));
}
/** Every SkyUp read of client data checks the grant on the request (AC-P57-1/2) and is logged for the advisor (AC-P57-3). */
export async function underGrant(ctx: AuthContext, accountId: string, what: string, recordId: string | null, req?: Request) {
  const u = await SupportGrant.findOneAndUpdate({ accountId, granteeUserId: ctx.userId, status: 'ACTIVE', endsAt: { $gt: clock.now() } }, { $push: { log: { at: clock.now(), what, recordId } } }, { new: true }).lean();
  if (!u) {
    // Change #56: the refused attempt is logged (who, which account, what) before SUP-03 is shown
    await audit({ entity: 'support', entityId: accountId, action: 'SUPPORT_ACCESS_REFUSED', result: 'REFUSED', after: { what, recordId }, actor: { userId: ctx.userId, role: ctx.role, accountId } }, { req }).catch(() => undefined);
    throw new AppError(403, 'SUPPORT_GRANT_REQUIRED', 'SUP-03');
  }
}
export async function supportCustomers(ctx: AuthContext, accountId: string, req?: Request) {
  await underGrant(ctx, accountId, 'Customer list', null, req);
  return (await Customer.find({ accountId }, { number: 1, name: 1, status: 1 }).sort({ createdAt: -1 }).limit(500).lean<Array<{ _id: string; number: string; name: string; status: string }>>()).map((c) => ({ id: c._id, number: c.number, name: c.name, status: c.status }));
}
export async function supportCustomer(ctx: AuthContext, accountId: string, id: string, req?: Request) {
  await underGrant(ctx, accountId, 'Customer', id, req);
  const c = await Customer.findOne({ _id: id, accountId }).lean<Record<string, any>>();
  if (!c) throw AppError.notFound();
  const docs = await CustomerDocument.find({ accountId, customerId: id }, { type: 1, label: 1, version: 1, status: 1 }).lean();
  // The full Aadhaar or PAN reveal is never available to support (P-57 backend rule)
  return { id: c._id, number: c.number, name: c.name, mobile: c.mobile, email: c.email, dob: c.dob, city: c.city, status: c.status, documents: docs.map((d) => ({ type: d.type, label: d.label, version: d.version, status: d.status })) };
}

/** Dev tools: the gateway confirming a subscription payment (signed). */
export function devSign(body: object) { return sign(JSON.stringify(body)); }
void cfgList;
// ════════ Changes #53, #54: subscriptions and wallets across all advisors (read only) ════════
import { WalletTxn } from '../comms/outbox.model.js';

/** Every advisor account with its plan, status (as in force now), period end and last invoice; filter by status. */
export async function subscriptions(q: { status?: string }) {
  const accs = await Account.find({}, { subscription: 1, status: 1, createdAt: 1 }).sort({ createdAt: -1 }).limit(2000).lean<Array<{ _id: string; status: string; subscription: Parameters<typeof effectiveStatus>[0] & { plan: string | null; cycle?: string | null; endsAt: Date } }>>();
  const advisors = new Map((await User.find({ role: 'ADV', accountId: { $in: accs.map((a) => a._id) } }, { name: 1, accountId: 1 }).lean<Array<{ name: string; accountId: string }>>()).map((u) => [u.accountId, u.name]));
  const last = new Map((await SubscriptionOrder.aggregate<{ _id: string; id: string; invoiceNumber: string; totalPaise: number; at: Date }>([
    { $match: { status: 'SUCCESS' } }, { $sort: { createdAt: -1 } },
    { $group: { _id: '$accountId', id: { $first: '$_id' }, invoiceNumber: { $first: '$invoiceNumber' }, totalPaise: { $first: '$totalPaise' }, at: { $first: '$createdAt' } } },
  ])).map((r) => [r._id, r]));
  const rows = accs.map((a) => {
    const inv = last.get(a._id);
    return { accountId: a._id, advisor: advisors.get(a._id) ?? '', accountStatus: a.status, plan: a.subscription.plan, status: effectiveStatus(a.subscription, clock.now()), cycle: a.subscription.cycle ?? null,
      endsAt: a.subscription.endsAt, lastInvoice: inv ? { id: inv.id, number: inv.invoiceNumber, total: inv.totalPaise / 100, at: inv.at } : null };
  });
  return q.status && q.status !== 'ALL' ? rows.filter((r) => r.status === q.status) : rows;
}
/** One invoice: plan, period, amounts with the GST split, how it was paid and by whom recorded, GSTIN and state. */
export async function invoice(id: string) {
  const o = await SubscriptionOrder.findOne({ _id: id, status: 'SUCCESS' }).lean<OrderDoc>();
  if (!o) throw AppError.notFound();
  const [adv, by] = await Promise.all([User.findOne({ accountId: o.accountId, role: 'ADV' }, { name: 1 }).lean<{ name: string }>(), User.findById(o.createdBy, { name: 1, role: 1 }).lean<{ name: string; role: string }>()]);
  return {
    id: o._id, invoiceNumber: o.invoiceNumber, accountId: o.accountId, advisor: adv?.name ?? '', plan: o.plan, cycle: o.cycle, period: { from: o.periodStart, to: o.periodEnd },
    amounts: { base: o.basePaise / 100, credit: o.creditPaise / 100, cgst: (o.gst.cgst ?? 0) / 100, sgst: (o.gst.sgst ?? 0) / 100, igst: (o.gst.igst ?? 0) / 100, total: o.totalPaise / 100 },
    method: o.kind === 'OFFLINE' ? 'Offline' : 'Online', reference: o.reference ?? o.gatewayPaymentId ?? null,
    recordedBy: o.kind === 'OFFLINE' ? (by?.name ?? null) : null, gstin: o.gstin ?? null, state: o.state ?? null, at: o.createdAt,
  };
}
/** All wallets: totals (balance, recharged this month, messages this month, low and empty) and one row per account. */
export async function wallets(q: { filter?: 'ALL' | 'LOW' | 'EMPTY' }) {
  const monthStart = new Date(`${istToday().slice(0, 7)}-01T00:00:00+05:30`);
  const accs = await Account.find({}, { wallet: 1, subscription: 1 }).lean<Array<{ _id: string; wallet: { balancePaise: number }; subscription: { plan: string | null } }>>();
  const [recharges, debits, lastRecharge] = await Promise.all([
    WalletTxn.aggregate<{ _id: string; paise: number }>([{ $match: { type: { $in: ['RECHARGE', 'CREDIT'] }, status: 'SUCCESS', createdAt: { $gte: monthStart } } }, { $group: { _id: '$accountId', paise: { $sum: '$amountPaise' } } }]),
    WalletTxn.aggregate<{ _id: string; n: number }>([{ $match: { type: 'DEBIT', createdAt: { $gte: monthStart } } }, { $group: { _id: '$accountId', n: { $sum: 1 } } }]),
    WalletTxn.aggregate<{ _id: string; at: Date; paise: number }>([{ $match: { type: 'RECHARGE', status: 'SUCCESS' } }, { $sort: { createdAt: -1 } }, { $group: { _id: '$accountId', at: { $first: '$createdAt' }, paise: { $first: '$amountPaise' } } }]),
  ]);
  const rmap = new Map(recharges.map((r) => [r._id, r.paise])); const dmap = new Map(debits.map((d) => [d._id, d.n])); const lmap = new Map(lastRecharge.map((l) => [l._id, l]));
  const advisors = new Map((await User.find({ role: 'ADV' }, { name: 1, accountId: 1 }).lean<Array<{ name: string; accountId: string }>>()).map((u) => [u.accountId, u.name]));
  const price = cfgNum('CFG-162'); const lowBelow = cfgNum('CFG-164') * 100;
  const rows = accs.map((a) => {
    const bal = a.wallet?.balancePaise ?? 0;
    const status = bal < price ? 'EMPTY' : bal < lowBelow ? 'LOW' : 'OK';
    const lr = lmap.get(a._id);
    return { accountId: a._id, advisor: advisors.get(a._id) ?? '', plan: a.subscription?.plan ?? null, balance: bal / 100, lastRecharge: lr ? { at: lr.at, amount: lr.paise / 100 } : null, messagesThisMonth: dmap.get(a._id) ?? 0, status, statusLabel: status === 'EMPTY' ? 'Empty · sending paused' : status === 'LOW' ? 'Low' : 'OK' };
  });
  const totals = {
    balance: rows.reduce((s, r) => s + r.balance, 0), rechargedThisMonth: [...rmap.values()].reduce((s, p) => s + p, 0) / 100,
    messagesThisMonth: rows.reduce((s, r) => s + r.messagesThisMonth, 0), lowCount: rows.filter((r) => r.status === 'LOW').length, emptyCount: rows.filter((r) => r.status === 'EMPTY').length,
  };
  const filter = q.filter ?? 'ALL';
  return { totals, rows: filter === 'ALL' ? rows : rows.filter((r) => r.status === filter) };
}