/**
 * Collaboration store. Mirrors the team store's async pattern: POST
 * /api/collaborations/runs immediately returns collabId, buildCollaboration
 * (mode-aware buildTeam + shared-artifact persistence) runs detached; we poll
 * GET /api/collaborations/runs/:id for the terminal state (completed →
 * runId+plan / failed → error). On completion, TeamPage-style execution view
 * takes over (GraphDagView polling).
 */
import { create } from 'zustand';
import { apiFetch } from '../api/client';

export type CollaborationMode = 'orchestrator-worker' | 'peer' | 'critic-adversarial';

export interface CollaborationMember {
  name: string;
  role: string;
  systemPrompt?: string;
  engine?: string;
  skills?: string[];
  mcpServers?: string[];
  maxTurns?: number;
  deliverable?: string;
}

export interface CollaborationPlan {
  teamName: string;
  members: CollaborationMember[];
  graph: {
    nodes: Array<{
      id: string;
      type: string;
      title: string;
      dependsOn?: string[];
      agentMember?: string;
    }>;
  };
  acceptanceCriteria?: string;
}

export interface CollaborationSummary {
  id: string;
  teamName: string | null;
  goalText: string;
  mode: CollaborationMode;
  scenario: string | null;
  status: 'running' | 'completed' | 'failed';
  runId: string | null;
  createdAt: number;
}

interface CollaborationState {
  building: boolean;
  error: string | null;
  lastRunId: string | null;
  lastPlan: CollaborationPlan | null;
  lastMode: CollaborationMode | null;
  lastCollabId: string | null;
  history: CollaborationSummary[];
  historyLoading: boolean;
  buildCollaboration: (input: {
    goalText: string;
    background?: string;
    acceptanceCriteria?: string;
    mode: CollaborationMode;
    scenario?: string;
    groupFolder: string;
    chatJid: string;
    userLanguage?: string;
    maxTeamSize?: number;
    toolset?: string[];
    executionMode?: 'auto' | 'semi-auto';
  }) => Promise<{ runId: string; collabId: string; plan: CollaborationPlan } | null>;
  reset: () => void;
  loadHistory: () => Promise<void>;
  openHistory: (collabId: string) => Promise<void>;
}

let pollToken = 0;
const POLL_INTERVAL_MS = 2000;

async function pollBuild(
  token: number,
  collabId: string,
  onCompleted: (runId: string, plan: CollaborationPlan, mode: string) => void,
  onFailed: (error: string) => void,
): Promise<void> {
  for (;;) {
    if (token !== pollToken) return;
    let res: {
      status?: string;
      runId?: string;
      plan?: CollaborationPlan;
      mode?: string;
      error?: string;
    };
    try {
      res = await apiFetch<{
        status?: string;
        runId?: string;
        plan?: CollaborationPlan;
        mode?: string;
        error?: string;
      }>(`/api/collaborations/runs/${encodeURIComponent(collabId)}`);
    } catch {
      res = { status: 'running' };
    }
    if (token !== pollToken) return;
    if (res.status === 'completed' && res.runId && res.plan) {
      onCompleted(res.runId, res.plan, res.mode ?? 'orchestrator-worker');
      return;
    }
    if (res.status === 'failed') {
      onFailed(res.error ?? 'build failed');
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

export const useCollaborationStore = create<CollaborationState>((set) => ({
  building: false,
  error: null,
  lastRunId: null,
  lastPlan: null,
  lastMode: null,
  lastCollabId: null,
  history: [],
  historyLoading: false,

  buildCollaboration: async (input) => {
    set({ building: true, error: null, lastRunId: null, lastPlan: null, lastMode: input.mode, lastCollabId: null });
    const token = ++pollToken;

    let collabId: string;
    try {
      const data = await apiFetch<{ ok?: boolean; collabId?: string; status?: string; error?: string }>(
        '/api/collaborations/runs',
        { method: 'POST', body: JSON.stringify(input) },
      );
      if (!data.ok || !data.collabId) {
        set({ building: false, error: data.error ?? 'build failed' });
        return null;
      }
      collabId = data.collabId;
    } catch (err) {
      set({ building: false, error: (err as Error).message });
      return null;
    }
    if (token !== pollToken) return null;

    return new Promise<{ runId: string; collabId: string; plan: CollaborationPlan } | null>(
      (resolve) => {
        pollBuild(
          token,
          collabId,
          (runId, plan, mode) => {
            if (token !== pollToken) {
              resolve(null);
              return;
            }
            set({
              building: false,
              lastRunId: runId,
              lastPlan: plan,
              lastMode: mode as CollaborationMode,
              lastCollabId: collabId,
            });
            resolve({ runId, collabId, plan });
          },
          (error) => {
            if (token !== pollToken) {
              resolve(null);
              return;
            }
            set({ building: false, error });
            resolve(null);
          },
        );
      },
    );
  },

  reset: () => {
    pollToken++;
    set({ building: false, error: null, lastRunId: null, lastPlan: null, lastMode: null, lastCollabId: null });
  },

  loadHistory: async () => {
    set({ historyLoading: true });
    try {
      const data = await apiFetch<{ runs: CollaborationSummary[] }>(
        '/api/collaborations/runs',
      );
      set({ history: data.runs ?? [], historyLoading: false });
    } catch {
      set({ historyLoading: false });
    }
  },

  openHistory: async (collabId) => {
    set({ error: null });
    try {
      const data = await apiFetch<{
        status?: string;
        runId?: string;
        plan?: CollaborationPlan;
        mode?: string;
        error?: string;
      }>(`/api/collaborations/runs/${encodeURIComponent(collabId)}`);
      if (data.status === 'completed' && data.runId && data.plan) {
        set({
          lastRunId: data.runId,
          lastPlan: data.plan,
          lastMode: (data.mode ?? 'orchestrator-worker') as CollaborationMode,
          lastCollabId: collabId,
          building: false,
        });
      } else if (data.status === 'failed') {
        set({ error: data.error ?? '该历史协作组建失败' });
      } else {
        set({ error: '该历史协作仍在组建中' });
      }
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },
}));
