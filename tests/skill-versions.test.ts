/**
 * skill_versions DB layer tests (v58 — skill version history / rollback).
 */
import { beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-ver-'));
fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
fs.mkdirSync(path.join(tmpDir, 'groups'), { recursive: true });

vi.mock('../src/config.js', async () => ({
  STORE_DIR: path.join(tmpDir, 'db'),
  GROUPS_DIR: path.join(tmpDir, 'groups'),
}));

const { initDatabase } = await import('../src/db.js');
const {
  createSkillVersion,
  listSkillVersions,
  getSkillVersion,
} = await import('../src/db.js');

beforeAll(() => initDatabase());

describe('skill_versions (v58)', () => {
  test('create auto-increments version', () => {
    const v1 = createSkillVersion({ skillId: 'demo', userId: 'u1', content: '# v1\n', notes: 'first' });
    const v2 = createSkillVersion({ skillId: 'demo', userId: 'u1', content: '# v2\n' });
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
  });

  test('list returns newest first', () => {
    createSkillVersion({ skillId: 'listdemo', userId: 'u2', content: 'a' });
    createSkillVersion({ skillId: 'listdemo', userId: 'u2', content: 'b' });
    const vs = listSkillVersions('listdemo', 'u2');
    expect(vs[0].version).toBe(2);
    expect(vs[1].version).toBe(1);
  });

  test('get by version', () => {
    const created = createSkillVersion({ skillId: 'getdemo', userId: 'u3', content: 'x' });
    const got = getSkillVersion('getdemo', 'u3', created.version);
    expect(got).not.toBeNull();
    expect(got!.content).toBe('x');
    expect(got!.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('versions are isolated per user', () => {
    createSkillVersion({ skillId: 'shared', userId: 'a', content: 'a-content' });
    createSkillVersion({ skillId: 'shared', userId: 'b', content: 'b-content' });
    expect(listSkillVersions('shared', 'a')).toHaveLength(1);
    expect(listSkillVersions('shared', 'b')).toHaveLength(1);
    expect(getSkillVersion('shared', 'a', 1)!.content).toBe('a-content');
    expect(getSkillVersion('shared', 'b', 1)!.content).toBe('b-content');
  });

  test('missing version returns null', () => {
    expect(getSkillVersion('nope', 'u', 99)).toBeNull();
  });
});
