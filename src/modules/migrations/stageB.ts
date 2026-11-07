/**
 * Stage B (change analysis §4.4 step 3 and §7.4 step 1): additive backfills, safe to run again.
 *   1. A default "Standard" variant for every product version that has none (its features and sum insured copied).
 *   2. Each quotation revision points at the variant of the version in its snapshot. The snapshot itself is never
 *      changed (GR-22): the variant is stored beside it.
 *   3. Proposals take the variant of their quotation revision; policies the variant of their quotation, else the
 *      default variant of their product's published version (policies recorded without a catalogue product keep none).
 *   4. Tasks created before change #21 get priority MEDIUM (task type stays empty: it was never asked).
 * Dry run unless `apply` is true: the report counts what would change, and a second run changes nothing.
 */
import { ProductVersion } from '../catalogue/product.model.js';
import { Product } from '../catalogue/product.model.js';
import { ProductVariant, defaultVariantFor } from '../catalogue/variant.model.js';
import { Policy } from '../policies/policy.model.js';
import { Proposal } from '../proposals/proposal.model.js';
import { Quotation } from '../quotations/quotation.model.js';
import { Task } from '../tasks/task.model.js';

type Rev = { revision: number; status: string; variantId?: string | null; snapshot?: { product?: { versionId?: string } } };

export async function runStageB(opts: { apply: boolean }) {
  const report = { apply: opts.apply, variantsCreated: 0, revisionsLinked: 0, revisionsWithoutProduct: 0, proposalsLinked: 0, policiesLinked: 0, policiesWithoutProduct: 0, tasksGivenPriority: 0 };

  // 1. default variants
  const withDefault = new Set((await ProductVariant.find({ isDefault: true }, { productVersionId: 1 }).lean<Array<{ productVersionId: string }>>()).map((v) => v.productVersionId));
  for await (const v of ProductVersion.find({}, { productId: 1, data: 1 }).lean<{ _id: string; productId: string; data: Record<string, unknown> }>().cursor({ batchSize: 200 })) {
    if (withDefault.has(v._id)) continue;
    report.variantsCreated++;
    if (opts.apply) await defaultVariantFor(v);
  }
  const variantOf = async (versionId: string | null | undefined) => {
    if (!versionId) return null;
    const d = await ProductVariant.findOne({ productVersionId: versionId, isDefault: true }, { _id: 1 }).lean<{ _id: string }>();
    return d?._id ?? (opts.apply ? null : 'dry-run');
  };

  // 2. quotation revisions (beside the frozen snapshot)
  for await (const q of Quotation.find({ 'revisions.variantId': { $in: [null] } }, { revisions: 1 }).lean<{ _id: string; revisions: Rev[] }>().cursor({ batchSize: 200 })) {
    const set: Record<string, string> = {};
    for (const [i, r] of q.revisions.entries()) {
      if (r.variantId) continue;
      const versionId = r.snapshot?.product?.versionId;
      if (!versionId) { report.revisionsWithoutProduct++; continue; }
      const id = await variantOf(versionId);
      if (!id) continue;
      report.revisionsLinked++;
      set[`revisions.${i}.variantId`] = id;
    }
    if (opts.apply && Object.keys(set).length) await Quotation.updateOne({ _id: q._id }, { $set: set });
  }
  const revisionVariant = async (quotationId: string | null | undefined, revision?: number) => {
    if (!quotationId) return null;
    const q = await Quotation.findById(quotationId, { revisions: 1 }).lean<{ revisions: Rev[] }>();
    if (!q) return null;
    const r = revision !== undefined ? q.revisions.find((x) => x.revision === revision)
      : q.revisions.find((x) => x.status === 'ACCEPTED') ?? q.revisions.at(-1);
    return r?.variantId ?? (r?.snapshot?.product?.versionId ? await variantOf(r.snapshot.product.versionId) : null);
  };

  // 3. proposals and policies
  for await (const p of Proposal.find({ variantId: null }, { quotationId: 1, revision: 1 }).lean<{ _id: string; quotationId: string; revision: number }>().cursor()) {
    const id = await revisionVariant(p.quotationId, p.revision);
    if (!id) continue;
    report.proposalsLinked++;
    if (opts.apply) await Proposal.updateOne({ _id: p._id, variantId: null }, { $set: { variantId: id } });
  }
  for await (const p of Policy.find({ variantId: null }, { quotationId: 1, productId: 1 }).lean<{ _id: string; quotationId: string | null; productId: string | null }>().cursor()) {
    let id = await revisionVariant(p.quotationId);
    if (!id && p.productId) {
      const prod = await Product.findById(p.productId, { publishedVersionId: 1 }).lean<{ publishedVersionId: string | null }>();
      id = await variantOf(prod?.publishedVersionId);
    }
    if (!id) { report.policiesWithoutProduct++; continue; }
    report.policiesLinked++;
    if (opts.apply) await Policy.updateOne({ _id: p._id, variantId: null }, { $set: { variantId: id } });
  }

  // 4. task priority for tasks made before the field existed
  const noPriority = { priority: { $exists: false } };
  report.tasksGivenPriority = await Task.countDocuments(noPriority);
  if (opts.apply && report.tasksGivenPriority) await Task.collection.updateMany(noPriority, { $set: { priority: 'MEDIUM', taskType: null } });
  return report;
}