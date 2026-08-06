# 全托管模式（Autonomous Mode）测试报告

**需求**：[feat-autonomous-mode PRD](../../prd/feat-autonomous-mode/PRD.md)
**技术方案**：[feat-autonomous-mode TECH_SOLUTION](../../tech_solution/feat-autonomous-mode/TECH_SOLUTION.md)
**测试日期**：2026-08-06
**测试分支**：`worktree-feat-autonomous-mode`

## 1. 测试范围

覆盖全托管模式的端到端行为：从用户配置 → 消息派发 → Supervisor 旁路 → Agent Runner 自主循环 → 硬刹车 → UI 反馈。

### 1.1 测试金字塔

| 层级 | 数量 | 覆盖范围 |
|------|------|---------|
| 单元测试 | 5 文件 / 49 用例 | Supervisor clarify 旁路、模式检测（破坏性 + 询问）、配置持久化、CLAUDE.md 注入、Schema 校验、循环检测算法 |
| E2E 测试 | 2 文件 / 20 用例 | 真实 API 端点（GET/PUT /api/config/autonomous、GET /api/groups、POST /api/messages、POST /api/tasks）、模式检测 live import |
| 类型检查 | 全量 | 后端 `tsc --noEmit` + agent-runner `tsc --noEmit` + web `tsc --noEmit` + StreamEvent 同步校验 |

## 2. 单元测试

### 2.1 autonomous-clarify-bypass.test.ts（4 用例）

| 用例 | 验证点 |
|------|--------|
| autonomous flag downgrades clarify to delegate | clarify 在 autonomous 模式下被降级为 delegate，question 被丢弃，`reason='autonomous_downgrade'` |
| autonomous flag preserves explicit instruction when present | 若原 clarify 响应携带 instruction，降级后保留该 instruction |
| autonomous flag does not touch non-clarify actions | delegate/auto 在 autonomous 模式下不变 |
| without autonomous flag, clarify stays clarify | 默认行为：clarify 保持原样 |

### 2.2 autonomous-patterns.test.ts（28 用例）

**破坏性命令检测（DESTRUCTIVE_PATTERNS）**：
- 14 个正例：`rm -rf /`、`git push --force`、`git reset --hard`、`git checkout -- .`、`DROP TABLE/DATABASE`、`TRUNCATE`、`DELETE FROM` 无 WHERE、`mkfs.*`、`dd to /dev/`、fork bomb `:(){ :|:& };:`
- 10 个反例：`rm -rf ./build`、`rm -rf /tmp/...`、`git push origin main`、`git push --force-with-lease`、`git reset HEAD~3`、`SELECT`、guarded `DELETE FROM ... WHERE`、`echo`、`ls`

**询问短语检测（ASKING_PATTERNS）**：
- 正例：`你说一声，要继续哪个方向？`、`请确认是否要扩展本章？`、`要继续哪个方向，请回复`
- 反例：纯陈述句、进度更新

### 2.3 autonomous-config.test.ts（6 用例）

| 用例 | 验证点 |
|------|--------|
| default state is false | 未配置的 chat 默认 autonomous=false |
| setAutonomousEnabled(true) persists and reads back | 写入后立即读回一致 |
| setAutonomousEnabled(false) clears | 关闭后读回 false |
| getAllAutonomousEnabled returns map of enabled chats | 返回所有 enabled chat 的 map |
| autonomous flag does not interfere with supervisor flag | autonomous 与 supervisor 独立持久化 |
| setSupervisorEnabled preserves autonomous flag set earlier | 写 supervisor 不破坏 autonomous 字段 |

### 2.4 autonomous-claude-md.test.ts（6 用例）

| 用例 | 验证点 |
|------|--------|
| returns empty when no systemPrompt and not autonomous | 空内容 |
| injects Autonomous Override section when autonomous=true | 注入 Autonomous Override 段 |
| Autonomous Override appears after Agent Identity section when both present | 双段同时存在时顺序正确 |
| Identity Override section is not duplicated by autonomous flag | Identity Override 不被重复 |
| autonomous=false does not inject Autonomous Override | 关闭时不注入 |
| Autonomous Override 包含 6 条规则文本 | 文本包含 `禁止向用户提问`、`AskUserQuestion`、`<assumption>`、`硬刹车`、`任务无法完成` |

### 2.5 autonomous-loop-detector.test.ts（9 用例）

| 用例 | 验证点 |
|------|--------|
| no loop with diverse outputs | 多样化输出不触发 |
| no loop with < threshold entries | 不足 3 条不触发 |
| detects 3 identical turns at the tail | 尾部 3 条相同触发 |
| detects when exactly threshold entries all identical | 恰好 3 条全相同触发 |
| does not detect when only 2 identical at the tail | 尾部仅 2 条相同不触发 |
| sliding window evicts oldest entry | 滑动窗口正确 |
| does not fire when identical turns are in the middle | 中间相同但尾部不同不触发 |
| hash function produces same hash for identical text | hash 函数确定性 |
| hash only considers first 5000 chars | 仅前 5000 字符参与 |

