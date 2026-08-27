import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
  findFreePort: vi.fn(),
  mkdirSync: vi.fn(),
  createWriteStream: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: mocks.spawn,
  execFileSync: mocks.execFileSync,
}));

vi.mock('fs', () => ({
  default: {
    mkdirSync: mocks.mkdirSync,
    createWriteStream: mocks.createWriteStream,
    readdirSync: vi.fn(() => {
      throw new Error('not found');
    }),
    statSync: vi.fn(),
  },
}));

vi.mock('../desktop/src/paths.js', () => ({
  backendEntry: '/mock/backend/index.js',
  nodeBinary: '/mock/node',
  dataDir: '/mock/data',
  logDir: '/mock/logs',
  backendLogPath: '/mock/logs/backend.log',
  agentRunnerDir: '/mock/agent-runner',
  webDistDir: '/mock/web-dist',
}));

vi.mock('../desktop/src/port-resolver.js', () => ({
  findFreePort: mocks.findFreePort,
}));

import { BackendSupervisor } from '../desktop/src/backend-supervisor.js';

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly killSignals: NodeJS.Signals[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  autoExitOnKill = true;
  private exited = false;

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killSignals.push(signal);
    if (this.autoExitOnKill) {
      queueMicrotask(() => this.emitExit(null, signal));
    }
    return true;
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

const children: FakeChild[] = [];
const fetchMock = vi.fn();
let consoleSpy: ReturnType<typeof vi.spyOn>;

async function startReady(supervisor: BackendSupervisor) {
  const started = supervisor.start();
  await vi.advanceTimersByTimeAsync(300);
  return started;
}

beforeEach(() => {
  vi.useFakeTimers();
  children.length = 0;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetchMock);

  mocks.spawn.mockReset();
  mocks.spawn.mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  });
  mocks.findFreePort.mockReset();
  mocks.findFreePort.mockResolvedValue(49281);
  mocks.mkdirSync.mockReset();
  mocks.createWriteStream.mockReset();
  mocks.createWriteStream.mockImplementation(() => ({
    write: vi.fn(),
    end: vi.fn(),
  }));
  mocks.execFileSync.mockReset();
  mocks.execFileSync.mockImplementation((command: string) => {
    if (command === 'lsof') throw new Error('no listener');
    return '/usr/bin:/bin';
  });
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  consoleSpy.mockRestore();
});

describe('BackendSupervisor lifecycle', () => {
  test('starts successfully after an explicit stop', async () => {
    const supervisor = new BackendSupervisor();

    const first = await startReady(supervisor);
    await supervisor.stop();
    const second = await startReady(supervisor);

    expect(first.proc).toBe(children[0]);
    expect(second.proc).toBe(children[1]);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await supervisor.stop();
  });

  test('starts a fresh lifecycle after stop cancels port selection', async () => {
    const supervisor = new BackendSupervisor();
    let resolveFirstPort!: (port: number) => void;
    mocks.findFreePort.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          resolveFirstPort = resolve;
        }),
    );

    const cancelledStart = supervisor.start().then(
      () => 'resolved',
      (err: Error) => err.message,
    );
    const stopping = supervisor.stop();
    const restarted = supervisor.start();
    resolveFirstPort(49282);
    await vi.advanceTimersByTimeAsync(300);

    await stopping;
    await expect(cancelledStart).resolves.toBe('Backend start cancelled');
    await expect(restarted).resolves.toMatchObject({ port: 49281 });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);

    await supervisor.stop();
  });

  test('automatically restarts a crash after the second explicit start', async () => {
    const supervisor = new BackendSupervisor();

    await startReady(supervisor);
    await supervisor.stop();
    await startReady(supervisor);

    children[1].emitExit(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(mocks.spawn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(300);
    await supervisor.stop();
  });

  test('cancels a scheduled crash restart across stop and manual start', async () => {
    const supervisor = new BackendSupervisor();

    await startReady(supervisor);
    children[0].emitExit(1);
    await supervisor.stop();
    await startReady(supervisor);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);

    await supervisor.stop();
  });

  test('ignores late output and exit from an old child', async () => {
    const supervisor = new BackendSupervisor();

    await startReady(supervisor);
    const oldChild = children[0];
    oldChild.autoExitOnKill = false;

    fetchMock.mockResolvedValue({ ok: false });
    const stopping = supervisor.stop();
    let secondSettled = false;
    const secondStart = supervisor.start().then((result) => {
      secondSettled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await stopping;
    await vi.advanceTimersByTimeAsync(0);

    oldChild.stdout.emit('data', Buffer.from('Server listening on old port'));
    oldChild.stderr.emit('data', Buffer.from('old failure'));
    oldChild.emitExit(1);
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValue({ ok: true });
    await vi.advanceTimersByTimeAsync(300);
    await secondStart;

    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);

    await supervisor.stop();
  });

  test('coalesces concurrent starts into one spawn', async () => {
    const supervisor = new BackendSupervisor();

    const first = supervisor.start();
    const second = supervisor.start();

    expect(second).toBe(first);
    await vi.advanceTimersByTimeAsync(300);
    await expect(first).resolves.toMatchObject({ port: 49281 });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);

    await supervisor.stop();
  });

  test('does not report a timed-out live process as ready', async () => {
    const supervisor = new BackendSupervisor();
    fetchMock.mockResolvedValue({ ok: false });

    const timedOut = supervisor.start().then(
      () => 'resolved',
      (err: Error) => err.message,
    );
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(timedOut).resolves.toBe(
      'Backend did not become ready within 60000ms',
    );
    await expect(supervisor.start()).rejects.toThrow(
      'Backend process is running but did not become ready',
    );
    expect(mocks.spawn).toHaveBeenCalledTimes(1);

    await supervisor.stop();
  });

  test('preserves the three-attempt budget across internal restarts', async () => {
    const supervisor = new BackendSupervisor();

    await startReady(supervisor);
    for (const delay of [1_000, 2_000, 4_000]) {
      children[children.length - 1].emitExit(1);
      await vi.advanceTimersByTimeAsync(delay);
      await vi.advanceTimersByTimeAsync(300);
    }

    expect(mocks.spawn).toHaveBeenCalledTimes(4);
    children[3].emitExit(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.spawn).toHaveBeenCalledTimes(4);

    await supervisor.stop();
  });
});
