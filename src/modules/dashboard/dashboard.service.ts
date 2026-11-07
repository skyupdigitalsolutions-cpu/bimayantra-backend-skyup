import { cfgNum } from '../../config/cfg.js';
import { istToday } from '../../lib/clock.js';
import { msg } from '../../lib/messages.js';
import { AuditLog } from '../audit/audit.model.js';
import { Customer } from '../customers/customer.model.js';
import { Lead } from '../leads/lead.model.js';
import { getProfile } from '../profile/profile.service.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { dueTodayOrOverdue } from '../tasks/tasks.service.js';

/**
 * Advisor dashboard (P-08). Each widget is its own call scoped to the account, so one failing widget never
 * blanks the page (AC-P08-3). Every count says which list (and filter) it opens (AC-P08-4).
 * Quotations, policies and renewals arrive with their modules; until then they are 0 and not available.
 */
const OPEN_LEAD = ['NEW', 'CONTACTED', 'QUALIFIED', 'FOLLOW_UP'];
const empty = (n: number) => (n === 0 ? { emptyMessageId: 'DSH-04', emptyMessage: msg('DSH-04') } : {});

export async function openLeads(ctx: AuthContext) {
  const count = await Lead.countDocuments({ accountId: ctx.accountId, status: { $in: OPEN_LEAD } });
  return { count, opens: { list: 'LEADS', filter: { status: OPEN_LEAD } }, ...empty(count) };
}

export async function activeCustomers(ctx: AuthContext) {
  const count = await Customer.countDocuments({ accountId: ctx.accountId, status: 'ACTIVE' });
  return { count, opens: { list: 'CUSTOMERS', filter: { status: ['ACTIVE'] } }, ...empty(count) };
}

export const notYet = (list: string, module: number) => async () => ({ count: 0, available: false, arrivesWith: `Module ${module}`, opens: { list, filter: {} } });

const PERIODS = ['THIS_MONTH', 'LAST_3_MONTHS', 'THIS_YEAR'] as const;
export type Period = (typeof PERIODS)[number];
/** Start of the period in IST. */
function periodStart(p: Period): Date {
  const [y, m] = istToday().split('-').map(Number) as [number, number];
  const ist = (yy: number, mm: number) => new Date(`${yy}-${String(mm).padStart(2, '0')}-01T00:00:00+05:30`);
  if (p === 'THIS_YEAR') return ist(y, 1);
  if (p === 'LAST_3_MONTHS') { const back = m - 2; return back >= 1 ? ist(y, back) : ist(y - 1, back + 12); }
  return ist(y, m);
}

/** Lead funnel: leads CREATED in the period, counted by their status now, and how many reached CONVERTED. */
export async function funnel(ctx: AuthContext, period: Period = 'THIS_MONTH') {
  const from = periodStart(period);
  const rows = await Lead.aggregate<{ _id: string; n: number }>([
    { $match: { accountId: ctx.accountId, createdAt: { $gte: from } } },
    { $group: { _id: '$status', n: { $sum: 1 } } },
  ]);
  const by = Object.fromEntries(rows.map((r) => [r._id, r.n]));
  const statuses = ['NEW', 'CONTACTED', 'QUALIFIED', 'FOLLOW_UP', 'CONVERTED', 'LOST'];
  const created = rows.reduce((n, r) => n + r.n, 0);
  return {
    period, periods: PERIODS, from, created, converted: by.CONVERTED ?? 0,
    bars: statuses.map((s) => ({ status: s, count: by[s] ?? 0, opens: { list: 'LEADS', filter: { status: [s], createdFrom: from } } })),
    ...empty(created),
  };
}

export async function todaysTasks(ctx: AuthContext) {
  const tasks = await dueTodayOrOverdue(ctx, cfgNum('CFG-130'));
  return { tasks, opens: { list: 'TASKS', filter: { tab: 'TODAY' } }, ...empty(tasks.length) };
}

/**
 * The last CFG-130 events: records created, status changes, messages sent (P-08). An explicit list, so views,
 * reveals, file reads and sign-ins never appear as activity. Messages sent join with Module 14.
 */
