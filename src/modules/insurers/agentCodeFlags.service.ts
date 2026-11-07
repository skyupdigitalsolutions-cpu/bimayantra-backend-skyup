/** Change #55: raising, listing and resolving agent-code flags (DEC-09). See agentCodeFlag.model.ts for the rules. */
import type { Request } from 'express';
import { clock } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { isDuplicateKey, withTx } from '../../lib/mongo.js';
import { audit } from '../audit/audit.service.js';
import { notify, notifySkyUp } from '../notifications/notifications.service.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { User } from '../users/user.model.js';
import { AgentCodeFlag, type AgentCodeFlagDoc } from './agentCodeFlag.model.js';
import { Insurer } from './insurer.model.js';
import { InsurerMapping, type MappingDoc } from './mapping.model.js';

/** Open (or add accounts to) the review item for this insurer + code, and tell SkyUp once per new item. */
export async function raiseFlag(insurerId: string, agentCode: string, accountIds: string[]) {
  const now = clock.now();
  let created = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const before = await AgentCodeFlag.findOneAndUpdate(
        { insurerId, agentCode, status: 'OPEN' },
        { $addToSet: { accountIds: { $each: accountIds } }, $setOnInsert: { raisedAt: now } },
        { upsert: true, new: false },
      ).lean();
      created = !before;
      break;
    } catch (e) { if (!isDuplicateKey(e) || attempt) throw e; } // two saves at once: the second updates the item the first made
  }
  const flag = (await AgentCodeFlag.findOne({ insurerId, agentCode, status: 'OPEN' }).lean<AgentCodeFlagDoc>())!;
  if (created) {
    const ins = await Insurer.findById(insurerId, { name: 1 }).lean<{ name: string }>();
    await notifySkyUp({ kind: 'AGENT_CODE_FLAGGED', messageId: 'AGC-04', params: { code: agentCode, insurer: ins?.name ?? '', n: flag.accountIds.length }, dedupeKey: `AGC-04|${flag._id}`, link: { type: 'AGENT_CODE_FLAG', id: flag._id } }).catch(() => undefined);
  }
  return flag;
}

/**
 * Flags saved before this change exist only as `flaggedAt` on the mappings. Turn each such group into a review
 * item once (no bell: they were raised earlier). Cheap when there is nothing to do.
 */
async function adoptOldFlags() {
  const groups = await InsurerMapping.aggregate<{ _id: { insurerId: string; agentCode: string }; accountIds: string[]; at: Date }>([
    { $match: { flaggedAt: { $type: 'date' } } },
    { $group: { _id: { insurerId: '$insurerId', agentCode: '$agentCode' }, accountIds: { $addToSet: '$accountId' }, at: { $min: '$flaggedAt' } } },
  ]);
  if (!groups.length) return;
  const known = await AgentCodeFlag.find({ $or: groups.map((g) => ({ insurerId: g._id.insurerId, agentCode: g._id.agentCode })) }, { insurerId: 1, agentCode: 1 }).lean<Array<{ insurerId: string; agentCode: string }>>();
  for (const g of groups) {
    if (known.some((k) => k.insurerId === g._id.insurerId && k.agentCode === g._id.agentCode)) continue;
    await AgentCodeFlag.create({ insurerId: g._id.insurerId, agentCode: g._id.agentCode, accountIds: g.accountIds, raisedAt: g.at }).catch((e) => { if (!isDuplicateKey(e)) throw e; });
  }
}

/**
 * SF-01: flags by status. Each keeps the earlier fields (insurer, agentCode, accounts with advisorName and flaggedAt)
 * so older screens still work, and adds id, status, raisedAt, resolution and actions.
 */
export async function listFlags(q: { status?: 'OPEN' | 'RESOLVED' | 'ALL' }) {
  await adoptOldFlags();
  const status = q.status ?? 'OPEN';
  const rows = await AgentCodeFlag.find(status === 'ALL' ? {} : { status }).sort({ raisedAt: -1 }).limit(500).lean<AgentCodeFlagDoc[]>();
  const accIds = [...new Set(rows.flatMap((r) => r.accountIds))];
  const [insurers, advisors, maps, people] = await Promise.all([
    Insurer.find({ _id: { $in: rows.map((r) => r.insurerId) } }, { name: 1 }).lean<Array<{ _id: string; name: string }>>(),
    User.find({ accountId: { $in: accIds }, role: 'ADV' }, { name: 1, accountId: 1 }).lean<Array<{ name: string; accountId: string }>>(),
    InsurerMapping.find({ accountId: { $in: accIds }, insurerId: { $in: rows.map((r) => r.insurerId) } }, { accountId: 1, insurerId: 1, agentCode: 1, status: 1, flaggedAt: 1 }).lean<MappingDoc[]>(),
    User.find({ _id: { $in: rows.flatMap((r) => [r.resolvedBy, ...r.actions.map((a) => a.by)]).filter(Boolean) as string[] } }, { name: 1 }).lean<Array<{ _id: string; name: string }>>(),
  ]);
  const adv = new Map(advisors.map((a) => [a.accountId, a.name]));
  const who = new Map(people.map((p) => [p._id, p.name]));
  const counts = { OPEN: await AgentCodeFlag.countDocuments({ status: 'OPEN' }), RESOLVED: await AgentCodeFlag.countDocuments({ status: 'RESOLVED' }) };
  return {
    counts,
    items: rows.map((r) => ({
      id: r._id, insurerId: r.insurerId, insurer: insurers.find((i) => i._id === r.insurerId)?.name ?? r.insurerId, agentCode: r.agentCode, status: r.status, raisedAt: r.raisedAt, version: r.version,
      accounts: r.accountIds.map((a) => {
        const m = maps.find((x) => x.accountId === a && x.insurerId === r.insurerId);
        return { accountId: a, advisorName: adv.get(a) ?? null, flaggedAt: m?.flaggedAt ?? r.raisedAt, mappingStatus: m ? (m.agentCode === r.agentCode ? m.status : 'CODE_CHANGED') : 'REMOVED' };
      }),
      resolution: r.resolution, removedFromAccountId: r.removedFromAccountId, resolvedBy: r.resolvedBy ? who.get(r.resolvedBy) ?? null : null, resolvedAt: r.resolvedAt,
      actions: r.actions.map((a) => ({ type: a.type, accountId: a.accountId, note: a.note, by: who.get(a.by) ?? null, at: a.at })),
    })),
  };
}

