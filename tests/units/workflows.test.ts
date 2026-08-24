/**
 * Agent Workflow orchestration — backend unit tests (M7).
 *
 * Covers the schema v56 migration, user-scoped workflow CRUD (owner isolation /
 * 404-not-leak-existence), the workflow_builds detached-build lifecycle, and
 * the team-builder draft path (mode B "编排 Agent" — register only, no run).
 *
 * Mirrors the super-agent-team-trace test setup: point DEEPTHINK_DATA_DIR at a
 * temp dir before importing db.ts so initDatabase() creates an isolated db.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

// Set DEEPTHINK_DATA_DIR to an isolated temp dir BEFORE any src import resolves
// config.ts (which reads the env at module-load time). vi.hoisted is hoisted
// above imports, unlike a plain top-level assignment (ESM import hoisting would
// let config.ts see the real production DATA_DIR otherwise).
const tmpDir = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-test-'));
  process.env.DEEPTHINK_DATA_DIR = dir;
  return dir;
});

import {
  initDatabase,
  getDb,
  createGraphDefinition,
  getWorkflowDefinition,
  listWorkflowDefinitions,
  createWorkflowBuild,
  getWorkflowBuild,
  completeWorkflowBuild,
  failWorkflowBuild,
  type GraphDefinitionRow,
} from '../../src/db.js';
import { registerDefinition } from '../../src/graph-engineering/graph-registry.js';

beforeAll(() => {
  initDatabase();
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function makeDefRow(id: string, ownerUserId: string | null): GraphDefinitionRow {
  return {
    id,
    version: 1,
    parent_version_id: null,
    name: `wf-${id}`,
    description: 'test',
    nodes_json: '[]',
    edges_json: '[]',
    state_schema_json: null,
    budget_json: null,
    manifest_hash: `hash-${id}`,
    status: 'active',
    owner_user_id: ownerUserId,
  };
}

describe('Agent Workflow: schema v56 migration', () => {
  test('schema_version is 56', () => {
    const row = getDb()
      .prepare('SELECT value FROM router_state WHERE key = ?')
      .get('schema_version') as { value: string } | undefined;
    expect(row?.value).toBe('56');
  });

  test('graph_definitions has owner_user_id column', () => {
    const cols = getDb()
      .prepare("PRAGMA table_info('graph_definitions')")
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('owner_user_id');
  });

  test('workflow_builds table exists with expected columns', () => {
    const cols = getDb()
      .prepare("PRAGMA table_info('workflow_builds')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('id');
    expect(names).toContain('owner_user_id');
    expect(names).toContain('status');
    expect(names).toContain('definition_id');
    expect(names).toContain('plan_json');
    expect(names).toContain('error');
  });
});

describe('Agent Workflow: user-scoped workflow CRUD (TC1–TC4)', () => {
  test('TC1 — listWorkflowDefinitions returns own + shared, hides others', () => {
    createGraphDefinition(makeDefRow('wf-list-own', 'uA'));
    createGraphDefinition(makeDefRow('wf-list-shared', null)); // owner-less → visible to all
    createGraphDefinition(makeDefRow('wf-list-other', 'uB'));

    const a = listWorkflowDefinitions('uA').map((r) => r.id);
    expect(a).toContain('wf-list-own');
    expect(a).toContain('wf-list-shared');
    expect(a).not.toContain('wf-list-other');
  });

  test('TC2 — getWorkflowDefinition: owner sees, other user gets undefined (no leak)', () => {
    createGraphDefinition(makeDefRow('wf-get-own', 'uA'));
    expect(getWorkflowDefinition('wf-get-own', 'uA')).toBeDefined();
    expect(getWorkflowDefinition('wf-get-own', 'uB')).toBeUndefined();
  });

  test('TC3 — shared (owner-less) definition visible to any user', () => {
    createGraphDefinition(makeDefRow('wf-shared', null));
    expect(getWorkflowDefinition('wf-shared', 'uA')).toBeDefined();
    expect(getWorkflowDefinition('wf-shared', 'uB')).toBeDefined();
  });

  test('TC4 — update creates next version; latest version returned', () => {
    createGraphDefinition(makeDefRow('wf-ver', 'uA'));
    const v2 = makeDefRow('wf-ver', 'uA');
    v2.version = 2;
    v2.description = 'updated';
    createGraphDefinition(v2);
    const latest = getWorkflowDefinition('wf-ver', 'uA');
    expect(latest?.version).toBe(2);
    expect(latest?.description).toBe('updated');
  });
});

describe('Agent Workflow: workflow_builds lifecycle (TC5–TC7)', () => {
  beforeAll(() => {
    // workflow_builds.owner_user_id FK→users(id); seed the users our build rows
    // reference so the constraint holds.
    const now = Date.now();
    const stmt = getDb().prepare(
      `INSERT OR IGNORE INTO users (id, username, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    stmt.run('uA', 'uA', 'x', now, now);
    stmt.run('uB', 'uB', 'x', now, now);
  });

  test('TC5 — createWorkflowBuild starts in running state', () => {
    createWorkflowBuild({
      id: 'bld-1',
      owner_user_id: 'uA',
      group_folder: 'main',
      chat_jid: 'feishu:t1',
      goal_text: 'do X',
    });
    const b = getWorkflowBuild('bld-1');
    expect(b?.status).toBe('running');
    expect(b?.definition_id).toBeNull();
  });

  test('TC6 — completeWorkflowBuild writes plan + definitionId, marks completed', () => {
    createWorkflowBuild({
      id: 'bld-2',
      owner_user_id: 'uA',
      group_folder: 'main',
      chat_jid: 'feishu:t1',
      goal_text: 'do Y',
    });
    completeWorkflowBuild('bld-2', {
      plan_json: '{"members":[]}',
      definition_id: 'wf-built-2',
    });
    const b = getWorkflowBuild('bld-2');
    expect(b?.status).toBe('completed');
    expect(b?.definition_id).toBe('wf-built-2');
    expect(b?.plan_json).toBe('{"members":[]}');
    expect(b?.error).toBeNull();
  });

  test('TC7 — failWorkflowBuild writes error, marks failed', () => {
    createWorkflowBuild({
      id: 'bld-3',
      owner_user_id: 'uA',
      group_folder: 'main',
      chat_jid: 'feishu:t1',
      goal_text: 'do Z',
    });
    failWorkflowBuild('bld-3', 'decompose failed');
    const b = getWorkflowBuild('bld-3');
    expect(b?.status).toBe('failed');
    expect(b?.error).toBe('decompose failed');
  });
});

describe('Agent Workflow: registerDefinition + draft path (TC8)', () => {
  test('TC8 — registerDefinition stamps owner_user_id and returns version', () => {
    const def = {
      id: 'wf-reg-1',
      version: 1,
      name: 'reg',
      description: null,
      nodes: [{ id: 'n1', type: 'start' as const, title: 'start' }],
      edges: [],
      stateSchema: [],
    };
    const registered = registerDefinition(def, 'uA');
    expect(registered.version).toBe(1);
    expect(registered.hash).toBeTruthy();
    // owner isolation: uA sees it, uB does not
    expect(getWorkflowDefinition('wf-reg-1', 'uA')).toBeDefined();
    expect(getWorkflowDefinition('wf-reg-1', 'uB')).toBeUndefined();
  });
});
