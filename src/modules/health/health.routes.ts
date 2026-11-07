import { Router } from 'express';
import mongoose from 'mongoose';
import { redisCache } from '../../lib/redis.js';

export function healthRoutes() {
  const r = Router();
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