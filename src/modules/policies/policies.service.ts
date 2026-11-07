import type { Request } from 'express';
import { cfgNum, cfgRange } from '../../config/cfg.js';
import { ageOn, clock, istToday } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import type { MessageId } from '../../lib/messages.js';
import { isDuplicateKey, withTx } from '../../lib/mongo.js';
import { audit } from '../audit/audit.service.js';
import { Customer, FamilyMember } from '../customers/customer.model.js';
import { assertOwnFile } from '../files/files.service.js';
import { Insurer } from '../insurers/insurer.model.js';
import { can, type AuthContext } from '../rbac/capabilities.js';
import { Product, ProductVersion, type ProductDoc } from '../catalogue/product.model.js';
import type { ProductData } from '../catalogue/products.service.js';
import { Payment } from '../payments/payment.model.js';
import { RenewalCycle } from '../renewals/renewal.model.js';
import { NomineeVersion, Policy, type NomineeVersionDoc, type PolicyDoc } from './policy.model.js';

type Problem = { field: string; messageId: MessageId; params?: Record<string, string | number> };
const dmy = (iso: string) => iso.split('-').reverse().join('-');
const iso = (d: string) => (/^\d{2}-\d{2}-\d{4}$/.test(d) ? d.split('-').reverse().join('-') : d);
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const addYears = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCFullYear(x.getUTCFullYear() + n); return x.toISOString().slice(0, 10); };

export interface PolicyFields {
  policyNumber: string; issueDate: string; startDate: string; endDate: string; frequency: 'Single' | 'Yearly' | 'Half-yearly' | 'Quarterly' | 'Monthly';
  nextDueDate?: string | null; sumInsured: number; sumInsuredReason?: string | null; premium: number; documentFileId?: string | null; notes?: string | null; expectedCommission?: number | null;
}
export interface NomineeIn { personKey?: string | null; name: string; relationship: string; dob: string; share: number; appointee?: { name: string; relationship: string; dob: string } | null; mobile?: string | null }

async function load(ctx: AuthContext, id: string) {
  const p = await Policy.findOne({ _id: id, accountId: ctx.accountId }).lean<PolicyDoc>();
  if (!p) throw AppError.notFound();
  return p;
}
async function view(ctx: AuthContext, p: PolicyDoc) {
  const [nominees, versions, cycle, insurer, customer] = await Promise.all([
    NomineeVersion.findOne({ policyId: p._id, status: 'CURRENT' }).lean<NomineeVersionDoc>(),
    NomineeVersion.find({ policyId: p._id }, { number: 1, status: 1, endorsementRef: 1, effectiveDate: 1, createdAt: 1, nominees: 1 }).sort({ number: -1 }).lean<NomineeVersionDoc[]>(),
    RenewalCycle.findOne({ policyId: p._id }).sort({ createdAt: -1 }).lean(),
    p.insurerId ? Insurer.findById(p.insurerId, { name: 1 }).lean<{ name: string }>() : null,
    Customer.findById(p.customerId, { name: 1, number: 1 }).lean<{ name: string; number: string }>(),
  ]);
  const { expectedCommission, policyNumberKey: _k, ...rest } = p;
  return {
    ...rest, id: p._id, insurer: insurer?.name ?? null, customer: customer ? { id: p.customerId, name: customer.name, number: customer.number } : null,
    ...(can(ctx.role, 'policies.manage') ? { expectedCommission } : {}), // visible only to the advisor (P-33)
    nominees: nominees?.nominees ?? [], nomineeVersions: versions.map((v) => ({ number: v.number, status: v.status, endorsementRef: v.endorsementRef, effectiveDate: v.effectiveDate, savedAt: v.createdAt, nominees: v.nominees })),
    renewal: cycle ? { status: cycle.status, dueDate: cycle.dueDate, graceUntil: cycle.graceUntil, reason: cycle.reason } : null,
  };
}

