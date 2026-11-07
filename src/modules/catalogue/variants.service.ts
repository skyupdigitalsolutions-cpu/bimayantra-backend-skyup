/**
 * Changes #2 and #5: product variants and own features.
 *
 * Q4 defaults (to confirm): variants exist on SkyUp-verified and own products alike; price versions, riders, entry ages
 * and policy terms stay on the PRODUCT; each variant has a name, cover type, a sum-insured range inside the product's,
 * and its own feature values. A feature value missing on a variant falls back to the product version's value, so a
 * product without variants behaves exactly as before (one default variant, "Standard").
 *
 * Variants belong to one product VERSION (GR-23): an edit makes a new version with its own copies, and a quotation
 * keeps the variant of the version it used. The first variant is the default.
 *
 * Own features (change #5) are features outside the category's template: added by the advisor (or by SkyUp on a
 * verified product), or AI-suggested by brochure reading and ticked to add. They are listed in the version's
 * `data.customFeatures` and valued per variant like template features (✓/✗ is a Yes/No value).
 */
import type { ClientSession } from 'mongoose';
import { AppError } from '../../lib/errors.js';
import { ProductVariant, defaultVariantFields, type VariantDoc } from './variant.model.js';

export const MAX_VARIANTS = 10; // [TO CONFIRM] no limit is stated in the design
export type FeatureValue = { value?: string | number | boolean | null; page?: number | null; notStated?: boolean; included?: boolean };
export interface CustomFeature { key?: string; name: string; origin?: 'ADVISOR' | 'AI_SUGGESTED' | 'SKYUP'; group?: string | null; dataType?: string }
export interface VariantInput {
  name: string; coverType?: 'INDIVIDUAL' | 'FLOATER' | null; sumInsuredMin?: number | null; sumInsuredMax?: number | null;
  features?: Record<string, FeatureValue>;
}
type ProductSi = { options?: number[]; min?: number | null; max?: number | null } | undefined;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 50);

/** Keys for own features (`cf_` + the name), unique names (CAT-51); the origin defaults by who adds it. */
export function normaliseCustomFeatures(list: CustomFeature[] | undefined, by: 'ADVISOR' | 'SKYUP') {
  const out: Array<Required<Pick<CustomFeature, 'key' | 'name' | 'origin' | 'dataType'>> & { group: string | null }> = [];
  (list ?? []).forEach((c, i) => {
    const name = c.name.trim();
    if (out.some((o) => o.name.toLowerCase() === name.toLowerCase())) throw AppError.field(`customFeatures.${i}.name`, 'CAT-51');
    out.push({ key: c.key && c.key.startsWith('cf_') ? c.key : `cf_${slug(name)}`, name, origin: c.origin ?? by, group: c.group ?? 'Other', dataType: c.dataType ?? 'Yes/No' });
  });
  if (new Set(out.map((o) => o.key)).size !== out.length) throw AppError.field('customFeatures', 'CAT-51');
  return out;
}

/** Product sum-insured bounds: the range, else the smallest and largest option. */
function bounds(si: ProductSi) {
  const opts = (si?.options ?? []).filter((x) => typeof x === 'number');
  const min = si?.min ?? (opts.length ? Math.min(...opts) : null);
  const max = si?.max ?? (opts.length ? Math.max(...opts) : null);
  return { min, max };
}

/** Field checks on a set of variants: count, names, sum insured inside the product's, known feature keys. */
export function checkVariants(variants: VariantInput[], si: ProductSi, featureKeys: Set<string>) {
  if (variants.length > MAX_VARIANTS) throw AppError.field('variants', 'CAT-49', { n: MAX_VARIANTS });
  const b = bounds(si);
  const errs: Array<{ field: string; messageId: 'CAT-46' | 'CAT-47' | 'CAT-16' | 'VAL-22'; params?: Record<string, string | number> }> = [];
  const seen = new Set<string>();
  variants.forEach((v, i) => {
    const key = v.name.trim().toLowerCase();
    if (seen.has(key)) errs.push({ field: `variants.${i}.name`, messageId: 'CAT-46' });
    seen.add(key);
    const lo = v.sumInsuredMin ?? null; const hi = v.sumInsuredMax ?? null;
    if (lo !== null && hi !== null && lo > hi) errs.push({ field: `variants.${i}.sumInsuredMax`, messageId: 'CAT-16' });
    else if (b.min !== null && b.max !== null && ((lo !== null && lo < b.min) || (hi !== null && hi > b.max))) {
      errs.push({ field: `variants.${i}.sumInsuredMin`, messageId: 'CAT-47', params: { min: b.min, max: b.max } });
    }
    for (const k of Object.keys(v.features ?? {})) if (!featureKeys.has(k)) errs.push({ field: `variants.${i}.features.${k}`, messageId: 'VAL-22' });
  });
  if (errs.length) throw AppError.fields(errs);
}

