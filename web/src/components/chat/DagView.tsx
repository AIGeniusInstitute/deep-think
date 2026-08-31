/**
 * DAG visualization canvas for chat trace nodes.
 *
 * Uses @xyflow/react (reactflow 12) with dynamic import so the ~200KB dep
 * only loads when the user opens the "执行 DAG" sidebar tab.
 *
 * Nodes are sourced from the chat store's `traceNodes[jid]` array, which is
 * populated by stream events (live) and /api/groups/:jid/trace/nodes (initial
 * load). Click a node to open the detail panel (DagNodeDetail) which shows
 * full context state and supports editing input/output annotations, rerun,
 * and continue-from-here.
 */

import { useEffect, useMemo, useState, lazy, Suspense } from 'react';
import { Workflow, Loader2, RefreshCw } from 'lucide-react';
import { useChatStore, type TraceNodeEntry } from '../../stores/chat';
import { DagNodeDetail } from './DagNodeDetail';
import type { Node, Edge, NodeMouseHandler } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// Dynamic import — reactflow is ~200KB gzip, only load when canvas is opened.
// Wraps ReactFlow + Controls + Background + MiniMap in a single lazy component
// so they share one dynamic chunk and keep all @xyflow/react value imports
// (MarkerType enum, etc.) inside the lazy boundary.
const FlowCanvas = lazy(async () => {
  const { ReactFlow, Controls, Background, MiniMap, MarkerType } = await import('@xyflow/react');
  const Component = ({
    nodes,
    edges,
    onNodeClick,
  }: {
    nodes: Node[];
    edges: Edge[];
    onNodeClick: NodeMouseHandler;
  }) => (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodeClick={onNodeClick}
      defaultEdgeOptions={{
        style: { stroke: '#94a3b8', strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed },
      }}
      fitView
      proOptions={{ hideAttribution: true }}
      className="bg-muted/20"
    >
      <Background gap={16} size={1} />
      <Controls />
      <MiniMap pannable zoomable className="!bg-white" />
    </ReactFlow>
  );
  return { default: Component };
});

const NODE_TYPE_COLORS: Record<TraceNodeEntry['node_type'], string> = {
  turn: '#3b82f6',       // blue
  tool: '#10b981',       // green
  skill: '#a855f7',      // purple
  subagent: '#f97316',   // orange
  review: '#eab308',     // yellow
  goal_check: '#ef4444', // red
  // Atomic step types (v57) — share palette hues, lighter shade.
  thinking: '#6366f1',       // indigo
  compact: '#8b5cf6',        // violet
  memory_recall: '#0ea5e9', // sky
  memory_write: '#0891b2',  // cyan
  tool_select: '#14b8a6',   // teal
  llm_call: '#06b6d4',      // cyan
  permission_check: '#f59e0b', // amber
  context_audit: '#a3a3a3',   // neutral
  validation: '#16a34a',    // green (result-checking)
};

const NODE_TYPE_LABELS: Record<TraceNodeEntry['node_type'], string> = {
  turn: 'Turn',
  tool: 'Tool',
  skill: 'Skill',
  subagent: 'Sub-Agent',
  review: 'Review',
  goal_check: 'Goal Check',
  thinking: 'Thinking',
  compact: 'Compact',
  memory_recall: 'Memory Recall',
  memory_write: 'Memory Write',
  tool_select: 'Tool Select',
  llm_call: 'LLM Call',
  permission_check: 'Permission Check',
  context_audit: 'Context Audit',
  validation: 'Validation',
};

const STATUS_BORDER: Record<string, string> = {
  running: 'border-amber-500',
  done: 'border-emerald-500',
  failed: 'border-red-500',
  pending: 'border-slate-400',
};

interface DagViewProps {
  chatJid: string;
}

