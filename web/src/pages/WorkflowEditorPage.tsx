/**
 * WorkflowEditorPage — three-column visual orchestration page.
 *
 * Layout: [NodePalette] [Canvas: edit=WorkflowEditorCanvas / run=GraphDagView]
 * [WorkflowNodeInspector]. Top toolbar: name, save, run, auto-layout, AI 编排,
 * edit↔run toggle, workflow list drawer.
 *
 * Two orchestration modes per PRD:
 *  - FP1 手工可视化编排: drag nodes from palette, connect, edit per-node in the
 *    inspector (agent nodes embed AgentEditorPanel — reuses Agent Studio).
 *  - FP2 AI 编排 (编排 Agent): "AI 编排" opens a goal input; the backend
 *    编排 Agent (team-builder draft mode) decomposes the goal, creates an Agent
 *    cluster, and assembles a Workflow draft, which is loaded back into the
 *    canvas for per-node editing.
 *
 * Routes: /workflows (list+editor), /workflows/:id (open existing).
 */
import { useEffect, useState, lazy, Suspense } from 'react';
import { useParams } from 'react-router-dom';
import { useWorkflowEditorStore } from '../stores/workflow-editor';
import { useGroupsStore } from '../stores/groups';
import { NodePalette } from '../components/workflow/NodePalette';
import { WorkflowNodeInspector } from '../components/workflow/WorkflowNodeInspector';
import { GraphDagView } from '../components/graph/GraphDagView';
import { workflowsApi } from '../api/workflows';
import { toast } from 'sonner';
import { Workflow, Save, Play, Sparkles, LayoutGrid, List, Plus, Loader2 } from 'lucide-react';

const WorkflowEditorCanvas = lazy(() =>
  import('../components/workflow/WorkflowEditorCanvas').then((m) => ({
    default: m.WorkflowEditorCanvas,
  })),
);
const WorkflowEditorCanvasLoader = lazy(() =>
  import('../components/workflow/WorkflowEditorCanvas').then((m) => ({
    default: m.WorkflowEditorCanvasLoader,
  })),
);

