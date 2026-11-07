import type { Request } from 'express';
import { flagOn } from '../flags/flags.js';
import { cfgBool, cfgList, cfgNum } from '../../config/cfg.js';
import { clock, istToday } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { msg } from '../../lib/messages.js';
import { isDuplicateKey, withTx } from '../../lib/mongo.js';
import { audit } from '../audit/audit.service.js';
import { assertOwnFile } from '../files/files.service.js';
import { Insurer } from '../insurers/insurer.model.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { Quotation, type QuotationDoc } from '../quotations/quotation.model.js';
import { pageMeta, pageSize } from '../../lib/pagination.js';
import { Payment, type PaymentDoc } from './payment.model.js';

type Snap = { insurer: { id: string; name: string }; customer: { name: string }; breakdown: { final: number }; calculationDate: string };
const dmy = (iso: string) => iso.split('-').reverse().join('-');
const isoFromDmy = (d: string) => (/^\d{2}-\d{2}-\d{4}$/.test(d) ? d.split('-').reverse().join('-') : d);

async function loadQ(ctx: AuthContext, quotationId: string) {
  const q = await Quotation.findOne({ _id: quotationId, accountId: ctx.accountId }).lean<QuotationDoc>();
  if (!q) throw AppError.notFound();
  const rev = q.revisions[q.revisions.length - 1];
  return { q, rev, snap: rev?.snapshot as Snap | undefined };
}
const view = (p: PaymentDoc) => ({
  id: p._id, quotationId: p.quotationId, revision: p.revision, status: p.status, statusLabel: 'as recorded by the advisor', method: p.method, link: p.link,
  linkValidUntil: p.linkValidUntil, portalAmount: p.portalAmount, mode: p.mode, amount: p.amount, paymentDate: p.paymentDate, reference: p.reference,
  cheque: p.cheque, differenceReason: p.differenceReason, recordedAt: p.recordedAt, reason: p.reason, createdAt: p.createdAt,
});

export async function list(ctx: AuthContext, quotationId: string) {
  await loadQ(ctx, quotationId);
  return (await Payment.find({ accountId: ctx.accountId, quotationId }).sort({ createdAt: -1 }).lean<PaymentDoc[]>()).map(view);
}

/**
 * B-04 · GET /payments?customerId=&status=: payments of the account with the quotation, customer, product and insurer
 * they belong to (from the frozen revision), so the customer's Payments tab needs one request, not one per quotation.
 */
export async function listAll(ctx: AuthContext, q: { page: number; limit?: number; customerId?: string | null; status?: string }) {
  const qFilter: Record<string, unknown> = { accountId: ctx.accountId };
  if (q.customerId) qFilter.customerId = q.customerId;
  const quotes = await Quotation.find(qFilter, { number: 1, customerId: 1, revisions: 1 }).lean<QuotationDoc[]>();
  const byId = new Map(quotes.map((x) => [x._id, x]));
  const filter: Record<string, unknown> = { accountId: ctx.accountId, ...(q.customerId ? { quotationId: { $in: [...byId.keys()] } } : {}), ...(q.status ? { status: q.status } : {}) };
  const limit = pageSize(q.limit);
  const [items, total] = await Promise.all([
    Payment.find(filter).sort({ createdAt: -1, _id: -1 }).skip((q.page - 1) * limit).limit(limit).lean<PaymentDoc[]>(),
    Payment.countDocuments(filter),
  ]);
  const missing = items.map((p) => p.quotationId).filter((id) => !byId.has(id));
  if (missing.length) for (const x of await Quotation.find({ _id: { $in: missing }, accountId: ctx.accountId }, { number: 1, customerId: 1, revisions: 1 }).lean<QuotationDoc[]>()) byId.set(x._id, x);
  type Snap2 = { customer?: { id: string; name: string }; product?: { name: string }; insurer?: { name: string } };
  return {
    items: items.map((p) => {
      const qt = byId.get(p.quotationId);
      const s = qt?.revisions.find((r) => r.revision === p.revision)?.snapshot as Snap2 | undefined;
      return { ...view(p), quotationNumber: qt?.number ?? null, customer: s?.customer ? { id: s.customer.id, name: s.customer.name } : null, productName: s?.product?.name ?? null, insurer: s?.insurer?.name ?? null };
    }),
    meta: pageMeta(q.page, limit, total),
  };
}

