/**
 * memory_write trace synthesis tests.
 *
 * memory_append is an MCP tool whose tool_result flows through the main-process
 * persist layer. maybeSynthesizeMemoryWrite inspects the stream event sequence
 * (tool_use_start records the tool name; tool_result consumes it) and, for
 * memory_append specifically, returns a memory_write trace_step row. Other
 * tools return null (no spurious atomic step).
 */
import { describe, expect, test } from 'vitest';
import { maybeSynthesizeMemoryWrite } from '../../src/chat-trace-persist.js';
import type { StreamEvent } from '../../src/stream-event.types.js';

const CHAT_JID = 'feishu:oc_test';
const TOOL_USE_ID = 'toolu_01ABCDEF123';

function makeToolUseStart(toolName: string): StreamEvent {
  return {
    eventType: 'tool_use_start',
    toolUseId: TOOL_USE_ID,
    toolName,
  } as unknown as StreamEvent;
}

function makeToolResult(content: string, traceNode?: Partial<NonNullable<StreamEvent['traceNode']>>): StreamEvent {
  return {
    eventType: 'tool_result',
    toolUseId: TOOL_USE_ID,
    toolResult: content,
    detail: content,
    traceNode: traceNode
      ? ({ nodeId: 5, nodeType: 'tool', traceId: 't1', spanId: 's5', parentSpanId: 's1', ...traceNode } as any)
      : undefined,
  } as unknown as StreamEvent;
}

describe('maybeSynthesizeMemoryWrite', () => {
  test('memory_append tool_result synthesizes a memory_write step', () => {
    // tool_use_start records the tool name
    expect(maybeSynthesizeMemoryWrite(CHAT_JID, makeToolUseStart('memory_append'))).toBeNull();
    // tool_result consumes it → memory_write step
    const step = maybeSynthesizeMemoryWrite(
      CHAT_JID,
      makeToolResult('记录了今日进展', { traceId: 't1', parentSpanId: 's1' }),
    );
    expect(step).not.toBeNull();
    expect(step!.node_type).toBe('memory_write');
    expect(step!.chat_jid).toBe(CHAT_JID);
    expect(step!.trace_id).toBe('t1');
    expect(step!.parent_span_id).toBe('s1');
    expect(step!.span_id).toMatch(/^mw-/);
    expect(step!.output_summary).toBe('记录了今日进展');
    expect(step!.status).toBe('done');
    expect(step!.title).toBe('Memory Write');
  });

  test('non-memory_append tool returns null', () => {
    expect(maybeSynthesizeMemoryWrite(CHAT_JID, makeToolUseStart('Read'))).toBeNull();
    expect(
      maybeSynthesizeMemoryWrite(CHAT_JID, makeToolResult('file contents')),
    ).toBeNull();
  });

  test('tool_result without prior tool_use_start returns null (no recorded name)', () => {
    // Fresh toolUseId never seen at tool_use_start
    const ev = {
      eventType: 'tool_result',
      toolUseId: 'toolu_never_seen',
      toolResult: 'x',
    } as unknown as StreamEvent;
    expect(maybeSynthesizeMemoryWrite(CHAT_JID, ev)).toBeNull();
  });

  test('falls back to chat-derived traceId when traceNode absent', () => {
    expect(maybeSynthesizeMemoryWrite(CHAT_JID, makeToolUseStart('memory_append'))).toBeNull();
    const step = maybeSynthesizeMemoryWrite(
      CHAT_JID,
      makeToolResult('note', undefined),
    );
    expect(step).not.toBeNull();
    expect(step!.trace_id).toBe(`chat-${CHAT_JID}`);
    expect(step!.parent_span_id).toBeNull();
  });

  test('truncates very long memory content in output_summary', () => {
    maybeSynthesizeMemoryWrite(CHAT_JID, makeToolUseStart('memory_append'));
    const long = 'x'.repeat(3000);
    const step = maybeSynthesizeMemoryWrite(CHAT_JID, makeToolResult(long));
    expect(step).not.toBeNull();
    expect(step!.output_summary!.length).toBeLessThanOrEqual(2048);
  });

  test('non-tool event returns null', () => {
    const ev = { eventType: 'text_delta', text: 'hi' } as unknown as StreamEvent;
    expect(maybeSynthesizeMemoryWrite(CHAT_JID, ev)).toBeNull();
  });
});
