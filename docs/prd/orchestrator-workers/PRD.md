# PRD：主 Agent 编排子 Agent（Orchestrator–Workers 模式）

> 状态：草案 v1
> 分支：`feat/orchestrator-workers`
> 作者：DeepThink
> 日期：2026-08-28
> 关联既有能力：复用 `agent_definitions`（Agent Studio 用户级 Agent 定义）+ `agent_mounts`（skill/mcp/kb 挂载）+ `graph-engineering`（DAG 编排执行层，已支持 `GraphNode.agentDefId` 引用既有 Agent 定义执行）。

---

## 0. 背景与动机

DeepThink 已有两条"多 Agent"路径，但都未覆盖"用户显式指定角色分工"的场景：

1. **单主 Agent 串行**：一个主 Agent 从头到尾完成用户任务，遇到复杂任务容易"提前宣布完成 / 忘记目标 / 中途停下问人"。
2. **`super-agent-team`（超级 Agent 团队）**：Team Builder 用 LLM **自主拆解任务 → 自主创建 Agent 成员 → 自主组装 DAG → 执行**。这条路径的 Agent 成员是**运行时临时生成的**，用户无法复用自己在 Agent Studio 里精心调教的既有 Agent，也无法指定"谁来干哪一类活"。

本需求新增第三条路径——**Orchestrator–Workers 模式**：

> 用户在 Agent Studio 中创建并调教好若干子 Agent（Workers，各自有独立的 system prompt / 引擎 / 工具挂载）；再创建一个**主 Agent（编排者 / Orchestrator）**，从既有 Agent 中**勾选多个 Workers 关联**到它；当用户给主 Agent 下发一个复杂任务时，主 Agent **自主拆解任务并分派给被关联的 Workers 协作完成**。

关键差异（相对 super-agent-team）：

| 维度 | super-agent-team | orchestrator–workers（本需求） |
|------|------------------|-------------------------------|
| Worker 来源 | 运行时 LLM 自主创建（一次性） | 用户在 Agent Studio **预先创建、可复用、可迭代** |
| 角色分派 | LLM 自主设计成员 | 用户**显式勾选**哪些 Worker 参与 |
| 编排大脑 | 通用 decompose prompt | **主 Agent 自身的 system prompt**（用户定义的编排人设） |
| 复用性 | 一次任务即弃 | Workers 可被多个编排者复用 |

---

## 1. 目标

**需求 1（主 Agent 类型 + Worker 关联）**：Agent Studio 支持把 Agent 标记为"编排者（orchestrator）"类型；编排者 Agent 可关联（多选）其他既有 Agent 作为其 Workers，关联可随时增删改查。

**需求 2（主 Agent 自主编排执行）**：用户给编排者 Agent 下发复杂任务后，主 Agent 依据自身 system prompt + 已关联的 Workers 花名册，自主规划分派方案（哪个 Worker 干哪个子任务、先后/并行顺序），并驱动 Workers 依次/并行执行，最终产出交付物。

**需求 3（全链路可观测）**：编排执行过程复用 DAG 任务图可视化（节点 = 被分派的 Worker），每个 Worker 节点内部执行步骤可回溯；编排规划（谁被分派了什么）可回溯。

---

## 2. 设计原则（约束本 PRD 范围）

1. **复用，不推翻**：本需求是 `super-agent-team` 的"用户显式指定成员"变体，不推翻 graph-engineering / agent-definitions，只在其上加一层"用户配置的编排者 → Worker 关联 + 编排者自主规划"。Worker 执行 100% 复用 `GraphNode.agentDefId` 既有路径（`loadGroupAgentDefinition` → `ContainerInput.agentDefinition`）。
2. **Workers 是既有 agent_definitions**：不发明新的 Agent spec。关联表只存 `(orchestrator_id, worker_id, position)`。
3. **编排大脑 = 编排者自身 system prompt**：规划阶段用 `sdkQuery`（单轮、无工具）把编排者 system prompt 作为"编排人设" + 注入 Workers 花名册 + 用户任务，产出结构化分派计划 JSON；严格 schema 校验，非法即拒绝并降级。
4. **行为证据优先于 LLM 自述**：末端验收沿用 super-agent-team 的 gate 断言/`shellCheck` 行为证据闭环，杜绝"agent 自述完成即完成"。
5. **Simplicity First**：P0 只做"编排者类型 + Worker 关联 CRUD + 编排者自主规划 + DAG 执行 + 可观测"。运行中动态 re-plan、human 审批门、循环节点列为 P1+。
6. **Surgical Changes**：只新增 `agent_definitions.kind` 一列、`agent_worker_links` 一张表、一个新 orchestrator-runner 模块、paas-agents 若干路由、Agent Studio 前端若干区块；**不改** graph-scheduler/orchestrator/runner 核心调度、**不改** agent-runner 内核、**不改** container-runner。

