# PRD — Team Graph 复杂任务规划与执行能力

> 需求代号：`graph-task-planning-execution`
> 分支：`feat-graph-task-planning-execution`
> 创建：2026-08-23
> 状态：P0 实施中

---

## 0. 背景与定位

DeepThink 已存在两个相关模块：

- **`src/graph-engineering/`** —— 图执行引擎（DAG 调度、节点级 checkpoint、resume/rerun、gate 行为证据、human 审批、Mermaid + React Flow 运行态画布、崩溃恢复）。已落地 P0 执行底盘。
- **`src/agent-team/`** —— Team 构建层。用**单轮 LLM（decompose）**把任务拆解为 `TeamPlan`，产出**仅含 `agent`+`gate` 节点的串行依赖链** `GraphDefinition`，然后 100% 委托 graph-engineering 执行。无独立 Planner Agent。

**本次需求不是从零构建 Graph，而是对上述两模块做增量增强**，补齐三块短板：

1. **规划侧**：Team 当前只产出串行 agent+gate 链，缺乏并行分支、条件路由、降级 fallback、丰富节点类型（LLM/Tool/起止/汇聚）的显式表达与自动规划。
2. **执行健壮性**：节点超时未强制、无执行预算熔断、并行节点共享 owner folder（文件冲突风险）、resume 不校验版本 hash、条件路由仅支持字符串相等。
3. **全链路可视化**：Graph 侧走 5s 轮询非实时、无 `graph_*` 流式事件、无 span 父子树、无甘特图/数据流动画/历史回放/拓扑编辑。

> 与既有 `docs/prd/graph-engineering/` 的关系：graph-engineering 定义了执行底盘；本 PRD 在其上扩展 DSL、规划器、健壮性与可视化，**不重复造调度内核**。

---

## 1. 目标与非目标

### 目标（P0 本次落地）

| # | 目标 | 对应验收标准 |
|---|------|------------|
| G1 | 扩展 Graph DSL：新增 `llm`/`tool`/`start`/`end`/`parallel`/`aggregate` 节点 + 条件表达式边 + default fallback 边 + 节点 input/output 契约 | AC1, AC3 |
| G2 | Graph Planner 自动规划器：自然语言任务 → 合法 GraphDefinition（含并行/条件/降级/gate 验收），LLM 结构化输出 + Schema 校验 + 3 内置模板 | AC1 |
| G3 | 执行引擎健壮性：节点级独立工作区、节点超时强制、执行预算熔断、真实全局并发追踪、resume 版本 hash 校验、条件表达式路由 | AC2, AC3, AC5 |
| G4 | 全链路实时可视化：`graph_*` WS 流式事件、前端 store 迁移 WS（延迟 < 2s）、dagre 自动布局、甘特图时间线、边数据流动画 | AC4 |
| G5 | 历史执行回放（trace 快照序列 + 前端 scrubber 逐帧/自动播放） | AC4 |

### 非目标（P1/P2 后续，本次不做）

- ❌ 循环节点（while/for + 最大迭代）—— P1。P0 保持 DAG 无环，与现有 3-color DFS 校验一致，避免过度设计。
- ❌ 子图节点（Graph 嵌套复用）—— P2。
- ❌ 动态图（运行时 LLM 决定添加节点）—— 已有 `replan` 端点，P0 不扩展。
- ❌ 完整拓扑编辑器拖拽连线 —— P0 只做 dagre 布局 + 只读增强；拖拽编辑列 P1。
- ❌ 监控告警看板（成功率/平均耗时/webhook）—— P2。
- ❌ 飞书 IM 审批卡片渲染 —— 已有 human 审批机制，飞书卡片 P1。
- ❌ 权限分级（查看/编辑/发起/终止/审批）—— P2。

---

## 2. 功能需求细化

### 2.1 Graph DSL v2（G1）

#### 2.1.1 节点类型扩展

