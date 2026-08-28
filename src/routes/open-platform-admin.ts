// Agent Service 开放平台 — 管理接口：用量统计 + 模型定价（登录态，走 authMiddleware）。
//
// 前缀 /api/open-platform：
//   GET  /usage              开放平台专属用量聚合（source='open-platform'）
//   GET  /pricing            模型定价列表（admin）
//   PUT  /pricing/:modelId   新增/更新定价（admin）
//   DELETE /pricing/:modelId 删除定价（admin）
import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  getOpenPlatformUsage,
  listModelPricing,
  upsertModelPricing,
  deleteModelPricing,
} from '../db.js';
import type { AuthUser } from '../types.js';

const openPlatformAdminRoutes = new Hono<{ Variables: Variables }>();
openPlatformAdminRoutes.use('*', authMiddleware);

// GET /api/open-platform/usage?days=7&userId=（admin 可看全部 / member 只看自己）
openPlatformAdminRoutes.get('/usage', (c) => {
  const user = c.get('user') as AuthUser;
  const daysParam = c.req.query('days');
  const days = Math.min(Math.max(parseInt(daysParam || '7', 10) || 7, 1), 365);
  const userId = user.role === 'admin' ? c.req.query('userId') || undefined : user.id;
  const result = getOpenPlatformUsage(days, userId);
  return c.json({ ...result, days });
});

// GET /api/open-platform/pricing（admin）
openPlatformAdminRoutes.get('/pricing', (c) => {
  const user = c.get('user') as AuthUser;
  if (user.role !== 'admin') return c.json({ error: 'admin only' }, 403);
  return c.json({ pricing: listModelPricing() });
});

// PUT /api/open-platform/pricing/:modelId（admin，upsert）
openPlatformAdminRoutes.put('/pricing/:modelId', async (c) => {
  const user = c.get('user') as AuthUser;
  if (user.role !== 'admin') return c.json({ error: 'admin only' }, 403);
  const modelId = c.req.param('modelId');
  let body: { input_price_per_mtok?: number; output_price_per_mtok?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const inputPrice = Number(body?.input_price_per_mtok);
  const outputPrice = Number(body?.output_price_per_mtok);
  if (!modelId || !Number.isFinite(inputPrice) || !Number.isFinite(outputPrice) || inputPrice < 0 || outputPrice < 0) {
    return c.json({ error: 'modelId 与非负 input_price_per_mtok/output_price_per_mtok 必填' }, 400);
  }
  const row = upsertModelPricing({
    modelId,
    inputPricePerMtok: inputPrice,
    outputPricePerMtok: outputPrice,
  });
  return c.json(row);
});

// DELETE /api/open-platform/pricing/:modelId（admin）
openPlatformAdminRoutes.delete('/pricing/:modelId', (c) => {
  const user = c.get('user') as AuthUser;
  if (user.role !== 'admin') return c.json({ error: 'admin only' }, 403);
  const modelId = c.req.param('modelId');
  if (!deleteModelPricing(modelId)) return c.json({ error: 'Pricing not found' }, 404);
  return c.json({ ok: true });
});

export default openPlatformAdminRoutes;
