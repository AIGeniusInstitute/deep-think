// Super Agent Team routes.
//
// POST /api/team/runs: 异步——立即创建一条 team_builds 记录（status='running'）
// 并返回 buildId，buildTeam（decompose + 成员创建 + graph 注册启动，最坏 ~240s）
// 在后台 detached 执行，结果/错误回写记录。前端轮询 GET /api/team/runs/:buildId
// 拿终态（completed → plan+runId / failed → error），消除"长时间阻塞 HTTP 请求"
// 这一脆弱模式。团队 Builder 算法本身（team-builder.ts）零改动；runId 是标准
// graph_run，/api/graph/runs/:id 与 GraphPage 可视化不变。
//
// 选型：不复用 graph_runs 承载 build 期——其 definition_id 为 NOT NULL+FK，而
// decompose 之前没有 graph definition。故新增极简 team_builds 表解耦。

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { getWebDeps } from '../web-context.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  createTeamBuild,
  getTeamBuild,
  completeTeamBuild,
  failTeamBuild,
  listTeamBuilds,
} from '../db.js';
import { logger } from '../logger.js';

export const teamRoutes = new Hono<{ Variables: Variables }>();

teamRoutes.use('*', authMiddleware);

const TeamRunBodySchema = z.object({
  goalText: z.string().min(1),
  background: z.string().optional(),
  acceptanceCriteria: z.string().optional(),
  groupFolder: z.string().min(1),
  chatJid: z.string().min(1),
  userLanguage: z.string().optional(),
  maxTeamSize: z.number().int().min(1).max(12).optional(),
  toolset: z.array(z.string()).optional(),
  executionMode: z.enum(['auto', 'semi-auto']).optional(),
});

/**
 * GET /api/team/runs — list the current user's team builds (history, newest
 * first). v2 (TeamPage UI): powers the "历史任务" entry so users can reopen a
 * past team run with its full plan. Must be registered BEFORE /runs/:buildId
 * so the literal /runs path isn't captured by the :buildId param route.
 */
teamRoutes.get('/runs', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const rows = listTeamBuilds(authUser.id, 20);
  return c.json({
    runs: rows.map((r) => {
      let teamName: string | null = null;
      if (r.plan_json) {
        try {
          teamName = (JSON.parse(r.plan_json) as { teamName?: string }).teamName ?? null;
        } catch {
          teamName = null;
        }
      }
      return {
        id: r.id,
        teamName,
        goalText: r.goal_text,
        status: r.status,
        runId: r.run_id,
        createdAt: r.created_at,
      };
    }),
  });
});

/** POST /api/team/runs — 立即返回 buildId，后台 detached 组建团队。 */
teamRoutes.post('/runs', async (c) => {
  const _t0 = Date.now();
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const body = await c.req.json().catch(() => null);
  const parsed = TeamRunBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid body', detail: parsed.error.issues.map((i) => i.message).join('; ') },
      400,
    );
  }
  const webDeps = getWebDeps();
  if (!webDeps?.buildTeam) {
    return c.json({ error: 'Team builder not initialized' }, 503);
  }

  const buildId = `tb-${randomUUID()}`;
  createTeamBuild({
    id: buildId,
    owner_user_id: authUser.id,
    group_folder: parsed.data.groupFolder,
    chat_jid: parsed.data.chatJid,
    goal_text: parsed.data.goalText,
  });
  console.error(`[team-timing] createTeamBuild+parse done at +${Date.now() - _t0}ms`);

  const input = {
    goalText: parsed.data.goalText,
    background: parsed.data.background,
    acceptanceCriteria: parsed.data.acceptanceCriteria,
    ownerUserId: authUser.id,
    groupFolder: parsed.data.groupFolder,
    chatJid: parsed.data.chatJid,
    userLanguage: parsed.data.userLanguage ?? 'zh-CN',
    maxTeamSize: parsed.data.maxTeamSize,
    toolset: parsed.data.toolset,
    executionMode: parsed.data.executionMode,
  };

  // Fire-and-forget。关键：必须用 setImmediate 真正延迟到下一个事件循环 tick，
  // 否则 buildTeam 的同步前缀（decompose → sdkQuery → SDK query() 子进程握手，
  // 实测 ~21s 同步阻塞）会在当前请求 tick 上执行，导致 POST /api/team/runs
  // 超过前端 8s 请求超时、前端拿到 "Request timeout" 而 buildId 丢失，组建虽然
  // 后台仍在跑但前端无法轮询。setImmediate 让 HTTP 立即返回 buildId，前端即可
  // 开始轮询 GET /api/team/runs/:buildId；buildTeam 同步前缀的 21s 阻塞由轮询的
  // 单次失败重试（pollBuild catch → 下一轮）吸收，不影响终态回写。
  // 成功回写 plan+runId，失败回写 error；进程级 unhandledRejection 已有 logger 兜底。
  const buildTeam = webDeps.buildTeam;
  setImmediate(() => {
    buildTeam(input)
      .then((result) => {
        if ('error' in result) {
          failTeamBuild(buildId, `${result.error}${result.detail ? `：${result.detail}` : ''}`);
          logger.warn({ buildId, err: result.error, detail: result.detail }, 'team build failed');
          return;
        }
        completeTeamBuild(buildId, {
          plan_json: JSON.stringify(result.plan),
          // This route never sets draft:true, so runId is always present here.
          run_id: result.runId!,
        });
        logger.info({ buildId, runId: result.runId }, 'team build completed');
      })
      .catch((err: unknown) => {
        failTeamBuild(buildId, (err as Error).message?.slice(0, 500) ?? 'unknown error');
        logger.error({ buildId, err }, 'team build threw');
      });
  });

  return c.json({ ok: true, buildId, status: 'running' });
});

/** GET /api/team/runs/:buildId — 轮询组建状态。owner 校验与 graph 路由一致（404 不泄露存在性）。 */
teamRoutes.get('/runs/:buildId', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const buildId = c.req.param('buildId');
  const row = getTeamBuild(buildId);
  if (!row) return c.json({ error: 'Build not found' }, 404);
  if (row.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Build not found' }, 404);
  }
  if (row.status === 'completed') {
    return c.json({
      status: 'completed',
      runId: row.run_id,
      plan: row.plan_json ? JSON.parse(row.plan_json) : null,
    });
  }
  if (row.status === 'failed') {
    return c.json({ status: 'failed', error: row.error ?? 'build failed' });
  }
  return c.json({ status: 'running' });
});
