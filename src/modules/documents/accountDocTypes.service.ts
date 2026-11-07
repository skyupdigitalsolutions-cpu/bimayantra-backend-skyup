import type { Request } from 'express';
import { AppError } from '../../lib/errors.js';
import { isDuplicateKey } from '../../lib/mongo.js';
import { audit } from '../audit/audit.service.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { AccountDocumentType } from './accountDocType.model.js';

/** Change #25: the account's saved "Other" document names, A–Z. */
export async function list(ctx: AuthContext) {
  return (await AccountDocumentType.find({ accountId: ctx.accountId }, { name: 1 }).collation({ locale: 'en', strength: 2 }).sort({ name: 1 }).lean<Array<{ _id: string; name: string }>>()).map((t) => ({ id: t._id, name: t.name }));
}
/** Save a name (any case counts as the same name; saving it again returns the existing one). */
export async function add(ctx: AuthContext, name: string, req: Request | null) {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (!clean) throw AppError.field('name', 'DOC-02');
  const found = await AccountDocumentType.findOne({ accountId: ctx.accountId, name: clean }).collation({ locale: 'en', strength: 2 }).lean<{ _id: string; name: string }>();
  if (found) return { id: found._id, name: found.name, created: false };
  try {
    const t = await AccountDocumentType.create({ accountId: ctx.accountId, name: clean, createdBy: ctx.userId });
    if (req) await audit({ entity: 'documentType', entityId: t._id, action: 'DOCUMENT_TYPE_SAVED', after: { name: clean } }, { req });
    return { id: t._id as string, name: clean, created: true };
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    const t = (await AccountDocumentType.findOne({ accountId: ctx.accountId, name: clean }).collation({ locale: 'en', strength: 2 }).lean<{ _id: string; name: string }>())!;
    return { id: t._id, name: t.name, created: false };
  }
}
/** For an "Other" upload: the saved type this name is (created first when asked to save it). */
export async function resolve(ctx: AuthContext, name: string, saveAsType: boolean, req: Request) {
  if (saveAsType) return (await add(ctx, name, req)).id;
  const found = await AccountDocumentType.findOne({ accountId: ctx.accountId, name: name.trim().replace(/\s+/g, ' ') }).collation({ locale: 'en', strength: 2 }).lean<{ _id: string }>();
  return found?._id ?? null;
}