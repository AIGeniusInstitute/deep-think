/**
 * Graph Runner — executes a single graph node.
 *
 * Dispatches by node type:
 *  - agent: calls runHostAgent/runContainerAgent (mirrors loop-orchestrator
 *           runOneIteration, but the prompt comes from the node, not a loop hint)
 *  - gate:  calls the reviewer (lightweightSdkQuery + parseReviewResult) — pass
 *           = completed, fail = failed
 *  - branch: evaluates the node's branchKey against the shared state to decide
 *           which outgoing conditional edge to activate
 *  - join:   pass-through (the scheduler only activates a join once all
 *           predecessors are completed; the node itself is a no-op marker)
 *  - human:  P0 placeholder — pauses the run (full HITL + IM approval in P1)
 *
 * Each node run creates a graph_node_runs checkpoint row BEFORE execution
 * (status=running) and updates it after (status=completed/failed/paused), so a
 * crash never leaves the run in an un-resumable state. See SOLUTION.md §3/§6.
 */

import type { ChildProcess } from 'child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  addGraphRunUsage,
  acquireNodeLock,
  createGraphNodeRun,
  releaseNodeLock,
  updateGraphNodeRun,
} from '../db.js';
import { logger } from '../logger.js';
import { sdkQuery as lightweightSdkQuery } from '../sdk-query.js';
import {
  runContainerAgent,
  runHostAgent,
  type ContainerInput,
  type ContainerOutput,
} from '../container-runner.js';
import { parseReviewResult } from '../loop-orchestrator.js';
import { persistTraceNodeFromStreamEvent } from '../chat-trace-persist.js';
import { runScript } from '../script-runner.js';
import { scoreAssertion } from '../harness-eval.js';
import type { ExecutionMode, RegisteredGroup } from '../types.js';
import type { StreamEvent } from '../stream-event.types.js';
import { buildEvalContext, resolveExpr, resolveValue } from './graph-expr.js';
import type {
  GraphAssertion,
  GraphDefinition,
  GraphNode,
  GraphState,
  NodeRunOutcome,
  StatePatch,
} from './graph-types.js';

const GATE_REVIEW_TIMEOUT_MS = 120_000;

/** Context for a single graph run (mirrors LoopRunContext shape). */
export interface GraphRunContext {
  graphRunId: string;
  ownerUserId: string;
  groupFolder: string;
  chatJid: string;
  definition: GraphDefinition;
  state: GraphState;
  maxParallel: number;
  userLanguage?: string;
}

/** Dependencies injected from the host process (mirrors LoopDeps). */
export interface GraphDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string | null,
    groupFolder: string,
    displayName?: string,
    taskRunId?: string,
    selectedProviderId?: string | null,
  ) => void;
  broadcastStreamEvent?: (chatJid: string, event: StreamEvent) => void;
  storeResultAndNotify?: (
    chatJid: string,
    text: string,
    options: {
      ownerId?: string;
      notifyChannels?: string[] | null;
      sourceKind?: ContainerOutput['sourceKind'];
      skipStore?: boolean;
      workspaceFolder?: string;
    },
  ) => Promise<void>;
  /**
   * Super Agent Team P1: persist an approval card as a chat message (with an
   * 'approval' attachment) + push it via new_message so the DeepThink chat
   * renders a button form. Called by the orchestrator when a human node
   * pauses the run. See routes/graph.ts approve endpoint for the submit path.
   */
  storeApprovalCard?: (
    chatJid: string,
    payload: {
      runId: string;
      nodeId: string;
      title: string;
      question: string;
      options: { label: string; value: string }[];
      stateKey?: string;
    },
  ) => Promise<void>;
}

/** Resolve execution mode for the owner's home group (mirrors loop-orchestrator). */
function resolveExecutionMode(ctx: GraphRunContext, deps: GraphDeps): ExecutionMode {
  const groups = deps.registeredGroups();
  const homeGroup = Object.values(groups).find((g) => g.folder === ctx.groupFolder);
  if (homeGroup?.executionMode) return homeGroup.executionMode;
  return ctx.groupFolder === 'main' ? 'host' : 'container';
}

/** Build a synthetic RegisteredGroup for the owner folder (mirrors runOneIteration). */
function buildOwnerGroup(ctx: GraphRunContext, executionMode: ExecutionMode): RegisteredGroup {
  return {
    folder: ctx.groupFolder,
    chat_jid: ctx.chatJid,
    owner_user_id: ctx.ownerUserId,
    execution_mode: executionMode,
  } as unknown as RegisteredGroup;
}

