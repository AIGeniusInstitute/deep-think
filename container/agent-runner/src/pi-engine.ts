/**
 * pi Engine Adapter
 *
 * Drives the pi coding agent (`pi --mode rpc`) as an alternative to the
 * Claude Agent SDK query() path. Invoked by index.ts main() when
 * ContainerInput.engine === 'pi'.
 *
 * pi is a TypeScript monorepo (~/pi, v0.82.0) with four run modes. This
 * adapter uses **RPC mode** — a long-running stdio JSONL protocol designed
 * for process integration (pi README / rpc-types.ts):
 *   - stdin:  one JSONL `RpcCommand` per line (we send `prompt`, `get_state`,
 *             `extension_ui_response`)
 *   - stdout: one JSONL per line, either an `RpcResponse`, an
 *             `AgentSessionEvent`, or an `extension_ui_request`
 *
 * Lifecycle:
 *   1. spawn `binaryPath [cliScriptPath] --mode rpc [--provider P] [--model M]
 *      [--thinking T] [--session <id>]`, cwd=workingDir, inject
 *      `<PROVIDER>_API_KEY` env + per-group `PI_CODING_AGENT_DIR`.
 *   2. Ready detection: send `get_state`, await matching `response success`
 *      (30s). Capture `sessionId` for persistence.
 *   3. Send first `prompt` command (drain IPC + scheduled-task prefix into
 *      the message). Translate subsequent `AgentSessionEvent`s to DeepThink
 *      StreamEvents via writeOutput({ status:'stream', streamEvent }).
 *   4. On `agent_settled`: emit writeOutput({ status:'success', result,
 *      newSessionId }) — `agent_settled` is the authoritative idle signal
 *      (agent_end may be followed by retry/compaction).
 *   5. IPC polling loop — on new message: send another `prompt` command.
 *   6. `extension_ui_request`: reply `{ cancelled: true }` (no TUI in
 *      external-driver mode).
 *   7. On `_close` sentinel / SIGTERM: SIGTERM pi child → exit.
 *
 * Known limitations (documented in PRD §3.1):
 *   - No DeepThink MCP tool bridge (send_message/schedule_task/memory_*).
 *     pi core has no MCP client/server; first version does not bridge.
 *   - No image input (first version is text-only).
 *   - No sub-agents / skills / plugins / extensions bridging.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';

import type { ContainerInput, ContainerOutput, StreamEvent } from './types.js';

const OUTPUT_START_MARKER = '---DEEPTHINK_OUTPUT_START---';
const OUTPUT_END_MARKER = '---DEEPTHINK_OUTPUT_END---';

const IPC_INPUT_DIR = process.env.DEEPTHINK_WORKSPACE_IPC
  ? path.join(process.env.DEEPTHINK_WORKSPACE_IPC, 'input')
  : '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_FALLBACK_POLL_MS = 5000;

const WORKSPACE_GROUP = process.env.DEEPTHINK_WORKSPACE_GROUP || '/workspace/group';

interface IpcDrainMessage {
  text: string;
  images?: Array<{ data: string; mimeType?: string }>;
  taskId?: string;
  sourceJid?: string;
}

interface IpcDrainResult {
  messages: IpcDrainMessage[];
}

/**
 * provider name → env var that pi-ai reads for the API key
 * (packages/ai/src/env-api-keys.ts). Providers not in this map fall back to
 * the `--api-key` CLI flag on spawn (only the first unmapped provider).
 */
const PROVIDER_ENV_KEY: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  gemini: 'GEMINI_API_KEY',
  google: 'GEMINI_API_KEY',
  qwen: 'DASHSCOPE_API_KEY',
  dashscope: 'DASHSCOPE_API_KEY',
  zai: 'ZAI_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  kimi: 'KIMI_API_KEY',
  xai: 'XAI_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  together: 'TOGETHER_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  cloudflare: 'CLOUDFLARE_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  ai_gateway: 'AI_GATEWAY_API_KEY',
  radius: 'RADIUS_API_KEY',
};

