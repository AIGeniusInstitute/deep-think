/**
 * Graph v2 集成验证 — TC7 预算熔断 + TC2 并发窗口.
 *
 * 真实 orchestrator + 真实 DB（隔离 /tmp）+ 仅 mock container-runner/sdk-query。
 * 复用 graph-e2e 的隔离数据目录与 mock 模式。
 *
 *   DEEPTHINK_DATA_DIR=/tmp/deepthink-e2e-graph npx vitest run tests/graph-v2-budget.test.ts
 */
import { beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// 每个 agent 节点贡献 120 input + 60 output = 180 tokens, $0.012.
vi.mock('../src/container-runner.js', () => ({
  runHostAgent: vi.fn(async (
    _group: unknown,
    input: { turnId?: string },
    _onProc: unknown,
    onOutput?: (o: unknown) => Promise<void>,
  ) => {
    await onOutput?.({
      status: 'stream',
      streamEvent: { usage: { inputTokens: 120, outputTokens: 60, costUSD: 0.012 } },
    });
    return { status: 'success', result: `out [${input.turnId ?? 'agent'}]` };
  }),
  runContainerAgent: vi.fn(async () => ({ status: 'success', result: 'out' })),
}));
vi.mock('../src/sdk-query.js', () => ({
  sdkQuery: vi.fn(async () => '{"result":"pass","reason":"ok","suggestion":""}'),
}));

import { initDatabase } from '../src/db.js';
import * as db from '../src/db.js';
import { registerDefinition } from '../src/graph-engineering/graph-registry.js';
import {
  startGraphRun,
  buildRunContext,
  executeGraph,
} from '../src/graph-engineering/graph-orchestrator.js';
import type { GraphDeps } from '../src/graph-engineering/graph-runner.js';
import type { GraphDefinition } from '../src/graph-engineering/graph-types.js';

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

const DATA_DIR = process.env.DEEPTHINK_DATA_DIR || '/tmp/deepthink-e2e-graph';
const ISOLATED = DATA_DIR.startsWith('/tmp') || DATA_DIR.includes('e2e');
const describeIso = ISOLATED ? describe : describe.skip;

/** 串行 5 节点链 a→b→c→d→e，每节点 180 tokens. */
function chainGraph(maxTokens: number): GraphDefinition {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  return {
    id: 'budget-chain', version: 1, name: 'budget chain',
    nodes: ids.map((id) => ({ id, type: 'agent', title: id, prompt: id })),
    edges: ids.slice(1).map((id, i) => ({ id: `e${i}`, from: ids[i], to: id })),
    budget: { maxTokens },
  };
}

/** 3 并行分支 fan-out → aggregate → end (TC2). */
function parallelGraph(): GraphDefinition {
  return {
    id: 'parallel-3', version: 1, name: 'parallel-3',
    nodes: [
      { id: 'start', type: 'start', title: 'Start' },
      { id: 'fanout', type: 'parallel', title: '并行' },
      { id: 'ra', type: 'agent', title: '调研A', prompt: 'a' },
      { id: 'rb', type: 'agent', title: '调研B', prompt: 'b' },
      { id: 'rc', type: 'agent', title: '调研C', prompt: 'c' },
      { id: 'agg', type: 'aggregate', title: '汇聚', mergeStrategy: 'all' },
      { id: 'end', type: 'end', title: 'End', outputTemplate: '${state.node_agg_output}' },
    ],
    edges: [
      { id: 'e0', from: 'start', to: 'fanout' },
      { id: 'ea', from: 'fanout', to: 'ra' },
      { id: 'eb', from: 'fanout', to: 'rb' },
      { id: 'ec', from: 'fanout', to: 'rc' },
      { id: 'ja', from: 'ra', to: 'agg' },
      { id: 'jb', from: 'rb', to: 'agg' },
      { id: 'jc', from: 'rc', to: 'agg' },
      { id: 'ee', from: 'agg', to: 'end' },
    ],
  };
}

describeIso('Graph v2: TC7 预算熔断 + TC2 并发', () => {
  beforeAll(() => {
    if (!ISOLATED) return;
    fs.rmSync(path.join(DATA_DIR, 'db', 'messages.db'), { force: true });
    initDatabase();
  });

  test('TC7 — maxTokens 熔断: 累计超限后 run failed, reason 含 budget exceeded', async () => {
    registerDefinition(chainGraph(300)); // 2 节点 = 360 > 300
    const deps = buildDeps();
    const started = startGraphRun({
      definitionId: 'budget-chain', ownerUserId: 'u1',
      groupFolder: 'main', chatJid: 'feishu:e2e',
    });
    const runId = (started as { runId: string }).runId;
    const ctxRes = await buildRunContext(runId, deps);
    expect(ctxRes).not.toBeNull();
    await executeGraph(ctxRes!.ctx, deps);

    const run = db.getGraphRun(runId);
    expect(run?.status).toBe('failed');
    expect(run?.cancel_reason).toContain('budget exceeded');
    // 不应跑完全部 5 节点
    const nodes = db.listGraphNodeRuns(runId);
    const completed = nodes.filter((n) => n.status === 'completed');
    expect(completed.length).toBeLessThan(5);
  }, 30_000);

  test('TC2 — 3 并行分支 started_at 窗口重叠 (fan-out 并发)', async () => {
    registerDefinition(parallelGraph());
    const deps = buildDeps();
    const started = startGraphRun({
      definitionId: 'parallel-3', ownerUserId: 'u1',
      groupFolder: 'main', chatJid: 'feishu:e2e',
    });
    const runId = (started as { runId: string }).runId;
    const ctxRes = await buildRunContext(runId, deps);
    await executeGraph(ctxRes!.ctx, deps);

    const run = db.getGraphRun(runId);
    expect(run?.status).toBe('completed');
    const nodes = db.listGraphNodeRuns(runId);
    const pick = (id: string) => nodes.find((n) => n.node_id === id);
    const ra = pick('ra'), rb = pick('rb'), rc = pick('rc');
    expect(ra?.started_at && rb?.started_at && rc?.started_at).toBeTruthy();
    // 三个并行节点的执行窗口两两重叠（并发而非串行）。
    const overlap = (x: { started_at: string; ended_at: string | null }, y: { started_at: string; ended_at: string | null }) =>
      new Date(x.started_at).getTime() <= new Date(y.ended_at ?? x.started_at).getTime() &&
      new Date(y.started_at).getTime() <= new Date(x.ended_at ?? x.started_at).getTime();
    expect(overlap(ra!, rb!)).toBe(true);
    expect(overlap(ra!, rc!)).toBe(true);
    expect(overlap(rb!, rc!)).toBe(true);
    // aggregate 在三者之后开始
    const agg = pick('agg');
    expect(new Date(agg!.started_at!).getTime()).toBeGreaterThanOrEqual(
      Math.max(new Date(ra!.ended_at!).getTime(), new Date(rb!.ended_at!).getTime(), new Date(rc!.ended_at!).getTime()),
    );
  }, 30_000);
});
