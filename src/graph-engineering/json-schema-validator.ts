/**
 * JSON Schema validation engine for result-checking nodes.
 *
 * Consumes the `outputSchema` field declared on Graph nodes (DSL v2) and on
 * Open Platform result-validation policies. Uses ajv (Draft-07) with common
 * formats. Exposes a pure-function `validateJson` (no throw) plus `isSchemaValid`
 * for definition-time schema checks, and `compileSchema` for reuse.
 *
 * Why a dedicated module: prior to v57, `GraphNode.outputSchema` was declared
 * (graph-types.ts) but never consumed — runner did not validate node output
 * against it, and the UI had no schema editor. This module is the single seam
 * that turns that dead field into enforced validation.
 */

import { Ajv } from 'ajv';
import * as addFormatsNS from 'ajv-formats';

const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false });
// ajv-formats ships a CJS default export; under NodeNext+esModuleInterop the
// default surfaces on the namespace object.
const addFormats: (ajv: Ajv, opts?: unknown) => void =
  (addFormatsNS as any).default ?? (addFormatsNS as any);
addFormats(ajv);

export interface ValidationIssue {
  /** JSON pointer path of the failing data (root = '$'). */
  path: string;
  /** Human-readable failure reason. */
  message: string;
  /** Schema location that produced the rule, for evidence tracing. */
  schemaPath?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[] | null;
}

/**
 * Validate `data` against a JSON Schema. Never throws — an invalid schema
 * yields a single `$`-level error so the caller can surface it without a
 * try/catch. Returned `errors` are flat + ordered for trace evidence.
 */
export function validateJson(
  schema: Record<string, unknown>,
  data: unknown,
): ValidationResult {
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (err) {
    return {
      valid: false,
      errors: [
        { path: '$', message: `invalid schema: ${(err as Error).message}` },
      ],
    };
  }
  const valid = validate(data) as boolean;
  if (valid) return { valid: true, errors: null };
  const errors: ValidationIssue[] = (validate.errors ?? []).map((e: any) => ({
    path: e.instancePath || '$',
    message: e.message ?? 'validation failed',
    schemaPath: e.schemaPath,
  }));
  return { valid: false, errors };
}

/** Definition-time check: does the schema itself compile? Used by
 *  validateDefinition to reject malformed node registrations early. */
export function isSchemaValid(schema: Record<string, unknown>): boolean {
  try {
    ajv.compile(schema);
    return true;
  } catch {
    return false;
  }
}

/** Compile a schema for repeated validation (returns an ajv validate fn). */
export function compileSchema(schema: Record<string, unknown>) {
  return ajv.compile(schema);
}
