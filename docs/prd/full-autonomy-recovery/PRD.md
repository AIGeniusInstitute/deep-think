# PRD：DeepThink 全自主恢复引擎（Full Autonomy Recovery Engine）

> 分支：`feat/full-autonomy-recovery` ｜ worktree：`~/deepthink/.worktrees/feat-full-autonomy-recovery`
> 创建日期：2026-08-19
> 范围类型：**整合增强** —— 在已合并的 `feat-autonomous-mode`（全托管模式）之上，把"终止性硬刹车"升级为"可恢复硬刹车"，并接通学习/适应闭环，彻底消除长程任务中途终端需人类介入的场景。
> 上游依赖：`feat-autonomous-mode`（已合并）、`autonomy-system`（已合并）、`graph-engineering` + `super-agent-team`（已合并）

---

## 0. 背景与定位

### 0.1 用户问题（原话）

> 当前的 deepthink 在全自主完成一个长程复杂任务的场景，还存在中途终端，让人类进来判断输入的情况，期望能够彻底解放人类，DeepThink 作为一个全自主超级智能体自主进化学习，试错，检索，与外部世界环境进行自主交互，积累经验，最终能够像一个人类专家一样完成用户输入的任务。

### 0.2 现状：`feat-autonomous-mode` 做了什么、没做什么

`feat-autonomous-mode`（v1.0）已解决"agent 主动停下询问用户"的问题——三层注入（Supervisor 旁路 clarify、CLAUDE.md Autonomous Override、端回合自动续接）让 agent 不再 `AskUserQuestion`。**但它的硬刹车是终止性的**：

| 刹车 | 代码位置 | 当前行为 |
|---|---|---|
| 破坏性命令 | `container/agent-runner/src/index.ts:3032-3054` | `process.exit(1)`，任务死亡 |
| 轮次超限(50) | `index.ts:3055-3077` | `process.exit(1)`，无检查点续跑 |
| Token 超限(1M) | `index.ts:3078-3102` | `process.exit(1)`，无上下文凝结续跑 |
| 循环检测(3 同) | `index.ts:3103-3127` | `process.exit(1)`，无反思改策略 |

且 `feat-autonomous-mode` PRD §2.3 明确列为 **Out of Scope**：
- ❌ 不实现任务后学习/经验沉淀（沿用现有 `autonomy-learning.ts`，本需求不扩展）
- ❌ 不实现多 agent 协同自主
- ❌ 不实现任务结果自动验收

### 0.3 本 PRD 的定位

本 PRD 接管 `feat-autonomous-mode` 留下的全部 Out-of-Scope 项 + 终止性刹车问题，是全自主能力的**第二阶段**。核心命题（呼应 Sutton《苦涩的教训》+ 大世界假说）：

> **遇到摩擦不死亡，而是改策略后继续；每次摩擦沉淀为经验，回注入后续执行。**

不重写既有自主层（`autonomy-system` 的 7 能力总线、度量、学习采集器保留不动），只新增**恢复策略层** + **补全适应/学习闭环的最后一公里**。

---

## 1. Gap 分析：长程任务中途终端的 9 个摩擦点

| # | 摩擦点 | 代码位置 | 根因 | 本 PRD 覆盖 |
|---|---|---|---|---|
| A | 破坏性命令刹车终止 | `index.ts:3032` | `exit(1)`，无安全替代方案搜索 | ✅ F2 |
| B | 轮次超限终止 | `index.ts:3055` | `exit(1)`，无检查点+续跑 | ✅ F2 |
| C | Token 超限终止 | `index.ts:3078` | `exit(1)`，无强制凝结续跑 | ✅ F2 |
| D | 循环检测终止 | `index.ts:3103` | `exit(1)`，无反思改策略 | ✅ F2 |
| E | adapt 闭环未完成 | `autonomy-adapt.ts:39-41` 注释 P2 | 只记录信号，不做 LLM re-plan | ✅ F5 |
| F | lessons 只写不读 | `autonomy-learning.ts:121` `searchLessons` | 未接入 team-builder/loop 执行 | ✅ F4 |
| G | 知识/工具缺口不自主消解 | override 提示词 `:1255-1273` | 只让"用 `<assumption>`"，不主动检索/装技能 | ✅ F3 |
| H | gate 失败即终止 | `graph-recovery.ts:26-30` | 翻 failed，需手动 resume | ✅ F6 |
| I | 外部交互结果不归档 | `autonomy-learning.ts:42-77` | 只到 graph_run 粒度，不存 web/sandbox 细粒度 | ✅ F7 |

