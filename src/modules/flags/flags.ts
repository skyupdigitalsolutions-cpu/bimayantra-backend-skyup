import { Schema, model } from 'mongoose';
import { logger } from '../../lib/logger.js';

/**
 * FEATURE SWITCHES for behaviour that changes rules the API already enforces (Backend Change Analysis §5.3, §9.1).
 * The old path keeps working until a SkyUp Admin switches the new one on, and web and mobile read the same value
 * (GET /v1/flags), so both change together.
 *
 *  - GLOBAL switches are one value for the whole platform (SkyUp's own approval rules).
 *  - ACCOUNT switches have a platform default and an optional value per advisor account (rolling out per account).
 *
 * Every switch is registered here with its default; code never checks a name that is not in this list. A switch is
 * removed from the code once its old path is deleted.
 *
 * Reads are synchronous from memory. The instance that saves a change reloads at once; other instances within
 * 30 seconds (the same rule as configuration values).
 */
export type FlagScope = 'GLOBAL' | 'ACCOUNT';
/** Plan-based rollout for ACCOUNT switches: on for accounts on these plans. TRIAL = any account still in its free trial. */
export const ROLLOUT_PLANS = ['PREMIUM', 'NORMAL', 'TRIAL'] as const;
export type RolloutPlan = (typeof ROLLOUT_PLANS)[number];
interface FlagDef { scope: FlagScope; default: boolean; description: string; ref: string; defaultPlans?: readonly RolloutPlan[] }

export const FLAGS = {
  // skyup_direct_publish removed in Stage E2: approval is gone for good (Q92), so there is no old path to switch back to.
  // A stored value for it is ignored (unknown switches are skipped on load).
  quotation_accept_requires_payment: {
    scope: 'ACCOUNT', default: false, ref: 'Change #11, §5.2',
    description: 'Mark accepted is refused until the quotation has a PAID payment.',
  },
  payment_skips_auto_accept: {
    scope: 'ACCOUNT', default: false, ref: 'Change #11, §2.8 (pending decision)',
    description: 'Recording a payment no longer moves the quotation to ACCEPTED; the advisor marks it accepted separately.',
  },
  campaigns_website: {
    scope: 'ACCOUNT', default: true, ref: 'Change #1, §7.4 step 8',
    description: 'Website forms (embed, webhook, WordPress) can be connected and their submissions imported.',
  },
  campaigns_google: {
    scope: 'ACCOUNT', default: true, ref: 'Change #1, §7.4 step 8',
    description: 'Google Ads lead forms can be connected and their leads imported.',
  },
  campaigns_meta: {
    // client decision (Nov 2026): on for Premium accounts while it is tested; everyone else after Meta app review
    scope: 'ACCOUNT', default: false, defaultPlans: ['PREMIUM'], ref: 'Change #1, §7.4 step 8',
    description: 'Meta Ads lead forms can be connected and their leads imported (needs Meta app review).',
  },
  campaigns_linkedin: {
    scope: 'ACCOUNT', default: false, defaultPlans: ['PREMIUM'], ref: 'Change #1 (client request: LinkedIn Lead Gen Forms)',
    description: 'LinkedIn Lead Gen Forms can be connected and their leads imported (needs LinkedIn Lead Sync API access).',
  },
} as const satisfies Record<string, FlagDef>;

export type FlagKey = keyof typeof FLAGS;
export const FLAG_KEYS = Object.keys(FLAGS) as FlagKey[];
export const isFlagKey = (k: string): k is FlagKey => k in FLAGS;
export const flagDef = (k: FlagKey): FlagDef => FLAGS[k];

/** The platform value of a switch (the default until an Admin sets it). */
export const GlobalFlag = model(
  'GlobalFlag',
  new Schema({
    _id: String, enabled: { type: Boolean, required: true }, reason: { type: String, required: true }, updatedBy: { type: String, required: true },
    /** ACCOUNT switches: also on for accounts on these plans while `enabled` is false (null = the switch's default plans). */
    plans: { type: [String], default: null },
  }, { timestamps: true, versionKey: false }),
  'feature_flags',
);
/** An account's own value of an ACCOUNT switch. _id = `${flag}|${accountId}`. */
const accountFlagSchema = new Schema(
  { _id: String, flag: { type: String, required: true }, accountId: { type: String, required: true }, enabled: { type: Boolean, required: true }, reason: { type: String, required: true }, updatedBy: { type: String, required: true } },
  { timestamps: true, versionKey: false },
);
accountFlagSchema.index({ flag: 1, accountId: 1 }, { unique: true });
accountFlagSchema.index({ accountId: 1 });
export const AccountFlag = model('AccountFlag', accountFlagSchema, 'account_feature_flags');

