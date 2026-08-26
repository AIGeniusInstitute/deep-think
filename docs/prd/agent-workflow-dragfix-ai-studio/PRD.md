# PRD：Agent Workflow 拖拽修复 + 编排功能完善 + Agent Studio AI 生成/优化

> 状态：v1，待评审
> 分支：`feat/agent-workflow-ai-studio`（worktree：`~/deepthink/.worktrees/feat-agent-workflow-ai-studio`）
> 作者：DeepThink
> 日期：2026-08-26
> 关联既有能力：Agent Workflow 可视化编排（`feat/agent-workflow-editor`，已合入 main）、Agent Studio / PaaS Agents（`agent_definitions` + `AgentStudioPage`，已落地）、Skills AI 生成/优化范式（`skill-ai.ts` + `routes/skills.ts` + `OptimizeSkillDialog.tsx`，已落地，作为本次 Agent AI 能力的镜像范本）。

---

## 0. 背景与动机

上一轮 `feat/agent-workflow-editor` 已把 Agent Workflow 可视化编排能力（可编辑 DAG 画布、节点调色板、属性检视器、用户级 CRUD、team-builder draft 模式 AI 编排、运行态复用 graph-engineering）完整落地并合入 main。但当前存在两类问题：

### 问题 A（Bug）：拖拽组件到工作流画布上无法拖拽

- **用户现象**：新建一个空工作流后，从左侧 NodePalette 拖拽节点瓷砖（agent/gate/branch/human/llm/start/end）到画布，鼠标显示「禁止」光标，松手后节点不出现——**从空工作流起步时完全无法通过拖拽添加第一个节点**，编辑器不可用，只能靠「AI 编排」或打开已有工作流绕过。
- **根因**：`web/src/components/workflow/WorkflowEditorCanvas.tsx:98-105` 的空状态分支走 early return，渲染的占位 div **没有挂 `onDrop`/`onDragOver` 处理器**；而真正的 drop 处理器只挂在第 108 行的 wrapper div 上（空状态下根本不渲染）。HTML5 DnD 规范要求 drop 目标必须在 `dragover` 中 `preventDefault()` 才能成为有效 drop 区，故空状态下 drop 永远被浏览器丢弃。
- 非根因（已排除）：ReactFlow 内部 pane 的 `touch-action`/`pointer-events`/`z-index`（wrapper 渲染时事件可正常冒泡，仅空状态 early return 路径失效）。

### 问题 B（新功能）：Agent Studio 缺少 AI 自动生成 / AI 优化能力

- **现状**：Agent Studio 新建 Agent 是纯手填弹窗（name/description/engine/model/system_prompt/max_turns/temperature + 挂载区），用户要写出一套专业的业务领域 system_prompt 门槛高。Skills 模块已有成熟的 AI 生成/优化范式（`skill-ai.ts` 的 `generateSkillContent`/`optimizeSkillContent` + `routes/skills.ts` 的 `/create`、`/:id/optimize`、`/:id/optimize/apply` + 前端 `OptimizeSkillDialog`），但 Agent 侧**完全没有**对应能力，连半成品都没有。
- **目标**：在 Agent Studio 新建界面增加「AI 自动生成」——根据 Agent name 或简单基础描述，AI 自动生成一个专业业务领域 Agent（填好 description/system_prompt/model/engine/max_turns/temperature 等字段，可建议挂载资源）；在 Agent 详情/编辑界面增加「AI 优化」——对已有 Agent 的 system_prompt 等字段做 AI 优化，预览 diff 后一键应用。

### 问题 C（功能完整性）：编排工作流端到端测试与修复

- 上一轮虽已落地，但拖拽 bug 说明存在未被测试覆盖的路径。本次需对编排工作流做端到端功能完整性测试（人工拖拽编排全链路、AI 编排 draft 生成 + 单节点编辑、保存、运行），发现并修复存在的 bug。

## 1. 目标

