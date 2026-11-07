/**
 * Change #49: one advisor's account as SkyUp sees it (SA-02, SA-03 to SA-03g). Read only.
 *
 * AC-P51-3: SkyUp sees the advisor's own data (profile, plan, KYC status, insurers, wallet, team, sign-ins) and
 * COUNTS of client records, never client names, mobiles or documents. Client records open only under a support
 * grant (supportAdmin.service.ts).
 */
import { cfg, cfgNum } from '../../config/cfg.js';
import { clock, istToday } from '../../lib/clock.js';
import { decryptField } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { maskMobile } from '../../lib/phone.js';
import { Account } from '../accounts/account.model.js';
import { effectiveStatus } from '../accounts/subscription.js';
import { AuditLog } from '../audit/audit.model.js';
import { maskIp } from '../audit/audit.service.js';
import { Session } from '../auth/session.model.js';
import { WalletTxn } from '../comms/outbox.model.js';
import { Customer } from '../customers/customer.model.js';
import { Insurer } from '../insurers/insurer.model.js';
import { InsurerMapping } from '../insurers/mapping.model.js';
import { Lead } from '../leads/lead.model.js';
import { Policy } from '../policies/policy.model.js';
import { Quotation } from '../quotations/quotation.model.js';
import { User } from '../users/user.model.js';
import { PlanChange, SubscriptionOrder, SupportGrant, type GrantDoc, type OrderDoc } from './admin.model.js';
import { SUSPEND_REASONS } from './admin.service.js';

type Acc = {
  _id: string; status: string; statusReason?: string | null; createdAt: Date; closedAt?: Date | null;
  subscription: Parameters<typeof effectiveStatus>[0] & { plan: string | null; cycle?: string | null; endsAt: Date; startsAt: Date; nextPlan?: string | null };
  wallet?: { balancePaise: number };
  profile?: {
    kycStatus?: string;
    kyc?: { panEnc?: string | null; nameOnPan?: string | null; panFileId?: string | null; licenceFileId?: string | null; submittedAt?: Date | null; decidedAt?: Date | null; decidedBy?: string | null; rejectReason?: string | null; rejectNote?: string | null; checklist?: unknown };
    contact?: { email?: string | null; city?: string | null; state?: string | null };
    professional?: { licenceNumber?: string | null; licenceValidUntil?: string | null; advisorType?: string | null };
    business?: { displayName?: string | null; gstin?: string | null };
  };
};
const istDate = (d: Date) => new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const maskPan = (pan: string | null) => (pan ? `${pan.slice(0, 2)}XXXXX${pan.slice(-3)}` : null);

async function load(id: string) {
  const a = await Account.findById(id).lean<Acc>();
  if (!a) throw AppError.notFound();
  return a;
}
const advisorOf = (accountId: string) => User.findOne({ accountId, role: 'ADV' }, { name: 1, mobile: 1, lastLoginAt: 1, createdAt: 1 }).lean<{ _id: string; name: string; mobile: string; lastLoginAt: Date | null; createdAt: Date }>();

// ── SA-02 the list ──
export type AccountTab = 'ALL' | 'TRIAL' | 'ACTIVE' | 'GRACE' | 'READ_ONLY' | 'SUSPENDED' | 'CLOSED';
/** Which tab an account belongs to: the account status first, then the subscription as in force now. */
function tabOf(a: Acc): Exclude<AccountTab, 'ALL'> {
  if (a.status === 'SUSPENDED') return 'SUSPENDED';
  if (a.status === 'CLOSED') return 'CLOSED';
  const s = effectiveStatus(a.subscription, clock.now());
  return s === 'EXPIRED' ? 'READ_ONLY' : (s as 'TRIAL' | 'ACTIVE' | 'GRACE');
}

/**
 * Advisors with tab counts. Earlier fields (advisor, status, plan, subscription, createdAt, lastLogin, counts) are kept
 * for older screens; the new ones are added. Counts only, never client data (AC-P51-3).
 */
