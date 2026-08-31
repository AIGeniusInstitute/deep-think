/**
 * WorkflowNodeInspector — right-side property panel for the selected node.
 *
 * Renders type-specific fields (title / prompt / successCriteria / branchKey /
 * approvalPrompt …) bound to the store's node data. For 'agent' nodes it embeds
 * AgentEditorPanel so the user can bind an existing Agent, create a new one, or
 * edit the bound one inline — reusing the Agent Studio capability (PRD FP3).
 */
import { useState } from 'react';
import Editor from '@monaco-editor/react';
import { useWorkflowEditorStore } from '../../stores/workflow-editor';
import { useAgentsPaasStore } from '../../stores/agents-paas';
import { AgentEditorPanel } from '../agents/AgentEditorPanel';
import { NODE_TYPE_LABEL_ZH } from './workflow-constants';

export function WorkflowNodeInspector() {
  const nodes = useWorkflowEditorStore((s) => s.nodes);
  const selectedId = useWorkflowEditorStore((s) => s.selectedNodeId);
  const updateNodeData = useWorkflowEditorStore((s) => s.updateNodeData);
  const removeNode = useWorkflowEditorStore((s) => s.removeNode);
  const agents = useAgentsPaasStore((s) => s.list);
  const loadAgents = useAgentsPaasStore((s) => s.load);

  const [agentPanelOpen, setAgentPanelOpen] = useState(false);

  const node = nodes.find((n) => n.id === selectedId) ?? null;

  if (!node) {
    return (
      <div className="w-[320px] flex-shrink-0 border-l border-border p-4 text-xs text-muted-foreground">
        选中一个节点以编辑其属性。
      </div>
    );
  }

  const d = node.data;
  const set = (patch: Record<string, unknown>) => updateNodeData(node.id, patch);
  const inputCls = 'w-full text-sm rounded border border-border bg-background px-2 py-1';

  return (
    <div className="w-[320px] flex-shrink-0 border-l border-border overflow-y-auto">
      <div className="px-3 py-2 border-b border-border flex items-center justify-between">
        <span className="text-xs font-semibold">{NODE_TYPE_LABEL_ZH[d.type] ?? d.type} 节点</span>
        <button
          onClick={() => removeNode(node.id)}
          className="text-[10px] text-red-500 hover:underline"
        >
          删除节点
        </button>
      </div>

      <div className="p-3 space-y-2.5">
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">ID</label>
          <input className={`${inputCls} text-[11px] text-slate-500`} value={d.id} readOnly />
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">标题</label>
          <input className={inputCls} value={d.title ?? ''} onChange={(e) => set({ title: e.target.value })} />
        </div>

        {d.type === 'agent' && (
          <AgentSection
            agentDefId={(d.agentDefId as string | undefined) ?? null}
            agents={agents}
            onLoadAgents={loadAgents}
            onBound={(id, name) => set({ agentDefId: id, title: name })}
            onUnbind={() => set({ agentDefId: '' })}
            panelOpen={agentPanelOpen}
            setPanelOpen={setAgentPanelOpen}
          />
        )}

        {d.type === 'agent' && (
          <div>
            <label className="text-[10px] text-muted-foreground block mb-0.5">目标锚点（goalAnchor，每轮重申）</label>
            <textarea
              className={`${inputCls} resize-y`}
              rows={3}
              value={(d.goalAnchor as string) ?? ''}
              onChange={(e) => set({ goalAnchor: e.target.value })}
              placeholder="原始目标 + 验收标准 + 角色交付物"
            />
          </div>
        )}

        {(d.type === 'agent' || d.type === 'llm') && (
          <div>
            <label className="text-[10px] text-muted-foreground block mb-0.5">{d.type === 'llm' ? 'Prompt' : '执行 Prompt（可空，默认用标题）'}</label>
            <textarea
              className={`${inputCls} resize-y`}
              rows={3}
              value={(d.prompt as string) ?? ''}
              onChange={(e) => set({ prompt: e.target.value })}
            />
          </div>
        )}

        {d.type === 'gate' && (
          <GateSection d={d} set={set} nodes={nodes} inputCls={inputCls} />
        )}

        {d.type === 'branch' && (
          <div>
            <label className="text-[10px] text-muted-foreground block mb-0.5">分支 Key（branchKey）</label>
            <input className={inputCls} value={(d.branchKey as string) ?? ''} onChange={(e) => set({ branchKey: e.target.value })} />
          </div>
        )}

        {d.type === 'human' && (
          <HumanSection d={d} set={set} inputCls={inputCls} />
        )}

        {d.type === 'validate' && (
          <ValidateSection d={d} set={set} nodes={nodes} inputCls={inputCls} />
        )}

        {d.type === 'end' && (
          <div>
            <label className="text-[10px] text-muted-foreground block mb-0.5">输出模板（${'{var}'} 引用）</label>
            <textarea className={`${inputCls} resize-y`} rows={2} value={(d.outputTemplate as string) ?? ''} onChange={(e) => set({ outputTemplate: e.target.value })} />
          </div>
        )}

        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">失败最大重试</label>
          <input
            type="number"
            className={inputCls}
            value={(d.maxAttempts as number) ?? 3}
            onChange={(e) => set({ maxAttempts: Number(e.target.value) || 3 })}
          />
        </div>
      </div>
    </div>
  );
}

