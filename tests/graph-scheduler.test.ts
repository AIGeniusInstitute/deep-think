/**
 * Graph scheduler + registry — pure-logic unit tests (no DB, no agents).
 *
 * Covers the verifiable core of PRD §5:
 *  TC1  linear A→B→C progresses in topological order
 *  TC2  fan-out A→[B,C]→D join: B,C run in parallel, D waits
 *  TC3  branch routes to the matching conditional edge
 *  TC4  cycle detection rejects the definition
 *  TC5  retry budget (maxAttempts) — exercised at orchestrator level; here we
 *       assert nextReadyBatch never over-subscribes
 *  TC14 global concurrency ceiling — nextReadyBatch ≤ maxParallel
 *  TC16 Mermaid export renders edges
 */
import { describe, expect, test } from 'vitest';

import {
  allCompleted,
  branchEdgeCoverage,
  computeReadyNodes,
  downstreamNodeIds,
  nextReadyBatch,
  sourceNodes,
} from '../src/graph-engineering/graph-scheduler.js';
import {
  computeManifestHash,
  toMermaid,
  validateDefinition,
} from '../src/graph-engineering/graph-registry.js';
import type { GraphDefinition } from '../src/graph-engineering/graph-types.js';

function linearGraph(): GraphDefinition {
  return {
    id: 'linear', version: 1, name: 'linear',
    nodes: [
      { id: 'A', type: 'agent', title: 'A', prompt: 'do A' },
      { id: 'B', type: 'agent', title: 'B', prompt: 'do B' },
      { id: 'C', type: 'agent', title: 'C', prompt: 'do C' },
    ],
    edges: [
      { id: 'e1', from: 'A', to: 'B' },
      { id: 'e2', from: 'B', to: 'C' },
    ],
  };
}

function fanOutGraph(): GraphDefinition {
  return {
    id: 'fanout', version: 1, name: 'fanout',
    nodes: [
      { id: 'A', type: 'agent', title: 'A', prompt: 'do A' },
      { id: 'B', type: 'agent', title: 'B', prompt: 'do B' },
      { id: 'C', type: 'agent', title: 'C', prompt: 'do C' },
      { id: 'D', type: 'join', title: 'D' },
    ],
    edges: [
      { id: 'e1', from: 'A', to: 'B' },
      { id: 'e2', from: 'A', to: 'C' },
      { id: 'e3', from: 'B', to: 'D' },
      { id: 'e4', from: 'C', to: 'D' },
    ],
  };
}

function branchGraph(): GraphDefinition {
  return {
    id: 'branch', version: 1, name: 'branch',
    nodes: [
      { id: 'A', type: 'agent', title: 'A', prompt: 'do A' },
      { id: 'B', type: 'branch', title: 'route', branchKey: 'path' },
      { id: 'C', type: 'agent', title: 'C', prompt: 'do C' },
      { id: 'D', type: 'agent', title: 'D', prompt: 'do D' },
    ],
    edges: [
      { id: 'e1', from: 'A', to: 'B' },
      { id: 'e2', from: 'B', to: 'C', condition: 'fast' },
      { id: 'e3', from: 'B', to: 'D', condition: 'slow' },
    ],
  };
}

describe('graph-scheduler computeReadyNodes', () => {
  test('TC1: linear A→B→C progresses in topological order', () => {
    const def = linearGraph();
    const decisions = new Map<string, string>();

    // Step 0: only A is ready (source).
    let ready = computeReadyNodes(def, new Set(), decisions);
    expect(ready.map((n) => n.id)).toEqual(['A']);

    // After A completes, B is ready.
    ready = computeReadyNodes(def, new Set(['A']), decisions);
    expect(ready.map((n) => n.id)).toEqual(['B']);

    // After A,B complete, C is ready.
    ready = computeReadyNodes(def, new Set(['A', 'B']), decisions);
    expect(ready.map((n) => n.id)).toEqual(['C']);

    expect(allCompleted(def, new Set(['A', 'B', 'C']))).toBe(true);
  });

  test('TC2: fan-out A→[B,C]→D — B,C parallel, D waits for both', () => {
    const def = fanOutGraph();
    const decisions = new Map<string, string>();

    let ready = computeReadyNodes(def, new Set(), decisions);
    expect(ready.map((n) => n.id)).toEqual(['A']);

    // After A: both B and C ready (parallel fan-out).
    ready = computeReadyNodes(def, new Set(['A']), decisions);
    expect(ready.map((n) => n.id).sort()).toEqual(['B', 'C']);

    // After A,B (only one of the two join predecessors): D NOT ready.
    ready = computeReadyNodes(def, new Set(['A', 'B']), decisions);
    expect(ready.map((n) => n.id)).toEqual(['C']);

    // After A,B,C: D ready (fan-in complete).
    ready = computeReadyNodes(def, new Set(['A', 'B', 'C']), decisions);
    expect(ready.map((n) => n.id)).toEqual(['D']);
  });

  test('TC3: branch routes only the matching conditional edge', () => {
    const def = branchGraph();
    const decisions = new Map<string, string>();

    // After A, B (branch) is ready.
    let ready = computeReadyNodes(def, new Set(['A']), decisions);
    expect(ready.map((n) => n.id)).toEqual(['B']);

    // B chose 'fast' → only C is reachable, NOT D.
    decisions.set('B', 'fast');
    ready = computeReadyNodes(def, new Set(['A', 'B']), decisions);
    expect(ready.map((n) => n.id)).toEqual(['C']);

    // B chose 'slow' → only D is reachable, NOT C.
    decisions.set('B', 'slow');
    ready = computeReadyNodes(def, new Set(['A', 'B']), decisions);
    expect(ready.map((n) => n.id)).toEqual(['D']);
  });

  test('source nodes = nodes with no incoming edges', () => {
    expect(sourceNodes(linearGraph()).map((n) => n.id)).toEqual(['A']);
  });
});