interface PiProviderInput {
  provider: string;
  apiKey: string;
  baseURL: string;
  model: string;
}

/** pi RPC stdout messages (discriminated union, see pi rpc-types.ts). */
type PiRpcMessage =
  | { id?: string; type: 'response'; command: string; success: boolean; data?: unknown; error?: { message?: string } | string }
  | { type: 'extension_ui_request'; id: string; method: string }
  | { type: string; [key: string]: unknown };

interface RunOpts {
  containerInput: ContainerInput;
  writeOutput: (out: ContainerOutput) => void;
  log: (message: string) => void;
}

interface RunOneTurnResult {
  fullText: string;
  toolCalls: number;
  sessionId?: string;
  error?: string;
  interrupted?: boolean;
}

function emitStream(
  writeOutput: (out: ContainerOutput) => void,
  streamEvent: StreamEvent,
  sessionId: string | undefined,
  turnId: string | undefined,
): void {
  writeOutput({
    status: 'stream',
    result: null,
    streamEvent,
    sessionId,
    turnId,
  });
}

/**
 * Drain pending IPC input files. Mirrors the logic in index.ts / codex-engine
 * so the pi engine sees the same follow-up messages that the Claude path
 * would have absorbed into its initial prompt.
 */
function drainIpcInput(): IpcDrainResult {
  const result: IpcDrainResult = { messages: [] };
  try {
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          result.messages.push({
            text: data.text,
            images: data.images,
            taskId: typeof data.taskId === 'string' ? data.taskId : undefined,
            sourceJid: typeof data.sourceJid === 'string' ? data.sourceJid : undefined,
          });
        }
      } catch {
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
  } catch {
    // IPC dir may not exist yet
  }
  return result;
}

/** Write a JSONL command to the pi child's stdin. */
function sendCommand(proc: ChildProcess, cmd: Record<string, unknown>): boolean {
  if (!proc.stdin || proc.stdin.destroyed) return false;
  try {
    proc.stdin.write(JSON.stringify(cmd) + '\n');
    return true;
  } catch {
    return false;
  }
}

/** Resolve a per-group PI_CODING_AGENT_DIR so multiple pi instances don't
 *  collide on ~/.pi/agent sessions. */
