/**
 * Graph Orchestrator — top-level execution loop + control API.
 *
 * executeGraph(): mark run running → loop { derive ready batch (scheduler) →
 * run nodes in parallel (runner) → merge state patches, record branch
 * decisions → persist state checkpoint → check pause/cancel } until all nodes
 * completed or run fails/cancelled.
 *
 * Resume: reconstructs the completed-set and branch decisions from
 * graph_node_runs + state_json, then re-enters the loop — skipping already-
 * completed nodes (AC3.4).
 *
 * Control API: pauseGraphRun / resumeGraphRun / cancelGraphRun / rerunGraphNode.
 *
 * See SOLUTION.md §4/§6.
 */

import crypto from 'node:crypto';

import {
  createGraphRun,
  getCompletedGraphNodeIds,
  getGraphDefinition,
  getGraphRun,
  getGraphRunUsage,
  getLatestGraphNodeRun,
  listGraphNodeRuns,
  resetGraphNodeAndDownstream,
  updateGraphNodeRun,
  updateGraphRunState,
  updateGraphRunStatus,
} from '../db.js';
import { logger } from '../logger.js';
import { emitAutonomyEvent } from '../autonomy/autonomy-bus.js';
import {
  allCompleted,
  branchEdgeCoverage,
  computeReadyNodes,
  downstreamNodeIds,
  nextReadyBatch,
  takenEdges,
} from './graph-scheduler.js';
import {
  deserializeDefinition,
  loadLatestDefinition,
  computeManifestHash,
} from './graph-registry.js';
import { runGraphNode, type GraphDeps, type GraphRunContext } from './graph-runner.js';
import { buildEvalContext } from './graph-expr.js';
import {
  graphStartEvent,
  graphNodeStartEvent,
  graphNodeEndEvent,
  graphEdgeTakenEvent,
  graphEndEvent,
} from './graph-events.js';
import type { StreamEvent } from '../stream-event.types.js';
import type { GraphDefinition, GraphNode, GraphState, NodeRunOutcome } from './graph-types.js';

const BRANCH_STATE_PREFIX = '__branch_';
const GATE_FEEDBACK_PREFIX = 'gate_feedback_';
const GATE_RETRY_MAX = 2;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 5000;
const POLL_INTERVAL_MS = 1000;

/** Build a GraphRunContext from a persisted graph_run row + its locked definition. */
export async function buildRunContext(
  runId: string,
  deps: GraphDeps,
): Promise<{ ctx: GraphRunContext; definition: GraphDefinition } | null> {
  const run = getGraphRun(runId);
  if (!run) return null;
  const defRow = getGraphDefinition(run.definition_id, run.definition_version);
  if (!defRow) {
    logger.error({ runId, defId: run.definition_id, ver: run.definition_version },
      'Graph definition version missing — cannot resume');
    return null;
  }
  const definition = deserializeDefinition(defRow);
  // DSL v2: detect version drift on resume. The run captured the definition's
  // manifest_hash at start; if the definition row's hash now differs (e.g. the
  // row was mutated out-of-band), refuse resume so the caller reruns from
  // scratch rather than replaying a half-changed graph. Defense-in-depth on
  // top of the immutable (id, version) append-only versioning. Old runs
  // (pre-v55, manifest_hash null) skip the check — backward compatible.
  if (run.manifest_hash && defRow.manifest_hash && run.manifest_hash !== defRow.manifest_hash) {
    logger.error(
      { runId, stored: run.manifest_hash, computed: defRow.manifest_hash },
      'Graph definition manifest hash mismatch — refusing resume',
    );
    return null;
  }
  const ctx: GraphRunContext = {
    graphRunId: run.id,
    ownerUserId: run.owner_user_id,
    groupFolder: run.group_folder,
    chatJid: run.chat_jid,
    definition,
    state: JSON.parse(run.state_json || '{}') as GraphState,
    maxParallel: run.max_parallel,
  };
  return { ctx, definition };
}

/** Reconstruct branch decisions from persisted state (resume support). */
function reconstructBranchDecisions(state: GraphState): Map<string, string> {
  const decisions = new Map<string, string>();
  for (const [k, v] of Object.entries(state)) {
    if (k.startsWith(BRANCH_STATE_PREFIX)) {
      decisions.set(k.slice(BRANCH_STATE_PREFIX.length), String(v));
    }
  }
  return decisions;
}

