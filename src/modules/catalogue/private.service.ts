/**
 * Changes #3 and #4: an advisor's private insurer and private insurance category.
 *
 *  - A private insurer is added by name only (no IRDAI number, no short code), ACTIVE at once, and visible only in
 *    that account: in its insurer picker (P-07 agent codes), its own products and its quotations. Never in the SkyUp
 *    library, the verified catalogue, the "Verified by SkyUp" feature-table source, or another account.
 *  - A private category has no SkyUp feature template. It gets an empty ACTIVE template so the rest of the catalogue
 *    (versions, publish checks, feature table) works unchanged; products in it carry the advisor's own features and are
 *    priced by manual entry (no rating factors). Not offered in Best fit; no lead pipeline is created (Q4 defaults).
 *  - Names are unique per owner, so a private name may match a library one (the advisor did not find it there).
 *    SkyUp merging a private insurer into a library one is not built (Q101).
 */
import { categoryKey } from './categoryNames.js';
import type { Request } from 'express';
import { AppError } from '../../lib/errors.js';
import { isDuplicateKey, withTx } from '../../lib/mongo.js';
import { audit } from '../audit/audit.service.js';
import { Insurer, type InsurerDoc } from '../insurers/insurer.model.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { InsuranceType, TemplateVersion, type InsuranceTypeDoc } from './types.model.js';
import { formOfType, guessProductForm, type ProductFormCode } from './productForms.js';
import { Product, ProductVersion } from './product.model.js';
import { Policy } from '../policies/policy.model.js';

/** Owner filter: the SkyUp library plus this account's private items. */
export const visibleTo = (accountId: string | null | undefined) => ({ ownerAccountId: { $in: [null, ...(accountId ? [accountId] : [])] } });
/** The SkyUp library only (shared lists, SkyUp screens, Best fit). */
export const LIBRARY = { ownerAccountId: null } as const;

export async function assertVisibleInsurer(accountId: string | null | undefined, insurerId: string, field = 'insurerId') {
  const i = await Insurer.findOne({ _id: insurerId, ...visibleTo(accountId) }, { status: 1, ownerAccountId: 1 }).lean<Pick<InsurerDoc, 'status' | 'ownerAccountId'>>();
  if (!i) throw AppError.field(field, 'VAL-22');
  return i;
}
export async function assertVisibleType(accountId: string | null | undefined, typeId: string, field = 'typeId') {
  const t = await InsuranceType.findOne({ _id: typeId, ...visibleTo(accountId) }, { status: 1, ownerAccountId: 1, name: 1 }).lean<Pick<InsuranceTypeDoc, '_id' | 'status' | 'ownerAccountId' | 'name'>>();
  if (!t) throw AppError.field(field, 'VAL-22');
  return t;
}
export const isPrivateType = async (typeId: string) => !!(await InsuranceType.exists({ _id: typeId, ownerAccountId: { $ne: null } }));

/** Step 2 "add a company": name only, ACTIVE at once, this account only. */
export async function addInsurer(ctx: AuthContext, b: { name: string }, req: Request) {
  const name = b.name.trim();
  try {
    const i = await Insurer.create({ name, nameKey: name.toLowerCase(), ownerAccountId: ctx.accountId, status: 'ACTIVE', makerId: ctx.userId });
    await audit({ entity: 'insurer', entityId: i._id, action: 'PRIVATE_INSURER_ADDED', after: { name } }, { req });
    return { id: i._id, name: i.name, private: true, status: i.status };
  } catch (e) {
    if (isDuplicateKey(e)) throw AppError.field('name', 'CAT-50', { name });
    throw e;
  }
}

/**
 * Step 1 "create a category": no SkyUp template; an empty live template is made with it (one transaction). The
 * advisor may pick which product details it carries (productForm); otherwise it follows the name.
 */
