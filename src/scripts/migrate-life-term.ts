/**
 * Change #18: split "Life and Term" into Life and Term pipelines. Dry run unless --apply is given.
 *   npm run db:migrate:life-term             # report only
 *   npm run db:migrate:life-term -- --apply  # write
 */
import { connectMongo, disconnectMongo } from '../lib/mongo.js';
import { runLifeTermSplit } from '../modules/migrations/lifeTerm.js';

const apply = process.argv.includes('--apply');
await connectMongo();
const report = await runLifeTermSplit({ apply });
console.log(JSON.stringify(report, null, 2));
if (!apply) console.log('\nDry run: nothing was written. Run again with --apply to write.');
await disconnectMongo();