在 `GraphNodeType` 上**向后兼容地新增**（既有 `agent|gate|branch|join|human` 不变）：

| 节点类型 | 职责 | 关键字段 |
|---------|------|---------|
| `llm` | 纯模型推理（提示词节点，不绑 Agent） | `prompt`、`model?`、`outputSchema?` |
| `tool` | 直接调用平台工具/API（不经 Agent） | `toolName`、`toolInput`（可含变量引用）、`outputSchema?` |
| `start` | 图入口，声明图级输入参数 Schema | `inputSchema?`（GraphStateField[]） |
| `end` | 图出口，声明输出格式 + 聚合规则 | `outputTemplate?`（变量引用拼装） |
| `parallel` | 并行分支开启器（fan-out）—— 语义糖，等价于一个节点向多后继发 data 边 | `branchCount?`（仅文档/校验用） |
| `aggregate` | 多分支汇聚，策略选择 | `mergeStrategy: 'all' \| 'any' \| 'arbitrate'`、`arbitratePrompt?` |

> 设计原则（Simplicity First）：`parallel`/`aggregate` 是**语义糖节点**。`parallel` 在 scheduler 层退化为"一个 completed 节点 + 多条出边"（现有 fan-out 已支持）；`aggregate` 退化为"join 节点 + 可选 LLM 仲裁"。不引入新调度路径，复用 `join` 的 fan-in 逻辑。

#### 2.1.2 边类型扩展

`GraphEdge` 增字段（向后兼容）：

```ts
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type?: 'data' | 'control';
  // 既有：branch 节点出边的字符串相等条件
  condition?: string;
  // 新增：条件表达式（当 from 节点不是 branch 时也可用）
  // 形如 "${node_a.output.score} > 0.8" 或 "${node_b.status} == 'ok'"
  // 与 condition 互斥：有 expression 时忽略 condition
  expression?: string;
  // 新增：default fallback 边（from 节点的所有条件边都不命中时走此边）
  isDefault?: boolean;
  // 新增：数据映射/转换规则（${node_x.output.field} → 目标变量名）
  dataMapping?: Record<string, string>;
}
```

#### 2.1.3 输入输出契约

- 每个节点可选 `inputSchema?` / `outputSchema?`（JSON Schema 片段，存 nodes_json）。
- 节点间数据通过**变量引用**传递：`${node_a.output.summary}`、`${graph.input.topic}`、`${state.key}`。
- 图级全局上下文（`graph.input`、`state`）与节点级局部上下文（`node.output`）隔离。
- `start` 节点定义图级输入 Schema；`end` 节点定义输出模板。

#### 2.1.4 变量引用求值器

新增 `graph-expr.ts`：纯函数 `resolveExpr(template, context)` 把 `${...}` 占位符替换为上下文值。供 runner（构造节点输入）和 scheduler（条件边求值）共用。

### 2.2 Graph Planner 自动规划器（G2）

#### 2.2.1 模块位置

新增 `src/graph-engineering/graph-planner.ts`。

#### 2.2.2 规划方式

- **自动规划**：用户输入复杂任务描述 → LLM 结构化输出 `GraphDefinition`（zod schema 校验）→ `registerDefinition` 合法性校验（DAG 无环、悬空边、branch 覆盖、变量引用存在性）→ 失败重试 1 次 → 再失败降级为 dev-workflow 模板填充。
- **模板库**：3 个内置模板（见 2.2.3），存 `src/graph-engineering/graph-templates.ts`，支持"自动生成后人工调整"混合模式（P0：生成即可执行，人工调整走 PRD 后续）。
- **与 agent-team 关系**：`team-builder.decompose` 升级为调用 `graph-planner`，产出 richer graph（可含并行/条件/llm/tool 节点），不再限定 agent+gate 串行链。Team 成员创建逻辑（createMemberAgent）保留。

#### 2.2.3 内置模板

