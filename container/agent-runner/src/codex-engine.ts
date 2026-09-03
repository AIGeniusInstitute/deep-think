/**
 * Codex Engine Adapter
 *
 * Drives OpenAI Codex CLI (`codex exec --json`) as an alternative to the
 * Claude Agent SDK query() path. Invoked by index.ts main() when
 * ContainerInput.engine === 'codex'.
 *
 * Lifecycle:
 *   1. spawn `codex exec --json --model M --cd DIR <prompt>` per turn
 *      (first turn) or `codex exec --json --model M --cd DIR resume
 *      <threadId> <prompt>` (follow-up turns).
 *   2. Parse JSONL stdout (one ThreadEvent per line), translate to
 *      DeepThink StreamEvents, emit via writeOutput({ status:'stream',
 *      streamEvent }).
 *   3. On `turn.completed`/`turn.failed`: emit final writeOutput({
 *      status:'success', result, newSessionId }).
 *   4. Enter IPC polling loop — on new message: spawn codex exec again
 *      with resume + threadId.
 *   5. On _close sentinel: exit process.
 *
 * Known limitations (documented in PRD §3.1):
 *   - No DeepThink MCP tool bridge (send_message/schedule_task/memory_*).
 *   - No image input (codex exec --json does support -i but first version
 *     is text-only).
 *   - No sub-agents / skills / plugins bridging.
 *   - Cold-start per turn (~2-3s spawn overhead).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';

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

/** Codex ThreadEvent — one per stdout line in `codex exec --json`. */
interface CodexThreadEvent {
  type: string;
  thread_id?: string;
  turn_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
    changes?: Array<{ path: string; kind: string }>;
    tool?: string;
    arguments?: unknown;
    result?: { content?: unknown; structured_content?: unknown };
    error?: { message: string };
    query?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
    reasoning_output_tokens?: number;
  };
  error?: { message: string };
  message?: string;
}

