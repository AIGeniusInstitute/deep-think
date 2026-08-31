/**
 * Open Platform — result-validation pipeline.
 *
 * Wires the two validation stages together for a single model/agent output:
 *   1. JSON Schema stage: parse the result text, validate against the row's
 *      `validation_schema` (ajv, no-throw). Outcome recorded as evidence.
 *   2. Business-hook stage: if a `validation_hook_url` is configured, dispatch
 *      the result to the external business system via result-hooks.ts.
 *
 * The caller (open-platform route) decides what to do on failure based on the
 * policy's `on_schema_fail` / `hook_failure_action`. This module only reports
 * the evidence-backed outcome; it never short-circuits the HTTP response — that
 * is the route's job (Simplicity First: one responsibility per module).
 *
 * Evidence shape follows the v57 trace_steps.evidence_json contract so the
 * caller can write a `validation` trace step directly from this outcome.
 */
import crypto from 'node:crypto';
import { validateJson } from '../graph-engineering/json-schema-validator.js';
import { callValidationHook } from './result-hooks.js';
import type { ValidationPolicy } from '../db.js';

export interface ValidationEvidence {
  type: 'validation';
  stage: 'schema' | 'hook';
  passed: boolean;
  detail: string;
  httpStatus?: number | null;
  latencyMs?: number | null;
  errors?: unknown[] | null;
}

export interface ValidationResultOutcome {
  /** Overall: schema passed AND (no hook configured OR hook accepted). */
  passed: boolean;
  schemaPassed: boolean;
  hookPassed: boolean; // true when no hook configured OR hook accepted
  hookErrored: boolean;
  httpStatus: number | null;
  requestId: string;
  evidence: ValidationEvidence[];
  /** Short human summary for the trace step title / error body. */
  summary: string;
}

/**
 * Run the validation pipeline on a result string. Returns a structured,
 * evidence-backed outcome. Never throws — a thrown validator is captured as a
 * failed schema stage with the error message in evidence.
 */
export async function validateResult(
  policy: ValidationPolicy,
  resultText: string,
  requestId?: string,
): Promise<ValidationResultOutcome> {
  const rid = requestId ?? crypto.randomUUID();
  const evidence: ValidationEvidence[] = [];

  // ── Stage 1: JSON Schema ──
  let schemaPassed = true;
  let parsedData: unknown = null;
  let schemaErrors: unknown[] | null = null;
  if (policy.validationSchema) {
    let schemaObj: Record<string, unknown> = {} as Record<string, unknown>;
    try {
      schemaObj = JSON.parse(policy.validationSchema) as Record<string, unknown>;
    } catch (err) {
      schemaPassed = false;
      schemaErrors = [{ message: `policy schema is not valid JSON: ${(err as Error).message}` }];
      evidence.push({
        type: 'validation',
        stage: 'schema',
        passed: false,
        detail: 'policy schema is not valid JSON (admin misconfiguration)',
        errors: schemaErrors,
      });
    }
    if (schemaPassed) {
      // Try to parse the model output as JSON. If it isn't JSON, schema fails.
      try {
        parsedData = JSON.parse(resultText);
      } catch (err) {
        schemaPassed = false;
        schemaErrors = [{ message: `result is not valid JSON: ${(err as Error).message}` }];
        evidence.push({
          type: 'validation',
          stage: 'schema',
          passed: false,
          detail: 'result text is not JSON (schema expects an object)',
          errors: schemaErrors,
        });
      }
      if (schemaPassed) {
        const res = validateJson(schemaObj, parsedData);
        schemaPassed = res.valid;
        schemaErrors = res.errors;
        evidence.push({
          type: 'validation',
          stage: 'schema',
          passed: res.valid,
          detail: res.valid ? 'schema validation passed' : 'schema validation failed',
          errors: res.errors,
        });
      }
    }
  } else {
    // No schema configured — schema stage is a vacuous pass.
    evidence.push({
      type: 'validation',
      stage: 'schema',
      passed: true,
      detail: 'no validation_schema configured (skipped)',
    });
  }

  // ── Stage 2: business hook ──
  // The hook always receives the result + schema outcome, even when the schema
  // failed — the business system may have its own reconciliation logic.
  const hookOutcome = await callValidationHook(policy, {
    request_id: rid,
    policy_type: policy.policyType,
    policy_id: policy.policyId,
    result: parsedData ?? resultText,
    schema_valid: schemaPassed,
    schema_errors: schemaErrors,
    created_at: new Date().toISOString(),
  });
  evidence.push({
    type: 'validation',
    stage: 'hook',
    passed: hookOutcome.accepted,
    detail: hookOutcome.detail,
    httpStatus: hookOutcome.httpStatus,
    latencyMs: hookOutcome.latencyMs,
  });

  const overallHookPassed = !policy.validationHookUrl ? true : hookOutcome.accepted;
  const passed = schemaPassed && overallHookPassed;

  const summary = passed
    ? 'validation passed'
    : !schemaPassed
      ? `validation failed at schema stage (${(schemaErrors ?? []).length} issue(s))`
      : `validation failed at hook stage: ${hookOutcome.detail}`;

  return {
    passed,
    schemaPassed,
    hookPassed: overallHookPassed,
    hookErrored: hookOutcome.errored,
    httpStatus: hookOutcome.httpStatus,
    requestId: rid,
    evidence,
    summary,
  };
}

/**
 * Decide what the route should do with a validation outcome. Encodes the
 * policy's `on_schema_fail` (schema stage) and `hook_failure_action` (hook
 * stage) into a single directive so the route stays a thin dispatcher.
 *
 * - 'pass': return the result to the client (optionally with a warning header
 *   when validation was configured but tolerated).
 * - 'reject': return 422 with the structured errors (the model output is wrong
 *   and the policy says block).
 * - 'retry': re-call the provider once (bounded to a single retry); the route
 *   re-runs validateResult on the second output and, if it still fails, treats
 *   the second outcome via decideValidationAction with a no-retry fallback.
 */
export function decideValidationAction(
  policy: ValidationPolicy,
  outcome: ValidationResultOutcome,
): { action: 'pass' | 'reject' | 'retry'; status: number; message: string } {
  if (outcome.passed) return { action: 'pass', status: 200, message: outcome.summary };
  // Schema stage governs first.
  if (!outcome.schemaPassed) {
    const onFail = policy.onSchemaFail ?? 'fail';
    if (onFail === 'passthrough') {
      return { action: 'pass', status: 200, message: outcome.summary };
    }
    if (onFail === 'retry') {
      return { action: 'retry', status: 422, message: outcome.summary };
    }
    return { action: 'reject', status: 422, message: outcome.summary };
  }
  // Schema passed but hook failed/errored.
  const hookAction = policy.hookFailureAction ?? 'passthrough';
  if (hookAction === 'passthrough') {
    return { action: 'pass', status: 200, message: outcome.summary };
  }
  if (hookAction === 'retry') {
    return { action: 'retry', status: 422, message: outcome.summary };
  }
  // 'block'
  return { action: 'reject', status: 422, message: outcome.summary };
}
