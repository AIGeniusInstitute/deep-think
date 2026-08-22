/**
 * Graph Templates — built-in parameterized GraphDefinition factories.
 *
 * Three task patterns the auto-planner can fall back to (and that users can
 * invoke directly via POST /api/graph/plan with `template:`). Parameters are
 * {topic} / {acceptanceCriteria} placeholders substituted at instantiation.
 *
 * See docs/prd/graph-task-planning-execution/PRD.md §2.2.3.
 */

import type { GraphDefinition, GraphNode, GraphEdge } from './graph-types.js';

export interface TemplateParams {
  topic: string;
  acceptanceCriteria?: string;
  /** Optional member-role hints injected into agent node prompts. */
  background?: string;
}

export type TemplateId = 'dev-workflow' | 'report-ppt' | 'parallel-research';

let nodeSeq = 0;
/** Stable id generator for template instances (reset per build is fine —
 *  template graphs are rebuilt on each plan call). */
function nid(prefix: string): string {
  nodeSeq += 1;
  return `${prefix}-${nodeSeq}`;
}

function agent(id: string, title: string, prompt: string): GraphNode {
  return { id, type: 'agent', title, prompt };
}
function gate(id: string, title: string, successCriteria: string, upstream: string): GraphNode {
  return {
    id,
    type: 'gate',
    title,
    successCriteria,
    upstreamNodeId: upstream,
    assertions: [{ kind: 'contains' as const, value: successCriteria.slice(0, 60) || title }],
  };
}

const accept = (p: TemplateParams) =>
  p.acceptanceCriteria || `交付物须紧扣主题「${p.topic}」且内容完整可用`;

/**
 * dev-workflow: 调研 → 实现 → 评审 → 验收 (serial).
 */
export function buildDevWorkflow(p: TemplateParams): GraphDefinition {
  nodeSeq = 0;
  const research = agent(nid('research'), '调研', `围绕「${p.topic}」进行调研，输出结构化要点。${p.background ? `\n背景：${p.background}` : ''}`);
  const impl = agent(nid('impl'), '实现', `基于调研要点，完成「${p.topic}」的实际产出。`);
  const review = gate(nid('review'), '评审', '产出是否完整、无明显错误', impl.id);
  const acceptGate = gate(nid('accept'), '验收', accept(p), impl.id);
  const nodes: GraphNode[] = [
    { id: 'start', type: 'start', title: 'Start', inputParams: [{ name: 'topic' }] },
    research,
    impl,
    review,
    acceptGate,
    { id: 'end', type: 'end', title: 'End', outputTemplate: '${state.node_' + impl.id + '_output}' },
  ];
  const edges: GraphEdge[] = [
    { id: 'e1', from: 'start', to: research.id },
    { id: 'e2', from: research.id, to: impl.id },
    { id: 'e3', from: impl.id, to: review.id },
    { id: 'e4', from: review.id, to: acceptGate.id },
    { id: 'e5', from: acceptGate.id, to: 'end' },
  ];
  return { id: `tpl-dev-workflow-${Date.now()}`, version: 1, name: `dev-workflow: ${p.topic}`, nodes, edges };
}

/**
 * report-ppt: 并行调研（3 分支）→ 汇聚 → 撰写 → PPT → 验收.
 * Exercises parallel fan-out + aggregate (AC1, AC2).
 */
