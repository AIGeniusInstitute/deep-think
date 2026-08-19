/**
 * F3: Autonomous knowledge/tool-gap resolution.
 *
 * When the autonomous-mode end-of-turn detector fires (the agent was about to
 * ask the user), classify the asking text and — for knowledge / tool gaps —
 * inject a resolution directive that tells the agent to self-resolve using its
 * own tools (web_search / install_skill / create_skill) instead of asking.
 * Only `decision` gaps fall back to the existing <assumption> override.
 *
 * Rule-based on purpose (Simplicity First): no extra LLM turn, no token cost.
 * The agent already has web_search / web_fetch / install_skill / create_skill
 * as MCP tools — this module just redirects an about-to-ask turn into a
 * self-resolution turn.
 */

export type GapKind = 'knowledge_gap' | 'tool_gap' | 'decision';

const KNOWLEDGE_GAP_PATTERNS: RegExp[] = [
  /是什么/,
  /是什么意思/,
  /怎么[^。？]*\?/,
  /如何[^。？]*\?/,
  /哪里/,
  /哪个版本/,
  /是否有/,
  /是否支持/,
  /有没有/,
  /支持什么/,
  /版本是/,
  /最新版本/,
  /叫什么名字/,
  /what is/i,
  /how (do|does|to)/i,
  /which version/i,
  /where (is|can)/i,
];

const TOOL_GAP_PATTERNS: RegExp[] = [
  /缺少[^。？]*(工具|能力|依赖|包|库|模块)/,
  /没有[^。？]*(工具|能力|依赖|包|库|模块)/,
  /无法[^。？]*因为没有/,
  /需要安装/,
  /need.*(tool|package|library|dependency)/i,
  /missing.*(tool|capability|dependency)/i,
  /don'?t have.*(tool|capability)/i,
];

const DECISION_PATTERNS: RegExp[] = [
  /要哪个方向/,
  /要不要/,
  /是否继续/,
  /你决定/,
  /你选择/,
  /which (approach|direction|option)/i,
  /should (i|we)/i,
];

export function classifyGap(turnText: string): GapKind {
  const tail = turnText.slice(-800);
  if (TOOL_GAP_PATTERNS.some((re) => re.test(tail))) return 'tool_gap';
  if (KNOWLEDGE_GAP_PATTERNS.some((re) => re.test(tail))) return 'knowledge_gap';
  if (DECISION_PATTERNS.some((re) => re.test(tail))) return 'decision';
  // Default: treat unknown asks as knowledge gaps (most asks are factual).
  return 'knowledge_gap';
}

/**
 * Build a resolution directive prompt for the gap kind, or null to fall back
 * to the existing <assumption> auto-continue prompt.
 */
export function buildGapResolutionPrompt(kind: GapKind, turnText: string): string | null {
  const askingExcerpt = turnText.slice(-400).replace(/\s+/g, ' ').trim();
  switch (kind) {
    case 'knowledge_gap':
      return [
        '【系统提示：全托管模式 — 知识缺口自主消解】',
        '你刚才的输出包含向用户提问的迹象，这违反了禁止提问规则。',
        '判定为知识缺口。请改用自主检索消解，不要提问：',
        '- 调用 web_search 工具检索你不确定的事实（API 用法、版本支持、库名、配置项等）；',
        '- 对最相关的结果用 web_fetch 抓取详情；',
        '- 综合检索结果后基于事实继续推进任务；',
        '- 若检索后仍无法确定，用 <assumption> 声明合理假设并继续，禁止提问。',
        `你刚才的征询内容（摘要）：${askingExcerpt}`,
      ].join('\n');
    case 'tool_gap':
      return [
        '【系统提示：全托管模式 — 工具缺口自主消解】',
        '你刚才提到缺少某工具/能力，这违反了禁止提问规则。',
        '判定为工具缺口。请改用自主补能力，不要提问：',
        '- 调用 install_skill 从 skills 仓库安装匹配能力；',
        '- 或调用 create_skill 用自然语言生成一个可复用 skill；',
        '- 或用 sandbox_run_code 直接实现该能力（一次性脚本即可则不必装 skill）；',
        '- 补能力后继续推进任务；',
        '- 若确无法补能力，用 <assumption> 声明替代方案并继续，禁止提问。',
        `你刚才的征询内容（摘要）：${askingExcerpt}`,
      ].join('\n');
    case 'decision':
      return null; // fall back to existing <assumption> auto-continue prompt
  }
}
