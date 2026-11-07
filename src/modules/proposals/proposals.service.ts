import type { Request } from 'express';
import { cfgList, cfgNum } from '../../config/cfg.js';
import { ageOn, clock, istToday } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { msg, type MessageId } from '../../lib/messages.js';
import { isDuplicateKey, withTx } from '../../lib/mongo.js';
import { nextNumber } from '../accounts/numbers.js';
import { audit } from '../audit/audit.service.js';
import { CustomerDocument } from '../documents/document.model.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { InsuranceType } from '../catalogue/types.model.js';
import { paidFor } from '../payments/payments.service.js';
import { Policy } from '../policies/policy.model.js';
import { Quotation, type QuotationDoc } from '../quotations/quotation.model.js';
import { Customer } from '../customers/customer.model.js';
import { Proposal, type ProposalDoc } from './proposal.model.js';

type Member = { name: string; relationship: string; dob: string | null; age: number };
type Answer = { answer: boolean; condition?: string | null; since?: string | null; treatment?: string | null };
type Declaration = { member: string; answers: Record<string, Answer> };
type Nominee = { name: string; relationship: string; dob: string; share: number; appointee?: { name: string; dob: string } | null };
type Snap = { number: string; customer: { id: string; name: string }; people: Member[]; product: { id: string; name: string; uin: string }; insurer: { id: string; name: string }; breakdown: { final: number }; inputs: { typeId: string } };

/** CFG-174: the declaration questions for this insurance type. */
function questionsFor(typeName: string) {
  if (/term|life/i.test(typeName)) return ['Tobacco', 'Pre-existing disease', 'Hazardous occupation'];
  if (/motor|car|two-?wheeler/i.test(typeName)) return ['Claims in the last policy year'];
  return cfgList('CFG-174');
}

const view = (p: ProposalDoc) => ({
  id: p._id, number: p.number, status: p.status, quotationId: p.quotationId, revision: p.revision, customerId: p.customerId, members: p.members, questions: p.questions,
  declarations: p.declarations, nominees: p.nominees, declineReason: p.declineReason, cancelReason: p.cancelReason ?? null, cancelNote: p.cancelNote ?? null, policyId: p.policyId, submittedAt: p.submittedAt, version: p.version,
  ...((p.declarations as Declaration[]).some((d) => Object.values(d.answers ?? {}).some((a) => a.answer)) ? { warning: { messageId: 'PRP-03', message: msg('PRP-03') } } : {}),
});
async function load(ctx: AuthContext, id: string) {
  const p = await Proposal.findOne({ _id: id, accountId: ctx.accountId }).lean<ProposalDoc>();
  if (!p) throw AppError.notFound();
  return p;
}
const snapOf = async (p: Pick<ProposalDoc, 'quotationId' | 'revision'>) => {
  const q = await Quotation.findById(p.quotationId).lean<QuotationDoc>();
  return (q!.revisions.find((r) => r.revision === p.revision)!.snapshot) as Snap;
};

