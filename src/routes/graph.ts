// Graph Engineering routes.
//
// Mirrors routes/loops.ts. List/detail/pause/cancel/rerun hit the DB directly
// (no orchestrator deps needed). Start + resume go through WebDeps
// (startGraphRun / resumeGraphRun), wired in index.ts where full GraphDeps
// (queue, broadcastStreamEvent, sendMessage) are in scope — same pattern as
// triggerTaskRun.

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { getWebDeps } from '../web-context.js';
import {
  getGraphRun,
  getLatestGraphNodeRun,
  listGraphRuns,
  listGraphNodeRuns,
  listGraphDefinitions,
  listGraphNodeTraceNodes,
  listGraphNodeTimeline,
  listTraceToolCalls,
  repointGraphRunDefinition,
} from '../db.js';
import {
  deserializeDefinition,
  registerDefinition,
  toMermaid,
} from '../graph-engineering/graph-registry.js';
import {
  approveHumanNode,
  cancelGraphRun,
  pauseGraphRun,
  rerunGraphNode,
} from '../graph-engineering/graph-orchestrator.js';
import { planAndRegister } from '../graph-engineering/graph-planner.js';
import { logger } from '../logger.js';

export const graphRoutes = new Hono<{ Variables: Variables }>();

graphRoutes.use('*', authMiddleware);

/** GET /api/graph/definitions — list latest active graph definitions. */
graphRoutes.get('/definitions', (c) => {
  const rows = listGraphDefinitions();
  const defs = rows.map((r) => ({
    id: r.id,
    version: r.version,
    name: r.name,
    description: r.description,
    nodeCount: (JSON.parse(r.nodes_json) as unknown[]).length,
    createdAt: r.created_at,
  }));
  return c.json({ definitions: defs });
});

/** GET /api/graph/definitions/:id — definition detail + Mermaid export (AC1.3). */
graphRoutes.get('/definitions/:id', (c) => {
  const id = c.req.param('id');
  const row = listGraphDefinitions().find((r) => r.id === id);
  if (!row) return c.json({ error: 'Definition not found' }, 404);
  const def = deserializeDefinition(row);
  return c.json({ definition: def, mermaid: toMermaid(def) });
});

/** POST /api/graph/definitions — register a new version of a graph definition. */
graphRoutes.post('/definitions', async (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  if (authUser.role !== 'admin') {
    return c.json({ error: 'admin only' }, 403);
  }
  const body = await c.req.json().catch(() => null);
  if (!body?.id || !Array.isArray(body.nodes) || !Array.isArray(body.edges)) {
    return c.json({ error: 'Missing id/nodes/edges' }, 400);
  }
  try {
    const { key, hash } = registerDefinition({
      id: body.id,
      version: body.version ?? 1,
      name: body.name ?? body.id,
      description: body.description,
      nodes: body.nodes,
      edges: body.edges,
      stateSchema: body.stateSchema,
    });
    return c.json({ ok: true, key, hash });
  } catch (err) {
    logger.error({ err }, 'Failed to register graph definition');
    return c.json({ error: (err as Error).message }, 400);
  }
});

/** GET /api/graph/runs — list current user's graph runs. */
graphRoutes.get('/runs', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const status = c.req.query('status');
  const limit = parseInt(c.req.query('limit') ?? '50', 10);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);
  const runs = listGraphRuns(authUser.id, { status, limit, offset });
  return c.json({ runs });
});

/**
 * POST /api/graph/plan — DSL v2 auto-planner.
 * Body: { task, background?, acceptanceCriteria?, template?, groupFolder, chatJid, autorun? }
 * Calls planAndRegister (LLM → validate → template fallback), optionally
 * starts a run when autorun=true. Returns the registered definition + runId.
 */
graphRoutes.post('/plan', async (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const body = await c.req.json().catch(() => null);
  if (!body?.task || !body.groupFolder || !body.chatJid) {
    return c.json({ error: 'Missing task/groupFolder/chatJid' }, 400);
  }
  try {
    const result = await planAndRegister({
      task: body.task,
      background: body.background,
      acceptanceCriteria: body.acceptanceCriteria,
      template: body.template,
      ownerUserId: authUser.id,
      groupFolder: body.groupFolder,
      userLanguage: 'zh-CN',
    });
    let runId: string | undefined;
    if (body.autorun) {
      const webDeps = getWebDeps();
      if (!webDeps?.startGraphRun) {
        return c.json({
          ok: true,
          definitionId: result.definition.id,
          version: result.definition.version,
          source: result.source,
          warnings: result.warnings,
          error: 'autorun requested but graph execution not initialized',
        });
      }
      const startResult = webDeps.startGraphRun({
        definitionId: result.definition.id,
        ownerUserId: authUser.id,
        groupFolder: body.groupFolder,
        chatJid: body.chatJid,
        goalText: body.task,
        maxParallel: body.maxParallel,
        initialState: body.initialState,
      });
      if (startResult.success) runId = startResult.runId;
    }
    return c.json({
      ok: true,
      definitionId: result.definition.id,
      version: result.definition.version,
      source: result.source,
      warnings: result.warnings,
      runId,
    });
  } catch (err) {
    logger.error({ err }, 'Graph plan failed');
    return c.json({ error: (err as Error).message }, 400);
  }
});

