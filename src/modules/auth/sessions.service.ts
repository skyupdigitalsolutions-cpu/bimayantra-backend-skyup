import type { Request } from 'express';
import type { ClientSession } from 'mongoose';
import { cfgNum } from '../../config/cfg.js';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { clock, istDate } from '../../lib/clock.js';
import type { MessageId } from '../../lib/messages.js';
import { Account } from '../accounts/account.model.js';
import { effectiveStatus } from '../accounts/subscription.js';
import { User, type Role } from '../users/user.model.js';
import { capabilitiesOf, type AuthContext } from '../rbac/capabilities.js';
import { audit } from '../audit/audit.service.js';
import { Session, type EndReason } from './session.model.js';
import { hashJti, newJti, signAccessToken, signRefreshToken, verifyRefreshToken } from './tokens.js';
import type { Tokens } from './cookies.js';

const ROTATION_GRACE_MS = 10_000; // two parallel refreshes from one app must not look like token theft
const TOUCH_EVERY_MS = 30_000;    // last-active precision for the idle rule (CFG-07)
const idleMs = () => cfgNum('CFG-07') * 60_000;

/** "Chrome on Windows" (P-03: device names come from the browser and may be general). */
export function deviceName(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';
  if (/okhttp/i.test(ua)) return 'Bimayantra Android app';
  if (/CFNetwork|Darwin/i.test(ua) && !/Safari/i.test(ua)) return 'Bimayantra iOS app';
  const browser = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /curl\//i.test(ua) ? 'curl' : /node|undici|supertest/i.test(ua) ? 'API client' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

const disabledMessage = (role: Role): MessageId => (role === 'STF' || role === 'ADM' ? 'AUTH-19' : 'AUTH-11');

/** The message a device sees on its next action after its session ended (P-03). */
function endedError(reason: EndReason | null | undefined, role?: Role) {
  const id: MessageId = reason === 'SUPERSEDED' ? 'AUTH-17'
    : reason === 'IDLE' || reason === 'EXPIRED' ? 'AUTH-18'
      : reason === 'LOGOUT' ? 'AUTH-16'
        : reason === 'ACCOUNT_SUSPENDED' ? 'AUTH-10'
          : reason === 'USER_DISABLED' && role ? disabledMessage(role)
            : 'GEN-09';
  return new AppError(401, 'SESSION_ENDED', id, {}, { reason: reason ?? 'UNKNOWN' });
}

export async function endSessions(filter: Record<string, unknown>, reason: EndReason, session: ClientSession | null = null): Promise<number> {
  const r = await Session.updateMany({ ...filter, endedAt: null }, { $set: { endedAt: clock.now(), endReason: reason } }, { session: session ?? undefined });
  return r.modifiedCount;
}

/**
 * Starts a session (P-02 step 5). Sessions that are already idle or past CFG-08 are closed first; then, if
 * the user already has CFG-09 live sessions, the oldest ends (SUPERSEDED → that device sees AUTH-17).
 */
export async function startSession(userId: string, req: Request, client: 'WEB' | 'APP', session: ClientSession | null) {
  const now = clock.now();
  const open = await Session.find({ userId, endedAt: null }).sort({ startedAt: 1 }).session(session).lean();
  const live: string[] = [];
  for (const s of open) {
    if (s.expiresAt <= now) await endSessions({ _id: s._id }, 'EXPIRED', session);
    else if (now.getTime() - s.lastActiveAt.getTime() > idleMs()) await endSessions({ _id: s._id }, 'IDLE', session);
    else live.push(s._id);
  }
  const surplus = live.length - (cfgNum('CFG-09') - 1);
  if (surplus > 0) await endSessions({ _id: { $in: live.slice(0, surplus) } }, 'SUPERSEDED', session);

  const jti = newJti();
  const doc = await new Session({
    userId, client, device: deviceName(req.get('user-agent')), userAgent: req.get('user-agent')?.slice(0, 512) ?? null, ip: req.ip ?? null,
    refreshJtiHash: hashJti(jti), startedAt: now, lastActiveAt: now, expiresAt: new Date(now.getTime() + cfgNum('CFG-08') * 3_600_000),
  }).save({ session: session ?? undefined });
  return { sessionId: doc._id, jti, expiresAt: doc.expiresAt };
}

export function issueTokens(userId: string, sessionId: string, jti: string, sessionExpiresAt: Date): Tokens {
  const secondsLeft = Math.ceil((sessionExpiresAt.getTime() - clock.nowMs()) / 1000);
  return {
    accessToken: signAccessToken({ sub: userId, sid: sessionId }),
    refreshToken: signRefreshToken({ sub: userId, sid: sessionId, jti }, secondsLeft),
    tokenType: 'Bearer',
    expiresIn: env.JWT_ACCESS_TTL_SECONDS,
    sessionExpiresAt,
  };
}

/**
 * Everything a request needs to know about its caller, re-checked on EVERY request (P-02 backend rules):
 * session not ended, not idle (CFG-07), not past CFG-08; user ACTIVE; account ACTIVE; current subscription.
 */
export async function loadSessionContext(sid: string, userId: string, client: 'WEB' | 'APP', touch = true): Promise<AuthContext> {
  const [s, user] = await Promise.all([Session.findById(sid).lean(), User.findById(userId).lean()]);
  if (!s || !user || s.userId !== userId) throw endedError(null);
  if (s.endedAt) throw endedError(s.endReason, user.role as Role);

  const now = clock.now();
  if (s.expiresAt <= now) { await endSessions({ _id: sid }, 'EXPIRED'); throw endedError('EXPIRED'); }
  if (now.getTime() - s.lastActiveAt.getTime() > idleMs()) { await endSessions({ _id: sid }, 'IDLE'); throw endedError('IDLE'); }
  if (user.status !== 'ACTIVE') { await endSessions({ userId }, 'USER_DISABLED'); throw endedError('USER_DISABLED', user.role as Role); }

  let subscription: AuthContext['subscription'] = null;
  if (user.accountId) {
    const account = await Account.findById(user.accountId, { status: 1, closedAt: 1, subscription: 1 }).lean();
    if (!account) throw endedError(null);
    if (account.status === 'SUSPENDED') { await endSessions({ userId }, 'ACCOUNT_SUSPENDED'); throw endedError('ACCOUNT_SUSPENDED'); }
    if (account.status === 'CLOSED') {
      throw new AppError(401, 'SESSION_ENDED', 'AUTH-14', { date: account.closedAt ? istDate(account.closedAt.toISOString().slice(0, 10)) : '' });
    }
    const sub = account.subscription!;
    subscription = { status: effectiveStatus(sub, now), plan: (sub.plan ?? null) as 'NORMAL' | 'PREMIUM' | null, endsAt: sub.endsAt };
  }
  if (touch && now.getTime() - s.lastActiveAt.getTime() > TOUCH_EVERY_MS) {
    await Session.updateOne({ _id: sid, endedAt: null }, { $set: { lastActiveAt: now } });
  }
  const role = user.role as Role;
  return {
    userId, sessionId: sid, role, name: user.name, mobile: user.mobile, accountId: user.accountId ?? null, client,
    subscription, readOnly: subscription?.status === 'EXPIRED', capabilities: capabilitiesOf(role),
  };
}

/**
 * Refresh-token rotation with reuse detection. Only the holder of the current token can rotate; an old
 * token replayed outside a short grace window ends the session (theft). Refreshing is not "activity" for
 * the idle rule, so a tab left open does not stay signed in forever.
 */
export async function rotateRefresh(refreshToken: string, req: Request): Promise<{ tokens: Tokens; ctx: AuthContext }> {
  const claims = verifyRefreshToken(refreshToken);
  const presented = hashJti(claims.jti);
  const next = newJti();
  const now = clock.now();
  const rotated = await Session.findOneAndUpdate(
    { _id: claims.sid, userId: claims.sub, refreshJtiHash: presented, endedAt: null },
    { $set: { refreshJtiHash: hashJti(next), previousJtiHash: presented, rotatedAt: now } },
    { new: true },
  ).lean();
  if (rotated) {
    const ctx = await loadSessionContext(rotated._id, rotated.userId, rotated.client as 'WEB' | 'APP', false);
    return { tokens: issueTokens(rotated.userId, rotated._id, next, rotated.expiresAt), ctx };
  }
  const s = await Session.findOne({ _id: claims.sid, userId: claims.sub }).lean();
  if (!s || s.endedAt) throw endedError(s?.endReason);
  if (s.previousJtiHash === presented && s.rotatedAt && now.getTime() - s.rotatedAt.getTime() < ROTATION_GRACE_MS) {
    throw new AppError(401, 'TOKEN_INVALID', 'GEN-09', {}, { retryWithLatest: true });
  }
  await endSessions({ _id: s._id }, 'REFRESH_REUSE');
  await audit({ entity: 'session', entityId: s._id, action: 'REFRESH_REUSE_DETECTED', result: 'REFUSED', actor: { userId: s.userId, role: null, accountId: null } }, { req });
  throw new AppError(401, 'REFRESH_TOKEN_REUSED', 'GEN-09');
}

export async function listSessions(ctx: AuthContext) {
  const now = clock.now();
  const sessions = await Session.find({ userId: ctx.userId, endedAt: null, expiresAt: { $gt: now }, lastActiveAt: { $gt: new Date(now.getTime() - idleMs()) } })
    .sort({ lastActiveAt: -1 }).lean();
  return sessions.map((s) => ({ id: s._id, device: s.device, client: s.client, ip: s.ip, startedAt: s.startedAt, lastActiveAt: s.lastActiveAt, current: s._id === ctx.sessionId }));
}
