/**
 * DeepThink MCP Bridge — Standalone stdio MCP Server
 *
 * Bridges Codex/OpenCode engines (which spawn stdio MCP server subprocesses)
 * to DeepThink's built-in MCP tool set (send_message, schedule_task,
 * memory_*, etc.).
 *
 * Communication with the main process mirrors container/agent-runner/src/mcp-tools.ts:
 *   - Fire-and-forget tools (send_message): write JSON to {IPC_DIR}/messages/.
 *   - Request/response tools (schedule_task, list_tasks, pause/resume/cancel,
 *     register_group, install/uninstall_skill): write JSON with requestId to
 *     {IPC_DIR}/tasks/, poll for {type}_result_{requestId}.json. Main process
 *     already handles these.
 *   - Direct-file tools (memory_append/search/get): direct fs ops on workspace
 *     paths (workspaceMemory, workspaceGroup, workspaceGlobal).
 *
 * Context is passed via env vars (set by container-runner.ts when spawning
 * codex/opencode, which in turn spawn this bridge as their MCP subprocess):
 *   DT_CHAT_JID, DT_GROUP_FOLDER, DT_IS_HOME, DT_IS_ADMIN_HOME,
 *   DT_IPC_DIR, DT_WORKSPACE_GROUP, DT_WORKSPACE_GLOBAL, DT_WORKSPACE_MEMORY,
 *   DT_DISABLE_MEMORY_LAYER (optional)
 */

import fs from 'node:fs';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// ─── Context from env ───────────────────────────────────────
const CHAT_JID = process.env.DT_CHAT_JID ?? '';
const GROUP_FOLDER = process.env.DT_GROUP_FOLDER ?? '';
const IS_HOME = process.env.DT_IS_HOME === 'true';
const IS_ADMIN_HOME = process.env.DT_IS_ADMIN_HOME === 'true';
const IPC_DIR = process.env.DT_IPC_DIR ?? '';
const WORKSPACE_GROUP = process.env.DT_WORKSPACE_GROUP ?? '/workspace/group';
const WORKSPACE_GLOBAL = process.env.DT_WORKSPACE_GLOBAL ?? '/workspace/global';
const WORKSPACE_MEMORY = process.env.DT_WORKSPACE_MEMORY ?? '/workspace/memory';
const DISABLE_MEMORY_LAYER = process.env.DT_DISABLE_MEMORY_LAYER === 'true';

// ─── Distributed Redis mode ────────────────────────────────
const REDIS_URL = process.env.DT_REDIS_URL || process.env.REDIS_URL || '';
const DISTRIBUTED_MODE = process.env.DT_DISTRIBUTED_MODE === 'true' || process.env.AGENT_RUNNER_MODE === 'distributed';
const distributedMode = !!REDIS_URL && DISTRIBUTED_MODE;

let _redisPub: any = null;
let _redisSub: any = null;
let _redisConnected = false;

const IPC_OUTPUT_PREFIX = 'deepthink:ipc-out:';
const IPC_TASK_RESULT_PREFIX = 'deepthink:ipc-task:';

async function initRedisBridge(): Promise<void> {
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
    console.error('[mcp-bridge] Redis bridge connected — distributed IPC mode active');
  } catch (err) {
    console.error('[mcp-bridge] Redis connection failed, falling back to file-system IPC:', err);
    _redisConnected = false;
  }
}

async function redisPublishMessage(data: object): Promise<void> {
  if (!_redisConnected) return;
  try {
    await _redisPub.publish(
      `${IPC_OUTPUT_PREFIX}${GROUP_FOLDER}:messages`,
      JSON.stringify(data),
    );
  } catch { /* non-fatal */ }
}

async function redisRequestTask(
  data: Record<string, unknown> & { requestId: string },
  resultFilePrefix: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const resultChannel = `${IPC_TASK_RESULT_PREFIX}${GROUP_FOLDER}:${data.requestId}`;
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

    // Publish the request to the tasks channel
    _redisPub.publish(
      `${IPC_OUTPUT_PREFIX}${GROUP_FOLDER}:tasks`,
      JSON.stringify(data),
    ).catch(() => {});
  });
}

