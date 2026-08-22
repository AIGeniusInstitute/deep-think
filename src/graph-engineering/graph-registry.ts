/**
 * Graph Registry — graph definition lifecycle: validation, serialization,
 * versioning, Mermaid export.
 *
 * Modeled on harness-registry.ts (snapshot/version/diff pattern). Definitions
 * are text manifests (nodes/edges JSON), versioned by (id, version), locked
 * at run start so resume replays the same version.
 */

import crypto from 'node:crypto';
import {
  createGraphDefinition,
  getLatestGraphDefinition,
} from '../db.js';
import type {
  GraphDefinition,
  GraphEdge,
  GraphNode,
  GraphValidationResult,
} from './graph-types.js';

/** Canonical JSON stringify (stable key order) for deterministic hashing. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as object).sort());
}

/** Content hash of a definition — used to detect version drift on resume. */
export function computeManifestHash(def: GraphDefinition): string {
  const payload = {
    id: def.id,
    version: def.version,
    name: def.name,
    nodes: def.nodes,
    edges: def.edges,
    stateSchema: def.stateSchema ?? [],
    budget: def.budget ?? null,
  };
  return crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/** Serialize a definition for DB storage. */
export function serializeDefinition(def: GraphDefinition): {
  nodes_json: string;
  edges_json: string;
  state_schema_json: string;
  budget_json: string;
} {
  return {
    nodes_json: JSON.stringify(def.nodes),
    edges_json: JSON.stringify(def.edges),
    state_schema_json: def.stateSchema ? JSON.stringify(def.stateSchema) : '',
    budget_json: def.budget ? JSON.stringify(def.budget) : '',
  };
}

/** Deserialize a DB row back into an in-memory definition. */
export function deserializeDefinition(row: {
  id: string;
  version: number;
  name: string;
  description: string | null;
  nodes_json: string;
  edges_json: string;
  state_schema_json: string | null;
  budget_json?: string | null;
}): GraphDefinition {
  return {
    id: row.id,
    version: row.version,
    name: row.name,
    description: row.description ?? undefined,
    nodes: JSON.parse(row.nodes_json) as GraphNode[],
    edges: JSON.parse(row.edges_json) as GraphEdge[],
    stateSchema: row.state_schema_json
      ? (JSON.parse(row.state_schema_json) as GraphDefinition['stateSchema'])
      : undefined,
    budget: row.budget_json
      ? (JSON.parse(row.budget_json) as GraphDefinition['budget'])
      : undefined,
  };
}

/**
 * Validate a graph definition. Checks:
 *  - non-empty, unique node ids
 *  - all edges reference existing nodes (no dangling)
 *  - no self-loops
 *  - acyclic (DAG) — DFS with coloring
 *  - branch nodes declare a branchKey
 */
export function validateDefinition(def: GraphDefinition): GraphValidationResult {
  const errors: string[] = [];

  if (!def.nodes.length) {
    errors.push('graph has no nodes');
  }
  const nodeIds = new Set<string>();
  for (const n of def.nodes) {
    if (!n.id) errors.push(`node missing id`);
    if (nodeIds.has(n.id)) errors.push(`duplicate node id: ${n.id}`);
    nodeIds.add(n.id);
    if (n.type === 'branch' && !n.branchKey) {
      errors.push(`branch node ${n.id} missing branchKey`);
    }
    if ((n.type === 'agent' || n.type === 'gate') && !n.prompt && !n.successCriteria) {
      errors.push(`${n.type} node ${n.id} missing prompt/successCriteria`);
    }
    // DSL v2: required fields for the new node kinds.
    if (n.type === 'llm' && !n.prompt) {
      errors.push(`llm node ${n.id} missing prompt`);
    }
    if (n.type === 'tool' && !n.toolName) {
      errors.push(`tool node ${n.id} missing toolName`);
    }
    if (n.type === 'aggregate' && n.mergeStrategy === 'arbitrate' && !n.arbitratePrompt) {
      errors.push(`aggregate node ${n.id} with mergeStrategy=arbitrate missing arbitratePrompt`);
    }
  }

  // Edges
  for (const e of def.edges) {
    if (!nodeIds.has(e.from)) errors.push(`edge ${e.id}: from '${e.from}' not found`);
    if (!nodeIds.has(e.to)) errors.push(`edge ${e.id}: to '${e.to}' not found`);
    if (e.from === e.to) errors.push(`edge ${e.id}: self-loop not allowed (P0)`);
    // DSL v2: an edge may declare condition OR expression OR be default, not
    // conflicting combinations. (condition + expression is tolerated with
    // expression taking precedence, but flag for author clarity.)
    if (e.expression && e.condition) {
      errors.push(`edge ${e.id}: both condition and expression set — ambiguous`);
    }
  }
  // DSL v2: at most one default edge per from-node.
  const defaultByFrom = new Map<string, number>();
  for (const e of def.edges) {
    if (e.isDefault) {
      defaultByFrom.set(e.from, (defaultByFrom.get(e.from) ?? 0) + 1);
    }
  }
  for (const [from, cnt] of defaultByFrom) {
    if (cnt > 1) errors.push(`node ${from}: multiple default edges (${cnt})`);
  }

  // Cycle detection (3-color DFS). P0 forbids cycles.
  const adj = new Map<string, string[]>();
  for (const n of def.nodes) adj.set(n.id, []);
  for (const e of def.edges) {
    adj.get(e.from)?.push(e.to);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const n of def.nodes) color.set(n.id, WHITE);
  let hasCycle = false;
  const dfs = (u: string): void => {
    color.set(u, GRAY);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? WHITE;
      if (c === GRAY) {
        hasCycle = true;
        errors.push(`cycle detected involving edge ${u} → ${v}`);
      } else if (c === WHITE) {
        dfs(v);
      }
    }
    color.set(u, BLACK);
  };
  for (const n of def.nodes) {
    if (color.get(n.id) === WHITE) dfs(n.id);
    if (hasCycle) break;
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Export a definition to Mermaid (graph TD). Used to commit a human-readable
 * picture of the graph alongside the code (auditability, AC1.3).
 */
export function toMermaid(def: GraphDefinition): string {
  const lines: string[] = [`%% ${def.name} (v${def.version})`, 'graph TD'];
  for (const n of def.nodes) {
    const label = n.title.replace(/"/g, "'").slice(0, 40);
    lines.push(`  ${n.id}["${label}<br/><small>${n.type}</small>"]`);
  }
  for (const e of def.edges) {
    const cond = e.condition ? `|${e.condition}|` : '';
    lines.push(`  ${e.from} -->${cond} ${e.to}`);
  }
  return lines.join('\n');
}

/**
 * Register a new version of a graph definition. Auto-increments version from
 * the latest existing one. Refuses to register an invalid definition.
 */
export function registerDefinition(
  def: GraphDefinition,
): { key: string; hash: string } {
  const validation = validateDefinition(def);
  if (!validation.ok) {
    throw new Error(`Invalid graph definition: ${validation.errors.join('; ')}`);
  }
  const latest = getLatestGraphDefinition(def.id);
  const version = latest ? latest.version + 1 : def.version;
  const { nodes_json, edges_json, state_schema_json, budget_json } = serializeDefinition(def);
  const hash = computeManifestHash({ ...def, version });
  const key = createGraphDefinition({
    id: def.id,
    version,
    parent_version_id: latest ? `${latest.id}@${latest.version}` : null,
    name: def.name,
    description: def.description ?? null,
    nodes_json,
    edges_json,
    state_schema_json: state_schema_json || null,
    budget_json: budget_json || null,
    manifest_hash: hash,
    status: 'active',
  });
  return { key, hash };
}

/** Load the latest active version of a definition by id. */
export function loadLatestDefinition(id: string): GraphDefinition | undefined {
  const row = getLatestGraphDefinition(id);
  return row ? deserializeDefinition(row) : undefined;
}
