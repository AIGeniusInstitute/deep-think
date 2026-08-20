/**
 * OPC（一人公司）store。仅做公司/目标的 CRUD——多智能体网络组建复用
 * useTeamStore.buildTeam（POST /api/team/runs），launch 编排在 OpcPage
 * 组件内完成（需同时访问 team store + groups store + opc store），保持本
 * store 单一职责，不耦合 team store。
 *
 * 后端契约见 src/routes/opc.ts：companies/objectives 经 owner_user_id 隔离，
 * 越权一律 404。domains/revenue_share/metrics 在后端序列化为 JSON 字符串，
 * API 层已还原为数组/对象。
 */
import { create } from 'zustand';
import { api } from '../api/client';

export type OpcScaleTier = 'solo' | 'small' | 'mid';
export type OpcCompanyStatus = 'active' | 'archived';
export type OpcObjectiveStatus = 'draft' | 'active' | 'running' | 'completed' | 'failed';

export interface RevenueSharePartner {
  name: string;
  ratio: number;
}

export interface OpcCompany {
  id: string;
  name: string;
  vision: string | null;
  commercial_goals: string | null;
  operating_strategy: string | null;
  scale_tier: OpcScaleTier;
  domains: string[];
  revenue_share: RevenueSharePartner[];
  status: OpcCompanyStatus;
  created_at: number;
  updated_at: number;
}

export interface OpcObjective {
  id: string;
  company_id: string;
  title: string;
  description: string | null;
  domain: string | null;
  acceptance_criteria: string | null;
  metrics: string[];
  status: OpcObjectiveStatus;
  team_build_id: string | null;
  run_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface OpcCompanyInput {
  name: string;
  vision?: string;
  commercial_goals?: string;
  operating_strategy?: string;
  scale_tier?: OpcScaleTier;
  domains?: string[];
  revenue_share?: RevenueSharePartner[];
  status?: OpcCompanyStatus;
}

export interface OpcObjectiveInput {
  title: string;
  description?: string;
  domain?: string;
  acceptance_criteria?: string;
  metrics?: string[];
}

interface OpcState {
  companies: OpcCompany[];
  companiesLoading: boolean;
  /** 当前选中公司的目标列表（按公司 id 缓存，避免来回切换时反复请求）。 */
  objectivesByCompany: Record<string, OpcObjective[]>;
  objectivesLoading: boolean;
  error: string | null;

  loadCompanies: () => Promise<void>;
  createCompany: (input: OpcCompanyInput) => Promise<OpcCompany | null>;
  updateCompany: (id: string, patch: Partial<OpcCompanyInput>) => Promise<OpcCompany | null>;
  deleteCompany: (id: string) => Promise<boolean>;

  loadObjectives: (companyId: string) => Promise<void>;
  createObjective: (companyId: string, input: OpcObjectiveInput) => Promise<OpcObjective | null>;
  updateObjective: (id: string, patch: Partial<OpcObjectiveInput & { status: OpcObjectiveStatus; team_build_id: string | null; run_id: string | null }>) => Promise<OpcObjective | null>;
  deleteObjective: (id: string, companyId: string) => Promise<boolean>;

  clearError: () => void;
}

export const useOpcStore = create<OpcState>((set, get) => ({
  companies: [],
  companiesLoading: false,
  objectivesByCompany: {},
  objectivesLoading: false,
  error: null,

  loadCompanies: async () => {
    set({ companiesLoading: true, error: null });
    try {
      const data = await api.get<{ companies: OpcCompany[] }>('/api/opc/companies');
      set({ companies: data.companies ?? [], companiesLoading: false });
    } catch (err) {
      set({ companiesLoading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  createCompany: async (input) => {
    try {
      const data = await api.post<{ company: OpcCompany }>('/api/opc/companies', input);
      set({ companies: [data.company, ...get().companies], error: null });
      return data.company;
    } catch (err) {
      const msg = err instanceof Error ? err.message : (err as { message?: string })?.message ?? '创建失败';
      set({ error: msg });
      return null;
    }
  },

  updateCompany: async (id, patch) => {
    try {
      const data = await api.put<{ company: OpcCompany }>(`/api/opc/companies/${encodeURIComponent(id)}`, patch);
      set({
        companies: get().companies.map((c) => (c.id === id ? data.company : c)),
        error: null,
      });
      return data.company;
    } catch (err) {
      const msg = err instanceof Error ? err.message : (err as { message?: string })?.message ?? '保存失败';
      set({ error: msg });
      return null;
    }
  },

  deleteCompany: async (id) => {
    try {
      await api.delete(`/api/opc/companies/${encodeURIComponent(id)}`);
      const { [id]: _drop, ...restObj } = get().objectivesByCompany;
      set({
        companies: get().companies.filter((c) => c.id !== id),
        objectivesByCompany: restObj,
        error: null,
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : (err as { message?: string })?.message ?? '删除失败';
      set({ error: msg });
      return false;
    }
  },

  loadObjectives: async (companyId) => {
    set({ objectivesLoading: true, error: null });
    try {
      const data = await api.get<{ objectives: OpcObjective[] }>(
        `/api/opc/companies/${encodeURIComponent(companyId)}/objectives`,
      );
      set((state) => ({
        objectivesByCompany: { ...state.objectivesByCompany, [companyId]: data.objectives ?? [] },
        objectivesLoading: false,
      }));
    } catch (err) {
      set({ objectivesLoading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  createObjective: async (companyId, input) => {
    try {
      const data = await api.post<{ objective: OpcObjective }>(
        `/api/opc/companies/${encodeURIComponent(companyId)}/objectives`,
        input,
      );
      const existing = get().objectivesByCompany[companyId] ?? [];
      set((state) => ({
        objectivesByCompany: { ...state.objectivesByCompany, [companyId]: [data.objective, ...existing] },
        error: null,
      }));
      return data.objective;
    } catch (err) {
      const msg = err instanceof Error ? err.message : (err as { message?: string })?.message ?? '创建失败';
      set({ error: msg });
      return null;
    }
  },

  updateObjective: async (id, patch) => {
    try {
      const data = await api.put<{ objective: OpcObjective }>(`/api/opc/objectives/${encodeURIComponent(id)}`, patch);
      const companyId = data.objective.company_id;
      set((state) => {
        const list = state.objectivesByCompany[companyId] ?? [];
        return {
          objectivesByCompany: {
            ...state.objectivesByCompany,
            [companyId]: list.map((o) => (o.id === id ? data.objective : o)),
          },
          error: null,
        };
      });
      return data.objective;
    } catch (err) {
      const msg = err instanceof Error ? err.message : (err as { message?: string })?.message ?? '保存失败';
      set({ error: msg });
      return null;
    }
  },

  deleteObjective: async (id, companyId) => {
    try {
      await api.delete(`/api/opc/objectives/${encodeURIComponent(id)}`);
      const list = get().objectivesByCompany[companyId] ?? [];
      set((state) => ({
        objectivesByCompany: {
          ...state.objectivesByCompany,
          [companyId]: list.filter((o) => o.id !== id),
        },
        error: null,
      }));
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : (err as { message?: string })?.message ?? '删除失败';
      set({ error: msg });
      return false;
    }
  },

  clearError: () => set({ error: null }),
}));
