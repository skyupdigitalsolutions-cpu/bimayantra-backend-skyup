import type { Request, Response } from 'express';
import { cfgList, cfgNum } from '../../config/cfg.js';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { clock, istDate, istToday } from '../../lib/clock.js';
import { newId } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';
import { msg, type MessageId, type MessageParams } from '../../lib/messages.js';
import { USER_MOBILE_INDEX } from '../users/user.model.js';
import { isDuplicateKey, transactionsSupported, withTx } from '../../lib/mongo.js';
import { maskMobile } from '../../lib/phone.js';
import { Account } from '../accounts/account.model.js';
import { audit } from '../audit/audit.service.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { ROLE_LABEL, User, type Role, type UserDoc } from '../users/user.model.js';
import { assertTrustedOrigin } from '../../middleware/authenticate.js';
import { ACCESS_COOKIE, REFRESH_COOKIE, clearSessionCookies, clientOf, deliverTokens } from './cookies.js';
import { checkOtp, consumeOtp, createGrant, findGrant, issueOtp, useGrant } from './otp.service.js';
import { Session } from './session.model.js';
import { endSessions, issueTokens, listSessions, loadSessionContext, rotateRefresh, startSession } from './sessions.service.js';
import { sendSms } from './sms.js';
import { verifyAccessToken, verifyRefreshToken } from './tokens.js';
import type { OtpChallengeDoc } from './otp.model.js';

export interface Outcome<T> { data: T; messageId?: MessageId | null; params?: MessageParams }

const DAY = 86_400_000;

/**
 * Trial: from the first subscription-end reminder (largest CFG-80 value) until it ends (SUB-04). Grace: always (SUB-05).
 * Ended (read-only): always (SUB-03). An active paid plan shows nothing here; its reminders go by message.
 */
function subscriptionBanner(status: string, daysLeft: number, endsAt: Date | string, graceUntil: Date | null, readOnly: boolean) {
  const dmy = (d: Date | string) => istDate(istToday(new Date(d))); // DD-MM-YYYY in IST
  if (readOnly || status === 'EXPIRED') return { tone: 'EXPIRED', messageId: 'SUB-03', message: msg('SUB-03') };
  if (status === 'GRACE' && graceUntil) {
    const days = Math.max(0, Math.ceil((graceUntil.getTime() - clock.nowMs()) / DAY));
    return { tone: 'GRACE', messageId: 'SUB-05', message: msg('SUB-05', { date: dmy(endsAt), days }) };
  }
  const first = Math.max(0, ...(cfgList('CFG-80') as unknown[]).map(Number).filter((n) => Number.isFinite(n)));
  if (status === 'TRIAL' && daysLeft <= first) return { tone: 'TRIAL', messageId: 'SUB-04', message: msg('SUB-04', { days: daysLeft }) };
  return null;
}

/** The signed-in user as every client sees them: who they are and what they may do right now. */
export async function me(ctx: AuthContext) {
  const account = ctx.accountId ? await Account.findById(ctx.accountId, { profile: 1, subscription: 1 }).lean() : null;
  const advisor = ctx.role === 'AST' || ctx.role === 'REF' ? await User.findOne({ accountId: ctx.accountId, role: 'ADV' }, { name: 1 }).lean() : null;
  const sub = ctx.subscription;
  const daysLeft = sub ? Math.max(0, Math.ceil((new Date(sub.endsAt).getTime() - clock.nowMs()) / DAY)) : 0;
  const graceUntil = sub?.status === 'GRACE' ? new Date(new Date(sub.endsAt).getTime() + cfgNum('CFG-79') * DAY) : null;
  return {
    id: ctx.userId,
    name: ctx.name,
    mobile: ctx.mobile,
    maskedMobile: maskMobile(ctx.mobile),
    role: ctx.role,
    roleLabel: ROLE_LABEL[ctx.role],
    accountId: ctx.accountId,
    advisorName: advisor?.name ?? null,
    sessionId: ctx.sessionId,
    capabilities: ctx.capabilities,
    readOnly: ctx.readOnly,
    subscription: sub && account ? {
      status: sub.status,
      storedStatus: account.subscription!.status,
      plan: sub.plan,
      endsAt: sub.endsAt,
      daysLeft,
      graceUntil,
      // A7–A9: the banner the web console shows on every page, worded here so every client says the same.
      banner: subscriptionBanner(sub.status, daysLeft, sub.endsAt, graceUntil, ctx.readOnly),
    } : null,
    profile: account ? { kycStatus: account.profile!.kycStatus, completionPct: account.profile!.completionPct } : null,
  };
}

