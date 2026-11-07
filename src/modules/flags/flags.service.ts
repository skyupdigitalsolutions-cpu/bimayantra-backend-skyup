import type { Request } from 'express';
import { AppError } from '../../lib/errors.js';
import { Account } from '../accounts/account.model.js';
import { audit } from '../audit/audit.service.js';
import { useStepUp } from '../auth/stepUp.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { AccountFlag, FLAG_KEYS, FLAGS, GlobalFlag, flagOn, isFlagKey, loadFlags, plansOf, type FlagKey } from './flags.js';

function keyOf(k: string): FlagKey {
  if (!isFlagKey(k)) throw AppError.notFound();
  return k;
}

/** Admin list: each switch with its default, platform value and how many accounts have their own value. */
export async function list() {
  const [globals, counts] = await Promise.all([
    GlobalFlag.find().lean<Array<{ _id: string; enabled: boolean; reason: string; updatedBy: string; updatedAt: Date }>>(),
    AccountFlag.aggregate<{ _id: { flag: string; enabled: boolean }; n: number }>([{ $group: { _id: { flag: '$flag', enabled: '$enabled' }, n: { $sum: 1 } } }]),
  ]);
  return FLAG_KEYS.map((k) => {
    const g = globals.find((x) => x._id === k);
    const count = (enabled: boolean) => counts.find((c) => c._id.flag === k && c._id.enabled === enabled)?.n ?? 0;
    return {
      key: k, scope: FLAGS[k].scope, description: FLAGS[k].description, ref: FLAGS[k].ref, default: FLAGS[k].default, enabled: flagOn(k),
      plans: FLAGS[k].scope === 'ACCOUNT' ? plansOf(k) : [],
      lastChange: g ? { reason: g.reason, by: g.updatedBy, at: g.updatedAt } : null,
      accounts: FLAGS[k].scope === 'ACCOUNT' ? { on: count(true), off: count(false) } : null,
    };
  });
}

/** Accounts with their own value of an ACCOUNT switch. */
export async function accountValues(key: string) {
  const k = keyOf(key);
  const rows = await AccountFlag.find({ flag: k }).sort({ updatedAt: -1 }).limit(1000).lean<Array<{ accountId: string; enabled: boolean; reason: string; updatedBy: string; updatedAt: Date }>>();
  return rows.map((r) => ({ accountId: r.accountId, enabled: r.enabled, reason: r.reason, by: r.updatedBy, at: r.updatedAt }));
}

/** Set the platform value (step-up OTP on the route; audited with the reason and the OTP verification). */
export async function setGlobal(ctx: AuthContext, key: string, b: { enabled: boolean; reason: string; plans?: string[] | null }, req: Request) {
  const k = keyOf(key);
  const before = { enabled: flagOn(k), plans: plansOf(k) };
  if (b.plans?.length && FLAGS[k].scope !== 'ACCOUNT') throw new AppError(409, 'INVALID_STATE', 'FLG-02');
  await GlobalFlag.updateOne({ _id: k }, { $set: { enabled: b.enabled, reason: b.reason, updatedBy: ctx.userId, ...(b.plans !== undefined ? { plans: b.plans } : {}) } }, { upsert: true });
  await audit({ entity: 'featureFlag', entityId: k, action: 'FEATURE_FLAG_CHANGED', before, after: { enabled: b.enabled, plans: b.plans ?? before.plans, reason: b.reason, stepUpId: req.stepUpId ?? null } }, { req });
  await useStepUp(req.stepUpId, 'FEATURE_FLAG_CHANGED', null);
  await loadFlags();
  return (await list()).find((x) => x.key === k)!;
}

/**
 * Set (true/false) or clear (null) one account's own value of an ACCOUNT switch. A GLOBAL switch applies to every
 * account (FLG-02).
 */
export async function setForAccount(ctx: AuthContext, key: string, accountId: string, b: { enabled: boolean | null; reason: string }, req: Request) {
  const k = keyOf(key);
  if (FLAGS[k].scope !== 'ACCOUNT') throw new AppError(409, 'INVALID_STATE', 'FLG-02');
  if (!(await Account.exists({ _id: accountId }))) throw AppError.notFound();
  const before = flagOn(k, accountId);
  if (b.enabled === null) await AccountFlag.deleteOne({ flag: k, accountId });
  else await AccountFlag.updateOne({ _id: `${k}|${accountId}` }, { $set: { flag: k, accountId, enabled: b.enabled, reason: b.reason, updatedBy: ctx.userId } }, { upsert: true });
  await audit({ entity: 'featureFlag', entityId: k, action: 'FEATURE_FLAG_ACCOUNT_CHANGED', after: { accountId, before, enabled: b.enabled, reason: b.reason, stepUpId: req.stepUpId ?? null } }, { req });
  await useStepUp(req.stepUpId, 'FEATURE_FLAG_CHANGED', null);
  await loadFlags();
  return { key: k, accountId, ownValue: b.enabled, enabled: flagOn(k, accountId) };
}