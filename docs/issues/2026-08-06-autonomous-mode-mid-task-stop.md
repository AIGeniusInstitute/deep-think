# 2026-08-06 DeepThink 中途停下询问用户违反全自主指令

## 1. 用户现象

用户在 DeepThink 中下发了明确的全自主完成指令（"全自主完成，不要中途停下询问"），并在系统提示中明确禁止询问。Agent 在任务执行过程中仍然在中途停下，输出"下一步：你说一声，我可以：扩展本章补到 5 万字…或直接开第 2 章…要继续哪个方向，你说。"类征询性文本，违反了用户的全自主授权。

## 2. 问题描述

DeepThink 的 Claude Code 引擎在 task 执行期间，即便用户明确授权"全自主"，Agent 仍会在以下三道"防御层"触发停下询问行为：

1. **CLAUDE.md "Think Before Coding" 宪法**：`Don't assume. Don't hide confusion. Surface tradeoffs.` → Agent 遇到方向分叉时，将"halt and ask"作为首选行为
2. **Supervisor clarify 路径**：`runSupervisorPreDispatch` 在意图不明时返回 `{action: 'clarify', question}`，主进程向用户抛问题
3. **RLHF 端回合礼貌**：Claude 在训练中被强化为"礼貌征询下一步"，自然输出"你说一声"/"要继续哪个方向"等征询性短语后结束 turn

## 3. 根因

### 3.1 三层防御均为非自主设计

- `~/.claude/CLAUDE.md` 的 `Think Before Coding` 第 1 条与全自主语义直接冲突
- `src/supervisor.ts` 的 `parseDecision` 不区分任务上下文，clarify 是合法动作
- Claude Agent SDK 的 RLHF 训练偏置无法在 SDK 层关闭

### 3.2 没有"全自主"语义通道

原本 `ContainerInput` 没有 `autonomous` 字段；Supervisor 没有 `autonomous` 旁路；CLAUDE.md 注入逻辑没有 autonomous override 段；主循环没有"端回合检测 + 自动续接"逻辑。

### 3.3 缺乏硬刹车护栏

即使 Agent 不停下，也可能：执行破坏性命令（`rm -rf /`）、无限循环输出相同文本、消耗过多 token。系统原本只有 `CONTAINER_TIMEOUT`（30 分钟）这一道粗粒度护栏，对全自主场景风险过高。

## 4. 复现路径

1. 在 admin 主工作区发送任务："你是诺贝尔文学奖得主，写一本中英双语长篇，全自主完成，不要中途询问"
2. 观察第 1 章生成完毕后 Agent 的输出
3. 预期（修复前）：输出末尾出现"要继续哪个方向，你说。"，turn 结束，等待用户输入
4. 预期（修复后）：Agent 直接进入第 2 章，无征询性文本

## 5. 诊断方法

```bash
# 检查 chat 是否开启 autonomous
curl -b cookies.txt http://localhost:9899/api/config/autonomous?chat_jid=web:main

# 检查消息是否携带 autonomous flag（DB）
sqlite3 ~/.deepthink/data/db/messages.db \
  "SELECT id, substr(content,1,40), autonomous FROM messages WHERE chat_jid='web:main' ORDER BY timestamp DESC LIMIT 5;"

# 检查 agent-runner 是否注入了 Autonomous Override 段
cat ~/.deepthink/data/groups/main/CLAUDE.md | grep -A 20 "Autonomous Override"
```

## 6. 修复方案

引入"全托管模式"（Autonomous Mode）作为三道防御层的可显式压覆开关，外加四道硬刹车护栏。

### 6.1 数据流

```
User toggle (UI: AutonomousToggle)
    → PUT /api/config/autonomous { chat_jid, enabled: true }
    → supervisor-config.ts setAutonomousEnabled(jid, true)

User sends message (per-message flag override)
    → POST /api/messages { chatJid, content, autonomous: true }
    → messages.autonomous column = 1
    → lastProcessed.autonomous = 1
    → ContainerInput.autonomous = true

Agent runner
    → CLAUDE.md Autonomous Override 段注入
    → <autonomous-mode> 系统提示段注入
    → runQuery 收集 autonomousSignals { lastTurnAskedUser, lastTurnDestructiveCmd, turnFullText, totalTokens }
    → 主循环 autonomous block：
        - 4 道硬刹车（破坏性命令 / 轮次上限 / token 上限 / 循环检测）
        - 端回合检测（强信号 AskUserQuestion tool + 弱信号 ≥2 个 ASKING_PATTERNS）
        - 自动续接：注入 synthetic continue message，再次 runQuery
```

### 6.2 关键代码改动

