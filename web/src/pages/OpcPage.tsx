/**
 * OPC（一人公司）页面。一级菜单「OPC」入口。
 *
 * 左栏公司列表 + 右栏公司详情：
 *   - 统计卡（目标总数 / 各状态 / 运行中）
 *   - 成果分成摘要
 *   - 目标看板（按 status 分组）
 *   - 目标卡片支持「启动团队」（委托 useTeamStore.buildTeam，以目标为 goalText，
 *     用主工作区作 groupFolder/chatJid，成功后回写 run_id/status=running）
 *     与「查看运行」（openHistory 跳转 /team 恢复 DAG 可视化）。
 *
 * launch 编排在本组件完成——需同时访问 opc/team/groups 三个 store，放 store
 * 会耦合；放组件保持各 store 单一职责。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, Plus, Pencil, Trash2, Rocket, ExternalLink, Target } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader, EmptyState, ConfirmDialog } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  useOpcStore,
  type OpcCompany,
  type OpcObjective,
  type OpcScaleTier,
  type OpcObjectiveStatus,
  type RevenueSharePartner,
} from '../stores/opc';
import { useTeamStore } from '../stores/team';
import { useGroupsStore } from '../stores/groups';

const SCALE_TIERS: { value: OpcScaleTier; label: string }[] = [
  { value: 'solo', label: '单人' },
  { value: 'small', label: '小型' },
  { value: 'mid', label: '中型' },
];

const OBJ_STATUS_LABEL: Record<OpcObjectiveStatus, string> = {
  draft: '草稿',
  active: '待启动',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
};

const OBJ_STATUS_STYLE: Record<OpcObjectiveStatus, string> = {
  draft: 'bg-muted text-muted-foreground',
  active: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  running: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  completed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
};

const STATUS_GROUPS: OpcObjectiveStatus[] = ['draft', 'active', 'running', 'completed', 'failed'];

/** 找到用户主工作区的 folder + jid，供 buildTeam 使用。 */
function useHomeWorkspace() {
  const groups = useGroupsStore((s) => s.groups);
  return useMemo(() => {
    for (const [jid, info] of Object.entries(groups)) {
      if (info.is_my_home) return { jid, folder: info.folder };
    }
    return null;
  }, [groups]);
}

