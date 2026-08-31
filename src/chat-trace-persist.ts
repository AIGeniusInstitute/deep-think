/**
 * Persist traceNode metadata from stream events to the chat_trace_nodes table
 * (coarse DAG types), the trace_steps table (atomic step types), and tool-call
 * input/output to trace_tool_calls (Super Agent Team).
 *
 * Called from src/index.ts on every stream event that carries a traceNode
 * field (for the trace node) or tool input/result fields (for the tool call).
 * The upserts are idempotent (chat_trace_nodes on (chat_jid, id);
 * trace_steps on (trace_id, span_id); trace_tool_calls on (graph_run_id,
 * tool_use_id)) so replays are safe. Failures are logged but do not block the
 * stream — DAG visualization is a best-effort side channel, not a critical path.
 *
 * Atomic Step Trace (v57): thinking / compact / memory_recall / llm_call / etc.
 * are persisted to trace_steps (not chat_trace_nodes, whose CHECK constraint
 * only allows the six coarse types). Tool I/O exceeding 64KB is offloaded to
 * data/trace-io/{traceId}/{spanId}.{in|out}.json and the DB row stores the
 * file path in output_ref, so large tool outputs stay fully traceable without
 * bloating the table.
 */

import type { StreamEvent } from './stream-event.types.js';
import {
  upsertChatTraceNode,
  upsertTraceToolCall,
  upsertTraceStep,
} from './db.js';
import type { TraceStepUpsertInput } from './db.js';
import { logger } from './logger.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TOOL_IO_MAX = 64 * 1024; // 64KB per input/output JSON — trace volume guard
const COARSE_NODE_TYPES = new Set([
  'turn', 'tool', 'review', 'goal_check', 'skill', 'subagent',
]);

/** The MCP tool name that writes to the memory layer. Its tool_result carries
 *  the appended content — we synthesize a dedicated memory_write atomic step so
 *  memory writes are first-class traceable events (not buried inside a generic
 *  tool node). */
const MEMORY_WRITE_TOOL = 'memory_append';
const MEMORY_WRITE_SUMMARY_MAX = 2048;

/**
 * Per-(chatJid, toolUseId) record of the tool name seen at tool_use_start.
 * tool_result events carry toolUseId but NOT toolName, so we look the name up
 * here to decide whether to synthesize a memory_write step. Bounded by turn
 * (cleared implicitly as toolUseIds are unique per turn).
 */
const toolNameByUseId = new Map<string, string>();

function toolNameKey(chatJid: string, toolUseId: string): string {
  return `${chatJid}|${toolUseId}`;
}

/**
 * Inspect a stream event and, when it completes a `memory_append` tool call,
 * return a trace_steps upsert row for a `memory_write` atomic step. Stateful:
 * records tool names from tool_use_start events and consumes them on
 * tool_result. Returns null for all non-matching events (no side effect on the
 * trace beyond the returned row). Pure with respect to DB — the caller decides
 * whether to upsertTraceStep the returned row.
 */