describe('graph-scheduler nextReadyBatch', () => {
  test('TC14: batch never exceeds maxParallel or global slots', () => {
    const def = fanOutGraph();
    const ready = computeReadyNodes(def, new Set(['A']), new Map());
    // 2 ready (B,C), maxParallel=1 → 1 picked.
    expect(nextReadyBatch(ready, 1, 10).length).toBe(1);
    // maxParallel=4, globalSlots=1 → 1 picked (global ceiling).
    expect(nextReadyBatch(ready, 4, 1).length).toBe(1);
    // maxParallel=4, globalSlots=10 → both picked.
    expect(nextReadyBatch(ready, 4, 10).length).toBe(2);
  });

  test('downstreamNodeIds returns transitive successors', () => {
    expect(downstreamNodeIds(linearGraph(), 'A')).toEqual(new Set(['B', 'C']));
    expect(downstreamNodeIds(fanOutGraph(), 'A')).toEqual(new Set(['B', 'C', 'D']));
  });

  test('branchEdgeCoverage flags duplicate conditional values', () => {
    const def: GraphDefinition = {
      id: 'x', version: 1, name: 'x',
      nodes: [
        { id: 'B', type: 'branch', title: 'B', branchKey: 'k' },
        { id: 'C', type: 'agent', title: 'C', prompt: 'do C' },
        { id: 'D', type: 'agent', title: 'D', prompt: 'do D' },
      ],
      edges: [
        { id: 'e1', from: 'B', to: 'C', condition: 'fast' },
        { id: 'e2', from: 'B', to: 'D', condition: 'fast' }, // duplicate!
      ],
    };
    expect(branchEdgeCoverage(def)).toContain(
      'branch node B: duplicate conditional edge values',
    );
  });
});

describe('graph-registry validateDefinition', () => {
  test('TC4: cycle is rejected (P0 forbids cyclic graphs)', () => {
    const cyclic: GraphDefinition = {
      id: 'cyc', version: 1, name: 'cyc',
      nodes: [
        { id: 'A', type: 'agent', title: 'A', prompt: 'do A' },
        { id: 'B', type: 'agent', title: 'B', prompt: 'do B' },
      ],
      edges: [
        { id: 'e1', from: 'A', to: 'B' },
        { id: 'e2', from: 'B', to: 'A' },
      ],
    };
    const v = validateDefinition(cyclic);
    expect(v.ok).toBe(false);
    expect(v.errors.join('; ')).toMatch(/cycle/i);
  });

  test('self-loop is rejected', () => {
    const selfLoop: GraphDefinition = {
      id: 'sl', version: 1, name: 'sl',
      nodes: [{ id: 'A', type: 'agent', title: 'A', prompt: 'do A' }],
      edges: [{ id: 'e1', from: 'A', to: 'A' }],
    };
    expect(validateDefinition(selfLoop).ok).toBe(false);
  });

  test('dangling edge target is rejected', () => {
    const def: GraphDefinition = {
      id: 'd', version: 1, name: 'd',
      nodes: [{ id: 'A', type: 'agent', title: 'A', prompt: 'do A' }],
      edges: [{ id: 'e1', from: 'A', to: 'NOPE' }],
    };
    expect(validateDefinition(def).ok).toBe(false);
  });

  test('duplicate directed connections are rejected', () => {
    const def: GraphDefinition = {
      id: 'dup',
      version: 1,
      name: 'dup',
      nodes: [
        { id: 'A', type: 'agent', title: 'A', prompt: 'do A' },
        { id: 'B', type: 'agent', title: 'B', prompt: 'do B' },
      ],
      edges: [
        { id: 'e1', from: 'A', to: 'B' },
        { id: 'e2', from: 'A', to: 'B' },
      ],
    };
    const result = validateDefinition(def);

    expect(result.ok).toBe(false);
    expect(result.errors.join('; ')).toMatch(/duplicate edge/i);
  });

  test('valid linear graph passes', () => {
    expect(validateDefinition(linearGraph()).ok).toBe(true);
  });

  test('manifest hash is deterministic for identical content', () => {
    const a = computeManifestHash(linearGraph());
    const b = computeManifestHash(linearGraph());
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });
});

describe('graph-registry toMermaid', () => {
  test('TC16: Mermaid renders graph TD with nodes + conditional edges', () => {
    const mermaid = toMermaid(branchGraph());
    expect(mermaid).toContain('graph TD');
    expect(mermaid).toContain('A["A');
    expect(mermaid).toContain('|fast|');  // conditional edge label
    expect(mermaid).toContain('|slow|');
    expect(mermaid).toMatch(/B -->\|fast\| C/);
  });
});
