import { create } from 'zustand';
import { sandboxApi, type SandboxSession } from '../api/sandbox';
import { wsManager } from '../api/ws';

export interface AgentStep {
  runId: string;
  step: number;
  thought: string;
  action: { type: string; [k: string]: unknown };
  result: string;
  screenshot?: string;
}

interface SandboxStore {
  sessions: SandboxSession[];
  activeSessionId: string | null;
  browserFrame: string | null;
  browserFrames: Record<string, string>;
  browserStartedSessions: Set<string>;
  subscribedSessions: Set<string>;
  loading: boolean;
  error: string | null;
  // Browser Use Agent state, per session
  agentSteps: Record<string, AgentStep[]>;
  agentRunning: Record<string, boolean>;
  agentSummary: Record<string, string | null>;

  loadSessions: () => Promise<void>;
  create: (opts: { language?: 'python' | 'node' | 'sh'; browserEnabled?: boolean }) => Promise<SandboxSession | null>;
  destroy: (id: string) => Promise<void>;
  setActive: (id: string | null) => void;
  sendTerminalInput: (sessionId: string, data: string) => void;
  startTerminal: (sessionId: string, cols: number, rows: number) => void;
  stopTerminal: (sessionId: string) => void;
  resizeTerminal: (sessionId: string, cols: number, rows: number) => void;
  startBrowser: (sessionId: string, url?: string) => Promise<boolean>;
  subscribeBrowser: (sessionId: string, url?: string) => boolean;
  unsubscribeBrowser: (sessionId: string) => void;
  setBrowserStarted: (sessionId: string, started: boolean) => void;
  setBrowserFrame: (dataUrl: string | null) => void;
  setBrowserFrameForSession: (sessionId: string, dataUrl: string) => void;
  getBrowserFrame: (sessionId: string) => string | null;
  isSubscribed: (sessionId: string) => boolean;
  focusSession: (sessionId: string) => void;
  clearAgent: (sessionId: string) => void;
  wireWsHandlers: () => (() => void) | void;
}

