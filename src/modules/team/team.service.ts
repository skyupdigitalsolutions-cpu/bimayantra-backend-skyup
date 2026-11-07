import type { Request } from 'express';
import { cfgNum } from '../../config/cfg.js';
import { AppError } from '../../lib/errors.js';
import { clock } from '../../lib/clock.js';
import { msg } from '../../lib/messages.js';
import { USER_MOBILE_INDEX } from '../users/user.model.js';
import { isDuplicateKey, withTx } from '../../lib/mongo.js';
import { maskMobile } from '../../lib/phone.js';
import { accountOf } from '../../middleware/authorize.js';
import { allowsAssistants } from '../accounts/subscription.js';
import { AuditLog } from '../audit/audit.model.js';
import { audit } from '../audit/audit.service.js';
import { endSessions } from '../auth/sessions.service.js';
import { useStepUp } from '../auth/stepUp.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { ROLE_LABEL, User, type UserDoc } from '../users/user.model.js';

const mobileInUse = () =>
  new AppError(409, 'MOBILE_IN_USE', 'REF-02', {}, undefined, [{ field: 'mobile', messageId: 'REF-02', message: msg('REF-02') }]);

async function assertMobileFree(mobile: string) {
  if (await User.exists({ mobile })) throw mobileInUse();
}

const view = (u: UserDoc, showMobile: boolean) => ({
  id: u._id, name: u.name, mobile: showMobile ? u.mobile : maskMobile(u.mobile), role: u.role, roleLabel: ROLE_LABEL[u.role as keyof typeof ROLE_LABEL],
  status: u.status, invitedAt: u.invitedAt, activatedAt: u.activatedAt, lastLoginAt: u.lastLoginAt, version: u.version,
  ...(u.role === 'STF' || u.role === 'ADM' ? { email: (u as { email?: string | null }).email ?? null } : {}),
});

// ── P-53 Assistants (Premium or Trial) ───────────────────────────────────────

export async function listAssistants(ctx: AuthContext) {
  const accountId = accountOf(ctx);
  const users = await User.find({ accountId, role: 'AST' }).sort({ createdAt: 1 }).lean<UserDoc[]>();
  const recent = await Promise.all(users.map((u) => AuditLog.find({ actorUserId: u._id }, { at: 1, action: 1, entity: 1, entityRef: 1 })
    .sort({ at: -1 }).limit(cfgNum('CFG-130')).lean()));
  const sub = ctx.subscription;
  return {
    items: users.map((u, i) => ({ ...view(u, true), recentActions: recent[i]!.map((a) => ({ at: a.at, action: a.action, entity: a.entity, entityRef: a.entityRef })) })),
    limit: cfgNum('CFG-158'),
    planAllows: !!sub && allowsAssistants(sub.status, sub.plan),
  };
}

async function assertSeat(ctx: AuthContext, accountId: string) {
  const sub = ctx.subscription;
  if (!sub || !allowsAssistants(sub.status, sub.plan)) throw new AppError(403, 'PLAN_REQUIRED', 'AST-04');
  const seats = await User.countDocuments({ accountId, role: 'AST', status: { $in: ['INVITED', 'ACTIVE'] } });
  if (seats >= cfgNum('CFG-158')) throw new AppError(409, 'LIMIT_REACHED', 'AST-02');
}

export async function addAssistant(ctx: AuthContext, b: { name: string; mobile: string }, req: Request) {
  const accountId = accountOf(ctx);
  await assertSeat(ctx, accountId);
  await assertMobileFree(b.mobile);
  try {
    const user = await withTx(async (session) => {
      const u = await new User({ accountId, role: 'AST', name: b.name, mobile: b.mobile, status: 'INVITED', invitedBy: ctx.userId, invitedAt: clock.now() }).save({ session: session ?? undefined });
      await useStepUp(req.stepUpId, 'ASSISTANT_ADDED', session);
      await audit({ entity: 'user', entityId: u._id, action: 'ASSISTANT_ADDED', after: { name: u.name, mobile: u.mobile, role: 'AST' }, stepUpId: req.stepUpId }, { req, session });
      return u;
    });
    return view(user.toObject() as UserDoc, true);
  } catch (err) {
    if (isDuplicateKey(err, USER_MOBILE_INDEX)) throw mobileInUse();
    throw err;
  }
}

/** Disable ends the assistant's sessions at once (AST-03). Enable needs a free seat on an eligible plan. */
export async function setAssistantStatus(ctx: AuthContext, id: string, enable: boolean, version: number, req: Request) {
  const accountId = accountOf(ctx);
  const user = await User.findOne({ _id: id, accountId, role: 'AST' }).lean<UserDoc>();
  if (!user) throw AppError.notFound();
  if (user.version !== version) throw AppError.versionConflict('assistant', view(user, true));
  if (enable === (user.status !== 'DISABLED')) return view(user, true);
  if (enable) await assertSeat(ctx, accountId);
  const next = enable ? (user.activatedAt ? 'ACTIVE' : 'INVITED') : 'DISABLED';
  const updated = await withTx(async (session) => {
    const u = await User.findOneAndUpdate({ _id: id, version }, { $set: { status: next, disabledAt: enable ? null : clock.now() }, $inc: { version: 1 } }, { new: true, session }).lean<UserDoc>();
    if (!u) throw AppError.versionConflict('assistant', null);
    if (!enable) await endSessions({ userId: id }, 'USER_DISABLED', session);
    await audit({ entity: 'user', entityId: id, action: enable ? 'ASSISTANT_ENABLED' : 'ASSISTANT_DISABLED', before: { status: user.status }, after: { status: next } }, { req, session });
    return u;
  });
  return view(updated, true);
}

