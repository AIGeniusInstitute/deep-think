/**
 * /skill IM command tests — verifies argument parsing, owner→userId resolution
 * via group.created_by, skill lookup, and reply truncation. getSkillDetail and
 * debugSkill are stubbed so no filesystem/LLM access is needed.
 */
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { handleSkillImCommand } from '../../src/skill-im-command.js';

const getSkillDetail = vi.fn();
const debugSkill = vi.fn();

function deps() {
  return { getSkillDetail, debugSkill };
}

const GROUP = { created_by: 'u_owner_123' } as any;

beforeEach(() => {
  getSkillDetail.mockReset();
  debugSkill.mockReset();
});

describe('handleSkillImCommand', () => {
  test('valid skill + input → runs debugSkill real and returns output', async () => {
    getSkillDetail.mockReturnValue({ enabled: true, content: '# skill' });
    debugSkill.mockResolvedValue({ output: 'result text', durationMs: 100, mode: 'real' });

    const reply = await handleSkillImCommand(
      'g1',
      'code-review please review this code',
      GROUP,
      deps(),
    );

    expect(getSkillDetail).toHaveBeenCalledWith('code-review', 'u_owner_123');
    expect(debugSkill).toHaveBeenCalledWith(
      '# skill',
      'please review this code',
      'real',
      { chatJid: 'g1', label: 'Skill: code-review' },
    );
    expect(reply).toBe('result text');
  });

  test('missing arguments → usage hint', async () => {
    const reply = await handleSkillImCommand('g2', '', GROUP, deps());
    expect(reply).toContain('用法');
    expect(getSkillDetail).not.toHaveBeenCalled();
  });

  test('missing input only → usage hint', async () => {
    const reply = await handleSkillImCommand('g3', 'code-review', GROUP, deps());
    expect(reply).toContain('用法');
  });

  test('group without created_by → error', async () => {
    const reply = await handleSkillImCommand('g4', 'sid input', { created_by: null }, deps());
    expect(reply).toContain('未关联 DeepThink 账号');
    expect(getSkillDetail).not.toHaveBeenCalled();
  });

  test('skill not found → error', async () => {
    getSkillDetail.mockReturnValue(null);
    const reply = await handleSkillImCommand('g5', 'nope do thing', GROUP, deps());
    expect(reply).toContain('未找到 Skill');
    expect(debugSkill).not.toHaveBeenCalled();
  });

  test('disabled skill → error', async () => {
    getSkillDetail.mockReturnValue({ enabled: false, content: '# x' });
    const reply = await handleSkillImCommand('g6', 'sid input', GROUP, deps());
    expect(reply).toContain('已禁用');
    expect(debugSkill).not.toHaveBeenCalled();
  });

  test('debugSkill error → prefixed error reply', async () => {
    getSkillDetail.mockReturnValue({ enabled: true, content: '# s' });
    debugSkill.mockResolvedValue({ error: 'provider unavailable' });
    const reply = await handleSkillImCommand('g7', 'sid input', GROUP, deps());
    expect(reply).toContain('provider unavailable');
    expect(reply.startsWith('⚠️')).toBe(true);
  });

  test('long output is truncated with marker', async () => {
    getSkillDetail.mockReturnValue({ enabled: true, content: '# s' });
    debugSkill.mockResolvedValue({ output: 'x'.repeat(5000), durationMs: 1, mode: 'real' });
    const reply = await handleSkillImCommand('g8', 'sid input', GROUP, deps());
    expect(reply.length).toBeLessThan(5000);
    expect(reply).toContain('已截断');
  });
});