/** Start proposal (PRP-01). An expired quotation cannot be used (QT-44, AC-P55-1); SHARED is marked accepted here. */
export async function start(ctx: AuthContext, quotationId: string, req: Request) {
  const q = await Quotation.findOne({ _id: quotationId, accountId: ctx.accountId }).lean<QuotationDoc>();
  if (!q) throw AppError.notFound();
  const rev = q.revisions[q.revisions.length - 1];
  if (rev?.status === 'EXPIRED' || q.status === 'EXPIRED' || (rev?.validUntil && rev.validUntil < istToday())) throw new AppError(409, 'INVALID_STATE', 'QT-44');
  if (!rev || !['SHARED', 'ACCEPTED'].includes(rev.status) || q.status === 'DRAFT') throw AppError.invalidState('quotation', q.status);
  const snap = rev.snapshot as Snap;
  const type = await InsuranceType.findById(snap.inputs.typeId, { name: 1 }).lean<{ name: string }>();
  // P-55 step 4: nominees start from the customer's default nominee (P-35, B-01); the advisor can change them.
  const holder = await Customer.findOne({ _id: snap.customer.id, accountId: ctx.accountId }, { defaultNominee: 1 }).lean<{ defaultNominee?: { name: string; relationship: string; dob: string; appointeeName?: string | null; appointeeDob?: string | null } | null }>();
  const dn = holder?.defaultNominee;
  const defaultNominees: Nominee[] = dn ? [{ name: dn.name, relationship: dn.relationship, dob: dn.dob, share: 100, appointee: dn.appointeeName && dn.appointeeDob ? { name: dn.appointeeName, dob: dn.appointeeDob } : null }] : [];
  try {
    const p = await withTx(async (session) => {
      if (rev.status === 'SHARED') {
        const revisions = q.revisions.map((r, i) => (i === q.revisions.length - 1 ? { ...r, status: 'ACCEPTED' } : r));
        await Quotation.updateOne({ _id: quotationId }, { $set: { status: 'ACCEPTED', revisions }, $inc: { version: 1 } }, { session: session ?? undefined });
      }
      const number = await nextNumber(ctx.accountId!, 'proposal', session);
      const [p] = await Proposal.create([{ accountId: ctx.accountId, quotationId, revision: rev.revision, variantId: (rev as { variantId?: string | null }).variantId ?? null, customerId: snap.customer.id, number, createdBy: ctx.userId, // change #2
        members: snap.people.map((m) => ({ name: m.name, relationship: m.relationship, dob: m.dob, age: m.age })), questions: questionsFor(type?.name ?? ''),
        nominees: defaultNominees }], { session: session ?? undefined });
      await audit({ entity: 'proposal', entityId: p!._id, action: 'PROPOSAL_STARTED', after: { quotationId, number } }, { req, session });
      return p!.toObject() as ProposalDoc;
    });
    return { proposal: view(p), params: { number: p.number, 'quotation number': `${q.number} R${rev.revision}` } };
  } catch (e) {
    if (isDuplicateKey(e, 'one_draft_per_quotation')) throw AppError.invalidState('quotation', 'already in a proposal');
    throw e;
  }
}

/** P-35 nominee rules (POL-11 to POL-17). Totals (POL-13) are checked on Submit. */
function nomineeProblems(ns: Nominee[], holder: Member, max: number, final: boolean) {
  const p: Array<{ field: string; messageId: MessageId; params?: Record<string, string | number> }> = [];
  if (ns.length > max) p.push({ field: 'nominees', messageId: 'POL-11', params: { max } });
  const names = new Set<string>();
  ns.forEach((n, i) => {
    if (n.share < cfgNum('CFG-55')) p.push({ field: `nominees.${i}.share`, messageId: 'POL-12', params: { 'CFG-55': cfgNum('CFG-55') } });
    if (n.name.trim().toLowerCase() === holder.name.toLowerCase() && n.dob === holder.dob) p.push({ field: `nominees.${i}.name`, messageId: 'POL-14' });
    if (names.has(n.name.trim().toLowerCase())) p.push({ field: `nominees.${i}.name`, messageId: 'POL-15', params: { Name: n.name } });
    names.add(n.name.trim().toLowerCase());
    if (ageOn(n.dob) < cfgNum('CFG-56')) {
      if (!n.appointee) p.push({ field: `nominees.${i}.appointee`, messageId: 'POL-16', params: { Name: n.name, 'CFG-56': cfgNum('CFG-56') } });
      else if (ageOn(n.appointee.dob) < cfgNum('CFG-56')) p.push({ field: `nominees.${i}.appointee`, messageId: 'POL-17', params: { 'CFG-56': cfgNum('CFG-56') } });
    }
  });
  const total = Math.round(ns.reduce((t, n) => t + n.share, 0) * 100) / 100;
  if (final && ns.length && total !== cfgNum('CFG-54')) p.push({ field: 'nominees', messageId: 'POL-13', params: { 'CFG-54': cfgNum('CFG-54'), total } });
  return p;
}

/** Save declarations and nominees (DRAFT). Members are locked (PRP-06). */
export async function save(ctx: AuthContext, id: string, b: { version: number; declarations: Declaration[]; nominees: Nominee[] }) {
  const p = await load(ctx, id);
  if (p.status !== 'DRAFT') throw AppError.invalidState('proposal', p.status);
  const members = p.members as Member[];
  if (b.declarations.some((d) => !members.some((m) => m.name === d.member))) throw AppError.field('declarations', 'PRP-06');
  const probs = nomineeProblems(b.nominees, members[0]!, cfgNum('CFG-53'), false);
  if (probs.length) throw AppError.fields(probs);
  const u = await Proposal.findOneAndUpdate({ _id: id, version: b.version, status: 'DRAFT' }, { $set: { declarations: b.declarations, nominees: b.nominees }, $inc: { version: 1 } }, { new: true }).lean<ProposalDoc>();
  if (!u) throw AppError.versionConflict('proposal', view(p));
  return view(u);
}

