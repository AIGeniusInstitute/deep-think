/**
 * Graph Scheduler — pure topology logic: ready-queue derivation, fan-out /
 * fan-in, conditional branch routing, retry budget.
 *
 * Stateless over the DB: takes a definition + completed-set + branch decisions,
 * returns the next batch of ready nodes. The orchestrator (graph-orchestrator.ts)
 * owns persistence and concurrency. This separation keeps the scheduling logic
 * testable without spinning up agents (TC1-5, TC14).
 *
 * See SOLUTION.md §4 for the algorithm.
 */

import type { GraphDefinition, GraphEdge, GraphNode } from './graph-types.js';
import type { EvalContext } from './graph-expr.js';
import { evalCondition } from './graph-expr.js';

/** Get all predecessors (incoming edges) of a node. */
function predecessors(def: GraphDefinition, nodeId: string): GraphEdge[] {
  return def.edges.filter((e) => e.to === nodeId);
}

/** All outgoing edges of a node (siblings), used for default-edge fallback logic. */
function outgoing(def: GraphDefinition, nodeId: string): GraphEdge[] {
  return def.edges.filter((e) => e.from === nodeId);
}

/** Source nodes (no incoming edges) — initial ready set. */
export function sourceNodes(def: GraphDefinition): GraphNode[] {
  const hasIncoming = new Set(def.edges.map((e) => e.to));
  return def.nodes.filter((n) => !hasIncoming.has(n.id));
}

/**
 * Is a single edge "active" (its data/control may flow)? An edge is active iff:
 *  - its source is completed, AND
 *  - for a plain edge (no condition/expression/default): always active once source completed;
 *  - for an `expression` edge: the expression evaluates truthy against evalCtx;
 *  - for a `condition` edge (legacy branch string equality): branchDecisions[from] === condition;
 *  - for a `default` edge: NONE of the sibling conditional edges (same `from`)
 *    are active — i.e. it is the fallback when no condition/expression matched.
 *
 * @param evalCtx  when null, expression/default edges degrade to legacy behavior
 *                 (expression treated as always-active, default ignored). This
 *                 keeps the scheduler unit-testable without a full runtime
 *                 context while preserving backward compatibility for callers
 *                 that haven't built an EvalContext.
 */
function edgeActive(
  edge: GraphEdge,
  def: GraphDefinition,
  completed: Set<string>,
  branchDecisions: Map<string, string>,
  evalCtx: EvalContext | null,
): boolean {
  if (!completed.has(edge.from)) return false;
  // Plain edge.
  if (!edge.condition && !edge.expression && !edge.isDefault) return true;

  // Expression edge: evaluate against the runtime context.
  if (edge.expression) {
    if (!evalCtx) return true; // degrade: no context → treat as active (legacy callers)
    return evalCondition(edge.expression, evalCtx);
  }
  // Legacy condition edge: string equality against recorded branch decision.
  if (edge.condition) {
    return branchDecisions.get(edge.from) === edge.condition;
  }
  // Default edge: active iff no sibling conditional edge is active.
  if (edge.isDefault) {
    if (!evalCtx) return false; // no context → default edges never activate (legacy)
    for (const sib of outgoing(def, edge.from)) {
      if (sib.isDefault) continue;
      if (edgeActive(sib, def, completed, branchDecisions, evalCtx)) return false;
    }
    return true;
  }
  return true;
}

/**
 * Compute the set of node ids that are ready to run.
 * A node is ready iff every incoming edge is active (source completed + any
 * conditional/default routing condition satisfied).
 *
 * @param completed  node ids that reached 'completed'
 * @param branchDecisions  branchNodeId → chosen condition value (legacy)
 * @param evalCtx  runtime context for expression/default edges (optional, backward compat)
 */
export function computeReadyNodes(
  def: GraphDefinition,
  completed: Set<string>,
  branchDecisions: Map<string, string>,
  evalCtx: EvalContext | null = null,
): GraphNode[] {
  const ready: GraphNode[] = [];
  for (const node of def.nodes) {
    if (completed.has(node.id)) continue;
    const preds = predecessors(def, node.id);
    if (preds.length === 0) {
      // source node — ready only if not completed (handles resume skip)
      ready.push(node);
      continue;
    }
    let allSatisfied = true;
    for (const edge of preds) {
      if (!edgeActive(edge, def, completed, branchDecisions, evalCtx)) {
        allSatisfied = false;
        break;
      }
    }
    if (allSatisfied) ready.push(node);
  }
  return ready;
}

/**
 * Edges that were "taken" in this scheduling step — the conditional/default
 * edges whose source just completed and whose condition matched. Emitted as
 * `graph_edge_taken` stream events by the orchestrator for the data-flow view.
 */
export function takenEdges(
  def: GraphDefinition,
  newlyCompleted: GraphNode[],
  completed: Set<string>,
  branchDecisions: Map<string, string>,
  evalCtx: EvalContext | null = null,
): GraphEdge[] {
  const result: GraphEdge[] = [];
  for (const node of newlyCompleted) {
    for (const edge of outgoing(def, node.id)) {
      if (edgeActive(edge, def, completed, branchDecisions, evalCtx)) {
        result.push(edge);
      }
    }
  }
  return result;
}

/**
 * Pick up to `maxParallel` nodes from the ready list, respecting a global
 * concurrency ceiling (TC14 — never exceed MAX_CONCURRENT_*).
 *
 * @param globalSlots  available global concurrency slots (MAX_CONCURRENT_* -
 *                     currently in-flight agent processes). The orchestrator
 *                     tracks this; scheduler just won't over-subscribe.
 */
export function nextReadyBatch(
  ready: GraphNode[],
  maxParallel: number,
  globalSlots: number,
): GraphNode[] {
  const limit = Math.max(0, Math.min(maxParallel, globalSlots, ready.length));
  return ready.slice(0, limit);
}

/** True iff every node is completed (run finished successfully). */
export function allCompleted(def: GraphDefinition, completed: Set<string>): boolean {
  return def.nodes.every((n) => completed.has(n.id));
}

/**
 * Downstream node ids of a given node (transitive), used by rerun: resetting
 * a node invalidates its downstream so the scheduler re-derives them.
 */
export function downstreamNodeIds(def: GraphDefinition, nodeId: string): Set<string> {
  const result = new Set<string>();
  const stack = [nodeId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const edge of def.edges) {
      if (edge.from === cur && !result.has(edge.to)) {
        result.add(edge.to);
        stack.push(edge.to);
      }
    }
  }
  return result;
}

/** Validate that a branch node has matching outgoing conditional edges. */
export function branchEdgeCoverage(def: GraphDefinition): string[] {
  const errors: string[] = [];
  for (const n of def.nodes) {
    if (n.type !== 'branch') continue;
    const out = def.edges.filter((e) => e.from === n.id);
    const conds = out.map((e) => e.condition).filter(Boolean) as string[];
    if (new Set(conds).size !== conds.length) {
      errors.push(`branch node ${n.id}: duplicate conditional edge values`);
    }
  }
  return errors;
}