function AgentSection({
  agentDefId,
  agents,
  onLoadAgents,
  onBound,
  onUnbind,
  panelOpen,
  setPanelOpen,
}: {
  agentDefId: string | null;
  agents: { id: string; name: string }[];
  onLoadAgents: () => void;
  onBound: (id: string, name: string) => void;
  onUnbind: () => void;
  panelOpen: boolean;
  setPanelOpen: (v: boolean) => void;
}) {
  return (
    <div className="space-y-1.5 border border-border rounded p-2 bg-muted/10">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase text-muted-foreground">Agent 绑定</span>
        <button onClick={() => setPanelOpen(!panelOpen)} className="text-[10px] text-blue-600 hover:underline">
          {agentDefId ? '编辑 Agent' : '新建 / 编辑 Agent'}
        </button>
      </div>
      <select
        className="w-full text-xs rounded border border-border bg-background px-2 py-1"
        value={agentDefId ?? ''}
        onFocus={() => void onLoadAgents()}
        onChange={(e) => {
          const id = e.target.value;
          const a = agents.find((x) => x.id === id);
          if (a) onBound(id, a.name);
          else onUnbind();
        }}
      >
        <option value="">— 未绑定 —</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      {!agentDefId && (
        <div className="text-[10px] text-amber-600">未绑定 Agent：运行时退化为默认 Agent</div>
      )}
      {panelOpen && (
        <div className="pt-1 border-t border-border">
          <AgentEditorPanel agentDefId={agentDefId} onBound={onBound} compact />
        </div>
      )}
    </div>
  );
}

function GateSection({
  d,
  set,
  nodes,
  inputCls,
}: {
  d: Record<string, unknown>;
  set: (patch: Record<string, unknown>) => void;
  nodes: { id: string; data: { type: string; title: string } }[];
  inputCls: string;
}) {
  const assertions = (d.assertions as Array<{ kind: string; value: string }>) ?? [];
  const upstreamNodes = nodes.filter((n) => n.data.type === 'agent');
  return (
    <>
      <div>
        <label className="text-[10px] text-muted-foreground block mb-0.5">验收标准（successCriteria）</label>
        <textarea className={`${inputCls} resize-y`} rows={2} value={(d.successCriteria as string) ?? ''} onChange={(e) => set({ successCriteria: e.target.value })} />
      </div>
      <div>
        <label className="text-[10px] text-muted-foreground block mb-0.5">上游 Agent 节点（断言对象）</label>
        <select className={inputCls} value={(d.upstreamNodeId as string) ?? ''} onChange={(e) => set({ upstreamNodeId: e.target.value })}>
          <option value="">自动（最近前驱）</option>
          {upstreamNodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.data.title || n.id}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="text-[10px] text-muted-foreground block mb-0.5">Shell 检查命令（可空，非 0 即失败）</label>
        <input className={`${inputCls} font-mono text-[11px]`} value={(d.shellCheck as string) ?? ''} onChange={(e) => set({ shellCheck: e.target.value })} placeholder="make test" />
      </div>
      <div>
        <label className="text-[10px] text-muted-foreground block mb-0.5">断言（行为证据）</label>
        <div className="space-y-1">
          {assertions.map((a, i) => (
            <div key={i} className="flex gap-1">
              <select
                className="text-[11px] rounded border border-border bg-background px-1"
                value={a.kind}
                onChange={(e) => {
                  const next = [...assertions];
                  next[i] = { ...a, kind: e.target.value };
                  set({ assertions: next });
                }}
              >
                <option value="contains">contains</option>
                <option value="not_contains">not_contains</option>
                <option value="regex">regex</option>
                <option value="no_error">no_error</option>
              </select>
              <input
                className={`${inputCls} text-[11px]`}
                value={a.value}
                onChange={(e) => {
                  const next = [...assertions];
                  next[i] = { ...a, value: e.target.value };
                  set({ assertions: next });
                }}
              />
              <button onClick={() => set({ assertions: assertions.filter((_, j) => j !== i) })} className="text-red-500 text-[11px]">✕</button>
            </div>
          ))}
          <button
            onClick={() => set({ assertions: [...assertions, { kind: 'contains', value: '' }] })}
            className="text-[11px] text-blue-600 hover:underline"
          >
            + 添加断言
          </button>
        </div>
      </div>
    </>
  );
}