/** P-33/P-34 field checks. */
async function checkFields(ctx: AuthContext, b: PolicyFields, o: { insurerId: string; paymentDate?: string | null; quotedSumInsured?: number | null; documentRequired: boolean; selfId?: string }): Promise<Problem[]> {
  const p: Problem[] = [];
  const { min, max } = cfgRange('CFG-107');
  const num = b.policyNumber.trim();
  if (num.length < min || num.length > max || !/^[A-Za-z0-9/-]+$/.test(num)) p.push({ field: 'policyNumber', messageId: 'VAL-20', params: { 'CFG-107': `${min} to ${max}` } });
  else {
    const dup = await Policy.findOne({ accountId: ctx.accountId, policyNumberKey: `${o.insurerId}|${num.toUpperCase()}`, ...(o.selfId ? { _id: { $ne: o.selfId } } : {}) }, { customerId: 1 }).lean<{ customerId: string }>();
    if (dup) { const c = await Customer.findById(dup.customerId, { name: 1 }).lean<{ name: string }>(); p.push({ field: 'policyNumber', messageId: 'POL-02', params: { number: num, customer: c?.name ?? '' } }); } // AC-P33-2
  }
  const issue = iso(b.issueDate), start = iso(b.startDate), end = iso(b.endDate);
  if (issue > istToday()) p.push({ field: 'issueDate', messageId: 'VAL-35' });
  if (o.paymentDate && issue < o.paymentDate) p.push({ field: 'issueDate', messageId: 'POL-03', params: { date: dmy(o.paymentDate) } });
  if (end < start) p.push({ field: 'endDate', messageId: 'VAL-08' });
  else if (end > addYears(start, cfgNum('CFG-58'))) p.push({ field: 'endDate', messageId: 'POL-04', params: { 'CFG-58': cfgNum('CFG-58') } });
  const longerThanYear = end > addDays(addYears(start, 1), -1);
  if (b.frequency !== 'Single' && longerThanYear) {
    if (!b.nextDueDate) p.push({ field: 'nextDueDate', messageId: 'GEN-01', params: { 'Field label': 'Next premium due date' } });
    else if (iso(b.nextDueDate) <= start || iso(b.nextDueDate) > end) p.push({ field: 'nextDueDate', messageId: 'POL-05' });
  }
  if (o.quotedSumInsured !== null && o.quotedSumInsured !== undefined && b.sumInsured !== o.quotedSumInsured && !b.sumInsuredReason?.trim()) p.push({ field: 'sumInsuredReason', messageId: 'POL-06' });
  if (o.documentRequired && !b.documentFileId) p.push({ field: 'documentFileId', messageId: 'GEN-01', params: { 'Field label': 'Policy document' } });
  if (b.documentFileId) await assertOwnFile(ctx, b.documentFileId, 'POLICY_DOCUMENT', 'documentFileId');
  return p;
}

/** The renewal cycle's date: the next premium due date when set, otherwise the end date (backend rule). */
const cycleDate = (b: { nextDueDate?: string | null; endDate: string }) => iso(b.nextDueDate || b.endDate);
async function gracePeriod(productId: string | null) {
  if (!productId) return cfgNum('CFG-62');
  const p = await Product.findById(productId, { publishedVersionId: 1 }).lean<ProductDoc>();
  const v = p?.publishedVersionId ? await ProductVersion.findById(p.publishedVersionId, { data: 1 }).lean<{ data: ProductData }>() : null;
  return v?.data?.gracePeriodDays ?? cfgNum('CFG-62');
}

