import { Schema, model, type ClientSession, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';
import { isDuplicateKey } from '../../lib/mongo.js';

/**
 * Change #2: a product variant (Silver, Gold, Platinum…) inside one product version, with its own cover type, sum
 * insured range and feature values. Every version has a default variant ("Standard"): created by the Stage B migration
 * for existing versions, and on first use for later ones, so quotations made before variants keep pointing at one.
 */
const variantSchema = new Schema(
  {
    _id: { type: String, default: () => newId('var') },
    productId: { type: String, required: true },
    productVersionId: { type: String, required: true },
    name: { type: String, required: true },
    coverType: { type: String, enum: ['INDIVIDUAL', 'FLOATER', null], default: null },
    sumInsuredMin: { type: Number, default: null }, sumInsuredMax: { type: Number, default: null },
    position: { type: Number, default: 0 },
    status: { type: String, enum: ['ACTIVE', 'WITHDRAWN'], default: 'ACTIVE' },
    isDefault: { type: Boolean, default: false },
    /** { [featureKey]: { value, page, notStated, included } }, the shape of a version's `data.features`. */
    features: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, versionKey: false, minimize: false },
);
variantSchema.index({ productVersionId: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 }, name: 'variant_name_per_version' });
variantSchema.index({ productVersionId: 1 }, { unique: true, partialFilterExpression: { isDefault: true }, name: 'one_default_variant' });
variantSchema.index({ productId: 1 });
export type VariantDoc = InferSchemaType<typeof variantSchema> & { _id: string };
export const ProductVariant = model('ProductVariant', variantSchema, 'product_variants');

type VersionLike = { _id: string; productId: string; data?: Record<string, any> | null };
/** The default variant's values: the version's own features and sum-insured range. */
export function defaultVariantFields(v: VersionLike) {
  const d = (v.data ?? {}) as { features?: Record<string, unknown>; sumInsured?: { options?: number[]; min?: number | null; max?: number | null } };
  const opts = (d.sumInsured?.options ?? []).filter((x) => typeof x === 'number');
  return {
    productId: v.productId, productVersionId: v._id, name: 'Standard', isDefault: true, position: 0,
    sumInsuredMin: d.sumInsured?.min ?? (opts.length ? Math.min(...opts) : null),
    sumInsuredMax: d.sumInsured?.max ?? (opts.length ? Math.max(...opts) : null),
    features: d.features ?? {},
  };
}
/** The version's default variant, created if missing (race-safe: one default per version is a database rule). */
export async function defaultVariantFor(v: VersionLike, session?: ClientSession | null): Promise<VariantDoc> {
  const found = await ProductVariant.findOne({ productVersionId: v._id, isDefault: true }).session(session ?? null).lean<VariantDoc>();
  if (found) return found;
  try { return (await ProductVariant.create([defaultVariantFields(v)], { session: session ?? undefined }))[0]!.toObject() as VariantDoc; }
  catch (e) { if (!isDuplicateKey(e)) throw e; return (await ProductVariant.findOne({ productVersionId: v._id, isDefault: true }).lean<VariantDoc>())!; }
}