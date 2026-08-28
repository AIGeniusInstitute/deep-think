/**
 * Agent Orchestrator–Workers — orchestrator runner.
 *
 * runOrchestrator(input, deps): the orchestration brain for the "主 Agent 编排
 * 子 Agent" mode. Unlike super-agent-team (which auto-creates members), here the
 * workers are pre-existing agent_definitions that the user explicitly linked to
 * an orchestrator agent. The orchestrator's own system prompt acts as the
 * planning persona:
 *
 *   1. load the orchestrator definition + its linked workers;
 *   2. plan: sdkQuery (single LLM turn, no tools, orchestrator's model) produces
 *      an OrchestratorPlan JSON that assigns sub-tasks to the linked workers
 *      (validated by orchestrator-plan.ts; retry once then fall back);
 *   3. assemble: each step becomes a standard GraphNode 'agent' node whose
 *      agentDefId references the assigned worker (reusing graph-runner's
 *      existing agentDefId execution), plus a trailing behavioral-evidence
 *      acceptance gate;
 *   4. register + start the graph run via graph-engineering (100% reuse).
 */

import { logger } from '../logger.js';
import { emitAutonomyEvent } from '../autonomy/autonomy-bus.js';
import { sdkQuery } from '../sdk-query.js';
import { getAgentDefinition, listAgentWorkers, type AgentDefinitionRow } from '../db.js';
import { registerDefinition } from '../graph-engineering/graph-registry.js';
import {
  startGraphRun,
  buildRunContext,
  executeGraph,
} from '../graph-engineering/graph-orchestrator.js';
import type { GraphDeps } from '../graph-engineering/graph-runner.js';
import type {
  GraphDefinition,
  GraphNode,
  GraphEdge,
} from '../graph-engineering/graph-types.js';
import {
  parseOrchestratorPlan,
  buildFallbackPlan,
  type OrchestratorPlan,
  type OrchestratorRunInput,
  type OrchestratorRunResult,
  type OrchestratorRunError,
} from './orchestrator-plan.js';

const PLAN_TIMEOUT_MS = 120_000;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build the planning prompt: orchestrator persona + worker roster + task. */
function buildOrchestratorPrompt(
  orchestrator: AgentDefinitionRow,
  workers: AgentDefinitionRow[],
  input: OrchestratorRunInput,
): string {
  const persona =
    orchestrator.system_prompt?.trim() ||
    '你是资深项目主管，负责把复杂任务拆解为清晰的子任务，并分派给合适的下属子 Agent 协作完成。';
  const roster = workers
    .map(
      (w) =>
        `- id: ${w.id}\n  name: ${w.name}\n  description: ${(w.description || '无').slice(0, 300)}`,
    )
    .join('\n');
  return `${persona}

【你的下属子 Agent 花名册（只能从以下 id 中分派）】
${roster}

【用户任务】
${input.task}

【背景】
${input.background?.trim() || '无'}

【验收标准】
${input.acceptanceCriteria?.trim() || '无'}

请拆解任务并分派给下属子 Agent，输出 STRICTLY JSON（不要代码块、不要任何多余文字），格式：
{
  "planName": "slug",
  "steps": [
    {
      "id": "step1",
      "title": "步骤标题",
      "workerId": "<必须精确等于花名册中某个子 Agent 的 id>",
      "task": "该子 Agent 要完成的具体子任务与交付物",
      "dependsOn": []
    }
  ],
  "acceptanceCriteria": "验收标准文本"
}

规则：
- 每个 step 的 workerId 必须精确等于花名册中某个子 Agent 的 id。
- dependsOn 引用其他 step 的 id（前驱完成后才执行）；无依赖的 step 可并行。
- 至少 1 个 step；各 step 的交付物不要重叠。`;
}

/** Plan via LLM, retry once, then fall back to sequential dispatch. */
async function planOrchestration(
  input: OrchestratorRunInput,
  orchestrator: AgentDefinitionRow,
  workers: AgentDefinitionRow[],
): Promise<OrchestratorPlan> {
  const workerIdSet = new Set(workers.map((w) => w.id));
  const prompt = buildOrchestratorPrompt(orchestrator, workers, input);

  let result = parseOrchestratorPlan(
    await sdkQuery(prompt, { model: orchestrator.model ?? undefined, timeout: PLAN_TIMEOUT_MS }),
    workerIdSet,
  );
  if (result) return result;
  logger.warn({ orchestratorId: input.orchestratorId }, 'orchestrator plan attempt 1 invalid; retrying');
  result = parseOrchestratorPlan(
    await sdkQuery(prompt, { model: orchestrator.model ?? undefined, timeout: PLAN_TIMEOUT_MS }),
    workerIdSet,
  );
  if (result) return result;
  logger.warn({ orchestratorId: input.orchestratorId }, 'orchestrator plan attempt 2 invalid; using fallback');
  return buildFallbackPlan(workers.map((w) => w.id), input.task);
}

