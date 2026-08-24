# PRD：Agent Workflow 可视化编排 —— 多 Agent 工作流的编排、单节点编辑与运行

> 状态：草案 v1，待评审
> 分支：`feat/agent-workflow-editor`（worktree：`~/deepthink/.worktrees/feat-agent-workflow-editor`）
> 作者：DeepThink
> 日期：2026-08-25
> 关联既有能力：复用 `graph-engineering`（DAG 编排与执行引擎，P0 已落地）、`agent-team/team-builder`（自主拆解 + 创建 Agent 集群 + 组装 GraphDefinition，已落地）、Agent Studio / PaaS Agents（`agent_definitions` + `agent_mounts` + `AgentStudioPage`，已落地）。

---

## 0. 背景与动机

DeepThink 已具备单 Agent 串行执行（Loop）、DAG 编排执行（Graph Engineering P0）、以及"自主组建 Agent 团队"（Super Agent Team）三档能力。但当前**用户无法在界面上手动把多个 Agent 编排成一个 Workflow 并运行**：

- 现有 `GraphDagView`（`web/src/components/graph/GraphDagView.tsx`）是**只读运行态可视化**：未接 `onNodesChange`/`onEdgesChange`/`onConnect`，节点位置由 `dagreLayout` 自动布局，不可拖拽增删节点或连线（证据：全项目 grep `onConnect`/`useNodesState`/`addEdge` 均 0 命中）。
- `GraphPage`（`/graphs`）只有运行列表 + 续跑/暂停/取消，**无"新建图""编辑图"入口**。
- `stores/graph.ts` 只有运行控制 action（`startRun`/`resumeRun`/`rerunNode` 等），**无 `addNode`/`updateNode`/`saveDefinition` 等编辑态 action**。
- 模式B 的"编排 Agent 智能创建 Agent 集群"**已由 `team-builder.ts` 实现**（`buildTeam`：LLM 拆解 → 为每个 member 创建 `agent_definitions` 行 → 组装标准 `GraphDefinition` → `startGraphRun`，100% 复用 graph-engineering 执行层），但当前 `TeamPage` 是"一键组建即跑"的**只读、fire-and-forget** 模式：用户无法在生成后**单节点编辑**某个 Agent（改它的 systemPrompt / 工具挂载 / 模型），也无法手动调整图结构。
- Agent 的创建/编辑能力（Agent Studio / PaaS Agents）已成熟（`/api/paas/agents` CRUD + `agent_mounts` + `AgentStudioPage.tsx` + `useAgentsPaasStore`），但与 Workflow 编排画布**未打通**：编排画布上的 agent 节点不能就地复用 Agent Studio 编辑。

本 PRD 在既有引擎之上新增**可视化编排编辑层 + 单节点 Agent 编辑闭环**，让用户既能"人工拖拽编排"也能"由编排 Agent 智能生成后再逐节点精修"，两种模式产出的都是同一个标准 `GraphDefinition`，复用既有执行引擎运行。

## 1. 目标

**需求1（人工可视化编排）**：用户在 Web 界面上通过可编辑 DAG 画布，从节点调色板拖拽添加 Agent 节点（及 gate / branch / human / join 等控制节点）、手动连线、拖拽定位、在右侧属性面板编辑节点属性；agent 节点可"选择已有 Agent"或"新建 Agent"（复用 Agent Studio 的创建/编辑能力）。编排完成后保存为工作流定义并一键启动运行。

**需求2（编排 Agent 智能生成 + 单节点编辑）**：用户输入一个复杂业务流程描述，由**编排 Agent**（复用 `team-builder` 的拆解 + 创建 Agent 集群 + 组装图能力）智能生成一个 Agent Workflow 草稿，加载进**同一个可视化编辑器**，用户可对任意节点（Agent）就地编辑（复用 Agent Studio 的创建/编辑 Agent 能力），调整图结构后保存并运行。

**需求3（运行与可观测）**：编排好的 Agent Workflow 复用既有 `graph-engineering` 执行引擎运行（DAG 调度、checkpoint、断点续跑、行为证据 gate、trace 全链路可回溯），运行态在同一画布上实时高亮、可查看节点内子步骤 trace。

