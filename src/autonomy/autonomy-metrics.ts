// Autonomy metrics — quantified measurement of the 7 capabilities.
//
// Metrics are stored as raw (numerator, denominator) pairs in autonomy_metrics.
// Aggregation sums numerator+denominator over a window and computes ratio at
// read time — this preserves re-windowing (PRD §F2.2). denominator=0 → null
// (never NaN).
//
// The metrics module subscribes to the autonomy bus; capability-specific event
// types map to numerator/denominator increments via a type→handler table. New
// metrics are added by extending EVENT_HANDLERS — no schema change needed.
//
// See docs/prd/autonomy-system/PRD.md §F2.1 (metric definitions table).

import { getDb } from '../db.js';
import type { AutonomyEvent, MetricIncrement, MetricRatio, Capability } from './autonomy-types.js';
import { onAutonomyEvent } from './autonomy-bus.js';
import { logger } from '../logger.js';

function nowMs(): number {
  return Date.now();
}

/**
 * Record a raw metric increment. numerator/denominator are added, not set.
 * Caller is responsible for the ratio semantics (e.g. +1/+1 for one success).
 */
export function recordMetric(inc: MetricIncrement): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO autonomy_metrics
        (capability, metric_name, numerator, denominator, run_id, graph_run_id, ts, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      inc.capability,
      inc.metricName,
      Math.max(0, Math.floor(inc.numerator)),
      Math.max(0, Math.floor(inc.denominator)),
      inc.runId ?? null,
      inc.graphRunId ?? null,
      nowMs(),
      inc.details ? JSON.stringify(inc.details) : null,
    );
  } catch (err) {
    logger.warn({ err, inc }, '[autonomy-metrics] record failed — swallowed');
  }
}

/**
 * Aggregate a metric over [from, to] (epoch ms, inclusive). Returns ratio or
 * null when denominator is 0.
 */
export function aggregateMetric(
  capability: Capability,
  metricName: string,
  from: number,
  to: number,
): MetricRatio | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(numerator), 0) AS numerator,
         COALESCE(SUM(denominator), 0) AS denominator
       FROM autonomy_metrics
       WHERE capability = ? AND metric_name = ? AND ts >= ? AND ts <= ?`,
    )
    .get(capability, metricName, from, to) as { numerator: number; denominator: number };
  const numerator = row.numerator ?? 0;
  const denominator = row.denominator ?? 0;
  return {
    capability,
    metric_name: metricName,
    numerator,
    denominator,
    ratio: denominator > 0 ? numerator / denominator : null,
  };
}

/**
 * Aggregate ALL metrics for a capability over a window — used by the dashboard
 * health endpoint to compute a metrics_summary snapshot.
 */
export function aggregateAllMetricsForCapability(
  capability: Capability,
  from: number,
  to: number,
): MetricRatio[] {
  const db = getDb();
  const metricNames = db
    .prepare(
      'SELECT DISTINCT metric_name FROM autonomy_metrics WHERE capability = ? AND ts >= ? AND ts <= ?',
    )
    .all(capability, from, to) as { metric_name: string }[];
  return metricNames.map((m) => aggregateMetric(capability, m.metric_name, from, to)!).filter(Boolean);
}

// --- Event → metric mapping -------------------------------------------------
//
// Each handler returns a MetricIncrement (or null to ignore). The mapping
// encodes the metric definitions from PRD §F2.1. Adding a metric = adding a
// handler here; the bus + table stay unchanged.

type EventHandler = (ev: AutonomyEvent) => MetricIncrement | null;

const EVENT_HANDLERS: Record<string, EventHandler> = {
  // ① perception — proactivity ratio (active vs passive triggers)
  'perception.active_trigger': (ev) => {
    const passive = ev.payload?.passive === true;
    return {
      capability: 'perception',
      metricName: 'proactivity_ratio',
      numerator: passive ? 0 : 1,
      denominator: 1,
      runId: ev.runId,
      details: { trigger: ev.payload?.trigger },
    };
  },
  // ③ decision — independence (no human instruction)
  'decision.generated': (ev) => {
    const humanTriggered = ev.payload?.human_triggered === true;
    return {
      capability: 'decision',
      metricName: 'decision_independence',
      numerator: humanTriggered ? 0 : 1,
      denominator: 1,
      runId: ev.runId,
    };
  },
  // ④ execution — success rate + self-recovery rate
  'execution.completed': (ev) => ({
    capability: 'execution',
    metricName: 'success_rate',
    numerator: ev.payload?.success === true ? 1 : 0,
    denominator: 1,
    runId: ev.runId,
    graphRunId: ev.graphRunId,
  }),
  'execution.recovered': (ev) => ({
    capability: 'execution',
    metricName: 'self_recovery_rate',
    numerator: ev.payload?.success === false ? 0 : 1, // recovered=true → +1 numerator
    denominator: 1,
    runId: ev.runId,
  }),
  // ⑤ learning — strategy update latency (ms)
  'learning.promoted': (ev) => ({
    capability: 'learning',
    metricName: 'strategy_update_latency_ms',
    numerator: typeof ev.payload?.latency_ms === 'number' ? ev.payload.latency_ms : 0,
    denominator: 1,
    runId: ev.runId,
  }),
  // ⑥ adaptation — adaptation speed (ms)
  'adaptation.adjusted': (ev) => ({
    capability: 'adaptation',
    metricName: 'adaptation_speed_ms',
    numerator: typeof ev.payload?.latency_ms === 'number' ? ev.payload.latency_ms : 0,
    denominator: 1,
    runId: ev.runId,
  }),
  // ⑦ monitoring — prediction accuracy + self-heal rate
  'monitoring.predicted': (ev) => ({
    capability: 'monitoring',
    metricName: 'prediction_accuracy',
    numerator: ev.payload?.correct === true ? 1 : 0,
    denominator: 1,
  }),
  'monitoring.self_healed': (ev) => ({
    capability: 'monitoring',
    metricName: 'self_repair_rate',
    numerator: ev.payload?.success === false ? 0 : 1,
    denominator: 1,
  }),
};

let subscribed = false;

/**
 * Wire the metrics collector to the bus. Idempotent — only subscribes once.
 */
export function startAutonomyMetricsCollector(): void {
  if (subscribed) return;
  onAutonomyEvent((ev) => {
    const handler = EVENT_HANDLERS[ev.type];
    if (!handler) return;
    const inc = handler(ev);
    if (inc) recordMetric(inc);
  });
  subscribed = true;
  logger.info({ handlers: Object.keys(EVENT_HANDLERS).length }, '[autonomy-metrics] collector started');
}

/** Test-only. */
export function __resetAutonomyMetricsForTest(): void {
  subscribed = false;
}
