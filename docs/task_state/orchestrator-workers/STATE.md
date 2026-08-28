# 任务状态 — Orchestrator–Workers（主 Agent 编排子 Agent）

> 需求：支持用户创建一个主 Agent（编排者），关联多个 Agent Studio 中已创建的子 Agent（Workers），
> 由主 Agent 自主编排子 Agent 协作完成复杂任务。
>
> 分支：`feat/orchestrator-workers`

## 整体进度

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 | 数据模型（kind + agent_worker_links） | ✅ 完成 |
| M2 | 类型 / schema | ✅ 完成 |
| M3 | 路由（workers 关联 + orchestrate） | ✅ 完成 |
| M4 | orchestrator 运行器（plan → graph） | ✅ 完成 |
| M5 | 前端（类型选择 + Worker 选择器 + 编排入口） | ✅ 完成 |
| M6 | 构建 / 测试 / 运行时验证 | 🔄 进行中 |
| M7 | 测试报告 + 合并 main | ⏳ 待办 |

## 已完成改动清单

### 后端
- `src/db.ts`
  - `agent_definitions.kind` 列（默认 `'assistant'`）+ `ensureColumn` 迁移
  - 新增 `agent_worker_links` 表（orchestrator_id / worker_id / position，UNIQUE + 级联删除 + 双索引）
  - `setAgentWorkers` / `listAgentWorkers` / `listWorkerLinksForAgent`
  - `AgentDefinitionRow.kind`、`createAgentDefinition`/`updateAgentDefinition` 支持 kind
- `src/types.ts`：新增 `AgentDefinitionKind = 'assistant' | 'orchestrator'`，`AgentDefinition.kind`
- `src/schemas.ts`：`AgentDefinitionCreateSchema` / `AgentDefinitionPatchSchema` 增加 `kind`
- `src/routes/paas-agents.ts`
  - `serializeAgentDef` 输出 `kind`
  - `GET /:id/workers` / `PUT /:id/workers`（校验非自身/非编排者，去重，幂等整体替换）
  - `ensureOrchestratorWorkspace`（确定性 `web:agent-orch-{id}` 工作区）
  - `POST /:id/orchestrate`（校验编排者类型 + task 必填 → `webDeps.runOrchestrator`）
- `src/agent-orchestration/orchestrator-plan.ts`（新增）
  - `OrchestratorPlanSchema` / `parseOrchestratorPlan`（fence 剥离 + zod + workerId 归属 + dependsOn 存在性 + 环检测）
  - `buildFallbackPlan`（顺序派发兜底）
- `src/agent-orchestration/orchestrator-runner.ts`（新增）
  - `runOrchestrator`：load orchestrator+workers → plan（sdkQuery，重试 1 次 + 兜底）→ `assembleOrchestratorGraph` → register + start + execute
  - `assembleOrchestratorGraph`：每 step 一个 `agent` 节点（复用 `agentDefId` 执行路径）+ 尾部验收 gate
- `src/web-context.ts`：`WebDeps.runOrchestrator`
- `src/index.ts`：`webDeps.runOrchestrator = (input) => runOrchestrator(input, graphDeps)`

### 前端
- `web/src/stores/agents-paas.ts`
  - `AgentKind` 类型 + `AgentDefinition.kind`
  - `create` 支持 `kind`
  - 新增 `listWorkers` / `setWorkers` / `orchestrate`
- `web/src/pages/AgentStudioPage.tsx`
  - 新建 Agent 弹窗增加类型选择（普通 / 编排者）
  - 详情页类型切换按钮 + 列表编排者徽标
  - `WorkersSection`（编排者专属，勾选关联子 Agent）
  - `OrchestrateDialog`（输入任务 → 启动编排 → 展示计划）

## 测试状态

- `tests/orchestrator-plan.test.ts`：15 用例全通过（parseOrchestratorPlan 有效性/归属/依赖/环、buildFallbackPlan、assembleOrchestratorGraph）
- 修复了一处 `extractJson` 真实 bug：先剥离前导 prose 后再计算 `last`，否则前导 prose 场景下 JSON.parse 失败（测试驱动发现）
- `npx tsc --noEmit`（后端）与 `web/npx tsc --noEmit`（前端）均通过

## 下一步

1. 后端构建 + 运行时验证（`make start-prod PORT=9898` + curl API 冒烟）
2. 编写测试报告 `docs/test_report/orchestrator-workers/TEST_REPORT.md`
3. 合并 `feat/orchestrator-workers` → `main` 并 push