/** Build the reviewer prompt for a gate node. */
function buildGatePrompt(node: GraphNode, agentOutput: string): string {
  const criteria = node.successCriteria ?? '由你根据节点目标判断是否达成';
  return [
    '你是一个严格的评审 Agent。请基于以下信息判定图节点是否达成目标。',
    '',
    '【节点目标】',
    node.title,
    '',
    '【成功标准】',
    criteria,
    '',
    '【节点产出】',
    agentOutput.slice(0, 8000),
    '',
    '请输出严格的 JSON（不要 markdown 代码块），格式：',
    '{"result":"pass"|"fail"|"needs_improvement","reason":"具体原因","suggestion":"改进方向"}',
  ].join('\n');
}

/**
 * Execute one node. Creates the checkpoint row, dispatches by type, persists
 * the outcome. Returns NodeRunOutcome for the scheduler to merge state patch
 * and advance the ready queue.
 */
export async function runGraphNode(
  ctx: GraphRunContext,
  deps: GraphDeps,
  node: GraphNode,
  parentNodeRunId: string | null,
): Promise<NodeRunOutcome> {
  const nodeRunId = `${ctx.graphRunId}:${node.id}:${Date.now()}`;
  const startedAt = new Date().toISOString();

  // Persist BEFORE execution (crash safety). Attempt counter incremented by
  // the scheduler on retry; here we just create the row at running.
  createGraphNodeRun({
    id: nodeRunId,
    graph_run_id: ctx.graphRunId,
    node_id: node.id,
    node_type: node.type,
    parent_node_run_id: parentNodeRunId,
    is_idempotent: !!node.isIdempotent,
    input_summary: JSON.stringify({ state: ctx.state }).slice(0, 2000),
  });

  // AC2.7: acquire a workspace lock for audit/observability. P0 runs nodes in
  // the owner group folder; parallel nodes are expected to write DISJOINT
  // artifacts (graph authors declare node outputs). File-level isolation is P1.
  const lockId = acquireNodeLock({
    graph_run_id: ctx.graphRunId,
    node_id: node.id,
    workspace_folder: ctx.groupFolder,
  });

  try {
    const outcome = await dispatchByType(ctx, deps, node);

    updateGraphNodeRun(nodeRunId, {
      status: outcome.status,
      output_summary: outcome.output.slice(0, 5000),
      state_patch_json: outcome.statePatch ? JSON.stringify(outcome.statePatch) : null,
      ended_at: new Date().toISOString(),
      input_tokens: outcome.inputTokens,
      output_tokens: outcome.outputTokens,
      cost_usd: outcome.costUsd,
      error: outcome.error ?? null,
    });
    addGraphRunUsage(ctx.graphRunId, outcome.inputTokens, outcome.outputTokens, outcome.costUsd);
    return outcome;
  } catch (err) {
    const errMsg = (err as Error).message?.slice(0, 500) || 'Unknown error';
    logger.error({ err: errMsg, graphRunId: ctx.graphRunId, nodeId: node.id }, 'Graph node failed');
    updateGraphNodeRun(nodeRunId, {
      status: 'failed',
      ended_at: new Date().toISOString(),
      error: errMsg,
    });
    return {
      status: 'failed',
      output: '',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      error: errMsg,
    };
  } finally {
    releaseNodeLock(lockId);
  }
}

/** Type-specific dispatch. Wraps execution in a per-node timeout when set. */
async function dispatchByType(
  ctx: GraphRunContext,
  deps: GraphDeps,
  node: GraphNode,
): Promise<NodeRunOutcome> {
  const exec = dispatchByTypeInner(ctx, deps, node);
  if (node.timeoutMs && node.timeoutMs > 0) {
    const timeout = new Promise<NodeRunOutcome>((resolve) =>
      setTimeout(
        () =>
          resolve({
            status: 'failed',
            output: '',
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            error: `node ${node.id} timed out after ${node.timeoutMs}ms`,
          }),
        node.timeoutMs,
      ),
    );
    return Promise.race([exec, timeout]);
  }
  return exec;
}