/** What Submit needs, step by step (shown on the review screen too). */
export async function readiness(ctx: AuthContext, id: string) {
  const p = await load(ctx, id);
  const snap = await snapOf(p);
  const members = p.members as Member[];
  const decl = p.declarations as Declaration[];
  const problems: Array<{ field: string; messageId: MessageId; params?: Record<string, string | number> }> = [];
  for (const m of members) {
    const d = decl.find((x) => x.member === m.name);
    if (!d || p.questions.some((q) => d.answers?.[q]?.answer === undefined)) { problems.push({ field: 'declarations', messageId: 'PRP-02', params: { name: m.name } }); continue; }
    for (const q of p.questions) if (d.answers[q]!.answer && !d.answers[q]!.condition?.trim()) problems.push({ field: 'declarations', messageId: 'GEN-01', params: { 'Field label': 'Condition details' } });
  }
  problems.push(...nomineeProblems(p.nominees as Nominee[], members[0]!, cfgNum('CFG-53'), true));
  const docs = await CustomerDocument.find({ accountId: ctx.accountId, customerId: p.customerId, personKey: `C:${p.customerId}`, status: 'CONFIRMED', type: { $in: ['Aadhaar', 'PAN'] } }, { type: 1 }).lean<Array<{ type: string }>>();
  const kyc = ['Aadhaar', 'PAN'].every((t) => docs.some((d) => d.type === t));
  if (!kyc) problems.push({ field: 'kyc', messageId: 'PRP-04', params: { customer: snap.customer.name } }); // AC-P55-2
  const paid = await paidFor(p.quotationId);
  if (!paid) problems.push({ field: 'payment', messageId: 'PAY-18' }); // AC-P55-3
  return { kyc, paid: paid ? { amount: paid.amount, mode: paid.mode, date: paid.paymentDate, label: 'as recorded by the advisor' } : null, problems: problems.map((x) => ({ ...x, message: msg(x.messageId, x.params ?? {}) })) };
}

/**
 * Submit (ADV only, AC-P55-6): SUBMITTED, and the policy record AWAITING_ISSUANCE with frozen copies — one transaction.
 * A double Submit gives one submission (idempotent route).
 */
export async function submit(ctx: AuthContext, id: string, b: { version: number }, req: Request) {
  const p = await load(ctx, id);
  if (p.status !== 'DRAFT') throw AppError.invalidState('proposal', p.status);
  const r = await readiness(ctx, id);
  if (r.problems.length) throw AppError.fields(r.problems.map((x) => ({ field: x.field, messageId: x.messageId, params: x.params })));
  const snap = await snapOf(p);
  const paid = await paidFor(p.quotationId);
  const out = await withTx(async (session) => {
    const q = await Quotation.findById(p.quotationId).lean<QuotationDoc>();
    const qInputs = (q!.revisions.find((r) => r.revision === p.revision)!.snapshot as { inputs: { typeId: string; sumInsured: number; people: string[] } }).inputs;
    const [pol] = await Policy.create([{ accountId: ctx.accountId, customerId: p.customerId, proposalId: id, quotationId: p.quotationId, createdBy: ctx.userId,
      variantId: (p as { variantId?: string | null }).variantId ?? (q!.revisions.find((r) => r.revision === p.revision) as { variantId?: string | null } | undefined)?.variantId ?? null, // change #2
      insurerId: snap.insurer.id, productId: snap.product.id, productName: snap.product.name, typeId: qInputs.typeId, sumInsured: qInputs.sumInsured, premium: paid!.amount,
      insured: (p.members as Member[]).map((m, i) => ({ key: qInputs.people[i] ?? null, name: m.name, relationship: m.relationship, dob: m.dob })), frozen: {
      members: p.members, declarations: p.declarations, nominees: p.nominees, product: snap.product, insurer: snap.insurer, premium: snap.breakdown.final,
      payment: { id: paid!._id, amount: paid!.amount, mode: paid!.mode, date: paid!.paymentDate }, quotation: `${snap.number}`, proposal: p.number,
    } }], { session: session ?? undefined });
    const u = await Proposal.findOneAndUpdate({ _id: id, version: b.version, status: 'DRAFT' }, { $set: { status: 'SUBMITTED', policyId: pol!._id, submittedAt: clock.now(), submittedBy: ctx.userId }, $inc: { version: 1 } }, { new: true, session: session ?? undefined }).lean<ProposalDoc>();
    if (!u) throw AppError.versionConflict('proposal', null);
    await audit({ entity: 'proposal', entityId: id, action: 'PROPOSAL_SUBMITTED', after: { policyId: pol!._id } }, { req, session });
    return u;
  });
  return { proposal: view(out), params: { number: out.number, insurer: snap.insurer.name } };
}

