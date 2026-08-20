/**
 * OPC（一人公司）模块测试。
 *
 * 覆盖：
 *   T2  创建公司——name 必填校验（空名 400）
 *   T3  创建公司成功 + 列表返回
 *   T5  成果分成合计 >100% 阻断
 *   T6  目标创建（默认 draft）
 *   T7/T8 回写 run_id + status=running（launch 终态回写路径）
 *   T9  删除公司级联删除目标
 *   T10 越权 GET/PUT/DELETE 返回 404（不泄露存在性）
 *   T12 createCompany→listCompanies
 *   T13 createObjective→deleteCompany 级联
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

const SHARED_TMP = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'deepthink-opc-test-'));
  process.env.DEEPTHINK_TEST_DATA_DIR = d;
  return d;
})();

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const dataDir = process.env.DEEPTHINK_TEST_DATA_DIR!;
  return {
    ...real,
    DATA_DIR: dataDir,
    GROUPS_DIR: path.join(dataDir, 'groups'),
    STORE_DIR: path.join(dataDir, 'db'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: process.env.DEEPTHINK_TEST_USER_ID ?? 'alice',
      username: 'alice',
      role: 'member',
      permissions: [],
    });
    return next();
  },
}));

const opcRoutesModule = await import('../src/routes/opc.js');
const db = await import('../src/db.js');
import Database from 'better-sqlite3';

const opcRoutes = opcRoutesModule.opcRoutes;

function asUser(userId: string): void {
  process.env.DEEPTHINK_TEST_USER_ID = userId;
}

const dbPath = path.join(SHARED_TMP, 'db', 'messages.db');

beforeAll(() => {
  fs.mkdirSync(path.join(SHARED_TMP, 'db'), { recursive: true });
  fs.mkdirSync(path.join(SHARED_TMP, 'groups'), { recursive: true });
  db.initDatabase();
});

afterEach(() => {
  delete process.env.DEEPTHINK_TEST_USER_ID;
  // 清表，避免用例间干扰。
  const wb = new Database(dbPath);
  wb.exec('DELETE FROM opc_objectives; DELETE FROM opc_companies;');
  wb.close();
});

afterAll(() => {
  fs.rmSync(SHARED_TMP, { recursive: true, force: true });
});

async function createCompany(
  body: Record<string, unknown>,
  user = 'alice',
): Promise<{ id: string; status: number; json: any }> {
  asUser(user);
  const res = await opcRoutes.request('/companies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { id: res.status === 201 ? json.company.id : '', status: res.status, json };
}

describe('OPC 公司 CRUD', () => {
  test('T2 名称缺失返回 400', async () => {
    const { status, json } = await createCompany({ name: '' });
    expect(status).toBe(400);
    expect(json.error).toBe('invalid_body');
  });

  test('T3/T12 创建成功并出现在列表中', async () => {
    const { status, json } = await createCompany({ name: 'Acme OPC', scale_tier: 'mid' });
    expect(status).toBe(201);
    expect(json.company.name).toBe('Acme OPC');
    expect(json.company.scale_tier).toBe('mid');
    const listRes = await opcRoutes.request('/companies');
    const list = await listRes.json();
    expect(list.companies).toHaveLength(1);
    expect(list.companies[0].id).toBe(json.company.id);
  });

  test('T5 分成合计 >100% 阻断', async () => {
    const { status, json } = await createCompany({
      name: 'Split Co',
      revenue_share: [
        { name: 'Alice', ratio: 60 },
        { name: 'Bob', ratio: 60 },
      ],
    });
    expect(status).toBe(400);
    expect(json.error).toBe('revenue_share_exceeds_100');
  });

  test('T5b 分成合计 =100% 允许', async () => {
    const { status } = await createCompany({
      name: 'Exact Co',
      revenue_share: [
        { name: 'Alice', ratio: 50 },
        { name: 'Bob', ratio: 50 },
      ],
    });
    expect(status).toBe(201);
  });

  test('T4 局部更新公司字段', async () => {
    const { id } = await createCompany({ name: 'Edit Co' });
    asUser('alice');
    const res = await opcRoutes.request(`/companies/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scale_tier: 'small', vision: '成为领域第一' }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.company.scale_tier).toBe('small');
    expect(json.company.vision).toBe('成为领域第一');
    expect(json.company.name).toBe('Edit Co'); // 未传字段保持不变
  });
});

describe('OPC 目标 CRUD 与回写', () => {
  test('T6 创建目标默认 draft', async () => {
    const { id: companyId } = await createCompany({ name: 'Obj Co' });
    asUser('alice');
    const res = await opcRoutes.request(`/companies/${companyId}/objectives`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Q3 营收 10w', domain: '财务' }),
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.objective.status).toBe('draft');
    expect(json.objective.title).toBe('Q3 营收 10w');
  });

  test('T7/T8 回写 run_id + status=running（launch 终态回写）', async () => {
    const { id: companyId } = await createCompany({ name: 'Launch Co' });
    asUser('alice');
    const createRes = await opcRoutes.request(`/companies/${companyId}/objectives`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '代码生成流水线' }),
    });
    const obj = (await createRes.json()).objective;
    // launch 成功后前端回写
    const ok = await opcRoutes.request(`/objectives/${obj.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'running', run_id: 'run_123', team_build_id: 'tb_123' }),
    });
    expect(ok.status).toBe(200);
    const okJson = await ok.json();
    expect(okJson.objective.status).toBe('running');
    expect(okJson.objective.run_id).toBe('run_123');
    expect(okJson.objective.team_build_id).toBe('tb_123');

    // launch 失败回写 failed
    const fail = await opcRoutes.request(`/objectives/${obj.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'failed' }),
    });
    expect(fail.status).toBe(200);
    expect((await fail.json()).objective.status).toBe('failed');
  });

  test('T9/T13 删除公司级联删除目标', async () => {
    const { id: companyId } = await createCompany({ name: 'Cascade Co' });
    asUser('alice');
    await opcRoutes.request(`/companies/${companyId}/objectives`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '目标A' }),
    });
    // 直接验证 DB 层级联
    const objsBefore = db.listOpcObjectivesByCompany(companyId);
    expect(objsBefore).toHaveLength(1);
    db.deleteOpcCompany(companyId);
    expect(db.getOpcCompany(companyId)).toBeUndefined();
    expect(db.listOpcObjectivesByCompany(companyId)).toHaveLength(0);
  });
});

describe('T10 越权隔离', () => {
  test('用户 B 访问用户 A 的公司返回 404', async () => {
    const { id: companyId } = await createCompany({ name: 'A 的公司' }, 'alice');
    asUser('bob');
    const get = await opcRoutes.request('/companies');
    const list = await get.json();
    expect(list.companies.find((c: any) => c.id === companyId)).toBeUndefined();

    const put = await opcRoutes.request(`/companies/${companyId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'hacked' }),
    });
    expect(put.status).toBe(404);

    const del = await opcRoutes.request(`/companies/${companyId}`, { method: 'DELETE' });
    expect(del.status).toBe(404);

    const objs = await opcRoutes.request(`/companies/${companyId}/objectives`);
    expect(objs.status).toBe(404);
  });

  test('用户 B 越权 PUT/DELETE 用户 A 的目标返回 404', async () => {
    const { id: companyId } = await createCompany({ name: 'A2' }, 'alice');
    asUser('alice');
    const createRes = await opcRoutes.request(`/companies/${companyId}/objectives`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'A 的目标' }),
    });
    const objId = (await createRes.json()).objective.id;

    asUser('bob');
    const put = await opcRoutes.request(`/objectives/${objId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });
    expect(put.status).toBe(404);

    const del = await opcRoutes.request(`/objectives/${objId}`, { method: 'DELETE' });
    expect(del.status).toBe(404);
  });
});