/** P-35 rules on a list (POL-11 to POL-17), shares summed exactly in hundredths. */
async function nomineeProblems(ctx: AuthContext, pol: PolicyDoc, ns: NomineeIn[]): Promise<Problem[]> {
  const p: Problem[] = [];
  const product = pol.productId ? await Product.findById(pol.productId, { publishedVersionId: 1 }).lean<ProductDoc>() : null;
  const data = product?.publishedVersionId ? (await ProductVersion.findById(product.publishedVersionId, { data: 1 }).lean<{ data: ProductData }>())?.data : undefined;
  const max = Math.min(data?.maxNominees ?? cfgNum('CFG-53'), cfgNum('CFG-53'));
  if (ns.length > max) p.push({ field: 'nominees', messageId: 'POL-11', params: { max } });
  const holder = await Customer.findById(pol.customerId, { name: 1, dob: 1 }).lean<{ name: string; dob: string | null }>();
  const seen = new Set<string>();
  for (const [i, n] of ns.entries()) {
    if (n.personKey?.startsWith('F:')) { // GEN-11: a family member of another customer
      const f = await FamilyMember.findOne({ _id: n.personKey.slice(2), customerId: pol.customerId, accountId: ctx.accountId }, { _id: 1 }).lean();
      if (!f) throw AppError.notFound();
    }
    if (n.personKey === `C:${pol.customerId}` || (holder && n.name.trim().toLowerCase() === holder.name.toLowerCase() && iso(n.dob) === holder.dob)) p.push({ field: `nominees.${i}.name`, messageId: 'POL-14' });
    const key = n.personKey ?? n.name.trim().toLowerCase();
    if (seen.has(key)) p.push({ field: `nominees.${i}.name`, messageId: 'POL-15', params: { Name: n.name } });
    seen.add(key);
    if (Math.round(n.share * 100) < cfgNum('CFG-55') * 100) p.push({ field: `nominees.${i}.share`, messageId: 'POL-12', params: { 'CFG-55': cfgNum('CFG-55') } });
    if (ageOn(iso(n.dob)) < cfgNum('CFG-56')) {
      if (!n.appointee) p.push({ field: `nominees.${i}.appointee`, messageId: 'POL-16', params: { Name: n.name, 'CFG-56': cfgNum('CFG-56') } }); // AC-P35-4
      else if (ageOn(iso(n.appointee.dob)) < cfgNum('CFG-56')) p.push({ field: `nominees.${i}.appointee`, messageId: 'POL-17', params: { 'CFG-56': cfgNum('CFG-56') } });
    }
  }
  const total = ns.reduce((t, n) => t + Math.round(n.share * 100), 0);
  if (ns.length && total !== cfgNum('CFG-54') * 100) p.push({ field: 'nominees', messageId: 'POL-13', params: { 'CFG-54': cfgNum('CFG-54'), total: total / 100 } });
  return p;
}

async function writeNominees(ctx: AuthContext, pol: PolicyDoc, ns: NomineeIn[], extra: { endorsementRef?: string | null; effectiveDate?: string | null; documentFileId?: string | null }, session: import('mongoose').ClientSession | null) {
  const last = await NomineeVersion.findOne({ policyId: pol._id }, { number: 1 }).sort({ number: -1 }).session(session).lean<{ number: number }>();
  await NomineeVersion.updateMany({ policyId: pol._id, status: 'CURRENT' }, { $set: { status: 'PREVIOUS' } }, { session: session ?? undefined });
  await NomineeVersion.create([{ accountId: ctx.accountId, policyId: pol._id, customerId: pol.customerId, number: (last?.number ?? 0) + 1, nominees: ns.map((n) => ({ ...n, dob: iso(n.dob), ...(n.appointee ? { appointee: { ...n.appointee, dob: iso(n.appointee.dob) } } : {}) })), endorsementRef: extra.endorsementRef ?? null, effectiveDate: extra.effectiveDate ? iso(extra.effectiveDate) : null, documentFileId: extra.documentFileId ?? null, savedBy: ctx.userId }], { session: session ?? undefined });
}

/**
 * P-33 Record the issued policy: ISSUED, its renewal cycle and the snapshot in one transaction (POL-01). The nominees
 * from the proposal become version 1 unless the advisor enters others. Double save: one policy, one cycle.
 */
