import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Point DATA_DIR at a temp dir BEFORE importing db.ts so initDatabase() creates
// an isolated messages.db for this test run.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sat-trace-'));
process.env.DEEPTHINK_DATA_DIR = tmpDir;

import {
  initDatabase,
  upsertChatTraceNode,
  listGraphNodeTraceNodes,
  upsertTraceToolCall,
  listTraceToolCalls,
  getDb,
} from '../../src/db.js';
import { persistTraceNodeFromStreamEvent } from '../../src/chat-trace-persist.js';
import type { StreamEvent } from '../../src/stream-event.types.js';

beforeAll(() => {
  initDatabase();
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe('super-agent-team C1: schema v53 trace tables', () => {
  test('schema_version is 56', () => {
    const row = getDb()
      .prepare('SELECT value FROM router_state WHERE key = ?')
      .get('schema_version') as { value: string } | undefined;
    expect(row?.value).toBe('56');
  });

  test('chat_trace_nodes has graph columns', () => {
    const cols = getDb()
      .prepare("PRAGMA table_info('chat_trace_nodes')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('graph_run_id');
    expect(names).toContain('graph_node_id');
    expect(names).toContain('tool_name');
    expect(names).toContain('tool_use_id');
  });

  test('trace_tool_calls table exists', () => {
    const cols = getDb()
      .prepare("PRAGMA table_info('trace_tool_calls')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('tool_use_id');
    expect(names).toContain('input_json');
    expect(names).toContain('output_json');
  });
});

describe('super-agent-team C1: chat_trace_nodes graph linkage (TC12/TC14)', () => {
  const chatJid = 'feishu:test-trace';

  afterEach(() => {
    getDb().prepare('DELETE FROM chat_trace_nodes WHERE chat_jid = ?').run(chatJid);
  });

  test('upsert persists graph_run_id/graph_node_id and queryable by node', () => {
    upsertChatTraceNode({
      id: 1001,
      chat_jid: chatJid,
      node_type: 'turn',
      title: 'agent turn',
      started_at: '2026-07-22T00:00:00.000Z',
      graph_run_id: 'graph-run-1',
      graph_node_id: 'node-impl',
      tool_name: 'Bash',
      tool_use_id: 'toolu_1',
    });
    const rows = listGraphNodeTraceNodes('graph-run-1', 'node-impl');
    expect(rows).toHaveLength(1);
    expect(rows[0].graph_run_id).toBe('graph-run-1');
    expect(rows[0].graph_node_id).toBe('node-impl');
    expect(rows[0].tool_use_id).toBe('toolu_1');
  });

  test('plain chat trace (no graph fields) still works — backward compat (TC14)', () => {
    upsertChatTraceNode({
      id: 1002,
      chat_jid: chatJid,
      node_type: 'turn',
      title: 'plain chat',
      started_at: '2026-07-22T00:00:01.000Z',
    });
    const rows = listGraphNodeTraceNodes('graph-run-1', 'node-impl');
    expect(rows).toHaveLength(0); // not linked to graph
  });
});

describe('super-agent-team C1: trace_tool_calls upsert merge (TC13)', () => {
  const runId = 'graph-run-tc13';

  afterEach(() => {
    getDb().prepare('DELETE FROM trace_tool_calls WHERE graph_run_id = ?').run(runId);
  });

  test('input then output merge into one row by tool_use_id', () => {
    // first stream event: tool input
    upsertTraceToolCall({
      graph_run_id: runId,
      graph_node_id: 'node-x',
      chat_jid: 'feishu:tc13',
      tool_use_id: 'toolu_merge',
      tool_name: 'Bash',
      input_json: JSON.stringify({ command: 'ls' }),
      status: 'running',
      started_at: '2026-07-22T00:00:00.000Z',
    });
    // second stream event: tool result
    upsertTraceToolCall({
      graph_run_id: runId,
      tool_use_id: 'toolu_merge',
      tool_name: 'Bash',
      output_json: JSON.stringify({ stdout: 'file.txt' }),
      status: 'success',
      started_at: '2026-07-22T00:00:00.000Z',
      ended_at: '2026-07-22T00:00:01.000Z',
    });
    const rows = listTraceToolCalls(runId, 'node-x');
    expect(rows).toHaveLength(1);
    expect(rows[0].input_json).toContain('ls');
    expect(rows[0].output_json).toContain('file.txt');
    expect(rows[0].status).toBe('success');
    expect(rows[0].ended_at).toBe('2026-07-22T00:00:01.000Z');
  });
});

describe('super-agent-team C3: persistTraceNodeFromStreamEvent captures tool I/O (TC13)', () => {
  const chatJid = 'feishu:persist-test';
  const runId = 'graph-run-persist';

  afterEach(() => {
    getDb().prepare('DELETE FROM chat_trace_nodes WHERE chat_jid = ?').run(chatJid);
    getDb().prepare('DELETE FROM trace_tool_calls WHERE chat_jid = ?').run(chatJid);
  });

  test('tool_use_start (toolInput) + tool_result (toolResult) merge into trace_tool_calls', () => {
    // tool_use_start event carries toolInput + traceNode with graph linkage
    const startEvent: StreamEvent = {
      eventType: 'tool_use_start',
      toolName: 'Bash',
      toolUseId: 'toolu_p1',
      toolInput: { command: 'echo hi' },
      traceNode: {
        nodeId: 9001,
        nodeType: 'tool',
        parentNodeId: 9000,
        status: 'running',
        graphRunId: runId,
        graphNodeId: 'node-impl',
        toolName: 'Bash',
        toolUseId: 'toolu_p1',
      },
    };
    persistTraceNodeFromStreamEvent(chatJid, startEvent);

    // tool_result event carries toolResult
    const resultEvent: StreamEvent = {
      eventType: 'tool_result',
      toolName: 'Bash',
      toolUseId: 'toolu_p1',
      toolResult: 'hi',
      traceNode: {
        nodeId: 9001,
        nodeType: 'tool',
        parentNodeId: 9000,
        status: 'done',
        graphRunId: runId,
        graphNodeId: 'node-impl',
        toolName: 'Bash',
        toolUseId: 'toolu_p1',
      },
    };
    persistTraceNodeFromStreamEvent(chatJid, resultEvent);

    const calls = listTraceToolCalls(runId, 'node-impl');
    expect(calls).toHaveLength(1);
    expect(calls[0].tool_use_id).toBe('toolu_p1');
    expect(calls[0].input_json).toContain('echo hi');
    expect(calls[0].output_json).toBe('hi');
    expect(calls[0].status).toBe('success');

    // trace node also persisted with graph linkage
    const nodes = listGraphNodeTraceNodes(runId, 'node-impl');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes[0].tool_use_id).toBe('toolu_p1');
  });

  test('plain chat trace event (no graph fields) persists without graph linkage (TC14)', () => {
    const event: StreamEvent = {
      eventType: 'status',
      statusText: 'turn_start',
      traceNode: { nodeId: 9100, nodeType: 'turn', status: 'running' },
    };
    persistTraceNodeFromStreamEvent(chatJid, event);
    // should not crash, should not be linked to graph
    const nodes = listGraphNodeTraceNodes(runId, 'node-impl');
    expect(nodes).toHaveLength(0);
  });
});
