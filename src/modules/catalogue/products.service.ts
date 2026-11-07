import type { Request } from 'express';
import { cfgNum, cfgRange } from '../../config/cfg.js';
import { clock, istToday } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { isDuplicateKey, withTx } from '../../lib/mongo.js';
import { audit } from '../audit/audit.service.js';
import { useStepUp } from '../auth/stepUp.js';
import { assertOwnFile } from '../files/files.service.js';
import { Insurer, type InsurerDoc } from '../insurers/insurer.model.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { Commercial, Product, ProductVersion, type CommercialDoc, type ProductDoc, type ProductVersionDoc } from './product.model.js';
import { InsuranceType, TemplateVersion, type InsuranceTypeDoc, type TemplateDoc } from './types.model.js';
import { hasReference } from './prices.service.js';
import { ocrMarksFor } from './ocr.service.js';
import { assertVisibleInsurer, assertVisibleType } from './private.service.js';
import { ProductVariant, defaultVariantFor } from './variant.model.js';
import { InsurerMapping } from '../insurers/mapping.model.js';
import { asInput, checkVariants, copyVariants, missingOnVariants, normaliseCustomFeatures, variantsOf, writeVariants, type CustomFeature, type FeatureValue, type VariantInput } from './variants.service.js';

/** The product version's values (validated field by field on the route; completeness is checked on submit). */
export interface ProductData {
  name?: string; description?: string | null; uin?: string; launchDate?: string;
  adultMin?: number; adultMax?: number; coversChildren?: boolean; childMin?: number | null; childMax?: number | null;
  sumInsured?: { options?: number[]; min?: number | null; max?: number | null };
  policyTerms?: number[];
  features?: Record<string, { value?: string | number | boolean | null; page?: number | null; notStated?: boolean }>;
  addOns?: Array<{ name: string; description?: string | null; priceType: 'FIXED' | 'PERCENT'; value: number }>;
  pricingMode?: 'RATE_TABLE' | 'MANUAL_ENTRY'; taxPercent?: number;
  nomineeRequired?: boolean; maxNominees?: number; gracePeriodDays?: number | null;
  brochureFileId?: string | null; sourceLink?: string | null; sourceCheckedOn?: string | null;
  /** Change #5: features outside the template (the advisor's own, AI-suggested ones ticked to add, or SkyUp's). */
  customFeatures?: CustomFeature[];
}

const NOT_STATED = 'Not stated by insurer'; // AC-P22-5

/** Status shown now: an UPCOMING product becomes ACTIVE on its launch date (§4.3). */
export const effectiveStatus = (p: Pick<ProductDoc, 'status' | 'launchDate'>) =>
  p.status === 'UPCOMING' && p.launchDate && p.launchDate <= istToday() ? 'ACTIVE' : p.status;
const statusFor = (launch?: string | null) => (launch && launch > istToday() ? 'UPCOMING' : 'ACTIVE');

/** AC-P22-3: a child fits the child band; an adult fits the adult band. */
export function fitsEntryAge(d: ProductData, age: number, as: 'ADULT' | 'CHILD') {
  if (as === 'CHILD') {
    if (!d.coversChildren) return false;
    const band = cfgRange('CFG-153');
    return age >= (d.childMin ?? band.min) && age <= (d.childMax ?? band.max);
  }
  return age >= (d.adultMin ?? 0) && age <= (d.adultMax ?? -1);
}

async function activeTemplate(typeId: string) {
  return TemplateVersion.findOne({ typeId, status: 'ACTIVE' }).lean<TemplateDoc>();
}

/**
 * P-22 checks before save or submit. Field problems (CAT-33, CAT-16, CAT-34, CAT-15) are reported on their field;
 * everything else missing is listed in CAT-13. Verified products also need a source and, for RATE_TABLE, a price
 * version (P-24, Stage 4).
 */
