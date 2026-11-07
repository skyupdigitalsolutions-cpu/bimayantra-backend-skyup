/**
 * Stage B backfills (default product variants, variant links, task priority). Dry run unless --apply is given.
 *   npm run db:migrate:stage-b             # report only
 *   npm run db:migrate:stage-b -- --apply  # write
 * Run `npm run db:indexes` first, so the one-default-variant rule exists before variants are created.
 */
import { connectMongo, disconnectMongo } from '../lib/mongo.js';
import { runStageB } from '../modules/migrations/stageB.js';

const apply = process.argv.includes('--apply');
await connectMongo();
const report = await runStageB({ apply });
console.log(JSON.stringify(report, null, 2));
if (!apply) console.log('\nDry run: nothing was written. Run again with --apply to write.');
await disconnectMongo();