| 模板 id | 模式 | 节点结构 |
|--------|------|---------|
| `dev-workflow` | 调研→实现→评审→验收 | start → agent(research) → agent(implement) → gate(review) → gate(accept) → end |
| `report-ppt` | 并行调研→汇聚→撰写→PPT | start → parallel[agent(research-a), agent(research-b), agent(research-c)] → aggregate → agent(write) → agent(ppt) → gate(accept) → end |
| `parallel-research` | 多分支并行调研→汇聚仲裁 | start → parallel[...] → aggregate(arbitrate) → end |

模板参数化：`{topic}`、`{acceptanceCriteria}` 占位符在实例化时替换。

### 2.3 执行引擎健壮性（G3）

#### 2.3.1 节点级独立工作区

- 路径：`data/groups/{folder}/graph-workspaces/{run_id}/{node_id}/`
- `runAgentNode`/`runGateNode` 的 `workspaceFolder` 从 `ctx.groupFolder` 改为节点专属目录。
- runner 启动前 `mkdir -p`，节点输出产物落该目录，并行节点不再共享 owner folder。
- gate 的 `shellCheck` 也在该目录执行。

#### 2.3.2 节点超时强制

- `node.timeoutMs`（已有字段）在 runner 用 `Promise.race([nodeExec, timeoutPromise(timeoutMs)])` 强制。
- 超时记为 attempt 失败，进入重试/降级流程。

#### 2.3.3 执行预算熔断

- `GraphDefinition` 增 `budget?: { maxTokens?, maxCostUsd?, maxDurationMs? }`。
- orchestrator 每批执行后累加 `inputTokens/outputTokens/costUsd/durationMs`，超限 → 整图 `failed`（status=failed，error="budget exceeded"）。

#### 2.3.4 真实全局并发追踪

- `nextReadyBatch` 的 `globalSlots` 参数改为传入"真实剩余槽位" = `MAX_CONCURRENT - 当前在飞节点数`。
- orchestrator 维护 in-flight 计数（batch Promise.all 在飞期间计数累加）。

#### 2.3.5 resume 版本 hash 校验

- `buildRunContext` 在 `getGraphDefinition(id, version)` 后比对 `manifest_hash`；不匹配则拒绝 resume，返回错误提示"图定义已变更，请 rerun 整图"。

#### 2.3.6 条件表达式路由

- scheduler `computeReadyNodes`：对带 `expression` 的边，调用 `graph-expr` 求值（而非 `branchDecisions` 字符串相等）。
- default 边：当 from 节点的所有非 default 条件边都不命中时激活。

### 2.4 全链路实时可视化（G4）

#### 2.4.1 graph_* 流式事件

在 `stream-event.types.ts` 新增事件类型：

| 事件 | 触发点 | 载荷 |
|------|--------|------|
| `graph_start` | orchestrator executeGraph 开始 | runId, definitionId, nodeCount |
| `graph_node_start` | 节点开始执行 | runId, nodeId, nodeType, title |
| `graph_node_status` | 节点状态变更（running/completed/failed/paused） | runId, nodeId, status, tokens, costUsd |
| `graph_node_end` | 节点结束 | runId, nodeId, status, output(summary), durationMs |
| `graph_edge_taken` | 条件边被激活 | runId, fromNodeId, toNodeId, condition/expr |
| `graph_end` | 整图结束 | runId, status, totalTokens, totalCostUsd, durationMs |

经 `broadcastStreamEvent` 推 WS。复用现有 WsManager 通道。

#### 2.4.2 前端 store 迁移 WS

- `web/src/stores/graph.ts`：保留轮询作为 fallback，主通道订阅 `graph_*` WS 事件增量更新 `currentNodeRuns`。
- 延迟目标 < 2s（WS 本地直连，远低于 5s 轮询）。

#### 2.4.3 dagre 自动布局

