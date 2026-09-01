import { describe, expect, test } from 'vitest';

import {
  parseTeamPlan,
  validatePlanIntegrity,
  type TeamTaskInput,
} from '../../src/agent-team/team-plan.js';
import {
  buildDecompositionPrompt,
  buildDecompositionPromptByMode,
  buildFallbackPlan,
  SCENARIO_PRESETS,
} from '../../src/agent-team/team-prompt.js';
import { assembleGraphDefinition } from '../../src/agent-team/team-builder.js';
import { applyScenario } from '../../src/agent-team/collaboration-builder.js';

const baseInput: TeamTaskInput = {
  goalText: '调研X并实现Y原型并写测试',
  acceptanceCriteria: '测试通过且报告含X',
  ownerUserId: 'u1',
  groupFolder: 'main',
  chatJid: 'feishu:t1',
};

// --- A peer-mode plan: 2 parallel agents + a gate depending on both ---
const peerPlanJson = JSON.stringify({
  teamName: 'peer-demo',
  members: [
    {
      name: 'visionary',
      role: '愿景派',
      systemPrompt: '你是愿景派，产出前瞻方案。',
      engine: 'claude',
      model: null,
      skills: [],
      mcpServers: [],
      maxTurns: 12,
      deliverable: '方案写入 collaborations/c1/peer/visionary.md',
    },
    {
      name: 'pragmatist',
      role: '务实派',
      systemPrompt: '你是务实派，产出落地方案。',
      engine: 'claude',
      model: null,
      skills: [],
      mcpServers: [],
      maxTurns: 12,
      deliverable: '方案写入 collaborations/c1/peer/pragmatist.md',
    },
  ],
  graph: {
    nodes: [
      { id: 'v', type: 'agent', title: '愿景方案', agentMember: 'visionary', deliverable: '方案写入 collaborations/c1/peer/visionary.md', dependsOn: [] },
      { id: 'p', type: 'agent', title: '务实方案', agentMember: 'pragmatist', deliverable: '方案写入 collaborations/c1/peer/pragmatist.md', dependsOn: [] },
      {
        id: 'accept',
        type: 'gate',
        title: '汇聚验收',
        successCriteria: '各对等方案文件齐备且视角不同',
        upstreamNodeId: 'v',
        shellCheck: 'test -f "collaborations/c1/peer/visionary.md" && test -f "collaborations/c1/peer/pragmatist.md"',
        dependsOn: ['v', 'p'],
      },
    ],
  },
  acceptanceCriteria: '各对等方案文件齐备且视角不同',
});

// --- A critic-adversarial plan: producer + adversarial critic gate ---
const criticPlanJson = JSON.stringify({
  teamName: 'critic-demo',
  members: [
    {
      name: 'producer',
      role: '产出者',
      systemPrompt: '你是产出者，产出初稿；被批判打回则修订重做。',
      engine: 'claude',
      model: null,
      skills: [],
      mcpServers: [],
      maxTurns: 20,
      deliverable: '经批判修订的最终交付物',
    },
  ],
  graph: {
    nodes: [
      { id: 'produce', type: 'agent', title: '产出初稿', agentMember: 'producer', deliverable: '初稿', dependsOn: [] },
      {
        id: 'critic',
        type: 'gate',
        title: '批判验收',
        successCriteria: '批判性审查：找逻辑谬误/反例；经得起批判且含修订痕迹才通过',
        upstreamNodeId: 'produce',
        assertions: [{ kind: 'regex', value: '(修订|回应|反驳|完善)' }],
        dependsOn: ['produce'],
      },
    ],
  },
  acceptanceCriteria: '产出经得起批判且含修订痕迹',
});

