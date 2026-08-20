import { spawn, ChildProcess, execFileSync } from 'child_process';
import fs from 'fs';
import { backendEntry, nodeBinary, dataDir, logDir, backendLogPath, agentRunnerDir, webDistDir } from './paths.js';
import { findFreePort } from './port-resolver.js';

const READY_TIMEOUT_MS = 60_000;
const READY_PROBE_INTERVAL_MS = 200;

export interface StartResult {
  port: number;
  proc: ChildProcess;
}

interface ReadyWait {
  generation: number;
  proc: ChildProcess;
  timeout: ReturnType<typeof setTimeout> | null;
  probeTimer: ReturnType<typeof setTimeout> | null;
  resolve: (port: number) => void;
  reject: (err: Error) => void;
}

export class BackendSupervisor {
  private proc: ChildProcess | null = null;
  private port: number | null = null;
  private logStream: fs.WriteStream | null = null;
  private restartCount = 0;
  private stopped = false;
  private generation = 0;
  private startPromise: Promise<StartResult> | null = null;
  private stopPromise: Promise<void> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readyWait: ReadyWait | null = null;
  private ready = false;

  start(): Promise<StartResult> {
    if (this.startPromise) return this.startPromise;
    const proc = this.proc;
    if (
      !this.stopped &&
      proc &&
      proc.exitCode === null &&
      proc.signalCode === null
    ) {
      if (this.ready && this.port !== null) {
        return Promise.resolve({ port: this.port, proc });
      }
      return Promise.reject(
        new Error(
          'Backend process is running but did not become ready; stop it before restarting',
        ),
      );
    }

    this.cancelRestartTimer();
    this.stopped = false;
    this.restartCount = 0;
    const generation = ++this.generation;
    return this.trackStart(generation);
  }

  private trackStart(generation: number): Promise<StartResult> {
    if (this.startPromise) return this.startPromise;

    const pendingStop = this.stopPromise;
    const task = (async () => {
      if (pendingStop) await pendingStop;
      if (this.stopped || generation !== this.generation) {
        throw new Error('Backend start cancelled');
      }
      return this.startAttempt(generation);
    })();
    const tracked = task.finally(() => {
      if (this.startPromise === tracked) this.startPromise = null;
    });
    this.startPromise = tracked;
    return tracked;
  }