export async function publishCheck(kind: 'VERIFIED' | 'OWN', insurerId: string, typeId: string, templateId: string, d: ProductData, productId?: string, variants: VariantInput[] = []) {
  if (!d.uin) throw AppError.field('uin', 'CAT-33'); // AC-P22-1
  const fields: Array<{ field: string; messageId: 'CAT-16' | 'CAT-34' | 'CAT-15' | 'CAT-48'; params?: Record<string, string | number> }> = [];
  const f = (field: string, id: 'CAT-16' | 'CAT-34' | 'CAT-15' | 'CAT-48', params: Record<string, string | number> = {}) => fields.push({ field, messageId: id, params });
  const missing: string[] = [];
  const [insurer, type, tpl, used] = await Promise.all([
    Insurer.findById(insurerId, { status: 1 }).lean<{ status: string }>(), InsuranceType.findById(typeId, { status: 1, ownerAccountId: 1 }).lean<{ status: string; ownerAccountId?: string | null }>(),
    activeTemplate(typeId), TemplateVersion.findById(templateId).lean<TemplateDoc>(),
  ]);
  if (insurer?.status !== 'ACTIVE') missing.push('an ACTIVE insurer');
  if (type?.status !== 'ACTIVE') missing.push('an ACTIVE insurance type');
  if (!tpl || tpl._id !== templateId) missing.push('the current feature template (CAT-28)');
  for (const [k, label] of [['name', 'product name'], ['launchDate', 'launch date'], ['pricingMode', 'pricing mode']] as const) if (!d[k]) missing.push(label);
  if (d.taxPercent === undefined || d.taxPercent === null) missing.push('tax %');
  if (d.adultMin === undefined || d.adultMax === undefined) missing.push('adult entry ages');
  else if (d.adultMin > d.adultMax) f('adultMax', 'CAT-16');
  if (d.coversChildren) {
    const band = cfgRange('CFG-153');
    const cmin = d.childMin ?? band.min; const cmax = d.childMax ?? band.max;
    if (cmin < 0 || (d.adultMax !== undefined && cmax > d.adultMax)) f('childMax', 'CAT-34');
    if (cmin > cmax) f('childMax', 'CAT-16');
  }
  const si = d.sumInsured ?? {};
  if (!(si.options?.length) && !(si.min && si.max)) missing.push('sum insured options or range');
  if (si.min && si.max && si.min > si.max) f('sumInsured.max', 'CAT-16');
  if (!d.policyTerms?.length) missing.push('policy term options');
  if ((d.addOns?.length ?? 0) > cfgNum('CFG-40')) f('addOns', 'CAT-15', { 'CFG-40': cfgNum('CFG-40') });
  for (const feat of (used ?? tpl)?.features ?? []) {
    if (!feat.requiredToPublish) continue;
    const v = d.features?.[feat.key];
    if (!v || (!v.notStated && (v.value === undefined || v.value === null || v.value === ''))) missing.push(`a value for ${feat.name}`);
  }
  // Change #4: a private category has no rating factors, so no rate table (Q4 default)
  if (type?.ownerAccountId && d.pricingMode === 'RATE_TABLE') f('pricingMode', 'CAT-48');
  // Changes #2, #5: variants and own features
  const custom = d.customFeatures ?? [];
  checkVariants(variants, d.sumInsured, new Set([...((used ?? tpl)?.features ?? []).map((x) => x.key), ...custom.map((c) => c.key!)]));
  missing.push(...missingOnVariants(variants, ((used ?? tpl)?.features ?? []).filter((x) => x.requiredToPublish), (d.features ?? {}) as Record<string, FeatureValue>));
  if (kind === 'VERIFIED') {
    if (!d.brochureFileId && !(d.sourceLink && d.sourceCheckedOn)) missing.push('the insurer page link and the date it was checked');
    if (d.pricingMode === 'RATE_TABLE' && !(productId && (await hasReference(productId)))) missing.push('a SkyUp reference price version (P-24)');
  }
  if (fields.length) throw AppError.fields(fields);
  if (missing.length) throw new AppError(400, 'VALIDATION_FAILED', 'CAT-13', { list: missing.join(', ') }, { missing });
}

const versionView = (v: ProductVersionDoc) => ({
  id: v._id, productId: v.productId, number: v.number, status: v.status, templateId: v.templateId, data: (v.data ?? {}) as ProductData,
  makerId: v.makerId, submittedAt: v.submittedAt, rejectReason: v.rejectReason, approvedAt: v.approvedAt, publishedAt: v.publishedAt, rev: v.rev,
});

async function names(insurerIds: string[], typeIds: string[]) {
  const [ins, typ] = await Promise.all([
    Insurer.find({ _id: { $in: insurerIds } }, { name: 1, status: 1 }).lean<Array<Pick<InsurerDoc, '_id' | 'name' | 'status'>>>(),
    InsuranceType.find({ _id: { $in: typeIds } }, { name: 1, status: 1 }).lean<Array<Pick<InsuranceTypeDoc, '_id' | 'name' | 'status'>>>(),
  ]);
  return { ins: new Map(ins.map((i) => [i._id, i])), typ: new Map(typ.map((t) => [t._id, t])) };
}

// ── Verified products: SkyUp makes, a different ADM approves (P-22 step 1, P-25) ──

export async function adminList(q?: string) {
  const f: Record<string, unknown> = { kind: 'VERIFIED' };
  if (q) f.$or = [{ name: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }, { code: q.toUpperCase() }];
  const rows = await Product.find(f).sort({ updatedAt: -1 }).limit(500).lean<ProductDoc[]>();
  const open = await ProductVersion.find({ productId: { $in: rows.map((r) => r._id) }, isOpen: true }, { productId: 1, status: 1, number: 1, data: 1 }).lean<ProductVersionDoc[]>();
  const n = await names(rows.map((r) => r.insurerId), rows.map((r) => r.typeId));
  return rows.map((p) => {
    const o = open.find((x) => x.productId === p._id);
    return {
      id: p._id, code: p.code, name: p.name ?? (o?.data as ProductData | undefined)?.name ?? null, status: effectiveStatus(p), version: p.version,
      insurer: n.ins.get(p.insurerId)?.name ?? null, type: n.typ.get(p.typeId)?.name ?? null,
      openVersion: o ? { id: o._id, number: o.number, status: o.status } : null,
    };
  });
}