export async function accountList(q: { tab?: AccountTab; kyc?: string; plan?: string; q?: string }) {
  const accs = await Account.find({}).sort({ createdAt: -1 }).limit(2000).lean<Acc[]>();
  const ids = accs.map((a) => a._id);
  const [advisors, leads, customers, policies, users] = await Promise.all([
    User.find({ accountId: { $in: ids }, role: 'ADV' }, { name: 1, accountId: 1, mobile: 1, lastLoginAt: 1 }).lean<Array<{ name: string; accountId: string; mobile: string; lastLoginAt: Date | null }>>(),
    Lead.aggregate<{ _id: string; n: number }>([{ $match: { accountId: { $in: ids } } }, { $group: { _id: '$accountId', n: { $sum: 1 } } }]),
    Customer.aggregate<{ _id: string; n: number }>([{ $match: { accountId: { $in: ids } } }, { $group: { _id: '$accountId', n: { $sum: 1 } } }]),
    Policy.aggregate<{ _id: string; n: number }>([{ $match: { accountId: { $in: ids } } }, { $group: { _id: '$accountId', n: { $sum: 1 } } }]),
    User.aggregate<{ _id: string; n: number }>([{ $match: { accountId: { $in: ids } } }, { $group: { _id: '$accountId', n: { $sum: 1 } } }]),
  ]);
  const count = (rows: Array<{ _id: string; n: number }>) => new Map(rows.map((r) => [r._id, r.n]));
  const [L, C, P, U] = [count(leads), count(customers), count(policies), count(users)];
  const adv = new Map(advisors.map((u) => [u.accountId, u]));
  const rows = accs.map((a) => {
    const u = adv.get(a._id);
    return {
      id: a._id, advisor: u?.name ?? '', business: a.profile?.business?.displayName ?? null, mobile: maskMobile(u?.mobile ?? null),
      status: a.status, plan: a.subscription.plan, subscription: effectiveStatus(a.subscription, clock.now()), subscriptionEndsAt: istDate(a.subscription.endsAt),
      tab: tabOf(a), kycStatus: a.profile?.kycStatus ?? 'NOT_SUBMITTED', walletBalance: (a.wallet?.balancePaise ?? 0) / 100,
      createdAt: a.createdAt, lastLogin: u?.lastLoginAt ?? null,
      counts: { leads: L.get(a._id) ?? 0, customers: C.get(a._id) ?? 0, policies: P.get(a._id) ?? 0, users: U.get(a._id) ?? 0 },
    };
  });
  const matches = (r: (typeof rows)[number]) =>
    (!q.kyc || r.kycStatus === q.kyc) && (!q.plan || (q.plan === 'TRIAL' ? r.subscription === 'TRIAL' : r.plan === q.plan))
    && (!q.q || [r.advisor, r.business ?? ''].some((t) => t.toLowerCase().includes(q.q!.toLowerCase())));
  const filtered = rows.filter(matches);
  const tabs = { ALL: filtered.length, TRIAL: 0, ACTIVE: 0, GRACE: 0, READ_ONLY: 0, SUSPENDED: 0, CLOSED: 0 } as Record<AccountTab, number>;
  for (const r of filtered) tabs[r.tab]++;
  return { tabs, rows: !q.tab || q.tab === 'ALL' ? filtered : filtered.filter((r) => r.tab === q.tab) };
}

// ── SA-03 Overview ──
export async function overview(id: string) {
  const a = await load(id);
  const u = await advisorOf(id);
  const [leads, customers, quotations, policies, assistants] = await Promise.all([
    Lead.countDocuments({ accountId: id }), Customer.countDocuments({ accountId: id }), Quotation.countDocuments({ accountId: id }), Policy.countDocuments({ accountId: id }),
    User.countDocuments({ accountId: id, role: 'AST', status: { $ne: 'DISABLED' } }),
  ]);
  return {
    id, advisor: u?.name ?? '', business: a.profile?.business?.displayName ?? null, mobile: u?.mobile ?? null, email: a.profile?.contact?.email ?? null, city: a.profile?.contact?.city ?? null,
    licence: { number: a.profile?.professional?.licenceNumber ?? null, validUntil: a.profile?.professional?.licenceValidUntil ?? null, type: a.profile?.professional?.advisorType ?? null },
    joinedAt: a.createdAt, lastLogin: u?.lastLoginAt ?? null,
    account: { status: a.status, reason: a.statusReason ?? null, closedAt: a.closedAt ?? null, tab: tabOf(a) },
    plan: a.subscription.plan, subscription: effectiveStatus(a.subscription, clock.now()), kycStatus: a.profile?.kycStatus ?? 'NOT_SUBMITTED',
    assistants: { used: assistants, limit: cfgNum('CFG-158') }, walletBalance: (a.wallet?.balancePaise ?? 0) / 100,
    counts: { leads, customers, quotations, policies },
    suspendReasons: SUSPEND_REASONS,
  };
}