function resolvePiAgentDir(groupFolder: string, log: (m: string) => void): string {
  const base = process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, 'pi-homes')
    : path.join(os.homedir() || '/tmp', '.deepthink', 'pi-homes');
  const dir = path.join(base, groupFolder || 'default');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o700);
  } catch (err) {
    log(`Failed to mkdir PI_CODING_AGENT_DIR ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return dir;
}

/**
 * Run one prompt turn against the long-lived pi RPC process:
 * send `prompt`, consume events until `agent_settled` (or error/abort).
 */
async function runOneTurn(
  opts: {
    proc: ChildProcess;
    message: string;
    writeOutput: (out: ContainerOutput) => void;
    currentSessionId: string | undefined;
    turnId: string | undefined;
    log: (m: string) => void;
    signal?: AbortSignal;
    onSessionId?: (id: string) => void;
    onUiRequest?: (req: { id: string; method: string }) => void;
  },
): Promise<RunOneTurnResult> {
  const { proc, message, writeOutput, currentSessionId, turnId, log, signal, onSessionId, onUiRequest } = opts;

  const promptId = `turn-${turnId ?? 'x'}`;
  const result: RunOneTurnResult = { fullText: '', toolCalls: 0 };

  let settled = false;
  let turnEnded = false;

  // Resolve when agent_settled arrives (or error/abort).
  const settledPromise = new Promise<void>((resolve) => {
    const stdout = proc.stdout;
    if (!stdout) { resolve(); return; }
    const rl = readline.createInterface({ input: stdout, crlfDelay: Infinity });

    const onLine = (line: string): void => {
      if (!line.trim()) return;
      let msg: PiRpcMessage;
      try {
        msg = JSON.parse(line) as PiRpcMessage;
      } catch {
        // Non-JSONL (logs) — ignore.
        return;
      }
      // Route by message kind.
      if (msg.type === 'response') {
        // Could be the prompt ack or a stray get_state response. The prompt
        // ack only signals preflight passed; real results come via events.
        if (msg.command === 'prompt' && !msg.success) {
          const errMsg = typeof msg.error === 'string' ? msg.error : (msg.error as { message?: string })?.message ?? 'prompt rejected';
          result.error = errMsg;
          resolve();
          return;
        }
        return;
      }
      if (msg.type === 'extension_ui_request') {
        const req = msg as { id: string; method: string };
        onUiRequest?.(req);
        return;
      }
      // AgentSessionEvent routing.
      switch (msg.type) {
        case 'agent_start':
          emitStream(writeOutput, {
            eventType: 'init',
            agentScope: 'main',
            statusText: 'pi 引擎已启动',
          }, currentSessionId, turnId);
          break;
        case 'message_update': {
          const ame = msg.assistantMessageEvent as
            | { type?: string; delta?: string; content?: string; toolCall?: { name?: string; arguments?: unknown } }
            | undefined;
          if (!ame) break;
          if (ame.type === 'text_delta' && ame.delta) {
            result.fullText += ame.delta;
            emitStream(writeOutput, {
              eventType: 'text_delta',
              agentScope: 'main',
              text: ame.delta,
            }, currentSessionId, turnId);
          } else if (ame.type === 'thinking_delta' && ame.delta) {
            emitStream(writeOutput, {
              eventType: 'thinking_delta',
              agentScope: 'main',
              text: ame.delta,
            }, currentSessionId, turnId);
          } else if (ame.type === 'toolcall_end' && ame.toolCall) {
            // Fallback tool-start if tool_execution_* not emitted.
            result.toolCalls += 1;
            emitStream(writeOutput, {
              eventType: 'tool_use_start',
              agentScope: 'main',
              toolName: ame.toolCall.name ?? 'tool',
              toolInputSummary: JSON.stringify(ame.toolCall.arguments ?? {}).slice(0, 200),
            }, currentSessionId, turnId);
          }
          break;
        }
        case 'tool_execution_start': {
          result.toolCalls += 1;
          const t = msg as { toolName?: string; args?: unknown };
          emitStream(writeOutput, {
            eventType: 'tool_use_start',
            agentScope: 'main',
            toolName: t.toolName ?? 'tool',
            toolInputSummary: JSON.stringify(t.args ?? {}).slice(0, 200),
          }, currentSessionId, turnId);
          break;
        }
        case 'tool_execution_update': {
          const t = msg as { toolName?: string; partialResult?: unknown };
          emitStream(writeOutput, {
            eventType: 'tool_progress',
            agentScope: 'main',
            toolName: t.toolName ?? 'tool',
            detail: (typeof t.partialResult === 'string' ? t.partialResult : JSON.stringify(t.partialResult ?? '')).slice(-1000),
          }, currentSessionId, turnId);
          break;
        }
        case 'tool_execution_end': {
          const t = msg as { toolName?: string; result?: unknown; isError?: boolean };
          emitStream(writeOutput, {
            eventType: 'tool_use_end',
            agentScope: 'main',
            toolName: t.toolName ?? 'tool',
            toolResult: (typeof t.result === 'string' ? t.result : JSON.stringify(t.result ?? '')).slice(-1000),
          }, currentSessionId, turnId);
          break;
        }
        case 'bash_execution_update': {
          const t = msg as { delta?: string };
          if (t.delta) {
            emitStream(writeOutput, {
              eventType: 'tool_progress',
              agentScope: 'main',
              toolName: 'bash',
              detail: t.delta.slice(-1000),
            }, currentSessionId, turnId);
          }
          break;
        }
        case 'turn_end':
          turnEnded = true;
          break;
        case 'session_info_changed':
          // No sessionId here; captured from get_state response instead.
          break;
        case 'agent_end':
          // Not authoritative — may retry/compact. Wait for agent_settled.
          break;
        case 'agent_settled':
          settled = true;
          resolve();
          break;
        default:
          // Unknown event — ignore (protocol-robust, don't crash).
          break;
      }
    };
    rl.on('line', onLine);

    // If aborted externally, resolve.
    signal?.addEventListener('abort', () => {
      if (!settled) {
        result.interrupted = true;
        resolve();
      }
    });
  });

  // Send the prompt command.
  if (!sendCommand(proc, { id: promptId, type: 'prompt', message })) {
    return { fullText: result.fullText, toolCalls: result.toolCalls, error: 'pi stdin unavailable' };
  }

  await settledPromise;
  void turnEnded;

  if (result.error) return result;
  if (result.interrupted) return result;
  return result;
}

export async function runPiEngine(opts: RunOpts): Promise<void> {
  const { containerInput, writeOutput, log } = opts;
  const turnId = containerInput.turnId;

  // ── 1. Read engine env vars (injected by container-runner) ──
  const binaryPath = process.env.PI_BINARY_PATH?.trim() ?? '';
  const cliScriptPath = process.env.PI_CLI_SCRIPT_PATH?.trim() ?? '';
  const workingDir = process.env.PI_WORKING_DIR?.trim() || WORKSPACE_GROUP;
  const defaultProvider = process.env.PI_DEFAULT_PROVIDER?.trim() || 'anthropic';
  const defaultModel = process.env.PI_DEFAULT_MODEL?.trim() || 'claude-sonnet-4-6';
  const thinkingLevel = process.env.PI_THINKING_LEVEL?.trim() || 'off';
  const providersJson = process.env.PI_PROVIDERS_JSON?.trim() ?? '';

  if (!binaryPath) {
    writeOutput({
      status: 'error',
      result: null,
      error: 'PI_BINARY_PATH 未注入。请在 设置 → pi 引擎 中配置启动命令，并确保群组 engine=pi。',
      turnId,
    });
    return;
  }
  if (cliScriptPath && !fs.existsSync(cliScriptPath)) {
    writeOutput({
      status: 'error',
      result: null,
      error: `pi CLI 脚本不存在：${cliScriptPath}`,
      turnId,
    });
    return;
  }

  // ── 1b. Parse providers, inject API key env (provider→envvar map) ──
  let providers: PiProviderInput[] = [];
  if (providersJson) {
    try {
      const parsed = JSON.parse(providersJson);
      if (Array.isArray(parsed)) {
        providers = parsed.filter(
          (p): p is PiProviderInput =>
            !!p && typeof p === 'object' &&
            typeof p.provider === 'string' && typeof p.apiKey === 'string' &&
            typeof p.model === 'string',
        );
      }
    } catch (err) {
      log(`Failed to parse PI_PROVIDERS_JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Inject <PROVIDER>_API_KEY env for each mapped provider; collect unmapped.
  const unmapped: PiProviderInput[] = [];
  for (const p of providers) {
    const envKey = PROVIDER_ENV_KEY[p.provider.toLowerCase()];
    if (envKey) {
      process.env[envKey] = p.apiKey;
    } else {
      unmapped.push(p);
    }
  }

  // ── 1c. Per-group PI_CODING_AGENT_DIR (session isolation) ──
  const groupFolder = process.env.DT_GROUP_FOLDER || containerInput.groupFolder || 'default';
  const piAgentDir = resolvePiAgentDir(groupFolder, log);
  process.env.PI_CODING_AGENT_DIR = piAgentDir;

  // Override DT_CHAT_JID with the actual chatJid from containerInput.
  if (containerInput.chatJid) {
    process.env.DT_CHAT_JID = containerInput.chatJid;
  }

  // ── 2. Build spawn args ──
  const args: string[] = [];
  if (cliScriptPath) args.push(cliScriptPath);
  args.push('--mode', 'rpc');
  args.push('--provider', defaultProvider);
  args.push('--model', defaultModel);
  args.push('--thinking', thinkingLevel);
  // Resume persisted session if any.
  if (containerInput.sessionId) {
    args.push('--session', containerInput.sessionId);
  }
  // Unmapped provider fallback: pass first via --api-key (pi CLI runtime injection).
  if (unmapped.length > 0) {
    args.push('--api-key', unmapped[0].apiKey);
  }

  log(`Spawning pi: ${binaryPath} ${args.map((a) => a.includes(' ') ? `"${a}"` : a).join(' ')} (cwd=${workingDir}, PI_CODING_AGENT_DIR=${piAgentDir})`);

  // ── 3. Spawn pi --mode rpc ──
  let proc: ChildProcess;
  try {
    proc = spawn(binaryPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: workingDir,
      env: process.env,
    });
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `pi 引擎启动失败：${err instanceof Error ? err.message : String(err)}`,
      turnId,
    });
    return;
  }

  // stderr → log file + log()
  const logDir = process.env.DEEPTHINK_WORKSPACE_GROUP
    ? path.join(process.env.DEEPTHINK_WORKSPACE_GROUP, 'logs')
    : path.join(piAgentDir, 'logs');
  try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }
  const logFile = path.join(logDir, 'pi-engine.log');
  let logStream: fs.WriteStream | null = null;
  try {
    logStream = fs.createWriteStream(logFile, { flags: 'a' });
  } catch { /* ignore */ }
  proc.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trimEnd();
    if (!line) return;
    log(`[pi stderr] ${line}`);
    try { logStream?.write(line + '\n'); } catch { /* ignore */ }
  });

  let piSessionId: string | undefined = containerInput.sessionId;
  let ready = false;

  // Helper to handle extension_ui_request globally.
  const handleUiRequest = (req: { id: string; method: string }): void => {
    // Notify/setStatus/setWidget/setTitle/set_editor_text are fire-and-forget;
    // select/confirm/input/editor block until response — reply cancelled.
    sendCommand(proc, { type: 'extension_ui_response', id: req.id, cancelled: true });
  };

  // ── 4. Ready detection: send get_state, await response (30s) ──
  const readyPromise = new Promise<boolean>((resolve) => {
    const stdout = proc.stdout;
    if (!stdout) { resolve(false); return; }
    const rl = readline.createInterface({ input: stdout, crlfDelay: Infinity });
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; resolve(false); }
    }, 30_000);
    const onLine = (line: string): void => {
      if (resolved) return;
      if (!line.trim()) return;
      let msg: PiRpcMessage;
      try { msg = JSON.parse(line) as PiRpcMessage; } catch { return; }
      if (msg.type === 'extension_ui_request') {
        handleUiRequest(msg as { id: string; method: string });
        return;
      }
      if (msg.type === 'response' && msg.command === 'get_state' && msg.success) {
        const data = msg.data as { sessionId?: string; sessionFile?: string } | undefined;
        if (data?.sessionId) {
          piSessionId = data.sessionId;
        }
        resolved = true;
        clearTimeout(timer);
        rl.removeListener('line', onLine);
        resolve(true);
      }
    };
    rl.on('line', onLine);
    proc.on('close', () => {
      if (!resolved) { resolved = true; clearTimeout(timer); resolve(false); }
    });
    // Send get_state
    if (!sendCommand(proc, { id: 'init', type: 'get_state' })) {
      resolved = true; clearTimeout(timer); resolve(false);
    }
  });

  ready = await readyPromise;
  if (!ready) {
    writeOutput({
      status: 'error',
      result: null,
      error: 'pi 引擎就绪检测失败（30s 内未收到 get_state 响应）。请检查 binaryPath / cliScriptPath 配置与 pi stderr 日志。',
      turnId,
    });
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    try { logStream?.end(); } catch { /* ignore */ }
    return;
  }
  log(`pi ready, sessionId=${piSessionId ?? '(none)'}`);

  // ── 5. Prepare initial prompt (drain IPC, scheduled task prefix) ──
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt =
      '[定时任务 - 以下内容由系统自动发送。]\n\n' +
      '本次运行的最终输出会作为结果保存到对话历史。' +
      '如需主动向用户/群组推送消息，请使用 send_message MCP 工具。\n\n' +
      prompt;
  }
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
  const pending = drainIpcInput();
  if (pending.messages.length > 0) {
    log(`Draining ${pending.messages.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.messages.map((m) => m.text).join('\n');
  }

  // ── 6. First turn ──
  let abortController: AbortController | null = null;

  const runOneTurnWrapper = async (message: string): Promise<void> => {
    abortController = new AbortController();
    const result = await runOneTurn({
      proc,
      message,
      writeOutput,
      currentSessionId: piSessionId,
      turnId,
      log,
      signal: abortController.signal,
      onSessionId: (id) => { piSessionId = id; },
      onUiRequest: handleUiRequest,
    });
    abortController = null;

    if (result.error) {
      writeOutput({
        status: 'error',
        result: result.fullText || null,
        error: `pi 错误：${result.error}`,
        newSessionId: piSessionId,
        sessionId: piSessionId,
        turnId,
      });
      return;
    }

    writeOutput({
      status: 'success',
      result: result.fullText || '(pi 返回空回复)',
      newSessionId: piSessionId,
      sessionId: piSessionId,
      turnId,
      finalizationReason: result.interrupted ? 'interrupted' : 'completed',
    });
  };

  await runOneTurnWrapper(prompt);

  // ── 7. IPC polling loop — handle follow-up messages ──
  let closed = false;
  let watcher: fs.FSWatcher | null = null;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;

  const checkForNewMessages = async (): Promise<void> => {
    if (closed) return;
    try {
      if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
        log('IPC _close sentinel detected, shutting down');
        closed = true;
        cleanup();
        return;
      }
    } catch { /* ignore */ }

    const drain = drainIpcInput();
    if (drain.messages.length === 0) return;
    for (const msg of drain.messages) {
      if (closed) break;
      log(`IPC follow-up message: ${msg.text.slice(0, 80)}`);
      await runOneTurnWrapper(msg.text);
    }
  };

  const cleanup = async (): Promise<void> => {
    closed = true;
    if (watcher) {
      try { watcher.close(); } catch { /* ignore */ }
      watcher = null;
    }
    if (fallbackTimer) {
      clearInterval(fallbackTimer);
      fallbackTimer = null;
    }
    if (abortController) {
      try { abortController.abort(); } catch { /* ignore */ }
    }
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    try { logStream?.end(); } catch { /* ignore */ }
    writeOutput({ status: 'closed', result: null, turnId });
  };

  try { fs.mkdirSync(IPC_INPUT_DIR, { recursive: true }); } catch { /* ignore */ }
  try {
    watcher = fs.watch(IPC_INPUT_DIR, () => {
      void checkForNewMessages();
    });
    watcher.on('error', (err) => {
      log(`IPC watcher error: ${err.message}`);
    });
  } catch (err) {
    log(`Failed to create IPC watcher: ${err instanceof Error ? err.message : String(err)}`);
  }
  fallbackTimer = setInterval(() => {
    void checkForNewMessages();
  }, IPC_FALLBACK_POLL_MS);
  fallbackTimer.unref();

  // SIGINT/SIGTERM handler
  const sigHandler = async (sig: string): Promise<void> => {
    log(`Received ${sig}, stopping pi-engine`);
    await cleanup();
    process.exit(0);
  };
  process.on('SIGINT', () => void sigHandler('SIGINT'));
  process.on('SIGTERM', () => void sigHandler('SIGTERM'));

  // Export for index.ts protocol symmetry (unused but matches other engines).
  void OUTPUT_START_MARKER;
  void OUTPUT_END_MARKER;
}