1. **FP1（P0 Bugfix）**：修复空状态画布拖拽失效，确保任意时刻（空 / 非空）从 NodePalette 拖拽节点到画布都能成功落点。
2. **FP2（P0 Feature）**：Agent Studio 新增「AI 自动生成 Agent」：输入 name / 简短描述 → AI 生成完整 Agent 字段（预览）→ 用户确认后落库为 `agent_definitions` 行。
3. **FP3（P0 Feature）**：Agent Studio 新增「AI 优化 Agent」：对已有 Agent 调 AI 优化 system_prompt/description 等字段 → 预览 → 一键应用（写回 `agent_definitions`）。
4. **FP4（P0 Quality）**：编排工作流端到端功能完整性测试，发现并修复 bug，产出测试报告。

## 2. 设计原则（约束范围）

1. **镜像 Skills AI 范式**：Agent AI 生成/优化**镜像** `skill-ai.ts` + `routes/skills.ts` 的实现结构，复用 `sdkQuery`（`src/sdk-query.ts`，maxTurns=1、无工具、纯文本 in/out），不引入新的 LLM 调用链路（Simplicity First）。
2. **复用 Agent Studio 既有字段与 CRUD**：AI 生成/优化产出的字段直接对齐 `AgentDefinitionCreateSchema`/`AgentDefinitionPatchSchema`（`schemas.ts:260-289`），落库走既有 `createAgentDefinition`/`updateAgentDefinition`，不新建表、不加列（Surgical Changes）。
3. **复用 AgentEditorPanel**：AI 生成结果预览复用既有 `AgentEditorPanel`（create/edit 双模式）渲染表单，不另写一套预览组件。
4. **Surgical Changes**：拖拽修复只改 `WorkflowEditorCanvas.tsx` 的空状态渲染路径，不动 ReactFlow 配置、不动 NodePalette、不动 store；AI 优化只新增 `agent-ai.ts` + `paas-agents.ts` 端点 + `agents-paas.ts` action + `AgentStudioPage` UI 按钮/对话框，不重构既有 Agent 编辑逻辑。
5. **Goal-Driven**：每个功能点附可测验收标准与测试用例，闭环验证。

## 3. 关键决策与假设

**A1. 拖拽修复策略：空状态提示作为 overlay 渲染在 wrapper 内部，而非 early return 替换 wrapper。**
- 理由：根因是空状态 early return 绕过了挂 drop 处理器的 wrapper。最简修复是把空状态提示作为绝对定位 overlay 叠加在 wrapper 内部（wrapper 始终渲染），使 `onDrop`/`onDragOver` 始终生效；空状态下 ReactFlow 渲染空 nodes/edges 即可（ReactFlow 本身支持空画布）。也可选择给占位 div 补 `onDrop`/`onDragOver` 并让 wrapperRef 指向它——但 overlay 方案与正常路径一致、边界更少，优先采用。
- **若用户期望其他交互（如空状态点击直接添加默认 agent 节点），请在此项明确否决**，否则按 overlay 方案推进。

**A2. AI 生成 Agent 返回结构化字段而非自由文本，后端解析为 JSON。**
- 理由：Agent 字段是结构化的（name/description/system_prompt/model/engine/max_turns/temperature），不像 skill 是单块 Markdown。让 LLM 返回 JSON（`{name, description, system_prompt, model, engine, max_turns, temperature}`），后端 `agent-ai.ts` 解析 + 校验 + 容错（strip code fences → JSON.parse → 字段兜底）。
- model/engine 的建议：LLM 给出建议值，但 engine 限定在 `['claude','atomcode','codex','opencode','pi']` 枚举内（schema 已约束），越界回退 `'claude'`；model 给字符串建议或 null。
- 不在 AI 生成阶段挂载资源（mcp/skill/kb）——资源挂载需要资源列表上下文，P0 保持简单，生成后由用户手动挂载（Simplicity First）。可选后续增强：把 `/resources/available` 列表喂给 LLM 让它建议挂载。

**A3. AI 优化只优化「软字段」，不动 engine/model/挂载。**
- 理由：engine/model 切换是用户强意图决策，AI 不应擅自改；挂载资源是结构性变更。AI 优化聚焦 `system_prompt`（主）和 `description`（次），返回优化后的两个字段供预览 diff，用户确认后 PATCH 写回。max_turns/temperature 不在优化范围（数值类字段 LLM 优化意义不大）。