## 2. 设计原则（约束本 PRD 范围）

1. **Workflow = GraphDefinition**，不发明新的执行引擎或新的图规格。本 PRD 产出的工作流就是标准 `GraphDefinition`（`graph-engineering/graph-types.ts`），节点复用 `agent|gate|branch|join|human|llm|start|end` 等既有类型，agent 节点复用既有 `agentDefId`/`goalAnchor`/`agentMember` 字段。运行 100% 复用 `graph-orchestrator`/`graph-runner`/`graph-scheduler`，零改动核心调度。
2. **复用编排 Agent**：模式B 的"编排 Agent"**复用 `team-builder.ts`**，不另起一套拆解/创建/组装逻辑（Simplicity First + 用户明确的"复用"意图）。新增仅是一个"draft 草稿模式"：让 `buildTeam` 在创建 Agent 集群 + 组装 + 注册定义后**不立即 `startGraphRun`**，而是把定义返回给前端编辑器加载；用户编辑后再显式运行。
3. **复用 Agent Studio 编辑能力**：agent 节点的"单节点编辑"复用 `useAgentsPaasStore`（`create`/`update`/`addMount`/`removeMount`）与 `AgentStudioPage` 的表单片段，抽取为可复用的 `AgentEditorPanel` 组件，编排画布与 Agent Studio 共用。不重写 Agent 编辑逻辑。
4. **Surgical Changes**：不改动 `graph-scheduler`/`graph-orchestrator`/`graph-runner` 核心；不改动既有 `GraphDagView`（只读运行态画布保持原样供运行查看），而是**新增**一个可编辑画布组件 `WorkflowEditorCanvas`；`graph_definitions` 表仅**加列**（`owner_user_id`，向后兼容），不动既有列。
5. **Simplicity First**：P0 只做"人工编排 + 编排 Agent 生成草稿 + 单节点编辑 + 保存运行 + 运行态高亮"。运行中动态 re-plan 画布（已有 `/api/graph/runs/:id/replan` API，P0 不做画布内重规划 UI）、循环节点、团队结构自进化列为 P1/P2。
6. **Goal-Driven**：每个功能点附可测验收标准与测试用例，闭环验证。

## 3. 关键决策与假设（待评审）

> 以下 3 项是影响实现路径的关键判断，编码前需确认。

**A1. 模式B 的"编排 Agent"复用 `team-builder`，而非新写一套。**
- 理由：`team-builder.ts` 已完整实现"LLM 拆解 → 创建 `agent_definitions` 集群 → 组装 `GraphDefinition`"，与用户"基于编排 Agent 智能创建一个 Agent 集群，编排成一个 Agent Workflow"的描述一致；用户全文贯穿"复用"原则（"Agent 创建复用 Agent studio"）。新写一套将违反 Simplicity First。
- 新增：给 `buildTeam` 增加一个 `draft: true` 选项（或新增 `planTeam()` 入口）：执行拆解 + 创建成员 + 组装 + `registerDefinition`，但**不 `startGraphRun`**，返回 `{definitionId, definition, plan}` 供编辑器加载。
- **若用户期望"编排 Agent"是一个独立于 team-builder 的全新 Agent（不同 prompt/策略），请在此项明确否决**，否则按复用推进。

**A2. `graph_definitions` 加 `owner_user_id` 列 + 新增用户级 `/api/workflows` 路由。**
- 现状：`graph_definitions`（`src/db.ts:481-495`）无 owner，`POST /api/graph/definitions` 为 admin-only（`src/routes/graph.ts:66-70`），定义是全局共享的。
- 本功能要让普通用户创建/保存自己的工作流，故：`graph_definitions` 新增可空列 `owner_user_id`（既有行回填 NULL，向后兼容；team-builder 产生的定义也补 owner）；新增 `GET/POST/PUT /api/workflows`（用户级，复用 `registerDefinition`/`deserializeDefinition`，按 owner 过滤）。既有 `/api/graph/definitions`（admin）不动。
- 不引入新的"workflow"表——工作流就是 graph_definition（A1 决定的复用）。

