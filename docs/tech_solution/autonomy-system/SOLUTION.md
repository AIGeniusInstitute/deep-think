# 技术方案：DeepThink 自主 AI Agent 系统升级

> 分支：`feat/autonomy-system` ｜ worktree：`~/deepthink/.worktrees/autonomy`
> 关联 PRD：`docs/prd/autonomy-system/PRD.md`

---

## 0. 设计原则

- **Surgical Changes**：不重写 loop/graph/team/supervisor/harness 核心；仅新增 `src/autonomy/` 模块 + 在既有路径追加最小埋点。
- **Simplicity First**：事件总线用 Node 内置 `EventEmitter`，不引入新依赖；指标用 SQLite 表 + 既有 DB 连接。
- **复用既有**：boot recovery 模式（`bootRecoverGraphRuns`/`bootRecoverSupervisor`）、replan（`repointGraphRunDefinition`）、provider restart、script-runner 沙箱——全部复用。
- **Goal-Driven**：每 WP 有量化退出条件，Loop until verified。

---

## 1. 模块结构

```
src/autonomy/
├── autonomy-bus.ts          # 事件总线（EventEmitter 封装）
├── autonomy-types.ts         # AutonomyEvent / Capability / Metric 类型
├── autonomy-registry.ts      # 能力注册表 + boot recovery
├── autonomy-metrics.ts       # 指标采集 + 聚合查询
├── autonomy-repo.ts          # DB 表初始化 + CRUD
├── autonomy-learning.ts      # 学习闭环（trace→eval→promote→lesson）
├── autonomy-adapt.ts         # 主动适应（信号驱动 re-plan + 目标重排）
├── autonomy-heal.ts           # 自愈（模块 restart + 预测预警）
└── autonomy-routes.ts        # HTTP API（/api/autonomy/*）
web/src/pages/AutonomyPage.tsx  # 仪表盘
tests/autonomy/*.test.ts         # 单测
tests/e2e/autonomy-*.spec.ts     # E2E
```

---

## 2. 数据模型（SQLite，schema 升级）

### 2.1 `autonomy_capabilities`（能力状态）
```sql
CREATE TABLE IF NOT EXISTS autonomy_capabilities (
  capability TEXT PRIMARY KEY,        -- perception/cognition/decision/execution/learning/adaptation/monitoring
  domain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- active/degraded/failed
  last_event_at INTEGER,
  metrics_summary_json TEXT,
  updated_at INTEGER NOT NULL
);
```

### 2.2 `autonomy_metrics`（指标原始记录）
```sql
CREATE TABLE IF NOT EXISTS autonomy_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  capability TEXT NOT NULL,
  metric_name TEXT NOT NULL,          -- proactivity_ratio / decision_independence / ...
  numerator INTEGER NOT NULL DEFAULT 0,
  denominator INTEGER NOT NULL DEFAULT 0,
  run_id TEXT,
  graph_run_id TEXT,
  ts INTEGER NOT NULL,
  details_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_am_cap_metric ON autonomy_metrics(capability, metric_name, ts);
```

聚合口径：`ratio = denominator>0 ? numerator/denominator : null`。分子/分母按口径表（PRD §F2.1）在对应代码路径 `incrementMetric(capability, metric, +num, +den)`。