// ── SA-03a Subscription ──
export async function subscription(id: string) {
  const a = await load(id);
  const [orders, changes] = await Promise.all([
    SubscriptionOrder.find({ accountId: id, status: 'SUCCESS' }).sort({ createdAt: -1 }).lean<OrderDoc[]>(),
    PlanChange.find({ accountId: id }).sort({ createdAt: -1 }).limit(50).lean<Array<{ _id: string; fromPlan: string | null; toPlan: string; effective: string; effectiveFrom: string; note: string; changedBy: string; createdAt: Date }>>(),
  ]);
  const people = new Map((await User.find({ _id: { $in: [...orders.map((o) => o.createdBy), ...changes.map((c) => c.changedBy)] } }, { name: 1 }).lean<Array<{ _id: string; name: string }>>()).map((p) => [p._id, p.name]));
  const state = a.profile?.contact?.state ?? null;
  const home = String(cfg('CFG-161'));
  const eff = effectiveStatus(a.subscription, clock.now());
  return {
    plan: a.subscription.plan, status: eff, cycle: a.subscription.cycle ?? null, startsAt: istDate(a.subscription.startsAt), endsAt: istDate(a.subscription.endsAt),
    nextPlan: a.subscription.nextPlan ?? null, graceDays: cfgNum('CFG-79'),
    billing: { state, gstin: a.profile?.business?.gstin ?? null, gstType: state && state.toLowerCase() === home.toLowerCase() ? 'CGST_SGST' : 'IGST' },
    invoices: orders.map((o) => ({ id: o._id, invoiceNumber: o.invoiceNumber, plan: o.plan, cycle: o.cycle, period: { from: o.periodStart, to: o.periodEnd }, total: o.totalPaise / 100, method: o.kind === 'OFFLINE' ? 'Offline' : 'Online', reference: o.reference ?? o.gatewayPaymentId ?? null, recordedBy: o.kind === 'OFFLINE' ? people.get(o.createdBy) ?? null : null, at: o.createdAt })),
    planChanges: changes.map((c) => ({ id: c._id, fromPlan: c.fromPlan, toPlan: c.toPlan, effective: c.effective, effectiveFrom: c.effectiveFrom, note: c.note, by: people.get(c.changedBy) ?? null, at: c.createdAt })),
  };
}

// ── SA-03b KYC (masked PAN here; the full PAN only on the KYC review screen, which is logged) ──
export async function kyc(id: string) {
  const a = await load(id);
  const k = a.profile?.kyc ?? {};
  const decidedBy = k.decidedBy ? await User.findById(k.decidedBy, { name: 1 }).lean<{ name: string }>() : null;
  const pan = k.panEnc ? decryptField(k.panEnc) : null;
  const until = a.profile?.professional?.licenceValidUntil ?? null;
  return {
    status: a.profile?.kycStatus ?? 'NOT_SUBMITTED', pan: maskPan(pan), nameOnPan: k.nameOnPan ?? null,
    licence: { number: a.profile?.professional?.licenceNumber ?? null, validUntil: until, expired: !!until && until < istToday(), type: a.profile?.professional?.advisorType ?? null },
    documents: { panFileId: k.panFileId ?? null, licenceFileId: k.licenceFileId ?? null },
    submittedAt: k.submittedAt ?? null, decidedAt: k.decidedAt ?? null, decidedBy: decidedBy?.name ?? null, rejectReason: k.rejectReason ?? null, rejectNote: k.rejectNote ?? null,
    checklist: k.checklist ?? null, targetWorkingDays: cfgNum('CFG-125'),
  };
}

