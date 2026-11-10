/**
 * Merge advisors' private categories that duplicate a SkyUp category (e.g. a private "Health") into the SkyUp one.
 *   npm run catalogue:merge-duplicates             # report only
 *   npm run catalogue:merge-duplicates -- --apply  # write  (PowerShell: '--' in quotes)
 */
import { connectMongo, disconnectMongo } from '../lib/mongo.js';
import { mergeDuplicateCategories } from '../modules/catalogue/private.service.js';

const apply = process.argv.includes('--apply') || process.env.npm_config_apply === 'true';
await connectMongo();
const report = await mergeDuplicateCategories({ apply });
console.log(report.length ? JSON.stringify(report, null, 2) : 'No duplicate categories found.');
if (!apply && report.length) console.log('\nDry run: nothing was written. Run again with --apply to merge.');
await disconnectMongo();
process.exit(0);