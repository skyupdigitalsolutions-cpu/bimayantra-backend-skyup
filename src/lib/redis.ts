import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Two physically separate Redis instances (agreed decision):
 *  - cache: allkeys-lru — dashboard/product cache, login attempts, lockouts, revoked sessions, idempotency
 *  - queue: noeviction  — BullMQ only, so jobs are never silently evicted under memory pressure
 *
 * NOTE: lockout and revoked-session keys live on the LRU instance. Under memory pressure LRU could
 * evict them early; that fails open only for keys that are about to expire anyway, and access tokens
 * are short-lived. If the client wants strict guarantees, move these keys to a third noeviction DB.
 *
 * Clients are created lazily so tests can inject a mock with setRedisClients().
 */
let cache: Redis | undefined;
let queue: Redis | undefined;

export function redisCache(): Redis {
  if (!cache) {
    cache = new Redis(env.REDIS_CACHE_URL, { maxRetriesPerRequest: 2 });
    cache.on('error', (err) => logger.error({ err }, 'Redis cache error'));
  }
  return cache;
}

export function redisQueue(): Redis {
  if (!queue) {
    // BullMQ requires maxRetriesPerRequest: null on the connection it uses.
    queue = new Redis(env.REDIS_QUEUE_URL, { maxRetriesPerRequest: null });
    queue.on('error', (err) => logger.error({ err }, 'Redis queue error'));
  }
  return queue;
}

export function setRedisClients(clients: { cache?: Redis; queue?: Redis }) {
  if (clients.cache) cache = clients.cache;
  if (clients.queue) queue = clients.queue;
}

export async function disconnectRedis() {
  await Promise.allSettled([cache?.quit(), queue?.quit()]);
  cache = undefined;
  queue = undefined;
}