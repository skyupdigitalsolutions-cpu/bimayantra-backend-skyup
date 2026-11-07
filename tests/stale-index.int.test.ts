/**
 * Regression: a unique index left behind by an older schema (the InsureHub `users.email` index) made
 * every registration after the first fail with 409 ALREADY_SUBMITTED (GEN-06), which hid the real cause.
 * A duplicate on any index other than the users.mobile rule must surface as GEN-99, and the API must be
 * able to list such leftover indexes at start-up.
 */
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { User } from '../src/modules/users/user.model.js';
import { findStaleIndexes } from '../src/lib/mongo.js';
import { app, err, key, lastOtp, newMobile, registerAdvisor, resetState, startTestEnv, stopTestEnv } from './helpers.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);
afterEach(async () => { await User.collection.dropIndex('email_1').catch(() => undefined); });

async function registerRaw(mobile: string) {
  await request(app).post('/v1/auth/register/otp').set('X-Client', 'app').send({ name: 'Ravi Kumar', mobile, termsAccepted: true });
  return request(app).post('/v1/auth/register/verify').set('X-Client', 'app').set('Idempotency-Key', key()).send({ mobile, code: await lastOtp(mobile) });
}

describe('leftover unique index from an older schema', () => {
  it('is reported as GEN-99 with a reference, never as a double submit (GEN-06)', async () => {
    await User.collection.createIndex({ email: 1 }, { unique: true, name: 'email_1' });
    await registerAdvisor('Asha Rao'); // first one is fine: one user with no email
    const second = await registerRaw(newMobile()); // second user with no email collides on email_1
    expect(err(second)).not.toMatchObject({ messageId: 'GEN-06' });
    expect(err(second)).toMatchObject({ status: 500, messageId: 'GEN-99' });
  });

  it('a genuine double submit on the same number is still GEN-06', async () => {
    const mobile = newMobile();
    await request(app).post('/v1/auth/register/otp').set('X-Client', 'app').send({ name: 'Ravi Kumar', mobile, termsAccepted: true });
    const code = await lastOtp(mobile);
    const send = () => request(app).post('/v1/auth/register/verify').set('X-Client', 'app').set('Idempotency-Key', key()).send({ mobile, code });
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });

  it('is listed at start-up so it can be removed (npm run db:indexes)', async () => {
    await User.collection.createIndex({ email: 1 }, { unique: true, name: 'email_1' });
    expect(await findStaleIndexes()).toContainEqual({ collection: 'users', index: 'email_1' });
  });
});