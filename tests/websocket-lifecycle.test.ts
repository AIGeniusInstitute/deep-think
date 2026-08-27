import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED;
  });
  send = vi.fn();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emitClose(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

const replaceSpy = vi.fn();

vi.stubGlobal('window', {
  location: {
    protocol: 'http:',
    host: 'localhost:5173',
    origin: 'http://localhost:5173',
    pathname: '/',
    replace: replaceSpy,
  },
  addEventListener: vi.fn(),
});
vi.stubGlobal('WebSocket', FakeWebSocket);

const { WsManager } = await import('../web/src/api/ws');

describe('WsManager lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances.length = 0;
    replaceSpy.mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  test('disconnect closes the current socket and the next connect creates a fresh one', () => {
    const manager = new WsManager();

    manager.connect();
    const first = FakeWebSocket.instances[0];
    expect(first).toBeDefined();
    first.open();
    expect(manager.isConnected()).toBe(true);

    manager.disconnect();
    expect(first.close).toHaveBeenCalledOnce();
    expect(manager.isConnected()).toBe(false);

    manager.connect();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1]).not.toBe(first);
  });

  test('reconnects after the current socket closes unexpectedly', () => {
    const manager = new WsManager();

    manager.connect();
    FakeWebSocket.instances[0].emitClose(1006);

    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  test('disconnect cancels a pending reconnect', () => {
    const manager = new WsManager();

    manager.connect();
    FakeWebSocket.instances[0].emitClose(1006);
    manager.disconnect();

    vi.advanceTimersByTime(30_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  test('a stale socket close cannot reconnect or redirect after disconnect', () => {
    const manager = new WsManager();

    manager.connect();
    const staleNormalSocket = FakeWebSocket.instances[0];
    manager.disconnect();
    manager.connect();
    const staleAuthSocket = FakeWebSocket.instances[1];
    staleNormalSocket.emitClose(1006);
    vi.advanceTimersByTime(30_000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    manager.disconnect();
    manager.connect();
    const currentSocket = FakeWebSocket.instances[2];
    currentSocket.open();

    staleAuthSocket.emitClose(1008);
    vi.advanceTimersByTime(30_000);
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(manager.isConnected()).toBe(true);
    expect(replaceSpy).not.toHaveBeenCalled();
  });
});
