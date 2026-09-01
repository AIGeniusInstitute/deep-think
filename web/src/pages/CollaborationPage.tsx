/**
 * Multi-User Collaboration page. Input a complex task, pick a collaboration
 * mode (orchestrator-worker / peer / critic-adversarial) and optional scenario
 * preset, DeepThink autonomously decomposes it into a mode-appropriate agent
 * team (mode-aware prompt + generic graph assembly) and starts a run in the
 * shared group workspace. Execution view reuses GraphDagView +
 * AgentConversationPanel (split). Shared artifacts + memory persisted to
 * data/groups/{folder}/collaborations/{collabId}/ for all group members.
 */
import { useEffect, useMemo, useState } from 'react';
import { History, Square } from 'lucide-react';
import { useCollaborationStore, type CollaborationMode } from '../stores/collaborations';
import { useGroupsStore } from '../stores/groups';
import { useGraphStore } from '../stores/graph';
import { GraphDagView } from '../components/graph/GraphDagView';
import { AgentConversationPanel } from '../components/team/AgentConversationPanel';
import { ResizableSplitter } from '../components/team/ResizableSplitter';
import { toast } from 'sonner';

const MODE_OPTIONS: Array<{
  id: CollaborationMode;
  label: string;
  desc: string;
}> = [
  {
    id: 'orchestrator-worker',
    label: '编排者-工作者',
    desc: '编排者拆解分派、串行依赖链、gate 验收',
  },
  {
    id: 'peer',
    label: '对等并行',
    desc: 'N 个对等角色并行产出不同视角方案，汇聚验收',
  },
  {
    id: 'critic-adversarial',
    label: '批评对抗',
    desc: '产出→批判 gate 找漏洞→带反馈重做，对抗闭环',
  },
];

const SCENARIO_OPTIONS: Array<{
  id: string;
  label: string;
  mode: CollaborationMode;
  goal: string;
  criteria: string;
}> = [
  {
    id: 'software-engineering',
    label: '软件工程开发流程',
    mode: 'orchestrator-worker',
    goal: '实现一个最小可运行的 TODO CLI（增删查改 + 持久化），并编写单元测试，确保测试全部通过。',
    criteria: '测试全部通过（退出码 0）；CLI 可增删查改 TODO 并持久化。',
  },
  {
    id: 'brainstorm',
    label: '创新脑暴方案',
    mode: 'peer',
    goal: '就「AI 时代个人的超级竞争力是什么」产出 3 个不同视角的创新方案，每个方案有独立立论与可落地路径。',
    criteria: '3 个方案文件齐备且视角不同；每个方案含立论+落地路径。',
  },
  {
    id: 'philosophy-critique',
    label: '唯心主义唯物主义理性批判',
    mode: 'critic-adversarial',
    goal: '就「意识是大脑的涌现属性，不存在独立的心物二元」产出论点并经对立批判者严格批判，最终产出一个经得起批判的修订论证。',
    criteria: '论证含修订痕迹（回应了批判/反驳了反例）；批判者未发现致命逻辑谬误。',
  },
];

const TOOLSET_OPTIONS = [
  { id: 'web-research', label: '网络搜索' },
  { id: 'code-execution', label: '代码执行' },
  { id: 'file-io', label: '文件读写' },
  { id: 'mcp:deepthink', label: 'DeepThink MCP' },
];

