/**
 * Change #18 (change analysis §4.4 step 1): split each account's "Life and Term" pipeline. Dry run unless `apply`.
 *  - "Life and Term" is renamed "Life" (same ID, so its leads, stage history and campaign settings stay attached).
 *    If the account already has a "Life" pipeline, the leads move into that one instead and the old pipeline goes;
 *    campaign connections and forms that pointed at it follow.
 *  - A "Term" pipeline is added if missing, and every lead in the old pipeline whose interests mention Term moves to it
 *    (rule to confirm with the client, OPEN-QUESTIONS Q106). Stage and stage history are unchanged.
 * Safe to run again: an account without a "Life and Term" pipeline is left alone.
 */
import { newId } from '../../lib/ids.js';
import { Account } from '../accounts/account.model.js';
import { Connection, LeadForm } from '../campaigns/campaign.model.js';
import { Lead } from '../leads/lead.model.js';

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const isTerm = (interests: string[] | null | undefined) => (interests ?? []).some((i) => /\bterm\b/i.test(i));

export async function runLifeTermSplit(opts: { apply: boolean }) {
  const report = { apply: opts.apply, accounts: 0, renamedToLife: 0, mergedIntoLife: 0, termPipelinesAdded: 0, leadsToTerm: 0, leadsStayInLife: 0 };
  for await (const a of Account.find({ 'pipelines.name': { $regex: /^\s*life\s+and\s+term\s*$/i } }, { pipelines: 1 }).lean<{ _id: string; pipelines: Array<{ _id: string; name: string; position: number }> }>().cursor()) {
    report.accounts++;
    const old = a.pipelines.find((p) => norm(p.name) === 'life and term')!;
    const life = a.pipelines.find((p) => norm(p.name) === 'life');
    const term = a.pipelines.find((p) => norm(p.name) === 'term');
    const leads = await Lead.find({ accountId: a._id, pipelineId: old._id }, { interests: 1 }).lean<Array<{ _id: string; interests: string[] }>>();
    const toTerm = leads.filter((l) => isTerm(l.interests)).map((l) => l._id);
    report.leadsToTerm += toTerm.length;
    report.leadsStayInLife += leads.length - toTerm.length;
    if (life) report.mergedIntoLife++; else report.renamedToLife++;
    if (!term) report.termPipelinesAdded++;
    if (!opts.apply) continue;

    const lifeId = life?._id ?? old._id;
    const termId = term?._id ?? newId('pip');
    // the new list: Life where "Life and Term" was, Term right after it, positions 1..n again
    let list = a.pipelines.filter((p) => p._id !== old._id || !life).map((p) => (p._id === old._id ? { ...p, name: 'Life' } : p));
    if (!term) {
      const at = list.findIndex((p) => p._id === lifeId);
      list = [...list.slice(0, at + 1), { _id: termId, name: 'Term', position: 0 }, ...list.slice(at + 1)];
    }
    list = list.map((p, i) => ({ ...p, position: i + 1 }));
    await Account.updateOne({ _id: a._id }, { $set: { pipelines: list } });
    if (toTerm.length) await Lead.updateMany({ accountId: a._id, _id: { $in: toTerm } }, { $set: { pipelineId: termId } });
    if (life) {
      await Lead.updateMany({ accountId: a._id, pipelineId: old._id }, { $set: { pipelineId: lifeId } });
      await Connection.updateMany({ accountId: a._id, pipelineId: old._id }, { $set: { pipelineId: lifeId } });
      await LeadForm.updateMany({ accountId: a._id, pipelineId: old._id }, { $set: { pipelineId: lifeId } });
    }
  }
  return report;
}