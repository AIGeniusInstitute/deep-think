import { describe, expect, test } from 'vitest';

import {
  parseOrchestratorPlan,
  buildFallbackPlan,
} from '../src/agent-orchestration/orchestrator-plan.js';
import { assembleOrchestratorGraph } from '../src/agent-orchestration/orchestrator-runner.js';
import type { AgentDefinitionRow } from '../src/db.js';

const WORKER_IDS = new Set(['w1', 'w2', 'w3']);

function workerRow(id: string, name: string): AgentDefinitionRow {
  return {
    id,
    user_id: 'u1',
    name,
    description: `${name} 描述`,
    system_prompt: `你是 ${name}`,
    model: null,
    engine: null,
    avatar_emoji: null,
    avatar_color: null,
    max_turns: null,
    temperature: null,
    enabled: 1,
    kind: 'assistant',
    created_at: '2026-08-28T00:00:00.000Z',
    updated_at: '2026-08-28T00:00:00.000Z',
  } as unknown as AgentDefinitionRow;
}

describe('parseOrchestratorPlan — LLM JSON → validated plan', () => {
  test('valid plain JSON', () => {
    const raw = JSON.stringify({
      planName: 'build-site',
      steps: [
        { id: 'step1', title: '调研', workerId: 'w1', task: '做调研', dependsOn: [] },
        { id: 'step2', title: '写代码', workerId: 'w2', task: '写代码', dependsOn: ['step1'] },
      ],
      acceptanceCriteria: '可运行',
    });
    const plan = parseOrchestratorPlan(raw, WORKER_IDS);
    expect(plan).not.toBeNull();
    expect(plan!.planName).toBe('build-site');
    expect(plan!.steps).toHaveLength(2);
    expect(plan!.steps[1].dependsOn).toEqual(['step1']);
  });

  test('fenced json is stripped', () => {
    const raw = '```json\n' + JSON.stringify({
      planName: 'p',
      steps: [{ id: 's', title: 't', workerId: 'w1', task: 'x', dependsOn: [] }],
    }) + '\n```';
    expect(parseOrchestratorPlan(raw, WORKER_IDS)).not.toBeNull();
  });

  test('prose + json + prose', () => {
    const raw = '好的，以下是我的计划：\n' + JSON.stringify({
      planName: 'p',
      steps: [{ id: 's', title: 't', workerId: 'w1', task: 'x', dependsOn: [] }],
    }) + '\n希望有帮助';
    expect(parseOrchestratorPlan(raw, WORKER_IDS)).not.toBeNull();
  });

  test('workerId not in linked set → null', () => {
    const raw = JSON.stringify({
      planName: 'p',
      steps: [{ id: 's', title: 't', workerId: 'UNKNOWN', task: 'x', dependsOn: [] }],
    });
    expect(parseOrchestratorPlan(raw, WORKER_IDS)).toBeNull();
  });

  test('dependsOn referencing missing step → null', () => {
    const raw = JSON.stringify({
      planName: 'p',
      steps: [{ id: 's', title: 't', workerId: 'w1', task: 'x', dependsOn: ['ghost'] }],
    });
    expect(parseOrchestratorPlan(raw, WORKER_IDS)).toBeNull();
  });

  test('cyclic dependsOn → null', () => {
    const raw = JSON.stringify({
      planName: 'p',
      steps: [
        { id: 'a', title: 'A', workerId: 'w1', task: 'x', dependsOn: ['b'] },
        { id: 'b', title: 'B', workerId: 'w2', task: 'y', dependsOn: ['a'] },
      ],
    });
    expect(parseOrchestratorPlan(raw, WORKER_IDS)).toBeNull();
  });

  test('empty steps → null', () => {
    const raw = JSON.stringify({ planName: 'p', steps: [] });
    expect(parseOrchestratorPlan(raw, WORKER_IDS)).toBeNull();
  });

  test('garbage → null', () => {
    expect(parseOrchestratorPlan('not json at all', WORKER_IDS)).toBeNull();
  });

  test('null input → null', () => {
    expect(parseOrchestratorPlan(null, WORKER_IDS)).toBeNull();
  });
});

