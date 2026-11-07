import { cfgNum } from '../../config/cfg.js';
import { clock, istTime } from '../../lib/clock.js';
import { logger } from '../../lib/logger.js';
import { Customer } from '../customers/customer.model.js';
import { Lead } from '../leads/lead.model.js';
import { Task, type TaskDoc } from '../tasks/task.model.js';
import { User } from '../users/user.model.js';
import { notify, removeOld } from './notifications.service.js';

/**
 * Runs every minute (server.ts). Safe to run on several API servers at once: every reminder goes through
 * the bell's unique dedupe key, so a repeated or parallel sweep never creates a second item.
 *  - DSH-11: OPEN tasks whose due time is within CFG-34 and still ahead, once per task and due time (AC-P11-2).
 *  - P-10 step 4: bell items older than CFG-72 are removed.
 */
export async function runSweep(now = clock.now()) {
  const soon = new Date(now.getTime() + cfgNum('CFG-34') * 60_000);
  const due = await Task.find({ status: 'OPEN', dueAt: { $gt: now, $lte: soon }, $expr: { $ne: ['$remindedFor', '$dueAt'] } }).limit(500).lean<TaskDoc[]>();
  let reminders = 0;
  for (const t of due) {
    const adv = await User.findOne({ accountId: t.accountId, role: 'ADV' }, { _id: 1 }).lean<{ _id: string }>();
    if (!adv) continue;
    let name = t.title;
    if (t.linkedId) {
      const rec = t.linkedType === 'LEAD' ? await Lead.findById(t.linkedId, { name: 1 }).lean<{ name: string }>() : await Customer.findById(t.linkedId, { name: 1 }).lean<{ name: string }>();
      if (rec) name = rec.name;
    }
    const created = await notify({
      userId: adv._id, accountId: t.accountId, kind: 'TASK_DUE_SOON', messageId: 'DSH-11', params: { name, time: istTime(t.dueAt) },
      dedupeKey: `DSH-11|${t._id}|${new Date(t.dueAt).toISOString()}`, link: { type: 'TASK', id: t._id },
    });
    await Task.updateOne({ _id: t._id, dueAt: t.dueAt }, { $set: { remindedFor: t.dueAt } });
    if (created) reminders++;
  }
  const removed = await removeOld(now);
  // SYS-01: quotations past their validity (repeat-safe, AC-P29-3)
  const { expireDue } = await import('../quotations/lifecycle.service.js');
  const expired = await expireDue();
  await (await import('../quotations/comparisons.service.js')).expireComparisons();
  // SYS-03: the daily renewal job, once per IST day after CFG-63
  await (await import('../renewals/renewals.service.js')).maybeRunDaily(now);
  // SYS-04 greetings once a day after CFG-65; SYS-08 the sender every minute (WhatsApp only inside CFG-64)
  const comms = await import('../comms/comms.service.js');
  await comms.maybeRunGreetings(now);
  await comms.sendDue(now);
  await comms.syncWhatsAppTemplates(now); // MSG91: Meta's template decisions, every 10 minutes
  // P-45: REF-08 to referrers when a referral's status changes
  await (await import('../referrals/referrals.service.js')).refreshShownStatuses();
  // SYS-05 subscriptions (once a day) and SYS-14 support-grant expiry
  await (await import('../admin/admin.service.js')).maybeRunSubscriptionJob(now);
  // Change #23: follow-up overdue (SYS-07 extension): open leads whose follow-up passed in the last day, once per due time
  await followUpOverdue(now);
  // Campaigns: Meta / LinkedIn catch-up every 15 minutes (leads a webhook missed)
  await (await import('../campaigns/campaigns.service.js')).maybeCatchUp(now);
  return { reminders, removed, expired };
}

let timer: NodeJS.Timeout | undefined;
export function startSweep() {
  timer = setInterval(() => { runSweep().catch((e: Error) => logger.warn({ reason: e.message }, 'Notification sweep failed; next run in a minute')); }, 60_000);
  timer.unref();
}
export function stopSweep() { if (timer) clearInterval(timer); }

/** Change #23 FOLLOW_UP_OVERDUE: the advisor is told once per lead and follow-up time (dedupe), only for the last day's misses. */
async function followUpOverdue(now: Date) {
  const { Lead } = await import('../leads/lead.model.js');
  const { User } = await import('../users/user.model.js');
  const { notify } = await import('./notifications.service.js');
  const leads = await Lead.find({ isOpen: true, nextFollowUpAt: { $lt: now, $gte: new Date(now.getTime() - 86_400_000) } }, { accountId: 1, name: 1, nextFollowUpAt: 1 }).limit(500).lean<Array<{ _id: string; accountId: string; name: string; nextFollowUpAt: Date }>>();
  const advisors = new Map<string, string | null>();
  for (const l of leads) {
    if (!advisors.has(l.accountId)) advisors.set(l.accountId, (await User.findOne({ accountId: l.accountId, role: 'ADV' }, { _id: 1 }).lean<{ _id: string }>())?._id ?? null);
    const adv = advisors.get(l.accountId);
    if (!adv) continue;
    const time = new Date(l.nextFollowUpAt.getTime() + 5.5 * 3_600_000).toISOString().slice(11, 16);
    await notify({ userId: adv, accountId: l.accountId, kind: 'FOLLOW_UP_OVERDUE', messageId: 'DSH-26', params: { name: l.name, time }, dedupeKey: `DSH-26|${l._id}|${l.nextFollowUpAt.toISOString()}`, link: { type: 'LEAD', id: l._id } }).catch(() => undefined);
  }
}