describe('collaborations: mode-aware decomposition prompt (TC5-TC8)', () => {
  test('TC5 — orchestrator-worker (default) prompt equals legacy prompt', () => {
    const a = buildDecompositionPromptByMode({ ...baseInput, mode: 'orchestrator-worker' });
    const b = buildDecompositionPrompt(baseInput);
    expect(a).toBe(b);
  });

  test('TC5 — missing mode falls back to legacy prompt', () => {
    const a = buildDecompositionPromptByMode(baseInput);
    expect(a).toBe(buildDecompositionPrompt(baseInput));
  });

  test('TC6 — peer prompt instructs parallel + write-file', () => {
    const p = buildDecompositionPromptByMode({
      ...baseInput,
      mode: 'peer',
      collaborationId: 'c1',
    });
    expect(p).toContain('对等');
    expect(p).toContain('dependsOn 必须为空数组');
    expect(p).toContain('collaborations/c1/peer');
    expect(p).toMatch(/test -f/);
  });

  test('TC7 — critic prompt instructs adversarial gate', () => {
    const p = buildDecompositionPromptByMode({
      ...baseInput,
      mode: 'critic-adversarial',
    });
    expect(p).toContain('批判');
    expect(p).toContain('upstreamNodeId = producer');
    expect(p).toMatch(/adversarial|批判/);
    expect(p).toContain('assertions');
  });

  test('TC8 — scenario presets exist with correct recommended modes', () => {
    expect(SCENARIO_PRESETS['software-engineering'].recommendedMode).toBe('orchestrator-worker');
    expect(SCENARIO_PRESETS['brainstorm'].recommendedMode).toBe('peer');
    expect(SCENARIO_PRESETS['philosophy-critique'].recommendedMode).toBe('critic-adversarial');
    for (const k of Object.keys(SCENARIO_PRESETS)) {
      expect(SCENARIO_PRESETS[k].goalText.length).toBeGreaterThan(10);
      expect(SCENARIO_PRESETS[k].acceptanceCriteria.length).toBeGreaterThan(5);
    }
  });
});

describe('collaborations: applyScenario (TC8)', () => {
  test('empty goal/criteria filled from preset', () => {
    const out = applyScenario({
      goalText: '',
      mode: 'peer' as const,
      scenario: 'brainstorm',
      ownerUserId: 'u1',
      groupFolder: 'main',
      chatJid: 'feishu:t1',
      collaborationId: 'c1',
    });
    expect(out.goalText).toBe(SCENARIO_PRESETS['brainstorm'].goalText);
    expect(out.acceptanceCriteria).toBe(SCENARIO_PRESETS['brainstorm'].acceptanceCriteria);
    expect(out.mode).toBe('peer');
  });

  test('user-supplied goal takes precedence over preset', () => {
    const out = applyScenario({
      goalText: '我的自定义目标',
      mode: 'peer' as const,
      scenario: 'brainstorm',
      ownerUserId: 'u1',
      groupFolder: 'main',
      chatJid: 'feishu:t1',
      collaborationId: 'c1',
    });
    expect(out.goalText).toBe('我的自定义目标');
  });

  test('unknown scenario → no-op', () => {
    const out = applyScenario({
      goalText: 'G',
      mode: 'peer' as const,
      scenario: 'nope',
      ownerUserId: 'u1',
      groupFolder: 'main',
      chatJid: 'feishu:t1',
      collaborationId: 'c1',
    });
    expect(out.goalText).toBe('G');
  });

  test('missing scenario → no-op', () => {
    const out = applyScenario({
      goalText: 'G',
      mode: 'peer' as const,
      ownerUserId: 'u1',
      groupFolder: 'main',
      chatJid: 'feishu:t1',
      collaborationId: 'c1',
    } as Parameters<typeof applyScenario>[0]);
    expect(out.goalText).toBe('G');
  });
});

describe('collaborations: mode-aware fallback plan (TC9-TC10 prep)', () => {
  test('peer fallback → 2 parallel agents + gate shellCheck', () => {
    const p = buildFallbackPlan({ ...baseInput, mode: 'peer', collaborationId: 'c1' });
    const agents = p.graph.nodes.filter((n) => n.type === 'agent');
    const gates = p.graph.nodes.filter((n) => n.type === 'gate');
    expect(agents.length).toBe(2);
    expect(agents.every((a) => (a.dependsOn ?? []).length === 0)).toBe(true);
    expect(gates.length).toBe(1);
    expect(gates[0].shellCheck).toMatch(/test -f/);
    expect(gates[0].dependsOn).toContain(agents[0].id);
    expect(gates[0].dependsOn).toContain(agents[1].id);
    expect(validatePlanIntegrity(p as never)).toBe(true);
  });

  test('critic fallback → producer + adversarial critic gate', () => {
    const p = buildFallbackPlan({ ...baseInput, mode: 'critic-adversarial' });
    const agents = p.graph.nodes.filter((n) => n.type === 'agent');
    const gates = p.graph.nodes.filter((n) => n.type === 'gate');
    expect(agents.length).toBe(1);
    expect(gates.length).toBe(1);
    expect(gates[0].upstreamNodeId).toBe(agents[0].id);
    expect(gates[0].assertions?.length).toBeGreaterThan(0);
    expect(validatePlanIntegrity(p as never)).toBe(true);
  });

  test('orchestrator-worker fallback → legacy single-agent plan', () => {
    const p = buildFallbackPlan({ ...baseInput, mode: 'orchestrator-worker' });
    expect(p.graph.nodes.filter((n) => n.type === 'agent').length).toBe(1);
    expect(p.graph.nodes.filter((n) => n.type === 'gate').length).toBe(1);
  });
});

