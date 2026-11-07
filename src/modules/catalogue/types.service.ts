import type { Request } from 'express';
import mongoose from 'mongoose';
import { cfgList } from '../../config/cfg.js';
import { clock } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { msg } from '../../lib/messages.js';
import { isDuplicateKey, withTx } from '../../lib/mongo.js';
import { Account } from '../accounts/account.model.js';
import { audit } from '../audit/audit.service.js';
import { useStepUp } from '../auth/stepUp.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { InsuranceType, TemplateVersion, type InsuranceTypeDoc, type TemplateDoc } from './types.model.js';

type Feature = { key?: string; name: string; group: string; dataType: string; requiredToPublish: boolean; order: number; help?: string | null };
type Factor = { key?: string; name: string; kind: 'BAND' | 'VALUE'; source: string; bands: Array<{ from: number; to: number }>; values: string[] };
type Question = { key?: string; label: string; dataType: string; required: boolean };
export interface TemplateBody { rev: number; features: Feature[]; factors: Factor[]; questions: Question[] }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'item';
/** Keys identify a feature or factor across versions; new rows get one from their name, kept unique in the list. */
function withKeys<T extends { key?: string; name?: string; label?: string }>(rows: T[]): Array<T & { key: string }> {
  const used = new Set<string>();
  return rows.map((r) => {
    let k = r.key || slug(r.name ?? r.label ?? '');
    for (let i = 2; used.has(k); i++) k = `${(r.key || slug(r.name ?? r.label ?? ''))}_${i}`;
    used.add(k);
    return { ...r, key: k };
  });
}

/** Starting types (CFG-115) exist from the first use; adding one later is + Type. */
export async function ensureStartingTypes() {
  for (const name of cfgList('CFG-115')) {
    await InsuranceType.updateOne({ nameKey: name.toLowerCase() }, { $setOnInsert: { name, nameKey: name.toLowerCase(), status: 'ACTIVE' } }, { upsert: true }).catch((e) => { if (!isDuplicateKey(e)) throw e; });
  }
}

const tplView = (t: TemplateDoc, ctx?: AuthContext) => ({
  id: t._id, typeId: t.typeId, number: t.number, status: t.status, features: t.features, factors: t.factors, questions: t.questions,
  makerId: t.makerId, submittedAt: t.submittedAt, rejectReason: t.rejectReason, approvedAt: t.approvedAt, rev: t.rev,
  ...(ctx ? { mine: t.makerId === ctx.userId } : {}),
});

export async function listTypes(ctx: AuthContext) {
  await ensureStartingTypes();
  const [types, tpls] = await Promise.all([
    InsuranceType.find({ ownerAccountId: null }).sort({ name: 1 }).lean<InsuranceTypeDoc[]>(), // SkyUp's categories only (change #4)
    TemplateVersion.find({ status: { $ne: 'RETIRED' } }, { features: 0, factors: 0, questions: 0 }).lean<TemplateDoc[]>(),
  ]);
  return types.map((t) => {
    const active = tpls.find((v) => v.typeId === t._id && v.status === 'ACTIVE');
    const open = tpls.find((v) => v.typeId === t._id && v.isOpen);
    return {
      id: t._id, name: t.name, status: t.status, version: t.version,
      activeTemplate: active ? { id: active._id, number: active.number } : null,
      openTemplate: open ? { id: open._id, number: open.number, status: open.status, mine: open.makerId === ctx.userId, rejectReason: open.rejectReason } : null,
    };
  });
}

export async function getTemplate(ctx: AuthContext, id: string) {
  const t = await TemplateVersion.findById(id).lean<TemplateDoc>();
  if (!t) throw AppError.notFound();
  return tplView(t, ctx);
}

