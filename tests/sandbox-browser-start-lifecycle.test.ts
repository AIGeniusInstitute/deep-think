import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  if (typeof (globalThis as any).window === 'undefined') {
    (globalThis as any).window = {
      addEventListener: () => {},
      removeEventListener: () => {},
      location: { protocol: 'http:', host: 'localhost', pathname: '/' },
    };
  }
  if (typeof (globalThis as any).WebSocket === 'undefined') {
    (globalThis as any).WebSocket = class {};
  }
});

import { sandboxApi } from '../web/src/api/sandbox';
import { wsManager } from '../web/src/api/ws';
import { useSandboxStore } from '../web/src/stores/sandbox';

const resetBrowserState = () => {
  useSandboxStore.setState({
    activeSessionId: null,
    browserFrame: null,
    browserFrames: {},
    browserStartedSessions: new Set(),
    subscribedSessions: new Set(),
  });
};

describe('sandbox browser start lifecycle', () => {
  beforeEach(resetBrowserState);

  afterEach(() => {
    vi.restoreAllMocks();
    resetBrowserState();
  });

  it('marks the browser started and subscribes after REST confirms startup', async () => {
    vi.spyOn(sandboxApi, 'browserStart').mockResolvedValue({
      ok: true,
      started: true,
    });
    const send = vi.spyOn(wsManager, 'send').mockReturnValue(true);

    const started = await useSandboxStore
      .getState()
      .startBrowser('sb-1', 'https://example.com');

    expect(started).toBe(true);
    expect(sandboxApi.browserStart).toHaveBeenCalledWith(
      'sb-1',
      'https://example.com',
    );
    expect(useSandboxStore.getState().browserStartedSessions.has('sb-1')).toBe(
      true,
    );
    expect(useSandboxStore.getState().subscribedSessions.has('sb-1')).toBe(
      true,
    );
    expect(send).toHaveBeenCalledWith({
      type: 'sandbox_browser_subscribe',
      sessionId: 'sb-1',
    });
  });

  it('does not change lifecycle state when REST startup fails', async () => {
    vi.spyOn(sandboxApi, 'browserStart').mockRejectedValue(
      new Error('start failed'),
    );
    const send = vi.spyOn(wsManager, 'send').mockReturnValue(true);

    await expect(
      useSandboxStore.getState().startBrowser('sb-2'),
    ).rejects.toThrow('start failed');

    expect(useSandboxStore.getState().browserStartedSessions.has('sb-2')).toBe(
      false,
    );
    expect(useSandboxStore.getState().subscribedSessions.has('sb-2')).toBe(
      false,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('retries the frame subscription when WebSocket reconnects', async () => {
    vi.spyOn(sandboxApi, 'browserStart').mockResolvedValue({
      ok: true,
      started: true,
    });
    const send = vi
      .spyOn(wsManager, 'send')
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const off = useSandboxStore.getState().wireWsHandlers();

    await useSandboxStore.getState().startBrowser('sb-reconnect');
    expect(
      useSandboxStore.getState().browserStartedSessions.has('sb-reconnect'),
    ).toBe(true);
    expect(
      useSandboxStore.getState().subscribedSessions.has('sb-reconnect'),
    ).toBe(false);

    (wsManager as any).emit('connected', {});
    expect(
      useSandboxStore.getState().subscribedSessions.has('sb-reconnect'),
    ).toBe(true);
    expect(send).toHaveBeenLastCalledWith({
      type: 'sandbox_browser_subscribe',
      sessionId: 'sb-reconnect',
    });

    (wsManager as any).emit('disconnected', {});
    expect(
      useSandboxStore.getState().subscribedSessions.has('sb-reconnect'),
    ).toBe(false);
    expect(
      useSandboxStore.getState().browserStartedSessions.has('sb-reconnect'),
    ).toBe(true);

    off?.();
  });

  it('tracks WebSocket started/stopped events and clears the stale frame on stop', () => {
    const off = useSandboxStore.getState().wireWsHandlers();
    useSandboxStore.setState({ activeSessionId: 'sb-3' });

    (wsManager as any).emit('sandbox_browser_started', { sessionId: 'sb-3' });
    useSandboxStore.setState({ subscribedSessions: new Set(['sb-3']) });
    (wsManager as any).emit('sandbox_browser_frame', {
      sessionId: 'sb-3',
      dataUrl: 'data:image/jpeg;base64,frame',
    });
    expect(useSandboxStore.getState().browserStartedSessions.has('sb-3')).toBe(
      true,
    );
    expect(useSandboxStore.getState().browserFrames['sb-3']).toContain('frame');

    (wsManager as any).emit('sandbox_browser_stopped', { sessionId: 'sb-3' });
    expect(useSandboxStore.getState().browserStartedSessions.has('sb-3')).toBe(
      false,
    );
    expect(useSandboxStore.getState().subscribedSessions.has('sb-3')).toBe(
      false,
    );
    expect(useSandboxStore.getState().browserFrames['sb-3']).toBeUndefined();
    expect(useSandboxStore.getState().browserFrame).toBeNull();

    off?.();
  });

  it('cleans lifecycle state and sends unsubscribe when requested', () => {
    const send = vi.spyOn(wsManager, 'send').mockReturnValue(true);
    useSandboxStore.setState({
      activeSessionId: 'sb-4',
      browserFrame: 'data:image/jpeg;base64,frame',
      browserFrames: { 'sb-4': 'data:image/jpeg;base64,frame' },
      browserStartedSessions: new Set(['sb-4']),
      subscribedSessions: new Set(['sb-4']),
    });

    useSandboxStore.getState().unsubscribeBrowser('sb-4');

    expect(useSandboxStore.getState().browserStartedSessions.has('sb-4')).toBe(
      false,
    );
    expect(useSandboxStore.getState().subscribedSessions.has('sb-4')).toBe(
      false,
    );
    expect(useSandboxStore.getState().browserFrames['sb-4']).toBeUndefined();
    expect(useSandboxStore.getState().browserFrame).toBeNull();
    expect(send).toHaveBeenCalledWith({
      type: 'sandbox_browser_unsubscribe',
      sessionId: 'sb-4',
    });
  });

  it('falls back to REST stop when an unmounted view cannot use WebSocket', () => {
    vi.spyOn(wsManager, 'send').mockReturnValue(false);
    const stop = vi
      .spyOn(sandboxApi, 'browserStop')
      .mockResolvedValue({ ok: true });
    useSandboxStore.setState({
      browserStartedSessions: new Set(['sb-offline']),
      subscribedSessions: new Set(),
    });

    useSandboxStore.getState().unsubscribeBrowser('sb-offline');

    expect(
      useSandboxStore.getState().browserStartedSessions.has('sb-offline'),
    ).toBe(false);
    expect(stop).toHaveBeenCalledWith('sb-offline');
  });
});