export async function adminGet(id: string) {
  const p = await Product.findOne({ _id: id, kind: 'VERIFIED' }).lean<ProductDoc>();
  if (!p) throw AppError.notFound();
  const versions = await ProductVersion.find({ productId: id }).sort({ number: -1 }).lean<ProductVersionDoc[]>();
  const n = await names([p.insurerId], [p.typeId]);
  const tpl = await activeTemplate(p.typeId);
  return {
    id: p._id, code: p.code, status: effectiveStatus(p), version: p.version, withdrawnReason: p.withdrawnReason,
    insurer: { id: p.insurerId, name: n.ins.get(p.insurerId)?.name }, type: { id: p.typeId, name: n.typ.get(p.typeId)?.name },
    currentTemplateId: tpl?._id ?? null,
    versions: await Promise.all(versions.map(async (v) => ({ ...versionView(v), variants: await variantsOf(v._id) }))), // change #2
  };
}

/** + Product: the product and its first DRAFT version, on the type's ACTIVE template. */
export async function adminCreate(ctx: AuthContext, b: { insurerId: string; typeId: string; code: string }, req: Request) {
  const [ins, type, tpl] = await Promise.all([Insurer.findById(b.insurerId).lean<InsurerDoc>(), InsuranceType.findById(b.typeId).lean<InsuranceTypeDoc>(), activeTemplate(b.typeId)]);
  // A verified product uses the SkyUp library only: never an advisor's private insurer or category (changes #3, #4)
  if (ins?.status !== 'ACTIVE' || ins.ownerAccountId) throw AppError.field('insurerId', 'VAL-22');
  if (type?.status !== 'ACTIVE' || type.ownerAccountId || !tpl) throw AppError.field('typeId', 'VAL-22');
  try {
    const out = await withTx(async (session) => {
      const [p] = await Product.create([{ kind: 'VERIFIED', insurerId: b.insurerId, typeId: b.typeId, code: b.code, makerId: ctx.userId }], { session: session ?? undefined });
      const [v] = await ProductVersion.create([{ productId: p!._id, number: 1, templateId: tpl._id, makerId: ctx.userId, data: {} }], { session: session ?? undefined });
      await audit({ entity: 'product', entityId: p!._id, action: 'PRODUCT_CREATED', after: { insurerId: b.insurerId, typeId: b.typeId, code: b.code } }, { req, session });
      return { p: p!, v: v! };
    });
    return { productId: out.p._id, version: versionView(out.v.toObject() as ProductVersionDoc) };
  } catch (e) {
    if (isDuplicateKey(e, 'verified_code_per_insurer')) throw AppError.field('code', 'CAT-07');
    throw e;
  }
}

/** Edit: a new DRAFT copied from the PUBLISHED version (CAT-27); one open version at a time (CAT-08). */
export async function adminStartEdit(ctx: AuthContext, id: string, req: Request) {
  const p = await Product.findOne({ _id: id, kind: 'VERIFIED' }).lean<ProductDoc>();
  if (!p) throw AppError.notFound();
  if (await ProductVersion.exists({ productId: id, isOpen: true })) throw new AppError(409, 'INVALID_STATE', 'CAT-08');
  const [pub, last, tpl] = await Promise.all([
    ProductVersion.findOne({ productId: id, status: 'PUBLISHED' }).lean<ProductVersionDoc>(),
    ProductVersion.findOne({ productId: id }, { number: 1 }).sort({ number: -1 }).lean<{ number: number }>(),
    activeTemplate(p.typeId),
  ]);
  try {
    const v = await ProductVersion.create({ productId: id, number: (last?.number ?? 0) + 1, templateId: tpl?._id ?? pub?.templateId, makerId: ctx.userId, data: pub?.data ?? {} });
    if (pub) await copyVariants(pub._id, v._id); // change #2: the draft starts with the live variants
    await audit({ entity: 'product', entityId: id, action: 'PRODUCT_DRAFT_STARTED', after: { number: v.number } }, { req });
    return { version: versionView(v.toObject() as ProductVersionDoc), messageId: 'CAT-27' as const };
  } catch (e) {
    if (isDuplicateKey(e)) throw new AppError(409, 'INVALID_STATE', 'CAT-08');
    throw e;
  }
}

/** Save the DRAFT's values; two tabs: GEN-05. A draft verified product is never visible to advisors. */
export async function adminSaveDraft(ctx: AuthContext, vid: string, b: { rev: number; data: ProductData }, req: Request) {
  if ((b.data.addOns?.length ?? 0) > cfgNum('CFG-40')) throw AppError.field('addOns', 'CAT-15', { 'CFG-40': cfgNum('CFG-40') });
  if (b.data.customFeatures) b.data.customFeatures = normaliseCustomFeatures(b.data.customFeatures, 'SKYUP');
  const u = await ProductVersion.findOneAndUpdate({ _id: vid, status: 'DRAFT', rev: b.rev }, { $set: { data: b.data, makerId: ctx.userId, rejectReason: null }, $inc: { rev: 1 } }, { new: true }).lean<ProductVersionDoc>();
  if (!u) {
    const cur = await ProductVersion.findById(vid).lean<ProductVersionDoc>();
    if (!cur) throw AppError.notFound();
    if (cur.status !== 'DRAFT') throw AppError.invalidState('product version', cur.status.replace('_', ' '));
    throw AppError.versionConflict('product version', versionView(cur));
  }
  await audit({ entity: 'productVersion', entityId: vid, action: 'PRODUCT_DRAFT_SAVED' }, { req });
  return versionView(u);
}

