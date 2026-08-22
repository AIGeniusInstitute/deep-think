/**
 * Graph Planner — natural-language task → legal GraphDefinition.
 *
 * One-shot LLM call (sdkQuery, no tools) producing a GraphDefinition JSON that
 * may contain parallel branches, conditional routing, default fallback edges,
 * gate verification, and the new DSL v2 node kinds. The output is validated by
 * graph-registry's validateDefinition (DAG, dangling edges, branch coverage,
 * new-node required fields). On failure the planner retries once, then
 * degrades to the dev-workflow template so the user always gets an executable
 * graph (TC10).
 *
 * See docs/prd/graph-task-planning-execution/PRD.md §2.2.
 */

import { sdkQuery } from '../sdk-query.js';
import { logger } from '../logger.js';
import { registerDefinition, validateDefinition } from './graph-registry.js';
import { instantiateTemplate, type TemplateId } from './graph-templates.js';
import type { GraphDefinition, GraphNode, GraphEdge } from './graph-types.js';

export interface PlanInput {
  task: string;
  background?: string;
  acceptanceCriteria?: string;
  ownerUserId: string;
  groupFolder: string;
  userLanguage?: string;
  /** Force a specific template instead of LLM planning. */
  template?: TemplateId;
}

export interface PlanResult {
  definition: GraphDefinition;
  /** How the definition was produced — 'llm' | 'template' | 'fallback'. */
  source: 'llm' | 'template' | 'fallback';
  /** Warnings (e.g. LLM output failed validation and was retried). */
  warnings: string[];
}

const PLAN_TIMEOUT_MS = 90_000;

/** Build the planner prompt. Pure — unit-testable. */
export function buildPlanPrompt(input: PlanInput): string {
  const lang = input.userLanguage ?? 'zh-CN';
  return [
    '你是一名资深任务规划专家。请把以下复杂任务拆解为一个 Graph（有向无环图）定义，输出严格 JSON。',
    '',
    `【任务】${input.task}`,
    input.background ? `【背景】${input.background}` : '',
    input.acceptanceCriteria ? `【验收标准】${input.acceptanceCriteria}` : '',
    '',
    '可用节点类型：agent（绑定 Agent 执行）、gate（行为证据验收）、llm（纯模型推理）、tool（直接工具，toolName 仅支持 run_script）、start/end（起止）、parallel（并行 fan-out 语义糖）、aggregate（汇聚，mergeStrategy: all/any/arbitrate）、branch（条件路由，需 branchKey）、join、human（人工审批）。',
    '边支持：普通数据边；condition（branch 出边的字符串相等条件）；expression（条件表达式如 "${node_x.output.score} > 0.8"）；isDefault（fallback 边，条件全不命中时走）。',
    '节点间数据通过 ${node_id.output.field} 或 ${state.key} 引用传递。',
    '',
    '要求：',
    '1. 输出严格 JSON，不要 markdown 代码块，结构为 {"id","version":1,"name","nodes":[...],"edges":[...],"budget":{...可选}}',
    '2. 至少 1 个 agent 节点 + 1 个 gate 验收节点',
    '3. 可并行子任务用 parallel 节点 fan-out + aggregate 汇聚',
    '4. 有不确定路径时用 branch + condition 边 + isDefault 降级边',
    '5. DAG 必须无环；edge.from/to 必须引用已定义 node.id',
    `6. 用 ${lang} 描述节点 title/prompt`,
    '',
    '示例结构（report-ppt）：',
    '{"id":"graph-x","version":1,"name":"...","nodes":[{"id":"start","type":"start",...},{"id":"fanout","type":"parallel",...},...,{"id":"end","type":"end","outputTemplate":"${state.node_x_output}"}],"edges":[...],"budget":{"maxTokens":50000}}',
  ].filter(Boolean).join('\n');
}

/** Strip markdown code fences + leading prose, return the JSON object string. */
export function extractJson(raw: string): string {
  let s = raw.trim();
  // Remove ```json ... ``` fences.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  // Find the first { and last } to carve out the JSON object.
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return s;
}

/** Parse + structurally validate the LLM's JSON into a GraphDefinition. */
export function parseDefinition(raw: string): GraphDefinition | null {
  try {
    const obj = JSON.parse(extractJson(raw));
    if (!obj || !Array.isArray(obj.nodes) || !Array.isArray(obj.edges)) return null;
    return {
      id: String(obj.id ?? `plan-${Date.now()}`),
      version: 1,
      name: String(obj.name ?? 'planned graph'),
      description: obj.description ? String(obj.description) : undefined,
      nodes: obj.nodes as GraphNode[],
      edges: obj.edges as GraphEdge[],
      stateSchema: Array.isArray(obj.stateSchema) ? obj.stateSchema : undefined,
      budget: obj.budget ?? undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Plan a graph from a natural-language task. Returns a registered, executable
 * GraphDefinition. On LLM failure / invalid output, degrades to a template.
 */
export async function planGraph(input: PlanInput): Promise<PlanResult> {
  const warnings: string[] = [];

  // Forced template path.
  if (input.template) {
    const def = instantiateTemplate(input.template, {
      topic: input.task,
      acceptanceCriteria: input.acceptanceCriteria,
      background: input.background,
    });
    return { definition: def, source: 'template', warnings };
  }

  const prompt = buildPlanPrompt(input);
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await sdkQuery(prompt, { timeout: PLAN_TIMEOUT_MS });
    if (!raw) {
      warnings.push(`LLM 返回空（第 ${attempt + 1} 次）`);
      continue;
    }
    const def = parseDefinition(raw);
    if (!def) {
      warnings.push(`LLM 输出 JSON 解析失败（第 ${attempt + 1} 次）`);
      continue;
    }
    const validation = validateDefinition(def);
    if (!validation.ok) {
      warnings.push(`LLM 输出校验失败（第 ${attempt + 1} 次）：${validation.errors.join('; ')}`);
      continue;
    }
    logger.info({ defId: def.id, nodeCount: def.nodes.length, attempt }, 'Graph planner produced valid definition');
    return { definition: def, source: 'llm', warnings };
  }

  // Fallback: dev-workflow template.
  const fallback = instantiateTemplate('dev-workflow', {
    topic: input.task,
    acceptanceCriteria: input.acceptanceCriteria,
    background: input.background,
  });
  warnings.push('LLM 规划失败，已降级为 dev-workflow 模板');
  logger.warn({ task: input.task, warnings }, 'Graph planner degraded to template fallback');
  return { definition: fallback, source: 'fallback', warnings };
}

/**
 * Plan + register a graph definition (auto-increments version). Returns the
 * registered definition id + version. Used by the POST /api/graph/plan route.
 */
export async function planAndRegister(input: PlanInput): Promise<{
  definition: GraphDefinition;
  source: PlanResult['source'];
  warnings: string[];
}> {
  const result = await planGraph(input);
  // registerDefinition validates again + computes manifest hash + persists.
  registerDefinition(result.definition);
  return result;
}