export async function issue(ctx: AuthContext, id: string, b: PolicyFields & { version: number; nominees?: NomineeIn[] | null; renewalOf?: boolean }, req: Request) {
  const pol = await load(ctx, id);
  if (pol.status !== 'AWAITING_ISSUANCE') throw AppError.invalidState('policy', pol.status);
  const paid = pol.quotationId ? await Payment.findOne({ quotationId: pol.quotationId, status: 'PAID' }, { paymentDate: 1 }).lean<{ paymentDate: string }>() : null;
  const problems = await checkFields(ctx, b, { insurerId: pol.insurerId!, paymentDate: paid?.paymentDate ?? null, quotedSumInsured: pol.sumInsured, documentRequired: true });
  const product = pol.productId ? await Product.findById(pol.productId, { publishedVersionId: 1 }).lean<ProductDoc>() : null;
  const data = product?.publishedVersionId ? (await ProductVersion.findById(product.publishedVersionId, { data: 1 }).lean<{ data: ProductData }>())?.data : undefined;
  const nominees = b.nominees ?? (pol.frozen as { nominees?: NomineeIn[] } | null)?.nominees ?? [];
  if (data?.nomineeRequired && !nominees.length) problems.push({ field: 'nominees', messageId: 'POL-07' }); // AC-P33-3
  if (nominees.length) problems.push(...(await nomineeProblems(ctx, pol, nominees)));
  if (problems.length) throw AppError.fields(problems);
  const grace = await gracePeriod(pol.productId ?? null);
  // P-38: a policy recorded on a renewal quotation asks "Renewal of {policy number}?" (pre-ticked)
  const { Quotation } = await import('../quotations/quotation.model.js');
  const qd = pol.quotationId ? await Quotation.findById(pol.quotationId, { inputs: 1 }).lean<{ inputs: { renewalOf?: string | null } }>() : null;
  const renews = b.renewalOf !== false ? qd?.inputs?.renewalOf ?? null : null;
  try {
    const out = await withTx(async (session) => {
      const after = { policyNumber: b.policyNumber.trim(), issueDate: iso(b.issueDate), startDate: iso(b.startDate), endDate: iso(b.endDate), frequency: b.frequency, nextDueDate: b.nextDueDate ? iso(b.nextDueDate) : null, sumInsured: b.sumInsured, sumInsuredReason: b.sumInsuredReason ?? null, premium: b.premium, documentFileId: b.documentFileId ?? null, notes: b.notes ?? null, expectedCommission: b.expectedCommission ?? null };
      const u = await Policy.findOneAndUpdate({ _id: id, version: b.version, status: 'AWAITING_ISSUANCE' }, {
        $set: { ...after, status: 'ISSUED', policyNumberKey: `${pol.insurerId}|${after.policyNumber.toUpperCase()}`, gracePeriodDays: grace, issuedAt: clock.now(), renewalOf: renews },
        $push: { history: { at: clock.now(), by: ctx.userId, action: 'ISSUED', reason: null, before: null, after } }, $inc: { version: 1 },
      }, { new: true, session: session ?? undefined }).lean<PolicyDoc>();
      if (!u) throw AppError.versionConflict('policy', null);
      if (nominees.length) await writeNominees(ctx, u, nominees, {}, session);
      const due = cycleDate(after);
      await RenewalCycle.create([{ accountId: ctx.accountId, policyId: id, customerId: pol.customerId, dueDate: due, graceUntil: addDays(due, grace) }], { session: session ?? undefined });
      if (renews) await (await import('../renewals/renewals.service.js')).closeByRenewalPolicy(renews, id, session);
      await audit({ entity: 'policy', entityId: id, action: 'POLICY_ISSUED', after: { policyNumber: after.policyNumber, renewalDate: due, renewalOf: renews } }, { req, session });
      return u;
    });
    return { policy: await view(ctx, out), params: { 'policy number': out.policyNumber! }, renewed: !!renews };
  } catch (e) {
    if (isDuplicateKey(e, 'one_number_per_insurer')) throw AppError.field('policyNumber', 'POL-02', { number: b.policyNumber, customer: '' });
    throw e;
  }
}

/**
 * P-34 Record an existing policy (no quotation or payment, AC-P34-1). Past end (or due) date: POL-08 must be confirmed;
 * the policy is EXPIRED and its cycle DUE, or LAPSED once the grace period has passed (AC-P34-2).
 */