**A3. 单节点编辑 = 在编排画布属性面板内嵌 Agent Studio 编辑能力。**
- agent 节点属性面板提供"选择已有 Agent"下拉（来自 `useAgentsPaasStore.agents`）+ "新建 Agent"按钮（调 `useAgentsPaasStore.create` 后绑定 `agentDefId`）+ "编辑 Agent"（展开内嵌 `AgentEditorPanel`：编辑 systemPrompt/model/engine/maxTurns/temperature/挂载，全部走 `useAgentsPaasStore.update`/`addMount`/`removeMount`）。
- `AgentEditorPanel` 从 `AgentStudioPage.tsx` 抽取（抽取后 AgentStudioPage 也改用之，避免重复实现；这是 Surgical 的"清理自己引入的重复"）。
- 也可提供"在 Agent Studio 中打开"跳转 `/agents` 聚焦该 Agent，作为备选交互。

## 4. 功能点与验收标准

> P0（MVP 必做）/ P1（紧跟）/ P2（后续）

### 功能点 1：可编辑 DAG 画布（WorkflowEditorCanvas）— P0

**描述**：新增 `web/src/components/workflow/WorkflowEditorCanvas.tsx`，基于已安装的 `@xyflow/react`（`web/package.json:22`）实现可编辑画布。与只读 `GraphDagView` 并列、互不干扰。接入 `useNodesState`/`useEdgesState`/`onConnect`(addEdge)/`onNodesChange`/`onEdgesChange`/`nodesDraggable`，节点可拖拽定位、可增删、可从 handle 拉线连边。

**验收标准**：
- AC1.1 画布支持从左侧调色板拖拽（`@dnd-kit` 或 ReactFlow `onDrop`）添加节点：agent / gate / branch / join / human / llm / start / end。新增节点自动生成唯一 id 与默认字段。
- AC1.2 节点可拖拽改位置，位置持久化到工作流定义（节点 `position` 字段或前端草稿态），保存后重新打开位置不丢。
- AC1.3 节点 handle 拉线 → `onConnect` 生成新边（默认 `type:'data'`）；边可选中删除；可编辑边 `condition`/`expression`/`isDefault`（branch 出边）。
- AC1.4 节点可选中（高亮）、可删除（Delete 键或按钮），删除节点同时删除其关联边。
- AC1.5 画布支持自动布局按钮（复用 `dagreLayout`）与手动布局切换；支持 MiniMap/Controls（复用 GraphDagView 同款）。
- AC1.6 画布内 DAG 校验：保存前调用既有 `validateDefinition`（`graph-registry.ts:91-172`）——无环、唯一 id、无 dangling edge、必填字段齐全；校验失败给出可读错误且不保存。

### 功能点 2：节点调色板与属性面板 — P0

**描述**：新增左侧 `NodePalette`（可拖拽的节点类型清单，复用 `GraphDagView` 的 `NODE_TYPE_COLORS` 配色）与右侧 `WorkflowNodeInspector`（选中节点的属性编辑表单，复用 shadcn/ui）。

**验收标准**：
- AC2.1 调色板列出全部可编排节点类型，拖拽到画布生成对应类型节点（agent 节点默认 `agentDefId` 为空，提示未绑定）。
- AC2.2 属性面板按节点类型显示对应字段：
  - agent：title、agentDefId（Agent 选择器，见 FP3）、goalAnchor、prompt、maxAttempts。
  - gate：successCriteria、assertions、shellCheck、upstreamNodeId。
  - branch：branchKey、condition/expression（出边）。
  - human：approvalPrompt、approvalOptions、approvalStateKey。
  - 通用：id（只读）、title、type（只读）。
- AC2.3 属性变更实时反映到画布（受控状态），未保存前为"草稿态"。
- AC2.4 顶部工具栏：工作流名称/描述可编辑、保存、另存为新版本、运行、自动布局。

### 功能点 3：Agent 节点单节点编辑（复用 Agent Studio）— P0

