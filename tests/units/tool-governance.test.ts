import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-gov-test-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config.js')>();
  return {
    ...actual,
    STORE_DIR: tmpStoreDir,
    GROUPS_DIR: tmpGroupsDir,
    DATA_DIR: tmpDir,
  };
});

const {
  initDatabase,
  createRegistryServer,
  createRegistryTool,
  getRegistryTool,
  updateRegistryTool,
  getOrCreateRegistryToken,
  rotateRegistryToken,
  getUserIdByRegistryToken,
  migrateToolGovernanceV60,
  listToolCallAuditLog,
  listEnabledRegistryTools,
  createUser,
} = await import('../../src/db.js');
const {
  executeRegistryTool,
  parseRegistryToolRow,
} = await import('../../src/mcp-registry/engine.js');
const {
  resolveSideEffect,
  inferSideEffect,
  hashArgs,
} = await import('../../src/mcp-registry/governance.js');
const {
  checkRateLimit,
  _resetRateLimit,
} = await import('../../src/mcp-registry/rate-limit.js');
const {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  hashToken,
} = await import('../../src/mcp-registry/crypto.js');

const dbPath = path.join(tmpStoreDir, 'messages.db');
let probeDb: InstanceType<typeof Database>;

beforeAll(() => {
  initDatabase();
  createUser({
    id: USER,
    username: 'toolgov-tester',
    password_hash: 'x',
    display_name: 'Tester',
    role: 'admin',
    status: 'active',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  probeDb = new Database(dbPath);
});

afterAll(() => {
  if (probeDb) probeDb.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const USER = 'test-user';

function makeServer(name = 'svc'): string {
  return createRegistryServer(USER, { name, description: '' }).id;
}

function makeTool(serverId: string, opts: {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  sideEffect?: 'read' | 'write' | 'admin';
  authHeader?: { name: string; value: string };
} = {}): string {
  const { method = 'GET', sideEffect, authHeader } = opts;
  const row = createRegistryTool(USER, {
    server_id: serverId,
    name: `t_${Math.random().toString(36).slice(2, 8)}`,
    description: '',
    input_schema: JSON.stringify({ type: 'object', properties: {}, required: [] }),
    http_binding: JSON.stringify({
      method,
      url: 'https://example.invalid/api',
      ...(authHeader ? { authHeader } : {}),
    }),
    side_effect: sideEffect ?? resolveSideEffect(null, method),
  })!;
  return row.id;
}

// ─── F1 副作用分级 ──────────────────────────────────────────
describe('F1 side-effect classification', () => {
  test('TC1: GET 工具不传 sideEffect → DB read', () => {
    const srv = makeServer('s1');
    const id = makeTool(srv, { method: 'GET' });
    const row = probeDb.prepare('SELECT side_effect FROM mcp_registry_tools WHERE id=?').get(id) as { side_effect: string };
    expect(row.side_effect).toBe('read');
  });

  test('TC2: DELETE 工具不传 sideEffect → admin', () => {
    const srv = makeServer('s2');
    const id = makeTool(srv, { method: 'DELETE' });
    const row = probeDb.prepare('SELECT side_effect FROM mcp_registry_tools WHERE id=?').get(id) as { side_effect: string };
    expect(row.side_effect).toBe('admin');
  });

  test('TC3: 显式 sideEffect=write + method=GET → write', () => {
    const srv = makeServer('s3');
    const id = makeTool(srv, { method: 'GET', sideEffect: 'write' });
    const row = probeDb.prepare('SELECT side_effect FROM mcp_registry_tools WHERE id=?').get(id) as { side_effect: string };
    expect(row.side_effect).toBe('write');
  });

  test('TC4: PATCH 更新 sideEffect=admin 生效', () => {
    const srv = makeServer('s4');
    const id = makeTool(srv, { method: 'GET' });
    updateRegistryTool(id, USER, { side_effect: 'admin' });
    const row = probeDb.prepare('SELECT side_effect FROM mcp_registry_tools WHERE id=?').get(id) as { side_effect: string };
    expect(row.side_effect).toBe('admin');
  });

  test('TC5: resolveSideEffect 推断逻辑', () => {
    expect(inferSideEffect('GET')).toBe('read');
    expect(inferSideEffect('POST')).toBe('write');
    expect(inferSideEffect('DELETE')).toBe('admin');
    expect(resolveSideEffect(null, 'PUT')).toBe('write');
    expect(resolveSideEffect('read', 'DELETE')).toBe('read'); // 显式优先
    expect(resolveSideEffect(undefined, undefined)).toBe('read'); // 最保守
  });
});

// ─── F2 幂等键 ──────────────────────────────────────────────
describe('F2 idempotency', () => {
  let fetchCount: number;
  beforeAll(() => {
    _resetRateLimit();
    fetchCount = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCount++;
      return new Response(JSON.stringify({ ok: true, n: fetchCount }), { status: 200 });
    }) as any;
  });

  test('TC7: 写工具 + 同 key 两次 → 上游 1 次 + 回放', async () => {
    fetchCount = 0;
    const srv = makeServer('idem1');
    const id = makeTool(srv, { method: 'POST' });
    const row = getRegistryTool(id, USER)!;
    const tool = parseRegistryToolRow(row, 'idem1')!;
    const ctx = { userId: USER, requestId: 'r1', idempotencyKey: 'K1' };
    const r1 = await executeRegistryTool(tool, { x: 1 }, ctx);
    const r2 = await executeRegistryTool(tool, { x: 1 }, ctx);
    expect(fetchCount).toBe(1);
    expect(r2.idempotentReplay).toBe(true);
    expect(r1.idempotentReplay).not.toBe(true);
  });

  test('TC8: read 工具 + 同 key 两次 → 上游 2 次', async () => {
    fetchCount = 0;
    const srv = makeServer('idem2');
    const id = makeTool(srv, { method: 'GET' });
    const row = getRegistryTool(id, USER)!;
    const tool = parseRegistryToolRow(row, 'idem2')!;
    const ctx = { userId: USER, requestId: 'r2', idempotencyKey: 'K2' };
    await executeRegistryTool(tool, {}, ctx);
    await executeRegistryTool(tool, {}, ctx);
    expect(fetchCount).toBe(2);
  });

  test('TC9: 写工具失败 + 同 key 再调 → 重试（上游 2 次）', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response('boom', { status: 500 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any;
    const srv = makeServer('idem3');
    const id = makeTool(srv, { method: 'POST' });
    const row = getRegistryTool(id, USER)!;
    const tool = parseRegistryToolRow(row, 'idem3')!;
    const ctx = { userId: USER, requestId: 'r3', idempotencyKey: 'K3' };
    const r1 = await executeRegistryTool(tool, {}, ctx);
    expect(r1.isError).toBe(true);
    const r2 = await executeRegistryTool(tool, {}, ctx);
    expect(calls).toBe(2);
    expect(r2.isError).not.toBe(true);
  });
});

// ─── F3 调用审计 ────────────────────────────────────────────
describe('F3 audit log', () => {
  beforeAll(() => {
    _resetRateLimit();
    globalThis.fetch = vi.fn(async () => new Response('ok', { status: 200 })) as any;
  });

  test('TC10: 成功调用写 audit 行 success', async () => {
    const srv = makeServer('aud1');
    const id = makeTool(srv, { method: 'GET' });
    const row = getRegistryTool(id, USER)!;
    const tool = parseRegistryToolRow(row, 'aud1')!;
    await executeRegistryTool(tool, { q: 'a' }, { userId: USER, requestId: 'req-10' });
    const { rows } = listToolCallAuditLog({ toolId: id });
    expect(rows.length).toBeGreaterThan(0);
    const last = rows[0];
    expect(last.result_status).toBe('success');
    expect(last.http_status).toBe(200);
    expect(last.request_id).toBe('req-10');
  });

  test('TC11: 失败调用写 error', async () => {
    globalThis.fetch = vi.fn(async () => new Response('err', { status: 500 })) as any;
    const srv = makeServer('aud2');
    const id = makeTool(srv, { method: 'GET' });
    const row = getRegistryTool(id, USER)!;
    const tool = parseRegistryToolRow(row, 'aud2')!;
    await executeRegistryTool(tool, {}, { userId: USER, requestId: 'req-11' });
    const { rows } = listToolCallAuditLog({ toolId: id });
    expect(rows[0].result_status).toBe('error');
    expect(rows[0].http_status).toBe(500);
  });

  test('TC12: 相同参数 args_hash 一致', async () => {
    globalThis.fetch = vi.fn(async () => new Response('ok', { status: 200 })) as any;
    const srv = makeServer('aud3');
    const id = makeTool(srv, { method: 'GET' });
    const row = getRegistryTool(id, USER)!;
    const tool = parseRegistryToolRow(row, 'aud3')!;
    await executeRegistryTool(tool, { a: 1 }, { userId: USER, requestId: 'r12a' });
    await executeRegistryTool(tool, { a: 1 }, { userId: USER, requestId: 'r12b' });
    const { rows } = listToolCallAuditLog({ toolId: id });
    expect(rows[0].args_hash).toBe(rows[1].args_hash);
    // args_hash 不为空且不含原始参数值
    expect(rows[0].args_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test('hashArgs 不含原始参数', () => {
    const h = hashArgs({ secret: 'p@ssw0rd' });
    expect(h).not.toContain('p@ssw0rd');
  });
});

// ─── F4 限流 ────────────────────────────────────────────────
describe('F4 rate limit', () => {
  test('TC15: read 工具 120 次后第 121 次 429', () => {
    _resetRateLimit(USER);
    for (let i = 0; i < 120; i++) {
      const r = checkRateLimit(USER, 'tool-x', 'read');
      expect(r.allowed).toBe(true);
    }
    const r = checkRateLimit(USER, 'tool-x', 'read');
    expect(r.allowed).toBe(false);
  });

  test('TC16: write 工具 30 次后超限', () => {
    _resetRateLimit(USER + '-w');
    for (let i = 0; i < 30; i++) {
      expect(checkRateLimit(USER + '-w', 'tool-w', 'write').allowed).toBe(true);
    }
    expect(checkRateLimit(USER + '-w', 'tool-w', 'write').allowed).toBe(false);
  });

  test('TC17: 不同 user 互不影响', () => {
    _resetRateLimit();
    for (let i = 0; i < 120; i++) checkRateLimit('userA', 't', 'read');
    expect(checkRateLimit('userA', 't', 'read').allowed).toBe(false);
    expect(checkRateLimit('userB', 't', 'read').allowed).toBe(true);
  });
});

// ─── F5 凭据加密 ────────────────────────────────────────────
describe('F5 secret encryption', () => {
  test('TC18: 创建带 authHeader 工具 → DB 不含明文 value', () => {
    const srv = makeServer('enc1');
    const id = makeTool(srv, { method: 'GET', authHeader: { name: 'Authorization', value: 'Bearer secret-xyz' } });
    const row = probeDb.prepare('SELECT http_binding FROM mcp_registry_tools WHERE id=?').get(id) as { http_binding: string };
    expect(row.http_binding).not.toContain('secret-xyz');
    expect(row.http_binding).toContain('enc:v1:');
  });

  test('TC19: 引擎执行解密 authHeader 注入上游', async () => {
    _resetRateLimit();
    let receivedAuth = '';
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      receivedAuth = init?.headers?.Authorization ?? '';
      return new Response('ok', { status: 200 });
    }) as any;
    const srv = makeServer('enc2');
    const id = makeTool(srv, { method: 'GET', authHeader: { name: 'Authorization', value: 'Bearer secret-abc' } });
    const row = getRegistryTool(id, USER)!;
    const tool = parseRegistryToolRow(row, 'enc2')!;
    await executeRegistryTool(tool, {}, { userId: USER, requestId: 'r19' });
    expect(receivedAuth).toBe('Bearer secret-abc');
  });

  test('TC20: rotate token → DB 无明文；明文可鉴权', () => {
    const t = rotateRegistryToken(USER + '-rot');
    const row = probeDb.prepare('SELECT token, token_hash FROM mcp_registry_tokens WHERE user_id=?').get(USER + '-rot') as { token: string; token_hash: string };
    expect(row.token).not.toBe(t);
    expect(isEncrypted(row.token)).toBe(true);
    expect(row.token_hash).toBe(hashToken(t));
    expect(getUserIdByRegistryToken(t)).toBe(USER + '-rot');
  });

  test('TC21: 老明文 authHeader 迁移后加密', async () => {
    // 直接插入明文行
    const srv = makeServer('enc3');
    const id = makeTool(srv, { method: 'GET' });
    // 改成明文 authHeader
    probeDb.prepare('UPDATE mcp_registry_tools SET http_binding=? WHERE id=?').run(
      JSON.stringify({ method: 'GET', url: 'https://x.invalid', authHeader: { name: 'Authorization', value: 'plain-secret-999' } }),
      id,
    );
    // 运行迁移
    migrateToolGovernanceV60();
    const row = probeDb.prepare('SELECT http_binding FROM mcp_registry_tools WHERE id=?').get(id) as { http_binding: string };
    expect(row.http_binding).not.toContain('plain-secret-999');
    expect(row.http_binding).toContain('enc:v1:');
  });

  test('encryptSecret/decryptSecret 往返', () => {
    const c = encryptSecret('hello-world');
    expect(isEncrypted(c)).toBe(true);
    expect(c).not.toBe('hello-world');
    expect(decryptSecret(c)).toBe('hello-world');
    // 明文透传
    expect(decryptSecret('plaintext')).toBe('plaintext');
  });
});
