/**
 * No admin approval: items still waiting for approval. Dry run lists them.
 *   npm run db:migrate:pending-approvals                 # list only
 *   npm run db:migrate:pending-approvals -- --publish    # publish each as it is (original maker in the audit log)
 *   npm run db:migrate:pending-approvals -- --to-draft   # return each to draft
 */
import { connectMongo, disconnectMongo } from '../lib/mongo.js';
import { runPendingApprovals } from '../modules/migrations/pendingApprovals.js';

const mode = process.argv.includes('--publish') ? 'publish' : process.argv.includes('--to-draft') ? 'toDraft' : 'dry';
await connectMongo();
console.log(JSON.stringify(await runPendingApprovals({ mode }), null, 2));
if (mode === 'dry') console.log('\nDry run: nothing was written. Run again with --publish or --to-draft.');
await disconnectMongo();