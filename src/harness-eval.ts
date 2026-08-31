/**
 * Harness Eval Runner — behavior-evidence-based scoring for harness versions.
 *
 * Design notes (see docs/tech_solution/self-evolving-harness/TECH-SOLUTION.md §3.2):
 * - The eval runner is NOT versioned — it stays in code as the external judge
 *   (SEAGym pattern) to avoid the bootstrapping paradox.
 * - Each case runs as a single-turn sdkQuery (maxTurns=1, no tools) so the
 *   eval measures prompt response quality, not tool-call luck.
 * - Verdict is based on assertion matches against the response text — pure
 *   behavior evidence, no proposal-argument reading (Self-Harness philosophy).
 * - Trace: each case creates one chat_trace_nodes row under a synthetic
 *   chat_jid (harness-eval:{version_id}:{case_id}) so the evidence is
 *   inspectable later via the existing chat-trace UI.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import yaml from 'yaml';

import {
  createHarnessEvalRun,
  listHarnessEvalCases,
  listHarnessEvalRuns,
  upsertHarnessEvalCase,
  updateHarnessEvalRun,
  type HarnessEvalCaseRow,
  type HarnessEvalRunRow,
} from './db.js';
import { DATA_DIR, HARNESS_EVAL_CASES_SRC_DIR } from './config.js';
import { upsertChatTraceNode } from './db.js';
import { sdkQuery } from './sdk-query.js';
import { validateJson } from './graph-engineering/json-schema-validator.js';
import { logger } from './logger.js';

export const EVAL_CASES_DIR = path.join(DATA_DIR, 'harness', 'eval-cases');

export type AssertionKind =
  | 'contains'
  | 'not_contains'
  | 'regex'
  | 'no_error'
  // v58 — structured / semantic assertions (P3).
  | 'json_schema'   // value = JSON Schema text; response parsed & validated
  | 'json_path'     // value = $.path; expected/operator compare extracted value
  | 'numeric_range' // value = $.path (or '' for whole response as number); min/max
  | 'llm_judge';    // value = judge rubric prompt; requires async LLM judge

export interface EvalAssertion {
  kind: AssertionKind;
  value: string;
  /** json_path operator: equals | contains | exists. Default 'equals'. */
  operator?: 'equals' | 'contains' | 'exists';
  /** json_path/numeric_range expected value (string). */
  expected?: string;
  /** numeric_range bounds (inclusive). */
  min?: number;
  max?: number;
}

export interface EvalRubric {
  weights?: Record<string, number>;
  pass_threshold: number;
}

export interface EvalCase {
  case_id: string;
  name: string;
  prompt: string;
  assertions: EvalAssertion[];
  rubric: EvalRubric;
}

export interface EvalCaseResult {
  case_id: string;
  name: string;
  pass: boolean;
  score: number;
  trace_chat_jid: string;
  trace_node_id: number;
  evidence_summary: string;
  error?: string;
}

export interface EvalAggregate {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  score: number; // 0..1
  results: EvalCaseResult[];
}

/** Parse a YAML case file into an EvalCase. */
export function parseCaseYaml(raw: string): EvalCase | null {
  try {
    const obj = yaml.parse(raw) as any;
    if (!obj || !obj.case_id || !obj.prompt || !Array.isArray(obj.assertions)) {
      return null;
    }
    const assertions: EvalAssertion[] = obj.assertions
      .map((a: any) => ({
        kind: a.kind as AssertionKind,
        value: String(a.value ?? ''),
        operator: a.operator as EvalAssertion['operator'],
        expected: a.expected != null ? String(a.expected) : undefined,
        min: a.min != null ? Number(a.min) : undefined,
        max: a.max != null ? Number(a.max) : undefined,
      }))
      .filter((a: EvalAssertion) =>
        [
          'contains', 'not_contains', 'regex', 'no_error',
          'json_schema', 'json_path', 'numeric_range', 'llm_judge',
        ].includes(a.kind),
      );
    const rubric: EvalRubric = {
      weights: obj.rubric?.weights ?? { default: 1.0 },
      pass_threshold: Number(obj.rubric?.pass_threshold ?? 1.0),
    };
    return {
      case_id: obj.case_id,
      name: obj.name ?? obj.case_id,
      prompt: String(obj.prompt),
      assertions,
      rubric,
    };
  } catch {
    return null;
  }
}

