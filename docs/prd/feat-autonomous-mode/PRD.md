# PRD：DeepThink 全托管模式 (Autonomous Mode)

> 文档版本：v1.0
> 创建日期：2026-08-06
> 负责人：AI Coder
> 状态：待评审

---

## 1. 背景

DeepThink 当前架构以"短闭环 + 强验证 + halt and ask"为设计哲学，三层规则（CLAUDE.md 宪法层 `Think Before Coding`、Supervisor Agent clarify 决策、RLHF 端回合礼貌）共同导致：**任务执行中途遇到方向分叉时，agent 会停下来征询用户**。

实际用户场景需要"全托管"：用户交代完任务后，DeepThink 应当一路执行到任务目标完成，中途不询问。但当前架构在以下 3 个物理位置强制中断：

| 位置 | 文件 | 行为 |
|---|---|---|
| 任务派发前 | `src/web.ts:504-530` | Supervisor 输出 `clarify` → 存储 `__supervisor__` 提问消息，agent 不运行 |
| 任务执行中 | `src/supervisor-agent.ts:565-580` | 监督者输出 `escalate` → 写提问消息 + 重新入队 |
| 单回合结束后 | `container/agent-runner/src/index.ts:2962` | `await waitForIpcMessage()` 阻塞等下一条用户输入 |

已有路径：compaction (line 2760) 和 truncation (line 2844) 的自动续接已实现，可作为镜像模板。

## 2. 目标

### 2.1 核心目标

> **用户交代任务后，DeepThink 全自主执行直到任务目标完成；若任务目标本身不清晰，DeepThink 可在开始前一次性澄清，但一旦进入执行阶段不得中途停下询问。**

### 2.2 量化成功标准

- ✅ 当 `autonomous=true` 时，单次任务执行期间 agent **0 次主动停下询问用户**
- ✅ 任务前澄清阶段 ≤ 1 轮（如目标不清晰，Supervisor 一次性提问，用户回答后进入执行）
- ✅ 全托管任务平均推进轮次 ≥ 20（不卡死在第 1-2 轮）
- ✅ 硬刹车触发率 < 5%（说明硬刹车不误伤正常任务）
- ✅ 单次全托管任务 token 消耗有上限、可观测、可强停

### 2.3 非目标 (Out of Scope)

- ❌ 不修改现有 `src/autonomy/` 可观测性层（事件总线复用，不重构）
- ❌ 不移除默认监督者模式（`autonomous=false` 时行为不变）
- ❌ 不实现任务后学习/经验沉淀（沿用现有 `autonomy-learning.ts`，本需求不扩展）
- ❌ 不实现多 agent 协同自主（本需求只覆盖单 agent 全托管）
- ❌ 不实现任务结果自动验收（用户人工验收）

## 3. 用户故事

### US-1：用户在 Web 聊天发送"全自主完成"任务

> 作为 DeepThink 用户，我希望在 Web 聊天框输入任务并点击"全托管"按钮后，agent 全程自主执行直到交付，中途不再问我任何问题。

**验收**：
- ChatPage 输入框旁出现"全托管"按钮，点击后高亮
- 消息发送后，agent 全程不向用户提问
- 如任务目标本身模糊（如"写一本书"无章节要求），允许 Supervisor 在执行前一次性提问，用户回答后进入全托管
- 流式输出全程可见
- 任务完成或硬刹车触发时，UI 显示明确终态

### US-2：管理员在设置页给某个工作区开"全托管"模式

> 作为管理员，我希望在 Settings 里把某个工作区（group）默认设为全托管模式，这个工作区的所有后续任务都自动全托管执行。

**验收**：
- SettingsPage 出现"工作区模式"配置区
- 每个工作区可独立切换"监督者模式 / 全托管模式"
- 切换后立即生效（下一条消息按新模式执行）
- 配置持久化在 `data/config/` 下

### US-3：定时任务支持全托管

