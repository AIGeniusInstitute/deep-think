/**
 * Super Agent Team — LLM prompt templates.
 *
 * buildDecompositionPrompt: the single-turn prompt fed to sdkQuery to
 *   decompose a complex task into a TeamPlan JSON.
 * buildGoalAnchor: the per-agent-node goal re-anchoring text prepended to
 *   every agent prompt so the original goal is never forgotten (PRD AC2.3).
 */

import type { TeamTaskInput, TeamMember, TeamGraphNode } from './team-plan.js';

/**
 * Build the decomposition prompt. The LLM is asked to act as a Team Lead and
 * output strict JSON matching TeamPlanSchema. No tools, single turn.
 */
export function buildDecompositionPrompt(input: TeamTaskInput): string {
  const lang = input.userLanguage ?? 'zh-CN';
  return [
    '你是一个资深的技术团队组织者（Team Lead）。请把下面的复杂任务拆解为一个 Agent 团队计划，',
    '复刻人类科研/工程团队的分工：调研、实现、评审、验收各司其职。',
    '',
    '【任务目标】',
    input.goalText,
    '',
    '【背景】',
    input.background?.trim() || '（无额外背景）',
    '',
    '【验收标准】',
    input.acceptanceCriteria?.trim() || '（根据任务目标自行推导可客观验证的验收标准）',
    '',
    '【输出要求】严格输出一个 JSON 对象（不要 markdown 代码块，不要前后文字，不要在 JSON 内写注释）。',
    '字段说明：',
    '- teamName: slug（仅 a-z0-9_-）',
    '- members[]: 每个成员 name(slug) / role(角色) / systemPrompt(≥10字，自主设计角色与能力边界) / engine(可选 claude atomcode codex opencode，默认 claude) / model(null=继承全局，或具体 id) / skills[](skill id，可空) / mcpServers[](mcp id，可空) / maxTurns(数字) / deliverable(交付物)',
    '- graph.nodes[]: 每个节点 id(slug) / type(agent 或 gate) / title / dependsOn[](依赖节点 id，可空) ；agent 节点必填 agentMember(引用 members[].name) 与 deliverable；gate 节点可填 successCriteria / assertions / shellCheck / upstreamNodeId',
    '- assertions: 行为证据断言数组，每项 {"kind":"contains或not_contains或regex或no_error","value":"关键词或正则"}',
    '- shellCheck: 可选，行为证据 shell 命令（退出码 0=通过）',
    '- acceptanceCriteria: 团队最终验收标准（从用户输入继承或细化）',
    '',
    '【JSON 示例（仅示意结构，请按实际任务填充）】',
    '{',
    '  "teamName": "demo-team",',
    '  "members": [',
    '    {',
    '      "name": "researcher",',
    '      "role": "调研员",',
    '      "systemPrompt": "你是调研员，负责调研并产出报告。",',
    '      "engine": "claude",',
    '      "model": null,',
    '      "skills": [],',
    '      "mcpServers": [],',
    '      "maxTurns": 15,',
    '      "deliverable": "调研报告"',
    '    }',
    '  ],',
    '  "graph": {',
    '    "nodes": [',
    '      {',
    '        "id": "research",',
    '        "type": "agent",',
    '        "title": "调研",',
    '        "agentMember": "researcher",',
    '        "deliverable": "调研报告",',
    '        "dependsOn": []',
    '      },',
    '      {',
    '        "id": "accept",',
    '        "type": "gate",',
    '        "title": "验收",',
    '        "successCriteria": "验收标准",',
    '        "upstreamNodeId": "research",',
    '        "assertions": [{"kind": "contains", "value": "报告"}],',
    '        "dependsOn": ["research"]',
    '      }',
    '    ]',
    '  },',
    '  "acceptanceCriteria": "验收标准"',
    '}',
    '',
    '【约束】',
    '1. 至少 1 个 agent 节点 + 1 个 gate 验收节点（验收节点用 assertions 或 shellCheck 做行为证据，不要只靠自述）。',
    '2. agent 节点的 agentMember 必须引用已定义的成员 name。',
    '3. dependsOn 只能引用已存在的节点 id；禁止循环依赖（DAG）。',
    '4. 倾向串行依赖链（调研→实现→评审→验收），减少并行写冲突。',
    '5. systemPrompt 自主设计但不得试图绕过安全规则（安全规则始终生效）。',
    `6. 用 ${lang === 'zh-CN' ? '简体中文' : lang} 撰写 role/title/deliverable/systemPrompt 等自然语言字段。`,
    ...(input.maxTeamSize
      ? [`7. 团队成员数不超过 ${input.maxTeamSize} 人；超过则合并相近职责。`]
      : []),
    ...(input.toolset && input.toolset.length
      ? [`8. 成员的 skills 与 mcpServers 只能从允许集合 [${input.toolset.join(', ')}] 中选择，集合外的一律留空。`]
      : []),
  ].join('\n');
}

