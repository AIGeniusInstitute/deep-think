// MCP 注册中心 — 集成测试（T6 协议合规 + T7 端到端 tools/call）
//
// 运行方式（须用临时 DATA_DIR，避免污染真实库）：
//   DEEPTHINK_DATA_DIR=/tmp/dt-reg-test npx vitest run tests/units/mcp-registry-integration.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import os from 'node:os';

// 保护：仅当 DEEPTHINK_DATA_DIR 指向临时目录时才运行，防止误跑污染真实库
const RUN = (process.env.DEEPTHINK_DATA_DIR || '').startsWith(os.tmpdir());
const maybe = RUN ? describe : describe.skip;
import fs from 'node:fs';
import path from 'node:path';

import { initDatabase, getDb,
  createRegistryServer, createRegistryTool,
  getOrCreateRegistryToken,
} from '../../src/db.js';
import mcpRegistryRoutes from '../../src/routes/mcp-registry.js';

const PORT = 18925;
const ECHO = `http://localhost:${PORT}`;

let server: http.Server;

function startEcho() {
  return http.createServer((req, res) => {
    const url = new URL(req.url || '', ECHO);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: { 'x-api-key': req.headers['x-api-key'] || null },
        body: body ? JSON.parse(body) : null,
        data: { current: { temp: 26, cond: '晴' } },
      }));
    });
  });
}

const userId = '11111111-1111-1111-1111-111111111111';
let token: string;

beforeAll(async () => {
  initDatabase();
  const db = getDb();
  // 插入最小 user 行（满足 FK）
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO users (id, username, password_hash, display_name, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(userId, 'reg_tester', 'x', 'Tester', 'member', 'active', now, now);

  token = getOrCreateRegistryToken(userId);
  const srv = createRegistryServer(userId, { name: 'echo-svc', description: 'echo' });
  createRegistryTool(userId, {
    server_id: srv.id,
    name: 'hello',
    description: '回显工具',
    input_schema: JSON.stringify({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    }),
    http_binding: JSON.stringify({
      method: 'GET',
      url: `${ECHO}/hi`,
      paramMapping: { query: { name: 'name' } },
      authHeader: { name: 'X-Api-Key', value: 'secret123' },
      responseMapping: { extract: 'data.current' },
      timeoutMs: 5000,
    }),
  });

  server = startEcho();
  await new Promise<void>((r) => server.listen(PORT, r));
});

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  // 清理临时 DB
  const dataDir = process.env.DEEPTHINK_DATA_DIR;
  if (dataDir && dataDir.startsWith(os.tmpdir())) {
    fs.rmSync(path.join(dataDir, 'db', 'messages.db'), { force: true });
  }
});

async function mcp(req: unknown) {
  const res = await mcpRegistryRoutes.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(req),
  });
  return { status: res.status, body: await res.json() };
}

maybe('MCP endpoint: protocol compliance (T6)', () => {
  it('initialize returns protocolVersion + capabilities + session id', async () => {
    const { status, body } = await mcp({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
    });
    expect(status).toBe(200);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result.protocolVersion).toBe('2025-06-18');
    expect(body.result.capabilities.tools.listChanged).toBe(true);
    expect(body.result.serverInfo.name).toBe('deepthink-registry');
  });

  it('notifications/initialized returns 202 (no response body)', async () => {
    const res = await mcpRegistryRoutes.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(res.status).toBe(202);
  });

  it('tools/list returns the registered tool with prefixed name', async () => {
    const { body } = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = body.result.tools;
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('echo_svc__hello');
    expect(tools[0].inputSchema.required).toContain('name');
  });

  it('tools/call executes HTTP + extraction and returns text content (T7 core)', async () => {
    const { body } = await mcp({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'echo_svc__hello', arguments: { name: 'Alice' } },
    });
    expect(body.result.content[0].type).toBe('text');
    // extract path data.current → {"temp":26,"cond":"晴"}
    const text = body.result.content[0].text;
    expect(text).toContain('26');
    expect(text).toContain('晴');
    expect(body.result.isError).toBeFalsy();
  });

  it('rejects request without Bearer token (401, AC6.5)', async () => {
    const res = await mcpRegistryRoutes.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  it('unknown tool → INVALID_PARAMS error', async () => {
    const { body } = await mcp({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'nope__missing', arguments: {} },
    });
    expect(body.error.code).toBe(-32602);
  });

  it('unknown method → -32601', async () => {
    const { body } = await mcp({
      jsonrpc: '2.0', id: 5, method: 'foo/bar',
    });
    expect(body.error.code).toBe(-32601);
  });
});
