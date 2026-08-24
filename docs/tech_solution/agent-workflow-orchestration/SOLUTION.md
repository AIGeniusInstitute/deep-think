# 技术方案：Agent Workflow 可视化编排（编辑画布 + 单节点 Agent 编辑 + 编排 Agent 草稿模式）

> 关联 PRD：`docs/prd/agent-workflow-orchestration/PRD.md`
> 分支：`feat/agent-workflow-editor`
> 状态：v1
> 日期：2026-08-25

## 0. 设计总则

**核心判断**：本功能不是新引擎，而是 graph-engineering 之上的**可视化编辑层**。复用 `GraphDefinition` 作为 Workflow 数据模型、复用 `graph-orchestrator`/`graph-runner` 执行、复用 `team-builder` 做编排 Agent、复用 `useAgentsPaasStore`+Agent Studio 做 Agent 编辑。新增仅：①可编辑画布（前端）②用户级工作流 CRUD（后端薄层）③team-builder draft 模式 ④抽取 `AgentEditorPanel`。

**Surgical Changes**：不改动 `graph-scheduler`/`graph-orchestrator`/`graph-runner` 核心；不改动只读 `GraphDagView`；`graph_definitions` 仅加列 `owner_user_id`；既有 `/api/graph/definitions`（admin）与 `buildTeam`（默认即跑）行为不变。

