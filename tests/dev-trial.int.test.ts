/** Dev tool: extend an expired trial so read-only mode (GR-33) ends. Development only. */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { app, as, err, login, newMobile, registerAdvisor, resetState, startTestEnv, stopTestEnv } from './helpers.js';
import { clock } from '../src/lib/clock.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(async () => { clock.setOffset(0); await resetState(); });

it('an expired trial is read-only (SUB-03); Extend trial lets the advisor write again', async () => {
  const adv = await registerAdvisor('Asha Rao');
  clock.setOffset(8 * 86_400_000);
  const s1 = await login(adv.mobile);
  expect(err(await as(s1.token).post('/customers', { name: 'Meena Iyer', mobile: newMobile() }))).toMatchObject({ status: 403, messageId: 'SUB-03' });
  clock.setOffset(0);
  await request(app).post('/v1/dev/extend-trial').send({ mobile: adv.mobile, days: 30 }).expect(200);
  clock.setOffset(8 * 86_400_000);
  const s2 = await login(adv.mobile);
  expect((await as(s2.token).post('/customers', { name: 'Meena Iyer', mobile: newMobile() })).status).toBe(201);
});