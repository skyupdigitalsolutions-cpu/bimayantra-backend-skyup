import type { CookieOptions, Request, Response } from 'express';
import { env } from '../../config/env.js';

/**
 * P-02 backend rules: web sessions use secure, HttpOnly cookies holding a short-lived access token and
 * a rotating refresh token. Mobile apps (Section 17A) send "X-Client: app" and receive the tokens in the
 * response body instead, for their secure storage.
 */
export const ACCESS_COOKIE = 'bm_at';
export const REFRESH_COOKIE = 'bm_rt';
const REFRESH_PATH = () => `${env.API_PREFIX}/auth`;

const base = (): CookieOptions => ({ httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'strict', ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}) });

export const clientOf = (req: Request): 'WEB' | 'APP' => (req.get('x-client')?.toLowerCase() === 'app' ? 'APP' : 'WEB');

export interface Tokens { accessToken: string; refreshToken: string; tokenType: 'Bearer'; expiresIn: number; sessionExpiresAt: Date }

/** Web: set cookies and return nothing. App: return the tokens. The access cookie lives as long as the
 *  session, so an expired JWT inside it reports TOKEN_EXPIRED and the client refreshes. */
export function deliverTokens(req: Request, res: Response, t: Tokens) {
  if (clientOf(req) === 'APP') return { tokens: t };
  const maxAge = Math.max(1000, t.sessionExpiresAt.getTime() - Date.now());
  res.cookie(ACCESS_COOKIE, t.accessToken, { ...base(), path: '/', maxAge });
  res.cookie(REFRESH_COOKIE, t.refreshToken, { ...base(), path: REFRESH_PATH(), maxAge });
  return {};
}

export function clearSessionCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, { ...base(), path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...base(), path: REFRESH_PATH() });
}
