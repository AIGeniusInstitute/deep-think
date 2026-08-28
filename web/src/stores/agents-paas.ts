import { create } from 'zustand';
import { api } from '../api/client';

export type ResourceType = 'mcp_server' | 'skill' | 'knowledge_base';

export interface AgentMount {
  id: string;
  agentDefId: string;
  resourceType: ResourceType;
  resourceId: string;
}

export type AgentKind = 'assistant' | 'orchestrator';

export interface AgentDefinition {
  id: string;
  userId: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: string | null;
  engine: 'claude' | 'atomcode';
  avatarEmoji: string | null;
  avatarColor: string | null;
  maxTurns: number | null;
  temperature: number | null;
  enabled: boolean;
  kind: AgentKind;
  createdAt: string;
  updatedAt: string;
  mounts?: AgentMount[];
}

export interface AgentVersion {
  id: string;
  version: number;
  created_at: string;
  created_by: string;
}

export interface AgentShare {
  id: string;
  shareToken: string;
  shareUrl: string;
  createdAt: string;
  expiresAt: string | null;
  installCount: number;
}

export interface AgentCollaborator {
  userId: string;
  username: string;
  role: 'editor' | 'viewer';
  addedBy: string;
  addedAt: string;
}

export interface AgentVersionDiff {
  versionId: string;
  fields: Array<{ name: string; before: string; after: string; same: boolean }>;
  promptDiff: Array<{ op: '+' | '-' | '='; line: string }>;
  promptSame: boolean;
}

export interface OrchestrateResult {
  ok: true;
  runId: string;
  definitionId: string;
  plan: {
    planName: string;
    steps: Array<{ id: string; title: string; workerId: string; task: string; dependsOn: string[] }>;
    acceptanceCriteria: string;
  };
}

export interface AvailableResource {
  mcp_servers: Array<{ id: string; name: string; type: string; enabled: boolean }>;
  knowledge_bases: Array<{ id: string; name: string; doc_count: number }>;
  skills: Array<{ id: string; name: string; description: string }>;
}

export type AgentEngine = 'claude' | 'atomcode' | 'codex' | 'opencode' | 'pi';

export interface GeneratedAgentFields {
  name: string;
  description: string;
  system_prompt: string;
  model: string | null;
  engine: AgentEngine;
  max_turns: number | null;
  temperature: number | null;
}

export interface OptimizedAgentPreview {
  optimized_description: string;
  optimized_system_prompt: string;
  original_description: string;
  original_system_prompt: string;
}

interface AgentsState {
  list: AgentDefinition[];
  quota: number;
  used: number;
  loading: boolean;
  error: string | null;
  available: AvailableResource | null;
  versions: Record<string, AgentVersion[]>;
  shares: Record<string, AgentShare[]>;
  collaborators: Record<string, AgentCollaborator[]>;
  load: () => Promise<void>;
  loadAvailable: () => Promise<void>;
  create: (data: {
    name: string;
    description?: string;
    system_prompt?: string;
    model?: string | null;
    engine?: 'claude' | 'atomcode';
    avatar_emoji?: string | null;
    avatar_color?: string | null;
    max_turns?: number | null;
    temperature?: number | null;
    enabled?: boolean;
    kind?: AgentKind;
  }) => Promise<AgentDefinition | null>;
  update: (id: string, patch: Record<string, unknown>) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  addMount: (agentId: string, resourceType: ResourceType, resourceId: string) => Promise<boolean>;
  removeMount: (agentId: string, mountId: string) => Promise<boolean>;
  listVersions: (agentId: string) => Promise<AgentVersion[]>;
  restoreVersion: (agentId: string, versionId: string) => Promise<boolean>;
  diffVersion: (agentId: string, versionId: string) => Promise<AgentVersionDiff | null>;
  createShare: (agentId: string) => Promise<AgentShare | null>;
  listShares: (agentId: string) => Promise<AgentShare[]>;
  deleteShare: (agentId: string, shareId: string) => Promise<boolean>;
  listCollaborators: (agentId: string) => Promise<AgentCollaborator[]>;
  addCollaborator: (agentId: string, userId: string, role: 'editor' | 'viewer') => Promise<boolean>;
  removeCollaborator: (agentId: string, userId: string) => Promise<boolean>;
  testChat: (agentId: string) => Promise<{ jid: string; folder: string; name: string } | null>;
  listWorkers: (agentId: string) => Promise<AgentDefinition[]>;
  setWorkers: (agentId: string, workerIds: string[]) => Promise<AgentDefinition[]>;
  orchestrate: (
    agentId: string,
    input: { task: string; background?: string; acceptanceCriteria?: string },
  ) => Promise<OrchestrateResult | { error: string; detail?: string } | null>;
  generateAgent: (data: { name?: string; description: string }) => Promise<GeneratedAgentFields | null>;
  optimizeAgent: (agentId: string, feedback?: string) => Promise<OptimizedAgentPreview | null>;
  applyOptimizedAgent: (
    agentId: string,
    patch: { description?: string; system_prompt?: string },
  ) => Promise<boolean>;
}

