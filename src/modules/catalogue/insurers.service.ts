import type { Request } from 'express';
import mongoose from 'mongoose';
import { clock } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { msg } from '../../lib/messages.js';
import { isDuplicateKey } from '../../lib/mongo.js';
import { audit } from '../audit/audit.service.js';
import { assertStepUp, useStepUp } from '../auth/stepUp.js';
import { Insurer, type InsurerDoc } from '../insurers/insurer.model.js';
import { InsurerMapping } from '../insurers/mapping.model.js';
import type { AuthContext } from '../rbac/capabilities.js';

/**
 * P-20 Manage insurers, with Section 9 maker-checker. STF or ADM makes; a DIFFERENT ADM approves, after the
 * step-up OTP (AUTH-26, on the route). The insurer ID never changes; renaming never changes snapshots.
 */
export const FIELDS = ['name', 'shortCode', 'category', 'irdaiRegNo', 'website', 'paymentDomains', 'careNumber', 'careEmail'] as const;
export type Values = { name: string; shortCode: string; category: string; irdaiRegNo: string; website?: string | null; paymentDomains: string[]; careNumber?: string | null; careEmail?: string | null };

const pick = (o: Record<string, unknown>) => Object.fromEntries(FIELDS.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])) as Partial<Values>;
const valuesOf = (d: InsurerDoc): Values => pick(d as unknown as Record<string, unknown>) as Values;

/** CAT-06 (name, ignoring case) and CAT-07 (code), against every other insurer. */
async function assertUnique(v: Partial<Values>, exceptId?: string) {
  const not = exceptId ? { _id: { $ne: exceptId } } : {};
  // The SkyUp library only: an advisor's private insurer may carry the same name (change #3)
  if (v.name && (await Insurer.exists({ nameKey: v.name.toLowerCase(), ownerAccountId: null, ...not }))) throw AppError.field('name', 'CAT-06');
  if (v.shortCode && (await Insurer.exists({ shortCode: v.shortCode, ...not }))) throw AppError.field('shortCode', 'CAT-07');
}
const dupToField = (e: unknown): never => {
  if (isDuplicateKey(e)) {
    const key = JSON.stringify((e as { keyPattern?: object }).keyPattern ?? {});
    throw key.includes('shortCode') ? AppError.field('shortCode', 'CAT-07') : AppError.field('name', 'CAT-06');
  }
  throw e;
};

export function view(d: InsurerDoc, ctx?: AuthContext) {
  const p = d.pendingChange;
  return {
    id: d._id, ...valuesOf(d), status: d.status, version: d.version, makerId: d.makerId, submittedAt: d.submittedAt,
    rejectReason: d.rejectReason, approvedAt: d.approvedAt,
    pendingChange: p ? { values: p.values as Values, status: p.status, makerId: p.makerId, at: p.at, reason: p.reason } : null,
    // what the signed-in user may do now (screens hide what they cannot do, GR-18)
    ...(ctx ? { mine: (p?.makerId ?? d.makerId) === ctx.userId } : {}),
  };
}

async function load(id: string) {
  const d = await Insurer.findById(id).lean<InsurerDoc>();
  if (!d) throw AppError.notFound();
  return d;
}

export async function list(q?: string, status?: string) {
  const f: Record<string, unknown> = { ownerAccountId: null }; // the SkyUp library: advisors' private insurers never show here
  if (status) f.status = status;
  if (q) f.$or = [{ name: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }, { shortCode: q.toUpperCase() }];
  return (await Insurer.find(f).sort({ name: 1 }).limit(500).lean<InsurerDoc[]>()).map((d) => view(d));
}
export async function get(ctx: AuthContext, id: string) { return view(await load(id), ctx); }

/** + Insurer: Save draft (CAT-01) or Submit for approval (CAT-02). */
export async function create(ctx: AuthContext, b: Values & { submit?: boolean }, req: Request) {
  if (b.submit) assertStepUp(req); // publishing directly needs the OTP (no admin approval)
  await assertUnique(b);
  let d;
  try {
    d = await Insurer.create({
      ...pick(b), nameKey: b.name.toLowerCase(), status: b.submit ? 'PENDING_APPROVAL' : 'DRAFT', makerId: ctx.userId, submittedAt: b.submit ? clock.now() : null,
    });
  } catch (e) { dupToField(e); }
  await audit({ entity: 'insurer', entityId: d!._id, action: b.submit ? 'INSURER_SUBMITTED' : 'INSURER_DRAFT_SAVED', after: pick(b) }, { req });
  if (b.submit) return publishNow(ctx, d!._id as string, req, true);
  return { insurer: view(d!.toObject() as InsurerDoc, ctx), messageId: 'CAT-01' as const, params: { Item: b.name } };
}