export const ACTIVITY_ACTIONS = [
  'LEAD_CREATED', 'LEAD_STATUS_CHANGED', 'LEAD_REOPENED', 'LEAD_CONVERTED', 'LEAD_CONTACT_LOGGED',
  'CUSTOMER_CREATED', 'CUSTOMER_DEACTIVATED', 'CUSTOMER_REACTIVATED', 'FAMILY_MEMBER_ADDED',
  'DOCUMENT_UPLOADED', 'DOCUMENT_CONFIRMED', 'VEHICLE_ADDED', 'VEHICLE_MARKED_SOLD', 'VEHICLE_REACTIVATED',
  'TASK_CREATED', 'TASK_DONE', 'KYC_SUBMITTED', 'KYC_RESUBMITTED_AFTER_VERIFIED', 'KYC_VERIFIED', 'KYC_REJECTED',
  'INSURER_MAPPING_ADDED', 'ASSISTANT_ADDED',
] as const;
const ACTIVITY_TITLE: Record<string, string> = {
  LEAD_CREATED: 'New lead created', LEAD_STATUS_CHANGED: 'Lead status changed', LEAD_REOPENED: 'Lead reopened', LEAD_CONVERTED: 'Lead converted',
  LEAD_CONTACT_LOGGED: 'Contact logged', CUSTOMER_CREATED: 'Policy holder added', CUSTOMER_DEACTIVATED: 'Policy holder deactivated',
  CUSTOMER_REACTIVATED: 'Policy holder reactivated', FAMILY_MEMBER_ADDED: 'Family member added', DOCUMENT_UPLOADED: 'Document uploaded',
  DOCUMENT_CONFIRMED: 'Document verified', VEHICLE_ADDED: 'Vehicle added', VEHICLE_MARKED_SOLD: 'Vehicle marked inactive',
  VEHICLE_REACTIVATED: 'Vehicle active again', TASK_CREATED: 'Task created', TASK_DONE: 'Task completed', KYC_SUBMITTED: 'KYC submitted',
  KYC_RESUBMITTED_AFTER_VERIFIED: 'KYC resubmitted', KYC_VERIFIED: 'KYC verified', KYC_REJECTED: 'KYC rejected',
  INSURER_MAPPING_ADDED: 'Insurer added', ASSISTANT_ADDED: 'Assistant added',
};
type ActivityRow = { _id: string; entity: string; entityId: string; entityRef?: string | null; action: string; at: Date; actorUserId?: string | null; actorRole?: string | null; before?: Record<string, unknown> | null; after?: Record<string, unknown> | null };

/**
 * Gap fix: each event now carries what the screen shows — a display `title`, the person it is about (`name`, the
 * lead or policy holder), a short `detail` (lead source, "New → Contacted", member or task name) and `open`
 * (which record a tap opens). The raw fields stay for older clients.
 */
