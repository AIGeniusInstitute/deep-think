/**
 * AI-powered skill generation / optimization / debugging.
 * Uses sdkQuery (Claude Agent SDK, maxTurns=1, no tools) to turn natural language
 * into SKILL.md content, improve existing skills, or simulate skill execution.
 */
import { sdkQuery, sdkQueryMessages } from './sdk-query.js';
import { logger } from './logger.js';
import { slugifySkillName } from './skill-content-utils.js';

const GENERATION_TIMEOUT_MS = 90_000;
const OPTIMIZATION_TIMEOUT_MS = 90_000;
const DEBUG_TIMEOUT_MS = 60_000;

const GENERATION_PROMPT = `You are an expert at writing Claude Code skills. Generate a complete SKILL.md file based on the user's description.

Output format requirements:
1. Start with YAML frontmatter delimited by ---
2. Required frontmatter fields: name (snake-case or kebab-case, [a-z0-9-]+), description (concise, action-oriented, can use > folded style for long text)
3. Optional frontmatter fields: user-invocable (true/false, default true), allowed-tools (comma-separated tool patterns like "Bash, Read, Write"), argument-hint (string hint for user invocation)
4. Follow frontmatter with a Markdown body containing clear, specific instructions for how the skill should behave. Use sections, examples, and edge-case guidance where helpful.
5. Body should be 200-800 words — concise but complete.

User description: {{DESCRIPTION}}
{{SUGGESTED_NAME_LINE}}

Output ONLY the SKILL.md file content. No code fences, no explanation, no preamble.`;

const OPTIMIZATION_PROMPT = `You are an expert at improving Claude Code skills. Optimize the following SKILL.md content.

Improvement focus:
- Make the description clearer and more action-oriented
- Tighten and clarify the body instructions
- Add missing edge-case guidance
- Improve tool usage hints (allowed-tools) if needed
- Keep the same overall structure (frontmatter + markdown body)
- Preserve the original skill's core intent

{{FEEDBACK_LINE}}

Current SKILL.md content:
\`\`\`
{{CURRENT_CONTENT}}
\`\`\`

Output ONLY the optimized SKILL.md file content. No code fences around the output, no explanation, no preamble.`;

const DEBUG_PROMPT = `You are Claude with access to the following skill. The user is invoking this skill. Respond as if you were executing the skill according to its instructions.

CRITICAL: You do NOT have access to any tools in this context. Do not attempt to call Bash, Read, Write, WebFetch, or any other tool. Instead, respond with plain text: either process the user's request directly using your own knowledge, or describe in detail what you would do (which tool, which parameters, which URL) if you had tool access.

Skill SKILL.md:
\`\`\`
{{SKILL_CONTENT}}
\`\`\`

User input: {{TEST_INPUT}}

Respond in plain text only. Do not call any tools.`;

function fillTemplate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(v);
  }
  return out;
}

/**
 * Generate a new SKILL.md from natural language description.
 * Returns content + suggested skillId (slugified from name or description).
 */
export async function generateSkillContent(
  descriptionPrompt: string,
  suggestedName?: string,
): Promise<{ content: string; skillId: string } | { error: string }> {
  if (!descriptionPrompt || descriptionPrompt.trim().length < 10) {
    return { error: 'description_prompt must be at least 10 characters' };
  }

  const suggestedNameLine = suggestedName
    ? `Suggested name (you may override if it doesn't match the description): ${suggestedName}`
    : 'Choose an appropriate name based on the description.';

  const prompt = fillTemplate(GENERATION_PROMPT, {
    DESCRIPTION: descriptionPrompt.trim(),
    SUGGESTED_NAME_LINE: suggestedNameLine,
  });

  const result = await sdkQuery(prompt, { timeout: GENERATION_TIMEOUT_MS });
  if (!result || result.trim().length === 0) {
    return { error: 'AI generation returned empty content (provider may be unavailable)' };
  }

  const content = stripCodeFences(result);
  // Slugify skillId from suggestedName if provided, else from the frontmatter name
  // parsed from the generated content. Fallback: slugify the description.
  let skillId: string;
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const nameMatch = fmMatch[1].match(/^name:\s*(.+)$/m);
    if (nameMatch) {
      skillId = slugifySkillName(nameMatch[1].trim());
    } else if (suggestedName) {
      skillId = slugifySkillName(suggestedName);
    } else {
      skillId = slugifySkillName(descriptionPrompt);
    }
  } else if (suggestedName) {
    skillId = slugifySkillName(suggestedName);
  } else {
    skillId = slugifySkillName(descriptionPrompt);
  }

  return { content, skillId };
}