/** Load all eval cases from the tracked source dir (config/harness/eval-cases/)
 *  AND the runtime data dir (data/harness/eval-cases/), then upsert into DB.
 *  Source dir is tracked in git; runtime dir is for user-added ad-hoc cases. */
export function loadAndSyncEvalCases(): EvalCase[] {
  const cases: EvalCase[] = [];
  const seen = new Set<string>();
  const dirs = [HARNESS_EVAL_CASES_SRC_DIR, EVAL_CASES_DIR];
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    } catch {
      continue;
    }
    for (const f of files) {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      const c = parseCaseYaml(raw);
      if (c && !seen.has(c.case_id)) {
        seen.add(c.case_id);
        cases.push(c);
        upsertHarnessEvalCase({
          caseId: c.case_id,
          name: c.name,
          prompt: c.prompt,
          assertionsJson: JSON.stringify(c.assertions),
          rubricJson: JSON.stringify(c.rubric),
          enabled: true,
        });
      }
    }
  }
  return cases;
}

/** Load cases from DB (already synced by loadAndSyncEvalCases on startup). */
export function loadEvalCasesFromDb(enabledOnly = true): EvalCase[] {
  return listHarnessEvalCases(enabledOnly).map((row) => ({
    case_id: row.case_id,
    name: row.name,
    prompt: row.prompt,
    assertions: JSON.parse(row.assertions_json) as EvalAssertion[],
    rubric: JSON.parse(row.rubric_json) as EvalRubric,
  }));
}

/**
 * Extract a value via a simple dot/bracket JSON path (`$.a.b[0].c`).
 * Returns undefined if the path cannot be resolved. Kept dependency-free
 * (Simplicity First) — covers the structured-assertion use cases; a full
 * JSONPath grammar is out of scope for the eval harness.
 */
export function extractJsonPath(obj: unknown, pathStr: string): unknown {
  if (!pathStr) return obj;
  let p = pathStr.trim();
  if (p.startsWith('$.')) p = p.slice(2);
  else if (p === '$') return obj;
  const tokens = p.match(/[^.\[\]]+|\[\d+\]/g);
  if (!tokens) return undefined;
  let cur: unknown = obj;
  for (const tok of tokens) {
    if (cur == null) return undefined;
    if (tok.startsWith('[') && tok.endsWith(']')) {
      const idx = Number(tok.slice(1, -1));
      cur = Array.isArray(cur) ? cur[idx] : undefined;
    } else {
      cur = (cur as Record<string, unknown>)[tok];
    }
  }
  return cur;
}

/** LLM judge signature — injected by the caller (keeps harness-eval pure). */
export type LlmJudge = (rubricPrompt: string, responseText: string) => Promise<{ pass: boolean; detail: string }>;

/** Score a single assertion against response text. Pure function (unit-testable)
 *  for all sync kinds; llm_judge returns a placeholder (use scoreCaseAsync). */
