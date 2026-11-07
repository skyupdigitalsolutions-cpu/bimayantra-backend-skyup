import type { ClientSession } from 'mongoose';
import { cfgNum } from '../../config/cfg.js';
import { clock } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { msg, type MessageId, type MessageParams } from '../../lib/messages.js';
import { isDuplicateKey } from '../../lib/mongo.js';
import { Customer } from '../customers/customer.model.js';
import { Lead } from '../leads/lead.model.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { Task } from '../tasks/task.model.js';
import { Notification, type NotificationDoc } from './notification.model.js';

export interface NotifyInput {
  userId: string; accountId: string | null; kind: string; messageId: MessageId; params?: MessageParams;
  dedupeKey: string; link?: { type: NotificationDoc['linkType']; id: string } | null;
}

/** Create a bell item once per dedupe key (AC-P10-2). Returns false when it already existed. */
export async function notify(n: NotifyInput, session: ClientSession | null = null): Promise<boolean> {
  try {
    await new Notification({
      userId: n.userId, accountId: n.accountId, kind: n.kind, messageId: n.messageId, message: msg(n.messageId, n.params ?? {}),
      dedupeKey: n.dedupeKey, linkType: n.link?.type ?? null, linkId: n.link?.id ?? null,
    }).save({ session: session ?? undefined });
    return true;
  } catch (e) {
    if (isDuplicateKey(e, 'one_item_per_event')) return false;
    throw e;
  }
}

/** "99+" above CFG-149 (P-10 step 1). */
const shown = (n: number) => (n > cfgNum('CFG-149') ? `${cfgNum('CFG-149')}+` : String(n));

export async function unreadCount(ctx: AuthContext) {
  const unread = await Notification.countDocuments({ userId: ctx.userId, readAt: null });
  return { unread, shown: shown(unread) };
}

/**
 * Filters on the notifications page (change #60 for SkyUp; the advisor tabs of §5.2 use the same mechanism).
 * Each filter is a list of event kinds; UNREAD is the read state, ALL is everything.
 */
export const NOTIFICATION_FILTERS = {
  KYC: ['KYC_WAITING', 'KYC_VERIFIED', 'KYC_REJECTED'],
  CORRECTIONS: ['CORRECTION_SUBMITTED', 'CORRECTION_ACCEPTED', 'CORRECTION_REJECTED'],
  ACCOUNTS: ['AGENT_CODE_FLAGGED', 'TRIALS_ENDING', 'SUBSCRIPTION', 'PLAN_CHANGED', 'AGENT_CODE_QUESTION', 'AGENT_CODE_REMOVED', 'SUPPORT_SESSION'],
  TEMPLATES: ['TEMPLATE_REJECTED_BY_META', 'MESSAGE_TEMPLATE', 'TEMPLATE'],
  LEADS: ['AD_LEAD_ARRIVED', 'LEAD_FOLLOW_UP', 'FOLLOW_UP_OVERDUE', 'REFERRAL', 'REFERRAL_STATUS', 'LEAD_WITHDRAWN'],
  RENEWALS: ['RENEWAL_DUE', 'RENEWAL_LAPSED', 'POLICY'],
  PAYMENTS: ['WALLET', 'SUBSCRIPTION', 'QUOTATION_EXPIRED'],
  CATALOGUE: ['CATALOGUE_PRODUCT_PUBLISHED', 'CORRECTION_ACCEPTED', 'CORRECTION_REJECTED', 'OCR_DONE', 'OCR_FAILED'],
} as const;
export type NotificationFilter = 'ALL' | 'UNREAD' | keyof typeof NOTIFICATION_FILTERS;
/** The filter tab an event belongs to (first match in NOTIFICATION_FILTERS order), or OTHER. */
export function categoryOf(kind: string): keyof typeof NOTIFICATION_FILTERS | 'OTHER' {
  for (const [k, kinds] of Object.entries(NOTIFICATION_FILTERS)) if ((kinds as readonly string[]).includes(kind)) return k as keyof typeof NOTIFICATION_FILTERS;
  return 'OTHER';
}

