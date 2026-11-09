/**
 * DEMO ONLY: give one advisor an agent code for every insurer that has live SkyUp products, so the demo catalogue can
 * be quoted, compared and ranked at once. Real advisors add their own codes in Settings › My insurers (P-07).
 *
 * Codes are `D-<insurer code>-<4 characters of the account>` (unique per account, so the cross-account agent-code check,
 * DEC-09, is not tripped). An insurer the advisor already has (active or not) is left as it is. Dry run unless `apply`.
 */
import { cfgRange } from '../../config/cfg.js';
import { normalizeMobile } from '../../lib/phone.js';
import { Insurer } from '../insurers/insurer.model.js';
import { InsurerMapping } from '../insurers/mapping.model.js';
import { Product } from '../catalogue/product.model.js';
import { User } from '../users/user.model.js';

export async function demoAgentCodes(mobileRaw: string, opts: { apply: boolean }) {
  const mobile = normalizeMobile(mobileRaw);
  if (!mobile) throw new Error(`Not a valid mobile number: ${mobileRaw}`);
  const user = await User.findOne({ mobile }, { accountId: 1, name: 1, role: 1 }).lean<{ _id: string; accountId: string | null; name: string; role: string }>();
  if (!user?.accountId) throw new Error(`No advisor account for ${mobileRaw}`);
  const insurerIds = await Product.distinct('insurerId', { kind: 'VERIFIED', status: { $in: ['ACTIVE', 'UPCOMING'] }, publishedVersionId: { $ne: null } });
  const insurers = await Insurer.find({ _id: { $in: insurerIds }, status: 'ACTIVE', ownerAccountId: null }, { name: 1, shortCode: 1 }).sort({ name: 1 }).lean<Array<{ _id: string; name: string; shortCode: string }>>();
  const have = new Set((await InsurerMapping.find({ accountId: user.accountId }, { insurerId: 1 }).lean<Array<{ insurerId: string }>>()).map((m) => m.insurerId));
  const max = cfgRange('CFG-106').max;
  const tail = user.accountId.slice(-4).toUpperCase();
  const report = { apply: opts.apply, advisor: user.name, added: [] as Array<{ insurer: string; agentCode: string }>, alreadyThere: [] as string[] };
  for (const i of insurers) {
    if (have.has(i._id)) { report.alreadyThere.push(i.name); continue; }
    const agentCode = `D-${i.shortCode}-${tail}`.slice(0, max);
    if (opts.apply) await InsurerMapping.create({ accountId: user.accountId, insurerId: i._id, agentCode, status: 'ACTIVE', declaredAt: new Date(), createdBy: 'system:demo' });
    report.added.push({ insurer: i.name, agentCode });
  }
  return report;
}