/**
 * Edit. A DRAFT is changed in place (and may be submitted). An ACTIVE or INACTIVE insurer gets a pending change
 * that waits for approval (P-20 step 4); a second one is refused with CAT-08. A PENDING_APPROVAL insurer cannot
 * be edited until it is decided (GEN-04).
 */
export async function edit(ctx: AuthContext, id: string, b: Partial<Values> & { version: number; submit?: boolean }, req: Request) {
  const d = await load(id);
  if (b.submit || (d.status !== 'DRAFT' && d.status !== 'PENDING_APPROVAL')) assertStepUp(req); // it goes live now
  const changes = pick(b as Record<string, unknown>);
  await assertUnique(changes, id);
  if (d.status === 'PENDING_APPROVAL') throw AppError.invalidState('insurer', 'PENDING APPROVAL');
  if (d.status === 'DRAFT') {
    let u;
    try {
      u = await Insurer.findOneAndUpdate({ _id: id, version: b.version, status: 'DRAFT' }, {
        $set: { ...changes, ...(changes.name ? { nameKey: changes.name.toLowerCase() } : {}), makerId: ctx.userId, rejectReason: null,
          ...(b.submit ? { status: 'PENDING_APPROVAL', submittedAt: clock.now() } : {}) },
        $inc: { version: 1 },
      }, { new: true }).lean<InsurerDoc>();
    } catch (e) { dupToField(e); }
    if (!u) throw AppError.versionConflict('insurer', view(await load(id), ctx));
    await audit({ entity: 'insurer', entityId: id, action: b.submit ? 'INSURER_SUBMITTED' : 'INSURER_DRAFT_SAVED', before: valuesOf(d), after: valuesOf(u) }, { req });
    if (b.submit) return publishNow(ctx, id, req, true);
    return { insurer: view(u, ctx), messageId: 'CAT-01' as const, params: { Item: u.name } };
  }
  if (d.pendingChange?.status === 'PENDING') throw new AppError(409, 'INVALID_STATE', 'CAT-08');
  const base = d.pendingChange?.status === 'REJECTED' ? (d.pendingChange.values as Values) : valuesOf(d); // a rejected change keeps its values
  const values = { ...base, ...changes };
  const u = await Insurer.findOneAndUpdate(
    { _id: id, version: b.version, 'pendingChange.status': { $ne: 'PENDING' } },
    { $set: { pendingChange: { values, status: 'PENDING', makerId: ctx.userId, at: clock.now(), reason: null } }, $inc: { version: 1 } },
    { new: true },
  ).lean<InsurerDoc>();
  if (!u) throw AppError.versionConflict('insurer', view(await load(id), ctx));
  await audit({ entity: 'insurer', entityId: id, action: 'INSURER_CHANGE_SUBMITTED', before: valuesOf(d), after: values }, { req });
  return publishNow(ctx, id, req, false);
}

/** Submit a DRAFT (or a rejected pending change) for approval. */
export async function submit(ctx: AuthContext, id: string, b: { version: number }, req: Request) {
  assertStepUp(req);
  const d = await load(id);
  let u: InsurerDoc | null = null;
  if (d.status === 'DRAFT') {
    u = await Insurer.findOneAndUpdate({ _id: id, version: b.version, status: 'DRAFT' }, { $set: { status: 'PENDING_APPROVAL', submittedAt: clock.now(), makerId: ctx.userId, rejectReason: null }, $inc: { version: 1 } }, { new: true }).lean<InsurerDoc>();
  } else if (d.pendingChange?.status === 'REJECTED') {
    u = await Insurer.findOneAndUpdate({ _id: id, version: b.version, 'pendingChange.status': 'REJECTED' }, { $set: { 'pendingChange.status': 'PENDING', 'pendingChange.makerId': ctx.userId, 'pendingChange.at': clock.now(), 'pendingChange.reason': null }, $inc: { version: 1 } }, { new: true }).lean<InsurerDoc>();
  } else throw AppError.invalidState('insurer', d.status.replace('_', ' '));
  if (!u) throw AppError.versionConflict('insurer', view(await load(id), ctx));
  await audit({ entity: 'insurer', entityId: id, action: 'INSURER_SUBMITTED' }, { req });
  return publishNow(ctx, id, req, d.status === 'DRAFT');
}

