import { Router } from 'express';
import mongoose from 'mongoose';
import { redisCache } from '../../lib/redis.js';

/** Bumped with each delivered change set. */
export const BUILD = '2026-11-11-company-filter';

export function healthRoutes() {
  const r = Router();
  // Which build is running: open https://<api host>/health/version after a deploy to confirm the new code is live.
  r.get('/version', (_req, res) => res.json({ build: BUILD, features: ['integrations', 'message-rules', 'wallet-switch', 'session-24h', 'category-dedupe', 'bestfit-reasons', 'category-forms', 'company-filter', 'quotation-fixes'] }));
  // Liveness: the process is up. Used by Nginx / orchestrator.
  r.get('/live', (_req, res) => res.json({ status: 'ok' }));
  // Readiness: dependencies reachable. Unauthenticated, reveals only up/down.
  r.get('/ready', async (_req, res) => {
    const mongo = mongoose.connection.readyState === 1;
    const redis = await redisCache().ping().then(() => true, () => false);
    res.status(mongo && redis ? 200 : 503).json({ status: mongo && redis ? 'ok' : 'degraded', mongo, redis });
  });
  return r;
}