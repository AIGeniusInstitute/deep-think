// Autonomy Layer P1 unit tests — learning loop closure (WP3) + active adaptation (WP4).
// Covers PRD §F3.1/F3.2/F4.1 acceptance criteria.

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-p1-test-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
}));

const { initDatabase, getDb } = await import('../../src/db.js');
const {
  bootAutonomyRegistry,
  __resetAutonomyRegistryForTest,
} = await import('../../src/autonomy/autonomy-registry.js');
const {
  emitAutonomyEvent,
  onAutonomyEvent,
  __resetAutonomyBusForTest,
} = await import('../../src/autonomy/autonomy-bus.js');
const {
  startAutonomyMetricsCollector,
  aggregateMetric,
  __resetAutonomyMetricsForTest,
} = await import('../../src/autonomy/autonomy-metrics.js');
const {
  captureRunLesson,
  extractRunLesson,
  searchLessons,
  startLearningCollector,
  __resetAutonomyLearningForTest,
} = await import('../../src/autonomy/autonomy-learning.js');
const {
  processPendingSignals,
  __stopAdaptationLoopForTest,
} = await import('../../src/autonomy/autonomy-adapt.js');

// --- fixtures ---
function insertGraphRun(id: string, opts: { status?: string; goal?: string; startedAt?: string; cost?: number } = {}) {
  getDb()
    .prepare(
      `INSERT INTO graph_runs
        (id, definition_id, definition_version, owner_user_id, group_folder, chat_jid,
         goal_text, status, state_json, max_parallel, total_input_tokens,
         total_output_tokens, total_cost_usd, started_at)
       VALUES (?, 'def-x', 1, 'u1', 'g', 'c1', ?, ?, '{}', 4, 0, 0, ?, ?)`,
    )
    .run(
      id,
      opts.goal ?? 'build a graph engine',
      opts.status ?? 'completed',
      opts.cost ?? 0.01,
      opts.startedAt ?? new Date(Date.now() - 60000).toISOString(),
    );
}
function insertGraphNode(runId: string, nodeId: string, type: string, status: string) {
  getDb()
    .prepare(
      `INSERT INTO graph_node_runs
        (id, graph_run_id, node_id, node_type, status, attempt, input_tokens,
         output_tokens, cost_usd, is_idempotent)
       VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0)`,
    )
    .run(`${runId}-${nodeId}`, runId, nodeId, type, status);
}

let captured: any[] = [];

beforeAll(() => {
  initDatabase();
  // Test fixture inserts graph_runs without their graph_definitions parent —
  // disable FK enforcement for this suite only (production DB is unaffected).
  getDb().exec('PRAGMA foreign_keys=OFF');
  __resetAutonomyBusForTest();
  __resetAutonomyRegistryForTest();
  __resetAutonomyMetricsForTest();
  __resetAutonomyLearningForTest();
  bootAutonomyRegistry();
  startAutonomyMetricsCollector();
  startLearningCollector();
  onAutonomyEvent((ev) => captured.push(ev));
});

afterAll(() => {
  __stopAdaptationLoopForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  getDb().exec('DELETE FROM autonomy_metrics');
  getDb().exec('DELETE FROM autonomy_lessons');
  getDb().exec('DELETE FROM autonomy_signals');
  getDb().exec('DELETE FROM graph_node_runs');
  getDb().exec('DELETE FROM graph_runs');
  captured = [];
});

// --- WP3: learning loop closure ---

