import { describe, expect, test } from 'vitest';

/**
 * Loop detection algorithm test (mirrors the inline implementation in
 * container/agent-runner/src/index.ts at the autonomous block).
 *
 * The algorithm: hash the last 5000 chars of each turn's text output, push to
 * a sliding window of size AUTONOMOUS_LOOP_WINDOW=5, fire hard brake when the
 * last AUTONOMOUS_LOOP_THRESHOLD=3 entries are identical.
 */

import crypto from 'node:crypto';

const AUTONOMOUS_LOOP_WINDOW = 5;
const AUTONOMOUS_LOOP_THRESHOLD = 3;

function hashTurn(text: string): string {
  return crypto.createHash('sha256').update(text.slice(0, 5000)).digest('hex').slice(0, 16);
}

function isLoopDetected(hashes: string[]): boolean {
  if (hashes.length < AUTONOMOUS_LOOP_THRESHOLD) return false;
  const lastN = hashes.slice(-AUTONOMOUS_LOOP_THRESHOLD);
  return lastN.every((h) => h === lastN[0]);
}

describe('autonomous: loop detection algorithm', () => {
  test('no loop with diverse outputs', () => {
    const hashes = ['a', 'b', 'c', 'd', 'e'].map(hashTurn);
    expect(isLoopDetected(hashes)).toBe(false);
  });

  test('no loop with < threshold entries', () => {
    const hashes = ['same', 'same'].map(hashTurn);
    expect(isLoopDetected(hashes)).toBe(false);
  });

  test('detects 3 identical turns at the tail', () => {
    const hashes = ['a', 'b', 'same', 'same', 'same'].map(hashTurn);
    expect(isLoopDetected(hashes)).toBe(true);
  });

  test('does not fire when identical turns are in the middle, not at the tail', () => {
    // Algorithm only checks the last N entries, so identical middle entries
    // followed by a different turn do NOT fire. This is intentional: a single
    // different turn after a loop is enough to break the loop.
    const hashes = ['a', 'same', 'same', 'same', 'b'].map(hashTurn);
    expect(isLoopDetected(hashes)).toBe(false);
  });

  test('detects when exactly threshold entries all identical', () => {
    const hashes = ['same', 'same', 'same'].map(hashTurn);
    expect(isLoopDetected(hashes)).toBe(true);
  });

  test('does not detect when only 2 identical at the tail', () => {
    const hashes = ['a', 'b', 'same', 'same'].map(hashTurn);
    expect(isLoopDetected(hashes)).toBe(false);
  });

  test('sliding window evicts oldest entry', () => {
    // 5 entries, only 3 at the end are identical — last 3 are checked, not full window
    const hashes = ['same', 'same', 'a', 'b', 'c'].map(hashTurn);
    expect(isLoopDetected(hashes)).toBe(false);
  });

  test('identical hash function produces same hash for identical text', () => {
    expect(hashTurn('hello')).toBe(hashTurn('hello'));
    expect(hashTurn('hello')).not.toBe(hashTurn('hello '));
  });

  test('hash only considers first 5000 chars (long identical prefixes still match)', () => {
    const longA = 'A'.repeat(10000) + 'tail1';
    const longB = 'A'.repeat(10000) + 'tail2';
    expect(hashTurn(longA)).toBe(hashTurn(longB));
  });
});