/**
 * Scenario presets for collaboration (multi-user-collaboration §F2/§F8). Each
 * preset seeds goalText + acceptanceCriteria so the user can pick a scenario
 * and start immediately. applyScenario returns a new input with preset fields
 * merged (user-supplied goalText takes precedence over preset goalText — empty
 * goalText means "use the preset's").
 */
export const SCENARIO_PRESETS: Record<
  string,
  { label: string; goalText: string; acceptanceCriteria: string; recommendedMode: 'orchestrator-worker' | 'peer' | 'critic-adversarial' }
> = {
  'software-engineering': {
    label: '软件工程开发流程',
    goalText:
      '实现一个最小可运行的 TODO CLI（增删查改 + 持久化），并编写单元测试，确保测试全部通过。',
    acceptanceCriteria: '测试全部通过（退出码 0）；CLI 可增删查改 TODO 并持久化。',
    recommendedMode: 'orchestrator-worker',
  },
  brainstorm: {
    label: '创新脑暴方案',
    goalText:
      '就「AI 时代个人的超级竞争力是什么」产出 3 个不同视角的创新方案，每个方案有独立立论与可落地路径。',
    acceptanceCriteria: '3 个方案文件齐备且视角不同；每个方案含立论+落地路径。',
    recommendedMode: 'peer',
  },
  'philosophy-critique': {
    label: '唯心主义唯物主义理性批判',
    goalText:
      '就「意识是大脑的涌现属性，不存在独立的心物二元」产出论点并经对立批判者严格批判，最终产出一个经得起批判的修订论证。',
    acceptanceCriteria: '论证含修订痕迹（回应了批判/反驳了反例）；批判者未发现致命逻辑谬误。',
    recommendedMode: 'critic-adversarial',
  },
};

/**
 * Mode-aware decomposition prompt dispatcher (multi-user-collaboration).
 * - orchestrator-worker (default) → legacy buildDecompositionPrompt (zero change).
 * - peer → parallel-perspective prompt; members write deliverables to shared
 *   workspace files; terminal gate shellChecks file presence.
 * - critic-adversarial → producer + adversarial critic gate prompt; critic
 *   actively hunts flaws/counterexamples; failure re-runs producer with feedback.
 */
export function buildDecompositionPromptByMode(input: TeamTaskInput): string {
  const mode = input.mode ?? 'orchestrator-worker';
  if (mode === 'peer') return buildPeerDecompositionPrompt(input);
  if (mode === 'critic-adversarial') return buildCriticDecompositionPrompt(input);
  return buildDecompositionPrompt(input);
}

