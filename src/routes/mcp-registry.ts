// MCP Server 注册中心 routes
//
// 两部分：
//   1) REST CRUD：/api/mcp-registry/*  — server/tool 增删改查、试调、OpenAPI 导入
//   2) MCP streamable-HTTP 端点：/api/mcp-registry/mcp — 供 Agent 以 http MCP 挂载
//
// 转换引擎在主服务侧执行（有网络出站 + DB）；Agent 侧零改动。

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Variables } from '../web-context.js';
import type { AuthUser } from '../types.js';
import { authMiddleware } from '../middleware/auth.js';
import { logger } from '../logger.js';
import {
  listRegistryServers,
  getRegistryServer,
  createRegistryServer,
  updateRegistryServer,
  deleteRegistryServer,
  listRegistryToolsByServer,
  listEnabledRegistryTools,
  getRegistryTool,
  createRegistryTool,
  updateRegistryTool,
  deleteRegistryTool,
  getOrCreateRegistryToken,
  rotateRegistryToken,
  getUserIdByRegistryToken,
} from '../db.js';
import {
  RegistryServerCreateSchema,
  RegistryServerUpdateSchema,
  RegistryToolCreateSchema,
  RegistryToolUpdateSchema,
} from '../schemas.js';
import {
  executeRegistryTool,
  parseRegistryToolRow,
  sanitizeServerPrefix,
} from '../mcp-registry/engine.js';
import { parseOpenApi } from '../mcp-registry/openapi-parser.js';

const mcpRegistryRoutes = new Hono<{ Variables: Variables }>();

// ─── 工具函数 ───────────────────────────────────────────────

function zodError(e: import('zod').ZodError): { error: string } {
  return { error: e.issues.map((i) => i.message).join('; ') };
}

/** 把 DB 行序列化为 API 输出（inputSchema/httpBinding 反序列化为对象）。 */
function toolToApi(
  row: ReturnType<typeof getRegistryTool> & {},
  serverName: string,
) {
  if (!row) return null;
  let inputSchema: unknown = {};
  let httpBinding: unknown = {};
  try { inputSchema = JSON.parse(row.input_schema); } catch { /* keep default */ }
  try { httpBinding = JSON.parse(row.http_binding); } catch { /* keep default */ }
  return {
    id: row.id,
    server_id: row.server_id,
    name: row.name,
    description: row.description,
    enabled: row.enabled === 1,
    inputSchema,
    httpBinding,
    mcpName: `${sanitizeServerPrefix(serverName)}__${row.name}`,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function serverToApi(row: ReturnType<typeof getRegistryServer> & {}, toolCount: number) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled === 1,
    tool_count: toolCount,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ─── REST: Server CRUD ─────────────────────────────────────

// GET /servers
mcpRegistryRoutes.get('/servers', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const servers = listRegistryServers(authUser.id);
  const result = servers.map((s) =>
    serverToApi(s, listRegistryToolsByServer(s.id, authUser.id).length),
  );
  return c.json({ servers: result });
});

// POST /servers
mcpRegistryRoutes.post('/servers', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const v = RegistryServerCreateSchema.safeParse(body);
  if (!v.success) return c.json(zodError(v.error), 400);
  const row = createRegistryServer(authUser.id, v.data);
  return c.json({ server: serverToApi(row, 0) });
});

// PATCH /servers/:id
mcpRegistryRoutes.patch('/servers/:id', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const v = RegistryServerUpdateSchema.safeParse(body);
  if (!v.success) return c.json(zodError(v.error), 400);
  const row = updateRegistryServer(id, authUser.id, v.data);
  if (!row) return c.json({ error: 'Server not found' }, 404);
  return c.json({
    server: serverToApi(row, listRegistryToolsByServer(id, authUser.id).length),
  });
});

// DELETE /servers/:id
mcpRegistryRoutes.delete('/servers/:id', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const ok = deleteRegistryServer(id, authUser.id);
  if (!ok) return c.json({ error: 'Server not found' }, 404);
  return c.json({ success: true });
});

