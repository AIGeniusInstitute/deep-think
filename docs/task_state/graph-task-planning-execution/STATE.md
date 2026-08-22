# 任务执行状态 — Team Graph 复杂任务规划与执行能力

> 分支：`feat-graph-task-planning-execution`
> 创建：2026-08-23
> PRD：`docs/prd/graph-task-planning-execution/PRD.md`
> 技术方案：`docs/tech_solution/graph-task-planning-execution/SOLUTION.md`

## 进度

- [x] C0：worktree、PRD、技术方案
- [x] C1：DSL v2 类型扩展（graph-types.ts）+ graph-expr 求值器 — 24 测试通过
- [x] C2：DB migration（budget_json / graph_runs.manifest_hash / node_type CHECK 扩展 + 表重建）+ registry serialize/deserialize/validate 扩展 + getGraphRunUsage + listGraphNodeTimeline；SCHEMA_VERSION 54→55
- [x] C3：scheduler expression/default 边 + takenEdges — 既有 13 测试 + 5 新测试通过
- [x] C4：runner 新节点 dispatch（llm/tool/start/end/parallel/aggregate）+ 超时强制 + gate/tool/llm 独立工作区
- [x] C5：orchestrator graph_* 事件 + 预算熔断 + EvalContext 路由 + edge_taken 事件 + manifest_hash 校验
- [x] C6：graph-planner + 3 模板（dev-workflow/report-ppt/parallel-research）+ POST /plan + GET /runs/:id/timeline — 11 测试通过
- [x] C7：stream-event graph_* 前端 copy + stores/graph.ts WS 订阅（<2s 延迟 + 轮询兜底）
- [x] C8：dagreLayout + DataFlowEdge + GanttView + ReplayPlayer + GraphDagView 重构（definition 驱动布局 + 数据流动画）+ GraphPage 三标签 + store loadDefinition/loadTimeline/plan
- [x] C9：TC1-TC10 集成验证（见测试报告）
- [x] 类型检查：tsc --noEmit 全量通过（前后端 0 错误）
- [x] 后端测试：1475/1475 通过（+2 TC7/TC2 集成测试，0 失败）

## 测试回归修复

- gate-auto-resume：orchestrator 完成路径调用 getGraphRunUsage 发射 graph_end 统计，db mock 未提供该导出致崩溃 → 把统计读取包进 try-catch（遥测广播不崩溃核心循环）
- super-agent-team-trace：schema_version 断言 54 → 55（C2 升版本）

## 验收标准覆盖

| AC | 覆盖状态 | 证据 |
|----|---------|------|
| AC1 自动规划 | ✅ 逻辑+单测 | graph-planner + report-ppt 模板含 parallel/aggregate，planner 11 测试 |
| AC2 3 并行分支并发 | ✅ 集成 | graph-v2-budget TC2：3 分支 started_at 窗口两两重叠 + aggregate 在后 |
| AC3 重试后降级 | ✅ 逻辑 | runNodeWithRetry 重试 + scheduler default 边 fallback 测试（graph-scheduler-v2）|
| AC4 实时延迟<2s | ✅ 实现 | graph_* WS 事件 + 前端 WS 订阅增量 upsert（联调需运行时）|
| AC5 断点恢复 + hash 校验 | ✅ 集成 | graph-e2e resume + buildRunContext manifest_hash 校验 |
| AC6 节点超时 | ✅ 逻辑 | dispatchByType Promise.race 超时包装（需 LLM 联调）|
| AC7 预算熔断 | ✅ 集成 | graph-v2-budget TC7：maxTokens 熔断 run failed reason 含 budget exceeded |
| AC8 甘特图 | ✅ 实现 | GanttView.tsx SVG 甘特 + timeline 接口 |
| AC9 历史回放 | ✅ 实现 | ReplayPlayer.tsx scrubber + 自动播放 + 状态快照画布 |
| AC10 Planner 降级 | ✅ 单测 | planGraph 2 次重试 + 模板降级，parseDefinition/extractJson 测试 |