/**
 * Optimize an existing SKILL.md content. Returns the optimized content (does not write).
 */
export async function optimizeSkillContent(
  currentContent: string,
  feedback?: string,
): Promise<{ content: string } | { error: string }> {
  if (!currentContent || currentContent.trim().length === 0) {
    return { error: 'Current content is empty' };
  }

  const feedbackLine = feedback && feedback.trim().length > 0
    ? `User feedback to address: ${feedback.trim()}`
    : 'No specific user feedback — improve based on best practices.';

  const prompt = fillTemplate(OPTIMIZATION_PROMPT, {
    CURRENT_CONTENT: currentContent,
    FEEDBACK_LINE: feedbackLine,
  });

  const result = await sdkQuery(prompt, { timeout: OPTIMIZATION_TIMEOUT_MS });
  if (!result || result.trim().length === 0) {
    return { error: 'AI optimization returned empty content (provider may be unavailable)' };
  }

  const content = stripCodeFences(result);
  return { content };
}

/**
 * Debug a skill by simulating its execution against a test input.
 * Uses sdkQuery with no tools (maxTurns=1) — purely text-in/text-out.
 */
/**
 * Debug a skill against a test input.
 *
 * mode='ai' (default): predict/describe skill behavior via the DEBUG_PROMPT —
 *   the model explains what it *would* do (no tool access). Fast, safe, static.
 * mode='real': actually run the skill as a system prompt + the test input as
 *   the user message, so the model follows the skill instructions for real and
 *   produces genuine output (still maxTurns=1 / no tools — bounded & safe; a
 *   full tool-enabled run is a future, sandboxed path). The distinction gives
 *   the Skills debugger both a "what would happen" and a "what does happen"
 *   evidence channel (PRD: online skill registration + debugging).
 */
export async function debugSkill(
  skillContent: string,
  testInput: string,
  mode: 'ai' | 'real' = 'ai',
): Promise<{ output: string; durationMs: number; mode: string } | { error: string }> {
  if (!skillContent || skillContent.trim().length === 0) {
    return { error: 'Skill content is empty' };
  }
  if (!testInput || testInput.trim().length === 0) {
    return { error: 'test_input must be non-empty' };
  }

  const start = Date.now();

  if (mode === 'real') {
    // Real execution: skill content becomes the system prompt, test_input is
    // the user turn. The model actually follows the skill.
    const systemPrompt = `You are executing the following skill. Follow its instructions precisely to handle the user's request.\n\nSkill SKILL.md:\n\`\`\`\n${skillContent}\n\`\`\``;
    const result = await sdkQueryMessages(
      [{ role: 'user', content: testInput }],
      { timeout: DEBUG_TIMEOUT_MS, systemPrompt },
    );
    const durationMs = Date.now() - start;
    if (result === null) {
      return { error: 'Real debug query failed (provider unavailable or timed out)' };
    }
    return { output: result, durationMs, mode: 'real' };
  }

  // AI-predictive mode (legacy).
  const prompt = fillTemplate(DEBUG_PROMPT, {
    SKILL_CONTENT: skillContent,
    TEST_INPUT: testInput,
  });
  const result = await sdkQuery(prompt, { timeout: DEBUG_TIMEOUT_MS });
  const durationMs = Date.now() - start;

  if (result === null) {
    return { error: 'AI debug query failed (provider may be unavailable or timed out)' };
  }

  return { output: result, durationMs, mode: 'ai' };
}

/**
 * Strip surrounding ``` fences if the model wrapped its output in a code block.
 */
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    // Remove first fence line
    const firstNewline = trimmed.indexOf('\n');
    if (firstNewline === -1) return trimmed;
    const withoutFirst = trimmed.slice(firstNewline + 1);
    // Remove trailing fence if present
    if (withoutFirst.trimEnd().endsWith('```')) {
      return withoutFirst.trimEnd().slice(0, -3).trimStart() + '\n';
    }
    return withoutFirst;
  }
  return trimmed;
}

// Unused export to silence linter on logger import — logger may be used for future tracing
void logger;
