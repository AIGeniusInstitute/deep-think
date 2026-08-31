// Agent Service 开放平台 — 对外 `/v1/*` 路由（LLM MaaS + Agent as a Service）。
//
// 鉴权：Authorization: Bearer sk-xxx 或 ?token=，用 api_keys 表 SHA-256 校验。
// 与 mcp-gateway 同范式：独立 Hono 子应用，不挂 authMiddleware，不走会话 Cookie。
import { Hono } from 'hono';
import { verifyApiKey } from '../open-platform/api-keys.js';
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
import {
  validateResult,
  decideValidationAction,
} from '../open-platform/result-validation.js';
import {
  getApiKeyValidationPolicy,
  getAgentDefValidationPolicy,
} from '../db.js';
import { logger } from '../logger.js';

const openPlatformRoutes = new Hono();

/** 从 header / query 提取 Bearer key。 */
function extractToken(c: any): string {
  const auth = c.req.header('authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return c.req.query('token') || '';
}

/** 校验 key 并返回 { userId, scopes }，失败返回 null（同时写 401 响应）。 */
/** 校验 key 并返回 { userId, keyId, scopes }，失败返回 null（同时写 401 响应）。 */
function authenticate(c: any): { userId: string; keyId: string; scopes: string[] } | null {
  const raw = extractToken(c);
  const verified = verifyApiKey(raw);
  if (!verified) {
    c.status(401);
    return null;
  }
  return { userId: verified.userId, keyId: verified.keyId, scopes: verified.scopes };
}

function hasScope(scopes: string[], scope: string): boolean {
  return scopes.includes('*') || scopes.includes(scope);
}

function jsonError(c: any, status: number, message: string, type = 'invalid_request_error'): Response {
  return c.json(
    { error: { message, type, code: status } },
    status,
  );
}

/**
 * v58 result-validation seam. Runs the schema→hook pipeline on a model/agent
 * output text. `produce` is called to obtain the result (and re-called once on
 * a 'retry' action). Returns either:
 *  - { ok:true, payload, outcome } → route returns the (possibly second) result,
 *    optionally tagging an X-Validation header when validation was tolerated;
 *  - { ok:false, response } → route returns the 422 response directly.
 * When no policy is configured, behaves as a thin pass-through (produce once).
 */
async function applyResultValidation<T>(
  c: any,
  policy: ReturnType<typeof getApiKeyValidationPolicy>,
  produce: () => Promise<{ text: string; payload: T }>,
): Promise<
  | { ok: true; payload: T; outcome: import('../open-platform/result-validation.js').ValidationResultOutcome | null }
  | { ok: false; response: Response }
> {
  if (!policy || (!policy.validationSchema && !policy.validationHookUrl)) {
    const { payload } = await produce();
    return { ok: true, payload, outcome: null };
  }
  let { text, payload } = await produce();
  let outcome = await validateResult(policy, text);
  const decision = decideValidationAction(policy, outcome);
  if (decision.action === 'reject') {
    return { ok: false, response: jsonError(c, 422, decision.message, 'validation_error') };
  }
  if (decision.action === 'retry') {
    const second = await produce();
    text = second.text;
    payload = second.payload;
    outcome = await validateResult(policy, text);
    if (!outcome.passed) {
      const failAction = !outcome.schemaPassed ? policy.onSchemaFail : policy.hookFailureAction;
      if (failAction !== 'passthrough') {
        return { ok: false, response: jsonError(c, 422, outcome.summary, 'validation_error') };
      }
    }
  }
  return { ok: true, payload, outcome };
}

/** 把一个产出 JSON 字符串的 generator 包装成 SSE ReadableStream。 */
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

// GET /v1/models — 返回当前租户可用模型
openPlatformRoutes.get('/models', (c) => {
  const auth = authenticate(c);
  if (!auth) return jsonError(c, 401, 'Invalid API key', 'authentication_error');
  if (!hasScope(auth.scopes, 'maas')) {
    return jsonError(c, 403, 'API key missing maas scope', 'permission_error');
  }
  const endpoint = resolveProvider();
  if (!endpoint) return jsonError(c, 503, 'No LLM provider configured', 'server_error');
  const created = Math.floor(Date.now() / 1000);
  return c.json({
    object: 'list',
    data: [
      {
        id: endpoint.defaultModel || 'default',
        object: 'model',
        created,
        owned_by: 'deepthink',
      },
    ],
  });
});

// POST /v1/chat/completions — LLM MaaS（OpenAI 风格，支持 stream）
openPlatformRoutes.post('/chat/completions', async (c) => {
  const auth = authenticate(c);
  if (!auth) return jsonError(c, 401, 'Invalid API key', 'authentication_error');
  if (!hasScope(auth.scopes, 'maas')) {
    return jsonError(c, 403, 'API key missing maas scope', 'permission_error');
  }

  let body: OpenAiChatRequest;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, 'Invalid JSON body');
  }
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonError(c, 400, 'messages is required');
  }

  // 计费闭环：调用前余额/配额校验
  const billing = checkOpenPlatformBilling(auth.userId);
  if (!billing.allowed) {
    return jsonError(c, billing.status, billing.reason, 'insufficient_quota');
  }

  if (body.stream) {
    const stream = toSseStream(
      streamChatCompletion(body, (usage) => {
        const costUSD = computeMaaSCostUSD(usage.model, usage.inputTokens, usage.outputTokens);
        billOpenPlatformUsage(auth.userId, {
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUSD,
        });
      }),
    );
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  try {
    const policy = getApiKeyValidationPolicy(auth.keyId);
    const validated = await applyResultValidation<Record<string, unknown>>(c, policy, async () => {
      const result = await chatCompletion(body);
      // 后置计量扣费（每次 provider 调用都计费，含 retry 的二次调用）
      const usage = (result as any).usage ?? {};
      const inputTokens = usage.prompt_tokens ?? 0;
      const outputTokens = usage.completion_tokens ?? 0;
      const model = (result as any).model || body.model || '';
      const costUSD = computeMaaSCostUSD(model, inputTokens, outputTokens);
      billOpenPlatformUsage(auth.userId, { model, inputTokens, outputTokens, costUSD });
      const content = (result as any).choices?.[0]?.message?.content;
      const text = typeof content === 'string' ? content : JSON.stringify(result);
      return { text, payload: result };
    });
    if (!validated.ok) return validated.response;
    const headers: Record<string, string> = {};
    if (validated.outcome) {
      headers['X-Validation'] = validated.outcome.passed ? 'passed' : 'tolerated';
    }
    return c.json(validated.payload, 200, headers);
  } catch (err) {
    const status = (err as any).status || 500;
    logger.warn({ err: (err as Error).message }, '/v1/chat/completions failed');
    return jsonError(c, status, (err as Error).message || 'Upstream error', 'server_error');
  }
});