async function signedIn(userId: string, s: { sessionId: string; jti: string; expiresAt: Date }, req: Request, res: Response) {
  const tokens = issueTokens(userId, s.sessionId, s.jti, s.expiresAt);
  const ctx = await loadSessionContext(s.sessionId, userId, clientOf(req), false);
  const notices = ctx.readOnly ? [{ messageId: 'SUB-03', message: msg('SUB-03') }] : [];
  return { user: await me(ctx), notices, ...deliverTokens(req, res, tokens) };
}

// ── P-01 Register as an advisor ──────────────────────────────────────────────

export const sendRegisterOtp = (b: { name: string; mobile: string; email?: string | null }, req: Request) =>
  issueOtp({ mobile: b.mobile, purpose: 'REGISTER', pendingName: b.name, pendingEmail: b.email ?? null, termsVersion: env.TERMS_VERSION }, req);

/**
 * P-01 step 5. (a) new number: account, advisor user, empty profile, TRIAL (CFG-78, no plan), wallet ₹0 and
 * the CFG-169 pipelines are created together, in one transaction, and a session starts (AUTH-15);
 * (b) an advisor's number: signs that advisor in and ignores the typed name (AUTH-07);
 * (c) any other role's number: nothing is created (AUTH-08).
 */
export async function verifyRegister(b: { mobile: string; code: string }, req: Request, res: Response): Promise<Outcome<unknown>> {
  const ch = await checkOtp({ mobile: b.mobile, purpose: 'REGISTER', code: b.code }, req);
  const existing = await User.findOne({ mobile: b.mobile }).lean<UserDoc>();
  if (existing && existing.role !== 'ADV') {
    await consumeOtp(ch, null);
    await audit({ entity: 'account', action: 'REGISTRATION_REFUSED', result: 'REFUSED', after: { reason: 'MOBILE_USED_BY_OTHER_ROLE', mobile: b.mobile } }, { req });
    throw new AppError(409, 'MOBILE_IN_USE', 'AUTH-08');
  }
  if (existing) return signInExisting(existing, ch, req, res, 'AUTH-07');

  const now = clock.now();
  let accountId: string | null = null;
  try {
    const created = await withTx(async (session) => {
      await consumeOtp(ch, session);
      const account = await new Account({
        subscription: { plan: null, status: 'TRIAL', startsAt: now, endsAt: new Date(now.getTime() + cfgNum('CFG-78') * DAY) },
        wallet: { balancePaise: 0 },
        profile: { termsVersion: ch.termsVersion ?? env.TERMS_VERSION, termsAcceptedAt: now, ...(ch.pendingEmail ? { contact: { email: ch.pendingEmail } } : {}) },
        pipelines: cfgList('CFG-169').map((name, i) => ({ _id: newId('pip'), name, position: i + 1 })),
      }).save({ session: session ?? undefined });
      accountId = account._id;
      const user = await new User({ accountId: account._id, role: 'ADV', name: ch.pendingName, mobile: b.mobile, email: ch.pendingEmail ?? null, status: 'ACTIVE', activatedAt: now, lastLoginAt: now }).save({ session: session ?? undefined });
      const s = await startSession(user._id, req, clientOf(req), session);
      await audit({
        entity: 'account', entityId: account._id, action: 'ACCOUNT_CREATED',
        after: { advisorUserId: user._id, subscription: 'TRIAL', trialEndsAt: account.subscription!.endsAt, pipelines: account.pipelines.map((p) => p.name), termsVersion: account.profile!.termsVersion },
        actor: { userId: user._id, role: 'ADV', accountId: account._id },
      }, { req, session });
      return { user, s };
    });
    return { data: { outcome: 'CREATED', ...(await signedIn(created.user._id, created.s, req, res)) }, messageId: 'AUTH-15', params: { name: created.user.name } };
  } catch (err) {
    // Standalone MongoDB: undo the half-made account so "if any insert fails, none exist" still holds.
    if (!transactionsSupported() && accountId) await Account.deleteOne({ _id: accountId }).catch(() => undefined);
    // Only the unique mobile rule means "a parallel request already registered this number" (GEN-06).
    // Any other unique index is a real problem (for example a leftover index from an older schema): let it
    // surface as GEN-99 with a reference instead of disguising it as a double submit.
    if (isDuplicateKey(err, USER_MOBILE_INDEX)) throw new AppError(409, 'ALREADY_SUBMITTED', 'GEN-06');
    throw err;
  }
}