function ValidateSection({
  d,
  set,
  nodes,
  inputCls,
}: {
  d: Record<string, unknown>;
  set: (patch: Record<string, unknown>) => void;
  nodes: { id: string; data: { type: string; title: string } }[];
  inputCls: string;
}) {
  const schema = (d.outputSchema as string) ?? '';
  const onFail = (d.onFail as string) ?? 'fail';
  // Live schema-validity indicator (mirrors isSchemaValid on the backend).
  let schemaOk: null | boolean = null;
  let schemaErr = '';
  if (schema.trim()) {
    try {
      const parsed = JSON.parse(schema);
      schemaOk = typeof parsed === 'object' && parsed !== null;
    } catch (err) {
      schemaOk = false;
      schemaErr = (err as Error).message;
    }
  }
  return (
    <>
      <div>
        <label className="text-[10px] text-muted-foreground block mb-0.5">
          JSON Schema（校验上游输出）
          {schemaOk === true && <span className="text-green-600 ml-2">✓ 合法</span>}
          {schemaOk === false && <span className="text-red-500 ml-2" title={schemaErr}>✗ 非法 JSON</span>}
        </label>
        <div className="border border-border rounded overflow-hidden">
          <Editor
            height="180px"
            language="json"
            theme="vs-dark"
            value={schema}
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              lineNumbers: 'off',
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              tabSize: 2,
            }}
            onChange={(val) => set({ outputSchema: val ?? '' })}
          />
        </div>
      </div>
      <div>
        <label className="text-[10px] text-muted-foreground block mb-0.5">上游节点（校验对象，默认最近前驱）</label>
        <select className={inputCls} value={(d.upstreamNodeId as string) ?? ''} onChange={(e) => set({ upstreamNodeId: e.target.value })}>
          <option value="">自动（最近前驱）</option>
          {nodes.filter((n) => n.id !== d.id).map((n) => (
            <option key={n.id} value={n.id}>{n.data.title || n.id}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="text-[10px] text-muted-foreground block mb-0.5">失败策略（onFail）</label>
        <select className={inputCls} value={onFail} onChange={(e) => set({ onFail: e.target.value })}>
          <option value="fail">fail — 标记节点失败，流程进入错误处理</option>
          <option value="retry">retry — 重试上游节点（复用 GATE_RETRY_MAX）</option>
          <option value="fallback">fallback — 写入兜底值，节点标记完成</option>
        </select>
      </div>
      {onFail === 'fallback' && (
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">兜底值（fallbackValue，写入 state[node_&lt;id&gt;_output]）</label>
          <textarea
            className={`${inputCls} resize-y font-mono text-[11px]`}
            rows={2}
            value={(d.fallbackValue as string) ?? ''}
            onChange={(e) => set({ fallbackValue: e.target.value })}
            placeholder='{"ok": true}'
          />
        </div>
      )}
    </>
  );
}

function HumanSection({
  d,
  set,
  inputCls,
}: {
  d: Record<string, unknown>;
  set: (patch: Record<string, unknown>) => void;
  inputCls: string;
}) {
  const options = (d.approvalOptions as Array<{ label: string; value: string }>) ?? [];
  return (
    <>
      <div>
        <label className="text-[10px] text-muted-foreground block mb-0.5">审批问题</label>
        <textarea className={`${inputCls} resize-y`} rows={2} value={(d.approvalPrompt as string) ?? ''} onChange={(e) => set({ approvalPrompt: e.target.value })} />
      </div>
      <div>
        <label className="text-[10px] text-muted-foreground block mb-0.5">State Key（审批结果写入）</label>
        <input className={`${inputCls} text-[11px]`} value={(d.approvalStateKey as string) ?? ''} onChange={(e) => set({ approvalStateKey: e.target.value })} placeholder={`node_<id>_approval`} />
      </div>
      <div>
        <label className="text-[10px] text-muted-foreground block mb-0.5">选项按钮</label>
        <div className="space-y-1">
          {options.map((o, i) => (
            <div key={i} className="flex gap-1">
              <input className={`${inputCls} text-[11px]`} value={o.label} onChange={(e) => { const n = [...options]; n[i] = { ...o, label: e.target.value }; set({ approvalOptions: n }); }} placeholder="标签" />
              <input className={`${inputCls} text-[11px]`} value={o.value} onChange={(e) => { const n = [...options]; n[i] = { ...o, value: e.target.value }; set({ approvalOptions: n }); }} placeholder="value" />
              <button onClick={() => set({ approvalOptions: options.filter((_, j) => j !== i) })} className="text-red-500 text-[11px]">✕</button>
            </div>
          ))}
          <button onClick={() => set({ approvalOptions: [...options, { label: '', value: '' }] })} className="text-[11px] text-blue-600 hover:underline">+ 选项</button>
        </div>
      </div>
    </>
  );
}