export async function addCategory(ctx: AuthContext, b: { name: string; productForm?: ProductFormCode | null }, req: Request) {
  const name = b.name.trim();
  const productForm = b.productForm ?? guessProductForm(name);
  // A private "Health" next to SkyUp's Health shows two Health tabs, one with no features or products: refused.
  // Compared by meaning, not exact text: "health insurance", "Health  Cover" and "HEALTH" are all Health.
  const key = categoryKey(name);
  if (!key) throw AppError.field('name', 'GEN-01', { 'Field label': 'Category name' });
  const existing = await InsuranceType.find({ $or: [{ ownerAccountId: null, status: 'ACTIVE' }, { ownerAccountId: ctx.accountId }] }, { name: 1, ownerAccountId: 1 }).lean<Array<{ name: string; ownerAccountId: string | null }>>();
  const same = existing.find((t) => categoryKey(t.name) === key);
  if (same && !same.ownerAccountId) throw AppError.field('name', 'CAT-52', { name: same.name });
  if (same) throw AppError.field('name', 'CAT-50', { name: same.name });
  try {
    return await withTx(async (session) => {
      const [t] = await InsuranceType.create([{ name, nameKey: name.toLowerCase(), ownerAccountId: ctx.accountId, status: 'ACTIVE', productForm }], { session: session ?? undefined });
      const [tpl] = await TemplateVersion.create([{ typeId: t!._id, number: 1, status: 'ACTIVE', isOpen: null, features: [], factors: [], questions: [], makerId: ctx.userId, approvedAt: new Date() }], { session: session ?? undefined });
      await audit({ entity: 'insuranceType', entityId: t!._id, action: 'PRIVATE_CATEGORY_ADDED', after: { name, productForm } }, { req, session });
      return { id: t!._id, name: t!.name, private: true, productForm, template: { id: tpl!._id, number: 1 } };
    });
  } catch (e) {
    if (isDuplicateKey(e)) throw AppError.field('name', 'CAT-50', { name });
    throw e;
  }
}

/** Step 2 picker: the IRDAI library (ACTIVE) and this account's private insurers, searchable. */
/**
 * Which IRDAI licence classes may sell each kind of product: life insurers write term and savings plans; general
 * insurers write motor and home; health, travel and personal accident are written by general and standalone health
 * insurers. GENERIC (an advisor's own category, unknown kind): every class.
 */
const SELLERS: Record<ProductFormCode, ReadonlyArray<string>> = {
  TERM_LIFE: ['Life'], LIFE_SAVINGS: ['Life'],
  MOTOR_CAR: ['General'], MOTOR_TWO_WHEELER: ['General'], HOME: ['General'],
  HEALTH: ['General', 'Standalone Health'], TRAVEL: ['General', 'Standalone Health'], PERSONAL_ACCIDENT: ['General', 'Standalone Health'],
  GENERIC: ['Life', 'General', 'Standalone Health'],
};

/**
 * + My product, step 2: the companies the advisor can pick. With a category (typeId): only insurers licensed for it,
 * plus any insurer that already has a product in it (in case its class is recorded differently), plus companies the
 * advisor added themselves (their class is unknown, so they always show).
 */
export async function insurerChoices(ctx: AuthContext, q?: string, typeId?: string) {
  const f: Record<string, unknown> = { status: 'ACTIVE', ...visibleTo(ctx.accountId) };
  if (q) f.nameKey = { $regex: q.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };
  if (typeId) {
    const type = await InsuranceType.findOne({ _id: typeId, $or: [{ ownerAccountId: null }, { ownerAccountId: ctx.accountId }] }, { name: 1, productForm: 1 }).lean<{ name: string; productForm?: string | null }>();
    if (type) {
      const classes = SELLERS[formOfType(type).code as ProductFormCode] ?? SELLERS.GENERIC;
      const selling = await Product.distinct('insurerId', { typeId, $or: [{ kind: 'VERIFIED' }, { kind: 'OWN', accountId: ctx.accountId }] });
      f.$and = [{ $or: [{ category: { $in: classes } }, { _id: { $in: selling } }, { ownerAccountId: ctx.accountId }] }];
    }
  }
  const rows = await Insurer.find(f, { name: 1, category: 1, ownerAccountId: 1 }).sort({ name: 1 }).limit(200).lean<Array<Pick<InsurerDoc, '_id' | 'name' | 'category' | 'ownerAccountId'>>>();
  return rows.map((i) => ({ id: i._id, name: i.name, category: i.category ?? null, private: !!i.ownerAccountId }));
}

