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
import { sdkQuery } from '../sdk-query.js';

function nowMs(): number {
  return Date.now();
}

const ADJUSTMENT_TIMEOUT_MS = 30_000;

/**
 * F5: generate a strategy adjustment for a signal via a single LLM turn.
 * Non-fatal: returns null on any failure (timeout, parse error, no API key).
 * The adjustment is a short directive that a downstream consumer (loop/graph
 * next iteration) can inject. This completes the adapt loop — P1 only recorded
 * signal→applied latency; now it actually produces a strategy change.
 */
async function generateAdjustment(sig: {
  signal_type: string;
  payload_json: string | null;
  target_run_id: string | null;
}): Promise<string | null> {
  let payloadSummary = '(none)';
  try {
    if (sig.payload_json) {
      const parsed = JSON.parse(sig.payload_json);
      payloadSummary = typeof parsed === 'string' ? parsed : JSON.stringify(parsed).slice(0, 500);
    }
  } catch {
    payloadSummary = (sig.payload_json || '(none)').slice(0, 500);
  }
  const prompt = [
    '你是 DeepThink 自适应引擎。基于以下运行信号，产出一行（≤200 字）策略调整建议，',
    '供下游任务下一轮迭代注入。只输出调整建议本身，不要解释、不要前缀。',
    '',
    `信号类型：${sig.signal_type}`,
    `目标运行：${sig.target_run_id || '(system)'}`,
    `信号载荷：${payloadSummary}`,
  ].join('\n');
  try {
    const out = await sdkQuery(prompt, { timeout: ADJUSTMENT_TIMEOUT_MS });
    const text = (out || '').trim().slice(0, 300);
    return text || null;
  } catch (err) {
    logger.warn({ err, signal_type: sig.signal_type }, '[autonomy-adapt] adjustment generation failed — falling back to latency-only');
    return null;
  }
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
 * Process pending signals: mark applied + (F5) generate an LLM strategy
 * adjustment when the signal targets a run + emit adaptation.adjusted with
 * the adjustment. Falls back to latency-only when adjustment generation fails.
 *
 * Now async because adjustment generation calls the LLM (bounded 30s, non-fatal).
 */
export async function processPendingSignals(limit = 10): Promise<number> {
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
    // F5: generate strategy adjustment for targeted signals (non-fatal).
    const adjustment = sig.target_run_id ? await generateAdjustment(sig) : null;
    if (adjustment) {
      // Write adjustment back into payload_json for downstream consumers.
      try {
        const updated = { ...(sig.payload_json ? JSON.parse(sig.payload_json) : {}), adjustment };
        db.prepare(`UPDATE autonomy_signals SET payload_json = ? WHERE id = ?`)
          .run(JSON.stringify(updated), sig.id);
      } catch { /* non-fatal — keep latency-only path */ }
    }
    emitAutonomyEvent({
      capability: 'adaptation',
      domain: sig.target_run_id || 'system',
      type: 'adaptation.adjusted',
      payload: {
        latency_ms: latencyMs,
        signal_type: sig.signal_type,
        target_run_id: sig.target_run_id,
        adjustment: adjustment ?? undefined,
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
  const tick = async () => {
    try {
      await processPendingSignals();
    } catch (err) {
      logger.warn({ err }, '[autonomy-adapt] tick failed — swallowed');
    }
  };
  loopHandle = setInterval(tick, 5000);
  logger.info('[autonomy-adapt] loop started (5s tick, async)');
}

/** Test-only. */
export function __stopAdaptationLoopForTest(): void {
  if (loopHandle) {
    clearInterval(loopHandle);
    loopHandle = null;
  }
}
