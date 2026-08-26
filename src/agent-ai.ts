/**
 * AI-powered Agent generation / optimization.
 * Mirrors skill-ai.ts: uses sdkQuery (Claude Agent SDK, maxTurns=1, no tools)
 * to turn a name + short description into a complete structured Agent config,
 * or to optimize an existing Agent's description / system_prompt.
 *
 * Output is JSON (not free-form markdown like skills), because Agent fields
 * (name/description/system_prompt/model/engine/max_turns/temperature) are
 * structured. We strip code fences, extract the first JSON object, and apply
 * per-field fallbacks so a slightly-off model response still yields usable
 * fields.
 */
import { sdkQuery } from './sdk-query.js';

const GENERATION_TIMEOUT_MS = 90_000;
const OPTIMIZATION_TIMEOUT_MS = 90_000;

const VALID_ENGINES = new Set(['claude', 'atomcode', 'codex', 'opencode', 'pi']);

export type AgentEngine = 'claude' | 'atomcode' | 'codex' | 'opencode' | 'pi';

export interface GeneratedAgentFields {
  name: string;
  description: string;
  system_prompt: string;
  model: string | null;
  engine: AgentEngine;
  max_turns: number | null;
  temperature: number | null;
}

export interface OptimizedAgentFields {
  description: string;
  system_prompt: string;
}

const GENERATION_PROMPT = `You are an expert at designing AI agents. Based on the user's name and description, generate a complete, professional agent configuration.

Output STRICTLY a JSON object (no code fences, no prose, nothing before or after) with exactly these fields:
- name: string (1-80 chars, concise professional name; you may refine the user's suggested name)
- description: string (<=500 chars, a clear one-line statement of the agent's purpose)
- system_prompt: string (a complete, professional system prompt: role, responsibilities, constraints, output format, edge cases. Write in the same language as the user's description.)
- model: string or null (suggested model id, or null to inherit the platform default)
- engine: one of "claude" | "atomcode" | "codex" | "opencode" | "pi" (default "claude")
- max_turns: number or null (1-200, suggested autonomy budget, or null)
- temperature: number or null (0-2, suggested sampling temperature, or null)

User suggested name: {{NAME}}
User description: {{DESCRIPTION}}

Output ONLY the JSON object.`;

const OPTIMIZATION_PROMPT = `You are an expert at improving AI agent prompts. Optimize the given agent's description and system_prompt.

Improvement focus:
- Make the description clearer and more action-oriented.
- Tighten and clarify the system_prompt: role, responsibilities, constraints, output format, edge cases.
- Preserve the agent's core intent and write in the same language as the original.
- Do NOT change the agent's name.

{{FEEDBACK_LINE}}

Current name: {{NAME}}
Current description:
{{DESCRIPTION}}

Current system_prompt:
{{SYSTEM_PROMPT}}

Output STRICTLY a JSON object (no code fences, no prose) with exactly:
{ "description": string, "system_prompt": string }`;

function fillTemplate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(v);
  }
  return out;
}

/**
 * Strip surrounding ``` / ```json fences if the model wrapped its output.
 */
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    const firstNewline = trimmed.indexOf('\n');
    if (firstNewline === -1) return trimmed;
    const withoutFirst = trimmed.slice(firstNewline + 1);
    if (withoutFirst.trimEnd().endsWith('```')) {
      return withoutFirst.trimEnd().slice(0, -3).trimStart();
    }
    return withoutFirst.trim();
  }
  return trimmed;
}

/**
 * Extract the first balanced JSON object from a possibly-noisy string.
 * Falls back to raw text if no balanced object is found.
 */
function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  if (start === -1) return text;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.trim();
}

function coerceEngine(v: unknown): AgentEngine {
  if (typeof v === 'string' && VALID_ENGINES.has(v)) return v as AgentEngine;
  return 'claude';
}

function coerceString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function coerceNullableString(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

function coerceNullableNumber(v: unknown, min: number, max: number): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

/**
 * Generate a structured Agent config from a name + short description.
 * Returns fields for the caller to preview/edit (does NOT write to DB).
 */
export async function generateAgentContent(
  description: string,
  suggestedName?: string,
): Promise<{ fields: GeneratedAgentFields } | { error: string }> {
  if (!description || description.trim().length < 10) {
    return { error: 'description must be at least 10 characters' };
  }

  const nameLine = suggestedName && suggestedName.trim()
    ? suggestedName.trim()
    : '(none — choose an appropriate name based on the description)';

  const prompt = fillTemplate(GENERATION_PROMPT, {
    NAME: nameLine,
    DESCRIPTION: description.trim(),
  });

  const result = await sdkQuery(prompt, { timeout: GENERATION_TIMEOUT_MS });
  if (!result || result.trim().length === 0) {
    return { error: 'AI generation returned empty content (provider may be unavailable)' };
  }

  const cleaned = stripCodeFences(result);
  const jsonText = extractJsonObject(cleaned);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { error: 'AI generated invalid JSON (provider may be unavailable or misconfigured)' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { error: 'AI generated invalid JSON (provider may be unavailable or misconfigured)' };
  }
  const obj = parsed as Record<string, unknown>;

  const fields: GeneratedAgentFields = {
    name: (() => {
      const n = coerceString(obj.name).trim().slice(0, 80);
      return n || (suggestedName ? suggestedName.trim().slice(0, 80) : description.trim().slice(0, 80));
    })(),
    description: coerceString(obj.description).slice(0, 500),
    system_prompt: coerceString(obj.system_prompt).slice(0, 20000),
    model: coerceNullableString(obj.model),
    engine: coerceEngine(obj.engine),
    max_turns: coerceNullableNumber(obj.max_turns, 1, 200),
    temperature: coerceNullableNumber(obj.temperature, 0, 2),
  };

  return { fields };
}

/**
 * Optimize an existing Agent's description + system_prompt.
 * Returns the optimized fields (does NOT write to DB).
 */
export async function optimizeAgentContent(
  current: { name: string; description: string; system_prompt: string },
  feedback?: string,
): Promise<{ fields: OptimizedAgentFields } | { error: string }> {
  if (!current.system_prompt && !current.description) {
    return { error: 'Current agent has no description or system_prompt to optimize' };
  }

  const feedbackLine = feedback && feedback.trim().length > 0
    ? `User feedback to address: ${feedback.trim()}`
    : 'No specific user feedback — improve based on best practices.';

  const prompt = fillTemplate(OPTIMIZATION_PROMPT, {
    NAME: current.name,
    DESCRIPTION: current.description || '(empty)',
    SYSTEM_PROMPT: current.system_prompt || '(empty)',
    FEEDBACK_LINE: feedbackLine,
  });

  const result = await sdkQuery(prompt, { timeout: OPTIMIZATION_TIMEOUT_MS });
  if (!result || result.trim().length === 0) {
    return { error: 'AI optimization returned empty content (provider may be unavailable)' };
  }

  const cleaned = stripCodeFences(result);
  const jsonText = extractJsonObject(cleaned);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { error: 'AI optimized content is invalid JSON (provider may be unavailable or misconfigured)' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { error: 'AI optimized content is invalid JSON (provider may be unavailable or misconfigured)' };
  }
  const obj = parsed as Record<string, unknown>;

  return {
    fields: {
      description: coerceString(obj.description).slice(0, 500) || current.description,
      system_prompt: coerceString(obj.system_prompt).slice(0, 20000) || current.system_prompt,
    },
  };
}
