/**
 * Multi-User Collaboration Builder (multi-user-collaboration module).
 *
 * buildCollaboration(input, deps): wraps team-builder's buildTeam with a
 * collaboration mode + scenario preset, persists a `collaborations` row, and
 * after the graph run completes persists the shared artifacts (per-node
 * deliverables + manifest + final deliverable + shared memory file) into the
 * shared group workspace folder `data/groups/{folder}/collaborations/{collabId}/`
 * so all group members (owner + group_members) can read them via
 * /api/collaborations/:id/deliverables.
 *
 * Reuse (Simplicity First): the heavy lifting — decompose (mode-aware prompt)
 * → create member agent_definitions → assemble GraphDefinition → register →
 * startGraphRun + detached executeGraph — is 100% delegated to buildTeam.
 * This module adds only: scenario preset, collaboration row, shared-artifact
 * persistence, and a detached run-completion poller.
 */

import { logger } from '../logger.js';
import {
  completeCollaboration,
  failCollaboration,
  getGraphRun,
  listGraphNodeRuns,
} from '../db.js';
import { getFileRoot } from '../file-manager.js';
import { buildTeam } from './team-builder.js';
import { SCENARIO_PRESETS } from './team-prompt.js';
import type { GraphDeps } from '../graph-engineering/graph-runner.js';
import type { TeamTaskInput, TeamBuildResult, TeamBuildError, TeamPlan } from './team-plan.js';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

export type CollaborationMode = 'orchestrator-worker' | 'peer' | 'critic-adversarial';

export interface CollaborationInput {
  goalText: string;
  background?: string;
  acceptanceCriteria?: string;
  mode: CollaborationMode;
  scenario?: string;
  ownerUserId: string;
  groupFolder: string;
  chatJid: string;
  collaborationId: string;
  userLanguage?: string;
  maxTeamSize?: number;
  toolset?: string[];
  executionMode?: 'auto' | 'semi-auto';
}

export interface CollaborationBuildResult {
  collabId: string;
  runId: string;
  definitionId: string;
  plan: TeamPlan;
  mode: CollaborationMode;
}

export interface CollaborationBuildError {
  error: string;
  detail?: string;
}

/**
 * Apply a scenario preset: when `scenario` is set and the preset exists, fill
 * goalText/acceptanceCriteria/mode from the preset for any field the caller
 * left empty. Caller-supplied non-empty fields take precedence (user override).
 * Returns a new input (does not mutate the caller's object).
 */
export function applyScenario(input: CollaborationInput): CollaborationInput {
  if (!input.scenario) return input;
  const preset = SCENARIO_PRESETS[input.scenario];
  if (!preset) return input;
  return {
    ...input,
    goalText: input.goalText?.trim() ? input.goalText : preset.goalText,
    acceptanceCriteria: input.acceptanceCriteria?.trim()
      ? input.acceptanceCriteria
      : preset.acceptanceCriteria,
    mode: input.mode ?? preset.recommendedMode,
  };
}

/**
 * Resolve the shared artifacts directory for a collaboration. Pure: only
 * computes the path; the caller ensures it exists.
 */
export function collaborationDir(groupFolder: string, collabId: string): string {
  return `${getFileRoot(groupFolder)}/collaborations/${collabId}`;
}

/**
 * Persist shared artifacts after a collaboration run reaches a terminal
 * status. Idempotent: re-running overwrites the same files safely.
 *
 * Reads graph_node_runs for the run, writes one deliverable file per node
 * (content = output_summary or error), a manifest.json listing all nodes, and
 * a final-deliverable.md from the terminal node's output. Writes to the shared
 * group workspace folder so all group members can read it via the API.
 */
export function persistSharedArtifacts(
  groupFolder: string,
  collabId: string,
  runId: string,
  plan: TeamPlan | null,
): void {
  const dir = collaborationDir(groupFolder, collabId);
  const deliverablesDir = `${dir}/deliverables`;
  mkdirSync(deliverablesDir, { recursive: true });
  mkdirSync(`${dir}/peer`, { recursive: true });

  const nodeRuns = listGraphNodeRuns(runId);
  const roleByMember = new Map((plan?.members ?? []).map((m) => [m.name, m.role]));
  const titleByNodeId = new Map((plan?.graph.nodes ?? []).map((n) => [n.id, n.title]));
  const memberByNodeId = new Map(
    (plan?.graph.nodes ?? []).filter((n) => n.type === 'agent').map((n) => [n.id, n.agentMember]),
  );

  // Build the set of node ids that are terminal (no other node depends on them).
  const allNodeIds = new Set(nodeRuns.map((r) => r.node_id));
  const dependedUpon = new Set<string>();
  // We don't have edges here; use the plan's dependsOn to infer terminal nodes.
  for (const n of plan?.graph.nodes ?? []) {
    for (const dep of n.dependsOn ?? []) dependedUpon.add(dep);
  }

  const manifest: Array<{
    nodeId: string;
    nodeType: string;
    member: string | null;
    role: string | null;
    title: string;
    status: string;
    file: string | null;
  }> = [];

  let finalOutput = '';
  let finalNodeId: string | null = null;

  for (const r of nodeRuns) {
    const member = memberByNodeId.get(r.node_id) ?? null;
    const role = member ? (roleByMember.get(member) ?? null) : null;
    const title = titleByNodeId.get(r.node_id) ?? r.node_id;
    const isTerminal = !dependedUpon.has(r.node_id);
    const content =
      r.output_summary ??
      (r.error ? `[节点失败] ${r.error}` : `（节点 ${r.node_id} 无输出摘要）`);

    // Write deliverable file for agent/gate nodes with output.
    let file: string | null = null;
    if (r.status === 'completed' || r.status === 'failed') {
      file = `${deliverablesDir}/${r.node_id}.md`;
      const header = `# ${title}\n\n- 节点: \`${r.node_id}\` (${r.node_type})\n- 成员: ${member ?? '—'}${role ? `（${role}）` : ''}\n- 状态: ${r.status}\n\n---\n\n`;
      writeFileSync(file, header + content);
    }

    manifest.push({
      nodeId: r.node_id,
      nodeType: r.node_type,
      member,
      role,
      title,
      status: r.status,
      file: file ? `${r.node_id}.md` : null,
    });

    if (isTerminal && r.output_summary) {
      finalOutput = content;
      finalNodeId = r.node_id;
    }
  }

  writeFileSync(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2));
  if (finalOutput) {
    writeFileSync(
      `${dir}/final-deliverable.md`,
      `# 最终交付物\n\n协作 ${collabId} 终态节点 ${finalNodeId} 产出。\n\n---\n\n${finalOutput}`,
    );
  }

  // Ensure the shared memory file exists so members can append to it.
  const memPath = `${dir}/shared-memory.md`;
  if (!existsSync(memPath)) {
    writeFileSync(memPath, `# 协作共享记忆 · ${collabId}\n\n全体协作成员可在此累积协作要点、决策与待办。\n\n`);
  }

  logger.info({ collabId, runId, nodes: nodeRuns.length }, 'collaboration shared artifacts persisted');
}

