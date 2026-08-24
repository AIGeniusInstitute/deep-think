/**
 * AgentEditorPanel — reusable create/edit form for an Agent definition.
 *
 * Reuses useAgentsPaasStore (POST/PATCH /api/paas/agents + mounts), the same
 * backend the AgentStudioPage uses. Used by the workflow node inspector to
 * let users bind/create/edit an Agent inline on a workflow agent node (PRD FP3,
 * "单节点编辑复用 Agent Studio 的能力").
 *
 * Props:
 *  - agentDefId?: when set, the panel loads that agent (edit mode); otherwise
 *    it starts in create mode.
 *  - onBound?(agentDefId, name): called after create so the caller can bind the
 *    new agent to its node.
 *  - compact?: render a tighter layout for embedding in a side panel.
 */
import { useEffect, useState } from 'react';
import { useAgentsPaasStore, type AgentDefinition } from '../../stores/agents-paas';
import { toast } from 'sonner';

interface Props {
  agentDefId?: string | null;
  onBound?: (agentDefId: string, name: string) => void;
  compact?: boolean;
}

const ENGINES: Array<{ value: AgentDefinition['engine']; label: string }> = [
  { value: 'claude', label: 'Claude' },
  { value: 'atomcode', label: 'AtomCode' },
];

export function AgentEditorPanel({ agentDefId, onBound, compact }: Props) {
  const list = useAgentsPaasStore((s) => s.list);
  const available = useAgentsPaasStore((s) => s.available);
  const load = useAgentsPaasStore((s) => s.load);
  const loadAvailable = useAgentsPaasStore((s) => s.loadAvailable);
  const create = useAgentsPaasStore((s) => s.create);
  const update = useAgentsPaasStore((s) => s.update);
  const addMount = useAgentsPaasStore((s) => s.addMount);
  const removeMount = useAgentsPaasStore((s) => s.removeMount);

  const [mode, setMode] = useState<'create' | 'edit'>(agentDefId ? 'edit' : 'create');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [engine, setEngine] = useState<AgentDefinition['engine']>('claude');
  const [model, setModel] = useState('');
  const [maxTurns, setMaxTurns] = useState<number>(20);
  const [temperature, setTemperature] = useState<number>(0.7);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void load();
    void loadAvailable();
  }, [load, loadAvailable]);

  // When an agentDefId is provided (or changes), load its fields into the form.
  const agent = agentDefId ? list.find((a) => a.id === agentDefId) : undefined;
  useEffect(() => {
    if (agent && mode === 'edit') {
      setName(agent.name);
      setDescription(agent.description ?? '');
      setSystemPrompt(agent.systemPrompt ?? '');
      setEngine(agent.engine);
      setModel(agent.model ?? '');
      setMaxTurns(agent.maxTurns ?? 20);
      setTemperature(agent.temperature ?? 0.7);
    }
  }, [agent, mode]);

  const persist = async () => {
    if (!name.trim()) {
      toast.error('Agent 名称不能为空');
      return;
    }
    setSaving(true);
    try {
      if (mode === 'create') {
        const created = await create({
          name: name.trim(),
          description,
          system_prompt: systemPrompt,
          engine,
          model: model || null,
          max_turns: maxTurns,
          temperature,
          enabled: true,
        });
        if (created) {
          toast.success('Agent 已创建');
          onBound?.(created.id, created.name);
          setMode('edit');
        } else {
          toast.error('创建失败');
        }
      } else if (agent) {
        const ok = await update(agent.id, {
          name: name.trim(),
          description,
          system_prompt: systemPrompt,
          engine,
          model: model || null,
          max_turns: maxTurns,
          temperature,
        });
        if (ok) toast.success('已保存');
        else toast.error('保存失败');
      }
    } finally {
      setSaving(false);
    }
  };

  const inputCls = 'w-full text-sm rounded border border-border bg-background px-2 py-1';

  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase text-muted-foreground">
          {mode === 'create' ? '新建 Agent' : '编辑 Agent'}
        </span>
        {mode === 'edit' && (
          <button
            onClick={() => {
              setMode('create');
              setName('');
              setDescription('');
              setSystemPrompt('');
              setModel('');
            }}
            className="text-[10px] text-blue-600 hover:underline"
          >
            切换为新建
          </button>
        )}
      </div>

      <div>
        <label className="text-[10px] text-muted-foreground block mb-0.5">名称 *</label>
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label className="text-[10px] text-muted-foreground block mb-0.5">描述</label>
        <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div>
        <label className="text-[10px] text-muted-foreground block mb-0.5">System Prompt</label>
        <textarea
          className={`${inputCls} resize-y font-mono`}
          rows={compact ? 4 : 8}
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
        />
      </div>
      <div className="flex gap-2">
        <div className="flex-1">
          <label className="text-[10px] text-muted-foreground block mb-0.5">引擎</label>
          <select
            className={inputCls}
            value={engine}
            onChange={(e) => setEngine(e.target.value as AgentDefinition['engine'])}
          >
            {ENGINES.map((en) => (
              <option key={en.value} value={en.value}>
                {en.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1">
          <label className="text-[10px] text-muted-foreground block mb-0.5">模型（可空）</label>
          <input className={inputCls} value={model} onChange={(e) => setModel(e.target.value)} placeholder="继承默认" />
        </div>
      </div>
      <div className="flex gap-2">
        <div className="flex-1">
          <label className="text-[10px] text-muted-foreground block mb-0.5">maxTurns</label>
          <input
            type="number"
            className={inputCls}
            value={maxTurns}
            onChange={(e) => setMaxTurns(Number(e.target.value) || 20)}
          />
        </div>
        <div className="flex-1">
          <label className="text-[10px] text-muted-foreground block mb-0.5">temperature</label>
          <input
            type="number"
            step="0.1"
            className={inputCls}
            value={temperature}
            onChange={(e) => setTemperature(Number(e.target.value) || 0)}
          />
        </div>
      </div>

      {/* Mounts (edit mode only — needs an existing agent). */}
      {mode === 'edit' && agent && (
        <MountsSection
          agent={agent}
          available={available}
          onAdd={(rt, rid) => void addMount(agent.id, rt, rid)}
          onRemove={(mid) => void removeMount(agent.id, mid)}
        />
      )}

      <button
        onClick={() => void persist()}
        disabled={saving}
        className="w-full px-3 py-1.5 rounded bg-foreground text-background text-xs hover:opacity-90 disabled:opacity-50"
      >
        {saving ? '保存中…' : mode === 'create' ? '创建 Agent' : '保存修改'}
      </button>
    </div>
  );
}

function MountsSection({
  agent,
  available,
  onAdd,
  onRemove,
}: {
  agent: AgentDefinition;
  available: ReturnType<typeof useAgentsPaasStore.getState>['available'];
  onAdd: (rt: 'mcp_server' | 'skill' | 'knowledge_base', rid: string) => void;
  onRemove: (mid: string) => void;
}) {
  const mounts = agent.mounts ?? [];
  const [rt, setRt] = useState<'mcp_server' | 'skill' | 'knowledge_base'>('skill');
  const [rid, setRid] = useState('');

  const optionsFor = (t: 'mcp_server' | 'skill' | 'knowledge_base') => {
    if (!available) return [] as Array<{ id: string; name: string }>;
    if (t === 'mcp_server') return available.mcp_servers.map((m) => ({ id: m.id, name: m.name }));
    if (t === 'skill') return available.skills.map((m) => ({ id: m.id, name: m.name }));
    return available.knowledge_bases.map((m) => ({ id: m.id, name: m.name }));
  };

  const opts = optionsFor(rt);
  return (
    <div className="border border-border rounded p-2 space-y-1.5">
      <div className="text-[10px] text-muted-foreground">挂载（工具 / 技能 / 知识库）</div>
      {mounts.length === 0 && <div className="text-[10px] text-muted-foreground/70">无挂载</div>}
      {mounts.map((m) => (
        <div key={m.id} className="flex items-center justify-between text-[11px]">
          <span className="truncate">
            <span className="text-slate-400">[{m.resourceType}]</span> {m.resourceId}
          </span>
          <button
            onClick={() => onRemove(m.id)}
            className="text-red-500 hover:underline text-[10px]"
          >
            移除
          </button>
        </div>
      ))}
      <div className="flex gap-1 pt-1">
        <select
          className="flex-1 text-[11px] rounded border border-border bg-background px-1 py-0.5"
          value={rt}
          onChange={(e) => {
            setRt(e.target.value as typeof rt);
            setRid('');
          }}
        >
          <option value="skill">技能</option>
          <option value="mcp_server">MCP</option>
          <option value="knowledge_base">知识库</option>
        </select>
        <select
          className="flex-1 text-[11px] rounded border border-border bg-background px-1 py-0.5"
          value={rid}
          onChange={(e) => setRid(e.target.value)}
        >
          <option value="">选择…</option>
          {opts.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        <button
          onClick={() => rid && onAdd(rt, rid)}
          disabled={!rid}
          className="text-[11px] px-2 rounded border border-border hover:bg-muted disabled:opacity-40"
        >
          +
        </button>
      </div>
    </div>
  );
}
