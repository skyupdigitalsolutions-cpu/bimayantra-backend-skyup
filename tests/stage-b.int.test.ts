/** Stage B — additive schema (tasks, insurers, categories, variants, saved document types) and its backfill migration. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetState, startTestEnv, stopTestEnv } from './helpers.js';
import { ProductVariant, defaultVariantFor } from '../src/modules/catalogue/variant.model.js';
import { ProductVersion, Product } from '../src/modules/catalogue/product.model.js';
import { AccountDocumentType } from '../src/modules/documents/accountDocType.model.js';
import { Insurer } from '../src/modules/insurers/insurer.model.js';
import { Policy } from '../src/modules/policies/policy.model.js';
import { Proposal } from '../src/modules/proposals/proposal.model.js';
import { Quotation } from '../src/modules/quotations/quotation.model.js';
import { Task } from '../src/modules/tasks/task.model.js';
import { runStageB } from '../src/modules/migrations/stageB.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

const ACC = `acc_${'1'.repeat(28)}`;
/** An existing database as it was before Stage B (written raw: older documents have none of the new fields). */
async function oldWorld() {
  const now = new Date();
  await Product.collection.insertOne({ _id: 'prd_1' as never, kind: 'VERIFIED', insurerId: 'ins_1', typeId: 'typ_1', code: 'P1', status: 'PUBLISHED', publishedVersionId: 'pv_1b', makerId: 'u', createdAt: now, updatedAt: now });
  await ProductVersion.collection.insertMany([
    { _id: 'pv_1a' as never, productId: 'prd_1', number: 1, status: 'SUPERSEDED', isOpen: false, templateId: 't', makerId: 'u', data: { name: 'Family Care', sumInsured: { options: [300000, 500000, 1000000] }, features: { room_rent: { value: 'Single private room' } } }, createdAt: now, updatedAt: now },
    { _id: 'pv_1b' as never, productId: 'prd_1', number: 2, status: 'PUBLISHED', isOpen: false, templateId: 't', makerId: 'u', data: { name: 'Family Care', sumInsured: { min: 500000, max: 2500000 }, features: { room_rent: { value: 'No limit' }, copay: { notStated: true } } }, createdAt: now, updatedAt: now },
  ]);
  const snapshot = (versionId: string) => ({ product: { id: 'prd_1', versionId, versionNumber: 1, name: 'Family Care' }, breakdown: { final: 12345.67 } });
  await Quotation.collection.insertOne({ _id: 'qt_1' as never, accountId: ACC, customerId: 'cus_1', createdBy: 'u', status: 'ACCEPTED', revisions: [
    { revision: 1, status: 'SUPERSEDED', snapshot: snapshot('pv_1a'), generatedAt: now, generatedBy: 'u' },
    { revision: 2, status: 'ACCEPTED', snapshot: snapshot('pv_1b'), generatedAt: now, generatedBy: 'u' },
    { revision: 3, status: 'READY', snapshot: { product: null, manual: true }, generatedAt: now, generatedBy: 'u' },
  ], createdAt: now, updatedAt: now });
  await Proposal.collection.insertOne({ _id: 'prp_1' as never, accountId: ACC, quotationId: 'qt_1', revision: 2, status: 'SUBMITTED', createdAt: now, updatedAt: now });
  await Policy.collection.insertMany([
    { _id: 'pol_1' as never, accountId: ACC, quotationId: 'qt_1', productId: 'prd_1', status: 'ISSUED', createdAt: now, updatedAt: now },
    { _id: 'pol_2' as never, accountId: ACC, quotationId: null, productId: 'prd_1', status: 'ISSUED', createdAt: now, updatedAt: now },
    { _id: 'pol_3' as never, accountId: ACC, quotationId: null, productId: null, productName: 'Not in catalogue', status: 'ISSUED', createdAt: now, updatedAt: now },
  ]);
  await Task.collection.insertOne({ _id: 'tsk_1' as never, accountId: ACC, kind: 'GENERAL', title: 'Old task', dueAt: now, status: 'OPEN', createdAt: now, updatedAt: now });
}

