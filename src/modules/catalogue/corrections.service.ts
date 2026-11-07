import { assertStepUp } from '../auth/stepUp.js';
import type { Request } from 'express';
import { Schema, model, type InferSchemaType } from 'mongoose';
import { clock } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { isDuplicateKey, withTx } from '../../lib/mongo.js';
import { audit } from '../audit/audit.service.js';
import { assertOwnFile } from '../files/files.service.js';
import { notify, notifySkyUp } from '../notifications/notifications.service.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { Product, ProductVersion, type ProductDoc, type ProductVersionDoc } from './product.model.js';
import { TemplateVersion, type TemplateDoc } from './types.model.js';

/**
 * P-58 corrections: an advisor proposes a value for one field of a verified product; SkyUp reviews. The advisor never
 * edits the shared record (AC-P58-1). Accept puts the value in a DRAFT version that still needs a different ADM's
 * approval (P-25), so advisors see it only after that (AC-P58-2). The version keeps the correction ID.
 */
const correctionSchema = new Schema(
  {
    _id: { type: String, default: () => newId('cor') },
    accountId: { type: String, required: true },
    userId: { type: String, required: true },
    productId: { type: String, required: true },
    versionId: { type: String, required: true }, // the published version it refers to
    field: { type: String, required: true }, // a top-level field or features.<key>
    currentValue: { type: Schema.Types.Mixed, default: null },
    proposedValue: { type: String, required: true },
    reason: { type: String, required: true },
    attachmentFileId: { type: String, default: null },
    status: { type: String, enum: ['SUBMITTED', 'ACCEPTED', 'REJECTED'], default: 'SUBMITTED' },
    reviewerId: { type: String, default: null },
    reviewedAt: { type: Date, default: null },
    rejectReason: { type: String, default: null },
    draftVersionId: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, minimize: false },
);
/** One open correction per field, per account and product (CAT-08). */
correctionSchema.index({ accountId: 1, productId: 1, field: 1 }, { unique: true, partialFilterExpression: { status: 'SUBMITTED' }, name: 'one_open_correction' });
type CorrectionDoc = InferSchemaType<typeof correctionSchema> & { _id: string; createdAt: Date };
export const Correction = model('Correction', correctionSchema, 'product_corrections');

/** Fields a correction may propose, with how the text is turned into a value. */
const NUMBER_FIELDS = ['adultMin', 'adultMax', 'childMin', 'childMax', 'taxPercent', 'gracePeriodDays', 'maxNominees'];
const TEXT_FIELDS = ['name', 'description', 'uin'];

async function published(productId: string) {
  const p = await Product.findOne({ _id: productId, kind: 'VERIFIED' }).lean<ProductDoc>();
  if (!p) throw AppError.notFound();
  const v = p.publishedVersionId ? await ProductVersion.findById(p.publishedVersionId).lean<ProductVersionDoc>() : null;
  if (!v) throw AppError.invalidState('product', 'not published');
  return { p, v };
}

/** The fields an advisor can correct on this product: the top-level ones and every template feature. */
export async function correctableFields(productId: string) {
  const { v } = await published(productId);
  const tpl = await TemplateVersion.findById(v.templateId, { features: 1 }).lean<TemplateDoc>();
  return [
    ...TEXT_FIELDS.map((f) => ({ field: f, label: f === 'uin' ? 'IRDAI product UIN' : f === 'name' ? 'Product name' : 'Short description' })),
    ...NUMBER_FIELDS.map((f) => ({ field: f, label: f })),
    ...(tpl?.features ?? []).map((f) => ({ field: `features.${f.key}`, label: f.name })),
  ];
}

