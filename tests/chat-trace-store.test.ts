import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-trace-test-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
}));

const {
  initDatabase,
  upsertChatTraceNode,
  listChatTraceNodes,
  getChatTraceNode,
  saveChatTraceNodeAnnotation,
  deleteChatTraceNodes,
  upsertTraceStep,
  listTraceStepsByTrace,
  getTraceStep,
} = await import('../src/db.js');
const { persistTraceNodeFromStreamEvent } = await import('../src/chat-trace-persist.js');

const dbPath = path.join(tmpStoreDir, 'messages.db');
let probeDb: InstanceType<typeof Database>;

beforeAll(() => {
  initDatabase();
  probeDb = new Database(dbPath, { readonly: true });
});

afterAll(() => {
  if (probeDb) probeDb.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const CHAT_JID = 'web:test-group';

beforeEach(() => {
  deleteChatTraceNodes(CHAT_JID);
});

describe('upsertChatTraceNode', () => {
  test('inserts new node and is readable via listChatTraceNodes', () => {
    upsertChatTraceNode({
      id: 1,
      chat_jid: CHAT_JID,
      node_type: 'turn',
      title: 'user message',
      input_summary: 'hello',
      started_at: '2026-07-08T10:00:00Z',
      status: 'running',
    });
    const nodes = listChatTraceNodes(CHAT_JID);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe(1);
    expect(nodes[0].node_type).toBe('turn');
    expect(nodes[0].input_summary).toBe('hello');
    expect(nodes[0].status).toBe('running');
  });

  test('upsert is idempotent — second call updates rather than inserting', () => {
    upsertChatTraceNode({
      id: 1,
      chat_jid: CHAT_JID,
      node_type: 'turn',
      input_summary: 'first',
      started_at: '2026-07-08T10:00:00Z',
      status: 'running',
    });
    upsertChatTraceNode({
      id: 1,
      chat_jid: CHAT_JID,
      node_type: 'turn',
      input_summary: 'first',
      output_summary: 'done',
      started_at: '2026-07-08T10:00:00Z',
      ended_at: '2026-07-08T10:00:01Z',
      status: 'done',
      tokens: 1500,
    });
    const nodes = listChatTraceNodes(CHAT_JID);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].output_summary).toBe('done');
    expect(nodes[0].status).toBe('done');
    expect(nodes[0].tokens).toBe(1500);
  });

  test('COALESCE preserves earlier non-null fields when later upsert omits them', () => {
    upsertChatTraceNode({
      id: 5,
      chat_jid: CHAT_JID,
      node_type: 'tool',
      parent_node_id: 1,
      title: 'Bash',
      input_summary: 'ls',
      started_at: '2026-07-08T10:00:00Z',
    });
    // Second upsert omits parent_node_id and title — should NOT null out
    upsertChatTraceNode({
      id: 5,
      chat_jid: CHAT_JID,
      node_type: 'tool',
      output_summary: 'file1\nfile2',
      started_at: '2026-07-08T10:00:00Z',
      ended_at: '2026-07-08T10:00:02Z',
      status: 'done',
    });
    const node = getChatTraceNode(CHAT_JID, 5)!;
    expect(node.parent_node_id).toBe(1);
    expect(node.title).toBe('Bash');
    expect(node.output_summary).toBe('file1\nfile2');
  });
});

describe('saveChatTraceNodeAnnotation', () => {
  test('writes annotation_input and annotation_output', () => {
    upsertChatTraceNode({
      id: 10,
      chat_jid: CHAT_JID,
      node_type: 'tool',
      input_summary: 'original-in',
      output_summary: 'original-out',
      started_at: '2026-07-08T10:00:00Z',
    });
    saveChatTraceNodeAnnotation(CHAT_JID, 10, 'edited-in', 'edited-out');
    const node = getChatTraceNode(CHAT_JID, 10)!;
    expect(node.annotation_input).toBe('edited-in');
    expect(node.annotation_output).toBe('edited-out');
    // Original summaries are untouched
    expect(node.input_summary).toBe('original-in');
    expect(node.output_summary).toBe('original-out');
  });

  test('supports null annotations (clearing)', () => {
    upsertChatTraceNode({
      id: 11,
      chat_jid: CHAT_JID,
      node_type: 'tool',
      started_at: '2026-07-08T10:00:00Z',
    });
    saveChatTraceNodeAnnotation(CHAT_JID, 11, 'temp', 'temp');
    saveChatTraceNodeAnnotation(CHAT_JID, 11, null, null);
    const node = getChatTraceNode(CHAT_JID, 11)!;
    expect(node.annotation_input).toBeNull();
    expect(node.annotation_output).toBeNull();
  });
});