describe('Stage B migration', () => {
  it('the dry run reports and writes nothing; --apply backfills; snapshots stay exactly as they were; a second run changes nothing', async () => {
    await oldWorld();
    const before = await Quotation.collection.findOne({ _id: 'qt_1' as never });
    const dry = await runStageB({ apply: false });
    expect(dry).toMatchObject({ apply: false, variantsCreated: 2, revisionsLinked: 2, revisionsWithoutProduct: 1, proposalsLinked: 1, policiesLinked: 2, policiesWithoutProduct: 1, tasksGivenPriority: 1 });
    expect(await ProductVariant.countDocuments({})).toBe(0);
    expect(await Quotation.collection.findOne({ _id: 'qt_1' as never })).toEqual(before);

    const run = await runStageB({ apply: true });
    expect(run).toMatchObject({ variantsCreated: 2, revisionsLinked: 2, revisionsWithoutProduct: 1, proposalsLinked: 1, policiesLinked: 2, policiesWithoutProduct: 1, tasksGivenPriority: 1 });
    const va = await ProductVariant.findOne({ productVersionId: 'pv_1a' }).lean();
    const vb = await ProductVariant.findOne({ productVersionId: 'pv_1b' }).lean();
    expect(va).toMatchObject({ name: 'Standard', isDefault: true, productId: 'prd_1', sumInsuredMin: 300000, sumInsuredMax: 1000000, features: { room_rent: { value: 'Single private room' } } });
    expect(vb).toMatchObject({ sumInsuredMin: 500000, sumInsuredMax: 2500000, features: { room_rent: { value: 'No limit' }, copay: { notStated: true } } });
    const after = (await Quotation.collection.findOne({ _id: 'qt_1' as never }))!;
    expect(after.revisions.map((r: { variantId?: string }) => r.variantId ?? null)).toEqual([va!._id, vb!._id, null]);
    expect(after.revisions.map((r: { snapshot: unknown }) => r.snapshot)).toEqual(before!.revisions.map((r: { snapshot: unknown }) => r.snapshot)); // GR-22
    expect((await Proposal.findById('prp_1').lean())!.variantId).toBe(vb!._id);
    expect((await Policy.findById('pol_1').lean())!.variantId).toBe(vb!._id); // from the accepted revision
    expect((await Policy.findById('pol_2').lean())!.variantId).toBe(vb!._id); // from the product's published version
    expect((await Policy.findById('pol_3').lean())!.variantId ?? null).toBeNull(); // not in the catalogue: no variant
    expect(await Task.collection.findOne({ _id: 'tsk_1' as never })).toMatchObject({ priority: 'MEDIUM', taskType: null });

    expect(await runStageB({ apply: true })).toMatchObject({ variantsCreated: 0, revisionsLinked: 0, proposalsLinked: 0, policiesLinked: 0, tasksGivenPriority: 0 });
    expect(await ProductVariant.countDocuments({})).toBe(2);
  });
});

describe('Stage B schema', () => {
  it('a version gets exactly one default variant, even when asked for at the same moment', async () => {
    const v = { _id: 'pv_9', productId: 'prd_9', data: { sumInsured: { options: [200000] }, features: {} } };
    const got = await Promise.all(Array.from({ length: 6 }, () => defaultVariantFor(v)));
    expect(new Set(got.map((x) => x._id)).size).toBe(1);
    expect(await ProductVariant.countDocuments({ productVersionId: 'pv_9' })).toBe(1);
    await expect(ProductVariant.create({ productId: 'prd_9', productVersionId: 'pv_9', name: 'standard' })).rejects.toThrow(/duplicate key/); // names unique in any case
    await expect(ProductVariant.create({ productId: 'prd_9', productVersionId: 'pv_9', name: 'Gold', isDefault: true })).rejects.toThrow(/one_default_variant/); // only one default per version
    await ProductVariant.create({ productId: 'prd_9', productVersionId: 'pv_9', name: 'Gold' }); // a second, non-default variant is fine
  });

  it('new tasks default to Medium priority; a private insurer needs no IRDAI number, a library insurer still does; saved document types are unique per account in any case', async () => {
    const t = await Task.create({ accountId: ACC, kind: 'GENERAL', title: 'Call Ravi', dueAt: new Date() });
    expect(t.toObject()).toMatchObject({ priority: 'MEDIUM', taskType: null });
    await expect(Task.create({ accountId: ACC, kind: 'GENERAL', title: 'x', dueAt: new Date(), taskType: 'DANCE' })).rejects.toThrow(/taskType/);
    const ownErr = new Insurer({ name: 'Local Mutual', ownerAccountId: ACC }).validateSync();
    expect(ownErr?.errors.irdaiRegNo).toBeUndefined();
    expect(new Insurer({ name: 'Star Health' }).validateSync()?.errors.irdaiRegNo).toBeDefined();
    await AccountDocumentType.create({ accountId: ACC, name: 'Employer letter', createdBy: 'u' });
    await expect(AccountDocumentType.create({ accountId: ACC, name: 'EMPLOYER LETTER', createdBy: 'u' })).rejects.toThrow(/duplicate key/);
    await AccountDocumentType.create({ accountId: `acc_${'2'.repeat(28)}`, name: 'Employer letter', createdBy: 'u' }); // another account may
  });
});