function typed(field: string, text: string, tpl: TemplateDoc | null): unknown {
  if (NUMBER_FIELDS.includes(field)) { const n = Number(text.replace(/[₹,%\s]/g, '')); if (!Number.isFinite(n)) throw AppError.field('proposedValue', 'VAL-12', { min: 0, max: 'any' }); return n; }
  if (TEXT_FIELDS.includes(field)) return field === 'uin' ? text.trim().toUpperCase() : text.trim();
  const key = field.slice('features.'.length);
  const dt = tpl?.features.find((f) => f.key === key)?.dataType ?? 'Text';
  if (dt === 'Yes/No') return /^(yes|y|covered|true)$/i.test(text.trim());
  if (dt === 'Text') return text.trim();
  const n = Number(text.replace(/[₹,%\s]/g, ''));
  if (!Number.isFinite(n)) throw AppError.field('proposedValue', 'VAL-12', { min: 0, max: 'any' });
  return n;
}
const getAt = (data: Record<string, unknown>, field: string) => field.startsWith('features.') ? ((data.features as Record<string, unknown> | undefined)?.[field.slice(9)] ?? null) : (data[field] ?? null);

/** Suggest a correction (ADV): CAT-35. */
export async function suggest(ctx: AuthContext, productId: string, b: { field: string; proposedValue: string; reason: string; attachmentFileId?: string | null }, req: Request) {
  const { v } = await published(productId);
  if (!(await correctableFields(productId)).some((f) => f.field === b.field)) throw AppError.field('field', 'VAL-22');
  if (b.attachmentFileId) await assertOwnFile(ctx, b.attachmentFileId, 'BROCHURE', 'attachmentFileId');
  try {
    const c = await Correction.create({ accountId: ctx.accountId, userId: ctx.userId, productId, versionId: v._id, field: b.field, currentValue: getAt(v.data as Record<string, unknown>, b.field), proposedValue: b.proposedValue, reason: b.reason, attachmentFileId: b.attachmentFileId ?? null });
    await audit({ entity: 'correction', entityId: c._id, action: 'CORRECTION_SUBMITTED', after: { productId, field: b.field } }, { req });
    // Change #60 / §9.6: SkyUp is told a correction is waiting (once per correction)
    const pName = (v.data as { name?: string }).name ?? 'a product';
    await notifySkyUp({ kind: 'CORRECTION_SUBMITTED', messageId: 'DSH-27', params: { product: pName }, dedupeKey: `DSH-27|${c._id}`, link: { type: 'CORRECTION', id: c._id } }).catch(() => undefined);
    return view(c.toObject() as CorrectionDoc);
  } catch (e) {
    if (isDuplicateKey(e)) throw new AppError(409, 'INVALID_STATE', 'CAT-08');
    throw e;
  }
}

const view = (c: CorrectionDoc) => ({
  id: c._id, productId: c.productId, field: c.field, currentValue: c.currentValue, proposedValue: c.proposedValue, reason: c.reason,
  attachmentFileId: c.attachmentFileId, status: c.status, rejectReason: c.rejectReason, createdAt: c.createdAt, reviewedAt: c.reviewedAt,
});

export async function mine(ctx: AuthContext, productId: string) {
  return (await Correction.find({ accountId: ctx.accountId, productId }).sort({ createdAt: -1 }).lean<CorrectionDoc[]>()).map(view);
}

/** Admin → Approvals → Product corrections. */
export async function queue() {
  const rows = await Correction.find({ status: 'SUBMITTED' }).sort({ createdAt: 1 }).lean<CorrectionDoc[]>();
  const names = new Map((await Product.find({ _id: { $in: rows.map((r) => r.productId) } }, { name: 1, code: 1 }).lean<Array<{ _id: string; name: string | null; code: string }>>()).map((p) => [p._id, p.name ?? p.code]));
  return rows.map((r) => ({ ...view(r), product: names.get(r.productId) ?? '' }));
}

/**
 * Accept (STF or ADM): the value goes into the product's open DRAFT (a new one, copied from PUBLISHED, if there is
 * none). A version waiting for approval must be decided first (CAT-08). The advisor is told CAT-39.
 */