export function OpcPage() {
  const navigate = useNavigate();
  const {
    companies, companiesLoading,
    objectivesByCompany, objectivesLoading,
    loadCompanies, createCompany, updateCompany, deleteCompany,
    loadObjectives, createObjective, updateObjective, deleteObjective,
    error,
  } = useOpcStore();
  const buildTeam = useTeamStore((s) => s.buildTeam);
  const openHistory = useTeamStore((s) => s.openHistory);
  const loadGroups = useGroupsStore((s) => s.loadGroups);
  const home = useHomeWorkspace();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [companyDialog, setCompanyDialog] = useState<{ open: boolean; editing: OpcCompany | null }>({ open: false, editing: null });
  const [objDialog, setObjDialog] = useState<{ open: boolean; editing: OpcObjective | null }>({ open: false, editing: null });
  const [deleteTarget, setDeleteTarget] = useState<{ kind: 'company' | 'objective'; id: string; companyId?: string; name: string } | null>(null);
  const [launchingId, setLaunchingId] = useState<string | null>(null);

  useEffect(() => { loadGroups(); loadCompanies(); }, [loadGroups, loadCompanies]);
  useEffect(() => { if (selectedId) loadObjectives(selectedId); }, [selectedId, loadObjectives]);

  const selected = companies.find((c) => c.id === selectedId) ?? null;
  const objectives = selectedId ? (objectivesByCompany[selectedId] ?? []) : [];

  const stats = useMemo(() => {
    const byStatus: Record<OpcObjectiveStatus, number> = { draft: 0, active: 0, running: 0, completed: 0, failed: 0 };
    for (const o of objectives) byStatus[o.status]++;
    return { total: objectives.length, byStatus, running: byStatus.running };
  }, [objectives]);

  // --- launch：目标 → 团队，委托 team store ---
  const handleLaunch = async (obj: OpcObjective) => {
    if (!home) {
      toast.error('未找到主工作区，请先在「工作台」创建主工作区后再启动团队');
      return;
    }
    setLaunchingId(obj.id);
    try {
      const goalText = obj.acceptance_criteria
        ? `${obj.title} | 验收标准：${obj.acceptance_criteria}`
        : obj.title;
      const result = await buildTeam({
        goalText,
        groupFolder: home.folder,
        chatJid: home.jid,
        acceptanceCriteria: obj.acceptance_criteria ?? undefined,
        userLanguage: 'zh-CN',
      });
      if (result) {
        await updateObjective(obj.id, {
          status: 'running',
          run_id: result.runId,
          team_build_id: result.buildId,
        });
        toast.success('智能体网络已启动，正在 /team 执行');
      } else {
        await updateObjective(obj.id, { status: 'failed' });
        toast.error('团队组建失败，目标已标记为 failed');
      }
    } catch (err) {
      await updateObjective(obj.id, { status: 'failed' });
      toast.error('启动异常：' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLaunchingId(null);
    }
  };

  const handleViewRun = async (obj: OpcObjective) => {
    if (obj.team_build_id) {
      await openHistory(obj.team_build_id);
      navigate('/team');
      return;
    }
    if (obj.run_id) {
      navigate('/team');
      return;
    }
    toast.error('该目标尚未关联团队运行');
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    if (deleteTarget.kind === 'company') {
      await deleteCompany(deleteTarget.id);
      if (selectedId === deleteTarget.id) setSelectedId(null);
    } else {
      await deleteObjective(deleteTarget.id, deleteTarget.companyId!);
    }
    setDeleteTarget(null);
  };

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 pt-6 pb-4 border-b border-border">
        <PageHeader
          title="OPC 一人公司"
          subtitle="设定商业目标，驱动智能体网络协同，以一人之力运营企业级业务"
          actions={
            <Button onClick={() => setCompanyDialog({ open: true, editing: null })}>
              <Plus className="w-4 h-4 mr-1" /> 新建公司
            </Button>
          }
        />
      </div>

      {error && <div className="px-6 pt-2 text-sm text-destructive">{error}</div>}

      <div className="flex-1 flex min-h-0">
        {/* 公司列表 */}
        <div className="w-64 flex-shrink-0 border-r border-border overflow-y-auto p-3 space-y-1">
          {companiesLoading && companies.length === 0 ? (
            <div className="text-sm text-muted-foreground p-4 text-center">加载中…</div>
          ) : companies.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={Building2}
                title="还没有公司"
                description="创建你的第一家人公司，开始 AI 驱动的运营"
              />
            </div>
          ) : (
            companies.map((c) => (
              <button
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                className={cn(
                  'w-full text-left px-3 py-2.5 rounded-lg transition-colors cursor-pointer',
                  selectedId === c.id ? 'bg-brand-50 dark:bg-brand-950/30' : 'hover:bg-accent',
                )}
              >
                <div className="flex items-center gap-2">
                  <Building2 className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  <span className="text-sm font-medium truncate">{c.name}</span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span>{SCALE_TIERS.find((t) => t.value === c.scale_tier)?.label ?? c.scale_tier}</span>
                  {c.status === 'archived' && <Badge variant="secondary" className="text-[9px]">已归档</Badge>}
                </div>
              </button>
            ))
          )}
        </div>

        {/* 公司详情 */}
        <div className="flex-1 overflow-y-auto p-6">
          {!selected ? (
            <EmptyState
              icon={Building2}
              title="选择一家公司"
              description="从左侧选择公司查看运营总览，或新建公司"
            />
          ) : (
            <div className="space-y-6 max-w-5xl">
              {/* 头部 */}
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-xl font-semibold">{selected.name}</h2>
                  {selected.vision && <p className="mt-1 text-sm text-muted-foreground">{selected.vision}</p>}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setCompanyDialog({ open: true, editing: selected })}>
                    <Pencil className="w-3.5 h-3.5 mr-1" /> 编辑
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setDeleteTarget({ kind: 'company', id: selected.id, name: selected.name })}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>

              {/* 统计卡 */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard label="目标总数" value={stats.total} />
                <StatCard label="运行中" value={stats.running} highlight />
                <StatCard label="已完成" value={stats.byStatus.completed} />
                <StatCard label="失败" value={stats.byStatus.failed} danger={stats.byStatus.failed > 0} />
              </div>

              {/* 成果分成 */}
              {selected.revenue_share.length > 0 && (
                <Card>
                  <CardContent className="pt-4">
                    <div className="text-xs font-medium text-muted-foreground mb-2">成果分成</div>
                    <div className="flex flex-wrap gap-2">
                      {selected.revenue_share.map((p, i) => (
                        <Badge key={i} variant="secondary">{p.name} {p.ratio}%</Badge>
                      ))}
                      <span className="text-xs text-muted-foreground self-center">
                        合计 {selected.revenue_share.reduce((s, p) => s + p.ratio, 0)}%
                      </span>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* 目标看板 */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold flex items-center gap-2"><Target className="w-4 h-4" /> 商业目标</h3>
                  <Button size="sm" onClick={() => setObjDialog({ open: true, editing: null })}>
                    <Plus className="w-3.5 h-3.5 mr-1" /> 新目标
                  </Button>
                </div>

                {objectivesLoading && objectives.length === 0 ? (
                  <div className="text-sm text-muted-foreground">加载中…</div>
                ) : objectives.length === 0 ? (
                  <EmptyState
                    icon={Target}
                    title="还没有商业目标"
                    description="创建目标，驱动智能体网络协同执行"
                  />
                ) : (
                  <div className="space-y-4">
                    {STATUS_GROUPS.map((status) => {
                      const items = objectives.filter((o) => o.status === status);
                      if (items.length === 0) return null;
                      return (
                        <div key={status}>
                          <div className="flex items-center gap-2 mb-2">
                            <span className={cn('text-[10px] px-2 py-0.5 rounded-full', OBJ_STATUS_STYLE[status])}>
                              {OBJ_STATUS_LABEL[status]}
                            </span>
                            <span className="text-[10px] text-muted-foreground">{items.length}</span>
                          </div>
                          <div className="grid md:grid-cols-2 gap-2">
                            {items.map((o) => (
                              <ObjectiveCard
                                key={o.id} obj={o}
                                launching={launchingId === o.id}
                                onLaunch={() => handleLaunch(o)}
                                onViewRun={() => handleViewRun(o)}
                                onEdit={() => setObjDialog({ open: true, editing: o })}
                                onDelete={() => setDeleteTarget({ kind: 'objective', id: o.id, companyId: o.company_id, name: o.title })}
                              />
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <CompanyDialog
        open={companyDialog.open}
        editing={companyDialog.editing}
        onClose={() => setCompanyDialog({ open: false, editing: null })}
        onSave={async (input) => {
          if (companyDialog.editing) {
            await updateCompany(companyDialog.editing.id, input);
          } else {
            const c = await createCompany(input);
            if (c) setSelectedId(c.id);
          }
          setCompanyDialog({ open: false, editing: null });
        }}
      />

      <ObjectiveDialog
        open={objDialog.open}
        editing={objDialog.editing}
        onClose={() => setObjDialog({ open: false, editing: null })}
        onSave={async (input) => {
          if (objDialog.editing) {
            await updateObjective(objDialog.editing.id, input);
          } else if (selected) {
            await createObjective(selected.id, input);
          }
          setObjDialog({ open: false, editing: null });
        }}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title={deleteTarget?.kind === 'company' ? '删除公司' : '删除目标'}
        message={deleteTarget ? `确认删除「${deleteTarget.name}」？${deleteTarget.kind === 'company' ? '其下所有目标将一并删除。' : ''}不可撤销。` : ''}
        confirmText="删除"
        confirmVariant="danger"
      />
    </div>
  );
}

function StatCard({ label, value, highlight, danger }: { label: string; value: number; highlight?: boolean; danger?: boolean }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={cn('text-2xl font-semibold mt-1', highlight && 'text-amber-600 dark:text-amber-400', danger && 'text-destructive')}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

function ObjectiveCard({
  obj, launching, onLaunch, onViewRun, onEdit, onDelete,
}: {
  obj: OpcObjective;
  launching: boolean;
  onLaunch: () => void;
  onViewRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const canLaunch = obj.status !== 'running' && obj.status !== 'completed';
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-medium text-sm truncate">{obj.title}</div>
            {obj.domain && <div className="text-[11px] text-muted-foreground mt-0.5">{obj.domain}</div>}
          </div>
          <span className={cn('text-[10px] px-2 py-0.5 rounded-full flex-shrink-0', OBJ_STATUS_STYLE[obj.status])}>
            {OBJ_STATUS_LABEL[obj.status]}
          </span>
        </div>
        {obj.acceptance_criteria && (
          <p className="mt-2 text-xs text-muted-foreground line-clamp-2">{obj.acceptance_criteria}</p>
        )}
        <div className="mt-3 flex items-center gap-1.5">
          {canLaunch ? (
            <Button size="sm" variant="default" onClick={onLaunch} disabled={launching} className="h-7">
              <Rocket className="w-3 h-3 mr-1" /> {launching ? '组建中…' : '启动团队'}
            </Button>
          ) : null}
          {(obj.run_id || obj.team_build_id) && (
            <Button size="sm" variant="outline" onClick={onViewRun} className="h-7">
              <ExternalLink className="w-3 h-3 mr-1" /> 查看运行
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onEdit} className="h-7 w-7 p-0">
            <Pencil className="w-3 h-3" />
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete} className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive">
            <Trash2 className="w-3 h-3" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// --- 公司编辑 Dialog ---
function CompanyDialog({
  open, editing, onClose, onSave,
}: {
  open: boolean;
  editing: OpcCompany | null;
  onClose: () => void;
  onSave: (input: {
    name: string;
    vision?: string;
    commercial_goals?: string;
    operating_strategy?: string;
    scale_tier?: OpcScaleTier;
    domains?: string[];
    revenue_share?: RevenueSharePartner[];
  }) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [vision, setVision] = useState('');
  const [commercialGoals, setCommercialGoals] = useState('');
  const [strategy, setStrategy] = useState('');
  const [scaleTier, setScaleTier] = useState<OpcScaleTier>('solo');
  const [domains, setDomains] = useState('');
  const [partners, setPartners] = useState<RevenueSharePartner[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setVision(editing?.vision ?? '');
    setCommercialGoals(editing?.commercial_goals ?? '');
    setStrategy(editing?.operating_strategy ?? '');
    setScaleTier(editing?.scale_tier ?? 'solo');
    setDomains(editing?.domains?.join('、') ?? '');
    setPartners(editing?.revenue_share ?? []);
  }, [open, editing]);

  const addPartner = () => setPartners([...partners, { name: '', ratio: 0 }]);
  const updatePartner = (i: number, patch: Partial<RevenueSharePartner>) =>
    setPartners(partners.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  const removePartner = (i: number) => setPartners(partners.filter((_, idx) => idx !== i));
  const ratioSum = partners.reduce((s, p) => s + (Number(p.ratio) || 0), 0);

  const submit = async () => {
    if (!name.trim()) { toast.error('公司名称必填'); return; }
    if (ratioSum > 100) { toast.error(`成果分成合计 ${ratioSum}% 超过 100%`); return; }
    setSaving(true);
    const domainList = domains.split(/[、,，\s]+/).map((d) => d.trim()).filter(Boolean);
    await onSave({
      name: name.trim(),
      vision: vision.trim() || undefined,
      commercial_goals: commercialGoals.trim() || undefined,
      operating_strategy: strategy.trim() || undefined,
      scale_tier: scaleTier,
      domains: domainList,
      revenue_share: partners.filter((p) => p.name.trim()),
    });
    setSaving(false);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑公司' : '新建一人公司'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>公司名称 *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：Acme OPC" />
          </div>
          <div>
            <Label>愿景</Label>
            <Input value={vision} onChange={(e) => setVision(e.target.value)} placeholder="一句话愿景" />
          </div>
          <div>
            <Label>商业目标</Label>
            <Textarea value={commercialGoals} onChange={(e) => setCommercialGoals(e.target.value)} rows={2} placeholder="总体商业目标概述" />
          </div>
          <div>
            <Label>运营策略</Label>
            <Textarea value={strategy} onChange={(e) => setStrategy(e.target.value)} rows={2} placeholder="运营策略与方向" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>规模层级</Label>
              <Select value={scaleTier} onValueChange={(v) => setScaleTier(v as OpcScaleTier)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SCALE_TIERS.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>覆盖领域（顿号分隔）</Label>
              <Input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="技术、法务、财务" />
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label>成果分成</Label>
              <Button size="sm" variant="outline" onClick={addPartner} className="h-7"><Plus className="w-3 h-3 mr-1" />合作方</Button>
            </div>
            <div className="space-y-2">
              {partners.map((p, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input value={p.name} onChange={(e) => updatePartner(i, { name: e.target.value })} placeholder="合作方名称" className="flex-1" />
                  <Input type="number" min={0} max={100} value={p.ratio} onChange={(e) => updatePartner(i, { ratio: Number(e.target.value) })} className="w-20" />
                  <span className="text-xs text-muted-foreground">%</span>
                  <Button size="sm" variant="ghost" onClick={() => removePartner(i)} className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive">
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
              {partners.length > 0 && (
                <div className={cn('text-xs', ratioSum > 100 ? 'text-destructive' : 'text-muted-foreground')}>
                  合计 {ratioSum}% {ratioSum > 100 ? '（超过 100%）' : ''}
                </div>
              )}
            </div>
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">取消</Button></DialogClose>
          <Button onClick={submit} disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- 目标编辑 Dialog ---
function ObjectiveDialog({
  open, editing, onClose, onSave,
}: {
  open: boolean;
  editing: OpcObjective | null;
  onClose: () => void;
  onSave: (input: { title: string; description?: string; domain?: string; acceptance_criteria?: string; metrics?: string[] }) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [domain, setDomain] = useState('');
  const [description, setDescription] = useState('');
  const [criteria, setCriteria] = useState('');
  const [metrics, setMetrics] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(editing?.title ?? '');
    setDomain(editing?.domain ?? '');
    setDescription(editing?.description ?? '');
    setCriteria(editing?.acceptance_criteria ?? '');
    setMetrics(editing?.metrics?.join('、') ?? '');
  }, [open, editing]);

  const submit = async () => {
    if (!title.trim()) { toast.error('目标标题必填'); return; }
    setSaving(true);
    const metricList = metrics.split(/[、,，\n]+/).map((m) => m.trim()).filter(Boolean);
    await onSave({
      title: title.trim(),
      domain: domain.trim() || undefined,
      description: description.trim() || undefined,
      acceptance_criteria: criteria.trim() || undefined,
      metrics: metricList,
    });
    setSaving(false);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑目标' : '新建商业目标'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>目标标题 *</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：Q3 营收 10w" />
          </div>
          <div>
            <Label>领域</Label>
            <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="技术 / 法务 / 财务" />
          </div>
          <div>
            <Label>描述</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>
          <div>
            <Label>验收标准</Label>
            <Textarea value={criteria} onChange={(e) => setCriteria(e.target.value)} rows={3} placeholder="目标达成的可验证标准" />
          </div>
          <div>
            <Label>度量指标（顿号分隔）</Label>
            <Input value={metrics} onChange={(e) => setMetrics(e.target.value)} placeholder="DAU、留存率、营收" />
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">取消</Button></DialogClose>
          <Button onClick={submit} disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