> 作为管理员，我希望定时任务也能带 `autonomous=true` 标记，到点自动全托管执行。

**验收**：
- 创建/编辑定时任务时可勾选"全托管"
- scheduled_tasks 表持久化该字段
- 任务触发时 ContainerInput.autonomous = true

### US-4：硬刹车保护

> 作为用户/管理员，我希望全托管任务有自动刹车机制，防止 agent 跑飞了烧光预算或误删文件。

**验收**：
- 轮次超限自动停止（默认 50 轮，可配置）
- Token 超限自动停止（默认 1M，可配置）
- 循环输出检测（连续 3 轮输出 hash 相同）自动停止
- 破坏性命令拦截（`rm -rf /`、`git push --force`、`DROP TABLE` 等）自动停止并报警
- 任何一项硬刹车触发时，UI 红色 banner 显示原因
- 用户可随时手动停止任务

### US-5：紧急停止

> 作为用户，我希望在全托管任务执行中能随时按"停止"按钮中断。

**验收**：
- ChatPage 在全托管任务执行中显示红色"停止"按钮
- 点击后立即向 agent-runner 发送 `_close` sentinel
- 已写入的进度保留（不回滚）

## 4. 功能清单

### F1：ContainerInput.autonomous 字段
- 类型层：`container/agent-runner/src/types.ts:11` + `src/container-runner.ts:238` 同步加 `autonomous?: boolean`
- 透传链路：`src/index.ts:8433`（chat 路径）+ `src/task-scheduler.ts:612`（scheduled 路径）+ `src/loop-orchestrator.ts:289`（graph 路径）

### F2：Supervisor clarify 旁路
- `src/supervisor.ts:27-41`：autonomous 时 prompt 限制 action ∈ `{delegate, auto, delegate_team}`
- `src/web.ts:504-530`：autonomous 时跳过 clarify 分支，直接 `delegate`
- `src/supervisor-agent.ts:565-580`：autonomous 时 escalate 不写提问消息，改为日志 + 自动注入续接消息

### F3：CLAUDE.md 注入 Autonomous Override
- `src/container-runner.ts:1187-1212` `writeAgentProjectClaudeMd`：autonomous 时追加 override 段，显式压过 `Think Before Coding` 的 halt-and-ask

### F4：端回合自动续接（核心）
- `container/agent-runner/src/stream-processor.ts:64`：暴露 `lastTurnAskedUser` 标志（AskUserQuestion 工具调用 + 文本征询正则双信号）
- `container/agent-runner/src/index.ts:2944-2962`：autonomous 且 `lastTurnAskedUser` 时，不 `await waitForIpcMessage()`，改为注入"无需提问，按最佳判断继续推进"的合成 IPC 消息，进入下一轮 query()

### F5：硬刹车
- 轮次计数器（in-memory，per-session）
- Token 累计（in-memory，per-session）
- 输出 hash 历史队列（最近 5 轮）
- 破坏性命令正则拦截（Bash 工具调用 input 检查）
- 任一触发 → agent-runner 退出 + 主服务广播 `task_aborted` 事件

### F6：API
- `POST /api/messages` 接受 `autonomous?: boolean` body 字段
- `PATCH /api/groups/:jid` 接受 `autonomous?: boolean`
- `POST /api/tasks` / `PATCH /api/tasks/:id` 接受 `autonomous?: boolean`
- `GET /api/groups/:jid` 返回 `autonomous` 字段
- `GET /api/autonomous/active` 返回当前运行中的全托管任务列表（监控用）

### F7：DB Schema
- `scheduled_tasks` 表加 `autonomous INTEGER DEFAULT 0`
- `registered_groups.container_config` JSON 加 `autonomous?: boolean`（不改表结构，存 JSON）
- Schema version v24 → v25

