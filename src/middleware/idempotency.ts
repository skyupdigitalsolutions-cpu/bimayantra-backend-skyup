import type { Request, RequestHandler, Response } from 'express';
import { Schema, model } from 'mongoose';
import { protect } from '../lib/pii.js';
import { AppError } from '../lib/errors.js';
import { sha256 } from '../lib/crypto.js';
import { isDuplicateKey } from '../lib/mongo.js';
import { logger } from '../lib/logger.js';

/** GR-10: one stored outcome per (user, key) for 24 hours. */
const keySchema = new Schema(
  {
    _id: String, // `${scope}|${key}`
    fingerprint: { type: String, required: true },
    state: { type: String, enum: ['PENDING', 'DONE'], required: true },
    responseStatus: { type: Number, default: null },
    responseBody: { type: Schema.Types.Mixed, default: null },
    createdAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);
keySchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 3600 });
export const IdempotencyKey = model('IdempotencyKey', keySchema, 'idempotency_keys');
/** The id can hold a mobile (OTP scope) and the saved response holds whatever the API returned: both encrypted. */
protect(IdempotencyKey, { fields: { _id: 'key', responseBody: 'json' } });

const KEY = /^[A-Za-z0-9_-]{8,128}$/;
const ABANDONED_MS = 60_000;

function strip(body: unknown, keys: string[]): unknown {
  if (!keys.length || !body || typeof body !== 'object') return body;
  return JSON.parse(JSON.stringify(body, (k, v) => (keys.includes(k) ? undefined : v)));
}

/**
 * GR-10 double-submit protection for create, send and status-change requests. The client makes the
 * Idempotency-Key when the form opens and reuses it on Retry. A repeat of a completed request returns
 * 409 ALREADY_SUBMITTED (GEN-06) with the saved result (Section 2.5). Only successful results are kept,
 * so a request refused for a field error can be corrected and sent again with the same key (GR-04).
 */
export function idempotent(opts: { scope?: (req: Request) => string | null; redact?: string[] } = {}): RequestHandler {
  return async (req, res, next) => {
    const key = req.get('idempotency-key');
    if (!key || !KEY.test(key)) {
      throw AppError.field('Idempotency-Key', 'GEN-01', { 'Field label': 'Idempotency key' });
    }
    const scope = req.auth?.userId ?? opts.scope?.(req) ?? `ip:${req.ip}`;
    const id = `${scope}|${key}`;
    const fingerprint = sha256(`${req.method} ${req.baseUrl}${req.path} ${JSON.stringify(req.body ?? null)}`);

    try {
      await IdempotencyKey.create({ _id: id, fingerprint, state: 'PENDING' });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      const existing = await IdempotencyKey.findById(id).lean();
      if (existing && existing.state === 'PENDING' && Date.now() - new Date(existing.createdAt).getTime() > ABANDONED_MS) {
        await IdempotencyKey.deleteOne({ _id: id, state: 'PENDING' });
        await IdempotencyKey.create({ _id: id, fingerprint, state: 'PENDING' });
      } else if (!existing) {
        await IdempotencyKey.create({ _id: id, fingerprint, state: 'PENDING' });
      } else if (existing.fingerprint !== fingerprint) {
        throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'GEN-99', { errorId: req.requestId });
      } else if (existing.state === 'PENDING') {
        throw new AppError(409, 'REQUEST_IN_PROGRESS', 'GEN-12');
      } else {
        throw new AppError(409, 'ALREADY_SUBMITTED', 'GEN-06', {}, { originalStatus: existing.responseStatus, result: existing.responseBody });
      }
    }

    // Save the outcome BEFORE the response leaves, so a retry can never miss it.
    const send = res.json.bind(res) as Response['json'];
    res.json = ((body: unknown) => {
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      const save = ok
        ? IdempotencyKey.updateOne({ _id: id }, { $set: { state: 'DONE', responseStatus: res.statusCode, responseBody: strip(body, opts.redact ?? []) } })
        : IdempotencyKey.deleteOne({ _id: id, state: 'PENDING' });
      save.catch((err: unknown) => logger.error({ err }, 'Idempotency record update failed')).finally(() => send(body));
      return res;
    }) as Response['json'];
    next();
  };
}