/**
 * Build (or fail) a collaboration: apply scenario → buildTeam (mode-aware
 * decompose + members + graph + register + start + detached execute) →
 * completeCollaboration row → detached poller persists shared artifacts on run
 * completion. The caller (route) returns immediately with the collabId.
 */
export async function buildCollaboration(
  input: CollaborationInput,
  deps: GraphDeps,
): Promise<CollaborationBuildResult | CollaborationBuildError> {
  if (!input.goalText?.trim()) return { error: 'goalText is required' };
  if (!input.ownerUserId || !input.groupFolder || !input.chatJid || !input.collaborationId) {
    return { error: 'ownerUserId/groupFolder/chatJid/collaborationId are required' };
  }

  // 1. Apply scenario preset (fills empty goal/criteria from preset).
  const resolved = applyScenario(input);

  // 2. Delegate to buildTeam with the mode + collaborationId injected. buildTeam
  //    uses buildDecompositionPromptByMode (peer/critic branches) + the generic
  //    assembleGraphDefinition (which handles agent/gate + dependsOn/shellCheck/
  //    assertions/upstreamNodeId for all three topologies).
  const teamInput: TeamTaskInput = {
    goalText: resolved.goalText,
    background: resolved.background,
    acceptanceCriteria: resolved.acceptanceCriteria,
    ownerUserId: resolved.ownerUserId,
    groupFolder: resolved.groupFolder,
    chatJid: resolved.chatJid,
    userLanguage: resolved.userLanguage ?? 'zh-CN',
    maxTeamSize: resolved.maxTeamSize,
    toolset: resolved.toolset,
    executionMode: resolved.executionMode,
    mode: resolved.mode,
    scenario: resolved.scenario,
    collaborationId: resolved.collaborationId,
  };

  let result: TeamBuildResult | TeamBuildError;
  try {
    result = await buildTeam(teamInput, deps);
  } catch (err) {
    return { error: 'buildTeam threw', detail: (err as Error).message };
  }

  if ('error' in result) {
    return { error: result.error, detail: result.detail };
  }

  // draft mode: no runId. Collaborations always run (no draft path), so this
  // is a defensive guard — if draft somehow set, surface an error rather than
  // claiming success without a run.
  if (!result.runId) {
    return { error: 'buildTeam returned draft (no runId); collaborations require a run' };
  }

  // 3. Persist the shared artifacts directory scaffold now (peer/ deliverables/).
  mkdirSync(collaborationDir(resolved.groupFolder, resolved.collaborationId), {
    recursive: true,
  });

  // 4. Launch a detached poller that waits for the graph run to reach a terminal
  //    status, then persists shared artifacts. Mirrors buildTeam's detached
  //    executeGraph pattern: fire-and-forget, errors logged not thrown.
  const runId = result.runId;
  const collabId = resolved.collaborationId;
  const groupFolder = resolved.groupFolder;
  pollRunAndPersist(collabId, runId, groupFolder, result.plan).catch((err) => {
    logger.error({ err, collabId, runId }, 'collaboration artifact poller failed');
  });

  return {
    collabId,
    runId,
    definitionId: result.definitionId,
    plan: result.plan,
    mode: resolved.mode,
  };
}

const POLL_INTERVAL_MS = 5000;
const POLL_MAX_ATTEMPTS = 360; // ~30 min cap

/**
 * Detached poller: wait for graph run terminal status, then persist shared
 * artifacts. Self-terminates on terminal status or after the attempt cap.
 */
async function pollRunAndPersist(
  collabId: string,
  runId: string,
  groupFolder: string,
  plan: TeamPlan,
): Promise<void> {
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const run = getGraphRun(runId);
    if (!run) continue; // run row may not be visible immediately
    if (
      run.status === 'completed' ||
      run.status === 'failed' ||
      run.status === 'cancelled'
    ) {
      try {
        persistSharedArtifacts(groupFolder, collabId, runId, plan);
      } catch (err) {
        logger.error({ err, collabId, runId }, 'persistSharedArtifacts threw');
      }
      return;
    }
  }
  logger.warn({ collabId, runId }, 'collaboration artifact poller hit attempt cap');
}
