/**
 * MCP Tool Definitions for DeepThink Agent Runner.
 *
 * Uses SDK's `tool()` helper to define in-process MCP tools.
 * These tools communicate with the host process via IPC files.
 *
 * Context (chatJid, groupFolder, etc.) is passed via McpContext
 * rather than read from environment variables, enabling in-process usage.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import { formatIsoLocal } from './utils.js';

/** Context required by MCP tools. Passed at construction time. */
export interface McpContext {
  chatJid: string;
  groupFolder: string;
  isHome: boolean;
  isAdminHome: boolean;
  isScheduledTask?: boolean;
  /** Mutable: set when the current IPC turn was triggered by a task prompt.
   * Cleared between turns by the agent-runner main loop so that regular
   * follow-up messages aren't misattributed to the prior task. */
  currentTaskId?: string | null;
  workspaceIpc: string;
  workspaceGroup: string;
  workspaceGlobal: string;
  workspaceMemory: string;
  // 禁用 DeepThink 的 memory MCP 工具（memory_append/search/get），
  // 让 Agent 完全按用户本机 ~/.claude/ 下的 Playbook 约定管理记忆
  disableMemoryLayer?: boolean;
  /** IDs of knowledge bases bound to this group's Agent definition.
   * Empty when no Agent is bound or no KBs are mounted. The kb_search tool
   * refuses to search when this is empty. */
  kbIds?: string[];
}

// ─── Distributed Redis IPC mode (mirror mcp-bridge.ts) ────────────
// In distributed mode (AGENT_RUNNER_MODE=distributed + REDIS_URL), the
// Claude engine runs in an agent-runner Pod WITHOUT a shared PVC to the
// web-server Pod. send_message / task requests must therefore go via Redis
// pub/sub instead of the local file system — otherwise they are lost (the
// web-server Pod never sees the IPC file). This mirrors the mcp-bridge.ts
// pattern already used by the codex/opencode engines, publishing to the same
// channels the web-server already subscribes to
// (deepthink:ipc-out:{folder}:messages / :tasks).
const REDIS_URL = process.env.DT_REDIS_URL || process.env.REDIS_URL || '';
const DISTRIBUTED_MODE =
  process.env.DT_DISTRIBUTED_MODE === 'true' ||
  process.env.AGENT_RUNNER_MODE === 'distributed';
const distributedMode = !!REDIS_URL && DISTRIBUTED_MODE;

let _redisPub: any = null;
let _redisSub: any = null;
let _redisConnected = false;
let _redisInitStarted = false;
// Set from createMcpTools(ctx) — the agent-runner is per-group, so this is
// stable for the process lifetime. Used as the Redis channel routing key.
let _activeGroupFolder = '';

const IPC_OUTPUT_PREFIX = 'deepthink:ipc-out:';
const IPC_TASK_RESULT_PREFIX = 'deepthink:ipc-task:';

async function initRedisBridge(): Promise<void> {
  if (_redisInitStarted) return;
  _redisInitStarted = true;
  if (!distributedMode) return;
  try {
    const { createClient } = await import('redis');
    _redisPub = createClient({ url: REDIS_URL });
    _redisSub = createClient({ url: REDIS_URL });
    _redisPub.on('error', () => {});
    _redisSub.on('error', () => {});
    await _redisPub.connect();
    await _redisSub.connect();
    _redisConnected = true;
    console.error('[mcp-tools] Redis bridge connected — distributed IPC mode active');
  } catch (err) {
    console.error('[mcp-tools] Redis connection failed, falling back to file-system IPC:', err);
    _redisConnected = false;
  }
}

async function redisPublishMessage(data: object): Promise<void> {
  if (!_redisConnected || !_activeGroupFolder) return;
  try {
    await _redisPub.publish(
      `${IPC_OUTPUT_PREFIX}${_activeGroupFolder}:messages`,
      JSON.stringify(data),
    );
  } catch { /* non-fatal */ }
}

async function redisRequestTask(
  data: Record<string, unknown> & { requestId: string },
  resultFilePrefix: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const resultChannel = `${IPC_TASK_RESULT_PREFIX}${_activeGroupFolder}:${data.requestId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { _redisSub.unsubscribe(resultChannel); } catch { /* ignore */ }
      reject(new Error(`Task result timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    _redisSub.subscribe(resultChannel, (raw: string) => {
      clearTimeout(timer);
      try { _redisSub.unsubscribe(resultChannel); } catch { /* ignore */ }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (err) {
        reject(new Error(`Failed to parse task result: ${err}`));
      }
    }).catch(() => {
      clearTimeout(timer);
      reject(new Error('Failed to subscribe to result channel'));
    });

    _redisPub.publish(
      `${IPC_OUTPUT_PREFIX}${_activeGroupFolder}:tasks`,
      JSON.stringify(data),
    ).catch(() => {});
  });
}

function writeIpcFile(dir: string, data: object): string {
  // Distributed mode: send_message (messages dir) goes via Redis (fire-and-
  // forget). Task requests are handled by pollIpcResult's distributed path.
  // basename check mirrors mcp-bridge's `dir === MESSAGES_DIR` (MESSAGES_DIR
  // is factory-local here, but its basename is always 'messages').
  if (_redisConnected && path.basename(dir) === 'messages') {
    redisPublishMessage(data).catch(() => {});
    return '';
  }
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Atomic write: temp file then rename
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, filepath);
  } catch (err) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    throw new Error(`IPC 写入失败 (${dir}): ${err instanceof Error ? err.message : String(err)}`);
  }
  return filename;
}

/**
 * Send an IPC request and poll for the result file.
 * Fixes TOCTOU by directly attempting readFileSync and catching ENOENT.
 * Returns the parsed JSON result, or throws on timeout.
 */
async function pollIpcResult(
  dir: string,
  data: Record<string, unknown> & { requestId: string },
  resultFilePrefix: string,
  timeoutMs: number = 30_000,
): Promise<Record<string, unknown>> {
  // Distributed mode: Redis request/response pattern (mirrors mcp-bridge).
  if (_redisConnected) {
    return redisRequestTask(data, resultFilePrefix, timeoutMs);
  }
  const resultFileName = `${resultFilePrefix}_${data.requestId}.json`;
  const resultFilePath = path.join(dir, resultFileName);

  writeIpcFile(dir, data);

  const pollInterval = 500;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(resultFilePath, 'utf-8');
      fs.unlinkSync(resultFilePath);
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      // File not ready yet — only swallow ENOENT
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
  throw new Error(`Timeout waiting for IPC result (${timeoutMs / 1000}s)`);
}

function newRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- Memory helpers ---
const MEMORY_EXTENSIONS = new Set(['.md', '.txt']);
const MEMORY_SUBDIRS = new Set(['memory', 'conversations']);
const MEMORY_SKIP_DIRS = new Set(['logs', '.claude', 'node_modules', '.git']);
const MAX_MEMORY_FILE_SIZE = 512 * 1024; // 512KB per file
const MAX_MEMORY_APPEND_SIZE = 16 * 1024; // 16KB per append
const MEMORY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function collectMemoryFiles(
  baseDir: string,
  out: string[],
  maxDepth: number,
  depth = 0,
): void {
  if (depth > maxDepth || !fs.existsSync(baseDir)) return;
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(baseDir, entry.name);
      if (entry.isDirectory()) {
        if (MEMORY_SKIP_DIRS.has(entry.name)) continue;
        if (depth === 0 || MEMORY_SUBDIRS.has(entry.name)) {
          collectMemoryFiles(fullPath, out, maxDepth, depth + 1);
        }
      } else if (entry.isFile()) {
        if (
          entry.name === 'CLAUDE.md' ||
          MEMORY_EXTENSIONS.has(path.extname(entry.name))
        ) {
          out.push(fullPath);
        }
      }
    }
  } catch {
    /* skip unreadable */
  }
}

function createToRelativePath(ctx: McpContext) {
  return (filePath: string): string => {
    if (
      filePath === ctx.workspaceGlobal ||
      filePath.startsWith(ctx.workspaceGlobal + path.sep)
    ) {
      return `[global] ${path.relative(ctx.workspaceGlobal, filePath)}`;
    }
    if (
      filePath === ctx.workspaceMemory ||
      filePath.startsWith(ctx.workspaceMemory + path.sep)
    ) {
      return `[memory] ${path.relative(ctx.workspaceMemory, filePath)}`;
    }
    return path.relative(ctx.workspaceGroup, filePath);
  };
}

function parseMemoryFileReference(fileRef: string): {
  pathRef: string;
  lineFromRef?: number;
} {
  const trimmed = fileRef.trim();
  const lineRefMatch = trimmed.match(/^(.*?):(\d+)$/);
  if (!lineRefMatch) return { pathRef: trimmed };

  const lineFromRef = Number(lineRefMatch[2]);
  if (!Number.isInteger(lineFromRef) || lineFromRef <= 0) {
    return { pathRef: trimmed };
  }
  return { pathRef: lineRefMatch[1].trim(), lineFromRef };
}