function buildPeerDecompositionPrompt(input: TeamTaskInput): string {
  const lang = input.userLanguage ?? 'zh-CN';
  const collabDir = input.collaborationId
    ? `collaborations/${input.collaborationId}/peer`
    : 'collaborations/peer';
  return [
    '你是一个对等协作组织者。请把下面的任务拆解为一个「对等并行」Agent 团队计划：',
    'N 个对等角色各自产出**不同视角**的方案，彼此无依赖、可并行；每个成员把完整方案写入指定文件，并在对话给出摘要。',
    '',
    '【任务目标】',
    input.goalText,
    '',
    '【背景】',
    input.background?.trim() || '（无额外背景）',
    '',
    '【验收标准】',
    input.acceptanceCriteria?.trim() || '（根据任务目标自行推导可客观验证的验收标准）',
    '',
    '【输出要求】严格输出一个 JSON 对象（不要 markdown 代码块，不要前后文字）。字段同 TeamPlan：',
    '- teamName: slug；members[]: name/role/systemPrompt/engine/model/skills/mcpServers/maxTurns/deliverable',
    '- graph.nodes[]: 每个对等 agent 节点 dependsOn 必须为空数组（并行）；agentMember 引用成员；',
    `  每个 agent 节点的 deliverable 字段写明「方案写入 ${collabDir}/<member-name>.md」`,
    '- 末尾一个 gate 验收节点：dependsOn 含全部 agent 节点 id；upstreamNodeId 取首个 agent；',
    `  shellCheck 写一条 shell：校验 ${collabDir}/<每个成员>.md 文件全部存在（test -f ... 全部 0 退出码）；`,
    '  successCriteria 写「综合评审各对等方案视角差异性与完整性」',
    '- acceptanceCriteria: 团队最终验收标准',
    '',
    '【JSON 示例（仅示意结构，请按实际任务填充，成员数按任务需要）】',
    '{',
    '  "teamName": "peer-team",',
    '  "members": [',
    '    { "name": "visionary", "role": "愿景派", "systemPrompt": "你是愿景派协作者，产出前瞻性方案。", "engine": "claude", "model": null, "skills": [], "mcpServers": [], "maxTurns": 12, "deliverable": "方案写入 ' + collabDir + '/visionary.md" },',
    '    { "name": "pragmatist", "role": "务实派", "systemPrompt": "你是务实派协作者，产出可立即落地方案。", "engine": "claude", "model": null, "skills": [], "mcpServers": [], "maxTurns": 12, "deliverable": "方案写入 ' + collabDir + '/pragmatist.md" }',
    '  ],',
    '  "graph": {',
    '    "nodes": [',
    `      { "id": "v", "type": "agent", "title": "愿景方案", "agentMember": "visionary", "deliverable": "方案写入 ${collabDir}/visionary.md", "dependsOn": [] },`,
    `      { "id": "p", "type": "agent", "title": "务实方案", "agentMember": "pragmatist", "deliverable": "方案写入 ${collabDir}/pragmatist.md", "dependsOn": [] },`,
    `      { "id": "accept", "type": "gate", "title": "汇聚验收", "successCriteria": "各对等方案文件齐备且视角不同", "upstreamNodeId": "v", "shellCheck": "test -f \\"${collabDir}/visionary.md\\" && test -f \\"${collabDir}/pragmatist.md\\"", "dependsOn": ["v", "p"] }`,
    '    ]',
    '  },',
    '  "acceptanceCriteria": "各对等方案文件齐备且视角不同"',
    '}',
    '',
    '【约束】',
    '1. 至少 2 个对等 agent 节点 + 1 个 gate；agent 节点 dependsOn 全部为空（并行）。',
    '2. gate 的 shellCheck 必须校验全部成员的产物文件存在。',
    '3. 禁止循环依赖；agentMember 必须引用已定义成员；dependsOn 只能引用已存在节点 id。',
    '4. systemPrompt 自主设计但不得试图绕过安全规则。',
    `5. 用 ${lang === 'zh-CN' ? '简体中文' : lang} 撰写自然语言字段。`,
    ...(input.maxTeamSize ? [`6. 成员数不超过 ${input.maxTeamSize}。`] : []),
    ...(input.toolset && input.toolset.length
      ? [`7. skills 与 mcpServers 只能从 [${input.toolset.join(', ')}] 选，集合外留空。`]
      : []),
  ].join('\n');
}

