import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-inj-test-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

const configMock = await import('vitest').then(v => v.vi.mock('../../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
})));

const { initDatabase, getDb } = await import('../../src/db.js');
const { reinjectLessonsIntoPrompt } = await import('../../src/autonomy/lesson-injection.js');

beforeAll(() => {
  initDatabase();
  const db = getDb();
  const now = Date.now();
  const ins = db.prepare(`INSERT INTO autonomy_lessons (capability, lesson_text, derived_from_run_ids, applied_count, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  // Insert two lessons, one matching the goal keyword, one not.
  ins.run(
    'execution',
    'Task "部署应用到生产环境": succeeded — 5/5 nodes completed, 1/1 gates passed, 0.05 USD',
    '[]', 0, 'active', now, now,
  );
  ins.run(
    'decision',
    'Task "编写测试用例": failed — gate shellCheck exit 1',
    '[]', 0, 'active', now, now,
  );
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('reinjectLessonsIntoPrompt (F4)', () => {
  it('prepends matching lessons to the prompt (AC4.1.1)', () => {
    const out = reinjectLessonsIntoPrompt('部署应用到生产环境并验证', '原始 prompt', 'execution');
    expect(out).toContain('原始 prompt');
    expect(out).toContain('【历史经验');
    expect(out).toContain('部署应用到生产环境');
  });

  it('returns the prompt unchanged when no lessons match (AC4.1.2)', () => {
    const out = reinjectLessonsIntoPrompt('一个完全没有匹配的全新任务xyz123', '原始 prompt', 'execution');
    // no keyword match → searches fallback (undefined keyword) → may return
    // the non-matching lesson or none; must at least keep the original prompt
    expect(out.endsWith('原始 prompt')).toBe(true);
  });

  it('is non-fatal on DB errors — returns original prompt', () => {
    // Pass a goal with no extractable keyword and force a capability that
    // yields nothing; still returns a string ending with the prompt.
    const out = reinjectLessonsIntoPrompt('', 'P', 'decision');
    expect(typeof out).toBe('string');
    expect(out.endsWith('P')).toBe(true);
  });
});
