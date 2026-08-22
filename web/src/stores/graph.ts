/**
 * Graph Engineering store — mirrors stores/loops.ts.
 *
 * C7: subscribes to graph_* WebSocket events (graph_node_start /
 * node_status / node_end / edge_taken / graph_start / graph_end) for <2s
 * incremental canvas updates, with 5s polling as reconciliation fallback.
 * DB remains the source of truth — WS events upsert an in-memory overlay
 * that is reconciled on each poll + on graph_end (final authoritative load).
 */
import { create } from 'zustand';
import { apiFetch } from '../api/client';
import { wsManager } from '../api/ws';
import type { StreamEvent } from '../stream-event.types';

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
  node_type:
    | 'agent' | 'gate' | 'branch' | 'join' | 'human'
    | 'llm' | 'tool' | 'start' | 'end' | 'parallel' | 'aggregate';
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

/** A data/control edge traversed during execution (from graph_edge_taken
 *  events). Used by the DAG canvas to animate live data flow. */
export interface GraphTakenEdge {
  from: string;
  to: string;
  label?: string;
}

/** Frontend projection of a registered GraphDefinition (structure only —
 *  node statuses come from GraphNodeRun / timeline). */
export interface GraphDefNode {
  id: string;
  type: string;
  title: string;
}
export interface GraphDefEdge {
  id: string;
  from: string;
  to: string;
  condition?: string;
  expression?: string;
  isDefault?: boolean;
}
export interface GraphDefinition {
  id: string;
  name: string;
  nodes: GraphDefNode[];
  edges: GraphDefEdge[];
}

/** Timeline entry from GET /api/graph/runs/:id/timeline (history replay). */
export interface GraphTimelineItem {
  nodeId: string;
  nodeType: string;
  title: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  tokens: number;
  costUsd: number;
  error: string | null;
}

interface GraphState {
  runs: GraphRun[];
  loading: boolean;
  error: string | null;
  currentRun: GraphRun | null;
  currentNodeRuns: GraphNodeRun[];
  takenEdges: GraphTakenEdge[];
  definition: GraphDefinition | null;
  timeline: GraphTimelineItem[];
  pollingTimer: ReturnType<typeof setInterval> | null;
  wsCleanup: (() => void) | null;
  selectedNodeId: string | null;
  fetchRuns: () => Promise<void>;
  loadRun: (id: string) => Promise<void>;
  loadDefinition: (defId: string) => Promise<void>;
  loadTimeline: (runId: string) => Promise<void>;
  startPolling: (id: string, intervalMs?: number) => void;
  stopPolling: () => void;
  /** Subscribe to graph_* WS events for a run (low-latency overlay). */
  subscribeGraphEvents: (runId: string) => void;
  unsubscribeGraphEvents: () => void;
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
  /** DSL v2 auto-planner: task → registered definition (+optional autorun). */
  plan: (opts: {
    task: string;
    background?: string;
    acceptanceCriteria?: string;
    template?: string;
    groupFolder: string;
    chatJid: string;
    autorun?: boolean;
    maxParallel?: number;
    initialState?: Record<string, unknown>;
  }) => Promise<{
    definitionId: string;
    version: number;
    source: string;
    warnings: string[];
    runId?: string;
  } | null>;
}