interface RunOpts {
  containerInput: ContainerInput;
  writeOutput: (out: ContainerOutput) => void;
  log: (message: string) => void;
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
 * Drain pending IPC input files. Mirrors the logic in index.ts so the
 * Codex engine sees the same follow-up messages that the Claude path
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

interface RunOneTurnResult {
  threadId?: string;
  fullText: string;
  toolCalls: number;
  error?: string;
}

interface CodexProviderInput {
  name: string;
  apiKey: string;
  baseURL: string;
  model: string;
}

/**
 * Write a temporary $CODEX_HOME/config.toml with:
 *   - model_providers from injected providers JSON (apiKey via env_key)
 *   - mcp_servers.deepthink pointing to mcp-bridge.js
 *
 * Returns the CODEX_HOME directory path, or null if both providers and
 * mcp-bridge are unavailable (caller should still proceed — codex will
 * use its default config).
 */
async function writeCodexConfig(
  providersJson: string,
  mcpBridgePath: string,
  log: (m: string) => void,
): Promise<string | null> {
  let providers: CodexProviderInput[] = [];
  if (providersJson) {
    try {
      const parsed = JSON.parse(providersJson);
      if (Array.isArray(parsed)) {
        providers = parsed.filter(
          (p): p is CodexProviderInput =>
            !!p && typeof p === 'object' &&
            typeof p.name === 'string' && typeof p.apiKey === 'string' &&
            typeof p.baseURL === 'string' && typeof p.model === 'string',
        );
      }
    } catch (err) {
      log(`Failed to parse CODEX_PROVIDERS_JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Sessions dir holds per-group .codex home. Use a subdirectory to avoid clashes.
  const sessionsRoot = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '/tmp', '.codex-deepthink');
  const codexHome = path.join(sessionsRoot, '.codex');
  try {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.chmodSync(codexHome, 0o700);
  } catch (err) {
    log(`Failed to mkdir CODEX_HOME ${codexHome}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  const lines: string[] = [];
  // Default model and provider
  if (providers.length > 0) {
    const primary = providers[0];
    lines.push(`model = "${primary.model.replace(/"/g, '\\"')}"`);
    lines.push(`model_provider = "deepthink"`);
  }

  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    const providerKey = i === 0 ? 'deepthink' : `deepthink_${i}`;
    lines.push('');
    lines.push(`[model_providers.${providerKey}]`);
    lines.push(`name = "${p.name.replace(/"/g, '\\"')}"`);
    lines.push(`base_url = "${p.baseURL.replace(/"/g, '\\"')}"`);
    // env_key names an env var codex will read for the API key. We set the
    // env var on the codex subprocess below.
    const envKeyName = `DEEPTHINK_CODEX_API_KEY_${i}`;
    lines.push(`env_key = "${envKeyName}"`);
    // Inject the apiKey into process.env so codex subprocess inherits it.
    process.env[envKeyName] = p.apiKey;
  }

  // MCP bridge — only if the compiled bridge exists
  if (fs.existsSync(mcpBridgePath)) {
    lines.push('');
    lines.push(`[mcp_servers.deepthink]`);
    lines.push(`command = "node"`);
    lines.push(`args = ["${mcpBridgePath.replace(/"/g, '\\"')}"]`);
    // env_vars: pass DT_* context to the bridge subprocess explicitly.
    // codex expects `mcp_servers.*.env_vars` to be a TOML sequence (array)
    // of "KEY=VALUE" strings — an inline table is rejected with
    // "invalid type: map, expected a sequence" and codex exits 1 at startup.
    const envVars: Record<string, string> = {};
    for (const k of [
      'DT_CHAT_JID', 'DT_GROUP_FOLDER', 'DT_IS_HOME', 'DT_IS_ADMIN_HOME',
      'DT_IPC_DIR', 'DT_WORKSPACE_GROUP', 'DT_WORKSPACE_GLOBAL',
      'DT_WORKSPACE_MEMORY', 'DT_DISABLE_MEMORY_LAYER',
      'DT_REDIS_URL', 'DT_DISTRIBUTED_MODE',
    ]) {
      if (process.env[k] !== undefined) {
        envVars[k] = process.env[k] as string;
      }
    }
    const envVarsToml = Object.entries(envVars)
      .map(([k, v]) => `"${k}=${String(v).replace(/"/g, '\\"')}"`)
      .join(', ');
    lines.push(`env_vars = [ ${envVarsToml} ]`);
  } else {
    log(`mcp-bridge.js not found at ${mcpBridgePath}, skipping MCP bridge config`);
  }

  try {
    const configPath = path.join(codexHome, 'config.toml');
    const tmp = `${configPath}.tmp`;
    fs.writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 });
    fs.renameSync(tmp, configPath);
    fs.chmodSync(configPath, 0o600);
    log(`Wrote codex config: ${configPath} (providers=${providers.length})`);
    return codexHome;
  } catch (err) {
    log(`Failed to write codex config: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Spawn one `codex exec --json` invocation and stream JSONL events.
 */
async function runOneTurn(
  opts: {
    binaryPath: string;
    model: string;
    workingDir: string;
    message: string;
    threadId?: string;
    writeOutput: (out: ContainerOutput) => void;
    currentSessionId: string | undefined;
    turnId: string | undefined;
    log: (m: string) => void;
    signal?: AbortSignal;
  },
): Promise<RunOneTurnResult> {
  const { binaryPath, model, workingDir, message, threadId, writeOutput, currentSessionId, turnId, log, signal } = opts;

  // 构造参数：codex exec --json --model M --cd DIR [resume <threadId>] "<prompt>"
  const args = ['exec', '--json', '--model', model, '--cd', workingDir];
  if (threadId) {
    args.push('resume', threadId);
  }
  args.push(message);

  log(`Spawning codex: ${binaryPath} ${args.map((a) => a.includes(' ') ? `"${a}"` : a).join(' ')} (cwd=${workingDir})`);

  const proc = spawn(binaryPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: workingDir,
    signal,
    env: process.env,
  });

  // stderr -> log
  proc.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trimEnd();
    if (line) log(`[codex stderr] ${line}`);
  });

  let fullText = '';
  let toolCalls = 0;
  let newThreadId: string | undefined;
  const lastItemText: Record<string, string> = {};

  const stdout = proc.stdout;
  if (!stdout) {
    return { fullText, toolCalls };
  }

  const rl = readline.createInterface({ input: stdout, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let ev: CodexThreadEvent;
    try {
      ev = JSON.parse(line) as CodexThreadEvent;
    } catch {
      // Non-JSONL output (e.g. progress spinners) — ignore.
      continue;
    }
    switch (ev.type) {
      case 'thread.started': {
        if (ev.thread_id) newThreadId = ev.thread_id;
        break;
      }
      case 'item.started':
      case 'item.updated': {
        if (!ev.item) break;
        if (ev.item.type === 'agent_message' && ev.item.text) {
          const itemId = ev.item.id ?? '_anon';
          const prev = lastItemText[itemId] ?? '';
          const full = ev.item.text;
          const delta = full.startsWith(prev) ? full.slice(prev.length) : full;
          lastItemText[itemId] = full;
          if (delta) {
            fullText += delta;
            emitStream(writeOutput, {
              eventType: 'text_delta',
              agentScope: 'main',
              text: delta,
            }, currentSessionId, turnId);
          }
        } else if (ev.item.type === 'reasoning' && ev.item.text) {
          emitStream(writeOutput, {
            eventType: 'thinking_delta',
            agentScope: 'main',
            text: ev.item.text,
          }, currentSessionId, turnId);
        } else if (ev.item.type === 'command_execution' && ev.type === 'item.started') {
          toolCalls += 1;
          emitStream(writeOutput, {
            eventType: 'tool_use_start',
            agentScope: 'main',
            toolName: 'command',
            toolInputSummary: (ev.item.command ?? '').slice(0, 200),
          }, currentSessionId, turnId);
        } else if (ev.item.type === 'command_execution' && ev.type === 'item.updated' && ev.item.aggregated_output) {
          emitStream(writeOutput, {
            eventType: 'tool_progress',
            agentScope: 'main',
            toolName: 'command',
            detail: ev.item.aggregated_output.slice(-1000),
          }, currentSessionId, turnId);
        } else if (ev.item.type === 'file_change' && ev.type === 'item.started') {
          toolCalls += 1;
          const paths = (ev.item.changes ?? []).map((c) => c.path).join(', ');
          emitStream(writeOutput, {
            eventType: 'tool_use_start',
            agentScope: 'main',
            toolName: 'file_change',
            toolInputSummary: paths.slice(0, 200),
          }, currentSessionId, turnId);
        } else if (ev.item.type === 'mcp_tool_call' && ev.type === 'item.started') {
          toolCalls += 1;
          emitStream(writeOutput, {
            eventType: 'tool_use_start',
            agentScope: 'main',
            toolName: ev.item.tool ?? 'mcp_tool',
            toolInputSummary: JSON.stringify(ev.item.arguments ?? {}).slice(0, 200),
          }, currentSessionId, turnId);
        } else if (ev.item.type === 'web_search' && ev.type === 'item.started') {
          toolCalls += 1;
          emitStream(writeOutput, {
            eventType: 'tool_use_start',
            agentScope: 'main',
            toolName: 'web_search',
            toolInputSummary: (ev.item.query ?? '').slice(0, 200),
          }, currentSessionId, turnId);
        }
        break;
      }
      case 'item.completed': {
        if (!ev.item) break;
        // Some codex/model combos (e.g. qwen3.7-max via DashScope responses API)
        // only emit the agent_message as item.completed — never item.started/
        // item.updated — so without this branch the final text is lost and the
        // turn ends with "(Codex 返回空回复)". Reuse the lastItemText delta
        // tracker so models that DO stream via item.updated don't double-emit.
        if (ev.item.type === 'agent_message' && ev.item.text) {
          const itemId = ev.item.id ?? '_anon';
          const prev = lastItemText[itemId] ?? '';
          const full = ev.item.text;
          const delta = full.startsWith(prev) ? full.slice(prev.length) : full;
          lastItemText[itemId] = full;
          if (delta) {
            fullText += delta;
            emitStream(writeOutput, {
              eventType: 'text_delta',
              agentScope: 'main',
              text: delta,
            }, currentSessionId, turnId);
          }
        } else if (ev.item.type === 'command_execution') {
          emitStream(writeOutput, {
            eventType: 'tool_use_end',
            agentScope: 'main',
            toolName: 'command',
            toolResult: (ev.item.aggregated_output ?? '').slice(-1000),
          }, currentSessionId, turnId);
        } else if (ev.item.type === 'file_change') {
          emitStream(writeOutput, {
            eventType: 'tool_use_end',
            agentScope: 'main',
            toolName: 'file_change',
          }, currentSessionId, turnId);
        } else if (ev.item.type === 'mcp_tool_call') {
          emitStream(writeOutput, {
            eventType: 'tool_use_end',
            agentScope: 'main',
            toolName: ev.item.tool ?? 'mcp_tool',
            toolResult: ev.item.error?.message ?? (typeof ev.item.result?.content === 'string' ? ev.item.result.content : ''),
          }, currentSessionId, turnId);
        } else if (ev.item.type === 'web_search') {
          emitStream(writeOutput, {
            eventType: 'tool_use_end',
            agentScope: 'main',
            toolName: 'web_search',
          }, currentSessionId, turnId);
        }
        break;
      }
      case 'turn.completed': {
        const inputT = ev.usage?.input_tokens ?? 0;
        const outputT = ev.usage?.output_tokens ?? 0;
        emitStream(writeOutput, {
          eventType: 'status',
          agentScope: 'main',
          statusText: `Codex tokens: ${inputT}/${outputT}`,
        }, currentSessionId, turnId);
        break;
      }
      case 'turn.failed': {
        return { threadId: newThreadId, fullText, toolCalls, error: ev.error?.message ?? 'turn failed' };
      }
      case 'error': {
        return { threadId: newThreadId, fullText, toolCalls, error: ev.error?.message ?? ev.message ?? 'codex error' };
      }
    }
  }

  // Wait for process exit to capture exit code
  const exitCode = await new Promise<number | null>((resolve) => {
    if (proc.exitCode !== null) return resolve(proc.exitCode);
    proc.on('exit', (code) => resolve(code));
  });
  if (exitCode !== null && exitCode !== 0) {
    return { threadId: newThreadId, fullText, toolCalls, error: `codex exited with code ${exitCode}` };
  }
  return { threadId: newThreadId, fullText, toolCalls };
}

export async function runCodexEngine(opts: RunOpts): Promise<void> {
  const { containerInput, writeOutput, log } = opts;
  const turnId = containerInput.turnId;

  // ── 1. Read engine env vars (injected by container-runner) ──
  const binaryPath = process.env.CODEX_BINARY_PATH?.trim() ?? '';
  const defaultModel = process.env.CODEX_DEFAULT_MODEL?.trim() || 'gpt-5.1-codex';
  const workingDir = process.env.CODEX_WORKING_DIR?.trim() || WORKSPACE_GROUP;

  if (!binaryPath) {
    writeOutput({
      status: 'error',
      result: null,
      error:
        'CODEX_BINARY_PATH 未注入。请在 设置 → Codex 引擎 中配置二进制路径，并确保群组 engine=codex。',
      turnId,
    });
    return;
  }
  if (!fs.existsSync(binaryPath)) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Codex 二进制不存在：${binaryPath}`,
      turnId,
    });
    return;
  }

