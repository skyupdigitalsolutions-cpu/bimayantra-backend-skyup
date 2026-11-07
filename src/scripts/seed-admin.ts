/**
 * Creates the first SkyUp Admin (ADM). SkyUp users are otherwise created by another ADM (P-48).
 * Sign in on the login page with SEED_ADMIN_MOBILE and the OTP (shown in the console's SMS inbox in dev).
 * Idempotent: running it again changes nothing.
 */
import { connectMongo, disconnectMongo } from '../lib/mongo.js';
import { normalizeMobile } from '../lib/phone.js';
import { User } from '../modules/users/user.model.js';

async function main() {
  const name = process.env.SEED_ADMIN_NAME?.trim();
  const mobile = normalizeMobile(process.env.SEED_ADMIN_MOBILE ?? '');
  if (!name || !mobile) throw new Error('Set SEED_ADMIN_NAME and SEED_ADMIN_MOBILE (a 10-digit Indian mobile) in .env');
  await connectMongo();
  await User.syncIndexes();
  const existing = await User.findOne({ mobile }).lean();
  if (existing) {
    if (existing.role !== 'ADM') throw new Error(`${mobile} already belongs to a ${existing.role} user. Use another number (one role per mobile, DEC-07).`);
    console.log(`SkyUp Admin already exists: ${existing.name} (${mobile})`);
  } else {
    const u = await User.create({ accountId: null, role: 'ADM', name, mobile, status: 'ACTIVE', activatedAt: new Date() });
    console.log(`Created SkyUp Admin ${u.name} (${mobile}). Sign in with this mobile number and the OTP.`);
  }
  await disconnectMongo();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
