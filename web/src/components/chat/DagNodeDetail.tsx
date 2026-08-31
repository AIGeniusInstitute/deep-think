/**
 * Detail panel for a single DAG node. Shows full context state and supports:
 *   - Editing input_summary / output_summary (saved as annotations)
 *   - "Rerun this node" — sends node.input as a new user message
 *   - "Continue from here" — sends a context-augmented message that
 *     includes the node's input, output, and parent chain so the agent
 *     can actually resume execution from this point rather than re-running
 *     it blind. The context is injected as plain text in the message —
 *     the agent reads it like any other user instruction, no special
 *     agent-runner side handling required.
 *
 * Rerun is implemented client-side: the input text is sent through the
 * existing /api/messages pipeline via chat store's sendMessage action. No
 * dedicated server-side rerun endpoint — keeps the message pipeline single-path.
 */

import { useState, useEffect } from 'react';
import { X, Save, RotateCw, PlayCircle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useChatStore, type TraceNodeEntry } from '../../stores/chat';
import { Button } from '@/components/ui/button';

interface DagNodeDetailProps {
  chatJid: string;
  node: TraceNodeEntry;
}

const NODE_TYPE_LABELS: Record<TraceNodeEntry['node_type'], string> = {
  turn: 'Turn (回合)',
  tool: 'Tool (工具)',
  skill: 'Skill (技能)',
  subagent: 'Sub-Agent (子代理)',
  review: 'Review (审查)',
  goal_check: 'Goal Check (目标检查)',
  thinking: 'Thinking (推理)',
  compact: 'Compact (压缩)',
  memory_recall: 'Memory Recall (记忆召回)',
  memory_write: 'Memory Write (记忆写入)',
  tool_select: 'Tool Select (工具选择)',
  llm_call: 'LLM Call (模型调用)',
  permission_check: 'Permission Check (权限校验)',
  context_audit: 'Context Audit (上下文审计)',
  validation: 'Validation (结果校验)',
};