/** + Type: the type (ACTIVE) and an empty DRAFT template (P-21 step 2). */
export async function createType(ctx: AuthContext, name: string, req: Request) {
  if (await InsuranceType.exists({ nameKey: name.toLowerCase(), ownerAccountId: null })) throw AppError.invalidState('insurance type', 'already in the catalogue');
  const t = await InsuranceType.create({ name, nameKey: name.toLowerCase() });
  const draft = await TemplateVersion.create({ typeId: t._id, number: 1, makerId: ctx.userId });
  await audit({ entity: 'insuranceType', entityId: t._id, action: 'INSURANCE_TYPE_CREATED', after: { name } }, { req });
  return { type: { id: t._id, name: t.name, status: t.status }, template: tplView(draft.toObject() as TemplateDoc, ctx) };
}

/** Edit template: a new DRAFT copied from the ACTIVE version. One open version per type (CAT-08). */
export async function startDraft(ctx: AuthContext, typeId: string, req: Request) {
  const type = await InsuranceType.findById(typeId).lean<InsuranceTypeDoc>();
  if (!type) throw AppError.notFound();
  if (await TemplateVersion.exists({ typeId, isOpen: true })) throw new AppError(409, 'INVALID_STATE', 'CAT-08');
  const [active, last] = await Promise.all([
    TemplateVersion.findOne({ typeId, status: 'ACTIVE' }).lean<TemplateDoc>(),
    TemplateVersion.findOne({ typeId }, { number: 1 }).sort({ number: -1 }).lean<{ number: number }>(),
  ]);
  try {
    const d = await TemplateVersion.create({
      typeId, number: (last?.number ?? 0) + 1, makerId: ctx.userId,
      features: active?.features ?? [], factors: active?.factors ?? [], questions: active?.questions ?? [],
    });
    await audit({ entity: 'templateVersion', entityId: d._id, action: 'TEMPLATE_DRAFT_STARTED', after: { typeId, number: d.number } }, { req });
    return tplView(d.toObject() as TemplateDoc, ctx);
  } catch (e) {
    if (isDuplicateKey(e)) throw new AppError(409, 'INVALID_STATE', 'CAT-08'); // two makers at once
    throw e;
  }
}

/** Save the table editor's rows to the DRAFT. Two makers editing one draft: the second gets GEN-05. */
export async function saveDraft(ctx: AuthContext, id: string, b: TemplateBody, req: Request) {
  const u = await TemplateVersion.findOneAndUpdate(
    { _id: id, status: 'DRAFT', rev: b.rev },
    { $set: {
      features: withKeys(b.features).map((f, i) => ({ ...f, order: f.order ?? i + 1, help: f.help ?? null })),
      factors: withKeys(b.factors).map((f) => ({ ...f, bands: f.kind === 'BAND' ? f.bands : [], values: f.kind === 'VALUE' ? f.values : [] })),
      questions: withKeys(b.questions.map((q) => ({ ...q, name: q.label }))).map(({ name: _n, ...q }) => q),
      makerId: ctx.userId, rejectReason: null,
    }, $inc: { rev: 1 } },
    { new: true },
  ).lean<TemplateDoc>();
  if (!u) {
    const cur = await TemplateVersion.findById(id).lean<TemplateDoc>();
    if (!cur) throw AppError.notFound();
    if (cur.status !== 'DRAFT') throw AppError.invalidState('template', cur.status.replace('_', ' '));
    throw AppError.versionConflict('template', tplView(cur, ctx));
  }
  await audit({ entity: 'templateVersion', entityId: id, action: 'TEMPLATE_DRAFT_SAVED', after: { features: u.features.length, factors: u.factors.length, questions: u.questions.length } }, { req });
  return tplView(u, ctx);
}

/**
 * Submit checks (P-21 step 3): at least one feature (CAT-12) and one rating factor (CAT-30); a band factor's
 * ranges must not be reversed, overlap or leave gaps (CAT-16, backend rule); a value factor needs values.
 */
