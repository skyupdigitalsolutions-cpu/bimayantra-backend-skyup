/**
 * Encrypts personal data saved before field-level encryption (lib/pii.ts) and builds the search tokens.
 * Every collection registered with protect() is read straight from the driver (no decryption), each row is run
 * through the same encoder the app uses for writes, and only rows that change are written. Values already
 * encrypted are left as they are, so a second run changes nothing and an interrupted run can simply be repeated.
 * Rows whose _id holds personal data (OTP locks, bounced addresses, idempotency keys) are re-inserted under the
 * encrypted id. Dry run unless `apply` is true.
 */
import mongoose from 'mongoose';
import { isDuplicateKey } from '../../lib/mongo.js';
import { encodeDocFor, protectedCollections } from '../../lib/pii.js';
// Every model that protects fields must be loaded so its spec is registered.
import '../accounts/account.model.js';
import '../audit/audit.model.js';
import '../auth/otp.model.js';
import '../calls/call.model.js';
import '../campaigns/campaign.model.js';
import '../comms/outbox.model.js';
import '../customers/customer.model.js';
import '../leads/lead.model.js';
import '../notifications/notification.model.js';
import '../policies/policy.model.js';
import '../proposals/proposal.model.js';
import '../quotations/quotation.model.js';
import '../referrals/referral.model.js';
import '../users/user.model.js';
import '../../middleware/idempotency.js';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function runEncryptPii(opts: { apply: boolean }) {
  const report: Record<string, { scanned: number; toEncrypt: number; idsRewritten: number }> = {};
  const db = mongoose.connection.db!;
  for (const { collection } of protectedCollections()) {
    const r = (report[collection] = { scanned: 0, toEncrypt: 0, idsRewritten: 0 });
    const raw = db.collection(collection); // the driver's collection: reads ciphertext and plain text as stored
    for await (const doc of raw.find({}, { batchSize: 500 })) {
      r.scanned++;
      const next = encodeDocFor(collection, doc) as typeof doc;
      if (same(next, doc)) continue;
      r.toEncrypt++;
      if (!opts.apply) { if (!same(next._id, doc._id)) r.idsRewritten++; continue; }
      if (same(next._id, doc._id)) { await raw.replaceOne({ _id: doc._id }, next); continue; }
      r.idsRewritten++;
      try { await raw.insertOne(next); } catch (e) { if (!isDuplicateKey(e)) throw e; }
      await raw.deleteOne({ _id: doc._id });
    }
  }
  return { apply: opts.apply, collections: report };
}