export const useAgentsPaasStore = create<AgentsState>((set, get) => ({
  list: [],
  quota: 10,
  used: 0,
  loading: false,
  error: null,
  available: null,
  versions: {},
  shares: {},
  collaborators: {},
  load: async () => {
    set({ loading: true, error: null });
    try {
      const res = await api.get<{ agents: AgentDefinition[]; quota: number; used: number }>('/api/paas/agents');
      set({ list: res.agents ?? [], quota: res.quota, used: res.used, loading: false });
    } catch (e: any) {
      set({ loading: false, error: e?.message ?? 'Load failed' });
    }
  },
  loadAvailable: async () => {
    const res = await api.get<AvailableResource>('/api/paas/agents/resources/available');
    set({ available: res });
  },
  create: async (data) => {
    try {
      const res = await api.post<{ agent: AgentDefinition }>('/api/paas/agents', data);
      await get().load();
      return res.agent;
    } catch {
      return null;
    }
  },
  update: async (id, patch) => {
    try {
      await api.patch(`/api/paas/agents/${id}`, patch);
      await get().load();
      return true;
    } catch {
      return false;
    }
  },
  remove: async (id) => {
    try {
      await api.delete(`/api/paas/agents/${id}`);
      await get().load();
      return true;
    } catch {
      return false;
    }
  },
  addMount: async (agentId, resourceType, resourceId) => {
    try {
      await api.post(`/api/paas/agents/${agentId}/mounts`, { resource_type: resourceType, resource_id: resourceId });
      await get().load();
      return true;
    } catch {
      return false;
    }
  },
  removeMount: async (agentId, mountId) => {
    try {
      await api.delete(`/api/paas/agents/${agentId}/mounts/${mountId}`);
      await get().load();
      return true;
    } catch {
      return false;
    }
  },
  listVersions: async (agentId) => {
    try {
      const res = await api.get<{ versions: AgentVersion[] }>(`/api/paas/agents/${agentId}/versions`);
      set({ versions: { ...get().versions, [agentId]: res.versions ?? [] } });
      return res.versions ?? [];
    } catch {
      return [];
    }
  },
  restoreVersion: async (agentId, versionId) => {
    try {
      await api.post(`/api/paas/agents/${agentId}/versions/${versionId}/restore`);
      await get().load();
      await get().listVersions(agentId);
      return true;
    } catch {
      return false;
    }
  },
  diffVersion: async (agentId, versionId) => {
    try {
      const res = await api.get<AgentVersionDiff>(`/api/paas/agents/${agentId}/versions/${versionId}/diff`);
      return res;
    } catch {
      return null;
    }
  },
  createShare: async (agentId) => {
    try {
      const res = await api.post<AgentShare>(`/api/paas/agents/${agentId}/share`);
      await get().listShares(agentId);
      return res;
    } catch {
      return null;
    }
  },
  listShares: async (agentId) => {
    try {
      const res = await api.get<{ shares: AgentShare[] }>(`/api/paas/agents/${agentId}/shares`);
      const shares = res.shares ?? [];
      set({ shares: { ...get().shares, [agentId]: shares } });
      return shares;
    } catch {
      return [];
    }
  },
  deleteShare: async (agentId, shareId) => {
    try {
      await api.delete(`/api/paas/agents/${agentId}/shares/${shareId}`);
      await get().listShares(agentId);
      return true;
    } catch {
      return false;
    }
  },
  listCollaborators: async (agentId) => {
    try {
      const res = await api.get<{ collaborators: AgentCollaborator[] }>(`/api/paas/agents/${agentId}/collaborators`);
      const collabs = res.collaborators ?? [];
      set({ collaborators: { ...get().collaborators, [agentId]: collabs } });
      return collabs;
    } catch {
      return [];
    }
  },
  addCollaborator: async (agentId, userId, role) => {
    try {
      await api.post(`/api/paas/agents/${agentId}/collaborators`, { userId, role });
      await get().listCollaborators(agentId);
      return true;
    } catch {
      return false;
    }
  },
  removeCollaborator: async (agentId, userId) => {
    try {
      await api.delete(`/api/paas/agents/${agentId}/collaborators/${userId}`);
      await get().listCollaborators(agentId);
      return true;
    } catch {
      return false;
    }
  },
  testChat: async (agentId) => {
    try {
      const res = await api.post<{ jid: string; folder: string; name: string }>(
        `/api/paas/agents/${agentId}/test-chat`,
      );
      return res;
    } catch {
      return null;
    }
  },
  listWorkers: async (agentId) => {
    try {
      const res = await api.get<{ workers: AgentDefinition[] }>(`/api/paas/agents/${agentId}/workers`);
      return res.workers ?? [];
    } catch {
      return [];
    }
  },
  setWorkers: async (agentId, workerIds) => {
    const res = await api.put<{ workers: AgentDefinition[] }>(`/api/paas/agents/${agentId}/workers`, {
      workerIds,
    });
    return res.workers ?? [];
  },
  orchestrate: async (agentId, input) => {
    try {
      const res = await api.post<OrchestrateResult>(`/api/paas/agents/${agentId}/orchestrate`, input);
      return res;
    } catch (e: any) {
      const body = e?.body as { error?: string; detail?: string } | undefined;
      if (body?.error) return { error: body.error, detail: body.detail };
      return { error: e?.message ?? '编排启动失败' };
    }
  },
  generateAgent: async (data) => {
    try {
      const res = await api.post<{ fields: GeneratedAgentFields }>('/api/paas/agents/generate', data);
      return res.fields ?? null;
    } catch {
      return null;
    }
  },
  optimizeAgent: async (agentId, feedback) => {
    try {
      const res = await api.post<OptimizedAgentPreview>(
        `/api/paas/agents/${agentId}/optimize`,
        feedback ? { feedback } : {},
      );
      return res;
    } catch {
      return null;
    }
  },
  applyOptimizedAgent: async (agentId, patch) => {
    try {
      await api.post(`/api/paas/agents/${agentId}/optimize/apply`, patch);
      await get().load();
      return true;
    } catch {
      return false;
    }
  },
}));
