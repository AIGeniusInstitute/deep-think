# 技术方案 — Team Graph 复杂任务规划与执行能力

> 分支：`feat-graph-task-planning-execution`
> 创建：2026-08-23
> 依据 PRD：`docs/prd/graph-task-planning-execution/PRD.md`

---

## 0. 现状基线（已验证的代码事实）

| 文件 | 现状 | 改动面 |
|------|------|--------|
| `src/graph-engineering/graph-types.ts` | `GraphNodeType='agent'\|'gate'\|'branch'\|'join'\|'human'`；`GraphEdge{condition?}`；`GraphDefinition{nodes,edges,stateSchema?}` | 扩类型 + 字段 |
| `src/graph-engineering/graph-scheduler.ts` | 纯函数：`computeReadyNodes`（条件边靠 `branchDecisions` 字符串相等）、`nextReadyBatch(ready,maxParallel,globalSlots)`、`branchEdgeCoverage` | 加 expression/default 边求值 |
| `src/graph-engineering/graph-runner.ts` | `dispatchByType` switch；`runAgentNode` 用 `ctx.groupFolder` 作 workspaceFolder；`acquireNodeLock` 审计锁；无 timeoutMs 强制 | 加 case + 工作区 + 超时 |
| `src/graph-engineering/graph-orchestrator.ts` | `executeGraph` 循环：`computeReadyNodes→nextReadyBatch(ready,ctx.maxParallel,ctx.maxParallel)→Promise.all(runNodeWithRetry)`；gate 失败回灌上游；`buildRunContext` 不校验 hash | 加事件 + 预算 + 全局并发 + hash |
| `src/stream-event.types.ts` | `StreamEventType` 枚举；已有 `traceNode`/`approvalRequest` 载体；无 `graph_*` | 加事件类型 + graphEvent 载体 |
| `src/routes/graph.ts` | CRUD/run/resume/pause/cancel/rerun/approve/replan/trace/usage | 加 plan + timeline |
| `web/src/stores/graph.ts` | `startPolling` 5s 轮询 `GET /runs/:id` | 加 WS 订阅，轮询降级 fallback |
| `web/src/components/graph/GraphDagView.tsx` | React Flow，手动 grid 布局 | dagre 布局 + DataFlowEdge |
| `web/src/components/graph/GraphNodeDetail.tsx` | 节点详情抽屉 | 不改（已满足 AC4 后半） |

---

## 1. 模块结构

新增/修改文件：

```
src/graph-engineering/
├── graph-types.ts          [改] DSL v2 类型扩展
├── graph-expr.ts           [新] 变量引用 + 条件表达式求值器（纯函数）
├── graph-scheduler.ts      [改] expression/default 边 + 真实全局并发
├── graph-runner.ts          [改] 新节点类型 dispatch + 节点工作区 + 超时
├── graph-orchestrator.ts   [改] graph_* 事件 + 预算熔断 + 全局并发追踪 + hash 校验
├── graph-planner.ts        [新] NL→GraphDefinition 自动规划器
├── graph-templates.ts      [新] 3 内置模板
├── graph-registry.ts       [改] 校验扩展（expression/default 边、新节点类型）
└── graph-events.ts         [新] graph_* 事件构造 helper（薄封装）

src/stream-event.types.ts   [改] 加 graph_* 事件类型 + graphEvent 载体
src/routes/graph.ts         [改] POST /plan、GET /runs/:id/timeline
src/agent-team/team-builder.ts [改] decompose 升级为调 graph-planner（可选）

web/src/
├── stores/graph.ts         [改] WS 订阅 + 轮询 fallback
├── components/graph/dagreLayout.ts     [新] dagre 分层布局
├── components/graph/GanttView.tsx       [新] 甘特图时间线
├── components/graph/DataFlowEdge.tsx   [新] 数据流动画边
├── components/graph/ReplayPlayer.tsx   [新] 历史回放
└── components/graph/GraphDagView.tsx   [改] 接 dagre + DataFlowEdge

tests/
└── graph-planning.test.ts  [新] TC1-TC10
```

---

## 2. DSL v2 类型设计（graph-types.ts）

### 2.1 节点类型

```ts
export type GraphNodeType =
  | 'agent' | 'gate' | 'branch' | 'join' | 'human'        // 既有
  | 'llm' | 'tool' | 'start' | 'end'                        // 新增
  | 'parallel' | 'aggregate';                               // 新增（语义糖）
```

`GraphNode` 新增可选字段（向后兼容）：

