import { describe, expect, test } from 'vitest';

import {
  parseCaseYaml,
  scoreAssertion,
  scoreCase,
  scoreCaseAsync,
  extractJsonPath,
  type EvalCase,
} from '../../src/harness-eval.js';

describe('harness-eval: parseCaseYaml', () => {
  test('parses a well-formed case', () => {
    const raw = `
case_id: code-gen
name: Code Generation
prompt: |
  write a function
assertions:
  - { kind: contains, value: "def add" }
  - { kind: regex, value: "return\\\\s+a" }
  - { kind: not_contains, value: "I cannot" }
rubric:
  weights: { default: 1.0 }
  pass_threshold: 1.0
`;
    const c = parseCaseYaml(raw);
    expect(c).not.toBeNull();
    expect(c!.case_id).toBe('code-gen');
    expect(c!.name).toBe('Code Generation');
    expect(c!.assertions).toHaveLength(3);
    expect(c!.assertions[0]).toEqual({ kind: 'contains', value: 'def add' });
    expect(c!.rubric.pass_threshold).toBe(1.0);
  });

  test('returns null for missing required fields', () => {
    expect(parseCaseYaml('')).toBeNull();
    expect(parseCaseYaml('case_id: x\nassertions: []')).toBeNull();
    expect(parseCaseYaml('case_id: x\nprompt: hi\nassertions: "not-array"')).toBeNull();
  });

  test('filters out assertions with unknown kind', () => {
    const raw = `
case_id: t
prompt: hi
assertions:
  - { kind: contains, value: "ok" }
  - { kind: bogus, value: "x" }
rubric:
  pass_threshold: 1.0
`;
    const c = parseCaseYaml(raw);
    expect(c!.assertions).toHaveLength(1);
    expect(c!.assertions[0].kind).toBe('contains');
  });

  test('applies default rubric when missing', () => {
    const raw = `
case_id: t
prompt: hi
assertions:
  - { kind: contains, value: "ok" }
`;
    const c = parseCaseYaml(raw);
    expect(c!.rubric.pass_threshold).toBe(1.0);
    expect(c!.rubric.weights).toEqual({ default: 1.0 });
  });
});

describe('harness-eval: scoreAssertion', () => {
  test('contains matches', () => {
    expect(scoreAssertion({ kind: 'contains', value: 'foo' }, 'hello foo bar', false).pass).toBe(true);
    expect(scoreAssertion({ kind: 'contains', value: 'foo' }, 'hello bar', false).pass).toBe(false);
  });

  test('not_contains matches', () => {
    expect(scoreAssertion({ kind: 'not_contains', value: 'err' }, 'ok', false).pass).toBe(true);
    expect(scoreAssertion({ kind: 'not_contains', value: 'err' }, 'error here', false).pass).toBe(false);
  });

  test('regex matches', () => {
    expect(scoreAssertion({ kind: 'regex', value: 'def\\s+\\w+' }, 'def add(a, b)', false).pass).toBe(true);
    expect(scoreAssertion({ kind: 'regex', value: 'def\\s+\\w+' }, 'function add()', false).pass).toBe(false);
  });

  test('regex with invalid pattern fails gracefully', () => {
    expect(scoreAssertion({ kind: 'regex', value: '(' }, 'anything', false).pass).toBe(false);
  });

  test('no_error matches', () => {
    expect(scoreAssertion({ kind: 'no_error', value: '' }, 'response', false).pass).toBe(true);
    expect(scoreAssertion({ kind: 'no_error', value: '' }, 'response', true).pass).toBe(false);
  });
});

describe('harness-eval: scoreCase', () => {
  const evalCase: EvalCase = {
    case_id: 't',
    name: 'T',
    prompt: 'p',
    assertions: [
      { kind: 'contains', value: 'foo' },
      { kind: 'contains', value: 'bar' },
    ],
    rubric: { pass_threshold: 1.0 },
  };

  test('all pass → pass=true, score=1.0', () => {
    const r = scoreCase(evalCase, 'foo bar', false);
    expect(r.pass).toBe(true);
    expect(r.score).toBe(1.0);
    expect(r.details).toHaveLength(2);
  });

  test('one fail → pass=false, score=0.5', () => {
    const r = scoreCase(evalCase, 'foo only', false);
    expect(r.pass).toBe(false);
    expect(r.score).toBe(0.5);
  });

  test('threshold < 1.0 allows partial pass', () => {
    const c: EvalCase = { ...evalCase, rubric: { pass_threshold: 0.5 } };
    const r = scoreCase(c, 'foo only', false);
    expect(r.pass).toBe(true);
    expect(r.score).toBe(0.5);
  });

  test('zero assertions → score=0, pass=false', () => {
    const c: EvalCase = { ...evalCase, assertions: [] };
    const r = scoreCase(c, 'anything', false);
    expect(r.score).toBe(0);
    expect(r.pass).toBe(false);
  });
});