export async function recentActivity(ctx: AuthContext) {
  const rows = await AuditLog.find({ accountId: ctx.accountId, action: { $in: ACTIVITY_ACTIONS }, result: 'SUCCESS' })
    .sort({ at: -1 }).limit(cfgNum('CFG-130')).lean<ActivityRow[]>();
  const { Task } = await import('../tasks/task.model.js');
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const taskIds = rows.filter((r) => r.entity === 'task').map((r) => r.entityId);
  const tasks = new Map((await Task.find({ _id: { $in: taskIds }, accountId: ctx.accountId }, { title: 1, linkedType: 1, linkedId: 1 }).lean<Array<{ _id: string; title: string; linkedType?: string | null; linkedId?: string | null }>>()).map((t) => [t._id, t]));
  const leadIds = new Set<string>(); const customerIds = new Set<string>(); const customerNumbers = new Set<string>();
  const target = (r: ActivityRow): { type: 'LEAD' | 'CUSTOMER'; id?: string; number?: string } | null => {
    if (r.entity === 'lead') return { type: 'LEAD', id: r.entityId };
    if (r.entity === 'customer') return { type: 'CUSTOMER', id: r.entityId };
    if (r.entity === 'family_member' && r.entityRef) return { type: 'CUSTOMER', number: r.entityRef };
    if ((r.entity === 'document' || r.entity === 'vehicle') && str(r.after?.customerId)) return { type: 'CUSTOMER', id: str(r.after?.customerId)! };
    if (r.entity === 'task') { const t = tasks.get(r.entityId); if (t?.linkedType && t.linkedId) return { type: t.linkedType as 'LEAD' | 'CUSTOMER', id: t.linkedId }; }
    return null;
  };
  const targets = rows.map(target);
  for (const t of targets) {
    if (!t) continue;
    if (t.type === 'LEAD' && t.id) leadIds.add(t.id);
    else if (t.id) customerIds.add(t.id);
    else if (t.number) customerNumbers.add(t.number);
  }
  const [leads, customers] = await Promise.all([
    Lead.find({ _id: { $in: [...leadIds] }, accountId: ctx.accountId }, { name: 1, source: 1 }).lean<Array<{ _id: string; name: string; source: string }>>(),
    Customer.find({ accountId: ctx.accountId, $or: [{ _id: { $in: [...customerIds] } }, { number: { $in: [...customerNumbers] } }] }, { name: 1, number: 1 }).lean<Array<{ _id: string; name: string; number: string }>>(),
  ]);
  const leadById = new Map(leads.map((l) => [l._id, l]));
  const custById = new Map(customers.map((c) => [c._id, c]));
  const custByNumber = new Map(customers.map((c) => [c.number, c]));
  const label = (s: unknown) => (typeof s === 'string' ? s.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '');

  return {
    events: rows.map((r, i) => {
      const t = targets[i];
      const lead = t?.type === 'LEAD' && t.id ? leadById.get(t.id) : undefined;
      const cust = t?.type === 'CUSTOMER' ? (t.id ? custById.get(t.id) : t.number ? custByNumber.get(t.number) : undefined) : undefined;
      const person = lead ?? cust;
      let detail: string | null = null;
      if (r.action === 'LEAD_CREATED') detail = lead?.source ?? null;
      else if (r.action === 'LEAD_STATUS_CHANGED' || r.action === 'LEAD_REOPENED') detail = r.before?.status && r.after?.status ? `${label(r.before.status)} → ${label(r.after.status)}` : null;
      else if (r.action === 'FAMILY_MEMBER_ADDED') detail = str(r.after?.name);
      else if (r.entity === 'task') detail = tasks.get(r.entityId)?.title ?? null;
      else if (r.action === 'LEAD_CONTACT_LOGGED') detail = label(r.after?.outcome);
      return {
        id: r._id, entity: r.entity, entityId: r.entityId, ref: r.entityRef ?? null, action: r.action, at: r.at, byRole: r.actorRole ?? null, byUserId: r.actorUserId ?? null,
        title: ACTIVITY_TITLE[r.action] ?? label(r.action), name: person?.name ?? null, detail,
        open: lead ? { type: 'LEAD', id: lead._id } : cust ? { type: 'CUSTOMER', id: cust._id } : null,
      };
    }),
    ...empty(rows.length),
  };
}

/** Profile completion card: hidden (null) at 100%. */
export async function profileCard(ctx: AuthContext) {
  const p = await getProfile(ctx);
  return p.completion.percent >= 100 ? { hidden: true } : { hidden: false, percent: p.completion.percent, missing: p.completion.missing, message: p.completion.message ?? null };
}
// ════════ Change #22: the new dashboard widgets (and real counts for widgets that waited on later modules) ════════
import { clock as nowClock, istToday as todayIst } from '../../lib/clock.js';
import { LEAD_SOURCE_CODES, sourceLabel as labelOf } from '../../lib/leadSources.js';
const istDayStart = () => new Date(`${todayIst()}T00:00:00+05:30`);
const istMonthStart = () => new Date(`${todayIst().slice(0, 7)}-01T00:00:00+05:30`);