```ts
// ---- DSL v2 extensions ----
/** 'llm' 节点：纯模型推理。 */
model?: string;
/** 'llm' 节点输出 schema（文档/校验用）。 */
outputSchema?: Record<string, unknown>;
/** 'tool' 节点：工具名 + 入参（支持 ${var} 引用）。 */
toolName?: string;
toolInput?: Record<string, unknown>;
/** 'aggregate' 节点：汇聚策略。 */
mergeStrategy?: 'all' | 'any' | 'arbitrate';
arbitratePrompt?: string;
/** 节点输入 schema（文档/校验用）。 */
inputSchema?: Record<string, unknown>;
/** 'start' 节点：图级输入参数声明。 */
inputParams?: GraphStateField[];
/** 'end' 节点：输出模板（变量引用拼装）。 */
outputTemplate?: string;
```

> `parallel` 节点无新字段——它是 fan-out 语义糖，scheduler 把它当普通 completed 节点，其多条出边即并行分支。`aggregate` 退化为 join + 可选 LLM 仲裁。

### 2.2 边类型

```ts
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type?: 'data' | 'control';
  condition?: string;                                    // 既有：branch 字符串相等
  expression?: string;                                   // 新：条件表达式
  isDefault?: boolean;                                   // 新：fallback 边
  dataMapping?: Record<string, string>;                  // 新：数据映射
}
```

### 2.3 图级预算

```ts
export interface GraphDefinition {
  // 既有字段...
  budget?: { maxTokens?: number; maxCostUsd?: number; maxDurationMs?: number };
}
```

落库：`graph_definitions` 增 `budget_json TEXT` 列（migration），`deserializeDefinition`/`serializeDefinition` 读写。老定义无此列 → undefined → 无预算限制。

---

## 3. 变量引用与表达式求值器（graph-expr.ts）

纯函数，无 I/O，供 runner 与 scheduler 共用。单元可测。

```ts
/** 解析 ${...} 占位符。context = { graph:{input}, state, node:{id:{output}} } */
export function resolveExpr(template: string, ctx: EvalContext): string;

/** 求值条件表达式。支持: ==, !=, >, <, >=, <=, &&, ||, 数字/字符串字面量。 */
export function evalCondition(expr: string, ctx: EvalContext): boolean;
```

**实现策略**（安全优先，非图灵完备）：
- 解析 `${path.to.value}` → 从 context 按 dotted path 取值。
- 表达式求值：手写递归下降 parser，只支持比较 + 逻辑运算，**禁用** `eval`/`Function` 构造。
- 路径解析：`graph.input.topic`、`node_a.output.score`、`state.key`、`node_a.status`。

**EvalContext**：

```ts
export interface EvalContext {
  graph: { input: Record<string, unknown> };
  state: GraphState;
  node: Record<string, { output: unknown; status: string }>;
}
```

runner 在执行节点前用 `resolveExpr` 构造节点输入（替换 prompt/toolInput 中的 `${...}`）；scheduler 用 `evalCondition` 求值条件边。

---

## 4. Scheduler 扩展（graph-scheduler.ts）

### 4.1 条件边求值

`computeReadyNodes` 改为对每条入边判断"是否激活"：

```ts
function edgeActive(
  edge: GraphEdge,
  completed: Set<string>,
  branchDecisions: Map<string, string>,
  evalCtx: EvalContext | null,   // null = 退化为旧字符串相等逻辑（向后兼容）
): boolean
```

- 无 `condition` 且无 `expression` 且非 `isDefault` → 普通数据边，from completed 即激活。
- 有 `expression` → `evalCondition(edge.expression, evalCtx)`。
- 有 `condition`（旧） → `branchDecisions.get(edge.from) === edge.condition`。
- `isDefault` → 当 from 节点的**所有非 default 条件边**（expression/condition）都不激活时才激活。

### 4.2 default 边激活逻辑

对每个有 default 出边的 from 节点，先求值其所有非 default 条件边；若全不命中，default 边激活。这要求 `computeReadyNodes` 按 from 节点聚合出边——新增 `defaultEdgesByFrom` 预计算。

### 4.3 真实全局并发

`nextReadyBatch` 签名不变（已是 `globalSlots` 参数）；改的是 orchestrator 传值：从 `ctx.maxParallel` 改为 `MAX_CONCURRENT - inFlight`（见 §6.3）。

---

## 5. Runner 扩展（graph-runner.ts）

### 5.1 新节点类型 dispatch

`dispatchByType` 增加 case：