// ─── REST: Tool CRUD ───────────────────────────────────────

// GET /servers/:id/tools
mcpRegistryRoutes.get('/servers/:id/tools', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const server = getRegistryServer(id, authUser.id);
  if (!server) return c.json({ error: 'Server not found' }, 404);
  const tools = listRegistryToolsByServer(id, authUser.id);
  return c.json({
    tools: tools.map((t) => toolToApi(t, server.name)).filter(Boolean),
  });
});

// POST /servers/:id/tools
mcpRegistryRoutes.post('/servers/:id/tools', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const server = getRegistryServer(id, authUser.id);
  if (!server) return c.json({ error: 'Server not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const v = RegistryToolCreateSchema.safeParse(body);
  if (!v.success) return c.json(zodError(v.error), 400);
  const row = createRegistryTool(authUser.id, {
    server_id: id,
    name: v.data.name,
    description: v.data.description ?? '',
    input_schema: JSON.stringify(v.data.inputSchema),
    http_binding: JSON.stringify(v.data.httpBinding),
    enabled: v.data.enabled,
  });
  if (!row) return c.json({ error: 'Server not found' }, 404);
  return c.json({ tool: toolToApi(row, server.name) });
});

// PATCH /tools/:id
mcpRegistryRoutes.patch('/tools/:id', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const v = RegistryToolUpdateSchema.safeParse(body);
  if (!v.success) return c.json(zodError(v.error), 400);
  const existing = getRegistryTool(id, authUser.id);
  if (!existing) return c.json({ error: 'Tool not found' }, 404);
  const server = getRegistryServer(existing.server_id, authUser.id);
  const row = updateRegistryTool(id, authUser.id, {
    ...(v.data.name !== undefined ? { name: v.data.name } : {}),
    ...(v.data.description !== undefined ? { description: v.data.description ?? '' } : {}),
    ...(v.data.inputSchema !== undefined ? { input_schema: JSON.stringify(v.data.inputSchema) } : {}),
    ...(v.data.httpBinding !== undefined ? { http_binding: JSON.stringify(v.data.httpBinding) } : {}),
    ...(v.data.enabled !== undefined ? { enabled: v.data.enabled } : {}),
  });
  if (!row) return c.json({ error: 'Tool not found' }, 404);
  return c.json({ tool: toolToApi(row, server?.name ?? '') });
});

// DELETE /tools/:id
mcpRegistryRoutes.delete('/tools/:id', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const ok = deleteRegistryTool(id, authUser.id);
  if (!ok) return c.json({ error: 'Tool not found' }, 404);
  return c.json({ success: true });
});

// ─── REST: 试调 ────────────────────────────────────────────

// POST /tools/:id/test  body: { arguments: {...} }
mcpRegistryRoutes.post('/tools/:id/test', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const row = getRegistryTool(id, authUser.id);
  if (!row) return c.json({ error: 'Tool not found' }, 404);
  const server = getRegistryServer(row.server_id, authUser.id);
  const tool = parseRegistryToolRow(row, server?.name ?? '');
  if (!tool) return c.json({ error: 'Tool binding is corrupt' }, 500);
  const body = await c.req.json().catch(() => ({}));
  const args = (body && typeof body === 'object' && 'arguments' in body
    ? (body as { arguments: unknown }).arguments
    : body) as Record<string, unknown>;
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return c.json({ error: 'arguments must be an object' }, 400);
  }
  const result = await executeRegistryTool(tool, args);
  return c.json({
    isError: result.isError === true,
    content: result.content,
  });
});

// ─── REST: OpenAPI 导入 ────────────────────────────────────