export function CollaborationPage() {
  const building = useCollaborationStore((s) => s.building);
  const error = useCollaborationStore((s) => s.error);
  const lastRunId = useCollaborationStore((s) => s.lastRunId);
  const lastPlan = useCollaborationStore((s) => s.lastPlan);
  const lastMode = useCollaborationStore((s) => s.lastMode);
  const lastCollabId = useCollaborationStore((s) => s.lastCollabId);
  const buildCollaboration = useCollaborationStore((s) => s.buildCollaboration);
  const history = useCollaborationStore((s) => s.history);
  const loadHistory = useCollaborationStore((s) => s.loadHistory);
  const openHistory = useCollaborationStore((s) => s.openHistory);

  const groups = useGroupsStore((s) => s.groups);
  const loadGroups = useGroupsStore((s) => s.loadGroups);
  const startPolling = useGraphStore((s) => s.startPolling);
  const stopPolling = useGraphStore((s) => s.stopPolling);
  const cancelRun = useGraphStore((s) => s.cancelRun);
  const currentRun = useGraphStore((s) => s.currentRun);

  const [goal, setGoal] = useState('');
  const [background, setBackground] = useState('');
  const [criteria, setCriteria] = useState('');
  const [mode, setMode] = useState<CollaborationMode>('orchestrator-worker');
  const [scenario, setScenario] = useState<string>('');
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

  const applyScenario = (id: string) => {
    setScenario(id);
    const s = SCENARIO_OPTIONS.find((o) => o.id === id);
    if (s) {
      setGoal(s.goal);
      setCriteria(s.criteria);
      setMode(s.mode);
    }
  };

  const handleBuild = async () => {
    if (!goal.trim() || !home) return;
    await buildCollaboration({
      goalText: goal.trim(),
      background: background.trim() || undefined,
      acceptanceCriteria: criteria.trim() || undefined,
      mode,
      scenario: scenario || undefined,
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
    if (ok) toast.success('已发送终止指令');
    else toast.error('终止失败');
  };

  const toggleTool = (id: string) => {
    setToolset((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));
  };

  const isTerminal =
    currentRun?.status === 'completed' ||
    currentRun?.status === 'failed' ||
    currentRun?.status === 'cancelled';

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
              useCollaborationStore.getState().reset();
            }}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← 新建协作
          </button>
          <span className="text-sm text-muted-foreground truncate">
            协作 {lastPlan?.teamName ?? ''} · {lastMode ?? ''} · 运行 {lastRunId.slice(0, 12)}
          </span>
          {currentRun && (
            <span className={`text-xs px-2 py-0.5 rounded ${statusBadgeClass(currentRun.status)}`}>
              {statusLabel(currentRun.status)}
            </span>
          )}
          <div className="flex-1" />
          {lastCollabId && (
            <a
              href={`/api/collaborations/runs/${encodeURIComponent(lastCollabId)}/deliverables`}
              target="_blank"
              rel="noreferrer"
              className="text-xs px-2.5 py-1 rounded border border-border hover:bg-muted"
            >
              共享产物
            </a>
          )}
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
          <h2 className="font-semibold text-foreground">多人协作</h2>
          <p className="text-xs text-muted-foreground mt-1">
            选择协作模式，DeepThink 按模式自主拆解、组建 Agent 协作群（编排者-工作者 / 对等并行 / 批评对抗），产物落入共享工作区，群内成员共享上下文/记忆/任务状态。
          </p>
        </div>
        <button
          onClick={() => {
            setShowHistory((v) => !v);
            if (!showHistory) void loadHistory();
          }}
          className="flex items-center gap-1 text-xs px-2.5 py-1 rounded border border-border hover:bg-muted"
        >
          <History className="h-3.5 w-3.5" /> 历史协作
        </button>
      </div>

      <div className="p-4 space-y-3 max-w-3xl">
        {showHistory && (
          <div className="border border-border rounded p-3 space-y-1 bg-muted/20">
            <div className="text-xs text-muted-foreground mb-1">历史协作任务</div>
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
                  <span className="font-mono text-[10px] text-muted-foreground">{h.mode}</span>
                  <span className="font-medium truncate flex-1">
                    {h.teamName ?? h.goalText.slice(0, 36)}
                  </span>
                  <span className="text-muted-foreground">
                    {new Date(h.createdAt).toLocaleString('zh-CN')}
                  </span>
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

        {/* Scenario presets */}
        <div>
          <label className="text-xs text-muted-foreground block mb-1">场景预设（可选，自动填充目标与模式）</label>
          <div className="flex flex-wrap gap-2">
            {SCENARIO_OPTIONS.map((s) => (
              <button
                key={s.id}
                onClick={() => applyScenario(s.id)}
                className={`text-xs px-2.5 py-1 rounded border ${
                  scenario === s.id
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border hover:bg-muted'
                }`}
              >
                {s.label}
              </button>
            ))}
            <button
              onClick={() => {
                setScenario('');
                setGoal('');
                setCriteria('');
              }}
              className="text-xs px-2.5 py-1 rounded border border-border hover:bg-muted text-muted-foreground"
            >
              自定义
            </button>
          </div>
        </div>

        {/* Mode selection */}
        <div>
          <label className="text-xs text-muted-foreground block mb-1">协作模式 *</label>
          <div className="grid grid-cols-3 gap-2">
            {MODE_OPTIONS.map((m) => (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                className={`text-left p-2 rounded border ${
                  mode === m.id
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border hover:bg-muted'
                }`}
              >
                <div className="text-sm font-medium">{m.label}</div>
                <div className={`text-[10px] mt-0.5 ${mode === m.id ? 'text-background/80' : 'text-muted-foreground'}`}>
                  {m.desc}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-xs text-muted-foreground block mb-1">任务目标 *</label>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={4}
            placeholder="例：调研 2026 年 Agent 框架趋势，实现 TODO 原型并写测试，产出报告 + 代码 + 测试"
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
                    name="collabexecmode"
                    checked={executionMode === 'auto'}
                    onChange={() => setExecutionMode('auto')}
                  />
                  自动（全程自主）
                </label>
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="radio"
                    name="collabexecmode"
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
              <label className="text-xs text-muted-foreground block mb-1">验收标准（可选）</label>
              <textarea
                value={criteria}
                onChange={(e) => setCriteria(e.target.value)}
                rows={2}
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
          {building ? '组建协作中…（拆解 + 创建成员 + 组装图）' : '🤝 组建协作并启动'}
        </button>

        {lastPlan && (
          <div className="border border-border rounded p-3 space-y-2">
            <div className="text-xs text-muted-foreground">
              协作计划预览 · 模式 {lastMode}
            </div>
            <div className="text-sm font-medium">协作：{lastPlan.teamName}</div>
            <div className="text-xs">成员（{lastPlan.members.length}）：</div>
            <ul className="text-xs space-y-0.5 ml-4">
              {lastPlan.members.map((m) => (
                <li key={m.name}>
                  <span className="font-mono">{m.name}</span> — {m.role}
                </li>
              ))}
            </ul>
            <div className="text-xs">
              节点（{lastPlan.graph.nodes.length}）：{lastPlan.graph.nodes.map((n) => n.title).join(' → ')}
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
