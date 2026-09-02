/**
 * Redis Client — optional shared state layer for multi-replica deployments.
 *
 * When REDIS_URL is set (Phase 2), enables:
 *   - WebSocket broadcast pub/sub across pods
 *   - Distributed lock for scheduler leader election
 *   - Shared GroupQueue concurrency counters
 *
 * When REDIS_URL is empty (Phase 1, single replica), all functions
 * degrade to no-op/in-memory behavior — zero impact on existing single-process mode.
 *
 * Usage:
 *   if (redisEnabled) await publish('channel', msg);
 *   const locked = await acquireLease('scheduler:leader', 60_000);
 */

import { logger } from './logger.js';

export const redisEnabled = !!process.env.REDIS_URL;

let _client: any = null;
let _subscriber: any = null;

/** Lazy-init the Redis client (only when REDIS_URL is set). */
async function getClient(): Promise<any> {
  if (!redisEnabled) return null;
  if (_client) return _client;
  try {
    // redis is an optional dependency (Phase 2). Dynamic import avoids
    // requiring the package at runtime when REDIS_URL is not set.
    const mod = await import(/* @vite-ignore */ 'redis');
    const createClient = mod.createClient;
    _client = createClient({ url: process.env.REDIS_URL! });
    _client.on('error', (err: Error) => logger.warn({ err }, 'Redis client error'));
    await _client.connect();
    logger.info('Redis client connected');
    return _client;
  } catch (err) {
    logger.warn({ err }, 'Failed to connect to Redis — running in single-process mode');
    return null;
  }
}

/** Lazy-init a dedicated subscriber connection. */
async function getSubscriber(): Promise<any> {
  if (!redisEnabled) return null;
  if (_subscriber) return _subscriber;
  try {
    const mod = await import(/* @vite-ignore */ 'redis');
    const createClient = mod.createClient;
    _subscriber = createClient({ url: process.env.REDIS_URL! });
    _subscriber.on('error', (err: Error) => logger.warn({ err }, 'Redis subscriber error'));
    await _subscriber.connect();
    logger.info('Redis subscriber connected');
    return _subscriber;
  } catch {
    return null;
  }
}

/** Publish a message to a Redis channel (no-op if Redis not configured). */
export async function publish(channel: string, message: any): Promise<void> {
  const client = await getClient();
  if (!client) return;
  await client.publish(channel, JSON.stringify(message));
}

/** Subscribe to a Redis channel (no-op if Redis not configured). */
export async function subscribe(
  channel: string,
  handler: (message: any) => void,
): Promise<void> {
  const sub = await getSubscriber();
  if (!sub) return;
  await sub.subscribe(channel, (raw: string) => {
    try {
      handler(JSON.parse(raw));
    } catch (err) {
      logger.warn({ err, raw }, 'Failed to parse Redis message');
    }
  });
}

/**
 * Acquire a distributed lease (for leader election / single-writer guarantee).
 * Returns true if this process acquired the lock, false if another holds it.
 *
 * In single-process mode (no Redis), always returns true.
 */
export async function acquireLease(
  key: string,
  ttlMs: number,
): Promise<boolean> {
  const client = await getClient();
  if (!client) return true; // single-process: always win
  const result = await client.set(key, process.pid.toString(), {
    NX: true,
    PX: ttlMs,
  });
  return result === 'OK';
}

/** Release a lease (delete the key if we own it). */
export async function releaseLease(key: string): Promise<void> {
  const client = await getClient();
  if (!client) return;
  // Only delete if we own it (simple check via GET)
  const val = await client.get(key);
  if (val === process.pid.toString()) {
    await client.del(key);
  }
}

/** Atomically increment a counter (for shared concurrency tracking). */
export async function incrCounter(
  key: string,
  max?: number,
): Promise<{ count: number; allowed: boolean }> {
  const client = await getClient();
  if (!client) {
    // Single-process: no-op, caller uses its own in-memory counter
    return { count: 0, allowed: true };
  }
  const count = await client.incr(key);
  if (max !== undefined && count > max) {
    await client.decr(key);
    return { count: count - 1, allowed: false };
  }
  // Set TTL on first increment to avoid stale keys
  if (count === 1) {
    await client.expire(key, 3600); // 1h TTL as safety
  }
  return { count, allowed: true };
}

/** Decrement a counter. */
export async function decrCounter(key: string): Promise<number> {
  const client = await getClient();
  if (!client) return 0;
  return await client.decr(key);
}

/** Close all Redis connections (for graceful shutdown). */
export async function closeRedis(): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (_client) tasks.push(_client.quit().then(() => {}));
  if (_subscriber) tasks.push(_subscriber.quit().then(() => {}));
  await Promise.allSettled(tasks);
  _client = null;
  _subscriber = null;
}
