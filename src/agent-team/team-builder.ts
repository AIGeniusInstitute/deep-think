/**
 * Super Agent Team — Team Builder meta-agent.
 *
 * buildTeam(input, deps): the autonomous orchestration brain. Takes a complex
 * task (goal + background + acceptance criteria) and:
 *   1. uses sdkQuery (single LLM turn, no tools) to decompose it into a
 *      TeamPlan JSON (validated by team-plan.ts);
 *   2. autonomously creates an agent_definition per member (systemPrompt +
 *      engine + model + maxTurns) and binds skills/mcp via agent_mounts —
 *      reusing the existing Agent Definitions infrastructure (zero new spec
 *      format);
 *   3. assembles a standard GraphDefinition where agent nodes reference the
 *      created agent_definition ids + carry a goalAnchor, and gate nodes carry
 *      behavioral-evidence assertions/shellCheck;
 *   4. registers via the existing graph-registry and starts a GraphRun via the
 *      existing startGraphRun + buildRunContext + executeGraph (100% reuse of
 *      graph-engineering execution).
 *
 * On decomposition failure: retry once, then fall back to a single-agent plan
 * (PRD §6 risk). The Team Builder does NOT call tools or bypass security — it
 * only writes agent_definition rows + graph definitions via existing DB APIs.
 */

import { logger } from '../logger.js';
import { sdkQuery } from '../sdk-query.js';
import {
  createAgentDefinition,
  addAgentMount,
  getAgentDefinitionByName,
} from '../db.js';
import {
  computeManifestHash,
  registerDefinition,
  toMermaid,
} from '../graph-engineering/graph-registry.js';
import {
  startGraphRun,
  buildRunContext,
  executeGraph,
} from '../graph-engineering/graph-orchestrator.js';
import type { GraphDeps } from '../graph-engineering/graph-runner.js';
import type { GraphDefinition, GraphNode, GraphEdge } from '../graph-engineering/graph-types.js';
import {
  parseTeamPlan,
  type TeamTaskInput,
  type TeamBuildResult,
  type TeamBuildError,
  type TeamPlan,
  type TeamMember,
  type TeamGraphNode,
} from './team-plan.js';
import {
  buildDecompositionPrompt,
  buildGoalAnchor,
  buildFallbackPlan,
} from './team-prompt.js';

const DECOMPOSE_TIMEOUT_MS = 120_000;

/** Decompose via LLM, retry once, then fall back. Returns a valid TeamPlan. */
async function decompose(input: TeamTaskInput): Promise<TeamPlan> {
  const prompt = buildDecompositionPrompt(input);
  // Attempt 1.
  let plan = parseTeamPlan(await sdkQuery(prompt, { timeout: DECOMPOSE_TIMEOUT_MS }));
  if (plan) return plan;
  logger.warn({ goal: input.goalText.slice(0, 100) }, 'Team decompose attempt 1 invalid; retrying');
  // Attempt 2.
  plan = parseTeamPlan(await sdkQuery(prompt, { timeout: DECOMPOSE_TIMEOUT_MS }));
  if (plan) return plan;
  logger.warn({ goal: input.goalText.slice(0, 100) }, 'Team decompose attempt 2 invalid; using fallback');
  // Fallback single-agent plan (already structurally valid).
  return buildFallbackPlan(input) as TeamPlan;
}

/**
 * Idempotently create an agent_definition for a member (systemPrompt + engine +
 * model + maxTurns) and bind its skills/mcp via agent_mounts. Namespaced by
 * teamName to avoid cross-team collisions within one user. If the definition
 * already exists (same name), reuse it — re-build is idempotent.
 */
function createMemberAgent(
  ownerUserId: string,
  teamName: string,
  member: TeamMember,
): string {
  const namespacedName = `${teamName}-${member.name}`;
  const existing = getAgentDefinitionByName(ownerUserId, namespacedName);
  if (existing) {
    // Reuse; bind any missing mounts (idempotent).
    for (const skill of member.skills) addAgentMount(existing.id, 'skill', skill);
    for (const mcp of member.mcpServers) addAgentMount(existing.id, 'mcp_server', mcp);
    return existing.id;
  }
  const def = createAgentDefinition(ownerUserId, {
    name: namespacedName,
    description: `${member.role}（团队 ${teamName}）`,
    system_prompt: member.systemPrompt,
    engine: member.engine,
    model: member.model,
    max_turns: member.maxTurns,
    enabled: true,
  });
  for (const skill of member.skills) addAgentMount(def.id, 'skill', skill);
  for (const mcp of member.mcpServers) addAgentMount(def.id, 'mcp_server', mcp);
  return def.id;
}

