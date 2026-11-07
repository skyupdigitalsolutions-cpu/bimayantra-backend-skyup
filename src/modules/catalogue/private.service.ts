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
import type { Request } from 'express';
import { AppError } from '../../lib/errors.js';
import { isDuplicateKey, withTx } from '../../lib/mongo.js';
import { audit } from '../audit/audit.service.js';
import { Insurer, type InsurerDoc } from '../insurers/insurer.model.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { InsuranceType, TemplateVersion, type InsuranceTypeDoc } from './types.model.js';

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

/** Step 1 "create a category": no SkyUp template; an empty live template is made with it (one transaction). */
export async function addCategory(ctx: AuthContext, b: { name: string }, req: Request) {
  const name = b.name.trim();
  try {
    return await withTx(async (session) => {
      const [t] = await InsuranceType.create([{ name, nameKey: name.toLowerCase(), ownerAccountId: ctx.accountId, status: 'ACTIVE' }], { session: session ?? undefined });
      const [tpl] = await TemplateVersion.create([{ typeId: t!._id, number: 1, status: 'ACTIVE', isOpen: null, features: [], factors: [], questions: [], makerId: ctx.userId, approvedAt: new Date() }], { session: session ?? undefined });
      await audit({ entity: 'insuranceType', entityId: t!._id, action: 'PRIVATE_CATEGORY_ADDED', after: { name } }, { req, session });
      return { id: t!._id, name: t!.name, private: true, template: { id: tpl!._id, number: 1 } };
    });
  } catch (e) {
    if (isDuplicateKey(e)) throw AppError.field('name', 'CAT-50', { name });
    throw e;
  }
}

/** Step 2 picker: the IRDAI library (ACTIVE) and this account's private insurers, searchable. */
export async function insurerChoices(ctx: AuthContext, q?: string) {
  const f: Record<string, unknown> = { status: 'ACTIVE', ...visibleTo(ctx.accountId) };
  if (q) f.nameKey = { $regex: q.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };
  const rows = await Insurer.find(f, { name: 1, category: 1, ownerAccountId: 1 }).sort({ name: 1 }).limit(200).lean<Array<Pick<InsurerDoc, '_id' | 'name' | 'category' | 'ownerAccountId'>>>();
  return rows.map((i) => ({ id: i._id, name: i.name, category: i.category ?? null, private: !!i.ownerAccountId }));
}