/**
 * Build the IPC payload shared by send_message / send_image MCP tools.
 *
 * Always stamps `chatJid`, `groupFolder`, `timestamp`. Conditionally stamps
 * `isScheduledTask` (when ctx.isScheduledTask is truthy) and `taskId` (when
 * ctx.currentTaskId is non-empty). The conditional stamping matters for host-
 * side routing: a missing `taskId` key means "regular user-turn reply", while
 * a present `taskId` key triggers the task-broadcast branch in the IPC
 * consumer. `extras` carries per-tool fields (`type`, `text`, `imageBase64`, …).
 *
 * Pure function; exported for unit testing.
 */
export function buildSendMessageData(
  ctx: McpContext,
  extras: Record<string, unknown>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    chatJid: ctx.chatJid,
    groupFolder: ctx.groupFolder,
    timestamp: new Date().toISOString(),
    ...extras,
  };
  if (ctx.isScheduledTask) {
    data.isScheduledTask = true;
  }
  if (ctx.currentTaskId) {
    data.taskId = ctx.currentTaskId;
  }
  return data;
}

/**
 * Create all DeepThink MCP tool definitions for in-process SDK MCP server.
 */
export function createMcpTools(ctx: McpContext): SdkMcpToolDefinition<any>[] {
  // Capture the group folder for Redis IPC routing + kick off the Redis
  // bridge (idempotent). In non-distributed mode this is a no-op and the
  // file-system IPC path is used unchanged.
  _activeGroupFolder = ctx.groupFolder;
  initRedisBridge().catch((err) =>
    console.error('[mcp-tools] initRedisBridge failed:', err),
  );
  const MESSAGES_DIR = path.join(ctx.workspaceIpc, 'messages');
  const TASKS_DIR = path.join(ctx.workspaceIpc, 'tasks');
  const hasCrossGroupAccess = ctx.isAdminHome;
  const toRelativePath = createToRelativePath(ctx);

  const tools: SdkMcpToolDefinition<any>[] = [
    // --- send_message ---
    tool(
      'send_message',
      "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
      { text: z.string().describe('The message text to send') },
      async (args) => {
        const data = buildSendMessageData(ctx, {
          type: 'message',
          text: args.text,
        });
        writeIpcFile(MESSAGES_DIR, data);
        return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
      },
    ),

    // --- send_image ---
    tool(
      'send_image',
      'Send an image file from the workspace to the user via IM. Supports PNG/JPEG/GIF/WebP. Optional caption.',
      {
        file_path: z
          .string()
          .describe(
            'Path to the image file in the workspace (relative to workspace root or absolute)',
          ),
        caption: z
          .string()
          .optional()
          .describe('Optional caption text to send with the image'),
      },
      async (args) => {
        // NOTE: Web-prefixed JIDs (e.g. web:main) are no longer rejected here.
        // The main process routes the image to the correct IM channel via
        // activeImReplyRoutes, so the agent-runner should let the IPC
        // request through regardless of JID prefix.

        // Resolve path relative to workspace
        const absPath = path.isAbsolute(args.file_path)
          ? args.file_path
          : path.join(ctx.workspaceGroup, args.file_path);

        // Security: ensure path is within workspace
        // Use path.sep suffix to prevent prefix-bypass (e.g. /ws/group1 matching /ws/group10/evil.png)
        const resolved = path.resolve(absPath);
        const safeRoot = ctx.workspaceGroup.endsWith(path.sep)
          ? ctx.workspaceGroup
          : ctx.workspaceGroup + path.sep;
        if (resolved !== ctx.workspaceGroup && !resolved.startsWith(safeRoot)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: file path must be within workspace directory.`,
              },
            ],
            isError: true,
          };
        }

        // Check file exists
        if (!fs.existsSync(resolved)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: file not found: ${args.file_path}`,
              },
            ],
            isError: true,
          };
        }

        // Read file and check size (10MB limit for both Feishu and Telegram)
        const stat = fs.statSync(resolved);
        if (stat.size > 10 * 1024 * 1024) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: image file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Maximum is 10MB.`,
              },
            ],
            isError: true,
          };
        }
        if (stat.size === 0) {
          return {
            content: [
              { type: 'text' as const, text: `Error: image file is empty.` },
            ],
            isError: true,
          };
        }

        const buffer = fs.readFileSync(resolved);
        const base64 = buffer.toString('base64');

        // Detect MIME type from magic bytes
        const { detectImageMimeTypeFromBase64Strict } =
          await import('./image-detector.js');
        const mimeType = detectImageMimeTypeFromBase64Strict(base64);
        if (!mimeType) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: file does not appear to be a supported image format (PNG, JPEG, GIF, WebP, TIFF, BMP).`,
              },
            ],
            isError: true,
          };
        }

        const data = buildSendMessageData(ctx, {
          type: 'image',
          imageBase64: base64,
          mimeType,
          caption: args.caption || undefined,
          fileName: path.basename(resolved),
        });
        writeIpcFile(MESSAGES_DIR, data);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Image sent: ${path.basename(resolved)} (${mimeType}, ${(stat.size / 1024).toFixed(1)}KB)`,
            },
          ],
        };
      },
    ),

    // --- send_file ---
    tool(
      'send_file',
      `Send a file to the current chat (the user you're talking to) via IM (Feishu/Telegram/DingTalk/QQ/Discord). The file path is relative to the workspace/group directory.
Supports: PDF, DOC, XLS, PPT, MP4, ZIP, SO, etc. Max file size: 30MB.`,
      {
        filePath: z
          .string()
          .describe(
            'File path relative to workspace/group (e.g., "output/report.pdf")',
          ),
        fileName: z
          .string()
          .describe('File name to display (e.g., "report.pdf")'),
      },
      async (args) => {
        // NOTE: Web-prefixed JIDs (e.g. web:main) are no longer rejected here.
        // The main process routes the file to the correct IM channel via
        // activeImReplyRoutes, so the agent-runner should let the IPC
        // request through regardless of JID prefix.

        // Handle both absolute and relative paths
        let resolvedPath: string;
        let relativePath: string;

        if (path.isAbsolute(args.filePath)) {
          // Absolute path provided - validate and convert to relative
          resolvedPath = path.resolve(args.filePath);
          const safeRoot = ctx.workspaceGroup.endsWith(path.sep)
            ? ctx.workspaceGroup
            : ctx.workspaceGroup + path.sep;
          if (
            resolvedPath !== ctx.workspaceGroup &&
            !resolvedPath.startsWith(safeRoot)
          ) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Error: file must be within the workspace/group directory.',
                },
              ],
              isError: true,
            };
          }
          // Convert to relative path
          relativePath = path.relative(ctx.workspaceGroup, resolvedPath);
        } else {
          // Relative path provided
          relativePath = args.filePath;
          resolvedPath = path.resolve(ctx.workspaceGroup, args.filePath);
          // Validate resolved path is still within workspace
          const safeRoot = ctx.workspaceGroup.endsWith(path.sep)
            ? ctx.workspaceGroup
            : ctx.workspaceGroup + path.sep;
          if (
            resolvedPath !== ctx.workspaceGroup &&
            !resolvedPath.startsWith(safeRoot)
          ) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Error: file must be within the workspace/group directory.',
                },
              ],
              isError: true,
            };
          }
        }

        if (!fs.existsSync(resolvedPath)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: file not found: ${args.filePath}`,
              },
            ],
            isError: true,
          };
        }

        const data = {
          type: 'send_file',
          chatJid: ctx.chatJid,
          filePath: relativePath,
          fileName: args.fileName,
          timestamp: new Date().toISOString(),
        };
        writeIpcFile(TASKS_DIR, data);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Sending file "${args.fileName}"...`,
            },
          ],
        };
      },
    ),

    // --- schedule_task ---
    tool(
      'schedule_task',
      `Schedule a recurring or one-time task.

EXECUTION TYPE:
\u2022 "agent" (default): Task runs as a full Claude Agent with access to all tools. Consumes API tokens.
\u2022 "script" (admin only): Task runs a shell command directly on the host. Zero API token cost. Use for deterministic tasks like health checks, data collection, cURL calls, or cron-like scripts.

EXECUTION MODE:
\u2022 "host": Task runs directly on the host machine. Admin only.
\u2022 "container" (default for non-admin): Task runs in a Docker container.
Each agent task automatically gets its own dedicated workspace.

CONTEXT MODE (agent mode only) - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history.
\u2022 "isolated": Task runs in a fresh session with no conversation history.

