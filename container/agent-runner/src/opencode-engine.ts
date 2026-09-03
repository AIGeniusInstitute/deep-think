/**
 * OpenCode Engine Adapter
 *
 * Drives OpenCode (`opencode serve` HTTP/SSE API) as an alternative to the
 * Claude Agent SDK query() path. Invoked by index.ts main() when
 * ContainerInput.engine === 'opencode'.
 *
 * Lifecycle:
 *   1. spawn `<binaryPath> serve --hostname 127.0.0.1 --port <port>`
 *      with env OPENCODE_SERVER_PASSWORD (and OPENCODE_SERVER_USERNAME=opencode).
 *   2. Poll `GET /doc` until ready (30s timeout).
 *   3. POST /session to create a session (or reuse provided sessionID).
 *   4. GET /event?directory=<workDir> SSE — async consumer.
 *   5. POST /session/:id/message with { providerID, modelID, parts:[{text}] }.
 *   6. Translate SSE events to DeepThink StreamEvents, emit via writeOutput.
 *   7. On `session.status` (idle) / `session.error`: emit final writeOutput.
 *   8. Enter IPC polling loop — on new message: POST /message again.
 *   9. On _close sentinel: stop serve subprocess, exit process.
 *
 * Known limitations (documented in PRD §3.1):
 *   - No DeepThink MCP tool bridge (send_message/schedule_task/memory_*).
 *   - No image input (first version is text-only).
 *   - Requires Bun runtime (host machine or bind-mount).
 *   - Session persists to ~/.local/share/opencode/storage/ but serve
 *     process must be alive for SSE consumption.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

import type { ContainerInput, ContainerOutput, StreamEvent } from './types.js';

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

/** OpenCode SSE event: event name "message", data JSON {id, type, properties}. */
interface OpencodeSseEvent {
  id?: string;
  type: string;
  properties?: Record<string, unknown>;
}

interface RunOpts {
  containerInput: ContainerInput;
  writeOutput: (out: ContainerOutput) => void;
  log: (message: string) => void;
}

interface OpencodeProviderInput {
  id: string;
  name: string;
  apiKey: string;
  baseURL: string;
  models: string[];
}

/**
 * Write a temporary opencode.jsonc with:
 *   - provider entries from injected providers JSON
 *   - mcp.deepthink local-server pointing to mcp-bridge.js
 *
 * Returns the file path (also sets OPENCODE_CONFIG env on caller's behalf
 * is NOT done here — caller sets process.env.OPENCODE_CONFIG from return value).
 */
