import { ConfigValue, loadConfigOverrides } from '../../config/cfg.js';
import { LEAD_SOURCES, isSourceCode, offeredSourcesProblem, sourceCodeOf } from '../../lib/leadSources.js';
import { Customer } from '../customers/customer.model.js';
import { Lead } from './lead.model.js';

/**
 * Change #17 backfill: give every lead and converted customer its stable source code, and turn a CFG-133 value an
 * Admin saved as labels into codes. Safe to run again (it only touches rows still without a code). Record versions
 * are NOT changed, so a form open during the run still saves (no GEN-05).
 *
 * Dry run by default: the report says what would change. Labels that match no code are reported and left alone;
 * those rows keep working (their label shows) but their source must be chosen again before it can be corrected.
 */
export async function migrateLeadSourceCodes(opts: { apply: boolean }) {
  const report = {
    applied: opts.apply,
    leads: [] as Array<{ label: string; code: string; count: number }>,
    customers: [] as Array<{ label: string; code: string; count: number }>,
    unknownLabels: { leads: [] as Array<{ label: string; count: number }>, customers: [] as Array<{ label: string; count: number }> },
    cfg133: null as null | { before: unknown; after: string[] | null; dropped: string[] },
  };

  for (const [M, out, unknown] of [[Lead, report.leads, report.unknownLabels.leads], [Customer, report.customers, report.unknownLabels.customers]] as const) {
    const groups = await (M as typeof Lead).aggregate<{ _id: string; n: number }>([{ $match: { $or: [{ sourceCode: null }, { sourceCode: { $exists: false } }] } }, { $group: { _id: '$source', n: { $sum: 1 } } }]);
    for (const g of groups) {
      if (M === Customer && g._id === 'Direct') continue; // added directly, not from a lead: no source code
      const code = sourceCodeOf(g._id);
      if (!code) { unknown.push({ label: g._id, count: g.n }); continue; }
      out.push({ label: g._id, code, count: g.n });
      if (opts.apply) await (M as typeof Lead).updateMany({ source: g._id, $or: [{ sourceCode: null }, { sourceCode: { $exists: false } }] }, { $set: { sourceCode: code } }, { timestamps: false });
    }
  }

  const saved = await ConfigValue.findById('CFG-133').lean<{ value: unknown }>();
  if (saved && offeredSourcesProblem(saved.value) !== null && Array.isArray(saved.value)) {
    const codes: string[] = []; const dropped: string[] = [];
    for (const v of saved.value as unknown[]) {
      const c = typeof v === 'string' ? sourceCodeOf(v) : null;
      if (c && !('legacy' in LEAD_SOURCES[c]) && isSourceCode(c) && !codes.includes(c)) codes.push(c); else dropped.push(String(v));
    }
    report.cfg133 = { before: saved.value, after: codes.length ? codes : null, dropped };
    if (opts.apply) {
      if (codes.length) await ConfigValue.updateOne({ _id: 'CFG-133' }, { $set: { value: codes } });
      else await ConfigValue.deleteOne({ _id: 'CFG-133' }); // nothing usable: back to the documented default
      await loadConfigOverrides();
    }
  }
  return report;
}