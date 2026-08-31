// Long-running Supervisor Agent — core.
//
// A persistent, crash-recoverable supervisor that monitors the main conversation
// agent throughout a task lifecycle. Distinct from src/supervisor.ts (the
// stateless pre-dispatch intent parser) — this subsystem has its own DB tables,
// scheduling loop, decision audit trail, heartbeat, and boot-time recovery.
//
// Crash recovery follows the three existing precedents:
//  1. in-memory dedup set cleared on restart + DB stale 'running' rows flipped
//     to 'error' (task-scheduler cleanupStaleRunningLogs pattern)
//  2. next_check_at persisted as the scheduling anchor (loop_runs pattern)
//  3. heartbeat timeout → degraded + forced recovery check (new, but mirrors
//     the OOM auto-recovery "track consecutive failures" idea in index.ts)
//
// Feeding conclusions back to the main agent reuses the runGroupModeTask
// pattern: storePromptMessage (sourceKind='supervisor') + enqueueMessageCheck.

import { logger } from './logger.js';
import {
  createSupervisorSession,
  getSupervisorSession,
  getActiveSupervisorSessionForChat,
  listSupervisorSessions,
  listDueSupervisorSessions,
  listStaleHeartbeatSupervisorSessions,
  updateSupervisorSession,
  deleteSupervisorSession,
  createSupervisorDecision,
  finalizeSupervisorDecision,
  listSupervisorDecisions,
  getLatestSupervisorDecision,
  cleanupStaleSupervisorChecks,
} from './db.js';
import { getMessagesPage } from './db.js';
import { getLoopRun, listLoopIterations } from './db.js';
import type { SupervisorSessionRow, SupervisorDecisionRow } from './db.js';
import type {
  SupervisorStrategy,
  SupervisorSessionStatus,
  SupervisorAction,
  SupervisorEvidence,
} from './types.js';
import { randomUUID } from 'node:crypto';

export const SUPERVISOR_PERIOD_MIN_MS = 60_000;
export const SUPERVISOR_PERIOD_MAX_MS = 3_600_000;
export const SUPERVISOR_MAX_CHECKS_HARD_LIMIT = 500;
export const SUPERVISOR_TICK_MS_DEFAULT = 15_000;
export const SUPERVISOR_MAX_CONSECUTIVE_ERRORS = 5;
const SUPERVISOR_HEARTBEAT_PERIODS = 3;
const SUPERVISOR_EVENT_DEBOUNCE_MS = 5_000;

export { cleanupStaleSupervisorChecks };

// ---------------------------------------------------------------------------
// Public row types (re-exported for convenience)
// ---------------------------------------------------------------------------
export type {
  SupervisorSessionRow,
  SupervisorDecisionRow,
};

// ---------------------------------------------------------------------------
// ID + helpers
// ---------------------------------------------------------------------------
export function generateSupervisorId(): string {
  return `sup_${randomUUID()}`;
}

function generateDecisionId(): string {
  return `dec_${randomUUID()}`;
}

function nowIso(now?: number): string {
  return new Date(now ?? Date.now()).toISOString();
}

/** Clamp the requested period into the legal range. */
export function clampPeriodMs(requested: number | undefined): number {
  if (!requested || Number.isNaN(requested)) return 300_000;
  return Math.min(
    SUPERVISOR_PERIOD_MAX_MS,
    Math.max(SUPERVISOR_PERIOD_MIN_MS, Math.floor(requested)),
  );
}

/** Clamp the requested max_checks into the legal range. */
export function clampMaxChecks(requested: number | undefined): number {
  if (requested == null || Number.isNaN(requested)) return 100;
  return Math.min(
    SUPERVISOR_MAX_CHECKS_HARD_LIMIT,
    Math.max(1, Math.floor(requested)),
  );
}

function isTerminalStatus(status: string): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'aborted'
  );
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface CreateSupervisorInput {
  group_folder: string;
  chat_jid: string;
  owner_user_id?: string | null;
  goal_text: string;
  success_criteria: string;
  strategy?: SupervisorStrategy;
  period_ms?: number;
  max_checks?: number;
  bound_loop_run_id?: string | null;
  created_by?: string | null;
}

