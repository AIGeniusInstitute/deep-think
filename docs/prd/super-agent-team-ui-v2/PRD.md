# PRD：超级 Agent 团队 — TeamPage 执行视图增强 v2

> 状态：草案 v1，待评审
> 分支：`feat/super-agent-team-ui-v2`
> 作者：DeepThink
> 日期：2026-07-24
> 关联既有：`docs/prd/super-agent-team/PRD.md`（P0+P1 已合并 main：后端 team build 异步+轮询、graph run、trace API、cancel 端点、DAG、节点内子图 trace 全部就绪）
> 本迭代范围：**仅 TeamPage 执行视图的 UI/UX 重构 + trace 面板增强 + 高级选项字段 + 历史回溯**。后端执行/调度/trace 持久化零回归。

---

## 0. 背景与动机

既有 `super-agent-team`（P0/P1）已落地完整后端：Team Builder 自主拆解+创建 Agent+组装 graph+启动（异步 `POST /api/team/runs` + 轮询 `GET /api/team/runs/:buildId`）、graph run 调度执行（`GET /api/graph/runs/:id` 5s 轮询）、节点内子步骤 trace（`GET /api/graph/runs/:id/nodes/:nodeId/trace`）、cancel/resume/rerun/approve 端点、DAG 可视化（`GraphDagView` + React Flow）、节点详情（`GraphNodeDetail` + `NodeTraceSubgraph`）。

但当前 `web/src/pages/TeamPage.tsx`（182 行）的执行视图存在与产品验收标准的差距：

1. **高级选项默认折叠**且仅含"背景/验收标准"，缺"最大团队人数限制 / 可用工具集选择 / 执行模式"。
2. **启动后只渲染 `<GraphDagView>`**（右侧 DAG），**无左侧 Agent 对话面板**——用户看不到多角色对话流、计划说明、工具调用前声明、错误告警。
3. **DAG 节点显示 `node_id`** 而非角色名/Agent 名，不符合"节点显示角色名"。
4. **trace 面板缺**：步骤序号、时间戳、动作类型标签、复制按钮、"查看完整"按钮。
5. **无终止任务按钮**、无最终总结消息、无分割条、无键盘无障碍。
6. **无历史 team 任务列表入口**（后端无 `listTeamBuilds`）。

本 PRD 在不动后端执行层的前提下，补齐以上 6 类差距。

## 1. 目标

把 TeamPage 执行视图从"只有 DAG"升级为"左侧 Agent 对话面板 + 右侧 DAG 任务图 + 节点 trace 全可回溯"的标准超级 Agent 团队工作台，满足用户给出的 8 大验收标准与 28 条测试用例。

## 2. 设计原则（约束本迭代范围）

1. **Surgical Changes**：不改 `graph-engineering/*`（orchestrator/scheduler/runner）、不改 `agent-runner`、不改 `chat-trace-persist`、不改既有 DB schema。仅扩展：`TeamPage.tsx`（重写执行视图）、新增 `AgentConversationPanel` 组件、增强 `NodeTraceSubgraph`、`stores/team.ts`（消息派生）、`src/agent-team/team-plan.ts`（TeamTaskInput 加 3 可选字段）、`team-builder.ts`（落实 3 字段）、`team-prompt.ts`（prompt 注入）、`src/routes/team.ts`（加 list 路由 + body schema）、`src/db.ts`（加 `listTeamBuilds`）。
2. **Simplicity First**：对话面板用**轮询派生**（复用既有 graph store 2s 轮询），不接 WS `stream_event`——WS 的 `text_delta` 不带 `graphRunId/graphNodeId`，关联靠 turnId 前缀启发式且脆弱；轮询天然支持刷新恢复，满足"同步推进无明显延迟"（AC6.1）。无新依赖（分割条自写，不引 resizable-panels）。
3. **Goal-Driven Execution**：高级选项三字段**真实生效**而非装饰——maxTeamSize 截断成员数 + 注入 decompose prompt；executionMode=semi-auto 在 agent 节点间插 human 审批门；toolset 约束 member 的 skills/mcp 挂载集。
4. **向后兼容**：三字段全部可选；缺失时退化为既有行为（auto + 不限人数 + 不限工具）。

## 3. 功能点与验收标准

### 功能点 1：高级选项默认展开 + 三字段 — 对应 AC1

**描述**：`TeamPage` 任务输入区下方的"高级选项"区域默认完全展开；新增三个字段并透传后端落实。

**字段**：
- `maxTeamSize`（数字，默认 6，范围 1–12）：最大团队人数限制。
- `toolset`（多选，候选：web-research / code-execution / file-io / mcp:deepthink 等，默认全选）：可用工具集，约束 member.skills/mcpServers。
- `executionMode`（单选：auto 自动 / semi-auto 半自动，默认 auto）：半自动在 agent 节点后插 human 审批门（复用既有 human 节点 + approve 端点）。