/** Run a single node with retry policy (maxAttempts + exponential backoff). */
async function runNodeWithRetry(
  ctx: GraphRunContext,
  deps: GraphDeps,
  node: GraphNode,
  parentNodeRunId: string | null,
): Promise<NodeRunOutcome> {
  const maxAttempts = node.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoff = node.backoffMs ?? DEFAULT_BACKOFF_MS;
  let lastOutcome: NodeRunOutcome = {
    status: 'failed', output: '', inputTokens: 0, outputTokens: 0, costUsd: 0,
  };
  const nodeStartedAt = Date.now();
  // DSL v2: emit a node-start event so the frontend can light the node running
  // the moment the runner picks it up (before the attempt loop).
  try {
    deps.broadcastStreamEvent?.(ctx.chatJid, graphNodeStartEvent(ctx.graphRunId, node));
  } catch { /* never block control flow */ }
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Re-check run status between attempts (pause/cancel).
    const run = getGraphRun(ctx.graphRunId);
    if (run?.status === 'cancelled') return { ...lastOutcome, status: 'skipped' };
    if (run?.status === 'paused') return { ...lastOutcome, status: 'paused' };

    lastOutcome = await runGraphNode(ctx, deps, node, parentNodeRunId);
    if (lastOutcome.status === 'completed') {
      try {
        deps.broadcastStreamEvent?.(
          ctx.chatJid,
          graphNodeEndEvent(ctx.graphRunId, node, 'completed', {
            tokens: lastOutcome.inputTokens + lastOutcome.outputTokens,
            costUsd: lastOutcome.costUsd,
            durationMs: Date.now() - nodeStartedAt,
            output: lastOutcome.output,
          }),
        );
      } catch { /* ignore */ }
      return lastOutcome;
    }
    if (lastOutcome.status === 'paused') return lastOutcome; // human node
    if (lastOutcome.status === 'skipped') return lastOutcome;
    // failed → retry with backoff (unless last attempt)
    if (attempt < maxAttempts - 1) {
      logger.warn({ graphRunId: ctx.graphRunId, nodeId: node.id, attempt },
        'Node failed, retrying after backoff');
      await sleep(backoff * Math.pow(2, attempt));
    }
  }
  // All attempts exhausted → emit a node-end failed event.
  try {
    deps.broadcastStreamEvent?.(
      ctx.chatJid,
      graphNodeEndEvent(ctx.graphRunId, node, 'failed', {
        durationMs: Date.now() - nodeStartedAt,
        error: lastOutcome.error,
      }),
    );
  } catch { /* ignore */ }
  return lastOutcome;
}

/** Merge a node's state patch into the shared state. */
function mergeStatePatch(state: GraphState, patch: NodeRunOutcome['statePatch']): void {
  if (!patch) return;
  for (const [k, v] of Object.entries(patch)) state[k] = v;
}

/** Persist the current shared state back to graph_runs.state_json. */
function persistState(runId: string, state: GraphState): void {
  updateGraphRunState(runId, JSON.stringify(state));
}

/**
 * Execute a graph run to completion (or until paused/cancelled/failed).
 * Idempotent on resume: skips nodes already in 'completed'.
 */
function emitExecutionOutcome(ctx: GraphRunContext, success: boolean, reason?: string): void {
  // Autonomy Layer instrumentation — side-effect only, never breaks control flow.
  // See docs/tech_solution/autonomy-system/SOLUTION.md §4 (execution success rate).
  emitAutonomyEvent({
    capability: 'execution',
    domain: ctx.graphRunId,
    type: 'execution.completed',
    payload: { success, definition_id: ctx.definition.id, reason },
    ts: Date.now(),
    graphRunId: ctx.graphRunId,
  });
}