/**
 * Approve (P-20 step 3). The approver must not be the maker (CAT-05). Conditional on the version and on the item
 * still waiting, so when two approvers act at once the second gets GEN-04.
 */
export async function approve(ctx: AuthContext, id: string, b: { version: number }, req: Request, opts: { direct?: boolean } = {}) {
  const d = await load(id);
  const waitingNew = d.status === 'PENDING_APPROVAL';
  const waitingChange = d.pendingChange?.status === 'PENDING';
  if (!waitingNew && !waitingChange) throw AppError.invalidState('insurer', d.status.replace('_', ' '));
  const maker = waitingNew ? d.makerId : d.pendingChange!.makerId;
  if (maker === ctx.userId && !opts.direct) throw new AppError(403, 'FORBIDDEN', 'CAT-05'); // only for items left waiting from before
  const now = clock.now();
  let u: InsurerDoc | null;
  if (waitingNew) {
    u = await Insurer.findOneAndUpdate({ _id: id, version: b.version, status: 'PENDING_APPROVAL' }, { $set: { status: 'ACTIVE', approvedBy: ctx.userId, approvedAt: now }, $inc: { version: 1 } }, { new: true }).lean<InsurerDoc>();
  } else {
    const v = d.pendingChange!.values as Values;
    await assertUnique(v, id);
    try {
      u = await Insurer.findOneAndUpdate({ _id: id, version: b.version, 'pendingChange.status': 'PENDING' }, { $set: { ...pick(v as unknown as Record<string, unknown>), nameKey: v.name.toLowerCase(), pendingChange: null, approvedBy: ctx.userId, approvedAt: now }, $inc: { version: 1 } }, { new: true }).lean<InsurerDoc>();
    } catch (e) { dupToField(e); u = null; }
  }
  if (!u) {
    const cur = await load(id);
    if (cur.status !== 'PENDING_APPROVAL' && cur.pendingChange?.status !== 'PENDING') throw AppError.invalidState('insurer', cur.status.replace('_', ' ')); // GEN-04
    throw AppError.versionConflict('insurer', view(cur, ctx));
  }
  await useStepUp(req.stepUpId, 'CATALOGUE_APPROVED', null); // one OTP, one decision
  await audit({ entity: 'insurer', entityId: id, action: opts.direct ? (waitingNew ? 'INSURER_PUBLISHED' : 'INSURER_CHANGE_APPLIED') : (waitingNew ? 'INSURER_APPROVED' : 'INSURER_CHANGE_APPROVED'), before: valuesOf(d), after: valuesOf(u) }, { req });
  return { insurer: view(u, ctx), messageId: (opts.direct ? (waitingNew ? 'CAT-42' : 'CAT-43') : 'CAT-03') as 'CAT-03' | 'CAT-42' | 'CAT-43', params: { Item: u.name } };
}

/** Reject with a reason (CAT-04). A new insurer goes back to DRAFT; a change is kept as REJECTED. Values are kept. */
export async function reject(ctx: AuthContext, id: string, b: { version: number; reason: string }, req: Request) {
  const d = await load(id);
  const waitingNew = d.status === 'PENDING_APPROVAL';
  if (!waitingNew && d.pendingChange?.status !== 'PENDING') throw AppError.invalidState('insurer', d.status.replace('_', ' '));
  if ((waitingNew ? d.makerId : d.pendingChange!.makerId) === ctx.userId) throw new AppError(403, 'FORBIDDEN', 'CAT-05');
  const u = waitingNew
    ? await Insurer.findOneAndUpdate({ _id: id, version: b.version, status: 'PENDING_APPROVAL' }, { $set: { status: 'DRAFT', rejectReason: b.reason }, $inc: { version: 1 } }, { new: true }).lean<InsurerDoc>()
    : await Insurer.findOneAndUpdate({ _id: id, version: b.version, 'pendingChange.status': 'PENDING' }, { $set: { 'pendingChange.status': 'REJECTED', 'pendingChange.reason': b.reason }, $inc: { version: 1 } }, { new: true }).lean<InsurerDoc>();
  if (!u) throw AppError.invalidState('insurer', (await load(id)).status.replace('_', ' '));
  await useStepUp(req.stepUpId, 'CATALOGUE_REJECTED', null);
  await audit({ entity: 'insurer', entityId: id, action: waitingNew ? 'INSURER_REJECTED' : 'INSURER_CHANGE_REJECTED', after: { reason: b.reason } }, { req });
  return { insurer: view(u, ctx), messageId: 'CAT-04' as const, params: { Item: u.name, reason: b.reason } };
}