export async function existing(ctx: AuthContext, b: PolicyFields & { customerId: string; insurerId: string; productId?: string | null; productName?: string | null; typeId: string; soldByMe: boolean; insured: string[]; confirmExpired?: boolean }, req: Request) {
  const cus = await Customer.findOne({ _id: b.customerId, accountId: ctx.accountId }, { name: 1, dob: 1, status: 1 }).lean<{ _id: string; name: string; dob: string | null; status: string }>();
  if (!cus) throw AppError.notFound();
  if (cus.status !== 'ACTIVE') throw AppError.invalidState('customer', cus.status);
  const ins = await Insurer.findOne({ _id: b.insurerId, status: 'ACTIVE', ownerAccountId: { $in: [null, ctx.accountId] } }, { _id: 1 }).lean();
  if (!ins) throw AppError.field('insurerId', 'VAL-22');
  let productName = b.productName?.trim() ?? null;
  if (b.productId) {
    const pr = await Product.findOne({ _id: b.productId, insurerId: b.insurerId, $or: [{ kind: 'VERIFIED' }, { kind: 'OWN', accountId: ctx.accountId }] }).lean<ProductDoc>();
    if (!pr) throw AppError.field('productId', 'VAL-22');
    productName = pr.name ?? pr.code;
  } else if (!productName) throw AppError.field('productName', 'GEN-01', { 'Field label': 'Product name' }); // AC-P34-3: not in catalogue, by name
  const fam = await FamilyMember.find({ customerId: b.customerId, accountId: ctx.accountId, status: 'ACTIVE' }, { name: 1, dob: 1, relationship: 1 }).lean<Array<{ _id: string; name: string; dob: string | null; relationship: string }>>();
  const everyone = [{ key: `C:${cus._id}`, name: cus.name, relationship: 'Self', dob: cus.dob }, ...fam.map((f) => ({ key: `F:${f._id}`, name: f.name, relationship: f.relationship, dob: f.dob }))];
  const insured = b.insured.map((k) => everyone.find((e) => e.key === k) ?? (() => { throw AppError.field('insured', 'VAL-22'); })());
  if (!insured.length) throw AppError.field('insured', 'GEN-01', { 'Field label': 'Insured persons' });
  const problems = await checkFields(ctx, b, { insurerId: b.insurerId, documentRequired: false });
  if (problems.length) throw AppError.fields(problems);
  const due = cycleDate(b);
  const today = istToday();
  const past = due < today;
  if (past && !b.confirmExpired) throw new AppError(409, 'CONFIRMATION_REQUIRED', 'POL-08');
  const grace = await gracePeriod(b.productId ?? null);
  try {
    const pol = await withTx(async (session) => {
      const fields = { policyNumber: b.policyNumber.trim(), issueDate: iso(b.issueDate), startDate: iso(b.startDate), endDate: iso(b.endDate), frequency: b.frequency, nextDueDate: b.nextDueDate ? iso(b.nextDueDate) : null, sumInsured: b.sumInsured, premium: b.premium, documentFileId: b.documentFileId ?? null, notes: b.notes ?? null, expectedCommission: b.expectedCommission ?? null };
      const [pol] = await Policy.create([{ accountId: ctx.accountId, customerId: b.customerId, source: 'EXISTING', status: past ? 'EXPIRED' : 'ISSUED', insurerId: b.insurerId, productId: b.productId ?? null, productName, typeId: b.typeId, soldByMe: b.soldByMe, insured,
        ...fields, policyNumberKey: `${b.insurerId}|${fields.policyNumber.toUpperCase()}`, gracePeriodDays: grace, issuedAt: clock.now(), createdBy: ctx.userId,
        history: [{ at: clock.now(), by: ctx.userId, action: 'RECORDED_EXISTING', before: null, after: fields }] }], { session: session ?? undefined });
      const graceUntil = addDays(due, grace);
      await RenewalCycle.create([{ accountId: ctx.accountId, policyId: pol!._id, customerId: b.customerId, dueDate: due, graceUntil, status: !past ? 'UPCOMING' : graceUntil < today ? 'LAPSED' : 'DUE' }], { session: session ?? undefined });
      await audit({ entity: 'policy', entityId: pol!._id, action: 'POLICY_EXISTING_RECORDED', after: { policyNumber: fields.policyNumber, status: past ? 'EXPIRED' : 'ISSUED' } }, { req, session });
      return pol!.toObject() as PolicyDoc;
    });
    return { policy: await view(ctx, pol), params: { 'policy number': pol.policyNumber! } };
  } catch (e) {
    if (isDuplicateKey(e, 'one_number_per_insurer')) throw AppError.field('policyNumber', 'POL-02', { number: b.policyNumber, customer: cus.name });
    throw e;
  }
}