// POST /import-openapi/preview  body: { serverId, source:'json'|'url', content, includePaths? }
mcpRegistryRoutes.post('/import-openapi/preview', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const { serverId, source, content, includePaths, baseUrl } = body as {
    serverId?: string;
    source?: string;
    content?: string;
    includePaths?: string[];
    baseUrl?: string;
  };
  if (!serverId) return c.json({ error: 'serverId is required' }, 400);
  const server = getRegistryServer(serverId, authUser.id);
  if (!server) return c.json({ error: 'Server not found' }, 404);

  let docText: string;
  if (source === 'url') {
    if (!content || typeof content !== 'string') {
      return c.json({ error: 'content (URL) is required for source=url' }, 400);
    }
    try {
      const resp = await fetch(content, { signal: AbortSignal.timeout(15000) });
      docText = await resp.text();
    } catch (err) {
      return c.json({
        error: `Failed to fetch OpenAPI doc: ${err instanceof Error ? err.message : String(err)}`,
      }, 400);
    }
  } else {
    if (!content || typeof content !== 'string') {
      return c.json({ error: 'content (JSON text) is required' }, 400);
    }
    docText = content;
  }

  const parsed = parseOpenApi(docText, { baseUrl, includePaths });
  if (parsed.error) return c.json({ error: parsed.error }, 400);
  return c.json({ tools: parsed.tools });
});

// POST /import-openapi/confirm  body: { serverId, tools: CandidateTool[] }
mcpRegistryRoutes.post('/import-openapi/confirm', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const { serverId, tools } = body as { serverId?: string; tools?: unknown[] };
  if (!serverId) return c.json({ error: 'serverId is required' }, 400);
  const server = getRegistryServer(serverId, authUser.id);
  if (!server) return c.json({ error: 'Server not found' }, 404);
  if (!Array.isArray(tools)) return c.json({ error: 'tools must be an array' }, 400);

  const created: unknown[] = [];
  const errors: { index: number; error: string }[] = [];
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i];
    // 复用 create 校验：以 RegistryToolCreateSchema 校验单条
    const v = RegistryToolCreateSchema.safeParse(t);
    if (!v.success) {
      errors.push({ index: i, error: v.error.issues.map((e) => e.message).join('; ') });
      continue;
    }
    const row = createRegistryTool(authUser.id, {
      server_id: serverId,
      name: v.data.name,
      description: v.data.description ?? '',
      input_schema: JSON.stringify(v.data.inputSchema),
      http_binding: JSON.stringify(v.data.httpBinding),
    });
    if (row) created.push(toolToApi(row, server.name));
  }
  return c.json({ created: created.length, errors, tools: created });
});

// ─── REST: token ────────────────────────────────────────────

// GET /token  — 查看（隐式创建）
mcpRegistryRoutes.get('/token', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const token = getOrCreateRegistryToken(authUser.id);
  return c.json({ token });
});

// POST /token/rotate  — 轮换
mcpRegistryRoutes.post('/token/rotate', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const token = rotateRegistryToken(authUser.id);
  return c.json({ token });
});

// ─── MCP streamable-HTTP 端点 ──────────────────────────────
//
// POST /mcp  — JSON-RPC 2.0 over HTTP
//   Authorization: Bearer <registryToken>
//   支持：initialize / notifications/initialized / tools/list / tools/call

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function jsonRpcResponse(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function jsonRpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown,
) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

