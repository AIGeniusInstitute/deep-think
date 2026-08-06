/**
 * Shared types for DeepThink Agent Runner.
 *
 * These types are used across index.ts, stream-processor.ts, and mcp-tools.ts.
 */

// Streaming event types (canonical source: shared/stream-event.ts)
export type { StreamEventType, StreamEvent } from './stream-event.types.js';
import type { ClaudeContextAudit, StreamEvent } from './stream-event.types.js';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  turnId?: string;
  groupFolder: string;
  chatJid: string;
  /** Source JID of the latest message that triggered this run (e.g. `discord:123…`).
   * Used by per-channel MCP tools (discord_*, etc.) to identify the current
   * incoming chat. Undefined when chatJid already encodes the IM source. */
  currentSourceJid?: string;
  /** @deprecated Use isHome + isAdminHome instead. Kept for backward compatibility with older host processes. */
  isMain?: boolean;
  /** Whether this is the user's home container (admin or member). */
  isHome?: boolean;
  /** Whether this is the admin's home container (full privileges). */
  isAdminHome?: boolean;
  isScheduledTask?: boolean;
  /** If the last unprocessed message was emitted by a scheduled task prompt,
   * this is that task's ID; used to tag MCP send_message outputs so the host
   * routes results to the task's configured chat_jid / notify channels. */
  messageTaskId?: string;
  images?: Array<{ data: string; mimeType?: string }>;
  agentId?: string;
  agentName?: string;
  /**
   * Claude Code plugins to load for this session, passed straight to
   * SDK `options.plugins`. Each `path` must be an absolute path (already
   * runtime-translated by container-runner: container-internal for Docker,
   * host absolute path for host mode).
   */
  plugins?: Array<{ type: 'local'; path: string }>;
  /** Runtime context audit bootstrap from the host/container launcher. */
  contextAudit?: ClaudeContextAudit;
  /**
   * User's preferred response language (BCP-47-ish code, e.g. 'zh-CN', 'en').
   * Injected into the agent's system prompt as a "respond in this language"
   * directive. Defaults to 'zh-CN' when undefined.
   */
  userLanguage?: string;
  /**
   * Agent execution engine. 'claude' (default) uses Claude Agent SDK query().
   * 'atomcode' routes to atomcode-engine.ts which drives atomcode-daemon's
   * HTTP/SSE /chat endpoint. 'codex' routes to codex-engine.ts which drives
   * `codex exec --json` JSONL. 'opencode' routes to opencode-engine.ts which
   * drives `opencode serve` REST+SSE. 'pi' routes to pi-engine.ts which
   * drives `pi --mode rpc` stdio JSONL.
   */
  engine?: 'claude' | 'atomcode' | 'codex' | 'opencode' | 'pi';
  /** Agent PaaS: when group is bound to a user-defined Agent, this carries
   * the definition + mounts. agent-runner main() uses it to override system
   * prompt, model, and filter MCP/Skill to only those listed in mounts. */
  agentDefinition?: {
    id: string;
    systemPrompt?: string;
    model?: string | null;
    maxTurns?: number | null;
    temperature?: number | null;
    mounts: Array<{
      resourceType: 'mcp_server' | 'skill' | 'knowledge_base';
      resourceId: string;
      resourceName?: string;
      mcpConfig?: {
        type: string;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        url?: string;
      };
      kbId?: string;
      kbName?: string;
    }>;
  };
  /** Super Agent Team: graph linkage. When set (agent node executed by
   *  graph-runner), TraceNodeAllocator tags every trace node + tool call with
   *  these so the node-internal sub-graph is traceable. Optional. */
  graphRunId?: string;
  graphNodeId?: string;
  /** Reminder mechanism config. When set and enabled, the agent-runner
   *  periodically re-injects the task goal (via MessageStream.push) to
   *  counter context decay in long tasks, and emits reminder_injected
   *  stream events for the chat UI's Reminder panel. Optional — undefined
   *  or enabled=false disables injection. */
  reminderConfig?: {
    enabled: boolean;
    intervalSteps: number;
    goalSnippet: string;
  };
  /** 全托管模式开关：true 时 agent 在单次任务执行期间不主动停下询问用户。
   *  Supervisor clarify 被禁用、端回合检测到提问信号时自动注入续接消息、
   *  硬刹车（轮次/token/循环/破坏性命令）触发时强制退出。 */
  autonomous?: boolean;
  /** 全托管硬刹车上限：轮次计数到 maxTurns 即停止。默认 50。 */
  maxTurns?: number;
  /** 全托管硬刹车上限：累计 token 用量到 maxTokens 即停止。默认 1,000,000。 */
  maxTokens?: number;
}

export interface ContainerOutput {
  status: 'success' | 'error' | 'stream' | 'closed';
  result: string | null;
  newSessionId?: string;
  error?: string;
  streamEvent?: StreamEvent;
  turnId?: string;
  sessionId?: string;
  sdkMessageUuid?: string;
  sourceKind?: 'sdk_final' | 'sdk_send_message' | 'interrupt_partial' | 'overflow_partial' | 'compact_partial' | 'legacy' | 'auto_continue' | 'truncation_continue' | 'autonomous_continue' | 'autonomous_brake';
  /** 'truncated'：上游断流截断的 partial（usage 双零指纹，runner 会自动续写） */
  finalizationReason?: 'completed' | 'interrupted' | 'error' | 'truncated';
  /** 本 result 发出时仍未 settle 的后台任务数（异步 Agent / backgrounded Bash）。
   * >0 时主进程应把流式卡片保持在「后台任务运行中」而非定稿，后续 turn 的
   * 内容会继续追加到同一张卡。仅 sdk_final 类 result 携带。 */
  pendingBgTasks?: number;
}

export interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

export interface SessionsIndex {
  entries: SessionEntry[];
}

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface SDKUserMessage {
  type: 'user';
  message: {
    role: 'user';
    content:
      | string
      | Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: ImageMediaType; data: string } }>;
  };
  parent_tool_use_id: null;
  session_id: string;
}

export interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}