// POST /v1/agents/:agentId/chat/completions — Agent as a Service
openPlatformRoutes.post('/agents/:agentId/chat/completions', async (c) => {
  const auth = authenticate(c);
  if (!auth) return jsonError(c, 401, 'Invalid API key', 'authentication_error');
  if (!hasScope(auth.scopes, 'agent')) {
    return jsonError(c, 403, 'API key missing agent scope', 'permission_error');
  }

  const agentId = c.req.param('agentId');
  let body: OpenAiChatRequest;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, 'Invalid JSON body');
  }
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonError(c, 400, 'messages is required');
  }
  const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
  const userText = lastUser ? lastUser.content : '';
  if (!userText.trim()) {
    return jsonError(c, 400, 'no user message found');
  }

  // 计费闭环：调用前余额/配额校验（后置计量扣费在 agent-service 内部完成）
  const billing = checkOpenPlatformBilling(auth.userId);
  if (!billing.allowed) {
    return jsonError(c, billing.status, billing.reason, 'insufficient_quota');
  }

  if (body.stream) {
    const stream = toSseStream(streamAgent(agentId, auth.userId, userText));
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  try {
    const policy = getAgentDefValidationPolicy(agentId);
    const validated = await applyResultValidation<{ id: string; object: string; created: number; model: string; choices: unknown[]; usage: Record<string, number> }>(c, policy, async () => {
      const { text } = await runAgent(agentId, auth.userId, userText);
      const payload = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model || 'agent',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      return { text, payload };
    });
    if (!validated.ok) return validated.response;
    const headers: Record<string, string> = {};
    if (validated.outcome) {
      headers['X-Validation'] = validated.outcome.passed ? 'passed' : 'tolerated';
    }
    return c.json(validated.payload, 200, headers);
  } catch (err) {
    const status = (err as any).status || 500;
    return jsonError(c, status, (err as Error).message || 'Agent execution failed', 'server_error');
  }
});

export default openPlatformRoutes;
