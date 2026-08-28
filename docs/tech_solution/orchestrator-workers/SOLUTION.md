# 技术方案：主 Agent 编排子 Agent（Orchestrator–Workers 模式）

> 分支：`feat/orchestrator-workers`
> 关联 PRD：`docs/prd/orchestrator-workers/PRD.md`
> 关联既有：`src/agent-team/`（super-agent-team）、`src/graph-engineering/`（DAG 编排执行层）、`src/routes/paas-agents.ts`（Agent Studio）、`src/container-runner.ts`（`loadGroupAgentDefinition`）。

---

## 1. 方案总览

本需求是 `super-agent-team` 的"用户显式指定成员"变体。核心思路：

> 用户创建**编排者 Agent**（`agent_definitions.kind='orchestrator'`），通过 `agent_worker_links` 表**显式勾选**既有 Agent（Workers）。用户给编排者下发任务后，新增的 `orchestrator-runner.ts` 用**编排者自身的 system prompt** 做规划（LLM 单轮，产出分派计划），把计划组装成标准 `GraphDefinition`（agent 节点 `agentDefId` 指向被分派的 Worker），随后 **100% 复用 graph-engineering** 完成执行、调度、checkpoint、断点续跑、行为证据验收。

复用点（零改动）：
- `GraphNode.agentDefId` + `goalAnchor` → `runAgentNode` 加载 Worker 的 agent_definition 执行（`graph-runner.ts`）。
- `loadGroupAgentDefinition` / `ContainerInput.agentDefinition` → Worker 的 system prompt / 引擎 / skill/mcp 挂载注入（`container-runner.ts`）。
- `registerDefinition` / `startGraphRun` / `buildRunContext` / `executeGraph` → 图注册、启动、后台执行（`graph-engineering`）。
- gate 断言 / `shellCheck` 行为证据验收（`harness-eval.ts:scoreAssertion` + `script-runner.ts`）。

新增点（本方案实现）：
1. DB：`agent_definitions.kind` 列 + `agent_worker_links` 表 + CRUD 函数。
2. 类型/schema：`AgentDefinition.kind`、Create/Patch schema 加 `kind`。
3. 路由：`paas-agents` 加 workers CRUD + orchestrate 端点。
4. 运行器：`src/agent-orchestration/orchestrator-runner.ts`（规划 → 组装 → 启动）。
5. 装配：`WebDeps.runOrchestrator` + `index.ts` 装配。
6. 前端：Agent Studio 类型切换 + Worker 多选 + 编排运行入口。

---

## 2. 数据模型

### 2.1 `agent_definitions` 加列

```sql
ALTER TABLE agent_definitions ADD COLUMN kind TEXT NOT NULL DEFAULT 'assistant';
```

- 取值：`'assistant'`（普通，默认）/ `'orchestrator'`（编排者）。Workers 就是普通 `'assistant'` Agent，被关联到编排者后即成为其 Worker（不新增 `'worker'` 枚举，避免过度设计——见 PRD §2 原则 5）。
- 迁移用既有 `ensureColumn('agent_definitions', 'kind', "TEXT NOT NULL DEFAULT 'assistant'")`，幂等、不动既有列。

### 2.2 新表 `agent_worker_links`

```sql
CREATE TABLE IF NOT EXISTS agent_worker_links (
  id TEXT PRIMARY KEY,
  orchestrator_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (orchestrator_id, worker_id),
  FOREIGN KEY (orchestrator_id) REFERENCES agent_definitions(id) ON DELETE CASCADE,
  FOREIGN KEY (worker_id) REFERENCES agent_definitions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_worker_links_orch ON agent_worker_links(orchestrator_id);
CREATE INDEX IF NOT EXISTS idx_worker_links_worker ON agent_worker_links(worker_id);
```

- 多对多：一个编排者可关联多个 Worker；一个 Worker 可被多个编排者复用。
- `position` 保证 Worker 展示顺序（与用户勾选顺序一致）。
- 外键级联：Worker 或编排者被删时关联自动清除。

### 2.3 DB CRUD 函数（`src/db.ts`）

- `setAgentWorkers(orchestratorId, workerIds: string[])` — 事务内先删后插（整体替换，幂等）。
- `listAgentWorkers(orchestratorId)` — 返回 Worker 的 `agent_definitions` 行（按 position 排序）。
- `getAgentDefinition` / `listAgentDefinitions` / `createAgentDefinition` / `updateAgentDefinition` 增补 `kind` 读写；`AgentDefinitionRow` 增补 `kind` 字段。

