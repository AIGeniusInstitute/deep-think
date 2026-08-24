/**
 * Super Agent Team — Team Plan schema + validation.
 *
 * The Team Builder meta-agent uses sdkQuery (single LLM turn, no tools) to
 * decompose a complex task into a structured TeamPlan JSON. This module
 * defines the zod schema, validates the LLM output, and exposes the parsed
 * plan. On invalid output the Team Builder retries once, then falls back to a
 * single-agent template (PRD AC1.1 / §6 risk).
 *
 * The plan is intentionally a thin overlay on top of the existing
 * GraphDefinition + Agent Definitions systems — members become agent_definition
 * rows, graph nodes become GraphNode[] (agent nodes reference members by name).
 */

import { z } from 'zod';

export const GraphAssertionSchema = z.object({
  kind: z.enum(['contains', 'not_contains', 'regex', 'no_error']),
  // value may be empty for the 'no_error' kind (which checks hadError, not the
  // value text). We drop empty-value non-no_error assertions after parse
  // (a vacuous contains:"" would always pass, weakening the gate).
  value: z.string(),
});

export const TeamMemberSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/, 'member name must be slug-ish (a-z0-9_-)'),
  role: z.string().min(1),
  systemPrompt: z.string().min(10),
  engine: z.enum(['claude', 'atomcode', 'codex', 'opencode', 'pi']).default('claude'),
  model: z.string().nullable().default(null),
  skills: z.array(z.string()).default([]),
  mcpServers: z.array(z.string()).default([]),
  maxTurns: z.number().int().min(1).max(50).default(20),
  deliverable: z.string().default(''),
});

export const TeamGraphNodeSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/, 'node id must be slug-ish'),
  type: z.enum(['agent', 'gate']),
  title: z.string().min(1),
  agentMember: z.string().optional(),
  deliverable: z.string().optional(),
  dependsOn: z.array(z.string()).default([]),
  // gate-only:
  assertions: z.array(GraphAssertionSchema).optional(),
  shellCheck: z.string().optional(),
  successCriteria: z.string().optional(),
  upstreamNodeId: z.string().optional(),
});

export const TeamPlanSchema = z.object({
  teamName: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+/, 'teamName must start with slug char'),
  members: z.array(TeamMemberSchema).min(1),
  graph: z.object({
    nodes: z.array(TeamGraphNodeSchema).min(1),
  }),
  acceptanceCriteria: z.string().default(''),
});

export type TeamPlan = z.infer<typeof TeamPlanSchema>;
export type TeamMember = z.infer<typeof TeamMemberSchema>;
export type TeamGraphNode = z.infer<typeof TeamGraphNodeSchema>;
export type TeamAssertion = z.infer<typeof GraphAssertionSchema>;

export interface TeamTaskInput {
  goalText: string;
  background?: string;
  acceptanceCriteria?: string;
  ownerUserId: string;
  groupFolder: string;
  chatJid: string;
  userLanguage?: string;
  /**
   * v2 (TeamPage UI): max team member count. When set and the decomposed plan
   * exceeds it, buildTeam caps members (preserving any member referenced by a
   * graph node via dependency closure). Missing → no cap (backward compat).
   */
  maxTeamSize?: number;
  /**
   * v2 (TeamPage UI): allowed skill/mcp id allow-list. When set, buildTeam
   * filters each member's skills/mcpServers to this set. Missing → no filter.
   */
  toolset?: string[];
  /**
   * v2 (TeamPage UI): 'semi-auto' inserts a human approval gate after each
   * agent node (串入依赖链, blocks downstream until approved). 'auto' (default)
   * = no extra gates. Missing → 'auto' (backward compat).
   */
  executionMode?: 'auto' | 'semi-auto';
  /**
   * Agent Workflow editor (mode B): when true, buildTeam performs decompose +
   * create members + assemble + register the graph definition but does NOT
   * start a run. Instead it returns the definitionId + plan so the visual
   * editor can load the draft for per-node editing before the user explicitly
   * runs it. Missing → false (legacy "build and immediately run" behavior).
   */
  draft?: boolean;
}

export interface TeamBuildResult {
  /** Present only when draft=false (default). Draft mode registers a
   * definition but does not start a run, so runId is omitted. */
  runId?: string;
  definitionId: string;
  definitionVersion: number;
  plan: TeamPlan;
  memberDefIds: Record<string, string>;
  draft?: boolean;
}

export interface TeamBuildError {
  error: string;
  detail?: string;
}

/**
 * Parse + validate a raw LLM string into a TeamPlan. Tolerates a leading
 * ```json fence (strips it). Returns null on any validation failure so the
 * caller can retry or fall back.
 */
export function parseTeamPlan(raw: string | null): TeamPlan | null {
  if (!raw) return null;
  let text = raw.trim();
  // Strip markdown code fences if the model wrapped the JSON.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  // Extract the outermost JSON object if there's surrounding prose.
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace > 0) text = text.slice(firstBrace);
  if (lastBrace >= 0 && lastBrace < text.length - 1) text = text.slice(0, lastBrace + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const result = TeamPlanSchema.safeParse(parsed);
  if (!result.success) return null;
  // Normalize: drop empty-value assertions for non-no_error kinds (a vacuous
  // contains:"" / regex:"" would always pass, weakening the gate). Tolerates
  // LLM-produced empty values without rejecting the whole plan.
  for (const node of result.data.graph.nodes) {
    if (node.assertions) {
      node.assertions = node.assertions.filter(
        (a) => a.kind === 'no_error' || a.value.length > 0,
      );
      if (node.assertions.length === 0) delete node.assertions;
    }
  }
  if (!validatePlanIntegrity(result.data)) return null;
  return result.data;
}

/**
 * Cross-reference integrity checks beyond zod shape (PRD AC1.1): every agent
 * node's agentMember must exist in members; dependsOn must reference existing
 * node ids; no cycles; at least one agent node.
 */
export function validatePlanIntegrity(plan: TeamPlan): boolean {
  const memberNames = new Set(plan.members.map((m) => m.name));
  const nodeIds = new Set(plan.graph.nodes.map((n) => n.id));
  let hasAgent = false;
  for (const node of plan.graph.nodes) {
    if (node.type === 'agent') {
      hasAgent = true;
      if (!node.agentMember || !memberNames.has(node.agentMember)) return false;
    }
    for (const dep of node.dependsOn) {
      if (!nodeIds.has(dep)) return false;
    }
  }
  if (!hasAgent) return false;
  // Cycle detection (DFS three-color).
  const adj = new Map<string, string[]>();
  for (const n of plan.graph.nodes) adj.set(n.id, n.dependsOn);
  const color = new Map<string, number>(); // 0=white,1=gray,2=black
  const dfs = (id: string): boolean => {
    color.set(id, 1);
    for (const next of adj.get(id) ?? []) {
      const c = color.get(next) ?? 0;
      if (c === 1) return true; // back edge → cycle
      if (c === 0 && dfs(next)) return true;
    }
    color.set(id, 2);
    return false;
  };
  for (const n of plan.graph.nodes) {
    if ((color.get(n.id) ?? 0) === 0 && dfs(n.id)) return false;
  }
  return true;
}
