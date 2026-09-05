/**
 * MCP Gateway 限流：per-user + per-tool 滑动窗口（内存）。
 *
 * 配额（每 60s）：
 *   read=120, write=30, admin=10
 *
 * 单 Pod 内存实现。多 Pod 下为 best-effort（每 Pod 独立配额），
 * 全量 Redis 滑动窗口列入后续路线，本次不阻塞主流程。
 *
 * 超限返回 { allowed:false, retryAfterMs }。
 */
import type { SideEffect } from './governance.js';

const WINDOW_MS = 60_000;
const LIMITS: Record<SideEffect, number> = {
  read: 120,
  write: 30,
  admin: 10,
};

interface Bucket {
  timestamps: number[];
}

const buckets = new Map<string, Bucket>();

function key(userId: string, toolId: string, side: SideEffect): string {
  return `mcp:rl:${userId}:${toolId}:${side}`;
}

function prune(b: Bucket, now: number): void {
  const cutoff = now - WINDOW_MS;
  // 从尾部 pop 过期（timestamps 升序）
  while (b.timestamps.length > 0 && b.timestamps[0] < cutoff) {
    b.timestamps.shift();
  }
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
  remaining: number;
  limit: number;
}

/** 检查并计入一次调用。 */
export function checkRateLimit(
  userId: string,
  toolId: string,
  side: SideEffect,
  now: number = Date.now(),
): RateLimitResult {
  const k = key(userId, toolId, side);
  const limit = LIMITS[side];
  let b = buckets.get(k);
  if (!b) {
    b = { timestamps: [] };
    buckets.set(k, b);
  }
  prune(b, now);
  if (b.timestamps.length >= limit) {
    // 计算最早一个过期时间作为 retryAfter
    const retryAfterMs = Math.max(0, b.timestamps[0] + WINDOW_MS - now);
    return { allowed: false, retryAfterMs, remaining: 0, limit };
  }
  b.timestamps.push(now);
  return { allowed: true, retryAfterMs: 0, remaining: limit - b.timestamps.length, limit };
}

/** 测试用：重置某 key。 */
export function _resetRateLimit(userId?: string): void {
  if (!userId) {
    buckets.clear();
    return;
  }
  for (const k of buckets.keys()) {
    if (k.includes(`:${userId}:`)) buckets.delete(k);
  }
}

/** 周期清理空桶（防内存泄漏）。 */
export function sweepEmptyBuckets(): number {
  let removed = 0;
  const now = Date.now();
  for (const [k, b] of buckets) {
    prune(b, now);
    if (b.timestamps.length === 0) {
      buckets.delete(k);
      removed++;
    }
  }
  return removed;
}
