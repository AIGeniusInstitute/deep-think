/**
 * MCP Registry — HTTP→MCP 转换引擎。
 *
 * 接收一个 registry tool 的 httpBinding + Agent 上行 arguments，
 * 执行：参数映射 → 凭证注入 → HTTP 调用 → 响应提取 → 错误映射。
 * 返回标准 MCP ToolResult 的 content + isError。
 *
 * 设计原则：引擎层不抛 JSON-RPC 错误，所有失败以 isError=true 的 ToolResult
 * 返回，由 MCP 端点层按需转译（见 routes/mcp-registry.ts）。
 */

import { logger } from '../logger.js';
import { decryptSecret } from './crypto.js';
import {
  resolveSideEffect,
  hashArgs,
  logToolCallAudit,
  getIdempotencyRecord,
  saveIdempotencyRecord,
  type SideEffect,
} from './governance.js';

export interface HttpBinding {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  paramMapping?: {
    path?: Record<string, string>;
    query?: Record<string, string>;
    header?: Record<string, string>;
    body?: Record<string, string>;
  };
  bodyTemplate?: Record<string, unknown>;
  authHeader?: { name: string; value: string } | null;
  responseMapping?: {
    extract?: string;
    toText?: string;
    truncate?: number;
  };
  timeoutMs?: number;
}

export interface InputSchemaObject {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  description?: string;
  [k: string]: unknown;
}

export interface RegistryTool {
  id: string;
  serverId: string;
  serverName: string;
  name: string;
  description: string;
  inputSchema: InputSchemaObject;
  httpBinding: HttpBinding;
  sideEffect?: SideEffect;
}

export interface McpToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  /** 回放标记：命中幂等缓存时为 true。 */
  idempotentReplay?: boolean;
  /** 上游 HTTP 状态码（用于审计）。 */
  httpStatus?: number;
}

/** 执行上下文：治理所需。全部可选，不传时退化为旧行为（零回归）。 */
export interface ExecCtx {
  userId?: string;
  requestId?: string | null;
  idempotencyKey?: string | null;
}

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 60000;
const DEFAULT_TRUNCATE = 20000;
const MAX_RESULT_LEN = 200000;

/** 清洗 server 名为 MCP 工具名前缀安全字符。 */
export function sanitizeServerPrefix(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'server';
}

/** 取点路径值：a.b.c，支持数组索引 a[0].b。返回 undefined 表示不存在。 */
export function extractByPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  // 支持 a.b[0].c 与 a.b.0.c 两种写法
  const parts = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((p) => p !== '');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(p);
      if (Number.isNaN(idx)) return undefined;
      cur = cur[idx];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** 简单模板替换：{{field}} 从 data 取值。 */
