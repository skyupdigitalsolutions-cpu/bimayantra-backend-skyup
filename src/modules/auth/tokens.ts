import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';

const ALG = 'HS256' as const;

export interface AccessClaims { sub: string; sid: string; typ: 'access' }
export interface RefreshClaims { sub: string; sid: string; jti: string; typ: 'refresh' }

export const newJti = () => randomBytes(32).toString('base64url');
export const hashJti = (jti: string) => createHash('sha256').update(jti).digest('hex');

export const signAccessToken = (c: { sub: string; sid: string }) =>
  jwt.sign({ sid: c.sid, typ: 'access' }, env.JWT_ACCESS_SECRET, {
    algorithm: ALG, subject: c.sub, expiresIn: env.JWT_ACCESS_TTL_SECONDS, issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE,
  });

/** The refresh token lives no longer than its session (CFG-08). */
export const signRefreshToken = (c: { sub: string; sid: string; jti: string }, expiresInSeconds: number) =>
  jwt.sign({ sid: c.sid, typ: 'refresh' }, env.JWT_REFRESH_SECRET, {
    algorithm: ALG, subject: c.sub, jwtid: c.jti, expiresIn: Math.max(1, expiresInSeconds), issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE,
  });

function verify<T>(token: string, secret: string, typ: 'access' | 'refresh'): T {
  try {
    const d = jwt.verify(token, secret, { algorithms: [ALG], issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE }) as jwt.JwtPayload;
    if (d.typ !== typ || !d.sub || !d.sid) throw new Error('wrong token type');
    return d as T;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw new AppError(401, 'TOKEN_EXPIRED', 'GEN-09');
    throw new AppError(401, 'TOKEN_INVALID', 'GEN-09');
  }
}
export const verifyAccessToken = (t: string) => verify<AccessClaims>(t, env.JWT_ACCESS_SECRET, 'access');
export const verifyRefreshToken = (t: string) => verify<RefreshClaims>(t, env.JWT_REFRESH_SECRET, 'refresh');
