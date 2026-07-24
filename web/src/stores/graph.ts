/**
 * Graph Engineering store — mirrors stores/loops.ts. P0 uses polling (5s,
 * same cadence as InlineLoopCard) instead of SSE/stream events (those are P1,
 * see PRD AC5.3).
 */
import { create } from 'zustand';
import { apiFetch } from '../api/client';

export interface GraphRun {
  id: string;
  definition_id: string;
  definition_version: number;
  owner_user_id: string;
  group_folder: string;
  chat_jid: string;
  goal_text: string | null;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  current_node_id: string | null;
  state_json: string;
  max_parallel: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  started_at: string;
  ended_at: string | null;
  cancel_reason: string | null;
}

export interface GraphNodeRun {
  id: string;
  graph_run_id: string;
  node_id: string;
  node_type: 'agent' | 'gate' | 'branch' | 'join' | 'human';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'paused';
  attempt: number;
  input_summary: string | null;
  output_summary: string | null;
  parent_node_run_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  error: string | null;
  is_idempotent: number;
}

interface GraphState {
  runs: GraphRun[];
  loading: boolean;
  error: string | null;
  currentRun: GraphRun | null;
  currentNodeRuns: GraphNodeRun[];
  pollingTimer: ReturnType<typeof setInterval> | null;
  selectedNodeId: string | null;
  fetchRuns: () => Promise<void>;
  loadRun: (id: string) => Promise<void>;
  startPolling: (id: string, intervalMs?: number) => void;
  stopPolling: () => void;
  setSelectedNode: (id: string | null) => void;
  startRun: (opts: {
    definitionId: string;
    groupFolder: string;
    chatJid: string;
    goalText?: string;
    maxParallel?: number;
    initialState?: Record<string, unknown>;
  }) => Promise<string | null>;
  resumeRun: (id: string) => Promise<boolean>;
  pauseRun: (id: string) => Promise<boolean>;
  cancelRun: (id: string) => Promise<boolean>;
  rerunNode: (id: string, nodeId: string) => Promise<boolean>;
  approveNode: (
    id: string,
    nodeId: string,
    payload: { optionId: string; note?: string },
  ) => Promise<boolean>;
}

export const useGraphStore = create<GraphState>((set, get) => ({
  runs: [],
  loading: false,
  error: null,
  currentRun: null,
  currentNodeRuns: [],
  pollingTimer: null,
  selectedNodeId: null,

  fetchRuns: async () => {
    set({ loading: true, error: null });
    try {
      const data = await apiFetch<{ runs: GraphRun[] }>('/api/graph/runs');
      set({ runs: data.runs ?? [], loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  loadRun: async (id) => {
    try {
      const data = await apiFetch<{ run: GraphRun; nodeRuns: GraphNodeRun[] }>(
        `/api/graph/runs/${id}`,
      );
      set({ currentRun: data.run, currentNodeRuns: data.nodeRuns ?? [] });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  startPolling: (id, intervalMs) => {
    const { stopPolling, loadRun } = get();
    stopPolling();
    void loadRun(id);
    const timer = setInterval(() => {
      // v2: stop polling once the run reaches a terminal state — avoids
      // infinite polling after completed/failed/cancelled (AC6 + trace回溯).
      const { currentRun } = get();
      if (
        currentRun &&
        (currentRun.status === 'completed' ||
          currentRun.status === 'failed' ||
          currentRun.status === 'cancelled')
      ) {
        get().stopPolling();
        return;
      }
      void loadRun(id);
    }, intervalMs ?? 5000);
    set({ pollingTimer: timer });
  },

  stopPolling: () => {
    const { pollingTimer } = get();
    if (pollingTimer) {
      clearInterval(pollingTimer);
      set({ pollingTimer: null });
    }
  },

  setSelectedNode: (id) => set({ selectedNodeId: id }),

  startRun: async (opts) => {
    try {
      const data = await apiFetch<{ ok: boolean; runId?: string; error?: string }>(
        '/api/graph/runs',
        {
          method: 'POST',
          body: JSON.stringify(opts),
        },
      );
      return data.runId ?? null;
    } catch (err) {
      set({ error: (err as Error).message });
      return null;
    }
  },

  resumeRun: async (id) => {
    try {
      await apiFetch(`/api/graph/runs/${id}/resume`, { method: 'POST' });
      return true;
    } catch (err) {
      set({ error: (err as Error).message });
      return false;
    }
  },

  pauseRun: async (id) => {
    try {
      await apiFetch(`/api/graph/runs/${id}/pause`, { method: 'POST' });
      return true;
    } catch {
      return false;
    }
  },

  cancelRun: async (id) => {
    try {
      await apiFetch(`/api/graph/runs/${id}/cancel`, { method: 'POST' });
      return true;
    } catch {
      return false;
    }
  },

  rerunNode: async (id, nodeId) => {
    try {
      await apiFetch(`/api/graph/runs/${id}/nodes/${nodeId}/rerun`, {
        method: 'POST',
      });
      return true;
    } catch {
      return false;
    }
  },

  approveNode: async (id, nodeId, payload) => {
    try {
      await apiFetch(`/api/graph/runs/${id}/nodes/${nodeId}/approve`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return true;
    } catch {
      return false;
    }
  },
}));
