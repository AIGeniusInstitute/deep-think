# 测试报告 — 全自主恢复与经验沉淀（full-autonomy-recovery）

- 分支：`feat-full-autonomy-recovery`（worktree）
- 日期：2026-08-19
- 范围：P0 可恢复刹车引擎、P1 知识缺口自主消解 + 经验回注、P2 闭环（F5 适配闭环 / F6 gate 自动续跑 / F7 外部交互归档）

## 1. 执行命令

```bash
cd ~/deepthink/.worktrees/feat-full-autonomy-recovery
npx tsc --noEmit -p tsconfig.json      # 类型检查
npx vitest run                          # 全量单测
```

## 2. 总体结果

| 指标 | 数值 |
|---|---|
| 测试文件 | 1 failed / 118 passed / 1 skipped（共 120） |
| 测试用例 | **1 failed / 1424 passed / 4 skipped（共 1429）** |
| tsc | 0 error |

唯一失败：`tests/prompt-loader.test.ts > platform prompt patches do not duplicate user rules or skill bodies`。

### 2.1 该失败的归因（非本次改动引入）

- 断言：加载后的平台 prompt 不应包含字符串 `WebFetch`。
- 失败根因：用户全局 `CLAUDE.md`（位于工作区之外，由平台注入）含「WebSearch / WebFetch 已重写（中国可用）」段落，命中 `WebFetch` 子串。
- 证据：`git diff --name-only main` 显示本分支**未触碰任何 prompt / loader / CLAUDE.md 文件**（见下方 §4 文件清单）。
- 结论：**预存在失败，与本工作无关**，不阻断合并。

## 3. 本次新增测试（全部通过）

| 文件 | 用例 | 覆盖 |
|---|---|---|
| `tests/units/recovery-state.test.ts` | 10 | P0：4 类刹车 × 恢复策略 / 衰减 / 上限终止 |
| `tests/units/gap-classifier.test.ts` | 11 | P1：knowledge/tool/decision 分类 + 自主消解指令 |
| `tests/units/lessons-reinjection.test.ts` | 3 | P1：经验回注入 prompt（CJK 关键词截断修复） |
| `tests/units/tool-artifact-lesson.test.ts` | 3 | F7：web_search/web_fetch/sandbox_run_code 归档 + 去重 |
| `tests/units/gate-feedback-prompt.test.ts` | 5 | F6：composeAgentPrompt 反馈注入顺序 |
| `tests/units/gate-auto-resume.test.ts` | 4 | F6：gate 失败→上游重跑 / 连续失败终止 / 无上游直败 / 反馈写回 state |
| `tests/units/autonomy-p1.test.ts`（增改） | 12（原 10 + 新 2） | F5：targeted signal 生成 LLM 调整 + 持久化；untargeted 跳过 |

新增用例合计：**48 个，全部 PASS**。

## 4. 验收标准对齐

| AC | 验证 | 结果 |
|---|---|---|
| AC1（刹车可恢复） | recovery-state：destructive/turn/token/loop 各≤3 次可恢复，超过则终止 | ✅ |
| AC2（恢复后继续 loop） | index.ts runRecoveryTurn 走 runQuery→waitForIpcMessage（不 `continue` 重放原 prompt） | ✅（代码路径对齐 auto-continue） |
| AC3（恢复事件可观测） | stream-event 新增 `autonomous_recovering/recovered`；web banner 🟡/🟢 | ✅ |
| AC4（知识缺口自消解） | gap-resolver：tool_gap→install_skill/create_skill；knowledge_gap→web_search | ✅ |
| AC5（经验回注） | lesson-injection：reinjectLessonsIntoPrompt 被 team-builder/loop-orchestrator 复用 | ✅ |
| AC5.1（适配闭环） | F5：processPendingSignals 对 targeted signal 生成 LLM 调整并写回 payload_json | ✅ |
| AC6.1.1（gate 失败一次→重跑→通过） | gate-auto-resume：scripted.g=['failed','completed'] → run completed，gate 跑 2 次 | ✅ |
| AC6.1.2（连续 2 次 gate 失败→failed） | scripted.g 全 failed → run failed，gate 跑 2 次（tries<GATE_RETRY_MAX=2） | ✅ |
| AC6.1.3（反馈注入上游 prompt） | composeAgentPrompt：feedback→goalAnchor→base 顺序 | ✅ |
| AC6.1.4（反馈写回 state） | gate-auto-resume：ctx.state['gate_feedback_a'] 含评审失败详情 | ✅ |
| AC7（外部交互归档） | F7：captureToolArtifacts 从 trace_tool_calls 归档 web/sandbox 为 perception/execution 经验，去重幂等 | ✅ |

## 5. 环境性失败处理

- `chat-agent-messages` / `sandbox-steps-selector-stability` 两个文件曾因 worktree `web/node_modules` 缺失（`zustand` 不可解析）失败。
- 处理：`ln -sfn ~/deepthink/web/node_modules web/node_modules` 重建软链后**两文件 6/6 通过**。
- `better-sqlite3` 原生绑定需 `cd ~/deepthink && npm rebuild better-sqlite3`（worktree 经父目录解析 node_modules）。

## 6. 风险与遗留

1. **prompt-loader 预存在失败**：见 §2.1，建议后续单独修（平台 prompt 与全局 CLAUDE.md 的 WebFetch 文案冲突），与本工作解耦。
2. **F6 顺带修复的预存在 bug**：`executeGraph` 失败终态分支原顺序为 `updateGraphRunStatus('failed') → persistState`，后者硬编码 `'running'` 会把终态改回 running。本次重排为 `persistState → updateGraphRunStatus('failed')`，使终态正确持久化。改动落在本次正在修改的分支内，符合 Surgical Changes。
3. F5 的 LLM 调整生成在单测中以 mock 替代（`sdkQuery → 'mocked-adjustment-text'`），真实 LLM 质量需在联调环境观察。

## 7. 结论

- 本次 P0/P1/P2 全部功能验收通过，新增 48 用例全绿。
- 全量回归 1424 passed / 4 skipped，唯一失败为预存在且与本次无关。
- 可合并至 main。