export function scoreAssertion(
  assertion: EvalAssertion,
  responseText: string,
  hadError: boolean,
): { pass: boolean; detail: string } {
  switch (assertion.kind) {
    case 'contains': {
      const pass = responseText.includes(assertion.value);
      return { pass, detail: pass ? `found "${assertion.value}"` : `missing "${assertion.value}"` };
    }
    case 'not_contains': {
      const pass = !responseText.includes(assertion.value);
      return { pass, detail: pass ? `absent "${assertion.value}"` : `present "${assertion.value}"` };
    }
    case 'regex': {
      let pass = false;
      try {
        pass = new RegExp(assertion.value).test(responseText);
      } catch {
        pass = false;
      }
      return { pass, detail: pass ? `matched /${assertion.value}/` : `no match /${assertion.value}/` };
    }
    case 'no_error': {
      const pass = !hadError;
      return { pass, detail: pass ? 'no error' : 'had error' };
    }
    case 'json_schema': {
      // Reuse the v57 result-validation engine. No-throw: a malformed schema
      // or non-JSON response yields a structured failure, not a crash.
      let schemaObj: Record<string, unknown>;
      try {
        schemaObj = JSON.parse(assertion.value) as Record<string, unknown>;
      } catch (err) {
        return { pass: false, detail: `invalid schema JSON: ${(err as Error).message}` };
      }
      let data: unknown;
      try {
        data = JSON.parse(responseText);
      } catch (err) {
        return { pass: false, detail: `response not JSON: ${(err as Error).message}` };
      }
      const res = validateJson(schemaObj, data);
      return {
        pass: res.valid,
        detail: res.valid ? 'json_schema passed' : `json_schema failed: ${(res.errors ?? []).map((e) => e.message).join('; ')}`,
      };
    }
    case 'json_path': {
      let data: unknown;
      try {
        data = JSON.parse(responseText);
      } catch (err) {
        return { pass: false, detail: `response not JSON: ${(err as Error).message}` };
      }
      const val = extractJsonPath(data, assertion.value);
      const op = assertion.operator ?? 'equals';
      if (op === 'exists') {
        const pass = val !== undefined;
        return { pass, detail: pass ? `${assertion.value} exists` : `${assertion.value} missing` };
      }
      const got = val == null ? '' : String(val);
      if (op === 'contains') {
        const pass = got.includes(assertion.expected ?? '');
        return { pass, detail: `${assertion.value}="${got}" ${pass ? 'contains' : '!contains'} "${assertion.expected}"` };
      }
      // equals
      const pass = got === (assertion.expected ?? '');
      return { pass, detail: `${assertion.value}="${got}" ${pass ? '==' : '!='} "${assertion.expected}"` };
    }
    case 'numeric_range': {
      let data: unknown;
      try {
        data = JSON.parse(responseText);
      } catch (err) {
        return { pass: false, detail: `response not JSON: ${(err as Error).message}` };
      }
      const raw = assertion.value ? extractJsonPath(data, assertion.value) : data;
      const num = Number(raw);
      if (Number.isNaN(num)) {
        return { pass: false, detail: `${assertion.value || '$'} not numeric (got ${JSON.stringify(raw)})` };
      }
      const aboveMin = assertion.min == null || num >= assertion.min;
      const belowMax = assertion.max == null || num <= assertion.max;
      const pass = aboveMin && belowMax;
      return {
        pass,
        detail: `${assertion.value || '$'}=${num} ${pass ? 'in' : 'out of'} range[${assertion.min ?? '-∞'}, ${assertion.max ?? '+∞'}]`,
      };
    }
    case 'llm_judge':
      // Requires an async judge — sync scorer marks it as skipped.
      return { pass: false, detail: 'llm_judge requires async judge (use scoreCaseAsync)' };
    default:
      return { pass: false, detail: `unknown kind ${assertion.kind}` };
  }
}

/** Score all assertions for a case; pass if score >= rubric.pass_threshold. */
export function scoreCase(
  evalCase: EvalCase,
  responseText: string,
  hadError: boolean,
): { pass: boolean; score: number; details: string[] } {
  const details: string[] = [];
  let passed = 0;
  let total = 0;
  for (const a of evalCase.assertions) {
    total += 1;
    const r = scoreAssertion(a, responseText, hadError);
    if (r.pass) passed += 1;
    details.push(`[${r.pass ? 'PASS' : 'FAIL'}] ${a.kind}: ${r.detail}`);
  }
  const score = total === 0 ? 0 : passed / total;
  const pass = total > 0 && score >= evalCase.rubric.pass_threshold;
  return { pass, score, details };
}

/**
 * Async variant that supports `llm_judge` assertions via an injected judge.
 * Sync kinds reuse scoreAssertion; llm_judge kinds call `judge` (when provided;
 * otherwise scored as failed). The harness runner passes a real sdkQuery-backed
 * judge; unit tests pass a stub.
 */
export async function scoreCaseAsync(
  evalCase: EvalCase,
  responseText: string,
  hadError: boolean,
  judge?: LlmJudge,
): Promise<{ pass: boolean; score: number; details: string[] }> {
  const details: string[] = [];
  let passed = 0;
  let total = 0;
  for (const a of evalCase.assertions) {
    total += 1;
    let r: { pass: boolean; detail: string };
    if (a.kind === 'llm_judge') {
      if (!judge) {
        r = { pass: false, detail: 'llm_judge: no judge configured' };
      } else {
        try {
          r = await judge(a.value, responseText);
        } catch (err) {
          r = { pass: false, detail: `llm_judge error: ${(err as Error).message}` };
        }
      }
    } else {
      r = scoreAssertion(a, responseText, hadError);
    }
    if (r.pass) passed += 1;
    details.push(`[${r.pass ? 'PASS' : 'FAIL'}] ${a.kind}: ${r.detail}`);
  }
  const score = total === 0 ? 0 : passed / total;
  const pass = total > 0 && score >= evalCase.rubric.pass_threshold;
  return { pass, score, details };
}

