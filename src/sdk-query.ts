/**
 * Lightweight Claude Agent SDK wrapper for simple text-in → text-out queries.
 * Replaces all `claude --print` CLI calls so authentication uses the
 * provider configured in the settings page (ANTHROPIC_API_KEY / OAuth / Base URL).
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildClaudeEnvLines, getClaudeProviderConfig } from './runtime-config.js';
import { logger } from './logger.js';
import { upsertTraceStep } from './db.js';

/**
 * Trace context for an llm_call atomic step. When provided to sdkQuery /
 * sdkQueryMessages, the call is recorded as a `llm_call` trace_step so
 * orchestration-layer LLM invocations (supervisor decisions, team decompose,
 * skill runs) are visible in the trace timeline alongside agent-runner steps.
 * Omit for non-chat-context calls (eval, bug report, etc.) — backward compat.
 */
export interface LlmCallTrace {
  /** Chat jid this LLM call belongs to (scopes the step into the chat timeline). */
  chatJid: string;
  /** Reuse an existing traceId to group with an ongoing turn; fresh UUID if omitted. */
  traceId?: string;
  /** Parent span (e.g. the turn span); null/undefined = root. */
  parentSpanId?: string | null;
  /** Human label shown in the timeline (e.g. "Supervisor Decision"). */
  label?: string;
}

/** Monotonic counter for llm_call span ids (process-scoped, like TraceNodeAllocator). */
let llmCallCounter = 0;

/**
 * Record an llm_call trace_step (best-effort). Never throws — trace is a side
 * channel and must not break the query. Called from the finally block of
 * sdkQuery/sdkQueryMessages when a trace context was provided.
 */
function recordLlmCallTrace(
  trace: LlmCallTrace,
  prompt: string,
  result: string | null,
  startedAt: string,
  failed: boolean,
): void {
  try {
    const traceId = trace.traceId ?? (globalThis.crypto?.randomUUID?.() ?? `llm-${Date.now()}`);
    const spanId = `llm-${++llmCallCounter}`;
    upsertTraceStep({
      trace_id: traceId,
      span_id: spanId,
      parent_span_id: trace.parentSpanId ?? null,
      chat_jid: trace.chatJid,
      node_type: 'llm_call',
      title: trace.label ?? 'LLM Call',
      input_summary: prompt.slice(0, 500),
      output_summary: (result ?? '').slice(0, 1000),
      tokens: 0,
      status: failed ? 'failed' : 'done',
      started_at: startedAt,
      ended_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message?.slice(0, 200) }, 'recordLlmCallTrace failed');
  }
}

/**
 * Send a prompt to Claude and return the plain-text response.
 * Uses the provider configured in the web settings (not a separate CLI install).
 *
 * @param prompt  The user prompt text
 * @param opts.model   Override model (defaults to provider config)
 * @param opts.timeout Timeout in ms (default 60 000)
 * @returns The assistant's text response, or null on failure
 */
export async function sdkQuery(
  prompt: string,
  opts?: { model?: string; timeout?: number; trace?: LlmCallTrace },
): Promise<string | null> {
  const timeout = opts?.timeout ?? 60_000;
  const trace = opts?.trace;
  const startedAt = new Date().toISOString();
  let failed = false;

  // 构造隔离的 env 副本传给 SDK（options.env 是子进程 env 的权威来源）。
  // 不再突变全局 process.env、也无需 mutex 串行化，因此多个 sdkQuery（/recall、
  // 自动标题、bug 上报、task 解析等）可并发执行、凭据互不串扰。
  const config = getClaudeProviderConfig();
  const envLines = buildClaudeEnvLines(config);
  const env: Record<string, string | undefined> = { ...process.env };
  for (const line of envLines) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeout);

  let result: string | null = null;
  try {
    const model = opts?.model || config.anthropicModel || undefined;

    let raw = '';
    const conversation = query({
      prompt,
      options: {
        ...(model && { model }),
        env,
        maxTurns: 1,
        allowedTools: [],
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
        abortController,
      },
    });

    for await (const event of conversation) {
      if (event.type === 'result' && event.subtype === 'success') {
        raw = event.result;
      }
    }

    result = raw.trim() || null;
    return result;
  } catch (err) {
    failed = true;
    logger.warn({ err: (err as Error).message?.slice(0, 200) }, 'sdkQuery failed');
    return null;
  } finally {
    clearTimeout(timer);
    if (trace) recordLlmCallTrace(trace, prompt, result, startedAt, failed);
  }
}

/**
 * Anthropic 消息内容块类型（文本 / 图像 base64）。
 * 仅声明我们用到的子集，避免依赖 SDK 私有类型。
 */
export type AssistantContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    };

export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string | AssistantContentBlock[];
}

/**
 * 发送带图像的消息（用于 Browser Use Agent：截图 + 文本指令 → 下一步动作）。
 * 复用 provider 配置；maxTurns=1、不允许工具，纯模型问答。
 * 返回文本结果（调用方自行解析 JSON 动作）。
 */
export async function sdkQueryMessages(
  messages: AssistantMessage[],
  opts?: { model?: string; timeout?: number; systemPrompt?: string; trace?: LlmCallTrace },
): Promise<string | null> {
  const timeout = opts?.timeout ?? 90_000;
  const trace = opts?.trace;
  const startedAt = new Date().toISOString();
  let failed = false;
  const config = getClaudeProviderConfig();
  const envLines = buildClaudeEnvLines(config);
  const env: Record<string, string | undefined> = { ...process.env };
  for (const line of envLines) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeout);

  let result: string | null = null;
  try {
    const model = opts?.model || config.anthropicModel || undefined;
    let raw = '';

    // ⚠️ Claude Agent SDK 的 query() 只接受 `prompt`（string 或
    // AsyncIterable<SDKUserMessage>），**没有** `messages` 参数。早期实现把
    // `messages` 直接传给 query()，该字段被静默忽略 → prompt 缺失 → SDK 立即
    // abort("Operation aborted") → 返回 null → Browser Use Agent 全步 "空响应"。
    //
    // 正确做法：把输入消息转成 SDKUserMessage 流，作为 prompt 传入。
    // SDKUserMessage.message 是 MessageParam，其 content 支持 text/image content
    // block，因此图像截图可以照常携带。
    const promptStream = (async function* () {
      for (const m of messages) {
        yield {
          type: 'user' as const,
          message: {
            role: m.role,
            content: m.content,
          },
          parent_tool_use_id: null,
        };
      }
    })();

    const conversation = query({
      prompt: promptStream as any,
      options: {
        ...(model && { model }),
        env,
        ...(opts?.systemPrompt && { systemPrompt: opts.systemPrompt }),
        maxTurns: 1,
        allowedTools: [],
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
        abortController,
      },
    });

    for await (const event of conversation) {
      if (event.type === 'result' && event.subtype === 'success') {
        raw = event.result;
      }
    }
    result = raw.trim() || null;
    return result;
  } catch (err) {
    failed = true;
    logger.warn(
      { err: (err as Error).message?.slice(0, 200) },
      'sdkQueryMessages failed',
    );
    return null;
  } finally {
    clearTimeout(timer);
    if (trace) {
      // Use the joined user-turn text as the input summary for message-mode calls.
      const inputSummary = messages
        .map((m) => (typeof m.content === 'string' ? m.content : ''))
        .join('\n')
        .slice(0, 500);
      recordLlmCallTrace(trace, inputSummary, result, startedAt, failed);
    }
  }
}