/**
 * v2 (TeamPage UI): apply user's advanced options to the decomposed plan.
 * - maxTeamSize: cap members, preserving any member referenced by a graph
 *   agent node (dependency closure) so the graph never references a dropped
 *   member. Fill remaining slots in declaration order.
 * - toolset: filter each member's skills/mcpServers to the allowed set.
 * executionMode is honored in assembleGraphDefinition (inserts human gates).
 * Surgical: both no-op when the option is missing (backward compat).
 */
function applyAdvancedOptions(plan: TeamPlan, input: TeamTaskInput): TeamPlan {
  let members = plan.members;

  if (input.maxTeamSize && members.length > input.maxTeamSize) {
    const referenced = new Set(
      plan.graph.nodes.filter((n) => n.agentMember).map((n) => n.agentMember!),
    );
    const keep: TeamMember[] = [];
    // First: keep all members referenced by graph nodes (dependency closure).
    for (const m of members) {
      if (referenced.has(m.name)) keep.push(m);
    }
    // Then fill up to maxTeamSize in declaration order.
    for (const m of members) {
      if (keep.length >= input.maxTeamSize) break;
      if (!keep.includes(m)) keep.push(m);
    }
    members = keep;
  }

  if (input.toolset && input.toolset.length) {
    const allowed = new Set(input.toolset);
    members = members.map((m) => ({
      ...m,
      skills: m.skills.filter((s) => allowed.has(s)),
      mcpServers: m.mcpServers.filter((s) => allowed.has(s)),
    }));
  }

  return members === plan.members ? plan : { ...plan, members };
}

/** Assemble a GraphDefinition from the plan + created member agent def ids. */
export function assembleGraphDefinition(
  plan: TeamPlan,
  memberDefIds: Record<string, string>,
  input: TeamTaskInput,
): GraphDefinition {
  const memberByName = new Map(plan.members.map((m) => [m.name, m]));
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set(plan.graph.nodes.map((n) => n.id));
  let lastAgentNodeId: string | null = null;

  // v2 semi-auto: for each agent node, a human approval gate is inserted right
  // after it and spliced into the dependency chain — downstream nodes that
  // depended on the agent now depend on the gate, so the run pauses for human
  // approval before downstream work proceeds (AC6.5). Map agentId → reviewId.
  const semiAuto = input.executionMode === 'semi-auto';
  const reviewIdForAgent = new Map<string, string>();

  for (const gn of plan.graph.nodes) {
    const node: GraphNode = { id: gn.id, type: gn.type, title: gn.title };
    if (gn.type === 'agent') {
      const member = gn.agentMember ? memberByName.get(gn.agentMember) : undefined;
      if (!member || !memberDefIds[member.name]) {
        throw new Error(`agent node ${gn.id} references unknown member ${gn.agentMember}`);
      }
      node.agentDefId = memberDefIds[member.name];
      node.agentMember = member.name;
      node.goalAnchor = buildGoalAnchor(input, member, gn);
      node.prompt = gn.deliverable || gn.title;
      node.isIdempotent = false;
      lastAgentNodeId = gn.id;

      if (semiAuto) {
        // Insert a human approval gate after this agent, spliced into the chain.
        let reviewId = `${gn.id}-review`;
        let i = 0;
        while (nodeIds.has(reviewId)) {
          i += 1;
          reviewId = `${gn.id}-review-${i}`;
        }
        nodeIds.add(reviewId);
        reviewIdForAgent.set(gn.id, reviewId);
        nodes.push({
          id: reviewId,
          type: 'human',
          title: `${gn.title} 产出确认`,
          approvalPrompt: `${member.role} 的「${gn.title}」产出是否通过？通过则继续下游，打回则重做该节点。`,
          approvalOptions: [
            { label: '通过，继续下游', value: 'approve' },
            { label: '打回重做', value: 'reject' },
          ],
          approvalStateKey: `node_${gn.id}_approval`,
        });
        edges.push({ id: `${gn.id}->${reviewId}`, from: gn.id, to: reviewId, type: 'data' });
      }
    } else if (gn.type === 'gate') {
      node.assertions = gn.assertions;
      node.shellCheck = gn.shellCheck;
      node.successCriteria = gn.successCriteria || input.acceptanceCriteria || input.goalText;
      node.upstreamNodeId = gn.upstreamNodeId || lastAgentNodeId || undefined;
    }
    nodes.push(node);
    for (const dep of gn.dependsOn) {
      if (nodeIds.has(dep)) {
        // semi-auto: if this node depends on an agent that got a review gate,
        // rewire the dependency to the review gate so approval blocks downstream.
        const rewiredDep = (semiAuto && reviewIdForAgent.has(dep)) ? reviewIdForAgent.get(dep)! : dep;
        edges.push({
          id: `${rewiredDep}->${gn.id}`,
          from: rewiredDep,
          to: gn.id,
          type: 'data',
        });
      }
    }
  }

  // Acceptance gate backstop: if no gate node carries behavioral evidence
  // (assertions or shellCheck), append one that asserts the acceptance
  // criteria keyword against the last agent's output (PRD AC6.1).
  const hasEvidenceGate = plan.graph.nodes.some(
    (n) => n.type === 'gate' && ((n.assertions && n.assertions.length > 0) || n.shellCheck),
  );
  if (!hasEvidenceGate && lastAgentNodeId) {
    const acceptId = 'accept';
    let id = acceptId;
    let i = 0;
    while (nodeIds.has(id)) {
      i += 1;
      id = `${acceptId}-${i}`;
    }
    const criteria = input.acceptanceCriteria || input.goalText;
    nodes.push({
      id,
      type: 'gate',
      title: '验收（行为证据）',
      successCriteria: criteria,
      upstreamNodeId: lastAgentNodeId,
      assertions: [
        {
          kind: 'regex',
          value: String(criteria).slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') || '.+',
        },
      ],
    });
    edges.push({ id: `${lastAgentNodeId}->${id}`, from: lastAgentNodeId, to: id, type: 'data' });
  }

  const def: GraphDefinition = {
    id: `team-${plan.teamName}`,
    version: 1,
    name: plan.teamName,
    description: `Team built by DeepThink for: ${input.goalText.slice(0, 120)}`,
    nodes,
    edges,
  };
  return def;
}

