import type { Request, RequestHandler } from 'express';
import { env } from '../config/env.js';
import { cfgNum } from '../config/cfg.js';
import { AppError } from '../lib/errors.js';
import { hitCounter } from '../lib/rateCounter.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';
import { ACCESS_COOKIE } from '../modules/auth/cookies.js';
import { loadSessionContext } from '../modules/auth/sessions.service.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cookie-authenticated browsers must send an Origin we serve (CSRF defence). Apps use a Bearer token,
 * which a third-party page cannot attach, so they are not checked.
 */
export function assertTrustedOrigin(req: Request) {
  if (SAFE_METHODS.has(req.method)) return;
  const origin = req.get('origin');
  if (!origin || !env.CORS_ORIGINS.includes(origin)) throw AppError.forbidden();
}

/**
 * Web: HttpOnly cookie. Apps: "Authorization: Bearer". Every request re-checks the session (ended, idle
 * CFG-07, longest CFG-08), the user's status, the account's status and the subscription (P-02 backend
 * rules), then applies the per-user limit CFG-99 (NFR-07).
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const bearer = req.get('authorization')?.match(/^Bearer ([A-Za-z0-9._-]+)$/)?.[1];
  const token = bearer ?? (req.cookies?.[ACCESS_COOKIE] as string | undefined);
  if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'GEN-09');
  if (!bearer) assertTrustedOrigin(req);

  const claims = verifyAccessToken(token);
  req.auth = await loadSessionContext(claims.sid, claims.sub, bearer ? 'APP' : 'WEB');

  const { count, secondsLeft } = await hitCounter(`rl:user:${req.auth.userId}`, 60);
  if (count > cfgNum('CFG-99')) throw new AppError(429, 'RATE_LIMITED', 'GEN-15', { seconds: secondsLeft });
  next();
};

/** CFG-10: registration and login requests per IP address per hour (GEN-15). */
export const authIpLimit: RequestHandler = async (req, _res, next) => {
  const { count, secondsLeft } = await hitCounter(`rl:auth-ip:${req.ip}`, 3600);
  if (count > cfgNum('CFG-10')) throw new AppError(429, 'RATE_LIMITED', 'GEN-15', { seconds: secondsLeft });
  next();
};