export async function executeGraph(ctx: GraphRunContext, deps: GraphDeps): Promise<void> {
  const def = ctx.definition;
  const coverageErrors = branchEdgeCoverage(def);
  if (coverageErrors.length) {
    logger.warn({ errors: coverageErrors }, 'Graph branch edge coverage warnings');
  }

  /** Broadcast a graph_* event over WebSocket (never throws). */
  const broadcast = (ev: StreamEvent) => {
    try {
      deps.broadcastStreamEvent?.(ctx.chatJid, ev);
    } catch (err) {
      logger.error({ err, graphRunId: ctx.graphRunId }, 'graph event broadcast failed');
    }
  };

  updateGraphRunStatus(ctx.graphRunId, 'running');
  logger.info({ graphRunId: ctx.graphRunId, defId: def.id }, 'Graph run started');
  broadcast(graphStartEvent(ctx.graphRunId, def.id, def.nodes.length));

  const runStartedAt = Date.now();

  // Resume: rebuild completed-set + branch decisions from persisted state.
  const completed = getCompletedGraphNodeIds(ctx.graphRunId);
  const branchDecisions = reconstructBranchDecisions(ctx.state);
  // F6: per-gate retry counter for gate-failure auto-resume. A gate failure
  // re-runs its upstream agent node with the failure evidence injected (not the
  // gate itself — re-running a gate against unchanged output is pointless).
  // Up to GATE_RETRY_MAX re-runs before the run is marked failed.
  const gateRetryCount = new Map<string, number>();

  /** DSL v2: budget circuit breaker. Hard-fails the run when any budget limit
   *  (tokens / cost / duration) is exceeded. Returns an error reason or null. */
  const budgetBreached = (): string | null => {
    if (!def.budget) return null;
    if (def.budget.maxDurationMs) {
      if (Date.now() - runStartedAt > def.budget.maxDurationMs) {
        return `budget exceeded: duration > ${def.budget.maxDurationMs}ms`;
      }
    }
    if (def.budget.maxTokens || def.budget.maxCostUsd) {
      const usage = getGraphRunUsage(ctx.graphRunId);
      if (def.budget.maxTokens && usage.totalTokens > def.budget.maxTokens) {
        return `budget exceeded: tokens ${usage.totalTokens} > ${def.budget.maxTokens}`;
      }
      if (def.budget.maxCostUsd && usage.totalCostUsd > def.budget.maxCostUsd) {
        return `budget exceeded: cost $${usage.totalCostUsd.toFixed(4)} > $${def.budget.maxCostUsd}`;
      }
    }
    return null;
  };

  try {
    while (true) {
      const run = getGraphRun(ctx.graphRunId);
      if (run?.status === 'cancelled') {
        logger.info({ graphRunId: ctx.graphRunId }, 'Graph cancelled by user');
        broadcast(graphEndEvent(ctx.graphRunId, 'cancelled'));
        return;
      }
      if (run?.status === 'paused') {
        logger.info({ graphRunId: ctx.graphRunId }, 'Graph paused — awaiting resume');
        return;
      }

      // DSL v2: budget circuit breaker — checked every loop iteration so a
      // long run is failed promptly when the ceiling is crossed.
      const breach = budgetBreached();
      if (breach) {
        persistState(ctx.graphRunId, ctx.state);
        updateGraphRunStatus(ctx.graphRunId, 'failed', {
          endedAt: new Date().toISOString(),
          cancelReason: breach,
        });
        logger.error({ graphRunId: ctx.graphRunId, breach }, 'Graph run failed — budget exceeded');
        broadcast(graphEndEvent(ctx.graphRunId, 'failed', { error: breach }));
        emitExecutionOutcome(ctx, false, breach);
        return;
      }

      if (allCompleted(def, completed)) {
        updateGraphRunStatus(ctx.graphRunId, 'completed', { endedAt: new Date().toISOString() });
        logger.info({ graphRunId: ctx.graphRunId }, 'Graph run completed');
        // graph_end totals are telemetry — never let a usage-read failure crash
        // the run after it's already marked completed. Tolerate missing impl
        // (e.g. tests that mock db without getGraphRunUsage).
        let endTotals: { totalTokens?: number; totalCostUsd?: number; durationMs?: number } = {};
        try {
          const usage = getGraphRunUsage(ctx.graphRunId);
          endTotals = {
            totalTokens: usage.totalTokens,
            totalCostUsd: usage.totalCostUsd,
            durationMs: Date.now() - runStartedAt,
          };
        } catch { /* tolerate */ }
        broadcast(graphEndEvent(ctx.graphRunId, 'completed', endTotals));
        emitExecutionOutcome(ctx, true);
        return;
      }

      // DSL v2: build an EvalContext from the live state so expression/default
      // edges route on current node outputs + branch decisions.
      const evalCtx = buildEvalContext(ctx.state);
      const ready = computeReadyNodes(def, completed, branchDecisions, evalCtx);
      if (ready.length === 0) {
        // No ready nodes but not all completed → deadlock or waiting on paused.
        const anyRunning = listGraphNodeRuns(ctx.graphRunId).some(
          (n) => n.status === 'running',
        );
        if (!anyRunning) {
          updateGraphRunStatus(ctx.graphRunId, 'failed', {
            endedAt: new Date().toISOString(),
            cancelReason: 'deadlock: no ready nodes and none running',
          });
          logger.error({ graphRunId: ctx.graphRunId }, 'Graph deadlocked');
          broadcast(graphEndEvent(ctx.graphRunId, 'failed', { error: 'deadlock' }));
          emitExecutionOutcome(ctx, false, 'deadlock');
          return;
        }
        // Something still running — wait for it to settle.
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      // P0: self-limit to maxParallel. The true global ceiling
      // (MAX_CONCURRENT_CONTAINERS / HOST_PROCESSES) is enforced downstream by
      // runHostAgent/runContainerAgent + GroupQueue; the per-run ceiling is
      // maxParallel (awaited per batch, so in-flight is bounded by batch size).
      const batch = nextReadyBatch(ready, ctx.maxParallel, ctx.maxParallel);
      updateGraphRunStatus(ctx.graphRunId, 'running', {
        currentNodeId: batch[0]?.id ?? null,
      });

      // Fan-out: run the batch concurrently. runNodeWithRetry emits
      // graph_node_start / graph_node_end events around each node.
      const results = await Promise.all(
        batch.map((node) => runNodeWithRetry(ctx, deps, node, null)),
      );

      for (let i = 0; i < batch.length; i++) {
        const node = batch[i];
        const outcome = results[i];
        if (outcome.status === 'completed') {
          completed.add(node.id);
          mergeStatePatch(ctx.state, outcome.statePatch);
          // Branch: record the chosen condition so computeReadyNodes activates
          // only the matching outgoing conditional edge.
          if (node.type === 'branch' && outcome.branchResult) {
            ctx.state[`${BRANCH_STATE_PREFIX}${node.id}`] = outcome.branchResult;
            branchDecisions.set(node.id, outcome.branchResult);
          }
        } else if (outcome.status === 'paused') {
          // human node — pause the whole run and surface an approval card.
          updateGraphRunStatus(ctx.graphRunId, 'paused', {
            currentNodeId: node.id,
            endedAt: new Date().toISOString(),
          });
          persistState(ctx.graphRunId, ctx.state);
          if (node.type === 'human') {
            await surfaceHumanApproval(ctx, deps, node);
          }
          logger.info({ graphRunId: ctx.graphRunId, nodeId: node.id }, 'Graph paused at human node');
          return;
        } else {
          // failed (skipped from cancel also lands here)
          // F6: gate failure auto-resume. A gate failing against its upstream
          // agent's output means the upstream work didn't meet the gate's
          // behavioral evidence / assertions. Instead of failing the whole run
          // on the first gate miss, reset the upstream agent node to re-run with
          // the failure evidence injected as feedback, up to GATE_RETRY_MAX.
          // Re-running the gate node itself would be pointless — it asserts
          // against the same unchanged output. See SOLUTION.md §4.2 (AC6.1).
          if (node.type === 'gate' && node.upstreamNodeId) {
            const tries = (gateRetryCount.get(node.id) ?? 0) + 1;
            gateRetryCount.set(node.id, tries);
            if (tries < GATE_RETRY_MAX) {
              const feedback = outcome.error ?? outcome.output ?? 'gate 失败（无详情）';
              ctx.state[`${GATE_FEEDBACK_PREFIX}${node.upstreamNodeId}`] =
                `【上游 Gate "${node.title}" 第 ${tries} 次评审失败,请据此修正后重做】\n${feedback}`;
              completed.delete(node.upstreamNodeId);
              persistState(ctx.graphRunId, ctx.state);
              logger.warn(
                { graphRunId: ctx.graphRunId, gateId: node.id, upstreamId: node.upstreamNodeId, tries },
                'Gate failed — resetting upstream agent node for re-run with feedback',
              );
              continue;
            }
            logger.error(
              { graphRunId: ctx.graphRunId, gateId: node.id, tries },
              'Gate failed — GATE_RETRY_MAX exhausted, failing run',
            );
          }
          // persistState hardcodes status='running', so it MUST run before the
          // terminal 'failed' write — otherwise it clobbers 'failed' back to
          // 'running' (pre-existing latent bug in this exact path; surfaced by
          // F6 AC6.1.2 which asserts the terminal status persists).
          persistState(ctx.graphRunId, ctx.state);
          updateGraphRunStatus(ctx.graphRunId, 'failed', {
            endedAt: new Date().toISOString(),
            cancelReason: `node ${node.id} failed: ${outcome.error ?? 'unknown'}`,
          });
          logger.error({ graphRunId: ctx.graphRunId, nodeId: node.id, err: outcome.error },
            'Graph run failed at node');
          broadcast(
            graphEndEvent(ctx.graphRunId, 'failed', {
              error: `node ${node.id} failed: ${outcome.error ?? 'unknown'}`,
            }),
          );
          emitExecutionOutcome(ctx, false, `node ${node.id} failed`);
          return;
        }
      }
      // DSL v2: emit edge_taken events for the conditional / default edges
      // activated by the nodes that just completed (for the data-flow view).
      const justCompleted = batch.filter((n) => completed.has(n.id));
      for (const edge of takenEdges(def, justCompleted, completed, branchDecisions, evalCtx)) {
        if (edge.condition || edge.expression || edge.isDefault) {
          broadcast(
            graphEdgeTakenEvent(
              ctx.graphRunId,
              edge.from,
              edge.to,
              edge.id,
              edge.expression ?? edge.condition ?? (edge.isDefault ? 'default' : undefined),
            ),
          );
        }
      }
      persistState(ctx.graphRunId, ctx.state);
    }
  } catch (err) {
    const errMsg = (err as Error).message?.slice(0, 500) || 'Unknown error';
    logger.error({ err: errMsg, graphRunId: ctx.graphRunId }, 'Graph orchestrator crashed');
    updateGraphRunStatus(ctx.graphRunId, 'failed', {
      endedAt: new Date().toISOString(),
      cancelReason: `orchestrator crash: ${errMsg}`,
    });
    persistState(ctx.graphRunId, ctx.state);
    broadcast(graphEndEvent(ctx.graphRunId, 'failed', { error: `orchestrator crash: ${errMsg}` }));
    emitExecutionOutcome(ctx, false, `orchestrator crash: ${errMsg}`);
  }
}

/** Pause a running graph (takes effect at the next node boundary). */
export function pauseGraphRun(runId: string): void {
  updateGraphRunStatus(runId, 'paused');
}

/** Cancel a running graph (takes effect at the next node boundary). */
export function cancelGraphRun(runId: string, reason: string): void {
  updateGraphRunStatus(runId, 'cancelled', {
    endedAt: new Date().toISOString(),
    cancelReason: reason,
  });
}

/** Reset a node (and downstream) to pending so the scheduler re-runs them. */
export function rerunGraphNode(runId: string, nodeId: string): number {
  return resetGraphNodeAndDownstream(runId, nodeId);
}

/** Start a graph run from a registered definition. Returns the new run id. */
export function startGraphRun(opts: {
  definitionId: string;
  ownerUserId: string;
  groupFolder: string;
  chatJid: string;
  goalText?: string;
  maxParallel?: number;
  initialState?: GraphState;
}): { runId: string; definition: GraphDefinition } | { error: string } {
  const def = loadLatestDefinition(opts.definitionId);
  if (!def) return { error: `definition not found: ${opts.definitionId}` };
  const runId = `graph-${crypto.randomUUID()}`;
  createGraphRun({
    id: runId,
    definition_id: def.id,
    definition_version: def.version,
    owner_user_id: opts.ownerUserId,
    group_folder: opts.groupFolder,
    chat_jid: opts.chatJid,
    goal_text: opts.goalText ?? null,
    max_parallel: opts.maxParallel ?? 4,
    state_json: JSON.stringify(opts.initialState ?? {}),
    manifest_hash: computeManifestHash(def),
    started_at: new Date().toISOString(),
  });
  return { runId, definition: def };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const DEFAULT_APPROVAL_OPTIONS = [
  { label: '批准', value: 'approve' },
  { label: '拒绝', value: 'reject' },
];

/**
 * P1: surface a human approval node's decision card to the DeepThink chat.
 * Persists an 'approval' attachment message (durable + WS new_message push) and
 * broadcasts a human_approval_request stream event. Called when a human node
 * pauses the run. No-op if storeApprovalCard is not wired (e.g. unit tests).
 */
async function surfaceHumanApproval(
  ctx: GraphRunContext,
  deps: GraphDeps,
  node: GraphNode,
): Promise<void> {
  const options = node.approvalOptions?.length ? node.approvalOptions : DEFAULT_APPROVAL_OPTIONS;
  const question = node.approvalPrompt ?? node.title ?? '请审批是否继续';
  const stateKey = node.approvalStateKey ?? `node_${node.id}_approval`;
  const payload = {
    runId: ctx.graphRunId,
    nodeId: node.id,
    title: node.title ?? node.id,
    question,
    options,
    stateKey,
  };
  try {
    await deps.storeApprovalCard?.(ctx.chatJid, payload);
  } catch (err) {
    logger.error({ err, graphRunId: ctx.graphRunId, nodeId: node.id }, 'storeApprovalCard failed');
  }
  try {
    deps.broadcastStreamEvent?.(ctx.chatJid, {
      eventType: 'human_approval_request',
      displayLevel: 'primary',
      agentScope: 'system',
      traceNode: {
        nodeId: 0,
        nodeType: 'subagent',
        graphRunId: ctx.graphRunId,
        graphNodeId: node.id,
        title: node.title,
      },
      approvalRequest: payload,
    });
  } catch (err) {
    logger.error({ err, graphRunId: ctx.graphRunId, nodeId: node.id }, 'broadcast approval failed');
  }
}

/**
 * P1: submit an approval decision for a paused human node. Marks the node run
 * completed, writes the chosen option + note into state (so downstream nodes
 * can read it via state[approvalStateKey]), and leaves the run paused for the
 * caller (routes/graph.ts) to resume. Returns the state key the decision was
 * written under, or an error.
 */
export function approveHumanNode(
  runId: string,
  nodeId: string,
  optionId: string,
  note?: string,
): { ok: true; stateKey: string } | { ok: false; error: string } {
  const run = getGraphRun(runId);
  if (!run) return { ok: false, error: 'Graph run not found' };
  if (run.status !== 'paused') return { ok: false, error: `Run not paused (status=${run.status})` };
  const defRow = getGraphDefinition(run.definition_id, run.definition_version);
  if (!defRow) return { ok: false, error: 'Graph definition version missing' };
  const def = deserializeDefinition(defRow);
  const node = def.nodes.find((n) => n.id === nodeId);
  if (!node || node.type !== 'human') return { ok: false, error: 'Not a human node' };

  const nodeRun = getLatestGraphNodeRun(runId, nodeId);
  if (!nodeRun || nodeRun.node_type !== 'human') return { ok: false, error: 'Human node run not found' };
  if (nodeRun.status !== 'paused') return { ok: false, error: `Human node not paused (status=${nodeRun.status})` };

  const stateKey = node.approvalStateKey ?? `node_${nodeId}_approval`;
  const statePatch: GraphState = {
    [stateKey]: optionId,
    [`${stateKey}__note`]: note ?? '',
  };

  updateGraphNodeRun(nodeRun.id, {
    status: 'completed',
    output_summary: JSON.stringify({ optionId, note: note ?? '' }),
    state_patch_json: JSON.stringify(statePatch),
    ended_at: new Date().toISOString(),
  });

  // Merge the decision into the run's persisted state so resume sees it.
  const merged: GraphState = { ...JSON.parse(run.state_json || '{}') as GraphState, ...statePatch };
  updateGraphRunStatus(runId, 'paused', { stateJson: JSON.stringify(merged) });

  logger.info({ runId, nodeId, optionId }, 'Human node approved — ready to resume');
  return { ok: true, stateKey };
}
