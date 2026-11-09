/**
 * JWT lifetimes: the access token never outlives its session; expiresIn is its real lifetime; a refresh rotates the
 * token; two refreshes with the same token at once get "retry with the latest" (not a sign-out); an old token replayed
 * later ends the session.
 */
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, as, registerAdvisor, resetState, startTestEnv, stopTestEnv } from './helpers.js';
import { clock } from '../src/lib/clock.js';
import { env } from '../src/config/env.js';
import { Session } from '../src/modules/auth/session.model.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(async () => { clock.setOffset(0); await resetState(); });
const refresh = (token: string) => request(app).post('/v1/auth/refresh').set('X-Client', 'app').send({ refreshToken: token });
const exp = (t: string) => (jwt.decode(t) as { exp: number }).exp;

describe('JWT refresh', () => {
  it('access token lasts JWT_ACCESS_TTL_SECONDS, but never past the session end; the refresh token ends with the session', async () => {
    const adv = await registerAdvisor();
    const now = Math.floor(Date.now() / 1000);
    expect(exp(adv.token) - now).toBeGreaterThan(env.JWT_ACCESS_TTL_SECONDS - 5);
    expect(exp(adv.token) - now).toBeLessThanOrEqual(env.JWT_ACCESS_TTL_SECONDS + 1);

    // 2 minutes of session left: the new access token and expiresIn stop there too
    const sid = (jwt.decode(adv.token) as { sid: string }).sid;
    await Session.updateOne({ _id: sid }, { $set: { expiresAt: new Date(Date.now() + 120_000) } });
    const r = await refresh(adv.refresh);
    expect(r.status).toBe(200);
    const t = r.body.data.tokens;
    expect(t.expiresIn).toBeLessThanOrEqual(120);
    expect(exp(t.accessToken)).toBeLessThanOrEqual(Math.ceil((Date.now() + 120_000) / 1000) + 1);
    expect(exp(t.refreshToken)).toBeLessThanOrEqual(Math.ceil((Date.now() + 120_000) / 1000) + 1);
  });

  it('a parallel refresh with the same token gets retryWithLatest (still signed in); a late replay ends the session', async () => {
    const adv = await registerAdvisor();
    const first = await refresh(adv.refresh);
    expect(first.status).toBe(200);
    const twin = await refresh(adv.refresh); // a second tab or request a moment later
    expect(twin.status).toBe(401);
    expect(twin.body.error).toMatchObject({ code: 'TOKEN_INVALID', details: { retryWithLatest: true } });
    // the session is still alive: the newest refresh token works
    const next = await refresh(first.body.data.tokens.refreshToken);
    expect(next.status).toBe(200);
    // the original token replayed after the grace window = theft: session ended
    clock.setOffset(60_000);
    const replay = await refresh(adv.refresh);
    expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSED');
    expect((await refresh(next.body.data.tokens.refreshToken)).status).toBe(401);
  });

  it('stays signed in for 24 hours: still in after 23 hours without activity, out after 24', async () => {
    const adv = await registerAdvisor();
    const sid = (jwt.decode(adv.token) as { sid: string }).sid;
    const s = (await Session.findById(sid).lean())!;
    expect(s.expiresAt.getTime() - s.startedAt.getTime()).toBe(24 * 3_600_000);
    clock.setOffset(23 * 3_600_000);
    const r = await refresh(adv.refresh); // the app refreshes the 15-minute access token silently
    expect(r.status).toBe(200);
    expect((await as(r.body.data.tokens.accessToken).get('/auth/me')).status).toBe(200);
    clock.setOffset(24 * 3_600_000 + 60_000);
    expect((await as(r.body.data.tokens.accessToken).get('/auth/me')).status).toBe(401);
  });
});