/**
 * Create a new supervisor session. Refuses (throws) if the chat already has an
 * active session — one active supervisor per chat at a time.
 */
export function createSupervisorSessionFromInput(
  input: CreateSupervisorInput,
): SupervisorSessionRow {
  if (getActiveSupervisorSessionForChat(input.chat_jid)) {
    const err = new Error(
      '该会话已有活跃的 Supervisor，请先关闭或暂停旧的再创建新的',
    );
    (err as any).statusCode = 409;
    throw err;
  }
  const id = generateSupervisorId();
  const now = Date.now();
  const startedAt = nowIso(now);
  const periodMs = clampPeriodMs(input.period_ms);
  const maxChecks = clampMaxChecks(input.max_checks);
  const strategy: SupervisorStrategy = input.strategy ?? 'periodic';
  // First check fires one period from now (periodic), or immediately for
  // on_iteration (so the supervisor can establish a baseline before the bound
  // loop's first turn completes).
  const nextCheckAt =
    strategy === 'on_iteration' ? startedAt : nowIso(now + periodMs);
  createSupervisorSession({
    id,
    group_folder: input.group_folder,
    chat_jid: input.chat_jid,
    owner_user_id: input.owner_user_id ?? null,
    goal_text: input.goal_text,
    success_criteria: input.success_criteria,
    strategy,
    period_ms: periodMs,
    max_checks: maxChecks,
    bound_loop_run_id: input.bound_loop_run_id ?? null,
    status: 'active',
    next_check_at: nextCheckAt,
    started_at: startedAt,
    created_at: startedAt,
    created_by: input.created_by ?? null,
  });
  return getSupervisorSession(id)!;
}

export function getSupervisorSessionById(id: string): SupervisorSessionRow | undefined {
  return getSupervisorSession(id);
}

export function listSupervisorSessionsFor(
  ownerUserId: string | null,
  opts: { status?: string; chatJid?: string; limit?: number; offset?: number } = {},
): SupervisorSessionRow[] {
  return listSupervisorSessions(ownerUserId, opts);
}

export interface UpdateSupervisorPatch {
  goal_text?: string;
  success_criteria?: string;
  strategy?: SupervisorStrategy;
  period_ms?: number;
  max_checks?: number;
  bound_loop_run_id?: string | null;
  enabled?: boolean;
}

export function updateSupervisorSessionFromInput(
  id: string,
  patch: UpdateSupervisorPatch,
): SupervisorSessionRow {
  const session = getSupervisorSession(id);
  if (!session) {
    const err = new Error('Supervisor not found');
    (err as any).statusCode = 404;
    throw err;
  }
  const updates: Partial<SupervisorSessionRow> = {};
  if (patch.goal_text !== undefined) updates.goal_text = patch.goal_text;
  if (patch.success_criteria !== undefined)
    updates.success_criteria = patch.success_criteria;
  if (patch.strategy !== undefined) updates.strategy = patch.strategy;
  if (patch.period_ms !== undefined) updates.period_ms = clampPeriodMs(patch.period_ms);
  if (patch.max_checks !== undefined) updates.max_checks = clampMaxChecks(patch.max_checks);
  if (patch.bound_loop_run_id !== undefined)
    updates.bound_loop_run_id = patch.bound_loop_run_id;

  if (patch.enabled !== undefined) {
    if (patch.enabled) {
      // resume: only from paused
      if (session.status === 'paused') {
        updates.status = 'active';
        updates.next_check_at = nowIso(Date.now() + session.period_ms);
      }
    } else {
      if (session.status === 'active') {
        updates.status = 'paused';
      }
    }
  }

  // If strategy changed to on_iteration, fire the next check immediately so the
  // baseline is established.
  if (patch.strategy === 'on_iteration' && session.status === 'active') {
    updates.next_check_at = nowIso();
  }

  updateSupervisorSession(id, updates);
  return getSupervisorSession(id)!;
}

export function deleteSupervisorSessionById(
  id: string,
  opts: { force?: boolean } = {},
): void {
  const session = getSupervisorSession(id);
  if (!session) {
    const err = new Error('Supervisor not found');
    (err as any).statusCode = 404;
    throw err;
  }
  if (session.status === 'active' && !opts.force) {
    const err = new Error('请先暂停（enabled=false）或使用 force=true 删除活跃会话');
    (err as any).statusCode = 409;
    throw err;
  }
  deleteSupervisorSession(id);
}