describe('buildFallbackPlan — deterministic sequential dispatch', () => {
  test('chains workers in link order', () => {
    const plan = buildFallbackPlan(['w1', 'w2', 'w3'], '做一个网站');
    expect(plan.planName).toBe('sequential-fallback');
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps.map((s) => s.workerId)).toEqual(['w1', 'w2', 'w3']);
    expect(plan.steps[0].dependsOn).toEqual([]);
    expect(plan.steps[1].dependsOn).toEqual(['step1']);
    expect(plan.steps[2].dependsOn).toEqual(['step2']);
  });

  test('single worker has no deps', () => {
    const plan = buildFallbackPlan(['w1'], '任务');
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].dependsOn).toEqual([]);
  });
});

describe('assembleOrchestratorGraph — plan → GraphDefinition', () => {
  const workerById = new Map([
    ['w1', workerRow('w1', '研究员')],
    ['w2', workerRow('w2', '工程师')],
  ]);

  test('maps each step to an agent node with agentDefId + goalAnchor', () => {
    const plan = buildFallbackPlan(['w1', 'w2'], '写一份报告');
    const input = {
      orchestratorId: 'orch1',
      task: '写一份报告',
      ownerUserId: 'u1',
      groupFolder: 'main',
      chatJid: 'web:main',
    };
    const graph = assembleOrchestratorGraph(plan, workerById, input);

    const agentNodes = graph.nodes.filter((n) => n.type === 'agent');
    expect(agentNodes).toHaveLength(2);
    expect(agentNodes[0].agentDefId).toBe('w1');
    expect(agentNodes[0].agentMember).toBe('研究员');
    expect(agentNodes[0].goalAnchor).toContain('写一份报告');
    expect(agentNodes[1].agentDefId).toBe('w2');

    // sequential fallback produces a data edge between the two steps.
    expect(graph.edges.some((e) => e.from === 'step1' && e.to === 'step2')).toBe(true);
  });

  test('appends a trailing acceptance gate node', () => {
    const plan = buildFallbackPlan(['w1'], '任务');
    const input = {
      orchestratorId: 'orch1',
      task: '任务',
      acceptanceCriteria: '输出必须包含结论',
      ownerUserId: 'u1',
      groupFolder: 'main',
      chatJid: 'web:main',
    };
    const graph = assembleOrchestratorGraph(plan, workerById, input);
    const gate = graph.nodes.find((n) => n.type === 'gate');
    expect(gate).toBeDefined();
    expect(gate!.id).toBe('accept');
    expect(graph.edges.some((e) => e.to === 'accept')).toBe(true);
  });

  test('no acceptance criteria → gate has no assertions', () => {
    const plan = {
      planName: 'p',
      steps: [{ id: 's', title: 't', workerId: 'w1', task: 'x', dependsOn: [] }],
      acceptanceCriteria: '',
    };
    const input = {
      orchestratorId: 'orch1',
      task: '任务',
      ownerUserId: 'u1',
      groupFolder: 'main',
      chatJid: 'web:main',
    };
    const graph = assembleOrchestratorGraph(plan, workerById, input);
    const gate = graph.nodes.find((n) => n.type === 'gate');
    expect(gate).toBeDefined();
    expect((gate as { assertions?: unknown[] }).assertions).toBeUndefined();
  });

  test('unknown worker id throws', () => {
    const plan = buildFallbackPlan(['missing'], '任务');
    const input = {
      orchestratorId: 'orch1',
      task: '任务',
      ownerUserId: 'u1',
      groupFolder: 'main',
      chatJid: 'web:main',
    };
    expect(() => assembleOrchestratorGraph(plan, workerById, input)).toThrow(/unknown worker/);
  });
});
