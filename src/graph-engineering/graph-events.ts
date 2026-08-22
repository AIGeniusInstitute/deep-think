/**
 * Graph Events — thin constructors for the graph_* StreamEvent variants.
 *
 * The orchestrator calls these at graph / node / edge lifecycle boundaries;
 * they build the event payload and forward it via deps.broadcastStreamEvent
 * over WebSocket so the frontend canvas can render status changes with < 2s
 * latency (DSL v2 full-chain visibility — replaces the 5s polling fallback).
 *
 * Kept dependency-free (only types) so it is unit-testable and never blocks
 * control flow: every call is wrapped in try/catch by the caller.
 *
 * See docs/tech_solution/graph-task-planning-execution/SOLUTION.md §6.1.
 */

import type { GraphNode } from './graph-types.js';
import type { StreamEvent } from '../stream-event.types.js';

export function graphStartEvent(
  runId: string,
  definitionId: string,
  nodeCount: number,
): StreamEvent {
  return {
    eventType: 'graph_start',
    displayLevel: 'primary',
    agentScope: 'system',
    graphEvent: { runId, definitionId, totalTokens: 0, totalCostUsd: 0 },
    summary: `graph run ${runId} started (${nodeCount} nodes)`,
  };
}

export function graphNodeStartEvent(runId: string, node: GraphNode): StreamEvent {
  return {
    eventType: 'graph_node_start',
    displayLevel: 'detail',
    agentScope: 'system',
    graphEvent: {
      runId,
      nodeId: node.id,
      nodeType: node.type,
      title: node.title,
      status: 'running',
    },
  };
}

export function graphNodeStatusEvent(
  runId: string,
  node: GraphNode,
  status: string,
  meta?: { tokens?: number; costUsd?: number; output?: string; error?: string },
): StreamEvent {
  return {
    eventType: 'graph_node_status',
    displayLevel: 'detail',
    agentScope: 'system',
    graphEvent: {
      runId,
      nodeId: node.id,
      nodeType: node.type,
      title: node.title,
      status,
      tokens: meta?.tokens,
      costUsd: meta?.costUsd,
      output: meta?.output?.slice(0, 500),
      error: meta?.error,
    },
  };
}

export function graphNodeEndEvent(
  runId: string,
  node: GraphNode,
  status: string,
  meta?: { tokens?: number; costUsd?: number; durationMs?: number; output?: string; error?: string },
): StreamEvent {
  return {
    eventType: 'graph_node_end',
    displayLevel: 'detail',
    agentScope: 'system',
    graphEvent: {
      runId,
      nodeId: node.id,
      nodeType: node.type,
      title: node.title,
      status,
      tokens: meta?.tokens,
      costUsd: meta?.costUsd,
      durationMs: meta?.durationMs,
      output: meta?.output?.slice(0, 500),
      error: meta?.error,
    },
  };
}

export function graphEdgeTakenEvent(
  runId: string,
  fromNodeId: string,
  toNodeId: string,
  edgeId: string,
  edgeLabel?: string,
): StreamEvent {
  return {
    eventType: 'graph_edge_taken',
    displayLevel: 'debug',
    agentScope: 'system',
    graphEvent: { runId, fromNodeId, toNodeId, edgeId, edgeLabel },
  };
}

export function graphEndEvent(
  runId: string,
  status: string,
  meta?: { totalTokens?: number; totalCostUsd?: number; durationMs?: number; error?: string },
): StreamEvent {
  return {
    eventType: 'graph_end',
    displayLevel: 'primary',
    agentScope: 'system',
    graphEvent: {
      runId,
      status,
      totalTokens: meta?.totalTokens,
      totalCostUsd: meta?.totalCostUsd,
      durationMs: meta?.durationMs,
      error: meta?.error,
    },
    summary: `graph run ${runId} ${status}`,
  };
}