/** What deactivating would affect (CAT-09): products in the catalogue and advisors with an ACTIVE mapping. */
async function impact(id: string) {
  const products = mongoose.connection.db ? await mongoose.connection.db.collection('products').countDocuments({ insurerId: id }).catch(() => 0) : 0;
  const advisors = (await InsurerMapping.distinct('accountId', { insurerId: id, status: 'ACTIVE' })).length;
  return { products, advisors };
}

/**
 * Deactivate (ADM): CAT-09 shows the impact; on confirm the insurer becomes INACTIVE. Mappings, products,
 * quotations and policies are untouched; new quotations (P-27) and new mappings (P-07) are blocked.
 */
export async function setActive(ctx: AuthContext, id: string, b: { version: number; confirm?: string[]; reason?: string | null }, to: 'ACTIVE' | 'INACTIVE', req: Request) {
  const d = await load(id);
  const from = to === 'INACTIVE' ? 'ACTIVE' : 'INACTIVE';
  if (d.status !== from) throw AppError.invalidState('insurer', d.status.replace('_', ' '));
  if (to === 'INACTIVE' && !(b.confirm ?? []).includes('CAT-09')) {
    const i = await impact(id);
    const params = { name: d.name, n: i.products, m: i.advisors };
    throw new AppError(409, 'CONFIRMATION_REQUIRED', 'CAT-09', params, { warnings: [{ messageId: 'CAT-09', message: msg('CAT-09', params) }], impact: i });
  }
  const u = await Insurer.findOneAndUpdate({ _id: id, version: b.version, status: from }, { $set: { status: to, deactivatedReason: to === 'INACTIVE' ? b.reason ?? null : null }, $inc: { version: 1 } }, { new: true }).lean<InsurerDoc>();
  if (!u) throw AppError.versionConflict('insurer', view(await load(id), ctx));
  if (to === 'INACTIVE') await useStepUp(req.stepUpId, 'INSURER_DEACTIVATED', null);
  await audit({ entity: 'insurer', entityId: id, action: to === 'INACTIVE' ? 'INSURER_DEACTIVATED' : 'INSURER_ACTIVATED', before: { status: from }, after: { status: to, reason: b.reason ?? null }, stepUpId: to === 'INACTIVE' ? req.stepUpId : null }, { req });
  return view(u, ctx);
}

/** Approvals queue: catalogue items waiting for a decision, oldest first (Section 9). Types and products join later. */
export async function approvals(ctx: AuthContext) {
  const rows = await Insurer.find({ $or: [{ status: 'PENDING_APPROVAL' }, { 'pendingChange.status': 'PENDING' }] }).lean<InsurerDoc[]>();
  return rows.map((d) => {
    const isNew = d.status === 'PENDING_APPROVAL';
    const maker = isNew ? d.makerId : d.pendingChange!.makerId;
    return {
      kind: 'INSURER', id: d._id, name: isNew ? d.name : (d.pendingChange!.values as Values).name, what: isNew ? 'NEW' : 'CHANGE',
      at: isNew ? d.submittedAt : d.pendingChange!.at, makerId: maker, mine: maker === ctx.userId, version: d.version,
      ...(isNew ? {} : { current: valuesOf(d), proposed: d.pendingChange!.values }),
    };
  }).sort((a, b) => new Date(a.at ?? 0).getTime() - new Date(b.at ?? 0).getTime());
}

/**
 * No admin approval (client decision, OPEN-QUESTIONS Q92): what used to wait for a second admin is published now,
 * through the same checks and single update as approval, with the OTP and the actor in the audit log. If a publish
 * check fails, the item is not left waiting for an approval that no longer exists: a new insurer goes back to DRAFT
 * and a change is marked REJECTED, both with the reason, and the error is returned.
 */
async function publishNow(ctx: AuthContext, id: string, req: Request, isNew: boolean) {
  const cur = await load(id);
  try { return await approve(ctx, id, { version: cur.version }, req, { direct: true }); }
  catch (e) {
    const reason = (e as Error).message?.slice(0, 200) || 'Could not publish';
    if (isNew) await Insurer.updateOne({ _id: id, status: 'PENDING_APPROVAL' }, { $set: { status: 'DRAFT', rejectReason: reason }, $inc: { version: 1 } });
    else await Insurer.updateOne({ _id: id, 'pendingChange.status': 'PENDING' }, { $set: { 'pendingChange.status': 'REJECTED', 'pendingChange.reason': reason }, $inc: { version: 1 } });
    throw e;
  }
}