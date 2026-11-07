import mongoose, { type ClientSession } from 'mongoose';
import { env } from '../config/env.js';
import { logger } from './logger.js';

mongoose.set('strictQuery', true);

let txSupported = false;

export async function connectMongo(uri = env.MONGO_URI) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000, autoIndex: env.NODE_ENV !== 'production' });
  const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
  txSupported = Boolean(hello.setName) || hello.msg === 'isdbgrid';
  if (!txSupported) {
    if (env.MONGO_REQUIRE_TRANSACTIONS) throw new Error('MongoDB must be a replica set: this environment requires transactions.');
    logger.warn('MongoDB is a standalone server: records that must be saved together are written one after another, '
      + 'not in one transaction. Fine for local testing; see README to run a single-node replica set.');
  }
  logger.info(`MongoDB connected (transactions ${txSupported ? 'on' : 'off'})`);
}

/**
 * Lists indexes that exist in the database but are no longer defined by the code (for example a
 * unique index left behind by an older version). Such an index can refuse valid saves, so the API
 * warns at start-up. Fix with `npm run db:indexes` (or use a fresh database).
 */
export async function findStaleIndexes(): Promise<Array<{ collection: string; index: string }>> {
  const stale: Array<{ collection: string; index: string }> = [];
  for (const name of mongoose.modelNames()) {
    const model = mongoose.model(name);
    try {
      const { toDrop } = await model.diffIndexes();
      for (const index of toDrop) stale.push({ collection: model.collection.collectionName, index });
    } catch { /* collection may not exist yet */ }
  }
  return stale;
}

export async function disconnectMongo() {
  await mongoose.disconnect();
}

export const transactionsSupported = () => txSupported;
/** Tests use this to exercise the standalone fallback on a replica set. */
export const setTransactionsSupported = (v: boolean) => { txSupported = v; };

/**
 * Runs fn in one transaction, so every record it writes is saved together or not at all
 * (P-01 account creation, P-14 conversion, P-19 deactivation …). fn may be retried by the driver on
 * a transient error, so it must only write to the database: SMS and other provider calls go after it.
 * On a standalone server fn runs once with session null and writes in order.
 */
export async function withTx<T>(fn: (session: ClientSession | null) => Promise<T>): Promise<T> {
  if (!txSupported) return fn(null);
  const session = await mongoose.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async () => { result = await fn(session); });
    return result as T;
  } finally {
    await session.endSession();
  }
}

/** True when err is a unique-index violation, optionally on a specific index. */
export function isDuplicateKey(err: unknown, index?: string): boolean {
  const e = err as { code?: number; message?: string; errmsg?: string };
  if (e?.code !== 11000) return false;
  return !index || String(e.message ?? e.errmsg ?? '').includes(index);
}