```ts
case 'llm':       return runLlmNode(ctx, node);
case 'tool':      return runToolNode(ctx, deps, node);
case 'start':     return { status:'completed', output:'', inputTokens:0, outputTokens:0, costUsd:0 };
case 'end':       return runEndNode(ctx, node);
case 'parallel':  return { status:'completed', ... };   // 语义糖，no-op
case 'aggregate': return runAggregateNode(ctx, node);   // join + 可选仲裁
```

- `runLlmNode`：`lightweightSdkQuery(resolveExpr(node.prompt, ctx))`，产出写 `node_<id>_output`。
- `runToolNode`：解析 `toolInput` 中的 `${...}`，调平台工具分发（复用 `plugin-command-index` 或 `mcp-utils` 的工具调用路径，P0 限定内置工具子集：`web_search`/`web_fetch`/`run_script`）。产出写 state。
- `runEndNode`：用 `resolveExpr(node.outputTemplate, ctx)` 拼装最终输出。
- `runAggregateNode`：等价 join（completed 即可），若 `mergeStrategy='arbitrate'` 调一次 LLM 合并多分支产出。

### 5.2 节点级独立工作区

`runGraphNode` 中：

```ts
const nodeWorkspace = path.join(ctx.groupFolder, 'graph-workspaces', ctx.graphRunId, node.id);
fs.mkdirSync(nodeWorkspace, { recursive: true });
```

把 `nodeWorkspace` 传入 `runAgentNode`（作 ContainerInput.groupFolder 的**子目录**）/`runGateNode`（shellCheck cwd）/`runToolNode`。

> 注意：`runAgentNode` 当前把 `ctx.groupFolder` 同时用作 group 标识和 workspace。group 标识（`buildOwnerGroup` 的 folder）必须保持 `ctx.groupFolder`（用于 registeredGroups 查找），但 ContainerInput 的实际工作目录用 `nodeWorkspace`。需确认 container-runner 是否允许 groupFolder ≠ group.folder —— 若不允许，P0 退化为：agent 节点仍在 groupFolder 工作，但 gate 的 shellCheck 与 tool 节点用独立工作区（这部分无 group 查找依赖，可安全隔离）。**决策：P0 对 gate/tool/llm 节点强制独立工作区；agent 节点保留 groupFolder 但靠 disjoint artifacts 约定（与现状一致），agent 独立工作区列 P1**——避免改 container-runner 内核（Surgical Changes）。

### 5.3 节点超时强制

`dispatchByType` 包装：

```ts
const exec = dispatchByType(ctx, deps, node);
const outcome = node.timeoutMs
  ? await Promise.race([exec, timeoutNode(node.timeoutMs, node.id)])
  : await exec;
```

`timeoutNode` 返回 `{status:'failed', error:'timeout after ${ms}ms'}`。超时进入 runNodeWithRetry 的重试/降级流程（AC6）。

> agent 节点的 `runHostAgent`/`runContainerAgent` 已有进程级超时机制（container-runner），`timeoutMs` 作为图层级补充，用 `Promise.race` 包裹整个节点执行（含流式）。

---

## 6. Orchestrator 扩展（graph-orchestrator.ts）

### 6.1 graph_* 事件发射

在 `executeGraph` 关键点调 `graph-events.ts` 的 helper（薄封装 `deps.broadcastStreamEvent`）：

| 位置 | 事件 |
|------|------|
| `executeGraph` 开头（updateGraphRunStatus running 后） | `graph_start` |
| `runNodeWithRetry` 调 `runGraphNode` 前 | `graph_node_start` |
| `runGraphNode` 返回后（status 变更） | `graph_node_status` + `graph_node_end` |
| `computeReadyNodes` 返回后对条件边求值命中 | `graph_edge_taken` |
| `allCompleted` 或 failed/cancelled | `graph_end` |

事件经 `deps.broadcastStreamEvent(ctx.chatJid, event)` 推 WS。

### 6.2 预算熔断

`executeGraph` 循环每批后：

```ts
const usage = getGraphRunUsage(ctx.graphRunId);  // 已有 addGraphRunUsage 累加
if (def.budget?.maxTokens && usage.totalTokens > def.budget.maxTokens) { fail('budget exceeded: tokens'); }
if (def.budget?.maxCostUsd && usage.totalCostUsd > def.budget.maxCostUsd) { fail('budget exceeded: cost'); }
if (def.budget?.maxDurationMs && (Date.now() - runStart) > def.budget.maxDurationMs) { fail('budget exceeded: duration'); }
```