export function buildReportPpt(p: TemplateParams): GraphDefinition {
  nodeSeq = 0;
  const ra = agent(nid('ra'), '调研A', `调研「${p.topic}」的市场现状维度。`);
  const rb = agent(nid('rb'), '调研B', `调研「${p.topic}」的技术趋势维度。`);
  const rc = agent(nid('rc'), '调研C', `调研「${p.topic}」的代表案例维度。`);
  const agg: GraphNode = {
    id: nid('agg'),
    type: 'aggregate',
    title: '汇聚',
    mergeStrategy: 'arbitrate',
    arbitratePrompt: '请将三路调研产出合并为统一的报告大纲。',
  };
  const write = agent(nid('write'), '撰写', `基于汇聚大纲撰写「${p.topic}」完整报告。`);
  const ppt = agent(nid('ppt'), 'PPT', `将报告转为可演示的 PPT 内容。`);
  const acceptGate = gate(nid('accept'), '验收', accept(p), ppt.id);
  const nodes: GraphNode[] = [
    { id: 'start', type: 'start', title: 'Start', inputParams: [{ name: 'topic' }] },
    { id: 'fanout', type: 'parallel', title: '并行调研' },
    ra, rb, rc,
    agg,
    write,
    ppt,
    acceptGate,
    { id: 'end', type: 'end', title: 'End', outputTemplate: '${state.node_' + ppt.id + '_output}' },
  ];
  const edges: GraphEdge[] = [
    { id: 'e0', from: 'start', to: 'fanout' },
    { id: 'ea', from: 'fanout', to: ra.id },
    { id: 'eb', from: 'fanout', to: rb.id },
    { id: 'ec', from: 'fanout', to: rc.id },
    { id: 'eAggA', from: ra.id, to: agg.id },
    { id: 'eAggB', from: rb.id, to: agg.id },
    { id: 'eAggC', from: rc.id, to: agg.id },
    { id: 'eW', from: agg.id, to: write.id },
    { id: 'eP', from: write.id, to: ppt.id },
    { id: 'eAc', from: ppt.id, to: acceptGate.id },
    { id: 'eE', from: acceptGate.id, to: 'end' },
  ];
  return { id: `tpl-report-ppt-${Date.now()}`, version: 1, name: `report-ppt: ${p.topic}`, nodes, edges };
}

/**
 * parallel-research: 多分支并行调研 → 仲裁汇聚.
 */
export function buildParallelResearch(p: TemplateParams): GraphDefinition {
  nodeSeq = 0;
  const r1 = agent(nid('r1'), '调研1', `从角度1调研「${p.topic}」。`);
  const r2 = agent(nid('r2'), '调研2', `从角度2调研「${p.topic}」。`);
  const r3 = agent(nid('r3'), '调研3', `从角度3调研「${p.topic}」。`);
  const agg: GraphNode = {
    id: nid('agg'),
    type: 'aggregate',
    title: '仲裁汇聚',
    mergeStrategy: 'arbitrate',
    arbitratePrompt: '请综合三路调研，给出结论与分歧。',
  };
  const nodes: GraphNode[] = [
    { id: 'start', type: 'start', title: 'Start', inputParams: [{ name: 'topic' }] },
    { id: 'fanout', type: 'parallel', title: '并行' },
    r1, r2, r3, agg,
    { id: 'end', type: 'end', title: 'End', outputTemplate: '${state.node_' + agg.id + '_output}' },
  ];
  const edges: GraphEdge[] = [
    { id: 'e0', from: 'start', to: 'fanout' },
    { id: 'e1', from: 'fanout', to: r1.id },
    { id: 'e2', from: 'fanout', to: r2.id },
    { id: 'e3', from: 'fanout', to: r3.id },
    { id: 'eA1', from: r1.id, to: agg.id },
    { id: 'eA2', from: r2.id, to: agg.id },
    { id: 'eA3', from: r3.id, to: agg.id },
    { id: 'eE', from: agg.id, to: 'end' },
  ];
  return { id: `tpl-parallel-research-${Date.now()}`, version: 1, name: `parallel-research: ${p.topic}`, nodes, edges };
}

export const TEMPLATES: Record<TemplateId, (p: TemplateParams) => GraphDefinition> = {
  'dev-workflow': buildDevWorkflow,
  'report-ppt': buildReportPpt,
  'parallel-research': buildParallelResearch,
};

/** Instantiate a template by id, substituting params. */
export function instantiateTemplate(id: TemplateId, p: TemplateParams): GraphDefinition {
  const factory = TEMPLATES[id] ?? buildDevWorkflow;
  return factory(p);
}
