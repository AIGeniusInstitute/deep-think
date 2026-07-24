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
