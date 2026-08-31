import { describe, expect, test } from 'vitest';

import {
  validateWorkflowGraph,
  type WorkflowValidationEdge,
  type WorkflowValidationNode,
} from '../web/src/components/workflow/workflow-validation';

function node(id: string, type: string = 'agent', fields: Record<string, unknown> = {}): WorkflowValidationNode {
  return {
    id,
    data: {
      id,
      type,
      title: id,
      ...(type === 'agent' ? { prompt: `执行 ${id}`, agentDefId: `agent-${id}` } : {}),
      ...fields,
    },
  };
}

function edge(id: string, source: string, target: string): WorkflowValidationEdge {
  return { id, source, target };
}

describe('workflow DAG validation', () => {
  test('accepts a valid DAG and keeps an unbound Agent as a non-blocking warning', () => {
    const issues = validateWorkflowGraph({
      name: '有效工作流',
      nodes: [node('start', 'start'), node('agent', 'agent', { agentDefId: '' }), node('end', 'end')],
      edges: [edge('e1', 'start', 'agent'), edge('e2', 'agent', 'end')],
    });

    expect(issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'unbound-agent', severity: 'warning' }));
  });

  test('rejects a directed cycle before save', () => {
    const issues = validateWorkflowGraph({
      name: '环图',
      nodes: [node('A'), node('B')],
      edges: [edge('e1', 'A', 'B'), edge('e2', 'B', 'A')],
    });

    expect(issues).toContainEqual(expect.objectContaining({ code: 'cycle', severity: 'error' }));
  });

  test('reports self-loops, duplicate connections and dangling endpoints', () => {
    const issues = validateWorkflowGraph({
      name: '非法连线',
      nodes: [node('A'), node('B')],
      edges: [
        edge('self', 'A', 'A'),
        edge('first', 'A', 'B'),
        edge('duplicate', 'A', 'B'),
        edge('dangling', 'B', 'missing'),
      ],
    });
    const codes = issues.map((issue) => issue.code);

    expect(codes).toContain('self-loop');
    expect(codes).toContain('duplicate-edge');
    expect(codes).toContain('dangling-edge');
  });

  test('reports required fields used by the graph registry', () => {
    const issues = validateWorkflowGraph({
      name: '字段校验',
      nodes: [
        node('branch', 'branch', { branchKey: '' }),
        node('gate', 'gate', { successCriteria: '' }),
        node('llm', 'llm', { prompt: '' }),
        node('tool', 'tool', { toolName: '' }),
      ],
      edges: [],
    });

    expect(issues.filter((issue) => issue.code === 'missing-node-field')).toHaveLength(4);
  });

  test('reports missing metadata, duplicate ids and invalid branch edge settings', () => {
    const issues = validateWorkflowGraph({
      name: '   ',
      nodes: [node('branch', 'branch', { branchKey: 'route' }), node('target'), node('target')],
      edges: [
        {
          ...edge('conditional', 'branch', 'target'),
          condition: 'fast',
          expression: 'state.route === "fast"',
          isDefault: true,
        },
        { ...edge('fallback', 'branch', 'target'), isDefault: true },
      ],
    });
    const codes = issues.map((issue) => issue.code);

    expect(codes).toContain('missing-name');
    expect(codes).toContain('duplicate-node-id');
    expect(codes).toContain('duplicate-edge');
    expect(codes).toContain('ambiguous-edge-condition');
    expect(codes).toContain('multiple-default-edges');
  });
});