---

## 3. 类型与 schema

### 3.1 `types.ts`

```ts
export type AgentKind = 'assistant' | 'orchestrator';
export interface AgentDefinition { ... kind: AgentKind; ... }
```

### 3.2 `schemas.ts`

`AgentDefinitionCreateSchema` / `AgentDefinitionPatchSchema` 增补：
```ts
kind: z.enum(['assistant', 'orchestrator']).optional(),
```

### 3.3 `web-context.ts`（WebDeps）

```ts
runOrchestrator?: (input: OrchestratorRunInput) => Promise<OrchestratorRunResult | OrchestratorRunError>;
```
其中 `OrchestratorRunInput` / `OrchestratorRunResult` 类型从 `agent-orchestration/orchestrator-types.ts` 导入。

---

## 4. orchestrator-runner（核心）

文件：`src/agent-orchestration/orchestrator-runner.ts`（+ `orchestrator-types.ts`、`orchestrator-plan.ts`、`orchestrator-prompt.ts`）。

### 4.1 输入 / 输出契约

```ts
interface OrchestratorRunInput {
  orchestratorId: string;      // 编排者 agent_definitions.id
  task: string;                // 用户复杂任务
  background?: string;
  acceptanceCriteria?: string;
  ownerUserId: string;
  groupFolder: string;         // graph run 工作区
  chatJid: string;             // 流式/通知目标
}
type OrchestratorRunResult = { runId: string; definitionId: string; definitionVersion: number; plan: OrchestratorPlan };
type OrchestratorRunError = { error: string; detail?: string };
```

### 4.2 规划阶段（编排者自主分派）

`planOrchestration(input, orchestratorDef, workers)`：

1. 加载编排者 `system_prompt`、`model`。
2. 构造规划 prompt（`orchestrator-prompt.ts`）：
   - 编排者人设：编排者 `system_prompt`（或默认"你是资深项目主管…"）。
   - Workers 花名册：每个 Worker 的 `id` / `name` / `description`（截断）。
   - 用户任务 + 背景 + 验收标准。
   - 输出契约：严格 JSON（planName + steps[]，每个 step 的 `workerId` 必须来自花名册 id，`dependsOn` 引用 step id）。
3. `sdkQuery(prompt, { model: orchestratorDef.model, timeout: 120s })`，单轮、无工具。
4. `parseOrchestratorPlan(raw, workerIdSet)` 做 zod 校验 + 完整性校验（workerId ∈ 关联集、dependsOn 引用存在、无环、至少 1 step）。
5. 失败重试 1 次；仍失败 → **兜底计划**：按关联顺序串行，每 Worker 一步，task 拆成"请基于上游产出完成 [task] 中你负责的部分"。

### 4.3 组装 GraphDefinition

`assembleOrchestratorGraph(plan, workerById, input)`：

- 每个 step → `agent` 节点：`id=step.id`、`title=step.title`、`agentDefId=step.workerId`、`agentMember=worker.name`、`prompt=step.task`、`goalAnchor=任务目标+step.task`、`isIdempotent=false`。
- 边由 `dependsOn` 推导；无依赖的 step 相互并行（graph 调度器按 maxParallel 并发）。
- 末端追加"验收 gate"节点（复用 super-agent-team `assembleGraphDefinition` 的 gate 逻辑）：`successCriteria`、`upstreamNodeId=最后 agent 节点`、`assertions=[{kind:'regex', value: acceptanceCriteria 前 60 字符转义}]`；无 `acceptanceCriteria` 时退化为 LLM-only gate（无 assertions）。

### 4.4 注册 + 启动

```ts
const registered = registerDefinition(def, input.ownerUserId);
const started = startGraphRun({
  definitionId: def.id, ownerUserId, groupFolder, chatJid, goalText: input.task,
});
buildRunContext(started.runId, deps).then(ctxRes => executeGraph(ctxRes.ctx, deps));
```

返回 `{ runId, definitionId, definitionVersion, plan }`。执行在后台 detached（同 `buildTeam`）。

### 4.5 校验与前置条件

