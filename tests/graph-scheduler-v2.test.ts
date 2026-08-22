import { describe, expect, test } from 'vitest';

import type { GraphDefinition } from '../src/graph-engineering/graph-types.js';
import { computeReadyNodes, takenEdges } from '../src/graph-engineering/graph-scheduler.js';
import type { EvalContext } from '../src/graph-engineering/graph-expr.js';

const ctx = (state: Record<string, unknown> = {}): EvalContext => ({
  graph: { input: {} },
  state,
  node: {},
});

const node = (id: string, type: string) => ({ id, type: type as any, title: id });

describe('computeReadyNodes — DSL v2 expression edges', () => {
  test('expression edge activates when condition true', () => {
    // start -(expr "state.score > 0.8")-> A
    const def: GraphDefinition = {
      id: 'g', version: 1, name: 'g',
      nodes: [node('start', 'start'), node('A', 'agent')],
      edges: [
        { id: 'e1', from: 'start', to: 'A', expression: '${state.score} > 0.8' },
      ],
    };
    const completed = new Set(['start']);
    // score low → A not ready
    expect(computeReadyNodes(def, completed, new Map(), ctx({ score: 0.3 }))).toEqual([]);
    // score high → A ready
    expect(computeReadyNodes(def, completed, new Map(), ctx({ score: 0.9 }))).toHaveLength(1);
  });

  test('default fallback edge when no conditional matches', () => {
    // start → high (score>0.8), start → low (score<0.2), start → fallback (default)
    // Each target has exactly one incoming edge (conditional routing pattern).
    const def: GraphDefinition = {
      id: 'g', version: 1, name: 'g',
      nodes: [node('start', 'start'), node('high', 'agent'), node('low', 'agent'), node('fallback', 'agent')],
      edges: [
        { id: 'e1', from: 'start', to: 'high', expression: '${state.score} > 0.8' },
        { id: 'e2', from: 'start', to: 'low', expression: '${state.score} < 0.2' },
        { id: 'eD', from: 'start', to: 'fallback', isDefault: true },
      ],
    };
    const completed = new Set(['start']);
    // mid score → no conditional matches → default activates → fallback ready
    const ready = computeReadyNodes(def, completed, new Map(), ctx({ score: 0.5 }));
    expect(ready.map((n) => n.id)).toEqual(['fallback']);
    // high score → high ready, others not
    const readyHigh = computeReadyNodes(def, completed, new Map(), ctx({ score: 0.9 }));
    expect(readyHigh.map((n) => n.id)).toEqual(['high']);
    // low score → low ready
    const readyLow = computeReadyNodes(def, completed, new Map(), ctx({ score: 0.1 }));
    expect(readyLow.map((n) => n.id)).toEqual(['low']);
  });

  test('parallel fan-out: multiple plain edges from one source', () => {
    const def: GraphDefinition = {
      id: 'g', version: 1, name: 'g',
      nodes: [node('start', 'start'), node('A', 'agent'), node('B', 'agent'), node('C', 'agent')],
      edges: [
        { id: 'e1', from: 'start', to: 'A' },
        { id: 'e2', from: 'start', to: 'B' },
        { id: 'e3', from: 'start', to: 'C' },
      ],
    };
    const ready = computeReadyNodes(def, new Set(['start']), new Map(), ctx());
    expect(ready.map((n) => n.id).sort()).toEqual(['A', 'B', 'C']);
  });

  test('legacy condition edges still work without evalCtx (backward compat)', () => {
    // branch node 'b' with condition edges, no expression
    const def: GraphDefinition = {
      id: 'g', version: 1, name: 'g',
      nodes: [node('b', 'branch'), node('X', 'agent'), node('Y', 'agent')],
      edges: [
        { id: 'e1', from: 'b', to: 'X', condition: 'yes' },
        { id: 'e2', from: 'b', to: 'Y', condition: 'no' },
      ],
    };
    const completed = new Set(['b']);
    const decisions = new Map([['b', 'yes']]);
    // No evalCtx → legacy path → X ready (condition match), Y not
    const ready = computeReadyNodes(def, completed, decisions, null);
    expect(ready.map((n) => n.id)).toEqual(['X']);
  });
});

describe('takenEdges — edges activated by newly completed nodes', () => {
  test('reports taken conditional edge', () => {
    const def: GraphDefinition = {
      id: 'g', version: 1, name: 'g',
      nodes: [node('start', 'start'), node('A', 'agent')],
      edges: [{ id: 'e1', from: 'start', to: 'A', expression: '${state.ok} == "yes"' }],
    };
    const taken = takenEdges(def, [node('start', 'start')], new Set(['start']), new Map(), ctx({ ok: 'yes' }));
    expect(taken).toHaveLength(1);
    expect(taken[0].id).toBe('e1');
  });
});
