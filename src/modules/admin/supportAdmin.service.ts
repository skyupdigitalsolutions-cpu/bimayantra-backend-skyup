/**
 * Change #56: support access from the SkyUp side (SS-01 to SS-03), on the existing P-57 rules.
 *  - The grants list: Staff see the grants given to them; Admins see every grant (who has access to which account).
 *  - "Open account (read only)": a few summary sections of the advisor's account, each read checked against an
 *    active grant on the request and logged for the advisor (AC-P57-1/2/3). A refused attempt is logged too.
 *  - "End my session": the SkyUp person ends their own grant early.
 * Nothing here changes client data; the full Aadhaar or PAN reveal is never available to support.
 */
import type { Request } from 'express';
import { clock } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { audit } from '../audit/audit.service.js';
import { CustomerDocument } from '../documents/document.model.js';
import { Lead } from '../leads/lead.model.js';
import { Quotation } from '../quotations/quotation.model.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { User } from '../users/user.model.js';
import { Account } from '../accounts/account.model.js';
import { SupportGrant, type GrantDoc } from './admin.model.js';
import { underGrant } from './admin.service.js';

const statusOf = (g: Pick<GrantDoc, 'status' | 'endsAt'>) => (g.status === 'ACTIVE' && g.endsAt <= clock.now() ? 'EXPIRED' : g.status);
/** The sections a grant opens (SS-02 tabs). */
export const SUPPORT_SECTIONS = ['quotations', 'customers', 'leads', 'documents'] as const;

export async function grantsForSkyUp(ctx: AuthContext, q: { status?: 'ACTIVE' | 'ENDED' | 'EXPIRED' }) {
  const filter: Record<string, unknown> = ctx.role === 'ADM' ? {} : { granteeUserId: ctx.userId };
  const now = clock.now();
  if (q.status === 'ACTIVE') Object.assign(filter, { status: 'ACTIVE', endsAt: { $gt: now } });
  else if (q.status === 'EXPIRED') Object.assign(filter, { $or: [{ status: 'EXPIRED' }, { status: 'ACTIVE', endsAt: { $lte: now } }] });
  else if (q.status === 'ENDED') filter.status = 'ENDED';
  const rows = await SupportGrant.find(filter).sort({ createdAt: -1 }).limit(500).lean<GrantDoc[]>();
  const people = await User.find({ $or: [{ _id: { $in: rows.map((r) => r.granteeUserId) } }, { accountId: { $in: rows.map((r) => r.accountId) }, role: 'ADV' }] }, { name: 1, accountId: 1, role: 1 }).lean<Array<{ _id: string; name: string; accountId: string | null; role: string }>>();
  const accs = new Map((await Account.find({ _id: { $in: rows.map((r) => r.accountId) } }, { 'profile.business.displayName': 1 }).lean<Array<{ _id: string; profile?: { business?: { displayName?: string | null } } }>>()).map((a) => [a._id, a.profile?.business?.displayName ?? null]));
  const name = (id: string) => people.find((p) => p._id === id)?.name ?? '';
  const advisor = (acc: string) => people.find((p) => p.accountId === acc && p.role === 'ADV')?.name ?? '';
  return rows.map((r) => ({
    id: r._id, accountId: r.accountId, advisor: advisor(r.accountId), business: accs.get(r.accountId) ?? null, to: name(r.granteeUserId), mine: r.granteeUserId === ctx.userId,
    reason: r.reason, status: statusOf(r), startsAt: r.startsAt, endsAt: r.endsAt, endedAt: r.endedAt ?? null, endedBy: (r as { endedBy?: string | null }).endedBy ?? null, recordsOpened: r.log?.length ?? 0,
  }));
}

/** "End my session": only the person the grant was given to, only while it is active. */
export async function endMySession(ctx: AuthContext, id: string, req: Request) {
  const g = await SupportGrant.findOneAndUpdate({ _id: id, granteeUserId: ctx.userId, status: 'ACTIVE' }, { $set: { status: 'ENDED', endedAt: clock.now(), endedBy: 'GRANTEE' } }, { new: true }).lean<GrantDoc>();
  if (!g) {
    if (!(await SupportGrant.exists({ _id: id, granteeUserId: ctx.userId }))) throw AppError.notFound();
    throw AppError.invalidState('support access', 'not active');
  }
  await audit({ entity: 'support', entityId: id, action: 'SUPPORT_GRANT_ENDED_BY_SKYUP', after: { accountId: g.accountId } }, { req });
  const adv = await User.findOne({ accountId: g.accountId, role: 'ADV' }, { name: 1 }).lean<{ name: string }>();
  return { grant: { id: g._id, status: 'ENDED', endedAt: g.endedAt }, params: { advisor: adv?.name ?? 'the advisor' } };
}

/** The banner of the read-only view: whose account, until when, and which sections. Checks the grant first. */
export async function supportOverview(ctx: AuthContext, accountId: string, req: Request) {
  await underGrant(ctx, accountId, 'Account opened', null, req);
  const g = await SupportGrant.findOne({ accountId, granteeUserId: ctx.userId, status: 'ACTIVE', endsAt: { $gt: clock.now() } }).lean<GrantDoc>();
  const adv = await User.findOne({ accountId, role: 'ADV' }, { name: 1 }).lean<{ name: string }>();
  return { accountId, advisor: adv?.name ?? '', grant: g ? { id: g._id, reason: g.reason, until: g.endsAt } : null, readOnly: true, sections: SUPPORT_SECTIONS };
}

export async function supportLeads(ctx: AuthContext, accountId: string, req: Request) {
  await underGrant(ctx, accountId, 'Lead list', null, req);
  const rows = await Lead.find({ accountId }, { number: 1, name: 1, status: 1, source: 1, createdAt: 1 }).sort({ createdAt: -1 }).limit(500).lean<Array<{ _id: string; number: string; name: string; status: string; source: string; createdAt: Date }>>();
  return rows.map((l) => ({ id: l._id, number: l.number, name: l.name, status: l.status, source: l.source, createdAt: l.createdAt }));
}

export async function supportQuotations(ctx: AuthContext, accountId: string, req: Request) {
  await underGrant(ctx, accountId, 'Quotation list', null, req);
  const rows = await Quotation.find({ accountId }, { number: 1, status: 1, customerId: 1, updatedAt: 1, revisions: { $slice: -1 } }).sort({ updatedAt: -1 }).limit(500).lean<Array<{ _id: string; number: string; status: string; customerId: string; updatedAt: Date; revisions?: Array<{ snapshot?: { product?: { name?: string }; breakdown?: { final?: number } } }> }>>();
  return rows.map((q) => ({ id: q._id, number: q.number, status: q.status, customerId: q.customerId, product: q.revisions?.[0]?.snapshot?.product?.name ?? null, premium: q.revisions?.[0]?.snapshot?.breakdown?.final ?? null, updatedAt: q.updatedAt }));
}

/** Document names only (type, label, version, status): files and read values are not opened here. */
export async function supportDocuments(ctx: AuthContext, accountId: string, req: Request) {
  await underGrant(ctx, accountId, 'Document list', null, req);
  const rows = await CustomerDocument.find({ accountId }, { customerId: 1, type: 1, label: 1, version: 1, status: 1, createdAt: 1 }).sort({ createdAt: -1 }).limit(500).lean<Array<{ _id: string; customerId: string; type: string; label: string; version: number; status: string; createdAt: Date }>>();
  return rows.map((d) => ({ id: d._id, customerId: d.customerId, type: d.type, label: d.label, version: d.version, status: d.status, createdAt: d.createdAt }));
}