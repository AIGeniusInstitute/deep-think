/**
 * Agent Orchestrator–Workers — plan schema + validation + fallback.
 *
 * The orchestrator (主 Agent 编排者) uses sdkQuery (single LLM turn, no tools)
 * to decompose a complex task into a structured plan that assigns sub-tasks to
 * its already-linked workers (agent_definitions). This module defines the zod
 * schema, validates the LLM output against the linked worker set, and exposes
 * a deterministic fallback plan (sequential dispatch) for when the LLM output
 * is invalid.
 *
 * Mirrors src/agent-team/team-plan.ts, but the "members" are pre-existing
 * agent_definitions (workers) rather than auto-created members — the plan only
 * references workers by id, it never creates them.
 */

import { z } from 'zod';

export const OrchestratorStepSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/, 'step id must be slug-ish (a-z0-9_-)'),
  title: z.string().min(1),
  /** Must be one of the orchestrator's linked worker agent_definitions.id. */
  workerId: z.string().min(1),
  task: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
});

export const OrchestratorPlanSchema = z.object({
  planName: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+/, 'planName must start with slug char'),
  steps: z.array(OrchestratorStepSchema).min(1),
  acceptanceCriteria: z.string().default(''),
});

export type OrchestratorStep = z.infer<typeof OrchestratorStepSchema>;
export type OrchestratorPlan = z.infer<typeof OrchestratorPlanSchema>;

export interface OrchestratorRunInput {
  orchestratorId: string;
  task: string;
  background?: string;
  acceptanceCriteria?: string;
  ownerUserId: string;
  groupFolder: string;
  chatJid: string;
}

export type OrchestratorRunResult = {
  runId: string;
  definitionId: string;
  definitionVersion: number;
  plan: OrchestratorPlan;
};

export type OrchestratorRunError = { error: string; detail?: string };

/** Strip a leading/trailing markdown code fence and extract the JSON object. */
function extractJson(text: string): string {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const first = t.indexOf('{');
  if (first > 0) t = t.slice(first);
  const last = t.lastIndexOf('}');
  if (last >= 0 && last < t.length - 1) t = t.slice(0, last + 1);
  return t;
}

/**
 * Parse + validate a raw LLM string into an OrchestratorPlan, cross-referencing
 * the linked worker set. Returns null on any shape or integrity failure so the
 * caller can retry or fall back.
 */
export function parseOrchestratorPlan(
  raw: string | null,
  workerIdSet: Set<string>,
): OrchestratorPlan | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    return null;
  }
  const result = OrchestratorPlanSchema.safeParse(parsed);
  if (!result.success) return null;

  const plan = result.data;
  const stepIds = new Set(plan.steps.map((s) => s.id));
  for (const step of plan.steps) {
    if (!workerIdSet.has(step.workerId)) return null;
    for (const dep of step.dependsOn) {
      if (!stepIds.has(dep)) return null;
    }
  }

  // Cycle detection (DFS three-color).
  const adj = new Map<string, string[]>();
  for (const s of plan.steps) adj.set(s.id, s.dependsOn);
  const color = new Map<string, number>();
  const dfs = (id: string): boolean => {
    color.set(id, 1);
    for (const next of adj.get(id) ?? []) {
      const c = color.get(next) ?? 0;
      if (c === 1) return true;
      if (c === 0 && dfs(next)) return true;
    }
    color.set(id, 2);
    return false;
  };
  for (const s of plan.steps) {
    if ((color.get(s.id) ?? 0) === 0 && dfs(s.id)) return null;
  }

  return plan;
}

/**
 * Deterministic fallback: dispatch the task sequentially across all workers in
 * link order, each step depending on the previous. Guarantees a valid plan even
 * when the orchestrator LLM output is invalid. (PRD §6 / AC3.1)
 */
export function buildFallbackPlan(
  workerIds: string[],
  task: string,
): OrchestratorPlan {
  const steps: OrchestratorStep[] = workerIds.map((workerId, i) => ({
    id: `step${i + 1}`,
    title: `子任务 ${i + 1}`,
    workerId,
    task:
      i === 0
        ? task
        : `基于前面子任务的产出，继续完成「${task}」中分配给你的部分，产出你的交付物。`,
    dependsOn: i === 0 ? [] : [`step${i}`],
  }));
  return { planName: 'sequential-fallback', steps, acceptanceCriteria: task };
}
