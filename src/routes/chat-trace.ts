/**
 * Routes for chat trace node DAG visualization.
 *
 * Two endpoints:
 *   GET  /api/groups/:jid/trace/nodes              — list all nodes for a chat
 *   PUT  /api/groups/:jid/trace/nodes/:id/annotation — save user annotations
 *
 * Rerun / continue-from-here is implemented client-side: the DAG node detail
 * panel reads the node's input (annotation if present, else original
 * input_summary) and sends it as a normal user message via the existing
 * /api/messages endpoint. This keeps the message pipeline single-path and
 * avoids a redundant server-side enqueue path.
 *
 * All endpoints require auth and group access (canAccessGroup).
 */

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { canAccessGroup } from '../web-context.js';
import {
  listChatTraceNodes,
  getChatTraceNode,
  saveChatTraceNodeAnnotation,
  getRegisteredGroup,
  listTraceSteps,
  getTraceStep,
} from '../db.js';
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { DATA_DIR } from '../config.js';

const router = new Hono<{ Variables: Variables }>();

router.use('*', authMiddleware);

function ensureGroupAccess(c: any) {
  const jid = c.req.param('jid');
  const user = c.get('user');
  const group = getRegisteredGroup(jid);
  if (!group || !canAccessGroup(user, { ...group, jid })) {
    return { jid, error: c.json({ error: 'No access to this group' }, 403) };
  }
  return { jid, group };
}

router.get('/:jid/trace/nodes', async (c) => {
  const access = ensureGroupAccess(c);
  if ('error' in access) return access.error;
  const nodes = listChatTraceNodes(access.jid);
  return c.json({ nodes });
});

router.put('/:jid/trace/nodes/:id/annotation', async (c) => {
  const jid = c.req.param('jid');
  const nodeId = parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(nodeId) || nodeId <= 0) {
    return c.json({ error: 'Invalid node id' }, 400);
  }
  const user = c.get('user');
  const group = getRegisteredGroup(jid);
  if (!group || !canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'No access to this group' }, 403);
  }
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Invalid body' }, 400);
  }
  const { annotationInput, annotationOutput } = body as {
    annotationInput?: unknown;
    annotationOutput?: unknown;
  };
  const inputStr =
    typeof annotationInput === 'string' ? annotationInput : null;
  const outputStr =
    typeof annotationOutput === 'string' ? annotationOutput : null;
  const existing = getChatTraceNode(jid, nodeId);
  if (!existing) {
    return c.json({ error: 'Node not found' }, 404);
  }
  saveChatTraceNodeAnnotation(jid, nodeId, inputStr, outputStr);
  return c.json({ ok: true });
});

/** Atomic Step Trace (v57): list fine-grained steps (thinking/compact/memory/
 *  llm_call/...) for a chat, optionally filtered by nodeType. */
router.get('/:jid/trace/steps', async (c) => {
  const access = ensureGroupAccess(c);
  if ('error' in access) return access.error;
  const nodeType = c.req.query('nodeType');
  let steps = listTraceSteps(access.jid);
  if (nodeType) steps = steps.filter((s) => s.node_type === nodeType);
  return c.json({ steps });
});

/** Read the full offloaded tool I/O payload for an atomic step (when
 *  output_ref points to a file under data/trace-io/). Path-traversal safe. */
router.get('/:jid/trace/steps/:spanId/io', async (c) => {
  const access = ensureGroupAccess(c);
  if ('error' in access) return access.error;
  const traceId = c.req.query('traceId');
  const spanId = c.req.param('spanId');
  if (!traceId) return c.json({ error: 'traceId required' }, 400);
  const step = getTraceStep(traceId, spanId);
  if (!step || !step.output_ref) {
    return c.json({ error: 'No offloaded I/O for this step' }, 404);
  }
  // Path-traversal guard: the ref must resolve under DATA_DIR/trace-io/.
  // Must match the WRITE side (chat-trace-persist.ts traceIoDir, which uses
  // DATA_DIR). Earlier this read process.cwd()/data/trace-io while the writer
  // used DATA_DIR — the mismatch made every offloaded I/O read fail the guard
  // and return 400, so trace tool I/O was write-only / unreadable.
  const ioRoot = resolve(DATA_DIR, 'trace-io');
  const resolved = resolve(step.output_ref);
  const rel = relative(ioRoot, resolved);
  if (rel.startsWith('..') || resolve(ioRoot, rel) !== resolved) {
    return c.json({ error: 'Invalid ref' }, 400);
  }
  try {
    const content = readFileSync(resolved, 'utf8');
    return c.json({ spanId, content });
  } catch {
    return c.json({ error: 'I/O file not found' }, 404);
  }
});

/** Replay timeline: merge coarse DAG nodes + atomic steps, ordered by time. */
router.get('/:jid/trace/timeline', async (c) => {
  const access = ensureGroupAccess(c);
  if ('error' in access) return access.error;
  const nodes = listChatTraceNodes(access.jid).map((n) => ({
    kind: 'node' as const,
    spanId: n.span_id ?? `n${n.id}`,
    traceId: n.trace_id,
    parentSpanId: n.parent_span_id,
    nodeType: n.node_type,
    title: n.title,
    status: n.status,
    startedAt: n.started_at,
    endedAt: n.ended_at,
  }));
  const steps = listTraceSteps(access.jid).map((s) => ({
    kind: 'step' as const,
    spanId: s.span_id,
    traceId: s.trace_id,
    parentSpanId: s.parent_span_id,
    nodeType: s.node_type,
    title: s.title,
    status: s.status,
    outputRef: s.output_ref,
    startedAt: s.started_at,
    endedAt: s.ended_at,
  }));
  const timeline = [...nodes, ...steps].sort(
    (a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0),
  );
  return c.json({ timeline });
});

export default router;

