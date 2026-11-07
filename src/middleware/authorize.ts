import type { RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';
import { CLIENT_DATA, can, type AuthContext, type Capability } from '../modules/rbac/capabilities.js';
import { audit } from '../modules/audit/audit.service.js';

/**
 * Capability gate (Section 3.2). Always after authenticate. Controls the user may not use are hidden on
 * screen; the API still refuses them (GR-18). SkyUp users trying to open client data get SUP-03 and the
 * attempt is logged (P-57 step 4).
 */
export const allow = (cap: Capability): RequestHandler => async (req, _res, next) => {
  const ctx = req.auth;
  if (!ctx) throw new AppError(401, 'UNAUTHENTICATED', 'GEN-09');
  if (can(ctx.role, cap)) return next();
  if ((ctx.role === 'STF' || ctx.role === 'ADM') && CLIENT_DATA.has(cap)) {
    await audit({ entity: 'client_data', action: 'SUPPORT_ACCESS_REFUSED', result: 'REFUSED', after: { path: req.originalUrl } }, { req });
    throw new AppError(403, 'SUPPORT_GRANT_REQUIRED', 'SUP-03');
  }
  throw AppError.forbidden();
};

/** GR-33 read-only mode: an EXPIRED subscription cannot create, edit or send (SUB-03). */
export const writable: RequestHandler = (req, _res, next) => {
  if (req.auth?.readOnly) throw new AppError(403, 'READ_ONLY', 'SUB-03');
  next();
};

/** The signed-in user's account. Every advisor-owned query filters on it (GR-20). */
export function accountOf(ctx: AuthContext): string {
  if (!ctx.accountId) throw AppError.forbidden();
  return ctx.accountId;
}