---

## 2. 核心增量：7 个功能点

### F1 可恢复刹车框架（Recoverable Brake Framework）— P0
把 4 道终止性刹车改造为"可恢复"：命中刹车时不再 `exit(1)`，而是 emit `recovery_request` + 注入恢复提示 + 继续主循环。引入**每类刹车的恢复计数器**，同一刹车类型连续恢复超过 `MAX_RECOVERY_ATTEMPTS`（默认 3）才真正终止（判为不可恢复）。

### F2 逐刹车恢复策略（Per-Brake Recovery Strategy）— P0
- **破坏性命令**：注入"命令被安全规则拦截，请改用安全等价方案"提示（限定路径 / trash 替代 rm -rf / 普通 push 替代 force push），继续。恢复计数不重置，累计超限才终止。
- **轮次超限**：检查点存档当前 state + 上下文凝结（摘要进度）+ 提升 turn 预算一档（50→100→150，硬上限 200）+ 用凝结上下文续跑。
- **Token 超限**：强制上下文凝结（复用 compaction auto-continue 通路）+ 清窗续跑。
- **循环检测**：注入反思提示"你已连续 N 轮产出相同结果，陷入循环。反思当前策略为何失败，改用不同方法（换工具/换路径/拆子任务/查文档）"+ 清空 hash 窗口续跑。

### F3 自主知识/工具缺口消解（Autonomous Gap Resolution）— P1
当 `lastTurnAskedUser` 触发（agent 即将提问）时，在现有"用 `<assumption>` 继续"兜底**之前**，先尝试自主消解：
- 知识缺口（事实/未知信息类提问）→ 自动 `web_search` + `web_fetch` + 注入发现。
- 工具缺口（缺某能力）→ 自动 `install_skill` / `create_skill`。
- 仅当消解失败才回退 `<assumption>`。

### F4 经验回注入执行（Lessons Reinjection）— P1
在任务/loop/graph-run 启动时调 `searchLessons(capability, keywords)` 检索相关经验，prepend 到 agent 上下文（goalAnchor / system prompt）。接入点：`team-builder.ts` 分解提示、`loop-orchestrator.ts` 迭代提示。

### F5 适应闭环补全（Adapt Loop Completion）— P2
`autonomy-adapt.ts` 消费信号时，真正调用 LLM 生成策略调整，emit `adaptation.adjusted(adjustment)`，调整注入到对应 run 的下一轮迭代。

### F6 gate 失败自动续跑（Gate-Failure Auto-Resume）— P2
gate 节点失败时，不再终止整个 run，而是把失败证据注入回上游 agent 节点 + 重跑该子链（最多 N 次），超限才 failed。

### F7 外部交互经验归档（External Interaction Archival）— P2
自动把 `web_search` / `web_fetch` / `sandbox_run_code` 的产出归档为 `autonomy_lessons`（细粒度），不只 graph_run 元数据。

---

## 3. 功能点清单 + 验收标准 + 测试用例

### 阶段划分（Simplicity First + Goal-Driven）
- **P0**：F1 + F2 —— 直接消灭"中途终端"主因，最高杠杆
- **P1**：F3 + F4 —— 自主消解缺口 + 经验回注，呼应"自主检索/积累经验"
- **P2**：F5 + F6 + F7 —— 适应闭环 + gate 续跑 + 细粒度归档，呼应对外部世界持续交互

---

### F1：可恢复刹车框架（P0）

#### F1.1 恢复请求事件 + 计数器
- **功能**：新增 `RecoveryState`（per-session in-memory：`{ [brakeType]: { attempts, lastReason, lastTs } }`）。命中刹车时调 `requestRecovery(brakeType, context)`：attempts < `MAX_RECOVERY_ATTEMPTS` → emit `autonomous_recovering(reason, strategy, attempt)` + 返回恢复提示；attempts >= 上限 → 返回 `{ terminal: true }` 触发原 `exit(1)` 路径。
- **验收标准**：
  - AC1.1.1 单测：模拟 3 次同类型刹车 → 前 2 次 `recovering`，第 3 次 `terminal`
  - AC1.1.2 不同刹车类型计数器互不干扰（破坏性命令 2 次 + 循环 1 次，各自独立计数）
  - AC1.1.3 恢复成功推进 ≥1 轮后，该类刹车计数器衰减/重置（避免历史惩罚永久累积）