/** Update the draft to the CURRENT template (CAT-28): values of features that still exist are kept. */
export async function adminUseCurrentTemplate(ctx: AuthContext, vid: string, b: { rev: number }, req: Request) {
  const v = await ProductVersion.findById(vid).lean<ProductVersionDoc>();
  if (!v) throw AppError.notFound();
  const p = await Product.findById(v.productId).lean<ProductDoc>();
  const tpl = p ? await activeTemplate(p.typeId) : null;
  if (!tpl) throw AppError.invalidState('insurance type', 'without a live template');
  const keep = new Set(tpl.features.map((f) => f.key));
  const data = { ...(v.data as ProductData) };
  data.features = Object.fromEntries(Object.entries(data.features ?? {}).filter(([k]) => keep.has(k)));
  const u = await ProductVersion.findOneAndUpdate({ _id: vid, status: 'DRAFT', rev: b.rev }, { $set: { templateId: tpl._id, data }, $inc: { rev: 1 } }, { new: true }).lean<ProductVersionDoc>();
  if (!u) throw AppError.versionConflict('product version', null);
  await audit({ entity: 'productVersion', entityId: vid, action: 'PRODUCT_TEMPLATE_UPDATED', after: { templateId: tpl._id } }, { req });
  return versionView(u);
}

/** Change #2: a SkyUp draft's variants, replaced as a set (rev-checked with the draft, so two tabs get GEN-05). */
export async function adminSaveVariants(ctx: AuthContext, vid: string, b: { rev: number; variants: VariantInput[] }, req: Request) {
  const v = await ProductVersion.findById(vid).lean<ProductVersionDoc>();
  if (!v) throw AppError.notFound();
  if (v.status !== 'DRAFT') throw AppError.invalidState('product version', v.status.replace('_', ' '));
  const tpl = await TemplateVersion.findById(v.templateId, { features: 1 }).lean<TemplateDoc>();
  const d = (v.data ?? {}) as ProductData;
  checkVariants(b.variants, d.sumInsured, new Set([...(tpl?.features ?? []).map((f) => f.key), ...(d.customFeatures ?? []).map((c) => c.key!)]));
  const u = await withTx(async (session) => {
    const claimed = await ProductVersion.findOneAndUpdate({ _id: vid, status: 'DRAFT', rev: b.rev }, { $inc: { rev: 1 } }, { new: true, session: session ?? undefined }).lean<ProductVersionDoc>();
    if (!claimed) throw AppError.versionConflict('product version', versionView(v));
    await writeVariants(v.productId, vid, d, b.variants, session);
    await audit({ entity: 'productVersion', entityId: vid, action: 'PRODUCT_VARIANTS_SAVED', after: { variants: b.variants.map((x) => x.name) } }, { req, session });
    return claimed;
  });
  return { ...versionView(u), variants: await variantsOf(vid) };
}

async function productItem(v: ProductVersionDoc) {
  const p = await Product.findById(v.productId).lean<ProductDoc>();
  return `${(v.data as ProductData).name ?? p?.code ?? 'Product'} version ${v.number}`;
}

export async function adminSubmit(ctx: AuthContext, vid: string, b: { rev: number }, req: Request) {
  const v = await ProductVersion.findById(vid).lean<ProductVersionDoc>();
  if (!v) throw AppError.notFound();
  if (v.status !== 'DRAFT') throw AppError.invalidState('product version', v.status.replace('_', ' '));
  const p = await Product.findById(v.productId).lean<ProductDoc>();
  const drafted = (await ProductVariant.find({ productVersionId: vid }).sort({ position: 1 }).lean()).map(asInput);
  await publishCheck('VERIFIED', p!.insurerId, p!.typeId, v.templateId, v.data as ProductData, p!._id, drafted);
  const u = await ProductVersion.findOneAndUpdate({ _id: vid, status: 'DRAFT', rev: b.rev }, { $set: { status: 'PENDING_APPROVAL', submittedAt: clock.now(), makerId: ctx.userId }, $inc: { rev: 1 } }, { new: true }).lean<ProductVersionDoc>();
  if (!u) throw AppError.versionConflict('product version', versionView(v));
  await audit({ entity: 'productVersion', entityId: vid, action: 'PRODUCT_SUBMITTED' }, { req });
  // No admin approval (Q92): publish now through the approval step; a failure returns the version to DRAFT.
  try { return await adminApprove(ctx, vid, { rev: u.rev }, req, { direct: true }); }
  catch (e) { await ProductVersion.updateOne({ _id: vid, status: 'PENDING_APPROVAL' }, { $set: { status: 'DRAFT', rejectReason: (e as Error).message?.slice(0, 200) ?? null }, $inc: { rev: 1 } }); throw e; }
}

