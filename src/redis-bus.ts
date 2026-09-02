/**
 * Redis Event Bus — 跨 Pod 事件总线 (Horizontal Scaling Core)
 *
 * 当 REDIS_URL 设置时:
 *   - WebSocket 广播通过 Redis Pub/Sub 跨 Pod 传播
 *   - 调度器通过 Redis 分布式锁选主
 *   - Agent IPC 通过 Redis 替代文件系统
 *
 * 未设置 REDIS_URL 时:所有操作退化为本地 no-op / 内存模式,零影响单进程部署。
 */

import { logger } from './logger.js';

export const redisEnabled = !!process.env.REDIS_URL;

let _pub: any = null;
let _sub: any = null;
let _connected = false;

/** 初始化 Redis 连接(仅当 REDIS_URL 存在)。 */
export async function initRedis(): Promise<void> {
  if (!redisEnabled) return;
  try {
    const { createClient } = await import('redis');
    _pub = createClient({ url: process.env.REDIS_URL! });
    _sub = createClient({ url: process.env.REDIS_URL! });

    _pub.on('error', (e: Error) => logger.warn({ err: e }, 'Redis pub client error'));
    _sub.on('error', (e: Error) => logger.warn({ err: e }, 'Redis sub client error'));

    await _pub.connect();
    await _sub.connect();
    _connected = true;
    logger.info('Redis event bus connected — multi-pod mode active');
  } catch (err) {
    logger.warn({ err }, 'Redis connection failed — falling back to single-process mode');
    _connected = false;
  }
}

/** 是否已连接 Redis。 */
export function isRedisConnected(): boolean {
  return _connected;
}

/** 获取发布客户端(内部用)。 */
function getPub(): any {
  return _connected ? _pub : null;
}

/** 获取订阅客户端(内部用)。 */
function getSub(): any {
  return _connected ? _sub : null;
}

// ─── Pub/Sub: WebSocket 广播 ───────────────────────────

const WS_BROADCAST_CHANNEL = 'deepthink:ws:broadcast';

interface WsBroadcastEnvelope {
  msg: any;
  adminOnly: boolean;
  allowedUserIds: string[] | null;
}

/**
 * 发布 WebSocket 广播消息到 Redis(跨 Pod 传播)。
 * 单进程模式(无 Redis)时 no-op,本地 safeBroadcast 已处理。
 */
export async function publishWsBroadcast(
  msg: any,
  adminOnly: boolean,
  allowedUserIds: Set<string> | null,
): Promise<void> {
  const pub = getPub();
  if (!pub) return;
  const envelope: WsBroadcastEnvelope = {
    msg,
    adminOnly,
    allowedUserIds: allowedUserIds ? [...allowedUserIds] : null,
  };
  try {
    await pub.publish(WS_BROADCAST_CHANNEL, JSON.stringify(envelope));
  } catch (err) {
    logger.debug({ err }, 'Redis publishWsBroadcast failed (non-fatal)');
  }
}

/**
 * 订阅 WebSocket 广播通道。收到消息时调用 handler。
 * handler 负责将消息转发到本 Pod 的 wsClients。
 */
export async function subscribeWsBroadcast(
  handler: (msg: any, adminOnly: boolean, allowedUserIds: Set<string> | null) => void,
): Promise<void> {
  const sub = getSub();
  if (!sub) return;
  await sub.subscribe(WS_BROADCAST_CHANNEL, (raw: string) => {
    try {
      const env = JSON.parse(raw) as WsBroadcastEnvelope;
      const userIds = env.allowedUserIds ? new Set(env.allowedUserIds) : null;
      handler(env.msg, env.adminOnly, userIds);
    } catch (err) {
      logger.warn({ err, raw }, 'Failed to parse Redis WS broadcast');
    }
  });
  logger.info(`Subscribed to Redis channel: ${WS_BROADCAST_CHANNEL}`);
}

// ─── Distributed Lock: 调度器选主 ───────────────────────

const SCHEDULER_LOCK_KEY = 'deepthink:scheduler:leader';
const SCHEDULER_LOCK_TTL = 90_000; // 90s — 调度器每 60s tick,90s lease 给足余量

/**
 * 尝试获取调度器 leader lease。
 * 成功:本 Pod 是 leader,可以执行调度。
 * 失败:另一个 Pod 是 leader,跳过本轮。
 *
 * 单进程模式:永远返回 true。
 */
