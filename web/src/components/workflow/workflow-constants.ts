/**
 * Shared metadata for workflow node types — used by the editor palette, the
 * canvas node renderer, and the inspector. Colors mirror GraphDagView's
 * NODE_TYPE_COLORS so editor ↔ run views stay visually consistent.
 */

export type GraphNodeType =
  | 'agent' | 'gate' | 'branch' | 'join' | 'human'
  | 'llm' | 'tool' | 'start' | 'end' | 'parallel' | 'aggregate' | 'validate';

export const NODE_TYPE_COLORS: Record<string, string> = {
  agent: '#3b82f6',
  gate: '#eab308',
  branch: '#a855f7',
  join: '#10b981',
  human: '#f97316',
  llm: '#06b6d4',
  tool: '#0ea5e9',
  start: '#64748b',
  end: '#475569',
  parallel: '#8b5cf6',
  aggregate: '#ec4899',
  validate: '#16a34a',
};

export const NODE_TYPE_LABEL_ZH: Record<string, string> = {
  agent: 'Agent',
  gate: '验收门',
  branch: '分支',
  join: '汇合',
  human: '人工',
  llm: '推理',
  tool: '工具',
  start: '开始',
  end: '结束',
  parallel: '并行',
  aggregate: '聚合',
  validate: '校验',
};

/** Node types creatable from the palette (excludes parallel/aggregate sugar). */
export const PALETTE_TYPES: GraphNodeType[] = [
  'agent',
  'gate',
  'branch',
  'join',
  'human',
  'llm',
  'validate',
  'start',
  'end',
];

/** Default fields for a freshly dropped node of a given type. */
export function defaultNodeFields(type: GraphNodeType, title: string): Record<string, unknown> {
  switch (type) {
    case 'agent':
      return { prompt: title };
    case 'gate':
      return { successCriteria: '', assertions: [], shellCheck: '', upstreamNodeId: '' };
    case 'branch':
      return { branchKey: '' };
    case 'human':
      return { approvalPrompt: '', approvalOptions: [], approvalStateKey: '' };
    case 'llm':
      return { prompt: title, model: '' };
    case 'tool':
      return { toolName: 'run_script', toolInput: {} };
    case 'validate':
      // v57/v58 result-checking node: JSON Schema over the upstream node output,
      // plus a failure policy. upstreamNodeId is resolved at run time (default =
      // nearest predecessor).
      return {
        outputSchema: '{\n  "type": "object",\n  "required": [],\n  "properties": {}\n}',
        onFail: 'fail',
        fallbackValue: '',
        upstreamNodeId: '',
      };
    case 'start':
      return { inputParams: [] };
    case 'end':
      return { outputTemplate: '' };
    default:
      return {};
  }
}