MESSAGING BEHAVIOR - The task output is sent to the user or group.
\u2022 Agent mode: output is sent via MCP tool or stdout. Use <internal> tags to suppress.
\u2022 Script mode: stdout is sent as the result. stderr is included on failure.

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
      {
        prompt: z
          .string()
          .optional()
          .default('')
          .describe(
            'The action to perform on EACH run (agent mode), or task description (script mode). The repeat cadence is expressed by schedule_type/schedule_value — do NOT put scheduling words like "每隔N/每天/定期/提醒我/every N" into the prompt. This prompt is replayed verbatim to the agent on every trigger to execute, so write it as a direct imperative action, not as a request to schedule something.',
          ),
        schedule_type: z
          .enum(['cron', 'interval', 'once'])
          .describe(
            'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
          ),
        schedule_value: z
          .string()
          .describe(
            'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
          ),
        execution_type: z
          .enum(['agent', 'script'])
          .default('agent')
          .describe(
            'agent=full Claude Agent (default), script=shell command (admin only, zero token cost)',
          ),
        script_command: z
          .string()
          .max(4096)
          .optional()
          .describe(
            'Shell command to execute (required for script mode). Runs in the group workspace directory.',
          ),
        execution_mode: z
          .enum(['host', 'container'])
          .optional()
          .describe(
            'Execution mode: host runs directly on the server, container runs in Docker isolation',
          ),
        context_mode: z
          .enum(['group', 'isolated'])
          .default('group')
          .describe(
            '(agent mode only) group=runs with persistent workspace context (recommended), isolated=fresh session each time',
          ),
        target_group_jid: z
          .string()
          .optional()
          .describe(
            '(Admin home only) JID of the group to schedule the task for. Defaults to the current group.',
          ),
      },
      async (args) => {
        const execType = args.execution_type || 'agent';

        // Validate execution_type constraints
        if (execType === 'agent' && !args.prompt?.trim()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Agent mode requires a prompt. Provide instructions for what the agent should do.',
              },
            ],
            isError: true,
          };
        }
        if (execType === 'script' && !args.script_command?.trim()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Script mode requires script_command. Provide the shell command to execute.',
              },
            ],
            isError: true,
          };
        }
        if (execType === 'script' && !ctx.isAdminHome) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Only admin home container can create script tasks.',
              },
            ],
            isError: true,
          };
        }

        // Validate schedule_value before writing IPC
        if (args.schedule_type === 'cron') {
          try {
            CronExpressionParser.parse(args.schedule_value, { tz: process.env.TZ || 'Asia/Shanghai' });
          } catch {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
                },
              ],
              isError: true,
            };
          }
        } else if (args.schedule_type === 'interval') {
          const ms = parseInt(args.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
                },
              ],
              isError: true,
            };
          }
        } else if (args.schedule_type === 'once') {
          const date = new Date(args.schedule_value);
          if (isNaN(date.getTime())) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Invalid timestamp: "${args.schedule_value}". Use ISO 8601 format like "2026-02-01T15:30:00.000Z".`,
                },
              ],
              isError: true,
            };
          }
        }

        const targetJid =
          hasCrossGroupAccess && args.target_group_jid
            ? args.target_group_jid
            : ctx.chatJid;
        const requestId = newRequestId();
        const data: Record<string, unknown> & { requestId: string } = {
          type: 'schedule_task',
          requestId,
          prompt: args.prompt || '',
          schedule_type: args.schedule_type,
          schedule_value: args.schedule_value,
          context_mode: args.context_mode || 'group',
          execution_type: execType,
          targetJid,
          createdBy: ctx.groupFolder,
          timestamp: new Date().toISOString(),
        };
        if (execType === 'script') {
          data.script_command = args.script_command;
        }
        if (args.execution_mode) {
          data.execution_mode = args.execution_mode;
        }
        const modeLabel = execType === 'script' ? 'script' : 'agent';
        // 改为阻塞确认：等主进程真正落库后回执，避免 fire-and-forget 的“报成功但没建成”。
        try {
          const result = await pollIpcResult(TASKS_DIR, data, 'schedule_task_result');
          if (!result.success) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to schedule task: ${result.error || 'Unknown error'}`,
                },
              ],
              isError: true,
            };
          }
          const nextRun = result.nextRun
            ? ` 下次触发：${formatIsoLocal(result.nextRun as string)}`
            : '';
          const dup = result.duplicate
            ? '（已存在完全相同的活动任务，未重复创建，返回的是已有任务）'
            : '';
          return {
            content: [
              {
                type: 'text' as const,
                text: `Task scheduled [${modeLabel}] id=${result.taskId ?? '?'}: ${args.schedule_type} - ${args.schedule_value}.${nextRun}${dup}`,
              },
            ],
          };
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Timeout waiting for schedule_task confirmation. 任务可能已创建也可能未创建——请先用 list_tasks 核实，不要直接重试以免重复创建。',
              },
            ],
            isError: true,
          };
        }
      },
    ),

    // --- list_tasks ---
    tool(
      'list_tasks',
      "List all scheduled tasks. From admin home: shows all tasks. From other groups: shows only that group's tasks.",
      {},
      async () => {
        const requestId = newRequestId();
        try {
          const result = await pollIpcResult(
            TASKS_DIR,
            {
              type: 'list_tasks',
              requestId,
              groupFolder: ctx.groupFolder,
              isAdminHome: hasCrossGroupAccess,
              timestamp: new Date().toISOString(),
            },
            'list_tasks_result',
          );
          if (!result.success) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error listing tasks: ${result.error || 'Unknown error'}`,
                },
              ],
              isError: true,
            };
          }
          const tasks = (result.tasks || []) as Array<{
            id: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }>;
          if (tasks.length === 0) {
            return {
              content: [
                { type: 'text' as const, text: 'No scheduled tasks found.' },
              ],
            };
          }
          const formatted = tasks
            .map(
              (t) =>
                `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${formatIsoLocal(t.next_run)}`,
            )
            .join('\n');
          return {
            content: [
              { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
            ],
          };
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Timeout waiting for task list response.',
              },
            ],
            isError: true,
          };
        }
      },
    ),

    // --- pause_task ---
    tool(
      'pause_task',
      'Pause a scheduled task. It will not run until resumed.',
      { task_id: z.string().describe('The task ID to pause') },
      async (args) => {
        const data = {
          type: 'pause_task',
          requestId: newRequestId(),
          taskId: args.task_id,
          groupFolder: ctx.groupFolder,
          isMain: hasCrossGroupAccess,
          timestamp: new Date().toISOString(),
        };
        try {
          const result = await pollIpcResult(TASKS_DIR, data, 'pause_task_result');
          if (!result.success) {
            return {
              content: [{ type: 'text' as const, text: `Failed to pause task ${args.task_id}: ${result.error || 'Unknown error'}` }],
              isError: true,
            };
          }
          return { content: [{ type: 'text' as const, text: `Task ${args.task_id} paused.` }] };
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Timeout waiting for pause confirmation for task ${args.task_id}.` }],
            isError: true,
          };
        }
      },
    ),

    // --- resume_task ---
    tool(
      'resume_task',
      'Resume a paused task.',
      { task_id: z.string().describe('The task ID to resume') },
      async (args) => {
        const data = {
          type: 'resume_task',
          requestId: newRequestId(),
          taskId: args.task_id,
          groupFolder: ctx.groupFolder,
          isMain: hasCrossGroupAccess,
          timestamp: new Date().toISOString(),
        };
        try {
          const result = await pollIpcResult(TASKS_DIR, data, 'resume_task_result');
          if (!result.success) {
            return {
              content: [{ type: 'text' as const, text: `Failed to resume task ${args.task_id}: ${result.error || 'Unknown error'}` }],
              isError: true,
            };
          }
          return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resumed.` }] };
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Timeout waiting for resume confirmation for task ${args.task_id}.` }],
            isError: true,
          };
        }
      },
    ),

    // --- cancel_task ---
    tool(
      'cancel_task',
      'Cancel and delete a scheduled task.',
      { task_id: z.string().describe('The task ID to cancel') },
      async (args) => {
        const data = {
          type: 'cancel_task',
          requestId: newRequestId(),
          taskId: args.task_id,
          groupFolder: ctx.groupFolder,
          isMain: hasCrossGroupAccess,
          timestamp: new Date().toISOString(),
        };
        try {
          const result = await pollIpcResult(TASKS_DIR, data, 'cancel_task_result');
          if (!result.success) {
            return {
              content: [{ type: 'text' as const, text: `Failed to cancel task ${args.task_id}: ${result.error || 'Unknown error'}` }],
              isError: true,
            };
          }
          return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancelled and deleted.` }] };
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Timeout waiting for cancel confirmation for task ${args.task_id}.` }],
            isError: true,
          };
        }
      },
    ),

    // --- update_task ---
    tool(
      'update_task',
      `Update an existing scheduled task IN PLACE. Strongly PREFER this over cancel_task + schedule_task when modifying an existing task: delete-then-recreate risks leaving a duplicate (if the delete silently fails) or losing the task entirely. Only the fields you pass are changed; omit a field to keep its current value.`,
      {
        task_id: z.string().describe('The task ID to update'),
        prompt: z.string().optional().describe('New action/instructions for the task (agent mode)'),
        schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type. If you change this you MUST also pass schedule_value.'),
        schedule_value: z
          .string()
          .optional()
          .describe('New schedule value (LOCAL time): cron expr | interval ms | once "2026-02-01T15:30:00" (no Z).'),
        context_mode: z.enum(['group', 'isolated']).optional().describe('New context mode (agent mode)'),
        execution_type: z.enum(['agent', 'script']).optional().describe('New execution type (script is admin only)'),
        script_command: z.string().max(4096).optional().describe('New shell command (script mode)'),
        execution_mode: z.enum(['host', 'container']).optional().describe('New execution mode (host is admin only)'),
      },
      async (args) => {
        // 改 schedule_type 必须同时给 schedule_value，否则主进程无法据新类型重算 next_run。
        if (args.schedule_type && !args.schedule_value) {
          return {
            content: [{ type: 'text' as const, text: 'When changing schedule_type you must also provide a matching schedule_value.' }],
            isError: true,
          };
        }
        const data: Record<string, unknown> & { requestId: string } = {
          type: 'update_task',
          requestId: newRequestId(),
          taskId: args.task_id,
          groupFolder: ctx.groupFolder,
          isMain: hasCrossGroupAccess,
          timestamp: new Date().toISOString(),
        };
        for (const k of ['prompt', 'schedule_type', 'schedule_value', 'context_mode', 'execution_type', 'script_command', 'execution_mode'] as const) {
          if (args[k] !== undefined) data[k] = args[k];
        }
        try {
          const result = await pollIpcResult(TASKS_DIR, data, 'update_task_result');
          if (!result.success) {
            return {
              content: [{ type: 'text' as const, text: `Failed to update task ${args.task_id}: ${result.error || 'Unknown error'}` }],
              isError: true,
            };
          }
          const nextRun = result.nextRun ? ` 下次触发：${formatIsoLocal(result.nextRun as string)}` : '';
          return { content: [{ type: 'text' as const, text: `Task ${args.task_id} updated.${nextRun}` }] };
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Timeout waiting for update confirmation for task ${args.task_id}.` }],
            isError: true,
          };
        }
      },
    ),

    // --- register_group ---
    tool(
      'register_group',
      `Register a new group so the agent can respond to messages there. Admin home only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").
You can optionally specify execution_mode: "container" (default, isolated Docker) or "host" (direct host access, admin only).`,
      {
        jid: z.string().describe('The chat JID (e.g., "feishu:oc_xxxx")'),
        name: z.string().describe('Display name for the group'),
        folder: z
          .string()
          // Strict regex: prevent path traversal / absolute paths flowing into
          // host's path.join(GROUPS_DIR, folder). The host re-validates with
          // the same shape — this is the documentation copy.
          .regex(
            /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
            'folder must be alphanumerics + ._- (no slashes, no leading dot, ≤128 chars)',
          )
          .describe(
            'Folder name for group files (lowercase, hyphens, e.g., "family-chat")',
          ),
        execution_mode: z
          .enum(['container', 'host'])
          .optional()
          .describe(
            'Execution mode: "container" (default, isolated Docker) or "host" (direct host access)',
          ),
      },
      async (args) => {
        if (!hasCrossGroupAccess) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Only the admin home container can register new groups.',
              },
            ],
            isError: true,
          };
        }
        const data = {
          type: 'register_group',
          jid: args.jid,
          name: args.name,
          folder: args.folder,
          executionMode: args.execution_mode,
          timestamp: new Date().toISOString(),
        };
        writeIpcFile(TASKS_DIR, data);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
            },
          ],
        };
      },
    ),

    // --- discord_get_history ---
    tool(
      'discord_get_history',
      `Fetch recent messages from the current Discord channel or DM. Only works when the current chat is a Discord channel.
Returns up to 100 messages per call (default 50), ordered oldest-first. Use "before" with a message ID to paginate older messages.`,
      {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Number of messages to fetch (1-100, default 50)'),
        before: z
          .string()
          .regex(/^\d{17,20}$/, 'must be a Discord snowflake')
          .optional()
          .describe(
            'Message ID (snowflake) — only return messages older than this. Use the "id" of the oldest message in your previous batch to paginate.',
          ),
      },
      async (args) => {
        if (!ctx.chatJid.startsWith('discord:')) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: discord_get_history only works in Discord channels. Current chat: ${ctx.chatJid}`,
              },
            ],
            isError: true,
          };
        }
        const requestId = newRequestId();
        try {
          const result = await pollIpcResult(
            TASKS_DIR,
            {
              type: 'discord_get_history',
              chatJid: ctx.chatJid,
              limit: args.limit,
              before: args.before,
              requestId,
              timestamp: new Date().toISOString(),
            },
            'discord_get_history_result',
          );
          if (!result.success) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error fetching Discord history: ${result.error || 'Unknown error'}`,
                },
              ],
              isError: true,
            };
          }
          const messages = (result.messages || []) as Array<{
            id: string;
            authorName: string;
            authorBot: boolean;
            content: string;
            timestamp: string;
            attachments: Array<{ name: string; url: string }>;
            replyToId?: string;
            edited: boolean;
          }>;
          if (messages.length === 0) {
            return {
              content: [
                { type: 'text' as const, text: 'No messages found in this channel.' },
              ],
            };
          }
          const formatted = messages
            .map((m) => {
              const tag = m.authorBot ? ' [bot]' : '';
              const editFlag = m.edited ? ' (edited)' : '';
              const replyFlag = m.replyToId ? ` ↪${m.replyToId}` : '';
              const attachStr =
                m.attachments.length > 0
                  ? `\n  📎 ${m.attachments.map((a) => a.name).join(', ')}`
                  : '';
              return `[${m.timestamp}] ${m.authorName}${tag}${replyFlag}${editFlag} (id=${m.id})\n  ${m.content || '(empty)'}${attachStr}`;
            })
            .join('\n\n');
          return {
            content: [
              {
                type: 'text' as const,
                text: `Discord history (${messages.length} messages, oldest first):\n\n${formatted}`,
              },
            ],
          };
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Timeout waiting for Discord history response.',
              },
            ],
            isError: true,
          };
        }
      },
    ),

    // --- discord_get_channel_info ---
    tool(
      'discord_get_channel_info',
      `Get metadata for the current Discord channel: name, type (guild_text/dm/etc), topic, NSFW flag, parent (category) ID, and guild ID.
Only works when the current chat is a Discord channel.`,
      {},
      async () => {
        if (!ctx.chatJid.startsWith('discord:')) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: discord_get_channel_info only works in Discord channels. Current chat: ${ctx.chatJid}`,
              },
            ],
            isError: true,
          };
        }
        const requestId = newRequestId();
        try {
          const result = await pollIpcResult(
            TASKS_DIR,
            {
              type: 'discord_get_channel_info',
              chatJid: ctx.chatJid,
              requestId,
              timestamp: new Date().toISOString(),
            },
            'discord_get_channel_info_result',
          );
          if (!result.success) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error fetching Discord channel info: ${result.error || 'Unknown error'}`,
                },
              ],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: `Discord channel info:\n${JSON.stringify(result.channel, null, 2)}`,
              },
            ],
          };
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Timeout waiting for Discord channel info response.',
              },
            ],
            isError: true,
          };
        }
      },
    ),

    // --- discord_get_server_info ---
    tool(
      'discord_get_server_info',
      `Get metadata for the Discord server (guild) the current channel belongs to: name, description, owner ID, member count, icon URL.
Returns null if the current chat is a DM (DMs do not belong to a server). Only works when the current chat is a Discord channel.`,
      {},
      async () => {
        if (!ctx.chatJid.startsWith('discord:')) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: discord_get_server_info only works in Discord channels. Current chat: ${ctx.chatJid}`,
              },
            ],
            isError: true,
          };
        }
        const requestId = newRequestId();
        try {
          const result = await pollIpcResult(
            TASKS_DIR,
            {
              type: 'discord_get_server_info',
              chatJid: ctx.chatJid,
              requestId,
              timestamp: new Date().toISOString(),
            },
            'discord_get_server_info_result',
          );
          if (!result.success) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error fetching Discord server info: ${result.error || 'Unknown error'}`,
                },
              ],
              isError: true,
            };
          }
          if (result.guild === null) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'This is a DM channel — no server (guild) information available.',
                },
              ],
            };
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: `Discord server info:\n${JSON.stringify(result.guild, null, 2)}`,
              },
            ],
          };
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Timeout waiting for Discord server info response.',
              },
            ],
            isError: true,
          };
        }
      },
    ),
  ];

  // Skill 安装/卸载仅限主容器（与 memory_* 工具一致）
  if (ctx.isHome) {
    tools.push(
      // --- install_skill ---
      tool(
        'install_skill',
        `Install a skill from the skills registry (skills.sh). The skill will be available in future conversations.
Example packages: "anthropic/memory", "anthropic/think", "owner/repo", "owner/repo@skill-name".`,
        {
          package: z
            .string()
            .describe(
              'The skill package to install, format: owner/repo or owner/repo@skill',
            ),
        },
        async (args) => {
          const pkg = args.package.trim();
          if (
            !/^[\w\-]+\/[\w\-.]+(?:[@#][\w\-.\/]+)?$/.test(pkg) &&
            !/^https?:\/\//.test(pkg)
          ) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Invalid package format: "${pkg}". Expected format: owner/repo or owner/repo@skill`,
                },
              ],
              isError: true,
            };
          }

          const requestId = newRequestId();
          try {
            const result = await pollIpcResult(
              TASKS_DIR,
              {
                type: 'install_skill',
                package: pkg,
                requestId,
                groupFolder: ctx.groupFolder,
                timestamp: new Date().toISOString(),
              },
              'install_skill_result',
              120_000,
            );
            if (result.success) {
              const installed =
                ((result.installed as string[]) || []).join(', ') || pkg;
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Skill installed successfully: ${installed}\n\nNote: The skill will be available in the next conversation (new container/process).`,
                  },
                ],
              };
            } else {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Failed to install skill "${pkg}": ${result.error || 'Unknown error'}`,
                  },
                ],
                isError: true,
              };
            }
          } catch {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Timeout waiting for skill installation result (120s). The installation may still be in progress.`,
                },
              ],
              isError: true,
            };
          }
        },
      ),

      // --- uninstall_skill ---
      tool(
        'uninstall_skill',
        `Uninstall a user-level skill by its ID. Project-level skills cannot be uninstalled.
Use the skills panel in the UI to find the skill ID (directory name, e.g. "memory", "think").`,
        {
          skill_id: z
            .string()
            .describe(
              'The skill ID to uninstall (the directory name, e.g. "memory", "think")',
            ),
        },
        async (args) => {
          const skillId = args.skill_id.trim();
          if (!skillId || !/^[\w\-]+$/.test(skillId)) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Invalid skill ID: "${skillId}". Must be alphanumeric with hyphens/underscores.`,
                },
              ],
              isError: true,
            };
          }

          const requestId = newRequestId();
          try {
            const result = await pollIpcResult(
              TASKS_DIR,
              {
                type: 'uninstall_skill',
                skillId,
                requestId,
                groupFolder: ctx.groupFolder,
                timestamp: new Date().toISOString(),
              },
              'uninstall_skill_result',
            );
            if (result.success) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Skill "${skillId}" uninstalled successfully.`,
                  },
                ],
              };
            } else {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Failed to uninstall skill "${skillId}": ${result.error || 'Unknown error'}`,
                  },
                ],
                isError: true,
              };
            }
          } catch {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Timeout waiting for skill uninstall result.`,
                },
              ],
              isError: true,
            };
          }
        },
      ),

      // --- create_skill ---
      tool(
        'create_skill',
        `Create a new user-level skill from a natural-language description. The AI will generate a complete SKILL.md (YAML frontmatter + Markdown body) and register it to the user's skill list. The skill will be available in the next conversation.
Use this when the user describes a reusable capability that should be persisted as a skill (e.g. "每天爬取 GitHub trending" → skill "github-trending").`,
        {
          description_prompt: z
            .string()
            .min(10)
            .describe(
              'Natural-language description of what the skill should do. At least 10 characters.',
            ),
          name: z
            .string()
            .optional()
            .describe(
              'Optional suggested skill name (kebab-case). If omitted, the AI will choose based on the description.',
            ),
        },
        async (args) => {
          const descriptionPrompt = args.description_prompt.trim();
          if (descriptionPrompt.length < 10) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'description_prompt must be at least 10 characters.',
                },
              ],
              isError: true,
            };
          }
          const name = args.name?.trim() || undefined;

          const requestId = newRequestId();
          try {
            const result = await pollIpcResult(
              TASKS_DIR,
              {
                type: 'create_skill',
                descriptionPrompt,
                name,
                requestId,
                groupFolder: ctx.groupFolder,
                timestamp: new Date().toISOString(),
              },
              'create_skill_result',
              150_000,
            );
            if (result.success) {
              const skillId = result.skillId as string;
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Skill created successfully: ${skillId}\n\nNote: The skill will be available in the next conversation (new container/process).`,
                  },
                ],
              };
            } else {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Failed to create skill: ${result.error || 'Unknown error'}`,
                  },
                ],
                isError: true,
              };
            }
          } catch {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Timeout waiting for skill creation result (150s). The AI generation may still be in progress.`,
                },
              ],
              isError: true,
            };
          }
        },
      ),
    );
  }

  // --- memory_append --- (only available for home containers, skipped in native Claude mode)
  if (ctx.isHome && !ctx.disableMemoryLayer) {
    tools.push(
      tool(
        'memory_append',
        `\u5c06**\u65f6\u6548\u6027\u8bb0\u5fc6**\u8ffd\u52a0\u5230 memory/YYYY-MM-DD.md\uff08\u72ec\u7acb\u8bb0\u5fc6\u76ee\u5f55\uff0c\u4e0d\u5728\u5de5\u4f5c\u533a\u5185\uff09\u3002
\u4ec5\u8ffd\u52a0\u5199\u5165\uff0c\u4e0d\u4f1a\u8986\u76d6\u5df2\u6709\u5185\u5bb9\u3002

\u4ec5\u7528\u4e8e\u660e\u786e\u53ea\u8ddf\u5f53\u5929/\u77ed\u671f\u6709\u5173\u7684\u4fe1\u606f\uff1a\u4eca\u65e5\u9879\u76ee\u8fdb\u5c55\u3001\u4e34\u65f6\u6280\u672f\u51b3\u7b56\u3001\u5f85\u529e\u4e8b\u9879\u3001\u4f1a\u8bae\u8981\u70b9\u7b49\u3002

**\u91cd\u8981**\uff1a\u4e0b\u6b21\u5bf9\u8bdd\u4ecd\u53ef\u80fd\u7528\u5230\u7684\u4fe1\u606f\uff08\u7528\u6237\u8eab\u4efd\u3001\u504f\u597d\u3001\u5e38\u7528\u9879\u76ee\u3001\u7528\u6237\u8bf4\u201c\u8bb0\u4f4f\u201d\u7684\u5185\u5bb9\uff09\u5e94\u76f4\u63a5\u7528 Edit \u5de5\u5177\u7f16\u8f91 /workspace/global/CLAUDE.md\uff0c\u4e0d\u8981\u7528\u6b64\u5de5\u5177\u3002`,
        {
          content: z
            .string()
            .describe('\u8981\u8ffd\u52a0\u7684\u8bb0\u5fc6\u5185\u5bb9'),
          date: z
            .string()
            .optional()
            .describe(
              '\u76ee\u6807\u65e5\u671f\uff0c\u683c\u5f0f YYYY-MM-DD\uff08\u9ed8\u8ba4\uff1a\u4eca\u5929\uff09',
            ),
        },
        async (args) => {
          const normalizedContent = args.content.replace(/\r\n?/g, '\n').trim();
          if (!normalizedContent) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: '\u5185\u5bb9\u4e0d\u80fd\u4e3a\u7a7a\u3002',
                },
              ],
              isError: true,
            };
          }
          const appendBytes = Buffer.byteLength(normalizedContent, 'utf-8');
          if (appendBytes > MAX_MEMORY_APPEND_SIZE) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `\u5185\u5bb9\u8fc7\u5927\uff1a${appendBytes} \u5b57\u8282\uff08\u4e0a\u9650 ${MAX_MEMORY_APPEND_SIZE}\uff09\u3002`,
                },
              ],
              isError: true,
            };
          }
          const date = (
            args.date ?? new Date().toISOString().split('T')[0]
          ).trim();
          if (!MEMORY_DATE_PATTERN.test(date)) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `\u65e5\u671f\u683c\u5f0f\u65e0\u6548\uff1a\u201c${date}\u201d\uff0c\u8bf7\u4f7f\u7528 YYYY-MM-DD\u3002`,
                },
              ],
              isError: true,
            };
          }
          const resolvedPath = path.normalize(
            path.join(ctx.workspaceMemory, `${date}.md`),
          );
          const inMemory =
            resolvedPath === ctx.workspaceMemory ||
            resolvedPath.startsWith(ctx.workspaceMemory + path.sep);
          if (!inMemory) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: '\u8bbf\u95ee\u88ab\u62d2\u7edd\uff1a\u8def\u5f84\u8d85\u51fa\u5de5\u4f5c\u533a\u8303\u56f4\u3002',
                },
              ],
              isError: true,
            };
          }
          try {
            fs.mkdirSync(ctx.workspaceMemory, { recursive: true });
            const fileExists = fs.existsSync(resolvedPath);
            const currentSize = fileExists ? fs.statSync(resolvedPath).size : 0;
            const separator = currentSize > 0 ? '\n---\n\n' : '';
            const entry = `${separator}### ${new Date().toISOString()}\n${normalizedContent}\n`;
            const nextSize = currentSize + Buffer.byteLength(entry, 'utf-8');
            if (nextSize > MAX_MEMORY_FILE_SIZE) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `\u8bb0\u5fc6\u6587\u4ef6\u5c06\u8d85\u8fc7 ${MAX_MEMORY_FILE_SIZE} \u5b57\u8282\u4e0a\u9650\uff0c\u8bf7\u7f29\u77ed\u5185\u5bb9\u3002`,
                  },
                ],
                isError: true,
              };
            }
            fs.appendFileSync(resolvedPath, entry, 'utf-8');
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `\u5df2\u8ffd\u52a0\u5230 memory/${date}.md\uff08${appendBytes} \u5b57\u8282\uff09\u3002`,
                },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `\u8ffd\u52a0\u8bb0\u5fc6\u65f6\u51fa\u9519\uff1a${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),
    );
  }

  // --- memory_search + memory_get --- (skipped in native Claude mode)
  if (!ctx.disableMemoryLayer) {
    tools.push(
    tool(
      'memory_search',
      `\u5728\u5de5\u4f5c\u533a\u7684\u8bb0\u5fc6\u6587\u4ef6\u4e2d\u641c\u7d22\uff08CLAUDE.md\u3001memory/\u3001conversations/ \u53ca\u5176\u4ed6 .md/.txt \u6587\u4ef6\uff09\u3002
