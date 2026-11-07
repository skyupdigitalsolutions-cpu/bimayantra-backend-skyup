/**
 * Change #59: the SkyUp home screen (SA-01). KPIs, a needs-attention list, recent SkyUp activity and the plan mix.
 * There is no "pending approvals" count: nothing waits for a second admin (Q92). Counts only, no client data.
 */
import { cfgNum } from '../../config/cfg.js';
import { clock, istToday } from '../../lib/clock.js';
import { Account } from '../accounts/account.model.js';
import { effectiveStatus } from '../accounts/subscription.js';
import { AuditLog } from '../audit/audit.model.js';
import { Correction } from '../catalogue/corrections.service.js';
import { Product, ProductVersion } from '../catalogue/product.model.js';
import { AgentCodeFlag } from '../insurers/agentCodeFlag.model.js';
import { workingDaysSince } from '../kyc/kyc.service.js';
import { User } from '../users/user.model.js';

type Acc = { _id: string; status: string; subscription: Parameters<typeof effectiveStatus>[0] & { plan: string | null; endsAt: Date }; wallet?: { balancePaise: number }; profile?: { kycStatus?: string; kyc?: { submittedAt?: Date | null } } };
/** Audit entries shown under "Recent SkyUp activity" (publishing, KYC, payments, support, configuration, accounts). */
const RECENT_ENTITIES = ['product', 'productVersion', 'insurer', 'template', 'messageTemplate', 'kyc', 'subscription', 'support', 'config', 'account', 'correction', 'agentCodeFlag', 'wallet'];

export async function dashboard() {
  const now = clock.now();
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const in7 = new Date(`${istToday()}T23:59:59.999+05:30`); in7.setUTCDate(in7.getUTCDate() + 7);
  const accs = await Account.find({}, { status: 1, subscription: 1, wallet: 1, 'profile.kycStatus': 1, 'profile.kyc.submittedAt': 1, createdAt: 1 }).lean<Acc[]>();
  const open = accs.filter((a) => a.status === 'ACTIVE');
  const sub = (a: Acc) => effectiveStatus(a.subscription, now);
  const lowBelow = cfgNum('CFG-164') * 100;

  const kycPending = accs.filter((a) => a.profile?.kycStatus === 'PENDING_REVIEW').sort((x, y) => +new Date(x.profile!.kyc?.submittedAt ?? 0) - +new Date(y.profile!.kyc?.submittedAt ?? 0));
  const trialsEnding = open.filter((a) => sub(a) === 'TRIAL' && a.subscription.endsAt >= now && a.subscription.endsAt <= in7);
  const grace = open.filter((a) => sub(a) === 'GRACE');
  const readOnly = open.filter((a) => sub(a) === 'EXPIRED');
  const [verifiedTotal, publishedThisWeek, corrections, flags, recent] = await Promise.all([
    Product.countDocuments({ kind: 'VERIFIED', status: { $ne: 'NOT_PUBLISHED' } }),
    Product.find({ kind: 'VERIFIED' }, { _id: 1 }).lean<Array<{ _id: string }>>().then((ps) => ProductVersion.countDocuments({ productId: { $in: ps.map((p) => p._id) }, status: { $in: ['PUBLISHED', 'SUPERSEDED'] }, publishedAt: { $gte: weekAgo } })),
    Correction.find({ status: 'SUBMITTED' }, { createdAt: 1 }).sort({ createdAt: 1 }).lean<Array<{ _id: string; createdAt: Date }>>(),
    AgentCodeFlag.find({ status: 'OPEN' }, { raisedAt: 1, agentCode: 1 }).sort({ raisedAt: 1 }).lean<Array<{ _id: string; raisedAt: Date; agentCode: string }>>(),
    AuditLog.find({ actorRole: { $in: ['STF', 'ADM'] }, entity: { $in: RECENT_ENTITIES }, result: 'SUCCESS', action: { $not: /OPENED|VIEWED/ } }).sort({ at: -1 }).limit(5).lean<Array<{ at: Date; actorUserId: string | null; entity: string; entityId: string | null; action: string; accountId: string | null }>>(),
  ]);
  const names = new Map((await User.find({ $or: [{ _id: { $in: recent.map((r) => r.actorUserId).filter(Boolean) as string[] } }, { role: 'ADV', accountId: { $in: [...kycPending, ...trialsEnding, ...readOnly].map((a) => a._id) } }] }, { name: 1, accountId: 1, role: 1 }).lean<Array<{ _id: string; name: string; accountId: string | null; role: string }>>()).flatMap((u) => [[u._id, u.name], ...(u.role === 'ADV' && u.accountId ? [[u.accountId, u.name]] : [])] as Array<[string, string]>));

  const kycOldest = kycPending[0]?.profile?.kyc?.submittedAt ?? null;
  const attention = [
    ...kycPending.map((a) => ({ type: 'KYC', accountId: a._id, label: `KYC from ${names.get(a._id) ?? 'an advisor'}`, since: a.profile?.kyc?.submittedAt ?? null })),
    ...flags.map((f) => ({ type: 'AGENT_CODE_FLAG', id: f._id, label: `Agent code ${f.agentCode} in more than one account`, since: f.raisedAt })),
    ...corrections.map((c) => ({ type: 'CORRECTION', id: c._id, label: 'Product correction waiting', since: c.createdAt })),
    ...trialsEnding.map((a) => ({ type: 'TRIAL_ENDING', accountId: a._id, label: `Trial of ${names.get(a._id) ?? 'an advisor'} ends soon`, since: a.subscription.endsAt })),
    ...readOnly.map((a) => ({ type: 'READ_ONLY', accountId: a._id, label: `${names.get(a._id) ?? 'An advisor'} is read-only`, since: a.subscription.endsAt })),
  ].sort((x, y) => +new Date(x.since ?? 0) - +new Date(y.since ?? 0)).slice(0, 50);

  const mix = { TRIAL: 0, NORMAL: 0, PREMIUM: 0, GRACE: 0, EXPIRED: 0 };
  for (const a of open) {
    const s = sub(a);
    if (s === 'TRIAL') mix.TRIAL++; else if (s === 'GRACE') mix.GRACE++; else if (s === 'EXPIRED') mix.EXPIRED++;
    else if (a.subscription.plan === 'PREMIUM') mix.PREMIUM++; else mix.NORMAL++;
  }
  return {
    kpis: {
      advisors: { total: accs.filter((a) => a.status !== 'CLOSED').length, active: open.filter((a) => ['ACTIVE', 'GRACE'].includes(sub(a))).length, trial: mix.TRIAL },
      kycToReview: { count: kycPending.length, oldestWorkingDays: kycOldest ? workingDaysSince(kycOldest, now) : 0, targetWorkingDays: cfgNum('CFG-125') },
      trialsEndingIn7Days: trialsEnding.length,
      graceOrReadOnly: { grace: grace.length, readOnly: readOnly.length },
      verifiedProducts: { total: verifiedTotal, publishedThisWeek },
      correctionsWaiting: corrections.length,
      openAgentCodeFlags: flags.length,
      wallets: { totalBalance: open.reduce((s, a) => s + (a.wallet?.balancePaise ?? 0), 0) / 100, belowThreshold: open.filter((a) => (a.wallet?.balancePaise ?? 0) < lowBelow).length, threshold: cfgNum('CFG-164') },
    },
    needsAttention: attention,
    recentActivity: recent.map((r) => ({ at: r.at, by: r.actorUserId ? names.get(r.actorUserId) ?? null : null, action: r.action, entity: r.entity, entityId: r.entityId, accountId: r.accountId })),
    planMix: mix,
  };
}