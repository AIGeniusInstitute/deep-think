import { describe, expect, test } from 'vitest';

import { MessageCreateSchema, GroupPatchSchema, TaskCreateSchema } from '../../src/schemas.js';

describe('schemas: autonomous flag validation', () => {
  describe('MessageCreateSchema', () => {
    test('accepts autonomous=true', () => {
      const r = MessageCreateSchema.safeParse({ chatJid: 'web:x', content: 'hi', autonomous: true });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.autonomous).toBe(true);
    });

    test('accepts autonomous=false (explicit disable)', () => {
      const r = MessageCreateSchema.safeParse({ chatJid: 'web:x', content: 'hi', autonomous: false });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.autonomous).toBe(false);
    });

    test('accepts autonomous=null (explicit disable, even when group enabled)', () => {
      const r = MessageCreateSchema.safeParse({ chatJid: 'web:x', content: 'hi', autonomous: null });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.autonomous).toBeNull();
    });

    test('accepts undefined autonomous (fall back to group config)', () => {
      const r = MessageCreateSchema.safeParse({ chatJid: 'web:x', content: 'hi' });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.autonomous).toBeUndefined();
    });

    test('rejects non-boolean autonomous', () => {
      const r = MessageCreateSchema.safeParse({ chatJid: 'web:x', content: 'hi', autonomous: 'yes' });
      expect(r.success).toBe(false);
    });
  });

  describe('GroupPatchSchema', () => {
    test('accepts autonomous=true', () => {
      const r = GroupPatchSchema.safeParse({ autonomous: true });
      expect(r.success).toBe(true);
    });

    test('accepts autonomous=false', () => {
      const r = GroupPatchSchema.safeParse({ autonomous: false });
      expect(r.success).toBe(true);
    });

    test('accepts no autonomous field (undefined)', () => {
      const r = GroupPatchSchema.safeParse({ name: 'test' });
      expect(r.success).toBe(true);
    });
  });

  describe('TaskCreateSchema', () => {
    test('accepts autonomous=true for agent tasks', () => {
      const r = TaskCreateSchema.safeParse({
        prompt: 'do it',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        execution_type: 'agent',
        autonomous: true,
      });
      expect(r.success).toBe(true);
    });

    test('accepts autonomous=false', () => {
      const r = TaskCreateSchema.safeParse({
        prompt: 'do it',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        execution_type: 'agent',
        autonomous: false,
      });
      expect(r.success).toBe(true);
    });

    test('accepts no autonomous field', () => {
      const r = TaskCreateSchema.safeParse({
        prompt: 'do it',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        execution_type: 'agent',
      });
      expect(r.success).toBe(true);
    });
  });
});
