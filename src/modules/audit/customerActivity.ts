import { AppError } from '../../lib/errors.js';
import { pageMeta, pageSize } from '../../lib/pagination.js';
import { accountOf } from '../../middleware/authorize.js';
import { Consent, Customer, CustomerLink, FamilyMember } from '../customers/customer.model.js';
import { CustomerDocument } from '../documents/document.model.js';
import { Payment } from '../payments/payment.model.js';
import { Policy } from '../policies/policy.model.js';
import { Proposal } from '../proposals/proposal.model.js';
import { Comparison } from '../quotations/comparisons.service.js';
import { Quotation } from '../quotations/quotation.model.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { RenewalCycle } from '../renewals/renewal.model.js';
import { User } from '../users/user.model.js';
import { Vehicle } from '../vehicles/vehicle.model.js';
import { AuditLog } from './audit.model.js';
import { maskIp } from './audit.service.js';

type Ids = Array<{ _id: string }>;

/**
 * B-05 / B-06 · Everything that happened around one customer, newest first: the customer record, family members,
 * documents, consents, vehicles, quotations, proposals, policies, payments, renewals and comparisons.
 * Audit entries point at a record by its own ID, so the IDs of the customer's records are collected first.
 * `values: false` (assistants, SkyUp staff) returns who/when/what only, without old and new values (P-50 metadata rule).
 */
export async function customerActivity(ctx: AuthContext, customerId: string, q: { page: number; limit?: number }, opts: { values: boolean }) {
  // SkyUp staff have no account of their own: the customer decides the account. An advisor or assistant only ever sees their own.
  const own = ctx.role === 'ADV' || ctx.role === 'AST';
  const customer = await Customer.findOne({ _id: customerId, ...(own ? { accountId: accountOf(ctx) } : {}) }, { accountId: 1, number: 1 }).lean<{ _id: string; accountId: string; number: string }>();
  if (!customer) throw AppError.notFound();
  const accountId = customer.accountId;
  const byCustomer = { accountId, customerId };
  const [family, docs, vehicles, quotes, proposals, policies, renewals, comparisons, consents, links] = await Promise.all([
    FamilyMember.find(byCustomer, { _id: 1 }).lean<Ids>(),
    CustomerDocument.find(byCustomer, { _id: 1 }).lean<Ids>(),
    Vehicle.find(byCustomer, { _id: 1 }).lean<Ids>(),
    Quotation.find(byCustomer, { _id: 1 }).lean<Ids>(),
    Proposal.find(byCustomer, { _id: 1 }).lean<Ids>(),
    Policy.find(byCustomer, { _id: 1 }).lean<Ids>(),
    RenewalCycle.find(byCustomer, { _id: 1 }).lean<Ids>(),
    Comparison.find(byCustomer, { _id: 1 }).lean<Ids>(),
    Consent.find(byCustomer, { _id: 1 }).lean<Ids>(),
    CustomerLink.find({ accountId, $or: [{ customerId }, { linkedCustomerId: customerId }] }, { _id: 1 }).lean<Ids>(),
  ]);
  const payments = await Payment.find({ accountId, quotationId: { $in: quotes.map((x) => x._id) } }, { _id: 1 }).lean<Ids>();
  const entityIds = [customerId, ...[family, docs, vehicles, quotes, proposals, policies, renewals, comparisons, consents, links, payments].flatMap((rows) => rows.map((r) => r._id))];
  const filter = { accountId, entityId: { $in: entityIds } };
  const limit = pageSize(q.limit);
  const [items, total] = await Promise.all([
    AuditLog.find(filter).sort({ at: -1, _id: -1 }).skip((q.page - 1) * limit).limit(limit).lean(),
    AuditLog.countDocuments(filter),
  ]);
  const names = new Map((await User.find({ _id: { $in: [...new Set(items.map((i) => i.actorUserId).filter(Boolean))] } }, { name: 1 }).lean<Array<{ _id: string; name: string }>>()).map((u) => [u._id, u.name]));
  return {
    items: items.map((i) => ({
      id: String(i._id), at: i.at, actorUserId: i.actorUserId, actorName: i.actorUserId ? names.get(i.actorUserId) ?? null : i.actorLabel, actorRole: i.actorRole,
      entity: i.entity, entityId: i.entityId, entityRef: i.entityRef, action: i.action, result: i.result,
      ip: maskIp(i.ip as string | null), device: (i as { device?: string | null }).device ?? null,
      ...(opts.values ? { before: i.before, after: i.after } : {}),
    })),
    meta: pageMeta(q.page, limit, total),
  };
}