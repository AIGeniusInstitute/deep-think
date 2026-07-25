// Autonomy Layer unit tests — bus, registry, metrics.
// Covers PRD §F1.1/F1.2/F2.1/F2.2 acceptance criteria.

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-test-'));
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
  listCapabilities,
  touchCapability,
  setCapabilityStatus,
  __resetAutonomyRegistryForTest,
} = await import('../../src/autonomy/autonomy-registry.js');
const {
  emitAutonomyEvent,
  onAutonomyEvent,
  __resetAutonomyBusForTest,
} = await import('../../src/autonomy/autonomy-bus.js');
const {
  recordMetric,
  aggregateMetric,
  startAutonomyMetricsCollector,
  __resetAutonomyMetricsForTest,
} = await import('../../src/autonomy/autonomy-metrics.js');

beforeAll(() => {
  initDatabase();
  // Wire registry + metrics collector once for the whole suite.
  __resetAutonomyBusForTest();
  __resetAutonomyRegistryForTest();
  __resetAutonomyMetricsForTest();
  bootAutonomyRegistry();
  startAutonomyMetricsCollector();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Clear autonomy tables between tests; keep bus subscribers wired.
  getDb().exec('DELETE FROM autonomy_metrics');
});

// --- F1.1 Autonomy bus ---

describe('autonomy-bus', () => {
  test('delivers valid event to subscriber', () => {
    const received: any[] = [];
    const off = onAutonomyEvent((ev) => received.push(ev));
    emitAutonomyEvent({
      capability: 'perception',
      domain: 'system',
      type: 'perception.active_trigger',
      payload: { passive: false },
      ts: 1000,
    });
    off();
    expect(received).toHaveLength(1);
    expect(received[0].capability).toBe('perception');
    expect(received[0].payload.passive).toBe(false);
  });

  test('rejects event whose type does not start with capability prefix', () => {
    const received: any[] = [];
    const off = onAutonomyEvent((ev) => received.push(ev));
    // @ts-expect-error — intentionally invalid type prefix
    emitAutonomyEvent({ capability: 'perception', domain: 'x', type: 'execution.completed', payload: {}, ts: 1 });
    off();
    expect(received).toHaveLength(0);
  });

  test('a throwing subscriber does not break emit', () => {
    const off = onAutonomyEvent(() => {
      throw new Error('boom');
    });
    expect(() =>
      emitAutonomyEvent({
        capability: 'perception',
        domain: 'system',
        type: 'perception.active_trigger',
        payload: {},
        ts: 2000,
      }),
    ).not.toThrow();
    off();
  });

  test('unsubscribe stops delivery', () => {
    const received: any[] = [];
    const off = onAutonomyEvent((ev) => received.push(ev));
    off();
    emitAutonomyEvent({
      capability: 'perception',
      domain: 'system',
      type: 'perception.active_trigger',
      payload: {},
      ts: 3000,
    });
    expect(received).toHaveLength(0);
  });
});

// --- F1.2 Capability registry ---

describe('autonomy-registry', () => {
  test('boot registers all 7 capabilities', () => {
    const caps = listCapabilities();
    expect(caps).toHaveLength(7);
    const names = caps.map((c) => c.capability);
    expect(names).toEqual([
      'perception',
      'cognition',
      'decision',
      'execution',
      'learning',
      'adaptation',
      'monitoring',
    ]);
  });

  test('touchCapability updates last_event_at', () => {
    touchCapability('execution', 12345);
    const caps = listCapabilities();
    const exec = caps.find((c) => c.capability === 'execution')!;
    expect(exec.last_event_at).toBe(12345);
    expect(exec.status).toBe('active');
  });

  test('setCapabilityStatus flips status', () => {
    setCapabilityStatus('monitoring', 'degraded');
    const caps = listCapabilities();
    const mon = caps.find((c) => c.capability === 'monitoring')!;
    expect(mon.status).toBe('degraded');
  });

  test('schema migration is idempotent (re-boot does not throw)', () => {
    expect(() => bootAutonomyRegistry()).not.toThrow();
    expect(listCapabilities()).toHaveLength(7);
  });
});

// --- F2.1 / F2.2 Metrics ---

describe('autonomy-metrics', () => {
  test('recordMetric + aggregateMetric computes ratio', () => {
    recordMetric({ capability: 'execution', metricName: 'success_rate', numerator: 1, denominator: 1 });
    recordMetric({ capability: 'execution', metricName: 'success_rate', numerator: 0, denominator: 1 });
    recordMetric({ capability: 'execution', metricName: 'success_rate', numerator: 1, denominator: 1 });
    const r = aggregateMetric('execution', 'success_rate', 0, Date.now() + 1)!;
    expect(r.numerator).toBe(2);
    expect(r.denominator).toBe(3);
    expect(r.ratio).toBeCloseTo(2 / 3, 5);
  });

  test('denominator=0 returns null ratio (never NaN)', () => {
    const r = aggregateMetric('execution', 'success_rate', 0, Date.now() + 1)!;
    expect(r.denominator).toBe(0);
    expect(r.ratio).toBeNull();
  });

  test('execution.completed event maps to success_rate metric (success=true → +1 numerator)', () => {
    emitAutonomyEvent({
      capability: 'execution',
      domain: 'run-1',
      type: 'execution.completed',
      payload: { success: true },
      ts: Date.now(),
      graphRunId: 'run-1',
    });
    const r = aggregateMetric('execution', 'success_rate', 0, Date.now() + 1000)!;
    expect(r.numerator).toBe(1);
    expect(r.denominator).toBe(1);
  });

  test('execution.completed event success=false → 0 numerator, +1 denominator', () => {
    emitAutonomyEvent({
      capability: 'execution',
      domain: 'run-2',
      type: 'execution.completed',
      payload: { success: false },
      ts: Date.now(),
      graphRunId: 'run-2',
    });
    const r = aggregateMetric('execution', 'success_rate', 0, Date.now() + 1000)!;
    expect(r.numerator).toBe(0);
    expect(r.denominator).toBe(1);
  });

  test('decision.generated event maps to decision_independence (human_triggered=false → +1)', () => {
    emitAutonomyEvent({
      capability: 'decision',
      domain: 'chat-1',
      type: 'decision.generated',
      payload: { human_triggered: false },
      ts: Date.now(),
    });
    const r = aggregateMetric('decision', 'decision_independence', 0, Date.now() + 1000)!;
    expect(r.numerator).toBe(1);
    expect(r.denominator).toBe(1);
  });

  test('perception.active_trigger passive=false → proactivity +1/+1', () => {
    emitAutonomyEvent({
      capability: 'perception',
      domain: 'system',
      type: 'perception.active_trigger',
      payload: { passive: false },
      ts: Date.now(),
    });
    const r = aggregateMetric('perception', 'proactivity_ratio', 0, Date.now() + 1000)!;
    expect(r.numerator).toBe(1);
    expect(r.denominator).toBe(1);
  });

  test('unmapped event type is ignored (no metric row)', () => {
    emitAutonomyEvent({
      capability: 'cognition',
      domain: 'system',
      type: 'cognition.some_unmapped',
      payload: {},
      ts: Date.now(),
    });
    const r = aggregateMetric('cognition', 'some_unmapped', 0, Date.now() + 1000)!;
    expect(r.denominator).toBe(0);
    expect(r.ratio).toBeNull();
  });
});