/** Mark declined (reason): DECLINED, policy record CANCELLED; the payment can then be undone (P-32). */
export async function decline(ctx: AuthContext, id: string, b: { version: number; reason: string }, req: Request) {
  const p = await load(ctx, id);
  if (p.status !== 'SUBMITTED') throw AppError.invalidState('proposal', p.status);
  const snap = await snapOf(p);
  const u = await withTx(async (session) => {
    const u = await Proposal.findOneAndUpdate({ _id: id, version: b.version, status: 'SUBMITTED' }, { $set: { status: 'DECLINED', declineReason: b.reason }, $inc: { version: 1 } }, { new: true, session: session ?? undefined }).lean<ProposalDoc>();
    if (!u) throw AppError.versionConflict('proposal', view(p));
    await Policy.updateOne({ _id: p.policyId }, { $set: { status: 'CANCELLED' } }, { session: session ?? undefined });
    await audit({ entity: 'proposal', entityId: id, action: 'PROPOSAL_DECLINED', after: { reason: b.reason } }, { req, session });
    return u;
  });
  return { proposal: view(u), params: { number: u.number, insurer: snap.insurer.name } };
}

/**
 * B-02 · Cancel a DRAFT proposal (PRC): nothing was sent to the insurer, so the quotation stays as it was and a new
 * proposal can be started from it. A SUBMITTED proposal is not cancelled here: it is marked declined (PRP-07).
 */
export async function cancel(ctx: AuthContext, id: string, b: { version: number; reason: string; note?: string | null }, req: Request) {
  const p = await load(ctx, id);
  if (p.status !== 'DRAFT') throw AppError.invalidState('proposal', p.status);
  const q = await Quotation.findById(p.quotationId, { number: 1 }).lean<{ number: string | null }>();
  const u = await withTx(async (session) => {
    const doc = await Proposal.findOneAndUpdate({ _id: id, version: b.version, status: 'DRAFT' },
      { $set: { status: 'CANCELLED', cancelReason: b.reason, cancelNote: b.note ?? null, cancelledAt: clock.now(), cancelledBy: ctx.userId }, $inc: { version: 1 } }, { new: true, session: session ?? undefined }).lean<ProposalDoc>();
    if (!doc) throw AppError.versionConflict('proposal', view(p));
    await audit({ entity: 'proposal', entityId: id, entityRef: p.number, action: 'PROPOSAL_CANCELLED', after: { reason: b.reason, quotation: q?.number ?? null } }, { req, session });
    return doc;
  });
  return { proposal: view(u), params: { number: u.number } };
}

export async function get(ctx: AuthContext, id: string) { const p = await load(ctx, id); return { ...view(p), readiness: await readiness(ctx, id) }; }
/** Gap fix (Proposals list): customer, quotation number, product, insurer and premium on every row (from the frozen quotation). */
export async function list(ctx: AuthContext) {
  const rows = await Proposal.find({ accountId: ctx.accountId }).sort({ updatedAt: -1 }).limit(200).lean<ProposalDoc[]>();
  const quotes = new Map((await Quotation.find({ _id: { $in: rows.map((r) => r.quotationId) } }, { revisions: 1, number: 1 }).lean<QuotationDoc[]>()).map((q) => [q._id, q]));
  return rows.map((p) => {
    const q = quotes.get(p.quotationId);
    const s = q?.revisions.find((r) => r.revision === p.revision)?.snapshot as (Snap & { product: { variantName?: string | null } }) | undefined;
    return {
      ...view(p), updatedAt: (p as { updatedAt?: Date }).updatedAt ?? null,
      quotationNumber: q?.number ?? s?.number ?? null, customer: s ? { id: s.customer.id, name: s.customer.name } : null,
      productName: s?.product.name ?? null, variantName: s?.product.variantName ?? null, insurer: s?.insurer.name ?? null, premium: s?.breakdown.final ?? null,
    };
  });
}