/** The bell list: the user's own items, newest first (P-10 step 2), optionally filtered (change #60). */
export async function list(ctx: AuthContext, opts: { before?: Date; limit: number; filter?: NotificationFilter }) {
  const f = opts.filter ?? 'ALL';
  const byFilter = f === 'UNREAD' ? { readAt: null } : f === 'ALL' ? {} : { kind: { $in: [...NOTIFICATION_FILTERS[f]] } };
  const rows = await Notification.find({ userId: ctx.userId, ...byFilter, ...(opts.before ? { createdAt: { $lt: opts.before } } : {}) })
    .sort({ createdAt: -1 }).limit(opts.limit + 1).lean<NotificationDoc[]>();
  const items = rows.slice(0, opts.limit).map((r) => {
    // Gap fix: the page shows a bold title, a grey line under it and an icon per kind of event.
    const text = String(r.message ?? '');
    const cut = text.search(/\.\s/); // first sentence → title, the rest → subtitle
    return {
      id: r._id, messageId: r.messageId, message: r.message, createdAt: r.createdAt, read: !!r.readAt,
      link: r.linkType ? { type: r.linkType, id: r.linkId } : null,
      kind: r.kind, category: categoryOf(r.kind),
      title: cut > 0 ? text.slice(0, cut + 1).trim() : text,
      subtitle: cut > 0 ? text.slice(cut + 1).trim() || null : null,
    };
  });
  return { items, more: rows.length > opts.limit, ...(await unreadCount(ctx)) };
}

/** Is the linked record still visible to this user? Inaccessible links get GEN-11 and leak nothing (AC-P10-4). */
async function linkVisible(ctx: AuthContext, type: string, id: string): Promise<boolean> {
  switch (type) {
    case 'TASK': return !!(await Task.exists({ _id: id, accountId: ctx.accountId }));
    case 'LEAD': return !!(await Lead.exists({ _id: id, accountId: ctx.accountId }));
    case 'CUSTOMER': return !!(await Customer.exists({ _id: id, accountId: ctx.accountId }));
    case 'PROFILE': return id === ctx.accountId;
    case 'KYC_REVIEW': case 'CORRECTION': case 'MESSAGE_TEMPLATE': case 'AGENT_CODE_FLAG': case 'ACCOUNT': return ctx.role === 'STF' || ctx.role === 'ADM';
    case 'RENEWAL': { const { RenewalCycle } = await import('../renewals/renewal.model.js'); return !!(await RenewalCycle.exists({ _id: id, accountId: ctx.accountId })); }
    case 'PRODUCT': { const { Product } = await import('../catalogue/product.model.js'); return !!(await Product.exists({ _id: id, $or: [{ kind: 'VERIFIED' }, { kind: 'OWN', accountId: ctx.accountId }] })); }
    case 'CAMPAIGN': { const { Connection } = await import('../campaigns/campaign.model.js'); return !!(await Connection.exists({ _id: id, accountId: ctx.accountId })); }
    default: return false;
  }
}

/** Select an item: mark it READ, then open its record (P-10 step 3). */
export async function open(ctx: AuthContext, id: string) {
  const n = await Notification.findOne({ _id: id, userId: ctx.userId }).lean<NotificationDoc>();
  if (!n) throw AppError.notFound();
  await Notification.updateOne({ _id: id, readAt: null }, { $set: { readAt: clock.now() } }); // first read time is kept
  if (!n.linkType || !n.linkId) return { link: null, ...(await unreadCount(ctx)) };
  if (!(await linkVisible(ctx, n.linkType, n.linkId))) throw AppError.notFound(); // read, but nothing revealed
  return { link: { type: n.linkType, id: n.linkId }, ...(await unreadCount(ctx)) };
}

/** Every active SkyUp Staff and Admin is told once per event (change analysis §9.6, SN-01). */
export async function notifySkyUp(n: Omit<NotifyInput, 'userId' | 'accountId'>, session: ClientSession | null = null) {
  const { User } = await import('../users/user.model.js');
  const people = await User.find({ role: { $in: ['STF', 'ADM'] }, status: 'ACTIVE' }, { _id: 1 }).session(session).lean<Array<{ _id: string }>>();
  for (const p of people) await notify({ ...n, userId: p._id, accountId: null }, session);
  return people.length;
}

export async function readAll(ctx: AuthContext) {
  const r = await Notification.updateMany({ userId: ctx.userId, readAt: null }, { $set: { readAt: clock.now() } });
  return { marked: r.modifiedCount, ...(await unreadCount(ctx)) };
}

/** P-10 step 4: items older than CFG-72 are removed. */
export async function removeOld(now = clock.now()) {
  const before = new Date(now.getTime() - cfgNum('CFG-72') * 86_400_000);
  return (await Notification.deleteMany({ createdAt: { $lt: before } })).deletedCount;
}