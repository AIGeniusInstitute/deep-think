/**
 * Super Agent Team — node-internal sub-graph trace panel.
 *
 * Fetches GET /api/graph/runs/:id/nodes/:nodeId/trace and renders the agent
 * node's internal execution steps (turn/tool span tree, by parent_node_id)
 * + each tool call's raw input/output (collapsible). Lets the user drill into
 * a graph agent node to see exactly what it did, step by step, fully traceable.
 *
 * v2 enhancements (AC5.1–5.4): step index, timestamp (started_at), action-type
 * label, per-step copy button, "view full" toggle for truncated tool I/O.
 */
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Wrench } from 'lucide-react';
import { apiFetch } from '../../api/client';
import { toast } from 'sonner';

interface TraceNode {
  id: number;
  node_type: string;
  parent_node_id: number | null;
  title: string | null;
  input_summary: string | null;
  output_summary: string | null;
  status: string | null;
  tool_name: string | null;
  tool_use_id: string | null;
  started_at: string | null;
  ended_at: string | null;
}

interface ToolCall {
  tool_use_id: string;
  tool_name: string;
  input_json: string | null;
  output_json: string | null;
  status: string | null;
}

const ACTION_LABEL: Record<string, string> = {
  turn: '推理',
  tool: '工具调用',
  skill: '技能',
  subagent: '子代理',
  review: '评审',
  goal_check: '目标检查',
};

const TRUNCATE_LEN = 2000;

interface NodeTraceSubgraphProps {
  runId: string;
  nodeId: string;
}

export function NodeTraceSubgraph({ runId, nodeId }: NodeTraceSubgraphProps) {
  const [traceNodes, setTraceNodes] = useState<TraceNode[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await apiFetch<{ traceNodes: TraceNode[]; toolCalls: ToolCall[] }>(
          `/api/graph/runs/${runId}/nodes/${nodeId}/trace`,
        );
        if (cancelled) return;
        setTraceNodes(data.traceNodes ?? []);
        setToolCalls(data.toolCalls ?? []);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    // Poll while the parent graph run is likely active (5s, same as graph store).
    const timer = setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runId, nodeId]);

  if (loading) {
    return <div className="text-xs text-muted-foreground p-2">加载节点内 trace…</div>;
  }
  if (error) {
    return <div className="text-xs text-red-600 p-2">trace 加载失败：{error}</div>;
  }
  if (traceNodes.length === 0) {
    return (
      <div className="text-xs text-muted-foreground p-2">
        暂无子步骤 trace（agent 节点尚未执行或未产生 trace）。
      </div>
    );
  }

  // Build a parent → children map for the span tree.
  const childrenOf = new Map<number | null, TraceNode[]>();
  for (const n of traceNodes) {
    const key = n.parent_node_id;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key)!.push(n);
  }
  const toolCallByUseId = new Map(toolCalls.map((t) => [t.tool_use_id, t]));
  const roots = childrenOf.get(null) ?? [];

  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground mb-1">
        节点内子步骤（{traceNodes.length} 步 / {toolCalls.length} 工具调用）
      </div>
      {roots.map((n, i) => (
        <TraceNodeItem
          key={n.id}
          node={n}
          index={i + 1}
          childrenOf={childrenOf}
          toolCallByUseId={toolCallByUseId}
        />
      ))}
    </div>
  );
}

