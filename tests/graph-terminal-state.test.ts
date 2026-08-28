/**
 * Regression coverage for graph lifecycle state persistence.
 *
 * Uses the real orchestrator, runner, scheduler, and database. Only the
 * external agent process is mocked so the tests remain deterministic.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GraphDefinition } from '../src/graph-engineering/graph-types.js';
import type { GraphDeps } from '../src/graph-engineering/graph-runner.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-terminal-state-'));
process.env.DEEPTHINK_DATA_DIR = tmpDir;

vi.mock('../src/container-runner.js', () => ({
  runHostAgent: vi.fn(),
  runContainerAgent: vi.fn(),
}));

let db: typeof import('../src/db.js');
let registry: typeof import('../src/graph-engineering/graph-registry.js');
let orchestrator: typeof import('../src/graph-engineering/graph-orchestrator.js');
let containerRunner: typeof import('../src/container-runner.js');

beforeAll(async () => {
  db = await import('../src/db.js');
  registry = await import('../src/graph-engineering/graph-registry.js');
  orchestrator = await import('../src/graph-engineering/graph-orchestrator.js');
  containerRunner = await import('../src/container-runner.js');
  db.initDatabase();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function buildDeps(): GraphDeps {
  return {
    registeredGroups: () =>
      ({
        main: {
          folder: 'main',
          chat_jid: 'web:main',
          owner_user_id: 'u1',
          execution_mode: 'host',
        },
      }) as unknown as ReturnType<GraphDeps['registeredGroups']>,
    getSessions: () => ({}),
    onProcess: () => {},
    broadcastStreamEvent: () => {},
    storeResultAndNotify: async () => {},
  };
}

function startRun(
  definition: GraphDefinition,
  initialState: Record<string, unknown> = {},
) {
  registry.registerDefinition(definition);
  const started = orchestrator.startGraphRun({
    definitionId: definition.id,
    ownerUserId: 'u1',
    groupFolder: 'main',
    chatJid: 'web:main',
    initialState,
  });
  if ('error' in started) throw new Error(started.error);
  return started.runId;
}

describe('Graph terminal state persistence', () => {
  test('executeGraph keeps a human node paused and resumes after approval', async () => {
    const definition: GraphDefinition = {
      id: 'terminal-state-human',
      version: 1,
      name: 'Terminal state human regression',
      nodes: [
        {
          id: 'approval',
          type: 'human',
          title: 'Approve deployment',
          approvalPrompt: 'Continue?',
          approvalOptions: [{ label: 'Approve', value: 'approve' }],
        },
      ],
      edges: [],
    };
    const runId = startRun(definition, { requestId: 'req-1' });
    const context = await orchestrator.buildRunContext(runId, buildDeps());
    expect(context).not.toBeNull();

    await orchestrator.executeGraph(context!.ctx, buildDeps());

    const pausedRun = db.getGraphRun(runId);
    expect(pausedRun?.status).toBe('paused');
    expect(JSON.parse(pausedRun?.state_json ?? '{}')).toMatchObject({
      requestId: 'req-1',
    });
    expect(db.getLatestGraphNodeRun(runId, 'approval')?.status).toBe('paused');

    const approved = orchestrator.approveHumanNode(
      runId,
      'approval',
      'approve',
      'looks good',
    );
    expect(approved).toEqual({ ok: true, stateKey: 'node_approval_approval' });

    const approvedRun = db.getGraphRun(runId);
    expect(approvedRun?.status).toBe('paused');
    expect(JSON.parse(approvedRun?.state_json ?? '{}')).toMatchObject({
      requestId: 'req-1',
      node_approval_approval: 'approve',
      node_approval_approval__note: 'looks good',
    });

    const resumedContext = await orchestrator.buildRunContext(
      runId,
      buildDeps(),
    );
    expect(resumedContext).not.toBeNull();
    await orchestrator.executeGraph(resumedContext!.ctx, buildDeps());

    const completedRun = db.getGraphRun(runId);
    expect(completedRun?.status).toBe('completed');
    expect(JSON.parse(completedRun?.state_json ?? '{}')).toMatchObject({
      requestId: 'req-1',
      node_approval_approval: 'approve',
      node_approval_approval__note: 'looks good',
    });
  });

  test('executeGraph keeps the run failed when an agent node fails', async () => {
    vi.mocked(containerRunner.runHostAgent).mockResolvedValueOnce({
      status: 'error',
      result: null,
      error: 'simulated agent failure',
    });
    const definition: GraphDefinition = {
      id: 'terminal-state-failure',
      version: 1,
      name: 'Terminal state failure regression',
      nodes: [
        {
          id: 'work',
          type: 'agent',
          title: 'Failing work',
          prompt: 'fail',
          maxAttempts: 1,
        },
      ],
      edges: [],
    };
    const runId = startRun(definition, { requestId: 'req-2' });
    const deps = buildDeps();
    const context = await orchestrator.buildRunContext(runId, deps);
    expect(context).not.toBeNull();

    await orchestrator.executeGraph(context!.ctx, deps);

    const failedRun = db.getGraphRun(runId);
    expect(failedRun?.status).toBe('failed');
    expect(failedRun?.cancel_reason).toContain('simulated agent failure');
    expect(JSON.parse(failedRun?.state_json ?? '{}')).toMatchObject({
      requestId: 'req-2',
    });
    expect(db.getLatestGraphNodeRun(runId, 'work')?.status).toBe('failed');
  });
});
