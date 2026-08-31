/**
 * /skill IM command handler — runs a registered Skill in real execution mode
 * from an IM chat. Extracted into a standalone module so it is unit-testable
 * (src/index.ts is a side-effectful boot module and cannot be imported in tests).
 *
 * Form: `/skill <skillId> <input...>`
 *
 * Owner gate is applied upstream (the command is in OWNER_REQUIRED_IM_COMMANDS,
 * so ownerCheck runs before this handler). sender→userId resolution: a verified
 * owner's DeepThink account is `group.created_by` — no global findUserByIm
 * needed because within a group the owner is unambiguous.
 */
import type { RegisteredGroup } from './types.js';
import { getSkillDetail } from './routes/skills.js';
import { debugSkill } from './skill-ai.js';

const SKILL_COOLDOWN_MS = 10_000;
const IM_REPLY_MAX = 4000;
const skillCooldowns = new Map<string, number>();

export interface SkillImCommandDeps {
  getSkillDetail: typeof getSkillDetail;
  debugSkill: typeof debugSkill;
}

/** Default deps bound to the real implementations. Overridable in tests. */
const DEFAULT_DEPS: SkillImCommandDeps = { getSkillDetail, debugSkill };

export async function handleSkillImCommand(
  chatJid: string,
  rawArgs: string,
  group: Pick<RegisteredGroup, 'created_by'> | null | undefined,
  deps: SkillImCommandDeps = DEFAULT_DEPS,
): Promise<string> {
  const sp = rawArgs.split(/\s+/);
  const skillId = sp[0] ?? '';
  const testInput = rawArgs.slice(skillId.length).trim();
  if (!skillId || !testInput) {
    return '用法：/skill <skillId> <输入内容>\n例：/skill code-review 请审查这段代码 …';
  }

  const now = Date.now();
  const last = skillCooldowns.get(chatJid) || 0;
  if (now - last < SKILL_COOLDOWN_MS) {
    return '⏳ 请稍后再试（冷却中）';
  }
  skillCooldowns.set(chatJid, now);

  const userId = group?.created_by;
  if (!userId) {
    return '⚠️ 该工作区未关联 DeepThink 账号，无法调用 Skill';
  }

  const skill = deps.getSkillDetail(skillId, userId);
  if (!skill) {
    return `⚠️ 未找到 Skill：${skillId}`;
  }
  if (!skill.enabled) {
    return `⚠️ Skill 已禁用：${skillId}`;
  }

  const result = await deps.debugSkill(skill.content, testInput, 'real', {
    chatJid,
    label: `Skill: ${skillId}`,
  });
  if ('error' in result) {
    return `⚠️ ${result.error}`;
  }
  const out = result.output;
  return out.length > IM_REPLY_MAX ? out.slice(0, IM_REPLY_MAX) + '\n…（已截断）' : out;
}