### F8：前端 UI
- `ChatPage` 输入框旁加"全托管"toggle 按钮（per-message）
- `SettingsPage` 加"工作区自主模式"配置区（per-group）
- `TasksPage` 创建定时任务表单加"全托管"复选框
- `MonitorPage` 加"自主任务"区，显示活跃全托管任务 + 紧急停止按钮
- 新增 Zustand store `autonomous-store.ts`

### F9：可观测性
- 复用 `src/autonomy/autonomy-bus.ts` 事件总线，发新事件类型：
  - `autonomous.started` / `autonomous.continued` / `autonomous.aborted`
  - `autonomous.brake_triggered`（含刹车原因）
- 前端 AutonomySection 仪表盘加"自主任务"卡片

## 5. 验收标准

### AC-1：Supervisor 不拦全托管任务
**Given** 用户发送一条带 `autonomous=true` 的消息
**When** Supervisor 解析意图时输出 `clarify`
**Then** 主服务跳过 clarify 分支，直接走 `delegate` 原文转发，agent 启动

### AC-2：端回合自动续接
**Given** 全托管任务执行中，agent 这一轮用 `AskUserQuestion` 工具或文本结尾出现征询性短语
**When** agent-runner 主循环走到 line 2944
**Then** 不阻塞 `waitForIpcMessage()`，自动注入合成续接消息，进入下一轮 `query()`

### AC-3：硬刹车 - 轮次超限
**Given** 全托管任务已执行 50 轮（默认上限）
**When** agent-runner 检测到 `turnCount >= maxTurns`
**Then** agent-runner 退出，主服务广播 `task_aborted` 事件，UI 红色 banner 显示"轮次超限"

### AC-4：硬刹车 - 循环检测
**Given** 连续 3 轮 agent 输出 hash 相同
**When** 检测器命中
**Then** agent-runner 退出，刹车原因为 `loop_detected`

### AC-5：硬刹车 - 破坏性命令
**Given** agent 调用 Bash 工具，input 匹配 `rm -rf /|git push --force|DROP TABLE|git reset --hard`
**When** 拦截器命中
**Then** agent-runner 退出，刹车原因为 `destructive_command`

### AC-6：默认模式不变
**Given** 用户发送 `autonomous=false` 或不带的普通消息
**When** 走原有路径
**Then** 行为与改造前完全一致（Supervisor 可 clarify，端回合等待用户输入）

### AC-7：紧急停止
**Given** 全托管任务执行中
**When** 用户点击"停止"按钮
**Then** agent-runner 收到 `_close` sentinel，1s 内退出，已写入进度保留

### AC-8：任务前澄清允许
**Given** 用户发送 `autonomous=true` 但任务目标模糊（如"写本书"）
**When** Supervisor 判定无法自主决策
**Then** **允许** 1 次 clarify 提问（这是任务前澄清，符合需求），用户回答后进入全托管执行

### AC-9：定时任务全托管
**Given** 管理员创建定时任务时勾选"全托管"
**When** 任务触发
**Then** ContainerInput.autonomous=true，走全托管路径

### AC-10：可观测性
**Given** 全托管任务执行
**When** 每轮自动续接时
**Then** autonomy bus 发 `autonomous.continued` 事件，仪表盘可见

## 6. 测试用例

### 6.1 单测

| ID | 文件 | 覆盖 |
|---|---|---|
| U-1 | `tests/units/supervisor-autonomous.test.ts` | autonomous 时 supervisor prompt 禁用 clarify |
| U-2 | `tests/units/clarify-bypass.test.ts` | web.ts:505 在 autonomous=true 时跳过 clarify 分支 |
| U-3 | `tests/units/end-of-turn-detection.test.ts` | AskUserQuestion 工具调用 + 文本征询正则双信号检测 |
| U-4 | `tests/units/loop-detector.test.ts` | 连续 3 轮 hash 相同触发 |
| U-5 | `tests/units/destructive-command.test.ts` | rm -rf / git push --force / DROP TABLE 等正则命中 |
| U-6 | `tests/units/turn-counter.test.ts` | 轮次计数 + 超限退出 |
| U-7 | `tests/units/autonomous-directive.test.ts` | CLAUDE.md override 段在 autonomous=true 时注入 |
| U-8 | `tests/units/auto-continue.test.ts` | 端回合检测后注入合成消息而非阻塞 |
| U-9 | `tests/units/scheduled-task-autonomous.test.ts` | scheduled_tasks.autonomous 字段持久化 |
| U-10 | `tests/units/group-autonomous-config.test.ts` | registered_groups container_config.autonomous 读写 |