/**
 * One-off clean-up: a private category that means the same as a SkyUp category (a private "Health" next to SkyUp's
 * Health, made before duplicates were refused) is merged into the SkyUp one. Its products move to the SkyUp category
 * and follow SkyUp's live feature template (values the private template did not have show as "Not stated" until
 * edited); policies recorded under it move too; the private category is switched off. Dry run unless apply.
 *   npm run catalogue:merge-duplicates            # report only
 *   npm run catalogue:merge-duplicates -- --apply # write
 */
export async function mergeDuplicateCategories(opts: { apply: boolean }) {
  const skyup = await InsuranceType.find({ ownerAccountId: null, status: 'ACTIVE' }).lean<InsuranceTypeDoc[]>();
  const byKey = new Map(skyup.map((t) => [categoryKey(t.name), t]));
  const priv = await InsuranceType.find({ ownerAccountId: { $ne: null }, status: 'ACTIVE' }).lean<InsuranceTypeDoc[]>();
  const report: Array<{ accountId: string; category: string; into: string; products: number; policies: number; result: string }> = [];
  for (const p of priv) {
    const s = byKey.get(categoryKey(p.name));
    if (!s) continue;
    const tpl = await TemplateVersion.findOne({ typeId: s._id, status: 'ACTIVE' }, { _id: 1 }).lean<{ _id: string }>();
    const productIds = (await Product.find({ typeId: p._id }, { _id: 1 }).lean<Array<{ _id: string }>>()).map((x) => x._id);
    const policies = await Policy.countDocuments({ typeId: p._id });
    const row = { accountId: String(p.ownerAccountId), category: p.name, into: s.name, products: productIds.length, policies, result: '' };
    if (!tpl) { report.push({ ...row, result: `skipped: SkyUp's ${s.name} has no live feature template` }); continue; }
    if (!opts.apply) { report.push({ ...row, result: 'would merge' }); continue; }
    await withTx(async (session) => {
      const o = { session: session ?? undefined };
      await Product.updateMany({ typeId: p._id }, { $set: { typeId: s._id } }, o);
      await ProductVersion.updateMany({ productId: { $in: productIds } }, { $set: { templateId: tpl._id, 'data.form': formOfType(s).code } }, o);
      await Policy.updateMany({ typeId: p._id }, { $set: { typeId: s._id } }, o);
      await TemplateVersion.updateMany({ typeId: p._id, status: 'ACTIVE' }, { $set: { status: 'RETIRED', isOpen: null } }, o);
      await InsuranceType.updateOne({ _id: p._id }, { $set: { status: 'INACTIVE' } }, o);
      await audit({ entity: 'insuranceType', entityId: p._id, action: 'PRIVATE_CATEGORY_MERGED', after: { into: s._id, products: productIds.length, policies } }, { session });
    });
    report.push({ ...row, result: 'merged' });
  }
  return report;
}

/**
 * Repair: products (and policies) whose category no longer exists — e.g. categories deleted and created again with new
 * IDs. Such products show no category, are missing from the category tabs, Best fit, quotations by type and the
 * feature table. Each old category is matched to a current SkyUp category by the kind its products recorded
 * (data.form: HEALTH, TERM_LIFE…) or, failing that, by its feature template (feature keys overlap). Dry run unless apply.
 *   npm run catalogue:repair-categories            # report only
 *   npm run catalogue:repair-categories -- --apply # write
 */