**A4. AI 生成/优化走「预览 → 确认 → 落库」两步，不走「直接落库」。**
- 理由：镜像 Skills 的 `optimize` 返回内容 + `optimize/apply` 两步范式；生成也是先返回预览、用户在表单里可再编辑、点保存才落库。防止 AI 一次产出直接覆盖用户既有 Agent。

## 4. 功能点与验收标准

### FP1：修复空状态画布拖拽失效（Bugfix）

**描述**：`WorkflowEditorCanvas` 在 nodes 为空时仍渲染带 `onDrop`/`onDragOver` 的 wrapper（空状态提示作 overlay），使任意时刻拖拽均生效。

**验收标准（AC）**：
- AC1.1 新建空工作流 → 从 NodePalette 拖「agent」节点到画布 → 松手后画布出现一个 agent 节点（类型/标题正确）。
- AC1.2 空状态下拖入节点后，节点位置接近鼠标落点（非全跑到 {80,80}）。
- AC1.3 非空状态下从 NodePalette 拖入新节点仍正常落点（回归不破坏）。
- AC1.4 空状态下拖入非 agent 类型（gate/branch/human/llm/start/end）同样可落点。
- AC1.5 空状态 overlay 在有节点后自动消失（不遮挡画布）。

### FP2：Agent Studio AI 自动生成 Agent（Feature）

**描述**：Agent Studio 新建 Agent 弹窗增加「AI 生成」入口，用户输入 name 或简短描述，AI 生成完整字段填入表单，用户可编辑后保存。

**验收标准（AC）**：
- AC2.1 Agent Studio 新建弹窗存在「AI 生成」按钮/区域，输入框接受 name + 简短描述（描述 ≥ 10 字符）。
- AC2.2 点击生成 → loading 态 → 返回后表单 name/description/system_prompt/model/engine/max_turns/temperature 被填充（system_prompt 非空且为专业领域内容）。
- AC2.3 engine 字段值在枚举 `['claude','atomcode','codex','opencode','pi']` 内（越界回退 claude）。
- AC2.4 生成失败（provider 不可用 / 超时 / 空返回）时显示明确错误提示，不崩 UI。
- AC2.5 生成后用户可改任意字段，点保存 → 落库为 `agent_definitions` 行，列表刷新可见。
- AC2.6 后端 `POST /api/paas/agents/generate` 返回结构化字段（不落库），前端用于填表。

### FP3：Agent Studio AI 优化 Agent（Feature）

**描述**：Agent 详情/编辑面板增加「AI 优化」按钮，对当前 Agent 的 system_prompt/description 调 AI 优化，预览 diff 后一键应用。

**验收标准（AC）**：
- AC3.1 Agent 详情面板存在「AI 优化」入口，可选填反馈意见。
- AC3.2 点击优化 → loading → 返回优化后的 system_prompt + description，以 diff/对比形式预览。
- AC3.3 用户可「应用」优化结果 → PATCH 写回 `agent_definitions`（system_prompt/description 更新，engine/model/挂载不变）。
- AC3.4 用户可「取消」不应用，原字段不变。
- AC3.5 优化失败显示明确错误，不覆盖原字段。
- AC3.6 后端 `POST /api/paas/agents/:id/optimize` 返回预览（不落库），`POST /api/paas/agents/:id/optimize/apply` 写回。

### FP4：编排工作流端到端功能完整性测试（Quality）

**描述**：对已合入 main 的 Agent Workflow 编排能力做端到端测试，覆盖人工拖拽编排全链路、AI 编排 draft 生成 + 单节点编辑、保存、运行，修复发现的 bug。

**验收标准（AC）**：
- AC4.1 人工编排：拖拽多个节点（含 agent）→ 连线 → 编辑属性 → 保存为工作流定义 → 列表可见 → 重新打开结构完整。
- AC4.2 AI 编排：输入业务描述 → AI 生成 draft → 加载进编辑器 → 单节点编辑 Agent（改 systemPrompt/绑定）→ 保存。
- AC4.3 运行：编排好的工作流可启动运行，运行态在画布高亮（复用 GraphDagView）。
- AC4.4 发现的所有 bug 已修复或记录（无法修复的列入 issue 文档并说明）。

## 5. 测试用例

### TC-FP1：拖拽修复

