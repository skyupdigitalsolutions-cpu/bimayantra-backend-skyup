import { AppError } from '../../lib/errors.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { Insurer } from '../insurers/insurer.model.js';
import { Product, ProductVersion } from './product.model.js';
import { liveFeatures } from './types.service.js';
import { ProductVariant } from './variant.model.js';

type FeatureValue = { value?: string | number | boolean | null; notStated?: boolean; included?: boolean } | undefined;
const shown = (v: FeatureValue) => (!v ? null : v.notStated ? 'Not stated by insurer' : v.included === false ? 'Not included' : v.value ?? null);

/**
 * Change #7: the feature table. Rows are the type's live template features, grouped; columns are the live products the
 * advisor can quote (SkyUp-verified, their own, or both) and each product's variants. Read only: a version without
 * variant records shows as one "Standard" column from its own values (nothing is created by reading).
 */
export async function featureTable(ctx: AuthContext, q: { typeId: string; source?: 'ALL' | 'VERIFIED' | 'OWN' }) {
  const tpl = await liveFeatures(q.typeId, ctx.accountId ?? null);
  const source = q.source ?? 'ALL';
  const kinds = source === 'VERIFIED' ? [{ kind: 'VERIFIED' }] : source === 'OWN' ? [{ kind: 'OWN', accountId: ctx.accountId }] : [{ kind: 'VERIFIED' }, { kind: 'OWN', accountId: ctx.accountId }];
  const products = await Product.find({ typeId: q.typeId, status: { $in: ['ACTIVE', 'UPCOMING'] }, publishedVersionId: { $ne: null }, $or: kinds }, { name: 1, kind: 1, insurerId: 1, publishedVersionId: 1 }).sort({ name: 1 }).lean<Array<{ _id: string; name: string | null; kind: string; insurerId: string; publishedVersionId: string }>>();
  if (products.length > 60) throw new AppError(400, 'VALIDATION_FAILED', 'GEN-01', { 'Field label': 'A narrower filter' });
  const versions = new Map((await ProductVersion.find({ _id: { $in: products.map((p) => p.publishedVersionId) } }, { data: 1 }).lean<Array<{ _id: string; data: { features?: Record<string, FeatureValue>; customFeatures?: Array<{ key: string; name: string; dataType?: string }> } }>>()).map((v) => [v._id, v]));
  const variants = await ProductVariant.find({ productVersionId: { $in: products.map((p) => p.publishedVersionId) }, status: 'ACTIVE' }).sort({ position: 1, name: 1 }).lean<Array<{ _id: string; productVersionId: string; name: string; features: Record<string, FeatureValue> }>>();
  const insurers = new Map((await Insurer.find({ _id: { $in: [...new Set(products.map((p) => p.insurerId))] } }, { name: 1 }).lean<Array<{ _id: string; name: string }>>()).map((i) => [i._id, i.name]));
  const columns: Array<{ productId: string; productName: string; insurer: string; kind: string; variantId: string | null; variantName: string; features: Record<string, FeatureValue> }> = [];
  for (const p of products) {
    const own = variants.filter((v) => v.productVersionId === p.publishedVersionId);
    const base = versions.get(p.publishedVersionId)?.data?.features ?? {};
    if (!own.length) columns.push({ productId: p._id, productName: p.name ?? '', insurer: insurers.get(p.insurerId) ?? '', kind: p.kind, variantId: null, variantName: 'Standard', features: base });
    for (const v of own) columns.push({ productId: p._id, productName: p.name ?? '', insurer: insurers.get(p.insurerId) ?? '', kind: p.kind, variantId: v._id, variantName: v.name, features: { ...base, ...(v.features ?? {}) } });
  }
  const groups: Array<{ group: string; rows: Array<{ key: string; name: string; dataType: string; values: Array<string | number | boolean | null>; differs: boolean }> }> = [];
  for (const f of tpl.features) {
    const values = columns.map((c) => shown(c.features[f.key]));
    const row = { key: f.key, name: f.name, dataType: f.dataType, values, differs: new Set(values.map((x) => JSON.stringify(x))).size > 1 };
    const g = groups.find((x) => x.group === f.group);
    if (g) g.rows.push(row); else groups.push({ group: f.group, rows: [row] });
  }
  // Change #5: own features (outside the template) as extra rows; a product without one shows nothing there
  const own = new Map<string, { name: string; dataType: string }>();
  for (const v of versions.values()) for (const c of v.data?.customFeatures ?? []) if (!own.has(c.key)) own.set(c.key, { name: c.name, dataType: c.dataType ?? 'Yes/No' });
  if (own.size) {
    const rows = [...own].map(([key, c]) => { const values = columns.map((col) => shown(col.features[key])); return { key, name: c.name, dataType: c.dataType, values, differs: new Set(values.map((x) => JSON.stringify(x))).size > 1 }; });
    groups.push({ group: 'Own features', rows });
  }
  return { typeId: tpl.typeId, typeName: tpl.typeName, source, columns: columns.map(({ features: _f, ...c }) => c), groups };
}