/**
 * DataFlowEdge — custom React Flow edge with an animated "data packet"
 * traveling along the path. Used for live (taken) edges so the canvas
 * visibly shows data flowing between nodes (PRD AC6.2 data-flow animation).
 *
 * No external deps — pure SVG via @xyflow/react's getBezierPath + a CSS
 * keyframe injected once on module load.
 */
import { memo } from 'react';
import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';

let styleInjected = false;
function ensureStyle() {
  if (styleInjected || typeof document === 'undefined') return;
  const css = `
@keyframes dthink-dataflow {
  0% { stroke-dashoffset: 24; }
  100% { stroke-dashoffset: 0; }
}
.dthink-dataflow-edge {
  stroke-dasharray: 6 6;
  animation: dthink-dataflow 0.9s linear infinite;
}
.dthink-dataflow-dot {
  animation: dthink-dataflow-move 1.2s linear infinite;
}
@keyframes dthink-dataflow-move {
  0% { offset-distance: 0%; }
  100% { offset-distance: 100%; }
}
`;
  const el = document.createElement('style');
  el.setAttribute('data-dthink-dataflow', '1');
  el.textContent = css;
  document.head.appendChild(el);
  styleInjected = true;
}

export const DataFlowEdge = memo(function DataFlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  data,
}: EdgeProps) {
  ensureStyle();
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const active = (data as { active?: boolean })?.active;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          ...style,
          ...(active ? { stroke: '#3b82f6', strokeWidth: 2 } : {}),
        }}
        className={active ? 'dthink-dataflow-edge' : undefined}
      />
      {active && (
        <circle r={3.5} fill="#3b82f6">
          <animateMotion dur="1.2s" repeatCount="indefinite" path={path} />
        </circle>
      )}
    </>
  );
});
