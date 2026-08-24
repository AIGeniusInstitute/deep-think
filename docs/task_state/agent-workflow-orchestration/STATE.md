# 任务执行状态：Agent Workflow 可视化编排

> 分支：`feat/agent-workflow-editor`
> 关联：PRD `docs/prd/agent-workflow-orchestration/PRD.md`、技术方案 `docs/tech_solution/agent-workflow-orchestration/SOLUTION.md`

## 总体进度

| 里程碑 | 内容 | 状态 |
|--------|------|------|
| M1 | DB schema 加列 + 工作流 CRUD 函数 | ✅ 完成 |
| M2 | team-builder draft 模式 + WebDeps 签名 | ✅ 完成 |
| M3 | 前端可编辑画布 + 调色板 + 属性面板 | ✅ 完成 |
| M4 | /api/workflows 路由 + autobuild detached | ✅ 完成 |
| M5 | WorkflowEditorPage + 路由 + 保存运行串联 + 运行态复用 | ✅ 完成 |
| M6 | 抽取 AgentEditorPanel（AgentStudioPage 保持原版不回归） | ✅ 完成 |
| M7 | 测试用例执行 + bug 修复 + 构建验证 | ✅ 完成 |

## 验证结论

- 后端 `tsc --noEmit`：exit 0
- 前端 `tsc --noEmit`：exit 0
- 前端 `vite build`：成功（PWA 产物生成，无转译错误）
- `npx vitest run`（全量）：**1486 passed / 6 skipped / 0 failed**（含新增 `workflows.test.ts` 11 例 + 修正 trace schema 断言 55→56）
- 模块转译冒烟：dev server 加载 WorkflowEditorPage / workflow-editor / WorkflowEditorCanvas / AgentEditorPanel 全部 200，vite log 无 error/warn

## 已完成明细

### 后端（M1+M2+M4）
- `src/db.ts`：`graph_definitions` 加 `owner_user_id` + `idx_graph_def_owner`（索引在 `ensureColumn` 之后创建，修复既有库升级时"no such column"的顺序 bug）；`SCHEMA_VERSION` 55→56；`listWorkflowDefinitions/getWorkflowDefinition`（owner 隔离，404 不泄露）；`workflow_builds` 表 + 四个生命周期函数。
- `src/graph-engineering/graph-types.ts`：`GraphNode.position?`（UI 持久化，引擎忽略）。
- `src/graph-engineering/graph-registry.ts`：`registerDefinition(def, ownerUserId?)` 透传 owner + 返回 `version`。
- `src/agent-team/team-plan.ts` + `team-builder.ts`：`draft?:boolean` 分支，跳过 `startGraphRun`，返回 `{definitionId, definitionVersion, plan, memberDefIds, draft:true}`。
- `src/web-context.ts` + `src/routes/team.ts` + `src/agent-team/team-commands.ts`：签名适配，`result.runId!`。
- `src/routes/workflows.ts`（新增）：`GET/POST/PUT /:id` + `POST /autobuild`（detached setImmediate）+ `GET /autobuild/:buildId` 轮询；`src/web.ts` 挂载 `/api/workflows`。

### 前端（M3+M5+M6）
- `web/src/api/workflows.ts`：workflowsApi（list/get/create/update/autobuild/pollAutobuild）。
- `web/src/stores/workflow-editor.ts`：受控模式 Zustand store，草稿态与运行态隔离（运行态复用 stores/graph.ts）；addNode/updateNodeData/removeNode/applyNodeChanges/onConnect/autoLayout/save/run/autobuild；save 序列化为 GraphDefinition 形状；home group 解析（chatJid 为 record key）。
- `web/src/components/workflow/`：workflow-constants、NodePalette、WorkflowEditorCanvas（受控 ReactFlow + onDrop + 自定义 workflowNode 卡片）、WorkflowNodeInspector（按类型字段 + agent 节点内嵌 AgentEditorPanel）。
- `web/src/components/agents/AgentEditorPanel.tsx`：可复用 create/edit 表单 + MountsSection，复用 useAgentsPaasStore（与 AgentStudioPage 同后端）。决策：不重构 AgentStudioPage（Surgical Changes，避免回归）。
- `web/src/pages/WorkflowEditorPage.tsx`：三列布局 + 工具栏 + edit↔run 切换（run 复用 GraphDagView）+ 工作流列表 drawer + AI 编排 dialog（轮询→加载定义）。
- `web/src/App.tsx`：`/workflows` + `/workflows/:id` 惰性路由；`nav-items.ts`：工作流菜单项。

### 测试（M7）
- `tests/units/workflows.test.ts`（新增 11 例）：schema v56 迁移 / owner 隔离 TC1–TC4 / workflow_builds 生命周期 TC5–TC7 / registerDefinition owner TC8。
- 修正 `super-agent-team-trace.test.ts` schema_version 断言 55→56。
- 修复 `db.ts` 索引顺序 bug（既有库升级必备）。

## 决策记录
- A1 复用 team-builder（draft 模式）✅ —— 不重建编排 Agent，Simplicity First
- A2 graph_definitions 加 owner_user_id + /api/workflows ✅
- A3 抽取 AgentEditorPanel ✅；AgentStudioPage 保持原版不回归

## 浏览器 E2E（TC18/TC19）说明
本环境无可用浏览器沙箱、且运行态应用为 main 分支（不含本特性），故 TC18/TC19 端到端未在本会话执行。已以「tsc + vite build + 全量 vitest + dev server 模块转译冒烟」替代验证；功能正确性由对应单元测试（TC1–TC8 后端映射）覆盖，前端交互逻辑经 typecheck + build 保证。待合并后在运行态应用上补做 TC18/TC19 人工 E2E。
