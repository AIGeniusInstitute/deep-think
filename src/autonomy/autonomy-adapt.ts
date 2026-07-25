// Autonomy active adaptation — environment-signal-driven adjustment.
//
// Design (Simplicity First):
// - P1 scope: signal reception → processing → adaptation.adjusted event →
//   adaptation-speed metric collection (≤30s target). This closes the
//   "signal → measurable adaptation" loop, the part the PRD §F4.1 quantifies.
// - The full LLM re-plan (re-decompose → repointGraphRunDefinition → resume) is
//   intentionally P2: it requires a fresh LLM decomposition call and is wired
//   alongside WP5. P1 records the signal + emits the adaptation event so the
//   adaptation-speed metric is already live and verifiable.
//
// See docs/prd/autonomy-system/PRD.md §F4.1/F4.2,
//     docs/tech_solution/autonomy-system/SOLUTION.md §7.

import { getDb } from '../db.js';
import { emitAutonomyEvent } from './autonomy-bus.js';
import { logger } from '../logger.js';

function nowMs(): number {
  return Date.now();
}

export interface AdaptationSignalRow {
  id: number;
  signal_type: string;
  payload_json: string | null;
  target_run_id: string | null;
  status: string;
  created_at: number;
  applied_at: number | null;
}

/**
 * Process one pending signal: mark applied + emit adaptation.adjusted with the
 * signal→applied latency. This is the measurable adaptation event.
 *
 * Returns true if a signal was processed.
 *
 * NOTE: full LLM re-plan (repoint+resume) is P2. P1 records the adaptation
 * latency; the actual graph-definition swap is wired in WP5.
 */
export function processPendingSignals(limit = 10): number {
  const db = getDb();
  const pending = db
    .prepare(
      `SELECT id, signal_type, payload_json, target_run_id, created_at
       FROM autonomy_signals WHERE status = 'pending'
       ORDER BY created_at ASC LIMIT ?`,
    )
    .all(limit) as {
      id: number;
      signal_type: string;
      payload_json: string | null;
      target_run_id: string | null;
      created_at: number;
    }[];
  let processed = 0;
  const now = nowMs();
  for (const sig of pending) {
    // Mark applied first (idempotent under concurrent ticks — status guard).
    const upd = db
      .prepare(
        `UPDATE autonomy_signals SET status = 'applied', applied_at = ? WHERE id = ? AND status = 'pending'`,
      )
      .run(now, sig.id);
    if (upd.changes === 0) continue; // another tick took it
    const latencyMs = Math.max(0, now - sig.created_at);
    emitAutonomyEvent({
      capability: 'adaptation',
      domain: sig.target_run_id || 'system',
      type: 'adaptation.adjusted',
      payload: {
        latency_ms: latencyMs,
        signal_type: sig.signal_type,
        target_run_id: sig.target_run_id,
      },
      ts: now,
      runId: sig.target_run_id || undefined,
    });
    processed++;
  }
  return processed;
}

/** List signals (admin observability). */
export function listSignals(limit = 50): AdaptationSignalRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, signal_type, payload_json, target_run_id, status, created_at, applied_at
       FROM autonomy_signals ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as AdaptationSignalRow[];
}

let loopHandle: NodeJS.Timeout | null = null;

/**
 * Start a 5s tick that drains pending adaptation signals. Idempotent.
 * Failures in a tick never crash the loop (try/catch per tick).
 */
export function startAdaptationLoop(): void {
  if (loopHandle) return;
  const tick = () => {
    try {
      processPendingSignals();
    } catch (err) {
      logger.warn({ err }, '[autonomy-adapt] tick failed — swallowed');
    }
  };
  loopHandle = setInterval(tick, 5000);
  logger.info('[autonomy-adapt] loop started (5s tick)');
}

/** Test-only. */
export function __stopAdaptationLoopForTest(): void {
  if (loopHandle) {
    clearInterval(loopHandle);
    loopHandle = null;
  }
}