| 文件 | 改动 |
|------|------|
| `src/supervisor.ts` | `parseDecision` 接受 `opts.autonomous`，降级 clarify→delegate |
| `src/supervisor-config.ts` | 新增 `isAutonomousEnabled/setAutonomousEnabled/getAllAutonomousEnabled` |
| `src/container-runner.ts` | `buildAgentProjectClaudeMdContent(agentDef, autonomous)` 注入 Autonomous Override 段 |
| `container/agent-runner/src/stream-processor.ts` | 新增 `DESTRUCTIVE_PATTERNS`（11 条）、`ASKING_PATTERNS`（13 条）、token 累积、turn 文本累积、`lastTurnAskedUser` / `lastTurnDestructiveCmd` 标记 |
| `container/agent-runner/src/index.ts` | 主循环新增 autonomous block（4 硬刹车 + auto-continue），runQuery 返回 `autonomousSignals` |
| `src/db.ts` | `messages.autonomous` + `scheduled_tasks.autonomous` 列 |
| `src/web.ts` | `handleWebUserMessage` 接受 `opts.autonomous`，跳过 clarify 分支 |
| `src/routes/config.ts` | 3 个新路由：GET/PUT /api/config/autonomous、GET /api/config/autonomous/all |
| `shared/stream-event.ts` | 4 个新事件类型：autonomous_started/continued/aborted/brake |
| 前端 | `web/src/stores/autonomous.ts` + `AutonomousToggle.tsx` + `AutonomousStopButton.tsx` + `CreateTaskForm` checkbox + chat store 事件处理 |

### 6.3 选型理由

- **不修改 `~/.claude/CLAUDE.md` 全局宪法**：避免影响普通会话；override 段以"本任务专用"形式注入到 group-level CLAUDE.md
- **per-message flag 用 null 显式关闭**：`{ autonomous: null }` 即使 group 开启也按监督者模式执行，比 boolean 更细致
- **双信号端回合检测**：AskUserQuestion tool 是强信号（单次即触发），文本 regex 是弱信号（需 ≥2 个匹配）。避免误报
- **循环检测只看尾部 3 条**：避免长任务中的中间相似段落误触发
- **硬刹车使用 `process.exit(1)`**：立即终止，无法被 Agent 规避；与 supervisor-agent.ts 的 escalate 路径互补

## 7. 处理卡住的状态

如果 autonomous run 卡住（如陷入无限循环但未被检测到）：

1. UI 红色"停止"按钮 → `POST /api/groups/:jid/stop` → `_close` sentinel → agent-runner 退出
2. 进程级：`lsof -ti:PORT -sTCP:LISTEN | xargs kill` 杀监听进程
3. 容器级：`docker ps | grep <folder>` → `docker stop <name>`
4. 配置级：`PUT /api/config/autonomous { enabled: false }` 防止下次又自动进入

## 8. 经验沉淀 / 预防

1. **"halt and ask" 是 RLHF 默认偏置**：要全自主，必须在三道防御层都加显式压覆开关，缺一不可
2. **风险护栏优先于自主性**：autonomous block 的硬刹车检查（破坏性命令 / 循环 / 轮次 / token）必须**先于** auto-continue 执行，否则 Agent 可能在破坏性命令后又被续接
3. **AskUserQuestion tool 调用是端回合的强信号**：不需要文本 regex 验证即可触发 auto-continue；regex 仅作 fallback
4. **per-message autonomous flag 必须持久化**：仅在内存中传递会被冷启动丢失；存到 `messages.autonomous` 列后 `loadState()` 可恢复
5. **WebSocket 路径与 HTTP 路径必须同时支持 autonomous flag**：前端 Send via WS 时也需携带
6. **autonomous 应有独立 store**：避免与 supervisor store 耦合，因为两者语义不同（supervisor 是 pre-dispatch，autonomous 是全周期）

### 8.1 巡检脚本建议

```bash
# 列出所有开启了 autonomous 的 chat
curl -b cookies.txt http://localhost:9899/api/config/autonomous/all | jq '.groups | to_entries | map(select(.value))'

# 检查长时间运行的 autonomous 进程（> 10 分钟）
ps -eo pid,etime,cmd | grep "agent-runner" | awk '$2 ~ /[0-9]+:[0-9][0-9]/ && $2 !~ /^00:0/'

# 检查 messages 表中 autonomous=1 的消息
sqlite3 ~/.deepthink/data/db/messages.db \
  "SELECT chat_jid, COUNT(*) FROM messages WHERE autonomous=1 GROUP BY chat_jid;"
```

### 8.2 告警建议

- 监控 `autonomous_brake` StreamEvent 出现频率，> 5 次/小时 提示有 Agent 陷入循环或破坏性尝试
- 监控单个 chat 的 autonomous 状态保持时间，> 2 小时未关闭提示用户忘记关
- 监控 token 使用量，单次 autonomous run > 800k tokens 提示接近硬刹车阈值
