/**
 * F4: Shared lesson-reinjection helper (continual-learning 近似).
 *
 * Prepends relevant autonomy_lessons to a task prompt so past run experience
 * influences downstream execution (team decomposition / loop iterations).
 * Used by team-builder.decompose() and loop-orchestrator.runOneIteration().
 *
 * Non-fatal: any DB error returns the prompt unchanged.
 */
import { searchLessons, markLessonApplied } from './autonomy-learning.js';
import { logger } from '../logger.js';

/**
 * @param goalText  the task goal (used to derive a LIKE keyword)
 * @param prompt    the prompt to prepend lessons to
 * @param capability  preferred capability filter ('decision' | 'execution' | undefined)
 * @returns the (possibly prepended) prompt
 */
export function reinjectLessonsIntoPrompt(
  goalText: string,
  prompt: string,
  capability?: string,
): string {
  try {
    // Derive a short LIKE keyword from the goal — a long greedy CJK run would
    // never LIKE-match lesson_text, so cap at 6 chars of the first token.
    const rawToken = (goalText.match(/[一-龥a-zA-Z0-9]{2,}/) || [])[0] ?? '';
    const keyword = rawToken.slice(0, 6);
    let lessons = keyword ? searchLessons(capability, keyword, 3) : [];
    if (!lessons.length) lessons = searchLessons(undefined, keyword || undefined, 3);
    if (!lessons.length) return prompt;
    lessons.forEach((l) => { try { markLessonApplied(l.id); } catch { /* non-fatal */ } });
    logger.debug({ count: lessons.length, capability, goal: goalText.slice(0, 80) }, 'Reinjected autonomy lessons into prompt');
    return [
      '【历史经验（autonomy_lessons，按相关性参考，非强制）】',
      ...lessons.map((l) => `- [${l.capability}] ${l.lesson_text}`),
      '',
      prompt,
    ].join('\n');
  } catch {
    return prompt;
  }
}