describe('collaborations: mode topology assembly (TC9-TC11)', () => {
  test('TC9 — peer topology: parallel agents + gate dependsOn all', () => {
    const plan = parseTeamPlan(peerPlanJson)!;
    expect(plan).not.toBeNull();
    expect(validatePlanIntegrity(plan)).toBe(true);
    const def = assembleGraphDefinition(plan, { visionary: 'ad1', pragmatist: 'ad2' }, {
      ...baseInput,
      mode: 'peer',
      collaborationId: 'c1',
    });
    const agentNodes = def.nodes.filter((n) => n.type === 'agent');
    const gateNodes = def.nodes.filter((n) => n.type === 'gate');
    expect(agentNodes.length).toBe(2);
    // all agent nodes have NO incoming data edges (parallel)
    for (const an of agentNodes) {
      const incoming = def.edges.filter((e) => e.to === an.id);
      expect(incoming.length).toBe(0);
    }
    // gate depends on both agents (2 incoming edges)
    const gate = gateNodes.find((g) => g.upstreamNodeId !== undefined)!;
    const gateIncoming = def.edges.filter((e) => e.to === gate.id);
    expect(gateIncoming.length).toBe(2);
    expect(gate.shellCheck).toMatch(/test -f/);
  });

  test('TC10 — critic topology: producer → critic gate with upstreamNodeId + assertions', () => {
    const plan = parseTeamPlan(criticPlanJson)!;
    expect(plan).not.toBeNull();
    expect(validatePlanIntegrity(plan)).toBe(true);
    const def = assembleGraphDefinition(plan, { producer: 'ad1' }, {
      ...baseInput,
      mode: 'critic-adversarial',
    });
    const producer = def.nodes.find((n) => n.type === 'agent')!;
    const critic = def.nodes.find((n) => n.type === 'gate' && n.upstreamNodeId === producer.id)!;
    expect(critic).toBeDefined();
    expect(critic.assertions?.length).toBeGreaterThan(0);
    // critic gate depends on producer (edge producer→critic)
    expect(def.edges.some((e) => e.from === producer.id && e.to === critic.id)).toBe(true);
  });

  test('TC11 — orchestrator-worker topology: serial chain + acceptance gate (backward compat)', () => {
    const serialPlanJson = JSON.stringify({
      teamName: 'ow',
      members: [
        { name: 'a', role: '调研', systemPrompt: '你是一名调研员，负责调研并产出报告。', engine: 'claude', model: null, skills: [], mcpServers: [], maxTurns: 15, deliverable: '调研' },
        { name: 'b', role: '实现', systemPrompt: '你是一名实现者，负责编码实现。', engine: 'claude', model: null, skills: [], mcpServers: [], maxTurns: 25, deliverable: '实现' },
      ],
      graph: {
        nodes: [
          { id: 'n1', type: 'agent', title: '调研', agentMember: 'a', deliverable: '调研', dependsOn: [] },
          { id: 'n2', type: 'agent', title: '实现', agentMember: 'b', deliverable: '实现', dependsOn: ['n1'] },
          { id: 'accept', type: 'gate', title: '验收', successCriteria: '测试通过', upstreamNodeId: 'n2', assertions: [{ kind: 'contains', value: '通过' }], dependsOn: ['n2'] },
        ],
      },
      acceptanceCriteria: '测试通过',
    });
    const plan = parseTeamPlan(serialPlanJson)!;
    const def = assembleGraphDefinition(plan, { a: 'ad1', b: 'ad2' }, baseInput);
    expect(def.nodes.length).toBe(3);
    expect(def.edges.some((e) => e.from === 'n1' && e.to === 'n2')).toBe(true);
    expect(def.edges.some((e) => e.from === 'n2' && e.to === 'accept')).toBe(true);
  });

  test('peer/critic plans pass validateDefinition cycle check (no cycles)', () => {
    for (const j of [peerPlanJson, criticPlanJson]) {
      const plan = parseTeamPlan(j)!;
      expect(validatePlanIntegrity(plan)).toBe(true);
    }
  });
});
