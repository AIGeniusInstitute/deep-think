# PRD：DeepThink 自主 AI Agent 系统升级

> 分支：`feat/autonomy-system` ｜ worktree：`~/deepthink/.worktrees/autonomy`
> 创建日期：2026-07-26
> 范围类型：**整合增强**（非从零开发）——在已合并的 5 个自主相关 PRD 之上，补统一抽象层 + 度量层 + 验收套件

---

## 0. 背景与定位

DeepThink 已合并 5 个与"自主"强相关的 PRD，构成能力栈：
- `self-evolving-harness`（壳自进化闭环）
- `loop-engineering-v3`（4 类循环纠错）
- `supervisor-longrunning`（长驻监督+回喂+熔断）
- `super-agent-team`（自主组建团队+行为证据验收）
- `graph-engineering`（DAG 调度+checkpoint+续跑）

**问题**：这 5 个 PRD 是纵向切片，各自成熟，但横向缺一个"自主性中枢"——七大能力分散在不同模块、不同表、不同事件流，导致：
1. **无法量化**：用户要求的"主动性≥95%""决策独立性≥95%"等指标无埋点、无采集、无统计口径。
2. **学习未闭环**：harness meta-loop 自成一角，未接入 team/loop/supervisor 的执行数据闭环——这是整个能力栈最薄弱处。
3. **适应/监控偏被动**：运行中图结构不可变、无主动自愈/预测性维护、无 metrics 仪表盘。
4. **验收空白**：除 self-evolving-harness 跑过真实端到端外，其余 4 个 PRD 的 E2E 普遍留白；"无人工干预"验收套件完全空白。

**定位**：本 PRD 不重写既有能力，而是新增一个横切"自主性层（Autonomy Layer）"，把分散的感知/决策/执行/学习/监控收口为可度量、可验收、可闭环的统一系统，并补齐量化度量与无人工干预 E2E 验收。

---

## 1. Gap 分析（对照用户 7 大能力）

| # | 能力 | 现状模块 | 现状评级 | 关键缺口（本 PRD 补） |
|---|---|---|---|---|
| ① | 自主感知 | task-scheduler(60s轮询)、index.ts(IPC watcher)、loop-commands(/proactive)、embedding | 部分实现 | 缺统一感知总线；缺异常驱动采集闭环；缺外部数据源主动监听 |
| ② | 自主认知 | embedding+FTS5、supervisor-agent 决策、harness-eval 行为断言、im-safety | 部分实现 | 缺实时异常识别引擎；认知层=检索+单轮LLM，缺持续上下文建模 |
| ③ | 自主决策 | graph-scheduler、team-builder、loop-orchestrator、supervisor | **成熟** | 失败后无自动重规划 DAG（replan 仅 P1 人工触发） |
| ④ | 自主执行 | graph-orchestrator(retry)、graph-recovery、container-runner、group-queue | **成熟** | 无事务性 rollback（副作用不可撤销） |
| ⑤ | 自主学习 | harness-meta-loop、harness-registry、loop skill_evolution/adaptive | **成熟但孤立** | 🔴 harness 未接入主任务循环；无跨会话学习固化 |
| ⑥ | 自主适应 | loop adaptive、provider-pool failover、supervisor heartbeat | 部分实现 | 运行中图结构不可变；缺环境信号驱动+目标重排 |
| ⑦ | 自主监控 | /api/health、boot recovery、OOM recovery、qq watchdog | 部分实现 | 无主动自愈/预测性维护；无 metrics 聚合仪表盘 |

---

## 2. 核心增量：6 个工作包（Work Package）

### WP1：Autonomy Layer 自主性中枢
一个横切层，定义统一的自主性事件总线、能力状态模型、能力注册表。把 7 大能力的既有实现收口为可观测、可度量的统一抽象。

### WP2：Autonomy Metrics 度量埋点 + 采集 + 统计
为 7 大能力定义量化指标口径（主动性、独立性、成功率、自恢复率、学习效率、适应速度、预警准确率），在既有代码路径埋点，落库 `autonomy_metrics` 表，提供统计聚合 API。**这是支撑用户量化验收标准的前提**。

