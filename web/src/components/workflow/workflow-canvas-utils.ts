import type { GraphNodeType } from './workflow-constants';

export interface CanvasPoint {
  x: number;
  y: number;
}

/** A persisted position is usable only when both coordinates are finite numbers. */
export function isWorkflowCanvasPoint(value: unknown): value is CanvasPoint {
  if (!value || typeof value !== 'object') return false;
  const point = value as Record<string, unknown>;
  return (
    typeof point.x === 'number' &&
    Number.isFinite(point.x) &&
    typeof point.y === 'number' &&
    Number.isFinite(point.y)
  );
}

/**
 * Legacy definitions may not contain positions. Auto-layout only those graphs;
 * a fully positioned graph must retain the user's manual layout when reopened.
 */
export function hasCompleteWorkflowNodePositions(
  nodes: Array<{ position?: unknown }>,
): boolean {
  return nodes.every((node) => isWorkflowCanvasPoint(node.position));
}

const WORKFLOW_NODE_HALF_WIDTH = 60;
const WORKFLOW_NODE_HALF_HEIGHT = 20;

/**
 * Keep the dropped card centred below the pointer after React Flow accounts
 * for the current viewport translation and zoom.
 */
export function projectWorkflowDropPosition(
  clientPoint: CanvasPoint,
  screenToFlowPosition: (point: CanvasPoint) => CanvasPoint,
): CanvasPoint {
  const flowPoint = screenToFlowPosition(clientPoint);
  return {
    x: flowPoint.x - WORKFLOW_NODE_HALF_WIDTH,
    y: flowPoint.y - WORKFLOW_NODE_HALF_HEIGHT,
  };
}

/** Start nodes only emit edges; end nodes only receive them. */
export function getWorkflowNodeHandleVisibility(type: GraphNodeType): {
  source: boolean;
  target: boolean;
} {
  return {
    source: type !== 'end',
    target: type !== 'start',
  };
}