---

## 3. 功能点与验收标准

### 功能点 1：Agent 类型（编排者 / 普通）— P0

**描述**：`agent_definitions` 新增 `kind` 列（`'assistant'` 默认 / `'orchestrator'` 编排者）。创建/编辑 Agent 时可指定类型；类型可切换。`kind='orchestrator'` 的 Agent 展示"关联 Worker"能力。

**验收标准**：
- AC1.1 `POST /api/paas/agents` 接受可选 `kind`（`'assistant'` 默认 / `'orchestrator'`），DB 落库 `agent_definitions.kind`。
- AC1.2 `PATCH /api/paas/agents/:id` 接受可选 `kind`，可切换类型；切换为 `'orchestrator'` 不清空既有 Worker 关联。
- AC1.3 `GET /api/paas/agents` 与 `GET /api/paas/agents/:id` 返回 `kind` 字段。
- AC1.4 缺省（旧数据）`kind` 视作 `'assistant'`，既有行为不回归。

### 功能点 2：编排者关联 Worker（多选）— P0

**描述**：新增 `agent_worker_links` 表 + CRUD 端点，编排者可关联（多选）其他既有 Agent 作为 Workers。

**验收标准**：
- AC2.1 `PUT /api/paas/agents/:id/workers`（body `{ workerIds: string[] }`）整体替换该编排者的 Worker 集合（幂等）。
- AC2.2 `GET /api/paas/agents/:id/workers` 返回关联 Worker 列表（含 id/name/description/avatar，按 position 排序）。
- AC2.3 校验：`workerIds` 只能是**当前用户自己**的、`id != 编排者自身`的、`kind != 'orchestrator'` 的 Agent；非法项整体拒绝并返回结构化错误，不产生部分副作用。
- AC2.4 被关联的 Worker 被删除时，关联行级联清除（外键 `ON DELETE CASCADE`）；编排者被删除时同理。
- AC2.5 一个 Agent 可同时是多个编排者的 Worker（多对多）。

### 功能点 3：编排者自主规划 + 执行 — P0

**描述**：新增 orchestrator-runner：接收 `{ orchestratorId, task, background?, acceptanceCriteria? }`，加载编排者定义 + 关联 Workers，用编排者 system prompt 规划分派计划，组装标准 `GraphDefinition`（agent 节点引用 Worker 的 `agentDefId` + 携带 `goalAnchor`），注册并启动 graph run。

**规划输出契约**（编排者 LLM 产出、zod 校验后落地）：
```jsonc
{
  "planName": "slug",
  "steps": [
    {
      "id": "research",                  // 节点 id（slug）
      "title": "需求调研",
      "workerId": "<agent_definitions.id>", // 必须 ∈ 已关联 Workers
      "task": "调研 X 并产出 docs/report.md",
      "dependsOn": []                    // 依赖的其他 step id
    }
  ],
  "acceptanceCriteria": "……"             // 从用户输入继承，注入末端验收 gate
}
```