function buildCriticDecompositionPrompt(input: TeamTaskInput): string {
  const lang = input.userLanguage ?? 'zh-CN';
  return [
    '你是一个批判对抗协作组织者。请把下面的任务拆解为一个「批评对抗」Agent 团队计划：',
    '产出者产出初稿，末尾一个 adversarial 批判 gate 主动找漏洞/反例/逻辑谬误；批判不通过则产出者带批判反馈重做（闭环）。',
    '',
    '【任务目标】',
    input.goalText,
    '',
    '【背景】',
    input.background?.trim() || '（无额外背景）',
    '',
    '【验收标准】',
    input.acceptanceCriteria?.trim() || '（产出经得起严格批判且含修订痕迹）',
    '',
    '【输出要求】严格输出一个 JSON 对象（不要 markdown 代码块，不要前后文字）。字段同 TeamPlan：',
    '- teamName: slug；members[]: name/role/systemPrompt/engine/model/skills/mcpServers/maxTurns/deliverable',
    '- graph.nodes[]: 至少 1 个 producer agent 节点（dependsOn:[]）+ 1 个 critic gate 节点；',
    '  critic gate 的 upstreamNodeId = producer 节点 id；dependsOn: [producer 节点 id]；',
    '  critic gate 的 successCriteria 写「批判性审查：主动找产出的逻辑谬误/反例/未覆盖情形；只有经得起严格批判且含修订痕迹时通过」；',
    '  critic gate 的 assertions 用行为证据（如 regex 要求产出含「修订/回应/反驳」等修订痕迹，证明经批判后修订过）；',
    '  critic gate 可选 shellCheck（如产出是代码，可跑测试）',
    '- acceptanceCriteria: 团队最终验收标准',
    '',
    '【JSON 示例（仅示意结构，请按实际任务填充）】',
    '{',
    '  "teamName": "critic-team",',
    '  "members": [',
    '    { "name": "producer", "role": "产出者", "systemPrompt": "你是产出者，产出初稿；若被批判打回，根据批判反馈修订后重做。", "engine": "claude", "model": null, "skills": [], "mcpServers": [], "maxTurns": 20, "deliverable": "经批判修订的最终交付物" }',
    '  ],',
    '  "graph": {',
    '    "nodes": [',
    '      { "id": "produce", "type": "agent", "title": "产出初稿", "agentMember": "producer", "deliverable": "初稿", "dependsOn": [] },',
    '      { "id": "critic", "type": "gate", "title": "批判验收", "successCriteria": "批判性审查：找出逻辑谬误/反例/未覆盖情形；经得起批判且含修订痕迹才通过", "upstreamNodeId": "produce", "assertions": [{"kind":"regex","value":"(修订|回应|反驳|完善)"}], "dependsOn": ["produce"] }',
    '    ]',
    '  },',
    '  "acceptanceCriteria": "产出经得起批判且含修订痕迹"',
    '}',
    '',
    '【约束】',
    '1. 至少 1 个 producer agent + 1 个 critic gate；critic gate.upstreamNodeId = producer 节点 id。',
    '2. critic gate 必须有非空 assertions（行为证据），不要只靠自述。',
    '3. 禁止循环依赖；agentMember 必须引用已定义成员；dependsOn 只能引用已存在节点 id。',
    '4. systemPrompt 自主设计但不得试图绕过安全规则。',
    `5. 用 ${lang === 'zh-CN' ? '简体中文' : lang} 撰写自然语言字段。`,
    ...(input.maxTeamSize ? [`6. 成员数不超过 ${input.maxTeamSize}。`] : []),
  ].join('\n');
}

/**
 * Build the goal anchor prepended to every agent node's prompt so the original
 * goal + acceptance criteria + role + deliverable are re-anchored each turn.
 * (PRD AC2.3 — fixes "forget the original goal".)
 */
export function buildGoalAnchor(
  input: TeamTaskInput,
  member: TeamMember,
  node: TeamGraphNode,
): string {
  return [
    '【团队目标】',
    input.goalText,
    '',
    '【团队验收标准】',
    input.acceptanceCriteria?.trim() || input.goalText,
    '',
    '【你的角色】',
    `${member.role}（${member.name}）`,
    '',
    '【你的交付物】',
    node.deliverable || member.deliverable || '按角色职责产出',
    '',
    '【提醒】始终对齐团队目标与验收标准，完成交付物后再结束。不要提前宣布完成。',
  ].join('\n');
}

/**
 * Fallback single-agent plan when the LLM decomposition fails twice. Produces
 * a minimal valid TeamPlan: one agent + one LLM-only gate. Lets the user still
 * get a runnable team even when decomposition is malformed (PRD §6 risk).
 *
 * Mode-aware (multi-user-collaboration): peer → 2 parallel agents + gate;
 * critic-adversarial → producer + adversarial critic gate; otherwise the legacy
 * single-agent serial plan.
 */
