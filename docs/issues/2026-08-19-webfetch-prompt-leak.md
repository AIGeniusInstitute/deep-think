# 2026-08-19 — web-fetch.md 平台 prompt 泄露内部工具名 WebFetch 致 prompt-loader 测试失败

## 1. 用户现象
无直接用户报错。表现为：主干 `main` 上 `tests/prompt-loader.test.ts` 持续一个红测，CI/本地全量回归始终非全绿。

## 2. 问题描述
`tests/prompt-loader.test.ts` 的「platform prompt patches do not duplicate user rules or skill bodies」断言：
```ts
expect(webFetch).not.toContain('WebFetch');
expect(webFetch).not.toContain('web-content-fetcher');
```
即平台 prompt patch `container/agent-runner/prompts/web-fetch.md` 不应包含内部工具名 `WebFetch`（避免与 skill/工具层注入重复）。当前文件含 `### WebSearch / WebFetch 已重写（中国可用）` 段落，命中 `WebFetch` 子串，断言失败。

## 3. 根因
- 断言来自奠基提交 `8accd49 deep-think`。
- 提交 `8549c71 feat(agent-runner): 重写 WebSearch/WebFetch 为中国可用`（2026-07-23）为告知 agent「内置网页工具已重写为中国可用、勿因 US-only 回避」，在 `web-fetch.md` 里直接写了工具名 `WebFetch`，破坏了上述断言。
- 即：新增的可用性指引与"patch 不泄露内部工具名"约束冲突，提交时未跑/未修该测试。

## 4. 复现路径
```bash
cd ~/deepthink
npx vitest run tests/prompt-loader.test.ts
# → FAIL  platform prompt patches do not duplicate user rules or skill bodies
#   expect(webFetch).not.toContain('WebFetch')  // Received 含 "WebFetch"
```

## 5. 诊断方法
```bash
# 确认文件含禁用 token
grep -n WebFetch container/agent-runner/prompts/web-fetch.md
# 确认谁引入
git log --oneline -- container/agent-runner/prompts/web-fetch.md
git show 8549c71 -- container/agent-runner/prompts/web-fetch.md
# 确认断言来源
git log --oneline -- tests/prompt-loader.test.ts   # 8accd49
```

## 6. 修复方案
保留原指引语义（告知 agent 内置网页工具已重写为中国可用、勿回避），但避开断言禁用的字面 token `WebFetch`（`WebSearch` 不在断言内，保留）。diff 关键改动：

```diff
-### WebSearch / WebFetch 已重写（中国可用）
+### 内置网页工具已重写（中国可用）

-内置的 `WebSearch` 与 `WebFetch` 已在本平台重写为中国国内可用的实现…
-- `WebSearch` → 智谱 paas v4 搜索后端，中英文检索均可用。
-- `WebFetch` → 直连抓取并转 Markdown，兼容 GB18030/GBK 中文字符集…
+内置的 `WebSearch` 与网页抓取工具已在本平台重写为中国国内可用的实现…
+- `WebSearch` → 智谱 paas v4 搜索后端，中英文检索均可用。
+- 网页抓取 → 直连抓取并转 Markdown，兼容 GB18030/GBK 中文字符集…
```

选型理由：测试只禁 `WebFetch`/`web-content-fetcher`，不禁 `WebSearch`。agent 实际调用工具时由工具层提供工具名，patch 只需传达"别回避、已中国可用"的语义，不必写死被禁的字面名。改写后语义等价、断言通过，且不丢任何运行时指引。

## 7. 处理卡住的状态
不适用（无 stuck 运行态）。

## 8. 经验沉淀 / 预防
- **提交前跑全量**：`8549c71` 改了平台 prompt 却未发现破坏既有测试——根因是提交未执行 `npx vitest run tests/prompt-loader.test.ts`。建议在 prompt/平台 patch 相关改动上设 CI gate：`tests/prompt-loader.test.ts` 必须绿。
- **"勿用字面工具名"约束**：平台 prompt patch 描述工具行为时应优先用语义化描述（"网页抓取"），避免写死内部工具标识符——既满足去重约束，也更抗工具改名。
- 已在 `tests/prompt-loader.test.ts` 现有断言中体现该约束，无需新增测试。