- **测试用例**：
  - U-1.1 `tests/units/recovery-state.test.ts`：计数器边界 + 独立性 + 衰减

#### F1.2 StreamEvent 类型
- **功能**：新增 `autonomous_recovering`（reason/strategy/attempt）与 `autonomous_recovered`（brakeType）事件类型，同步 `shared/stream-event.ts` + `web/src/stream-event.types.ts`。
- **验收标准**：
  - AC1.2.1 前端能渲染 recovering banner（与现有 `autonomous_brake` banner 并列，黄色而非红色）
- **测试用例**：
  - U-1.2 类型导出存在 + 序列化 round-trip

### F2：逐刹车恢复策略（P0）

#### F2.1 破坏性命令恢复
- **功能**：`DESTRUCTIVE_PATTERNS` 命中时，注入恢复提示"命令 `[cmd]` 被安全规则拦截。请改用安全等价方案：限定路径范围、用 trash/移动到 /tmp 替代 rm -rf、用普通 git push 或新建分支替代 --force、用 DELETE 替代 DROP/TRUNCATE"，继续主循环。原 `lastTurnDestructiveCmd` 清除。
- **验收标准**：
  - AC2.1.1 E2E：autonomous 任务中 agent 拟 `rm -rf /tmp/xx` → 不 exit，注入恢复提示，agent 下一轮改用安全命令
  - AC2.1.2 同一破坏性命令连续恢复 3 次仍不改 → terminal brake（红色 banner）
- **测试用例**：
  - E-2.1 `tests/e2e/autonomous-recovery-destructive.mjs`

#### F2.2 轮次超限恢复
- **功能**：`autonomousTurnCount >= maxTurns` 时，检查点存档（写 `loop_iterations` 或 `graph_node_runs`）+ 上下文凝结 + `maxTurns` 提升一档（MAX_TURN_STEPS=[50,100,150,200]）+ 凝结后续跑。超硬上限 200 → terminal。
- **验收标准**：
  - AC2.2.1 单测：50 轮命中 → maxTurns 升至 100 + 继续计数
  - AC2.2.2 超 200 → terminal brake
- **测试用例**：
  - U-2.2 `tests/units/recovery-turn-budget.test.ts`

#### F2.3 Token 超限恢复
- **功能**：`totalTokens >= maxTokens` 时，强制上下文凝结（复用现有 compaction 通路，`index.ts:2637-2657` 的 overflow 重试逻辑镜像）+ 清窗续跑。恢复次数计入 F1 计数器。
- **验收标准**：
  - AC2.3.1 token 命中 → 触发凝结 → 续跑，不 exit
- **测试用例**：
  - U-2.3 单测：mock totalTokens 超 maxTokens → 返回 recovery 而非 terminal

#### F2.4 循环检测恢复
- **功能**：3 轮同 hash 命中时，注入反思提示（见 F2 描述）+ 清空 `autonomousOutputHashes` + 续跑。恢复计数计入 F1。
- **验收标准**：
  - AC2.4.1 E2E：构造 agent 连续输出相同文本 → 命中 → 注入反思 → 下一轮输出不同（hash 变）→ 继续
  - AC2.4.2 反思 3 次仍循环 → terminal
- **测试用例**：
  - E-2.4 `tests/e2e/autonomous-recovery-loop.mjs`

---

### F3：自主知识/工具缺口消解（P1）

#### F3.1 提问分类 + 路由
- **功能**：`lastTurnAskedUser` 命中时，对 turn 文本做轻量分类（规则/小 LLM 单轮）：`knowledge_gap`（事实未知）→ `web_search`+`web_fetch` 注入发现；`tool_gap`（缺能力）→ `install_skill`/`create_skill`；`decision`（方向分叉）→ 现有 `<assumption>` 优先级决策。
- **验收标准**：
  - AC3.1.1 知识缺口提问 → 自动检索 → 发现注入下一轮 prompt，不再 fallback assumption
  - AC3.1.2 检索无结果 → 回退 `<assumption>`，不卡死
- **测试用例**：
  - U-3.1 `tests/units/gap-classifier.test.ts`

---

### F4：经验回注入执行（P1）

#### F4.1 team-builder / loop-orchestrator 检索经验
- **功能**：`buildTeam` 分解前 + `executeGoalLoop` 首轮前，调 `searchLessons('decision'|'execution', keywords)` 取 top-3 lesson，prepend 到分解/迭代 prompt。
- **验收标准**：
  - AC4.1.1 有历史 lesson 时，分解 prompt 包含 lesson 文本
  - AC4.1.2 无 lesson 时不报错、prompt 不变
