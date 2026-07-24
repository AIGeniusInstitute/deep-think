/**
 * Graph DAG visualization — running-state canvas for graph_node_runs.
 *
 * Reuses the @xyflow/react lazy-import pattern from chat/DagView.tsx (~200KB
 * only loads when opened). Nodes are sourced from the graph store's
 * currentNodeRuns (polled every 5s, P0). Status drives color + pulse for
 * running nodes; parent_node_run_id reconstructs fan-out/fan-in edges.
 *
 * See PRD AC6.1-6.4.
 */
import { useEffect, useMemo, lazy, Suspense } from 'react';
import { Loader2, RefreshCw, Workflow } from 'lucide-react';
import { useGraphStore } from '../../stores/graph';
import { GraphNodeDetail } from './GraphNodeDetail';
import type { Node, Edge, NodeMouseHandler } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

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

const NODE_TYPE_COLORS: Record<string, string> = {
  agent: '#3b82f6',
  gate: '#eab308',
  branch: '#a855f7',
  join: '#10b981',
  human: '#f97316',
};

const STATUS_COLOR: Record<string, string> = {
  running: '#f59e0b', // amber — pulsing
  completed: '#10b981', // green
  failed: '#ef4444', // red
  paused: '#eab308', // yellow
  pending: '#94a3b8', // slate
  skipped: '#cbd5e1', // light slate
};

interface GraphDagViewProps {
  runId: string;
  /**
   * v2 (TeamPage UI): optional map nodeId → {role, title, type} from the team
   * plan. When provided, agent nodes render the member role + title instead of
   * the raw node_id. Missing (GraphPage call) → falls back to node_id (backward
   * compat). AC4.1.
   */
  roleByNode?: Map<string, { role: string; title: string; type: string }>;
}

const STATUS_LABEL_ZH: Record<string, string> = {
  pending: '等待中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  paused: '等待审批',
  skipped: '已跳过',
  cancelled: '已取消',
};

export function GraphDagView({ runId, roleByNode }: GraphDagViewProps) {
  const currentRun = useGraphStore((s) => s.currentRun);
  const nodeRuns = useGraphStore((s) => s.currentNodeRuns);
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const setSelectedNode = useGraphStore((s) => s.setSelectedNode);
  const startPolling = useGraphStore((s) => s.startPolling);
  const stopPolling = useGraphStore((s) => s.stopPolling);
  const loadRun = useGraphStore((s) => s.loadRun);

  useEffect(() => {
    startPolling(runId);
    return () => stopPolling();
  }, [runId, startPolling, stopPolling]);

  const { rfNodes, rfEdges } = useMemo(() => {
    const rfNodes: Node[] = nodeRuns.map((n, index) => {
      const status = n.status ?? 'pending';
      const color = STATUS_COLOR[status] ?? '#94a3b8';
      const typeColor = NODE_TYPE_COLORS[n.node_type] ?? '#64748b';
      const rn = roleByNode?.get(n.node_id);
      const displayLabel = rn
        ? n.node_type === 'agent'
          ? rn.role
          : rn.title
        : `${n.node_id}`.slice(0, 24);
      const subTitle = rn ? rn.title : n.node_id;
      const statusText = STATUS_LABEL_ZH[status] ?? status;
      return {
        id: n.id,
        data: {
          label: (
            <div className="flex flex-col items-center text-center">
              <div
                className="px-3 py-2 rounded-md border-2 bg-white text-xs font-medium"
                style={{
                  borderColor: color,
                  boxShadow:
                    status === 'running'
                      ? '0 0 0 3px rgba(245,158,11,0.4)'
                      : undefined,
                }}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className="inline-block w-2 h-2 rounded-full"
                    style={{ backgroundColor: typeColor }}
                  />
                  <span className="text-[10px] uppercase text-slate-500">
                    {n.node_type}
                  </span>
                </div>
                <div className="mt-1 max-w-[140px] truncate text-slate-800">
                  {displayLabel}
                </div>
                {rn && (
                  <div className="mt-0.5 max-w-[140px] truncate text-[9px] text-slate-500">
                    {subTitle}
                  </div>
                )}
                <div className="mt-0.5 text-[9px] text-slate-500">
                  {statusText} · att{n.attempt}
                </div>
              </div>
            </div>
          ),
        },
        position: { x: (index % 5) * 180, y: Math.floor(index / 5) * 120 },
      };
    });
    const rfEdges: Edge[] = nodeRuns
      .filter((n) => n.parent_node_run_id)
      .map((n) => ({
        id: `${n.parent_node_run_id}-${n.id}`,
        source: n.parent_node_run_id as string,
        target: n.id,
        style: { stroke: '#94a3b8', strokeWidth: 1.5 },
        animated: n.status === 'running',
      }));
    return { rfNodes, rfEdges };
  }, [nodeRuns, roleByNode]);

  const selectedNode = nodeRuns.find((n) => n.id === selectedNodeId) ?? null;

  if (!currentRun) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div>
          <h3 className="font-semibold text-foreground text-sm">
            Graph 执行图 — {currentRun.status}
          </h3>
          <p className="text-xs text-muted-foreground">
            def {currentRun.definition_id}@v{currentRun.definition_version} ·{' '}
            {nodeRuns.length} 节点
          </p>
        </div>
        <button
          onClick={() => void loadRun(runId)}
          className="text-muted-foreground hover:text-foreground p-2 rounded-md hover:bg-muted cursor-pointer"
          title="刷新"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-h-0 relative">
          {nodeRuns.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-8">
              <Workflow className="w-12 h-12 mb-3 opacity-40" />
              <p className="text-sm">暂无节点</p>
              <p className="text-xs mt-1 text-muted-foreground/70">
                图运行启动后节点会出现在这里（5s 轮询）
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
                onNodeClick={(_, node) => setSelectedNode(node.id)}
              />
            </Suspense>
          )}
        </div>

        {selectedNode && (
          <div className="w-[340px] flex-shrink-0 border-l border-border">
            <GraphNodeDetail runId={runId} node={selectedNode} />
          </div>
        )}
      </div>
    </div>
  );
}
