import { describe, expect, test } from 'vitest';

import { buildAgentProjectClaudeMdContent } from '../../src/container-runner.js';

describe('autonomous: CLAUDE.md directive injection', () => {
  test('returns empty when no systemPrompt and not autonomous', () => {
    const content = buildAgentProjectClaudeMdContent(null, false);
    expect(content).toBe('');
  });

  test('returns empty when no systemPrompt and autonomous=false', () => {
    const content = buildAgentProjectClaudeMdContent(undefined, false);
    expect(content).toBe('');
  });

  test('injects Autonomous Override section when autonomous=true', () => {
    const content = buildAgentProjectClaudeMdContent(null, true);
    expect(content).toContain('Autonomous Override');
    expect(content).toContain('autonomous=true');
    // The 6 numbered rules
    expect(content).toContain('禁止向用户提问');
    expect(content).toContain('AskUserQuestion');
    expect(content).toContain('<assumption>');
    expect(content).toContain('硬刹车');
    expect(content).toContain('任务无法完成');
  });

  test('Autonomous Override appears after Agent Identity section when both present', () => {
    const agentDef = { systemPrompt: 'You are a code reviewer.' } as any;
    const content = buildAgentProjectClaudeMdContent(agentDef, true);
    const identityIdx = content.indexOf('Agent Identity');
    const autonomousIdx = content.indexOf('Autonomous Override');
    expect(identityIdx).toBeGreaterThan(-1);
    expect(autonomousIdx).toBeGreaterThan(-1);
    expect(autonomousIdx).toBeGreaterThan(identityIdx);
  });

  test('Identity Override section is not duplicated by autonomous flag', () => {
    const agentDef = { systemPrompt: 'You are X.' } as any;
    const content = buildAgentProjectClaudeMdContent(agentDef, true);
    const count = (content.match(/Identity Override/g) || []).length;
    expect(count).toBe(1);
  });

  test('autonomous=false does not inject Autonomous Override', () => {
    const agentDef = { systemPrompt: 'You are X.' } as any;
    const content = buildAgentProjectClaudeMdContent(agentDef, false);
    expect(content).not.toContain('Autonomous Override');
    expect(content).toContain('Agent Identity');
  });
});