export async function repairOrphanCategories(opts: { apply: boolean }) {
  const existing = new Set((await InsuranceType.find({}, { _id: 1 }).lean<Array<{ _id: string }>>()).map((t) => t._id));
  const orphans = await Product.find({ typeId: { $nin: [...existing] } }, { typeId: 1, publishedVersionId: 1, draftVersionId: 1, name: 1, code: 1 }).lean<Array<{ _id: string; typeId: string; publishedVersionId?: string | null; draftVersionId?: string | null; name?: string; code: string }>>();
  const skyup = await InsuranceType.find({ ownerAccountId: null, status: 'ACTIVE' }).lean<InsuranceTypeDoc[]>();
  const live = new Map<string, Set<string>>();
  for (const t of skyup) {
    const tpl = await TemplateVersion.findOne({ typeId: t._id, status: 'ACTIVE' }, { features: 1 }).lean<{ features: Array<{ key: string }> }>();
    live.set(t._id, new Set((tpl?.features ?? []).map((f) => f.key)));
  }
  const byOld = new Map<string, typeof orphans>();
  for (const p of orphans) byOld.set(p.typeId, [...(byOld.get(p.typeId) ?? []), p]);
  const report: Array<{ oldCategoryId: string; products: number; policies: number; into: string | null; by: string; examples: string[]; result: string }> = [];
  for (const [oldId, prods] of byOld) {
    const versions = await ProductVersion.find({ productId: { $in: prods.map((p) => p._id) } }, { productId: 1, templateId: 1, 'data.form': 1 }).lean<Array<{ productId: string; templateId?: string; data?: { form?: string } }>>();
    // 1) the kind the products recorded
    const votes = new Map<string, number>();
    for (const v of versions) { const f = v.data?.form; if (f && f !== 'GENERIC') votes.set(f, (votes.get(f) ?? 0) + 1); }
    const topForm = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    let target = topForm ? skyup.filter((t) => formOfType(t).code === topForm) : [];
    let by = topForm ? `recorded kind ${topForm}` : '';
    // 2) failing that, the feature template
    if (target.length !== 1) {
      const keys = new Set<string>();
      for (const id of new Set(versions.map((v) => v.templateId).filter(Boolean) as string[])) {
        const tpl = await TemplateVersion.findById(id, { features: 1 }).lean<{ features: Array<{ key: string }> }>();
        for (const f of tpl?.features ?? []) keys.add(f.key);
      }
      const scored = skyup.map((t) => {
        const k = live.get(t._id) ?? new Set<string>();
        const both = [...keys].filter((x) => k.has(x)).length;
        return { t, score: keys.size && k.size ? both / new Set([...keys, ...k]).size : 0 };
      }).sort((a, b) => b.score - a.score);
      const best = scored[0];
      target = best && best.score >= 0.5 && (scored[1]?.score ?? 0) < best.score ? [best.t] : [];
      by = best && target.length ? `feature template (${Math.round(best.score * 100)}% same features)` : 'no match';
    }
    const policies = await Policy.countDocuments({ typeId: oldId });
    const into = target.length === 1 ? target[0]! : null;
    const row = { oldCategoryId: oldId, products: prods.length, policies, into: into?.name ?? null, by, examples: prods.slice(0, 3).map((p) => p.name ?? p.code), result: '' };
    if (!into) { report.push({ ...row, result: 'skipped: could not tell which category — fix by hand' }); continue; }
    if (!opts.apply) { report.push({ ...row, result: `would move to ${into.name}` }); continue; }
    await withTx(async (session) => {
      const o = { session: session ?? undefined };
      await Product.updateMany({ typeId: oldId }, { $set: { typeId: into._id } }, o);
      await Policy.updateMany({ typeId: oldId }, { $set: { typeId: into._id } }, o);
      await audit({ entity: 'insuranceType', entityId: oldId, action: 'ORPHAN_CATEGORY_REPAIRED', after: { into: into._id, products: prods.length, policies, by } }, { session });
    });
    report.push({ ...row, result: `moved to ${into.name}` });
  }
  return report;
}