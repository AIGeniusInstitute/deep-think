/**
 * Workflow editor store — single source of truth for the editable DAG canvas.
 *
 * Holds ReactFlow-shaped nodes/edges (controlled mode) so the canvas and the
 * inspector share the same state. Structural mutations (add/remove node,
 * connect, update node data) go through actions here; position drags are
 * committed via applyNodeChanges (controlled). On save, nodes/edges are
 * serialized to the backend GraphDefinition shape (GraphNode[] with position).
 *
 * Run mode is handled by the existing stores/graph.ts; this store only owns
 * the edit/draft state. Saving → POST/PUT /api/workflows; running → the page
 * calls /api/graph/runs directly (reusing the graph run store for live view).
 */
import { create } from 'zustand';
import type { Node, Edge, NodeChange, EdgeChange, Connection } from '@xyflow/react';
import { applyNodeChanges, applyEdgeChanges, addEdge as rfAddEdge } from '@xyflow/react';
import { workflowsApi, type WorkflowDefinition, type WorkflowSummary } from '../api/workflows';
import { useGroupsStore } from './groups';
import type { GraphNodeType } from '../components/workflow/workflow-constants';
import { defaultNodeFields } from '../components/workflow/workflow-constants';
import {
  hasCompleteWorkflowNodePositions,
  isWorkflowCanvasPoint,
} from '../components/workflow/workflow-canvas-utils';

let nodeSeq = 0;
/** Generate a unique node id for a freshly dropped node. */
function genNodeId(type: GraphNodeType): string {
  nodeSeq += 1;
  return `${type}-${Date.now().toString(36)}-${nodeSeq}`;
}

/** The GraphNode payload carried in node.data (mirrors graph-engineering GraphNode). */
export interface WorkflowNodeData {
  id: string;
  type: GraphNodeType;
  title: string;
  [key: string]: unknown;
}

export interface WorkflowEditorState {
  mode: 'edit' | 'run';
  definitionId: string | null;
  name: string;
  description: string;
  nodes: Node<WorkflowNodeData>[];
  edges: Edge[];
  selectedNodeId: string | null;
  saving: boolean;
  saveError: string | null;
  list: WorkflowSummary[];
  autobuilding: boolean;
  autobuildId: string | null;
  autobuildError: string | null;
  runId: string | null;

  // navigation
  setMode: (m: 'edit' | 'run') => void;
  setSelected: (id: string | null) => void;

  // list
  loadList: () => Promise<void>;
  openWorkflow: (id: string) => Promise<void>;
  newWorkflow: () => void;

  // structural edits
  addNode: (type: GraphNodeType, position: { x: number; y: number }) => void;
  updateNodeData: (id: string, patch: Record<string, unknown>) => void;
  removeNode: (id: string) => void;
  applyNodeChanges: (changes: NodeChange[]) => void;
  applyEdgeChanges: (changes: EdgeChange[]) => void;
  onConnect: (conn: Connection) => void;
  removeEdge: (id: string) => void;
  updateEdge: (id: string, patch: Record<string, unknown>) => void;
  autoLayout: () => void;

  // meta
  setName: (name: string) => void;
  setDescription: (desc: string) => void;

  // persistence + run
  save: () => Promise<{ id: string; version: number } | null>;
  run: () => Promise<string | null>;

  // 编排 Agent 草稿生成
  autobuild: (input: {
    goalText: string;
    background?: string;
    acceptanceCriteria?: string;
    maxTeamSize?: number;
    toolset?: string[];
    executionMode?: 'auto' | 'semi-auto';
  }) => Promise<void>;

  loadDefinitionIntoEditor: (def: WorkflowDefinition) => void;
}