超限 → `updateGraphRunStatus(failed, {cancelReason:'budget exceeded: ...'})` + `graph_end`(failed) + return。

> `getGraphRunUsage` 需新增（聚合 graph_runs 的 input_tokens/output_tokens/cost_usd 列，或读 graph_node_runs 求和）。P0 用 sum(graph_node_runs) 实现。

### 6.3 真实全局并发追踪

```ts
let inFlight = 0;
// batch 执行前 inFlight += batch.length；执行中不新增（nextReadyBatch 已扣减）
const slots = Math.max(0, MAX_CONCURRENT - inFlight);
const batch = nextReadyBatch(ready, ctx.maxParallel, slots);
inFlight += batch.length;
const results = await Promise.all(batch.map(...));
inFlight -= batch.length;
```

`MAX_CONCURRENT` 从 config 读（复用 `MAX_CONCURRENT_CONTAINERS`/host 进程上限）。

### 6.4 resume 版本 hash 校验

`buildRunContext` 在 `deserializeDefinition(defRow)` 后：

```ts
const manifestHash = computeManifestHash(definition);
if (run.manifest_hash && run.manifest_hash !== manifestHash) {
  logger.error({runId, stored: run.manifest_hash, computed: manifestHash}, 'manifest hash mismatch — definition changed');
  return null;  // 拒绝 resume，调用方提示用户 rerun 整图
}
```

> 需确认 `graph_runs` 是否已有 `manifest_hash` 列。若无，`startGraphRun` 写入时一并落 `computeManifestHash(def)`（migration 加列）。

### 6.5 条件边事件与求值上下文

`executeGraph` 构造 `EvalContext`（从 ctx.state + graph.input + completed 节点的 output）传入 `computeReadyNodes`。条件边命中时发 `graph_edge_taken`。

---

## 7. Graph Planner（graph-planner.ts + graph-templates.ts）

### 7.1 planGraph

```ts
export async function planGraph(input: {
  task: string;
  background?: string;
  acceptanceCriteria?: string;
  ownerUserId: string;
  groupFolder: string;
  userLanguage?: string;
  template?: string;   // 强制用某模板
}): Promise<{ definition: GraphDefinition } | { error: string }>
```

流程：
1. `buildPlanPrompt(input)` → LLM 结构化输出 `GraphDefinition` JSON（zod 校验：节点/边合法、DAG 无环、变量引用存在性）。
2. 失败重试 1 次。
3. 再失败 → `instantiateTemplate('dev-workflow', input)` 降级。
4. 成功 → `registerDefinition`（graph-registry 校验 + 落库）。

### 7.2 模板

`graph-templates.ts` 导出 `TEMPLATES: Record<string, (params)=>GraphDefinition>`。参数化占位符 `{topic}`/`{acceptanceCriteria}` 替换。

`report-ppt` 模板结构（含 parallel + aggregate + gate）：

```
start → parallel(fan-out) → [research-a, research-b, research-c]
     → aggregate(all) → write → ppt → gate(accept) → end
```

### 7.3 与 team-builder 关系

`team-builder.decompose` 当前产出 `TeamPlan`（members + agent/gate 串行图）。P0 改为：先调 `planGraph` 产出 `GraphDefinition`，再从中提取 agent 节点的 role/prompt 反推 `TeamMember`（或保留 TeamPlan 的 members 设计，仅图结构用 planner 产出）。**决策：P0 不改 team-builder，planner 作为独立入口（`POST /api/graph/plan` + `/graph plan` 命令）**——Surgical Changes，避免动已稳定的 Team 链路。Team 集成 planner 列 P1。

---

## 8. 路由扩展（routes/graph.ts）

### 8.1 POST /api/graph/plan

```ts
POST /api/graph/plan
body: { task, background?, acceptanceCriteria?, template? }
→ { definitionId, version, runId }  // 注册 + 立即 startGraphRun（可选 ?autorun=true）
```

### 8.2 GET /api/graph/runs/:id/timeline

返回 `graph_node_runs` 按 `started_at` 排序的状态变更序列：

```ts
[{ nodeId, nodeType, title, status, startedAt, endedAt, tokens, costUsd }]
```

供前端回放。

### 8.3 POST /api/graph/definitions（既有，扩展）

接受 v2 DSL（新节点/边/budget）。`registerDefinition` 校验扩展。

---

## 9. 前端可视化（web/）

### 9.1 WS 订阅（stores/graph.ts）