// ── P-02 Log in with mobile OTP ──────────────────────────────────────────────

export async function sendLoginOtp(b: { mobile: string }, req: Request) {
  const user = await User.findOne({ mobile: b.mobile }, { _id: 1 }).lean();
  if (!user) throw new AppError(404, 'MOBILE_NOT_REGISTERED', 'AUTH-09', {}, undefined, [{ field: 'mobile', messageId: 'AUTH-09', message: msg('AUTH-09') }]);
  return issueOtp({ mobile: b.mobile, purpose: 'LOGIN', userId: user._id }, req);
}

export async function verifyLogin(b: { mobile: string; code: string }, req: Request, res: Response) {
  const ch = await checkOtp({ mobile: b.mobile, purpose: 'LOGIN', code: b.code }, req);
  const user = await User.findOne({ mobile: b.mobile }).lean<UserDoc>();
  if (!user) {
    await consumeOtp(ch, null);
    throw new AppError(404, 'MOBILE_NOT_REGISTERED', 'AUTH-09');
  }
  return signInExisting(user, ch, req, res, null);
}

const disabledMessage = (role: Role): MessageId => (role === 'STF' || role === 'ADM' ? 'AUTH-19' : 'AUTH-11');

/** P-02 step 4: after the code, check account status, then user status, then role. */
async function signInExisting(user: UserDoc, ch: OtpChallengeDoc, req: Request, res: Response, messageId: MessageId | null): Promise<Outcome<unknown>> {
  const now = clock.now();
  const actor = { userId: user._id, role: user.role, accountId: user.accountId ?? null };
  const refuse = async (err: AppError): Promise<never> => {
    await consumeOtp(ch, null).catch(() => undefined);
    await audit({ entity: 'auth', action: 'LOGIN_REFUSED', result: 'REFUSED', after: { reason: err.code }, actor }, { req });
    throw err;
  };
  if (user.accountId) {
    const account = await Account.findById(user.accountId, { status: 1, closedAt: 1 }).lean();
    if (account?.status === 'SUSPENDED') await refuse(new AppError(403, 'ACCOUNT_SUSPENDED', 'AUTH-10'));
    if (account?.status === 'CLOSED') {
      await refuse(new AppError(403, 'ACCOUNT_CLOSED', 'AUTH-14', { date: account.closedAt ? istDate(account.closedAt.toISOString().slice(0, 10)) : '' }));
    }
  }
  if (user.status === 'DISABLED') await refuse(new AppError(403, 'USER_DISABLED', disabledMessage(user.role as Role)));
  if (user.status === 'INVITED' && user.role === 'REF' && user.invitedAt
    && now.getTime() > user.invitedAt.getTime() + cfgNum('CFG-122') * DAY) await refuse(new AppError(403, 'INVITE_EXPIRED', 'AUTH-20'));

  const firstLogin = user.status === 'INVITED';
  const s = await withTx(async (session) => {
    await consumeOtp(ch, session);
    await User.updateOne(
      { _id: user._id },
      firstLogin ? { $set: { lastLoginAt: now, status: 'ACTIVE', activatedAt: now }, $inc: { version: 1 } } : { $set: { lastLoginAt: now } },
      { session: session ?? undefined },
    );
    const started = await startSession(user._id, req, clientOf(req), session);
    await audit({ entity: 'auth', entityId: started.sessionId, action: firstLogin ? 'INVITE_ACCEPTED' : 'LOGIN_SUCCEEDED', actor }, { req, session });
    return started;
  });
  return { data: { outcome: 'SIGNED_IN', ...(await signedIn(user._id, s, req, res)) }, messageId: messageId ?? (firstLogin ? 'AUTH-12' : null), params: { name: user.name } };
}

