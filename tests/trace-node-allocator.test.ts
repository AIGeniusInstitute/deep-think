import { describe, expect, test } from 'vitest';
import { TraceNodeAllocator } from '../container/agent-runner/src/trace-node-allocator.js';
import type { StreamEvent } from '../container/agent-runner/src/stream-event.types.js';

function makeToolStartEvent(over: Partial<StreamEvent> = {}): StreamEvent {
  return {
    eventType: 'tool_use_start',
    toolName: 'Bash',
    toolUseId: 'tu_1',
    toolInputSummary: 'ls',
    ...over,
  } as StreamEvent;
}

describe('TraceNodeAllocator', () => {
  test('tool_use_start allocates a tool node with parent turn', () => {
    const alloc = new TraceNodeAllocator();
    alloc.startTurn('user input');
    const event = makeToolStartEvent();
    alloc.decorate(event);
    expect(event.traceNode).toBeDefined();
    expect(event.traceNode!.nodeType).toBe('tool');
    expect(event.traceNode!.title).toBe('Bash');
    expect(event.traceNode!.inputSummary).toBe('ls');
    expect(event.traceNode!.status).toBe('running');
  });

  test('tool_use_start auto-allocates a turn if none was started', () => {
    const alloc = new TraceNodeAllocator();
    const event = makeToolStartEvent();
    alloc.decorate(event);
    expect(event.traceNode!.parentNodeId).toBeDefined();
  });

  test('Skill tool_use_start is reclassified as nodeType="skill"', () => {
    const alloc = new TraceNodeAllocator();
    alloc.startTurn();
    const event = makeToolStartEvent({
      toolName: 'Skill',
      skillName: 'github-trending',
      toolInputSummary: '{"name":"github-trending"}',
    });
    alloc.decorate(event);
    expect(event.traceNode!.nodeType).toBe('skill');
    expect(event.traceNode!.title).toBe('Skill:github-trending');
  });

  test('tool_use_start with skillName field but non-Skill toolName still becomes a skill node', () => {
    const alloc = new TraceNodeAllocator();
    alloc.startTurn();
    const event = makeToolStartEvent({
      toolName: 'Bash',
      skillName: 'github-trending',
    });
    alloc.decorate(event);
    expect(event.traceNode!.nodeType).toBe('skill');
  });

  test('tool_use_end + tool_result updates node status and writes outputSummary', () => {
    const alloc = new TraceNodeAllocator();
    alloc.startTurn();
    const startEvent = makeToolStartEvent();
    alloc.decorate(startEvent);
    // tool_use_end fires first — sets status=done but NOT outputSummary
    // (the actual output arrives in a separate tool_result event).
    const endEvent: StreamEvent = {
      eventType: 'tool_use_end',
      toolUseId: 'tu_1',
    } as StreamEvent;
    alloc.decorate(endEvent);
    expect(endEvent.traceNode).toBeDefined();
    expect(endEvent.traceNode!.nodeType).toBe('tool');
    expect(endEvent.traceNode!.status).toBe('done');
    expect(endEvent.traceNode!.outputSummary).toBeUndefined();
    // tool_result fires next — carries the actual output text.
    const resultEvent: StreamEvent = {
      eventType: 'tool_result',
      toolUseId: 'tu_1',
      toolResult: 'file1\nfile2',
    } as StreamEvent;
    alloc.decorate(resultEvent);
    expect(resultEvent.traceNode).toBeDefined();
    expect(resultEvent.traceNode!.outputSummary).toBe('file1\nfile2');
    expect(resultEvent.traceNode!.status).toBe('done');
  });

  test('tool_progress updates node inputSummary from input_json_delta', () => {
    const alloc = new TraceNodeAllocator();
    alloc.startTurn();
    // tool_use_start at content_block_start fires with empty input → inputSummary=null
    const startEvent = makeToolStartEvent({ toolInputSummary: undefined });
    alloc.decorate(startEvent);
    expect(startEvent.traceNode!.inputSummary).toBeUndefined();
    // tool_progress later carries the resolved input summary
    const progressEvent: StreamEvent = {
      eventType: 'tool_progress',
      toolUseId: 'tu_1',
      toolInputSummary: 'command: ls -la',
    } as StreamEvent;
    alloc.decorate(progressEvent);
    expect(progressEvent.traceNode).toBeDefined();
    expect(progressEvent.traceNode!.inputSummary).toBe('command: ls -la');
  });

  test('task_start allocates a subagent node', () => {
    const alloc = new TraceNodeAllocator();
    alloc.startTurn();
    const event: StreamEvent = {
      eventType: 'task_start',
      subagentType: 'web-researcher',
      taskDescription: 'research foo',
    } as StreamEvent;
    alloc.decorate(event);
    expect(event.traceNode!.nodeType).toBe('subagent');
    expect(event.traceNode!.title).toBe('web-researcher');
    expect(event.traceNode!.inputSummary).toBe('research foo');
    expect(event.traceNode!.status).toBe('running');
  });

  test('non-trace events are not decorated', () => {
    const alloc = new TraceNodeAllocator();
    alloc.startTurn();
    const event: StreamEvent = {
      eventType: 'text_delta',
      text: 'hello',
    } as StreamEvent;
    alloc.decorate(event);
    expect(event.traceNode).toBeUndefined();
  });

  test('already-populated traceNode is not overwritten', () => {
    const alloc = new TraceNodeAllocator();
    alloc.startTurn();
    const event = makeToolStartEvent();
    event.traceNode = {
      nodeId: 999,
      nodeType: 'tool',
      parentNodeId: 1,
      status: 'custom',
    };
    alloc.decorate(event);
    expect(event.traceNode.nodeId).toBe(999);
    expect(event.traceNode.status).toBe('custom');
  });

  test('resetTurn clears current turn and active tools', () => {
    const alloc = new TraceNodeAllocator();
    alloc.startTurn();
    const event = makeToolStartEvent();
    alloc.decorate(event);
    alloc.resetTurn();
    // After reset, a new tool_use_start will allocate a fresh turn
    const event2 = makeToolStartEvent({ toolUseId: 'tu_2' });
    alloc.decorate(event2);
    // The new tool's parent should be a fresh turn (different from the first)
    expect(event2.traceNode!.parentNodeId).not.toBe(event.traceNode!.parentNodeId);
  });

  test('nodeIds are allocated monotonically', () => {
    const alloc = new TraceNodeAllocator();
    alloc.startTurn();
    const e1 = makeToolStartEvent({ toolUseId: 'a' });
    const e2 = makeToolStartEvent({ toolUseId: 'b' });
    const e3 = makeToolStartEvent({ toolUseId: 'c' });
    alloc.decorate(e1);
    alloc.decorate(e2);
    alloc.decorate(e3);
    expect(e3.traceNode!.nodeId).toBeGreaterThan(e2.traceNode!.nodeId);
    expect(e2.traceNode!.nodeId).toBeGreaterThan(e1.traceNode!.nodeId);
  });

  // ---- Atomic Step Trace (v57): thinking / compact / memory_recall + spans ----

  test('thinking_delta allocates a thinking span and accumulates deltas', () => {
    const alloc = new TraceNodeAllocator();
    alloc.startTurn('q');
    const e1: StreamEvent = {
      eventType: 'thinking_delta',
      text: 'Let me think',
    } as StreamEvent;
    alloc.decorate(e1);
    expect(e1.traceNode!.nodeType).toBe('thinking');
    expect(e1.traceNode!.outputSummary).toBe('Let me think');
    expect(e1.traceNode!.status).toBe('running');
    // second delta merges into the same span
    const e2: StreamEvent = {
      eventType: 'thinking_delta',
      text: ' further',
    } as StreamEvent;
    alloc.decorate(e2);
    expect(e2.traceNode!.nodeId).toBe(e1.traceNode!.nodeId);
    expect(e2.traceNode!.outputSummary).toBe('Let me think further');
  });

  test('compact_boundary allocates a compact span (done)', () => {
    const alloc = new TraceNodeAllocator();
    alloc.startTurn();
    const e: StreamEvent = {
      eventType: 'compact_boundary',
      summary: 'pre:8000 post:4000',
    } as StreamEvent;
    alloc.decorate(e);
    expect(e.traceNode!.nodeType).toBe('compact');
    expect(e.traceNode!.inputSummary).toBe('pre:8000 post:4000');
    expect(e.traceNode!.status).toBe('done');
  });

  test('memory_recall allocates a memory_recall span (done)', () => {
    const alloc = new TraceNodeAllocator();
    alloc.startTurn();
    const e: StreamEvent = {
      eventType: 'memory_recall',
      summary: 'recalled 3 memories',
    } as StreamEvent;
    alloc.decorate(e);
    expect(e.traceNode!.nodeType).toBe('memory_recall');
    expect(e.traceNode!.status).toBe('done');
  });

  test('turn carries traceId+spanId; thinking/tool inherit parentSpanId', () => {
    const alloc = new TraceNodeAllocator();
    const turn = alloc.startTurn('q');
    expect(turn.traceId).toBeTruthy();
    expect(turn.spanId).toBeTruthy();
    expect(turn.parentSpanId).toBeNull();
    const th: StreamEvent = { eventType: 'thinking_delta', text: 'h' } as StreamEvent;
    alloc.decorate(th);
    expect(th.traceNode!.traceId).toBe(turn.traceId);
    expect(th.traceNode!.parentSpanId).toBe(turn.spanId);
    const tool = makeToolStartEvent({ toolUseId: 'x' });
    alloc.decorate(tool);
    expect(tool.traceNode!.traceId).toBe(turn.traceId);
    expect(tool.traceNode!.parentSpanId).toBe(turn.spanId);
  });

  test('atomic steps auto-start a turn if none active', () => {
    const alloc = new TraceNodeAllocator();
    const e: StreamEvent = {
      eventType: 'memory_recall',
      summary: 'recalled',
    } as StreamEvent;
    alloc.decorate(e);
    expect(e.traceNode!.nodeType).toBe('memory_recall');
    expect(e.traceNode!.parentSpanId).toBeTruthy();
  });
});