if (!CHAT_JID || !GROUP_FOLDER || !IPC_DIR) {
  console.error('[mcp-bridge] Missing required env vars: DT_CHAT_JID, DT_GROUP_FOLDER, DT_IPC_DIR');
  process.exit(1);
}

const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// ─── IPC helpers (mirror mcp-tools.ts) ─────────────────────
function writeIpcFile(dir: string, data: object): void {
  // Distributed mode: send_message goes via Redis (fire-and-forget).
  // Task requests are handled by pollIpcResult's distributed path.
  if (_redisConnected && dir === MESSAGES_DIR) {
    redisPublishMessage(data).catch(() => {});
    return;
  }
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, filepath);
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    throw new Error(`IPC 写入失败 (${dir}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

function newRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function pollIpcResult(
  dir: string,
  data: Record<string, unknown> & { requestId: string },
  resultFilePrefix: string,
  timeoutMs: number = 30_000,
): Promise<Record<string, unknown>> {
  // Distributed mode: use Redis request/response pattern.
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
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }
  throw new Error(`Timeout waiting for IPC result (${timeoutMs / 1000}s)`);
}

function buildSendMessageData(extras: Record<string, unknown>): Record<string, unknown> {
  return {
    chatJid: CHAT_JID,
    groupFolder: GROUP_FOLDER,
    timestamp: new Date().toISOString(),
    ...extras,
  };
}

// ─── Memory helpers (mirror mcp-tools.ts) ──────────────────
const MEMORY_EXTENSIONS = new Set(['.md', '.txt']);
const MEMORY_SUBDIRS = new Set(['memory', 'conversations']);
const MEMORY_SKIP_DIRS = new Set(['logs', '.claude', 'node_modules', '.git']);
const MAX_MEMORY_FILE_SIZE = 512 * 1024;
const MAX_MEMORY_APPEND_SIZE = 16 * 1024;
const MEMORY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function collectMemoryFiles(baseDir: string, out: string[], maxDepth: number, depth = 0): void {
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
        if (entry.name === 'CLAUDE.md' || MEMORY_EXTENSIONS.has(path.extname(entry.name))) {
          out.push(fullPath);
        }
      }
    }
  } catch { /* skip */ }
}

function toRelativePath(filePath: string): string {
  if (filePath === WORKSPACE_GLOBAL || filePath.startsWith(WORKSPACE_GLOBAL + path.sep)) {
    return `[global] ${path.relative(WORKSPACE_GLOBAL, filePath)}`;
  }
  if (filePath === WORKSPACE_MEMORY || filePath.startsWith(WORKSPACE_MEMORY + path.sep)) {
    return `[memory] ${path.relative(WORKSPACE_MEMORY, filePath)}`;
  }
  return path.relative(WORKSPACE_GROUP, filePath);
}

function parseMemoryFileReference(fileRef: string): { pathRef: string; lineFromRef?: number } {
  const trimmed = fileRef.trim();
  const m = trimmed.match(/^(.*?):(\d+)$/);
  if (!m) return { pathRef: trimmed };
  const lineFromRef = Number(m[2]);
  if (!Number.isInteger(lineFromRef) || lineFromRef <= 0) return { pathRef: trimmed };
  return { pathRef: m[1].trim(), lineFromRef };
}

// ─── Tool schema helpers ────────────────────────────────────
type JsonSchema = Record<string, unknown>;
type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;
interface ToolDef { name: string; description: string; inputSchema: JsonSchema; handler: ToolHandler; }

const sString = (desc: string): JsonSchema => ({ type: 'string', description: desc });
const sNumber = (desc: string): JsonSchema => ({ type: 'number', description: desc });
const sEnum = (values: string[], desc: string): JsonSchema => ({ type: 'string', enum: values, description: desc });
const sObj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: 'object',
  properties,
  required: required.length > 0 ? required : undefined,
});

// ─── Tool definitions ───────────────────────────────────────
const TOOLS: ToolDef[] = [
  {
    name: 'send_message',
    description: "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
    inputSchema: sObj({ text: sString('The message text to send') }, ['text']),
    handler: async (args) => {
      const text = String(args.text ?? '');
      if (!text) return { content: [{ type: 'text', text: 'Error: text is required' }], isError: true };
      writeIpcFile(MESSAGES_DIR, buildSendMessageData({ type: 'message', text }));
      return { content: [{ type: 'text', text: 'Message sent.' }] };
    },
  },
  {
    name: 'schedule_task',
    description: `Schedule a recurring or one-time task.

EXECUTION TYPE:
- "agent" (default): Task runs as a full Agent with access to all tools. Consumes API tokens.
- "script" (admin only): Task runs a shell command directly on the host. Zero API token cost.

EXECUTION MODE:
- "host": Direct on host machine. Admin only.
- "container": Runs in a Docker container (default for non-admin).

CONTEXT MODE (agent mode only):
- "group": Task runs in the group's conversation context, with access to chat history.
- "isolated": Task runs in a fresh session with no conversation history.

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
- cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
- interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
- once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
    inputSchema: sObj({
      prompt: sString('The action to perform on EACH run (agent mode), or task description (script mode).'),
      schedule_type: sEnum(['cron', 'interval', 'once'], 'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
      schedule_value: sString('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
      execution_type: sEnum(['agent', 'script'], 'agent=full Agent (default), script=shell command (admin only, zero token cost)'),
      script_command: sString('Shell command to execute (required for script mode). Runs in the group workspace directory.'),
      execution_mode: sEnum(['host', 'container'], 'host=direct on host (admin only), container=Docker (default for non-admin)'),
      context_mode: sEnum(['group', 'isolated'], 'group=runs with persistent workspace context, isolated=fresh session each time'),
      target_group_jid: sString('JID of the group to schedule the task for (admin only, defaults to current group)'),
    }, ['schedule_type', 'schedule_value']),
    handler: async (args) => {
      const requestId = newRequestId();
      try {
        const result = await pollIpcResult(TASKS_DIR, {
          type: 'schedule_task',
          chatJid: CHAT_JID,
          groupFolder: GROUP_FOLDER,
          prompt: args.prompt ?? '',
          schedule_type: args.schedule_type,
          schedule_value: args.schedule_value,
          execution_type: args.execution_type ?? 'agent',
          script_command: args.script_command,
          execution_mode: args.execution_mode,
          context_mode: args.context_mode,
          target_group_jid: args.target_group_jid,
          isHome: IS_HOME,
          isAdminHome: IS_ADMIN_HOME,
          requestId,
          timestamp: new Date().toISOString(),
        }, 'schedule_task_result');
        if (result.success) {
          return { content: [{ type: 'text', text: `Task scheduled. Task ID: ${result.task_id}` }] };
        }
        return { content: [{ type: 'text', text: `Failed: ${result.error ?? 'Unknown error'}` }], isError: true };
      } catch {
        return { content: [{ type: 'text', text: 'Timeout waiting for schedule_task confirmation. 任务可能已创建也可能未创建——请先用 list_tasks 核实，不要直接重试以免重复创建。' }], isError: true };
      }
    },
  },
  {
    name: 'list_tasks',
    description: 'List all scheduled tasks. From admin home: shows all tasks. From other groups: shows only that group\'s tasks.',
    inputSchema: sObj({}),
    handler: async () => {
      const requestId = newRequestId();
      try {
        const result = await pollIpcResult(TASKS_DIR, {
          type: 'list_tasks',
          chatJid: CHAT_JID,
          groupFolder: GROUP_FOLDER,
          requestId,
          timestamp: new Date().toISOString(),
        }, 'list_tasks_result');
        const tasks = (result.tasks || []) as Array<Record<string, unknown>>;
        if (tasks.length === 0) return { content: [{ type: 'text', text: 'No scheduled tasks.' }] };
        const lines = tasks.map((t) => `- [${t.id}] ${t.schedule_type}=${t.schedule_value} | ${String(t.prompt ?? '').slice(0, 60)} | ${t.enabled ? 'enabled' : 'paused'}`);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch {
        return { content: [{ type: 'text', text: 'Timeout waiting for list_tasks.' }], isError: true };
      }
    },
  },
  {
    name: 'pause_task',
    description: 'Pause a scheduled task. It will not run until resumed.',
    inputSchema: sObj({ task_id: sString('The task ID to pause') }, ['task_id']),
    handler: async (args) => {
      const requestId = newRequestId();
      try {
        const result = await pollIpcResult(TASKS_DIR, {
          type: 'pause_task', task_id: args.task_id, requestId, timestamp: new Date().toISOString(),
        }, 'pause_task_result');
        if (result.success) return { content: [{ type: 'text', text: `Task ${args.task_id} paused.` }] };
        return { content: [{ type: 'text', text: `Failed: ${result.error ?? 'Unknown'}` }], isError: true };
      } catch {
        return { content: [{ type: 'text', text: 'Timeout.' }], isError: true };
      }
    },
  },
  {
    name: 'resume_task',
    description: 'Resume a paused task.',
    inputSchema: sObj({ task_id: sString('The task ID to resume') }, ['task_id']),
    handler: async (args) => {
      const requestId = newRequestId();
      try {
        const result = await pollIpcResult(TASKS_DIR, {
          type: 'resume_task', task_id: args.task_id, requestId, timestamp: new Date().toISOString(),
        }, 'resume_task_result');
        if (result.success) return { content: [{ type: 'text', text: `Task ${args.task_id} resumed.` }] };
        return { content: [{ type: 'text', text: `Failed: ${result.error ?? 'Unknown'}` }], isError: true };
      } catch {
        return { content: [{ type: 'text', text: 'Timeout.' }], isError: true };
      }
    },
  },
  {
    name: 'cancel_task',
    description: 'Cancel and delete a scheduled task.',
    inputSchema: sObj({ task_id: sString('The task ID to cancel') }, ['task_id']),
    handler: async (args) => {
      const requestId = newRequestId();
      try {
        const result = await pollIpcResult(TASKS_DIR, {
          type: 'cancel_task', task_id: args.task_id, requestId, timestamp: new Date().toISOString(),
        }, 'cancel_task_result');
        if (result.success) return { content: [{ type: 'text', text: `Task ${args.task_id} cancelled.` }] };
        return { content: [{ type: 'text', text: `Failed: ${result.error ?? 'Unknown'}` }], isError: true };
      } catch {
        return { content: [{ type: 'text', text: 'Timeout.' }], isError: true };
      }
    },
  },
  {
    name: 'register_group',
    description: 'Register a new group so the agent can respond to messages there. Admin only.',
    inputSchema: sObj({
      jid: sString('The chat JID (e.g., "feishu:oc_xxxx")'),
      name: sString('Display name for the group'),
      folder: sString('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
      execution_mode: sEnum(['container', 'host'], 'Execution mode: "container" (default, isolated Docker) or "host" (direct host access, admin only)'),
    }, ['jid', 'name', 'folder']),
    handler: async (args) => {
      if (!IS_ADMIN_HOME) {
        return { content: [{ type: 'text', text: 'Error: register_group is admin-only.' }], isError: true };
      }
      const requestId = newRequestId();
      try {
        const result = await pollIpcResult(TASKS_DIR, {
          type: 'register_group',
          jid: args.jid,
          name: args.name,
          folder: args.folder,
          execution_mode: args.execution_mode,
          groupFolder: GROUP_FOLDER,
          requestId,
          timestamp: new Date().toISOString(),
        }, 'register_group_result', 60_000);
        if (result.success) return { content: [{ type: 'text', text: `Group registered: ${args.jid}` }] };
        return { content: [{ type: 'text', text: `Failed: ${result.error ?? 'Unknown'}` }], isError: true };
      } catch {
        return { content: [{ type: 'text', text: 'Timeout.' }], isError: true };
      }
    },
  },
  {
    name: 'install_skill',
    description: 'Install a skill from the skills registry (skills.sh). The skill will be available in future conversations. Example packages: "anthropic/memory", "anthropic/think", "owner/repo", "owner/repo@skill-name".',
    inputSchema: sObj({ package: sString('The skill package to install, format: owner/repo or owner/repo@skill') }, ['package']),
    handler: async (args) => {
      const pkg = String(args.package ?? '').trim();
      if (!/^[\w\-]+\/[\w\-.]+(?:[@#][\w\-.\/]+)?$/.test(pkg) && !/^https?:\/\//.test(pkg)) {
        return { content: [{ type: 'text', text: `Invalid package format: "${pkg}". Expected format: owner/repo or owner/repo@skill` }], isError: true };
      }
      const requestId = newRequestId();
      try {
        const result = await pollIpcResult(TASKS_DIR, {
          type: 'install_skill',
          package: pkg,
          requestId,
          groupFolder: GROUP_FOLDER,
          timestamp: new Date().toISOString(),
        }, 'install_skill_result', 120_000);
        if (result.success) {
          const installed = ((result.installed as string[]) || []).join(', ') || pkg;
          return { content: [{ type: 'text', text: `Skill installed successfully: ${installed}\n\nNote: The skill will be available in the next conversation (new container/process).` }] };
        }
        return { content: [{ type: 'text', text: `Failed to install skill "${pkg}": ${result.error ?? 'Unknown error'}` }], isError: true };
      } catch {
        return { content: [{ type: 'text', text: `Timeout waiting for skill installation result (120s). The installation may still be in progress.` }], isError: true };
      }
    },
  },
  {
    name: 'uninstall_skill',
    description: 'Uninstall a user-level skill by its ID. Project-level skills cannot be uninstalled. Use the skills panel in the UI to find the skill ID (directory name, e.g. "memory", "think").',
    inputSchema: sObj({ skill_id: sString('The skill ID to uninstall (the directory name, e.g. "memory", "think")') }, ['skill_id']),
    handler: async (args) => {
      const skillId = String(args.skill_id ?? '').trim();
      if (!skillId || !/^[\w\-]+$/.test(skillId)) {
        return { content: [{ type: 'text', text: `Invalid skill ID: "${skillId}". Must be alphanumeric with hyphens/underscores.` }], isError: true };
      }
      const requestId = newRequestId();
      try {
        const result = await pollIpcResult(TASKS_DIR, {
          type: 'uninstall_skill',
          skillId,
          requestId,
          groupFolder: GROUP_FOLDER,
          timestamp: new Date().toISOString(),
        }, 'uninstall_skill_result');
        if (result.success) return { content: [{ type: 'text', text: `Skill "${skillId}" uninstalled successfully.` }] };
        return { content: [{ type: 'text', text: `Failed to uninstall skill "${skillId}": ${result.error ?? 'Unknown error'}` }], isError: true };
      } catch {
        return { content: [{ type: 'text', text: 'Timeout waiting for skill uninstall result.' }], isError: true };
      }
    },
  },
];

// ─── memory_* tools (conditional on IS_HOME / !DISABLE_MEMORY_LAYER) ──
if (IS_HOME && !DISABLE_MEMORY_LAYER) {
  TOOLS.push({
    name: 'memory_append',
    description: `将**时效性记忆**追加到 memory/YYYY-MM-DD.md（独立记忆目录，不在工作区内）。仅追加写入，不会覆盖已有内容。

仅用于明确只跟当天/短期有关的信息：今日项目进展、临时技术决策、待办事项、会议要点等。

**重要**：下次对话仍可能用到的信息（用户身份、偏好、常用项目、用户说"记住"的内容）应直接用 Edit 工具编辑 /workspace/global/CLAUDE.md，不要用此工具。`,
    inputSchema: sObj({
      content: sString('要追加的记忆内容'),
      date: sString('目标日期，格式 YYYY-MM-DD（默认：今天）'),
    }, ['content']),
    handler: async (args) => {
      const normalizedContent = String(args.content ?? '').replace(/\r\n?/g, '\n').trim();
      if (!normalizedContent) return { content: [{ type: 'text', text: '内容不能为空。' }], isError: true };
      const appendBytes = Buffer.byteLength(normalizedContent, 'utf-8');
      if (appendBytes > MAX_MEMORY_APPEND_SIZE) {
        return { content: [{ type: 'text', text: `内容过大：${appendBytes} 字节（上限 ${MAX_MEMORY_APPEND_SIZE}）。` }], isError: true };
      }
      const date = (args.date ? String(args.date) : new Date().toISOString().split('T')[0]).trim();
      if (!MEMORY_DATE_PATTERN.test(date)) {
        return { content: [{ type: 'text', text: `日期格式无效："${date}"，请使用 YYYY-MM-DD。` }], isError: true };
      }
      const resolvedPath = path.normalize(path.join(WORKSPACE_MEMORY, `${date}.md`));
      const inMemory = resolvedPath === WORKSPACE_MEMORY || resolvedPath.startsWith(WORKSPACE_MEMORY + path.sep);
      if (!inMemory) {
        return { content: [{ type: 'text', text: '访问被拒绝：路径超出工作区范围。' }], isError: true };
      }
      try {
        fs.mkdirSync(WORKSPACE_MEMORY, { recursive: true });
        const fileExists = fs.existsSync(resolvedPath);
        const currentSize = fileExists ? fs.statSync(resolvedPath).size : 0;
        const separator = currentSize > 0 ? '\n---\n\n' : '';
        const entry = `${separator}### ${new Date().toISOString()}\n${normalizedContent}\n`;
        const nextSize = currentSize + Buffer.byteLength(entry, 'utf-8');
        if (nextSize > MAX_MEMORY_FILE_SIZE) {
          return { content: [{ type: 'text', text: `记忆文件将超过 ${MAX_MEMORY_FILE_SIZE} 字节上限，请缩短内容。` }], isError: true };
        }
        fs.appendFileSync(resolvedPath, entry, 'utf-8');
        return { content: [{ type: 'text', text: `已追加到 memory/${date}.md（${appendBytes} 字节）。` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `追加记忆时出错：${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  });
}

if (!DISABLE_MEMORY_LAYER) {
  TOOLS.push({
    name: 'memory_search',
    description: `在工作区的记忆文件中搜索（CLAUDE.md、memory/、conversations/ 及其他 .md/.txt 文件）。返回文件路径、行号和上下文片段。超过 512KB 的文件会被跳过。用于回忆过去的决策、偏好、项目上下文或对话历史。`,
    inputSchema: sObj({
      query: sString('搜索关键词或短语（不区分大小写）'),
      max_results: sNumber('最大结果数（默认 20，上限 50）'),
    }, ['query']),
    handler: async (args) => {
      const query = String(args.query ?? '').toLowerCase().trim();
      if (!query) return { content: [{ type: 'text', text: 'Query cannot be empty.' }], isError: true };
      const maxResults = Math.min(Math.max(Number(args.max_results ?? 20), 1), 50);
      const files: string[] = [];
      collectMemoryFiles(WORKSPACE_MEMORY, files, 4);
      collectMemoryFiles(WORKSPACE_GLOBAL, files, 4);
      collectMemoryFiles(WORKSPACE_GROUP, files, 4);
      const results: Array<{ file: string; line: number; context: string }> = [];
      for (const file of files) {
        if (results.length >= maxResults) break;
        try {
          const stat = fs.statSync(file);
          if (stat.size > MAX_MEMORY_FILE_SIZE) continue;
          const content = fs.readFileSync(file, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(query)) {
              const start = Math.max(0, i - 1);
              const end = Math.min(lines.length, i + 2);
              const context = lines.slice(start, end).join('\n');
              results.push({ file: toRelativePath(file), line: i + 1, context });
              if (results.length >= maxResults) break;
            }
          }
        } catch { /* skip */ }
      }
      if (results.length === 0) {
        return { content: [{ type: 'text', text: `No matches found for: ${args.query}` }] };
      }
      const formatted = results.map((r) => `- ${r.file}:${r.line}\n  ${r.context}`).join('\n\n');
      return { content: [{ type: 'text', text: `${results.length} matches:\n\n${formatted}` }] };
    },
  });

  TOOLS.push({
    name: 'memory_get',
    description: `读取记忆文件或指定行范围。在 memory_search 之后使用以获取完整上下文。`,
    inputSchema: sObj({
      file: sString('相对路径，可带 :行号（如 "CLAUDE.md:12"、"[global] CLAUDE.md:8" 或 "[memory] 2026-01-15.md")'),
      from_line: sNumber('起始行号（从 1 开始，默认：1）'),
      lines: sNumber('读取行数（默认：全部，上限：200）'),
    }, ['file']),
    handler: async (args) => {
      const fileRef = String(args.file ?? '');
      const { pathRef, lineFromRef } = parseMemoryFileReference(fileRef);
      let resolvedPath: string;
      if (pathRef.startsWith('[global] ')) {
        resolvedPath = path.normalize(path.join(WORKSPACE_GLOBAL, pathRef.slice(9)));
      } else if (pathRef.startsWith('[memory] ')) {
        resolvedPath = path.normalize(path.join(WORKSPACE_MEMORY, pathRef.slice(9)));
      } else {
        resolvedPath = path.normalize(path.join(WORKSPACE_GROUP, pathRef));
      }
      const inGroup = resolvedPath === WORKSPACE_GROUP || resolvedPath.startsWith(WORKSPACE_GROUP + path.sep);
      const inGlobal = resolvedPath === WORKSPACE_GLOBAL || resolvedPath.startsWith(WORKSPACE_GLOBAL + path.sep);
      const inMemory = resolvedPath === WORKSPACE_MEMORY || resolvedPath.startsWith(WORKSPACE_MEMORY + path.sep);
      if (!inGroup && !inGlobal && !inMemory) {
        return { content: [{ type: 'text', text: '访问被拒绝：路径超出工作区范围。' }], isError: true };
      }
      if (!fs.existsSync(resolvedPath)) {
        return { content: [{ type: 'text', text: `文件未找到：${fileRef}` }], isError: true };
      }
      try {
        const content = fs.readFileSync(resolvedPath, 'utf-8');
        const allLines = content.split('\n');
        const fromLine = Math.max((Number(args.from_line ?? lineFromRef ?? 1)) - 1, 0);
        const maxLines = Math.min(Number(args.lines ?? allLines.length), 200);
        const slice = allLines.slice(fromLine, fromLine + maxLines);
        const header = `${fileRef}（第 ${fromLine + 1}-${fromLine + slice.length} 行，共 ${allLines.length} 行）`;
        return { content: [{ type: 'text', text: `${header}\n\n${slice.join('\n')}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `读取文件时出错：${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  });
}

// ─── MCP Server bootstrap ──────────────────────────────────
const server = new Server(
  { name: 'deepthink-mcp-bridge', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return {
      content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }
  try {
    return await tool.handler(args);
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();

// Initialize Redis bridge before connecting (distributed mode only).
// This must happen before the server starts handling tool calls.
initRedisBridge().finally(() => {
  server.connect(transport).catch((err) => {
    console.error('[mcp-bridge] Failed to start server:', err);
    process.exit(1);
  });
});

// Graceful cleanup on exit
process.on('SIGTERM', async () => {
  try {
    if (_redisPub) await _redisPub.quit().catch(() => {});
    if (_redisSub) await _redisSub.quit().catch(() => {});
  } catch { /* ignore */ }
  process.exit(0);
});

process.on('SIGINT', async () => {
  try {
    if (_redisPub) await _redisPub.quit().catch(() => {});
    if (_redisSub) await _redisSub.quit().catch(() => {});
  } catch { /* ignore */ }
  process.exit(0);
});