// ── P-48 SkyUp users (ADM) ───────────────────────────────────────────────────

export async function listStaff() {
  const users = await User.find({ role: { $in: ['STF', 'ADM'] } }).sort({ createdAt: 1 }).lean<UserDoc[]>();
  return users.map((u) => view(u, false));
}

export async function addStaff(ctx: AuthContext, b: { name: string; mobile: string; role: 'STF' | 'ADM'; email?: string | null }, req: Request) {
  await assertMobileFree(b.mobile);
  try {
    const user = await withTx(async (session) => {
      const u = await new User({ accountId: null, role: b.role, name: b.name, mobile: b.mobile, email: b.email?.toLowerCase() ?? null, status: 'INVITED', invitedBy: ctx.userId, invitedAt: clock.now() }).save({ session: session ?? undefined });
      await useStepUp(req.stepUpId, 'STAFF_ADDED', session);
      await audit({ entity: 'user', entityId: u._id, action: 'STAFF_ADDED', after: { name: u.name, mobile: u.mobile, role: u.role, email: u.email ?? null }, stepUpId: req.stepUpId }, { req, session });
      return u;
    });
    return view(user.toObject() as UserDoc, false);
  } catch (err) {
    if (isDuplicateKey(err, USER_MOBILE_INDEX)) throw mobileInUse();
    throw err;
  }
}

async function loadStaff(ctx: AuthContext, id: string, version: number) {
  if (id === ctx.userId) throw new AppError(409, 'SELF_ACTION', 'ADM-03');
  const user = await User.findOne({ _id: id, role: { $in: ['STF', 'ADM'] } }).lean<UserDoc>();
  if (!user) throw AppError.notFound();
  if (user.version !== version) throw AppError.versionConflict('user', view(user, false));
  return user;
}

/** "At least one SkyUp Admin must stay active" (ADM-02). */
async function assertAnotherActiveAdmin(excludeId: string) {
  if ((await User.countDocuments({ role: 'ADM', status: 'ACTIVE', _id: { $ne: excludeId } })) === 0) throw new AppError(409, 'LAST_ADMIN', 'ADM-02');
}

/** A role change ends the user's sessions, so the new role applies at their next login (P-48). */
export async function changeStaffRole(ctx: AuthContext, id: string, b: { role: 'STF' | 'ADM'; version: number }, req: Request) {
  const user = await loadStaff(ctx, id, b.version);
  if (user.role === b.role) return view(user, false);
  if (user.role === 'ADM' && user.status === 'ACTIVE') await assertAnotherActiveAdmin(id);
  const updated = await withTx(async (session) => {
    const u = await User.findOneAndUpdate({ _id: id, version: b.version }, { $set: { role: b.role }, $inc: { version: 1 } }, { new: true, session }).lean<UserDoc>();
    if (!u) throw AppError.versionConflict('user', null);
    await endSessions({ userId: id }, 'ROLE_CHANGED', session);
    await useStepUp(req.stepUpId, 'STAFF_ROLE_CHANGED', session);
    await audit({ entity: 'user', entityId: id, action: 'STAFF_ROLE_CHANGED', before: { role: user.role }, after: { role: b.role }, stepUpId: req.stepUpId }, { req, session });
    return u;
  });
  return view(updated, false);
}

export async function setStaffStatus(ctx: AuthContext, id: string, enable: boolean, version: number, req: Request) {
  const user = await loadStaff(ctx, id, version);
  if (enable === (user.status !== 'DISABLED')) return view(user, false);
  if (!enable && user.role === 'ADM' && user.status === 'ACTIVE') await assertAnotherActiveAdmin(id);
  const next = enable ? (user.activatedAt ? 'ACTIVE' : 'INVITED') : 'DISABLED';
  const updated = await withTx(async (session) => {
    const u = await User.findOneAndUpdate({ _id: id, version }, { $set: { status: next, disabledAt: enable ? null : clock.now() }, $inc: { version: 1 } }, { new: true, session }).lean<UserDoc>();
    if (!u) throw AppError.versionConflict('user', null);
    if (!enable) await endSessions({ userId: id }, 'USER_DISABLED', session);
    await useStepUp(req.stepUpId, enable ? 'STAFF_ENABLED' : 'STAFF_DISABLED', session);
    await audit({ entity: 'user', entityId: id, action: enable ? 'STAFF_ENABLED' : 'STAFF_DISABLED', before: { status: user.status }, after: { status: next }, stepUpId: req.stepUpId }, { req, session });
    return u;
  });
  return view(updated, false);
}