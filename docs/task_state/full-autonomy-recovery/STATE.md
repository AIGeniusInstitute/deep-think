# 任务执行状态：全自主恢复引擎

> worktree：`~/deepthink/.worktrees/feat-full-autonomy-recovery`
> 开始：2026-08-19

## 阶段进度

### P0（可恢复刹车框架）— 进行中
- [ ] F1 新增 `autonomy-recovery.ts`（RecoveryState + requestRecovery + buildRecovery）
- [ ] F1 改造 `index.ts` 4 处 `exit(1)` → 恢复分支
- [ ] F1 `shared/stream-event.ts` + 2 事件类型 + 2 字段
- [ ] F2 逐刹车策略（destructive/turn/token/loop）
- [ ] F2 前端 banner（最小）
- [ ] P0 单测：recovery-state / recovery-turn-budget / stream-event-recovery
- [ ] P0 E2E：destructive / loop
- [ ] 回归基线不降

### P1（知识消解 + 经验回注）— 待开始
### P2（适应闭环 + gate 续跑 + 归档）— 待开始

## 执行日志
- 2026-08-19 创建 worktree、PRD、技术方案；开始 P0 编码。
## 执行日志
- 2026-08-19 创建 worktree、PRD、技术方案。
- 2026-08-19 P0 完成：
  - 新增 `container/agent-runner/src/autonomy-recovery.ts`（RecoveryState + 4 刹车策略）
  - 改造 `container/agent-runner/src/index.ts` 4 处 `exit(1)` → 可恢复分支 + runRecoveryTurn 助手
  - `shared/stream-event.ts` +2 事件类型（autonomous_recovering/recovered）+strategy/attempt 字段，同步 3 副本
  - `container/agent-runner/src/types.ts` sourceKind +`autonomous_recover`
  - 前端 `web/src/stores/chat.ts` +recovering/recovered banner
  - 单测 `tests/units/recovery-state.test.ts` 10/10 通过
  - 全量单测 266/266 通过（零回归，better-sqlite3 原生绑定已重编译）
  - agent-runner + web 类型检查通过
- 2026-08-19 进入 P1（知识缺口消解 + 经验回注）。

## P1（知识缺口消解 + 经验回注）— 完成
- [x] F3 新增 `container/agent-runner/src/gap-resolver.ts`（规则分类 knowledge/tool/decision + 自消解指令）
- [x] F3 index.ts askedUser 块：优先用 gap 消解 prompt，decision 回退 <assumption>
- [x] F4 新增 `src/autonomy/lesson-injection.ts` 共享 helper（reinjectLessonsIntoPrompt）
- [x] F4 team-builder.decompose + loop-orchestrator.runOneIteration 首轮注入 lessons
- [x] 单测：gap-classifier 11/11 + lessons-reinjection 3/3
- [x] 全量 277/277 零回归；agent-runner + 后端类型检查通过

## P2（适应闭环 + gate 续跑 + 归档）— 完成
- [x] F5 `src/autonomy/autonomy-adapt.ts`：targeted signal 生成 LLM 调整（generateAdjustment，30s 超时，非致命），写回 payload_json + 事件携带 adjustment；processPendingSignals/startAdaptationLoop 改 async；routes/autonomy signals/process async
- [x] F6 `src/graph-engineering/graph-orchestrator.ts`：executeGraph 失败分支增加 gate 自动续跑（gateRetryCount，tries<GATE_RETRY_MAX=2 → 重置上游 + 写 gate_feedback_<upstreamId> 到 state + continue；否则终态失败）
- [x] F6 `src/graph-engineering/graph-runner.ts`：抽取 `composeAgentPrompt(node,state)`，gate 反馈前置注入（feedback→goalAnchor→base）
- [x] F6 顺带修复预存在 bug：终态分支 persistState（硬编码 running）会覆盖 failed，重排为 persistState→updateGraphRunStatus('failed')
- [x] F7 `src/autonomy/autonomy-learning.ts`：captureToolArtifacts 从 trace_tool_calls 归档 web_search/web_fetch/sandbox_run_code 为 perception/execution 经验，去重幂等；captureRunLesson 内非致命调用
- [x] 单测：autonomy-p1 +2（F5 targeted/untargeted）；tool-artifact-lesson 3/3；gate-feedback-prompt 5/5；gate-auto-resume 4/4
- [x] 全量回归 1424 passed / 4 skipped / 1 failed（prompt-loader 预存在无关失败）；tsc 0 error
- [x] 测试报告写入 docs/test_report/full-autonomy-recovery/TEST_REPORT.md

