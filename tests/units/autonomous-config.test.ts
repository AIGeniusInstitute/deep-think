import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-cfg-'));
process.env.DATA_DIR = tmpDir;

const {
  isAutonomousEnabled,
  setAutonomousEnabled,
  getAllAutonomousEnabled,
  isSupervisorEnabled,
  setSupervisorEnabled,
} = await import('../../src/supervisor-config.js');

describe('supervisor-config: autonomous flag persistence', () => {
  beforeAll(() => {
    fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('default state is false', async () => {
    expect(await isAutonomousEnabled('web:nonexistent')).toBe(false);
  });

  test('setAutonomousEnabled(true) persists and reads back', async () => {
    await setAutonomousEnabled('web:test-1', true);
    expect(await isAutonomousEnabled('web:test-1')).toBe(true);
  });

  test('setAutonomousEnabled(false) clears', async () => {
    await setAutonomousEnabled('web:test-2', true);
    expect(await isAutonomousEnabled('web:test-2')).toBe(true);
    await setAutonomousEnabled('web:test-2', false);
    expect(await isAutonomousEnabled('web:test-2')).toBe(false);
  });

  test('getAllAutonomousEnabled returns map of enabled chats', async () => {
    await setAutonomousEnabled('web:multi-1', true);
    await setAutonomousEnabled('web:multi-2', true);
    await setAutonomousEnabled('web:multi-3', false);
    const all = await getAllAutonomousEnabled();
    expect(all['web:multi-1']).toBe(true);
    expect(all['web:multi-2']).toBe(true);
    expect(all['web:multi-3']).toBe(false);
  });

  test('autonomous flag does not interfere with supervisor flag', async () => {
    await setSupervisorEnabled('web:separate', true);
    await setAutonomousEnabled('web:separate', true);
    expect(await isSupervisorEnabled('web:separate')).toBe(true);
    expect(await isAutonomousEnabled('web:separate')).toBe(true);
    // Toggle one off, the other stays
    await setAutonomousEnabled('web:separate', false);
    expect(await isSupervisorEnabled('web:separate')).toBe(true);
    expect(await isAutonomousEnabled('web:separate')).toBe(false);
  });
});

describe('supervisor-config: legacy boolean migration', () => {
  test('setSupervisorEnabled preserves autonomous flag set earlier', async () => {
    // setAutonomousEnabled stores under { autonomous: true }. A subsequent
    // setSupervisorEnabled (which re-reads the normalized shape and writes
    // { ...cur, supervisor: x }) must preserve the autonomous flag.
    await setAutonomousEnabled('web:compat-1', true);
    await setSupervisorEnabled('web:compat-1', true);
    expect(await isAutonomousEnabled('web:compat-1')).toBe(true);
    expect(await isSupervisorEnabled('web:compat-1')).toBe(true);
  });
});
