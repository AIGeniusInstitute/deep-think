import { describe, expect, test } from 'vitest';

import { evalCondition, resolveExpr, resolveValue, type EvalContext } from '../src/graph-engineering/graph-expr.js';

const ctx: EvalContext = {
  graph: { input: { topic: 'AI Agent', threshold: 0.8 } },
  state: { score: 0.9, node_a_output: 'hello', flag: true, empty: '' },
  node: {
    a: { output: { summary: '调研完成', score: 0.92 }, status: 'completed' },
    b: { output: 'plain string', status: 'failed' },
  },
};

describe('resolveExpr — ${var} template resolution', () => {
  test('resolves graph input', () => {
    expect(resolveExpr('topic=${graph.input.topic}', ctx)).toBe('topic=AI Agent');
  });
  test('resolves node output nested path', () => {
    expect(resolveExpr('${node.a.output.summary}', ctx)).toBe('调研完成');
  });
  test('resolves node status', () => {
    expect(resolveExpr('status=${node.a.status}', ctx)).toBe('status=completed');
  });
  test('resolves state key', () => {
    expect(resolveExpr('${state.score}', ctx)).toBe('${state.score}'.replace('${state.score}', '0.9'));
  });
  test('unknown path → empty string', () => {
    expect(resolveExpr('[${state.missing}]', ctx)).toBe('[]');
  });
  test('object output → JSON stringified', () => {
    expect(resolveExpr('${node.a.output}', ctx)).toContain('"summary":"调研完成"');
  });
  test('no placeholder → unchanged', () => {
    expect(resolveExpr('plain text', ctx)).toBe('plain text');
  });
  test('non-string → unchanged', () => {
    expect(resolveExpr(123 as unknown as string, ctx)).toBe(123 as unknown as string);
  });
});

describe('resolveValue — recursive value resolution', () => {
  test('resolves strings inside nested objects', () => {
    const input = { topic: '${graph.input.topic}', nested: { s: '${node.a.output.summary}' } };
    const out = resolveValue(input, ctx);
    expect(out).toEqual({ topic: 'AI Agent', nested: { s: '调研完成' } });
  });
  test('resolves inside arrays', () => {
    const input = ['${graph.input.topic}', '${node.b.output}'];
    expect(resolveValue(input, ctx)).toEqual(['AI Agent', 'plain string']);
  });
  test('primitives pass through', () => {
    expect(resolveValue(42, ctx)).toBe(42);
    expect(resolveValue(true, ctx)).toBe(true);
  });
});

describe('evalCondition — expression evaluation', () => {
  test('numeric > comparison', () => {
    expect(evalCondition('${state.score} > 0.8', ctx)).toBe(true);
  });
  test('numeric < comparison false', () => {
    expect(evalCondition('${state.score} < 0.5', ctx)).toBe(false);
  });
  test('== string equality', () => {
    expect(evalCondition("${node.a.status} == 'completed'", ctx)).toBe(true);
  });
  test('!= inequality', () => {
    expect(evalCondition("${node.a.status} != 'failed'", ctx)).toBe(true);
  });
  test('&& logical and', () => {
    expect(evalCondition('${state.score} > 0.8 && ${node.a.status} == "completed"', ctx)).toBe(true);
  });
  test('|| logical or', () => {
    expect(evalCondition('${state.score} < 0.5 || ${node.a.status} == "completed"', ctx)).toBe(true);
  });
  test('! negation', () => {
    expect(evalCondition('!${state.flag}', ctx)).toBe(false);
  });
  test('parenthesized', () => {
    expect(evalCondition('(${state.score} > 0.5 || ${state.score} < 0.1) && ${node.a.status} == "completed"', ctx)).toBe(true);
  });
  test('>= and <=', () => {
    expect(evalCondition('${state.score} >= 0.9', ctx)).toBe(true);
    expect(evalCondition('${state.score} <= 0.95', ctx)).toBe(true);
  });
  test('truthy standalone value', () => {
    expect(evalCondition('${state.flag}', ctx)).toBe(true);
    expect(evalCondition('${state.empty}', ctx)).toBe(false);
  });
  test('malformed → fail-safe false', () => {
    expect(evalCondition('${state.score >', ctx)).toBe(false);
    expect(evalCondition('', ctx)).toBe(false);
    expect(evalCondition('   ', ctx)).toBe(false);
  });
  test('trailing garbage → false', () => {
    expect(evalCondition('${state.score} > 0.5 garbage', ctx)).toBe(false);
  });
  test('node output numeric comparison', () => {
    expect(evalCondition('${node.a.output.score} > 0.8', ctx)).toBe(true);
    expect(evalCondition('${node.a.output.score} > 0.95', ctx)).toBe(false);
  });
});
