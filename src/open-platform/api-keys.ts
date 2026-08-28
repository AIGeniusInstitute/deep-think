/**
 * Agent Service 开放平台 — API Key 生成 / 哈希 / 校验。
 *
 * 安全模型：
 * - 明文 key 格式 `sk-` + base64url(32 随机字节)，仅在创建时返回一次。
 * - 落库只存 sha256(rawKey) 与展示前缀 key_prefix，日志/响应永不回显明文。
 * - 校验用 key_hash 索引等值查询（无字符串比较时序侧信道）。
 */
import crypto from 'crypto';
import { getApiKeyByHash, touchApiKeyLastUsed } from '../db.js';
import { logger } from '../logger.js';

/** 生成一把新 key：返回明文（仅此一次）、哈希与展示前缀。 */
export function generateApiKey(): { rawKey: string; hash: string; prefix: string } {
  const raw = 'sk-' + crypto.randomBytes(32).toString('base64url');
  return { rawKey: raw, hash: hashApiKey(raw), prefix: keyPrefix(raw) };
}

export function hashApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

/** 展示用前缀：`sk-` + 前 8 个可见字符（含 sk- 共 11 字符）。 */
export function keyPrefix(rawKey: string): string {
  return rawKey.slice(0, 11);
}

export interface VerifiedApiKey {
  userId: string;
  keyId: string;
  scopes: string[];
}

const LAST_USED_THROTTLE_MS = 60_000;
const lastUsedTouched = new Map<string, number>();

/** 校验 Bearer key。返回 { userId, keyId, scopes } 或 null（无效/禁用/过期）。 */
export function verifyApiKey(rawKey: string): VerifiedApiKey | null {
  if (!rawKey || typeof rawKey !== 'string' || !rawKey.startsWith('sk-')) {
    return null;
  }
  const hash = hashApiKey(rawKey);
  const row = getApiKeyByHash(hash);
  if (!row) return null;
  if (row.enabled !== 1) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return null;
  }

  // last_used_at 节流刷新（fire-and-forget，避免高频写库）。
  const now = Date.now();
  const last = lastUsedTouched.get(row.id) ?? 0;
  if (now - last >= LAST_USED_THROTTLE_MS) {
    lastUsedTouched.set(row.id, now);
    try {
      touchApiKeyLastUsed(row.id, new Date().toISOString());
    } catch (err) {
      logger.warn({ err }, 'touchApiKeyLastUsed failed');
    }
  }

  let scopes: string[] = ['maas', 'agent'];
  try {
    const parsed = JSON.parse(row.scopes);
    if (Array.isArray(parsed)) scopes = parsed.filter((s) => typeof s === 'string');
  } catch {
    /* 保持默认 */
  }

  return { userId: row.user_id, keyId: row.id, scopes };
}
