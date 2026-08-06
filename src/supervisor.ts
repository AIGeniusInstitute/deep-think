import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { logger } from './logger.js';
import { isSupervisorEnabled, isAutonomousEnabled } from './supervisor-config.js';

const SUPERVISOR_TIMEOUT_MS = 60_000;

export interface SupervisorDecision {
  action: 'clarify' | 'delegate' | 'auto' | 'delegate_team' | 'accept' | 'retry';
  instruction?: string;
  question?: string;
  reason?: string;
}

export interface SupervisorRunOpts {
  /** 全托管模式：禁用 clarify，缺失信息按合理假设推进。 */
  autonomous?: boolean;
}

/**
 * Ask the Supervisor SubAgent to decide how to handle a user message.
 * Returns the decision or null if the call fails.
 *
 * The Supervisor is a lightweight intent parser — it does NOT call tools.
 * It outputs strict JSON deciding: clarify (ask user), delegate (forward
 * original), auto (rewrite instruction), or delegate_team (complex task →
 * autonomously decompose + build an Agent Team).
 *
 * In autonomous mode, clarify is forbidden — the prompt restricts the
 * allowed actions to {delegate, auto, delegate_team} and parseDecision
 * auto-downgrades any LLM-returned clarify to delegate so the user is
 * never prompted mid-task.
 */
export async function runSupervisorPreDispatch(
  userMessage: string,
  userLanguage: string,
  opts?: SupervisorRunOpts,
): Promise<SupervisorDecision | null> {
  const autonomousDirective = opts?.autonomous
    ? [
        '【全托管模式】',
        '- **禁止 clarify**：本任务目标已明确，不允许向用户提问。',
        '- 缺失信息请按合理假设推进，并在 instruction 中说明你的假设。',
        '- action 只能是 delegate / auto / delegate_team 三选一。',
      ].join('\n')
    : '';

  const actionDocs = opts?.autonomous
    ? ['- 注意：当前为全托管模式，clarify 已被禁用。即便你认为目标模糊，也必须选 delegate 并按合理假设推进。']
    : [
        '- clarify: 消息模糊，向用户提问。question 字段必填。',
        '- delegate: 意图清晰，原样转发。instruction 字段填原消息精简版。',
        '- auto: 意图清晰但可优化表达，instruction 字段填你重写的指令。',
        '- delegate_team: 任务复杂、需要多角色协作（如需调研+实现+评审+验收、跨多个交付物、需要自主拆解组建团队）。instruction 字段填任务目标描述（将作为 Team Builder 的 goalText）。',
      ];

  const prompt = [
    '用户将以下任务托管给你（Supervisor）。请判断如何处理。',
    '',
    `用户语言：${userLanguage}`,
    '',
    autonomousDirective,
    '',
    '【用户消息】',
    userMessage.slice(0, 4000),
    '',
    '请输出严格 JSON（不要 markdown 代码块）：',
    '{"action":"clarify"|"delegate"|"auto"|"delegate_team","instruction"?:string,"question"?:string}',
    ...actionDocs,
  ].filter(Boolean).join('\n');

  try {
    const raw = await sdkQuery({
      prompt,
      options: {
        model: process.env.SUPERVISOR_MODEL || undefined,
        maxTurns: 1,
        systemPrompt: '',
      },
    });
    const text = typeof raw === 'string' ? raw : (raw as any)?.text ?? '';
    return parseDecision(text, opts);
  } catch (err) {
    logger.error({ err }, 'Supervisor pre-dispatch failed');
    return null;
  }
}

export function parseDecision(
  raw: string,
  opts?: SupervisorRunOpts,
): SupervisorDecision | null {
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*$/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    let action = parsed.action as SupervisorDecision['action'];
    if (
      action !== 'clarify' &&
      action !== 'delegate' &&
      action !== 'auto' &&
      action !== 'delegate_team'
    ) {
      return null;
    }
    // Autonomous mode: clarify is forbidden. Downgrade to delegate so the
    // user is never prompted mid-task. The agent will receive the original
    // message and proceed with its own best-judgment assumptions.
    if (action === 'clarify' && opts?.autonomous) {
      logger.warn(
        { question: parsed.question },
        'Supervisor returned clarify in autonomous mode, downgrading to delegate',
      );
      action = 'delegate';
      return {
        action,
        instruction: parsed.instruction
          ? String(parsed.instruction).slice(0, 4000)
          : undefined,
        question: undefined,
        reason: 'autonomous_downgrade',
      };
    }
    return {
      action,
      instruction: parsed.instruction ? String(parsed.instruction).slice(0, 4000) : undefined,
      question: parsed.question ? String(parsed.question).slice(0, 2000) : undefined,
    };
  } catch {
    return null;
  }
}

export async function isChatSupervisorEnabled(chatJid: string): Promise<boolean> {
  return isSupervisorEnabled(chatJid);
}

export async function isChatAutonomousEnabled(chatJid: string): Promise<boolean> {
  return isAutonomousEnabled(chatJid);
}

export { SUPERVISOR_TIMEOUT_MS };
