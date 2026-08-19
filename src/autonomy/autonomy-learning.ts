// Autonomy learning loop closure — graph_run completion → extract behavioral
// evidence → sediment as a cross-session lesson → searchable for future tasks.
//
// Design (Simplicity First):
// - We do NOT wire into harness-meta-loop's variant-promote machinery (that
//   mutates prompt/skill text via mutation_patch — a heavier, separate flow).
//   Instead we capture a *lesson* per run: a structured record of what the
//   configuration achieved, keyed by capability, retrievable by future
//   team-builders. This is the "cross-session learning solidification" the
//   PRD calls out as the largest gap (§0, ⑤).
// - Triggered by execution.completed events on the autonomy bus.
// - learning.promoted(latency_ms) is emitted so the learning-efficiency metric
//   (strategy_update_latency_ms) is collected. latency = run.started_at → now.
//
// See docs/prd/autonomy-system/PRD.md §F3.1/F3.2,
//     docs/tech_solution/autonomy-system/SOLUTION.md §6.

import { getDb } from '../db.js';
import { emitAutonomyEvent, onAutonomyEvent } from './autonomy-bus.js';
import { logger } from '../logger.js';

function nowMs(): number {
  return Date.now();
}

export interface RunLesson {
  graphRunId: string;
  capability: string;
  lessonText: string;
  success: boolean;
  totalNodes: number;
  completedNodes: number;
  gatePassed: number;
  gateTotal: number;
  costUsd: number;
}

/**
 * Extract behavioral evidence from a completed graph_run and its node runs.
 * Returns null if the run is missing or has no nodes (no signal to learn from).
 */
export function extractRunLesson(graphRunId: string): RunLesson | null {
  const db = getDb();
  const run = db
    .prepare('SELECT id, goal_text, status, started_at, total_cost_usd FROM graph_runs WHERE id = ?')
    .get(graphRunId) as
    | { id: string; goal_text: string | null; status: string; started_at: string; total_cost_usd: number }
    | undefined;
  if (!run) return null;
  const nodes = db
    .prepare('SELECT node_id, node_type, status FROM graph_node_runs WHERE graph_run_id = ?')
    .all(graphRunId) as { node_id: string; node_type: string; status: string }[];
  if (nodes.length === 0) return null;
  const totalNodes = nodes.length;
  const completedNodes = nodes.filter((n) => n.status === 'completed').length;
  const gates = nodes.filter((n) => n.node_type === 'gate');
  const gateTotal = gates.length;
  const gatePassed = gates.filter((n) => n.status === 'completed').length;
  const success = run.status === 'completed';
  const goalSnippet = (run.goal_text || '').slice(0, 80);
  const lessonText =
    `Task "${goalSnippet}": ${success ? 'succeeded' : 'failed'} — ` +
    `${completedNodes}/${totalNodes} nodes completed, ` +
    `${gatePassed}/${gateTotal} gates passed, ` +
    `${(run.total_cost_usd ?? 0).toFixed(4)} USD`;
  return {
    graphRunId,
    capability: 'execution',
    lessonText,
    success,
    totalNodes,
    completedNodes,
    gatePassed,
    gateTotal,
    costUsd: run.total_cost_usd ?? 0,
  };
}

/**
 * F7: archive fine-grained external-interaction results (web_search /
 * web_fetch / sandbox_run_code) from trace_tool_calls as autonomy_lessons.
 * This gives the system continual-learning material at the tool level, not
 * just the graph_run level. Called from captureRunLesson after the run lesson.
 *
 * Each archived lesson: capability='perception' (web) or 'execution' (sandbox),
 * lesson_text carries the query/url + a short result excerpt.
 */
const EXTERNAL_TOOLS = new Set([
  'web_search',
  'mcp__deepthink__web_search',
  'web_fetch',
  'mcp__deepthink__web_fetch',
  'sandbox_run_code',
  'mcp__deepthink__sandbox_run_code',
]);

function capabilityForTool(toolName: string): 'perception' | 'execution' {
  return toolName.includes('web') ? 'perception' : 'execution';
}