// ── SA-03c Insurers: insurer, agent code, valid until, status (Active / Code expired), flag text "Also in {advisor}" ──
export async function insurers(id: string) {
  await load(id);
  const maps = await InsurerMapping.find({ accountId: id }).sort({ createdAt: 1 }).lean<Array<{ _id: string; insurerId: string; agentCode: string; validUntil: string | null; status: string; flaggedAt: Date | null }>>();
  const [ins, shared] = await Promise.all([
    Insurer.find({ _id: { $in: maps.map((m) => m.insurerId) } }, { name: 1 }).lean<Array<{ _id: string; name: string }>>(),
    maps.length
      ? InsurerMapping.find({ $or: maps.map((m) => ({ insurerId: m.insurerId, agentCode: m.agentCode })), accountId: { $ne: id } }, { insurerId: 1, agentCode: 1, accountId: 1 }).lean<Array<{ insurerId: string; agentCode: string; accountId: string }>>()
      : Promise.resolve([] as Array<{ insurerId: string; agentCode: string; accountId: string }>),
  ]);
  const others = new Map((await User.find({ accountId: { $in: shared.map((s) => s.accountId) }, role: 'ADV' }, { name: 1, accountId: 1 }).lean<Array<{ name: string; accountId: string }>>()).map((u) => [u.accountId, u.name]));
  const today = istToday();
  return maps.map((m) => {
    const also = shared.filter((s) => s.insurerId === m.insurerId && s.agentCode === m.agentCode).map((s) => others.get(s.accountId) ?? s.accountId);
    return {
      id: m._id, insurerId: m.insurerId, insurer: ins.find((i) => i._id === m.insurerId)?.name ?? '', agentCode: m.agentCode, validUntil: m.validUntil,
      status: m.status === 'INACTIVE' ? 'INACTIVE' : m.validUntil && m.validUntil < today ? 'CODE_EXPIRED' : 'ACTIVE',
      flagged: !!m.flaggedAt, flagText: also.length ? `Also in ${also.join(', ')}` : null,
    };
  });
}

// ── SA-03d Wallet ──
export async function wallet(id: string) {
  const a = await load(id);
  const monthStart = new Date(`${istToday().slice(0, 7)}-01T00:00:00+05:30`);
  const [txns, messagesThisMonth] = await Promise.all([
    WalletTxn.find({ accountId: id }).sort({ createdAt: -1 }).limit(200).lean<Array<{ _id: string; type: string; amountPaise: number; status: string; by: string | null; reason: string | null; createdAt: Date; balanceAfterPaise: number | null }>>(),
    WalletTxn.countDocuments({ accountId: id, type: 'DEBIT', createdAt: { $gte: monthStart } }),
  ]);
  const byIds = txns.map((t) => t.by).filter((b): b is string => !!b && b.startsWith('usr_'));
  const people = new Map((await User.find({ _id: { $in: byIds } }, { name: 1, role: 1 }).lean<Array<{ _id: string; name: string; role: string }>>()).map((p) => [p._id, p]));
  const byLabel = (t: (typeof txns)[number]) => {
    if (t.type === 'DEBIT') return 'System';
    const p = t.by ? people.get(t.by) : null;
    if (p) return p.role === 'ADM' || p.role === 'STF' ? p.name : 'Advisor';
    return t.type === 'RECHARGE' ? 'Advisor' : 'System';
  };
  return {
    balance: (a.wallet?.balancePaise ?? 0) / 100, messagesThisMonth, lowBalanceBelow: cfgNum('CFG-164'), messagePrice: cfgNum('CFG-162') / 100,
    transactions: txns.map((t) => ({ id: t._id, at: t.createdAt, type: t.type === 'CREDIT' ? 'MANUAL_CREDIT' : t.type, amount: t.amountPaise / 100, status: t.status, by: byLabel(t), reason: t.reason, balanceAfter: t.balanceAfterPaise == null ? null : t.balanceAfterPaise / 100 })),
  };
}

// ── SA-03e Assistants (read only) ──
export async function assistants(id: string) {
  await load(id);
  const rows = await User.find({ accountId: id, role: 'AST' }).sort({ createdAt: 1 }).lean<Array<{ _id: string; name: string; mobile: string; status: string; lastLoginAt: Date | null; createdAt: Date }>>();
  return { limit: cfgNum('CFG-158'), items: rows.map((u) => ({ id: u._id, name: u.name, mobile: maskMobile(u.mobile), status: u.status, lastActive: u.lastLoginAt, addedAt: u.createdAt })) };
}