export function DagView({ chatJid }: DagViewProps) {
  const traceNodesMap = useChatStore((s) => s.traceNodes);
  const loadTraceNodes = useChatStore((s) => s.loadTraceNodes);
  const selectedNodeId = useChatStore((s) => s.selectedTraceNodeId);
  const setSelectedNodeId = useChatStore((s) => s.setSelectedTraceNodeId);
  const [loading, setLoading] = useState(false);

  const nodes = traceNodesMap[chatJid] ?? [];

  useEffect(() => {
    setLoading(true);
    loadTraceNodes(chatJid).finally(() => setLoading(false));
  }, [chatJid, loadTraceNodes]);

  const handleRefresh = async () => {
    setLoading(true);
    await loadTraceNodes(chatJid);
    setLoading(false);
  };

  const { rfNodes, rfEdges } = useMemo(() => {
    const rfNodes = nodes.map((n, index) => {
      const isSelected = n.id === selectedNodeId;
      const status = n.status ?? 'pending';
      const title = n.title?.slice(0, 30) || `#${n.id}`;
      return {
        id: String(n.id),
        data: {
          label: (
            <div className="flex flex-col items-center text-center">
              <div
                className="px-3 py-2 rounded-md border-2 bg-white text-xs font-medium"
                style={{
                  borderColor: NODE_TYPE_COLORS[n.node_type],
                  boxShadow: isSelected ? '0 0 0 2px rgba(59,130,246,0.4)' : undefined,
                }}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className="inline-block w-2 h-2 rounded-full"
                    style={{ backgroundColor: NODE_TYPE_COLORS[n.node_type] }}
                  />
                  <span className="text-[10px] uppercase text-slate-500">
                    {NODE_TYPE_LABELS[n.node_type]}
                  </span>
                </div>
                <div className="mt-1 max-w-[140px] truncate text-slate-800">
                  {title}
                </div>
                <div className={`mt-0.5 text-[9px] ${STATUS_BORDER[status] || ''}`}>
                  {status}
                </div>
              </div>
            </div>
          ),
        },
        // Layout by array index (not by id) so large nodeIds don't push
        // nodes off-screen. Simple grid: 5 columns, rows top-down.
        position: { x: (index % 5) * 180, y: Math.floor(index / 5) * 120 },
      };
    });
    const rfEdges = nodes
      .filter((n) => n.parent_node_id != null)
      .map((n) => ({
        id: `${n.parent_node_id}-${n.id}`,
        source: String(n.parent_node_id),
        target: String(n.id),
        style: { stroke: '#94a3b8', strokeWidth: 1.5 },
        animated: n.status === 'running',
      }));
    return { rfNodes, rfEdges };
  }, [nodes, selectedNodeId]);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="font-semibold text-foreground text-sm">执行 DAG</h3>
        <div className="flex items-center gap-1">
          <button
            onClick={handleRefresh}
            className="text-muted-foreground hover:text-foreground p-2 rounded-md hover:bg-muted cursor-pointer"
            title="刷新"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-h-0 relative">
          {nodes.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-8">
              <Workflow className="w-12 h-12 mb-3 opacity-40" />
              <p className="text-sm">
                {loading ? '加载中...' : '暂无执行节点'}
              </p>
              <p className="text-xs mt-1 text-muted-foreground/70">
                发送消息触发 Agent 后，工具调用与子 Agent 节点会出现在这里
              </p>
            </div>
          ) : (
            <Suspense
              fallback={
                <div className="flex items-center justify-center h-full">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              }
            >
              <FlowCanvas
                nodes={rfNodes}
                edges={rfEdges}
                onNodeClick={(_, node) => setSelectedNodeId(Number(node.id))}
              />
            </Suspense>
          )}
        </div>

        {/* Detail panel */}
        {selectedNode && (
          <div className="w-[340px] flex-shrink-0 border-l border-border">
            <DagNodeDetail chatJid={chatJid} node={selectedNode} />
          </div>
        )}
      </div>
    </div>
  );
}
