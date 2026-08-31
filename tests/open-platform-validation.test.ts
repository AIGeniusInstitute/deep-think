import { beforeAll, afterEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-validation-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
}));

// Stub global fetch for the hook caller (module under test grabs it lazily).
const fetchSpy = vi.fn();
globalThis.fetch = fetchSpy as unknown as typeof fetch;

const { initDatabase } = await import('../src/db.js');
const { recordWebhookCall, listWebhookCalls } = await import('../src/db.js');
import type { ValidationPolicy } from '../src/db.js';
const { validateResult, decideValidationAction } = await import(
  '../src/open-platform/result-validation.js'
);
const { callValidationHook } = await import('../src/open-platform/result-hooks.js');

beforeAll(() => {
  initDatabase();
});

afterEach(() => {
  fetchSpy.mockReset();
});

const basePolicy: ValidationPolicy = {
  policyType: 'api_key',
  policyId: 'pk_test',
  validationSchema: null,
  validationHookUrl: null,
  hookSecret: 'sekret',
  hookFailureAction: 'passthrough',
  onSchemaFail: 'fail',
};

describe('result-validation pipeline (v58)', () => {
  test('TC2.3.1a: schema fail + on_schema_fail=fail → reject/422', async () => {
    const policy: ValidationPolicy = {
      ...basePolicy,
      validationSchema: JSON.stringify({ type: 'object', required: ['x'] }),
      onSchemaFail: 'fail',
    };
    const outcome = await validateResult(policy, JSON.stringify({ y: 1 }));
    expect(outcome.schemaPassed).toBe(false);
    expect(outcome.passed).toBe(false);
    const d = decideValidationAction(policy, outcome);
    expect(d.action).toBe('reject');
    expect(d.status).toBe(422);
  });

  test('TC2.3.1b: schema fail + on_schema_fail=passthrough → pass', async () => {
    const policy: ValidationPolicy = {
      ...basePolicy,
      validationSchema: JSON.stringify({ type: 'object', required: ['x'] }),
      onSchemaFail: 'passthrough',
    };
    const outcome = await validateResult(policy, JSON.stringify({ y: 1 }));
    const d = decideValidationAction(policy, outcome);
    expect(d.action).toBe('pass');
  });

  test('TC2.3.1c: schema pass + on_schema_fail=retry → retry', async () => {
    const policy: ValidationPolicy = {
      ...basePolicy,
      validationSchema: JSON.stringify({ type: 'object', required: ['x'] }),
      onSchemaFail: 'retry',
    };
    const outcome = await validateResult(policy, JSON.stringify({ x: 1 }));
    const d = decideValidationAction(policy, outcome);
    // schema passed → overall pass → no retry needed
    expect(d.action).toBe('pass');
  });

  test('TC2.3.1d: non-JSON result with object schema → schema fails', async () => {
    const policy: ValidationPolicy = {
      ...basePolicy,
      validationSchema: JSON.stringify({ type: 'object' }),
    };
    const outcome = await validateResult(policy, 'not json at all');
    expect(outcome.schemaPassed).toBe(false);
    expect(outcome.evidence[0].stage).toBe('schema');
    expect(outcome.evidence[0].passed).toBe(false);
  });

  test('TC2.4.1: hook accepts → passed; evidence records httpStatus', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ accept: true }),
    });
    const policy: ValidationPolicy = {
      ...basePolicy,
      validationHookUrl: 'https://example.com/hook',
    };
    const outcome = await validateResult(policy, JSON.stringify({ ok: 1 }));
    expect(outcome.passed).toBe(true);
    const hookEv = outcome.evidence.find((e) => e.stage === 'hook')!;
    expect(hookEv.passed).toBe(true);
    expect(hookEv.httpStatus).toBe(200);
  });

  test('TC2.4.2: hook rejects (accept=false) + hook_failure_action=block → reject', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ accept: false, reason: 'business rule X' }),
    });
    const policy: ValidationPolicy = {
      ...basePolicy,
      validationHookUrl: 'https://example.com/hook',
      hookFailureAction: 'block',
    };
    const outcome = await validateResult(policy, JSON.stringify({ ok: 1 }));
    expect(outcome.passed).toBe(false);
    const d = decideValidationAction(policy, outcome);
    expect(d.action).toBe('reject');
  });

  test('TC2.5.1: hook timeout (AbortError) retried 3×, then errored', async () => {
    const abortErr = new Error('timeout');
    abortErr.name = 'AbortError';
    fetchSpy.mockRejectedValue(abortErr);
    const policy: ValidationPolicy = {
      ...basePolicy,
      validationHookUrl: 'https://example.com/hook',
      hookFailureAction: 'block',
    };
    const outcome = await validateResult(policy, JSON.stringify({ ok: 1 }));
    expect(outcome.hookErrored).toBe(true);
    expect(outcome.passed).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  test('TC2.5.2: idempotency — same request_id dedupes webhook_calls', () => {
    recordWebhookCall({
      policyType: 'api_key',
      policyId: 'pk_dedup',
      requestId: 'req-1',
      url: 'https://example.com/h',
      httpStatus: 200,
      responseSummary: 'ok',
      error: null,
      latencyMs: 5,
    });
    recordWebhookCall({
      policyType: 'api_key',
      policyId: 'pk_dedup',
      requestId: 'req-1',
      url: 'https://example.com/h',
      httpStatus: 500,
      responseSummary: 'err',
      error: 'http 500',
      latencyMs: 8,
    });
    const calls = listWebhookCalls('api_key', 'pk_dedup');
    expect(calls.length).toBe(1);
    expect(calls[0].http_status).toBe(500); // overwritten, not duplicated
  });

  test('TC2.5.3: HMAC signature sent when secret configured', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
    });
    const policy: ValidationPolicy = {
      ...basePolicy,
      validationHookUrl: 'https://example.com/hook',
      hookSecret: 'topsecret',
    };
    await callValidationHook(policy, {
      request_id: 'req-sig',
      policy_type: 'api_key',
      policy_id: 'pk_test',
      result: { a: 1 },
      schema_valid: true,
      schema_errors: null,
      created_at: new Date().toISOString(),
    });
    const call = fetchSpy.mock.calls[0];
    const headers = call[1].headers as Record<string, string>;
    expect(headers['x-deepthink-signature']).toMatch(/^[0-9a-f]{64}$/);
  });
});