/** POST /api/graph/runs — start a new graph run (AC3.4 start). */
graphRoutes.post('/runs', async (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const body = await c.req.json().catch(() => null);
  if (!body?.definitionId || !body.groupFolder || !body.chatJid) {
    return c.json({ error: 'Missing definitionId/groupFolder/chatJid' }, 400);
  }
  const webDeps = getWebDeps();
  if (!webDeps?.startGraphRun) {
    return c.json({ error: 'Graph execution not initialized' }, 503);
  }
  const result = webDeps.startGraphRun({
    definitionId: body.definitionId,
    ownerUserId: authUser.id,
    groupFolder: body.groupFolder,
    chatJid: body.chatJid,
    goalText: body.goalText,
    maxParallel: body.maxParallel,
    initialState: body.initialState,
  });
  if (!result.success) {
    return c.json({ error: result.error ?? 'Failed to start graph run' }, 400);
  }
  return c.json({ ok: true, runId: result.runId });
});

/** GET /api/graph/runs/:id — graph run + node_runs tree. */
graphRoutes.get('/runs/:id', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const id = c.req.param('id');
  const run = getGraphRun(id);
  if (!run) return c.json({ error: 'Graph run not found' }, 404);
  if (run.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Graph run not found' }, 404);
  }
  const nodes = listGraphNodeRuns(id);
  return c.json({ run, nodeRuns: nodes });
});

/**
 * GET /api/graph/runs/:id/timeline — DSL v2 history-replay timeline.
 * Returns node status-change events ordered by start time, for the frontend
 * ReplayPlayer to rebuild canvas state at a given timestamp.
 */
graphRoutes.get('/runs/:id/timeline', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const id = c.req.param('id');
  const run = getGraphRun(id);
  if (!run) return c.json({ error: 'Graph run not found' }, 404);
  if (run.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Graph run not found' }, 404);
  }
  const timeline = listGraphNodeTimeline(id);
  return c.json({ runId: id, timeline });
});

/** POST /api/graph/runs/:id/resume — resume from checkpoint (AC3.4). */
graphRoutes.post('/runs/:id/resume', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const id = c.req.param('id');
  const run = getGraphRun(id);
  if (!run) return c.json({ error: 'Graph run not found' }, 404);
  if (run.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Graph run not found' }, 404);
  }
  if (run.status !== 'paused' && run.status !== 'failed') {
    return c.json({ error: `Cannot resume run in status '${run.status}'` }, 400);
  }
  const webDeps = getWebDeps();
  if (!webDeps?.resumeGraphRun) {
    return c.json({ error: 'Graph execution not initialized' }, 503);
  }
  const result = webDeps.resumeGraphRun(id);
  return result.success
    ? c.json({ ok: true, status: 'running' })
    : c.json({ error: result.error ?? 'Failed to resume' }, 400);
});

/** POST /api/graph/runs/:id/pause — pause at next node boundary (AC4.1). */
graphRoutes.post('/runs/:id/pause', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const id = c.req.param('id');
  const run = getGraphRun(id);
  if (!run) return c.json({ error: 'Graph run not found' }, 404);
  if (run.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Graph run not found' }, 404);
  }
  pauseGraphRun(id);
  return c.json({ ok: true, status: 'paused' });
});

/** POST /api/graph/runs/:id/cancel — cancel (AC4.3). */
graphRoutes.post('/runs/:id/cancel', async (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const id = c.req.param('id');
  const run = getGraphRun(id);
  if (!run) return c.json({ error: 'Graph run not found' }, 404);
  if (run.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Graph run not found' }, 404);
  }
  cancelGraphRun(id, `Cancelled via Web by ${authUser.username}`);
  return c.json({ ok: true, status: 'cancelled' });
});

/** POST /api/graph/runs/:id/nodes/:nodeId/rerun — rerun node + downstream (AC4.4). */
graphRoutes.post('/runs/:id/nodes/:nodeId/rerun', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const id = c.req.param('id');
  const nodeId = c.req.param('nodeId');
  const run = getGraphRun(id);
  if (!run) return c.json({ error: 'Graph run not found' }, 404);
  if (run.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Graph run not found' }, 404);
  }
  const changed = rerunGraphNode(id, nodeId);
  // Kick resume so the scheduler re-derives the ready queue.
  const webDeps = getWebDeps();
  webDeps?.resumeGraphRun?.(id);
  return c.json({ ok: true, resetNodes: changed });
});