/** The quotation's PAID payment, if any (P-55 Submit, the customer's page). */
export const paidFor = (quotationId: string) => Payment.findOne({ quotationId, status: 'PAID' }).lean<PaymentDoc>();
export const awaitingFor = (quotationId: string, revision: number) => Payment.findOne({ quotationId, revision, status: 'AWAITING_PAYMENT' }).lean<PaymentDoc>();

/** When a revision is superseded or cancelled, its AWAITING_PAYMENT payment becomes CANCELLED (P-31, P-29). */
export async function cancelAwaiting(quotationId: string, revisions: number[]) {
  await Payment.updateMany({ quotationId, revision: { $in: revisions }, status: 'AWAITING_PAYMENT' }, { $set: { status: 'CANCELLED' } });
}

export interface LinkBody { method: 'Insurer payment link' | 'Paid at insurer branch or by cheque' | 'Other insurer channel'; link?: string | null; linkValidUntil?: string | null; portalAmount: number; note?: string | null }

/**
 * P-31 Add (or replace) the insurer payment link. The link's domain must be the insurer's (or a subdomain, PAY-01);
 * the portal amount must match the final payable within CFG-52 (PAY-02); at most CFG-50 attempts (PAY-03).
 */
export async function addLink(ctx: AuthContext, quotationId: string, b: LinkBody, replace: boolean, req: Request) {
  const { q, rev, snap } = await loadQ(ctx, quotationId);
  if (!rev || !['READY', 'SHARED', 'ACCEPTED'].includes(rev.status) || !['READY', 'SHARED', 'ACCEPTED'].includes(q.status)) throw AppError.invalidState('quotation', q.status);
  if (await paidFor(quotationId)) throw AppError.invalidState('quotation', 'PAID');
  if ((await Payment.countDocuments({ quotationId })) >= cfgNum('CFG-50')) throw new AppError(409, 'LIMIT_REACHED', 'PAY-03', { 'CFG-50': cfgNum('CFG-50') });
  const insurer = await Insurer.findById(snap!.insurer.id, { name: 1, paymentDomains: 1 }).lean<{ name: string; paymentDomains: string[] }>();
  if (b.method === 'Insurer payment link') {
    if (!b.link) throw AppError.field('link', 'GEN-01', { 'Field label': 'Payment link' });
    const host = new URL(b.link).hostname.toLowerCase();
    const ok = (insurer?.paymentDomains ?? []).some((d) => host === d || host.endsWith(`.${d}`));
    if (!ok) throw AppError.field('link', 'PAY-01', { insurer: insurer?.name ?? '', 'allowed domains': (insurer?.paymentDomains ?? []).join(', ') }); // AC-P31-1
  }
  const until = b.linkValidUntil ? new Date(b.linkValidUntil) : null;
  if (until && until.getTime() <= clock.now().getTime()) throw AppError.field('linkValidUntil', 'VAL-07');
  if (Math.abs(b.portalAmount - snap!.breakdown.final) > cfgNum('CFG-52')) throw AppError.field('portalAmount', 'PAY-02', { 'portal amount': b.portalAmount.toLocaleString('en-IN'), 'final payable': snap!.breakdown.final.toLocaleString('en-IN') });
  const current = await awaitingFor(quotationId, rev.revision);
  if (current && !replace) throw AppError.invalidState('payment', 'AWAITING PAYMENT');
  try {
    const p = await withTx(async (session) => {
      if (current) await Payment.updateOne({ _id: current._id, status: 'AWAITING_PAYMENT' }, { $set: { status: 'EXPIRED' } }, { session: session ?? undefined }); // AC-P31-4
      const [p] = await Payment.create([{ accountId: ctx.accountId, quotationId, revision: rev.revision, insurerId: snap!.insurer.id, status: 'AWAITING_PAYMENT', method: b.method, link: b.link ?? null, linkValidUntil: until, portalAmount: b.portalAmount, note: b.note ?? null }], { session: session ?? undefined });
      await audit({ entity: 'quotation', entityId: quotationId, action: replace ? 'PAYMENT_LINK_REPLACED' : 'PAYMENT_LINK_ADDED', after: { paymentId: p!._id, method: b.method } }, { req, session });
      return p!.toObject() as PaymentDoc;
    });
    return { payment: view(p), params: { customer: snap!.customer.name } };
  } catch (e) {
    if (isDuplicateKey(e)) throw AppError.invalidState('payment', 'AWAITING PAYMENT'); // double save: one payment
    throw e;
  }
}

