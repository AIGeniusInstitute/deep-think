// Agent Service 开放平台 — API Key 管理路由（登录态，走 authMiddleware）。
//
// 前缀 /api/open-platform/keys：创建（返回明文一次）/ 列表（脱敏）/ 吊销。
import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  createApiKey,
  listApiKeys,
  getApiKey,
  deleteApiKey,
  type ApiKeyRow,
} from '../db.js';
import { generateApiKey } from '../open-platform/api-keys.js';

const ALLOWED_SCOPES = new Set(['maas', 'agent', '*']);

const openPlatformKeysRoutes = new Hono<{ Variables: Variables }>();
openPlatformKeysRoutes.use('*', authMiddleware);

function toPublic(row: ApiKeyRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    masked_key: `${row.key_prefix}...`,
    scopes: safeScopes(row.scopes),
    enabled: row.enabled === 1,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    expires_at: row.expires_at,
  };
}

function safeScopes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

// GET /api/open-platform/keys — 列出（脱敏）
openPlatformKeysRoutes.get('/', (c) => {
  const user = c.get('user');
  const isAdmin = user.role === 'admin';
  const rows = listApiKeys(user.id, isAdmin);
  return c.json({ keys: rows.map(toPublic) });
});

// POST /api/open-platform/keys — 创建（返回完整 key，仅此一次）
openPlatformKeysRoutes.post('/', async (c) => {
  const user = c.get('user');
  let body: { name?: string; scopes?: string[]; expires_at?: string | null };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const name = (body?.name || '').trim();
  if (!name || name.length < 2 || name.length > 80) {
    return c.json({ error: 'name 必须为 2-80 字符' }, 400);
  }

  let scopes: string[] = ['maas', 'agent'];
  if (Array.isArray(body?.scopes) && body.scopes.length > 0) {
    for (const s of body.scopes) {
      if (typeof s !== 'string' || !ALLOWED_SCOPES.has(s)) {
        return c.json({ error: `非法 scope: ${s}` }, 400);
      }
    }
    scopes = body.scopes;
  }

  const { rawKey, hash, prefix } = generateApiKey();
  const row = createApiKey({
    userId: user.id,
    name,
    keyHash: hash,
    keyPrefix: prefix,
    scopes,
    expiresAt: body?.expires_at ?? null,
  });

  return c.json({ ...toPublic(row), key: rawKey }, 201);
});

// DELETE /api/open-platform/keys/:id — 吊销
openPlatformKeysRoutes.delete('/:id', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const row = getApiKey(id, user.id, user.role === 'admin');
  if (!row) return c.json({ error: 'API key not found' }, 404);
  deleteApiKey(id, user.id, user.role === 'admin');
  return c.json({ ok: true });
});

export default openPlatformKeysRoutes;