function TraceNodeItem({
  node,
  index,
  childrenOf,
  toolCallByUseId,
}: {
  node: TraceNode;
  index: number;
  childrenOf: Map<number | null, TraceNode[]>;
  toolCallByUseId: Map<string, ToolCall>;
}) {
  const [open, setOpen] = useState(false);
  const [showFullInput, setShowFullInput] = useState(false);
  const [showFullOutput, setShowFullOutput] = useState(false);
  const children = childrenOf.get(node.id) ?? [];
  const toolCall = node.tool_use_id ? toolCallByUseId.get(node.tool_use_id) : undefined;
  const hasDetail = children.length > 0 || !!toolCall || !!node.output_summary || !!node.input_summary;
  const statusColor =
    node.status === 'done' || node.status === 'completed'
      ? 'text-emerald-600'
      : node.status === 'failed'
        ? 'text-red-600'
        : node.status === 'running'
          ? 'text-amber-600'
          : 'text-muted-foreground';
  const actionLabel = ACTION_LABEL[node.node_type] ?? node.node_type;

  const copyStep = async () => {
    const payload = {
      step: index,
      timestamp: node.started_at,
      action: actionLabel,
      type: node.node_type,
      title: node.title,
      tool: node.tool_name ?? toolCall?.tool_name ?? null,
      status: node.status,
      input: node.input_summary ?? toolCall?.input_json ?? null,
      output: node.output_summary ?? toolCall?.output_json ?? null,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      toast.success('已复制步骤日志');
    } catch {
      toast.error('复制失败');
    }
  };

  const renderValue = (label: string, value: string | null, full: boolean, toggle: () => void) => {
    if (!value) return null;
    const truncated = !full && value.length > TRUNCATE_LEN ? value.slice(0, TRUNCATE_LEN) : value;
    const isTruncated = value.length > TRUNCATE_LEN;
    return (
      <pre className="whitespace-pre-wrap break-all rounded bg-muted/40 p-1.5 text-[10px] max-h-40 overflow-y-auto">
        {label}: {truncated}
        {isTruncated && (
          <button onClick={toggle} className="ml-2 rounded bg-blue-50 px-1 text-blue-700 hover:bg-blue-100">
            {full ? '收起' : '查看完整'}
          </button>
        )}
      </pre>
    );
  };

  return (
    <div className="border-l border-border pl-2 ml-1">
      <div className="flex items-center gap-1 py-0.5">
        <button
          onClick={() => hasDetail && setOpen((v) => !v)}
          className={`flex items-center gap-1 text-xs w-full text-left ${hasDetail ? 'hover:bg-muted/40 rounded cursor-pointer' : 'cursor-default'}`}
        >
          {hasDetail ? (
            open ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />
          ) : (
            <span className="w-3" />
          )}
          <span className={`font-mono ${statusColor}`}>●</span>
          <span className="text-muted-foreground font-mono text-[10px]">#{index}</span>
          {node.started_at && (
            <span className="text-[10px] text-muted-foreground">{fmtTime(node.started_at)}</span>
          )}
          <span className="px-1 rounded bg-muted text-[9px] uppercase text-muted-foreground">{actionLabel}</span>
          <span className="text-foreground truncate">{node.title || node.node_type}</span>
          {(node.tool_name || toolCall?.tool_name) && (
            <span className="inline-flex items-center gap-0.5 text-[10px] px-1 rounded bg-blue-50 text-blue-700">
              <Wrench className="w-2.5 h-2.5" />
              {node.tool_name || toolCall?.tool_name}
            </span>
          )}
        </button>
        <button
          onClick={copyStep}
          title="复制步骤日志"
          className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
        >
          <Copy className="w-3 h-3" />
        </button>
      </div>
      {open && (
        <div className="ml-4 space-y-1 mb-1">
          {renderValue('入参摘要', node.input_summary, showFullInput, () => setShowFullInput((v) => !v))}
          {renderValue('产出摘要', node.output_summary, showFullOutput, () => setShowFullOutput((v) => !v))}
          {toolCall && (
            <div className="space-y-1">
              {renderValue('工具入参', toolCall.input_json, showFullInput, () => setShowFullInput((v) => !v))}
              {renderValue('工具输出', toolCall.output_json, showFullOutput, () => setShowFullOutput((v) => !v))}
            </div>
          )}
          {children.map((c, i) => (
            <TraceNodeItem
              key={c.id}
              node={c}
              index={i + 1}
              childrenOf={childrenOf}
              toolCallByUseId={toolCallByUseId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function fmtTime(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}
