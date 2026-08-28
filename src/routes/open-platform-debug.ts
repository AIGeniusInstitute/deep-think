// Agent Service 开放平台 — 在线调试端点（登录态，走 authMiddleware）。
//
// 前缀 /api/open-platform/debug：
//   GET  /meta    返回 provider 默认模型（供调试表单回填）
//   POST /chat    LLM 调试（复用 maas.chatCompletion / streamChatCompletion）
//   POST /agent   Agent 调试（复用 agent-service.runAgent / streamAgent）
//
// 与对外 /v1/* 走同一套底层执行与计费函数（checkOpenPlatformBilling 前置 +
// billOpenPlatformUsage 后置），仅鉴权从 Bearer sk- 换成会话 Cookie，计费对象
// 为当前登录用户。保证「控制台里调到的」与「外部 SDK 调到的」完全一致。
import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthUser } from '../types.js';
import {
  chatCompletion,
  streamChatCompletion,
  resolveProvider,
  type OpenAiChatRequest,
} from '../open-platform/maas.js';
import { runAgent, streamAgent } from '../open-platform/agent-service.js';
import {
  checkOpenPlatformBilling,
  billOpenPlatformUsage,
  computeMaaSCostUSD,
} from '../open-platform/billing.js';
import { logger } from '../logger.js';

const openPlatformDebugRoutes = new Hono<{ Variables: Variables }>();
openPlatformDebugRoutes.use('*', authMiddleware);

function userOf(c: any): AuthUser {
  return c.get('user') as AuthUser;
}

/** 把一个产出 OpenAI chunk JSON 字符串的 generator 包装成 SSE ReadableStream。 */
function toSseStream(gen: AsyncGenerator<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await gen.next();
        if (next.done) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } else {
          controller.enqueue(encoder.encode(`data: ${next.value}\n\n`));
        }
      } catch (err) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ error: { message: (err as Error).message || 'stream error', type: 'server_error' } })}\n\n`,
          ),
        );
        controller.close();
      }
    },
  });
}

function sseResponse(gen: AsyncGenerator<string>): Response {
  return new Response(toSseStream(gen), {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

/** 从 OpenAI 风格 messages 提取最后一条 user 文本。 */
function lastUserText(messages: OpenAiChatRequest['messages']): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  return lastUser?.content ?? '';
}

/** 统一 JSON 错误响应（status 为运行时数值，故 c 取 any 绕过字面量类型）。 */
function jsonError(c: any, status: number, message: string): Response {
  return c.json({ error: message }, status);
}

// GET /api/open-platform/debug/meta
openPlatformDebugRoutes.get('/meta', (c) => {
  const endpoint = resolveProvider();
  return c.json({ defaultModel: endpoint?.defaultModel || '', hasProvider: !!endpoint });
});

// POST /api/open-platform/debug/chat — LLM 调试
openPlatformDebugRoutes.post('/chat', async (c) => {
  const user = userOf(c);
  let body: OpenAiChatRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: 'messages is required' }, 400);
  }
  if (!lastUserText(body.messages).trim()) {
    return c.json({ error: 'no user message found' }, 400);
  }

  const billing = checkOpenPlatformBilling(user.id);
  if (!billing.allowed) {
    return jsonError(c, billing.status, billing.reason);
  }

  if (body.stream) {
    return sseResponse(
      streamChatCompletion(body, (usage) => {
        const costUSD = computeMaaSCostUSD(usage.model, usage.inputTokens, usage.outputTokens);
        billOpenPlatformUsage(user.id, {
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUSD,
        });
      }),
    );
  }

  try {
    const result = await chatCompletion(body);
    const usage = (result as any).usage ?? {};
    const model = (result as any).model || body.model || '';
    const inputTokens = usage.prompt_tokens ?? 0;
    const outputTokens = usage.completion_tokens ?? 0;
    const costUSD = computeMaaSCostUSD(model, inputTokens, outputTokens);
    billOpenPlatformUsage(user.id, { model, inputTokens, outputTokens, costUSD });
    return c.json(result);
  } catch (err) {
    const status = (err as any).status || 500;
    logger.warn({ err: (err as Error).message }, '/api/open-platform/debug/chat failed');
    return jsonError(c, status, (err as Error).message || 'Upstream error');
  }
});

// POST /api/open-platform/debug/agent — Agent 调试
openPlatformDebugRoutes.post('/agent', async (c) => {
  const user = userOf(c);
  let body: { agentId?: string; messages?: OpenAiChatRequest['messages']; stream?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const agentId = (body?.agentId || '').trim();
  if (!agentId) {
    return c.json({ error: 'agentId is required' }, 400);
  }
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return c.json({ error: 'messages is required' }, 400);
  }
  const text = lastUserText(body.messages).trim();
  if (!text) {
    return c.json({ error: 'no user message found' }, 400);
  }

  const billing = checkOpenPlatformBilling(user.id);
  if (!billing.allowed) {
    return jsonError(c, billing.status, billing.reason);
  }

  if (body.stream) {
    return sseResponse(streamAgent(agentId, user.id, text));
  }

  try {
    const { text: result } = await runAgent(agentId, user.id, text);
    return c.json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'agent',
      choices: [{ index: 0, message: { role: 'assistant', content: result }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (err) {
    const status = (err as any).status || 500;
    return jsonError(c, status, (err as Error).message || 'Agent execution failed');
  }
});

export default openPlatformDebugRoutes;
