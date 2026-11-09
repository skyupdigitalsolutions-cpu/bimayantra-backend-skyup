/**
 * DEMO ONLY: agent codes for every insurer with live products, for one advisor (by mobile). Dry run unless --apply.
 *   npm run demo:agent-codes -- 9876543210            # report only
 *   npm run demo:agent-codes -- 9876543210 --apply    # write   (PowerShell: '--' in quotes)
 */
import { connectMongo, disconnectMongo } from '../lib/mongo.js';
import { demoAgentCodes } from '../modules/demo/demoAgentCodes.js';

const args = process.argv.slice(2);
const mobile = args.find((a) => !a.startsWith('--'));
if (!mobile) { console.error('Usage: npm run demo:agent-codes -- <advisor mobile> [--apply]'); process.exit(1); }
const apply = args.includes('--apply') || process.env.npm_config_apply === 'true';
await connectMongo();
try {
  console.log(JSON.stringify(await demoAgentCodes(mobile, { apply }), null, 2));
  if (!apply) console.log('\nDry run: nothing was written. Run again with --apply to write.');
} catch (e) { console.error((e as Error).message); process.exitCode = 1; }
await disconnectMongo();