### WP3：Learning Loop Closure 学习接入主循环
把 harness meta-loop 从"自成一角"接入 super-agent-team / loop / supervisor 的执行数据闭环：执行 trace → 评估 → 提案 → promote/rollback → 影响后续任务调度。补"跨会话学习固化"原语。

### WP4：Active Adaptation 主动适应
环境信号驱动 + 运行中目标重排：基于外部信号（数据源更新、用户需求变化、性能退化）自主调整任务优先级、自主 re-plan DAG。复用 super-agent-team P1 的 `repointGraphRunDefinition` 基础，从"人工触发"升级为"信号驱动自动触发"。

### WP5：Self-Healing 主动自愈 + 监控仪表盘
模块级 self-restart、预测性维护（基于 metrics 趋势预警）、统一 metrics 仪表盘（AutonomyPage）。

### WP6：Autonomy Acceptance Suite 自主性验收套件
无人工干预 E2E 验收套件：7 大能力各一组场景，每场景有量化断言（≥95%/≥90% 等），UI 自动化（Playwright，admin/88888888 登录）。**这是当前最大空白，也是用户验收标准的落地形式**。

---

## 3. 功能点清单 + 验收标准 + 测试用例

### 阶段划分（按 Simplicity First + Goal-Driven）
- **P0**：WP1（中枢骨架）+ WP2（度量埋点）+ WP6（验收套件骨架）——先把"可度量、可验收"的基础设施立起来
- **P1**：WP3（学习闭环）+ WP4（主动适应）——补能力栈最薄弱处
- **P2**：WP5（自愈+仪表盘）——把监控从被动升主动

---

### WP1：Autonomy Layer 自主性中枢（P0）

#### F1.1 自主性事件总线
- **功能**：定义 `AutonomyEvent` 类型（capability/domain/event/payload/timestamp/run_id），提供 `emitAutonomyEvent`/`onAutonomyEvent` 内存总线（EventEmitter），既有模块（loop/graph/supervisor/harness）在不破坏既有事件流的前提下，额外 emit 自主性事件。
- **验收标准**：
  - AC1.1.1 7 大能力均有至少 1 个事件源 emit（感知/认知/决策/执行/学习/适应/监控）
  - AC1.1.2 总线单测：emit→订阅者收到，payload 不丢失字段
  - AC1.1.3 既有测试零回归（1226+/1239+ 基线不下降）
- **测试用例**：
  - TC1.1.1 emit 感知事件，订阅者收到完整 payload
  - TC1.1.2 emit 决策事件，多订阅者均收到
  - TC1.1.3 错误 payload（缺 capability 字段）被校验拒绝

#### F1.2 能力状态模型 + 注册表
- **功能**：`autonomy_capabilities` 表（capability/domain/status/last_event_at/metrics_summary_json），boot 时注册 7 大能力，事件更新 last_event_at。
- **验收标准**：
  - AC1.2.1 表创建（schema 升级，IF NOT EXISTS + 不动既有列）
  - AC1.2.2 boot 后 7 行记录就位
  - AC1.2.3 `GET /api/autonomy/capabilities` 返回 7 能力状态
- **测试用例**：
  - TC1.2.1 schema 迁移幂等（跑两次不报错）
  - TC1.2.2 7 能力均在表中
  - TC1.2.3 事件触发后 last_event_at 更新

---

### WP2：Autonomy Metrics 度量（P0）

#### F2.1 指标口径定义 + 埋点
- **功能**：定义 7 能力的量化指标（见下表），在既有代码路径埋点采集。
- **指标口径表**：

| 能力 | 指标 | 采集口径 | 目标 |
|---|---|---|---|
| ①感知 | 主动性 | 主动触发次数 / (主动+被动) 总触发 | ≥95% |
| ①感知 | 覆盖度 | 关键信息采集命中 / 应采集总数 | ≥90% |
| ②认知 | 理解准确率 | 决策正确的 check 数 / 总 check 数 | ≥90% |
| ②认知 | 异常识别率 | 正确识别异常数 / 实际异常数 | ≥85% |
| ③决策 | 独立性 | 无人工指令生成决策次数 / 总决策次数 | ≥95% |
| ③决策 | 合理性偏差 | (实际成本-最优成本)/最优成本 | ≤5% |
| ④执行 | 成功率 | 完成任务数 / 总任务数 | ≥90% |
| ④执行 | 异常自恢复率 | 自恢复次数 / 异常总数 | ≥80% |
| ⑤学习 | 策略更新时间 | 反馈到策略落地耗时 | ≤5min |
| ⑤学习 | 性能提升 | (新-旧)/旧 准确率或效率 | ≥10% |
| ⑥适应 | 适应速度 | 环境变化到调整完成耗时 | ≤30s |
| ⑥适应 | 新场景完成率 | 新场景完成任务数 / 总数 | ≥85% |
| ⑦监控 | 预警准确率 | 正确预警数 / 预警总数 | ≥90% |
| ⑦监控 | 自修复率 | 自恢复次数 / 异常总数 | ≥80% |