  private async startAttempt(generation: number): Promise<StartResult> {
    const port = await findFreePort(49281, 49300);
    if (this.stopped || generation !== this.generation) {
      throw new Error('Backend start cancelled');
    }
    this.port = port;
    this.ready = false;
    this.openLogStream();
    this.log(`[supervisor] starting backend on port ${port}`);

    const env = this.buildEnv(port);
    this.log(`[supervisor] node binary: ${nodeBinary}`);
    this.log(`[supervisor] backend entry: ${backendEntry}`);
    this.log(`[supervisor] data dir: ${dataDir}`);
    this.log(`[supervisor] agent runner dir: ${agentRunnerDir}`);
    this.log(`[supervisor] web dist dir: ${webDistDir}`);

    const proc = spawn(nodeBinary, [backendEntry], {
      env: { ...process.env, ...env },
      cwd: dataDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    proc.stdout?.on('data', (chunk: Buffer) =>
      this.onStdout(proc, generation, port, chunk),
    );
    proc.stderr?.on('data', (chunk: Buffer) =>
      this.onStderr(proc, generation, chunk),
    );
    proc.on('exit', (code, signal) =>
      this.onExit(proc, generation, code, signal),
    );

    await this.waitForReady(proc, generation, port);
    return { port, proc };
  }

  private buildEnv(port: number): NodeJS.ProcessEnv {
    // When running under Electron's binary (dev mode), force Node-only behavior
    // so the backend process acts as plain Node rather than spawning a window.
    const isElectronBinary = /electron/i.test(nodeBinary);
    return {
      ELECTRON_RUN_AS_NODE: isElectronBinary ? '1' : '',
      DEEPTHINK_DATA_DIR: dataDir,
      DEEPTHINK_AGENT_RUNNER_DIR: agentRunnerDir,
      DEEPTHINK_WEB_DIST_DIR: webDistDir,
      WEB_PORT: String(port),
      ASSISTANT_NAME: 'DeepThink',
      NODE_ENV: 'production',
      FORCE_COLOR: '0',
      // macOS Electron GUI apps don't load shell profiles (.zshrc/.zprofile),
      // so the inherited PATH only contains /usr/bin:/bin:/usr/sbin:/sbin.
      // That misses homebrew (/opt/homebrew/bin or /usr/local/bin), nvm, asdf,
      // volta, ~/.local/bin, etc. — any spawn of npx/node/npm from the backend
      // fails with ENOENT (e.g. installSkillForUser -> npx skills add).
      // Resolve the user's login-shell PATH once at startup and merge with
      // the current PATH so backend subprocesses can find user-installed tools.
      PATH: resolveBackendPath(),
    };
  }

  private openLogStream(): void {
    fs.mkdirSync(logDir, { recursive: true });
    this.logStream = fs.createWriteStream(backendLogPath, { flags: 'a' });
  }

  private log(line: string): void {
    const ts = new Date().toISOString();
    const formatted = `${ts} ${line}\n`;
    this.logStream?.write(formatted);
    // eslint-disable-next-line no-console
    console.log(line);
  }

  private onStdout(
    proc: ChildProcess,
    generation: number,
    port: number,
    chunk: Buffer,
  ): void {
    if (this.proc !== proc || this.generation !== generation) return;
    this.logStream?.write(chunk);
    const text = chunk.toString();
    // Detect ready signal: Hono @hono/node-server prints "Server listening on" or
    // we rely on HTTP probe. Both paths handled below.
    if (/listening|Server listening|started on/i.test(text)) {
      this.resolveReady(proc, generation, port);
    }
  }

  private onStderr(
    proc: ChildProcess,
    generation: number,
    chunk: Buffer,
  ): void {
    if (this.proc !== proc || this.generation !== generation) return;
    this.logStream?.write(Buffer.concat([Buffer.from('[stderr] '), chunk]));
  }

  private onExit(
    proc: ChildProcess,
    generation: number,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.proc !== proc || this.generation !== generation) return;

    this.log(`[supervisor] backend exited code=${code} signal=${signal}`);
    this.proc = null;
    this.ready = false;
    this.rejectReady(
      proc,
      generation,
      new Error(`Backend exited before ready (code=${code} signal=${signal})`),
    );
    if (this.stopped) return;
    this.restartCount += 1;
    if (this.restartCount > 3) {
      this.log('[supervisor] max restart attempts exceeded, giving up');
      return;
    }
    const delayMs = 1000 * Math.pow(2, this.restartCount - 1);
    this.log(
      `[supervisor] scheduling restart #${this.restartCount} in ${delayMs}ms`,
    );
    const timer = setTimeout(() => {
      if (this.restartTimer !== timer) return;
      this.restartTimer = null;
      if (this.stopped || this.generation !== generation || this.proc) return;
      this.trackStart(generation).catch((err) => {
        this.log(`[supervisor] restart failed: ${err.message}`);
      });
    }, delayMs);
    this.restartTimer = timer;
  }

  private async waitForReady(
    proc: ChildProcess,
    generation: number,
    port: number,
  ): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const wait: ReadyWait = {
        generation,
        proc,
        timeout: null,
        probeTimer: null,
        resolve,
        reject,
      };
      this.readyWait = wait;
      wait.timeout = setTimeout(() => {
        this.rejectReady(
          proc,
          generation,
          new Error(
            `Backend did not become ready within ${READY_TIMEOUT_MS}ms`,
          ),
        );
      }, READY_TIMEOUT_MS);

      // HTTP probe fallback: poll /api/health until 200
      const probe = async () => {
        if (!this.isCurrent(proc, generation) || this.readyWait !== wait)
          return;
        try {
          const ok = await httpGetOk(`http://127.0.0.1:${port}/api/health`);
          if (ok) {
            this.resolveReady(proc, generation, port);
            return;
          }
        } catch {
          // not ready yet
        }
        if (this.isCurrent(proc, generation) && this.readyWait === wait) {
          wait.probeTimer = setTimeout(probe, READY_PROBE_INTERVAL_MS);
        }
      };
      wait.probeTimer = setTimeout(probe, 300);
    });
  }

  stop(): Promise<void> {
    this.stopped = true;
    ++this.generation;
    this.cancelRestartTimer();
    this.cancelReady(new Error('Backend stopped before ready'));
    // A start still waiting on port selection belongs to the old generation.
    // Detach it so a subsequent explicit start can create a fresh lifecycle.
    this.startPromise = null;
    this.ready = false;

    const proc = this.proc;
    const port = this.port;
    const logStream = this.logStream;
    this.proc = null;

    if (this.stopPromise) return this.stopPromise;

    const task = this.stopProcess(proc, port, logStream);
    const tracked = task.finally(() => {
      if (this.stopPromise === tracked) this.stopPromise = null;
    });
    this.stopPromise = tracked;
    return tracked;
  }

  private async stopProcess(
    proc: ChildProcess | null,
    port: number | null,
    logStream: fs.WriteStream | null,
  ): Promise<void> {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      // Even without a proc ref, kill anything still listening on the port
      if (port) killPortListeners(port, (l) => this.log(l));
      logStream?.end();
      if (this.logStream === logStream) this.logStream = null;
      return;
    }
    this.log('[supervisor] sending SIGTERM');
    proc.kill('SIGTERM');
    await waitExit(proc, 5000).catch(() => {
      this.log('[supervisor] SIGKILL after timeout');
      proc.kill('SIGKILL');
    });
    // Belt-and-suspenders: kill any descendant that escaped the process group
    // and is still holding the port (e.g. spawned Docker/agent subprocesses).
    if (port) killPortListeners(port, (l) => this.log(l));
    logStream?.end();
    if (this.logStream === logStream) this.logStream = null;
  }

  private isCurrent(proc: ChildProcess, generation: number): boolean {
    return (
      !this.stopped && this.generation === generation && this.proc === proc
    );
  }

  private resolveReady(
    proc: ChildProcess,
    generation: number,
    port: number,
  ): void {
    const wait = this.readyWait;
    if (!wait || wait.proc !== proc || wait.generation !== generation) return;
    if (!this.isCurrent(proc, generation)) return;
    this.ready = true;
    this.clearReadyWait(wait);
    wait.resolve(port);
  }

  private rejectReady(
    proc: ChildProcess,
    generation: number,
    err: Error,
  ): void {
    const wait = this.readyWait;
    if (!wait || wait.proc !== proc || wait.generation !== generation) return;
    this.clearReadyWait(wait);
    wait.reject(err);
  }

  private cancelReady(err: Error): void {
    const wait = this.readyWait;
    if (!wait) return;
    this.clearReadyWait(wait);
    wait.reject(err);
  }

  private clearReadyWait(wait: ReadyWait): void {
    if (wait.timeout) clearTimeout(wait.timeout);
    if (wait.probeTimer) clearTimeout(wait.probeTimer);
    if (this.readyWait === wait) this.readyWait = null;
  }

  private cancelRestartTimer(): void {
    if (!this.restartTimer) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  get currentPort(): number | null {
    return this.port;
  }
}