- `orchestratorId` 必须存在且 `kind==='orchestrator'`（否则报"该 Agent 不是编排者"）。
- Workers 数量 ≥ 1（0 个报"请先关联至少一个子 Agent"）。
- Workers 均为当前用户自己的、`kind!=='orchestrator'` 的 Agent（关联时就已保证，运行前二次校验兜底）。

---

## 5. 路由（`src/routes/paas-agents.ts` 扩展）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST / GET / PATCH / DELETE | `/api/paas/agents[/:id]` | 增补 `kind` 读写（既有端点） |
| PUT | `/api/paas/agents/:id/workers` | body `{ workerIds: string[] }`，整体替换关联（幂等） |
| GET | `/api/paas/agents/:id/workers` | 列出关联 Worker（id/name/description/avatar_emoji/avatar_color，按 position） |
| POST | `/api/paas/agents/:id/orchestrate` | body `{ task, background?, acceptanceCriteria?, groupFolder?, chatJid? }`，运行编排，返回 `{ runId, plan }` |

**orchestrate 的 groupFolder/chatJid 来源**：优先取 body；缺省时复用/创建该编排者的确定性工作区 `web:agent-orch-{agentId}`（folder `agent-orch-{agentId}`，`agentDefId` 绑定编排者），与 `test-chat` 端点同构——这样前端无需感知工作区概念即可一键运行。

**权限**：所有端点 `authMiddleware`；workers/orchestrate 仅限 Agent owner（`getAgentDefinition(id, user.id)` 已隐含 owner 校验，他人 404）。

---

## 6. 装配（`index.ts`）

在 `webDeps.buildTeam = (input) => buildTeam(input, graphDeps);` 同块内追加：

```ts
webDeps.runOrchestrator = (input) => runOrchestrator(input, graphDeps);
```

`runOrchestrator` 复用同一个 `graphDeps`（含 `registeredGroups` / `broadcastStreamEvent` / `storeResultAndNotify` / `storeApprovalCard`），无需新 deps。

---

## 7. 前端

### 7.1 Agent Studio 编辑面板（`web/src/pages/AgentStudioPage.tsx`）

- 表单加"类型"单选（普通 / 编排者），映射 `kind`。
- `kind==='orchestrator'` 时渲染"关联子 Agent"多选面板：拉 `GET /api/paas/agents` 过滤出当前用户**其他**且 `kind!=='orchestrator'` 的 Agent；勾选 → 保存时 `PUT /:id/workers`。
- 编排者卡片/详情展示已关联 Worker 数量 + 名称。

### 7.2 编排运行入口

- 编排者详情页加"编排运行"按钮 → 弹窗输入任务文本（+可选背景/验收标准）→ `POST /:id/orchestrate` → 拿到 `runId` → 复用既有 Graph/Team 执行视图（`GraphDagView` + 节点 trace）实时查看。

### 7.3 store

- 复用/扩展 `web/src/api/` 里 paas-agents 客户端 + `web/src/stores/`，新增 `runOrchestrator` / `setWorkers` / `getWorkers` 方法。

---

## 8. 测试策略

1. **单元测试**（vitest）：`orchestrator-plan.ts` 的 `parseOrchestratorPlan`（合法/非法 workerId/有环/缺 steps）、`assembleOrchestratorGraph`（节点 agentDefId/goalAnchor、边、末端 gate）、`agent_worker_links` CRUD（幂等替换、级联删除、多对多）。
2. **API 验证**（`make start-prod PORT=9898` + curl）：登录 → 建 2 个普通 Agent（Worker）+ 1 个编排者 → 关联 workers → orchestrate → 轮询 graph run 状态 → 校验 DAG 与完成态。
3. **浏览器 E2E**（可选，P0 以 API + 前端构建通过为准）：登录 admin/88888888 → Agent Studio 创建编排者 → 勾选 Worker → 编排运行 → 看 DAG。

---

## 9. 风险与缓解

- **编排者规划非法 JSON / 引用非关联 Worker**：zod 严格校验 + 重试 1 次 + 串行兜底计划（PRD §6）。
- **Worker 执行越权**：编排者 system prompt 仅参与规划（无工具单轮）；Worker 执行走既有安全段注入，不新增提权路径。
- **并发写冲突**：规划 prompt 明确要求各 step 交付物 DISJOINT；沿用 graph-engineering P0 约定。
- **Schema 迁移**：`ensureColumn` + `CREATE TABLE IF NOT EXISTS`，幂等、不动既有列。