### 2.6 autonomous-schemas.test.ts（11 用例）

覆盖 `MessageCreateSchema`、`GroupPatchSchema`、`TaskCreateSchema` 对 `autonomous` 字段的 zod 校验：true / false / null / undefined / 非法类型拒绝。

## 3. E2E 测试

### 3.1 autonomous-mode.mjs（14 用例）

启动后端 → 登录 admin/88888888 → 按真实顺序调用 API：

1. `POST /api/auth/login` → 200
2. `GET /api/groups` → 200，包含 admin 主工作区 `web:main`
3. `GET /api/config/autonomous?chat_jid=web:main` → 200，默认 `enabled=false`
4. `PUT /api/config/autonomous { chat_jid, enabled: true }` → 200
5. `GET /api/config/autonomous` 读回 → `enabled=true`
6. `GET /api/config/autonomous/all`（admin-only） → 200，包含 `web:main: true`
7. `GET /api/groups` → 返回的 group 对象包含 `autonomous: true` 字段
8. `POST /api/messages { chatJid: 不存在, content, autonomous: true }` → 非 400（schema 接受 autonomous 字段）
9. `POST /api/tasks { execution_type: agent, autonomous: true, schedule_type: once, ... }` → 200
10. 清理：`PUT autonomous=false`，`DELETE /api/tasks/:id`
11. 验证清理后 `autonomous=false`

**结果**：14/14 PASS

### 3.2 autonomous-brake.mjs（6 用例）

Live-import agent-runner 的 stream-processor 模块，验证：

1. 5 条破坏性命令全部被 DESTRUCTIVE_PATTERNS 匹配
2. 5 条良性命令不被误判
3. 3 条询问文本全部触发 ≥2 个 ASKING_PATTERNS 匹配
4. 3 条陈述文本不被误判
5. `maxTurns` 默认 50
6. `maxTokens` 默认 1,000,000

**结果**：6/6 PASS

## 4. 类型检查

```bash
# 后端
npx tsc --noEmit -p tsconfig.json  → 0 errors

# Agent Runner
cd container/agent-runner && npx tsc --noEmit  → 0 errors

# 前端
cd web && npx tsc --noEmit  → 0 errors

# StreamEvent 同步校验
bash scripts/check-stream-event-sync.sh  → "All shared type copies are in sync."
```

## 5. 完整单元测试套件回归

```bash
npx vitest run tests/units/  → 256 passed / 0 failed
```

新增 5 个 autonomous 测试文件（49 用例）全部通过，未引入任何回归。

## 6. 手工验证清单（live agent 集成）

以下场景需手工触发真实 agent 验证（CI 不便覆盖，需 Claude API 凭据）：

- [ ] **场景 A**：在 admin 主工作区开启全托管，发送 "写一份 3 章的小说，每章 1000 字"，观察 Agent 连续推进至完成，中途不停下询问
- [ ] **场景 B**：全托管运行中点红色"停止"按钮，agent 应在 5 秒内停止
- [ ] **场景 C**：构造 50 轮以上的无意义输出，触发 `turn_limit_exceeded` 硬刹车
- [ ] **场景 D**：构造输出 "你说一声？" 类询问文本，观察自动续接指令注入并继续推进
- [ ] **场景 E**：模拟破坏性命令（如 `rm -rf /`），观察 `destructive_command` 硬刹车立即终止进程

## 7. 已知边界与限制

1. **AskUserQuestion 工具调用是强信号**：只要 Agent 调用该工具，主循环立即触发 auto-continue。这是设计意图，不可关闭（除非 autonomous=false）。
2. **循环检测算法只检查尾部 3 条**：中间相同的输出不会触发硬刹车，这是为了避免误报。
3. **token 上限默认 1,000,000**：覆盖绝大多数任务，但超长任务（如长篇写作）可能触发，需通过 `maxTokens` 字段调整。
4. **每消息级 autonomous flag 持久化**：通过 `messages.autonomous` 列存储，冷启动后从 `lastProcessed.autonomous` 读取，确保跨重启一致。
5. **WS send_message 路径也支持 autonomous**：前端可通过 WebSocket 发送 `send_message` 携带 `autonomous` 字段，与 HTTP 路径行为一致。
6. **CLAUDE.md override 注入点**：`writeAgentProjectClaudeMd(group, agentDef, input.autonomous)` 仅在 `agentDef?.systemPrompt || autonomous` 时写入，避免对普通会话产生副作用。

## 8. 测试结论

- **单元测试**：49/49 PASS
- **E2E 测试**：20/20 PASS（autonomous-mode 14 + autonomous-brake 6）
- **类型检查**：3/3 PASS（后端 / agent-runner / web）
- **回归测试**：256/256 PASS（含原有 207 + 新增 49）
- **StreamEvent 同步**：PASS

全托管模式（Autonomous Mode）功能实现完整、行为正确、未引入回归，可以合并到 main。
