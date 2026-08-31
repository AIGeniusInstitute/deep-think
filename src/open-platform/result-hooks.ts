/**
 * Open Platform — outbound business validation-hook caller.
 *
 * When an api_key / agent_definition declares a `validation_hook_url`, the
 * result-validation pipeline (result-validation.ts) calls this module to
 * dispatch the model/agent output to an external business system, which applies
 * domain rules the platform itself cannot encode in JSON Schema.
 *
 * Design (SOLUTION §2.4 / §2.5):
 * - HMAC-SHA256 request signing with the row's `hook_secret` (constant-time
 *   compare on the receiver side is the receiver's job; we only sign).
 * - 10s HTTP timeout, 3 attempts with exponential backoff (200ms / 400ms).
 * - Idempotency: payload carries `request_id`; `webhook_calls` table dedupes
 *   by (policy_type, policy_id, request_id) — a retried dispatch overwrites the
 *   prior record rather than inserting a duplicate.
 * - SSRF: reuses url-safety.ts — http(s) only, no private/link-local hosts.
 *
 * Returns a structured outcome so the caller (trace step) can record evidence.
 */
import crypto from 'node:crypto';
import { validateSafeHttpsUrl } from '../url-safety.js';
import {
  recordWebhookCall,
  type ValidationPolicy,
} from '../db.js';
import { logger } from '../logger.js';

export interface HookPayload {
  request_id: string;
  policy_type: 'api_key' | 'agent_def';
  policy_id: string;
  result: unknown; // the model/agent output being validated
  schema_valid: boolean; // outcome of the JSON Schema stage (already run)
  schema_errors: unknown[] | null;
  created_at: string;
}

export interface HookOutcome {
  /** Did the hook accept the result? (2xx + body {accept:true} or 2xx default). */
  accepted: boolean;
  /** Did the hook itself error (timeout / non-2xx / unparseable)? */
  errored: boolean;
  httpStatus: number | null;
  detail: string;
  latencyMs: number | null;
  attempts: number;
}

const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 200;

function sign(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Call the configured validation hook. Safe to call with a null/empty url —
 * returns a passthrough outcome (accepted=true, errored=false) so the pipeline
 * can treat "no hook configured" uniformly.
 */
export async function callValidationHook(
  policy: ValidationPolicy,
  payload: HookPayload,
): Promise<HookOutcome> {
  const url = policy.validationHookUrl;
  if (!url) {
  return {
      accepted: true,
      errored: false,
      httpStatus: null,
      detail: 'no hook configured (passthrough)',
      latencyMs: null,
      attempts: 0,
    };
  }
  // SSRF guardrail (SOLUTION §2.4): http(s) only, no private/link-local hosts.
  const urlErr = validateSafeHttpsUrl(url, { allowHttp: true });
  if (urlErr) {
    const outcome: HookOutcome = {
      accepted: false,
      errored: true,
      httpStatus: null,
      detail: `hook url rejected: ${urlErr}`,
      latencyMs: null,
      attempts: 0,
    };
    recordWebhookCall({
      policyType: policy.policyType,
      policyId: policy.policyId,
      requestId: payload.request_id,
      url,
      httpStatus: null,
      responseSummary: null,
      error: outcome.detail,
      latencyMs: null,
    });
    return outcome;
  }

  const body = JSON.stringify(payload);
  const secret = policy.hookSecret ?? '';
  const sig = secret ? sign(secret, body) : '';

  let lastErr = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-deepthink-request-id': payload.request_id,
      };
      if (sig) headers['x-deepthink-signature'] = sig;
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const latencyMs = Date.now() - started;
      const text = await res.text().catch(() => '');
      const summary = text.slice(0, 500);
      // 2xx = hook responded. Body may explicitly set {accept:false} to reject.
      let accepted = res.ok;
      let detail = `http ${res.status}`;
      if (res.ok && text) {
        try {
          const parsed = JSON.parse(text) as { accept?: boolean; reason?: string };
          if (typeof parsed.accept === 'boolean') {
            accepted = parsed.accept;
            detail = parsed.reason ? `hook rejected: ${parsed.reason}` : `hook accept=${accepted}`;
          }
        } catch {
          // non-JSON 2xx body: treat as accepted (hook did not object).
        }
      }
      const errored = !res.ok;
      recordWebhookCall({
        policyType: policy.policyType,
        policyId: policy.policyId,
        requestId: payload.request_id,
        url,
        httpStatus: res.status,
        responseSummary: summary,
        error: errored ? `http ${res.status}` : null,
        latencyMs,
      });
      // On hook error (5xx/timeout-aborted), retry. On 4xx (client-config
      // mistake) or explicit accept=false, do NOT retry — surface to caller.
      if (errored && res.status >= 500 && attempt < MAX_ATTEMPTS) {
        lastErr = `http ${res.status}`;
        await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      return { accepted, errored, httpStatus: res.status, detail, latencyMs, attempts: attempt };
    } catch (err) {
      clearTimeout(timer);
      const latencyMs = Date.now() - started;
      lastErr = (err as Error).name === 'AbortError' ? `timeout (${TIMEOUT_MS}ms)` : (err as Error).message;
      recordWebhookCall({
        policyType: policy.policyType,
        policyId: policy.policyId,
        requestId: payload.request_id,
        url,
        httpStatus: null,
        responseSummary: null,
        error: lastErr,
        latencyMs,
      });
      if (attempt < MAX_ATTEMPTS) {
        await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
    }
  }
  return {
    accepted: false,
    errored: true,
    httpStatus: null,
    detail: `hook failed after ${MAX_ATTEMPTS} attempts: ${lastErr}`,
    latencyMs: null,
    attempts: MAX_ATTEMPTS,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Re-export for tests that want to inspect the signer without going to network.
export const __sign = sign;