/**
 * Build a Super Agent Team for the given task: decompose → create members →
 * assemble graph → register → start run. Returns the run id + plan, or an
 * error. The graph executes in the background (detached) exactly like a
 * /graph run; the caller returns immediately.
 */
export async function buildTeam(
  input: TeamTaskInput,
  deps: GraphDeps,
): Promise<TeamBuildResult | TeamBuildError> {
  if (!input.goalText?.trim()) {
    return { error: 'goalText is required' };
  }
  if (!input.ownerUserId || !input.groupFolder || !input.chatJid) {
    return { error: 'ownerUserId/groupFolder/chatJid are required' };
  }

  // 1. Decompose.
  let plan: TeamPlan;
  try {
    plan = await decompose(input);
  } catch (err) {
    return { error: 'decomposition failed', detail: (err as Error).message };
  }

  // v2: apply user advanced options (maxTeamSize / toolset) before creating members.
  plan = applyAdvancedOptions(plan, input);

  // 2. Create agent members (idempotent).
  const memberDefIds: Record<string, string> = {};
  try {
    for (const member of plan.members) {
      memberDefIds[member.name] = createMemberAgent(
        input.ownerUserId,
        plan.teamName,
        member,
      );
    }
  } catch (err) {
    return { error: 'agent creation failed', detail: (err as Error).message };
  }

  // 3. Assemble graph definition.
  let def: GraphDefinition;
  try {
    def = assembleGraphDefinition(plan, memberDefIds, input);
  } catch (err) {
    return { error: 'graph assembly failed', detail: (err as Error).message };
  }

  // 4. Register + start (reuse graph-engineering).
  try {
    const registered = registerDefinition(def);
    logger.info(
      { defId: def.id, hash: registered.hash.slice(0, 12), members: plan.members.length },
      'Team graph definition registered',
    );
    const started = startGraphRun({
      definitionId: def.id,
      ownerUserId: input.ownerUserId,
      groupFolder: input.groupFolder,
      chatJid: input.chatJid,
      goalText: input.goalText,
    });
    if ('error' in started) {
      return { error: started.error };
    }
    const { runId, definition } = started;

    // Detached background execution (mirrors webDeps.startGraphRun).
    buildRunContext(runId, deps).then((ctxRes) => {
      if (!ctxRes) {
        logger.error({ runId }, 'Team start: context build failed');
        return;
      }
      executeGraph(ctxRes.ctx, deps).catch((err) => {
        logger.error({ err, runId }, 'Team graph execution failed');
      });
    });

    logger.info(
      { runId, mermaid: toMermaid(definition).split('\n').slice(0, 4).join(' | ') },
      'Super Agent Team started',
    );
    return {
      runId,
      definitionId: definition.id,
      definitionVersion: definition.version,
      plan,
      memberDefIds,
    };
  } catch (err) {
    return { error: 'register/start failed', detail: (err as Error).message };
  }
}

// Re-export for callers (route/command) that want the prompt/mermaid helpers.
export { buildDecompositionPrompt, computeManifestHash };