// ── P-03 Session, logout and devices ─────────────────────────────────────────

export async function refresh(req: Request, res: Response) {
  const fromBody = req.body?.refreshToken as string | undefined;
  const token = fromBody ?? (req.cookies?.[REFRESH_COOKIE] as string | undefined);
  if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'GEN-09');
  if (!fromBody) assertTrustedOrigin(req);
  try {
    const { tokens } = await rotateRefresh(token, req);
    return { refreshed: true, ...deliverTokens(req, res, tokens) };
  } catch (err) {
    if (!fromBody && err instanceof AppError && err.code !== 'TOKEN_INVALID') clearSessionCookies(res);
    throw err;
  }
}

/** Log out always succeeds for the browser (its cookies are cleared); the server ends the session it can identify. */
export async function logout(req: Request, res: Response) {
  const bearer = req.get('authorization')?.match(/^Bearer ([A-Za-z0-9._-]+)$/)?.[1];
  if (!bearer) assertTrustedOrigin(req);
  let claims: { sub: string; sid: string } | null = null;
  for (const attempt of [
    () => verifyAccessToken(bearer ?? req.cookies?.[ACCESS_COOKIE]),
    () => verifyRefreshToken(req.body?.refreshToken ?? req.cookies?.[REFRESH_COOKIE]),
  ]) {
    try { claims = attempt(); break; } catch { /* try the next token */ }
  }
  clearSessionCookies(res);
  if (claims) {
    const ended = await endSessions({ _id: claims.sid, userId: claims.sub }, 'LOGOUT');
    if (ended) await audit({ entity: 'auth', entityId: claims.sid, action: 'LOGOUT', actor: { userId: claims.sub, role: null, accountId: null } }, { req });
  }
}

export const sessions = (ctx: AuthContext) => listSessions(ctx);

export async function endOwnSession(ctx: AuthContext, id: string, req: Request): Promise<Outcome<null>> {
  const s = await Session.findOne({ _id: id, userId: ctx.userId }).lean();
  if (!s) throw AppError.notFound();
  if (!s.endedAt) {
    await endSessions({ _id: id }, 'ENDED_BY_USER');
    await audit({ entity: 'session', entityId: id, action: 'SESSION_ENDED_BY_USER', after: { device: s.device } }, { req });
  }
  return { data: null, messageId: 'AUTH-22', params: { device: s.device } };
}

// ── Step-up OTP (CFG-83, AUTH-26) ────────────────────────────────────────────

export const sendStepUpOtp = (ctx: AuthContext, req: Request) =>
  issueOtp({ mobile: ctx.mobile, purpose: 'STEP_UP', userId: ctx.userId }, req, { id: 'AUTH-26' });

export async function verifyStepUp(ctx: AuthContext, code: string, req: Request) {
  const ch = await checkOtp({ mobile: ctx.mobile, purpose: 'STEP_UP', code }, req, ctx.userId);
  return withTx(async (session) => {
    await consumeOtp(ch, session);
    const g = await createGrant('STEP_UP', ctx, ch._id, cfgNum('CFG-02'), session);
    await audit({ entity: 'auth', entityId: ch._id, action: 'STEP_UP_VERIFIED' }, { req, ctx, session });
    return { stepUpToken: g.token, expiresAt: g.expiresAt };
  });
}

// ── P-04 Change registered mobile number ─────────────────────────────────────

export const sendCurrentMobileOtp = (ctx: AuthContext, req: Request) =>
  issueOtp({ mobile: ctx.mobile, purpose: 'CHANGE_MOBILE', userId: ctx.userId }, req);