- **测试用例**：
  - U-4.1 单测：mock searchLessons 返回 → 断言 prompt 含 lesson

---

### F5：适应闭环补全（P2）

#### F5.1 信号驱动 LLM re-plan
- **功能**：`autonomy-adapt.ts` 消费 `autonomy_signals` 时，调 LLM 生成策略调整文本，写回 signal `payload_json.adjustment`，emit `adaptation.adjusted(adjustment, latency_ms)`。若 signal 有 `target_run_id`，调整注入对应 loop/graph 下一轮。
- **验收标准**：
  - AC5.1.1 信号消费 → payload 含 adjustment 字段
  - AC5.1.2 事件 emit 带 adjustment
- **测试用例**：
  - U-5.1 单测：mock 信号 → mock LLM → 断言 adjustment 落库 + 事件

---

### F6：gate 失败自动续跑（P2）

#### F6.1 gate 失败重跑上游
- **功能**：`runGateNode` 失败时，不结束 run，而是把失败证据（assertions/shellCheck 输出）注入回上游 agent 节点的 goalAnchor + 重跑该子链（`graph-orchestrator` 重置上游 node_run 状态 + 下游）。最多 `GATE_RETRY_MAX=2` 次，超限 → run failed。
- **验收标准**：
  - AC6.1.1 gate 首次失败 → 上游重跑 + 第 2 次 gate 通过 → run completed
  - AC6.1.2 连续 2 次 gate 失败 → run failed（不无限重试）
- **测试用例**：
  - U-6.1 单测：mock gate fail/pass 序列 → 断言 run 状态流转

---

### F7：外部交互经验归档（P2）

#### F7.1 web/sandbox 产出归档
- **功能**：`web_search`/`web_fetch`/`sandbox_run_code` 工具调用完成后，把 (query/url, 摘要结果, capability) 归档为 `autonomy_lessons` 一条（capability='perception'/'execution'）。
- **验收标准**：
  - AC7.1.1 一次 web_search → `autonomy_lessons` 多一条 perception lesson
  - AC7.1.2 lesson 文本含 query + 摘要
- **测试用例**：
  - U-7.1 单测：mock 工具调用 → 断言 lesson 落库

---

## 4. 非目标（Out of Scope）

- ❌ 不重构 `autonomy-system` 7 能力总线（保留不动，仅在其上叠加恢复层）
- ❌ 不移除硬刹车本身（保留作为不可恢复时的最终兜底）
- ❌ 不改默认 `autonomous=false` 行为（非全托管时一切照旧）
- ❌ 不做模型权重级持续学习（Sutton 的权重更新超出现实可行性，本 PRD 用"经验回注"近似"持续学习"）

---

## 5. 量化验收标准（对照用户原话）

| 用户诉求 | 验收指标 | 覆盖功能点 |
|---|---|---|
| "彻底解放人类，中途不终端" | 全托管长程任务（≥20 轮）中，可恢复刹车命中后**自动恢复率 ≥ 80%**（不 exit） | F1+F2 |
| "自主检索" | 知识缺口提问自动 web_search 消解率 ≥ 70% | F3 |
| "积累经验" | `autonomy_lessons` 回注入 ≥ 1 个执行入口（team/loop） | F4 |
| "与外部世界自主交互" | web/sandbox 产出归档为 lesson 的覆盖率 100% | F7 |
| "自主进化学习" | adapt 信号 100% 产出 LLM 调整（非空） | F5 |
| "试错" | gate 失败自动重跑上游 ≥ 1 次 | F6 |
| 不烧光预算 | 不可恢复时仍 terminal brake 兜底，恢复有硬上限 | F1 |

---

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 恢复变无限循环（永远 recovering） | 每类刹车 `MAX_RECOVERY_ATTEMPTS=3` 硬上限 + 全局 turn/token 硬上限不变 |
| 破坏性命令"恢复"后仍执行危险操作 | 恢复提示**强制改方案**，不重放原命令；原 `lastTurnDestructiveCmd` 必须清除后才续跑 |
| 凝结丢上下文导致任务质量下降 | 凝结保留 goal+progress+待办；F4 经验回注补偿 |
| adapt LLM re-plan 延迟/失败 | 非阻塞（try/catch），失败回退现有"标记 applied"行为 |
| 现有 1226+/1239+ 测试基线回归 | 全部新增功能用新文件，不改既有断言；CI 红线不降 |
