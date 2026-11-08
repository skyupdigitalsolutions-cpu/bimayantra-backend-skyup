/**
 * Starting feature templates for the starting insurance types (Health, Term Life, Motor…), so + Product lists each
 * category's features as soon as it is chosen. Only types with no template version at all get one; dry run unless
 * --apply is given.
 *   npm run catalogue:seed-templates             # report only
 *   npm run catalogue:seed-templates -- --apply  # write
 */
import { connectMongo, disconnectMongo } from '../lib/mongo.js';
import { seedCategoryTemplates } from '../modules/catalogue/defaultTemplates.js';

const apply = process.argv.includes('--apply');
await connectMongo();
const report = await seedCategoryTemplates({ apply });
console.log(JSON.stringify(report, null, 2));
if (!apply) console.log('\nDry run: nothing was written. Run again with --apply to write.');
await disconnectMongo();