### 6.2 E2E

| ID | 文件 | 覆盖 |
|---|---|---|
| E-1 | `tests/e2e/autonomous-mode.mjs` | 全流程：发送 autonomous 消息 → 自动续接到完成 → 验证 0 次提问消息 |
| E-2 | `tests/e2e/autonomous-brake.mjs` | 触发轮次超限刹车 → 验证 task_aborted 事件 |
| E-3 | `tests/e2e/autonomous-stop-button.mjs` | 紧急停止按钮 → agent-runner 1s 内退出 |

## 7. 风险与边界

### 7.1 风险

| 风险 | 严重度 | 缓解 |
|---|---|---|
| Agent 跑飞烧光 token | 高 | Token 上限硬刹车 + 用户可紧急停止 |
| Agent 循环输出 | 中 | Hash 循环检测（3 轮阈值） |
| Agent 执行破坏性命令 | 高 | 正则黑名单 + CLAUDE.md override 双保险 |
| Agent 写错代码污染仓库 | 中 | Worktree 隔离（用户已在使用） + 紧急停止 |
| 端回合检测误判（agent 没问问题但被判为问问题）| 中 | 双信号（AskUserQuestion 工具 + 文本正则），单信号不触发 |
| 端回合检测漏判（agent 用模糊文本问问题） | 中 | 正则覆盖 8+ 种常见征询模式 + 持续迭代 |
| 默认监督者模式被误改 | 高 | 全部新增分支条件 `if (autonomous)`，未命中走原路径 |
| 数据库迁移破坏 | 中 | scheduled_tasks 加列用 `ALTER TABLE` + `ensureColumn`，v24→v25 增量 |

### 7.2 边界

- 全托管模式**不保证**任务结果正确性，只保证执行不中断
- 全托管模式**不保证**agent 选择最优方向，只保证按既定策略推进
- 用户验收仍是人工环节，不在本需求范围
- 全托管模式下 agent 仍可调用所有 MCP 工具和 Skills，不限制能力

## 8. 实施顺序

参见 `docs/tech_solution/feat-autonomous-mode/TECH_SOLUTION.md` 第 11 节实施计划。

## 9. 度量

任务上线后跟踪（不在本需求交付内，但要在 PRD 留痕）：

- 全托管任务平均轮次
- 全托管任务硬刹车触发率
- 全托管任务用户中断率
- 全托管任务完成率（用户验收通过率）

## 10. 附录

### 10.1 术语表

| 术语 | 定义 |
|---|---|
| 全托管 (Autonomous) | 任务执行期间 agent 不主动询问用户 |
| 硬刹车 (Hard Brake) | 系统强制终止 agent 的条件 |
| 端回合 (End-of-Turn) | agent 一次 query() 完成、等待下一个输入的时刻 |
| 任务前澄清 (Pre-task Clarification) | 任务开始前 Supervisor 一次性提问 |
| 监督者模式 (Supervisor Mode) | 默认模式，agent 可中途 halt and ask |

### 10.2 决策记录

- **不**实现"任务结果自动验收"——这是用户人工环节，不在本需求
- **不**实现多 agent 协同自主——本需求只覆盖单 agent，多 agent 走 graph-engineering
- **不**移除默认监督者模式——backward compatibility
- 端回合检测用**双信号**（AskUserQuestion 工具 + 文本正则）——单信号要么误判多要么漏判多
- 硬刹车默认值保守（50 轮 / 1M token）——首版宁误杀不放过
