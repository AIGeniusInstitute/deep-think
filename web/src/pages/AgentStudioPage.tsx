import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAgentsPaasStore, type AgentDefinition, type AgentKind, type OrchestrateResult, type ResourceType, type AvailableResource, type AgentVersion, type AgentShare, type AgentCollaborator, type AgentVersionDiff, type GeneratedAgentFields } from '../stores/agents-paas';
import { useGroupsStore } from '../stores/groups';
import { api } from '../api/client';
import { PageHeader } from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import { Bot, Plus, Trash2, Link as LinkIcon, Folder, History, RotateCcw, Share2, Users, GitCompare, MessageSquare, Wand2, Loader2, Network, Play } from 'lucide-react';
import { OptimizeAgentDialog } from '@/components/agents/OptimizeAgentDialog';

const RESOURCE_LABEL: Record<ResourceType, string> = {
  mcp_server: 'MCP Server',
  skill: 'Skill',
  knowledge_base: 'Knowledge Base',
};

const DIFF_FIELD_LABEL: Record<string, string> = {
  name: '名称',
  description: '描述',
  model: '模型',
  engine: '引擎',
  max_turns: 'max_turns',
  temperature: 'temperature',
  enabled: '启用',
  mounts: '挂载',
};

export function AgentStudioPage() {
  const { list, quota, used, loading, load, loadAvailable, available, create, remove, addMount, removeMount, update, restoreVersion, versions, createShare, listShares, deleteShare, shares, listCollaborators, addCollaborator, removeCollaborator, collaborators, diffVersion, testChat, generateAgent, listWorkers, setWorkers, orchestrate } = useAgentsPaasStore();
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [model, setModel] = useState('');
  const [engine, setEngine] = useState<'claude' | 'atomcode'>('claude');
  const [maxTurns, setMaxTurns] = useState<string>('');
  const [temperature, setTemperature] = useState<string>('');
  const [kind, setKind] = useState<AgentKind>('assistant');
  const [generating, setGenerating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const [diffVersionId, setDiffVersionId] = useState<string | null>(null);
  const [showOptimize, setShowOptimize] = useState(false);
  const [showOrchestrate, setShowOrchestrate] = useState(false);

  useEffect(() => { load(); loadAvailable(); }, [load, loadAvailable]);
  const groups = useGroupsStore((s) => s.groups);
  const loadGroups = useGroupsStore((s) => s.loadGroups);
  useEffect(() => { loadGroups(); }, [loadGroups]);

  const selected = list.find((a) => a.id === selectedId) ?? null;
  const boundGroups = selected
    ? Object.entries(groups)
        .filter(([, g]) => g.agent_def_id === selected.id)
        .map(([jid, g]) => ({ jid, name: g.name, folder: g.folder }))
    : [];
  const allGroupEntries = Object.entries(groups).map(([jid, g]) => ({ jid, name: g.name, folder: g.folder }));

  const handleCreate = async () => {
    if (!name.trim()) { toast.error('Name required'); return; }
    if (used >= quota) { toast.error(`Quota exceeded (${used}/${quota})`); return; }
    const ag = await create({
      name: name.trim(),
      description: description.trim() || undefined,
      system_prompt: systemPrompt || undefined,
      model: model || null,
      engine,
      max_turns: maxTurns ? Number(maxTurns) : null,
      temperature: temperature ? Number(temperature) : null,
      enabled: true,
      kind,
    });
    if (ag) {
      toast.success('Agent created');
      setName(''); setDescription(''); setSystemPrompt(''); setModel(''); setEngine('claude'); setMaxTurns(''); setTemperature(''); setKind('assistant'); setShowCreate(false);
      setSelectedId(ag.id);
    } else toast.error('Create failed');
  };

  const handleGenerate = async () => {
    if (description.trim().length < 10) {
      toast.error('请先填写至少 10 字符的描述，再点 AI 生成');
      return;
    }
    setGenerating(true);
    try {
      const fields = await generateAgent({ name: name.trim() || undefined, description: description.trim() });
      if (!fields) {
        toast.error('AI 生成失败（provider 可能不可用或超时）');
        return;
      }
      applyGeneratedFields(fields);
      toast.success('已填入 AI 生成结果，可继续编辑后创建');
    } finally {
      setGenerating(false);
    }
  };

  function applyGeneratedFields(f: GeneratedAgentFields) {
    if (f.name) setName(f.name);
    if (f.description) setDescription(f.description);
    if (f.system_prompt) setSystemPrompt(f.system_prompt);
    setModel(f.model ?? '');
    setEngine(f.engine === 'atomcode' ? 'atomcode' : 'claude');
    setMaxTurns(f.max_turns != null ? String(f.max_turns) : '');
    setTemperature(f.temperature != null ? String(f.temperature) : '');
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <PageHeader
        title="Agent Studio"
        subtitle={`创建并管理你的 Agent（配额 ${used}/${quota}）`}
        actions={
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="size-4 mr-1" /> 新建 Agent
          </Button>
        }
      />

      {loading && <div className="text-sm text-muted-foreground mt-4">加载中…</div>}

      <div className="mt-6 grid grid-cols-12 gap-4">
        <div className="col-span-12 md:col-span-4 space-y-2">
          {list.length === 0 && !loading && (
            <div className="text-sm text-muted-foreground">暂无 Agent，点击右上角新建。</div>
          )}
          {list.map((ag) => (
            <Card
              key={ag.id}
              className={`cursor-pointer transition hover:shadow-md ${selectedId === ag.id ? 'ring-2 ring-teal-500' : ''}`}
              onClick={() => setSelectedId(ag.id)}
            >
              <CardContent className="p-3">
                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <div className="font-medium truncate flex items-center gap-2">
                      <Bot className="size-4" /> {ag.name}
                      {ag.kind === 'orchestrator' && (
                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-700">编排者</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {ag.mounts?.length ?? 0} 挂载 · {ag.model ?? '默认模型'} · {ag.engine}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`删除 Agent "${ag.name}"？`)) {
                        remove(ag.id).then((ok) => {
                          if (ok) { toast.success('Deleted'); if (selectedId === ag.id) setSelectedId(null); }
                          else toast.error('Delete failed');
                        });
                      }
                    }}
                  >
                    <Trash2 className="size-4 text-red-500" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="col-span-12 md:col-span-8">
          {selected ? (
            <Card>
              <CardContent className="p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="min-w-0 flex-1 mr-2">
                    <input
                      className="w-full text-lg font-semibold bg-transparent border-b border-transparent hover:border-border focus:border-teal-500 outline-none px-0 py-0.5"
                      defaultValue={selected.name}
                      placeholder="Agent 名称"
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v && v !== selected.name) {
                          update(selected.id, { name: v }).then((ok) => ok && toast.success('已保存'));
                        }
                      }}
                    />
                    <textarea
                      className="w-full text-sm text-muted-foreground bg-transparent border-b border-transparent hover:border-border focus:border-teal-500 outline-none resize-none px-0 py-0.5 mt-0.5"
                      rows={2}
                      defaultValue={selected.description ?? ''}
                      placeholder="点击编辑描述…"
                      onBlur={(e) => {
                        const v = e.target.value;
                        if (v !== (selected.description ?? '')) {
                          update(selected.id, { description: v }).then((ok) => ok && toast.success('已保存'));
                        }
                      }}
                    />
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setShowOptimize(true)}
                      title="AI 优化当前 Agent 的 description 与 system prompt"
                    >
                      <Wand2 className="size-4 mr-1" /> AI 优化
                    </Button>
                    <Button
                      size="sm"
                      onClick={async () => {
                        const res = await testChat(selected.id);
                        if (res) {
                          navigate(`/chat/${res.folder}`);
                        } else {
                          toast.error('启动对话失败');
                        }
                      }}
                      title="为该 Agent 创建/复用一个测试对话工作区并跳转"
                    >
                      <MessageSquare className="size-4 mr-1" /> 测试对话
                    </Button>
                    {selected.kind === 'orchestrator' && (
                      <Button
                        size="sm"
                        onClick={() => setShowOrchestrate(true)}
                        title="让该编排者拆解任务并分派给已关联的子 Agent 执行"
                      >
                        <Play className="size-4 mr-1" /> 编排运行
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        const v = !selected.enabled;
                        update(selected.id, { enabled: v }).then((ok) => ok ? toast.success(v ? 'Enabled' : 'Disabled') : toast.error('Update failed'));
                      }}
                    >
                      {selected.enabled ? '已启用' : '已禁用'} · 点击切换
                    </Button>
                  </div>
                </div>

                <div className="text-sm">
                  <div className="font-medium mb-1">System Prompt</div>
                  <textarea
                    className="w-full px-3 py-2 border rounded-md bg-background text-sm"
                    rows={5}
                    defaultValue={selected.systemPrompt}
                    placeholder="（留空则使用平台默认行为指令）"
                    onBlur={(e) => {
                      if (e.target.value !== selected.systemPrompt) {
                        update(selected.id, { system_prompt: e.target.value }).then((ok) => ok && toast.success('Saved'));
                      }
                    }}
                  />
                </div>

                <div className="flex items-center gap-2">
                  <div className="text-sm font-medium">类型</div>
                  <button
                    onClick={() => {
                      const v: AgentKind = selected.kind === 'orchestrator' ? 'assistant' : 'orchestrator';
                      update(selected.id, { kind: v }).then((ok) => ok && toast.success(v === 'orchestrator' ? '已切换为编排者' : '已切换为普通 Agent'));
                    }}
                    className="text-xs px-2 py-1 rounded border border-border hover:bg-muted"
                    title="编排者可将任务拆解并分派给关联的子 Agent 协作执行"
                  >
                    <span className={selected.kind === 'orchestrator' ? 'text-violet-700 font-medium' : ''}>
                      {selected.kind === 'orchestrator' ? '编排者（主 Agent）' : '普通 Agent'}
                    </span>
                    {' · 点击切换'}
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-sm font-medium mb-1">模型</div>
                    <input
                      className="w-full px-3 py-1.5 border rounded-md bg-background text-sm"
                      defaultValue={selected.model ?? ''}
                      placeholder="留空使用 provider 默认"
                      onBlur={(e) => {
                        const v = e.target.value || null;
                        if (v !== selected.model) update(selected.id, { model: v });
                      }}
                    />
                  </div>
                  <div>
                    <div className="text-sm font-medium mb-1">max_turns</div>
                    <input
                      type="number"
                      className="w-full px-3 py-1.5 border rounded-md bg-background text-sm"
                      defaultValue={selected.maxTurns ?? ''}
                      placeholder="留空使用 SDK 默认"
                      onBlur={(e) => {
                        const raw = e.target.value;
                        const v = raw ? Number(raw) : null;
                        if (v !== selected.maxTurns) update(selected.id, { max_turns: v });
                      }}
                    />
                  </div>
                </div>

                <MountsSection
                  agent={selected}
                  available={available}
                  onAdd={(t, id) => addMount(selected.id, t, id)}
                  onRemove={(mid) => removeMount(selected.id, mid)}
                />

                {selected.kind === 'orchestrator' && (
                  <WorkersSection
                    orchestratorId={selected.id}
                    allAgents={list}
                    onList={listWorkers}
                    onSet={setWorkers}
                  />
                )}

                <BoundGroupsSection
                  boundGroups={boundGroups}
                  allGroups={allGroupEntries}
                  onBind={async (jid) => {
                    try {
                      await api.patch(`/api/groups/${encodeURIComponent(jid)}`, { agent_def_id: selected.id });
                      await loadGroups();
                      toast.success('Agent bound to group');
                    } catch {
                      toast.error('Bind failed');
                    }
                  }}
                  onUnbind={async (jid) => {
                    try {
                      await api.patch(`/api/groups/${encodeURIComponent(jid)}`, { agent_def_id: null });
                      await loadGroups();
                      toast.success('Unbound');
                    } catch {
                      toast.error('Unbind failed');
                    }
                  }}
                />

                <ShareSection
                  agentId={selected.id}
                  shares={shares[selected.id] ?? []}
                  onCreate={async () => {
                    const s = await createShare(selected.id);
                    if (s) { toast.success('分享链接已创建'); await listShares(selected.id); }
                    else toast.error('创建失败');
                  }}
                  onRevoke={async (sid) => {
                    const ok = await deleteShare(selected.id, sid);
                    if (ok) { toast.success('已撤销'); await listShares(selected.id); }
                    else toast.error('撤销失败');
                  }}
                />

                <CollaboratorsSection
                  agentId={selected.id}
                  list={collaborators[selected.id] ?? []}
                  onAdd={async (userId, role) => {
                    const ok = await addCollaborator(selected.id, userId, role);
                    if (ok) { toast.success('已添加协作者'); await listCollaborators(selected.id); }
                    else toast.error('添加失败');
                  }}
                  onRemove={async (userId) => {
                    const ok = await removeCollaborator(selected.id, userId);
                    if (ok) { toast.success('已移除'); await listCollaborators(selected.id); }
                    else toast.error('移除失败');
                  }}
                />

                <VersionHistorySection
                  agent={selected}
                  versions={versions[selected.id] ?? []}
                  onRestore={async (vid) => {
                    const ok = await restoreVersion(selected.id, vid);
                    if (ok) toast.success('已回滚到该版本');
                    else toast.error('回滚失败');
                  }}
                  onDiff={(vid) => setDiffVersionId(vid)}
                  showAll={showVersions}
                  onToggleShow={() => setShowVersions((v) => !v)}
                />
              </CardContent>
            </Card>
          ) : (
            <div className="text-sm text-muted-foreground">选择左侧 Agent 查看详情</div>
          )}
        </div>
      </div>

      {showCreate && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setShowCreate(false)}>
          <Card className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <CardContent className="p-4 space-y-3">
              <div className="font-semibold">新建 Agent</div>
              <input
                className="w-full px-3 py-2 border rounded-md bg-background text-sm"
                placeholder="名称"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <textarea
                className="w-full px-3 py-2 border rounded-md bg-background text-sm"
                rows={2}
                placeholder="描述（用于 AI 生成的关键输入，至少 10 字符）"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleGenerate}
                  disabled={generating}
                  title="根据名称+描述，AI 自动生成专业 system prompt 等字段"
                >
                  {generating ? <Loader2 className="size-4 mr-1 animate-spin" /> : <Wand2 className="size-4 mr-1" />}
                  AI 生成
                </Button>
                <span className="text-xs text-muted-foreground">生成后可编辑再创建</span>
              </div>
              <div className="flex gap-2 items-center">
                <select
                  className="px-3 py-2 border rounded-md bg-background text-sm"
                  value={engine}
                  onChange={(e) => setEngine(e.target.value as 'claude' | 'atomcode')}
                >
                  <option value="claude">claude engine</option>
                  <option value="atomcode">atomcode engine</option>
                </select>
                <input
                  className="flex-1 px-3 py-2 border rounded-md bg-background text-sm"
                  placeholder="模型 ID（可空）"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="number"
                  className="px-3 py-2 border rounded-md bg-background text-sm"
                  placeholder="max_turns（可空）"
                  value={maxTurns}
                  onChange={(e) => setMaxTurns(e.target.value)}
                />
                <input
                  type="number"
                  step="0.1"
                  className="px-3 py-2 border rounded-md bg-background text-sm"
                  placeholder="temperature（可空）"
                  value={temperature}
                  onChange={(e) => setTemperature(e.target.value)}
                />
              </div>
              <textarea
                className="w-full px-3 py-2 border rounded-md bg-background text-sm"
                rows={6}
                placeholder="System Prompt（可空，留空则继承平台默认；点 AI 生成可自动填充）"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
              />
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setShowCreate(false)}>取消</Button>
                <Button size="sm" onClick={handleCreate}>创建</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {selected && diffVersionId && (
        <VersionDiffDialog
          agentId={selected.id}
          versionId={diffVersionId}
          onClose={() => setDiffVersionId(null)}
          fetch={diffVersion}
        />
      )}

      {selected && (
        <OptimizeAgentDialog
          open={showOptimize}
          onClose={() => setShowOptimize(false)}
          agentId={selected.id}
          agentName={selected.name}
        />
      )}

      {selected && selected.kind === 'orchestrator' && (
        <OrchestrateDialog
          open={showOrchestrate}
          onClose={() => setShowOrchestrate(false)}
          agentId={selected.id}
          agentName={selected.name}
          onRun={orchestrate}
        />
      )}
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
  available: AvailableResource | null;
  onAdd: (t: ResourceType, id: string) => void;
  onRemove: (mid: string) => void;
}) {
  const [adding, setAdding] = useState<ResourceType | null>(null);
  const mounts = agent.mounts ?? [];
  const loadAvailable = useAgentsPaasStore((s) => s.loadAvailable);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">挂载（{mounts.length}）</div>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => loadAvailable()} title="刷新挂载资源列表">
            <RotateCcw className="size-3 mr-1" /> 刷新
          </Button>
          {(['mcp_server', 'skill', 'knowledge_base'] as ResourceType[]).map((t) => (
            <Button key={t} size="sm" variant="outline" onClick={() => setAdding(t)}>
              <Plus className="size-3 mr-1" /> {RESOURCE_LABEL[t]}
            </Button>
          ))}
        </div>
      </div>

      {mounts.length === 0 && (
        <div className="text-sm text-muted-foreground">暂无挂载。Agent 启用后将使用用户全局 MCP/Skill，不挂 KB。</div>
      )}

      {mounts.map((m) => (
        <div key={m.id} className="flex items-center justify-between py-1.5 border-b last:border-0 text-sm">
          <div className="flex items-center gap-2">
            <LinkIcon className="size-4 text-muted-foreground" />
            <span className="px-1.5 py-0.5 rounded bg-muted text-xs">{RESOURCE_LABEL[m.resourceType]}</span>
            <span className="font-mono text-xs">{m.resourceId}</span>
          </div>
          <Button size="sm" variant="ghost" onClick={() => onRemove(m.id)}>
            <Trash2 className="size-4 text-red-500" />
          </Button>
        </div>
      ))}

      {adding && available && (
        <div className="border rounded-md p-2 bg-muted/30">
          <div className="text-xs font-medium mb-2">选择 {RESOURCE_LABEL[adding]} 挂载</div>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {(() => {
              const opts =
                adding === 'mcp_server' ? (available.mcp_servers.map((s: { id: string; name: string }) => ({ id: s.id, label: `${s.name} (${s.id})` })))
                : adding === 'skill' ? (available.skills.map((s: { id: string; name: string }) => ({ id: s.id, label: s.name })))
                : (available.knowledge_bases.map((k: { id: string; name: string; doc_count: number }) => ({ id: k.id, label: `${k.name} (${k.doc_count} docs)` })));
              if (opts.length === 0) {
                return (
                  <div className="text-xs text-muted-foreground">
                    {adding === 'skill' ? (
                      <>
                        暂无可挂载 Skill。前往{' '}
                        <a href="/skills" className="text-teal-600 hover:underline">Skills 管理页</a>
                        {' '}安装后，回到本页点"刷新挂载资源"按钮即可挂载。
                      </>
                    ) : (
                      '无可挂载资源'
                    )}
                  </div>
                );
              }
              return opts.map((o: { id: string; label: string }) => (
                <button
                  key={o.id}
                  className="w-full text-left px-2 py-1 text-sm hover:bg-background rounded"
                  onClick={() => {
                    onAdd(adding, o.id);
                    setAdding(null);
                  }}
                >
                  {o.label}
                </button>
              ));
            })()}
          </div>
          <div className="flex justify-end mt-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(null)}>取消</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function BoundGroupsSection({
  boundGroups,
  allGroups,
  onBind,
  onUnbind,
}: {
  boundGroups: Array<{ jid: string; name: string; folder: string }>;
  allGroups: Array<{ jid: string; name: string; folder: string }>;
  onBind: (jid: string) => void;
  onUnbind: (jid: string) => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const candidates = allGroups.filter((g) => !boundGroups.some((b) => b.jid === g.jid));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">绑定的群组（{boundGroups.length}）</div>
        <Button size="sm" variant="outline" onClick={() => setShowPicker((v) => !v)}>
          <Plus className="size-3 mr-1" /> 绑定群组
        </Button>
      </div>
      <div className="text-xs text-muted-foreground">
        绑定后，该群组的下一条消息会以这个 Agent 的 system prompt / 模型 / 挂载执行。
      </div>

      {boundGroups.length === 0 && (
        <div className="text-sm text-muted-foreground">尚未绑定到任何群组。</div>
      )}

      {boundGroups.map((g) => (
        <div key={g.jid} className="flex items-center justify-between py-1.5 border-b last:border-0 text-sm">
          <div className="flex items-center gap-2 min-w-0">
            <Folder className="size-4 text-muted-foreground" />
            <span className="truncate">{g.name}</span>
            <span className="font-mono text-xs text-muted-foreground">{g.folder}</span>
          </div>
          <Button size="sm" variant="ghost" onClick={() => onUnbind(g.jid)}>
            解绑
          </Button>
        </div>
      ))}

      {showPicker && (
        <div className="border rounded-md p-2 bg-muted/30">
          <div className="text-xs font-medium mb-2">选择要绑定的群组</div>
          {candidates.length === 0 ? (
            <div className="text-xs text-muted-foreground">所有群组都已绑定</div>
          ) : (
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {candidates.map((g) => (
                <button
                  key={g.jid}
                  className="w-full text-left px-2 py-1 text-sm hover:bg-background rounded"
                  onClick={() => { onBind(g.jid); setShowPicker(false); }}
                >
                  {g.name} <span className="text-xs text-muted-foreground">({g.folder})</span>
                </button>
              ))}
            </div>
          )}
          <div className="flex justify-end mt-2">
            <Button size="sm" variant="ghost" onClick={() => setShowPicker(false)}>取消</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function VersionHistorySection({
  agent,
  versions,
  onRestore,
  onDiff,
  showAll,
  onToggleShow,
}: {
  agent: AgentDefinition;
  versions: AgentVersion[];
  onRestore: (vid: string) => void | Promise<void>;
  onDiff: (vid: string) => void;
  showAll: boolean;
  onToggleShow: () => void;
}) {
  const listVersions = useAgentsPaasStore((s) => s.listVersions);
  useEffect(() => { void listVersions(agent.id); }, [agent.id, listVersions]);

  const list = showAll ? versions : versions.slice(0, 3);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium flex items-center gap-2">
          <History className="size-4" /> 版本历史（{versions.length}）
        </div>
        {versions.length > 3 && (
          <Button size="sm" variant="ghost" onClick={onToggleShow}>
            {showAll ? '收起' : `展开全部 (${versions.length})`}
          </Button>
        )}
      </div>
      <div className="text-xs text-muted-foreground">
        每次修改 Agent 会自动生成版本快照（最多保留 20 个）。回滚前会再生成一个当前状态快照作为 undo。
      </div>

      {versions.length === 0 ? (
        <div className="text-sm text-muted-foreground">尚无版本历史。修改 Agent 后会自动创建快照。</div>
      ) : (
        <div className="space-y-1">
          {list.map((v) => (
            <div key={v.id} className="flex items-center justify-between py-1.5 border-b last:border-0 text-sm">
              <div className="flex items-center gap-2">
                <span className="px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 font-mono text-xs">v{v.version}</span>
                <span className="text-xs text-muted-foreground">
                  {new Date(v.created_at).toLocaleString('zh-CN')} · {v.created_by.slice(0, 8)}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onDiff(v.id)}
                  title="查看与当前版本的差异"
                >
                  <GitCompare className="size-4 mr-1" /> Diff
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (confirm(`回滚到 v${v.version}？当前状态会自动保存为新版本作为 undo。`)) {
                      onRestore(v.id);
                    }
                  }}
                >
                  <RotateCcw className="size-4 mr-1" /> 回滚
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ShareSection({
  agentId,
  shares,
  onCreate,
  onRevoke,
}: {
  agentId: string;
  shares: AgentShare[];
  onCreate: () => void | Promise<void>;
  onRevoke: (sid: string) => void | Promise<void>;
}) {
  const listShares = useAgentsPaasStore((s) => s.listShares);
  useEffect(() => { void listShares(agentId); }, [agentId, listShares]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium flex items-center gap-2">
          <Share2 className="size-4" /> 分享链接（{shares.length}）
        </div>
        <Button size="sm" variant="outline" onClick={() => void onCreate()}>
          <Plus className="size-3 mr-1" /> 生成分享链接
        </Button>
      </div>
      <div className="text-xs text-muted-foreground">
        生成公开链接，任何人通过链接可以查看 Agent 信息（含 200 字 prompt 预览）并安装到自己的账户。
      </div>

      {shares.length === 0 ? (
        <div className="text-sm text-muted-foreground">尚未生成分享链接。</div>
      ) : (
        <div className="space-y-1">
          {shares.map((s) => {
            const url = `${window.location.origin}${s.shareUrl}`;
            return (
              <div key={s.id} className="flex items-center justify-between py-1.5 border-b last:border-0 text-sm gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs truncate">{s.shareToken}</span>
                    <button
                      className="text-xs text-teal-600 hover:underline"
                      onClick={() => {
                        navigator.clipboard.writeText(url).then(() => toast.success('链接已复制'));
                      }}
                    >
                      复制链接
                    </button>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    安装 {s.installCount} 次 · {new Date(s.createdAt).toLocaleString('zh-CN')}
                    {s.expiresAt ? ` · 过期 ${new Date(s.expiresAt).toLocaleString('zh-CN')}` : ' · 永不过期'}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (confirm('撤销该分享链接？已安装的副本不受影响。')) void onRevoke(s.id);
                  }}
                >
                  <Trash2 className="size-4 text-red-500" />
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CollaboratorsSection({
  agentId,
  list,
  onAdd,
  onRemove,
}: {
  agentId: string;
  list: AgentCollaborator[];
  onAdd: (userId: string, role: 'editor' | 'viewer') => void | Promise<void>;
  onRemove: (userId: string) => void | Promise<void>;
}) {
  const listCollaborators = useAgentsPaasStore((s) => s.listCollaborators);
  const [showAdd, setShowAdd] = useState(false);
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('viewer');

  useEffect(() => { void listCollaborators(agentId); }, [agentId, listCollaborators]);

  const handleAdd = async () => {
    if (!userId.trim()) { toast.error('请填写用户 ID'); return; }
    await onAdd(userId.trim(), role);
    setUserId('');
    setRole('viewer');
    setShowAdd(false);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium flex items-center gap-2">
          <Users className="size-4" /> 协作者（{list.length}）
        </div>
        <Button size="sm" variant="outline" onClick={() => setShowAdd((v) => !v)}>
          <Plus className="size-3 mr-1" /> 添加协作者
        </Button>
      </div>
      <div className="text-xs text-muted-foreground">
        协作者可以查看该 Agent。editor 可修改，viewer 只读。Owner 隐式拥有全部权限。
      </div>

      {list.length === 0 && !showAdd && (
        <div className="text-sm text-muted-foreground">尚未添加协作者。</div>
      )}

      {list.map((c) => (
        <div key={c.userId} className="flex items-center justify-between py-1.5 border-b last:border-0 text-sm">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-muted">{c.username}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded ${c.role === 'editor' ? 'bg-teal-100 text-teal-700' : 'bg-slate-100 text-slate-600'}`}>
              {c.role}
            </span>
            <span className="text-xs text-muted-foreground truncate">
              由 {c.addedBy.slice(0, 8)} 添加 · {new Date(c.addedAt).toLocaleString('zh-CN')}
            </span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (confirm(`移除协作者 ${c.username}？`)) void onRemove(c.userId);
            }}
          >
            <Trash2 className="size-4 text-red-500" />
          </Button>
        </div>
      ))}

      {showAdd && (
        <div className="border rounded-md p-2 bg-muted/30 space-y-2">
          <input
            className="w-full px-3 py-1.5 border rounded-md bg-background text-sm"
            placeholder="用户 ID（UUID）"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
          />
          <select
            className="w-full px-3 py-1.5 border rounded-md bg-background text-sm"
            value={role}
            onChange={(e) => setRole(e.target.value as 'editor' | 'viewer')}
          >
            <option value="viewer">viewer（只读）</option>
            <option value="editor">editor（可修改）</option>
          </select>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)}>取消</Button>
            <Button size="sm" onClick={() => void handleAdd()}>添加</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function VersionDiffDialog({
  agentId,
  versionId,
  onClose,
  fetch,
}: {
  agentId: string;
  versionId: string;
  onClose: () => void;
  fetch: (agentId: string, versionId: string) => Promise<AgentVersionDiff | null>;
}) {
  const [diff, setDiff] = useState<AgentVersionDiff | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(agentId, versionId).then((d) => {
      if (!cancelled) { setDiff(d); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [agentId, versionId, fetch]);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <Card className="w-full max-w-2xl max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <CardContent className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="font-semibold flex items-center gap-2">
              <GitCompare className="size-4" /> 版本差异对比
            </div>
            <Button variant="outline" size="sm" onClick={onClose}>关闭</Button>
          </div>

          {loading ? (
            <div className="text-sm text-muted-foreground py-4 text-center">加载中…</div>
          ) : !diff ? (
            <div className="text-sm text-red-600 py-4 text-center">加载差异失败</div>
          ) : (
            <>
              <div className="text-xs text-muted-foreground">
                左侧为该历史版本（旧），右侧为当前版本（新）。绿色 = 新增，红色 = 删除。
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium">字段对比</div>
                <div className="rounded-md border border-border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-xs text-muted-foreground">
                      <tr>
                        <th className="text-left px-2 py-1">字段</th>
                        <th className="text-left px-2 py-1">旧</th>
                        <th className="text-left px-2 py-1">新</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diff.fields.map((f) => (
                        <tr key={f.name} className={f.same ? '' : 'bg-amber-50/30'}>
                          <td className="px-2 py-1 font-medium">{DIFF_FIELD_LABEL[f.name] ?? f.name}</td>
                          <td className="px-2 py-1 font-mono text-xs whitespace-pre-wrap break-all">{f.before || '—'}</td>
                          <td className="px-2 py-1 font-mono text-xs whitespace-pre-wrap break-all">
                            {f.same ? (
                              <span className="text-muted-foreground">{f.after || '—'}</span>
                            ) : (
                              <span className="text-emerald-700">{f.after || '—'}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium flex items-center justify-between">
                  <span>System Prompt 差异</span>
                  {diff.promptSame && <span className="text-xs text-muted-foreground">（无变化）</span>}
                </div>
                <pre className="rounded-md border border-border bg-muted/20 p-3 text-xs font-mono overflow-x-auto max-h-64">
                  {diff.promptDiff.map((l, i) => {
                    const color = l.op === '+' ? 'text-emerald-700' : l.op === '-' ? 'text-red-700' : 'text-muted-foreground';
                    const prefix = l.op === '+' ? '+' : l.op === '-' ? '-' : ' ';
                    return (
                      <div key={i} className={color}>
                        {prefix} {l.line}
                      </div>
                    );
                  })}
                </pre>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function WorkersSection({
  orchestratorId,
  allAgents,
  onList,
  onSet,
}: {
  orchestratorId: string;
  allAgents: AgentDefinition[];
  onList: (agentId: string) => Promise<AgentDefinition[]>;
  onSet: (agentId: string, workerIds: string[]) => Promise<AgentDefinition[]>;
}) {
  const [workers, setWorkersState] = useState<AgentDefinition[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    onList(orchestratorId).then((w) => {
      if (!cancelled) { setWorkersState(w); setLoaded(true); }
    });
    return () => { cancelled = true; };
  }, [orchestratorId, onList]);

  const candidates = allAgents.filter((a) => a.id !== orchestratorId && a.kind !== 'orchestrator');
  const workerIds = new Set(workers.map((w) => w.id));

  const toggle = async (agentId: string) => {
    const next = new Set(workerIds);
    if (next.has(agentId)) next.delete(agentId);
    else next.add(agentId);
    const ids = [...next];
    try {
      const updated = await onSet(orchestratorId, ids);
      setWorkersState(updated);
      toast.success(`已关联 ${updated.length} 个子 Agent`);
    } catch {
      toast.error('更新子 Agent 关联失败');
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium flex items-center gap-2">
          <Network className="size-4" /> 关联子 Agent（Workers，{workers.length}）
        </div>
      </div>
      <div className="text-xs text-muted-foreground">
        勾选后，编排运行时会把复杂任务拆解并分派给这些子 Agent 协作完成。仅普通 Agent 可作为 Worker。
      </div>

      {!loaded ? (
        <div className="text-sm text-muted-foreground">加载中…</div>
      ) : candidates.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          暂无可关联的普通 Agent。请先在 Agent Studio 创建若干子 Agent。
        </div>
      ) : (
        <div className="space-y-1 max-h-56 overflow-y-auto border rounded-md p-2 bg-muted/20">
          {candidates.map((a) => (
            <label
              key={a.id}
              className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-background cursor-pointer text-sm"
            >
              <input
                type="checkbox"
                checked={workerIds.has(a.id)}
                onChange={() => void toggle(a.id)}
              />
              <Bot className="size-4 text-muted-foreground" />
              <span className="truncate">{a.name}</span>
              <span className="text-xs text-muted-foreground truncate">{a.description || '—'}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function OrchestrateDialog({
  open,
  onClose,
  agentId,
  agentName,
  onRun,
}: {
  open: boolean;
  onClose: () => void;
  agentId: string;
  agentName: string;
  onRun: (
    agentId: string,
    input: { task: string; background?: string; acceptanceCriteria?: string },
  ) => Promise<OrchestrateResult | { error: string; detail?: string } | null>;
}) {
  const [task, setTask] = useState('');
  const [background, setBackground] = useState('');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<OrchestrateResult | null>(null);

  useEffect(() => {
    if (open) {
      setTask('');
      setBackground('');
      setAcceptanceCriteria('');
      setResult(null);
    }
  }, [open]);

  if (!open) return null;

  const handleRun = async () => {
    if (!task.trim()) {
      toast.error('请输入要完成的任务');
      return;
    }
    setRunning(true);
    setResult(null);
    try {
      const res = await onRun(agentId, {
        task: task.trim(),
        background: background.trim() || undefined,
        acceptanceCriteria: acceptanceCriteria.trim() || undefined,
      });
      if (res && 'error' in res) {
        toast.error(res.detail ? `${res.error}：${res.detail}` : (res.error ?? '编排失败'));
      } else if (res && 'ok' in res) {
        setResult(res);
        toast.success('编排运行已启动');
      } else {
        toast.error('编排启动失败');
      }
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <Card className="w-full max-w-lg max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <CardContent className="p-4 space-y-3">
          <div className="font-semibold flex items-center gap-2">
            <Play className="size-4" /> 编排运行：{agentName}
          </div>

          <div>
            <label className="text-xs text-muted-foreground block mb-1">任务 *</label>
            <textarea
              className="w-full px-3 py-2 border rounded-md bg-background text-sm"
              rows={3}
              placeholder="输入复杂任务，编排者会拆解并分派给子 Agent 协作完成"
              value={task}
              onChange={(e) => setTask(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">背景（可选）</label>
            <textarea
              className="w-full px-3 py-2 border rounded-md bg-background text-sm"
              rows={2}
              placeholder="补充上下文"
              value={background}
              onChange={(e) => setBackground(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">验收标准（可选）</label>
            <input
              className="w-full px-3 py-2 border rounded-md bg-background text-sm"
              placeholder="例如：交付物必须包含可运行的代码"
              value={acceptanceCriteria}
              onChange={(e) => setAcceptanceCriteria(e.target.value)}
            />
          </div>

          {result && (
            <div className="border rounded-md p-3 bg-muted/20 space-y-1 text-sm">
              <div className="font-medium text-xs text-muted-foreground">已启动编排计划（{result.plan.steps.length} 步）</div>
              <div className="text-xs font-mono text-muted-foreground">runId: {result.runId}</div>
              <ol className="list-decimal list-inside space-y-0.5">
                {result.plan.steps.map((s) => (
                  <li key={s.id} className="text-xs">
                    <span className="font-medium">{s.title}</span>
                    <span className="text-muted-foreground"> · worker {s.workerId.slice(0, 8)}</span>
                    {s.dependsOn.length > 0 && <span className="text-muted-foreground"> · 依赖 {s.dependsOn.join(', ')}</span>}
                  </li>
                ))}
              </ol>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>关闭</Button>
            <Button size="sm" onClick={() => void handleRun()} disabled={running}>
              {running ? <Loader2 className="size-4 mr-1 animate-spin" /> : <Play className="size-4 mr-1" />}
              启动编排
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