export function maybeSynthesizeMemoryWrite(
  chatJid: string,
  event: StreamEvent,
): TraceStepUpsertInput | null {
  const toolUseId = event.toolUseId;
  if (!toolUseId) return null;

  // Record phase: tool_use_start carries toolName.
  if (event.eventType === 'tool_use_start' && event.toolName) {
    toolNameByUseId.set(toolNameKey(chatJid, toolUseId), event.toolName);
    return null;
  }

  // Consume phase: tool_result carries the appended content.
  if (event.eventType !== 'tool_result') return null;

  const toolName = toolNameByUseId.get(toolNameKey(chatJid, toolUseId));
  toolNameByUseId.delete(toolNameKey(chatJid, toolUseId));
  if (toolName !== MEMORY_WRITE_TOOL) return null;

  const tn = event.traceNode;
  const traceId = tn?.traceId ?? `chat-${chatJid}`;
  const parentSpanId = tn?.parentSpanId ?? null;
  const now = new Date().toISOString();
  const tail = toolUseId.slice(-8);
  const content = event.toolResult ?? event.detail ?? '';
  return {
    trace_id: traceId,
    span_id: `mw-${tail}`,
    parent_span_id: parentSpanId,
    chat_jid: chatJid,
    graph_run_id: tn?.graphRunId ?? null,
    graph_node_id: tn?.graphNodeId ?? null,
    node_type: 'memory_write',
    title: 'Memory Write',
    input_summary: null,
    output_summary: content.length > MEMORY_WRITE_SUMMARY_MAX
      ? content.slice(0, MEMORY_WRITE_SUMMARY_MAX)
      : content,
    evidence: null,
    output_ref: null,
    tokens: 0,
    status: 'done',
    started_at: now,
    ended_at: now,
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** Resolve (and lazily create) the on-disk dir for a trace's large I/O files. */
function traceIoDir(traceId: string): string {
  const dir = join(process.cwd(), 'data', 'trace-io', traceId);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // dir may already exist; ignore
  }
  return dir;
}

/**
 * If `text` exceeds the DB size guard, write the full payload to a file and
 * return the file path (stored in output_ref). Otherwise return the truncated
 * payload (stored inline in the *_json column).
 */
function offloadLargeIo(
  text: string,
  traceId: string,
  spanId: string,
  side: 'in' | 'out',
): { inline: string; ref: string | null } {
  if (!text || text.length <= TOOL_IO_MAX) {
    return { inline: truncate(text, TOOL_IO_MAX), ref: null };
  }
  try {
    const file = join(traceIoDir(traceId), `${spanId}.${side}.json`);
    writeFileSync(file, text);
    return { inline: truncate(text, TOOL_IO_MAX), ref: file };
  } catch (err) {
    logger.warn({ err, traceId, spanId }, 'offloadLargeIo failed — truncating inline');
    return { inline: truncate(text, TOOL_IO_MAX), ref: null };
  }
}

/** Persist an atomic step (thinking/compact/memory_recall/llm_call/...) to trace_steps. */
function persistAtomicStep(chatJid: string, event: StreamEvent): void {
  const tn = event.traceNode!;
  if (!tn.traceId || !tn.spanId) return;
  const now = new Date().toISOString();
  const terminal = tn.status === 'done' || tn.status === 'failed';
  try {
    upsertTraceStep({
      trace_id: tn.traceId,
      span_id: tn.spanId,
      parent_span_id: tn.parentSpanId ?? null,
      chat_jid: chatJid,
      graph_run_id: tn.graphRunId ?? null,
      graph_node_id: tn.graphNodeId ?? null,
      node_type: tn.nodeType,
      title: tn.title ?? null,
      input_summary: tn.inputSummary ?? null,
      output_summary: tn.outputSummary ?? null,
      evidence: tn.evidence ?? null,
      output_ref: tn.outputRef ?? null,
      tokens: tn.tokens ?? 0,
      status: tn.status ?? null,
      started_at: now,
      ended_at: terminal ? now : null,
    });
  } catch (err) {
    logger.warn({ err, chatJid, spanId: tn.spanId }, 'persistAtomicStep failed');
  }
}

export function persistTraceNodeFromStreamEvent(
  chatJid: string,
  event: StreamEvent,
): void {
  // 1. Trace node → chat_trace_nodes (coarse) or trace_steps (atomic).
  if (event.traceNode) {
    const tn = event.traceNode;
    if (COARSE_NODE_TYPES.has(tn.nodeType)) {
      const startedAt = new Date().toISOString();
      try {
        upsertChatTraceNode({
          id: tn.nodeId,
          chat_jid: chatJid,
          node_type: tn.nodeType as
            | 'turn' | 'tool' | 'review' | 'goal_check' | 'skill' | 'subagent',
          parent_node_id: tn.parentNodeId ?? null,
          title: tn.title ?? null,
          input_summary: tn.inputSummary ?? null,
          output_summary: tn.outputSummary ?? null,
          tokens: tn.tokens ?? 0,
          status: tn.status ?? null,
          started_at: startedAt,
          ended_at: tn.status === 'done' || tn.status === 'failed' ? startedAt : null,
          graph_run_id: tn.graphRunId ?? null,
          graph_node_id: tn.graphNodeId ?? null,
          tool_name: tn.toolName ?? null,
          tool_use_id: tn.toolUseId ?? null,
          trace_id: tn.traceId ?? null,
          span_id: tn.spanId ?? null,
          parent_span_id: tn.parentSpanId ?? null,
        });
      } catch (err) {
        logger.warn({ err, chatJid, nodeId: tn.nodeId }, 'persistTraceNode failed');
      }
    } else {
      persistAtomicStep(chatJid, event);
    }
  }

  // 2. Tool-call raw I/O → trace_tool_calls. Captures the toolInput (on
  //    tool_use_start) and toolResult (on tool_result) fields. Idempotent on
  //    (graph_run_id, tool_use_id) so the input and output halves merge. Large
  //    output is offloaded to a file and the path stored in output_ref (v57).
  const toolUseId = event.toolUseId;
  if (toolUseId) {
    const graphRunId = event.traceNode?.graphRunId ?? null;
    const graphNodeId = event.traceNode?.graphNodeId ?? null;
    const traceId = event.traceNode?.traceId ?? `chat-${chatJid}`;
    const spanId = event.traceNode?.spanId ?? toolUseId;
    try {
      if (event.toolInput) {
        const inputStr = JSON.stringify(event.toolInput);
        upsertTraceToolCall({
          graph_run_id: graphRunId,
          graph_node_id: graphNodeId,
          chat_jid: chatJid,
          tool_use_id: toolUseId,
          tool_name: event.toolName ?? 'unknown',
          input_json: truncate(inputStr, TOOL_IO_MAX),
          status: 'running',
          started_at: new Date().toISOString(),
        });
      }
      if (event.toolResult !== undefined) {
        const { inline, ref } = offloadLargeIo(event.toolResult, traceId, spanId, 'out');
        upsertTraceToolCall({
          graph_run_id: graphRunId,
          graph_node_id: graphNodeId,
          chat_jid: chatJid,
          tool_use_id: toolUseId,
          tool_name: event.toolName ?? 'unknown',
          output_json: inline,
          output_ref: ref,
          status: event.permissionDenied ? 'denied' : 'success',
          started_at: new Date().toISOString(),
          ended_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      logger.warn({ err, chatJid, toolUseId }, 'persistTraceToolCall failed');
    }
  }

  // 3. memory_write atomic step synthesis: when a memory_append tool completes,
  //    emit a dedicated memory_write trace_step (best-effort). No-op for other
  //    tools. See maybeSynthesizeMemoryWrite for the stateful detection logic.
  const memoryWriteStep = maybeSynthesizeMemoryWrite(chatJid, event);
  if (memoryWriteStep) {
    try {
      upsertTraceStep(memoryWriteStep);
    } catch (err) {
      logger.warn({ err, chatJid, toolUseId }, 'persistMemoryWriteStep failed');
    }
  }
}
