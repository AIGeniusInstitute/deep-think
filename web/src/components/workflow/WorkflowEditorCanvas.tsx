/**
 * Editable DAG canvas for the Agent Workflow editor.
 *
 * Unlike GraphDagView (read-only run view), this canvas is driven by the
 * workflow-editor store in controlled mode: applyNodeChanges/onConnect/
 * onNodesDelete flow back so the user can drag, connect, and delete. A custom
 * 'workflowNode' type renders the node card (title + type color + agent-binding
 * badge). Drop from NodePalette is handled via onDrop reading dataTransfer.
 *
 * Reuses @xyflow/react (already a dependency). Lazy-loaded to keep the ~200KB
 * bundle out of the initial page weight (mirrors GraphDagView).
 */
import { useRef, useCallback, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import type { Node, Connection, NodeProps } from '@xyflow/react';
import {
  ReactFlow,
  Controls,
  Background,
  MiniMap,
  MarkerType,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useWorkflowEditorStore, type WorkflowNodeData } from '../../stores/workflow-editor';
import { NODE_TYPE_COLORS, NODE_TYPE_LABEL_ZH } from './workflow-constants';
import type { GraphNodeType } from './workflow-constants';

function WorkflowNodeCard({ id, data, selected }: NodeProps) {
  const d = data as WorkflowNodeData;
  const color = NODE_TYPE_COLORS[d.type] ?? '#64748b';
  const label = NODE_TYPE_LABEL_ZH[d.type] ?? d.type;
  const agentBound = d.type === 'agent' && !!d.agentDefId;
  const title = d.title || d.id;
  return (
    <div
      className="px-3 py-2 rounded-md border-2 bg-white text-xs min-w-[120px]"
      style={{
        borderColor: selected ? '#2563eb' : color,
        boxShadow: selected ? '0 0 0 3px rgba(37,99,235,0.35)' : undefined,
      }}
    >
      <div className="flex items-center gap-1.5">
        <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-[10px] uppercase text-slate-500">{label}</span>
      </div>
      <div className="mt-1 max-w-[150px] truncate text-slate-800 font-medium">{title}</div>
      {d.type === 'agent' && (
        <div className={`mt-0.5 text-[9px] ${agentBound ? 'text-emerald-600' : 'text-amber-600'}`}>
          {agentBound ? '● 已绑定 Agent' : '○ 未绑定 Agent'}
        </div>
      )}
      <div className="mt-0.5 text-[9px] text-slate-400">{id}</div>
    </div>
  );
}

const nodeTypes = { workflowNode: WorkflowNodeCard };

interface CanvasProps {
  children?: ReactNode;
}

export function WorkflowEditorCanvas({ children }: CanvasProps) {
  const nodes = useWorkflowEditorStore((s) => s.nodes);
  const edges = useWorkflowEditorStore((s) => s.edges);
  const applyNodeChanges = useWorkflowEditorStore((s) => s.applyNodeChanges);
  const applyEdgeChanges = useWorkflowEditorStore((s) => s.applyEdgeChanges);
  const onConnect = useWorkflowEditorStore((s) => s.onConnect);
  const addNode = useWorkflowEditorStore((s) => s.addNode);
  const removeNode = useWorkflowEditorStore((s) => s.removeNode);
  const setSelected = useWorkflowEditorStore((s) => s.setSelected);
  const removeEdge = useWorkflowEditorStore((s) => s.removeEdge);

  const wrapperRef = useRef<HTMLDivElement>(null);

  // Drop from the palette: read the node type from dataTransfer and place it
  // at the projected cursor position.
  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData('application/workflow-node') as GraphNodeType;
      if (!type) return;
      const bounds = wrapperRef.current?.getBoundingClientRect();
      const position = bounds
        ? { x: event.clientX - bounds.left - 60, y: event.clientY - bounds.top - 20 }
        : { x: 80, y: 80 };
      addNode(type, position);
    },
    [addNode],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  // Empty-state hint rendered as an overlay INSIDE the wrapper (not an early
  // return). The wrapper carries onDrop/onDragOver; if we early-returned a
  // bare placeholder div (as before), the empty canvas had no drop target and
  // HTML5 DnD rejected the very first node drag. pointer-events-none keeps the
  // overlay from swallowing the drop, which must land on the wrapper.
  const isEmpty = !nodes.length && !children;

  return (
    <div ref={wrapperRef} className="flex-1 min-h-0 relative" onDrop={onDrop} onDragOver={onDragOver}>
      {isEmpty && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center text-muted-foreground p-8">
          <p className="text-sm">从左侧拖拽节点到这里开始编排</p>
          <p className="text-xs mt-1 text-muted-foreground/70">支持 Agent / 验收门 / 分支 / 人工等节点</p>
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={applyNodeChanges}
        onEdgesChange={applyEdgeChanges}
        onConnect={onConnect}
        onNodeClick={(_, node) => setSelected(node.id)}
        onPaneClick={() => setSelected(null)}
        onNodesDelete={(deleted) => deleted.forEach((n) => removeNode(n.id))}
        onEdgesDelete={(deleted) => deleted.forEach((e) => removeEdge(e.id))}
        defaultEdgeOptions={{
          style: { stroke: '#94a3b8', strokeWidth: 1.5 },
          markerEnd: { type: MarkerType.ArrowClosed },
        }}
        nodesDraggable
        nodesConnectable
        fitView
        proOptions={{ hideAttribution: true }}
        className="bg-muted/20"
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls />
        <MiniMap pannable zoomable className="!bg-white" />
      </ReactFlow>
    </div>
  );
}

/** Lazy wrapper so the ~200KB ReactFlow bundle only loads when the editor opens. */
export function WorkflowEditorCanvasLoader() {
  return (
    <div className="flex items-center justify-center h-full">
      <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
    </div>
  );
}

export type { Node };
export type { Connection };