/**
 * Approve (P-25 step 3): ADM, not the maker (AC-P25-1), with the OTP (AC-P25-2, on the route). If the version
 * changed after it was opened: CAT-29. One transaction: this version PUBLISHED, the old one SUPERSEDED, the
 * product available; the approver, time and OTP verification ID are stored.
 */
export async function adminApprove(ctx: AuthContext, vid: string, b: { rev: number }, req: Request, opts: { direct?: boolean } = {}) {
  const v = await ProductVersion.findById(vid).lean<ProductVersionDoc>();
  if (!v) throw AppError.notFound();
  if (v.status !== 'PENDING_APPROVAL') throw AppError.invalidState('product version', v.status.replace('_', ' '));
  if (v.makerId === ctx.userId && !opts.direct) throw new AppError(403, 'FORBIDDEN', 'CAT-05'); // only items left waiting from before
  if (v.rev !== b.rev) throw new AppError(409, 'VERSION_CONFLICT', 'CAT-29');
  const now = clock.now();
  const out = await withTx(async (session) => {
    const claimed = await ProductVersion.findOneAndUpdate({ _id: vid, status: 'PENDING_APPROVAL', rev: b.rev }, { $set: { approvedBy: ctx.userId, approvedAt: now, approvalStepUpId: req.stepUpId ?? null }, $inc: { rev: 1 } }, { new: true, session: session ?? undefined }).lean<ProductVersionDoc>();
    if (!claimed) throw AppError.invalidState('product version', 'already decided'); // GEN-04
    await ProductVersion.updateMany({ productId: v.productId, status: 'PUBLISHED' }, { $set: { status: 'SUPERSEDED' } }, { session: session ?? undefined });
    const pub = await ProductVersion.findOneAndUpdate({ _id: vid }, { $set: { status: 'PUBLISHED', isOpen: null, publishedAt: now } }, { new: true, session: session ?? undefined }).lean<ProductVersionDoc>();
    if (!(await ProductVariant.exists({ productVersionId: vid }).session(session))) await writeVariants(v.productId, vid, pub!.data as ProductData, [], session); // a published version always has a default variant
    const d = pub!.data as ProductData;
    const prod = await Product.findById(v.productId).session(session).lean<ProductDoc>();
    await Product.updateOne({ _id: v.productId }, { $set: {
      publishedVersionId: vid, name: d.name ?? null, launchDate: d.launchDate ?? null,
      status: prod?.status === 'WITHDRAWN' ? 'WITHDRAWN' : statusFor(d.launchDate),
    }, $inc: { version: 1 } }, { session: session ?? undefined });
    await audit({ entity: 'productVersion', entityId: vid, action: 'PRODUCT_PUBLISHED', after: { productId: v.productId, number: v.number, stepUpId: req.stepUpId ?? null } }, { req, session });
    return pub!;
  });
  await useStepUp(req.stepUpId, 'CATALOGUE_APPROVED', null);
  if (v.number === 1) await announcePublished(v.productId); // change #23: a new verified product, not a new version
  return { version: versionView(out), params: { Item: await productItem(out) } };
}

export async function adminReject(ctx: AuthContext, vid: string, b: { rev: number; reason: string }, req: Request) {
  const v = await ProductVersion.findById(vid).lean<ProductVersionDoc>();
  if (!v) throw AppError.notFound();
  if (v.status !== 'PENDING_APPROVAL') throw AppError.invalidState('product version', v.status.replace('_', ' '));
  if (v.makerId === ctx.userId) throw new AppError(403, 'FORBIDDEN', 'CAT-05');
  const u = await ProductVersion.findOneAndUpdate({ _id: vid, status: 'PENDING_APPROVAL', rev: b.rev }, { $set: { status: 'DRAFT', rejectReason: b.reason }, $inc: { rev: 1 } }, { new: true }).lean<ProductVersionDoc>();
  if (!u) throw AppError.invalidState('product version', 'already decided');
  await useStepUp(req.stepUpId, 'CATALOGUE_REJECTED', null);
  await audit({ entity: 'productVersion', entityId: vid, action: 'PRODUCT_REJECTED', after: { reason: b.reason } }, { req });
  return { version: versionView(u), params: { Item: await productItem(u), reason: b.reason } };
}

/** Withdraw (ADM, reason required) → WITHDRAWN (CAT-26); Make available reverses it (P-25 step 4). */
export async function adminWithdraw(ctx: AuthContext, id: string, b: { version: number; reason?: string }, to: 'WITHDRAWN' | 'AVAILABLE', req: Request) {
  const p = await Product.findOne({ _id: id, kind: 'VERIFIED' }).lean<ProductDoc>();
  if (!p) throw AppError.notFound();
  if (p.status === 'NOT_PUBLISHED') throw AppError.invalidState('product', 'not published');
  if ((to === 'WITHDRAWN') === (p.status === 'WITHDRAWN')) throw AppError.invalidState('product', effectiveStatus(p));
  const status = to === 'WITHDRAWN' ? 'WITHDRAWN' : statusFor(p.launchDate);
  const u = await Product.findOneAndUpdate({ _id: id, version: b.version }, { $set: { status, withdrawnReason: to === 'WITHDRAWN' ? b.reason : null }, $inc: { version: 1 } }, { new: true }).lean<ProductDoc>();
  if (!u) throw AppError.versionConflict('product', null);
  if (to === 'WITHDRAWN') await useStepUp(req.stepUpId, 'PRODUCT_WITHDRAWN', null);
  await audit({ entity: 'product', entityId: id, action: to === 'WITHDRAWN' ? 'PRODUCT_WITHDRAWN' : 'PRODUCT_MADE_AVAILABLE', before: { status: p.status }, after: { status, reason: b.reason ?? null }, stepUpId: to === 'WITHDRAWN' ? req.stepUpId : null }, { req });
  return { id: u._id, status: effectiveStatus(u), version: u.version, name: u.name };
}