describe('harness-eval: v58 structured assertions', () => {
  test('json_schema passes on valid object', () => {
    const r = scoreAssertion(
      { kind: 'json_schema', value: JSON.stringify({ type: 'object', required: ['x'] }) },
      JSON.stringify({ x: 1 }),
      false,
    );
    expect(r.pass).toBe(true);
  });

  test('json_schema fails on missing field', () => {
    const r = scoreAssertion(
      { kind: 'json_schema', value: JSON.stringify({ type: 'object', required: ['x'] }) },
      JSON.stringify({ y: 1 }),
      false,
    );
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('json_schema failed');
  });

  test('json_schema fails gracefully on non-JSON response', () => {
    const r = scoreAssertion(
      { kind: 'json_schema', value: JSON.stringify({ type: 'object' }) },
      'not json',
      false,
    );
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('not JSON');
  });

  test('json_path equals', () => {
    const r = scoreAssertion(
      { kind: 'json_path', value: '$.status', operator: 'equals', expected: 'ok' },
      JSON.stringify({ status: 'ok' }),
      false,
    );
    expect(r.pass).toBe(true);
  });

  test('json_path contains', () => {
    const r = scoreAssertion(
      { kind: 'json_path', value: '$.msg', operator: 'contains', expected: 'world' },
      JSON.stringify({ msg: 'hello world' }),
      false,
    );
    expect(r.pass).toBe(true);
  });

  test('json_path exists / missing', () => {
    expect(
      scoreAssertion({ kind: 'json_path', value: '$.a.b', operator: 'exists' }, JSON.stringify({ a: { b: 1 } }), false).pass,
    ).toBe(true);
    expect(
      scoreAssertion({ kind: 'json_path', value: '$.a.c', operator: 'exists' }, JSON.stringify({ a: { b: 1 } }), false).pass,
    ).toBe(false);
  });

  test('numeric_range in bounds', () => {
    const r = scoreAssertion(
      { kind: 'numeric_range', value: '$.count', min: 1, max: 10 },
      JSON.stringify({ count: 5 }),
      false,
    );
    expect(r.pass).toBe(true);
  });

  test('numeric_range out of bounds', () => {
    const r = scoreAssertion(
      { kind: 'numeric_range', value: '$.count', min: 1, max: 10 },
      JSON.stringify({ count: 99 }),
      false,
    );
    expect(r.pass).toBe(false);
  });

  test('extractJsonPath dot/bracket navigation', () => {
    expect(extractJsonPath({ a: { b: [{ c: 7 }] } }, '$.a.b[0].c')).toBe(7);
    expect(extractJsonPath({ a: { b: 1 } }, '$.a.c')).toBe(undefined);
    expect(extractJsonPath({ x: 1 }, '$')).toEqual({ x: 1 });
  });
});

describe('harness-eval: scoreCaseAsync (llm_judge)', () => {
  test('llm_judge uses injected judge; sync kinds reuse scoreAssertion', async () => {
    const c: EvalCase = {
      case_id: 'lj',
      name: 'LJ',
      prompt: 'p',
      assertions: [
        { kind: 'contains', value: 'foo' },
        { kind: 'llm_judge', value: 'is the answer helpful?' },
      ],
      rubric: { pass_threshold: 1.0 },
    };
    const judge = async () => ({ pass: true, detail: 'judge ok' });
    const r = await scoreCaseAsync(c, 'foo bar', false, judge);
    expect(r.pass).toBe(true);
    expect(r.score).toBe(1.0);
    expect(r.details[1]).toContain('judge ok');
  });

  test('llm_judge without judge fails', async () => {
    const r = await scoreCaseAsync(
      { case_id: 'lj', name: 'LJ', prompt: 'p', assertions: [{ kind: 'llm_judge', value: 'q' }], rubric: { pass_threshold: 1.0 } },
      'resp',
      false,
    );
    expect(r.pass).toBe(false);
    expect(r.details[0]).toContain('no judge');
  });

  test('llm_judge error is captured', async () => {
    const judge = async () => { throw new Error('boom'); };
    const r = await scoreCaseAsync(
      { case_id: 'lj', name: 'LJ', prompt: 'p', assertions: [{ kind: 'llm_judge', value: 'q' }], rubric: { pass_threshold: 1.0 } },
      'resp',
      false,
      judge,
    );
    expect(r.pass).toBe(false);
    expect(r.details[0]).toContain('boom');
  });
});
