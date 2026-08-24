# 任务执行状态：Agent Workflow 可视化编排

> 分支：`feat/agent-workflow-editor`
> 关联：PRD `docs/prd/agent-workflow-orchestration/PRD.md`、技术方案 `docs/tech_solution/agent-workflow-orchestration/SOLUTION.md`

## 总体进度

| 里程碑 | 内容 | 状态 |
|--------|------|------|
| M1 | DB schema 加列 + 工作流 CRUD 函数 | ✅ 完成 |
| M2 | team-builder draft 模式 + WebDeps 签名 | ✅ 完成 |
| M3 | 前端可编辑画布 + 调色板 + 属性面板 | ⏳ 进行中 |
| M4 | /api/workflows 路由 + autobuild detached | ✅ 完成 |
| M5 | WorkflowEditorPage + 路由 + 保存运行串联 + 运行态复用 | ⏳ 待启动 |
| M6 | 抽取 AgentEditorPanel + AgentStudioPage 改用 | ⏳ 待启动 |
| M7 | 测试用例执行 + bug 修复循环 + E2E | ⏳ 待启动 |

## 已完成明细

### 后端（M1+M2+M4）— 已通过 `tsc --noEmit`

- `src/db.ts`：
  - `graph_definitions` 新增 `owner_user_id TEXT` 列 + `idx_graph_def_owner` 索引；CREATE TABLE 与 `ensureColumn` 迁移；`SCHEMA_VERSION` 55→56。
  - `GraphDefinitionRow` 加 `owner_user_id`；`createGraphDefinition` INSERT 加列。
  - 新增 `listWorkflowDefinitions(userId)` / `getWorkflowDefinition(id, userId)`（owner 隔离，404 不泄露）。
  - 新增 `workflow_builds` 表 + `WorkflowBuildRow` + `createWorkflowBuild/getWorkflowBuild/completeWorkflowBuild/failWorkflowBuild`。
- `src/graph-engineering/graph-types.ts`：`GraphNode` 加 `position?: {x,y}`（UI 持久化，执行引擎忽略）。
- `src/graph-engineering/graph-registry.ts`：`registerDefinition(def, ownerUserId?)` 透传 owner + 返回 `version`。
- `src/agent-team/team-plan.ts`：`TeamTaskInput.draft?` + `TeamBuildResult.runId` 改可选 + `draft?`。
- `src/agent-team/team-builder.ts`：`registerDefinition` 传 owner；`input.draft` 为真时跳过 `startGraphRun`/`executeGraph`，返回 `{definitionId, definitionVersion, plan, memberDefIds, draft:true}`。
- `src/web-context.ts`：`WebDeps.buildTeam` 签名加 `draft?`、返回 `runId?`。
- `src/routes/team.ts` + `src/agent-team/team-commands.ts`：`result.runId!`（非 draft 路径必有）。
- `src/routes/workflows.ts`（新增）：`GET/POST/PUT /:id` + `POST /autobuild`（detached）+ `GET /autobuild/:buildId`。
- `src/web.ts`：挂载 `/api/workflows`。

### 决策记录
- A1 复用 team-builder（draft 模式）✅
- A2 graph_definitions 加 owner_user_id + /api/workflows ✅
- A3 抽取 AgentEditorPanel（待 M6 落地）

## 待办

- 前端：stores/workflow-editor.ts、WorkflowEditorCanvas、NodePalette、WorkflowNodeInspector、AgentEditorPanel、WorkflowEditorPage、App 路由+菜单、api/workflows.ts。
- 测试：workflows.test.ts 单元 + make test 不回归 + 浏览器 E2E(TC18/TC19)。
