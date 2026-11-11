/**
 * Products whose category no longer exists (they show no category and are missing from the category tabs, Best fit
 * and quotations) are moved to the matching current SkyUp category.
 *   npm run catalogue:repair-categories             # report only
 *   npm run catalogue:repair-categories -- --apply  # write
 */
import { connectMongo, disconnectMongo } from '../lib/mongo.js';
import { repairOrphanCategories } from '../modules/catalogue/private.service.js';

const apply = process.argv.includes('--apply') || process.env.npm_config_apply === 'true';
await connectMongo();
const report = await repairOrphanCategories({ apply });
console.log(report.length ? JSON.stringify(report, null, 2) : 'Every product has an existing category. Nothing to repair.');
if (!apply && report.some((r) => r.result.startsWith('would'))) console.log('\nDry run: nothing was written. Run again with --apply to move them.');
await disconnectMongo();
process.exit(0);