/** 从请求解析 registry token → userId。 */
function resolveUserFromRequest(c: Context<{ Variables: Variables }>): string | null {
  const auth = c.req.header('Authorization') || c.req.header('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return null;
  return getUserIdByRegistryToken(m[1].trim());
}

type Ctx = Context<{ Variables: Variables }>;

async function handleMcp(c: Ctx, req: JsonRpcRequest) {
  // 鉴权
  const userId = resolveUserFromRequest(c);
  if (!userId) {
    return c.json(jsonRpcError(req.id, -32001, 'Unauthorized: invalid or missing Bearer token'), 401);
  }

  switch (req.method) {
    case 'initialize': {
      const sessionId = crypto.randomUUID();
      const body = jsonRpcResponse(req.id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'deepthink-registry', version: '1.0.0' },
      });
      c.header('Mcp-Session-Id', sessionId);
      return c.json(body);
    }
    case 'notifications/initialized': {
      // 通知（无 id）→ 202 Accepted
      return c.body(null, 202);
    }
    case 'tools/list': {
      const rows = listEnabledRegistryTools(userId);
      // 一次性取 server 名（按 server_id 分组）
      const serverNameCache = new Map<string, string>();
      const tools = rows.map((r) => {
        let sname = serverNameCache.get(r.server_id);
        if (!sname) {
          const s = getRegistryServer(r.server_id, userId);
          sname = s?.name ?? 'server';
          serverNameCache.set(r.server_id, sname);
        }
        const prefix = sanitizeServerPrefix(sname);
        let inputSchema: unknown = { type: 'object' };
        try { inputSchema = JSON.parse(r.input_schema); } catch { /* keep default */ }
        return {
          name: `${prefix}__${r.name}`,
          description: r.description || `${prefix}.${r.name}`,
          inputSchema,
        };
      });
      return c.json(jsonRpcResponse(req.id, { tools }));
    }
    case 'tools/call': {
      const name = req.params?.['name'] as string | undefined;
      const args = (req.params?.['arguments'] ?? {}) as Record<string, unknown>;
      if (!name) {
        return c.json(jsonRpcError(req.id, -32602, "Missing 'name' in tools/call params"), 200);
      }
      // __ 拆分：serverPrefix__toolName
      const sepIdx = name.indexOf('__');
      if (sepIdx < 0) {
        return c.json(jsonRpcError(req.id, -32602, `Unknown tool: ${name}`), 200);
      }
      const prefix = name.slice(0, sepIdx);
      const toolName = name.slice(sepIdx + 2);
      const rows = listEnabledRegistryTools(userId);
      const row = rows.find((r) => {
        const sname = getRegistryServer(r.server_id, userId)?.name ?? 'server';
        return sanitizeServerPrefix(sname) === prefix && r.name === toolName;
      });
      if (!row) {
        return c.json(
          jsonRpcError(req.id, -32602, `Tool not found or not enabled: ${name}`),
          200,
        );
      }
      const sname = getRegistryServer(row.server_id, userId)?.name ?? 'server';
      const tool = parseRegistryToolRow(row, sname);
      if (!tool) {
        return c.json(jsonRpcError(req.id, -32603, 'Tool binding is corrupt'), 200);
      }
      const result = await executeRegistryTool(tool, args);
      return c.json(
        jsonRpcResponse(req.id, {
          content: result.content,
          ...(result.isError ? { isError: true } : {}),
        }),
        200,
      );
    }
    default:
      return c.json(jsonRpcError(req.id, -32601, `Method not found: ${req.method}`), 200);
  }
}

mcpRegistryRoutes.all('/mcp', async (c) => {
  // GET：v1 不实现 SSE 推送通道，返回 405（SDK 应优雅降级）
  if (c.req.method === 'GET') {
    return c.body(null, 405);
  }
  if (c.req.method === 'DELETE') {
    // 会话关闭：无状态，直接 200
    return c.body(null, 200);
  }
  if (c.req.method !== 'POST') {
    return c.body(null, 405);
  }
  const ct = c.req.header('Content-Type') || '';
  if (!ct.includes('application/json') && !ct.includes('text/')) {
    return c.json(jsonRpcError(null, -32600, 'Invalid Request: expected JSON'), 400);
  }
  let req: JsonRpcRequest;
  try {
    req = (await c.req.json()) as JsonRpcRequest;
  } catch {
    return c.json(jsonRpcError(null, -32700, 'Parse error: invalid JSON'), 400);
  }
  if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return c.json(jsonRpcError(req?.id, -32600, 'Invalid Request'), 400);
  }
  try {
    return await handleMcp(c, req);
  } catch (err) {
    logger.error({ err, method: req.method }, 'MCP registry endpoint error');
    return c.json(
      jsonRpcError(req.id, -32603, 'Internal error'),
      200,
    );
  }
});

export default mcpRegistryRoutes;