export function submitProblems(t: Pick<TemplateDoc, 'features' | 'factors'>) {
  const problems: Array<{ field: string; messageId: 'CAT-12' | 'CAT-30' | 'CAT-16' | 'GEN-01'; params?: Record<string, string> }> = [];
  if (!t.features.length) problems.push({ field: 'features', messageId: 'CAT-12' });
  if (!t.factors.length) problems.push({ field: 'factors', messageId: 'CAT-30' });
  t.factors.forEach((f, i) => {
    if (f.kind === 'VALUE' && !f.values.length) problems.push({ field: `factors.${i}.values`, messageId: 'GEN-01', params: { 'Field label': `Values of ${f.name}` } });
    if (f.kind !== 'BAND') return;
    if (!f.bands.length) { problems.push({ field: `factors.${i}.bands`, messageId: 'GEN-01', params: { 'Field label': `Bands of ${f.name}` } }); return; }
    const bands = [...f.bands].map((b, j) => ({ ...b, j })).sort((a, b) => (a.from ?? 0) - (b.from ?? 0));
    bands.forEach((b, n) => {
      if ((b.from ?? 0) > (b.to ?? 0)) problems.push({ field: `factors.${i}.bands.${b.j}`, messageId: 'CAT-16' }); // reversed
      const prev = bands[n - 1];
      if (prev && (b.from ?? 0) !== (prev.to ?? 0) + 1) problems.push({ field: `factors.${i}.bands.${b.j}`, messageId: 'CAT-16' }); // overlap or gap
    });
  });
  return problems;
}

export async function submit(ctx: AuthContext, id: string, b: { rev: number }, req: Request) {
  const t = await TemplateVersion.findById(id).lean<TemplateDoc>();
  if (!t) throw AppError.notFound();
  if (t.status !== 'DRAFT') throw AppError.invalidState('template', t.status.replace('_', ' '));
  const problems = submitProblems(t);
  if (problems.length) throw AppError.fields(problems.map((p) => ({ field: p.field, messageId: p.messageId, message: msg(p.messageId, p.params ?? {}) })));
  const u = await TemplateVersion.findOneAndUpdate({ _id: id, status: 'DRAFT', rev: b.rev }, { $set: { status: 'PENDING_APPROVAL', submittedAt: clock.now(), makerId: ctx.userId }, $inc: { rev: 1 } }, { new: true }).lean<TemplateDoc>();
  if (!u) throw AppError.versionConflict('template', tplView(t, ctx));
  await audit({ entity: 'templateVersion', entityId: id, action: 'TEMPLATE_SUBMITTED' }, { req });
  // No admin approval (Q92): publish now through the approval step; a failure returns the version to DRAFT.
  try { return await approve(ctx, id, { rev: u.rev }, req, { direct: true }); }
  catch (e) { await TemplateVersion.updateOne({ _id: id, status: 'PENDING_APPROVAL' }, { $set: { status: 'DRAFT', rejectReason: (e as Error).message?.slice(0, 200) ?? null }, $inc: { rev: 1 } }); throw e; }
}

/**
 * Approve (P-21 step 4): a different ADM, with OTP. The version becomes ACTIVE and the earlier one RETIRED.
 * The first step claims the decision (conditional on PENDING and rev), so a second approver gets GEN-04.
 * Products keep their own version until their next edit (AC-P21-1).
 */