/** Approvals queue entries: pending product versions with a field-by-field comparison (P-25 step 2). */
export async function productApprovals(ctx: AuthContext) {
  const rows = await ProductVersion.find({ status: 'PENDING_APPROVAL' }).lean<ProductVersionDoc[]>();
  const pubs = await ProductVersion.find({ productId: { $in: rows.map((r) => r.productId) }, status: 'PUBLISHED' }).lean<ProductVersionDoc[]>();
  return rows.map((r) => {
    const pub = pubs.find((x) => x.productId === r.productId);
    const before = (pub?.data ?? {}) as Record<string, unknown>; const after = r.data as Record<string, unknown>;
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null));
    return {
      kind: 'PRODUCT' as const, id: r._id, name: `${(r.data as ProductData).name ?? 'Product'} version ${r.number}`, what: (pub ? 'CHANGE' : 'NEW') as 'CHANGE' | 'NEW',
      at: r.submittedAt, makerId: r.makerId, mine: r.makerId === ctx.userId, version: r.rev,
      changes: changed.map((k) => ({ field: k, before: before[k] ?? null, after: after[k] ?? null })),
    };
  });
}

// ── What advisors see (verified and the account's own) ──

/** Feature values as advisors see them: "Not stated in source" shows as "Not stated by insurer" (AC-P22-5). */
function advisorData(d: ProductData) {
  const features = Object.fromEntries(Object.entries(d.features ?? {}).map(([k, v]) => [k, v.notStated ? { value: NOT_STATED, page: null } : { value: v.value ?? null, page: v.page ?? null }]));
  return { ...d, features };
}

export async function advisorList(ctx: AuthContext, opts: { typeId?: string; quotableOnly?: boolean }) {
  const f: Record<string, unknown> = { $or: [{ kind: 'VERIFIED', status: { $ne: 'NOT_PUBLISHED' } }, { kind: 'OWN', accountId: ctx.accountId }] };
  if (opts.typeId) f.typeId = opts.typeId;
  const rows = await Product.find(f).sort({ name: 1 }).limit(1000).lean<ProductDoc[]>();
  const n = await names(rows.map((r) => r.insurerId), rows.map((r) => r.typeId));
  // Gap fix (10 · Products library): variants on each card, and whether *this advisor* can quote it (agent code).
  const [variantRows, maps] = await Promise.all([
    ProductVariant.find({ productVersionId: { $in: rows.map((r) => r.publishedVersionId).filter(Boolean) } }, { productVersionId: 1, name: 1, position: 1, isDefault: 1 }).sort({ position: 1 }).lean<Array<{ productVersionId: string; name: string; isDefault?: boolean }>>(),
    InsurerMapping.find({ accountId: ctx.accountId }, { insurerId: 1, status: 1, validUntil: 1 }).lean<Array<{ insurerId: string; status: string; validUntil: string | null }>>(),
  ]);
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const codeOf = new Map(maps.map((m) => [m.insurerId, m.status !== 'ACTIVE' ? 'INACTIVE' : m.validUntil && m.validUntil < today ? 'EXPIRED' : 'ACTIVE']));
  const out = rows.map((p) => {
    const status = effectiveStatus(p);
    const ins = n.ins.get(p.insurerId); const typ = n.typ.get(p.typeId);
    const quotable = status === 'ACTIVE' && ins?.status === 'ACTIVE' && typ?.status === 'ACTIVE';
    const vs = variantRows.filter((v) => v.productVersionId === p.publishedVersionId);
    const agentCode = codeOf.get(p.insurerId) ?? 'MISSING';
    return {
      id: p._id, kind: p.kind, code: p.code, name: p.name, status, insurerId: p.insurerId, typeId: p.typeId, insurer: ins?.name ?? null, type: typ?.name ?? null, quotable, renewalOnly: status === 'WITHDRAWN',
      variantCount: vs.length, defaultVariant: (vs.find((v) => v.isDefault) ?? vs[0])?.name ?? null, variants: vs.map((v) => v.name),
      agentCode, canQuote: quotable && agentCode === 'ACTIVE',
    };
  });
  return opts.quotableOnly ? out.filter((p) => p.quotable) : out; // AC-P22-4 / AC-P25-4
}