**验收标准**：
- AC3.1 `runOrchestrator(input)` 用 `sdkQuery`（maxTurns:1、无工具、model=编排者.model）调一次编排者规划；规划 JSON 非法（缺 steps / workerId 不在关联集 / 有环 / 引用不存在 step）→ 重试 1 次 → 仍失败降级为"按关联顺序串行分派"的兜底计划。
- AC3.2 组装 `GraphDefinition`：每个 step 一个 `agent` 节点，`agentDefId = workerId`、`agentMember = worker.name`、`goalAnchor = 任务目标 + step.task`、`prompt = step.task`；边由 `dependsOn` 推导；末端追加"验收 gate"节点（`assertions`/`shellCheck` 行为证据，见功能点 4）。
- AC3.3 注册 `registerDefinition` + `startGraphRun` + `buildRunContext` + `executeGraph`（100% 复用 graph-engineering），返回 `{ runId, plan }`。
- AC3.4 无 Worker 关联（0 个）→ 直接返回结构化错误（"请先关联至少一个子 Agent"）。
- AC3.5 规划全程输出 trace（plan JSON、组装后的图、启动的 runId），可回溯"编排者如何分派"。

### 功能点 4：行为证据验收闭环 — P0

**描述**：编排执行末端自动追加验收 gate，以行为证据断言（harness-eval 风格）+ 可选 shellCheck 判定是否完成任务目标；失败则循环重跑上游 Worker 节点，直到通过或耗尽预算。

**验收标准**：
- AC4.1 末端 gate 的 `assertions` 来自 `acceptanceCriteria`（关键字 regex/contains），`successCriteria` 为验收文本；`upstreamNodeId` 指向最后一个 Worker 节点。
- AC4.2 gate failed → graph 既有 retry/rerun 重跑上游 Worker（带 `goalAnchor` 重申）；retry 耗尽 → graph status=failed。
- AC4.3 graph status=completed **当且仅当**验收 gate 行为证据通过。
- AC4.4 无 `acceptanceCriteria` 时降级为 LLM-only gate（向后兼容），行为同 super-agent-team。

### 功能点 5：前端 —— Agent Studio 编排者类型 + Worker 选择器 + 编排运行入口 — P0

**描述**：Agent Studio 编辑面板新增"类型"切换（普通 / 编排者）；类型为编排者时展示"关联子 Agent"多选面板（列出当前用户其他非编排者 Agent）；提供"编排运行"入口（输入任务 → 调用 orchestrate → 跳转 graph 运行可视化）。

**验收标准**：
- AC5.1 创建/编辑 Agent 时可选择类型；选择"编排者"后出现 Worker 多选面板。
- AC5.2 Worker 多选面板列出当前用户**其他**非编排者 Agent，支持搜索/勾选/保存；保存调用 `PUT /:id/workers`。
- AC5.3 "编排运行"入口：输入任务文本（+可选背景/验收标准）→ `POST /:id/orchestrate` → 拿到 runId 后跳转到既有 Graph 运行详情（`/graph` 或 `/team` 执行视图）实时查看 DAG。
- AC5.4 编排者 Agent 卡片/详情展示已关联 Worker 数量与名称。

---

## 4. MVP（P0）范围明确

**本迭代交付**：
- FP1 Agent 类型（`kind`）
- FP2 编排者关联 Worker（`agent_worker_links` + CRUD）
- FP3 orchestrator-runner（编排者自主规划 + 组装 graph + 启动执行）
- FP4 行为证据验收闭环（复用 super-agent-team gate）
- FP5 前端（类型切换 + Worker 多选 + 编排运行入口）

**本迭代不交付（P1+）**：
- 运行中动态 re-plan（编排者执行中途调整分派）— P1
- 编排者在规划中插入 human 审批门（semi-auto）— P1
- 编排者跨多个 Workers 的流式对话面板（复用 TeamPage 会话面板）— P1
- 编排者模板 / 团队自进化学习 — P2
- 设计态拖拽建图 — P2

---

## 5. 测试用例

