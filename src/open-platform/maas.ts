/**
 * LLM MaaS — OpenAI 风格 Chat Completions 协议适配层。
 *
 * 对外暴露 OpenAI 协议（/v1/chat/completions），对内把请求转换为 Anthropic
 * Messages 协议，直连该租户已配置的 provider（getClaudeProviderConfig）。
 * 鉴权头对齐 buildClaudeEnvLines 语义：apiKey → x-api-key；Bearer token →
 * Authorization；无 Bearer 的第三方 token → x-api-key。
 */
import { getClaudeProviderConfig } from '../runtime-config.js';
import { logger } from '../logger.js';

export interface OpenAiChatMessage {
  role: 'system' | 'user' | 'assistant' | string;
  content: string;
}

export interface OpenAiChatRequest {
  model?: string;
  messages: OpenAiChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
}

interface ProviderEndpoint {
  url: string;
  headers: Record<string, string>;
  defaultModel: string;
}

/** 解析 provider 直连端点与鉴权头。返回 null 表示未配置可用 provider。 */
export function resolveProvider(): ProviderEndpoint | null {
  const cfg = getClaudeProviderConfig();
  if (!cfg.anthropicBaseUrl && !cfg.anthropicApiKey && !cfg.anthropicAuthToken) {
    return null;
  }

  const base = (cfg.anthropicBaseUrl || '').replace(/\/+$/, '');
  // baseUrl 可能已含 /v1，或只是 host。统一拼到 /v1/messages。
  const url = /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(cfg.anthropicAuthToken || '');
  if (bearerMatch) {
    headers['authorization'] = `Bearer ${bearerMatch[1]}`;
  } else if (cfg.anthropicApiKey) {
    headers['x-api-key'] = cfg.anthropicApiKey;
  } else if (cfg.anthropicAuthToken) {
    headers['x-api-key'] = cfg.anthropicAuthToken;
  }

  return { url, headers, defaultModel: cfg.anthropicModel || '' };
}

/** OpenAI Chat Completions → Anthropic Messages 请求体。 */
export function openAiToAnthropic(req: OpenAiChatRequest, defaultModel: string) {
  const systemParts = req.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
  const messages = req.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  const body: Record<string, unknown> = {
    model: req.model || defaultModel,
    messages,
    stream: !!req.stream,
  };
  if (systemParts) body.system = systemParts;
  if (typeof req.temperature === 'number') body.temperature = req.temperature;
  if (typeof req.max_tokens === 'number') body.max_tokens = req.max_tokens;
  if (typeof req.top_p === 'number') body.top_p = req.top_p;
  return body;
}

/** Anthropic stop_reason → OpenAI finish_reason。 */
export function mapFinishReason(stopReason: string | undefined): string {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    default:
      return 'stop';
  }
}

interface AnthropicMessage {
  id?: string;
  type?: string;
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Anthropic Messages 非流式响应 → OpenAI chat.completion 对象。 */
export function anthropicToOpenAi(resp: AnthropicMessage, model: string) {
  const text = (resp.content ?? [])
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text)
    .join('');
  const usage = resp.usage ?? {};
  const promptTokens = usage.input_tokens ?? 0;
  const completionTokens = usage.output_tokens ?? 0;
  return {
    id: resp.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: mapFinishReason(resp.stop_reason ?? undefined),
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

/** 单次非流式调用 provider，返回 OpenAI 对象或抛错（含 OpenAI 风格 error）。 */
export async function chatCompletion(
  req: OpenAiChatRequest,
): Promise<Record<string, unknown>> {
  const endpoint = resolveProvider();
  if (!endpoint) {
    const err: any = new Error('No LLM provider configured');
    err.status = 503;
    throw err;
  }
  const anthropicBody = openAiToAnthropic(req, endpoint.defaultModel);
  anthropicBody.stream = false;

  const res = await fetch(endpoint.url, {
    method: 'POST',
    headers: endpoint.headers,
    body: JSON.stringify(anthropicBody),
  });

  const raw = await res.text().catch(() => '');
  if (!res.ok) {
    logger.warn(
      { status: res.status, raw: raw.slice(0, 300) },
      '[maas] provider returned error',
    );
    const err: any = new Error(`Upstream provider error (${res.status})`);
    err.status = res.status >= 400 && res.status < 500 ? 502 : 502;
    err.upstreamBody = raw.slice(0, 2000);
    throw err;
  }

  let parsed: AnthropicMessage;
  try {
    parsed = JSON.parse(raw) as AnthropicMessage;
  } catch {
    const err: any = new Error('Upstream provider returned non-JSON');
    err.status = 502;
    throw err;
  }
  return anthropicToOpenAi(parsed, (req.model || endpoint.defaultModel));
}

/**
 * 流式调用 provider，返回一个 async generator，产出 OpenAI SSE `data:` 行
 * （不含 `data: ` 前缀，由路由拼接）。首块含 role，末块后由路由追加 [DONE]。
 * onUsage：流结束时回调，携带该次调用的 model 与 input/output token 数（供计费）。
 */
export async function* streamChatCompletion(
  req: OpenAiChatRequest,
  onUsage?: (usage: { model: string; inputTokens: number; outputTokens: number }) => void,
): AsyncGenerator<string> {
  const endpoint = resolveProvider();
  if (!endpoint) {
    const err: any = new Error('No LLM provider configured');
    err.status = 503;
    throw err;
  }
  const anthropicBody = openAiToAnthropic(req, endpoint.defaultModel);
  anthropicBody.stream = true;

  const res = await fetch(endpoint.url, {
    method: 'POST',
    headers: { ...endpoint.headers, accept: 'text/event-stream' },
    body: JSON.stringify(anthropicBody),
  });

  if (!res.ok || !res.body) {
    const raw = await res.text().catch(() => '');
    const err: any = new Error(`Upstream provider error (${res.status})`);
    err.status = 502;
    err.upstreamBody = raw.slice(0, 2000);
    throw err;
  }

  const model = req.model || endpoint.defaultModel;
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  let finishReason = 'stop';
  let started = false;
  let inputTokens = 0;
  let outputTokens = 0;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (!rawEvent.trim()) continue;

      let dataStr = '';
      for (const line of rawEvent.split('\n')) {
        if (line.startsWith('data:')) {
          dataStr = line.slice(5).trim();
        }
      }
      if (!dataStr) continue;

      let evt: any;
      try {
        evt = JSON.parse(dataStr);
      } catch {
        continue;
      }

      switch (evt.type) {
        case 'message_start':
          started = true;
          inputTokens = evt.message?.usage?.input_tokens ?? 0;
          yield JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
          });
          break;
        case 'content_block_delta': {
          const text = evt.delta?.text;
          if (typeof text === 'string' && text.length > 0) {
            if (!started) {
              started = true;
              yield JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
              });
            }
            yield JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
            });
          }
          break;
        }
        case 'message_delta':
          if (evt.delta?.stop_reason) {
            finishReason = mapFinishReason(evt.delta.stop_reason);
          }
          if (evt.usage?.output_tokens != null) {
            outputTokens = evt.usage.output_tokens;
          }
          break;
        case 'message_stop':
          onUsage?.({ model, inputTokens, outputTokens });
          yield JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          });
          break;
        case 'error':
          yield JSON.stringify({
            error: {
              message: evt.error?.message || 'Upstream stream error',
              type: 'upstream_error',
            },
          });
          break;
        default:
          break;
      }
    }
  }
}