## 1. 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│  前端 WorkflowEditorPage (React) — 可编辑 ReactFlow 画布      │
│   调色板(NodePalette) + 画布(WorkflowEditorCanvas) +          │
│   属性面板(WorkflowNodeInspector，内嵌 AgentEditorPanel)      │
│   ↑ /api/workflows/* (CRUD)  /api/workflows/autobuild (草稿)  │
│   ↑ /api/paas/agents/* (复用 Agent 编辑)                      │
├──────────────────────────────────────────────────────────────┤
│  路由层 src/routes/workflows.ts (Hono, authMiddleware)        │
│   GET/POST/PUT/GET:id + POST /autobuild (+ /autobuild/:id)   │
├──────────────────────────────────────────────────────────────┤
│  复用：registerDefinition/deserializeDefinition (graph-registry)│
│  复用：buildTeam({draft:true}) (agent-team/team-builder)       │
│  复用：startGraphRun/executeGraph (graph-engineering) 运行    │
├──────────────────────────────────────────────────────────────┤
│  SQLite：graph_definitions (+ owner_user_id 列)               │
└──────────────────────────────────────────────────────────────┘
```

## 2. 数据模型（schema v55→v56，仅加列）

### 2.1 `graph_definitions` 新增 `owner_user_id`
- `db.ts` CREATE TABLE 语句加 `owner_user_id TEXT`（新建库直接有）。
- 迁移：`ensureColumn('graph_definitions', 'owner_user_id', 'TEXT')`（既有行回填 NULL）。
- `SCHEMA_VERSION` `'55'` → `'56'`。
- `GraphDefinitionRow` 接口加 `owner_user_id: string | null`。

### 2.2 `createGraphDefinition` 扩展
INSERT 列加 `owner_user_id`，值取 `row.owner_user_id ?? null`。签名不变（row 类型已扩字段）。

### 2.3 新增用户级查询函数（db.ts）
```ts
export function listWorkflowDefinitions(userId: string): GraphDefinitionRow[]
// SELECT * FROM graph_definitions WHERE status='active' AND (owner_user_id=? OR owner_user_id IS NULL)
// GROUP BY id HAVING version=MAX(version) ORDER BY created_at DESC
// —— 用户可见自己 + 全局(NULL/admin)定义；admin 路由仍用 listGraphDefinitions() 看全部。

export function getWorkflowDefinition(id: string, userId: string): GraphDefinitionRow | undefined
// SELECT * WHERE id=? AND status='active' ORDER BY version DESC LIMIT 1，再在 TS 侧校验
// owner_user_id 为 null 或等于 userId（否则返回 undefined，404 不泄露存在性）。
```

### 2.4 `registerDefinition` 扩展 owner 透传
```ts
export function registerDefinition(def: GraphDefinition, ownerUserId?: string): { key; hash }
// createGraphDefinition({ ..., owner_user_id: ownerUserId ?? null })
```
- 既有 admin `POST /api/graph/definitions` 不传 owner（null，全局）。
- `team-builder.buildTeam` 传 `input.ownerUserId`。
- 新 `/api/workflows` 路由传当前用户 id。

## 3. 后端路由 `src/routes/workflows.ts`（新增，authMiddleware）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 列当前用户工作流（`listWorkflowDefinitions(userId)`），返回 `{workflows:[{id,version,name,description,nodeCount,updatedAt}]}` |
| GET | `/:id` | 工作流详情（`getWorkflowDefinition(id,userId)` + `deserializeDefinition`），返回 `{definition, mermaid}`；不存在/非 owner → 404 |
| POST | `/` | 新建：body `{id?, name, description?, nodes, edges, stateSchema?}`；`id ?? \`wf-${userId}-${slug(name)}-${rand}\``；`registerDefinition(def, userId)`；返回 `{id, version, hash}` |
| PUT | `/:id` | 更新（注册下一版本）：body 同上；owner 校验；`registerDefinition(def, userId)`；返回 `{id, version, hash}` |
| POST | `/autobuild` | 编排 Agent 草稿：body `{goalText, background?, acceptanceCriteria?, groupFolder, chatJid, maxTeamSize?, toolset?, executionMode?}`；立即返回 `buildId`，后台 detached 调 `buildTeam({...,draft:true})`，结果回写（复用 team_builds 表或新增 workflow_builds 表，见 §4） |
| GET | `/autobuild/:buildId` | 轮询：`running`/`completed→{definitionId,plan}`/`failed→{error}` |

运行仍走既有 `POST /api/graph/runs`（前端直接调），不在 `/api/workflows` 重复。

### 路由挂载
`web.ts`：`import { workflowRoutes } from './routes/workflows.js';` + `app.route('/api/workflows', workflowRoutes);`（紧跟 `/api/team` 之后）。

## 4. team-builder draft 模式（最小扩展）

### 4.1 `TeamTaskInput` 加 `draft?: boolean`
### 4.2 `TeamBuildResult` 放宽 `runId` 为可选 + 加 `draft?: boolean`
```ts
export interface TeamBuildResult {
  runId?: string;          // draft 模式下省略
  definitionId: string;
  definitionVersion: number;
  plan: TeamPlan;
  memberDefIds: Record<string, string>;
  draft?: boolean;
}
```
### 4.3 `buildTeam` 第 4 步分支
```ts
const registered = registerDefinition(def, input.ownerUserId);  // 传 owner
if (input.draft) {
  return { definitionId: def.id, definitionVersion: registered... , plan, memberDefIds, draft: true };
  // 不 startGraphRun、不 executeGraph
}
// 否则既有即跑逻辑（不变）
```
注意：`registerDefinition` 内部 `getLatestGraphDefinition(def.id)` 决定 version，draft 返回的 version 需取出——改为 `registerDefinition` 返回 `{key, hash, version}` 或 buildTeam 重新 `getLatestGraphDefinition(def.id)`。选后者（不动 registerDefinition 返回签名）：draft 后 `const latest = getLatestGraphDefinition(def.id)!; return { definitionId: def.id, definitionVersion: latest.version, plan, memberDefIds, draft:true }`。

### 4.4 WebDeps.buildTeam 签名扩展
`web-context.ts`：input 加 `draft?: boolean`；返回 union 加 `definitionVersion` 已有、`runId` 改可选、加 `draft?: boolean`。

### 4.5 autobuild detached 模式
复刻 `team.ts` 的 `team_builds` 表 + `createTeamBuild/getTeamBuild/completeTeamBuild/failTeamBuild` 模式。选型：**复用 team_builds 表**（它已有 owner/group/goal/plan_json/run_id/error/status），autobuild 草稿把 `run_id` 留空、`plan_json` 存 plan，新增一个 `definition_id` 列？为避免改表，**autobuild 直接复用 team_builds 表，complete 时写 `plan_json`，并在 plan 旁附 definitionId**。但 team_builds 无 definition_id 列。

决策：**新增极简 `workflow_builds` 表**（与 team_builds 同构 + `definition_id` 列），不复用 team_builds 以免污染既有 team 语义。表：`id, owner_user_id, group_folder, chat_jid, goal_text, status, definition_id, plan_json, error, created_at, updated_at`。CRUD 函数 `createWorkflowBuild/getWorkflowBuild/completeWorkflowBuild/failWorkflowBuild`。

## 5. 前端

### 5.1 新增 store `web/src/stores/workflow-editor.ts`（草稿态，独立于 stores/graph.ts）
```ts
interface WorkflowEditorState {
  mode: 'edit' | 'run';
  definitionId?: string;
  name: string; description: string;
  draftNodes: GraphNode[];   // 含 position
  draftEdges: GraphEdge[];
  selectedNodeId?: string;
  runId?: string;            // 切到 run 模式时
  // actions
  newWorkflow(); loadWorkflow(id); addNode(partial); updateNode(id,patch); removeNode(id);
  addEdge(edge); updateEdge(id,patch); removeEdge(id);
  save(): Promise<{id,version}>;  // POST/PUT /api/workflows
  run(groupFolder, chatJid): Promise<runId>; // save 后 POST /api/graph/runs
  autobuild(input): Promise<buildId>;  // POST /api/workflows/autobuild
  pollAutobuild(buildId): Promise<{definitionId,plan}>; // GET /api/workflows/autobuild/:id
}
```
节点 `position` 存在 `GraphNode` 上？`GraphNode` 无 position 字段。**选型**：编辑态用 `RfNode`（ReactFlow 节点，含 position），`draftNodes` 存 `RfNode[]`（data 里放 GraphNode），保存时把 position 写进 GraphNode 的一个新可选字段 `position?: {x,y}`（graph-types.ts 加字段，纯 UI 用，执行引擎忽略）。或 position 仅存前端草稿、不持久化（重新打开重新布局）。**P0 选**：`GraphNode` 加 `position?: {x:number;y:number}`（持久化，运行引擎忽略），保存时写入 nodes_json。

### 5.2 可编辑画布 `web/src/components/workflow/WorkflowEditorCanvas.tsx`
- 基于 `@xyflow/react`，`useNodesState`/`useEdgesState`/`onConnect`(addEdge)/`onNodesChange`/`onEdgesChange`。
- 节点类型组件 `WorkflowNode`（自定义，显示 title + type 图标 + agent 绑定状态徽章）。
- `onDrop`/`onDragOver` 接收调色板拖入（`@dnd-kit` 或原生 DnD，P0 用原生 ReactFlow `onDrop` 读 `dataTransfer`）。
- 删除节点（Delete 键 `onNodesDelete`）级联删边。
- 自动布局按钮调 `dagreLayout`（复用 `components/graph/dagreLayout.ts`）。

### 5.3 调色板 `web/src/components/workflow/NodePalette.tsx`
- 列出节点类型（agent/gate/branch/join/human/llm/start/end），draggable，dragstart 写 `dataTransfer` 类型标记。
- 配色复用 `GraphDagView` 的 `NODE_TYPE_COLORS`（抽到共享常量 `workflow/constants.ts`）。

### 5.4 属性面板 `web/src/components/workflow/WorkflowNodeInspector.tsx`
- 选中节点按 type 渲染字段（shadcn Input/Textarea/Select）。
- agent 节点：Agent 选择下拉（`useAgentsPaasStore.agents`）+ "新建 Agent" + "编辑 Agent"（展开 `AgentEditorPanel`）。
- gate：successCriteria/assertions/shellCheck/upstreamNodeId。
- branch：branchKey。human：approvalPrompt/approvalOptions。通用：title。

### 5.5 `AgentEditorPanel` 抽取（`web/src/components/agents/AgentEditorPanel.tsx`）
- 从 `AgentStudioPage.tsx` 抽取创建/编辑表单（name/description/systemPrompt/engine/model/maxTurns/temperature/mounts），props：`agentDefId?`（有则编辑模式 load，无则创建模式）、`onSaved?(agent)`。
- 复用 `useAgentsPaasStore`（`loadAgents`/`create`/`update`/`addMount`/`removeMount`/`loadAvailableResources`）。
- `AgentStudioPage` 改用 `AgentEditorPanel` 渲染右侧详情面板（不回归）。

### 5.6 页面 `web/src/pages/WorkflowEditorPage.tsx` + 路由 `/workflows`
- 三栏布局：左 NodePalette + 中 WorkflowEditorCanvas + 右 WorkflowNodeInspector。
- 顶部工具栏：名称/描述、保存、运行、自动布局、模式切换（edit/run）、"编排 Agent 生成"按钮（弹窗输入复杂流程 → autobuild → 加载草稿）。
- run 模式：渲染 `GraphDagView`（复用运行态）+ `stores/graph.ts` WS 订阅。
- `App.tsx` 加 lazy 路由 `/workflows` → `WorkflowEditorPage`；侧边栏加菜单项"工作流编排"。

### 5.7 工作流列表入口
- `WorkflowEditorPage` 首屏：工作流列表（`GET /api/workflows`）+ "新建空白工作流" + "编排 Agent 生成"。

## 6. 校验
- 保存前前端调既有 `validateDefinition` 逻辑（复刻 graph-registry 的校验，或前端调 `POST /api/workflows` 让后端 `registerDefinition` 抛错返回）。**P0**：后端 `registerDefinition` 已校验并抛错，前端捕获显示；前端做轻量预检（无环 UI 提示）。

## 7. 文件清单（新增/改动）

**新增**：
- `src/routes/workflows.ts`
- `web/src/stores/workflow-editor.ts`
- `web/src/components/workflow/WorkflowEditorCanvas.tsx`
- `web/src/components/workflow/NodePalette.tsx`
- `web/src/components/workflow/WorkflowNodeInspector.tsx`
- `web/src/components/workflow/workflow-constants.ts`（配色/类型元数据）
- `web/src/components/agents/AgentEditorPanel.tsx`（从 AgentStudioPage 抽取）
- `web/src/pages/WorkflowEditorPage.tsx`
- `web/src/api/workflows.ts`（API 客户端）

**改动**（surgical）：
- `src/db.ts`：CREATE TABLE graph_definitions 加 owner_user_id 列；ensureColumn 迁移；SCHEMA_VERSION 56；GraphDefinitionRow 加字段；createGraphDefinition 加列；新增 listWorkflowDefinitions/getWorkflowDefinition；新增 workflow_builds 表 + CRUD。
- `src/graph-engineering/graph-types.ts`：GraphNode 加 `position?: {x:number;y:number}`。
- `src/graph-engineering/graph-registry.ts`：registerDefinition 加 `ownerUserId?` 参数透传。
- `src/agent-team/team-plan.ts`：TeamTaskInput 加 `draft?`；TeamBuildResult.runId 改可选 + 加 `draft?`。
- `src/agent-team/team-builder.ts`：registerDefinition 传 owner；draft 分支跳过 startGraphRun。
- `src/web-context.ts`：WebDeps.buildTeam 签名加 draft。
- `src/web.ts`：挂载 /api/workflows。
- `web/src/App.tsx`：加 /workflows 路由 + 菜单。
- `web/src/pages/AgentStudioPage.tsx`：改用 AgentEditorPanel。

## 8. 测试策略
- 后端单元：`tests/units/` 加 `workflows.test.ts`（save/load/owner 隔离/autobuild draft 不产生 graph_runs）。
- 既有 `make test` 全绿不回归。
- 浏览器 E2E：TC18/TC19（人工编排 + 模式B 生成编辑运行）。
