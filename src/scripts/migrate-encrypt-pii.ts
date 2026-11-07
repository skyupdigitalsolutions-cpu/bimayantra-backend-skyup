/**
 * Encrypts names, mobiles, emails, KYC values and their copies saved before field-level encryption, and builds the
 * search tokens. Dry run unless --apply is given. Safe to run again.
 *   npm run db:migrate:encrypt-pii             # report only
 *   npm run db:migrate:encrypt-pii -- --apply  # write
 * Take a backup first, and keep PII_ENCRYPTION_KEY and PII_HASH_KEY safe: without them the data cannot be read.
 * Run `npm run db:indexes` afterwards, so the search-token indexes exist.
 */
import { connectMongo, disconnectMongo } from '../lib/mongo.js';
import { runEncryptPii } from '../modules/migrations/encryptPii.js';

const apply = process.argv.includes('--apply');
await connectMongo();
const report = await runEncryptPii({ apply });
console.log(JSON.stringify(report, null, 2));
if (!apply) console.log('\nDry run: nothing was written. Run again with --apply to write.');
await disconnectMongo();