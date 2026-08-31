/**
 * Validate-node unit tests (V2.2 graph-side result-checking).
 *
 * Directly exercises runValidateNode / applyValidateOnFail with a minimal
 * in-memory GraphRunContext — no DB, no orchestrator. The validation engine
 * itself (validateJson) is covered by json-schema-validator.test.ts; these
 * tests cover the onFail policy routing (fail / retry / fallback) and the
 * upstream-output wiring.
 */
import { describe, expect, test } from 'vitest';
import { runValidateNode } from '../../src/graph-engineering/graph-runner.js';
import type { GraphRunContext, GraphNode, GraphDefinition } from '../../src/graph-engineering/graph-types.js';

function makeCtx(state: Record<string, unknown>): GraphRunContext {
  return {
    graphRunId: 'gr_test',
    ownerUserId: 'u',
    groupFolder: 'g',
    chatJid: 'c',
    definition: { id: 'd', version: 1, name: 'n', nodes: [], edges: [] } as GraphDefinition,
    state,
    maxParallel: 4,
  };
}

function validateNode(overrides: Partial<GraphNode>): GraphNode {
  return {
    id: 'v1',
    type: 'validate',
    title: 'check',
    outputSchema: { type: 'object', required: ['x'] },
    upstreamNodeId: 'up1',
    ...overrides,
  } as GraphNode;
}

describe('graph validate node (V2.2)', () => {
  test('schema pass → completed, echoes upstream output', async () => {
    const ctx = makeCtx({ node_up1_output: JSON.stringify({ x: 1 }) });
    const out = await runValidateNode(ctx, validateNode({}));
    expect(out.status).toBe('completed');
    expect(out.output).toBe(JSON.stringify({ x: 1 }));
  });

  test('schema fail + onFail=fail → failed with evidence', async () => {
    const ctx = makeCtx({ node_up1_output: JSON.stringify({ y: 1 }) });
    const out = await runValidateNode(ctx, validateNode({ onFail: 'fail' }));
    expect(out.status).toBe('failed');
    expect(out.error).toContain('x');
  });

  test('schema fail + onFail=retry → failed (orchestrator re-runs upstream)', async () => {
    const ctx = makeCtx({ node_up1_output: JSON.stringify({ y: 1 }) });
    const out = await runValidateNode(ctx, validateNode({ onFail: 'retry' }));
    expect(out.status).toBe('failed');
    expect(out.output).toContain('retry');
  });

  test('schema fail + onFail=fallback → completed, writes fallbackValue to state', async () => {
    const ctx = makeCtx({ node_up1_output: JSON.stringify({ y: 1 }) });
    const out = await runValidateNode(
      ctx,
      validateNode({ onFail: 'fallback', fallbackValue: { ok: true } }),
    );
    expect(out.status).toBe('completed');
    expect(ctx.state['node_v1_output']).toBe(JSON.stringify({ ok: true }));
    expect(out.output).toContain('fallback');
  });

  test('non-JSON upstream output → fails (no crash)', async () => {
    const ctx = makeCtx({ node_up1_output: 'not json' });
    const out = await runValidateNode(ctx, validateNode({}));
    expect(out.status).toBe('failed');
    expect(out.error).toContain('not valid JSON');
  });

  test('missing outputSchema → fails with config error', async () => {
    const ctx = makeCtx({ node_up1_output: '{}' });
    const out = await runValidateNode(ctx, validateNode({ outputSchema: undefined } as any));
    expect(out.status).toBe('failed');
    expect(out.error).toContain('outputSchema');
  });

  test('auto upstream (upstreamNodeId empty) reads state[node_<id>_output]?', async () => {
    // When upstreamNodeId is empty, runValidateNode reads '' → non-JSON → fails.
    // This documents current behavior; the orchestrator injects upstreamNodeId.
    const ctx = makeCtx({});
    const out = await runValidateNode(ctx, validateNode({ upstreamNodeId: '' }));
    expect(out.status).toBe('failed');
  });
});