/** Inner dispatch — the actual node-type handlers. */
async function dispatchByTypeInner(
  ctx: GraphRunContext,
  deps: GraphDeps,
  node: GraphNode,
): Promise<NodeRunOutcome> {
  switch (node.type) {
    case 'agent':
      return runAgentNode(ctx, deps, node);
    case 'gate':
      return runGateNode(ctx, node);
    case 'branch':
      return runBranchNode(node, ctx.state);
    case 'join':
      return { status: 'completed', output: '', inputTokens: 0, outputTokens: 0, costUsd: 0 };
    case 'human':
      // P1: pause the run and surface an approval card. The orchestrator's
      // pause branch reads the node's approval fields to store an approval
      // message + broadcast human_approval_request. Approval is submitted via
      // POST /api/graph/runs/:id/nodes/:nodeId/approve, which marks this node
      // run completed + writes the decision into state, then resumes.
      return {
        status: 'paused',
        output: node.approvalPrompt ?? 'human-in-the-loop node awaiting approval',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
    // ---- DSL v2 node kinds (graph-task-planning-execution) ----
    case 'llm':
      return runLlmNode(ctx, node);
    case 'tool':
      return runToolNode(ctx, node);
    case 'start':
    case 'parallel':
      // Semantic-sugar / lifecycle markers: no-op, immediately completed.
      // 'parallel' fans out via its multiple outgoing plain edges (scheduler).
      // 'start' just records graph input has been consumed.
      return { status: 'completed', output: '', inputTokens: 0, outputTokens: 0, costUsd: 0 };
    case 'end':
      return runEndNode(ctx, node);
    case 'aggregate':
      return runAggregateNode(ctx, node);
    default:
      return {
        status: 'failed',
        output: '',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        error: `unknown node type: ${(node as GraphNode).type}`,
      };
  }
}

/**
 * Compose the effective prompt for an agent node: goal anchor + base prompt,
 * and (F6) prepend any downstream-gate failure feedback the orchestrator wrote
 * into state when it reset this node for re-run. Pure so it is unit-testable.
 */
export function composeAgentPrompt(node: GraphNode, state: GraphState): string {
  const basePrompt = node.prompt ?? node.title;
  let prompt = node.goalAnchor
    ? `${node.goalAnchor}\n\n---\n\n${basePrompt}`
    : basePrompt;
  const gateFeedbackKey = `gate_feedback_${node.id}`;
  const gateFeedback =
    typeof state[gateFeedbackKey] === 'string'
      ? (state[gateFeedbackKey] as string)
      : '';
  if (gateFeedback) {
    prompt = `${gateFeedback}\n\n---\n\n${prompt}`;
  }
  return prompt;
}

/** Run an 'agent' node — calls runHostAgent/runContainerAgent (mirrors runOneIteration). */
async function runAgentNode(
  ctx: GraphRunContext,
  deps: GraphDeps,
  node: GraphNode,
): Promise<NodeRunOutcome> {
  const executionMode = resolveExecutionMode(ctx, deps);
  const runAgent = executionMode === 'host' ? runHostAgent : runContainerAgent;
  const group = buildOwnerGroup(ctx, executionMode);
  const turnId = `${ctx.graphRunId}-${node.id}`;

  // Super Agent Team: if the node references a Team-created agent definition,
  // set it on the synthetic group so container-runner's existing
  // loadGroupAgentDefinition(group.agentDefId, group.created_by) loads the
  // Team-designed systemPrompt/engine/skills/mcp — zero change to
  // container-runner. loadGroupAgentDefinition returns undefined unless BOTH
  // agentDefId and created_by are non-null, so set created_by = ownerUserId.
  // (buildOwnerGroup sets owner_user_id, which RegisteredGroup doesn't read; we
  // set the correct created_by field only when an agentDefId is present, leaving
  // existing agentDefId-less nodes' behavior unchanged.)
  if (node.agentDefId) {
    const g = group as unknown as {
      agentDefId?: string;
      created_by?: string;
      _graphAgentNode?: boolean;
    };
    g.agentDefId = node.agentDefId;
    g.created_by = ctx.ownerUserId;
    // Marker: suppress writeAgentProjectClaudeMd for graph agent nodes so we
    // don't clobber the shared owner-folder CLAUDE.md. The Team-designed
    // systemPrompt still reaches the SDK via the <agent-definition> tag
    // (agent-runner index.ts:1487), which is independent of the CLAUDE.md write.
    g._graphAgentNode = true;
  }

  let output = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;

  const prompt = composeAgentPrompt(node, ctx.state);

  const input: ContainerInput = {
    prompt,
    groupFolder: ctx.groupFolder,
    chatJid: ctx.chatJid,
    isMain: ctx.groupFolder === 'main',
    isHome: true,
    isAdminHome: ctx.groupFolder === 'main',
    turnId,
    userLanguage: ctx.userLanguage ?? 'zh-CN',
    // Super Agent Team: propagate graph linkage so agent-runner tags its
    // trace nodes + tool calls with this graph_run_id / graph_node_id, forming
    // the node-internal sub-graph trace.
    graphRunId: ctx.graphRunId,
    graphNodeId: node.id,
  };

  const agentResult = await runAgent(
    group,
    input,
    (proc, identifier, selectedProviderId) =>
      deps.onProcess(
        ctx.chatJid,
        proc,
        executionMode === 'container' ? identifier : null,
        ctx.groupFolder,
        `graph-${ctx.graphRunId}-${node.id}`,
        turnId,
        selectedProviderId,
      ),
    async (streamed: ContainerOutput) => {
      if (streamed.status === 'stream' && streamed.streamEvent) {
        // Persist trace nodes + tool-call I/O to chat_trace_nodes /
        // trace_tool_calls (linked to this graph_run_id via the graphRunId
        // stamped by agent-runner's trace-node-allocator). Mirrors the IM path
        // at src/index.ts:3678; without this the execution-view trace panel
        // shows nothing for graph agent runs even though output_summary exists.
        persistTraceNodeFromStreamEvent(ctx.chatJid, streamed.streamEvent);
        deps.broadcastStreamEvent?.(ctx.chatJid, streamed.streamEvent);
        const u = (streamed.streamEvent as { usage?: { inputTokens: number; outputTokens: number; costUSD: number } }).usage;
        if (u) {
          inputTokens += u.inputTokens;
          outputTokens += u.outputTokens;
          costUsd += u.costUSD;
        }
      }
      if (streamed.result) output = streamed.result;
    },
  );

  // Container exit status → node outcome. Previously this return value was
  // discarded and the node was unconditionally marked 'completed', so a
  // timed-out / errored / closed (host-killed) container still surfaced as a
  // completed node with empty output, breaking downstream gates and masking
  // the real failure. Map non-success terminal states to 'failed'.
  if (agentResult.status === 'error' || agentResult.status === 'closed') {
    return {
      status: 'failed',
      output,
      statePatch: { [`node_${node.id}_output`]: output.slice(0, 4000) },
      inputTokens,
      outputTokens,
      costUsd,
      error: agentResult.error ?? `agent node ${node.id} ${agentResult.status}`,
    };
  }

  // Heuristic state patch: expose the agent output so downstream nodes can read it.
  const statePatch: StatePatch = { [`node_${node.id}_output`]: output.slice(0, 4000) };

  return {
    status: 'completed',
    output,
    statePatch,
    inputTokens,
    outputTokens,
    costUsd,
  };
}

/**
 * Pure evaluation of a gate's behavioral evidence (assertions + shellCheck
 * result). Returns null if evidence passed; returns a failure description
 * string if any evidence failed. Extracted for unit testing (TC8-TC11) — no
 * I/O, no SDK calls. The LLM reviewer is NOT part of behavioral evidence and
 * runs separately as a confirming/legacy pass.
 *
 * @param assertions  gate node's GraphAssertion[]
 * @param upstreamOutput  the upstream agent's output text to assert against
 * @param shellResult  result of node.shellCheck (null if no shellCheck)
 */
export function evaluateBehavioralEvidence(
  assertions: GraphAssertion[] | undefined,
  upstreamOutput: string,
  shellResult: { exitCode: number; stdout: string; stderr: string } | null,
): { pass: boolean; detail: string } {
  let hadError = false;
  const evidence: string[] = [];
  if (shellResult) {
    hadError = shellResult.exitCode !== 0;
    evidence.push(
      `shellCheck (exit ${shellResult.exitCode}) stdout:\n${shellResult.stdout.slice(0, 1500)}${shellResult.stderr ? `\nstderr:\n${shellResult.stderr.slice(0, 800)}` : ''}`,
    );
    if (hadError) {
      return {
        pass: false,
        detail: `行为证据失败：shellCheck 退出码 ${shellResult.exitCode}\n${evidence[0]}`,
      };
    }
  }
  const combinedText = `${upstreamOutput}\n${evidence.join('\n')}`;
  for (const assertion of assertions ?? []) {
    const r = scoreAssertion(assertion, combinedText, hadError);
    if (!r.pass) {
      return {
        pass: false,
        detail: `行为证据失败：断言 [${assertion.kind}:${assertion.value}] ${r.detail}`,
      };
    }
    evidence.push(`断言通过 [${assertion.kind}:${assertion.value}]`);
  }
  return { pass: true, detail: `行为证据通过：${evidence.join(' | ')}` };
}

/** Run a 'gate' node — behavioral-evidence first (shellCheck + assertions),
 *  then LLM reviewer as fallback. Behavioral evidence failing → gate failed,
 *  no LLM whitewashing (fixes "premature completion"). Missing evidence →
 *  LLM-only review (backward compat with existing gate nodes). */
async function runGateNode(
  ctx: GraphRunContext,
  node: GraphNode,
): Promise<NodeRunOutcome> {
  // Resolve the upstream agent's output text to assert against.
  const upstreamId = node.upstreamNodeId;
  const upstreamKey = upstreamId ? `node_${upstreamId}_output` : null;
  const upstreamOutput =
    (upstreamKey && typeof ctx.state[upstreamKey] === 'string'
      ? (ctx.state[upstreamKey] as string)
      : '') || node.prompt || '';

  // 1+2. Behavioral evidence (shellCheck + assertions) via the pure evaluator.
  let shellResult: { exitCode: number; stdout: string; stderr: string } | null = null;
  if (node.shellCheck) {
    // P0: run shellCheck in the node's isolated workspace so parallel gates /
    // tool nodes don't race on the owner folder's working tree.
    const ws = resolveNodeWorkspace(ctx, node);
    const res = await runScript(node.shellCheck, ws);
    shellResult = { exitCode: res.exitCode ?? 1, stdout: res.stdout, stderr: res.stderr };
  }
  const hasEvidence = !!node.shellCheck || !!(node.assertions && node.assertions.length > 0);
  const verdict = evaluateBehavioralEvidence(node.assertions, upstreamOutput, shellResult);
  if (hasEvidence && !verdict.pass) {
    return {
      status: 'failed',
      output: `${verdict.detail}\n上游产出片段：${upstreamOutput.slice(0, 500)}`,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      error: verdict.detail,
    };
  }

  // 3. LLM reviewer: legacy path when no behavioral evidence (backward compat),
  //    or a confirming pass after evidence passed when successCriteria is set.
  if (!hasEvidence) {
    const prompt = buildGatePrompt(node, upstreamOutput);
    const raw = await lightweightSdkQuery(prompt, { timeout: GATE_REVIEW_TIMEOUT_MS });
    const parsed = parseReviewResult(raw);
    const status = parsed.result === 'pass' ? 'completed' : 'failed';
    return {
      status,
      output: parsed.reason,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      error: status === 'failed' ? parsed.reason : undefined,
    };
  }

  // Behavioral evidence passed → completed (optionally annotated with LLM reason).
  let llmReason = '';
  if (node.successCriteria) {
    const prompt = buildGatePrompt(node, upstreamOutput);
    const raw = await lightweightSdkQuery(prompt, { timeout: GATE_REVIEW_TIMEOUT_MS });
    llmReason = parseReviewResult(raw).reason ?? '';
  }
  return {
    status: 'completed',
    output: `${verdict.detail}${llmReason ? `\nLLM 评审：${llmReason}` : ''}`,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
}

/** Run a 'branch' node — evaluate branchKey against state, return the chosen value. */
function runBranchNode(node: GraphNode, state: GraphState): NodeRunOutcome {
  const key = node.branchKey ?? '';
  const value = state[key];
  const branchResult = value === undefined || value === null ? 'default' : String(value);
  return {
    status: 'completed',
    output: `branch → ${branchResult}`,
    branchResult,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
}

// ---------------------------------------------------------------------------
// DSL v2 node runners (graph-task-planning-execution)
// ---------------------------------------------------------------------------

/**
 * Resolve an isolated workspace directory for a node. P0 isolates gate/tool/
 * llm nodes (which have no group-identity dependency) under
 * `<groupFolder>/graph-workspaces/<runId>/<nodeId>/`. Agent nodes still run in
 * the owner group folder (they depend on RegisteredGroup lookup + container
 * runner internals — full agent isolation is P1, see SOLUTION §5.2).
 */
function resolveNodeWorkspace(ctx: GraphRunContext, node: GraphNode): string {
  const ws = join(ctx.groupFolder, 'graph-workspaces', ctx.graphRunId, node.id);
  try {
    mkdirSync(ws, { recursive: true });
  } catch {
    // best-effort; the owner folder is the fallback for agents.
  }
  return ws;
}

/** Run an 'llm' node — pure model inference (no agent runner, no tools). */
async function runLlmNode(ctx: GraphRunContext, node: GraphNode): Promise<NodeRunOutcome> {
  const evalCtx = buildEvalContext(ctx.state);
  const prompt = resolveExpr(node.prompt ?? node.title ?? '', evalCtx);
  const raw = await lightweightSdkQuery(prompt, {
    timeout: GATE_REVIEW_TIMEOUT_MS,
    ...(node.model ? { model: node.model } : {}),
  });
  const output = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  return {
    status: 'completed',
    output,
    statePatch: { [`node_${node.id}_output`]: output.slice(0, 8000) },
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
}

/**
 * Run a 'tool' node — direct platform tool invocation. P0 supports the
 * `run_script` tool (mirrors gate shellCheck, in the node's isolated workspace)
 * plus `web_search` / `web_fetch` via the lightweight SDK query path. Other
 * tool names fail clearly rather than silently no-op'ing.
 */
async function runToolNode(ctx: GraphRunContext, node: GraphNode): Promise<NodeRunOutcome> {
  const evalCtx = buildEvalContext(ctx.state);
  const toolInput = resolveValue(node.toolInput ?? {}, evalCtx);
  const toolName = node.toolName ?? '';
  if (toolName === 'run_script') {
    const cmd = typeof toolInput.command === 'string' ? toolInput.command : '';
    const ws = resolveNodeWorkspace(ctx, node);
    const res = await runScript(cmd, ws);
    const ok = (res.exitCode ?? 1) === 0;
    const output = `$ ${cmd}\n[exit ${res.exitCode}]\n${res.stdout}${res.stderr ? `\n${res.stderr}` : ''}`;
    return {
      status: ok ? 'completed' : 'failed',
      output,
      statePatch: { [`node_${node.id}_output`]: output.slice(0, 8000) },
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      error: ok ? undefined : `run_script exit ${res.exitCode}`,
    };
  }
  // web_search / web_fetch: delegate to a one-shot LLM-style query is NOT a
  // real tool call; instead surface clearly as unsupported in P0 so the planner
  // / author gets a precise failure rather than silent success.
  return {
    status: 'failed',
    output: '',
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    error: `tool node ${node.id}: tool "${toolName}" not supported in P0 (only run_script)`,
  };
}

/** Run an 'end' node — resolve the output template against the final state. */
function runEndNode(ctx: GraphRunContext, node: GraphNode): NodeRunOutcome {
  if (!node.outputTemplate) {
    return { status: 'completed', output: '', inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }
  const evalCtx = buildEvalContext(ctx.state);
  const output = resolveExpr(node.outputTemplate, evalCtx);
  return {
    status: 'completed',
    output,
    statePatch: { [`node_${node.id}_output`]: output, __graph_result: output },
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
}

/**
 * Run an 'aggregate' node — converging multiple branch outputs. With
 * mergeStrategy='all' (default) it's a join no-op (the scheduler already
 * waited for all predecessors). With 'arbitrate' it calls an LLM to merge the
 * upstream outputs into one. 'any' completes as soon as ANY predecessor output
 * exists (the scheduler still waits for all completed predecessors; 'any'
 * governs which output is surfaced).
 */
async function runAggregateNode(ctx: GraphRunContext, node: GraphNode): Promise<NodeRunOutcome> {
  // Collect upstream outputs from state (node_<id>_output for each predecessor).
  const preds = ctx.definition.edges.filter((e) => e.to === node.id).map((e) => e.from);
  const outputs: Record<string, unknown> = {};
  for (const pid of preds) {
    const key = `node_${pid}_output`;
    if (ctx.state[key] !== undefined) outputs[pid] = ctx.state[key];
  }
  const strategy = node.mergeStrategy ?? 'all';
  if (strategy === 'arbitrate') {
    const prompt = `${node.arbitratePrompt ?? '请合并以下各分支产出为统一结论'}\n\n${JSON.stringify(outputs, null, 2).slice(0, 8000)}`;
    const raw = await lightweightSdkQuery(prompt, { timeout: GATE_REVIEW_TIMEOUT_MS });
    const output = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
    return {
      status: 'completed',
      output,
      statePatch: { [`node_${node.id}_output`]: output.slice(0, 8000) },
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
  }
  // 'all' / 'any': surface merged JSON.
  const output = JSON.stringify(outputs);
  return {
    status: 'completed',
    output,
    statePatch: { [`node_${node.id}_output`]: output.slice(0, 8000) },
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
}
