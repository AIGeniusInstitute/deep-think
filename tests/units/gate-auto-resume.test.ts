// F6 part 2 — orchestrator gate-failure auto-resume control flow.
// AC6.1.1: gate fails once → upstream agent re-run with feedback → gate passes
//          on 2nd attempt → run completed.
// AC6.1.2: gate fails twice consecutively → run failed (GATE_RETRY_MAX=2).
// AC6.1.4: gate failure writes gate_feedback_<upstreamId> into state so the
//          re-run agent receives the evidence (covered in gate-feedback-prompt).

import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GraphNode, GraphState, NodeRunOutcome } from '../../src/graph-engineering/graph-types.js';

// --- mocks (applied before any orchestrator import resolves) ---

const finalStatus: { status: string; reason?: string } = { status: '' };
const stateSnapshot: GraphState = {};

vi.mock('../../src/db.js', () => ({
  getGraphRun: () => ({ status: 'running' }),
  getCompletedGraphNodeIds: () => new Set<string>(),
  listGraphNodeRuns: () => [] as { status: string }[],
  updateGraphRunStatus: (_id: string, status: string, opts?: { stateJson?: string; cancelReason?: string }) => {
    finalStatus.status = status;
    if (opts?.cancelReason) finalStatus.reason = opts.cancelReason;
    if (opts?.stateJson) {
      try { Object.assign(stateSnapshot, JSON.parse(opts.stateJson)); } catch { /* ignore */ }
    }
  },
  updateGraphRunState: (_id: string, stateJson: string) => {
    try { Object.assign(stateSnapshot, JSON.parse(stateJson)); } catch { /* ignore */ }
  },
}));

vi.mock('../../src/autonomy/autonomy-bus.js', () => ({
  emitAutonomyEvent: () => {},
  onAutonomyEvent: () => () => {},
}));

// Scripted runGraphNode: per-node call counter drives the outcome sequence.
const callCounts = new Map<string, number>();
const scripted: Record<string, Array<'completed' | 'failed'>> = {};
vi.mock('../../src/graph-engineering/graph-runner.js', () => ({
  runGraphNode: async (_ctx: unknown, _deps: unknown, node: GraphNode): Promise<NodeRunOutcome> => {
    const n = callCounts.get(node.id) ?? 0;
    callCounts.set(node.id, n + 1);
    const seq = scripted[node.id] ?? [];
    const status = seq[n] ?? 'completed';
    if (node.type === 'agent') {
      return {
        status: 'completed',
        output: `agent output attempt ${n + 1}`,
        statePatch: { [`node_${node.id}_output`]: `agent output attempt ${n + 1}` },
        inputTokens: 0, outputTokens: 0, costUsd: 0,
      };
    }
    // gate
    return status === 'completed'
      ? { status: 'completed', output: 'gate passed', inputTokens: 0, outputTokens: 0, costUsd: 0 }
      : { status: 'failed', output: 'gate failed: assertion missing', inputTokens: 0, outputTokens: 0, costUsd: 0, error: 'assertion [contains:测试通过] not found' };
  },
}));

const { executeGraph } = await import('../../src/graph-engineering/graph-orchestrator.js');
import type { GraphRunContext, GraphDeps } from '../../src/graph-engineering/graph-orchestrator.js';
import type { GraphDefinition } from '../../src/graph-engineering/graph-types.js';

function makeCtx(): GraphRunContext {
  const def: GraphDefinition = {
    id: 'def-f6', version: 1, name: 'f6-graph',
    nodes: [
      { id: 'a', type: 'agent', title: '实现功能', prompt: 'do the work' },
      { id: 'g', type: 'gate', title: '校验功能', upstreamNodeId: 'a', maxAttempts: 1, assertions: [{ kind: 'contains', value: '测试通过' }] },
    ],
    edges: [{ id: 'e1', from: 'a', to: 'g', type: 'data' }],
  };
  return {
    graphRunId: 'run-f6', ownerUserId: 'u1', groupFolder: 'main', chatJid: 'c1',
    definition: def, state: {}, maxParallel: 4,
  };
}

const stubDeps = {
  registeredGroups: () => ({}),
  getSessions: () => ({}),
  onProcess: () => {},
} as unknown as GraphDeps;

beforeAll(() => {});
beforeEach(() => {
  callCounts.clear();
  finalStatus.status = '';
  finalStatus.reason = undefined;
  for (const k of Object.keys(stateSnapshot)) delete stateSnapshot[k];
});

describe('F6 gate-failure auto-resume (AC6.1.1 / AC6.1.2)', () => {
  test('AC6.1.1 — gate fails once, upstream re-run, gate passes 2nd → run completed', async () => {
    scripted.a = ['completed', 'completed'];
    scripted.g = ['failed', 'completed'];
    await executeGraph(makeCtx(), stubDeps);
    expect(finalStatus.status).toBe('completed');
    // upstream agent re-ran twice (initial + 1 retry after gate feedback)
    expect(callCounts.get('a')).toBe(2);
    // gate evaluated twice
    expect(callCounts.get('g')).toBe(2);
  });

  test('AC6.1.2 — gate fails twice consecutively → run failed', async () => {
    scripted.a = ['completed', 'completed', 'completed'];
    scripted.g = ['failed', 'failed', 'failed'];
    await executeGraph(makeCtx(), stubDeps);
    expect(finalStatus.status).toBe('failed');
    expect(finalStatus.reason).toContain('node g failed');
    // gate failed twice → terminal (no 3rd gate run needed)
    expect(callCounts.get('g')).toBe(2);
  });

  test('AC6.1.4 — gate failure writes gate_feedback_<upstreamId> into state before re-run', async () => {
    scripted.a = ['completed', 'completed'];
    scripted.g = ['failed', 'completed'];
    const ctx = makeCtx();
    await executeGraph(ctx, stubDeps);
    // the in-memory ctx.state carries the feedback key for the upstream agent
    expect(ctx.state['gate_feedback_a']).toBeTruthy();
    expect(String(ctx.state['gate_feedback_a'])).toContain('评审失败');
    expect(String(ctx.state['gate_feedback_a'])).toContain('assertion');
  });

  test('gate with no upstreamNodeId fails the run immediately (no upstream to reset)', async () => {
    const ctx = makeCtx();
    (ctx.definition.nodes[1] as GraphNode).upstreamNodeId = undefined;
    scripted.a = ['completed'];
    scripted.g = ['failed'];
    await executeGraph(ctx, stubDeps);
    expect(finalStatus.status).toBe('failed');
    expect(callCounts.get('g')).toBe(1);
  });
});
