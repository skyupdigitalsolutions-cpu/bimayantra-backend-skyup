import type { Request } from 'express';
import type { ClientSession } from 'mongoose';
import { cfgNum } from '../../config/cfg.js';
import { AppError } from '../../lib/errors.js';
import { clock, istTime } from '../../lib/clock.js';
import { newSalt, otpCode, otpHash, randomToken, safeEqualHex, sha256 } from '../../lib/crypto.js';
import { isDuplicateKey } from '../../lib/mongo.js';
import { logger } from '../../lib/logger.js';
import { msg, type MessageId, type MessageParams } from '../../lib/messages.js';
import { maskMobile } from '../../lib/phone.js';
import { audit } from '../audit/audit.service.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { OtpChallenge, OtpGrant, OtpLock, type OtpChallengeDoc, type OtpPurpose } from './otp.model.js';
import { sendSms } from './sms.js';

const minutes = (n: number) => n * 60_000;

export interface OtpSendResult {
  sent: boolean;
  maskedMobile: string;
  expiresAt: Date;
  resendAfterSeconds: number;
  codeLength: number;
  messageId: MessageId;
  message: string;
}

async function assertNotLocked(mobile: string, purpose: OtpPurpose, includeSendLock: boolean) {
  const ids = [`${purpose}:${mobile}`, ...(includeSendLock ? [`*:${mobile}`] : [])];
  const now = clock.now();
  const locks = await OtpLock.find({ _id: { $in: ids }, lockedUntil: { $gt: now } }).lean();
  if (!locks.length) return;
  const lock = locks.sort((a, b) => b.lockedUntil.getTime() - a.lockedUntil.getTime())[0]!;
  if (lock.reason === 'TOO_MANY_SENDS') throw new AppError(429, 'OTP_SEND_LIMIT', 'AUTH-06', { time: istTime(lock.lockedUntil) }, { lockedUntil: lock.lockedUntil });
  throw new AppError(429, 'OTP_LOCKED', 'AUTH-04', { time: istTime(lock.lockedUntil) }, { lockedUntil: lock.lockedUntil });
}

/**
 * Sends a code (P-01 step 3, P-02 step 2, P-04, step-up). Limits: resend wait CFG-04 (a repeat inside it
 * sends no new SMS and keeps the open code: AUTH-05), CFG-05 sends per number per 60 minutes (AUTH-06,
 * then locked for CFG-06). A failed SMS does not count towards CFG-05 (AUTH-13).
 */