export const useGraphStore = create<GraphState>((set, get) => ({
  runs: [],
  loading: false,
  error: null,
  currentRun: null,
  currentNodeRuns: [],
  takenEdges: [],
  definition: null,
  timeline: [],
  pollingTimer: null,
  wsCleanup: null,
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

  loadDefinition: async (defId) => {
    try {
      const data = await apiFetch<{ definition: GraphDefinition }>(
        `/api/graph/definitions/${defId}`,
      );
      set({ definition: data.definition ?? null });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  loadTimeline: async (runId) => {
    try {
      const data = await apiFetch<{ timeline: GraphTimelineItem[] }>(
        `/api/graph/runs/${runId}/timeline`,
      );
      set({ timeline: data.timeline ?? [] });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  startPolling: (id, intervalMs) => {
    const { stopPolling, loadRun } = get();
    stopPolling();
    set({ takenEdges: [] }); // reset edge overlay on run switch
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

  /**
   * Subscribe to graph_* WS events for one run. Upserts node entries
   * incrementally (so the canvas reflects a node the moment it starts,
   * not 5s later) and records taken edges for live data-flow animation.
   * Falls back to polling for authoritative reconciliation — DB is truth.
   */
  subscribeGraphEvents: (runId) => {
    get().unsubscribeGraphEvents();
    if (!wsManager.isConnected()) wsManager.connect();

    const matchRun = (e: StreamEvent) =>
      e.graphEvent?.runId === runId || (e as any).runId === runId;

    const upsert = (patch: {
      node_id: string;
      node_type?: string;
      title?: string;
      status?: string;
      tokens?: number;
      costUsd?: number;
      error?: string;
      output?: string;
    }) => {
      const list = get().currentNodeRuns;
      const idx = list.findIndex((n) => n.node_id === patch.node_id);
      const nowIso = new Date().toISOString();
      const base: GraphNodeRun = idx >= 0 ? list[idx] : {
        id: `${runId}-${patch.node_id}`,
        graph_run_id: runId,
        node_id: patch.node_id,
        node_type: (patch.node_type as GraphNodeRun['node_type']) ?? 'agent',
        status: 'pending',
        attempt: 1,
        input_summary: null,
        output_summary: null,
        parent_node_run_id: null,
        started_at: null,
        ended_at: null,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        error: null,
        is_idempotent: 0,
      };
      const merged: GraphNodeRun = {
        ...base,
        ...(patch.node_type ? { node_type: patch.node_type as GraphNodeRun['node_type'] } : {}),
        ...(patch.status ? { status: patch.status as GraphNodeRun['status'] } : {}),
        ...(patch.tokens != null ? { output_tokens: patch.tokens } : {}),
        ...(patch.costUsd != null ? { cost_usd: patch.costUsd } : {}),
        ...(patch.error != null ? { error: patch.error } : {}),
        ...(patch.output != null ? { output_summary: patch.output } : {}),
      };
      if (merged.status === 'running' && !merged.started_at) merged.started_at = nowIso;
      if (merged.status === 'completed' || merged.status === 'failed') merged.ended_at = nowIso;
      const next = [...list];
      if (idx >= 0) next[idx] = merged;
      else next.push(merged);
      set({ currentNodeRuns: next });
    };

    const offs: Array<() => void> = [];
    offs.push(wsManager.on('graph_node_start', (e: StreamEvent) => {
      if (!matchRun(e) || !e.graphEvent) return;
      upsert({
        node_id: e.graphEvent.nodeId!,
        node_type: e.graphEvent.nodeType,
        title: e.graphEvent.title,
        status: 'running',
      });
    }));
    offs.push(wsManager.on('graph_node_status', (e: StreamEvent) => {
      if (!matchRun(e) || !e.graphEvent?.nodeId || !e.graphEvent.status) return;
      upsert({ node_id: e.graphEvent.nodeId, status: e.graphEvent.status });
    }));
    offs.push(wsManager.on('graph_node_end', (e: StreamEvent) => {
      if (!matchRun(e) || !e.graphEvent?.nodeId) return;
      upsert({
        node_id: e.graphEvent.nodeId,
        status: e.graphEvent.status,
        tokens: e.graphEvent.tokens,
        costUsd: e.graphEvent.costUsd,
        output: e.graphEvent.output,
        error: e.graphEvent.error,
      });
    }));
    offs.push(wsManager.on('graph_edge_taken', (e: StreamEvent) => {
      if (!matchRun(e) || !e.graphEvent) return;
      const edge = {
        from: e.graphEvent.fromNodeId!,
        to: e.graphEvent.toNodeId!,
        label: e.graphEvent.edgeLabel,
      };
      const cur = get().takenEdges;
      const exists = cur.some((x) => x.from === edge.from && x.to === edge.to);
      if (!exists) set({ takenEdges: [...cur, edge] });
    }));
    offs.push(wsManager.on('graph_start', (e: StreamEvent) => {
      if (!matchRun(e) || !e.graphEvent) return;
      const run = get().currentRun;
      if (run) set({ currentRun: { ...run, status: 'running' } });
    }));
    offs.push(wsManager.on('graph_end', (e: StreamEvent) => {
      if (!matchRun(e) || !e.graphEvent) return;
      // Authoritative terminal state lives in DB — fetch it once, then stop.
      void get().loadRun(runId);
      get().stopPolling();
    }));

    set({
      wsCleanup: () => {
        offs.forEach((off) => off());
        offs.length = 0;
      },
    });
  },

  unsubscribeGraphEvents: () => {
    const { wsCleanup } = get();
    if (wsCleanup) {
      wsCleanup();
      set({ wsCleanup: null });
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

  plan: async (opts) => {
    try {
      const data = await apiFetch<{
        ok: boolean;
        definitionId?: string;
        version?: number;
        source?: string;
        warnings?: string[];
        runId?: string;
        error?: string;
      }>('/api/graph/plan', {
        method: 'POST',
        body: JSON.stringify(opts),
      });
      if (!data.ok || !data.definitionId) {
        set({ error: data.error ?? 'plan failed' });
        return null;
      }
      return {
        definitionId: data.definitionId,
        version: data.version ?? 1,
        source: data.source ?? 'llm',
        warnings: data.warnings ?? [],
        runId: data.runId,
      };
    } catch (err) {
      set({ error: (err as Error).message });
      return null;
    }
  },
}));