/** Step 2: the current number is verified. The change token allows steps 3–4 (two OTP validities). */
export async function verifyCurrentMobile(ctx: AuthContext, code: string, req: Request) {
  const ch = await checkOtp({ mobile: ctx.mobile, purpose: 'CHANGE_MOBILE', code }, req, ctx.userId);
  return withTx(async (session) => {
    await consumeOtp(ch, session);
    const g = await createGrant('CHANGE_MOBILE', ctx, ch._id, cfgNum('CFG-02') * 2, session);
    await audit({ entity: 'user', entityId: ctx.userId, action: 'MOBILE_CHANGE_STARTED' }, { req, ctx, session });
    return { changeToken: g.token, expiresAt: g.expiresAt };
  });
}

async function changeGrant(ctx: AuthContext, token: string) {
  const grant = await findGrant('CHANGE_MOBILE', ctx, token);
  if (!grant) throw new AppError(403, 'STEP_UP_REQUIRED', 'AUTH-26', { 'masked mobile': maskMobile(ctx.mobile)! });
  return grant;
}

async function assertNewMobile(ctx: AuthContext, newMobile: string) {
  if (newMobile === ctx.mobile) throw AppError.field('newMobile', 'AUTH-24');
  if (await User.exists({ mobile: newMobile })) {
    throw new AppError(409, 'MOBILE_IN_USE', 'AUTH-25', {}, undefined, [{ field: 'newMobile', messageId: 'AUTH-25', message: msg('AUTH-25') }]);
  }
}

export async function sendNewMobileOtp(ctx: AuthContext, b: { changeToken: string; newMobile: string }, req: Request) {
  await changeGrant(ctx, b.changeToken);
  await assertNewMobile(ctx, b.newMobile);
  return issueOtp({ mobile: b.newMobile, purpose: 'CHANGE_MOBILE', userId: ctx.userId }, req);
}

/** Step 4: the number changes in one transaction with the unique check; other sessions end; old number told. */
export async function verifyNewMobile(ctx: AuthContext, b: { changeToken: string; newMobile: string; code: string }, req: Request): Promise<Outcome<unknown>> {
  const grant = await changeGrant(ctx, b.changeToken);
  await assertNewMobile(ctx, b.newMobile);
  const ch = await checkOtp({ mobile: b.newMobile, purpose: 'CHANGE_MOBILE', code: b.code }, req, ctx.userId);
  try {
    await withTx(async (session) => {
      await consumeOtp(ch, session);
      await useGrant(grant._id, 'CHANGE_MOBILE', session);
      const r = await User.updateOne({ _id: ctx.userId, mobile: ctx.mobile }, { $set: { mobile: b.newMobile }, $inc: { version: 1 } }, { session: session ?? undefined });
      if (r.modifiedCount === 0) throw AppError.versionConflict('user', null);
      await endSessions({ userId: ctx.userId, _id: { $ne: ctx.sessionId } }, 'MOBILE_CHANGED', session);
      await audit({ entity: 'user', entityId: ctx.userId, action: 'MOBILE_CHANGED', before: { mobile: ctx.mobile }, after: { mobile: b.newMobile } }, { req, ctx, session });
    });
  } catch (err) {
    if (isDuplicateKey(err, USER_MOBILE_INDEX)) throw new AppError(409, 'MOBILE_IN_USE', 'AUTH-25');
    throw err;
  }
  // Provider work after the record is saved (GR-26). [TO CONFIRM DLT template]
  sendSms(ctx.mobile, 'MOBILE_CHANGED', `Your Bimayantra login number was changed to ${maskMobile(b.newMobile)}. If you did not do this, contact ${env.SUPPORT_EMAIL}.`, { masked_mobile: maskMobile(b.newMobile) ?? '', support: env.SUPPORT_EMAIL })
    .catch((err) => logger.warn({ err }, 'Mobile-change notice SMS failed'));
  return { data: { mobile: b.newMobile }, messageId: 'AUTH-23', params: { 'masked new number': maskMobile(b.newMobile)! } };
}