// ── SA-03f Support access given by this advisor ──
export async function supportGrants(id: string) {
  await load(id);
  const rows = await SupportGrant.find({ accountId: id }).sort({ createdAt: -1 }).limit(100).lean<GrantDoc[]>();
  const names = new Map((await User.find({ _id: { $in: rows.map((r) => r.granteeUserId) } }, { name: 1 }).lean<Array<{ _id: string; name: string }>>()).map((u) => [u._id, u.name]));
  return rows.map((r) => ({
    id: r._id, to: names.get(r.granteeUserId) ?? '', reason: r.reason, from: r.startsAt, until: r.endsAt, endedAt: r.endedAt ?? null,
    status: r.status === 'ACTIVE' && r.endsAt <= clock.now() ? 'EXPIRED' : r.status, recordsOpened: r.log?.length ?? 0,
  }));
}

// ── SA-03g Activity: sign-ins (device; city when known) and plan, KYC, support and account events ──
export type ActivityType = 'ALL' | 'LOGINS' | 'PLAN' | 'KYC' | 'SUPPORT' | 'ACCOUNT';
const AUDIT_GROUPS: Record<Exclude<ActivityType, 'ALL' | 'LOGINS'>, { entities: string[] }> = {
  PLAN: { entities: ['subscription'] }, KYC: { entities: ['kyc'] }, SUPPORT: { entities: ['support'] }, ACCOUNT: { entities: ['account'] },
};
export async function activity(id: string, type: ActivityType = 'ALL') {
  await load(id);
  const users = await User.find({ accountId: id }, { name: 1, role: 1 }).lean<Array<{ _id: string; name: string; role: string }>>();
  const who = new Map(users.map((u) => [u._id, u]));
  const items: Array<{ at: Date; type: string; text: string; by: string | null; device?: string | null; city?: string | null; ip?: string | null }> = [];
  if (type === 'ALL' || type === 'LOGINS') {
    const ses = await Session.find({ userId: { $in: users.map((u) => u._id) } }).sort({ startedAt: -1 }).limit(100).lean<Array<{ userId: string; device: string; ip: string | null; client: string; startedAt: Date }>>();
    // City: no IP-location service is set up, so it is null until one is chosen (Q119).
    for (const s of ses) items.push({ at: s.startedAt, type: 'LOGIN', text: `Signed in on ${s.client === 'APP' ? 'the app' : 'the web'}`, by: who.get(s.userId)?.name ?? null, device: s.device, city: null, ip: maskIp(s.ip) });
  }
  const groups = type === 'ALL' ? Object.keys(AUDIT_GROUPS) as Array<keyof typeof AUDIT_GROUPS> : type === 'LOGINS' ? [] : [type];
  if (groups.length) {
    const entities = groups.flatMap((g) => AUDIT_GROUPS[g].entities);
    // Payment and support entries are keyed by the order or grant, not the account: include this account's ones
    const [orders, grants] = await Promise.all([
      SubscriptionOrder.find({ accountId: id }, { _id: 1 }).lean<Array<{ _id: string }>>(),
      SupportGrant.find({ accountId: id }, { _id: 1 }).lean<Array<{ _id: string }>>(),
    ]);
    const ids = [id, ...orders.map((o) => o._id), ...grants.map((g) => g._id)];
    const rows = await AuditLog.find({ entity: { $in: entities }, $or: [{ accountId: id }, { entityId: { $in: ids } }] }).sort({ at: -1 }).limit(200)
      .lean<Array<{ at: Date; entity: string; action: string; actorUserId: string | null; actorRole: string | null; actorLabel: string | null; result: string }>>();
    const skyup = new Map((await User.find({ _id: { $in: rows.map((r) => r.actorUserId).filter(Boolean) as string[] }, role: { $in: ['STF', 'ADM'] } }, { name: 1 }).lean<Array<{ _id: string; name: string }>>()).map((u) => [u._id, `${u.name} (SkyUp)`]));
    for (const r of rows) {
      const g = (Object.keys(AUDIT_GROUPS) as Array<keyof typeof AUDIT_GROUPS>).find((k) => AUDIT_GROUPS[k].entities.includes(r.entity))!;
      items.push({ at: r.at, type: g, text: r.action.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) + (r.result !== 'SUCCESS' ? ` (${r.result.toLowerCase()})` : ''), by: r.actorUserId ? who.get(r.actorUserId)?.name ?? skyup.get(r.actorUserId) ?? null : r.actorLabel });
    }
  }
  return items.sort((x, y) => y.at.getTime() - x.at.getTime()).slice(0, 200);
}