export async function issueOtp(
  input: { mobile: string; purpose: OtpPurpose; userId?: string | null; pendingName?: string | null; pendingEmail?: string | null; termsVersion?: string | null },
  req: Request,
  sentMessage: { id: MessageId; params?: MessageParams } = { id: 'AUTH-01' },
): Promise<OtpSendResult> {
  const { mobile, purpose } = input;
  const now = clock.now();
  const maskedMobile = maskMobile(mobile)!;
  const result = (sent: boolean, ch: { expiresAt: Date; issuedAt: Date }, messageId: MessageId, params: MessageParams): OtpSendResult => ({
    sent, maskedMobile, expiresAt: ch.expiresAt, codeLength: cfgNum('CFG-01'),
    resendAfterSeconds: Math.max(0, Math.ceil((ch.issuedAt.getTime() + cfgNum('CFG-04') * 1000 - now.getTime()) / 1000)),
    messageId, message: msg(messageId, params),
  });

  await assertNotLocked(mobile, purpose, true);

  const open = await OtpChallenge.findOne({ mobile, purpose, status: 'ISSUED' });
  if (open && open.sent && open.expiresAt > now && now.getTime() - open.issuedAt.getTime() < cfgNum('CFG-04') * 1000) {
    if (input.pendingName !== undefined) {
      open.pendingName = input.pendingName ?? null;
      open.pendingEmail = input.pendingEmail ?? null;
      open.termsVersion = input.termsVersion ?? null;
      await open.save();
    }
    const r = result(false, open, 'AUTH-05', {});
    return { ...r, message: msg('AUTH-05', { seconds: r.resendAfterSeconds }) };
  }

  const sends = await OtpChallenge.countDocuments({ mobile, sent: true, issuedAt: { $gt: new Date(now.getTime() - minutes(60)) } });
  if (sends >= cfgNum('CFG-05')) {
    const lockedUntil = new Date(now.getTime() + minutes(cfgNum('CFG-06')));
    await OtpLock.updateOne({ _id: `*:${mobile}` }, { $set: { lockedUntil, reason: 'TOO_MANY_SENDS' } }, { upsert: true });
    await audit({ entity: 'otp', action: 'OTP_SEND_LIMIT_REACHED', result: 'REFUSED', after: { purpose, mobile }, actor: { userId: input.userId ?? null, role: null, accountId: null } }, { req });
    throw new AppError(429, 'OTP_SEND_LIMIT', 'AUTH-06', { time: istTime(lockedUntil) }, { lockedUntil });
  }

  if (open) await OtpChallenge.updateOne({ _id: open._id, status: 'ISSUED' }, { $set: { status: open.expiresAt > now ? 'REPLACED' : 'EXPIRED' } });

  const code = otpCode(cfgNum('CFG-01'));
  const salt = newSalt();
  let ch;
  try {
    ch = await OtpChallenge.create({
      mobile, purpose, codeHash: otpHash(code, salt), salt, status: 'ISSUED', userId: input.userId ?? null,
      pendingName: input.pendingName ?? null, pendingEmail: input.pendingEmail ?? null, termsVersion: input.termsVersion ?? null, ip: req.ip ?? null,
      issuedAt: now, expiresAt: new Date(now.getTime() + minutes(cfgNum('CFG-02'))),
    });
  } catch (err) {
    if (!isDuplicateKey(err, 'one_open_challenge')) throw err;
    // A parallel request opened a challenge a moment ago: behave as a resend inside the wait.
    return { ...result(false, { issuedAt: now, expiresAt: new Date(now.getTime() + minutes(cfgNum('CFG-02'))) }, 'AUTH-05', {}), message: msg('AUTH-05', { seconds: cfgNum('CFG-04') }) };
  }

  try {
    await Promise.race([
      sendSms(mobile, 'OTP', `${code} is your Bimayantra verification code. It is valid for ${cfgNum('CFG-02')} minutes. Do not share it with anyone.`, { code, minutes: String(cfgNum('CFG-02')) }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('SMS provider timeout')), 5_000)),
    ]);
  } catch (err) {
    logger.warn({ err, purpose }, 'OTP SMS could not be sent');
    await OtpChallenge.updateOne({ _id: ch._id }, { $set: { sendFailed: true, status: 'EXPIRED' } });
    throw new AppError(503, 'OTP_SEND_FAILED', 'AUTH-13');
  }
  await OtpChallenge.updateOne({ _id: ch._id }, { $set: { sent: true } });
  await audit({ entity: 'otp', entityId: ch._id, action: 'OTP_REQUESTED', after: { purpose, mobile }, actor: { userId: input.userId ?? null, role: null, accountId: null } }, { req });
  return result(true, ch, sentMessage.id, { 'masked mobile': maskedMobile, ...(sentMessage.params ?? {}) });
}

/**
 * Checks a code in constant time. A wrong code counts towards CFG-03 for this challenge (AUTH-02 with the
 * tries left); the last wrong try locks this number for this purpose for CFG-06 (AUTH-04). An expired or
 * replaced code gives AUTH-03. The challenge is NOT consumed here: call consumeOtp inside the transaction
 * that acts on it, so a failed action leaves nothing half-done.
 */