```ts
// 新增：订阅 graph_* 事件
wsManager.on('graph_node_status', (e) => {
  upsertNodeRun(e.graphEvent.runId, e.graphEvent.nodeId, e.graphEvent);
});
// startPolling 降为 fallback：WS 断开 30s 后启动 5s 轮询兜底
```

`StreamEvent.graphEvent` 载体：

```ts
graphEvent?: {
  runId: string; nodeId?: string; nodeType?: string; title?: string;
  status?: string; tokens?: number; costUsd?: number; durationMs?: number;
  fromNodeId?: string; toNodeId?: string; edge?: string;
  totalTokens?: number; totalCostUsd?: number;
  output?: string;  // summary
};
```

### 9.2 dagre 布局（dagreLayout.ts）

```ts
import dagre from 'dagre';
export function layoutGraph(def: GraphDefinition, nodeRuns): Node[] {
  const g = new dagre.graphlib.Graph(); g.setGraph({rankdir:'TB', nodesep:40, ranksep:60});
  def.nodes.forEach(n => g.setNode(n.id, {width:180, height:60}));
  def.edges.forEach(e => g.setEdge(e.from, e.to));
  dagre.layout(g);
  return def.nodes.map(n => ({...n, position: {x: g.node(n.id).x, y: g.node(n.id).y}}));
}
```

`GraphDagView` 用 `layoutGraph` 替代手动 grid。

### 9.3 甘特图（GanttView.tsx）

用 recharts `BarChart` 横向时间轴：x=时间，y=节点，bar 起=startedAt 止=endedAt。并行节点 bar 时间重叠可视化。

### 9.4 数据流动画（DataFlowEdge.tsx）

自定义 React Flow edge：running 状态的边加 CSS `animation: dash 1s linear infinite` 粒子流动；点击边显示 `dataMapping` 解析后的实际传递值（从 timeline/trace 读）。

### 9.5 历史回放（ReplayPlayer.tsx）

- 取 `GET /runs/:id/timeline`。
- scrubber 时间轴 + play/pause/step。
- 按当前时间点 t：节点 status = t 时刻的真实状态（startedAt≤t<endedAt → running，endedAt≤t → 终态）。
- 画布按重建状态渲染。

---

## 10. DB Migration

`db.ts` schema 升级（新 `SCHEMA_VERSION`）：

1. `graph_node_runs.node_type` CHECK 约束扩展枚举：加 `llm`/`tool`/`start`/`end`/`parallel`/`aggregate`。
2. `graph_definitions` 增 `budget_json TEXT`（deserialize/serialize 读写）。
3. `graph_runs` 增 `manifest_hash TEXT`（startGraphRun 写入，buildRunContext 校验）。

> better-sqlite3 migration 用 `ALTER TABLE ... ADD COLUMN`（幂等：`PRAGMA table_info` 检测列存在）。

---

## 11. 实施计划（C 阶段）

| 阶段 | 内容 | 验证 |
|------|------|------|
| C1 | DSL v2 类型 + graph-expr 求值器 + 单测 | resolveExpr/evalCondition 单测 |
| C2 | DB migration（node_type CHECK + budget_json + manifest_hash） | migration 幂等 |
| C3 | scheduler expression/default 边 + 单测 | computeReadyNodes 新逻辑单测 |
| C4 | runner 新节点 dispatch + 超时 + gate/tool 独立工作区 | TC6 |
| C5 | orchestrator 事件 + 预算 + 全局并发 + hash 校验 | TC5, TC7 |
| C6 | graph-planner + templates + plan 路由 | TC1, TC10 |
| C7 | stream-event graph_* + 前端 store WS 订阅 | TC4 |
| C8 | 前端 dagre + Gantt + DataFlowEdge + Replay | TC8, TC9 |
| C9 | TC2 并发、TC3 降级 集成验证 | TC2, TC3 |
| C10 | 全量回归 + test_report | 所有 AC |

---

## 12. 风险与回退

| 风险 | 缓解 |
|------|------|
| dagre 引入体积 | lazy import，仅 GraphDagView 挂载时加载 |
| 表达式求值注入 | 手写 parser，禁用 eval/Function，限定运算符白名单 |
| agent 节点独立工作区改 container-runner | P0 不改，agent 用 groupFolder + disjoint 约定，独立工作区 P1 |
| planner LLM 输出不合法 | zod 校验 + 重试 + 模板降级（TC10） |
| WS 断连 | 轮询 fallback；WS 重连后 stream_snapshot 补偿 |
| 老图无 budget/manifest_hash | 字段全可选，缺失退化旧行为 |