export function listDecisionsForSession(
  sessionId: string,
  opts: { limit?: number; offset?: number } = {},
): SupervisorDecisionRow[] {
  return listSupervisorDecisions(sessionId, opts);
}

// ---------------------------------------------------------------------------
// Decision parsing (pure function — unit-testable, mirrors parseDecision style)
// ---------------------------------------------------------------------------

export interface ParsedDecision {
  action: SupervisorAction | 'error';
  conclusion: string;
  evidence: SupervisorEvidence[];
  next_action_hint: string;
  confidence: number;
}

export function parseSupervisorDecision(raw: string): ParsedDecision | null {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/```json\s*/gi, '')
    .replace(/```\s*$/g, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  const action = parsed.action as string;
  if (
    action !== 'continue' &&
    action !== 'redirect' &&
    action !== 'escalate' &&
    action !== 'complete' &&
    action !== 'abort'
  ) {
    return null;
  }
  const evidenceRaw = Array.isArray(parsed.evidence) ? parsed.evidence : [];
  const evidence: SupervisorEvidence[] = [];
  for (const e of evidenceRaw) {
    if (!e || typeof e !== 'object') continue;
    const type = e.type as string;
    if (
      type !== 'message' &&
      type !== 'test' &&
      type !== 'file' &&
      type !== 'loop_status'
    ) {
      continue;
    }
    evidence.push({
      type,
      ref: String(e.ref ?? '').slice(0, 500),
      detail: e.detail ? String(e.detail).slice(0, 1000) : undefined,
    });
  }
  const conclusion = String(parsed.conclusion ?? '').slice(0, 4000);
  const nextHint =
    action === 'redirect' ? String(parsed.next_action_hint ?? '').slice(0, 4000) : '';
  if (action === 'redirect' && !nextHint) return null;
  let confidence = Number(parsed.confidence);
  if (Number.isNaN(confidence)) confidence = 0.5;
  confidence = Math.min(1, Math.max(0, confidence));
  return {
    action,
    conclusion,
    evidence,
    next_action_hint: nextHint,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Evidence gathering
// ---------------------------------------------------------------------------

interface BoundLoopSummary {
  loop_run_id: string;
  status: string;
  current_turn: number;
  max_turns: number;
  goal_text: string;
  last_review_result: string | null;
  last_review_reason: string | null;
}

function gatherBoundLoopSummary(
  boundLoopRunId: string | null,
): BoundLoopSummary | null {
  if (!boundLoopRunId) return null;
  const run = getLoopRun(boundLoopRunId);
  if (!run) return null;
  const iterations = listLoopIterations(boundLoopRunId);
  const last = iterations[iterations.length - 1] ?? null;
  return {
    loop_run_id: run.id,
    status: run.status,
    current_turn: run.current_turn,
    max_turns: run.max_turns,
    goal_text: run.goal_text,
    last_review_result: last?.review_result ?? null,
    last_review_reason: last?.review_reason ?? null,
  };
}

function summarizeRecentMessages(
  rows: Array<{ sender: string; content: string; is_from_me: boolean; source_kind?: string | null }>,
): string {
  // rows come newest-first; reverse for chronological readability.
  const chrono = [...rows].reverse();
  const lines = chrono.slice(-30).map((m, i) => {
    const role = m.is_from_me ? 'AI' : '用户';
    const src = m.source_kind && m.source_kind !== 'user' ? `[${m.source_kind}]` : '';
    return `${i + 1}. ${role}${src}: ${String(m.content ?? '').slice(0, 600)}`;
  });
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Check dependencies (injected for testability)
// ---------------------------------------------------------------------------

export interface RecentMessageLite {
  id: string;
  sender: string;
  sender_name?: string;
  content: string;
  is_from_me: boolean;
  source_kind?: string | null;
}

export interface SupervisorCheckDeps {
  getRecentMessages: (chatJid: string, limit: number) => Promise<RecentMessageLite[]>;
  getBoundLoopSummary?: (
    loopRunId: string,
  ) => Promise<BoundLoopSummary | null>;
  sdkQuery: (prompt: string, opts: { maxTurns: number; systemPrompt: string; model?: string; trace?: import('./sdk-query.js').LlmCallTrace }) => Promise<unknown>;
  storePromptMessage: (
    chatJid: string,
    senderId: string,
    senderName: string,
    text: string,
    taskId?: string,
  ) => Promise<void> | void;
  enqueueMessageCheck: (chatJid: string) => Promise<void> | void;
  notifyUser?: (chatJid: string, text: string) => Promise<void> | void;
  /** Returns true if this chat is in 全托管 (autonomous) mode.
   *  When true, escalate action does NOT store a prompt message or re-enqueue
   *  — instead it logs and emits an autonomous.brake_triggered event,
   *  letting the agent-runner's end-of-turn auto-continue take over. */
  isAutonomousChat?: (chatJid: string) => Promise<boolean>;
  /** Emit an autonomy-bus event. Used to signal autonomous.brake_triggered
   *  when escalate fires in autonomous mode. */
  emitAutonomyEvent?: (event: { type: string; [k: string]: unknown }) => void;
  now?: () => number;
}

function buildDecisionPrompt(
  session: SupervisorSessionRow,
  recentMessages: RecentMessageLite[],
  boundLoop: BoundLoopSummary | null,
): string {
  const evidenceLines: string[] = [];
  evidenceLines.push(`监督目标：${session.goal_text}`);
  evidenceLines.push(`达成判据：${session.success_criteria}`);
  if (boundLoop) {
    evidenceLines.push(
      `绑定 loop_run: status=${boundLoop.status}, turn=${boundLoop.current_turn}/${boundLoop.max_turns}, ` +
        `last_review=${boundLoop.last_review_result ?? 'n/a'} (${boundLoop.last_review_reason ?? ''})`,
    );
  }
  evidenceLines.push('近期主 Agent 对话（截断）：');
  evidenceLines.push(summarizeRecentMessages(recentMessages) || '（无）');
  return [
    '你是 DeepThink 的长驻 Supervisor Agent。你的职责是监督主对话 Agent 的工作进度，依据行为证据判断是否需要介入。',
    '',
    '【监督上下文】',
    evidenceLines.join('\n'),
    '',
    '【决策要求】',
    '基于上述证据，判断主 Agent 是否在朝监督目标收敛。输出严格 JSON（不要 markdown 代码块）：',
    '{',
    '  "action": "continue" | "redirect" | "escalate" | "complete" | "abort",',
    '  "conclusion": "一句话监督结论",',
    '  "evidence": [{"type":"message|test|file|loop_status","ref":"证据引用","detail":"说明"}],',
    '  "next_action_hint": "给主 Agent 的下一步指令（仅 redirect 必填）",',
    '  "confidence": 0.0-1.0',
    '}',
    '- continue: 进度正常，不打扰主 Agent。',
    '- redirect: 主 Agent 偏离或停滞，回喂 next_action_hint 驱动它收敛。',
    '- escalate: 缺关键信息无法判断，向用户提问（conclusion 写问题）。',
    '- complete: 目标已达成，关闭监督。',
    '- abort: 不可恢复，关闭监督并请求人工介入。',
    'evidence 必须引用上述上下文中可观察的事实，禁止臆测。',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The core check
// ---------------------------------------------------------------------------

export interface CheckOutcome {
  decision: SupervisorDecisionRow;
  session: SupervisorSessionRow;
  fedBack: boolean;
}

/**
 * Run one supervision check for a session. Idempotent under the in-memory dedup
 * set managed by the tick loop — but safe to call directly (manual trigger)
 * regardless.
 */
export async function runSupervisionCheck(
  sessionId: string,
  deps: SupervisorCheckDeps,
  triggeredBy: 'tick' | 'event' | 'manual' | 'recovery' = 'tick',
): Promise<CheckOutcome | null> {
  const session = getSupervisorSession(sessionId);
  if (!session) {
    logger.warn({ sessionId }, 'Supervisor session not found');
    return null;
  }
  if (session.status !== 'active') {
    return null;
  }
  const now = (deps.now?.() ?? Date.now());

  // Auto-complete if we've hit max_checks.
  if (session.current_checks >= session.max_checks) {
    updateSupervisorSession(sessionId, {
      status: 'completed',
      ended_at: nowIso(now),
      next_check_at: null,
    });
    await deps.notifyUser?.(
      session.chat_jid,
      `Supervisor 监督已达上限（${session.max_checks} 次），自动结束。`,
    );
    return null;
  }

  const decisionId = generateDecisionId();
  const turnIndex = session.current_checks + 1;
  createSupervisorDecision({
    id: decisionId,
    session_id: sessionId,
    turn_index: turnIndex,
    started_at: nowIso(now),
    triggered_by: triggeredBy,
  });

  let parsed: ParsedDecision | null = null;
  let traceSummary = '';
  let errorMsg: string | null = null;

  try {
    const recent = await deps.getRecentMessages(session.chat_jid, 30);
    const boundLoop = session.bound_loop_run_id
      ? (await deps.getBoundLoopSummary?.(session.bound_loop_run_id)) ?? null
      : null;
    traceSummary = buildTraceSummary(recent, boundLoop);
    const prompt = buildDecisionPrompt(session, recent, boundLoop);
    const raw = await deps.sdkQuery(prompt, {
      maxTurns: 1,
      systemPrompt: '',
      model: process.env.SUPERVISOR_MODEL || undefined,
      trace: { chatJid: session.chat_jid, label: 'Supervisor Decision' },
    });
    const text =
      typeof raw === 'string'
        ? raw
        : (raw as any)?.text ?? (raw as any)?.content ?? JSON.stringify(raw ?? '');
    parsed = parseSupervisorDecision(text);
    if (!parsed) {
      errorMsg = `Failed to parse supervisor decision: ${String(text).slice(0, 500)}`;
    }
  } catch (err) {
    errorMsg = (err as Error).message;
    logger.error({ err, sessionId }, 'Supervisor check failed');
  }

  const endedAt = nowIso((deps.now?.() ?? Date.now()));
  const action: SupervisorDecisionRow['action'] = parsed ? parsed.action : 'error';
  const evidenceJson = parsed && parsed.evidence.length
    ? JSON.stringify(parsed.evidence)
    : null;

  finalizeSupervisorDecision(decisionId, {
    action,
    conclusion: parsed?.conclusion ?? null,
    evidence_json: evidenceJson,
    next_action_hint: parsed?.next_action_hint ? parsed.next_action_hint : null,
    confidence: parsed?.confidence ?? null,
    trace_summary: traceSummary || null,
    status: action === 'error' ? 'error' : 'completed',
    ended_at: endedAt,
    error: errorMsg,
  });

  // Update session bookkeeping.
  const sessionUpdates: Partial<SupervisorSessionRow> = {
    current_checks: turnIndex,
    last_check_at: endedAt,
    consecutive_errors: parsed ? 0 : session.consecutive_errors + 1,
  };
  let fedBack = false;

  if (parsed) {
    // next_check_at: periodic/hybrid → now + period; on_iteration → defer (poll loop progress)
    if (session.strategy === 'on_iteration') {
      sessionUpdates.next_check_at = nowIso(
        (deps.now?.() ?? Date.now()) + session.period_ms * 2,
      );
    } else {
      sessionUpdates.next_check_at = nowIso(
        (deps.now?.() ?? Date.now()) + session.period_ms,
      );
    }

    // Side effects by action.
    if (parsed.action === 'redirect' || parsed.action === 'escalate') {
      // Autonomous mode bypass: when the chat is in 全托管 mode, escalate
      // (which normally stores a prompt message asking the user) is suppressed
      // — agent-runner's end-of-turn auto-continue handles continuation, and
      // we emit an autonomous.brake_triggered event for observability. The
      // user is never prompted mid-task.
      let autonomousChat = false;
      try {
        autonomousChat = deps.isAutonomousChat
          ? await deps.isAutonomousChat(session.chat_jid)
          : false;
      } catch {
        // best-effort
      }
      if (autonomousChat && parsed.action === 'escalate') {
        logger.warn(
          { sessionId, chatJid: session.chat_jid, conclusion: parsed.conclusion },
          'Supervisor escalate suppressed in autonomous mode (no user prompt)',
        );
        try {
          deps.emitAutonomyEvent?.({
            type: 'autonomous.brake_triggered',
            capability: 'execution',
            chatJid: session.chat_jid,
            sessionId,
            reason: 'supervisor_escalate',
            conclusion: parsed.conclusion,
          });
        } catch {
          // best-effort
        }
        // Do NOT store prompt message, do NOT enqueue. Fall through to next
        // check scheduling — agent-runner is responsible for continuation.
      } else {
        const prefix =
          parsed.action === 'escalate' ? '【Supervisor 提问】' : '【Supervisor 指令】';
        const text = `${prefix}${parsed.conclusion}${parsed.next_action_hint ? `\n${parsed.next_action_hint}` : ''}`;
        try {
          await deps.storePromptMessage(
            session.chat_jid,
            '__supervisor__',
            'Supervisor',
            text,
          );
          await deps.enqueueMessageCheck(session.chat_jid);
          fedBack = true;
        } catch (err) {
          logger.error({ err, sessionId }, 'Supervisor feed-back failed');
        }
      }
    } else if (parsed.action === 'complete') {
      sessionUpdates.status = 'completed';
      sessionUpdates.ended_at = endedAt;
      sessionUpdates.next_check_at = null;
      await deps.notifyUser?.(
        session.chat_jid,
        `Supervisor 判定目标已达成：${parsed.conclusion}。监督结束。`,
      );
    } else if (parsed.action === 'abort') {
      sessionUpdates.status = 'aborted';
      sessionUpdates.ended_at = endedAt;
      sessionUpdates.next_check_at = null;
      await deps.notifyUser?.(
        session.chat_jid,
        `Supervisor 判定无法继续：${parsed.conclusion}。请人工介入。`,
      );
    }
  } else {
    // parse/eval failed — keep next_check_at advancing so we retry next tick.
    sessionUpdates.next_check_at = nowIso(
      (deps.now?.() ?? Date.now()) + session.period_ms,
    );
    if (session.consecutive_errors + 1 >= SUPERVISOR_MAX_CONSECUTIVE_ERRORS) {
      sessionUpdates.status = 'failed';
      sessionUpdates.ended_at = endedAt;
      sessionUpdates.next_check_at = null;
      await deps.notifyUser?.(
        session.chat_jid,
        `Supervisor 连续 ${SUPERVISOR_MAX_CONSECUTIVE_ERRORS} 次评估失败，已熔断。请人工检查。`,
      );
    }
  }

  updateSupervisorSession(sessionId, sessionUpdates);

  const fresh = getSupervisorSession(sessionId)!;
  const freshDecision = getLatestSupervisorDecision(sessionId)!;
  return { decision: freshDecision, session: fresh, fedBack };
}

function buildTraceSummary(
  recent: RecentMessageLite[],
  boundLoop: BoundLoopSummary | null,
): string {
  const parts: string[] = [];
  parts.push(`recent_messages=${recent.length}`);
  if (boundLoop) {
    parts.push(
      `loop=${boundLoop.status} turn=${boundLoop.current_turn}/${boundLoop.max_turns} review=${boundLoop.last_review_result ?? 'n/a'}`,
    );
  }
  return parts.join(' | ');
}

// ---------------------------------------------------------------------------
// Tick loop + boot recovery (in-process, mirrors startSchedulerLoop)
// ---------------------------------------------------------------------------

const activeSupervisorChecks = new Set<string>();
let tickTimer: NodeJS.Timeout | null = null;
let tickRunning = false;

export function startSupervisorLoop(
  deps: SupervisorCheckDeps,
  opts: { tickMs?: number } = {},
): void {
  if (tickTimer) {
    return; // already running
  }
  const envTick = Number(process.env.SUPERVISOR_TICK_MS);
  const interval =
    opts.tickMs ??
    (Number.isFinite(envTick) && envTick > 0
      ? envTick
      : SUPERVISOR_TICK_MS_DEFAULT);  tickTimer = setInterval(() => {
    void runSupervisorTick(deps).catch((err) => {
      logger.error({ err }, 'Supervisor tick loop crashed');
    });
  }, interval);
  // Do not keep the event loop alive solely for the supervisor tick — the
  // backend process has other keep-alive handles (IM pools, scheduler loop).
  if (typeof tickTimer.unref === 'function') tickTimer.unref();
  logger.info({ tickMs: interval }, 'Supervisor loop started');
}

export function stopSupervisorLoop(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  activeSupervisorChecks.clear();
  tickRunning = false;
  logger.info('Supervisor loop stopped');
}

export async function runSupervisorTick(
  deps: SupervisorCheckDeps,
): Promise<{ checked: number; recovered: number }> {
  if (tickRunning) return { checked: 0, recovered: 0 };
  tickRunning = true;
  try {
    const nowMs = (deps.now?.() ?? Date.now());
    const now = nowIso(nowMs);

    // 1. Heartbeat-timeout recovery: sessions whose last_check_at is stale beyond
    //    3x their period. Force a recovery check (only if not already running).
    let recovered = 0;
    const stale = listStaleHeartbeatSupervisorSessions(nowMs);
    for (const s of stale) {
      if (activeSupervisorChecks.has(s.id)) continue;
      recovered++;
      activeSupervisorChecks.add(s.id);
      try {
        await runSupervisionCheck(s.id, deps, 'recovery');
      } finally {
        activeSupervisorChecks.delete(s.id);
      }
    }

    // 2. Due sessions: next_check_at <= now.
    let checked = 0;
    const due = listDueSupervisorSessions(now);
    for (const s of due) {
      if (activeSupervisorChecks.has(s.id)) continue;
      // on_iteration: only fire if the bound loop has advanced a turn since the
      // last check. Polled discovery — no cross-module event wiring.
      if (s.strategy === 'on_iteration' && s.bound_loop_run_id) {
        const advanced = hasBoundLoopAdvanced(s);
        if (!advanced) {
          // re-arm to avoid busy-looping until the next period.
          updateSupervisorSession(s.id, {
            next_check_at: nowIso(nowMs + s.period_ms),
          });
          continue;
        }
      }
      activeSupervisorChecks.add(s.id);
      checked++;
      try {
        await runSupervisionCheck(s.id, deps, 'tick');
      } finally {
        activeSupervisorChecks.delete(s.id);
      }
    }
    return { checked, recovered };
  } finally {
    tickRunning = false;
  }
}

function hasBoundLoopAdvanced(session: SupervisorSessionRow): boolean {
  if (!session.bound_loop_run_id) return false;
  const run = getLoopRun(session.bound_loop_run_id);
  if (!run) return false;
  // Terminal loop → fire a final check so the supervisor can rule on outcome.
  if (isTerminalStatus(run.status)) return true;
  return run.current_turn > session.last_bound_turn;
}

/**
 * Boot-time recovery. Call once after startSupervisorLoop. Mirrors the
 * task-scheduler boot recovery: flip stale 'running' decisions to 'error', then
 * re-arm active sessions whose next_check_at has passed (or is null).
 */
export async function bootRecoverSupervisor(
  deps: SupervisorCheckDeps,
): Promise<{ staleFlipped: number; reArmed: number }> {
  const staleFlipped = cleanupStaleSupervisorChecks();
  // Re-arm: active sessions with no next_check_at or an overdue one.
  const active = listSupervisorSessions(null, { status: 'active' });
  let reArmed = 0;
  const nowMs = deps.now?.() ?? Date.now();
  for (const s of active) {
    if (!s.next_check_at || Date.parse(s.next_check_at) <= nowMs) {
      updateSupervisorSession(s.id, { next_check_at: nowIso(nowMs) });
      reArmed++;
    }
  }
  if (staleFlipped > 0 || reArmed > 0) {
    logger.info(
      { staleFlipped, reArmed },
      'Supervisor boot recovery completed',
    );
  }
  return { staleFlipped, reArmed };
}

export function isSupervisorLoopRunning(): boolean {
  return tickTimer !== null;
}

export function isCheckInFlight(sessionId: string): boolean {
  return activeSupervisorChecks.has(sessionId);
}