export async function approve(ctx: AuthContext, id: string, b: { rev: number }, req: Request, opts: { direct?: boolean } = {}) {
  const t = await TemplateVersion.findById(id).lean<TemplateDoc>();
  if (!t) throw AppError.notFound();
  if (t.status !== 'PENDING_APPROVAL') throw AppError.invalidState('template', t.status.replace('_', ' '));
  if (t.makerId === ctx.userId && !opts.direct) throw new AppError(403, 'FORBIDDEN', 'CAT-05'); // only items left waiting from before
  const now = clock.now();
  const out = await withTx(async (session) => {
    const claimed = await TemplateVersion.findOneAndUpdate({ _id: id, status: 'PENDING_APPROVAL', rev: b.rev }, { $set: { approvedBy: ctx.userId, approvedAt: now }, $inc: { rev: 1 } }, { new: true, session: session ?? undefined }).lean<TemplateDoc>();
    if (!claimed) throw AppError.invalidState('template', 'already decided'); // GEN-04
    await TemplateVersion.updateMany({ typeId: t.typeId, status: 'ACTIVE' }, { $set: { status: 'RETIRED', isOpen: null } }, { session: session ?? undefined });
    const live = await TemplateVersion.findOneAndUpdate({ _id: id }, { $set: { status: 'ACTIVE', isOpen: null } }, { new: true, session: session ?? undefined }).lean<TemplateDoc>();
    await audit({ entity: 'templateVersion', entityId: id, action: opts.direct ? 'TEMPLATE_PUBLISHED' : 'TEMPLATE_APPROVED', after: { typeId: t.typeId, number: t.number } }, { req, session });
    return live!;
  });
  await useStepUp(req.stepUpId, 'CATALOGUE_APPROVED', null);
  const type = await InsuranceType.findById(t.typeId, { name: 1 }).lean<{ name: string }>();
  return { template: tplView(out, ctx), params: { Item: `${type?.name} template version ${out.number}` } };
}

/** Reject with a reason: back to DRAFT for editing (P-21 failure and recovery). */
export async function reject(ctx: AuthContext, id: string, b: { rev: number; reason: string }, req: Request) {
  const t = await TemplateVersion.findById(id).lean<TemplateDoc>();
  if (!t) throw AppError.notFound();
  if (t.status !== 'PENDING_APPROVAL') throw AppError.invalidState('template', t.status.replace('_', ' '));
  if (t.makerId === ctx.userId) throw new AppError(403, 'FORBIDDEN', 'CAT-05');
  const u = await TemplateVersion.findOneAndUpdate({ _id: id, status: 'PENDING_APPROVAL', rev: b.rev }, { $set: { status: 'DRAFT', rejectReason: b.reason }, $inc: { rev: 1 } }, { new: true }).lean<TemplateDoc>();
  if (!u) throw AppError.invalidState('template', 'already decided');
  await useStepUp(req.stepUpId, 'CATALOGUE_REJECTED', null);
  await audit({ entity: 'templateVersion', entityId: id, action: 'TEMPLATE_REJECTED', after: { reason: b.reason } }, { req });
  const type = await InsuranceType.findById(t.typeId, { name: 1 }).lean<{ name: string }>();
  return { template: tplView(u, ctx), params: { Item: `${type?.name} template version ${u.number}`, reason: b.reason } };
}

/** Deactivate a type (ADM): impact like CAT-09; hides its products from new quotations only (AC-P21-3). */
export async function setTypeActive(ctx: AuthContext, id: string, b: { version: number; confirm?: string[] }, to: 'ACTIVE' | 'INACTIVE', req: Request) {
  const t = await InsuranceType.findById(id).lean<InsuranceTypeDoc>();
  if (!t) throw AppError.notFound();
  const from = to === 'INACTIVE' ? 'ACTIVE' : 'INACTIVE';
  if (t.status !== from) throw AppError.invalidState('insurance type', t.status);
  if (to === 'INACTIVE' && !(b.confirm ?? []).includes('CAT-09')) {
    const products = mongoose.connection.db ? await mongoose.connection.db.collection('products').countDocuments({ typeId: id }).catch(() => 0) : 0;
    const advisors = await Account.countDocuments({ 'profile.professional.categories': t.name });
    const params = { name: t.name, n: products, m: advisors };
    throw new AppError(409, 'CONFIRMATION_REQUIRED', 'CAT-09', params, { warnings: [{ messageId: 'CAT-09', message: msg('CAT-09', params) }], impact: { products, advisors } });
  }
  const u = await InsuranceType.findOneAndUpdate({ _id: id, version: b.version, status: from }, { $set: { status: to }, $inc: { version: 1 } }, { new: true }).lean<InsuranceTypeDoc>();
  if (!u) throw AppError.versionConflict('insurance type', null);
  await audit({ entity: 'insuranceType', entityId: id, action: to === 'INACTIVE' ? 'INSURANCE_TYPE_DEACTIVATED' : 'INSURANCE_TYPE_ACTIVATED', before: { status: from }, after: { status: to } }, { req });
  return { id: u._id, name: u.name, status: u.status, version: u.version };
}