**验收标准**：
- AC1.1 打开 `/team` 时高级选项**默认完全展开**，所有字段可见，无遮挡。
- AC1.2 折叠/展开保留已填内容（maxTeamSize 输入 5、toolset 勾选搜索+代码执行 → 折叠 → 展开，值仍在）。
- AC1.3 三字段透传 `POST /api/team/runs` body；后端 `TeamRunBodySchema` 接受可选 `maxTeamSize/toolset/executionMode`。
- AC1.4 `team-builder`：`maxTeamSize` 截断 `plan.members` 到 N 个 + 注入 decompose prompt（"团队不超过 N 人"）；`toolset` 过滤每个 member 的 skills/mcpServers 到允许集；`executionMode==='semi-auto'` 时 `assembleGraphDefinition` 在每个 agent 节点之后插入一个 human 审批门节点（title=`{role} 产出确认`，approvalPrompt/Options 由角色产出推导，P0 用通用"确认通过/打回重做"两选项）。
- AC1.5 三字段缺失时退化为既有行为（auto + 不限 + 不过滤），既有 team build 不回归。

### 功能点 2：任务提交与执行视图布局 — 对应 AC2/AC8

**描述**：点"组建团队并启动"后**不整页跳转**，仍在 `/team`；执行视图切换为"左侧 Agent 对话面板 + 右侧 DAG"，中间可拖拽分割条。

**验收标准**：
- AC2.1 地址栏保持 `http://127.0.0.1:5173/team`，无整页刷新/跳转。
- AC2.2 布局切换：左 Agent 对话面板 + 右 DAG 可视化区；顶部条含"← 新建团队"、"终止任务"、run 状态。
- AC2.3 组建成功 → 对话面板置系统消息"已成功组建 N 个 Agent 角色：role1、role2…"（来自 `plan.members[].role`）。
- AC2.4 组建失败 → 可读错误提示，输入框/按钮仍可用，不卡死。
- AC8.1 分割条可左右拖拽，两侧宽度同步变化，有最小宽度限制（左 ≥280px、右 ≥360px），松开稳定。
- AC8.2 1366×768 下无横向滚动条，对话面板与 DAG 均在可视区。
- AC8.3 键盘无障碍：任务目标输入框、组建按钮、高级选项各项、终止按钮均可 Tab 聚焦，焦点样式清晰，按钮 Enter 激活。

### 功能点 3：Agent 对话面板 — 对应 AC3

**描述**：新建 `web/src/components/team/AgentConversationPanel.tsx`。轮询派生消息流（不接 WS）。

**消息来源（派生）**：
1. **系统消息**：build complete → "已成功组建 N 个 Agent 角色：…"；run status 变化 → "团队执行开始 / 任务完成 / 任务失败 / 已终止"。
2. **节点状态消息**：nodeRun pending→running → 角色消息"{role} 开始执行：{title}"；running→completed → 角色文本消息（`output_summary`，agent 自然语言产出）；running→failed → 错误告警"{role} 执行失败：{error}"；→skipped → 系统"{title} 被跳过（上游失败）"。
3. **工具摘要消息**：节点 completed 时一次性拉 `GET /nodes/:nodeId/trace`，若 `toolCalls.length>0` → 工具摘要消息"🔧 调用工具：toolA、toolB（共 N 次）"（点查看完整跳转 trace 面板并选中该节点）。
4. **最终总结**：run completed → 末端 gate 节点 output_summary 作为最终总结消息。

**验收标准**：
- AC3.1 每条消息标注发言人（角色图标 + 角色名），不同角色头像/颜色可区分。
- AC3.2 消息类型区分：普通文本 / 工具调用摘要 / 错误告警 / 系统通知，视觉差异（背景色、左侧边框、前缀图标）。错误用红/警示色。
- AC3.3 自动滚动至最新；用户向上滚动查看历史时不强行拉回，新消息时出现"↓ 回到底部"浮动按钮；点击回到底部。
- AC3.4 多角色消息正确显示；并行节点消息交错时有序（按 started_at / 检测时刻排序）。

### 功能点 4：DAG 任务图可视化 — 对应 AC4

**描述**：复用 `GraphDagView`，但节点显示角色名+标题，状态实时更新。

**验收标准**：
- AC4.1 节点显示**角色名/Agent 名 + 标题**（plan.members 按 `agentMember` name 反查 role；非 agent 节点显示 title 如"验收"）。
- AC4.2 节点状态（等待中 pending / 执行中 running / 已完成 completed / 失败 failed / 跳过 skipped / 取消 cancelled）通过颜色/图标实时变化，无需手动刷新。
- AC4.3 自动布局不重叠；支持滚轮缩放 + 拖拽平移（React Flow Controls，既有）。
- AC4.4 点击节点 → 节点高亮 + 右侧滑出节点详情面板（既有 `GraphNodeDetail`，内含 trace）。
- AC4.5 状态变化实时更新（2s 轮询）。

### 功能点 5：节点内步骤 + 工具调用全 Trace 可回溯面板 — 对应 AC5

**描述**：增强 `NodeTraceSubgraph`：步骤序号、时间戳、动作类型、复制、查看完整。

