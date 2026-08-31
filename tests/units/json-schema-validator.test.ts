import { describe, expect, test } from 'vitest';
import {
  validateJson,
  isSchemaValid,
  type ValidationIssue,
} from '../../src/graph-engineering/json-schema-validator.js';

describe('json-schema-validator (v57)', () => {
  test('TC2.1.1a: valid data passes', () => {
    const schema = { type: 'object', required: ['x'], properties: { x: { type: 'number' } } };
    const res = validateJson(schema, { x: 1 });
    expect(res.valid).toBe(true);
    expect(res.errors).toBeNull();
  });

  test('TC2.1.1b: missing required field fails with a path/message', () => {
    const schema = { type: 'object', required: ['x'] };
    const res = validateJson(schema, { y: 1 });
    expect(res.valid).toBe(false);
    expect(res.errors!.length).toBeGreaterThan(0);
    const detail = JSON.stringify(res.errors);
    expect(detail).toContain('x');
  });

  test('TC2.1.1c: wrong type fails', () => {
    const schema = { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] };
    const res = validateJson(schema, { x: 'not-a-number' });
    expect(res.valid).toBe(false);
  });

  test('TC2.1.2: invalid schema is rejected by isSchemaValid (definition-time)', () => {
    expect(isSchemaValid({ type: 'notAType' })).toBe(false);
    expect(isSchemaValid({ type: 'object', required: ['x'] })).toBe(true);
  });

  test('validateJson on invalid schema returns a $-level error (no throw)', () => {
    const res = validateJson({ type: 'notAType' } as any, { x: 1 });
    expect(res.valid).toBe(false);
    expect(res.errors![0].path).toBe('$');
    expect(res.errors![0].message).toContain('invalid schema');
  });

  test('format validation (ajv-formats) works', () => {
    const schema = { type: 'string', format: 'email' };
    expect(validateJson(schema, 'not-an-email').valid).toBe(false);
    expect(validateJson(schema, 'a@b.com').valid).toBe(true);
  });

  test('errors carry schemaPath for evidence tracing', () => {
    const schema = { type: 'object', required: ['x'] };
    const res = validateJson(schema, {});
    const issue = res.errors![0] as ValidationIssue;
    expect(issue.schemaPath).toBeDefined();
  });
});