- 引入 `dagre`（npm），新增 `web/src/components/graph/dagreLayout.ts`：把 GraphDefinition 节点/边喂 dagre 算分层坐标，替代手动 grid。

#### 2.4.4 甘特图时间线

- 新增 `web/src/components/graph/GanttView.tsx`：用 recharts（已有依赖）按 `graph_node_runs.started_at/ended_at` 渲染时间轴，展示并行关系。

#### 2.4.5 边数据流动画

- 自定义 React Flow edge `DataFlowEdge`：running 边粒子沿边流动（CSS animation），点击边显示传递的数据（dataMapping 解析后的实际值）。

### 2.5 历史执行回放（G5）

#### 2.5.1 后端

- `graph_node_runs` 已有 `started_at/ended_at/status`。新增 `GET /api/graph/runs/:id/timeline` 返回按时间排序的节点状态变更序列（快照序列）。
- 复用既有 checkpoint 数据，不新增表。

#### 2.5.2 前端

- `web/src/components/graph/ReplayPlayer.tsx`：scrubber 时间轴 + 逐帧/自动播放，按时间点重建画布状态。

---

## 3. 验收标准

| AC | 描述 | 验证方式 |
|----|------|---------|
| AC1 | 用户输入"撰写行业调研报告并生成 PPT"，系统自动生成合法 Graph（含并行分支）并成功执行 | TC1 |
| AC2 | 含 3 并行分支的 Graph，并行节点实际并发执行，耗时 ≈ 最长分支（≤ 最长分支 × 1.2） | TC2 |
| AC3 | 节点失败重试 3 次后走降级 default 边分支，整图最终成功 | TC3 |
| AC4 | 前端实时看到节点状态变化延迟 < 2s；可查任意节点完整输入输出与思考过程 | TC4 |
| AC5 | 执行中断后可从失败节点恢复，已成功节点不重跑；图定义未变更时 resume 成功，变更后拒绝 resume | TC5 |
| AC6 | 节点超时（timeoutMs）被强制，超时节点进入重试/降级 | TC6 |
| AC7 | 执行预算超限（maxTokens）触发整图熔断 failed | TC7 |
| AC8 | 甘特图正确展示各节点起止时间与并行关系 | TC8 |
| AC9 | 历史回放可逐帧/自动播放重建画布状态 | TC9 |
| AC10 | Planner 对非法 LLM 输出能降级为 dev-workflow 模板并成功执行 | TC10 |

---

## 4. 测试用例

| TC | 场景 | 步骤 | 预期 | 对应 AC |
|----|------|------|------|--------|
| TC1 | 自动规划报告 PPT | 调用 `POST /api/graph/plan` body `{task:"撰写 AI Agent 行业调研报告并生成 PPT"}` → 自动注册 GraphDefinition → startGraphRun → 等待完成 | run status=completed；GraphDefinition 含 ≥1 parallel 分支与 gate 验收节点 | AC1 |
| TC2 | 3 并行分支并发 | 构造含 start→[A,B,C]→aggregate→end 的 Graph，每个 agent 节点 sleep 3s → 执行 | 总耗时 ≤ 3.6s（≤ 3s×1.2）；A/B/C started_at 接近一致 | AC2 |
| TC3 | 重试后降级 | 构造 agent 节点（maxAttempts=3，前 2 次失败第 3 次成功）+ default 降级边 → 执行 | 节点最终 completed 或走 default 边，整图 completed | AC3 |
| TC4 | 实时状态延迟 | 启动 Graph，前端 WS 订阅 graph_node_status 事件，记录事件到达时间与节点实际 started_at 差值 | 延迟 < 2s；节点详情抽屉可查输入输出 + trace 子图 | AC4 |
| TC5 | 断点恢复 | 执行含 5 节点的 Graph，第 3 节点失败 → resume → 第 3 节点重跑，1/2 不重跑；篡改 definition 后 resume 被拒 | resume 后 1/2 节点 status 保持 completed；篡改后返回 hash 不匹配错误 | AC5 |
| TC6 | 节点超时 | agent 节点 timeoutMs=2000，实际执行 sleep 5s → 执行 | 该 attempt 计为 failed（timeout），进入重试或降级 | AC6 |
| TC7 | 预算熔断 | Graph budget.maxTokens=1000，执行节点累计超 1000 → 执行 | run status=failed，error 含 "budget exceeded" | AC7 |
| TC8 | 甘特图 | 执行 TC2 的 Graph → 前端打开甘特图 | 3 个并行节点条形时间重叠，aggregate 在其后 | AC8 |
| TC9 | 历史回放 | 取 TC2 完成的 run → 打开回放 → 逐帧/自动播放 | 画布按时间重建状态，可暂停/拖拽 scrubber | AC9 |
| TC10 | Planner 降级 | mock LLM 返回非法 JSON → 调用 planner | 降级为 dev-workflow 模板，GraphDefinition 合法可执行 | AC10 |

