/**
 * Agent Workflow API client — user-scoped workflow CRUD + 编排 Agent 草稿生成.
 * Wraps /api/workflows/* (see src/routes/workflows.ts).
 */
import { api } from './client';

export interface WorkflowSummary {
  id: string;
  version: number;
  name: string;
  description: string | null;
  owner: string | null;
  nodeCount: number;
  createdAt: string;
}

export interface WorkflowDefinition {
  id: string;
  version: number;
  name: string;
  description?: string;
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
  stateSchema?: Record<string, unknown>[];
}

export interface SaveResult {
  ok: boolean;
  id: string;
  version: number;
  hash: string;
}

export interface AutobuildResult {
  ok: boolean;
  buildId: string;
  status: string;
}

export interface AutobuildStatus {
  status: 'running' | 'completed' | 'failed';
  definitionId?: string;
  plan?: unknown;
  error?: string;
}

export const workflowsApi = {
  list: () => api.get<{ workflows: WorkflowSummary[] }>('/api/workflows'),
  get: (id: string) => api.get<{ definition: WorkflowDefinition; mermaid: string }>(`/api/workflows/${id}`),
  create: (body: { name: string; description?: string; nodes: unknown[]; edges: unknown[]; stateSchema?: unknown[]; id?: string }) =>
    api.post<SaveResult>('/api/workflows', body),
  update: (id: string, body: { name: string; description?: string; nodes: unknown[]; edges: unknown[]; stateSchema?: unknown[] }) =>
    api.put<SaveResult>(`/api/workflows/${id}`, body),
  autobuild: (body: {
    goalText: string;
    background?: string;
    acceptanceCriteria?: string;
    groupFolder: string;
    chatJid: string;
    maxTeamSize?: number;
    toolset?: string[];
    executionMode?: 'auto' | 'semi-auto';
  }) => api.post<AutobuildResult>('/api/workflows/autobuild', body, 15000),
  pollAutobuild: (buildId: string) => api.get<AutobuildStatus>(`/api/workflows/autobuild/${buildId}`),
};