describe('autonomy-learning (WP3)', () => {
  test('extractRunLesson summarizes node + gate results', () => {
    insertGraphRun('run-1', { status: 'completed' });
    insertGraphNode('run-1', 'agent-a', 'agent', 'completed');
    insertGraphNode('run-1', 'gate-check', 'gate', 'completed');
    insertGraphNode('run-1', 'agent-b', 'agent', 'failed');
    const lesson = extractRunLesson('run-1')!;
    expect(lesson).not.toBeNull();
    expect(lesson.totalNodes).toBe(3);
    expect(lesson.completedNodes).toBe(2);
    expect(lesson.gateTotal).toBe(1);
    expect(lesson.gatePassed).toBe(1);
    expect(lesson.success).toBe(true);
    expect(lesson.lessonText).toContain('succeeded');
    expect(lesson.lessonText).toContain('2/3 nodes');
  });

  test('captureRunLesson sediments a lesson + emits learning.promoted', () => {
    insertGraphRun('run-2', { status: 'completed' });
    insertGraphNode('run-2', 'n1', 'agent', 'completed');
    captureRunLesson('run-2');
    const lessons = searchLessons();
    expect(lessons).toHaveLength(1);
    expect(lessons[0].lesson_text).toContain('succeeded');
    const promoted = captured.filter((e) => e.type === 'learning.promoted');
    expect(promoted).toHaveLength(1);
    expect(promoted[0].payload.latency_ms).toBeGreaterThanOrEqual(0);
  });

  test('captureRunLesson is idempotent (no duplicate on re-capture)', () => {
    insertGraphRun('run-3', { status: 'completed' });
    insertGraphNode('run-3', 'n1', 'agent', 'completed');
    captureRunLesson('run-3');
    captureRunLesson('run-3');
    expect(searchLessons()).toHaveLength(1);
  });

  test('searchLessons filters by keyword', () => {
    insertGraphRun('run-4', { status: 'completed', goal: 'deploy the api gateway' });
    insertGraphNode('run-4', 'n1', 'agent', 'completed');
    captureRunLesson('run-4');
    const hits = searchLessons(undefined, 'api gateway');
    expect(hits).toHaveLength(1);
    expect(hits[0].lesson_text).toContain('api gateway');
  });

  test('execution.completed event auto-triggers lesson capture (bus → learning)', () => {
    insertGraphRun('run-5', { status: 'completed' });
    insertGraphNode('run-5', 'n1', 'agent', 'completed');
    emitAutonomyEvent({
      capability: 'execution',
      domain: 'run-5',
      type: 'execution.completed',
      payload: { success: true },
      ts: Date.now(),
      graphRunId: 'run-5',
    });
    expect(searchLessons()).toHaveLength(1);
  });

  test('learning.promoted metric collected (strategy_update_latency_ms)', () => {
    insertGraphRun('run-6', { status: 'completed' });
    insertGraphNode('run-6', 'n1', 'agent', 'completed');
    captureRunLesson('run-6');
    const m = aggregateMetric('learning', 'strategy_update_latency_ms', 0, Date.now() + 1000)!;
    expect(m.denominator).toBe(1);
    expect(m.numerator).toBeGreaterThanOrEqual(0);
  });
});

// --- WP4: active adaptation ---

describe('autonomy-adapt (WP4)', () => {
  test('processPendingSignals marks applied + emits adaptation.adjusted', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO autonomy_signals (signal_type, payload_json, target_run_id, status, created_at, applied_at)
       VALUES (?, ?, ?, 'pending', ?, NULL)`,
    ).run('perf_degradation', JSON.stringify({ source: 'test' }), 'run-x', Date.now() - 2000);
    const n = processPendingSignals();
    expect(n).toBe(1);
    const row = db.prepare('SELECT status, applied_at FROM autonomy_signals WHERE id = 1').get() as any;
    expect(row.status).toBe('applied');
    expect(row.applied_at).not.toBeNull();
    const adjusted = captured.filter((e) => e.type === 'adaptation.adjusted');
    expect(adjusted).toHaveLength(1);
    expect(adjusted[0].payload.signal_type).toBe('perf_degradation');
    expect(adjusted[0].payload.latency_ms).toBeGreaterThanOrEqual(0);
  });

  test('adaptation.adjusted metric collected (adaptation_speed_ms)', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO autonomy_signals (signal_type, target_run_id, status, created_at, applied_at)
       VALUES (?, ?, 'pending', ?, NULL)`,
    ).run('demand_change', 'run-y', Date.now() - 1500);
    processPendingSignals();
    const m = aggregateMetric('adaptation', 'adaptation_speed_ms', 0, Date.now() + 1000)!;
    expect(m.denominator).toBe(1);
    expect(m.numerator).toBeGreaterThanOrEqual(0);
  });

  test('processPendingSignals is idempotent (no double-process)', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO autonomy_signals (signal_type, status, created_at, applied_at)
       VALUES (?, 'pending', ?, NULL)`,
    ).run('data_source_update', Date.now() - 1000);
    const first = processPendingSignals();
    const second = processPendingSignals();
    expect(first).toBe(1);
    expect(second).toBe(0);
  });

  test('no pending signals → processes 0, no event', () => {
    expect(processPendingSignals()).toBe(0);
    expect(captured.filter((e) => e.type === 'adaptation.adjusted')).toHaveLength(0);
  });
});
