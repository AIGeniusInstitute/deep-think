import { describe, it, expect } from 'vitest';
import { RecoveryState, MAX_RECOVERY_ATTEMPTS, type BrakeType } from '../../container/agent-runner/src/autonomy-recovery.js';

const baseCtx = (over: Partial<Parameters<RecoveryState['request']>[1]> = {}) => ({
  turnCount: 5,
  maxTurns: 50,
  totalTokens: 1000,
  maxTokens: 1_000_000,
  goalSnippet: 'do the task',
  ...over,
});

describe('RecoveryState', () => {
  it('returns non-terminal recovery for the first MAX_RECOVERY_ATTEMPTS hits (AC1.1.1)', () => {
    const s = new RecoveryState();
    // First 3 requests of the same brake → recoverable
    for (let i = 1; i <= MAX_RECOVERY_ATTEMPTS; i++) {
      const r = s.request('loop_detected', baseCtx());
      expect(r.terminal).toBe(false);
      expect(r.attempt).toBe(i);
      expect(r.prompt).toBeTruthy();
    }
    // 4th request → terminal
    const r4 = s.request('loop_detected', baseCtx());
    expect(r4.terminal).toBe(true);
    expect(r4.prompt).toBeUndefined();
  });

  it('counts each brake type independently (AC1.1.2)', () => {
    const s = new RecoveryState();
    // 2 destructive + 1 loop → none terminal (each independent)
    expect(s.request('destructive_command', baseCtx({ destructiveCmd: 'rm -rf /' })).terminal).toBe(false);
    expect(s.request('destructive_command', baseCtx({ destructiveCmd: 'rm -rf /' })).terminal).toBe(false);
    expect(s.request('loop_detected', baseCtx()).terminal).toBe(false);
    // destructive now at attempt 2, loop at attempt 1 — both still have budget
    expect(s.getAttempts('destructive_command')).toBe(2);
    expect(s.getAttempts('loop_detected')).toBe(1);
    expect(s.getAttempts('token_limit')).toBe(0);
  });

  it('decays attempt count after 2 consecutive successful turns (AC1.1.3)', () => {
    const s = new RecoveryState();
    s.request('loop_detected', baseCtx()); // attempt 1
    expect(s.getAttempts('loop_detected')).toBe(1);
    // 1 success not enough
    s.tickSuccess();
    expect(s.getAttempts('loop_detected')).toBe(1);
    // 2nd success → decay by 1
    s.tickSuccess();
    expect(s.getAttempts('loop_detected')).toBe(0);
  });

  it('does not decay below zero', () => {
    const s = new RecoveryState();
    s.tickSuccess();
    s.tickSuccess();
    expect(s.getAttempts('destructive_command')).toBe(0);
  });
});

describe('buildRecovery per-brake strategies', () => {
  it('destructive_command clears the destructive signal and forbids replay', () => {
    const s = new RecoveryState();
    const r = s.request('destructive_command', baseCtx({ destructiveCmd: 'rm -rf /tmp/x' }));
    expect(r.terminal).toBe(false);
    expect(r.clearDestructiveSignal).toBe(true);
    expect(r.strategy).toBe('safe_alternative');
    expect(r.prompt).toContain('安全等价方案');
    expect(r.prompt).toContain('rm -rf /tmp/x');
  });

  it('turn_limit raises the budget tier and requires compaction (AC2.2.1)', () => {
    const s = new RecoveryState();
    const r = s.request('turn_limit', baseCtx({ maxTurns: 50 }));
    expect(r.terminal).toBe(false);
    expect(r.newMaxTurns).toBe(100);
    expect(r.requireCompaction).toBe(true);
    expect(r.strategy).toBe('checkpoint_compact_resume');
  });

  it('turn_limit goes terminal at the hard ceiling 200', () => {
    const s = new RecoveryState();
    // exhaust 3 recoveries at 200 ceiling → terminal
    s.request('turn_limit', baseCtx({ maxTurns: 200 }));
    s.request('turn_limit', baseCtx({ maxTurns: 200 }));
    s.request('turn_limit', baseCtx({ maxTurns: 200 }));
    const r4 = s.request('turn_limit', baseCtx({ maxTurns: 200 }));
    expect(r4.terminal).toBe(true);
  });

  it('token_limit requires compaction and is recoverable (AC2.3.1)', () => {
    const s = new RecoveryState();
    const r = s.request('token_limit', baseCtx({ totalTokens: 1_000_000, maxTokens: 1_000_000 }));
    expect(r.terminal).toBe(false);
    expect(r.requireCompaction).toBe(true);
    expect(r.strategy).toBe('force_compact_resume');
    expect(r.prompt).toContain('凝结');
  });

  it('loop_detected clears the hash window and demands a pivot (AC2.4)', () => {
    const s = new RecoveryState();
    const r = s.request('loop_detected', baseCtx());
    expect(r.terminal).toBe(false);
    expect(r.clearHashWindow).toBe(true);
    expect(r.strategy).toBe('reflect_and_pivot');
    expect(r.prompt).toContain('循环');
    expect(r.prompt).toContain('不同方法');
  });

  it('all four brake types produce a prompt until exhausted', () => {
    const brakes: BrakeType[] = ['destructive_command', 'turn_limit', 'token_limit', 'loop_detected'];
    for (const b of brakes) {
      const s = new RecoveryState();
      const r = s.request(b, b === 'destructive_command' ? baseCtx({ destructiveCmd: 'x' }) : baseCtx());
      expect(r.terminal).toBe(false);
      expect(typeof r.prompt).toBe('string');
      expect(r.prompt!.length).toBeGreaterThan(20);
    }
  });
});
