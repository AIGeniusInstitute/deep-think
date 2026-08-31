/**
 * Pure validation helpers for editable workflow drafts.
 *
 * The backend graph registry remains authoritative. This lightweight mirror
 * gives users actionable feedback before a save request is sent.
 */

export type WorkflowValidationSeverity = 'error' | 'warning';

export type WorkflowValidationCode =
  | 'missing-name'
  | 'empty-graph'
  | 'missing-node-id'
  | 'duplicate-node-id'
  | 'node-id-mismatch'
  | 'missing-node-field'
  | 'missing-edge-endpoint'
  | 'dangling-edge'
  | 'self-loop'
  | 'duplicate-edge'
  | 'ambiguous-edge-condition'
  | 'multiple-default-edges'
  | 'cycle'
  | 'unbound-agent';

export interface WorkflowValidationIssue {
  code: WorkflowValidationCode;
  severity: WorkflowValidationSeverity;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface WorkflowValidationNode {
  id: string;
  data: Record<string, unknown>;
}

export interface WorkflowValidationEdge {
  id: string;
  source: string;
  target: string;
  condition?: unknown;
  expression?: unknown;
  isDefault?: unknown;
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function nodeLabel(node: WorkflowValidationNode): string {
  return hasText(node.data.title) ? node.data.title : node.id || '未命名节点';
}

function pushMissingField(issues: WorkflowValidationIssue[], node: WorkflowValidationNode, fieldLabel: string): void {
  issues.push({
    code: 'missing-node-field',
    severity: 'error',
    nodeId: node.id,
    message: `节点「${nodeLabel(node)}」缺少必填字段：${fieldLabel}`,
  });
}

export function validateWorkflowGraph(input: {
  name: string;
  nodes: readonly WorkflowValidationNode[];
  edges: readonly WorkflowValidationEdge[];
}): WorkflowValidationIssue[] {
  const { name, nodes, edges } = input;
  const issues: WorkflowValidationIssue[] = [];

  if (!hasText(name)) {
    issues.push({
      code: 'missing-name',
      severity: 'error',
      message: '工作流名称不能为空',
    });
  }
  if (nodes.length === 0) {
    issues.push({
      code: 'empty-graph',
      severity: 'error',
      message: '工作流至少需要一个节点',
    });
  }

  const nodeIds = new Set<string>();
  for (const node of nodes) {
    const dataId = node.data.id;
    if (!hasText(dataId)) {
      issues.push({
        code: 'missing-node-id',
        severity: 'error',
        nodeId: node.id,
        message: `节点「${nodeLabel(node)}」缺少 ID`,
      });
    } else {
      if (nodeIds.has(dataId)) {
        issues.push({
          code: 'duplicate-node-id',
          severity: 'error',
          nodeId: dataId,
          message: `节点 ID 重复：${dataId}`,
        });
      }
      nodeIds.add(dataId);
      if (node.id !== dataId) {
        issues.push({
          code: 'node-id-mismatch',
          severity: 'error',
          nodeId: node.id,
          message: `节点「${nodeLabel(node)}」的画布 ID 与定义 ID 不一致`,
        });
      }
    }

    const type = node.data.type;
    if (type === 'branch' && !hasText(node.data.branchKey)) {
      pushMissingField(issues, node, 'branchKey');
    }
    if ((type === 'agent' || type === 'gate') && !hasText(node.data.prompt) && !hasText(node.data.successCriteria)) {
      pushMissingField(issues, node, type === 'agent' ? 'prompt' : 'successCriteria');
    }
    if (type === 'llm' && !hasText(node.data.prompt)) {
      pushMissingField(issues, node, 'prompt');
    }
    if (type === 'tool' && !hasText(node.data.toolName)) {
      pushMissingField(issues, node, 'toolName');
    }
    if (type === 'aggregate' && node.data.mergeStrategy === 'arbitrate' && !hasText(node.data.arbitratePrompt)) {
      pushMissingField(issues, node, 'arbitratePrompt');
    }
    if (type === 'agent' && !hasText(node.data.agentDefId)) {
      issues.push({
        code: 'unbound-agent',
        severity: 'warning',
        nodeId: node.id,
        message: `Agent 节点「${nodeLabel(node)}」尚未绑定 Agent，保存后运行时将使用默认 Agent`,
      });
    }
  }

  const edgePairs = new Set<string>();
  const defaultCountBySource = new Map<string, number>();
  for (const edge of edges) {
    if (!hasText(edge.source) || !hasText(edge.target)) {
      issues.push({
        code: 'missing-edge-endpoint',
        severity: 'error',
        edgeId: edge.id,
        message: `连线「${edge.id || '未命名'}」缺少起点或终点`,
      });
      continue;
    }
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      const missing = [
        !nodeIds.has(edge.source) ? `起点 ${edge.source}` : '',
        !nodeIds.has(edge.target) ? `终点 ${edge.target}` : '',
      ]
        .filter(Boolean)
        .join('、');
      issues.push({
        code: 'dangling-edge',
        severity: 'error',
        edgeId: edge.id,
        message: `连线「${edge.id || `${edge.source}→${edge.target}`}」引用了不存在的节点：${missing}`,
      });
    }
    if (edge.source === edge.target) {
      issues.push({
        code: 'self-loop',
        severity: 'error',
        edgeId: edge.id,
        nodeId: edge.source,
        message: `不允许节点自连接：${edge.source} → ${edge.target}`,
      });
    }

    const pairKey = `${edge.source}\u0000${edge.target}`;
    if (edgePairs.has(pairKey)) {
      issues.push({
        code: 'duplicate-edge',
        severity: 'error',
        edgeId: edge.id,
        message: `存在重复连线：${edge.source} → ${edge.target}`,
      });
    }
    edgePairs.add(pairKey);

    if (hasText(edge.condition) && hasText(edge.expression)) {
      issues.push({
        code: 'ambiguous-edge-condition',
        severity: 'error',
        edgeId: edge.id,
        message: `连线「${edge.id}」不能同时设置 condition 和 expression`,
      });
    }
    if (edge.isDefault === true) {
      defaultCountBySource.set(edge.source, (defaultCountBySource.get(edge.source) ?? 0) + 1);
    }
  }

  for (const [source, count] of defaultCountBySource) {
    if (count > 1) {
      issues.push({
        code: 'multiple-default-edges',
        severity: 'error',
        nodeId: source,
        message: `节点 ${source} 存在 ${count} 条默认连线，最多只能有一条`,
      });
    }
  }

  // Kahn topological traversal: if not every unique node can be consumed,
  // the draft contains at least one directed cycle.
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const id of nodeIds) {
    indegree.set(id, 0);
    outgoing.set(id, []);
  }
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    outgoing.get(edge.source)?.push(edge.target);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }
  const queue = [...nodeIds].filter((id) => indegree.get(id) === 0);
  let visited = 0;
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head];
    visited += 1;
    for (const target of outgoing.get(id) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
  }
  if (nodeIds.size > 0 && visited !== nodeIds.size) {
    issues.push({
      code: 'cycle',
      severity: 'error',
      message: '工作流存在环，必须保持为有向无环图（DAG）',
    });
  }

  return issues;
}