/** Leads at a glance: the total and the count per status (every status, Converted and Lost included). */
export async function leadStatusCounts(ctx: AuthContext) {
  const rows = await Lead.aggregate<{ _id: string; n: number }>([{ $match: { accountId: ctx.accountId } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  const byStatus: Record<string, number> = { NEW: 0, CONTACTED: 0, QUALIFIED: 0, FOLLOW_UP: 0, CONVERTED: 0, LOST: 0 };
  for (const r of rows) byStatus[r._id] = r.n;
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  return { total, byStatus, opens: { list: 'LEADS', filter: {} }, ...empty(total) };
}
/** Follow-ups due today and overdue (open leads, IST day). */
export async function followUps(ctx: AuthContext) {
  const start = istDayStart(); const end = new Date(start.getTime() + 86_400_000);
  const now = nowClock.now();
  const todayQ = { accountId: ctx.accountId, isOpen: true, nextFollowUpAt: { $gte: start, $lt: end } };
  const overdueQ = { accountId: ctx.accountId, isOpen: true, nextFollowUpAt: { $lt: now } };
  const pick = { name: 1, number: 1, nextFollowUpAt: 1 };
  type Row = { _id: string; name: string; number: string; nextFollowUpAt: Date };
  const [dueToday, overdue, firstToday, firstOverdue] = await Promise.all([
    Lead.countDocuments(todayQ),
    Lead.countDocuments(overdueQ),
    Lead.findOne(todayQ, pick).sort({ nextFollowUpAt: 1 }).lean<Row>(),
    Lead.findOne(overdueQ, pick).sort({ nextFollowUpAt: 1 }).lean<Row>(),
  ]);
  // Gap fix: the alert cards name the soonest lead ("Anand Kulkarni · 11:00 AM", "Ramesh Gowda · 2 days late").
  const card = (l: Row | null) => (l ? { id: l._id, name: l.name, number: l.number, at: l.nextFollowUpAt, daysLate: Math.max(0, Math.floor((start.getTime() - new Date(l.nextFollowUpAt).getTime()) / 86_400_000) + 1) } : null);
  return { dueToday, overdue, firstToday: card(firstToday), firstOverdue: card(firstOverdue), opens: { list: 'LEADS', filter: { followUp: 'today' } }, opensOverdue: { list: 'LEADS', filter: { followUp: 'overdue' } }, ...empty(dueToday + overdue) };
}
/** Lead sources this month: count and share per source (percentages to one decimal). */
export async function leadSources(ctx: AuthContext) {
  const rows = await Lead.aggregate<{ _id: { code: string | null; label: string }; n: number }>([
    { $match: { accountId: ctx.accountId, createdAt: { $gte: istMonthStart() } } },
    { $group: { _id: { code: '$sourceCode', label: '$source' }, n: { $sum: 1 } } },
  ]);
  const merged = new Map<string, { code: string | null; label: string; count: number }>();
  for (const r of rows) {
    const code = r._id.code && (LEAD_SOURCE_CODES as readonly string[]).includes(r._id.code) ? r._id.code : null;
    const key = code ?? `label:${r._id.label}`;
    const cur = merged.get(key) ?? { code, label: code ? labelOf(code as never) : r._id.label, count: 0 };
    cur.count += r.n; merged.set(key, cur);
  }
  const total = [...merged.values()].reduce((a, b) => a + b.count, 0);
  const sources = [...merged.values()].sort((a, b) => b.count - a.count).map((s) => ({ ...s, percent: total ? Math.round((s.count * 1000) / total) / 10 : 0 }));
  return { total, sources, opens: { list: 'LEADS', filter: {} }, ...empty(total) };
}
/** Insurance catalogue: live products per insurance type the advisor can quote (SkyUp-verified and their own), and how many are new in the last 30 days. */
export async function catalogueSummary(ctx: AuthContext) {
  const { Product } = await import('../catalogue/product.model.js');
  const { InsuranceType } = await import('../catalogue/types.model.js');
  const since = new Date(nowClock.now().getTime() - 30 * 86_400_000);
  const rows = await Product.aggregate<{ _id: string; n: number; fresh: number }>([
    { $match: { status: { $in: ['ACTIVE', 'UPCOMING'] }, $or: [{ kind: 'VERIFIED' }, { kind: 'OWN', accountId: ctx.accountId }] } },
    { $group: { _id: '$typeId', n: { $sum: 1 }, fresh: { $sum: { $cond: [{ $gte: ['$createdAt', since] }, 1, 0] } } } },
  ]);
  const names = new Map((await InsuranceType.find({ _id: { $in: rows.map((r) => r._id) } }, { name: 1 }).lean<Array<{ _id: string; name: string }>>()).map((t) => [t._id, t.name]));
  const types = rows.map((r) => ({ typeId: r._id, name: names.get(r._id) ?? 'Other', products: r.n, newLast30Days: r.fresh })).sort((a, b) => a.name.localeCompare(b.name));
  const total = types.reduce((a, b) => a + b.products, 0);
  return { total, types, opens: { list: 'CATALOGUE', filter: {} }, ...empty(total) };
}
/** Ad leads today: leads imported from campaigns since midnight (IST), per channel. */
export async function adLeadsToday(ctx: AuthContext) {
  const { Submission } = await import('../campaigns/campaign.model.js');
  const rows = await Submission.aggregate<{ _id: string; n: number }>([{ $match: { accountId: ctx.accountId, status: 'IMPORTED', createdAt: { $gte: istDayStart() } } }, { $group: { _id: '$channel', n: { $sum: 1 } } }]);
  const byChannel = Object.fromEntries(rows.map((r) => [r._id, r.n]));
  const count = rows.reduce((a, b) => a + b.n, 0);
  return { count, byChannel, opens: { list: 'CAMPAIGNS', filter: { tab: 'log', status: 'IMPORTED' } }, ...empty(count) };
}
/** Open quotations (ready or shared), now that Module 10 exists. */
export async function openQuotations(ctx: AuthContext) {
  const { Quotation } = await import('../quotations/quotation.model.js');
  const count = await Quotation.countDocuments({ accountId: ctx.accountId, status: { $in: ['READY', 'SHARED'] } });
  return { count, available: true, opens: { list: 'QUOTATIONS', filter: { status: ['READY', 'SHARED'] } }, ...empty(count) };
}
/** Policies in force (issued), now that Module 12 exists. */
export async function policiesInForce(ctx: AuthContext) {
  const { Policy } = await import('../policies/policy.model.js');
  const count = await Policy.countDocuments({ accountId: ctx.accountId, status: 'ISSUED' });
  return { count, available: true, opens: { list: 'POLICIES', filter: { status: ['ISSUED'] } }, ...empty(count) };
}
/** Renewals due cards: due now, in follow-up, coming in the next 30 days, and lapsed this month. */
export async function renewalsDue(ctx: AuthContext) {
  const { RenewalCycle } = await import('../renewals/renewal.model.js');
  const today = todayIst();
  const in30 = new Date(new Date(`${today}T00:00:00Z`).getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
  const [due, inFollowUp, upcoming30, lapsedThisMonth] = await Promise.all([
    RenewalCycle.countDocuments({ accountId: ctx.accountId, status: 'DUE' }),
    RenewalCycle.countDocuments({ accountId: ctx.accountId, status: 'IN_FOLLOW_UP' }),
    RenewalCycle.countDocuments({ accountId: ctx.accountId, status: 'UPCOMING', dueDate: { $lte: in30 } }),
    RenewalCycle.countDocuments({ accountId: ctx.accountId, status: 'LAPSED', updatedAt: { $gte: istMonthStart() } }),
  ]);
  const count = due + inFollowUp;
  // Gap fix: the three soonest renewals for the dashboard cards (customer, insurer, plan, date, premium).
  const { renewalRows } = await import('../renewals/renewals.service.js');
  const next = await RenewalCycle.find({ accountId: ctx.accountId, status: { $in: ['DUE', 'IN_FOLLOW_UP', 'UPCOMING'] } }).sort({ dueDate: 1 }).limit(3).lean();
  const items = await renewalRows(next as never[]);
  return { count, cards: { due, inFollowUp, upcoming30, lapsedThisMonth }, items, available: true, opens: { list: 'RENEWALS', filter: { status: ['DUE', 'IN_FOLLOW_UP'] } }, ...empty(count) };
}