export function captureToolArtifacts(graphRunId: string): number {
  const db = getDb();
  let rows: { tool_name: string; input_json: string | null; output_json: string | null }[] = [];
  try {
    rows = db
      .prepare(
        `SELECT tool_name, input_json, output_json FROM trace_tool_calls
         WHERE graph_run_id = ? AND tool_name IS NOT NULL`,
      )
      .all(graphRunId) as { tool_name: string; input_json: string | null; output_json: string | null }[];
  } catch {
    return 0; // trace_tool_calls not available (non-graph run)
  }
  const now = nowMs();
  let archived = 0;
  for (const r of rows) {
    // Normalize tool name (strip mcp__deepthink__ prefix).
    const tool = r.tool_name.replace(/^mcp__deepthink__/, '');
    if (!EXTERNAL_TOOLS.has(tool)) continue;
    // Avoid duplicate archival for the same run+tool+input.
    let inputSummary = '';
    try {
      const parsed = r.input_json ? JSON.parse(r.input_json) : {};
      inputSummary = parsed.query || parsed.url || parsed.code || JSON.stringify(parsed).slice(0, 120);
    } catch {
      inputSummary = (r.input_json || '').slice(0, 120);
    }
    const dedupKey = `${graphRunId}|${tool}|${inputSummary.slice(0, 60)}`;
    const existing = db
      .prepare(`SELECT id FROM autonomy_lessons WHERE lesson_text LIKE ?`)
      .get(`%${dedupKey}%`);
    if (existing) continue;
    let outputSummary = '';
    try {
      if (r.output_json) {
        const parsed = JSON.parse(r.output_json);
        const text = typeof parsed === 'string' ? parsed : (parsed.text || parsed.content || JSON.stringify(parsed));
        outputSummary = String(text).slice(0, 200);
      }
    } catch {
      outputSummary = (r.output_json || '').slice(0, 200);
    }
    const lessonText = `[${tool}] ${inputSummary.slice(0, 120)} → ${outputSummary} (run:${graphRunId})`;
    db.prepare(
      `INSERT INTO autonomy_lessons
        (capability, lesson_text, derived_from_run_ids, applied_count, status, created_at, updated_at)
       VALUES (?, ?, ?, 0, 'active', ?, ?)`,
    ).run(capabilityForTool(tool), `${dedupKey}\n${lessonText}`, JSON.stringify([graphRunId]), now, now);
    archived++;
  }
  return archived;
}

/**
 * Persist a run lesson + emit learning.promoted so the learning-efficiency
 * metric (latency from run start → lesson sediment) is collected.
 * Idempotent guard: skips if a lesson for this run already exists.
 */
export function captureRunLesson(graphRunId: string): RunLesson | null {
  const lesson = extractRunLesson(graphRunId);
  if (!lesson) return null;
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT id FROM autonomy_lessons WHERE derived_from_run_ids LIKE ?`,
    )
    .get(`%"${graphRunId}"%`);
  // F7: archive fine-grained tool artifacts regardless of run-lesson idempotency
  // (captureToolArtifacts has its own per-tool dedup).
  try {
    captureToolArtifacts(graphRunId);
  } catch (err) {
    logger.warn({ err, graphRunId }, '[autonomy-learning] tool-artifact capture failed — swallowed');
  }
  if (existing) return lesson; // already sedimented — idempotent
  const now = nowMs();
  const startedAtMs = Date.parse(
    (db.prepare('SELECT started_at FROM graph_runs WHERE id = ?').get(graphRunId) as
      | { started_at: string }
      | undefined)?.started_at || '',
  );
  const latencyMs = Number.isFinite(startedAtMs) ? Math.max(0, now - startedAtMs) : 0;
  db.prepare(
    `INSERT INTO autonomy_lessons
      (capability, lesson_text, derived_from_run_ids, applied_count, status, created_at, updated_at)
     VALUES (?, ?, ?, 0, 'active', ?, ?)`,
  ).run(lesson.capability, lesson.lessonText, JSON.stringify([graphRunId]), now, now);
  emitAutonomyEvent({
    capability: 'learning',
    domain: graphRunId,
    type: 'learning.promoted',
    payload: { latency_ms: latencyMs, success: lesson.success, graphRunId },
    ts: now,
    runId: graphRunId,
  });
  return lesson;
}

/**
 * Search sedimented lessons by capability + free-text keyword (LIKE on lesson_text).
 * Used by future team-builders to retrieve prior-run experience.
 */
export function searchLessons(
  capability?: string,
  keyword?: string,
  limit = 20,
): { id: number; capability: string; lesson_text: string; applied_count: number }[] {
  const db = getDb();
  const where: string[] = ['status = ?'];
  const params: unknown[] = ['active'];
  if (capability) {
    where.push('capability = ?');
    params.push(capability);
  }
  if (keyword) {
    where.push('lesson_text LIKE ?');
    params.push(`%${keyword}%`);
  }
  const sql = `SELECT id, capability, lesson_text, applied_count FROM autonomy_lessons
    WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params) as {
    id: number;
    capability: string;
    lesson_text: string;
    applied_count: number;
  }[];
}

/** Mark a lesson as applied (increment applied_count) — called when a future task reuses it. */
export function markLessonApplied(lessonId: number): void {
  const db = getDb();
  db.prepare(
    `UPDATE autonomy_lessons SET applied_count = applied_count + 1, updated_at = ? WHERE id = ?`,
  ).run(nowMs(), lessonId);
}

let subscribed = false;

/** Wire the learning collector to execution.completed events. Idempotent. */
export function startLearningCollector(): void {
  if (subscribed) return;
  onAutonomyEvent((ev) => {
    if (ev.type !== 'execution.completed') return;
    if (!ev.graphRunId) return;
    try {
      captureRunLesson(ev.graphRunId);
    } catch (err) {
      logger.warn({ err, graphRunId: ev.graphRunId }, '[autonomy-learning] capture failed — swallowed');
    }
  });
  subscribed = true;
  logger.info('[autonomy-learning] collector started');
}

/** Test-only. */
export function __resetAutonomyLearningForTest(): void {
  subscribed = false;
}
