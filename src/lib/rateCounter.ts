import { redisCache } from './redis.js';

/**
 * Fixed-window counter in Redis, used for limits that are CFG values (CFG-10 per IP, CFG-99 per user),
 * so a changed value applies on the next request. Returns the count in this window and its seconds left.
 */
export async function hitCounter(key: string, windowSeconds: number): Promise<{ count: number; secondsLeft: number }> {
  const r = redisCache();
  const [[, count], [, ttl]] = (await r.multi().incr(key).ttl(key).exec()) as [[null, number], [null, number]];
  if (ttl < 0) await r.expire(key, windowSeconds);
  return { count, secondsLeft: ttl < 0 ? windowSeconds : ttl };
}