function applyToTextTemplate(template: string, data: unknown): string {
  return template.replace(/\{\{\s*([\w.\[\]]+)\s*\}\}/g, (_m, expr: string) => {
    const v = extractByPath(data, expr);
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  });
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n…(truncated, ${text.length - limit} chars omitted)`;
}

function toText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 校验必填参数（基于 inputSchema.required）。返回缺失字段名数组。 */
function missingRequired(
  args: Record<string, unknown>,
  schema: InputSchemaObject,
): string[] {
  const required = schema.required ?? [];
  return required.filter((k) => args[k] === undefined || args[k] === null);
}

/**
 * 执行一个 registry tool。
 * 不抛错；所有失败以 isError ToolResult 返回。
 * 可选 ctx 启用治理（审计/幂等/解密 authHeader）；不传则退化为旧行为。
 */
export async function executeRegistryTool(
  tool: RegistryTool,
  args: Record<string, unknown>,
  ctx?: ExecCtx,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  const sideEff = resolveSideEffect(tool.sideEffect, tool.httpBinding.method);
  const argsHash = hashArgs(args);

  // 幂等回放：仅写工具 + 有 key + 命中成功记录
  if (ctx?.idempotencyKey && ctx?.userId && sideEff !== 'read') {
    const cached = getIdempotencyRecord(ctx.userId, tool.id, ctx.idempotencyKey);
    if (cached) {
      try {
        const replay = JSON.parse(cached.resultContent) as McpToolResult;
        replay.idempotentReplay = true;
        if (cached.httpStatus != null) replay.httpStatus = cached.httpStatus;
        // 回放也留审计
        if (ctx.userId) {
          logToolCallAudit({
            userId: ctx.userId,
            toolId: tool.id,
            toolName: `${tool.serverName}__${tool.name}`,
            sideEffect: sideEff,
            argsHash,
            requestId: ctx.requestId ?? null,
            idempotencyKey: ctx.idempotencyKey,
            resultStatus: cached.resultIsError ? 'error' : 'success',
            httpStatus: cached.httpStatus,
            durationMs: Date.now() - startedAt,
          });
        }
        return replay;
      } catch {
        /* 缓存损坏，忽略并继续执行 */
      }
    }
  }

  const result = await executeRegistryToolInner(tool, args, sideEff);

  // 审计 + 幂等缓存（fire-and-forget，失败仅 warn）
  if (ctx?.userId) {
    logToolCallAudit({
      userId: ctx.userId,
      toolId: tool.id,
      toolName: `${tool.serverName}__${tool.name}`,
      sideEffect: sideEff,
      argsHash,
      requestId: ctx.requestId ?? null,
      idempotencyKey: ctx.idempotencyKey ?? null,
      resultStatus: result.isError ? 'error' : 'success',
      httpStatus: result.httpStatus ?? null,
      durationMs: Date.now() - startedAt,
    });
    // 幂等缓存：仅写工具 + 有 key + 成功
    if (ctx.idempotencyKey && sideEff !== 'read' && !result.isError) {
      saveIdempotencyRecord(
        ctx.userId,
        tool.id,
        ctx.idempotencyKey,
        JSON.stringify(result),
        false,
        result.httpStatus ?? null,
      );
    } else if (ctx.idempotencyKey && sideEff !== 'read' && result.isError) {
      // 失败也存（标记 isError=1），getIdempotencyRecord 对失败记录返回 null，
      // 允许重试；但需在 saveIdempotencyRecord 内部以 saveIdempotencyRecord 写 resultContent。
      saveIdempotencyRecord(
        ctx.userId,
        tool.id,
        ctx.idempotencyKey,
        JSON.stringify(result),
        true,
        result.httpStatus ?? null,
      );
    }
  }
  return result;
}

/** 内部执行：参数校验→HTTP 调用→响应提取。 */
async function executeRegistryToolInner(
  tool: RegistryTool,
  args: Record<string, unknown>,
  sideEff: SideEffect,
): Promise<McpToolResult> {
  const b = tool.httpBinding;
  const timeoutMs = Math.min(Math.max(b.timeoutMs ?? DEFAULT_TIMEOUT_MS, 500), MAX_TIMEOUT_MS);

  // 1. 参数校验
  const missing = missingRequired(args, tool.inputSchema);
  if (missing.length > 0) {
    return {
      content: [{ type: 'text', text: `Missing required parameter(s): ${missing.join(', ')}` }],
      isError: true,
    };
  }

  // 2. 路径变量替换
  let url = b.url;
  const pathMap = b.paramMapping?.path ?? {};
  for (const [argName, placeholder] of Object.entries(pathMap)) {
    const v = args[argName];
    if (v === undefined || v === null) {
      return {
        content: [{ type: 'text', text: `Missing path parameter: ${argName}` }],
        isError: true,
      };
    }
    url = url.split(`{${placeholder}}`).join(encodeURIComponent(String(v)));
  }
  // 残留 {xxx} 占位视为缺参
  const leftover = url.match(/\{[^}]+\}/);
  if (leftover) {
    return {
      content: [{ type: 'text', text: `Unresolved URL placeholder: ${leftover[0]}` }],
      isError: true,
    };
  }

  // 3. query 拼接
  const queryMap = b.paramMapping?.query ?? {};
  const queryParams: string[] = [];
  for (const [argName, qName] of Object.entries(queryMap)) {
    const v = args[argName];
    if (v !== undefined && v !== null) {
      queryParams.push(`${encodeURIComponent(qName)}=${encodeURIComponent(String(v))}`);
    }
  }
  if (queryParams.length > 0) {
    url += (url.includes('?') ? '&' : '?') + queryParams.join('&');
  }

  // 4. headers
  const headers: Record<string, string> = { ...(b.headers ?? {}) };
  const headerMap = b.paramMapping?.header ?? {};
  for (const [argName, hName] of Object.entries(headerMap)) {
    const v = args[argName];
    if (v !== undefined && v !== null) {
      headers[hName] = String(v);
    }
  }
  // 凭证注入（仅引擎可见，不进 inputSchema / tools/list）
  // authHeader.value 落库为 enc:v1: 密文，此处解密注入；兼容未迁移明文。
  if (b.authHeader && b.authHeader.name && b.authHeader.value) {
    let headerVal = b.authHeader.value;
    try {
      headerVal = decryptSecret(b.authHeader.value);
    } catch (err) {
      logger.warn({ err, toolId: tool.id }, 'failed to decrypt authHeader; using raw value');
    }
    headers[b.authHeader.name] = headerVal;
  }

  // 5. body
  let body: string | undefined;
  const hasBody = ['POST', 'PUT', 'PATCH'].includes(b.method);
  if (hasBody) {
    const bodyObj: Record<string, unknown> = { ...(b.bodyTemplate ?? {}) };
    const bodyMap = b.paramMapping?.body ?? {};
    for (const [argName, field] of Object.entries(bodyMap)) {
      const v = args[argName];
      if (v !== undefined && v !== null) {
        bodyObj[field] = v;
      }
    }
    if (!('Content-Type' in headers) && !('content-type' in headers)) {
      headers['Content-Type'] = 'application/json';
    }
    body = JSON.stringify(bodyObj);
  }

  // 6. 调用
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: b.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === 'TimeoutError';
    return {
      content: [
        {
          type: 'text',
          text: isTimeout
            ? `HTTP request timed out after ${timeoutMs}ms`
            : `HTTP request failed: ${msg}`,
        },
      ],
      isError: true,
    };
  }

  // 7. 响应提取
  const respText = await resp.text();
  const truncate = b.responseMapping?.truncate ?? DEFAULT_TRUNCATE;
  const extractPath = b.responseMapping?.extract;
  const toTextTpl = b.responseMapping?.toText;

  // 尝试解析为 JSON 以便提取；非 JSON 则原样
  let parsed: unknown = undefined;
  let isJson = false;
  if (respText) {
    try {
      parsed = JSON.parse(respText);
      isJson = true;
    } catch {
      parsed = respText;
    }
  }

  // 8. 错误映射（HTTP 层）
  if (!resp.ok) {
    const summary = isJson ? toText(parsed).slice(0, 500) : respText.slice(0, 500);
    return {
      content: [
        {
          type: 'text',
          text: `HTTP ${resp.status}: ${summary || '(empty body)'}`,
        },
      ],
      isError: true,
      httpStatus: resp.status,
    };
  }

  // 9. 提取 + 文本化
  let output: string;
  if (toTextTpl) {
    const data = extractPath ? extractByPath(parsed, extractPath) : parsed;
    output = applyToTextTemplate(toTextTpl, data ?? parsed);
  } else if (extractPath) {
    const v = extractByPath(parsed, extractPath);
    output = toText(v);
    if (output === '') output = '(extracted value is empty)';
  } else {
    output = isJson ? toText(parsed) : respText;
  }

  output = truncateText(output, truncate);
  if (output.length > MAX_RESULT_LEN) {
    output = truncateText(output, MAX_RESULT_LEN);
  }

  return { content: [{ type: 'text', text: output }], httpStatus: resp.status };
}

/** 把 DB 行（input_schema/http_binding 为 JSON 字符串）解析为 RegistryTool。 */
export function parseRegistryToolRow(
  row: {
    id: string;
    server_id: string;
    name: string;
    description: string;
    input_schema: string;
    http_binding: string;
    side_effect?: string;
  },
  serverName: string,
): RegistryTool | null {
  try {
    const inputSchema = JSON.parse(row.input_schema) as InputSchemaObject;
    const httpBinding = JSON.parse(row.http_binding) as HttpBinding;
    const sideRaw = row.side_effect;
    const sideEffect: SideEffect | undefined =
      sideRaw === 'read' || sideRaw === 'write' || sideRaw === 'admin' ? sideRaw : undefined;
    return {
      id: row.id,
      serverId: row.server_id,
      serverName,
      name: row.name,
      description: row.description,
      inputSchema,
      httpBinding,
      sideEffect,
    };
  } catch (err) {
    logger.warn({ toolId: row.id, err }, 'Failed to parse registry tool binding');
    return null;
  }
}