- **验收标准**：
  - AC2.1.1 每个指标有明确的采集点（代码路径:行号 documented）
  - AC2.1.2 埋点不破坏既有控制流（仅追加 emit，不改逻辑）
  - AC2.1.3 埋点单测：触发某路径后对应 metric 落库
- **测试用例**：
  - TC2.1.1 触发主动感知路径，autonomy_metrics 落主动性记录
  - TC2.1.2 触发执行成功路径，落成功率分子
  - TC2.1.3 触发执行失败+自恢复路径，落自恢复率分子

#### F2.2 指标聚合 API
- **功能**：`autonomy_metrics` 表（capability/metric_name/numerator/denominator/window_start/window_end/run_id/ts），`GET /api/autonomy/metrics?capability=&from=&to=` 返回聚合比率。
- **验收标准**：
  - AC2.2.1 落库幂等 + 不动既有列
  - AC2.2.2 API 返回 `ratio = numerator/denominator`（denominator=0 时返回 null 而非 NaN）
  - AC2.2.3 admin-only 鉴权
- **测试用例**：
  - TC2.2.1 落 3 主动+1 被动，API 返回主动性 0.75
  - TC2.2.2 denominator=0 返回 null
  - TC2.2.3 非 admin 403

---

### WP6：Autonomy Acceptance Suite 验收套件（P0 骨架，P1/P2 补场景）

#### F6.1 E2E 验收框架
- **功能**：Playwright 套件（admin/88888888 登录），7 能力各 ≥1 场景，每场景量化断言。
- **验收标准**：
  - AC6.1.1 套件可独立运行（`npm run test:autonomy:e2e`）
  - AC6.1.2 每场景断言对应指标达标（≥95% 等）
  - AC6.1.3 失败场景输出证据（截图+trace）
- **测试用例（每能力 1 个代表场景，P1 扩充）**：
  - TC6.1.1【感知】无指令下定时触发主动采集，主动性≥95%
  - TC6.1.2【决策】无人工指令下生成决策，独立性≥95%
  - TC6.1.3【执行】任务完成率≥90%（含 1 个失败+自恢复场景）
  - TC6.1.4【学习】反馈后策略更新≤5min
  - TC6.1.5【适应】环境变化后调整≤30s
  - TC6.1.6【监控】注入异常后预警+自恢复≥80%

---

### WP3：Learning Loop Closure 学习接入主循环（P1）

#### F3.1 执行 trace → 评估闭环
- **功能**：把 super-agent-team 的 graph_run trace 作为 harness-eval 的输入，跑完后若 verdict=improved 则 promote harness 版本并标记"可影响后续 team 组建"。
- **验收标准**：
  - AC3.1.1 graph_run 完成后触发评估（可配开关，默认 on）
  - AC3.1.2 评估 verdict 落库 + 关联 run_id
  - AC3.1.3 promote 后后续 team-builder 可读到新版本（不破坏既有）
- **测试用例**：
  - TC3.1.1 graph_run 完成触发评估，落 verdict
  - TC3.1.2 verdict=improved → promote，版本号递增
  - TC3.1.3 verdict=regressed → rollback，版本不变

#### F3.2 跨会话学习固化
- **功能**：`autonomy_lessons` 表（lesson_text/derived_from_run_ids/applied_count/status），promote 的 harness 变更沉淀为 lesson，后续任务可检索复用。
- **验收标准**：
  - AC3.2.1 表创建幂等
  - AC3.2.2 promote 生成 lesson
  - AC3.2.3 后续 task 检索到相关 lesson（按 capability 命中）