export function WorkflowEditorPage() {
  const store = useWorkflowEditorStore();
  const { id } = useParams<{ id?: string }>();
  const loadGroups = useGroupsStore((s) => s.loadGroups);
  const groupsLoaded = useGroupsStore((s) => !!s.groups && Object.keys(s.groups).length > 0);

  const [showList, setShowList] = useState(false);
  const [showAutobuild, setShowAutobuild] = useState(false);

  useEffect(() => {
    if (!groupsLoaded) void loadGroups();
    void store.loadList();
    if (id) void store.openWorkflow(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const onRun = async () => {
    toast.loading('保存并启动运行…', { id: 'wf-run' });
    const runId = await store.run();
    if (runId) toast.success(`运行已启动：${runId}`, { id: 'wf-run' });
    else toast.error(store.saveError ?? '启动失败', { id: 'wf-run' });
  };

  const onSave = async () => {
    const res = await store.save();
    if (res) toast.success(`已保存（v${res.version}）`);
    else toast.error(store.saveError ?? '保存失败');
  };

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-background flex-shrink-0">
        <Workflow size={16} className="text-muted-foreground" />
        <label>
          <span className="sr-only">工作流名称</span>
          <input
            aria-label="工作流名称"
            title="编辑工作流名称"
            className="w-[190px] rounded border border-border bg-background px-2 py-1 text-sm font-medium outline-none transition-colors hover:border-muted-foreground focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30"
            value={store.name}
            onChange={(e) => store.setName(e.target.value)}
            placeholder="工作流名称"
          />
        </label>
        <label>
          <span className="sr-only">工作流描述</span>
          <input
            aria-label="工作流描述"
            title="编辑工作流描述"
            className="w-[220px] rounded border border-border bg-background px-2 py-1 text-xs text-muted-foreground outline-none transition-colors hover:border-muted-foreground focus:border-blue-500 focus:text-foreground focus:ring-1 focus:ring-blue-500/30"
            value={store.description}
            onChange={(e) => store.setDescription(e.target.value)}
            placeholder="工作流描述（可选）"
          />
        </label>
        <button
          onClick={() => setShowList(true)}
          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 px-2 py-1 rounded hover:bg-muted"
          title="我的工作流"
        >
          <List size={13} /> 列表
        </button>
        <div className="flex-1" />
        <button
          onClick={() => void store.autoLayout()}
          className="text-xs flex items-center gap-1 px-2.5 py-1 rounded border border-border hover:bg-muted"
        >
          <LayoutGrid size={13} /> 自动布局
        </button>
        <button
          onClick={() => setShowAutobuild(true)}
          className="text-xs flex items-center gap-1 px-2.5 py-1 rounded bg-violet-600 text-white hover:opacity-90"
        >
          <Sparkles size={13} /> AI 编排
        </button>
        <button
          onClick={() => void onSave()}
          disabled={store.saving}
          className="text-xs flex items-center gap-1 px-2.5 py-1 rounded border border-border hover:bg-muted disabled:opacity-50"
        >
          {store.saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} 保存
        </button>
        <button
          onClick={() => void onRun()}
          className="text-xs flex items-center gap-1 px-2.5 py-1 rounded bg-foreground text-background hover:opacity-90"
        >
          <Play size={13} /> 运行
        </button>
        <div className="flex items-center rounded border border-border overflow-hidden">
          <button
            onClick={() => store.setMode('edit')}
            className={`text-xs px-2.5 py-1 ${store.mode === 'edit' ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted'}`}
          >
            编辑
          </button>
          <button
            onClick={() => store.runId && store.setMode('run')}
            disabled={!store.runId}
            className={`text-xs px-2.5 py-1 disabled:opacity-40 ${store.mode === 'run' ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted'}`}
          >
            运行
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        {store.mode === 'edit' && <NodePalette />}
        <div className="flex-1 min-h-0 relative">
          {store.mode === 'edit' ? (
            <Suspense fallback={<WorkflowEditorCanvasLoader />}>
              <WorkflowEditorCanvas />
            </Suspense>
          ) : store.runId ? (
            <GraphDagView runId={store.runId} />
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              尚无运行：点击「运行」启动一次工作流执行。
            </div>
          )}
        </div>
        {store.mode === 'edit' && <WorkflowNodeInspector />}
      </div>

      {showList && <WorkflowListDrawer onClose={() => setShowList(false)} />}
      {showAutobuild && <AutobuildDialog onClose={() => setShowAutobuild(false)} />}
    </div>
  );
}

function WorkflowListDrawer({ onClose }: { onClose: () => void }) {
  const list = useWorkflowEditorStore((s) => s.list);
  const openWorkflow = useWorkflowEditorStore((s) => s.openWorkflow);
  const newWorkflow = useWorkflowEditorStore((s) => s.newWorkflow);
  const loadList = useWorkflowEditorStore((s) => s.loadList);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <div
        className="relative ml-auto w-[360px] h-full bg-background border-l border-border shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <span className="text-sm font-semibold">我的工作流</span>
          <button
            onClick={() => {
              newWorkflow();
              onClose();
            }}
            className="text-xs text-blue-600 hover:underline flex items-center gap-1"
          >
            <Plus size={13} /> 新建
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {list.length === 0 && (
            <div className="text-xs text-muted-foreground p-4">暂无工作流</div>
          )}
          {list.map((w) => (
            <button
              key={w.id}
              onClick={() => {
                void openWorkflow(w.id).then(() => onClose());
              }}
              className="w-full text-left px-4 py-2.5 border-b border-border hover:bg-muted"
            >
              <div className="text-sm font-medium truncate">{w.name}</div>
              <div className="text-[10px] text-muted-foreground flex items-center gap-2 mt-0.5">
                <span>{w.nodeCount} 节点</span>
                <span>·</span>
                <span>v{w.version}</span>
                <span>·</span>
                <span>{new Date(w.createdAt).toLocaleDateString()}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function AutobuildDialog({ onClose }: { onClose: () => void }) {
  const autobuild = useWorkflowEditorStore((s) => s.autobuild);
  const autobuilding = useWorkflowEditorStore((s) => s.autobuilding);
  const autobuildId = useWorkflowEditorStore((s) => s.autobuildId);
  const autobuildError = useWorkflowEditorStore((s) => s.autobuildError);
  const loadDefinitionIntoEditor = useWorkflowEditorStore((s) => s.loadDefinitionIntoEditor);

  const [goal, setGoal] = useState('');
  const [background, setBackground] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  const start = async () => {
    if (!goal.trim()) {
      toast.error('请填写业务目标');
      return;
    }
    await autobuild({
      goalText: goal.trim(),
      background: background.trim() || undefined,
      acceptanceCriteria: acceptance.trim() || undefined,
      executionMode: 'auto',
    });
  };

  // Poll the build until done, then load the produced definition into the editor.
  useEffect(() => {
    if (!autobuildId || autobuilding) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = (await workflowsApi.pollAutobuild(autobuildId)) as {
          status: 'running' | 'completed' | 'failed';
          definitionId?: string;
          error?: string;
        };
        if (cancelled) return;
        if (res.status === 'completed' && res.definitionId) {
          const detail = await workflowsApi.get(res.definitionId);
          loadDefinitionIntoEditor(detail.definition);
          setStatus('编排完成，已载入画布');
          toast.success('AI 编排完成，已载入画布');
          setTimeout(onClose, 800);
        } else if (res.status === 'failed') {
          setStatus(`编排失败：${res.error ?? '未知错误'}`);
        } else {
          setStatus(res.status === 'running' ? '编排 Agent 正在规划…' : '等待中…');
          setTimeout(poll, 2000);
        }
      } catch {
        if (!cancelled) setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
    };
  }, [autobuildId, autobuilding, loadDefinitionIntoEditor, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative w-[480px] max-w-[92vw] bg-background rounded-lg border border-border shadow-xl p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-violet-600" />
          <span className="text-sm font-semibold">AI 编排（编排 Agent）</span>
        </div>
        <p className="text-xs text-muted-foreground">
          描述业务目标，编排 Agent 将自动分解任务、创建 Agent 集群并编排成工作流草稿，载入后可逐节点编辑。
        </p>
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">业务目标 *</label>
          <textarea
            className="w-full text-sm rounded border border-border bg-background px-2 py-1.5 resize-y"
            rows={3}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="例如：对一批临床三期试验文档抽取主要终点并生成结构化报告"
          />
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">背景（可空）</label>
          <input
            className="w-full text-sm rounded border border-border bg-background px-2 py-1.5"
            value={background}
            onChange={(e) => setBackground(e.target.value)}
          />
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">验收标准（可空）</label>
          <input
            className="w-full text-sm rounded border border-border bg-background px-2 py-1.5"
            value={acceptance}
            onChange={(e) => setAcceptance(e.target.value)}
          />
        </div>
        {autobuildError && <div className="text-xs text-red-500">{autobuildError}</div>}
        {status && <div className="text-xs text-muted-foreground">{status}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded border border-border hover:bg-muted">
            取消
          </button>
          <button
            onClick={() => void start()}
            disabled={autobuilding}
            className="text-xs px-3 py-1.5 rounded bg-violet-600 text-white hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
          >
            {autobuilding ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            开始编排
          </button>
        </div>
      </div>
    </div>
  );
}