### 2.3 `autonomy_lessons`（跨会话学习固化）
```sql
CREATE TABLE IF NOT EXISTS autonomy_lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  capability TEXT NOT NULL,
  lesson_text TEXT NOT NULL,
  derived_from_run_ids TEXT,          -- JSON array
  applied_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### 2.4 `autonomy_signals`（适应信号）
```sql
CREATE TABLE IF NOT EXISTS autonomy_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_type TEXT NOT NULL,          -- perf_degradation / data_source_update / demand_change
  payload_json TEXT,
  target_run_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending/applied/dismissed
  created_at INTEGER NOT NULL,
  applied_at INTEGER
);
```

schema 版本号：在既有 SCHEMA_VERSION（当前 43，self-evolving 升到 43）基础上 +1 → 44。所有表 IF NOT EXISTS + 不动既有列。

---

## 3. 事件总线设计（autonomy-bus.ts）

```ts
type Capability = 'perception'|'cognition'|'decision'|'execution'|'learning'|'adaptation'|'monitoring';
interface AutonomyEvent {
  capability: Capability;
  domain: string;             // task_id / run_id / 'system'
  type: string;               // 'perception.active_trigger' / 'execution.recovered' / ...
  payload: Record<string, unknown>;
  ts: number;
  runId?: string;
}
```
- 单例 `EventEmitter`，`emitAutonomyEvent(ev)` 校验字段后 emit + 落 `autonomy_capabilities.last_event_at`。
- 订阅者：metrics 采集器（更新分子分母）、learning 闭环（触发评估）、heal（触发预警）。
- **关键约束**：emit 失败/订阅者抛错不影响主控制流（try-catch 包裹，仅 console.warn）。

---

## 4. 埋点位置（既有代码路径，最小侵入）

| 指标 | 埋点文件:函数 | 增量 |
|---|---|---|
| 主动性 | `task-scheduler.ts:startSchedulerLoop` 主动触发 / IM 被动触发 | emit perception.active_trigger(passive=false) / passive=true |
| 决策独立性 | `agent-team/team-builder.ts:buildTeam` / `supervisor-agent.ts:runSupervisionCheck` | emit decision.generated(human_triggered=false) |
| 执行成功率 | `graph-orchestrator.ts:executeGraph` 完成/失败 | emit execution.completed(success) / execution.failed |
| 异常自恢复 | `graph-orchestrator.ts:runNodeWithRetry` retry 成功 / `graph-recovery.ts:bootRecoverGraphRuns` | emit execution.recovered |
| 学习更新时间 | `harness-meta-loop.ts:runMetaLoopForProposal` promote 时刻 - 反馈时刻 | emit learning.promoted(latency_ms) |
| 适应速度 | `autonomy-adapt.ts` 信号到 re-plan 生效 | emit adaptation.adjusted(latency_ms) |
| 预警准确率 | `autonomy-heal.ts` 预警命中/误报 | emit monitoring.predicted(correct) |
| 自修复率 | `autonomy-heal.ts` restart 成功/失败 | emit monitoring.self_healed |

埋点统一通过 `emitAutonomyEvent`，不改既有函数签名，只在关键节点追加 1 行 emit。

---

## 5. API 设计（autonomy-routes.ts，admin-only）

```
GET  /api/autonomy/capabilities          -> 7 能力状态
GET  /api/autonomy/metrics?capability=&from=&to=  -> 聚合比率
GET  /api/autonomy/lessons?capability=   -> lessons 列表
POST /api/autonomy/signals               -> 注入适应信号（admin）
GET  /api/autonomy/health                -> 自主性健康（7 能力 status + 关键指标）
```
路由注册到 `src/routes/index.ts` 既有 router，复用 admin 鉴权中间件。

---

## 6. 学习闭环（autonomy-learning.ts，P1）

```
graph_run completed
  → onAutonomyEvent('execution.completed')
  → triggerLearningEval(runId)
     → 取 graph_run 的 trace_tool_calls + assertions 结果
     → 复用 harness-eval 的 scoreAssertion 跑 5 case（或直接用 run 的行为证据）
     → judgeVerdict(improved/regressed/neutral/inconclusive)
     → improved → harness-registry.promoteVersion + autonomy_lessons 新增 lesson
     → regressed → rollbackTo + 不新增 lesson
```
- 开关 `autonomy_learning_enabled`（默认 true，可 settings 配置）。
- 不自动链式（单次一轮，复用 self-evolving R4 约束）。

---

## 7. 主动适应（autonomy-adapt.ts，P1）

```
信号源：
  - 性能退化：autonomy-heal 的 perf_degradation 预警
  - 数据源更新：embedding triggerEmbeddingAsync 完成事件
  - 需求变更：IM 消息含"重排/优先"关键词（复用既有 IM 入口）
处理：
  onAutonomyEvent('monitoring.predicted', perf_degradation)
    → enqueue adapt signal
    → 若有活跃 graph_run → repointGraphRunDefinition + resume（复用 P1）
    → 若仅 pending task → task-scheduler 优先级提升
  emit adaptation.adjusted(latency_ms)
```
- 适应速度目标 ≤30s：信号 enqueue 同步处理，replan 异步但 ≤30s（repoint 是 DB 操作，快）。

---

## 8. 自愈 + 仪表盘（autonomy-heal.ts + AutonomyPage.tsx，P2）

- **self-restart**：连续错误率 ≥ 阈值（默认 5 次，复用 supervisor 熔断值）→ 调用既有 `requestGracefulRestart`（provider）/ 重启 supervisor/graph tick loop。
- **预测预警**：维护最近 N 个 metrics 窗口，错误率斜率超阈值 → emit monitoring.predicted。
- **AutonomyPage**：react-free 7 能力卡片 + SVG 趋势图（纯 SVG，不引 Chart.js）+ 5s 轮询 `/api/autonomy/health`。复用既有 SettingsPage 的 tab 注册模式。

---

## 9. E2E 验收套件（tests/e2e/autonomy-*.spec.ts）

- Playwright，`admin/88888888` 登录。
- 每场景：注入可控信号 → 等待指标变化 → 断言 ratio 达标。
- 失败输出截图 + trace（复用既有 Playwright fixture）。
- 独立 npm script：`test:autonomy:e2e`。

---

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 埋点侵入既有控制流 | emit 全部 try-catch，订阅者异常不抛回 |
| schema 迁移破坏既有 | IF NOT EXISTS + 不动既有列 + SCHEMA_VERSION +1 一次性 |
| 学习闭环误 promote 导致回归 | 复用 harness R4 单次一轮 + rollback 路径 + 开关可关 |
| 适应误触发 re-plan 风暴 | 信号去抖（5s）+ 同 run 一次 re-plan 限频 |
| E2E 指标采集时序 | 信号注入后轮询指标（≤30s 窗口），非 sleep 固定 |

---

## 11. 交付顺序（P0 → P1 → P2）

P0：autonomy-types/bus/registry/repo/metrics + routes + 埋点 + E2E 骨架
P1：autonomy-learning + autonomy-adapt + 对应 E2E 场景
P2：autonomy-heal + AutonomyPage + 全量 E2E
每阶段：单测 → typecheck → 全量回归 → commit。