/** GET /api/graph/runs/:id/usage — token/cost aggregated per node. */
graphRoutes.get('/runs/:id/usage', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const id = c.req.param('id');
  const run = getGraphRun(id);
  if (!run) return c.json({ error: 'Graph run not found' }, 404);
  if (run.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Graph run not found' }, 404);
  }
  const nodes = listGraphNodeRuns(id);
  const byNode = nodes.map((n) => ({
    nodeId: n.node_id,
    attempt: n.attempt,
    status: n.status,
    inputTokens: n.input_tokens,
    outputTokens: n.output_tokens,
    costUsd: n.cost_usd,
  }));
  const totals = nodes.reduce(
    (acc, n) => {
      acc.inputTokens += n.input_tokens;
      acc.outputTokens += n.output_tokens;
      acc.costUsd += n.cost_usd;
      return acc;
    },
    { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );
  return c.json({ byNode, totals });
});

/** GET /api/graph/runs/:id/nodes/:nodeId/trace — Super Agent Team: the agent
 *  node's internal sub-step trace (turn/tool span tree) + raw tool-call I/O.
 *  Returns {traceNodes, toolCalls} for the node-internal sub-graph view. */
graphRoutes.get('/runs/:id/nodes/:nodeId/trace', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const id = c.req.param('id');
  const nodeId = c.req.param('nodeId');
  const run = getGraphRun(id);
  if (!run) return c.json({ error: 'Graph run not found' }, 404);
  if (run.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Graph run not found' }, 404);
  }
  const traceNodes = listGraphNodeTraceNodes(id, nodeId);
  const toolCalls = listTraceToolCalls(id, nodeId);
  return c.json({ traceNodes, toolCalls });
});

/** GET /api/graph/runs/:id/nodes/:nodeId — latest node_run (approval status). */
graphRoutes.get('/runs/:id/nodes/:nodeId', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const id = c.req.param('id');
  const nodeId = c.req.param('nodeId');
  const run = getGraphRun(id);
  if (!run) return c.json({ error: 'Graph run not found' }, 404);
  if (run.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Graph run not found' }, 404);
  }
  const nodeRun = getLatestGraphNodeRun(id, nodeId);
  if (!nodeRun) return c.json({ error: 'Node run not found' }, 404);
  return c.json({ nodeRun });
});

/** POST /api/graph/runs/:id/nodes/:nodeId/approve — P1: submit a human node
 *  approval decision. Marks the human node completed, writes the chosen
 *  option into state, and resumes the run. Body: { optionId, note? }. */
graphRoutes.post('/runs/:id/nodes/:nodeId/approve', async (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const id = c.req.param('id');
  const nodeId = c.req.param('nodeId');
  const run = getGraphRun(id);
  if (!run) return c.json({ error: 'Graph run not found' }, 404);
  if (run.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Graph run not found' }, 404);
  }
  const body = await c.req.json().catch(() => null);
  if (!body?.optionId) return c.json({ error: 'Missing optionId' }, 400);
  const result = approveHumanNode(id, nodeId, String(body.optionId), body.note ? String(body.note) : undefined);
  if (!result.ok) return c.json({ error: result.error }, 400);
  const webDeps = getWebDeps();
  webDeps?.resumeGraphRun?.(id);
  return c.json({ ok: true, stateKey: result.stateKey });
});

/** POST /api/graph/runs/:id/replan — P1: dynamic re-plan. Registers a new
 *  version of the run's definition and repoints the run to it, then resumes.
 *  Body: { nodes, edges, stateSchema? }. Admin only (mutates the graph). */
graphRoutes.post('/runs/:id/replan', async (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  if (authUser.role !== 'admin') return c.json({ error: 'admin only' }, 403);
  const id = c.req.param('id');
  const run = getGraphRun(id);
  if (!run) return c.json({ error: 'Graph run not found' }, 404);
  const body = await c.req.json().catch(() => null);
  if (!Array.isArray(body?.nodes) || !Array.isArray(body?.edges)) {
    return c.json({ error: 'Missing nodes/edges' }, 400);
  }
  const newVersion = (run.definition_version ?? 0) + 1;
  try {
    registerDefinition({
      id: run.definition_id,
      version: newVersion,
      name: run.definition_id,
      nodes: body.nodes,
      edges: body.edges,
      stateSchema: body.stateSchema,
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
  repointGraphRunDefinition(id, run.definition_id, newVersion);
  const webDeps = getWebDeps();
  webDeps?.resumeGraphRun?.(id);
  return c.json({ ok: true, version: newVersion });
});
