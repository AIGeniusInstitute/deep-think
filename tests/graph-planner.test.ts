import { describe, expect, test } from 'vitest';

import { buildPlanPrompt, extractJson, parseDefinition } from '../src/graph-engineering/graph-planner.js';
import {
  buildDevWorkflow,
  buildReportPpt,
  buildParallelResearch,
  instantiateTemplate,
} from '../src/graph-engineering/graph-templates.js';
import { validateDefinition } from '../src/graph-engineering/graph-registry.js';

describe('extractJson — strips fences + prose', () => {
  test('plain json', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });
  test('fenced json', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  test('prose + json + prose', () => {
    expect(extractJson('here is the graph:\n{"a":1}\nthanks')).toBe('{"a":1}');
  });
});

describe('parseDefinition — LLM JSON → GraphDefinition', () => {
  test('valid minimal graph', () => {
    const raw = JSON.stringify({
      id: 'g1', version: 1, name: 'test',
      nodes: [
        { id: 'start', type: 'start', title: 'Start' },
        { id: 'a', type: 'agent', title: 'A', prompt: 'do A' },
        { id: 'g', type: 'gate', title: 'G', successCriteria: 'A done', upstreamNodeId: 'a', assertions: [{ kind: 'contains', value: 'A done' }] },
        { id: 'end', type: 'end', title: 'End', outputTemplate: '${state.node_a_output}' },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'a' },
        { id: 'e2', from: 'a', to: 'g' },
        { id: 'e3', from: 'g', to: 'end' },
      ],
      budget: { maxTokens: 50000 },
    });
    const def = parseDefinition(raw);
    expect(def).not.toBeNull();
    expect(def!.nodes).toHaveLength(4);
    expect(def!.budget?.maxTokens).toBe(50000);
    expect(validateDefinition(def!).ok).toBe(true);
  });
  test('rejects non-json', () => {
    expect(parseDefinition('not json at all')).toBeNull();
  });
  test('rejects missing nodes/edges arrays', () => {
    expect(parseDefinition('{"id":"x","name":"y"}')).toBeNull();
  });
});

describe('buildPlanPrompt — includes task + constraints', () => {
  test('contains task text + node-type list + JSON schema', () => {
    const p = buildPlanPrompt({ task: '写行业报告', ownerUserId: 'u', groupFolder: 'main' });
    expect(p).toContain('写行业报告');
    expect(p).toContain('agent');
    expect(p).toContain('parallel');
    expect(p).toContain('isDefault');
    expect(p).toContain('budget');
  });
});

describe('graph-templates — built-in patterns produce valid DAGs', () => {
  const params = { topic: 'AI Agent 行业调研', acceptanceCriteria: '报告完整覆盖现状/趋势/案例' };

  test('dev-workflow is a valid DAG with gate', () => {
    const def = buildDevWorkflow(params);
    const v = validateDefinition(def);
    expect(v.ok).toBe(true);
    expect(def.nodes.some((n) => n.type === 'gate')).toBe(true);
    expect(def.nodes.some((n) => n.type === 'start')).toBe(true);
    expect(def.nodes.some((n) => n.type === 'end')).toBe(true);
  });

  test('report-ppt has parallel fan-out + aggregate (AC1/AC2)', () => {
    const def = buildReportPpt(params);
    const v = validateDefinition(def);
    expect(v.ok).toBe(true);
    expect(def.nodes.some((n) => n.type === 'parallel')).toBe(true);
    expect(def.nodes.some((n) => n.type === 'aggregate')).toBe(true);
    // 3 parallel research branches
    const researchNodes = def.nodes.filter((n) => n.type === 'agent' && n.title.startsWith('调研'));
    expect(researchNodes.length).toBe(3);
    // aggregate has 3 incoming edges (fan-in)
    const agg = def.nodes.find((n) => n.type === 'aggregate')!;
    const incoming = def.edges.filter((e) => e.to === agg.id);
    expect(incoming.length).toBe(3);
  });

  test('parallel-research is valid', () => {
    const def = buildParallelResearch(params);
    expect(validateDefinition(def).ok).toBe(true);
    expect(def.nodes.some((n) => n.type === 'aggregate')).toBe(true);
  });

  test('instantiateTemplate dispatches by id', () => {
    const def = instantiateTemplate('dev-workflow', params);
    expect(validateDefinition(def).ok).toBe(true);
  });
});
