import { create } from 'zustand';
import { api } from '../api/client';

export type SideEffect = 'read' | 'write' | 'admin';

export interface RegistryHttpBinding {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  paramMapping?: {
    path?: Record<string, string>;
    query?: Record<string, string>;
    header?: Record<string, string>;
    body?: Record<string, string>;
  };
  bodyTemplate?: Record<string, unknown>;
  authHeader?: { name: string; value: string } | null;
  responseMapping?: {
    extract?: string;
    toText?: string;
    truncate?: number;
  };
  timeoutMs?: number;
}

export interface RegistryInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  description?: string;
  [k: string]: unknown;
}

export interface RegistryServer {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  tool_count: number;
  created_at: string;
  updated_at: string;
}

export interface RegistryTool {
  id: string;
  server_id: string;
  name: string;
  description: string;
  enabled: boolean;
  inputSchema: RegistryInputSchema;
  httpBinding: RegistryHttpBinding;
  sideEffect?: SideEffect;
  mcpName: string;
  created_at: string;
  updated_at: string;
}

export interface CandidateTool {
  name: string;
  description: string;
  inputSchema: RegistryInputSchema;
  httpBinding: RegistryHttpBinding;
  sideEffect?: SideEffect;
}

interface McpRegistryState {
  servers: RegistryServer[];
  tools: RegistryTool[]; // tools of currently selected server
  selectedServerId: string | null;
  loading: boolean;
  loadingTools: boolean;
  error: string | null;

  loadServers: () => Promise<void>;
  selectServer: (id: string | null) => Promise<void>;
  addServer: (input: { name: string; description?: string }) => Promise<void>;
  updateServer: (id: string, updates: Partial<RegistryServer>) => Promise<void>;
  deleteServer: (id: string) => Promise<void>;
  addTool: (serverId: string, tool: {
    name: string;
    description?: string;
    inputSchema: RegistryInputSchema;
    httpBinding: RegistryHttpBinding;
    enabled?: boolean;
  }) => Promise<void>;
  updateTool: (id: string, updates: Partial<RegistryTool>) => Promise<void>;
  deleteTool: (id: string) => Promise<void>;
  testTool: (id: string, args: Record<string, unknown>) => Promise<{ isError: boolean; content: { type: string; text: string }[] }>;
  previewOpenApi: (serverId: string, source: 'json' | 'url', content: string, includePaths?: string[], baseUrl?: string) => Promise<CandidateTool[]>;
  confirmImport: (serverId: string, tools: CandidateTool[]) => Promise<{ created: number; errors: { index: number; error: string }[] }>;
}

export const useMcpRegistryStore = create<McpRegistryState>((set, get) => ({
  servers: [],
  tools: [],
  selectedServerId: null,
  loading: false,
  loadingTools: false,
  error: null,

  loadServers: async () => {
    set({ loading: true, error: null });
    try {
      const data = await api.get<{ servers: RegistryServer[] }>('/api/mcp-registry/servers');
      set({ servers: data.servers, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  selectServer: async (id) => {
    set({ selectedServerId: id, tools: [], loadingTools: !!id, error: null });
    if (!id) return;
    try {
      const data = await api.get<{ tools: RegistryTool[] }>(`/api/mcp-registry/servers/${encodeURIComponent(id)}/tools`);
      set({ tools: data.tools, loadingTools: false });
    } catch (err) {
      set({ loadingTools: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  addServer: async (input) => {
    try {
      await api.post('/api/mcp-registry/servers', input);
      set({ error: null });
      await get().loadServers();
    } catch (err: any) {
      set({ error: err?.message || '创建失败' });
      throw err;
    }
  },

  updateServer: async (id, updates) => {
    try {
      await api.patch(`/api/mcp-registry/servers/${encodeURIComponent(id)}`, updates);
      set({ error: null });
      await get().loadServers();
      const sel = get().selectedServerId;
      if (sel === id) await get().selectServer(id);
    } catch (err: any) {
      set({ error: err?.message || '更新失败' });
      throw err;
    }
  },

  deleteServer: async (id) => {
    try {
      await api.delete(`/api/mcp-registry/servers/${encodeURIComponent(id)}`);
      set({ error: null });
      if (get().selectedServerId === id) get().selectServer(null);
      await get().loadServers();
    } catch (err: any) {
      set({ error: err?.message || '删除失败' });
      throw err;
    }
  },

  addTool: async (serverId, tool) => {
    try {
      await api.post(`/api/mcp-registry/servers/${encodeURIComponent(serverId)}/tools`, tool);
      set({ error: null });
      await get().selectServer(serverId);
      await get().loadServers();
    } catch (err: any) {
      set({ error: err?.message || '创建失败' });
      throw err;
    }
  },

  updateTool: async (id, updates) => {
    try {
      await api.patch(`/api/mcp-registry/tools/${encodeURIComponent(id)}`, updates);
      set({ error: null });
      const sel = get().selectedServerId;
      if (sel) await get().selectServer(sel);
    } catch (err: any) {
      set({ error: err?.message || '更新失败' });
      throw err;
    }
  },

  deleteTool: async (id) => {
    try {
      await api.delete(`/api/mcp-registry/tools/${encodeURIComponent(id)}`);
      set({ error: null });
      const sel = get().selectedServerId;
      if (sel) await get().selectServer(sel);
      await get().loadServers();
    } catch (err: any) {
      set({ error: err?.message || '删除失败' });
      throw err;
    }
  },

  testTool: async (id, args) => {
    const data = await api.post<{ isError: boolean; content: { type: string; text: string }[] }>(
      `/api/mcp-registry/tools/${encodeURIComponent(id)}/test`,
      { arguments: args },
      120000,
    );
    return data;
  },

  previewOpenApi: async (serverId, source, content, includePaths, baseUrl) => {
    const data = await api.post<{ tools: CandidateTool[] }>(
      '/api/mcp-registry/import-openapi/preview',
      { serverId, source, content, includePaths, baseUrl },
      30000,
    );
    return data.tools;
  },

  confirmImport: async (serverId, tools) => {
    const data = await api.post<{ created: number; errors: { index: number; error: string }[] }>(
      '/api/mcp-registry/import-openapi/confirm',
      { serverId, tools },
      60000,
    );
    set({ error: null });
    await get().selectServer(serverId);
    await get().loadServers();
    return data;
  },
}));
