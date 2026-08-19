import { describe, it, expect } from 'vitest';
import { classifyGap, buildGapResolutionPrompt, type GapKind } from '../../container/agent-runner/src/gap-resolver.js';

describe('classifyGap', () => {
  it('classifies factual questions as knowledge_gap', () => {
    expect(classifyGap('请问 Node.js 22 是否支持 fetch API？')).toBe('knowledge_gap');
    expect(classifyGap('这个库的最新版本是多少？')).toBe('knowledge_gap');
    expect(classifyGap('how do I configure webpack for ESM?')).toBe('knowledge_gap');
    expect(classifyGap('which version of React supports server components?')).toBe('knowledge_gap');
  });

  it('classifies missing-capability asks as tool_gap', () => {
    expect(classifyGap('我缺少一个可以解析 PDF 的工具，要安装吗？')).toBe('tool_gap');
    expect(classifyGap('没有能力直接调用 docker，需要安装依赖吗？')).toBe('tool_gap');
    expect(classifyGap('I need to install a tool to do X')).toBe('tool_gap');
  });

  it('classifies direction asks as decision', () => {
    expect(classifyGap('你要哪个方向：A 还是 B？')).toBe('decision');
    expect(classifyGap('should I use approach A or B?')).toBe('decision');
  });

  it('defaults unknown asks to knowledge_gap (AC3.1.1)', () => {
    expect(classifyGap('一些无法归类的征询文字？')).toBe('knowledge_gap');
  });
});

describe('buildGapResolutionPrompt', () => {
  it('knowledge_gap returns a self-search directive (AC3.1.1)', () => {
    const p = buildGapResolutionPrompt('knowledge_gap', '请问 fetch API 怎么用？');
    expect(p).toBeTruthy();
    expect(p).toContain('web_search');
    expect(p).toContain('禁止提问');
    expect(p).toContain('fetch API');
  });

  it('tool_gap returns a self-install directive', () => {
    const p = buildGapResolutionPrompt('tool_gap', '我缺少 PDF 解析工具');
    expect(p).toBeTruthy();
    expect(p).toContain('install_skill');
    expect(p).toContain('create_skill');
    expect(p).toContain('PDF 解析工具');
  });

  it('decision returns null → caller falls back to <assumption> override', () => {
    expect(buildGapResolutionPrompt('decision', '你要哪个方向？')).toBeNull();
  });

  it('all gap kinds produce stable output for round-trip', () => {
    const kinds: GapKind[] = ['knowledge_gap', 'tool_gap', 'decision'];
    for (const k of kinds) {
      const p = buildGapResolutionPrompt(k, '示例征询文字？');
      // decision → null; others → non-empty string
      if (k === 'decision') {
        expect(p).toBeNull();
      } else {
        expect(typeof p).toBe('string');
        expect(p!.length).toBeGreaterThan(20);
      }
    }
  });
});
