// Autonomy Layer P2 unit tests — self-healing + predictive maintenance (WP5).
// Covers PRD §F5.1/F5.2 acceptance criteria.

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-p2-test-'));
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
  handleExecutionFailure,
  handleExecutionSuccess,
  getHealStats,
  startHealCollector,
  __resetHealForTest,
} = await import('../../src/autonomy/autonomy-heal.js');

let captured: any[] = [];

beforeAll(() => {
  initDatabase();
  __resetAutonomyBusForTest();
  __resetAutonomyRegistryForTest();
  __resetAutonomyMetricsForTest();
  __resetHealForTest();
  bootAutonomyRegistry();
  startAutonomyMetricsCollector();
  startHealCollector();
  onAutonomyEvent((ev) => captured.push(ev));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  getDb().exec('DELETE FROM autonomy_metrics');
  __resetHealForTest();
  captured = [];
});

describe('autonomy-heal (WP5)', () => {
  test('4 failures accumulate streak without firing predict/heal', () => {
    for (let i = 0; i < 4; i++) {
      expect(handleExecutionFailure('run-1', 'run-1')).toBe('streak-accumulated');
    }
    const stats = getHealStats();
    expect(stats.errorStreak).toBe(4);
    expect(stats.totalPredictions).toBe(0);
    expect(captured.filter((e) => e.type === 'monitoring.predicted')).toHaveLength(0);
  });

  test('5th failure fires predictive warning + self-heal', () => {
    for (let i = 0; i < 4; i++) handleExecutionFailure('run-2', 'run-2');
    const action = handleExecutionFailure('run-2', 'run-2');
    expect(action).toBe('predicted+healed');
    const predicted = captured.filter((e) => e.type === 'monitoring.predicted');
    const healed = captured.filter((e) => e.type === 'monitoring.self_healed');
    expect(predicted).toHaveLength(1);
    expect(healed).toHaveLength(1);
    expect(predicted[0].payload.correct).toBe(true);
    expect(healed[0].payload.success).toBe(true);
    const stats = getHealStats();
    expect(stats.totalPredictions).toBe(1);
    expect(stats.correctPredictions).toBe(1);
    expect(stats.totalHeals).toBe(1);
    expect(stats.successfulHeals).toBe(1);
    expect(stats.errorStreak).toBe(0); // reset after heal
  });

  test('success resets the streak (no false positive)', () => {
    handleExecutionFailure('run-3', 'run-3');
    handleExecutionFailure('run-3', 'run-3');
    handleExecutionSuccess();
    expect(getHealStats().errorStreak).toBe(0);
    // subsequent 4 failures should NOT fire (streak was reset)
    for (let i = 0; i < 4; i++) handleExecutionFailure('run-3', 'run-3');
    expect(getHealStats().totalPredictions).toBe(0);
  });

  test('execution.completed(success=false) event auto-triggers heal path', () => {
    for (let i = 0; i < 5; i++) {
      emitAutonomyEvent({
        capability: 'execution',
        domain: 'run-4',
        type: 'execution.completed',
        payload: { success: false },
        ts: Date.now(),
        graphRunId: 'run-4',
      });
    }
    expect(getHealStats().totalPredictions).toBe(1);
    expect(getHealStats().totalHeals).toBe(1);
  });

  test('prediction_accuracy metric collected (correct=true → +1/+1)', () => {
    for (let i = 0; i < 5; i++) handleExecutionFailure('run-5', 'run-5');
    const m = aggregateMetric('monitoring', 'prediction_accuracy', 0, Date.now() + 1000)!;
    expect(m.numerator).toBe(1);
    expect(m.denominator).toBe(1);
    expect(m.ratio).toBe(1);
  });

  test('self_repair_rate metric collected (success=true → +1/+1)', () => {
    for (let i = 0; i < 5; i++) handleExecutionFailure('run-6', 'run-6');
    const m = aggregateMetric('monitoring', 'self_repair_rate', 0, Date.now() + 1000)!;
    expect(m.numerator).toBe(1);
    expect(m.denominator).toBe(1);
  });
});