/** Trace chat_jid convention: harness-eval:{versionId}:{caseId}. */
export function traceChatJid(versionId: string, caseId: string): string {
  return `harness-eval:${versionId}:${caseId}`;
}

/** Run a single case against a response (no sdkQuery call). Exported for unit tests. */
export function runCaseAgainstResponse(
  evalCase: EvalCase,
  responseText: string,
  hadError: boolean,
): EvalCaseResult {
  const chatJid = traceChatJid('test', evalCase.case_id);
  const { pass, score, details } = scoreCase(evalCase, responseText, hadError);
  return {
    case_id: evalCase.case_id,
    name: evalCase.name,
    pass,
    score,
    trace_chat_jid: chatJid,
    trace_node_id: 0,
    evidence_summary: details.join('\n'),
  };
}

/** Run eval for a version: invoke sdkQuery for each case, score, persist.
 *  Returns the aggregate + per-case results. */
export async function runEvalForVersion(
  versionId: string,
  opts: { caseIds?: string[]; proposalId?: string | null; timeoutMs?: number } = {},
): Promise<{ runs: HarnessEvalRunRow[]; aggregate: EvalAggregate }> {
  const cases = loadEvalCasesFromDb(true).filter(
    (c) => !opts.caseIds || opts.caseIds.includes(c.case_id),
  );
  const results: EvalCaseResult[] = [];
  const runs: HarnessEvalRunRow[] = [];

  for (const evalCase of cases) {
    const runId = `er_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const startedAt = new Date().toISOString();
    const chatJid = traceChatJid(versionId, evalCase.case_id);
    createHarnessEvalRun({
      id: runId,
      versionId,
      proposalId: opts.proposalId ?? null,
      caseId: evalCase.case_id,
      startedAt,
    });

    try {
      const response = await sdkQuery(evalCase.prompt, {
        timeout: opts.timeoutMs ?? 60_000,
      });
      const hadError = response === null;
      const responseText = response ?? '';
      const { pass, score, details } = scoreCase(evalCase, responseText, hadError);

      // Persist a trace node so the evidence is inspectable later.
      const nodeId = Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 1000);
      upsertChatTraceNode({
        id: nodeId,
        chat_jid: chatJid,
        node_type: 'turn',
        title: `[harness-eval] ${evalCase.name}`,
        input_summary: evalCase.prompt.slice(0, 800),
        output_summary: responseText.slice(0, 800),
        tokens: 0,
        status: pass ? 'pass' : 'fail',
        started_at: startedAt,
        ended_at: new Date().toISOString(),
      });

      const finishedAt = new Date().toISOString();
      updateHarnessEvalRun(runId, {
        status: 'completed',
        pass: pass ? 1 : 0,
        score,
        traceNodeRootId: nodeId,
        finishedAt,
      });

      results.push({
        case_id: evalCase.case_id,
        name: evalCase.name,
        pass,
        score,
        trace_chat_jid: chatJid,
        trace_node_id: nodeId,
        evidence_summary: details.join('\n'),
      });
    } catch (err) {
      const finishedAt = new Date().toISOString();
      const errorMsg = (err as Error).message?.slice(0, 500) ?? 'unknown error';
      updateHarnessEvalRun(runId, {
        status: 'failed',
        pass: 0,
        score: 0,
        finishedAt,
        error: errorMsg,
      });
      results.push({
        case_id: evalCase.case_id,
        name: evalCase.name,
        pass: false,
        score: 0,
        trace_chat_jid: chatJid,
        trace_node_id: 0,
        evidence_summary: `error: ${errorMsg}`,
        error: errorMsg,
      });
      logger.warn({ err: errorMsg, caseId: evalCase.case_id, versionId }, 'harness eval case failed');
    }
    runs.push(listHarnessEvalRuns({ versionId, limit: 500 }).find((r) => r.id === runId)!);
  }

  const aggregate: EvalAggregate = {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass && !r.error).length,
    errored: results.filter((r) => !!r.error).length,
    score: results.length === 0 ? 0 : results.reduce((s, r) => s + r.score, 0) / results.length,
    results,
  };
  return { runs, aggregate };
}

/** List eval runs from DB. */
export function listEvalRuns(
  opts: { versionId?: string; proposalId?: string; limit?: number } = {},
): HarnessEvalRunRow[] {
  return listHarnessEvalRuns(opts);
}