**描述**：agent 节点的属性面板内嵌 `AgentEditorPanel`（从 `AgentStudioPage` 抽取），实现"选择已有 Agent / 新建 Agent / 编辑当前 Agent"三种操作，全部复用 `useAgentsPaasStore` 与 `/api/paas/agents` 既有 API。

**验收标准**：
- AC3.1 agent 节点属性面板有 Agent 选择下拉，列出当前用户 `agent_definitions`（调 `useAgentsPaasStore.loadAgents`）；选中即把 `agentDefId` 绑定到节点，节点标题显示该 Agent 名。
- AC3.2 "新建 Agent"按钮：弹出 `AgentEditorPanel` 创建表单（name/systemPrompt/engine/model/maxTurns/temperature/mounts），调 `useAgentsPaasStore.create` + `addMount` 创建后自动绑定 `agentDefId` 到当前节点。
- AC3.3 "编辑 Agent"按钮：在面板内展开 `AgentEditorPanel` 加载该 `agentDefId` 的定义，编辑后调 `useAgentsPaasStore.update`/`addMount`/`removeMount` 持久化；保存即更新 `agent_definitions` 行（运行时 `loadGroupAgentDefinition` 自然读到最新）。
- AC3.4 未绑定 `agentDefId` 的 agent 节点在保存校验时被标记警告（可保存但运行时退化为默认 agent，复用既有向后兼容行为）；运行前可一键补绑。
- AC3.5 `AgentEditorPanel` 抽取后 `AgentStudioPage` 改用同一组件，行为与原版一致（不回归）。

### 功能点 4：工作流持久化与运行 — P0

**描述**：新增用户级工作流 CRUD（`/api/workflows`）+ "保存 → 运行"串联。运行复用既有 `startGraphRun` + `executeGraph`。

**验收标准**：
- AC4.1 `GET /api/workflows`：返回当前用户的 `graph_definitions`（`owner_user_id = 当前用户`，或 admin 看全部），含节点数/版本/更新时间。
- AC4.2 `POST /api/workflows`：body `{id?, name, description, nodes, edges, stateSchema?}`，复用 `registerDefinition` 注册新版本，写入 `owner_user_id`；返回 `{id, version, hash}`。id 缺省自动生成（`wf-{userId}-{slug}`）。
- AC4.3 `PUT /api/workflows/:id`：更新既有工作流（注册下一版本），owner 校验（非本人非 admin 返回 404 不泄露存在性，与 graph 路由惯例一致）。
- AC4.4 `GET /api/workflows/:id`：返回定义详情（nodes/edges/stateSchema），供编辑器加载。
- AC4.5 画布"保存"按钮调 `POST` 或 `PUT`；"运行"按钮调既有 `POST /api/graph/runs`（`{definitionId, groupFolder, chatJid, goalText}`），成功后画布切换到运行态视图（复用 `GraphDagView` 渲染 + `stores/graph.ts` 的 WS 订阅做实时高亮）。
- AC4.6 `graph_definitions` 新增 `owner_user_id TEXT` 列（`ALTER TABLE ADD COLUMN` IF NOT EXISTS，`SCHEMA_VERSION` 顺延），既有行回填 NULL；team-builder 创建的定义补写 owner。

### 功能点 5：编排 Agent 智能生成草稿（模式B）— P0

**描述**：在编辑器新增"编排 Agent 生成"入口：用户输入复杂业务流程描述 → 调 `buildTeam({...,draft:true})`（复用 team-builder 拆解 + 创建 Agent 集群 + 组装 + 注册，不启动 run）→ 返回的 `definition` 加载进可编辑画布，用户单节点编辑后保存运行。

