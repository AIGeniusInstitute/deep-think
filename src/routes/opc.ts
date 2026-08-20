// OPC（一人公司）模块路由。
//
// 在既有 team/graph 等子系统之上叠加的目标驱动编排层：
//   - opc_companies：一人公司配置（愿景/商业目标/运营策略/规模/领域/分成）
//   - opc_objectives：挂在公司下的商业目标，launch 后由前端回写
//     team_build_id/run_id 关联既有 team_builds / graph_runs
//
// launch 本身不在此处实现——前端 OpcPage 复用 useTeamStore.buildTeam（POST
// /api/team/runs）完成智能体网络组建，再把终态 runId 通过 PUT /objectives/:id
// 回写。路由层只做 CRUD + 归属校验，避免与 team builder 做服务端深度耦合。
//
// 归属校验：row.owner_user_id !== authUser.id 一律返回 404（不泄露存在性）。

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  createOpcCompany,
  getOpcCompany,
  listOpcCompanies,
  updateOpcCompany,
  deleteOpcCompany,
  createOpcObjective,
  getOpcObjective,
  listOpcObjectivesByCompany,
  updateOpcObjective,
  deleteOpcObjective,
  type OpcCompanyRow,
  type OpcObjectiveRow,
} from '../db.js';

export const opcRoutes = new Hono<{ Variables: Variables }>();

opcRoutes.use('*', authMiddleware);

const SCALE_TIERS = ['solo', 'small', 'mid'] as const;
const COMPANY_STATUS = ['active', 'archived'] as const;
const OBJECTIVE_STATUS = ['draft', 'active', 'running', 'completed', 'failed'] as const;

const CompanyCreateSchema = z.object({
  name: z.string().min(1).max(120),
  vision: z.string().max(2000).optional(),
  commercial_goals: z.string().max(4000).optional(),
  operating_strategy: z.string().max(4000).optional(),
  scale_tier: z.enum(SCALE_TIERS).optional(),
  domains: z.array(z.string().max(60)).max(20).optional(),
  revenue_share: z
    .array(z.object({ name: z.string().min(1).max(60), ratio: z.number().min(0).max(100) }))
    .max(20)
    .optional(),
});

const CompanyUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  vision: z.string().max(2000).optional(),
  commercial_goals: z.string().max(4000).optional(),
  operating_strategy: z.string().max(4000).optional(),
  scale_tier: z.enum(SCALE_TIERS).optional(),
  domains: z.array(z.string().max(60)).max(20).optional(),
  revenue_share: z
    .array(z.object({ name: z.string().min(1).max(60), ratio: z.number().min(0).max(100) }))
    .max(20)
    .optional(),
  status: z.enum(COMPANY_STATUS).optional(),
});

const ObjectiveCreateSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  domain: z.string().max(60).optional(),
  acceptance_criteria: z.string().max(4000).optional(),
  metrics: z.array(z.string().max(120)).max(20).optional(),
});

const ObjectiveUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  domain: z.string().max(60).optional(),
  acceptance_criteria: z.string().max(4000).optional(),
  metrics: z.array(z.string().max(120)).max(20).optional(),
  status: z.enum(OBJECTIVE_STATUS).optional(),
  team_build_id: z.string().max(120).nullable().optional(),
  run_id: z.string().max(120).nullable().optional(),
});

interface AuthUser {
  id: string;
}