export async function checkOtp(input: { mobile: string; purpose: OtpPurpose; code: string }, req: Request, actorUserId: string | null = null): Promise<OtpChallengeDoc> {
  const { mobile, purpose } = input;
  const now = clock.now();
  await assertNotLocked(mobile, purpose, false);

  const ch = await OtpChallenge.findOne({ mobile, purpose, status: 'ISSUED', sent: true }).lean<OtpChallengeDoc>();
  if (!ch) throw new AppError(400, 'OTP_EXPIRED', 'AUTH-03');
  if (ch.expiresAt <= now) {
    await OtpChallenge.updateOne({ _id: ch._id, status: 'ISSUED' }, { $set: { status: 'EXPIRED' } });
    throw new AppError(400, 'OTP_EXPIRED', 'AUTH-03');
  }
  if (safeEqualHex(otpHash(input.code, ch.salt), ch.codeHash)) return ch;

  const updated = await OtpChallenge.findOneAndUpdate({ _id: ch._id, status: 'ISSUED' }, { $inc: { wrongTries: 1 } }, { new: true }).lean();
  const tries = updated?.wrongTries ?? cfgNum('CFG-03');
  await audit({ entity: 'otp', entityId: ch._id, action: 'OTP_FAILED', result: 'FAILED', after: { purpose, mobile, wrongTries: tries }, actor: { userId: actorUserId ?? ch.userId ?? null, role: null, accountId: null } }, { req });
  if (tries >= cfgNum('CFG-03')) {
    const lockedUntil = new Date(now.getTime() + minutes(cfgNum('CFG-06')));
    await OtpChallenge.updateOne({ _id: ch._id }, { $set: { status: 'LOCKED' } });
    await OtpLock.updateOne({ _id: `${purpose}:${mobile}` }, { $set: { lockedUntil, reason: 'WRONG_TRIES' } }, { upsert: true });
    throw new AppError(429, 'OTP_LOCKED', 'AUTH-04', { time: istTime(lockedUntil) }, { lockedUntil });
  }
  const left = cfgNum('CFG-03') - tries;
  throw new AppError(400, 'OTP_INCORRECT', 'AUTH-02', { n: left }, { triesLeft: left }, [{ field: 'code', messageId: 'AUTH-02', message: msg('AUTH-02', { n: left }) }]);
}

/** Single use: only one request can consume a challenge (double-click on Verify, AC-P01-6). */
export async function consumeOtp(ch: { _id: string }, session: ClientSession | null) {
  const r = await OtpChallenge.updateOne({ _id: ch._id, status: 'ISSUED' }, { $set: { status: 'VERIFIED', verifiedAt: clock.now() } }, { session: session ?? undefined });
  if (r.modifiedCount === 0) throw new AppError(409, 'ALREADY_SUBMITTED', 'GEN-06');
}

/** A verified OTP that authorises one later action, valid for `validMinutes`. Returns the token once. */
export async function createGrant(purpose: 'STEP_UP' | 'CHANGE_MOBILE', ctx: AuthContext, challengeId: string, validMinutes: number, session: ClientSession | null) {
  const token = randomToken();
  const expiresAt = new Date(clock.nowMs() + minutes(validMinutes));
  await new OtpGrant({ purpose, tokenHash: sha256(token), userId: ctx.userId, sessionId: ctx.sessionId, challengeId, expiresAt }).save({ session: session ?? undefined });
  return { token, expiresAt };
}

export async function findGrant(purpose: 'STEP_UP' | 'CHANGE_MOBILE', ctx: AuthContext, token: string | undefined) {
  if (!token) return null;
  return OtpGrant.findOne({ tokenHash: sha256(token), purpose, userId: ctx.userId, sessionId: ctx.sessionId, usedAt: null, expiresAt: { $gt: clock.now() } }).lean();
}

export async function useGrant(id: string, usedFor: string, session: ClientSession | null) {
  const r = await OtpGrant.updateOne({ _id: id, usedAt: null }, { $set: { usedAt: clock.now(), usedFor } }, { session: session ?? undefined });
  if (r.modifiedCount === 0) throw new AppError(409, 'ALREADY_SUBMITTED', 'GEN-06');
}