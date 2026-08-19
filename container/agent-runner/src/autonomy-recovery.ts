/**
 * Autonomy Recovery Engine — converts the 4 terminal hard brakes
 * (destructive_command / turn_limit / token_limit / loop_detected) in
 * `index.ts` autonomous mode from `process.exit(1)` into recoverable
 * brakes: on hit, inject a strategy-change prompt and continue the main
 * loop (mirroring the existing auto-continue path). Only after
 * MAX_RECOVERY_ATTEMPTS consecutive unrecovered hits of the same brake
 * type does the brake become terminal (true unrecoverable).
 *
 * Design principle (Surgical Changes): this module is self-contained and
 * side-effect free; the main loop calls `request()` and acts on the result.
 * It does not touch the existing autonomy bus / metrics / learning layer.
 */

export type BrakeType =
  | 'destructive_command'
  | 'turn_limit'
  | 'token_limit'
  | 'loop_detected';

export interface RecoveryContext {
  destructiveCmd?: string;
  turnCount: number;
  maxTurns: number;
  totalTokens: number;
  maxTokens: number;
  goalSnippet?: string;
}

export interface RecoveryResult {
  /** true → unrecoverable, main loop must run the original exit(1) path. */
  terminal: boolean;
  /** recovery prompt to inject (absent when terminal). */
  prompt?: string;
  /** short strategy label, surfaced in the recovering event. */
  strategy?: string;
  /** 1-based recovery attempt count for this brake type. */
  attempt?: number;
  /** turn_limit recovery: new (raised) maxTurns tier. */
  newMaxTurns?: number;
  /** token_limit / turn_limit recovery: ask the loop to compact context first. */
  requireCompaction?: boolean;
  /** loop_detected recovery: clear the output-hash window. */
  clearHashWindow?: boolean;
  /** destructive recovery: clear the per-turn destructive signal so the next
   *  turn does not re-brake on the same (already-intercepted) command. */
  clearDestructiveSignal?: boolean;
}

export const MAX_RECOVERY_ATTEMPTS = 3;

/** Turn-budget raise ladder; 200 is the hard ceiling. */
const TURN_BUDGET_STEPS = [50, 100, 150, 200];
const TURN_HARD_CEILING = 200;

/**
 * Per-session recovery state. Lives in-memory for the lifetime of one
 * agent-runner process (one autonomous run). Counts attempts per brake
 * type independently, and decays counts after 2 consecutive successful
 * turns so that a single early mishap does not permanently erode the
 * recovery budget for the whole run.
 */
export class RecoveryState {
  private attempts: Record<BrakeType, number> = {
    destructive_command: 0,
    turn_limit: 0,
    token_limit: 0,
    loop_detected: 0,
  };
  private sinceLastBrake: Record<BrakeType, number> = {
    destructive_command: 0,
    turn_limit: 0,
    token_limit: 0,
    loop_detected: 0,
  };

  request(brake: BrakeType, ctx: RecoveryContext): RecoveryResult {
    const attempt = ++this.attempts[brake];
    if (attempt > MAX_RECOVERY_ATTEMPTS) {
      return { terminal: true };
    }
    this.sinceLastBrake[brake] = 0;
    return buildRecovery(brake, ctx, attempt);
  }

  /**
   * Called by the main loop at the end of a turn in which no brake fired
   * (i.e. the turn productively advanced). Decays stale attempt counts so
   * the budget recovers as the run stabilises.
   */
  tickSuccess(): void {
    (Object.keys(this.attempts) as BrakeType[]).forEach((b) => {
      this.sinceLastBrake[b]++;
      if (this.sinceLastBrake[b] >= 2 && this.attempts[b] > 0) {
        this.attempts[b] = Math.max(0, this.attempts[b] - 1);
        this.sinceLastBrake[b] = 0;
      }
    });
  }

  /** Test-only accessor. */
  getAttempts(brake: BrakeType): number {
    return this.attempts[brake];
  }
}

function buildRecovery(
  brake: BrakeType,
  ctx: RecoveryContext,
  attempt: number,
): RecoveryResult {
  switch (brake) {
    case 'destructive_command':
      return {
        terminal: false,
        attempt,
        strategy: 'safe_alternative',
        clearDestructiveSignal: true,
        prompt: [
          '【系统提示：恢复指令】',
          `你刚才拟执行的命令被安全规则拦截：${(ctx.destructiveCmd || '').slice(0, 200)}`,
          '请改用安全等价方案，禁止重放原命令：',
          '- rm -rf / → 限定到具体子路径，或用 mv 移到 /tmp，或用 trash 工具',
          '- git push --force → 改用普通 git push，或新建分支后再推送',
          '- git reset --hard → 用 git restore 指定文件，或先 git stash',
          '- DROP/TRUNCATE TABLE → 改用 DELETE 带条件，或先备份再操作',
          '- mkfs / dd to device → 不可安全替代，停止该路径，换任务入口',
          '选定安全方案后继续推进任务目标，不要重复提问。',
        ].join('\n'),
      };

    case 'turn_limit': {
      const idx = TURN_BUDGET_STEPS.indexOf(ctx.maxTurns);
      const nextMax =
        idx >= 0 && idx < TURN_BUDGET_STEPS.length - 1
          ? TURN_BUDGET_STEPS[idx + 1]
          : ctx.maxTurns >= TURN_HARD_CEILING
            ? -1
            : TURN_HARD_CEILING;
      if (nextMax < 0) return { terminal: true };
      return {
        terminal: false,
        attempt,
        strategy: 'checkpoint_compact_resume',
        newMaxTurns: nextMax,
        requireCompaction: true,
        prompt: [
          '【系统提示：恢复指令】',
          `已执行 ${ctx.turnCount} 轮，触达轮次预算 ${ctx.maxTurns}。已为你检查点存档并凝结上下文。`,
          `轮次预算提升至 ${nextMax}。请基于凝结后的进度摘要继续推进：`,
          '- 不要重复已完成的步骤；',
          '- 聚焦未完成子任务；',
          '- 若已全部完成，输出最终交付物并停止。',
          `任务目标：${(ctx.goalSnippet || '').slice(0, 300)}`,
        ].join('\n'),
      };
    }

    case 'token_limit':
      return {
        terminal: false,
        attempt,
        strategy: 'force_compact_resume',
        requireCompaction: true,
        prompt: [
          '【系统提示：恢复指令】',
          '上下文 token 触达上限，已强制凝结。请基于凝结后的进度摘要继续推进任务：',
          '- 不要重复已完成步骤；',
          '- 聚焦未完成子任务；',
          `- 任务目标：${(ctx.goalSnippet || '').slice(0, 300)}`,
        ].join('\n'),
      };

    case 'loop_detected':
      return {
        terminal: false,
        attempt,
        strategy: 'reflect_and_pivot',
        clearHashWindow: true,
        prompt: [
          '【系统提示：恢复指令】',
          '你已连续 3 轮产出相同结果，陷入循环。请先明确反思当前策略为何无法推进，然后改用不同方法：',
          '- 换工具：用 web_search 查资料 / sandbox_run_code 验证 / 浏览器抓取；',
          '- 换路径：拆解为更小子任务、从另一入口切入；',
          '- 查经验：memory_search 检索过往相似任务。',
          '反思后必须产出与之前不同的行动，禁止重放上一轮的做法。',
        ].join('\n'),
      };
  }
}