function companyToApi(r: OpcCompanyRow) {
  let domains: string[] = [];
  if (r.domains_json) {
    try { domains = JSON.parse(r.domains_json) as string[]; } catch { domains = []; }
  }
  let revenue_share: Array<{ name: string; ratio: number }> = [];
  if (r.revenue_share_json) {
    try { revenue_share = JSON.parse(r.revenue_share_json) as typeof revenue_share; } catch { revenue_share = []; }
  }
  return {
    id: r.id,
    name: r.name,
    vision: r.vision,
    commercial_goals: r.commercial_goals,
    operating_strategy: r.operating_strategy,
    scale_tier: r.scale_tier,
    domains,
    revenue_share,
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function objectiveToApi(r: OpcObjectiveRow) {
  let metrics: string[] = [];
  if (r.metrics_json) {
    try { metrics = JSON.parse(r.metrics_json) as string[]; } catch { metrics = []; }
  }
  return {
    id: r.id,
    company_id: r.company_id,
    title: r.title,
    description: r.description,
    domain: r.domain,
    acceptance_criteria: r.acceptance_criteria,
    metrics,
    status: r.status,
    team_build_id: r.team_build_id,
    run_id: r.run_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** 校验公司归属：返回公司 row 或 404（不泄露存在性）。 */
async function ownCompany(c: any, id: string): Promise<OpcCompanyRow | null> {
  const authUser = c.get('user') as AuthUser;
  const row = getOpcCompany(id);
  if (!row || row.owner_user_id !== authUser.id) return null;
  return row;
}

// --- 公司 ---

opcRoutes.get('/companies', (c) => {
  const authUser = c.get('user') as AuthUser;
  const rows = listOpcCompanies(authUser.id);
  return c.json({ companies: rows.map(companyToApi) });
});

opcRoutes.post('/companies', async (c) => {
  const authUser = c.get('user') as AuthUser;
  const parsed = CompanyCreateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400);
  }
  const d = parsed.data;
  // 分成合计校验：允许 ≤100%（预留部分），超过阻断。
  if (d.revenue_share && d.revenue_share.length > 0) {
    const sum = d.revenue_share.reduce((s, p) => s + p.ratio, 0);
    if (sum > 100 + 1e-6) {
      return c.json({ error: 'revenue_share_exceeds_100', sum }, 400);
    }
  }
  const id = randomUUID();
  createOpcCompany({
    id,
    owner_user_id: authUser.id,
    name: d.name,
    vision: d.vision ?? null,
    commercial_goals: d.commercial_goals ?? null,
    operating_strategy: d.operating_strategy ?? null,
    scale_tier: d.scale_tier ?? 'solo',
    domains_json: d.domains ? JSON.stringify(d.domains) : null,
    revenue_share_json: d.revenue_share ? JSON.stringify(d.revenue_share) : null,
  });
  const row = getOpcCompany(id)!;
  return c.json({ company: companyToApi(row) }, 201);
});

opcRoutes.put('/companies/:id', async (c) => {
  const id = c.req.param('id');
  const row = await ownCompany(c, id);
  if (!row) return c.json({ error: 'not_found' }, 404);
  const parsed = CompanyUpdateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400);
  }
  const d = parsed.data;
  if (d.revenue_share && d.revenue_share.length > 0) {
    const sum = d.revenue_share.reduce((s, p) => s + p.ratio, 0);
    if (sum > 100 + 1e-6) {
      return c.json({ error: 'revenue_share_exceeds_100', sum }, 400);
    }
  }
  updateOpcCompany(id, {
    ...(d.name !== undefined && { name: d.name }),
    ...(d.vision !== undefined && { vision: d.vision ?? null }),
    ...(d.commercial_goals !== undefined && { commercial_goals: d.commercial_goals ?? null }),
    ...(d.operating_strategy !== undefined && { operating_strategy: d.operating_strategy ?? null }),
    ...(d.scale_tier !== undefined && { scale_tier: d.scale_tier }),
    ...(d.domains !== undefined && { domains_json: JSON.stringify(d.domains) }),
    ...(d.revenue_share !== undefined && { revenue_share_json: JSON.stringify(d.revenue_share) }),
    ...(d.status !== undefined && { status: d.status }),
  });
  const updated = getOpcCompany(id)!;
  return c.json({ company: companyToApi(updated) });
});

opcRoutes.delete('/companies/:id', async (c) => {
  const id = c.req.param('id');
  const row = await ownCompany(c, id);
  if (!row) return c.json({ error: 'not_found' }, 404);
  deleteOpcCompany(id);
  return c.json({ ok: true });
});

// --- 目标 ---

opcRoutes.get('/companies/:id/objectives', async (c) => {
  const id = c.req.param('id');
  const row = await ownCompany(c, id);
  if (!row) return c.json({ error: 'not_found' }, 404);
  const rows = listOpcObjectivesByCompany(id);
  return c.json({ objectives: rows.map(objectiveToApi) });
});

opcRoutes.post('/companies/:id/objectives', async (c) => {
  const id = c.req.param('id');
  const row = await ownCompany(c, id);
  if (!row) return c.json({ error: 'not_found' }, 404);
  const authUser = c.get('user') as AuthUser;
  const parsed = ObjectiveCreateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400);
  }
  const d = parsed.data;
  const objId = randomUUID();
  createOpcObjective({
    id: objId,
    company_id: id,
    owner_user_id: authUser.id,
    title: d.title,
    description: d.description ?? null,
    domain: d.domain ?? null,
    acceptance_criteria: d.acceptance_criteria ?? null,
    metrics_json: d.metrics ? JSON.stringify(d.metrics) : null,
  });
  const created = getOpcObjective(objId)!;
  return c.json({ objective: objectiveToApi(created) }, 201);
});

opcRoutes.put('/objectives/:id', async (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  const obj = getOpcObjective(id);
  if (!obj || obj.owner_user_id !== authUser.id) {
    return c.json({ error: 'not_found' }, 404);
  }
  const parsed = ObjectiveUpdateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400);
  }
  const d = parsed.data;
  updateOpcObjective(id, {
    ...(d.title !== undefined && { title: d.title }),
    ...(d.description !== undefined && { description: d.description ?? null }),
    ...(d.domain !== undefined && { domain: d.domain ?? null }),
    ...(d.acceptance_criteria !== undefined && { acceptance_criteria: d.acceptance_criteria ?? null }),
    ...(d.metrics !== undefined && { metrics_json: JSON.stringify(d.metrics) }),
    ...(d.status !== undefined && { status: d.status }),
    ...(d.team_build_id !== undefined && { team_build_id: d.team_build_id ?? null }),
    ...(d.run_id !== undefined && { run_id: d.run_id ?? null }),
  });
  const updated = getOpcObjective(id)!;
  return c.json({ objective: objectiveToApi(updated) });
});

opcRoutes.delete('/objectives/:id', async (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  const obj = getOpcObjective(id);
  if (!obj || obj.owner_user_id !== authUser.id) {
    return c.json({ error: 'not_found' }, 404);
  }
  deleteOpcObjective(id);
  return c.json({ ok: true });
});