**验收标准**：
- AC5.1 `buildTeam` 支持 `draft:true`（或新增 `planTeam` 函数）：执行 decompose（`sdkQuery` 拆解）+ `createMemberAgent`（创建 `agent_definitions` 行 + `agent_mounts`）+ `assembleGraphDefinition` + `registerDefinition`，但**不调用 `startGraphRun`/不启动后台 executeGraph**；返回 `{definitionId, definition, plan}`。
- AC5.2 新增 `POST /api/workflows/autobuild`（用户级，authMiddleware）：body `{goalText, background?, acceptanceCriteria?, groupFolder, chatJid, maxTeamSize?, toolset?, executionMode?}`，后台/同步调用 `buildTeam({draft:true})`，返回 `{definitionId, plan}` 供前端加载。复用既有 `/api/team/runs` 的 detached 执行模式应对 ~21s 同步前缀阻塞。
- AC5.3 前端编辑器"编排 Agent 生成"面板：输入框 + 高级选项（复用 `TeamPage` 的 maxTeamSize/toolset/executionMode 选项）→ 调 `POST /api/workflows/autobuild` → 加载返回的 `definition` 到画布（agent 节点显示成员角色、gate 显示"验收"）。
- AC5.4 生成后用户可：①直接保存运行；②单节点编辑某个 Agent（FP3）后保存运行；③调整图结构（增删节点/改连线）后保存运行。三种路径都产出标准 `GraphDefinition` 走既有执行引擎。
- AC5.5 编排 Agent 生成失败（LLM 产出非法 JSON、拆解超时）时返回结构化错误，不产生半成品副作用（已创建的 agent_definitions 幂等可复用，下次同 teamName 复用而非重复创建——既有 `buildTeam` 行为）。

### 功能点 6：运行态可视化与 trace（复用）— P0

**描述**：工作流运行后，在画布上复用既有 `GraphDagView` 运行态渲染 + `stores/graph.ts` WS 订阅，实时高亮节点状态、点击 agent 节点看节点内子步骤 trace。

**验收标准**：
- AC6.1 运行态画布复用既有 `graph_*` 流式事件（`graph_node_start/status/end`/`edge_taken`）做增量 overlay：running 脉冲 / completed 绿 / failed 红 / paused 黄、taken 边动画（复用 `DataFlowEdge`）。
- AC6.2 点击运行态 agent 节点 → 调既有 `GET /api/graph/runs/:id/nodes/:nodeId/trace` → 渲染节点内子步骤 span 树 + 工具调用 input/output（复用 `NodeTraceSubgraph`）。
- AC6.3 运行控制（pause/resume/cancel/rerun/approve）复用 `stores/graph.ts` 既有 action 与 `GraphNodeDetail` 按钮，不新写控制逻辑。
- AC6.4 编辑态与运行态在同一页面切换：未运行显示编辑画布，运行中/已运行显示运行态画布 + 可切回编辑（编辑会注册新版本，复用既有版本机制）。

## 5. MVP（P0）范围明确

**本迭代交付**：
- FP1 可编辑 DAG 画布（WorkflowEditorCanvas）
- FP2 节点调色板 + 属性面板
- FP3 Agent 节点单节点编辑（抽取 AgentEditorPanel，复用 useAgentsPaasStore）
- FP4 工作流持久化与运行（graph_definitions 加 owner_user_id + /api/workflows CRUD + 保存运行串联）
- FP5 编排 Agent 智能生成草稿（buildTeam draft 模式 + /api/workflows/autobuild）
- FP6 运行态可视化与 trace（复用既有）

**本迭代不交付（P1+）**：
- 画布内运行中动态 re-plan（既有 `/api/graph/runs/:id/replan` API 已就绪，P0 不做画布内重规划 UI）— P1
- 循环节点 / 动态子图 — P2
- 团队结构自进化（跨 run 复用最优模板）— P2
- 工作流模板市场 / 分享 — P2
- 飞书 IM 审批推送（沿用 super-agent-team P1 非目标）— P1

## 6. 测试用例（P0 子集）