/** Assemble a GraphDefinition from the plan + linked worker definitions. */
export function assembleOrchestratorGraph(
  plan: OrchestratorPlan,
  workerById: Map<string, AgentDefinitionRow>,
  input: OrchestratorRunInput,
): GraphDefinition {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set(plan.steps.map((s) => s.id));
  let lastAgentNodeId: string | null = null;

  for (const step of plan.steps) {
    const worker = workerById.get(step.workerId);
    if (!worker) {
      throw new Error(`step ${step.id} references unknown worker ${step.workerId}`);
    }
    const goalAnchor = `【任务目标】${input.task}\n【你的子任务】${step.task}\n【角色】${worker.name}${input.acceptanceCriteria ? `\n【验收标准】${input.acceptanceCriteria}` : ''}`;
    nodes.push({
      id: step.id,
      type: 'agent',
      title: `${worker.name}：${step.title}`,
      agentDefId: step.workerId,
      agentMember: worker.name,
      prompt: step.task,
      goalAnchor,
      isIdempotent: false,
    });
    lastAgentNodeId = step.id;
    for (const dep of step.dependsOn) {
      if (nodeIds.has(dep)) {
        edges.push({ id: `${dep}->${step.id}`, from: dep, to: step.id, type: 'data' });
      }
    }
  }

  // Trailing acceptance gate (behavioral evidence). Without acceptance
  // criteria the gate is LLM-only (no assertions) — PRD AC4.4.
  const criteria = (input.acceptanceCriteria || plan.acceptanceCriteria || '').trim();
  if (lastAgentNodeId) {
    const gateId = 'accept';
    nodes.push({
      id: gateId,
      type: 'gate',
      title: '验收',
      successCriteria: criteria || input.task,
      upstreamNodeId: lastAgentNodeId,
      ...(criteria
        ? { assertions: [{ kind: 'regex', value: escapeRegex(criteria.slice(0, 60)) || '.+' }] }
        : {}),
    });
    edges.push({ id: `${lastAgentNodeId}->${gateId}`, from: lastAgentNodeId, to: gateId, type: 'data' });
  }

  return {
    id: `orchestrator-${plan.planName}`,
    version: 1,
    name: plan.planName,
    description: `Orchestrator run for: ${input.task.slice(0, 120)}`,
    nodes,
    edges,
  };
}

/**
 * Run the orchestrator on a complex task: plan → assemble graph → register →
 * start run. Execution runs detached (same as buildTeam). Returns runId + plan,
 * or an error.
 */
export async function runOrchestrator(
  input: OrchestratorRunInput,
  deps: GraphDeps,
): Promise<OrchestratorRunResult | OrchestratorRunError> {
  if (!input.orchestratorId || !input.task?.trim()) {
    return { error: 'orchestratorId and task are required' };
  }
  if (!input.ownerUserId || !input.groupFolder || !input.chatJid) {
    return { error: 'ownerUserId/groupFolder/chatJid are required' };
  }

  const orchestrator = getAgentDefinition(input.orchestratorId, input.ownerUserId);
  if (!orchestrator) {
    return { error: 'orchestrator not found' };
  }
  if (orchestrator.kind !== 'orchestrator') {
    return { error: 'agent is not an orchestrator' };
  }
  const workers = listAgentWorkers(input.orchestratorId);
  if (workers.length === 0) {
    return { error: 'no workers linked — associate at least one sub-agent first' };
  }

  let plan: OrchestratorPlan;
  try {
    plan = await planOrchestration(input, orchestrator, workers);
    emitAutonomyEvent({
      capability: 'decision',
      domain: input.chatJid,
      type: 'decision.generated',
      payload: { human_triggered: false, steps: plan.steps.length, orchestrator: 'workers' },
      ts: Date.now(),
    });
  } catch (err) {
    return { error: 'orchestrator planning failed', detail: (err as Error).message };
  }

  const workerById = new Map(workers.map((w) => [w.id, w]));
  let def: GraphDefinition;
  try {
    def = assembleOrchestratorGraph(plan, workerById, input);
  } catch (err) {
    return { error: 'graph assembly failed', detail: (err as Error).message };
  }

  try {
    const registered = registerDefinition(def, input.ownerUserId);
    const started = startGraphRun({
      definitionId: def.id,
      ownerUserId: input.ownerUserId,
      groupFolder: input.groupFolder,
      chatJid: input.chatJid,
      goalText: input.task,
    });
    if ('error' in started) {
      return { error: started.error };
    }

    buildRunContext(started.runId, deps).then((ctxRes) => {
      if (!ctxRes) {
        logger.error({ runId: started.runId }, 'orchestrator start: context build failed');
        return;
      }
      executeGraph(ctxRes.ctx, deps).catch((err) => {
        logger.error({ err, runId: started.runId }, 'orchestrator graph execution failed');
      });
    });

    logger.info(
      { runId: started.runId, steps: plan.steps.length },
      'Orchestrator run started',
    );
    return {
      runId: started.runId,
      definitionId: started.definition.id,
      definitionVersion: registered.version,
      plan,
    };
  } catch (err) {
    return { error: 'register/start failed', detail: (err as Error).message };
  }
}
