import { describe, expect, test } from 'vitest';

import { DESTRUCTIVE_PATTERNS, ASKING_PATTERNS } from '../../container/agent-runner/src/stream-processor.js';

describe('autonomous: destructive command patterns', () => {
  const positives = [
    'rm -rf /',
    'rm -rf /  && echo done',
    'git push --force origin main',
    'git push -f origin',
    'git reset --hard HEAD~3',
    'git checkout -- .',
    'DROP TABLE users;',
    'DROP DATABASE prod;',
    'TRUNCATE TABLE logs;',
    'DELETE FROM users;',
    'mkfs.ext4 /dev/sda1',
    'dd if=/dev/zero of=/dev/sda',
    ':(){ :|:& };:',
  ];

  test.each(positives)('detects destructive: %s', (cmd) => {
    const matches = DESTRUCTIVE_PATTERNS.filter((re) => re.test(cmd));
    expect(matches.length).toBeGreaterThan(0);
  });

  const negatives = [
    'rm -rf ./build',           // rm -rf relative path, not root
    'rm -rf /tmp/mybuild',      // rm -rf /tmp/... is also fine
    'git push origin main',     // normal push
    'git push --force-with-lease origin main',  // safer force push
    'git reset HEAD~3',        // soft reset
    'git checkout .',          // individual files, not "checkout -- ."
    'SELECT * FROM users',     // SELECT, not DELETE
    'DELETE FROM users WHERE id = ?;',  // guarded DELETE
    'echo hello',
    'ls -la',
  ];

  test.each(negatives)('does not flag benign: %s', (cmd) => {
    const matches = DESTRUCTIVE_PATTERNS.filter((re) => re.test(cmd));
    expect(matches.length).toBe(0);
  });
});

describe('autonomous: asking pattern detection', () => {
  test('two asking phrases trigger auto-continue (>=2 matches)', () => {
    const text = '你说一声，要继续哪个方向？';
    const matches = ASKING_PATTERNS.filter((re) => re.test(text));
    // "你说" + "要继续" + ending "？" → ≥2 matches
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  test('ends with half-width ? triggers single pattern', () => {
    const text = '继续吗?';
    const matches = ASKING_PATTERNS.filter((re) => re.test(text));
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  test('ends with full-width ？ triggers single pattern', () => {
    const text = '继续吗？';
    const matches = ASKING_PATTERNS.filter((re) => re.test(text));
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  test('pure declarative text does not match asking patterns', () => {
    const text = '本章已完成，进入下一章节。';
    const matches = ASKING_PATTERNS.filter((re) => re.test(text));
    expect(matches.length).toBe(0);
  });

  test('mid-task progress update does not trigger false positive', () => {
    const text = '已完成 5 万字，正在校对最后一节，估计 2 分钟后交付。';
    const matches = ASKING_PATTERNS.filter((re) => re.test(text));
    expect(matches.length).toBe(0);
  });
});