| ID | 用例 | 验收映射 |
|----|------|---------|
| TC1 | 打开 `/workflows` 新建空白工作流，从调色板拖入 1 个 start + 2 个 agent + 1 个 end 节点，手动连边形成 DAG，拖拽改位置，保存成功；重新打开位置/结构不丢 | AC1.1-1.4/4.2 |
| TC2 | 构造有环图（A→B→A），保存时 `validateDefinition` 拒绝并给出"存在环"错误，不落库 | AC1.6/4.2 |
| TC3 | 删除中间节点，其关联边同步删除；删除后图无 dangling edge，保存通过 | AC1.4/1.6 |
| TC4 | agent 节点属性面板 Agent 选择下拉列出当前用户 `agent_definitions`；选中后节点 `agentDefId` 绑定、标题变更 | AC3.1 |
| TC5 | agent 节点"新建 Agent"：填 name/systemPrompt/engine/model/mounts 提交后，DB `agent_definitions`+`agent_mounts` 新增行，节点 `agentDefId` 自动绑定到新 id | AC3.2 |
| TC6 | agent 节点"编辑 Agent"：改 systemPrompt 保存，`PATCH /api/paas/agents/:id` 落库；重新打开节点显示最新 systemPrompt | AC3.3 |
| TC7 | 抽取 `AgentEditorPanel` 后 AgentStudioPage（`/agents`）创建/编辑 Agent 行为不回归（与原版一致） | AC3.5 |
| TC8 | `POST /api/workflows` 保存工作流，DB `graph_definitions` 新增行且 `owner_user_id=当前用户`；`GET /api/workflows` 列出该行；未登录 401 | AC4.1/4.2 |
| TC9 | `PUT /api/workflows/:id` 更新注册下一版本（version++）；非 owner 非 admin 访问返回 404 | AC4.3 |
| TC10 | 保存后点"运行"，调 `POST /api/graph/runs` 返回 runId，画布切运行态，节点状态实时高亮 | AC4.5/6.1 |
| TC11 | 运行态点击 agent 节点，显示节点内子步骤 trace 树 + 工具调用 input/output | AC6.2 |
| TC12 | 模式B：输入复杂任务调 `POST /api/workflows/autobuild`，返回 definitionId + plan；`buildTeam({draft:true})` 未调用 `startGraphRun`（无 graph_runs 行产生），但 `agent_definitions`+`graph_definitions` 行已创建 | AC5.1/5.2 |
| TC13 | 模式B 生成草稿加载进画布，agent 节点显示成员角色、gate 显示"验收"；用户单节点编辑某 Agent 后保存运行，运行使用编辑后的 agent 定义 | AC5.3/5.4 |
| TC14 | 模式B LLM 产出非法 JSON 时返回结构化错误，前端显示，无半成品 graph_definitions 落库（或幂等可复用） | AC5.5 |
| TC15 | 既有 `GraphPage`（`/graphs`）只读运行态、`TeamPage`（`/team`）一键组建即跑行为不回归 | AC1（并列）/ — |
| TC16 | 既有 `/api/graph/definitions`（admin）路由行为不变；既有 team-builder `buildTeam({draft:false/默认})` 即跑行为不变 | AC4（不动）/5.1 |
| TC17 | DB schema 迁移：`graph_definitions` 加 `owner_user_id` 列，既有行回填 NULL，既有 graph/team 功能不回归 | AC4.6 |
| TC18 | 浏览器 UI（admin/Test12345! 或普通用户）端到端：登录→/workflows→人工编排 3 节点→保存→运行→看到实时高亮→点节点看 trace | AC1/4/6 |
| TC19 | 浏览器 UI 端到端模式B：/workflows→输入复杂业务流程→编排 Agent 生成草稿→单节点编辑一个 Agent→保存运行→执行通过 | AC5/3/4/6 |
| TC20 | `make test`（既有测试套件）全绿，不引入回归 | — |

## 7. 风险与陷阱清单