// Common user-level bin directories appended as a safety net when login-shell
// resolution fails or the user has a non-standard setup.
const FALLBACK_PATH_ENTRIES = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
];

// Homebrew installs node (and versioned node@18/node@20/...) as *keg-only*:
// the `npx`/`node`/`npm` binaries live in `<prefix>/opt/node@XX/bin` and are
// NOT symlinked into `<prefix>/bin`. Some users only expose this path via
// `~/.bash_profile` (e.g. `export PATH="/usr/local/opt/node@20/bin:$PATH"`),
// which a zsh login shell — and macOS GUI apps — never source. Login-shell PATH
// resolution (zsh) therefore misses it, and FALLBACK_PATH_ENTRIES only has
// `<prefix>/bin` (no npx there). Probe both Homebrew prefixes for node keg
// `bin` dirs so backend subprocesses (e.g. `npx skills add`) can find npx.
function homebrewNodeKegBins(): string[] {
  const dirs: string[] = [];
  for (const prefix of ['/usr/local/opt', '/opt/homebrew/opt']) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(prefix, { withFileTypes: true });
    } catch {
      continue; // prefix not present (e.g. /opt/homebrew on Intel)
    }
    for (const ent of entries) {
      if (!ent.name.startsWith('node')) continue;
      const binDir = `${prefix}/${ent.name}/bin`;
      try {
        // statSync follows the opt symlink, so it works for keg symlinks too.
        if (fs.statSync(binDir).isDirectory()) dirs.push(binDir);
      } catch {
        // bin doesn't exist — skip this keg
      }
    }
  }
  return dirs;
}