export async function advisorGet(ctx: AuthContext, id: string) {
  const p = await Product.findOne({ _id: id, $or: [{ kind: 'VERIFIED', status: { $ne: 'NOT_PUBLISHED' } }, { kind: 'OWN', accountId: ctx.accountId }] }).lean<ProductDoc>();
  if (!p) throw AppError.notFound(); // another account's own product, or an unpublished draft
  const v = await ProductVersion.findById(p.publishedVersionId).lean<ProductVersionDoc>();
  const n = await names([p.insurerId], [p.typeId]);
  const tpl = v ? await TemplateVersion.findById(v.templateId, { features: 1 }).lean<TemplateDoc>() : null;
  if (v) await defaultVariantFor(v as never); // versions from before variants get their default on first read (Stage B)
  const d = (v?.data ?? {}) as ProductData;
  const shown = (x: FeatureValue): FeatureValue => (x?.notStated ? { value: NOT_STATED, page: null } : x);
  return {
    id: p._id, kind: p.kind, code: p.code, status: effectiveStatus(p), version: p.version, insurerId: p.insurerId, typeId: p.typeId,
    variants: v ? await variantsOf(v._id, (d.features ?? {}) as Record<string, FeatureValue>, shown) : [], // change #2
    customFeatures: d.customFeatures ?? [], // change #5
    insurer: n.ins.get(p.insurerId)?.name ?? null, type: n.typ.get(p.typeId)?.name ?? null,
    publishedVersion: v ? {
      id: v._id, number: v.number, templateId: v.templateId, data: advisorData((v.data ?? {}) as ProductData),
      // Own products only: the values as the owner typed them, to edit from. `data` shows "Not stated by insurer" as
      // text (AC-P22-5); saving that back would store the text as the value.
      ...(p.kind === 'OWN' ? { entered: (v.data ?? {}) as ProductData } : {}),
    } : null,
    features: tpl?.features ?? [],
  };
}

// ── Own products (ADV): publish at once in this account (P-22 step 2) ──

export async function ownCreate(ctx: AuthContext, b: { insurerId: string; typeId: string; code: string; data: ProductData; variants?: VariantInput[]; ocrJobId?: string | null }, req: Request) {
  // Changes #3, #4: the library or this account's private insurer and category; nothing of another account's
  await assertVisibleInsurer(ctx.accountId, b.insurerId);
  await assertVisibleType(ctx.accountId, b.typeId);
  const tpl = await activeTemplate(b.typeId);
  if (!tpl) throw AppError.field('typeId', 'VAL-22');
  if (b.data.customFeatures) b.data.customFeatures = normaliseCustomFeatures(b.data.customFeatures, 'ADVISOR');
  await publishCheck('OWN', b.insurerId, b.typeId, tpl._id, b.data, undefined, b.variants ?? []);
  const marks = b.ocrJobId ? await ocrMarksFor(ctx, b.ocrJobId, b.typeId) : {};
  if (b.data.brochureFileId) await assertOwnFile(ctx, b.data.brochureFileId, 'BROCHURE', 'brochureFileId');
  try {
    const out = await withTx(async (session) => {
      const now = clock.now();
      const [p] = await Product.create([{ kind: 'OWN', accountId: ctx.accountId, insurerId: b.insurerId, typeId: b.typeId, code: b.code, makerId: ctx.userId, status: statusFor(b.data.launchDate), name: b.data.name, launchDate: b.data.launchDate }], { session: session ?? undefined });
      const [v] = await ProductVersion.create([{ productId: p!._id, number: 1, status: 'PUBLISHED', isOpen: null, templateId: tpl._id, makerId: ctx.userId, data: b.data, publishedAt: now, ocrMarks: marks }], { session: session ?? undefined });
      await Product.updateOne({ _id: p!._id }, { $set: { publishedVersionId: v!._id } }, { session: session ?? undefined });
      await writeVariants(p!._id, v!._id, b.data, b.variants, session);
      await audit({ entity: 'product', entityId: p!._id, action: 'OWN_PRODUCT_CREATED', after: { code: b.code } }, { req, session });
      return p!._id;
    });
    return advisorGet(ctx, out);
  } catch (e) {
    if (isDuplicateKey(e, 'own_code_per_account')) throw AppError.field('code', 'CAT-07');
    throw e;
  }
}

