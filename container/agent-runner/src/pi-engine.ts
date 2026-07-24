/**
 * pi Engine Adapter (v2 — RPC subprocess)
 *
 * Drives the pi coding agent as a **binary subprocess** in RPC mode, mirroring
 * the atomcode / codex / opencode "external binary package" integration pattern.
 *
 * pi is published as the npm package `@earendil-works/pi-coding-agent` (bin `pi`).
 * It ships a `--mode rpc` mode purpose-built for process integration: a long-lived
 * child process that reads JSONL commands on stdin and writes JSONL responses +
 * agent events on stdout (see ~/pi/packages/coding-agent/docs/rpc.md).
 *
 * This adapter spawns that child once per DeepThink session, drives it over the
 * JSONL protocol, and translates pi's `AgentSessionEvent` stream into DeepThink
 * `StreamEvent`s. The pi child is the engine; we are only the driver.
 *
 * ── Protocol contract (pi rpc-types.ts / jsonl.ts) ──
 *   stdin : one JSON `RpcCommand` per LF. We send: get_state, prompt,
 *           extension_ui_response.
 *   stdout: one JSON per LF — either an `RpcResponse` (carries the matching
 *           request `id`), an `AgentSessionEvent` (streamed, no id), or an
 *           `extension_ui_request` (carries a dialog `id`).
 *   Framing: STRICT LF-only. pi forbids Node `readline` because it also splits
 *           on U+2028 / U+2029, which are valid inside JSON strings. We use a
 *           dedicated LF-only reader (see attachJsonlReader below).
 *
 * ── Lifecycle ──
 *   1. spawn `binaryPath [cliScriptPath] --mode rpc [--provider P] [--model M]
 *      [--thinking T] [--session <id>]`, cwd=workingDir, inject
 *      `<PROVIDER>_API_KEY` env + per-group `PI_CODING_AGENT_DIR`.
 *   2. Attach ONE LF-only JSONL reader to proc.stdout for the process lifetime.
 *      It routes every line through `handleLine`: responses are correlated by
 *      `id` to pending request promises; events flow to the active turn
 *      handler; extension UI requests are auto-dismissed.
 *   3. Ready detection: send `get_state` (await its response, 30s). Capture
 *      `sessionId` for persistence.
 *   4. First turn: register a transient event handler, send `prompt`, consume
 *      events until `agent_settled` (authoritative idle signal — `agent_end`
 *      may be followed by retry / compaction). Emit success.
 *   5. IPC polling loop — on a new follow-up message: register a fresh handler,
 *      send another `prompt`, repeat.
 *   6. `extension_ui_request`: reply `{ cancelled: true }` (no TUI in
 *      external-driver mode).
 *   7. On `_close` sentinel / SIGTERM: SIGTERM pi child → exit.
 *
 * ── Unified LLM provider config (no machine-local pi config) ──
 *   All provider/model/apiKey/baseURL settings come from DeepThink's Settings →
 *   pi 引擎 UI (runtime-config.ts PiConfig, stored in DeepThink's
 *   CLAUDE_CONFIG_DIR/pi.json). container-runner injects them as PI_BINARY_PATH /
 *   PI_CLI_SCRIPT_PATH / PI_DEFAULT_PROVIDER / PI_DEFAULT_MODEL /
 *   PI_THINKING_LEVEL / PI_PROVIDERS_JSON env vars. This adapter maps each
 *   provider to its `<PROVIDER>_API_KEY` env var (so pi-ai reads it) and passes
 *   `--provider`/`--model`/`--thinking` on the CLI. The per-group
 *   PI_CODING_AGENT_DIR is an isolated empty dir, so pi never touches the
 *   user's `~/.pi/agent` credentials or settings — users configure everything
 *   in DeepThink.
 *
 * ── Why v2 (audit findings) ──
 *   The prior implementation used two `readline.createInterface` instances on
 *   the same stdout (one for ready detection, one per turn). That is (a) a
 *   protocol violation — pi forbids readline, and (b) architecturally broken —
 *   two readers on one stream split lines unpredictably and lose data. v2 uses
 *   a single LF-only reader with id-correlated response dispatch, matching pi's
 *   own `RpcClient` reference design.
 *
 * Known limitations (documented in PRD §3.1):
 *   - No DeepThink MCP tool bridge (send_message/schedule_task/memory_*).
 *   - No image input (first version is text-only).
 *   - No sub-agents / skills / plugins / extensions bridging.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import type { ContainerInput, ContainerOutput, StreamEvent } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// IPC constants (mirrors index.ts / codex-engine.ts so follow-up messages reach
// the pi engine the same way they would reach the Claude path).
// ─────────────────────────────────────────────────────────────────────────────
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

/** A line emitted by pi RPC on stdout — discriminated by `type`. */
interface PiResponse {
  id?: string;
  type: 'response';
  command: string;
  success: boolean;
  data?: unknown;
  error?: { message?: string } | string;
}
interface PiExtensionUiRequest {
  type: 'extension_ui_request';
  id: string;
  method: string;
}
type PiEvent = { type: string; [key: string]: unknown };
type PiRpcLine = PiResponse | PiExtensionUiRequest | PiEvent;

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

