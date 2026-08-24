/**
 * Super Agent Team slash command — /team <task description>.
 *
 * Mirrors graph-commands.ts handleGraphStartCommand. Resolves the chat context
 * (owner/folder/chatJid) + loopDeps (structurally identical to GraphDeps — same
 * registeredGroups/getSessions/onProcess/broadcastStreamEvent/
 * storeResultAndNotify shape), then calls buildTeam which autonomously
 * decomposes the task, creates agent members, assembles a graph, and starts a
 * run in the background.
 */

import { buildTeam } from './team-builder.js';
import { toMermaid } from '../graph-engineering/graph-registry.js';
import { getGraphRun } from '../db.js';
import type { LoopCommandDeps } from '../loop-commands.js';

/**
 * /team <task> — autonomously build an Agent Team for the task. The team
 * decomposes + assembles + starts a graph run in the background; the command
 * returns immediately with the run id + team plan preview.
 */
export async function handleTeamStartCommand(
  args: string,
  deps: LoopCommandDeps,
): Promise<string> {
  const goalText = args.trim();
  if (!goalText) {
    return '用法：/team <任务描述>\n示例：/team 调研X并实现Y原型并写测试\n\nDeepThink 会自主拆解任务、组建 Agent 团队（自主设计角色/System Prompt/工具），用 DAG 任务图可视化执行，节点内步骤 + 工具调用全 trace 可回溯。';
  }

  const result = await buildTeam(
    {
      goalText,
      ownerUserId: deps.ownerUserId,
      groupFolder: deps.groupFolder,
      chatJid: deps.chatJid,
    },
    deps.loopDeps as unknown as Parameters<typeof buildTeam>[1],
  );

  if ('error' in result) {
    return `❌ 团队组建失败：${result.error}${result.detail ? `\n详情：${result.detail}` : ''}`;
  }

  const { runId, plan } = result;
  // /team command never sets draft:true, so runId is always present here.
  const run = getGraphRun(runId!);
  const memberLines = (plan.members as Array<{ name: string; role: string }>)
    .map((m) => `  • ${m.name} — ${m.role}`)
    .join('\n');
  return [
    `🤝 已组建 Agent 团队并启动`,
    ``,
    `团队：${plan.teamName}`,
    `运行 ID：${runId}${run ? `（${plan.members.length} 成员 / ${plan.graph.nodes.length} 节点）` : ''}`,
    ``,
    `成员：`,
    memberLines,
    ``,
    `在 Web → Graph 执行 页查看 DAG 实时可视化、节点内子图 trace、中断/续跑/重跑。`,
  ].join('\n');
}

// Re-export so callers can preview the graph mermaid if needed.
export { toMermaid };