- ❌ **可编辑画布与只读 GraphDagView 状态冲突**：复用 `stores/graph.ts` 的 run/definition 类型，但编辑草稿态不能污染运行态。缓解：新增 `stores/workflow-editor.ts` 独立管草稿态（draftNodes/draftEdges/positions），运行态仍用 `stores/graph.ts`；二者通过"保存→加载定义"衔接。
- ❌ **ReactFlow 编辑态与运行态视图切换抖动**：编辑画布与 `GraphDagView` 是两套布局逻辑。缓解：同一页面按 `mode: 'edit'|'run'` 切换组件，节点 id 对齐，避免重新挂载丢状态。
- ❌ **编排 Agent 草稿模式副作用**：`buildTeam({draft:true})` 仍会创建 `agent_definitions` 行，用户若放弃编辑会留"孤儿 Agent"。缓解：复用 `buildTeam` 既有幂等（同 teamName+member 复用）；提供"清理未使用 Agent"辅助按钮（P1），P0 接受孤儿 Agent（用户可在 Agent Studio 管理）。
- ❌ **`POST /api/workflows/autobuild` 同步阻塞 ~21s**：`buildTeam` 同步前缀（decompose → sdkQuery 握手）会阻塞。缓解：复用 `/api/team/runs` 的 detached 后台执行 + 轮询模式（`POST` 立即返回 buildId，`GET /api/workflows/autobuild/:buildId` 轮询）。
- ❌ **`graph_definitions` 加列迁移破坏既有 DB**：缓解：`ALTER TABLE ADD COLUMN IF NOT EXISTS`（既有 db.ts 迁移惯例），既有行回填 NULL，不动既有列。
- ❌ **Agent 定义越权**：编排画布编辑的 agent 节点可能引用他人 Agent。缓解：`useAgentsPaasStore` 已按当前用户加载 `agent_definitions`（`/api/paas/agents` 按 owner 过滤）；`/api/workflows` 保存时只校验 agentDefId 存在性，运行时 `loadGroupAgentDefinition` 既有 owner 校验生效。
- ❌ **位置持久化膨胀 nodes_json**：节点 position 写进 `nodes_json`，体积可控（每节点 2 数字）；可接受。

## 8. 非目标（明确不做）

- 不替换/重写 `graph-engineering` 执行引擎或 `graph-scheduler`/`graph-orchestrator`/`graph-runner` 核心。
- 不重写 `team-builder` 拆解/创建/组装逻辑（仅加 draft 选项）。
- 不重写 Agent Studio / `useAgentsPaasStore`（仅抽取共用 `AgentEditorPanel`）。
- 不改动既有 `GraphDagView`（只读运行态）与 `GraphPage`/`TeamPage` 行为。
- 不做画布内运行中 re-plan UI（P1）、循环节点（P2）、团队自进化（P2）、工作流市场（P2）。
- 不引入新数据库（继续 SQLite）或新图数据库。

## 9. 里程碑

| 里程碑 | 内容 | 对应功能点 |
|--------|------|-----------|
| M1 | DB schema 加列（`graph_definitions.owner_user_id`）+ db.ts CRUD（`listWorkflowDefinitions(userId)`/`saveWorkflowDefinition`）+ `/api/workflows` CRUD 路由 | FP4 基座 |
| M2 | 抽取 `AgentEditorPanel` + AgentStudioPage 改用 + `useAgentsPaasStore` 联动验证 | FP3 |
| M3 | `stores/workflow-editor.ts`（草稿态）+ `WorkflowEditorCanvas`（可编辑 ReactFlow）+ `NodePalette` + `WorkflowNodeInspector` | FP1/FP2 |
| M4 | `buildTeam({draft:true})`/`planTeam` + `POST /api/workflows/autobuild`（detached+轮询）+ 编辑器"编排 Agent 生成"面板 | FP5 |
| M5 | `WorkflowEditorPage`（`/workflows`）路由 + 保存/运行串联 + 编辑↔运行态切换 + 运行态复用 GraphDagView/trace | FP4/FP6 |
| M6 | 测试用例 TC1-TC20 执行 + bug 修复循环 + 浏览器 E2E（TC18/TC19） | 全部 |

---

## 10. 后续 P1/P2 展望（不在本迭代）

- 画布内运行中 re-plan：基于既有 `POST /api/graph/runs/:id/replan`，在运行态画布上编辑未完成节点并提交新版本。
- 循环节点 / 动态子图（`graph-engineering` P2 占位）。
- 团队结构自进化：跨 run 复用最优团队模板（`super-agent-team` P2）。
- 工作流模板市场：复用既有 `agent_shares` 模式分享 Workflow 定义。
- "清理未使用 Agent"巡检：识别编排产生的孤儿 `agent_definitions`。