export const useSandboxStore = create<SandboxStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  browserFrame: null,
  browserFrames: {},
  browserStartedSessions: new Set<string>(),
  subscribedSessions: new Set<string>(),
  loading: false,
  error: null,
  agentSteps: {},
  agentRunning: {},
  agentSummary: {},

  loadSessions: async () => {
    set({ loading: true, error: null });
    try {
      const r = await sandboxApi.listSessions();
      set({ sessions: r.sessions, loading: false });
    } catch (e: any) {
      set({ loading: false, error: e?.message ?? '加载失败' });
    }
  },

  create: async (opts) => {
    try {
      const s = await sandboxApi.createSession(opts);
      set((st) => ({ sessions: [s, ...st.sessions], activeSessionId: s.id, browserFrame: null }));
      return s;
    } catch (e: any) {
      set({ error: e?.message ?? '创建失败' });
      return null;
    }
  },

  destroy: async (id) => {
    try {
      await sandboxApi.destroySession(id);
      set((st) => {
        const sessions = st.sessions.filter((s) => s.id !== id);
        const activeSessionId = st.activeSessionId === id ? null : st.activeSessionId;
        const browserFrames = { ...st.browserFrames };
        delete browserFrames[id];
        const browserStartedSessions = new Set(st.browserStartedSessions);
        browserStartedSessions.delete(id);
        const subscribedSessions = new Set(st.subscribedSessions);
        subscribedSessions.delete(id);
        return {
          sessions,
          activeSessionId,
          browserFrames,
          browserStartedSessions,
          subscribedSessions,
          browserFrame: activeSessionId === st.activeSessionId ? st.browserFrame : null,
        };
      });
    } catch (e: any) {
      set({ error: e?.message ?? '销毁失败' });
    }
  },

  setActive: (id) => set((st) => ({
    activeSessionId: id,
    browserFrame: id ? (st.browserFrames[id] ?? null) : null,
  })),

  sendTerminalInput: (sessionId, data) => {
    wsManager.send({ type: 'sandbox_terminal_input', sessionId, data });
  },

  startTerminal: (sessionId, cols, rows) => {
    wsManager.send({ type: 'sandbox_terminal_start', sessionId, cols, rows });
  },

  stopTerminal: (sessionId) => {
    wsManager.send({ type: 'sandbox_terminal_stop', sessionId });
  },
  resizeTerminal: (sessionId, cols, rows) => {
    wsManager.send({ type: 'sandbox_terminal_resize', sessionId, cols, rows });
  },

  startBrowser: async (sessionId, url) => {
    const result = await sandboxApi.browserStart(sessionId, url);
    if (result.started) {
      get().setBrowserStarted(sessionId, true);
      get().subscribeBrowser(sessionId);
    }
    return result.started;
  },

  subscribeBrowser: (sessionId, url) => {
    if (get().isSubscribed(sessionId)) return true;
    const sent = wsManager.send({
      type: 'sandbox_browser_subscribe',
      sessionId,
      ...(url ? { url } : {}),
    });
    if (!sent) return false;
    set((st) => {
      const subscribedSessions = new Set(st.subscribedSessions);
      subscribedSessions.add(sessionId);
      return { subscribedSessions, browserFrame: null };
    });
    return true;
  },

  unsubscribeBrowser: (sessionId) => {
    const shouldStop = get().isSubscribed(sessionId)
      || get().browserStartedSessions.has(sessionId);
    if (!shouldStop) return;
    set((st) => {
      const subscribedSessions = new Set(st.subscribedSessions);
      subscribedSessions.delete(sessionId);
      const browserStartedSessions = new Set(st.browserStartedSessions);
      browserStartedSessions.delete(sessionId);
      const browserFrames = { ...st.browserFrames };
      delete browserFrames[sessionId];
      return {
        subscribedSessions,
        browserStartedSessions,
        browserFrames,
        browserFrame: st.activeSessionId === sessionId ? null : st.browserFrame,
      };
    });
    if (!wsManager.send({ type: 'sandbox_browser_unsubscribe', sessionId })) {
      void sandboxApi.browserStop(sessionId).catch(() => {});
    }
  },

  setBrowserStarted: (sessionId, started) => set((st) => {
    const browserStartedSessions = new Set(st.browserStartedSessions);
    if (started) {
      browserStartedSessions.add(sessionId);
      return { browserStartedSessions };
    }

    browserStartedSessions.delete(sessionId);
    const subscribedSessions = new Set(st.subscribedSessions);
    subscribedSessions.delete(sessionId);
    const browserFrames = { ...st.browserFrames };
    delete browserFrames[sessionId];
    return {
      browserStartedSessions,
      subscribedSessions,
      browserFrames,
      browserFrame: st.activeSessionId === sessionId ? null : st.browserFrame,
    };
  }),

  setBrowserFrame: (dataUrl) => set({ browserFrame: dataUrl }),

  setBrowserFrameForSession: (sessionId, dataUrl) => set((st) => ({
    browserFrames: { ...st.browserFrames, [sessionId]: dataUrl },
    // Mirror to single browserFrame when this is the active session (for SandboxPage compatibility)
    browserFrame: st.activeSessionId === sessionId ? dataUrl : st.browserFrame,
  })),

  getBrowserFrame: (sessionId) => get().browserFrames[sessionId] ?? null,

  isSubscribed: (sessionId) => get().subscribedSessions.has(sessionId),

  focusSession: (sessionId) => set((st) => ({
    activeSessionId: sessionId,
    browserFrame: st.browserFrames[sessionId] ?? null,
  })),

  clearAgent: (sessionId) => set((st) => ({
    agentSteps: { ...st.agentSteps, [sessionId]: [] },
    agentSummary: { ...st.agentSummary, [sessionId]: null },
    agentRunning: { ...st.agentRunning, [sessionId]: false },
  })),

  wireWsHandlers: () => {
    const offs: Array<(() => void) | undefined> = [];
    offs.push(wsManager.on('connected', () => {
      const state = get();
      for (const sessionId of state.browserStartedSessions) {
        state.subscribeBrowser(sessionId);
      }
    }));
    offs.push(wsManager.on('disconnected', () => {
      set({ subscribedSessions: new Set<string>() });
    }));
    offs.push(wsManager.on('sandbox_browser_frame', (data) => {
      const sid = data?.sessionId;
      if (!sid) return;
      // Always store in the per-session index
      get().setBrowserFrameForSession(sid, data.dataUrl);
      // Backward-compat: if this is the active session, mirror to browserFrame
      if (sid === get().activeSessionId) {
        get().setBrowserFrame(data.dataUrl);
      }
    }));
    offs.push(wsManager.on('sandbox_browser_started', (data) => {
      if (data?.sessionId) get().setBrowserStarted(data.sessionId, true);
    }));
    offs.push(wsManager.on('sandbox_browser_stopped', (data) => {
      if (data?.sessionId) get().setBrowserStarted(data.sessionId, false);
    }));
    offs.push(wsManager.on('sandbox_status', (data) => {
      if (data?.sessionId) {
        set((st) => ({
          sessions: st.sessions.map((s) =>
            s.id === data.sessionId ? { ...s, status: data.status } : s,
          ),
        }));
      }
    }));
    offs.push(wsManager.on('sandbox_error', (data) => {
      console.error('[sandbox]', data?.error);
    }));
    offs.push(wsManager.on('sandbox_browser_agent_step', (data) => {
      const sid = data?.sessionId;
      if (!sid) return;
      const step: AgentStep = {
        runId: data.runId,
        step: data.step,
        thought: data.thought ?? '',
        action: data.action ?? { type: 'unknown' },
        result: data.result ?? '',
        screenshot: data.screenshot,
      };
      set((st) => ({
        agentSteps: { ...st.agentSteps, [sid]: [...(st.agentSteps[sid] ?? []), step] },
        agentRunning: { ...st.agentRunning, [sid]: true },
      }));
    }));
    offs.push(wsManager.on('sandbox_browser_agent_done', (data) => {
      const sid = data?.sessionId;
      if (!sid) return;
      set((st) => ({
        agentRunning: { ...st.agentRunning, [sid]: false },
        agentSummary: {
          ...st.agentSummary,
          [sid]: `[${data.status}] ${data.summary ?? ''}`,
        },
      }));
    }));
    return () => offs.forEach((off) => off?.());
  },
}));