| ID | 用例 | 验收映射 |
|----|------|---------|
| TC1 | `POST /api/paas/agents` 带 `kind:'orchestrator'` → DB 落库 kind=orchestrator；缺省 → assistant | AC1.1/1.4 |
| TC2 | `PATCH /api/paas/agents/:id` 切换 kind；`GET` 返回 kind | AC1.2/1.3 |
| TC3 | `PUT /:id/workers` 设置 3 个 worker → `GET /:id/workers` 按 position 返回 3 个 | AC2.1/2.2 |
| TC4 | `PUT /:id/workers` 传非法 workerId（他人 Agent / 自身 / 编排者）→ 400/结构化错误，无部分副作用 | AC2.3 |
| TC5 | 删除 Worker Agent → 关联行级联清除 | AC2.4 |
| TC6 | 同一 Worker 关联到两个编排者 → 两边都能列出 | AC2.5 |
| TC7 | 编排者规划产出合法计划（≥2 steps、workerId 均在关联集、无环）→ 组装 graph，agent 节点带 agentDefId+goalAnchor | AC3.1/3.2 |
| TC8 | 规划 JSON 非法（workerId 不在关联集/有环）→ 重试后降级为串行兜底计划 | AC3.1 |
| TC9 | 无 Worker 关联 → `runOrchestrator` 返回结构化错误 | AC3.4 |
| TC10 | `runOrchestrator` 成功 → 返回 runId；DB 出现 graph_definitions + graph_runs（running/pending） | AC3.3 |
| TC11 | 末端 gate 行为证据通过 → graph completed；失败 → retry 上游；耗尽 → failed | AC4.2/4.3 |
| TC12 | 无 acceptanceCriteria → 降级 LLM-only gate | AC4.4 |
| TC13 | 浏览器 UI：创建编排者 → 勾选 2 个 Worker → 编排运行 → 看到 DAG 实时执行 → 节点点击看子图 | AC5.1~5.4 |
| TC14 | 未登录调用 orchestrate/workers → 401 | 全局 auth |

---

## 6. 风险与陷阱

- ❌ **编排者规划产出非法 JSON / 引用非关联 Worker**：严格 zod 校验 + 重试 1 次 + 兜底串行计划；workerId 必须在关联集内，否则视为非法。
- ❌ **编排者 system prompt 注入越权**：编排者 system prompt 只作为规划阶段的"人设"注入 `sdkQuery`（无工具、maxTurns=1），不参与 Worker 实际执行；Worker 执行走既有 `agent_definitions` 注入 + `security-rules`/`mount-security` 安全段，编排者无权提权。
- ❌ **Workers 无关联时误启动**：`runOrchestrator` 前置校验 worker 数量，0 个直接报错。
- ❌ **graph 节点并发写冲突**：并行 Worker 节点写同一目录。缓解：沿用 graph-engineering P0 约定（DISJOINT artifacts）；编排者规划 prompt 明确要求各 step 交付物不重叠。
- ❌ **Schema 迁移破坏既有 DB**：`ALTER TABLE agent_definitions ADD COLUMN kind`（IF NOT EXISTS 模式）+ `CREATE TABLE IF NOT EXISTS agent_worker_links`，不动既有列。

---

## 7. 非目标（明确不做）

- 不替换 / 不修改 `super-agent-team`、SubAgent、Conversation Agent、Supervisor 既有机制。
- 不改 graph-scheduler/orchestrator/runner 核心调度、agent-runner 内核、container-runner。
- 不做运行中动态 re-plan（P1）、human 审批门（P1）、流式多角色对话面板（P1）、团队自进化（P2）。
- 不引入外部图数据库或 trace 后端。

---

## 8. 里程碑

| 里程碑 | 内容 | 对应功能点 |
|--------|------|-----------|
| M1 | DB：`agent_definitions.kind` 列 + `agent_worker_links` 表 + CRUD 函数 | FP1/FP2 基座 |
| M2 | 类型 + schema + paas-agents 路由（kind、workers CRUD、orchestrate） | FP1/FP2 |
| M3 | orchestrator-runner（规划 + 组装 graph + 启动 + 验收 gate） | FP3/FP4 |
| M4 | 前端：Agent Studio 类型切换 + Worker 多选 + 编排运行入口 | FP5 |
| M5 | 构建 + 单元测试 + 端到端 API 验证 + 修复循环 | 全部 |
| M6 | 测试报告 + 合并 main | — |