// ─────────────────────────────────────────────────────────────────────────────
// LF-only JSONL reader (DO NOT use node:readline — see file header).
// Mirrors pi's attachJsonlLineReader (packages/coding-agent/src/modes/rpc/jsonl.ts).
// ─────────────────────────────────────────────────────────────────────────────
function attachJsonlReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): () => void {
  const decoder = new StringDecoder('utf8');
  let buffer = '';

  const emitLine = (line: string): void => {
    onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
  };

  const onData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    while (true) {
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      emitLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  };

  const onEnd = (): void => {
    buffer += decoder.end();
    if (buffer.length > 0) emitLine(buffer);
    buffer = '';
  };

  stream.on('data', onData);
  stream.on('end', onEnd);
  return () => {
    stream.off('data', onData);
    stream.off('end', onEnd);
  };
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
 * Drain pending IPC input files. Mirrors index.ts / codex-engine so the pi
 * engine sees the same follow-up messages the Claude path would have absorbed.
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

/** Extract a human-readable error string from a pi response error field. */
function piErrorToString(err: PiResponse['error']): string {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  return err.message ?? 'unknown error';
}

/**
 * pi-ai provider name → models.json `api` field. Providers not listed default
 * to "openai-completions" (the dominant compatibility shape). Anthropic-family
 * providers use "anthropic-messages" so an Anthropic-compatible baseURL (e.g.
 * DashScope's /apps/anthropic) speaks the right wire format.
 */
const PROVIDER_API: Record<string, string> = {
  anthropic: 'anthropic-messages',
  'ant-ling': 'anthropic-messages',
  zai: 'anthropic-messages',
  kimi: 'anthropic-messages',
};

/** Sanitize a DeepThink provider name into a pi custom-provider id (no slash,
 *  no whitespace) so `--model <id>/<model>` parses correctly. */
function toCustomProviderId(provider: string): string {
  const cleaned = provider.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
  return `dt-${cleaned || 'default'}`;
}

/**
 * Write `models.json` into the isolated PI_CODING_AGENT_DIR so pi picks up
 * every DeepThink-configured provider that has a custom baseURL — without the
 * user touching ~/.pi/agent on the machine. Providers with an empty baseURL
 * stay on pi's built-in provider (env key only). The API key is referenced as
 * `$<ENV_KEY>` so the secret stays in the spawned env, not on disk.
 *
 * Returns a map from the original provider name → the provider id to use on
 * the CLI (`dt-<provider>` for custom, or the original name for built-in).
 */
function writePiModelsJson(
  providers: PiProviderInput[],
  piAgentDir: string,
  thinkingLevel: string,
  log: (m: string) => void,
): Map<string, string> {
  const idMap = new Map<string, string>();
  const custom: Record<string, unknown> = {};
  const reasoning = thinkingLevel !== 'off';
  for (const p of providers) {
    if (!p.baseURL) {
      // Built-in provider — just inject env key (done by caller), use as-is.
      idMap.set(p.provider, p.provider);
      continue;
    }
    const customId = toCustomProviderId(p.provider);
    idMap.set(p.provider, customId);
    const envKey = PROVIDER_ENV_KEY[p.provider.toLowerCase()];
    const apiKeyRef = envKey ? `$${envKey}` : p.apiKey; // fall back to literal
    custom[customId] = {
      baseUrl: p.baseURL,
      api: PROVIDER_API[p.provider.toLowerCase()] ?? 'openai-completions',
      apiKey: apiKeyRef,
      models: [
        {
          id: p.model,
          name: p.model,
          reasoning,
          input: ['text'],
          contextWindow: 128000,
          maxTokens: 8192,
        },
      ],
    };
  }
  const hasCustom = Object.keys(custom).length > 0;
  if (!hasCustom) {
    // No custom providers → remove a stale models.json from a prior run so pi
    // doesn't pick up old entries.
    const modelsPath = path.join(piAgentDir, 'models.json');
    try { fs.unlinkSync(modelsPath); } catch { /* ignore */ }
    return idMap;
  }
  try {
    fs.mkdirSync(piAgentDir, { recursive: true });
    const modelsPath = path.join(piAgentDir, 'models.json');
    fs.writeFileSync(modelsPath, JSON.stringify({ providers: custom }, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(modelsPath, 0o600);
    log(`Wrote pi models.json (${Object.keys(custom).length} custom provider(s)) → ${modelsPath}`);
  } catch (err) {
    log(`Failed to write pi models.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  return idMap;
}

// ─────────────────────────────────────────────────────────────────────────────
// pi RPC session driver: one persistent stdout reader + id-correlated command
// dispatch + a swappable per-turn event handler.
// ─────────────────────────────────────────────────────────────────────────────
interface PendingRequest {
  resolve: (resp: PiResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

type TurnEventHandler = (ev: PiEvent) => void;

class PiRpcDriver {
  private proc: ChildProcess;
  private log: (m: string) => void;
  private pending = new Map<string, PendingRequest>();
  private reqSeq = 0;
  private turnHandler: TurnEventHandler | null = null;
  private detachReader: (() => void) | null = null;
  private exited = false;

  constructor(proc: ChildProcess, log: (m: string) => void) {
    this.proc = proc;
    this.log = log;
  }

  /** Attach the single LF-only stdout reader. Call once after spawn. */
  start(onUiRequest: (req: PiExtensionUiRequest) => void): void {
    const stdout = this.proc.stdout;
    if (!stdout) return;
    this.detachReader = attachJsonlReader(stdout, (line) => {
      this.handleLine(line, onUiRequest);
    });
    this.proc.once('close', (code, signal) => {
      this.exited = true;
      this.log(`pi child exited (code=${code} signal=${signal})`);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.resolve({
          id: undefined,
          type: 'response',
          command: '__exit__',
          success: false,
          error: `pi process exited (code=${code} signal=${signal})`,
        });
      }
      this.pending.clear();
    });
  }

  private handleLine(line: string, onUiRequest: (req: PiExtensionUiRequest) => void): void {
    if (!line.trim()) return;
    let msg: PiRpcLine;
    try {
      msg = JSON.parse(line) as PiRpcLine;
    } catch {
      // Non-JSONL (stderr bleed / logs) — ignore.
      return;
    }
    if (msg.type === 'response') {
      const resp = msg as PiResponse;
      const id = resp.id;
      if (id && this.pending.has(id)) {
        const p = this.pending.get(id)!;
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.resolve(resp);
      }
      // Responses with no pending id (stray acks) — drop.
      return;
    }
    if (msg.type === 'extension_ui_request') {
      onUiRequest(msg as PiExtensionUiRequest);
      return;
    }
    // Otherwise it's an AgentSessionEvent — route to the active turn.
    const handler = this.turnHandler;
    if (handler) {
      try {
        handler(msg as PiEvent);
      } catch (err) {
        this.log(`turn handler threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Send a command and await its response (correlated by id). */
  async send<T = unknown>(cmd: Record<string, unknown>): Promise<PiResponse & { data?: T }> {
    const stdin = this.proc.stdin;
    if (!stdin || stdin.destroyed || this.exited) {
      throw new Error('pi stdin unavailable');
    }
    const id = `req-${++this.reqSeq}`;
    const fullCmd = { ...cmd, id };
    return new Promise<PiResponse & { data?: T }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi command timeout: ${String(cmd.type)}`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (resp) => resolve(resp as PiResponse & { data?: T }),
        timer,
      });
      try {
        stdin.write(JSON.stringify(fullCmd) + '\n');
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Install the handler that receives AgentSessionEvents for one turn. */
  setTurnHandler(h: TurnEventHandler | null): void {
    this.turnHandler = h;
  }

  hasExited(): boolean {
    return this.exited;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.detachReader?.();
    this.detachReader = null;
    try { this.proc.kill(signal); } catch { /* ignore */ }
  }
}

/**
 * Run one prompt turn against the long-lived pi RPC process:
 * send `prompt`, consume events until `agent_settled` (or error/abort).
 */
async function runOneTurn(
  opts: {
    driver: PiRpcDriver;
    message: string;
    writeOutput: (out: ContainerOutput) => void;
    currentSessionId: string | undefined;
    turnId: string | undefined;
    log: (m: string) => void;
    signal?: AbortSignal;
  },
): Promise<RunOneTurnResult> {
  const { driver, message, writeOutput, currentSessionId, turnId, signal } = opts;
  const result: RunOneTurnResult = { fullText: '', toolCalls: 0 };
  let settled = false;

  const settledPromise = new Promise<void>((resolve) => {
    const handler: TurnEventHandler = (ev) => {
      switch (ev.type) {
        case 'agent_start':
          emitStream(writeOutput, {
            eventType: 'init',
            agentScope: 'main',
            statusText: 'pi 引擎已启动',
          }, currentSessionId, turnId);
          break;
        case 'message_update': {
          const ame = (ev as {
            assistantMessageEvent?: {
              type?: string;
              delta?: string;
              content?: string;
              toolCall?: { name?: string; arguments?: unknown };
            };
          }).assistantMessageEvent;
          if (!ame) break;
          if (ame.type === 'text_delta' && ame.delta) {
            result.fullText += ame.delta;
            emitStream(writeOutput, { eventType: 'text_delta', agentScope: 'main', text: ame.delta }, currentSessionId, turnId);
          } else if (ame.type === 'thinking_delta' && ame.delta) {
            emitStream(writeOutput, { eventType: 'thinking_delta', agentScope: 'main', text: ame.delta }, currentSessionId, turnId);
          } else if (ame.type === 'toolcall_end' && ame.toolCall) {
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
          const t = ev as { toolName?: string; args?: unknown };
          emitStream(writeOutput, {
            eventType: 'tool_use_start',
            agentScope: 'main',
            toolName: t.toolName ?? 'tool',
            toolInputSummary: JSON.stringify(t.args ?? {}).slice(0, 200),
          }, currentSessionId, turnId);
          break;
        }
        case 'tool_execution_update': {
          const t = ev as { toolName?: string; partialResult?: unknown };
          emitStream(writeOutput, {
            eventType: 'tool_progress',
            agentScope: 'main',
            toolName: t.toolName ?? 'tool',
            detail: (typeof t.partialResult === 'string' ? t.partialResult : JSON.stringify(t.partialResult ?? '')).slice(-1000),
          }, currentSessionId, turnId);
          break;
        }
        case 'tool_execution_end': {
          const t = ev as { toolName?: string; result?: unknown; isError?: boolean };
          emitStream(writeOutput, {
            eventType: 'tool_use_end',
            agentScope: 'main',
            toolName: t.toolName ?? 'tool',
            toolResult: (typeof t.result === 'string' ? t.result : JSON.stringify(t.result ?? '')).slice(-1000),
          }, currentSessionId, turnId);
          break;
        }
        case 'bash_execution_update': {
          const t = ev as { delta?: string };
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
        case 'message_end': {
          // Capture assistant errors (e.g. 403/429/5xx surfaced as
          // stopReason:'error' + errorMessage). Without this the turn would
          // emit an empty success instead of propagating the provider error.
          const m = (ev as {
            message?: { role?: string; stopReason?: string; errorMessage?: string };
          }).message;
          if (m?.role === 'assistant' && (m.stopReason === 'error' || m.errorMessage)) {
            result.error = m.errorMessage || `assistant error (stopReason=${m.stopReason ?? 'unknown'})`;
          }
          break;
        }
        case 'turn_end':
          break;
        case 'agent_end':
          // Not authoritative — may retry/compact. Wait for agent_settled.
          break;
        case 'agent_settled':
          settled = true;
          resolve();
          break;
        default:
          // Unknown event — protocol-robust, don't crash.
          break;
      }
    };
    driver.setTurnHandler(handler);

    signal?.addEventListener('abort', () => {
      if (!settled) {
        result.interrupted = true;
        resolve();
      }
    });
  });

  // Send the prompt command. pi responds with success once the prompt is
  // accepted; real output arrives as events. A failure response means the
  // prompt was rejected before acceptance.
  try {
    const resp = await driver.send<{ sessionId?: string }>({ type: 'prompt', message });
    if (!resp.success) {
      result.error = piErrorToString(resp.error);
      driver.setTurnHandler(null);
      return result;
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    driver.setTurnHandler(null);
    return result;
  }

  await settledPromise;
  driver.setTurnHandler(null);
  return result;
}

/** Write a raw JSONL command to a child's stdin without awaiting a response
 *  (used for fire-and-forget replies like extension_ui_response). */
function sendRawCommand(proc: ChildProcess, cmd: Record<string, unknown>): boolean {
  if (!proc.stdin || proc.stdin.destroyed) return false;
  try {
    proc.stdin.write(JSON.stringify(cmd) + '\n');
    return true;
  } catch {
    return false;
  }
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
  // Empty isolated dir → pi never reads the user's ~/.pi/agent credentials or
  // settings. All provider config comes from DeepThink env / CLI flags.
  const groupFolder = process.env.DT_GROUP_FOLDER || containerInput.groupFolder || 'default';
  const piAgentDir = resolvePiAgentDir(groupFolder, log);
  process.env.PI_CODING_AGENT_DIR = piAgentDir;
  // Suppress pi's startup network calls (version check / telemetry) — we drive it.
  process.env.PI_SKIP_VERSION_CHECK = process.env.PI_SKIP_VERSION_CHECK ?? '1';
  process.env.PI_OFFLINE = process.env.PI_OFFLINE ?? '1';

  // ── 1d. Generate models.json for providers with a custom baseURL ──
  // Mirrors codex (config.toml) / opencode (opencode.jsonc): write the file
  // into the isolated config dir so all provider settings come from DeepThink.
  const providerIdMap = writePiModelsJson(providers, piAgentDir, thinkingLevel, log);
  const defaultProviderId = providerIdMap.get(defaultProvider) ?? defaultProvider;
  const defaultProviderHasBaseURL = providers.some(
    (p) => p.provider === defaultProvider && !!p.baseURL,
  );

  if (containerInput.chatJid) {
    process.env.DT_CHAT_JID = containerInput.chatJid;
  }

  // ── 2. Build spawn args ──
  const args: string[] = [];
  if (cliScriptPath) args.push(cliScriptPath);
  args.push('--mode', 'rpc');
  if (defaultProviderHasBaseURL) {
    // Custom provider registered in models.json — select via `provider/id`.
    args.push('--model', `${defaultProviderId}/${defaultModel}`);
  } else {
    args.push('--provider', defaultProvider);
    args.push('--model', defaultModel);
  }
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

  // ── 4. Start the single stdout reader + dispatch ──
  const handleUiRequest = (req: PiExtensionUiRequest): void => {
    // Dialog methods (select/confirm/input/editor) block until a response;
    // fire-and-forget methods ignore the response. Replying `cancelled` to
    // dialog methods is safe in external-driver mode (no TUI user to answer).
    sendRawCommand(proc, { type: 'extension_ui_response', id: req.id, cancelled: true });
  };

  const driver = new PiRpcDriver(proc, log);
  driver.start(handleUiRequest);

  // ── 5. Ready detection: send get_state, await response (30s) ──
  let piSessionId: string | undefined = containerInput.sessionId;
  let ready = false;
  try {
    const resp = await driver.send<{ sessionId?: string; sessionFile?: string }>({ type: 'get_state' });
    if (resp.success && resp.data?.sessionId) {
      piSessionId = resp.data.sessionId;
      ready = true;
    } else if (driver.hasExited()) {
      writeOutput({
        status: 'error',
        result: null,
        error: `pi 进程已退出，请检查 binaryPath/cliScriptPath 与 stderr 日志。${piErrorToString(resp.error)}`,
        turnId,
      });
      try { logStream?.end(); } catch { /* ignore */ }
      return;
    } else {
      writeOutput({
        status: 'error',
        result: null,
        error: `pi get_state 失败：${piErrorToString(resp.error)}`,
        turnId,
      });
    }
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `pi 就绪检测失败（30s 内未收到 get_state 响应）：${err instanceof Error ? err.message : String(err)}`,
      turnId,
    });
  }

  if (!ready) {
    driver.kill('SIGTERM');
    try { logStream?.end(); } catch { /* ignore */ }
    return;
  }
  log(`pi ready, sessionId=${piSessionId ?? '(none)'}`);

  // ── 6. Prepare initial prompt (drain IPC, scheduled task prefix) ──
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

  // ── 7. First turn ──
  let abortController: AbortController | null = null;

  const runOneTurnWrapper = async (message: string): Promise<void> => {
    abortController = new AbortController();
    const result = await runOneTurn({
      driver,
      message,
      writeOutput,
      currentSessionId: piSessionId,
      turnId,
      log,
      signal: abortController.signal,
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

  // ── 8. IPC polling loop — handle follow-up messages ──
  // The engine blocks here until the _close sentinel arrives (main process
  // writes it when the turn is fully drained). index.ts does
  // `await runPiEngine(); process.exit(0)` — without this block the process
  // would exit immediately after the first turn and IPC follow-ups / steering
  // messages would never be processed.
  let closed = false;
  let watcher: fs.FSWatcher | null = null;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  let resolveClosed: (() => void) | null = null;
  const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });

  const cleanup = async (): Promise<void> => {
    if (closed) return;
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
    driver.kill('SIGTERM');
    try { logStream?.end(); } catch { /* ignore */ }
    writeOutput({ status: 'closed', result: null, turnId });
    resolveClosed?.();
    resolveClosed = null;
  };

  const checkForNewMessages = async (): Promise<void> => {
    if (closed) return;
    try {
      if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
        log('IPC _close sentinel detected, shutting down');
        await cleanup();
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
  fallbackTimer.unref?.();

  // SIGINT/SIGTERM handler
  const sigHandler = async (sig: string): Promise<void> => {
    log(`Received ${sig}, stopping pi-engine`);
    await cleanup();
    process.exit(0);
  };
  process.on('SIGINT', () => void sigHandler('SIGINT'));
  process.on('SIGTERM', () => void sigHandler('SIGTERM'));

  // Block until _close sentinel / SIGTERM. Keeps the agent-runner process
  // alive for IPC follow-ups and steering messages.
  await closedPromise;

  // Exported markers kept for index.ts protocol symmetry (unused here).
  void OUTPUT_START_MARKER;
  void OUTPUT_END_MARKER;
}