async function writeOpencodeConfigFile(
  providersJson: string,
  mcpBridgePath: string,
  log: (m: string) => void,
): Promise<string | null> {
  let providers: OpencodeProviderInput[] = [];
  if (providersJson) {
    try {
      const parsed = JSON.parse(providersJson);
      if (Array.isArray(parsed)) {
        providers = parsed.filter(
          (p): p is OpencodeProviderInput =>
            !!p && typeof p === 'object' &&
            typeof p.id === 'string' && typeof p.apiKey === 'string' &&
            typeof p.baseURL === 'string' && Array.isArray(p.models) &&
            p.models.every((m: unknown) => typeof m === 'string'),
        );
      }
    } catch (err) {
      log(`Failed to parse OPENCODE_PROVIDERS_JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const sessionsRoot = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '/tmp', '.opencode-deepthink');
  const configDir = path.join(sessionsRoot, '.opencode');
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.chmodSync(configDir, 0o700);
  } catch (err) {
    log(`Failed to mkdir opencode config dir ${configDir}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const configPath = path.join(configDir, 'opencode.jsonc');

  // Build config object. opencode.jsonc schema:
  //   { "provider": { <id>: { "name", "api_key", "base_url", "models": { <model>: { "name" } } } },
  //     "mcp": { "deepthink": { "type":"local", "command":["node","..."], "environment": { ... } } } }
  const config: Record<string, unknown> = { provider: {}, mcp: {} };

  for (const p of providers) {
    const modelsMap: Record<string, { name: string }> = {};
    for (const m of p.models) {
      modelsMap[m] = { name: m };
    }
    // OpenCode v1 provider config schema (packages/core/src/v1/config/provider.ts):
    // the credentials live under `options` as camelCase `apiKey`/`baseURL`, and
    // `api` selects the API integration. DeepThink's opencode providers all use
    // OpenAI-compatible baseURLs (e.g. dashscope /compatible-mode/v1), so
    // `api: "openai"`. The previous `api_key`/`base_url` (snake_case, top-level)
    // format was unreadable by OpenCode → baseURL resolved to `undefined` →
    // "undefined/chat/completions cannot be parsed as a URL" → the LLM was
    // never called (only the user's prompt echoed back).
    (config.provider as Record<string, unknown>)[p.id] = {
      name: p.name || p.id,
      api: 'openai',
      options: {
        apiKey: p.apiKey,
        baseURL: p.baseURL,
      },
      models: modelsMap,
    };
  }

  if (fs.existsSync(mcpBridgePath)) {
    const environment: Record<string, string> = {};
    for (const k of [
      'DT_CHAT_JID', 'DT_GROUP_FOLDER', 'DT_IS_HOME', 'DT_IS_ADMIN_HOME',
      'DT_IPC_DIR', 'DT_WORKSPACE_GROUP', 'DT_WORKSPACE_GLOBAL',
      'DT_WORKSPACE_MEMORY', 'DT_DISABLE_MEMORY_LAYER',
      'DT_REDIS_URL', 'DT_DISTRIBUTED_MODE',
    ]) {
      if (process.env[k] !== undefined) {
        environment[k] = String(process.env[k]);
      }
    }
    (config.mcp as Record<string, unknown>).deepthink = {
      type: 'local',
      command: ['node', mcpBridgePath],
      environment,
    };
  } else {
    log(`mcp-bridge.js not found at ${mcpBridgePath}, skipping MCP bridge config`);
  }

  try {
    const tmp = `${configPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, configPath);
    fs.chmodSync(configPath, 0o600);
    log(`Wrote opencode config: ${configPath} (providers=${providers.length})`);
    return configPath;
  } catch (err) {
    log(`Failed to write opencode config: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
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

/** Pick a free TCP port in [basePort, basePort+portRange). */
async function pickFreePort(basePort: number, portRange: number, log: (m: string) => void): Promise<number> {
  const tried = new Set<number>();
  for (let attempt = 0; attempt < portRange; attempt++) {
    const offset = Math.floor(Math.random() * portRange);
    if (tried.has(offset)) continue;
    tried.add(offset);
    const port = basePort + offset;
    const free = await isPortFree(port);
    if (free) return port;
  }
  log(`pickFreePort: no free port in [${basePort}, ${basePort + portRange})`);
  return 0;
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => {
      try { server.close(); } catch { /* ignore */ }
      resolve(false);
    });
    server.once('listening', () => {
      try { server.close(); } catch { /* ignore */ }
      resolve(true);
    });
    server.listen(port, '127.0.0.1');
  });
}

/** Start opencode serve on a random loopback port, wait for GET /doc. */
async function startServe(opts: {
  binaryPath: string;
  basePort: number;
  portRange: number;
  host: string;
  password: string;
  workingDir: string;
  log: (m: string) => void;
  logFile?: string;
}): Promise<{ baseUrl: string; process: ChildProcess; port: number }> {
  const { binaryPath, basePort, portRange, host, password, workingDir, log, logFile } = opts;
  if (!binaryPath) throw new Error('OPENCODE_BINARY_PATH is empty');
  if (!fs.existsSync(binaryPath)) throw new Error(`opencode binary not found at ${binaryPath}`);

  const port = await pickFreePort(basePort, portRange, log);
  if (!port) {
    throw new Error(`No free port available in [${basePort}, ${basePort + portRange})`);
  }

  // <binaryPath> serve --hostname 127.0.0.1 --port <port>
  const args = ['serve', '--hostname', host || '127.0.0.1', '--port', String(port)];
  log(`Spawning opencode serve: ${binaryPath} ${args.join(' ')} (cwd=${workingDir})`);

  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_SERVER_USERNAME: 'opencode',
  };

  let stderrStream: fs.WriteStream | undefined;
  if (logFile) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      stderrStream = fs.createWriteStream(logFile, { flags: 'a' });
    } catch { /* ignore */ }
  }

  const proc = spawn(binaryPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: workingDir,
    env: childEnv,
  });
  if (stderrStream) {
    proc.stderr?.pipe(stderrStream);
  } else {
    proc.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trimEnd();
      if (line) log(`[opencode stderr] ${line}`);
    });
  }
  proc.stdout?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trimEnd();
    if (line) log(`[opencode stdout] ${line}`);
  });
  proc.on('exit', (code, sig) => {
    log(`opencode serve exited (code=${code}, sig=${sig})`);
  });
  proc.on('error', (err) => {
    log(`opencode serve error: ${err.message}`);
  });

  const baseUrl = `http://${(host || '127.0.0.1') === '0.0.0.0' ? '127.0.0.1' : host || '127.0.0.1'}:${port}`;
  // Poll /doc until ready
  const deadline = Date.now() + 30_000;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/doc`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        log(`opencode serve ready at ${baseUrl}`);
        return { baseUrl, process: proc, port };
      }
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  try { proc.kill('SIGKILL'); } catch { /* ignore */ }
  throw new Error(`opencode serve failed to become ready at ${baseUrl}: ${lastErr}`);
}

/** Stop opencode serve gracefully: SIGTERM -> 10s -> SIGKILL. */
async function stopServe(proc: ChildProcess, log: (m: string) => void): Promise<void> {
  if (proc.exitCode !== null || proc.killed) return;
  return new Promise<void>((resolve) => {
    const onExit = () => {
      clearTimeout(killTimer);
      resolve();
    };
    proc.once('exit', onExit);
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    const killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      resolve();
    }, 10_000);
  });
}

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

function authHeader(password: string): string {
  return 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
}

/** Create session via POST /session. Body can be empty. Returns sessionID. */
async function createSession(
  baseUrl: string,
  password: string,
  workingDir: string,
  log: (m: string) => void,
): Promise<string> {
  const res = await fetch(
    `${baseUrl}/session?directory=${encodeURIComponent(workingDir)}`,
    {
      method: 'POST',
      headers: {
        'Authorization': authHeader(password),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST /session HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = (await res.json()) as { id?: string };
  if (!data.id) throw new Error(`POST /session returned no id: ${JSON.stringify(data).slice(0, 200)}`);
  log(`Created opencode session: ${data.id}`);
  return data.id;
}

/** Send a prompt to opencode. Returns immediately; events come via SSE. */
async function sendMessage(
  baseUrl: string,
  sessionId: string,
  password: string,
  workingDir: string,
  providerID: string,
  modelID: string,
  message: string,
  log: (m: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(
    `${baseUrl}/session/${encodeURIComponent(sessionId)}/message?directory=${encodeURIComponent(workingDir)}`,
    {
      method: 'POST',
      headers: {
        'Authorization': authHeader(password),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        providerID,
        modelID,
        parts: [{ type: 'text', text: message }],
      }),
      signal,
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST /session/${sessionId}/message HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  log(`Sent opencode prompt to session ${sessionId}`);
}

/**
 * Parse an SSE response stream into discrete events. OpenCode emits
 * `event: message\ndata: <json>\n\n` blocks; data is JSON
 * `{id, type, properties}`.
 */
async function* parseSseStream(
  response: Response,
): AsyncGenerator<OpencodeSseEvent> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = raw
        .split('\n')
        .find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const jsonStr = dataLine.slice(5).trim();
      if (!jsonStr) continue;
      try {
        yield JSON.parse(jsonStr) as OpencodeSseEvent;
      } catch {
        // skip malformed event
      }
    }
  }
  // flush trailing
  if (buffer.trim()) {
    const dataLine = buffer
      .split('\n')
      .find((l) => l.startsWith('data:'));
    if (dataLine) {
      const jsonStr = dataLine.slice(5).trim();
      if (jsonStr) {
        try {
          yield JSON.parse(jsonStr) as OpencodeSseEvent;
        } catch {
          // skip
        }
      }
    }
  }
}

/** Run one turn: send prompt + wait for session.status (idle) or session.error. */
async function runOneTurn(
  opts: {
    baseUrl: string;
    sessionId: string;
    password: string;
    workingDir: string;
    providerID: string;
    modelID: string;
    message: string;
    writeOutput: (out: ContainerOutput) => void;
    currentSessionId: string | undefined;
    turnId: string | undefined;
    log: (m: string) => void;
    signal?: AbortSignal;
  },
): Promise<{ fullText: string; toolCalls: number; error?: string }> {
  const { baseUrl, sessionId, password, workingDir, providerID, modelID, message, writeOutput, currentSessionId, turnId, log, signal } = opts;

  let fullText = '';
  let toolCalls = 0;
  let errorMessage: string | undefined;
  let done = false;

  // SSE subscription + POST /message race: opencode's /event stream is
  // server-sent; we open it first, then POST. We use a promise that
  // resolves once session.status=idle or session.error arrives.
  const sseConsumer = (async () => {
    const eventUrl = `${baseUrl}/event?directory=${encodeURIComponent(workingDir)}`;
    const res = await fetch(eventUrl, {
      headers: { 'Authorization': authHeader(password), Accept: 'text/event-stream' },
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      errorMessage = `GET /event HTTP ${res.status}: ${text.slice(0, 500)}`;
      done = true;
      return;
    }
    try {
      // Track which messages are user-authored so we can drop their parts
      // below. OpenCode emits `message.part.updated` for the USER's prompt
      // text too (the very part we POSTed via /session/:id/message), and a
      // part carries no role field — only its parent message (surfaced via
      // `message.updated`) does. Without this filter the user's input —
      // including any injected <system_context> block — gets accumulated
      // into fullText and echoed back as the agent's reply.
      const userMessageIds = new Set<string>();
      for await (const ev of parseSseStream(res)) {
        if (done) break;
        const type = ev.type;
        const props = ev.properties ?? {};
        if (type === 'message.updated') {
          const info = (props as { info?: { id?: string; role?: string } }).info;
          if (info?.id && info.role === 'user') {
            userMessageIds.add(info.id);
          }
          continue;
        }
        if (type === 'message.part.updated') {
          const part = (props as { part?: { type?: string; text?: string; messageID?: string; state?: { status?: string }; tool?: string } }).part;
          if (!part) continue;
          // Skip parts belonging to a user message — they are the prompt we
          // sent, not the assistant's reply.
          if (part.messageID && userMessageIds.has(part.messageID)) continue;
          if (part.type === 'text' && part.text) {
            fullText += part.text;
            emitStream(writeOutput, {
              eventType: 'text_delta',
              agentScope: 'main',
              text: part.text,
            }, currentSessionId, turnId);
          } else if (part.type === 'reasoning' && part.text) {
            emitStream(writeOutput, {
              eventType: 'thinking_delta',
              agentScope: 'main',
              text: part.text,
            }, currentSessionId, turnId);
          } else if (part.type === 'tool') {
            const status = part.state?.status;
            if (status === 'running') {
              toolCalls += 1;
              emitStream(writeOutput, {
                eventType: 'tool_use_start',
                agentScope: 'main',
                toolName: part.tool ?? 'tool',
              }, currentSessionId, turnId);
            } else if (status === 'pending') {
              emitStream(writeOutput, {
                eventType: 'tool_progress',
                agentScope: 'main',
                toolName: part.tool ?? 'tool',
              }, currentSessionId, turnId);
            } else if (status === 'completed') {
              emitStream(writeOutput, {
                eventType: 'tool_use_end',
                agentScope: 'main',
                toolName: part.tool ?? 'tool',
              }, currentSessionId, turnId);
            } else if (status === 'error') {
              emitStream(writeOutput, {
                eventType: 'tool_use_end',
                agentScope: 'main',
                toolName: part.tool ?? 'tool',
              }, currentSessionId, turnId);
            }
          }
          // step-start / step-finish are internal markers, ignore
        } else if (type === 'session.status') {
          const statusType = (props as { status?: { type?: string } }).status?.type;
          if (statusType === 'idle') {
            done = true;
            break;
          }
        } else if (type === 'session.error') {
          errorMessage = `session.error: ${JSON.stringify(props).slice(0, 500)}`;
          done = true;
          break;
        }
      }
    } catch (err) {
      if (!done) {
        errorMessage = err instanceof Error ? err.message : String(err);
        done = true;
      }
    }
  })();

  // Send the prompt; SSE consumer will capture events
  try {
    await sendMessage(baseUrl, sessionId, password, workingDir, providerID, modelID, message, log, signal);
  } catch (err) {
    if (!done) {
      errorMessage = err instanceof Error ? err.message : String(err);
      done = true;
    }
  }

  // Wait for SSE consumer to signal idle/error (or signal abort)
  const deadline = Date.now() + 5 * 60 * 1000; // 5min turn timeout
  while (!done && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!done) {
    errorMessage = 'opencode turn timeout (5min)';
    done = true;
  }

  // SSE consumer exits when done becomes true
  await sseConsumer.catch(() => { /* already captured in errorMessage */ });

  return { fullText, toolCalls, error: errorMessage };
}

export async function runOpencodeEngine(opts: RunOpts): Promise<void> {
  const { containerInput, writeOutput, log } = opts;
  const turnId = containerInput.turnId;

  // ── 1. Read engine env vars (injected by container-runner) ──
  const binaryPath = process.env.OPENCODE_BINARY_PATH?.trim() ?? '';
  const host = process.env.OPENCODE_HOST?.trim() || '127.0.0.1';
  const basePort = parseInt(process.env.OPENCODE_BASE_PORT ?? '15000', 10);
  const portRange = parseInt(process.env.OPENCODE_PORT_RANGE ?? '100', 10);
  const password = process.env.OPENCODE_PASSWORD ?? '';
  const providerID = process.env.OPENCODE_PROVIDER_ID?.trim() || 'anthropic';
  const modelID = process.env.OPENCODE_MODEL_ID?.trim() || 'claude-sonnet-4-6';
  const workingDir = process.env.OPENCODE_WORKING_DIR?.trim() || WORKSPACE_GROUP;

  if (!binaryPath) {
    writeOutput({
      status: 'error',
      result: null,
      error:
        'OPENCODE_BINARY_PATH 未注入。请在 设置 → OpenCode 引擎 中配置 opencode 二进制路径，并确保群组 engine=opencode。',
      turnId,
    });
    return;
  }

  // ── 1b. Generate temporary opencode.jsonc with providers + MCP bridge ──
  // Override DT_CHAT_JID with the actual chatJid from containerInput
  if (containerInput.chatJid) {
    process.env.DT_CHAT_JID = containerInput.chatJid;
  }
  const providersJson = process.env.OPENCODE_PROVIDERS_JSON?.trim() ?? '';
  const mcpBridgePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-bridge.js');
  const configPath = await writeOpencodeConfigFile(providersJson, mcpBridgePath, log);
  if (configPath) {
    process.env.OPENCODE_CONFIG = configPath;
    log(`OpenCode config: OPENCODE_CONFIG=${configPath}`);
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

  // ── 3. Spawn opencode serve ──
  const logFile = path.join(workingDir, 'logs', 'opencode-serve.log');
  let serveInst: { baseUrl: string; process: ChildProcess; port: number };
  try {
    serveInst = await startServe({
      binaryPath,
      basePort,
      portRange,
      host,
      password,
      workingDir,
      log,
      logFile,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeOutput({
      status: 'error',
      result: null,
      error: `OpenCode serve 启动失败：${msg}`,
      turnId,
    });
    return;
  }

  // ── 4. Emit init event ──
  emitStream(writeOutput, {
    eventType: 'init',
    agentScope: 'main',
    statusText: `OpenCode 引擎已启动 (port=${serveInst.port})`,
  }, containerInput.sessionId, turnId);

  // ── 5. Create or reuse session ──
  let sessionId = containerInput.sessionId;
  if (!sessionId) {
    try {
      sessionId = await createSession(serveInst.baseUrl, password, workingDir, log);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeOutput({
        status: 'error',
        result: null,
        error: `OpenCode 创建 session 失败：${msg}`,
        turnId,
      });
      await stopServe(serveInst.process, log);
      return;
    }
  }

  // ── 6. First turn ──
  let abortController: AbortController | null = null;

  const runOneTurnWrapper = async (message: string): Promise<void> => {
    abortController = new AbortController();
    const result = await runOneTurn({
      baseUrl: serveInst.baseUrl,
      sessionId: sessionId!,
      password,
      workingDir,
      providerID,
      modelID,
      message,
      writeOutput,
      currentSessionId: sessionId,
      turnId,
      log,
      signal: abortController.signal,
    });
    abortController = null;

    if (result.error) {
      writeOutput({
        status: 'error',
        result: result.fullText || null,
        error: `OpenCode 错误：${result.error}`,
        newSessionId: sessionId,
        sessionId,
        turnId,
      });
      return;
    }

    writeOutput({
      status: 'success',
      result: result.fullText || '(OpenCode 返回空回复)',
      newSessionId: sessionId,
      sessionId,
      turnId,
      finalizationReason: 'completed',
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
    await stopServe(serveInst.process, log);
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
    log(`Received ${sig}, stopping opencode-engine`);
    await cleanup();
    process.exit(0);
  };
  process.on('SIGINT', () => void sigHandler('SIGINT'));
  process.on('SIGTERM', () => void sigHandler('SIGTERM'));
}