export interface RecordBody {
  mode: string; amount: number; paymentDate: string; reference?: string | null; cheque?: { number: string; bank: string; date: string } | null;
  differenceReason?: string | null; receiptFileId?: string | null; declaration: true;
}

/**
 * P-32 Record the premium payment. PAID, and the quotation ACCEPTED if it was SHARED, in one transaction. The database
 * allows one PAID payment per quotation, so two tabs at once: the second gets GEN-04.
 */
export async function record(ctx: AuthContext, quotationId: string, b: RecordBody, req: Request) {
  const { q, rev, snap } = await loadQ(ctx, quotationId);
  if (!rev || !['SHARED', 'ACCEPTED', 'EXPIRED'].includes(rev.status)) throw AppError.invalidState('quotation', q.status);
  if (await paidFor(quotationId)) throw AppError.invalidState('quotation', 'PAID');
  if (!cfgList('CFG-166').includes(b.mode)) throw AppError.field('mode', 'VAL-22');
  const date = isoFromDmy(b.paymentDate);
  if (date > istToday()) throw AppError.field('paymentDate', 'PAY-11');
  const created = new Date(q.createdAt).toISOString().slice(0, 10);
  if (date < created) throw AppError.field('paymentDate', 'PAY-12', { date: dmy(created) });
  if (rev.validUntil && date > rev.validUntil) throw AppError.field('paymentDate', 'PAY-15', { date: dmy(rev.validUntil) });
  if (rev.status === 'EXPIRED' && (!rev.validUntil || date > rev.validUntil)) throw AppError.invalidState('quotation', 'EXPIRED');
  if (cfgList('CFG-167').includes(b.mode) && !b.reference) throw AppError.field('reference', 'PAY-16', { mode: b.mode }); // AC-P32-1
  if (b.mode === 'Cheque' && !b.cheque) throw AppError.field('cheque', 'GEN-01', { 'Field label': 'Cheque details' });
  if (Math.abs(b.amount - snap!.breakdown.final) > cfgNum('CFG-52') && !b.differenceReason) throw AppError.field('differenceReason', 'PAY-13');
  if (cfgBool('CFG-51') && !b.receiptFileId) throw AppError.field('receiptFileId', 'GEN-01', { 'Field label': 'Receipt' });
  if (b.receiptFileId) await assertOwnFile(ctx, b.receiptFileId, 'CUSTOMER_DOCUMENT', 'receiptFileId');
  const referenceKey = b.reference ? `${snap!.insurer.id}|${b.reference.toUpperCase()}` : null;
  if (referenceKey) {
    const used = await Payment.findOne({ accountId: ctx.accountId, referenceKey, status: 'PAID' }, { quotationId: 1 }).lean<{ quotationId: string }>();
    if (used) { const uq = await Quotation.findById(used.quotationId, { number: 1 }).lean<{ number: string }>(); throw AppError.field('reference', 'PAY-08', { record: uq?.number ?? 'another quotation' }); } // AC-P32-3
  }
  try {
    const p = await withTx(async (session) => {
      const fields = { status: 'PAID', mode: b.mode, amount: b.amount, paymentDate: date, reference: b.reference ?? null, referenceKey, cheque: b.cheque ?? null, differenceReason: b.differenceReason ?? null, receiptFileId: b.receiptFileId ?? null, recordedBy: ctx.userId, recordedAt: clock.now() };
      const awaiting = await Payment.findOneAndUpdate({ quotationId, revision: rev.revision, status: 'AWAITING_PAYMENT' }, { $set: fields }, { new: true, session: session ?? undefined }).lean<PaymentDoc>();
      const p = awaiting ?? (await Payment.create([{ accountId: ctx.accountId, quotationId, revision: rev.revision, insurerId: snap!.insurer.id, ...fields }], { session: session ?? undefined }))[0]!.toObject() as PaymentDoc;
      // Change #11 (Q2): with the account switch on, recording a payment no longer accepts the quotation
      if (rev.status === 'SHARED' && !flagOn('payment_skips_auto_accept', ctx.accountId)) {
        const revisions = q.revisions.map((r, i) => (i === q.revisions.length - 1 ? { ...r, status: 'ACCEPTED' } : r));
        await Quotation.updateOne({ _id: quotationId }, { $set: { status: 'ACCEPTED', revisions }, $inc: { version: 1 } }, { session: session ?? undefined });
      }
      await audit({ entity: 'quotation', entityId: quotationId, action: 'PAYMENT_RECORDED', after: { paymentId: p._id, mode: b.mode, amount: b.amount } }, { req, session });
      return p;
    });
    const warnings = b.mode === 'Cash' ? [{ messageId: 'PAY-17', message: msg('PAY-17', { customer: snap!.customer.name, insurer: snap!.insurer.name }) }] : []; // AC-P32-2
    return { payment: view(p), warnings };
  } catch (e) {
    if (isDuplicateKey(e, 'one_paid_per_quotation')) throw AppError.invalidState('quotation', 'PAID');
    if (isDuplicateKey(e, 'one_reference_per_insurer')) throw AppError.field('reference', 'PAY-08', { record: 'another quotation' });
    throw e;
  }
}

