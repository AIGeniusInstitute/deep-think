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
import { useGraphStore, type GraphNodeRun } from '../../stores/graph';
import { GraphNodeDetail } from './GraphNodeDetail';
import { layoutDag } from './dagreLayout';
import { DataFlowEdge } from './DataFlowEdge';
import type { Node, Edge, NodeMouseHandler, EdgeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

const FlowCanvas = lazy(async () => {
  const { ReactFlow, Controls, Background, MiniMap, MarkerType } = await import('@xyflow/react');
  const Component = ({
    nodes,
    edges,
    onNodeClick,
    edgeTypes,
  }: {
    nodes: Node[];
    edges: Edge[];
    onNodeClick: NodeMouseHandler;
    edgeTypes?: EdgeTypes;
  }) => (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodeClick={onNodeClick}
      edgeTypes={edgeTypes}
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
  llm: '#06b6d4',
  tool: '#0ea5e9',
  start: '#64748b',
  end: '#475569',
  parallel: '#8b5cf6',
  aggregate: '#ec4899',
};

const EDGE_TYPES: EdgeTypes = { dataflow: DataFlowEdge };

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
  const definition = useGraphStore((s) => s.definition);
  const takenEdges = useGraphStore((s) => s.takenEdges);
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const setSelectedNode = useGraphStore((s) => s.setSelectedNode);
  const startPolling = useGraphStore((s) => s.startPolling);
  const stopPolling = useGraphStore((s) => s.stopPolling);
  const subscribeGraphEvents = useGraphStore((s) => s.subscribeGraphEvents);
  const unsubscribeGraphEvents = useGraphStore((s) => s.unsubscribeGraphEvents);
  const loadRun = useGraphStore((s) => s.loadRun);
  const loadDefinition = useGraphStore((s) => s.loadDefinition);

  useEffect(() => {
    startPolling(runId);
    subscribeGraphEvents(runId); // C7: <2s latency overlay via WS
    return () => {
      stopPolling();
      unsubscribeGraphEvents();
    };
  }, [runId, startPolling, stopPolling, subscribeGraphEvents, unsubscribeGraphEvents]);

  // C8: load the registered definition for structure (nodes/edges) + layout.
  useEffect(() => {
    if (currentRun && !definition) void loadDefinition(currentRun.definition_id);
  }, [currentRun, definition, loadDefinition]);

  const { rfNodes, rfEdges } = useMemo(() => {
    // Latest node_run per node_id (status overlay over the definition canvas).
    const latestByNodeId = new Map<string, GraphNodeRun>();
    for (const n of nodeRuns) {
      const prev = latestByNodeId.get(n.node_id);
      if (!prev || n.attempt >= prev.attempt) latestByNodeId.set(n.node_id, n);
    }

    const takenSet = new Set(
      takenEdges.map((e) => `${e.from}→${e.to}`),
    );

    // Node set: prefer definition structure; fall back to nodeRuns so the
    // canvas still renders before the definition loads.
    const nodeSet =
      definition?.nodes?.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
      })) ??
      nodeRuns.map((n) => ({ id: n.node_id, type: n.node_type, title: n.node_id }));

    const positions = layoutDag(
      nodeSet.map((n) => ({ id: n.id })),
      (definition?.edges ?? []).map((e) => ({ from: e.from, to: e.to })),
    );

    const rfNodes: Node[] = nodeSet.map((n) => {
      const run = latestByNodeId.get(n.id);
      const status = run?.status ?? 'pending';
      const color = STATUS_COLOR[status] ?? '#94a3b8';
      const typeColor = NODE_TYPE_COLORS[n.type] ?? '#64748b';
      const rn = roleByNode?.get(n.id);
      const displayLabel = rn
        ? n.type === 'agent'
          ? rn.role
          : rn.title
        : (n.title ?? n.id).slice(0, 24);
      const subTitle = rn ? rn.title : n.id;
      const statusText = STATUS_LABEL_ZH[status] ?? status;
      const pos = positions.get(n.id) ?? { x: 0, y: 0 };
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
                    {n.type}
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
                  {statusText}
                  {run ? ` · att${run.attempt}` : ''}
                </div>
              </div>
            </div>
          ),
        },
        position: { x: pos.x, y: pos.y },
      };
    });

    // Edges: prefer definition edges (with data-flow animation for taken/
    // running-target edges); fall back to parent_node_run_id before def loads.
    let rfEdges: Edge[];
    if (definition && definition.edges.length > 0) {
      rfEdges = definition.edges.map((e) => {
        const taken = takenSet.has(`${e.from}→${e.to}`);
        const targetRunning =
          latestByNodeId.get(e.to)?.status === 'running';
        const active = taken || targetRunning;
        const label = e.isDefault
          ? '默认'
          : e.condition ?? (e.expression ? '表达式' : undefined);
        return {
          id: e.id,
          source: e.from,
          target: e.to,
          type: active ? 'dataflow' : undefined,
          animated: active,
          data: { active },
          label,
          labelStyle: { fontSize: 9, fill: '#64748b' },
          style: { stroke: active ? '#3b82f6' : '#94a3b8', strokeWidth: 1.5 },
        };
      });
    } else {
      rfEdges = nodeRuns
        .filter((n) => n.parent_node_run_id)
        .map((n) => ({
          id: `${n.parent_node_run_id}-${n.node_id}`,
          source: n.parent_node_run_id as string,
          target: n.node_id,
          style: { stroke: '#94a3b8', strokeWidth: 1.5 },
          animated: n.status === 'running',
        }));
    }
    return { rfNodes, rfEdges };
  }, [nodeRuns, definition, takenEdges, roleByNode]);

  const selectedNode = nodeRuns.find((n) => n.node_id === selectedNodeId) ?? null;

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
            {rfNodes.length} 节点
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
          {rfNodes.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-8">
              <Workflow className="w-12 h-12 mb-3 opacity-40" />
              <p className="text-sm">暂无节点</p>
              <p className="text-xs mt-1 text-muted-foreground/70">
                图运行启动后节点会出现在这里（WS 实时 + 5s 轮询兜底）
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
                edgeTypes={EDGE_TYPES}
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