export type Resolution = 'BOTH_VALID' | 'REMOVED_FROM_ACCOUNT' | 'ASKED_ADVISORS';
/** SF-02: resolve with an option and a note (Staff or Admin). Version-checked, so two reviewers cannot both act. */
export async function resolveFlag(ctx: AuthContext, id: string, b: { version: number; resolution: Resolution; accountId?: string | null; note: string }, req: Request) {
  const f = await AgentCodeFlag.findById(id).lean<AgentCodeFlagDoc>();
  if (!f) throw AppError.notFound();
  if (f.status !== 'OPEN') throw AppError.invalidState('agent code flag', 'RESOLVED');
  if (b.resolution === 'REMOVED_FROM_ACCOUNT' && (!b.accountId || !f.accountIds.includes(b.accountId))) throw AppError.field('accountId', b.accountId ? 'VAL-22' : 'GEN-01', b.accountId ? {} : { 'Field label': 'Account' });
  const now = clock.now();
  const resolved = b.resolution !== 'ASKED_ADVISORS';
  const insurer = (await Insurer.findById(f.insurerId, { name: 1 }).lean<{ name: string }>())?.name ?? '';
  const out = await withTx(async (session) => {
    const u = await AgentCodeFlag.findOneAndUpdate(
      { _id: id, status: 'OPEN', version: b.version },
      {
        $push: { actions: { type: b.resolution, accountId: b.accountId ?? null, note: b.note, by: ctx.userId, at: now } }, $inc: { version: 1 },
        ...(resolved ? { $set: { status: 'RESOLVED', resolution: b.resolution, removedFromAccountId: b.accountId ?? null, resolvedBy: ctx.userId, resolvedAt: now } } : {}),
      },
      { new: true, session: session ?? undefined },
    ).lean<AgentCodeFlagDoc>();
    if (!u) throw AppError.versionConflict('agent code flag', null);
    if (b.resolution === 'REMOVED_FROM_ACCOUNT') {
      // §9.9 (Q120): the mapping is deactivated (quotations need an active code); its history stays.
      await InsurerMapping.updateOne({ accountId: b.accountId, insurerId: f.insurerId, agentCode: f.agentCode }, { $set: { status: 'INACTIVE' }, $inc: { version: 1 } }, { session: session ?? undefined });
    }
    if (resolved) await InsurerMapping.updateMany({ accountId: { $in: f.accountIds }, insurerId: f.insurerId, agentCode: f.agentCode }, { $set: { flaggedAt: null } }, { session: session ?? undefined });
    await audit({ entity: 'agentCodeFlag', entityId: id, action: `AGENT_CODE_FLAG_${b.resolution}`, after: { insurerId: f.insurerId, agentCode: f.agentCode, accountId: b.accountId ?? null, note: b.note } }, { req, session });
    return u;
  });
  // Advisors are told only when SkyUp acts on their account (the flag itself stays silent, DEC-09)
  const tell = b.resolution === 'ASKED_ADVISORS' ? f.accountIds : b.resolution === 'REMOVED_FROM_ACCOUNT' ? [b.accountId!] : [];
  const advisors = await User.find({ accountId: { $in: tell }, role: 'ADV' }, { _id: 1, accountId: 1 }).lean<Array<{ _id: string; accountId: string }>>();
  for (const a of advisors) {
    await notify({
      userId: a._id, accountId: a.accountId, kind: b.resolution === 'ASKED_ADVISORS' ? 'AGENT_CODE_QUESTION' : 'AGENT_CODE_REMOVED',
      messageId: b.resolution === 'ASKED_ADVISORS' ? 'AGC-02' : 'AGC-03', params: { code: f.agentCode, insurer, note: b.note },
      dedupeKey: `AGC|${id}|${out.version}|${a.accountId}`, link: { type: 'PROFILE', id: a.accountId },
    }).catch(() => undefined);
  }
  return { id: out._id, status: out.status, resolution: out.resolution, version: out.version };
}