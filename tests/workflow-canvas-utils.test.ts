import { describe, expect, test } from 'vitest';

import {
  getWorkflowNodeHandleVisibility,
  hasCompleteWorkflowNodePositions,
  isWorkflowCanvasPoint,
  projectWorkflowDropPosition,
} from '../web/src/components/workflow/workflow-canvas-utils';

describe('workflow canvas interactions', () => {
  test('projects browser coordinates through the current pan and zoom before centring the node', () => {
    const result = projectWorkflowDropPosition({ x: 500, y: 300 }, ({ x, y }) => ({
      x: (x - 200) / 2,
      y: (y - 100) / 2,
    }));

    expect(result).toEqual({ x: 90, y: 80 });
  });

  test('uses directional handles for start and end nodes', () => {
    expect(getWorkflowNodeHandleVisibility('start')).toEqual({ source: true, target: false });
    expect(getWorkflowNodeHandleVisibility('end')).toEqual({ source: false, target: true });
    expect(getWorkflowNodeHandleVisibility('agent')).toEqual({ source: true, target: true });
  });

  test('recognizes complete persisted node positions', () => {
    expect(isWorkflowCanvasPoint({ x: -120.5, y: 840 })).toBe(true);
    expect(isWorkflowCanvasPoint({ x: Number.NaN, y: 20 })).toBe(false);
    expect(isWorkflowCanvasPoint({ x: 10 })).toBe(false);

    expect(
      hasCompleteWorkflowNodePositions([
        { position: { x: 420, y: 90 } },
        { position: { x: -35, y: 510 } },
      ]),
    ).toBe(true);
  });

  test('requests a fallback layout when a legacy node has no valid position', () => {
    expect(
      hasCompleteWorkflowNodePositions([
        { position: { x: 420, y: 90 } },
        {},
      ]),
    ).toBe(false);
    expect(
      hasCompleteWorkflowNodePositions([
        { position: { x: 420, y: 90 } },
        { position: { x: '35', y: 510 } },
      ]),
    ).toBe(false);
  });
});