\u8fd4\u56de\u6587\u4ef6\u8def\u5f84\u3001\u884c\u53f7\u548c\u4e0a\u4e0b\u6587\u7247\u6bb5\u3002\u8d85\u8fc7 512KB \u7684\u6587\u4ef6\u4f1a\u88ab\u8df3\u8fc7\u3002
\u7528\u4e8e\u56de\u5fc6\u8fc7\u53bb\u7684\u51b3\u7b56\u3001\u504f\u597d\u3001\u9879\u76ee\u4e0a\u4e0b\u6587\u6216\u5bf9\u8bdd\u5386\u53f2\u3002`,
      {
        query: z
          .string()
          .describe(
            '\u641c\u7d22\u5173\u952e\u8bcd\u6216\u77ed\u8bed\uff08\u4e0d\u533a\u5206\u5927\u5c0f\u5199\uff09',
          ),
        max_results: z
          .number()
          .optional()
          .default(20)
          .describe(
            '\u6700\u5927\u7ed3\u679c\u6570\uff08\u9ed8\u8ba4 20\uff0c\u4e0a\u9650 50\uff09',
          ),
      },
      async (args) => {
        if (!args.query.trim()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: '\u641c\u7d22\u5173\u952e\u8bcd\u4e0d\u80fd\u4e3a\u7a7a\u3002',
              },
            ],
            isError: true,
          };
        }
        const maxResults = Math.min(Math.max(args.max_results ?? 20, 1), 50);
        const queryLower = args.query.toLowerCase();
        const files: string[] = [];
        collectMemoryFiles(ctx.workspaceMemory, files, 4);
        collectMemoryFiles(ctx.workspaceGroup, files, 4);
        collectMemoryFiles(ctx.workspaceGlobal, files, 4);
        const uniqueFiles = Array.from(new Set(files));
        if (uniqueFiles.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: '\u672a\u627e\u5230\u8bb0\u5fc6\u6587\u4ef6\u3002',
              },
            ],
          };
        }
        const results: string[] = [];
        let skippedLarge = 0;
        for (const filePath of uniqueFiles) {
          if (results.length >= maxResults) break;
          try {
            const stat = fs.statSync(filePath);
            if (stat.size > MAX_MEMORY_FILE_SIZE) {
              skippedLarge++;
              continue;
            }
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');
            let lastEnd = -1;
            for (let i = 0; i < lines.length; i++) {
              if (results.length >= maxResults) break;
              if (lines[i].toLowerCase().includes(queryLower)) {
                const start = Math.max(0, i - 1);
                if (start <= lastEnd) continue;
                const end = Math.min(lines.length, i + 2);
                lastEnd = end;
                const snippet = lines.slice(start, end).join('\n');
                results.push(
                  `${toRelativePath(filePath)}:${i + 1}\n${snippet}`,
                );
              }
            }
          } catch {
            /* skip unreadable */
          }
        }
        const skippedNote =
          skippedLarge > 0
            ? `\uff08\u8df3\u8fc7 ${skippedLarge} \u4e2a\u5927\u6587\u4ef6\uff09`
            : '';
        if (results.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `\u5728 ${uniqueFiles.length} \u4e2a\u8bb0\u5fc6\u6587\u4ef6\u4e2d\u672a\u627e\u5230\u201c${args.query}\u201d\u7684\u5339\u914d\u3002${skippedNote}`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `\u627e\u5230 ${results.length} \u6761\u5339\u914d${skippedNote}\uff1a\n\n${results.join('\n---\n')}`,
            },
          ],
        };
      },
    ),

    // --- memory_get ---
    tool(
      'memory_get',
      `\u8bfb\u53d6\u8bb0\u5fc6\u6587\u4ef6\u6216\u6307\u5b9a\u884c\u8303\u56f4\u3002\u5728 memory_search \u4e4b\u540e\u4f7f\u7528\u4ee5\u83b7\u53d6\u5b8c\u6574\u4e0a\u4e0b\u6587\u3002`,
      {
        file: z
          .string()
          .describe(
            '\u76f8\u5bf9\u8def\u5f84\uff0c\u53ef\u5e26 :\u884c\u53f7\uff08\u5982 "CLAUDE.md:12"\u3001"[global] CLAUDE.md:8" \u6216 "[memory] 2026-01-15.md"\uff09',
          ),
        from_line: z
          .number()
          .optional()
          .describe(
            '\u8d77\u59cb\u884c\u53f7\uff08\u4ece 1 \u5f00\u59cb\uff0c\u9ed8\u8ba4\uff1a1\uff09',
          ),
        lines: z
          .number()
          .optional()
          .describe(
            '\u8bfb\u53d6\u884c\u6570\uff08\u9ed8\u8ba4\uff1a\u5168\u90e8\uff0c\u4e0a\u9650\uff1a200\uff09',
          ),
      },
      async (args) => {
        const { pathRef, lineFromRef } = parseMemoryFileReference(args.file);
        let resolvedPath: string;
        if (pathRef.startsWith('[global] ')) {
          resolvedPath = path.join(
            ctx.workspaceGlobal,
            pathRef.slice('[global] '.length),
          );
        } else if (pathRef.startsWith('[memory] ')) {
          resolvedPath = path.join(
            ctx.workspaceMemory,
            pathRef.slice('[memory] '.length),
          );
        } else {
          resolvedPath = path.join(ctx.workspaceGroup, pathRef);
        }
        resolvedPath = path.normalize(resolvedPath);
        const inGroup =
          resolvedPath === ctx.workspaceGroup ||
          resolvedPath.startsWith(ctx.workspaceGroup + path.sep);
        const inGlobal =
          resolvedPath === ctx.workspaceGlobal ||
          resolvedPath.startsWith(ctx.workspaceGlobal + path.sep);
        const inMemory =
          resolvedPath === ctx.workspaceMemory ||
          resolvedPath.startsWith(ctx.workspaceMemory + path.sep);
        if (!inGroup && !inGlobal && !inMemory) {
          return {
            content: [
              {
                type: 'text' as const,
                text: '\u8bbf\u95ee\u88ab\u62d2\u7edd\uff1a\u8def\u5f84\u8d85\u51fa\u5de5\u4f5c\u533a\u8303\u56f4\u3002',
              },
            ],
            isError: true,
          };
        }
        if (!fs.existsSync(resolvedPath)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `\u6587\u4ef6\u672a\u627e\u5230\uff1a${pathRef}`,
              },
            ],
            isError: true,
          };
        }
        try {
          const content = fs.readFileSync(resolvedPath, 'utf-8');
          const allLines = content.split('\n');
          const fromLine = Math.max(
            (args.from_line ?? lineFromRef ?? 1) - 1,
            0,
          );
          const maxLines = Math.min(args.lines ?? allLines.length, 200);
          const slice = allLines.slice(fromLine, fromLine + maxLines);
          const header = `${pathRef}\uff08\u7b2c ${fromLine + 1}-${fromLine + slice.length} \u884c\uff0c\u5171 ${allLines.length} \u884c\uff09`;
          return {
            content: [
              {
                type: 'text' as const,
                text: `${header}\n\n${slice.join('\n')}`,
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `\u8bfb\u53d6\u6587\u4ef6\u65f6\u51fa\u9519\uff1a${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }
      },
    ),
  );
  }

  // --- kb_search --- (only enabled when the group has bound KB mounts)
  if (ctx.kbIds && ctx.kbIds.length > 0) {
    tools.push(
      tool(
        'kb_search',
        `Search the knowledge bases bound to this Agent. Returns matching snippets ranked by relevance (FTS5 bm25). Currently bound KB count: ${ctx.kbIds.length}.`,
        {
          query: z
            .string()
            .describe('Search query — keywords or phrases. FTS5 syntax (AND/OR/NOT, "phrase", col:value).'),
          limit: z
            .number()
            .optional()
            .default(5)
            .describe('Max results (default 5, max 20)'),
        },
        async (args) => {
          if (!args.query.trim()) {
            return {
              content: [{ type: 'text' as const, text: 'Query cannot be empty.' }],
              isError: true,
            };
          }
          const limit = Math.min(Math.max(args.limit ?? 5, 1), 20);
          const requestId = newRequestId();
          try {
            const result = await pollIpcResult(
              TASKS_DIR,
              {
                type: 'kb_search',
                requestId,
                groupFolder: ctx.groupFolder,
                kbIds: ctx.kbIds,
                query: args.query,
                limit,
                timestamp: new Date().toISOString(),
              },
              'kb_search_result',
              15_000,
            );
            if (!result.success) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `KB search failed: ${result.error || 'Unknown error'}`,
                  },
                ],
                isError: true,
              };
            }
            const hits = (result.results || []) as Array<{
              kb_id: string;
              kb_name?: string;
              doc_id: string;
              filename: string;
              snippet: string;
              rank: number;
            }>;
            if (hits.length === 0) {
              return {
                content: [{ type: 'text' as const, text: 'No matching documents found in bound KBs.' }],
              };
            }
            const lines = hits.map(
              (h, i) =>
                `### ${i + 1}. ${h.filename}${h.kb_name ? ` (KB: ${h.kb_name})` : ''}\n${h.snippet}`,
            );
            return {
              content: [
                { type: 'text' as const, text: `Found ${hits.length} match(s):\n\n${lines.join('\n\n')}` },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `KB search IPC error: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),
    );
  }

  // --- sandbox_* tools ---
  // Agents run untrusted code in an isolated Docker sandbox (deepthink-sandbox:latest).
  // The host process handles the actual docker run/exec; agent-runner just forwards
  // requests via IPC files in tasks/ dir and polls for results.
  tools.push(
    tool(
      'sandbox_run_code',
      'Execute code in an isolated Docker sandbox (Python/Node/Shell). Returns stdout/stderr/exit_code/duration. The sandbox is reused across calls within the same agent session. P0 hardening: non-root user, read-only rootfs, tmpfs /workspace, seccomp default-deny, cap-drop ALL, memory/cpu/pids limits, network disabled (for non-browser sandboxes).',
      {
        language: z.enum(['python', 'node', 'sh']).describe('Code language'),
        code: z.string().describe('Code to execute'),
        stdin: z.string().optional().describe('Optional stdin input'),
        timeout_ms: z.number().optional().describe('Wall-clock timeout in ms (default 30000, max 300000)'),
      },
      async (args) => {
        const requestId = newRequestId();
        try {
          const result = await pollIpcResult(
            TASKS_DIR,
            {
              type: 'sandbox_run_code',
              requestId,
              groupFolder: ctx.groupFolder,
              language: args.language,
              code: args.code,
              stdin: args.stdin ?? '',
              timeoutMs: args.timeout_ms ?? 30_000,
              timestamp: new Date().toISOString(),
            },
            'sandbox_run_code_result',
            Math.min((args.timeout_ms ?? 30_000) + 15_000, 120_000),
          );
          if (!result.success) {
            return {
              content: [{ type: 'text' as const, text: `Sandbox exec failed: ${result.error || 'Unknown'}` }],
              isError: true,
            };
          }
          const r = result.result as {
            status: string;
            exit_code: number | null;
            stdout: string;
            stderr: string;
            truncated: boolean;
            duration_ms: number;
            session_id: string;
          };
          const lines: string[] = [];
          lines.push(`status=${r.status} exit_code=${r.exit_code} duration_ms=${r.duration_ms} session=${r.session_id?.slice(0, 14) ?? 'n/a'}`);
          if (r.truncated) lines.push('WARNING: stdout/stderr truncated');
          if (r.stdout) lines.push('--- stdout ---\n' + r.stdout);
          if (r.stderr) lines.push('--- stderr ---\n' + r.stderr);
          return {
            content: [{ type: 'text' as const, text: lines.join('\n') }],
          };
        } catch (err) {
          return {
            content: [
              { type: 'text' as const, text: `Sandbox IPC error: ${err instanceof Error ? err.message : String(err)}` },
            ],
            isError: true,
          };
        }
      },
    ),
    tool(
      'sandbox_browser_navigate',
      'Navigate the sandbox browser to a URL. Requires the sandbox to be created with browserEnabled=true (the host will auto-create a browser-enabled sandbox if none exists).',
      { url: z.string().describe('URL to navigate to') },
      async (args) => {
        const requestId = newRequestId();
        try {
          const result = await pollIpcResult(
            TASKS_DIR,
            {
              type: 'sandbox_browser_navigate',
              requestId,
              groupFolder: ctx.groupFolder,
              url: args.url,
              timestamp: new Date().toISOString(),
            },
            'sandbox_browser_navigate_result',
            30_000,
          );
          if (!result.success) {
            return {
              content: [{ type: 'text' as const, text: `Browser navigate failed: ${result.error || 'Unknown'}` }],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text' as const, text: `Navigated to ${args.url}` }],
          };
        } catch (err) {
          return {
            content: [
              { type: 'text' as const, text: `Browser IPC error: ${err instanceof Error ? err.message : String(err)}` },
            ],
            isError: true,
          };
        }
      },
    ),
    tool(
      'sandbox_browser_click',
      'Click an element matched by a CSS selector in the sandbox browser.',
      { selector: z.string().describe('CSS selector') },
      async (args) => {
        const requestId = newRequestId();
        try {
          const result = await pollIpcResult(
            TASKS_DIR,
            {
              type: 'sandbox_browser_click',
              requestId,
              groupFolder: ctx.groupFolder,
              selector: args.selector,
              timestamp: new Date().toISOString(),
            },
            'sandbox_browser_click_result',
            15_000,
          );
          if (!result.success) {
            return {
              content: [{ type: 'text' as const, text: `Browser click failed: ${result.error || 'Unknown'}` }],
              isError: true,
            };
          }
          return { content: [{ type: 'text' as const, text: 'Clicked.' }] };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Browser IPC error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      },
    ),
    tool(
      'sandbox_browser_type',
      'Type text into an element matched by a CSS selector in the sandbox browser.',
      {
        selector: z.string().describe('CSS selector'),
        text: z.string().describe('Text to type'),
      },
      async (args) => {
        const requestId = newRequestId();
        try {
          const result = await pollIpcResult(
            TASKS_DIR,
            {
              type: 'sandbox_browser_type',
              requestId,
              groupFolder: ctx.groupFolder,
              selector: args.selector,
              text: args.text,
              timestamp: new Date().toISOString(),
            },
            'sandbox_browser_type_result',
            15_000,
          );
          if (!result.success) {
            return {
              content: [{ type: 'text' as const, text: `Browser type failed: ${result.error || 'Unknown'}` }],
              isError: true,
            };
          }
          return { content: [{ type: 'text' as const, text: 'Typed.' }] };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Browser IPC error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      },
    ),
    tool(
      'sandbox_browser_screenshot',
      'Take a screenshot of the sandbox browser. Screenshot is saved to the workspace downloads dir and the path is returned.',
      {},
      async () => {
        const requestId = newRequestId();
        try {
          const result = await pollIpcResult(
            TASKS_DIR,
            {
              type: 'sandbox_browser_screenshot',
              requestId,
              groupFolder: ctx.groupFolder,
              timestamp: new Date().toISOString(),
            },
            'sandbox_browser_screenshot_result',
            15_000,
          );
          if (!result.success) {
            return {
              content: [{ type: 'text' as const, text: `Screenshot failed: ${result.error || 'Unknown'}` }],
              isError: true,
            };
          }
          const r = result.result as { url: string | null; title: string | null; saved_to: string | null };
          const lines: string[] = [];
          if (r.url) lines.push(`current URL: ${r.url}`);
          if (r.title) lines.push(`page title: ${r.title}`);
          if (r.saved_to) lines.push(`screenshot saved to: ${r.saved_to}`);
          return { content: [{ type: 'text' as const, text: lines.join('\n') || 'Screenshot taken.' }] };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Browser IPC error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      },
    ),
    tool(
      'sandbox_browser_evaluate',
      'Evaluate a JavaScript expression in the sandbox browser page and return the result.',
      { script: z.string().describe('JavaScript expression to evaluate') },
      async (args) => {
        const requestId = newRequestId();
        try {
          const result = await pollIpcResult(
            TASKS_DIR,
            {
              type: 'sandbox_browser_evaluate',
              requestId,
              groupFolder: ctx.groupFolder,
              script: args.script,
              timestamp: new Date().toISOString(),
            },
            'sandbox_browser_evaluate_result',
            15_000,
          );
          if (!result.success) {
            return {
              content: [{ type: 'text' as const, text: `Evaluate failed: ${result.error || 'Unknown'}` }],
              isError: true,
            };
          }
          const r = result.result as { value: unknown };
          return { content: [{ type: 'text' as const, text: `Value: ${JSON.stringify(r.value)}` }] };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Browser IPC error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      },
    ),
    tool(
      'sandbox_close',
      'Destroy the sandbox associated with the current agent session. Call this when sandbox work is done to free resources.',
      {},
      async () => {
        const requestId = newRequestId();
        try {
          const result = await pollIpcResult(
            TASKS_DIR,
            {
              type: 'sandbox_close',
              requestId,
              groupFolder: ctx.groupFolder,
              timestamp: new Date().toISOString(),
            },
            'sandbox_close_result',
            10_000,
          );
          if (!result.success) {
            return {
              content: [{ type: 'text' as const, text: `Sandbox close failed: ${result.error || 'Unknown'}` }],
              isError: true,
            };
          }
          return { content: [{ type: 'text' as const, text: 'Sandbox closed.' }] };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Sandbox IPC error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      },
    ),

    // ── WebSearch / WebFetch 重写（中国可用）──────────────────────────
    // 内置 WebSearch/WebFetch 在中国国内不可用（US-only 搜索后端 / 抓取失败）。
    // 这里用 SDK tool() 注册两个进程内 MCP 工具，配合 index.ts 的 toolAliases
    // 把模型 emit 的 WebSearch/WebFetch 路由到本实现。详见 docs/tech_solution。
    tool(
      'web_search',
      'Search the web (China-accessible, via Zhipu paas v4 web_search API). Returns titles/content/links/publish_date/media as JSON. Compatible with built-in WebSearch signature.',
      {
        query: z.string().describe('The search query (any topic, zh/en ok)'),
        count: z
          .number()
          .optional()
          .describe('Number of results to return (default 5)'),
        allowed_domains: z
          .array(z.string())
          .optional()
          .describe('Only include results whose link domain matches one of these'),
        blocked_domains: z
          .array(z.string())
          .optional()
          .describe('Exclude results whose link domain matches one of these'),
      },
      async (args) => {
        const apiKey = (process.env.ZHIPU_API_KEY || '').trim();
        if (!apiKey) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ status: 'error', query: args.query, results: [], error: 'missing ZHIPU_API_KEY' }),
            }],
          };
        }
        const base = (process.env.ZHIPU_WEB_SEARCH_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/$/, '');
        const count = args.count ?? 5;
        const t0 = Date.now();
        try {
          const resp = await fetch(`${base}/web_search`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              search_query: args.query,
              search_engine: 'search_std',
              count,
              content_size: 'medium',
            }),
            signal: AbortSignal.timeout(15_000),
          });
          if (!resp.ok) {
            const snippet = await resp.text().catch(() => '');
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ status: 'error', query: args.query, results: [], error: `http_${resp.status}: ${snippet.slice(0, 200)}`, latency_ms: Date.now() - t0 }),
              }],
            };
          }
          const data = (await resp.json()) as Record<string, unknown>;
          const raw = data.search_result ?? data.data ?? [];
          const items: Record<string, string>[] = Array.isArray(raw) ? (raw as Record<string, string>[]) : [];
          let normalized = items.slice(0, count).map((r) => ({
            title: r.title || '',
            content: r.content || r.snippet || '',
            link: r.link || r.url || '',
            publish_date: r.publish_date || r.date || '',
            media: r.media || r.source || '',
          }));
          normalized = filterByDomain(normalized, args.allowed_domains, args.blocked_domains);
          const status = normalized.length ? 'ok' : 'empty';
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ status, query: args.query, results: normalized, latency_ms: Date.now() - t0, error: null }),
            }],
          };
        } catch (err) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ status: 'error', query: args.query, results: [], error: err instanceof Error ? `${err.name}: ${err.message}` : String(err), latency_ms: Date.now() - t0 }),
            }],
          };
        }
      },
    ),

    tool(
      'web_fetch',
      'Fetch a URL and convert the page to Markdown (China-accessible direct fetch; GB18030/GBK charset aware). The calling Agent should answer the `prompt` against the returned markdown. Compatible with built-in WebFetch signature.',
      {
        url: z.string().describe('The URL to fetch (http/https)'),
        prompt: z.string().describe('What to extract or answer from the page content'),
      },
      async (args) => {
        const result = await fetchUrlAsMarkdown(args.url);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      },
    ),
  );

  return tools;
}

// ── WebFetch helpers ───────────────────────────────────────────────

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** 按 allowed_domains / blocked_domains 过滤结果（基于 link 域名）。 */
function filterByDomain<T extends { link: string }>(
  items: T[],
  allowed?: string[],
  blocked?: string[],
): T[] {
  let out = items;
  if (allowed && allowed.length) {
    const allow = new Set(allowed.map((d) => d.replace(/^www\./, '').toLowerCase()));
    out = out.filter((it) => {
      const d = domainOf(it.link).toLowerCase();
      return allow.has(d) || [...allow].some((a) => d.endsWith(a));
    });
  }
  if (blocked && blocked.length) {
    const block = new Set(blocked.map((d) => d.replace(/^www\./, '').toLowerCase()));
    out = out.filter((it) => {
      const d = domainOf(it.link).toLowerCase();
      return !block.has(d) && ![...block].some((b) => d.endsWith(b));
    });
  }
  return out;
}

/** 从 Content-Type 与 HTML meta 嗅探字符集；默认 utf-8。Node 22 支持 gb18030/gbk。 */
function sniffCharset(contentType: string | null, htmlHead: string): string {
  const ct = (contentType || '').toLowerCase();
  let m = ct.match(/charset\s*=\s*['"]?([\w-]+)/);
  if (m) return m[1];
  m = htmlHead.match(/<meta[^>]+charset\s*=\s*['"]?([\w-]+)/i);
  if (m) return m[1];
  m = htmlHead.match(/<meta[^>]+http-equiv[^>]+content\s*=\s*['"][^'"]*charset\s*=\s*([\w-]+)/i);
  if (m) return m[1];
  return 'utf-8';
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)));
}

/** 去除所有 HTML 标签，保留文本。 */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ');
}

/** 最小 HTML→Markdown 转换：去脚本/样式/导航，保留标题/段落/列表/链接/代码。 */
function htmlToMarkdown(html: string, maxChars = 20000): { title: string; markdown: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : '';

  let h = html.replace(/<(script|style|nav|footer|aside|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, ' ');
  h = h.replace(/<!--[\s\S]*?-->/g, ' ');

  h = h
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, lvl: string, inner: string) => `\n\n${'#'.repeat(Number(lvl))} ${stripTags(inner).trim()}\n\n`)
    .replace(/<a\b[^>]*href\s*=\s*['"]([^'"]*)['"][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => `[${stripTags(inner).trim()}](${href})`)
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => `\n\n\`\`\`\n${decodeHtmlEntities(stripTags(inner)).trim()}\n\`\`\`\n\n`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => `\`${decodeHtmlEntities(stripTags(inner)).trim()}\``)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `- ${stripTags(inner).trim()}\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|ul|ol|table|tr|blockquote)\s*>/gi, '\n\n')
    .replace(/<img\b[^>]*alt\s*=\s*['"]([^'"]*)['"][^>]*\/?>/gi, (_m, alt: string) => `![${alt}]()`);

  let text = stripTags(h);
  text = decodeHtmlEntities(text);
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n...[truncated]';
  return { title, markdown: text };
}

/** 抓取 URL 并转为 Markdown。零新依赖，Node 内置 fetch + TextDecoder。 */
async function fetchUrlAsMarkdown(url: string): Promise<{
  url: string;
  status: string;
  http_status?: number;
  title?: string;
  markdown?: string;
  note?: string;
  error?: string;
}> {
  if (!/^https?:\/\//i.test(url)) {
    return { url, status: 'error', error: 'invalid url: only http/https supported' };
  }
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) {
      const buf = await resp.arrayBuffer().catch(() => new ArrayBuffer(0));
      const snippet = new TextDecoder('utf-8').decode(buf).slice(0, 300);
      return { url, status: 'error', http_status: resp.status, error: `http_${resp.status}`, markdown: snippet };
    }
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    // 用 ascii 范围嗅探 meta charset（前 4KB 足够）
    const headAscii = new TextDecoder('utf-8').decode(bytes.slice(0, 4096)).replace(/\0/g, '');
    const charset = sniffCharset(resp.headers.get('content-type'), headAscii);
    let html: string;
    try {
      const cs = charset.toLowerCase();
      html = new TextDecoder(cs === 'gb2312' ? 'gb18030' : cs).decode(buf);
    } catch {
      html = new TextDecoder('utf-8').decode(buf);
    }
    const { title, markdown } = htmlToMarkdown(html);
    if (!markdown.trim()) {
      return { url, status: 'empty', title, markdown: '', note: 'Page content is empty (may require JavaScript rendering). Consider the browser tool.' };
    }
    return { url, status: 'ok', title, markdown, note: 'Answer the `prompt` using the markdown above.' };
  } catch (err) {
    return { url, status: 'error', error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}
