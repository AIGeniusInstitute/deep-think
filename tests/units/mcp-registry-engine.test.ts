import { describe, it, expect } from 'vitest';
import {
  executeRegistryTool,
  extractByPath,
  sanitizeServerPrefix,
  type RegistryTool,
} from '../../src/mcp-registry/engine.js';

// 本地 echo http server — 用 Node 内置 http 起，避免外部依赖
import http from 'node:http';

function startEcho(port: number): { server: http.Server; close: () => Promise<void> } {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url || '', `http://localhost:${port}`);
      if (url.pathname === '/status') {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ err: 'boom' }));
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        method: req.method,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: body ? JSON.parse(body) : null,
        path: url.pathname,
      }));
    });
  });
  return {
    server,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const PORT = 18923;
const BASE = `http://localhost:${PORT}`;

let echo: ReturnType<typeof startEcho>;
beforeAll(async () => { echo = startEcho(PORT); await new Promise<void>(r => echo.server.listen(PORT, r)); });
afterAll(async () => { await echo.close(); });

function mkTool(over: Partial<RegistryTool['httpBinding']> & Partial<Pick<RegistryTool, 'inputSchema' | 'description'>> = {}): RegistryTool {
  return {
    id: 't', serverId: 's', serverName: 'srv', name: 'demo',
    description: 'demo',
    inputSchema: { type: 'object', properties: {}, required: [], ...over.inputSchema },
    httpBinding: { method: 'GET', url: BASE, ...over },
  };
}

import { beforeAll, afterAll } from 'vitest';

describe('engine: extractByPath', () => {
  it('extracts nested object path', () => {
    expect(extractByPath({ a: { b: { c: 1 } } }, 'a.b.c')).toBe(1);
  });
  it('extracts array index via [n] and .n', () => {
    expect(extractByPath({ a: [{ b: 2 }] }, 'a[0].b')).toBe(2);
    expect(extractByPath({ a: [{ b: 2 }] }, 'a.0.b')).toBe(2);
  });
  it('returns undefined for missing', () => {
    expect(extractByPath({ a: 1 }, 'b.c')).toBeUndefined();
  });
});

describe('engine: sanitizeServerPrefix', () => {
  it('replaces illegal chars', () => {
    expect(sanitizeServerPrefix('weather-service!')).toBe('weather_service');
  });
  it('defaults to server when empty', () => {
    expect(sanitizeServerPrefix('---')).toBe('server');
  });
});

describe('engine: executeRegistryTool', () => {
  it('maps query params (AC5.1)', async () => {
    const t = mkTool({
      url: `${BASE}/q`,
      paramMapping: { query: { city: 'city', unit: 'u' } },
    });
    const r = await executeRegistryTool(t, { city: '北京', unit: 'celsius' });
    expect(r.isError).toBeFalsy();
    const text = r.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.query.city).toBe('北京');
    expect(parsed.query.u).toBe('celsius');
  });

  it('maps path params + url placeholder (AC5.1)', async () => {
    const t = mkTool({
      url: `${BASE}/p/{id}`,
      paramMapping: { path: { itemId: 'id' } },
    });
    const r = await executeRegistryTool(t, { itemId: '42' });
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.path).toBe('/p/42');
  });

  it('maps headers and injects authHeader without exposing to args (AC5.2)', async () => {
    const t = mkTool({
      url: `${BASE}/h`,
      paramMapping: { header: { trace: 'X-Trace' } },
      authHeader: { name: 'X-Api-Key', value: 'secret' },
    });
    const r = await executeRegistryTool(t, { trace: 'abc' });
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.headers['x-trace']).toBe('abc');
    expect(parsed.headers['x-api-key']).toBe('secret');
  });

  it('maps body fields for POST (AC5.1)', async () => {
    const t = mkTool({
      method: 'POST',
      url: `${BASE}/b`,
      paramMapping: { body: { title: 'title' } },
      bodyTemplate: { format: 'json' },
    });
    const r = await executeRegistryTool(t, { title: 'hello' });
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.method).toBe('POST');
    expect(parsed.body).toEqual({ format: 'json', title: 'hello' });
  });

  it('extracts response sub-tree via responseMapping.extract (AC5.3)', async () => {
    const t = mkTool({
      url: `${BASE}/r`,
      paramMapping: { query: { city: 'city' } },
      responseMapping: { extract: 'query.city' },
    });
    const r = await executeRegistryTool(t, { city: '北京' });
    // extract path points into the echo response object
    expect(r.content[0].text).toBe('北京');
  });

  it('maps 4xx HTTP to isError (AC5.4)', async () => {
    const t = mkTool({ url: `${BASE}/status` });
    const r = await executeRegistryTool(t, {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('HTTP 500');
  });

  it('missing required param → isError (AC5.1 validation)', async () => {
    const t = mkTool({
      url: `${BASE}/q`,
      paramMapping: { query: { city: 'city' } },
      inputSchema: { type: 'object', properties: { city: {} }, required: ['city'] },
    });
    const r = await executeRegistryTool(t, {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Missing required');
  });

  it('timeout triggers isError (AC5.5)', async () => {
    const slow = http.createServer((_req, res) => { setTimeout(() => res.end('{}'), 1000); });
    await new Promise<void>(r => slow.listen(18924, r));
    try {
      const t = mkTool({ url: 'http://localhost:18924/slow', timeoutMs: 200 });
      const r = await executeRegistryTool(t, {});
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain('timed out');
    } finally {
      await new Promise<void>(r => slow.close(() => r()));
    }
  });
});