export function DagNodeDetail({ chatJid, node }: DagNodeDetailProps) {
  const setSelectedNodeId = useChatStore((s) => s.setSelectedTraceNodeId);
  const saveAnnotation = useChatStore((s) => s.saveTraceNodeAnnotation);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const traceNodesMap = useChatStore((s) => s.traceNodes);

  const [annotationInput, setAnnotationInput] = useState('');
  const [annotationOutput, setAnnotationOutput] = useState('');
  const [saving, setSaving] = useState(false);
  const [rerunning, setRerunning] = useState(false);

  useEffect(() => {
    setAnnotationInput(node.annotation_input ?? node.input_summary ?? '');
    setAnnotationOutput(node.annotation_output ?? node.output_summary ?? '');
  }, [node.id, node.annotation_input, node.annotation_output, node.input_summary, node.output_summary]);

  const handleSave = async () => {
    setSaving(true);
    const ok = await saveAnnotation(chatJid, node.id, annotationInput, annotationOutput);
    setSaving(false);
    if (ok) {
      toast.success('已保存节点注解');
    } else {
      toast.error('保存失败');
    }
  };

  /**
   * Build a context-augmented message for "continue from here". Includes:
   *   - The node's own input/output (so the agent knows what was done)
   *   - Parent chain up to the root turn (so the agent knows where it sits)
   *   - Sibling nodes that ran before this one (skipped — too noisy for now)
   *
   * The agent reads this like a normal user message — no agent-runner side
   * branching logic required.
   */
  const buildContinueMessage = (): string => {
    const allNodes = traceNodesMap[chatJid] ?? [];
    const lines: string[] = [];
    lines.push(`[从节点 #${node.id} 续跑]`);
    lines.push('');
    lines.push('## 当前节点');
    lines.push(`- 节点 ID: #${node.id}`);
    lines.push(`- 类型: ${NODE_TYPE_LABELS[node.node_type]}`);
    if (node.title) lines.push(`- 标题: ${node.title}`);
    lines.push(`- 状态: ${node.status ?? '未知'}`);
    if (node.tokens && node.tokens > 0) lines.push(`- Tokens: ${node.tokens}`);

    // Walk up the parent chain
    const chain: TraceNodeEntry[] = [];
    let cur: TraceNodeEntry | undefined = node;
    const seen = new Set<number>([node.id]);
    while (cur?.parent_node_id != null) {
      const parent = allNodes.find((n) => n.id === cur!.parent_node_id);
      if (!parent || seen.has(parent.id)) break;
      seen.add(parent.id);
      chain.unshift(parent);
      cur = parent;
    }
    if (chain.length > 0) {
      lines.push('');
      lines.push('## 父节点链路（从根到当前）');
      chain.forEach((n, i) => {
        lines.push(`${i + 1}. #${n.id} [${NODE_TYPE_LABELS[n.node_type]}] ${n.title ?? ''}`.trim());
        if (n.input_summary) {
          lines.push(`   输入: ${n.input_summary.slice(0, 200)}`);
        }
        if (n.output_summary) {
          lines.push(`   输出: ${n.output_summary.slice(0, 200)}`);
        }
      });
    }

    lines.push('');
    lines.push('## 当前节点的输入与输出');
    const inputForResume = (node.annotation_input ?? node.input_summary ?? '').trim();
    const outputForResume = (node.annotation_output ?? node.output_summary ?? '').trim();
    if (inputForResume) {
      lines.push('### 输入');
      lines.push('```');
      lines.push(inputForResume);
      lines.push('```');
    }
    if (outputForResume) {
      lines.push('### 已完成的输出');
      lines.push('```');
      lines.push(outputForResume);
      lines.push('```');
    }

    lines.push('');
    lines.push('## 续跑指令');
    lines.push('请基于上述节点上下文，从此节点继续执行后续任务。若该节点是工具调用，请检查其输出并决定下一步；若该节点是子 Agent，请继续其未完成的工作。');
    return lines.join('\n');
  };

  const handleRerun = async (mode: 'rerun' | 'continue') => {
    const inputText = (node.annotation_input ?? node.input_summary ?? '').trim();
    if (!inputText) {
      toast.error('该节点没有可重跑的输入');
      return;
    }
    const message =
      mode === 'continue'
        ? buildContinueMessage()
        : `[重跑节点 #${node.id}]\n\n${inputText}`;
    if (!window.confirm(`确定${mode === 'continue' ? '从该节点续跑' : '重跑该节点'}？将作为新消息发送到当前会话。`)) {
      return;
    }
    setRerunning(true);
    const ok = await sendMessage(chatJid, message);
    setRerunning(false);
    if (ok) {
      toast.success(`已${mode === 'continue' ? '从节点续跑' : '重跑节点'}`);
      setSelectedNodeId(null);
    } else {
      toast.error('发送失败');
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-semibold">#{node.id}</span>
          <span className="text-xs text-muted-foreground truncate">
            {NODE_TYPE_LABELS[node.node_type]}
          </span>
        </div>
        <button
          onClick={() => setSelectedNodeId(null)}
          className="text-muted-foreground hover:text-foreground p-1 cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        {/* Metadata */}
        <div className="space-y-1 text-xs">
          {node.parent_node_id != null && (
            <div className="flex gap-2">
              <span className="text-muted-foreground flex-shrink-0">父节点:</span>
              <button
                onClick={() => setSelectedNodeId(node.parent_node_id!)}
                className="text-primary hover:underline cursor-pointer"
              >
                #{node.parent_node_id}
              </button>
            </div>
          )}
          {node.title && (
            <div className="flex gap-2">
              <span className="text-muted-foreground flex-shrink-0">标题:</span>
              <span className="text-foreground break-all">{node.title}</span>
            </div>
          )}
          <div className="flex gap-2">
            <span className="text-muted-foreground flex-shrink-0">状态:</span>
            <span className="text-foreground">{node.status ?? '未知'}</span>
          </div>
          {node.tokens != null && node.tokens > 0 && (
            <div className="flex gap-2">
              <span className="text-muted-foreground flex-shrink-0">Tokens:</span>
              <span className="text-foreground">{node.tokens.toLocaleString()}</span>
            </div>
          )}
          <div className="flex gap-2">
            <span className="text-muted-foreground flex-shrink-0">开始:</span>
            <span className="text-foreground">{node.started_at}</span>
          </div>
          {node.ended_at && (
            <div className="flex gap-2">
              <span className="text-muted-foreground flex-shrink-0">结束:</span>
              <span className="text-foreground">{node.ended_at}</span>
            </div>
          )}
        </div>

        {/* Input (editable) */}
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">
            输入 (Input)
          </label>
          <textarea
            value={annotationInput}
            onChange={(e) => setAnnotationInput(e.target.value)}
            className="w-full min-h-[80px] px-2.5 py-1.5 text-xs font-mono rounded-md border border-input bg-background text-foreground resize-y"
            placeholder="节点输入..."
          />
        </div>

        {/* Output (editable) */}
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">
            输出 (Output)
          </label>
          <textarea
            value={annotationOutput}
            onChange={(e) => setAnnotationOutput(e.target.value)}
            className="w-full min-h-[80px] px-2.5 py-1.5 text-xs font-mono rounded-md border border-input bg-background text-foreground resize-y"
            placeholder="节点输出..."
          />
        </div>

        {/* Original summaries (read-only, for reference) */}
        {(node.input_summary || node.output_summary) && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              查看原始输入输出
            </summary>
            <div className="mt-2 space-y-2">
              {node.input_summary && (
                <div>
                  <div className="text-[10px] text-muted-foreground mb-0.5">原始输入</div>
                  <pre className="text-[10px] font-mono whitespace-pre-wrap break-all bg-muted p-2 rounded max-h-40 overflow-y-auto">
                    {node.input_summary}
                  </pre>
                </div>
              )}
              {node.output_summary && (
                <div>
                  <div className="text-[10px] text-muted-foreground mb-0.5">原始输出</div>
                  <pre className="text-[10px] font-mono whitespace-pre-wrap break-all bg-muted p-2 rounded max-h-40 overflow-y-auto">
                    {node.output_summary}
                  </pre>
                </div>
              )}
            </div>
          </details>
        )}

        {/* Evidence list (v57 atomic steps) — every judgment is traceable */}
        {node.evidence_json && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              证据链 (Evidence)
            </summary>
            <div className="mt-2 space-y-1.5">
              {(() => {
                try {
                  const items = JSON.parse(node.evidence_json!) as Array<{
                    type?: string;
                    ref?: string;
                    detail?: string;
                    stage?: string;
                    passed?: boolean;
                  }>;
                  if (!Array.isArray(items)) return <span className="text-[10px] text-muted-foreground">无</span>;
                  return items.map((ev, i) => (
                    <div key={i} className="text-[10px] font-mono bg-muted p-1.5 rounded break-all">
                      <span className="text-muted-foreground">[{ev.type ?? ev.stage ?? 'evidence'}]</span>{' '}
                      {ev.ref && <span className="text-primary">{ev.ref} </span>}
                      {ev.detail ?? JSON.stringify(ev)}
                      {typeof ev.passed === 'boolean' && (
                        <span className={ev.passed ? 'text-green-600 ml-1' : 'text-red-500 ml-1'}>
                          {ev.passed ? '✓' : '✗'}
                        </span>
                      )}
                    </div>
                  ));
                } catch {
                  return <span className="text-[10px] text-muted-foreground">证据解析失败</span>;
                }
              })()}
            </div>
          </details>
        )}

        {/* Large I/O offload reference (v57) */}
        {node.output_ref && (
          <div className="text-[10px] text-muted-foreground break-all">
            <span className="font-medium">大 I/O 落盘:</span> {node.output_ref}
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div className="flex-shrink-0 p-3 border-t border-border space-y-2">
        <Button
          onClick={handleSave}
          disabled={saving}
          className="w-full"
          size="sm"
          variant="outline"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          保存注解
        </Button>
        <div className="flex gap-2">
          <Button
            onClick={() => handleRerun('rerun')}
            disabled={rerunning}
            className="flex-1"
            size="sm"
            variant="outline"
          >
            {rerunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCw className="w-4 h-4" />}
            重跑此节点
          </Button>
          <Button
            onClick={() => handleRerun('continue')}
            disabled={rerunning}
            className="flex-1"
            size="sm"
          >
            {rerunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />}
            从此续跑
          </Button>
        </div>
      </div>
    </div>
  );
}