---

## 5. 非功能需求

| 维度 | 要求 | P0 达成路径 |
|------|------|------------|
| 性能 | 单 Graph ≥100 节点；调度延迟 < 500ms；前端 500 节点流畅 | scheduler 纯函数 O(V+E)；前端 React Flow 虚拟化（已内置） |
| 并发 | 单 Team ≥50 Graph 实例并发 | orchestrator detached 执行 + 全局并发追踪 |
| 可扩展 | 执行引擎插件化，自定义节点类型 | runner dispatch 按 node.type 分派，新增类型加 case |
| 数据 | 执行记录保留策略可配；敏感数据脱敏 | 复用既有 trace TTL；output 展示复用 sanitize |
| 兼容 | 兼容现有 Team 成员 Agent 接入 | agentDefId 机制不变，planner 产出的 agent 节点复用 createMemberAgent |

---

## 6. 关键设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| DSL 选型 | 自定义 JSON DSL（既有形态扩展） | 已有 graph_definitions.nodes_json 落库，向后兼容，不引入 YAML |
| 有环支持 | P0 仅 DAG，循环列 P1 | 与现有 3-color DFS 校验一致，避免 SCC 识别复杂度 |
| parallel/aggregate | 语义糖，退化为 fan-out/join | Simplicity First，不引入新调度路径 |
| 条件表达式 | 简单表达式（比较/相等/变量引用），非图灵完备 | 满足路由需求，避免注入 eval 风险 |
| 状态存储 | 复用 SQLite（graph_runs/graph_node_runs） | 不引入 Redis 双写，保持单文件部署简洁 |
| 实时推送 | 复用既有 WebSocket（WsManager） | Chat 侧已验证可用，不引入 SSE |
| 布局 | dagre | 轻量，分层布局适合 DAG |

---

## 7. 里程碑

| 阶段 | 内容 | 本次 |
|------|------|------|
| P0 | DSL v2 + Planner + 引擎健壮性 + WS 事件 + dagre/甘特/数据流/回放 | ✅ 本次落地 |
| P1 | 循环节点、拓扑编辑器拖拽、飞书审批卡片、断点恢复增强 | 后续 |
| P2 | 子图节点、动态图、监控告警、权限分级 | 后续 |

---

## 8. 影响面与兼容性

- **DB**：`graph_node_runs` 无需改表（node_type CHECK 需扩展枚举；通过 migration）。`graph_definitions` 增 budget 字段（存 nodes_json 同级 meta_json 或扩展列）。
- **既有图**：无新字段的老 GraphDefinition 仍可执行（所有新字段可选，runner/scheduler 缺失退化）。
- **Team**：decompose 升级为调 planner，产出更丰富 graph；老 TeamPlan 仍兼容。
- **前端**：graph store 增 WS 订阅，轮询降级为 fallback；新增 GanttView/ReplayPlayer/dagreLayout 组件。
