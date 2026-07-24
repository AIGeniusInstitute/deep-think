/**
 * Super Agent Team page — input a complex task, DeepThink autonomously
 * decomposes it into a team (creates agent members + assembles a graph) and
 * starts a run. The execution view stays on /team (no route jump) and shows
 * a resizable split: left Agent conversation panel + right DAG with node
 * trace. v2 (PRD docs/prd/super-agent-team-ui-v2).
 */
import { useEffect, useMemo, useState } from 'react';
import { History, Square } from 'lucide-react';
import { useTeamStore } from '../stores/team';
import { useGroupsStore } from '../stores/groups';
import { useGraphStore } from '../stores/graph';
import { GraphDagView } from '../components/graph/GraphDagView';
import { AgentConversationPanel } from '../components/team/AgentConversationPanel';
import { ResizableSplitter } from '../components/team/ResizableSplitter';
import { toast } from 'sonner';

const TOOLSET_OPTIONS = [
  { id: 'web-research', label: '网络搜索' },
  { id: 'code-execution', label: '代码执行' },
  { id: 'file-io', label: '文件读写' },
  { id: 'mcp:deepthink', label: 'DeepThink MCP' },
];

export function TeamPage() {
  const building = useTeamStore((s) => s.building);
  const error = useTeamStore((s) => s.error);
  const lastRunId = useTeamStore((s) => s.lastRunId);
  const lastPlan = useTeamStore((s) => s.lastPlan);
  const buildTeam = useTeamStore((s) => s.buildTeam);
  const history = useTeamStore((s) => s.history);
  const loadHistory = useTeamStore((s) => s.loadHistory);
  const openHistory = useTeamStore((s) => s.openHistory);

  const groups = useGroupsStore((s) => s.groups);
  const loadGroups = useGroupsStore((s) => s.loadGroups);
  const startPolling = useGraphStore((s) => s.startPolling);
  const stopPolling = useGraphStore((s) => s.stopPolling);
  const cancelRun = useGraphStore((s) => s.cancelRun);
  const currentRun = useGraphStore((s) => s.currentRun);

  const [goal, setGoal] = useState('');
  const [background, setBackground] = useState('');
  const [criteria, setCriteria] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(true);
  const [maxTeamSize, setMaxTeamSize] = useState<number>(6);
  const [toolset, setToolset] = useState<string[]>(TOOLSET_OPTIONS.map((t) => t.id));
  const [executionMode, setExecutionMode] = useState<'auto' | 'semi-auto'>('auto');
  const [showHistory, setShowHistory] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  const home = useMemo(() => {
    const entries = Object.entries(groups);
    const found =
      entries.find(([, g]) => g.is_my_home) ??
      entries.find(([, g]) => g.is_home) ??
      entries.find(([, g]) => g.kind === 'home') ??
      entries[0];
    return found ? { chatJid: found[0], folder: found[1].folder } : null;
  }, [groups]);

  useEffect(() => {
    if (lastRunId) {
      startPolling(lastRunId, 2000);
    }
    return () => stopPolling();
  }, [lastRunId, startPolling, stopPolling]);

  const handleBuild = async () => {
    if (!goal.trim() || !home) return;
    await buildTeam({
      goalText: goal.trim(),
      background: background.trim() || undefined,
      acceptanceCriteria: criteria.trim() || undefined,
      groupFolder: home.folder,
      chatJid: home.chatJid,
      maxTeamSize,
      toolset,
      executionMode,
    });
  };

  const handleCancel = async () => {
    if (!lastRunId) return;
    setCancelling(true);
    const ok = await cancelRun(lastRunId);
    setCancelling(false);
    if (ok) toast.success('已发送终止指令'); else toast.error('终止失败');
  };

  const toggleTool = (id: string) => {
    setToolset((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));
  };

  const isTerminal =
    currentRun?.status === 'completed' || currentRun?.status === 'failed' || currentRun?.status === 'cancelled';

  // Build roleByNode map for the DAG (node_id → {role, title, type}).
  const roleByNode = useMemo(() => {
    const m = new Map<string, { role: string; title: string; type: string }>();
    if (lastPlan) {
      const roleByMember = new Map(lastPlan.members.map((mm) => [mm.name, mm.role]));
      for (const n of lastPlan.graph.nodes) {
        const role = n.agentMember ? (roleByMember.get(n.agentMember) ?? n.title) : n.title;
        m.set(n.id, { role, title: n.title, type: n.type });
      }
    }
    return m;
  }, [lastPlan]);

  if (lastRunId) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <button
            onClick={() => {
              stopPolling();
              useTeamStore.getState().reset();
            }}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← 新建团队
          </button>
          <span className="text-sm text-muted-foreground truncate">
            团队 {lastPlan?.teamName ?? ''} · 运行 {lastRunId.slice(0, 12)}
          </span>
          {currentRun && (
            <span className={`text-xs px-2 py-0.5 rounded ${statusBadgeClass(currentRun.status)}`}>
              {statusLabel(currentRun.status)}
            </span>
          )}
          <div className="flex-1" />
          <button
            onClick={handleCancel}
            disabled={cancelling || isTerminal}
            className="flex items-center gap-1 text-xs px-2.5 py-1 rounded border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-40"
            title="终止任务"
          >
            <Square className="h-3 w-3" /> {cancelling ? '终止中…' : '终止任务'}
          </button>
        </div>
        <div className="flex-1 min-h-0">
          <ResizableSplitter
            left={<AgentConversationPanel plan={lastPlan} />}
            right={<GraphDagView runId={lastRunId} roleByNode={roleByNode} />}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div>
          <h2 className="font-semibold text-foreground">超级 Agent 团队</h2>
          <p className="text-xs text-muted-foreground mt-1">
            输入超复杂任务，DeepThink 自主拆解、组建 Agent 团队（自主设计角色 / System Prompt / 工具），用 DAG 任务图可视化执行，节点内步骤 + 工具调用全 trace 可回溯。
          </p>
        </div>
        <button
          onClick={() => {
            setShowHistory((v) => !v);
            if (!showHistory) void loadHistory();
          }}
          className="flex items-center gap-1 text-xs px-2.5 py-1 rounded border border-border hover:bg-muted"
        >
          <History className="h-3.5 w-3.5" /> 历史任务
        </button>
      </div>

      <div className="p-4 space-y-3 max-w-3xl">
        {showHistory && (
          <div className="border border-border rounded p-3 space-y-1 bg-muted/20">
            <div className="text-xs text-muted-foreground mb-1">历史团队任务</div>
            {history.length === 0 ? (
              <div className="text-xs text-muted-foreground">暂无历史任务</div>
            ) : (
              history.map((h) => (
                <button
                  key={h.id}
                  onClick={() => {
                    void openHistory(h.id);
                    setShowHistory(false);
                  }}
                  className="flex items-center gap-2 w-full text-left text-xs px-2 py-1.5 rounded hover:bg-background"
                >
                  <span className={`px-1.5 py-0.5 rounded ${statusBadgeClass(h.status)} text-[10px]`}>
                    {h.status}
                  </span>
                  <span className="font-medium truncate flex-1">{h.teamName ?? h.goalText.slice(0, 40)}</span>
                  <span className="text-muted-foreground">{new Date(h.createdAt).toLocaleString('zh-CN')}</span>
                </button>
              ))
            )}
          </div>
        )}

        {!home && (
          <div className="text-xs text-amber-600">
            未找到可用工作区（group）。请先在 Web 创建/进入一个工作区。
          </div>
        )}
        <div>
          <label className="text-xs text-muted-foreground block mb-1">任务目标 *</label>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={4}
            placeholder="例：调研 2026 年 Agent 框架趋势，实现一个最小可运行的 TODO 原型并写单元测试，产出研究报告 + 可运行代码 + 测试通过"
            className="w-full text-sm rounded border border-border bg-background px-3 py-2 resize-y"
          />
        </div>

        <button
          onClick={() => setShowAdvanced((v) => !v)}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          {showAdvanced ? '收起高级选项 ▲' : '高级选项 ▼'}
        </button>
        {showAdvanced && (
          <div className="border border-border rounded p-3 space-y-3 bg-muted/10">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">最大团队人数</label>
              <input
                type="number"
                min={1}
                max={12}
                value={maxTeamSize}
                onChange={(e) => setMaxTeamSize(Math.max(1, Math.min(12, Number(e.target.value) || 6)))}
                className="w-24 text-sm rounded border border-border bg-background px-2 py-1"
              />
              <span className="text-xs text-muted-foreground ml-2">1–12，截断超出成员</span>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">可用工具集</label>
              <div className="flex flex-wrap gap-2">
                {TOOLSET_OPTIONS.map((t) => (
                  <label key={t.id} className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={toolset.includes(t.id)}
                      onChange={() => toggleTool(t.id)}
                      className="h-3.5 w-3.5"
                    />
                    {t.label}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">执行模式</label>
              <div className="flex gap-3">
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="radio"
                    name="execmode"
                    checked={executionMode === 'auto'}
                    onChange={() => setExecutionMode('auto')}
                  />
                  自动（全程自主）
                </label>
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="radio"
                    name="execmode"
                    checked={executionMode === 'semi-auto'}
                    onChange={() => setExecutionMode('semi-auto')}
                  />
                  半自动（每个 Agent 产出后人工确认）
                </label>
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">背景（可选）</label>
              <textarea
                value={background}
                onChange={(e) => setBackground(e.target.value)}
                rows={2}
                className="w-full text-sm rounded border border-border bg-background px-3 py-2 resize-y"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">验收标准（可选，推荐填写以驱动行为证据）</label>
              <textarea
                value={criteria}
                onChange={(e) => setCriteria(e.target.value)}
                rows={2}
                placeholder="例：测试全部通过；报告含趋势章节"
                className="w-full text-sm rounded border border-border bg-background px-3 py-2 resize-y"
              />
            </div>
          </div>
        )}

        {error && (
          <div className="text-xs text-red-600 bg-red-50 rounded p-2">❌ {error}</div>
        )}

        <button
          onClick={() => void handleBuild()}
          disabled={building || !goal.trim() || !home}
          className="px-4 py-2 rounded bg-foreground text-background text-sm hover:opacity-90 disabled:opacity-50"
        >
          {building ? '组建团队中…（拆解 + 创建成员 + 组装图）' : '🤝 组建团队并启动'}
        </button>

        {lastPlan && (
          <div className="border border-border rounded p-3 space-y-2">
            <div className="text-xs text-muted-foreground">团队计划预览</div>
            <div className="text-sm font-medium">团队：{lastPlan.teamName}</div>
            <div className="text-xs">成员（{lastPlan.members.length}）：</div>
            <ul className="text-xs space-y-0.5 ml-4">
              {lastPlan.members.map((m) => (
                <li key={m.name}>
                  <span className="font-mono">{m.name}</span> — {m.role}
                  {m.engine && m.engine !== 'claude' && (
                    <span className="text-muted-foreground">（{m.engine}）</span>
                  )}
                </li>
              ))}
            </ul>
            <div className="text-xs">节点（{lastPlan.graph.nodes.length}）：
              {lastPlan.graph.nodes.map((n) => n.title).join(' → ')}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function statusLabel(status: string): string {
  return (
    {
      pending: '等待中',
      running: '执行中',
      paused: '等待审批',
      completed: '已完成',
      failed: '失败',
      cancelled: '已取消',
    } as Record<string, string>
  )[status] ?? status;
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'running':
    case 'pending':
      return 'bg-amber-50 text-amber-700';
    case 'completed':
      return 'bg-emerald-50 text-emerald-700';
    case 'failed':
      return 'bg-red-50 text-red-700';
    case 'cancelled':
      return 'bg-slate-100 text-slate-600';
    case 'paused':
      return 'bg-yellow-50 text-yellow-700';
    default:
      return 'bg-muted text-muted-foreground';
  }
}