/** Simple topological layout (BFS layers) so new/loaded graphs aren't a pile. */
function layoutLayers(nodes: Node<WorkflowNodeData>[], edges: Edge[]): Node<WorkflowNodeData>[] {
  const inDeg = new Map<string, number>();
  for (const n of nodes) inDeg.set(n.id, 0);
  for (const e of edges) inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
  const layer = new Map<string, number>();
  const queue: string[] = nodes.filter((n) => (inDeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  queue.forEach((id) => layer.set(id, 0));
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    const lyr = layer.get(id) ?? 0;
    for (const e of edges) {
      if (e.source === id) {
        const t = e.target;
        if ((layer.get(t) ?? -1) < lyr + 1) {
          layer.set(t, lyr + 1);
          queue.push(t);
        }
      }
    }
  }
  const byLayer = new Map<number, string[]>();
  for (const n of nodes) {
    const l = layer.get(n.id) ?? 0;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(n.id);
  }
  const pos = new Map<string, { x: number; y: number }>();
  for (const [l, ids] of byLayer) {
    ids.forEach((id, i) => pos.set(id, { x: 80 + l * 220, y: 80 + i * 110 }));
  }
  return nodes.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position }));
}

export const useWorkflowEditorStore = create<WorkflowEditorState>((set, get) => ({
  mode: 'edit',
  definitionId: null,
  name: '新建工作流',
  description: '',
  nodes: [],
  edges: [],
  selectedNodeId: null,
  saving: false,
  saveError: null,
  list: [],
  autobuilding: false,
  autobuildId: null,
  autobuildError: null,
  runId: null,

  setMode: (m) => set({ mode: m }),
  setSelected: (id) => set({ selectedNodeId: id }),

  loadList: async () => {
    try {
      const res = await workflowsApi.list();
      set({ list: res.workflows ?? [] });
    } catch {
      /* ignore */
    }
  },

  loadDefinitionIntoEditor: (def) => {
    const keepSavedPositions = hasCompleteWorkflowNodePositions(def.nodes);
    const nodes: Node<WorkflowNodeData>[] = (def.nodes as WorkflowNodeData[]).map((n) => ({
      id: n.id,
      type: 'workflowNode',
      position: isWorkflowCanvasPoint(n.position) ? { ...n.position } : { x: 0, y: 0 },
      data: { ...n },
    }));
    const edges: Edge[] = (def.edges as Record<string, unknown>[]).map((e) => ({
      ...e,
      id: (e.id as string | undefined) ?? `${e.from as string}-${e.to as string}`,
      source: e.from as string,
      target: e.to as string,
    }));
    const positionedNodes = keepSavedPositions ? nodes : layoutLayers(nodes, edges);
    set({
      definitionId: def.id,
      name: def.name,
      description: def.description ?? '',
      nodes: positionedNodes,
      edges,
      mode: 'edit',
      selectedNodeId: null,
      runId: null,
    });
  },

  openWorkflow: async (id) => {
    try {
      const res = await workflowsApi.get(id);
      get().loadDefinitionIntoEditor(res.definition);
    } catch (e) {
      set({ saveError: (e as Error).message });
    }
  },

  newWorkflow: () =>
    set({
      mode: 'edit',
      definitionId: null,
      name: '新建工作流',
      description: '',
      nodes: [],
      edges: [],
      selectedNodeId: null,
      saveError: null,
      runId: null,
    }),

  addNode: (type, position) => {
    const id = genNodeId(type);
    const title = type;
    const data: WorkflowNodeData = { id, type, title, ...defaultNodeFields(type, title) };
    const node: Node<WorkflowNodeData> = { id, type: 'workflowNode', position, data };
    set({ nodes: [...get().nodes, node], selectedNodeId: id });
  },

  updateNodeData: (id, patch) =>
    set({
      nodes: get().nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, ...patch } } : n,
      ),
    }),

  removeNode: (id) =>
    set({
      nodes: get().nodes.filter((n) => n.id !== id),
      edges: get().edges.filter((e) => e.source !== id && e.target !== id),
      selectedNodeId: get().selectedNodeId === id ? null : get().selectedNodeId,
    }),

  applyNodeChanges: (changes) =>
    set({ nodes: applyNodeChanges(changes, get().nodes) as Node<WorkflowNodeData>[] }),
  applyEdgeChanges: (changes) => set({ edges: applyEdgeChanges(changes, get().edges) }),

  onConnect: (conn) =>
    set({
      edges: rfAddEdge(
        { ...conn, id: `${conn.source}-${conn.target}-${Date.now().toString(36)}` },
        get().edges,
      ),
    }),

  removeEdge: (id) => set({ edges: get().edges.filter((e) => e.id !== id) }),
  updateEdge: (id, patch) =>
    set({ edges: get().edges.map((e) => (e.id === id ? { ...e, ...patch } : e)) }),

  autoLayout: () => set({ nodes: layoutLayers(get().nodes, get().edges) }),

  setName: (name) => set({ name }),
  setDescription: (description) => set({ description }),

  save: async () => {
    const { nodes, edges, name, description, definitionId } = get();
    if (!nodes.length) {
      set({ saveError: '工作流至少需要一个节点' });
      return null;
    }
    set({ saving: true, saveError: null });
    // Serialize to backend GraphNode/GraphEdge shape (position carried on node).
    const outNodes = nodes.map((n) => ({
      ...n.data,
      id: n.data.id,
      type: n.data.type,
      title: n.data.title,
      position: { x: n.position.x, y: n.position.y },
    }));
    const outEdges = edges.map((e) => ({
      id: e.id,
      from: e.source,
      to: e.target,
      type: (e as { type?: string }).type ?? 'data',
      condition: (e as { condition?: string }).condition,
      expression: (e as { expression?: string }).expression,
      isDefault: (e as { isDefault?: boolean }).isDefault,
    }));
    const body = { name, description, nodes: outNodes, edges: outEdges };
    try {
      const res = definitionId
        ? await workflowsApi.update(definitionId, body)
        : await workflowsApi.create(body);
      set({ saving: false, definitionId: res.id, saveError: null });
      return { id: res.id, version: res.version };
    } catch (e) {
      set({ saving: false, saveError: (e as Error).message });
      return null;
    }
  },

  run: async () => {
    const saved = await get().save();
    if (!saved) return null;
    // Need a group to host the run. Use the user's home group (mirrors TeamPage).
    const groups = useGroupsStore.getState().groups;
    const entries = Object.entries(groups);
    const home =
      entries.find(([, g]) => g.is_my_home) ??
      entries.find(([, g]) => g.is_home) ??
      entries.find(([, g]) => g.kind === 'home') ??
      entries[0];
    if (!home) {
      set({ saveError: '未找到可用工作区（group），无法启动运行' });
      return null;
    }
    const chatJid = home[0];
    const folder = home[1].folder;
    try {
      const startRes = await fetch(`${import.meta.env.BASE_URL}api/graph/runs`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          definitionId: saved.id,
          groupFolder: folder,
          chatJid,
          goalText: get().name,
        }),
      });
      const json = (await startRes.json()) as { ok?: boolean; runId?: string; error?: string };
      if (!startRes.ok || !json.runId) {
        set({ saveError: json.error ?? '启动运行失败' });
        return null;
      }
      set({ runId: json.runId, mode: 'run' });
      return json.runId;
    } catch (e) {
      set({ saveError: (e as Error).message });
      return null;
    }
  },

  autobuild: async (input) => {
    const groups = useGroupsStore.getState().groups;
    const entries = Object.entries(groups);
    const home =
      entries.find(([, g]) => g.is_my_home) ??
      entries.find(([, g]) => g.is_home) ??
      entries.find(([, g]) => g.kind === 'home') ??
      entries[0];
    if (!home) {
      set({ autobuildError: '未找到可用工作区（group）' });
      return;
    }
    const chatJid = home[0];
    const folder = home[1].folder;
    set({ autobuilding: true, autobuildError: null, autobuildId: null });
    try {
      const res = await workflowsApi.autobuild({ ...input, groupFolder: folder, chatJid });
      set({ autobuildId: res.buildId });
    } catch (e) {
      set({ autobuilding: false, autobuildError: (e as Error).message });
    }
  },
}));