export async function accept(ctx: AuthContext, id: string, req: Request) {
  const c = await Correction.findById(id).lean<CorrectionDoc>();
  if (c && !(await ProductVersion.exists({ productId: c.productId, isOpen: true }))) assertStepUp(req); // it will be published now
  if (!c) throw AppError.notFound();
  if (c.status !== 'SUBMITTED') throw AppError.invalidState('correction', c.status);
  const { p, v: pub } = await published(c.productId);
  const openV = await ProductVersion.findOne({ productId: c.productId, isOpen: true }).lean<ProductVersionDoc>();
  if (openV && openV.status !== 'DRAFT') throw new AppError(409, 'INVALID_STATE', 'CAT-08');
  const tpl = await TemplateVersion.findById((openV ?? pub).templateId, { features: 1 }).lean<TemplateDoc>();
  const value = typed(c.field, c.proposedValue, tpl);
  const out = await withTx(async (session) => {
    const claimed = await Correction.findOneAndUpdate({ _id: id, status: 'SUBMITTED' }, { $set: { status: 'ACCEPTED', reviewerId: ctx.userId, reviewedAt: clock.now() } }, { new: true, session: session ?? undefined }).lean<CorrectionDoc>();
    if (!claimed) throw AppError.invalidState('correction', 'already decided');
    let draft = openV;
    if (!draft) {
      const last = await ProductVersion.findOne({ productId: c.productId }, { number: 1 }).sort({ number: -1 }).session(session).lean<{ number: number }>();
      const active = await TemplateVersion.findOne({ typeId: p.typeId, status: 'ACTIVE' }, { _id: 1 }).session(session).lean<{ _id: string }>();
      const [d] = await ProductVersion.create([{ productId: c.productId, number: (last?.number ?? 0) + 1, templateId: active?._id ?? pub.templateId, makerId: ctx.userId, data: pub.data ?? {} }], { session: session ?? undefined });
      draft = d!.toObject() as ProductVersionDoc;
    }
    const set = c.field.startsWith('features.')
      ? { [`data.features.${c.field.slice(9)}`]: { value } }
      : { [`data.${c.field}`]: value };
    await ProductVersion.updateOne({ _id: draft._id }, { $set: { ...set, makerId: ctx.userId }, $push: { corrections: { correctionId: id, field: c.field } }, $inc: { rev: 1 } }, { session: session ?? undefined });
    await Correction.updateOne({ _id: id }, { $set: { draftVersionId: draft._id } }, { session: session ?? undefined });
    await audit({ entity: 'correction', entityId: id, action: 'CORRECTION_ACCEPTED', after: { productId: c.productId, versionId: draft._id, field: c.field } }, { req, session });
    return draft;
  });
  // "Accept and publish" (no admin approval, Q92): a draft made just for this correction goes live now. A draft that was
  // already open may hold someone's unfinished edits, so the value waits there and goes live when that draft is published.
  let live = false;
  if (!openV) {
    const draft = (await ProductVersion.findById(out._id, { rev: 1 }).lean<{ rev: number }>())!;
    await (await import('./products.service.js')).adminSubmit(ctx, out._id as string, { rev: draft.rev }, req);
    live = true;
  }
  await notify({ userId: c.userId, accountId: c.accountId, kind: 'CORRECTION_ACCEPTED', messageId: live ? 'CAT-44' : 'CAT-39', params: { product: p.name ?? p.code }, dedupeKey: `CAT-39|${id}` });
  return { correction: view((await Correction.findById(id).lean<CorrectionDoc>())!), draftVersionId: out._id, published: live };
}

/** Reject with a reason (STF or ADM): the advisor is told CAT-40. */
export async function reject(ctx: AuthContext, id: string, reason: string, req: Request) {
  const u = await Correction.findOneAndUpdate({ _id: id, status: 'SUBMITTED' }, { $set: { status: 'REJECTED', rejectReason: reason, reviewerId: ctx.userId, reviewedAt: clock.now() } }, { new: true }).lean<CorrectionDoc>();
  if (!u) { const c = await Correction.findById(id).lean<CorrectionDoc>(); if (!c) throw AppError.notFound(); throw AppError.invalidState('correction', c.status); }
  const p = await Product.findById(u.productId, { name: 1, code: 1 }).lean<{ name: string | null; code: string }>();
  await audit({ entity: 'correction', entityId: id, action: 'CORRECTION_REJECTED', after: { reason } }, { req });
  await notify({ userId: u.userId, accountId: u.accountId, kind: 'CORRECTION_REJECTED', messageId: 'CAT-40', params: { product: p?.name ?? p?.code ?? '', reason }, dedupeKey: `CAT-40|${id}` });
  return view(u);
}