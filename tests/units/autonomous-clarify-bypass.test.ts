import { describe, expect, test } from 'vitest';

import { parseDecision } from '../../src/supervisor.js';

describe('supervisor: autonomous mode clarify bypass', () => {
  test('autonomous flag downgrades clarify to delegate', () => {
    const d = parseDecision('{"action":"clarify","question":"哪个项目?"}', { autonomous: true });
    expect(d?.action).toBe('delegate');
    // Question is dropped — agent receives no clarification prompt and proceeds
    // with its own best-judgment assumptions.
    expect(d?.question).toBeUndefined();
    expect(d?.reason).toBe('autonomous_downgrade');
  });

  test('autonomous flag preserves explicit instruction when present', () => {
    const d = parseDecision(
      '{"action":"clarify","question":"哪个项目?","instruction":"按假设推进"}',
      { autonomous: true },
    );
    expect(d?.action).toBe('delegate');
    expect(d?.instruction).toBe('按假设推进');
  });

  test('autonomous flag does not touch non-clarify actions', () => {
    const cases = [
      { input: '{"action":"delegate","instruction":"跑测试"}', expectedAction: 'delegate' },
      { input: '{"action":"auto","instruction":"优化后"}', expectedAction: 'auto' },
    ];
    for (const c of cases) {
      const d = parseDecision(c.input, { autonomous: true });
      expect(d?.action).toBe(c.expectedAction);
    }
  });

  test('without autonomous flag, clarify stays clarify', () => {
    const d = parseDecision('{"action":"clarify","question":"哪个项目?"}');
    expect(d?.action).toBe('clarify');
    expect(d?.question).toBe('哪个项目?');
  });
});
