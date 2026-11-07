import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { allow } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { pageMeta, pageQuery, pageSize } from '../../lib/pagination.js';
import { sendData } from '../../lib/response.js';
import { User } from '../users/user.model.js';
import { AuditLog } from './audit.model.js';
import { requireStepUp } from '../auth/stepUp.js';
import { audit, maskIp } from './audit.service.js';
import { customerActivity } from './customerActivity.js';

const query = z.object({
  ...pageQuery,
  accountId: z.string().regex(/^acc_[a-f0-9]{28}$/).optional(),
  actorUserId: z.string().regex(/^usr_[a-f0-9]{28}$/).optional(),
  entity: z.string().max(40).optional(),
  entityId: z.string().max(60).optional(),
  /** B-05: everything around one customer (family, documents, consents, vehicles, quotations, proposals, policies, payments, renewals). */
  customerId: z.string().regex(/^cus_[a-f0-9]{28}$/).optional(),
  action: z.string().max(60).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

/**
 * P-50 (view part; CSV export with OTP is not built yet). ADV sees their own account only; ADM sees all;
 * STF sees metadata only (no old/new values). Personal data was masked when the entry was written.
 */
export function auditRoutes() {
  const r = Router();
  r.get('/', authenticate, allow('audit.view'), validate({ query }), async (req, res) => {
    const q = res.locals.query as z.infer<typeof query>;
    const ctx = req.auth!;
    if (q.customerId) {
      const out = await customerActivity(ctx, q.customerId, q, { values: ctx.role !== 'STF' });
      return sendData(res, out.items, 200, out.meta);
    }
    const filter: Record<string, unknown> = {};
    if (ctx.role === 'ADV') filter.accountId = ctx.accountId;
    else if (q.accountId) filter.accountId = q.accountId;
    for (const k of ['actorUserId', 'entity', 'entityId', 'action'] as const) if (q[k]) filter[k] = q[k];
    if (q.from || q.to) filter.at = { ...(q.from ? { $gte: new Date(q.from) } : {}), ...(q.to ? { $lte: new Date(q.to) } : {}) };
    const limit = pageSize(q.limit);
    const [items, total] = await Promise.all([
      AuditLog.find(filter).sort({ at: -1, _id: -1 }).skip((q.page - 1) * limit).limit(limit).lean(),
      AuditLog.countDocuments(filter),
    ]);
    const names = new Map((await User.find({ _id: { $in: [...new Set(items.map((i) => i.actorUserId).filter(Boolean))] } }, { name: 1 }).lean()).map((u) => [u._id, u.name]));
    sendData(res, items.map((i) => ({
      id: String(i._id), at: i.at, accountId: i.accountId, actorUserId: i.actorUserId, actorName: i.actorUserId ? names.get(i.actorUserId) ?? null : i.actorLabel,
      actorRole: i.actorRole, entity: i.entity, entityId: i.entityId, entityRef: i.entityRef, action: i.action, result: i.result, requestId: i.requestId,
      ip: maskIp(i.ip as string | null), device: (i as { device?: string | null }).device ?? null,
      ...(ctx.role === 'STF' ? {} : { before: i.before, after: i.after }),
    })), 200, pageMeta(q.page, limit, total));
  });
  r.get('/export', authenticate, allow('audit.export'), requireStepUp, validate({ query }), async (req, res) => {
    const q = res.locals.query as z.infer<typeof query>;
    const filter: Record<string, unknown> = {};
    if (q.accountId) filter.accountId = q.accountId;
    for (const k of ['actorUserId', 'entity', 'entityId', 'action'] as const) if (q[k]) filter[k] = q[k];
    if (q.from || q.to) filter.at = { ...(q.from ? { $gte: new Date(q.from) } : {}), ...(q.to ? { $lte: new Date(q.to) } : {}) };
    const items = await AuditLog.find(filter).sort({ at: -1 }).limit(50_000).lean();
    const esc = (v: unknown) => { const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const cols = ['at', 'accountId', 'actorUserId', 'actorRole', 'entity', 'entityId', 'entityRef', 'action', 'result', 'before', 'after'] as const;
    const body = [cols.join(','), ...items.map((i) => cols.map((c) => esc(c === 'at' ? (i.at as Date).toISOString() : (i as Record<string, unknown>)[c])).join(','))].join('\n');
    await audit({ entity: 'audit', action: 'AUDIT_EXPORTED', after: { filter, rows: items.length } }, { req });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audit.csv"');
    res.end(body);
  });
  return r;
}