let cachedBackendPath: string | null = null;

// macOS Electron GUI apps don't load shell profiles (.zshrc/.zprofile), so the
// inherited PATH only contains /usr/bin:/bin:/usr/sbin:/sbin and misses
// homebrew, nvm, asdf, volta, ~/.local/bin, etc. Resolve the user's login-shell
// PATH once at startup and merge with the inherited PATH + a small fallback list
// so backend subprocesses (e.g. `npx skills add`) can find user-installed tools.
function resolveBackendPath(): string {
  if (cachedBackendPath !== null) return cachedBackendPath;

  const inherited = (process.env.PATH || '').split(':').filter(Boolean);
  const shell = process.env.SHELL || '/bin/zsh';
  let shellPath: string[] = [];
  try {
    const out = execFileSync(shell, ['-l', '-i', '-c', 'printf %s "$PATH"'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    shellPath = out.split(':').filter(Boolean);
  } catch {
    // Ignore — fall back to inherited + FALLBACK_PATH_ENTRIES below.
  }

  const merged: string[] = [];
  const seen = new Set<string>();
  for (const p of [...shellPath, ...inherited, ...homebrewNodeKegBins(), ...FALLBACK_PATH_ENTRIES]) {
    if (p && !seen.has(p)) {
      seen.add(p);
      merged.push(p);
    }
  }

  cachedBackendPath = merged.join(':');
  return cachedBackendPath;
}

function waitExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    const t = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    proc.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

async function httpGetOk(url: string): Promise<boolean> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Kill every process listening on `port` (TCP LISTEN state only).
 *
 * Why -sTCP:LISTEN: a bare `lsof -ti:PORT` would also catch processes that
 * merely have a connection to the port (OrbStack/Docker proxies, etc.),
 * which can crash the Docker daemon. Restricting to LISTEN sockets targets
 * only the actual server process — same rule the project's CLAUDE.md
 * mandates for shutting down the dev server.
 */
function killPortListeners(port: number, log: (line: string) => void): void {
  try {
    const out = execFileSync('lsof', ['-ti', `:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pids = out
      .trim()
      .split('\n')
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (pids.length === 0) return;
    log(`[supervisor] killing ${pids.length} lingering listener(s) on port ${port}: ${pids.join(', ')}`);
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
    }
  } catch {
    // lsof returns non-zero when no listener matches — nothing to kill.
  }
}

// Keep ref for hot path
export const supervisorSingleton = new BackendSupervisor();
