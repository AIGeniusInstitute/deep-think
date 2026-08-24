// Agent Workflow routes — user-scoped visual workflow orchestration.
//
// A "workflow" is a graph_definition whose nodes are primarily agents (each
// referencing an agent_definitions row). These routes are the user-facing CRUD
// layer over the existing graph-registry: they scope definitions to the
// current user via owner_user_id, while the admin /api/graph/definitions route
// keeps registering global (owner=NULL) definitions unchanged.
//
// POST /api/workflows/autobuild: async — immediately creates a workflow_builds
// row (status='running') and returns buildId. buildTeam({draft:true}) (decompose
// + create members + register definition, NO run start, worst ~120s) runs
// detached; the result is written back. Frontend polls GET
// /api/workflows/autobuild/:buildId for the terminal state (completed →
// definitionId+plan / failed → error). Mirrors routes/team.ts.

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { getWebDeps } from '../web-context.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  listWorkflowDefinitions,
  getWorkflowDefinition,
  createWorkflowBuild,
  getWorkflowBuild,
  completeWorkflowBuild,
  failWorkflowBuild,
} from '../db.js';
import {
  deserializeDefinition,
  registerDefinition,
  toMermaid,
} from '../graph-engineering/graph-registry.js';
import type {
  GraphDefinition,
  GraphEdge,
  GraphNode,
} from '../graph-engineering/graph-types.js';
import { logger } from '../logger.js';

export const workflowRoutes = new Hono<{ Variables: Variables }>();

workflowRoutes.use('*', authMiddleware);

/** Slugify a workflow name into a safe id fragment. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'workflow'
  );
}

const NodeSchema = z.record(z.string(), z.unknown());
const EdgeSchema = z.record(z.string(), z.unknown());

const SaveBodySchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  nodes: z.array(NodeSchema).min(1),
  edges: z.array(EdgeSchema),
  stateSchema: z.array(z.record(z.string(), z.unknown())).optional(),
});

/** GET /api/workflows — list the current user's workflows (+ shared globals). */
workflowRoutes.get('/', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const rows = listWorkflowDefinitions(authUser.id);
  return c.json({
    workflows: rows.map((r) => ({
      id: r.id,
      version: r.version,
      name: r.name,
      description: r.description,
      owner: r.owner_user_id,
      nodeCount: (JSON.parse(r.nodes_json) as unknown[]).length,
      createdAt: r.created_at,
    })),
  });
});

/** GET /api/workflows/:id — definition detail + Mermaid export. */
workflowRoutes.get('/:id', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const id = c.req.param('id');
  const row = getWorkflowDefinition(id, authUser.id);
  if (!row) return c.json({ error: 'Workflow not found' }, 404);
  const def = deserializeDefinition(row);
  return c.json({ definition: def, mermaid: toMermaid(def) });
});

/** POST /api/workflows — register a new workflow (version 1). */
workflowRoutes.post('/', async (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const body = await c.req.json().catch(() => null);
  const parsed = SaveBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid body', detail: parsed.error.issues.map((i) => i.message).join('; ') },
      400,
    );
  }
  const id = parsed.data.id ?? `wf-${authUser.id}-${slugify(parsed.data.name)}-${randomUUID().slice(0, 8)}`;
  const def: GraphDefinition = {
    id,
    version: 1,
    name: parsed.data.name,
    description: parsed.data.description,
    nodes: parsed.data.nodes as unknown as GraphNode[],
    edges: parsed.data.edges as unknown as GraphEdge[],
    stateSchema: parsed.data.stateSchema as GraphDefinition['stateSchema'],
  };
  try {
    const { version, hash } = registerDefinition(def, authUser.id);
    return c.json({ ok: true, id, version, hash });
  } catch (err) {
    logger.error({ err }, 'Failed to register workflow');
    return c.json({ error: (err as Error).message }, 400);
  }
});

/** PUT /api/workflows/:id — register the next version of an existing workflow. */
workflowRoutes.put('/:id', async (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const id = c.req.param('id');
  // Owner check: existing definition must be visible to the user.
  const existing = getWorkflowDefinition(id, authUser.id);
  if (!existing) return c.json({ error: 'Workflow not found' }, 404);
  const body = await c.req.json().catch(() => null);
  const parsed = SaveBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid body', detail: parsed.error.issues.map((i) => i.message).join('; ') },
      400,
    );
  }
  const def: GraphDefinition = {
    id,
    version: existing.version + 1,
    name: parsed.data.name,
    description: parsed.data.description,
    nodes: parsed.data.nodes as unknown as GraphNode[],
    edges: parsed.data.edges as unknown as GraphEdge[],
    stateSchema: parsed.data.stateSchema as GraphDefinition['stateSchema'],
  };
  try {
    const { version, hash } = registerDefinition(def, authUser.id);
    return c.json({ ok: true, id, version, hash });
  } catch (err) {
    logger.error({ err }, 'Failed to update workflow');
    return c.json({ error: (err as Error).message }, 400);
  }
});

const AutobuildBodySchema = z.object({
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
 * POST /api/workflows/autobuild — 编排 Agent 草稿生成：立即返回 buildId，后台
 * detached 调 buildTeam({draft:true})（拆解+创建成员+注册定义，不启动 run），
 * 结果回写 workflow_builds。前端轮询 GET /api/workflows/autobuild/:buildId。
 */
workflowRoutes.post('/autobuild', async (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const body = await c.req.json().catch(() => null);
  const parsed = AutobuildBodySchema.safeParse(body);
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

  const buildId = `wb-${randomUUID()}`;
  createWorkflowBuild({
    id: buildId,
    owner_user_id: authUser.id,
    group_folder: parsed.data.groupFolder,
    chat_jid: parsed.data.chatJid,
    goal_text: parsed.data.goalText,
  });

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
    draft: true as const,
  };

  const buildTeam = webDeps.buildTeam;
  setImmediate(() => {
    buildTeam(input)
      .then((result) => {
        if ('error' in result) {
          failWorkflowBuild(buildId, `${result.error}${result.detail ? `：${result.detail}` : ''}`);
          logger.warn({ buildId, err: result.error, detail: result.detail }, 'workflow autobuild failed');
          return;
        }
        completeWorkflowBuild(buildId, {
          plan_json: JSON.stringify(result.plan),
          definition_id: result.definitionId,
        });
        logger.info({ buildId, definitionId: result.definitionId }, 'workflow autobuild completed');
      })
      .catch((err: unknown) => {
        failWorkflowBuild(buildId, (err as Error).message?.slice(0, 500) ?? 'unknown error');
        logger.error({ buildId, err }, 'workflow autobuild threw');
      });
  });

  return c.json({ ok: true, buildId, status: 'running' });
});

/** GET /api/workflows/autobuild/:buildId — poll the draft-generation status. */
workflowRoutes.get('/autobuild/:buildId', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const buildId = c.req.param('buildId');
  const row = getWorkflowBuild(buildId);
  if (!row) return c.json({ error: 'Build not found' }, 404);
  if (row.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Build not found' }, 404);
  }
  if (row.status === 'completed') {
    return c.json({
      status: 'completed',
      definitionId: row.definition_id,
      plan: row.plan_json ? JSON.parse(row.plan_json) : null,
    });
  }
  if (row.status === 'failed') {
    return c.json({ status: 'failed', error: row.error ?? 'build failed' });
  }
  return c.json({ status: 'running' });
});
