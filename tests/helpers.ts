import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import RedisMock from 'ioredis-mock';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { ConfigValue, loadConfigOverrides } from '../src/config/cfg.js';
import { clock } from '../src/lib/clock.js';
import { connectMongo, disconnectMongo, setTransactionsSupported } from '../src/lib/mongo.js';
import { normalizeMobile } from '../src/lib/phone.js';
import { redisCache, setRedisClients } from '../src/lib/redis.js';
import { devSms } from '../src/modules/auth/sms.js';
import { User } from '../src/modules/users/user.model.js';
import { loadFlags } from '../src/modules/flags/flags.js';

/**
 * Tests run against a real single-node MongoDB replica set (transactions on), started by
 * mongodb-memory-server (it downloads MongoDB on first use; set MONGOMS_SYSTEM_BINARY to use a local mongod),
 * and an in-memory Redis.
 */
export let app: Express;
let rs: MongoMemoryReplSet | undefined;

export async function startTestEnv() {
  setRedisClients({ cache: new RedisMock() as never, queue: new RedisMock() as never });
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await connectMongo(rs.getUri('bimayantra_test'));
  // TEST_NO_TX=1 runs everything as on a standalone MongoDB (records written in order, no transaction).
  if (process.env.TEST_NO_TX === '1') setTransactionsSupported(false);
  for (const name of mongoose.modelNames()) await mongoose.model(name).syncIndexes();
  app = createApp();
}

export async function stopTestEnv() {
  await disconnectMongo();
  await rs?.stop();
}

/** Empty every collection and Redis; normal clock; CFG-10 raised so tests are not throttled by IP. */
export async function resetState() {
  for (const c of Object.values(mongoose.connection.collections)) await c.deleteMany({});
  await redisCache().flushall();
  clock.setOffset(0);
  await ConfigValue.create({ _id: 'CFG-10', value: 100000 });
  await loadConfigOverrides();
  await loadFlags(); // collections were emptied: every feature switch is back to its default
  await (await import('../src/modules/campaigns/platformApps.js')).loadPlatformApps(); // no ad-platform apps saved
}

export async function setCfg(id: string, value: unknown) {
  await ConfigValue.updateOne({ _id: id }, { $set: { value } }, { upsert: true });
  await loadConfigOverrides();
}

export const key = () => randomUUID();
let seq = 0;
/** A fresh valid Indian mobile, typed the way people type it. */
export const newMobile = () => `98${String(Date.now() % 1e6).padStart(6, '0')}${String(++seq % 100).padStart(2, '0')}`;

export async function lastOtp(mobile: string): Promise<string> {
  const [m] = await devSms.list(normalizeMobile(mobile)!);
  if (!m) throw new Error(`No SMS for ${mobile}`);
  return m.text.slice(0, 6);
}

export interface Session { token: string; refresh: string; user: { id: string; accountId: string | null; role: string; capabilities: string[] } }

export async function registerAdvisor(name = 'Asha Rao', mobile = newMobile()): Promise<Session & { mobile: string }> {
  const send = await request(app).post('/v1/auth/register/otp').send({ name, mobile, termsAccepted: true });
  if (send.status !== 200) throw new Error(`register/otp ${send.status} ${JSON.stringify(send.body)}`);
  const r = await request(app).post('/v1/auth/register/verify').set('X-Client', 'app').set('Idempotency-Key', key()).send({ mobile, code: await lastOtp(mobile) });
  if (r.status !== 201) throw new Error(`register/verify ${r.status} ${JSON.stringify(r.body)}`);
  return { token: r.body.data.tokens.accessToken, refresh: r.body.data.tokens.refreshToken, user: r.body.data.user, mobile };
}

export async function login(mobile: string): Promise<Session> {
  const send = await request(app).post('/v1/auth/login/otp').send({ mobile });
  if (send.status !== 200) throw new Error(`login/otp ${send.status} ${JSON.stringify(send.body)}`);
  const r = await request(app).post('/v1/auth/login/verify').set('X-Client', 'app').set('Idempotency-Key', key()).send({ mobile, code: await lastOtp(mobile) });
  if (r.status !== 200) throw new Error(`login/verify ${r.status} ${JSON.stringify(r.body)}`);
  return { token: r.body.data.tokens.accessToken, refresh: r.body.data.tokens.refreshToken, user: r.body.data.user };
}

export async function seedAdmin(mobile = newMobile()) {
  await User.create({ accountId: null, role: 'ADM', name: 'SkyUp Admin', mobile: normalizeMobile(mobile), status: 'ACTIVE', activatedAt: new Date() });
  return { mobile, ...(await login(mobile)) };
}

/** Bearer-authenticated API client; every POST carries a fresh Idempotency-Key unless one is given. */
export function as(token: string) {
  const h = (r: request.Test, headers: Record<string, string> = {}) => {
    r.set('Authorization', `Bearer ${token}`);
    for (const [k, v] of Object.entries(headers)) r.set(k, v);
    return r;
  };
  return {
    get: (p: string) => h(request(app).get(`/v1${p}`)),
    post: (p: string, body: object = {}, headers: Record<string, string> = {}) => h(request(app).post(`/v1${p}`).send(body), { 'Idempotency-Key': key(), ...headers }),
    patch: (p: string, body: object) => h(request(app).patch(`/v1${p}`).send(body)),
    put: (p: string, body: object) => h(request(app).put(`/v1${p}`).send(body)),
    del: (p: string) => h(request(app).delete(`/v1${p}`)),
  };
}

/** Step-up OTP (CFG-83) for the signed-in user; returns the token for X-Step-Up-Token. */
export async function stepUp(token: string, mobile: string) {
  const c = as(token);
  await c.post('/auth/step-up/otp');
  const r = await c.post('/auth/step-up/verify', { code: await lastOtp(mobile) });
  return r.body.data.stepUpToken as string;
}

export const err = (res: request.Response) => ({ status: res.status, code: res.body?.error?.code, messageId: res.body?.error?.messageId });