/** Required template features must have a value on every variant (its own or the product's): for CAT-13. */
export function missingOnVariants(variants: VariantInput[], required: Array<{ key: string; name: string }>, productFeatures: Record<string, FeatureValue> = {}) {
  const missing: string[] = [];
  const has = (v?: FeatureValue) => !!v && (v.notStated || (v.value !== undefined && v.value !== null && v.value !== ''));
  for (const v of variants) for (const f of required) if (!has(v.features?.[f.key]) && !has(productFeatures[f.key])) missing.push(`a value for ${f.name} in ${v.name}`);
  return missing;
}

/** Replace a version's variants (a draft, or a version being published). None given → the default "Standard" one. */
export async function writeVariants(productId: string, versionId: string, data: { features?: Record<string, unknown>; sumInsured?: ProductSi } | null, variants: VariantInput[] | undefined, session?: ClientSession | null) {
  await ProductVariant.deleteMany({ productVersionId: versionId }, { session: session ?? undefined });
  const docs = variants?.length
    ? variants.map((v, i) => ({
      productId, productVersionId: versionId, name: v.name.trim(), coverType: v.coverType ?? null, sumInsuredMin: v.sumInsuredMin ?? null, sumInsuredMax: v.sumInsuredMax ?? null,
      features: v.features ?? {}, position: i, isDefault: i === 0, status: 'ACTIVE',
    }))
    : [defaultVariantFields({ _id: versionId, productId, data: data ?? {} })];
  await ProductVariant.insertMany(docs, { session: session ?? undefined });
}

/** An edit copies the published version's variants into the new version (new IDs, same values). */
export async function copyVariants(fromVersionId: string, toVersionId: string, session?: ClientSession | null) {
  const rows = await ProductVariant.find({ productVersionId: fromVersionId }).sort({ position: 1 }).session(session ?? null).lean<VariantDoc[]>();
  if (!rows.length) return;
  await ProductVariant.insertMany(rows.map(({ _id: _x, createdAt: _c, updatedAt: _u, ...v }) => ({ ...v, productVersionId: toVersionId })) as never[], { session: session ?? undefined });
}

export const asInput = (v: Pick<VariantDoc, 'name' | 'coverType' | 'sumInsuredMin' | 'sumInsuredMax' | 'features'>): VariantInput =>
  ({ name: v.name, coverType: (v.coverType ?? null) as VariantInput['coverType'], sumInsuredMin: v.sumInsuredMin ?? null, sumInsuredMax: v.sumInsuredMax ?? null, features: (v.features ?? {}) as Record<string, FeatureValue> });

/** A version's variants, each with its features merged over the product's (what screens and comparisons show). */
export async function variantsOf(versionId: string, productFeatures: Record<string, FeatureValue> = {}, show: (v: FeatureValue) => FeatureValue = (v) => v) {
  const rows = await ProductVariant.find({ productVersionId: versionId, status: 'ACTIVE' }).sort({ position: 1, name: 1 }).lean<VariantDoc[]>();
  return rows.map((v) => {
    const merged = { ...productFeatures, ...((v.features ?? {}) as Record<string, FeatureValue>) };
    return {
      id: v._id, name: v.name, coverType: v.coverType ?? null, sumInsuredMin: v.sumInsuredMin ?? null, sumInsuredMax: v.sumInsuredMax ?? null, isDefault: !!v.isDefault, position: v.position,
      features: Object.fromEntries(Object.entries(merged).map(([k, x]) => [k, show(x)])),
    };
  });
}