export async function acquireSchedulerLease(): Promise<boolean> {
  const pub = getPub();
  if (!pub) return true;
  try {
    const result = await pub.set(
      SCHEDULER_LOCK_KEY,
      process.pid.toString(),
      { NX: true, PX: SCHEDULER_LOCK_TTL },
    );
    return result === 'OK';
  } catch {
    return true; // Redis 出错时退化为单进程
  }
}

/** 释放调度器 lease(仅优雅关闭时调用)。 */
export async function releaseSchedulerLease(): Promise<void> {
  const pub = getPub();
  if (!pub) return;
  try {
    const val = await pub.get(SCHEDULER_LOCK_KEY);
    if (val === process.pid.toString()) {
      await pub.del(SCHEDULER_LOCK_KEY);
    }
  } catch {
    // non-fatal
  }
}

// ─── Distributed Lock: 通用 ─────────────────────────────

/**
 * 获取分布式锁。
 * @param key 锁键
 * @param ttlMs 锁存活时间(ms)
 * @returns true=获取成功, false=已被他人持有
 */
export async function acquireLock(key: string, ttlMs: number): Promise<boolean> {
  const pub = getPub();
  if (!pub) return true;
  try {
    const result = await pub.set(key, process.pid.toString(), { NX: true, PX: ttlMs });
    return result === 'OK';
  } catch {
    return true;
  }
}

/** 释放分布式锁(仅当持有者是自己时)。 */
export async function releaseLock(key: string): Promise<void> {
  const pub = getPub();
  if (!pub) return;
  try {
    const val = await pub.get(key);
    if (val === process.pid.toString()) {
      await pub.del(key);
    }
  } catch {
    // non-fatal
  }
}

// ─── Agent IPC via Redis ────────────────────────────────

const AGENT_IPC_CHANNEL_PREFIX = 'deepthink:ipc:';

/**
 * 向 agent 推送 IPC 消息(替代文件系统的 sendMessage)。
 * agent runner 订阅 `deepthink:ipc:{groupFolder}` 接收。
 */
export async function publishAgentIpc(
  groupFolder: string,
  payload: { type: string; text: string; images?: any[]; sourceJid?: string; taskId?: string },
): Promise<void> {
  const pub = getPub();
  if (!pub) return;
  try {
    await pub.publish(AGENT_IPC_CHANNEL_PREFIX + groupFolder, JSON.stringify(payload));
  } catch (err) {
    logger.debug({ err, groupFolder }, 'Redis publishAgentIpc failed');
  }
}

/**
 * 订阅 agent IPC 通道(agent runner 侧调用)。
 * 单进程模式返回空(退化为文件系统 IPC)。
 */
export async function subscribeAgentIpc(
  groupFolder: string,
  handler: (payload: any) => void,
): Promise<() => void> {
  const sub = getSub();
  if (!sub) return () => {};
  const channel = AGENT_IPC_CHANNEL_PREFIX + groupFolder;
  await sub.subscribe(channel, (raw: string) => {
    try {
      handler(JSON.parse(raw));
    } catch (err) {
      logger.warn({ err, raw }, 'Failed to parse Redis agent IPC');
    }
  });
  return () => {
    try { sub.unsubscribe(channel); } catch { /* ignore */ }
  };
}

// ─── Shared Counters: 并发计数 ─────────────────────────

/**
 * 原子递增计数器(用于跨 Pod 共享并发限制)。
 * @param key 计数器键
 * @param max 最大值(可选)
 * @returns { count, allowed }
 */
export async function incrCounter(
  key: string,
  max?: number,
): Promise<{ count: number; allowed: boolean }> {
  const pub = getPub();
  if (!pub) return { count: 0, allowed: true };
  try {
    const count = await pub.incr(key);
    if (max !== undefined && count > max) {
      await pub.decr(key);
      return { count: count - 1, allowed: false };
    }
    if (count === 1) await pub.expire(key, 3600);
    return { count, allowed: true };
  } catch {
    return { count: 0, allowed: true };
  }
}

/** 原子递减计数器。 */
export async function decrCounter(key: string): Promise<number> {
  const pub = getPub();
  if (!pub) return 0;
  try {
    return await pub.decr(key);
  } catch {
    return 0;
  }
}

// ─── Shutdown ───────────────────────────────────────────

/** 关闭所有 Redis 连接(优雅关闭时调用)。 */
export async function closeRedis(): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (_pub) tasks.push(_pub.quit().then(() => {}).catch(() => {}));
  if (_sub) tasks.push(_sub.quit().then(() => {}).catch(() => {}));
  await Promise.allSettled(tasks);
  _pub = null;
  _sub = null;
  _connected = false;
  logger.info('Redis connections closed');
}