| 用例 ID | 步骤 | 预期 |
|---|---|---|
| TC1.1 | 新建空工作流；从 NodePalette 拖 agent 瓷砖到画布空白区松手 | 画布出现 1 个 agent 节点 |
| TC1.2 | TC1.1 后再拖 gate 节点到画布 | 出现 gate 节点 |
| TC1.3 | 新建空工作流；拖 branch 节点 | 出现 branch 节点（覆盖非 agent 类型 + 空状态） |
| TC1.4 | 非空工作流（已有 2 节点）；拖 human 节点 | human 节点正常落点 |
| TC1.5 | 拖入节点后观察空状态提示 | 提示消失，不遮挡节点 |
| TC1.6 | 拖拽时观察鼠标光标 | 显示 move 光标，非禁止光标 |

### TC-FP2：AI 生成

| 用例 ID | 步骤 | 预期 |
|---|---|---|
| TC2.1 | 新建弹窗 → 输入 name「代码审查专家」+ 描述「review PR」→ 点 AI 生成 | loading 后表单填充，system_prompt 含审查相关内容 |
| TC2.2 | TC2.1 检查 engine 字段 | 值在枚举内 |
| TC2.3 | 描述 < 10 字符点生成 | 显示校验错误，不发请求 |
| TC2.4 | 模拟 provider 不可用（断 key）点生成 | 显示「provider 不可用」类错误，UI 不崩 |
| TC2.5 | 生成后改 system_prompt → 保存 | 列表出现新 Agent，字段正确 |
| TC2.6 | 直接调 `POST /api/paas/agents/generate` body `{name, description}` | 200 返回结构化字段，不落库 |

### TC-FP3：AI 优化

| 用例 ID | 步骤 | 预期 |
|---|---|---|
| TC3.1 | 选中已有 Agent → 详情面板点 AI 优化（无反馈） | loading → 返回优化后 system_prompt + description |
| TC3.2 | TC3.1 预览展示 | diff/对比可见前后差异 |
| TC3.3 | 点应用 | PATCH 写回，详情刷新，engine/model 不变 |
| TC3.4 | 点取消 | 原字段不变 |
| TC3.5 | 填反馈「更简洁」点优化 | 优化结果体现简洁倾向 |
| TC3.6 | 直接调 `POST /api/paas/agents/:id/optimize` | 200 返回预览，不落库 |
| TC3.7 | TC3.6 后调 `POST /api/paas/agents/:id/optimize/apply` | 200 写回，DB 中 system_prompt/description 更新 |

### TC-FP4：编排端到端

| 用例 ID | 步骤 | 预期 |
|---|---|---|
| TC4.1 | 拖 agent + gate + end 节点 → 连 agent→gate→end → 保存 | 保存成功，列表可见 |
| TC4.2 | 重新打开 TC4.1 工作流 | 节点 + 连线结构完整 |
| TC4.3 | agent 节点绑定已有 Agent → 编辑 systemPrompt → 保存 | 绑定 + 编辑生效 |
| TC4.4 | 输入业务描述 → AI 编排 → draft 加载编辑器 | 节点就位，可单节点编辑 |
| TC4.5 | TC4.4 编辑后保存 → 运行 | 运行启动，画布高亮 |

## 6. 非目标（Out of Scope）

- P0 不做 AI 生成时自动建议挂载 mcp/skill/kb 资源（A2 已述）。
- P0 不做 AI 优化 engine/model/挂载（A3 已述）。
- 不重构既有 Agent 编辑表单、不换 DnD 库（继续用原生 HTML5 DnD）。
- 不做运行中动态 re-plan 画布 UI、循环节点（沿用上一轮 P1/P2 边界）。
- 不新增「编排 Agent」独立 Agent（沿用 `team-builder` 复用决策）。

## 7. 交付物

- 本 PRD（含验收标准 + 测试用例）
- 技术方案 `docs/tech_solution/agent-workflow-dragfix-ai-studio/SOLUTION.md`
- 执行状态 `docs/task_state/agent-workflow-dragfix-ai-studio/STATE.md`
- 测试报告 `docs/test_report/agent-workflow-dragfix-ai-studio/REPORT.md`
- 编码改动（worktree 分支）
- 合并到 main 并 push