/**
 * P-35 Save nominees: a new CURRENT version (the earlier one PREVIOUS). On an ISSUED policy the insurer endorsement
 * reference and effective date are required (AC-P35-5).
 */
export async function saveNominees(ctx: AuthContext, id: string, b: { nominees: NomineeIn[]; endorsementRef?: string | null; effectiveDate?: string | null; documentFileId?: string | null }, req: Request) {
  const pol = await load(ctx, id);
  if (!['AWAITING_ISSUANCE', 'ISSUED'].includes(pol.status)) throw AppError.invalidState('policy', pol.status);
  const problems = await nomineeProblems(ctx, pol, b.nominees);
  if (pol.status === 'ISSUED') {
    if (!b.endorsementRef?.trim()) problems.push({ field: 'endorsementRef', messageId: 'GEN-01', params: { 'Field label': 'Insurer endorsement reference' } });
    if (!b.effectiveDate) problems.push({ field: 'effectiveDate', messageId: 'GEN-01', params: { 'Field label': 'Effective date' } });
  }
  if (problems.length) throw AppError.fields(problems);
  if (b.documentFileId) await assertOwnFile(ctx, b.documentFileId, 'POLICY_DOCUMENT', 'documentFileId');
  await withTx(async (session) => {
    await writeNominees(ctx, pol, b.nominees, b, session);
    await audit({ entity: 'policy', entityId: id, action: 'POLICY_NOMINEES_SAVED', after: { count: b.nominees.length, endorsementRef: b.endorsementRef ?? null } }, { req, session });
  });
  return { policy: await view(ctx, (await Policy.findById(id).lean<PolicyDoc>())!), params: { 'policy number': pol.policyNumber ?? '(awaiting issuance)' } };
}

/**
 * P-36 Correct details (reason required; old values kept in history). If the end or due date changes and the cycle is
 * not RENEWED, its dates are recalculated in the same transaction (AC-P36-1).
 */
export async function correct(ctx: AuthContext, id: string, b: { version: number; reason: string; changes: Partial<PolicyFields> }, req: Request) {
  const pol = await load(ctx, id);
  if (!['AWAITING_ISSUANCE', 'ISSUED'].includes(pol.status)) throw AppError.invalidState('policy', pol.status);
  const merged = { policyNumber: pol.policyNumber ?? '', issueDate: pol.issueDate ?? istToday(), startDate: pol.startDate ?? istToday(), endDate: pol.endDate ?? istToday(), frequency: (pol.frequency ?? 'Yearly') as PolicyFields['frequency'], nextDueDate: pol.nextDueDate, sumInsured: pol.sumInsured ?? 0, premium: pol.premium ?? 0, documentFileId: pol.documentFileId, ...b.changes, sumInsuredReason: 'correction' };
  if (pol.status === 'ISSUED') {
    const problems = await checkFields(ctx, merged, { insurerId: pol.insurerId!, documentRequired: false, selfId: id });
    if (problems.length) throw AppError.fields(problems);
  }
  const before = Object.fromEntries(Object.keys(b.changes).map((k) => [k, (pol as Record<string, unknown>)[k] ?? null]));
  const after = Object.fromEntries(Object.entries(b.changes).map(([k, v]) => [k, typeof v === 'string' && /Date$/.test(k) && v ? iso(v) : v]));
  await withTx(async (session) => {
    const u = await Policy.findOneAndUpdate({ _id: id, version: b.version }, {
      $set: { ...after, ...(after.policyNumber ? { policyNumberKey: `${pol.insurerId}|${String(after.policyNumber).toUpperCase()}` } : {}) },
      $push: { history: { at: clock.now(), by: ctx.userId, action: 'CORRECTED', reason: b.reason, before, after } }, $inc: { version: 1 },
    }, { new: true, session: session ?? undefined }).lean<PolicyDoc>();
    if (!u) throw AppError.versionConflict('policy', null);
    if (pol.status === 'ISSUED' && ('endDate' in after || 'nextDueDate' in after)) {
      const due = cycleDate({ nextDueDate: u.nextDueDate, endDate: u.endDate! });
      await RenewalCycle.updateOne({ policyId: id, status: { $in: ['UPCOMING', 'DUE', 'LAPSED'] } }, { $set: { dueDate: due, graceUntil: addDays(due, u.gracePeriodDays ?? cfgNum('CFG-62')) } }, { session: session ?? undefined });
    }
    await audit({ entity: 'policy', entityId: id, action: 'POLICY_CORRECTED', before, after: { ...after, reason: b.reason } }, { req, session });
  });
  return view(ctx, (await Policy.findById(id).lean<PolicyDoc>())!);
}