**验收标准**：
- AC5.1 时间线按时间序列，每条步骤含：步骤序号、时间戳（`started_at`）、动作类型（推理 turn / 工具调用 tool / 技能 skill / 子代理 subagent / 评审 review）。
- AC5.2 工具调用条目显示工具名称、格式化输入参数、输出结果（过长截断 + "查看完整"按钮展开）。
- AC5.3 每条步骤可展开/折叠。
- AC5.4 "复制日志"按钮，复制该步骤关键信息（时间、角色、动作、工具、输入/输出）。
- AC5.5 切换节点 → trace 面板内容完全切换，无残留；再次切回数据一致（全量回溯）。
- AC5.6 任务结束后仍可查看任意节点完整执行记录。
- AC5.7 trace 数据持久化，刷新后经历史入口可回溯（依赖 AC7）。

### 功能点 6：实时执行反馈与终态处理 — 对应 AC6

**验收标准**：
- AC6.1 对话面板与 DAG 同步推进（2s 轮询），无明显卡顿。
- AC6.2 全部节点 completed → DAG 全绿 + 对话面板最终总结消息。
- AC6.3 任一节点 failed → 该节点红、下游依赖节点自动 skipped（灰）、对话面板错误摘要、trace 面板失败原因。
- AC6.4 "终止任务"按钮 → 正在执行节点变 cancelled、未开始节点 cancelled、已完成 trace 保留、按钮变灰。
- AC6.5 human 审批门（semi-auto 模式）→ 对话面板渲染审批卡（复用既有 ApprovalCard），点击选项提交（`POST /approve`），下游继续。

### 功能点 7：历史任务回溯 — 对应 AC7（可选，本迭代交付）

**描述**：新增后端 `GET /api/team/runs`（列出当前用户 team_builds，按 created_at desc）+ `listTeamBuilds(ownerUserId, limit)`；TeamPage 落地页加"历史任务"入口，点击重开执行视图（带 plan，角色名完整）。

**验收标准**：
- AC7.1 刷新后通过历史入口找到刚执行的任务，点击重开 → 完整对话 + DAG + 各节点 trace 可回溯。
- AC7.2 历史列表显示 team 名 / 目标摘要 / 状态 / 时间。

## 4. 测试用例集

直接采用用户提供的 28 条测试用例（模块一~八），见 `## 测试用例集` 原文。本 PRD 将其作为验收依据，编号 TC1.1～TC8.3。E2E 执行用浏览器 UI 自动化（登录 admin / 88888888）。

## 5. 非目标（本迭代不做）

- 不接 WS `stream_event` 做逐字流式（P2，需后端给 text_delta 补 graphRunId/graphNodeId 字段）。
- 不改 graph-orchestrator/scheduler/runner 核心调度。
- 不改 agent-runner 内核。
- 不改既有 DB schema（不加表/列）。
- 不做运行中动态 re-plan UI（既有 `/replan` 端点保留，前端不暴露）。
- 不做移动端适配（AC8 仅要求不严重错位）。

## 6. 风险与陷阱

- ❌ **对话消息乱序**：并行节点状态变更在轮询间批量到达，需按 `started_at` + 节点依赖排序，避免"完成"先于"开始"。缓解：消息带 `started_at` 时间戳，渲染前排序；去重靠 `nodeRun.id+status` 键。
- ❌ **轮询频率与成本**：2s 轮询 + 每完成节点一次 trace 拉取。缓解：trace 仅在节点首次转 completed 时拉一次（缓存）；run 终态（completed/failed/cancelled）后停止轮询。
- ❌ **maxTeamSize 截断破坏图依赖**：若 LLM 产出 8 成员但 maxTeamSize=4，截断可能丢弃被依赖的成员导致 graph 引用不存在的 agentMember。缓解：截断后校验 graph.nodes.agentMember 全部存在于剩余 members；若不满足，保留被引用成员（按依赖闭包保留）而非硬切。
- ❌ **semi-auto 审批门阻塞执行**：human 节点 pause run 等用户。缓解：复用既有 approve 端点 + ApprovalCard；对话面板明确提示"等待审批"。
- ❌ **历史 list 性能**：team_builds 行数增长。缓解：list 默认 limit 20，按 owner 索引（既有 `idx_team_builds_owner`）。

## 7. 里程碑

| 里程碑 | 内容 | 对应功能点 |
|--------|------|-----------|
| M1 | 后端：TeamTaskInput 加 3 字段 + team-builder 落实 + team 路由 list + listTeamBuilds | FP1/FP7 |
| M2 | 前端：stores/team 消息派生 + AgentConversationPanel + trace 增强 + 分割条 + TeamPage 执行视图重构 | FP2/FP3/FP5/AC8 |
| M3 | DAG 节点角色名显示（GraphDagView 复用 plan 映射） | FP4 |
| M4 | E2E 浏览器自动化执行 28 用例 + 修复循环 | 全部 |
| M5 | 测试报告 + 合并 main | — |
