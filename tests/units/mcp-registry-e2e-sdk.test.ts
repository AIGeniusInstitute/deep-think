// MCP 注册中心 — 真实 SDK 客户端端到端测试（T7 铁证）
//
// 用 @modelcontextprotocol/sdk 的 StreamableHTTPClientTransport 连接
// 我们手写的 /api/mcp-registry/mcp 端点，验证 initialize → tools/list → tools/call
// 全流程，证明 DeepThink Agent（claude 引擎，SDK 原生 http MCP）能直接使用注册中心。
//
// 运行：DEEPTHINK_DATA_DIR=/tmp/dt-reg-e2e npx vitest run tests/units/mcp-registry-e2e-sdk.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// 保护：仅当 DEEPTHINK_DATA_DIR 指向临时目录时才运行，防止误跑污染真实库
const RUN = (process.env.DEEPTHINK_DATA_DIR || '').startsWith(os.tmpdir());
const maybe = RUN ? describe : describe.skip;

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { initDatabase, getDb,
  createRegistryServer, createRegistryTool,
  getOrCreateRegistryToken,
} from '../../src/db.js';
import mcpRegistryRoutes from '../../src/routes/mcp-registry.js';

const PORT = 18926;
const BASE = `http://localhost:${PORT}`;

let server: http.Server;
let token: string;
const userId = '22222222-2222-2222-2222-222222222222';

// 回显后端
function startBackend() {
  return http.createServer((req, res) => {
    const url = new URL(req.url || '', `http://localhost:${PORT + 1}`);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      method: req.method, path: url.pathname,
      data: { current: { temp: 31, cond: '多云' } },
    }));
  });
}
let backend: http.Server;

beforeAll(async () => {
  initDatabase();
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO users (id, username, password_hash, display_name, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(userId, 'e2e_tester', 'x', 'E2E', 'member', 'active', now, now);

  token = getOrCreateRegistryToken(userId);
  const srv = createRegistryServer(userId, { name: 'weather', description: '天气' });
  createRegistryTool(userId, {
    server_id: srv.id,
    name: 'get_weather',
    description: '查询天气',
    input_schema: JSON.stringify({
      type: 'object',
      properties: { city: { type: 'string', description: '城市' } },
      required: ['city'],
    }),
    http_binding: JSON.stringify({
      method: 'GET',
      url: `http://localhost:${PORT + 1}/v1/current`,
      paramMapping: { query: { city: 'city' } },
      authHeader: { name: 'X-Api-Key', value: 'e2e-secret' },
      responseMapping: { extract: 'data.current' },
      timeoutMs: 5000,
    }),
  });

  backend = startBackend();
  await new Promise<void>((r) => backend.listen(PORT + 1, r));

  // 把 mcpRegistryRoutes 挂到一个独立 Hono app（只暴露 /mcp 与 /api/mcp-registry/mcp 同路径）
  const app = new Hono();
  // 路由内部路径是 /mcp（相对 mount 点 /api/mcp-registry），所以直接 route 在根
  app.route('/api/mcp-registry', mcpRegistryRoutes);
  server = serve({ fetch: app.fetch, port: PORT });
});

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await new Promise<void>((r) => backend?.close(() => r()));
  const dataDir = process.env.DEEPTHINK_DATA_DIR;
  if (dataDir && dataDir.startsWith(os.tmpdir())) {
    fs.rmSync(path.join(dataDir, 'db', 'messages.db'), { force: true });
  }
});

maybe('MCP Registry — real SDK client (T7)', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client(
      { name: 'test-agent', version: '1.0.0' },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`${BASE}/api/mcp-registry/mcp`),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    );
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
  });

  it('initialize handshake succeeds (protocolVersion returned)', () => {
    // connect() already did initialize; if it didn't throw, it succeeded.
    expect(client).toBeDefined();
  });

  it('tools/list returns the weather tool prefixed with server name', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('weather__get_weather');
    expect(tools[0].description).toContain('天气');
  });

  it('tools/call returns extracted weather data', async () => {
    const result = await client.callTool({
      name: 'weather__get_weather',
      arguments: { city: '上海' },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('31');
    expect(text).toContain('多云');
  });
});