export function buildFallbackPlan(input: TeamTaskInput): {
  teamName: string;
  members: TeamMember[];
  graph: { nodes: TeamGraphNode[] };
  acceptanceCriteria: string;
} {
  const slug = input.goalText
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20) || 'team';
  const mode = input.mode ?? 'orchestrator-worker';
  const collabDir = input.collaborationId
    ? `collaborations/${input.collaborationId}/peer`
    : 'collaborations/peer';

  if (mode === 'peer') {
    return {
      teamName: `fallback-peer-${slug}`,
      members: [
        {
          name: 'peer-a',
          role: '对等方案A（回退方案）',
          systemPrompt: `你是一个对等协作者。任务目标：${input.goalText}。产出一个独立视角的方案并写入文件 ${collabDir}/peer-a.md，给出摘要。`,
          engine: 'claude',
          model: null,
          skills: [],
          mcpServers: [],
          maxTurns: 15,
          deliverable: '对等方案A',
        },
        {
          name: 'peer-b',
          role: '对等方案B（回退方案）',
          systemPrompt: `你是一个对等协作者。任务目标：${input.goalText}。产出一个与 A 不同视角的方案并写入文件 ${collabDir}/peer-b.md，给出摘要。`,
          engine: 'claude',
          model: null,
          skills: [],
          mcpServers: [],
          maxTurns: 15,
          deliverable: '对等方案B',
        },
      ],
      graph: {
        nodes: [
          { id: 'a', type: 'agent', title: '对等方案A', agentMember: 'peer-a', deliverable: '对等方案A', dependsOn: [] },
          { id: 'b', type: 'agent', title: '对等方案B', agentMember: 'peer-b', deliverable: '对等方案B', dependsOn: [] },
          {
            id: 'accept',
            type: 'gate',
            title: '汇聚验收',
            successCriteria: '两个对等方案文件齐备且视角不同',
            upstreamNodeId: 'a',
            shellCheck: `test -f "${collabDir}/peer-a.md" && test -f "${collabDir}/peer-b.md"`,
            dependsOn: ['a', 'b'],
          },
        ],
      },
      acceptanceCriteria: input.acceptanceCriteria || input.goalText,
    };
  }

  if (mode === 'critic-adversarial') {
    return {
      teamName: `fallback-critic-${slug}`,
      members: [
        {
          name: 'producer',
          role: '产出者（回退方案）',
          systemPrompt: `你是产出者。任务目标：${input.goalText}。产出初稿；若被批判打回，根据批判反馈修订后重做。`,
          engine: 'claude',
          model: null,
          skills: [],
          mcpServers: [],
          maxTurns: 20,
          deliverable: '最终交付物（经批判修订）',
        },
      ],
      graph: {
        nodes: [
          { id: 'produce', type: 'agent', title: '产出初稿', agentMember: 'producer', deliverable: '初稿', dependsOn: [] },
          {
            id: 'critic',
            type: 'gate',
            title: '批判验收',
            successCriteria: '批判性审查：找出产出的逻辑谬误/反例/未覆盖情形；只有当产出经得起严格批判且含修订痕迹时通过',
            upstreamNodeId: 'produce',
            assertions: [{ kind: 'regex', value: '(修订|回应|反驳|完善)' }],
            dependsOn: ['produce'],
          },
        ],
      },
      acceptanceCriteria: input.acceptanceCriteria || input.goalText,
    };
  }

  return {
    teamName: `fallback-${slug}`,
    members: [
      {
        name: 'solo',
        role: '独立执行者（回退方案）',
        systemPrompt: `你是一个独立执行者。任务目标：${input.goalText}。自主完成全部工作并产出最终交付物。`,
        engine: 'claude',
        model: null,
        skills: [],
        mcpServers: [],
        maxTurns: 20,
        deliverable: '完整任务交付物',
      },
    ],
    graph: {
      nodes: [
        {
          id: 'work',
          type: 'agent',
          title: '执行任务',
          agentMember: 'solo',
          deliverable: '完整任务交付物',
          dependsOn: [],
        },
        {
          id: 'accept',
          type: 'gate',
          title: '验收',
          successCriteria: input.acceptanceCriteria || '任务目标达成',
          upstreamNodeId: 'work',
          dependsOn: ['work'],
        },
      ],
    },
    acceptanceCriteria: input.acceptanceCriteria || input.goalText,
  };
}
