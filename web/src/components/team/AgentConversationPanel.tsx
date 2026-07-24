/**
 * Super Agent Team — Agent conversation panel (left of the execution view).
 *
 * Derives a multi-role message stream from polling snapshots (no WebSocket):
 * plan system message + per-nodeRun status transitions + agent output_summary
 * + tool-call summary (one trace fetch on node completion) + run terminal
 * state. Multi-role labels, message-type visual distinction, auto-scroll with
 * "back to bottom" button. Refresh-recoverable (re-derives from persistent
 * nodeRuns + plan).
 *
 * AC3.1–3.3 / AC6.1–6.3.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, AlertTriangle, Wrench, Bot, ShieldCheck } from 'lucide-react';
import { useGraphStore } from '../../stores/graph';
import type { TeamPlan } from '../../stores/team';
import { apiFetch } from '../../api/client';

interface ConvMessage {
  id: string;
  role: string;
  roleType: 'system' | 'agent' | 'tool' | 'error' | 'approval';
  kind: 'text' | 'tool' | 'status' | 'error' | 'system' | 'approval';
  text: string;
  ts: string | null;
  nodeRunId?: string;
  nodeId?: string;
}

interface ToolSummary {
  names: string[];
  count: number;
}

type ToolCacheState = Record<string, ToolSummary | null>;

interface AgentConversationPanelProps {
  plan: TeamPlan | null;
}

const ROLE_COLORS = ['#2563eb', '#7c3aed', '#059669', '#db2777', '#ea580c', '#0891b2', '#ca8a04', '#4f46e5'];

export function AgentConversationPanel({ plan }: AgentConversationPanelProps) {
  const currentRun = useGraphStore((s) => s.currentRun);
  const nodeRuns = useGraphStore((s) => s.currentNodeRuns);
  const containerRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  const [toolCache, setToolCache] = useState<ToolCacheState>({});
  const fetchedTraceFor = useRef<Set<string>>(new Set());

  // role + plan-node lookup from plan
  const { roleByMember, planNodeById } = useMemo(() => {
    const roleByMember = new Map<string, string>();
    if (plan) for (const m of plan.members) roleByMember.set(m.name, m.role);
    const planNodeById = new Map<string, { title: string; agentMember?: string; type: string }>();
    if (plan) for (const n of plan.graph.nodes) planNodeById.set(n.id, { title: n.title, agentMember: n.agentMember, type: n.type });
    return { roleByMember, planNodeById };
  }, [plan]);

  const sortedRuns = useMemo(
    () => [...nodeRuns].sort((a, b) => (a.started_at ?? '').localeCompare(b.started_at ?? '')),
    [nodeRuns],
  );

  // Derive messages deterministically from the latest snapshot.
  const messages = useMemo<ConvMessage[]>(() => {
    const out: ConvMessage[] = [];
    if (plan) {
      out.push({
        id: 'team:formed',
        role: '系统',
        roleType: 'system',
        kind: 'system',
        text: `已成功组建 ${plan.members.length} 个 Agent 角色：${plan.members.map((m) => m.role).join('、')}`,
        ts: null,
      });
    }

    for (const nr of sortedRuns) {
      const pn = planNodeById.get(nr.node_id);
      const role = pn?.agentMember ? (roleByMember.get(pn.agentMember) ?? pn.title) : pn?.title ?? nr.node_id;
      const ts = nr.started_at;
      if (nr.status === 'running') {
        out.push({ id: `${nr.id}:start`, role, roleType: 'agent', kind: 'status', text: `开始执行：${pn?.title ?? nr.node_id}`, ts, nodeRunId: nr.id, nodeId: nr.node_id });
      } else if (nr.status === 'completed') {
        if (nr.output_summary) {
          out.push({ id: `${nr.id}:output`, role, roleType: nr.node_type === 'gate' || nr.node_type === 'human' ? 'system' : 'agent', kind: 'text', text: nr.output_summary, ts, nodeRunId: nr.id, nodeId: nr.node_id });
        }
        const tc = toolCache[nr.node_id];
        if (tc && tc.count > 0) {
          out.push({ id: `${nr.id}:tools`, role, roleType: 'tool', kind: 'tool', text: `调用工具：${tc.names.join('、')}（共 ${tc.count} 次）`, ts, nodeRunId: nr.id, nodeId: nr.node_id });
        }
        if (nr.node_type === 'gate' || nr.node_type === 'human') {
          out.push({ id: `${nr.id}:done`, role: '系统', roleType: 'system', kind: 'system', text: `${pn?.title ?? nr.node_id} 通过`, ts, nodeId: nr.node_id });
        }
      } else if (nr.status === 'failed') {
        out.push({ id: `${nr.id}:error`, role, roleType: 'error', kind: 'error', text: `执行失败：${nr.error || '未知错误'}`, ts, nodeRunId: nr.id, nodeId: nr.node_id });
      } else if (nr.status === 'skipped') {
        out.push({ id: `${nr.id}:skipped`, role: '系统', roleType: 'system', kind: 'system', text: `${pn?.title ?? nr.node_id} 被跳过（上游未通过）`, ts, nodeId: nr.node_id });
      } else if (nr.status === 'paused') {
        out.push({ id: `${nr.id}:paused`, role: '系统', roleType: 'system', kind: 'system', text: `${pn?.title ?? nr.node_id} 等待审批`, ts, nodeId: nr.node_id });
      }
    }

    if (currentRun) {
      const status = currentRun.status;
      if (status === 'completed') {
        const finalGate = sortedRuns.filter((n) => n.node_type === 'gate').slice(-1)[0];
        out.push({ id: 'run:final', role: '系统', roleType: 'system', kind: 'system', text: finalGate?.output_summary ? `任务完成：${finalGate.output_summary.slice(0, 800)}` : '任务完成：全部节点已通过验收。', ts: currentRun.ended_at });
      } else if (status === 'failed') {
        out.push({ id: 'run:failed', role: '系统', roleType: 'error', kind: 'error', text: `任务失败：${currentRun.cancel_reason ?? '存在节点失败'}`, ts: currentRun.ended_at });
      } else if (status === 'cancelled') {
        out.push({ id: 'run:cancelled', role: '系统', roleType: 'system', kind: 'system', text: '任务已终止。', ts: currentRun.ended_at });
      } else if (status === 'paused') {
        out.push({ id: 'run:paused', role: '系统', roleType: 'system', kind: 'system', text: '任务已暂停，等待人工操作。', ts: null });
      }
    }
    return out;
  }, [plan, sortedRuns, toolCache, currentRun, roleByMember, planNodeById]);

  // Fetch trace once per completed agent node, to surface tool-call summary.
  const runId = currentRun?.id;
  useEffect(() => {
    if (!runId) return;
    for (const nr of sortedRuns) {
      if (nr.status === 'completed' && nr.node_type === 'agent' && !fetchedTraceFor.current.has(nr.node_id)) {
        fetchedTraceFor.current.add(nr.node_id);
        void (async () => {
          try {
            const data = await apiFetch<{ toolCalls: { tool_name: string }[] }>(
              `/api/graph/runs/${runId}/nodes/${nr.node_id}/trace`,
            );
            const tcs = data.toolCalls ?? [];
            const names = Array.from(new Set(tcs.map((t) => t.tool_name).filter(Boolean)));
            setToolCache((prev) => ({ ...prev, [nr.node_id]: { names, count: tcs.length } }));
          } catch {
            setToolCache((prev) => ({ ...prev, [nr.node_id]: null }));
          }
        })();
      }
    }
  }, [runId, sortedRuns]);

  // Auto-scroll: stick to bottom unless user scrolled up.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (stickToBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, stickToBottom]);

  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setStickToBottom(nearBottom);
  };

  const scrollToBottom = () => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setStickToBottom(true);
  };

  const roleColor = (idx: number) => ROLE_COLORS[idx % ROLE_COLORS.length];

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Bot className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">Agent 对话</span>
        <span className="text-xs text-muted-foreground">· {messages.length} 条</span>
      </div>
      <div ref={containerRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-2">
        {messages.length === 0 && (
          <div className="text-xs text-muted-foreground">团队组建完成后，Agent 对话将在此实时推进…</div>
        )}
        {messages.map((m, idx) => (
          <MessageBubble key={m.id} msg={m} color={roleColor(idx)} />
        ))}
      </div>
      {!stickToBottom && messages.length > 0 && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-full border border-border bg-background px-3 py-1 text-xs shadow hover:bg-muted"
        >
          <ArrowDown className="h-3 w-3" /> 回到底部
        </button>
      )}
    </div>
  );
}

function MessageBubble({ msg, color }: { msg: ConvMessage; color: string }) {
  if (msg.roleType === 'system' || msg.kind === 'system') {
    return (
      <div className="flex justify-center">
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-[11px] text-muted-foreground">
          <ShieldCheck className="h-3 w-3" />
          {msg.text}
        </span>
      </div>
    );
  }
  const isError = msg.roleType === 'error' || msg.kind === 'error';
  const isTool = msg.roleType === 'tool' || msg.kind === 'tool';
  return (
    <div
      className="flex gap-2"
      style={{ borderLeft: `3px solid ${isError ? '#ef4444' : isTool ? '#0891b2' : color}` }}
    >
      <div className="flex flex-col items-center pt-0.5">
        <div
          className="flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold text-white"
          style={{ backgroundColor: isError ? '#ef4444' : isTool ? '#0891b2' : color }}
        >
          {isError ? <AlertTriangle className="h-3.5 w-3.5" /> : isTool ? <Wrench className="h-3 w-3" /> : msg.role.slice(0, 1)}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-foreground">{msg.role}</span>
          {msg.ts && <span className="text-[10px] text-muted-foreground">{fmtTime(msg.ts)}</span>}
        </div>
        <div
          className={`mt-0.5 whitespace-pre-wrap break-words rounded px-2 py-1 text-xs ${
            isError ? 'bg-red-50 text-red-700' : isTool ? 'bg-cyan-50 text-cyan-800' : 'bg-muted/40 text-foreground'
          }`}
        >
          {msg.text}
        </div>
      </div>
    </div>
  );
}

function fmtTime(iso: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}
