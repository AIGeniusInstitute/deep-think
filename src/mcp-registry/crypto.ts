/**
 * MCP Registry 凭据加密：AES-256-GCM。
 *
 * 复用 runtime-config 的 getOrCreateEncryptionKey（CLAUDE_CONFIG_KEY_FILE，
 * 32 字节 AES key，文件 mode 0600）。与 provider 凭据、embedding 配置
 * 使用同一密钥管理边界，零新依赖。
 *
 * 密文格式：`enc:v1:<base64(iv[12] || tag[16] || data)>`。
 * 未以 `enc:v1:` 开头的值视为历史明文，decryptSecret 透传返回（兼容期），
 * 由启动迁移逐条加密回写。
 *
 * 注：本模块仅被 engine.ts（经 routes 加载）使用，不进 db.ts 静态依赖链，
 * 因此不影响仅部分 mock config 的 db-only 既有测试。db.ts 内联了一份
 * 等价实现（读同一 key 文件），二者密文格式完全互操作。
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { getOrCreateEncryptionKey } from '../runtime-config.js';

const getKey = getOrCreateEncryptionKey;

const PREFIX = 'enc:v1:';

/** 加密明文密钥。 */
export function encryptSecret(plain: string): string {
  if (plain.startsWith(PREFIX)) return plain; // 已加密，幂等
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
}

/** 解密；非 `enc:v1:` 前缀视为明文透传（兼容未迁移数据）。 */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const buf = Buffer.from(stored.slice(PREFIX.length), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const key = getKey();
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** 是否已加密。 */
export function isEncrypted(s: string): boolean {
  return typeof s === 'string' && s.startsWith(PREFIX);
}

/** sha256(token) 十六进制全量（用于 token hash 比对）。 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
