/**
 * A person withdrew their ad-form submission (LinkedIn "DELETED" lead action, OPEN-QUESTIONS Q97, client decision):
 * their submitted answers are cleared (campaigns.service), the lead is marked as withdrawn and the advisor is told.
 * The advisor then keeps the lead (only the answers stay cleared) or removes it with its tasks.
 */
import type { Request } from 'express';
import { AppError } from '../../lib/errors.js';
import { clock } from '../../lib/clock.js';
import { withTx } from '../../lib/mongo.js';
import { accountOf } from '../../middleware/authorize.js';
import { audit } from '../audit/audit.service.js';
import { Call } from '../calls/call.model.js';
import { Submission } from '../campaigns/campaign.model.js';
import { Notification } from '../notifications/notification.model.js';
import { notify } from '../notifications/notifications.service.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { ReferralSubmission } from '../referrals/referral.model.js';
import { Task } from '../tasks/task.model.js';
import { User } from '../users/user.model.js';
import { Lead, type LeadDoc } from './lead.model.js';

const CHANNEL_NAME: Record<string, string> = { LINKEDIN: 'LinkedIn', META: 'Meta', GOOGLE: 'Google', WEBSITE: 'website' };

/** Called after the answers were cleared: mark each linked lead and ring the advisor's bell once. */
export async function markWithdrawn(leadIds: string[], channel: string) {
  for (const id of [...new Set(leadIds.filter(Boolean))]) {
    const l = await Lead.findOneAndUpdate({ _id: id, withdrawal: null }, { $set: { withdrawal: { at: clock.now(), channel, decision: null, decidedAt: null } }, $inc: { version: 1 } }, { new: true }).lean<LeadDoc>();
    if (!l) continue; // already marked, or the lead was removed
    const adv = await User.findOne({ accountId: l.accountId, role: 'ADV' }, { _id: 1 }).lean<{ _id: string }>();
    if (adv) {
      await notify({ userId: adv._id, accountId: l.accountId, kind: 'LEAD_WITHDRAWN', messageId: 'CMP-16', params: { name: l.name, channel: CHANNEL_NAME[channel] ?? channel },
        dedupeKey: `CMP-16|${l._id}`, link: { type: 'LEAD', id: l._id } }).catch(() => undefined);
    }
    await audit({ entity: 'lead', entityId: l._id, entityRef: l.number, action: 'LEAD_FORM_WITHDRAWN', after: { channel }, actor: { userId: null, role: 'SYSTEM', accountId: l.accountId, label: `${CHANNEL_NAME[channel] ?? channel} (person withdrew)` } }).catch(() => undefined);
  }
}

async function loadWithdrawn(ctx: AuthContext, id: string, version: number) {
  const l = await Lead.findOne({ _id: id, accountId: accountOf(ctx) }).lean<LeadDoc>();
  if (!l) throw AppError.notFound();
  if (!(l as { withdrawal?: unknown }).withdrawal) throw new AppError(409, 'INVALID_STATE', 'CMP-19');
  if (l.version !== version) throw AppError.versionConflict('lead', { id: l._id, version: l.version });
  return l;
}

/** "Keep lead": the answers stay cleared, the lead stays as it is. */
export async function keepLead(ctx: AuthContext, id: string, b: { version: number }, req: Request) {
  const l = await loadWithdrawn(ctx, id, b.version);
  const u = await Lead.findOneAndUpdate({ _id: id, version: b.version }, { $set: { 'withdrawal.decision': 'KEPT', 'withdrawal.decidedAt': clock.now() }, $inc: { version: 1 } }, { new: true }).lean<LeadDoc>();
  if (!u) throw AppError.versionConflict('lead', { id: l._id, version: l.version });
  await audit({ entity: 'lead', entityId: id, entityRef: l.number, action: 'LEAD_KEPT_AFTER_WITHDRAWAL' }, { req });
  return { id, kept: true };
}

/**
 * "Remove lead": the lead and its tasks are deleted; call logs, form submissions and referral entries keep their own
 * record without the link; its bell items go too. A converted lead belongs to a policy holder and is refused (CMP-20).
 */
export async function removeLead(ctx: AuthContext, id: string, b: { version: number; reason?: string | null }, req: Request) {
  const l = await loadWithdrawn(ctx, id, b.version);
  if (l.status === 'CONVERTED' || l.customerId) throw new AppError(409, 'INVALID_STATE', 'CMP-20');
  const accountId = l.accountId;
  await withTx(async (session) => {
    const gone = await Lead.deleteOne({ _id: id, accountId, version: b.version }, { session: session ?? undefined });
    if (!gone.deletedCount) throw AppError.versionConflict('lead', { id, version: l.version });
    await Task.deleteMany({ accountId, linkedId: id }, { session: session ?? undefined });
    await Submission.updateMany({ accountId, leadId: id }, { $set: { leadId: null, reason: 'Lead removed after the person withdrew' } }, { session: session ?? undefined });
    await Call.updateMany({ accountId, leadId: id }, { $set: { leadId: null } }, { session: session ?? undefined });
    await ReferralSubmission.updateMany({ accountId, leadId: id }, { $set: { leadId: null } }, { session: session ?? undefined });
    await Notification.deleteMany({ accountId, linkType: 'LEAD', linkId: id }, { session: session ?? undefined });
    // No personal data in the audit entry: the lead number and the reason only.
    await audit({ entity: 'lead', entityId: id, entityRef: l.number, action: 'LEAD_REMOVED', after: { reason: b.reason ?? 'Person withdrew their form', channel: (l as { withdrawal?: { channel?: string } }).withdrawal?.channel ?? null } }, { req, session });
  });
  return { id, number: l.number, removed: true };
}