  // ── 1b. Generate temporary $CODEX_HOME/config.toml with providers + MCP bridge ──
  // Override DT_CHAT_JID with the actual chatJid from containerInput (the
  // container-runner only knows group.folder, so sets a web:{folder} default).
  if (containerInput.chatJid) {
    process.env.DT_CHAT_JID = containerInput.chatJid;
  }
  const providersJson = process.env.CODEX_PROVIDERS_JSON?.trim() ?? '';
  const mcpBridgePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-bridge.js');
  const codexHome = await writeCodexConfig(providersJson, mcpBridgePath, log);
  if (codexHome) {
    process.env.CODEX_HOME = codexHome;
    log(`Codex config: CODEX_HOME=${codexHome}`);
  }

  // ── 2. Prepare initial prompt (drain IPC, scheduled task prefix) ──
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

  // ── 3. Emit init event ──
  emitStream(writeOutput, {
    eventType: 'init',
    agentScope: 'main',
    statusText: `Codex 引擎已启动 (model=${defaultModel})`,
  }, containerInput.sessionId, turnId);

  // ── 4. First turn ──
  let threadId = containerInput.sessionId;
  let abortController: AbortController | null = null;

  const runOneTurnWrapper = async (message: string): Promise<void> => {
    abortController = new AbortController();
    const result = await runOneTurn({
      binaryPath,
      model: defaultModel,
      workingDir,
      message,
      threadId,
      writeOutput,
      currentSessionId: threadId,
      turnId,
      log,
      signal: abortController.signal,
    });
    abortController = null;

    if (result.error) {
      writeOutput({
        status: 'error',
        result: result.fullText || null,
        error: `Codex 错误：${result.error}`,
        newSessionId: result.threadId ?? threadId,
        sessionId: threadId,
        turnId,
      });
      return;
    }

    if (result.threadId) threadId = result.threadId;

    writeOutput({
      status: 'success',
      result: result.fullText || '(Codex 返回空回复)',
      newSessionId: threadId,
      sessionId: threadId,
      turnId,
      finalizationReason: 'completed',
    });
  };

  await runOneTurnWrapper(prompt);

  // ── 5. IPC polling loop — handle follow-up messages ──
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
    log(`Received ${sig}, stopping codex-engine`);
    await cleanup();
    process.exit(0);
  };
  process.on('SIGINT', () => void sigHandler('SIGINT'));
  process.on('SIGTERM', () => void sigHandler('SIGTERM'));

  // Export for index.ts protocol symmetry (unused but matches atomcode-engine).
  void OUTPUT_START_MARKER;
  void OUTPUT_END_MARKER;
}