const globals = new Map<FlagKey, boolean>();
const globalPlans = new Map<FlagKey, RolloutPlan[]>();
const perAccount = new Map<string, boolean>(); // `${flag}|${accountId}`
const accountPlans = new Map<string, RolloutPlan[]>(); // accountId → ['PREMIUM'] / ['NORMAL'] / [..., 'TRIAL']

/** The plans a switch is rolled out to (the Admin's choice, else the switch's default plans). */
export const plansOf = (key: FlagKey): RolloutPlan[] => globalPlans.get(key) ?? [...((FLAGS[key] as FlagDef).defaultPlans ?? [])];

/**
 * The value in force: the account's own value, else on for everyone if the platform value is on, else on when the
 * account's plan is one the switch is rolled out to, else the default.
 */
export function flagOn(key: FlagKey, accountId?: string | null): boolean {
  if (accountId && FLAGS[key].scope === 'ACCOUNT') {
    const own = perAccount.get(`${key}|${accountId}`);
    if (own !== undefined) return own;
    if (globals.get(key) !== true) {
      const plans = plansOf(key);
      if (plans.length && (accountPlans.get(accountId) ?? []).some((p) => plans.includes(p))) return true;
    }
  }
  return globals.get(key) ?? FLAGS[key].default;
}
/** Called when an account's plan changes, so plan-based switches follow at once (not after the 30-second refresh). */
export function setAccountPlan(accountId: string, plan: string | null, status: string | null) {
  const p: RolloutPlan[] = [];
  if (plan === 'PREMIUM' || plan === 'NORMAL') p.push(plan);
  if (status === 'TRIAL') p.push('TRIAL');
  accountPlans.set(accountId, p);
}

/** Every switch as it applies to this account (or platform-wide for SkyUp users): what clients read. */
export const effectiveFlags = (accountId?: string | null) => Object.fromEntries(FLAG_KEYS.map((k) => [k, flagOn(k, accountId)])) as Record<FlagKey, boolean>;

export async function loadFlags() {
  const { Account } = await import('../accounts/account.model.js');
  const [g, a, accs] = await Promise.all([
    GlobalFlag.find().lean<Array<{ _id: string; enabled: boolean; plans?: string[] | null }>>(),
    AccountFlag.find().lean<Array<{ flag: string; accountId: string; enabled: boolean }>>(),
    Account.find({ status: 'ACTIVE' }, { 'subscription.plan': 1, 'subscription.status': 1 }).lean<Array<{ _id: string; subscription?: { plan?: string | null; status?: string | null } }>>(),
  ]);
  globals.clear();
  globalPlans.clear();
  perAccount.clear();
  accountPlans.clear();
  for (const x of accs) setAccountPlan(x._id, x.subscription?.plan ?? null, x.subscription?.status ?? null);
  for (const r of g) if (isFlagKey(r._id)) {
    globals.set(r._id, r.enabled);
    if (Array.isArray(r.plans)) globalPlans.set(r._id, r.plans.filter((p): p is RolloutPlan => (ROLLOUT_PLANS as readonly string[]).includes(p)));
  }
  for (const r of a) if (isFlagKey(r.flag) && FLAGS[r.flag].scope === 'ACCOUNT') perAccount.set(`${r.flag}|${r.accountId}`, r.enabled);
}

let timer: NodeJS.Timeout | undefined;
export function startFlagRefresh() {
  timer ??= setInterval(() => {
    loadFlags().catch((err) => logger.warn({ err }, 'Feature switch refresh failed; keeping current values'));
  }, 30_000);
  timer.unref();
}
export function stopFlagRefresh() {
  if (timer) clearInterval(timer);
  timer = undefined;
}