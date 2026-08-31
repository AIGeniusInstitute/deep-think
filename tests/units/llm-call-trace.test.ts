/**
 * llm_call trace tests — verifies sdkQuery/sdkQueryMessages record an llm_call
 * trace_step when a trace context is provided, and skip it (backward compat)
 * when omitted.
 */
import { describe, expect, test, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above imports, so use vi.hoisted to obtain
// the mock fns that the factories reference.
const { queryMock, upsertTraceStep } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  upsertTraceStep: vi.fn(),
}));

// Mock the SDK query() to return a controllable async iterable.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

// Capture upsertTraceStep calls (the trace side channel).
vi.mock('../../src/db.js', () => ({
  upsertTraceStep,
}));

vi.mock('../../src/runtime-config.js', () => ({
  getClaudeProviderConfig: () => ({ anthropicModel: undefined }),
  buildClaudeEnvLines: () => [],
}));

vi.mock('../../src/logger.js', () => ({
  logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
}));

import { sdkQuery, sdkQueryMessages } from '../../src/sdk-query.js';

function asyncResultIter(result: string) {
  return (async function* () {
    yield { type: 'result', subtype: 'success', result };
  })();
}

beforeEach(() => {
  queryMock.mockReset();
  upsertTraceStep.mockReset();
});

describe('sdkQuery llm_call trace', () => {
  test('with trace → records one llm_call step (done)', async () => {
    queryMock.mockReturnValue(asyncResultIter('the answer'));
    const out = await sdkQuery('hello', { trace: { chatJid: 'g1', label: 'Test' } });
    expect(out).toBe('the answer');
    expect(upsertTraceStep).toHaveBeenCalledTimes(1);
    const row = upsertTraceStep.mock.calls[0][0];
    expect(row.node_type).toBe('llm_call');
    expect(row.chat_jid).toBe('g1');
    expect(row.title).toBe('Test');
    expect(row.status).toBe('done');
    expect(row.input_summary).toBe('hello');
    expect(row.output_summary).toBe('the answer');
    expect(row.span_id).toMatch(/^llm-\d+$/);
    expect(row.started_at).toBeTruthy();
    expect(row.ended_at).toBeTruthy();
  });

  test('without trace → does not record (backward compat)', async () => {
    queryMock.mockReturnValue(asyncResultIter('x'));
    await sdkQuery('hello', {});
    expect(upsertTraceStep).not.toHaveBeenCalled();
  });

  test('query failure → records step with status failed', async () => {
    queryMock.mockImplementation(() => { throw new Error('boom'); });
    const out = await sdkQuery('hello', { trace: { chatJid: 'g1' } });
    expect(out).toBeNull();
    expect(upsertTraceStep).toHaveBeenCalledTimes(1);
    expect(upsertTraceStep.mock.calls[0][0].status).toBe('failed');
  });
});

describe('sdkQueryMessages llm_call trace', () => {
  test('with trace → records llm_call step', async () => {
    queryMock.mockReturnValue(asyncResultIter('msg answer'));
    await sdkQueryMessages(
      [{ role: 'user', content: 'do the thing' }],
      { trace: { chatJid: 'g2', label: 'Skill: x' } },
    );
    expect(upsertTraceStep).toHaveBeenCalledTimes(1);
    const row = upsertTraceStep.mock.calls[0][0];
    expect(row.node_type).toBe('llm_call');
    expect(row.chat_jid).toBe('g2');
    expect(row.title).toBe('Skill: x');
    expect(row.input_summary).toContain('do the thing');
  });

  test('without trace → does not record', async () => {
    queryMock.mockReturnValue(asyncResultIter('x'));
    await sdkQueryMessages([{ role: 'user', content: 'hi' }], {});
    expect(upsertTraceStep).not.toHaveBeenCalled();
  });
});
