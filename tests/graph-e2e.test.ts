/**
 * Graph Engineering E2E — real orchestrator + real DB + real scheduler,
 * only the LLM/subprocess layer mocked (no provider creds, no process spawn).
 *
 * Covers the integration-level PRD use cases end-to-end:
 *  - register a dev-workflow graph definition (PRD → [fe,be] fan-out → join →
 *    code → test gate → merge), 7 nodes / 7 edges
 *  - executeGraph runs all nodes to completion (fan-out parallel, fan-in join,
 *    gate reviewer passes), checkpoints persist to graph_node_runs
 *  - resume: pre-populate 3 nodes as completed + state, re-enter executeGraph,
 *    assert it skips the 3 and runs the remaining 4 (AC3.4 resume)
 *  - rerun: reset a node + downstream, re-run (AC4.4)
 *
 * Run with an isolated data dir so the real server's DB is untouched:
 *   DEEPTHINK_DATA_DIR=/tmp/deepthink-e2e-graph npx vitest run tests/graph-e2e.test.ts
 */
import { beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Mock the LLM/subprocess layer (the only thing we can't really call).
// Agent nodes: return a canned output + usage via onOutput stream.
// Gate nodes: sdk-query returns a "pass" review JSON.
vi.mock('../src/container-runner.js', () => ({
  runHostAgent: vi.fn(async (
    _group: unknown,
    input: { turnId?: string },
    _onProc: unknown,
    onOutput?: (o: unknown) => Promise<void>,
  ) => {
    const nodeTag = input.turnId ?? 'agent';
    await onOutput?.({
      status: 'stream',
      streamEvent: { usage: { inputTokens: 120, outputTokens: 60, costUSD: 0.012 } },
    });
    const result = `agent output [${nodeTag}]`;
    await onOutput?.({ status: 'success', result });
    return { status: 'success', result };
  }),
  runContainerAgent: vi.fn(async (
    _group: unknown,
    input: { turnId?: string },
    _onProc: unknown,
    onOutput?: (o: unknown) => Promise<void>,
  ) => {
    const nodeTag = input.turnId ?? 'agent';
    await onOutput?.({
      status: 'stream',
      streamEvent: { usage: { inputTokens: 120, outputTokens: 60, costUSD: 0.012 } },
    });
    return { status: 'success', result: `agent output [${nodeTag}]` };
  }),
}));
vi.mock('../src/sdk-query.js', () => ({
  sdkQuery: vi.fn(async () =>
    '{"result":"pass","reason":"all tests pass","suggestion":""}',
  ),
}));

import { initDatabase } from '../src/db.js';
import * as db from '../src/db.js';
import { registerDefinition, toMermaid } from '../src/graph-engineering/graph-registry.js';
import {
  startGraphRun,
  buildRunContext,
  executeGraph,
  rerunGraphNode,
} from '../src/graph-engineering/graph-orchestrator.js';
import type { GraphDeps } from '../src/graph-engineering/graph-runner.js';
import type { GraphDefinition } from '../src/graph-engineering/graph-types.js';

function devWorkflowGraph(): GraphDefinition {
  return {
    id: 'dev-workflow', version: 1, name: 'Dev Workflow',
    description: 'PRD → 技术方案 fan-out → join → 编码 → 测试 gate → 合并',
    nodes: [
      { id: 'prd', type: 'agent', title: '生成 PRD', prompt: '生成 PRD 文档', isIdempotent: true },
      { id: 'design_fe', type: 'agent', title: '前端技术方案', prompt: '前端技术方案', isIdempotent: true },
      { id: 'design_be', type: 'agent', title: '后端技术方案', prompt: '后端技术方案', isIdempotent: true },
      { id: 'design_join', type: 'join', title: '方案汇合' },
      { id: 'code', type: 'agent', title: '编码实现', prompt: '编码实现', isIdempotent: false },
      { id: 'test_gate', type: 'gate', title: '测试评审', successCriteria: '所有测试通过' },
      { id: 'merge', type: 'agent', title: '合并到 main', prompt: '合并到 main', isIdempotent: true },
    ],
    edges: [
      { id: 'e1', from: 'prd', to: 'design_fe' },
      { id: 'e2', from: 'prd', to: 'design_be' },
      { id: 'e3', from: 'design_fe', to: 'design_join' },
      { id: 'e4', from: 'design_be', to: 'design_join' },
      { id: 'e5', from: 'design_join', to: 'code' },
      { id: 'e6', from: 'code', to: 'test_gate' },
      { id: 'e7', from: 'test_gate', to: 'merge' },
    ],
  };
}

function buildDeps(): GraphDeps {
  return {
    registeredGroups: () => ({
      main: { folder: 'main', chat_jid: 'feishu:e2e', owner_user_id: 'u1', execution_mode: 'host' },
    }) as unknown as Record<string, unknown>,
    getSessions: () => ({}),
    onProcess: () => {},
    broadcastStreamEvent: () => {},
    storeResultAndNotify: async () => {},
  } as unknown as GraphDeps;
}

const E2E_DATA_DIR = process.env.DEEPTHINK_DATA_DIR;

// SAFETY GUARD: only run when DEEPTHINK_DATA_DIR points at a throwaway
// (/tmp or *e2e*) dir. If unset, config.ts falls back to ~/.deepthink/data —
// initDatabase() would then open the real server's messages.db while the
// guard deleted a phantom /tmp path, leaking definition versions across runs.
// So skip instead of running against the live DB.
const ISOLATED =
  !!E2E_DATA_DIR &&
  (E2E_DATA_DIR.startsWith('/tmp') || E2E_DATA_DIR.includes('e2e'));
const describeE2E = ISOLATED ? describe : describe.skip;

describeE2E('Graph E2E: dev-workflow', () => {
  beforeAll(() => {
    if (!ISOLATED) return;
    // Fresh temp DB so we never touch the real server's messages.db.
    fs.rmSync(path.join(E2E_DATA_DIR!, 'db', 'messages.db'), { force: true });
    initDatabase();
  });

  test('register definition → Mermaid + version + hash', () => {
    const { key, hash } = registerDefinition(devWorkflowGraph());
    expect(key).toBe('dev-workflow@1');
    expect(hash).toHaveLength(64);
    const latest = db.getLatestGraphDefinition('dev-workflow');
    expect(latest).toBeDefined();
    const mermaid = toMermaid(devWorkflowGraph());
    expect(mermaid).toContain('graph TD');
    expect(mermaid).toMatch(/prd --> design_fe/);
  });

  test('full run: 7 nodes complete, fan-out + join + gate, checkpoint + usage', async () => {
    const deps = buildDeps();
    const started = startGraphRun({
      definitionId: 'dev-workflow', ownerUserId: 'u1',
      groupFolder: 'main', chatJid: 'feishu:e2e',
    });
    expect('error' in started).toBe(false);
    const runId = (started as { runId: string }).runId;

    const ctxRes = await buildRunContext(runId, deps);
    expect(ctxRes).not.toBeNull();
    await executeGraph(ctxRes!.ctx, deps);

    const run = getGraphRunSafe(runId);
    expect(run?.status).toBe('completed');

    const nodes = db.listGraphNodeRuns(runId);
    const completedIds = new Set(nodes.filter((n) => n.status === 'completed').map((n) => n.node_id));
    expect(completedIds.size).toBe(7);
    for (const id of ['prd', 'design_fe', 'design_be', 'design_join', 'code', 'test_gate', 'merge']) {
      expect(completedIds).toContain(id);
    }

    // Usage accumulated from 5 agent nodes (gate+join contribute 0).
    expect(run!.total_input_tokens).toBe(5 * 120);
    expect(run!.total_output_tokens).toBe(5 * 60);
    expect(run!.total_cost_usd).toBeCloseTo(5 * 0.012, 6);

    // State merged: each agent node exposes node_<id>_output.
    const state = JSON.parse(run!.state_json);
    expect(state.node_prd_output).toMatch(/agent output/);
    expect(state.node_design_fe_output).toMatch(/design_fe/);
    expect(state.node_merge_output).toMatch(/merge/);
  }, 30_000);

  test('resume: skips pre-completed nodes, runs the rest (AC3.4)', async () => {
    const deps = buildDeps();
    const started = startGraphRun({
      definitionId: 'dev-workflow', ownerUserId: 'u1',
      groupFolder: 'main', chatJid: 'feishu:e2e',
    });
    const runId = (started as { runId: string }).runId;

    // Simulate a partial run that crashed after the 3 design nodes completed.
    const pre = ['prd', 'design_fe', 'design_be'];
    const state: Record<string, unknown> = {};
    for (const id of pre) {
      const nr = db.createGraphNodeRun({
        id: `${runId}:${id}:pre`, graph_run_id: runId, node_id: id,
        node_type: 'agent', is_idempotent: true,
      });
      db.updateGraphNodeRun(nr, {
        status: 'completed', ended_at: new Date().toISOString(),
        output_summary: `pre-completed ${id}`,
        state_patch_json: JSON.stringify({ [`node_${id}_output`]: `pre ${id}` }),
      });
      state[`node_${id}_output`] = `pre ${id}`;
    }
    db.updateGraphRunStatus(runId, 'failed', { stateJson: JSON.stringify(state), cancelReason: 'simulated crash' });

    // Resume — should skip the 3 completed and run design_join→code→gate→merge.
    const ctxRes = await buildRunContext(runId, deps);
    expect(ctxRes).not.toBeNull();
    await executeGraph(ctxRes!.ctx, deps);

    const run = getGraphRunSafe(runId);
    expect(run?.status).toBe('completed');

    const nodes = db.listGraphNodeRuns(runId);
    // Exactly 7 rows (one per node — the 3 pre-completed were NOT re-run).
    expect(nodes.length).toBe(7);
    // The 3 pre rows kept their 'pre-completed' output (not overwritten).
    const prdNode = nodes.find((n) => n.node_id === 'prd');
    expect(prdNode?.output_summary).toBe('pre-completed prd');
    // The newly-run nodes have agent output.
    const codeNode = nodes.find((n) => n.node_id === 'code');
    expect(codeNode?.output_summary).toMatch(/agent output/);
    const mergeNode = nodes.find((n) => n.node_id === 'merge');
    expect(mergeNode?.output_summary).toMatch(/agent output/);

    // Resume ran 2 new agent nodes (code, merge) → 2*120 input tokens.
    expect(run!.total_input_tokens).toBe(2 * 120);
  }, 30_000);

  test('rerun node resets it + downstream (AC4.4)', async () => {
    const deps = buildDeps();
    const started = startGraphRun({
      definitionId: 'dev-workflow', ownerUserId: 'u1',
      groupFolder: 'main', chatJid: 'feishu:e2e',
    });
    const runId = (started as { runId: string }).runId;
    const ctxRes = await buildRunContext(runId, deps);
    await executeGraph(ctxRes!.ctx, deps);
    expect(getGraphRunSafe(runId)?.status).toBe('completed');

    const reset = rerunGraphNode(runId, 'code');
    expect(reset).toBeGreaterThan(0);

    const ctxRes2 = await buildRunContext(runId, deps);
    await executeGraph(ctxRes2!.ctx, deps);

    const run = getGraphRunSafe(runId);
    expect(run?.status).toBe('completed');
    const codeRuns = db.listGraphNodeRuns(runId).filter((n) => n.node_id === 'code');
    expect(codeRuns.length).toBeGreaterThanOrEqual(2);
  }, 30_000);
});

// Direct re-export to avoid pulling the `db` singleton name clash in test scope.
import { getGraphRun } from '../src/db.js';
function getGraphRunSafe(id: string) {
  return getGraphRun(id);
}