describe('deleteChatTraceNodes', () => {
  test('deletes all nodes for a chat_jid and returns count', () => {
    upsertChatTraceNode({ id: 1, chat_jid: CHAT_JID, node_type: 'turn', started_at: '2026-07-08T10:00:00Z' });
    upsertChatTraceNode({ id: 2, chat_jid: CHAT_JID, node_type: 'tool', parent_node_id: 1, started_at: '2026-07-08T10:00:01Z' });
    const deleted = deleteChatTraceNodes(CHAT_JID);
    expect(deleted).toBe(2);
    expect(listChatTraceNodes(CHAT_JID)).toHaveLength(0);
  });

  test('does not affect other chat_jids', () => {
    upsertChatTraceNode({ id: 1, chat_jid: 'web:other', node_type: 'turn', started_at: '2026-07-08T10:00:00Z' });
    deleteChatTraceNodes(CHAT_JID);
    expect(listChatTraceNodes('web:other')).toHaveLength(1);
    deleteChatTraceNodes('web:other');
  });
});

// ---- Atomic Step Trace (v57): trace_steps + large I/O offload ----

describe('trace_steps (v57 atomic step persistence)', () => {
  test('upsertTraceStep inserts and merges on (trace_id, span_id)', () => {
    const traceId = 'tr-merge-' + Date.now();
    upsertTraceStep({
      trace_id: traceId, span_id: 'sp1', chat_jid: CHAT_JID,
      node_type: 'thinking', title: 'Thinking',
      output_summary: 'partial', status: 'running',
      started_at: '2026-08-31T10:00:00Z',
    });
    upsertTraceStep({
      trace_id: traceId, span_id: 'sp1', chat_jid: CHAT_JID,
      node_type: 'thinking',
      output_summary: 'full thought', status: 'done', tokens: 120,
      started_at: '2026-08-31T10:00:00Z', ended_at: '2026-08-31T10:00:01Z',
    });
    const steps = listTraceStepsByTrace(traceId);
    expect(steps).toHaveLength(1);
    expect(steps[0].output_summary).toBe('full thought');
    expect(steps[0].status).toBe('done');
    expect(steps[0].tokens).toBe(120);
  });

  test('upsertTraceStep stores evidence_json', () => {
    const traceId = 'tr-ev-' + Date.now();
    upsertTraceStep({
      trace_id: traceId, span_id: 'sp1', chat_jid: CHAT_JID,
      node_type: 'validation',
      evidence: [{ type: 'test', ref: 'tc-2.1.1', detail: 'schema fail' }],
      started_at: '2026-08-31T10:00:00Z',
    });
    const step = getTraceStep(traceId, 'sp1')!;
    expect(step.evidence_json).toContain('tc-2.1.1');
    expect(step.evidence_json).toContain('schema fail');
  });
});

describe('persistTraceNodeFromStreamEvent — large tool I/O offload', () => {
  test('>64KB tool result is offloaded to a file with output_ref', () => {
    const traceId = 'tr-big-' + Date.now();
    const toolUseId = 'tu_big_' + Date.now();
    const big = 'x'.repeat(70_000);
    const event = {
      eventType: 'tool_result',
      toolUseId,
      toolName: 'Bash',
      toolResult: big,
      traceNode: { nodeId: 1, nodeType: 'tool', traceId, spanId: 'sp1', status: 'done' },
    } as any;
    persistTraceNodeFromStreamEvent(CHAT_JID, event);
    const row = probeDb
      .prepare('SELECT output_json, output_ref FROM trace_tool_calls WHERE tool_use_id = ?')
      .get(toolUseId) as { output_json: string; output_ref: string | null };
    // inline is truncated to <= 64KB, ref points to the full file
    expect(row.output_json.length).toBeLessThanOrEqual(64 * 1024);
    expect(row.output_ref).toBeTruthy();
    expect(fs.existsSync(row.output_ref!)).toBe(true);
    expect(fs.readFileSync(row.output_ref!, 'utf8').length).toBe(70_000);
    // cleanup offloaded file dir
    fs.rmSync(path.dirname(row.output_ref!), { recursive: true, force: true });
  });

  test('atomic step nodeType is routed to trace_steps (not chat_trace_nodes)', () => {
    const traceId = 'tr-compact-' + Date.now();
    const event = {
      eventType: 'compact_boundary',
      summary: 'pre:8000 post:4000',
      traceNode: {
        nodeId: 2, nodeType: 'compact', traceId, spanId: 'sp-c',
        parentNodeId: 1, status: 'done',
        inputSummary: 'pre:8000 post:4000',
        outputSummary: 'pre:8000 post:4000',
      },
    } as any;
    persistTraceNodeFromStreamEvent(CHAT_JID, event);
    const step = getTraceStep(traceId, 'sp-c');
    expect(step).toBeDefined();
    expect(step!.node_type).toBe('compact');
    expect(step!.input_summary).toBe('pre:8000 post:4000');
    // coarse nodes table must NOT contain the compact node (CHECK constraint)
    expect(getChatTraceNode(CHAT_JID, 2)).toBeUndefined();
  });
});