// ── What an advisor needs to add an own product (P-22 step 2) ──
// Read-only views for the + My product form. They expose the types and the live template's FEATURES only:
// rating factors, quotation questions, drafts and who made them stay on the admin endpoints above.

/** Insurance types an own product can be built on: ACTIVE, with a live (ACTIVE) template. */
export async function ownProductTypes(accountId?: string | null) {
  const [types, live] = await Promise.all([
    // Change #4: SkyUp's categories and this account's private ones
    InsuranceType.find({ status: 'ACTIVE', ownerAccountId: { $in: [null, ...(accountId ? [accountId] : [])] } }, { name: 1, ownerAccountId: 1 }).sort({ name: 1 }).lean<Array<Pick<InsuranceTypeDoc, '_id' | 'name' | 'ownerAccountId'>>>(),
    TemplateVersion.find({ status: 'ACTIVE' }, { typeId: 1, number: 1 }).lean<Array<Pick<TemplateDoc, '_id' | 'typeId' | 'number'>>>(),
  ]);
  const byType = new Map(live.map((t) => [t.typeId, t]));
  return types.flatMap((t) => {
    const tpl = byType.get(t._id);
    return tpl ? [{ id: t._id, name: t.name, private: !!t.ownerAccountId, template: { id: tpl._id, number: tpl.number } }] : [];
  });
}

/** The live template's features for one type, in display order: the values an own product records. */
export async function liveFeatures(typeId: string, accountId?: string | null) {
  const type = await InsuranceType.findById(typeId, { name: 1, status: 1, ownerAccountId: 1 }).lean<Pick<InsuranceTypeDoc, '_id' | 'name' | 'status' | 'ownerAccountId'>>();
  // An advisor sees SkyUp's categories and their own; another account's private category does not exist for them
  if (!type || (accountId !== undefined && type.ownerAccountId && type.ownerAccountId !== accountId)) throw AppError.notFound();
  if (type.status !== 'ACTIVE') throw AppError.invalidState('insurance type', type.status);
  const tpl = await TemplateVersion.findOne({ typeId, status: 'ACTIVE' }, { number: 1, features: 1 }).lean<Pick<TemplateDoc, '_id' | 'number' | 'features'>>();
  if (!tpl) throw AppError.invalidState('insurance type', 'without a live template');
  const features = [...tpl.features]
    .sort((a, b) => a.order - b.order)
    .map((f) => ({ key: f.key, name: f.name, group: f.group, dataType: f.dataType, requiredToPublish: f.requiredToPublish, order: f.order, help: f.help ?? null }));
  return { typeId: type._id, typeName: type.name, private: !!type.ownerAccountId, template: { id: tpl._id, number: tpl.number }, features };
}

/** Approvals queue entries for templates. */
export async function templateApprovals(ctx: AuthContext) {
  const rows = await TemplateVersion.find({ status: 'PENDING_APPROVAL' }, { features: 0, factors: 0, questions: 0 }).lean<TemplateDoc[]>();
  const types = new Map((await InsuranceType.find({ _id: { $in: rows.map((r) => r.typeId) } }, { name: 1 }).lean<Array<{ _id: string; name: string }>>()).map((t) => [t._id, t.name]));
  return rows.map((r) => ({ kind: 'TEMPLATE' as const, id: r._id, name: `${types.get(r.typeId) ?? ''} template version ${r.number}`, what: 'NEW' as const, at: r.submittedAt, makerId: r.makerId, mine: r.makerId === ctx.userId, version: r.rev }));
}