/** Mark failed (PAY-06), link expired (PAY-07) or undo (PAY-09; not once the proposal is SUBMITTED unless DECLINED). */
export async function change(ctx: AuthContext, id: string, to: 'FAILED' | 'EXPIRED' | 'REVERSED', reason: string | null, req: Request) {
  const p = await Payment.findOne({ _id: id, accountId: ctx.accountId }).lean<PaymentDoc>();
  if (!p) throw AppError.notFound();
  const from = to === 'REVERSED' ? ['PAID'] : ['AWAITING_PAYMENT', 'PAID'].filter((s) => to === 'FAILED' || s === 'AWAITING_PAYMENT');
  if (!from.includes(p.status)) throw AppError.invalidState('payment', p.status);
  if (to === 'REVERSED') {
    const { Proposal } = await import('../proposals/proposal.model.js');
    const pr = await Proposal.findOne({ quotationId: p.quotationId, status: 'SUBMITTED' }, { _id: 1 }).lean();
    if (pr) throw new AppError(409, 'INVALID_STATE', 'PAY-10'); // AC-P32-4
  }
  const u = await Payment.findOneAndUpdate({ _id: id, status: p.status }, { $set: { status: to, reason } }, { new: true }).lean<PaymentDoc>();
  if (!u) throw AppError.versionConflict('payment', view(p));
  await audit({ entity: 'quotation', entityId: p.quotationId, action: `PAYMENT_${to}`, after: { paymentId: id, reason } }, { req });
  return view(u);
}