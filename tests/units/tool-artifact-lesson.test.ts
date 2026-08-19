import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-artifact-test-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../../src/config.js', async () => ({ STORE_DIR: tmpStoreDir, GROUPS_DIR: tmpGroupsDir }));
vi.mock('../../src/sdk-query.js', () => ({ sdkQuery: async () => 'mocked' }));

const { initDatabase, getDb } = await import('../../src/db.js');
const { captureToolArtifacts } = await import('../../src/autonomy/autonomy-learning.js');

beforeAll(() => {
  initDatabase();
  const db = getDb();
  // graph_runs has FK to graph_definitions; tests insert runs without the parent.
  db.exec('PRAGMA foreign_keys=OFF');
  // One graph_run + one graph_node_run + three trace_tool_calls.
  db.prepare(
    `INSERT INTO graph_runs
      (id, definition_id, definition_version, owner_user_id, group_folder, chat_jid,
       goal_text, status, state_json, max_parallel, total_input_tokens, total_output_tokens, total_cost_usd, started_at)
     VALUES ('run-f7', 'def-x', 1, 'u1', 'g', 'c1', '调研 X', 'completed', '{}', 4, 0, 0, 0, '2026-08-19T10:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO graph_node_runs
      (id, graph_run_id, node_id, node_type, status, attempt, started_at)
     VALUES (1, 'run-f7', 'n1', 'agent', 'completed', 1, '2026-08-19T10:00:00Z')`,
  ).run();
  const insTool = db.prepare(
    `INSERT INTO trace_tool_calls (graph_run_id, graph_node_id, tool_use_id, tool_name, input_json, output_json, status, started_at, ended_at)
     VALUES ('run-f7', 'n1', ?, ?, ?, ?, 'ok', '2026-08-19T10:00:00Z', '2026-08-19T10:00:01Z')`,
  );
  insTool.run('tu1', 'web_search', JSON.stringify({ query: 'node 22 fetch support' }), JSON.stringify({ text: 'Node 22 has native fetch' }));
  insTool.run('tu2', 'sandbox_run_code', JSON.stringify({ code: 'console.log(1)' }), JSON.stringify({ text: '1\n__EXIT__:0' }));
  insTool.run('tu3', 'web_fetch', JSON.stringify({ url: 'https://example.com/x' }), JSON.stringify({ text: 'Example page content' }));
  // A non-external tool that should NOT be archived.
  insTool.run('tu4', 'Read', JSON.stringify({ file_path: '/a.ts' }), JSON.stringify({ text: 'file contents' }));
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('captureToolArtifacts (F7)', () => {
  it('archives web_search / web_fetch / sandbox_run_code as perception/execution lessons (AC7.1.1/7.1.2)', () => {
    const n = captureToolArtifacts('run-f7');
    expect(n).toBe(3); // 3 external tools archived
    const db = getDb();
    const lessons = db.prepare(`SELECT capability, lesson_text FROM autonomy_lessons WHERE derived_from_run_ids LIKE '%run-f7%' ORDER BY id`).all() as { capability: string; lesson_text: string }[];
    expect(lessons.length).toBe(3);
    // web_search + web_fetch → perception; sandbox_run_code → execution
    const caps = lessons.map((l) => l.capability).sort();
    expect(caps).toEqual(['execution', 'perception', 'perception']);
    // lesson text carries query/url + excerpt
    const joined = lessons.map((l) => l.lesson_text).join('\n');
    expect(joined).toContain('node 22 fetch support');
    expect(joined).toContain('Node 22 has native fetch');
    expect(joined).toContain('https://example.com/x');
    expect(joined).toContain('run:run-f7');
    // Read tool not archived
    expect(joined).not.toContain('file contents');
  });

  it('is idempotent — second capture archives 0 new (AC7 dedup)', () => {
    const n = captureToolArtifacts('run-f7');
    expect(n).toBe(0);
  });

  it('returns 0 for a non-existent run (no trace_tool_calls)', () => {
    expect(captureToolArtifacts('run-does-not-exist')).toBe(0);
  });
});
