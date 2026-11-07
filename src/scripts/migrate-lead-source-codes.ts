/**
 * Change #17: backfill stable lead source codes. Dry run unless --apply is given.
 *   npm run db:migrate:lead-sources            # report only
 *   npm run db:migrate:lead-sources -- --apply # write
 */
import '../app.js'; // registers every model
import { connectMongo, disconnectMongo } from '../lib/mongo.js';
import { loadConfigOverrides } from '../config/cfg.js';
import { migrateLeadSourceCodes } from '../modules/leads/sourceMigration.js';

const apply = process.argv.includes('--apply');
await connectMongo();
await loadConfigOverrides();
const report = await migrateLeadSourceCodes({ apply });
console.log(JSON.stringify(report, null, 2));
if (!apply) console.log('\nDry run: nothing was written. Run again with --apply to write.');
await disconnectMongo();