/** P-36 Cancel: CANCELLED, the open cycle NOT_RENEWING "Policy cancelled" so reminders stop (AC-P36-2). */
export async function cancel(ctx: AuthContext, id: string, b: { version: number; reason: string; date: string; refund?: number | null; note?: string | null }, req: Request) {
  const pol = await load(ctx, id);
  if (!['AWAITING_ISSUANCE', 'ISSUED'].includes(pol.status)) throw AppError.invalidState('policy', pol.status);
  if (iso(b.date) > istToday()) throw AppError.field('date', 'VAL-35');
  await withTx(async (session) => {
    const u = await Policy.findOneAndUpdate({ _id: id, version: b.version, status: { $in: ['AWAITING_ISSUANCE', 'ISSUED'] } }, {
      $set: { status: 'CANCELLED', cancellation: { reason: b.reason, date: iso(b.date), refund: b.refund ?? null, note: b.note ?? null } },
      $push: { history: { at: clock.now(), by: ctx.userId, action: 'CANCELLED', reason: b.reason, before: { status: pol.status }, after: { status: 'CANCELLED' } } }, $inc: { version: 1 },
    }, { new: true, session: session ?? undefined }).lean<PolicyDoc>();
    if (!u) throw AppError.invalidState('policy', 'CANCELLED');
    await RenewalCycle.updateMany({ policyId: id, status: { $in: ['UPCOMING', 'DUE', 'LAPSED'] } }, { $set: { status: 'NOT_RENEWING', reason: 'Policy cancelled' } }, { session: session ?? undefined });
    await audit({ entity: 'policy', entityId: id, action: 'POLICY_CANCELLED', after: { reason: b.reason } }, { req, session });
  });
  return view(ctx, (await Policy.findById(id).lean<PolicyDoc>())!);
}

export async function get(ctx: AuthContext, id: string) { return view(ctx, await load(ctx, id)); }
export async function list(ctx: AuthContext, q: { status?: string; customerId?: string }) {
  const rows = await Policy.find({ accountId: ctx.accountId, ...(q.status ? { status: q.status } : {}), ...(q.customerId ? { customerId: q.customerId } : {}) }).sort({ updatedAt: -1 }).limit(300).lean<PolicyDoc[]>();
  const names = new Map((await Customer.find({ _id: { $in: rows.map((r) => r.customerId) } }, { name: 1 }).lean<Array<{ _id: string; name: string }>>()).map((c) => [c._id, c.name]));
  // Gap fix (11 · Policies): insurer, dates, sum insured and the renewal stage for the list and its stat tiles.
  const insurers = new Map((await Insurer.find({ _id: { $in: rows.map((r) => r.insurerId).filter(Boolean) } }, { name: 1 }).lean<Array<{ _id: string; name: string }>>()).map((i) => [i._id, i.name]));
  const cycles = new Map((await RenewalCycle.find({ policyId: { $in: rows.map((r) => r._id) } }, { policyId: 1, status: 1, dueDate: 1 }).sort({ createdAt: 1 }).lean<Array<{ policyId: string; status: string; dueDate: string }>>()).map((c) => [c.policyId, c]));
  return rows.map((r) => ({
    id: r._id, customerId: r.customerId, customer: names.get(r.customerId) ?? '', status: r.status, source: r.source, policyNumber: r.policyNumber, productName: r.productName,
    endDate: r.endDate, premium: r.premium, createdAt: r.createdAt,
    insurer: r.insurerId ? insurers.get(r.insurerId) ?? null : null, startDate: r.startDate, sumInsured: r.sumInsured, frequency: r.frequency, proposalId: r.proposalId, quotationId: r.quotationId,
    renewal: cycles.get(r._id) ? { status: cycles.get(r._id)!.status, dueDate: cycles.get(r._id)!.dueDate } : null,
  }));
}