/** Edit an own product: a new version, PUBLISHED at once; the old one SUPERSEDED (one transaction). */
export async function ownEdit(ctx: AuthContext, id: string, b: { version: number; data: ProductData; variants?: VariantInput[] }, req: Request) {
  const p = await Product.findOne({ _id: id, kind: 'OWN', accountId: ctx.accountId }).lean<ProductDoc>();
  if (!p) throw AppError.notFound();
  const tpl = await activeTemplate(p.typeId);
  if (!tpl) throw AppError.invalidState('insurance type', 'without a live template');
  if (b.data.customFeatures) b.data.customFeatures = normaliseCustomFeatures(b.data.customFeatures, 'ADVISOR');
  // No variants sent: the live ones carry over (checked against the new values)
  const keep = b.variants === undefined && p.publishedVersionId ? (await ProductVariant.find({ productVersionId: p.publishedVersionId }).sort({ position: 1 }).lean()).map(asInput) : b.variants ?? [];
  await publishCheck('OWN', p.insurerId, p.typeId, tpl._id, b.data, undefined, keep);
  if (b.data.brochureFileId) await assertOwnFile(ctx, b.data.brochureFileId, 'BROCHURE', 'brochureFileId');
  await withTx(async (session) => {
    const claimed = await Product.findOneAndUpdate({ _id: id, accountId: ctx.accountId, version: b.version }, { $set: { name: b.data.name, launchDate: b.data.launchDate, ...(p.status === 'WITHDRAWN' ? {} : { status: statusFor(b.data.launchDate) }) }, $inc: { version: 1 } }, { new: true, session: session ?? undefined }).lean<ProductDoc>();
    if (!claimed) throw AppError.versionConflict('product', null);
    const last = await ProductVersion.findOne({ productId: id }, { number: 1 }).sort({ number: -1 }).session(session).lean<{ number: number }>();
    await ProductVersion.updateMany({ productId: id, status: 'PUBLISHED' }, { $set: { status: 'SUPERSEDED' } }, { session: session ?? undefined });
    const [v] = await ProductVersion.create([{ productId: id, number: (last?.number ?? 0) + 1, status: 'PUBLISHED', isOpen: null, templateId: tpl._id, makerId: ctx.userId, data: b.data, publishedAt: clock.now() }], { session: session ?? undefined });
    await Product.updateOne({ _id: id }, { $set: { publishedVersionId: v!._id } }, { session: session ?? undefined });
    await writeVariants(id, v!._id, b.data, keep, session);
    await audit({ entity: 'product', entityId: id, action: 'OWN_PRODUCT_EDITED', after: { number: v!.number } }, { req, session });
  });
  return advisorGet(ctx, id);
}

/** The owner sets UPCOMING, ACTIVE or WITHDRAWN (P-22 step 4). */
export async function ownSetStatus(ctx: AuthContext, id: string, b: { version: number; status: 'UPCOMING' | 'ACTIVE' | 'WITHDRAWN' }, req: Request) {
  const u = await Product.findOneAndUpdate({ _id: id, kind: 'OWN', accountId: ctx.accountId, version: b.version }, { $set: { status: b.status }, $inc: { version: 1 } }, { new: true }).lean<ProductDoc>();
  if (!u) { if (!(await Product.exists({ _id: id, kind: 'OWN', accountId: ctx.accountId }))) throw AppError.notFound(); throw AppError.versionConflict('product', null); }
  await audit({ entity: 'product', entityId: id, action: 'OWN_PRODUCT_STATUS_CHANGED', after: { status: b.status } }, { req });
  return advisorGet(ctx, id);
}

// ── My commercials (ADV only, private) ──

export async function getCommercials(ctx: AuthContext, productId: string) {
  await advisorGet(ctx, productId); // must be a product this advisor can quote
  const c = await Commercial.findOne({ accountId: ctx.accountId, productId }).lean<CommercialDoc>();
  return { productId, commissionPercent: c?.commissionPercent ?? null, notes: c?.notes ?? null, version: c?.version ?? 0 };
}

export async function saveCommercials(ctx: AuthContext, productId: string, b: { commissionPercent: number | null; notes: string | null }, req: Request) {
  const p = await advisorGet(ctx, productId);
  await Commercial.findOneAndUpdate({ accountId: ctx.accountId, productId }, { $set: { commissionPercent: b.commissionPercent, notes: b.notes }, $inc: { version: 1 } }, { upsert: true });
  await audit({ entity: 'product', entityId: productId, action: 'COMMERCIALS_SAVED', after: { commissionSet: b.commissionPercent !== null } }, { req }); // the value itself is private
  return { commercials: await getCommercials(ctx, productId), params: { product: p.publishedVersion?.data.name ?? p.code } };
}

/**
 * Change #23 CATALOGUE_PRODUCT_PUBLISHED: a SkyUp-verified product published for the first time is announced to every
 * active advisor (once per product, by dedupe). Called after any publish path (Stage E's direct publish too).
 */
export async function announcePublished(productId: string) {
  const p = await Product.findById(productId, { kind: 1, name: 1, insurerId: 1 }).lean<{ kind: string; name: string | null; insurerId: string }>();
  if (!p || p.kind !== 'VERIFIED') return 0;
  const { Insurer } = await import('../insurers/insurer.model.js');
  const { Account } = await import('../accounts/account.model.js');
  const { User } = await import('../users/user.model.js');
  const { notify } = await import('../notifications/notifications.service.js');
  const insurer = (await Insurer.findById(p.insurerId, { name: 1 }).lean<{ name: string }>())?.name ?? 'an insurer';
  const active = (await Account.find({ status: 'ACTIVE' }, { _id: 1 }).lean<Array<{ _id: string }>>()).map((a) => a._id);
  let sent = 0;
  for await (const u of User.find({ role: 'ADV', status: 'ACTIVE', accountId: { $in: active } }, { _id: 1, accountId: 1 }).lean<{ _id: string; accountId: string }>().cursor()) {
    if (await notify({ userId: u._id, accountId: u.accountId, kind: 'CATALOGUE_PRODUCT_PUBLISHED', messageId: 'CAT-41', params: { product: p.name ?? 'A new product', insurer }, dedupeKey: `CAT-41|${productId}`, link: { type: 'PRODUCT', id: productId } }).catch(() => false)) sent++;
  }
  return sent;
}