- **测试用例**：
  - TC3.2.1 promote 后 lessons 表新增 1 行
  - TC3.2.2 按 capability 检索命中
  - TC3.2.3 applied_count 在复用后递增

---

### WP4：Active Adaptation 主动适应（P1）

#### F4.1 环境信号驱动 re-plan
- **功能**：监听环境信号（数据源更新、性能退化告警、用户需求变更消息），自主触发 graph_run re-plan（复用 P1 `repointGraphRunDefinition`）。
- **验收标准**：
  - AC4.1.1 信号触发 re-plan，无需人工
  - AC4.1.2 re-plan 后已完成节点不变（复用既有语义）
  - AC4.1.3 适应速度≤30s（信号到 re-plan 生效）
- **测试用例**：
  - TC4.1.1 注入性能退化信号，触发 re-plan
  - TC4.1.2 re-plan 不重置已完成节点
  - TC4.1.3 信号到生效≤30s

#### F4.2 目标重排
- **功能**：基于优先级信号调整 pending 任务的调度顺序（task-scheduler 配合）。
- **验收标准**：
  - AC4.2.1 高优先级信号插入后，下个调度周期先执行
  - AC4.2.2 不破坏既有 cron/interval 语义
- **测试用例**：
  - TC4.2.1 注入高优先级，下周期执行该任务
  - TC4.2.2 既有 cron 不受影响

---

### WP5：Self-Healing + 监控仪表盘（P2）

#### F5.1 模块级 self-restart
- **功能**：基于 metrics（连续错误率、心跳超时）自主重启模块（复用 provider graceful restart 模式，扩展到 supervisor/graph tick loop）。
- **验收标准**：
  - AC5.1.1 连续错误超阈值触发 restart
  - AC5.1.2 restart 后状态恢复（boot recovery 配合）
  - AC5.1.3 自修复率≥80%
- **测试用例**：
  - TC5.1.1 注入连续错误，触发 restart
  - TC5.1.2 restart 后模块恢复 running

#### F5.2 预测性维护
- **功能**：基于 metrics 趋势（错误率上升斜率）提前预警。
- **验收标准**：
  - AC5.2.1 错误率趋势超阈值触发预警
  - AC5.2.2 预警准确率≥90%
- **测试用例**：
  - TC5.2.1 注入错误率上升趋势，触发预警
  - TC5.2.2 正常波动不误报

#### F5.3 AutonomyPage 仪表盘
- **功能**：前端 AutonomyPage，展示 7 能力状态 + 量化指标 + 趋势图（SVG）。
- **验收标准**：
  - AC5.3.1 7 能力卡片渲染
  - AC5.3.2 指标实时（5s 轮询）
  - AC5.3.3 趋势图 SVG 渲染无控制台报错
- **测试用例**：
  - TC5.3.1 页面加载 7 卡片
  - TC5.3.2 指标更新可见
  - TC5.3.3 趋势图渲染

---

## 4. 退出条件（成功标准）

1. typecheck 通过 + 全量测试零回归（基线 1239+）
2. P0 三 WP（WP1/WP2/WP6）单测全过 + E2E 骨架可运行
3. 7 大能力指标均可采集 + API 可查
4. E2E 场景量化断言达标（≥95%/≥90% 等，按阶段逐步达全标）
5. issue 文档（如有 bug）+ test_report 完整
6. 合并 main + push

---

## 5. 非目标（明确不做）

- 不重写既有 loop/graph/team/supervisor/harness 核心逻辑（Surgical Changes）
- 不引入模型权重更新（学习仅文本/策略层）
- 不做知识图谱推理引擎（认知层仍用检索+LLM，仅补异常识别）
- 不做外部 RSS/web monitor 全量接入（P0 只补统一总线 + 异常驱动闭环骨架）
- 不做事务性 rollback（执行副作用撤销不在本 PRD 范围）

---

## 6. 阶段交付计划

| 阶段 | WP | 退出条件 |
|---|---|---|
| P0 | WP1+WP2+WP6骨架 | 中枢+度量+验收骨架立起，单测+E2E骨架过 |
| P1 | WP3+WP4 | 学习闭环+主动适应，指标达标 |
| P2 | WP5+WP6场景扩充 | 自愈+仪表盘，全指标达标 |

每阶段独立验证 + commit，不跨阶段欠债。
