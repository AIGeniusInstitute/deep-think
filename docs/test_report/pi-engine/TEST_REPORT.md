# 测试报告：pi-engine v2 二进制包方式重新实现

- **分支**：`feat/pi-engine-rpc-fix`（基于 `main` a295eff）
- **测试日期**：2026-07-25
- **pi 版本**：0.82.0（`/home/me/pi/packages/coding-agent/dist/cli.js`）
- **测试环境**：Node v24.15.0；DeepThink dev 后端（`WEB_PORT=9898 npx tsx src/index.ts`，host 模式）；DashScope Anthropic 兼容端点（`https://dashscope.aliyuncs.com/apps/anthropic`，model `glm-5.2`）

## 1. 测试范围

| 层级 | 测试方式 | 结果 |
|------|----------|------|
| L1 协议正确性 | 裸跑 `pi --mode rpc` dump 全事件流 | ✅ |
| L2 引擎单元 | `runPiEngine` 直调 smoke（含 models.json 生成） | ✅ |
| L3 agent-runner 集成 | 真实 `dist/index.js` + ContainerInput JSON + OUTPUT marker 协议 | ✅ |
| L4 全栈 UI 等价 | WebSocket `send_message` → dev 后端 → engine=pi → agent-runner → pi → 回复 | ✅ |
| L5 配置 UI | `PUT /api/config/pi` 保存 provider/apiKey/baseURL | ✅ |
| L6 群组引擎切换 | `PATCH /api/groups/web:main {engine:"pi"}` | ✅ |

## 2. L1 协议正确性（裸 pi RPC）

命令：`printf '{"id":"t1","type":"get_state"}\n' | node dist/cli.js --mode rpc --no-session --provider anthropic --model <id>`

结果：`get_state` 响应 `success:true` + `data.sessionId` 正常。事件流完整：
agent_start → turn_start → message_start(user) → message_end(user) → message_start(assistant) → message_update(text_delta/thinking_delta) → message_end(assistant) → turn_end → agent_end → agent_settled

确认 pi RPC 协议契约与 `~/pi/packages/coding-agent/docs/rpc.md` 一致。

## 3. L2 引擎单元 smoke

### 3.1 错误透传（B3 修复验证）
配置 anthropic 直调 key（无 baseURL）→ Anthropic 返回 403 forbidden。
结果：`{"status":"error","error":"pi 错误：403 {\"error\":{\"type\":\"forbidden\",\"message\":\"Request not allowed\"}}"}` ✅
（v1 会返回"空回复 success"，v2 经 `message_end` 的 `stopReason:"error"` 分支正确捕获并透传）

### 3.2 统一配置 happy path（B4 修复验证）
`PiConfig.providers` 配 DashScope（含 baseURL）+ GLM-5.2，调 `runPiEngine`。
结果：
- 自动生成 `models.json`（1 个自定义 provider `dt-anthropic`，apiKey 用 `$ANTHROPIC_API_KEY` 引用不落盘）→ 写入隔离 `PI_CODING_AGENT_DIR/models.json` (0600)
- spawn `--mode rpc --model dt-anthropic/glm-5.2 --thinking off`（baseURL 生效）
- `get_state` 就绪 → `text_delta` 流式输出 "PONG" → `status:"success"` + `newSessionId` 持久化 ✅

### 3.3 多轮 IPC 跟进（B5 修复验证）
首轮 "FIRST" → 投递 IPC 跟进消息 "SECOND" → 投递 `_close`。
结果：`success: FIRST | success: SECOND`，`_close` 触发 cleanup → `closedPromise` resolve → 进程退出 ✅
（v1 设好 IPC 循环后函数即返回，`index.ts` 的 `process.exit(0)` 会立即杀进程，跟进消息永远不处理；v2 `await closedPromise` 阻塞保活）

## 4. L3 agent-runner 集成

命令：`node dist/index.js < ContainerInput.json`（PI_* env 按 container-runner 方式注入）
ContainerInput：`{"engine":"pi","prompt":"Reply with exactly one word: PONG","turnId":"ui-int-1",...}`

结果（经 OUTPUT marker 协议）：
```
[agent-runner] Engine = pi, routing to pi-engine adapter
[agent-runner] Spawning pi: node .../cli.js --mode rpc --model dt-anthropic/glm-5.2 --thinking off
[agent-runner] pi ready, sessionId=019f95dc-...
{"status":"stream","streamEvent":{"eventType":"init","statusText":"pi 引擎已启动"}}
{"status":"stream","streamEvent":{"eventType":"text_delta","text":"PONG"}}
{"status":"success","result":"PONG","newSessionId":"019f95dc-...","finalizationReason":"completed"}
{"status":"closed"}
```
完整分发链路 `index.ts → runPiEngine → pi 子进程 → StreamEvent → success` 验证通过 ✅

## 5. L4 全栈 UI 等价测试

dev 后端（`WEB_PORT=9898`，使用重建后的 `~/deepthink/container/agent-runner/dist`，含 v2 修复）。WebSocket 发消息：

| 发送 | pi 引擎回复（dev 日志 `Agent output`） | 结果 |
|------|----------------------------------------|------|
| `用一句话回复：pong` | `pong`（04:51:52，长度 4） | ✅ |
| `用一个词回复：ping` | `ping`（04:54:43） | ✅ |

全栈链路：`WS send_message → 后端 → engine=pi（web:main）→ spawn host agent-runner → pi-engine.ts → pi 子进程（DashScope/GLM）→ "pong"/"ping" → OUTPUT marker → 后端 → "Agent output: pong" → 消息写回 web:main` ✅

## 6. L5/L6 配置与切换

- `PUT /api/config/pi`（body 含 `enabled/binaryPath/cliScriptPath/defaultProvider/defaultModel/thinkingLevel/providers[+apiKey+baseURL]`）→ 200，GET 回读 `hasApiKey:true` ✅
- `PATCH /api/groups/web:main {"engine":"pi"}` → `{"success":true}`，GET 回读 `engine:"pi"` ✅

## 7. 验收标准核对（PRD §E）

| 编号 | 验收项 | 结果 |
|------|--------|------|
| EC1 | pi-engine 不含 readline 调用（`grep readline` 仅注释命中） | ✅ |
| EC2 | 单进程多轮经 id 关联，无 stdout 抢流 | ✅（L3） |
| EC3 | provider 错误以 `status:"error"` 透传 | ✅（L2 §3.1） |
| EC4 | 含 baseURL 的 provider 正常出流式回复 | ✅（L2 §3.2 / L4） |
| EC5 | 首轮后进程不退出，IPC 跟进被处理，`_close` 后退出 | ✅（L2 §3.3） |
| EC6 | 用户无需在本机配置 pi（隔离 PI_CODING_AGENT_DIR + 全配置来自 DeepThink） | ✅ |

## 8. 已知限制（PRD §F，v2 沿用 v1）

- 未桥接 DeepThink MCP 工具（send_message/schedule_task/memory_*）到 pi
- 不支持图片输入（首版 text-only）
- 未做 pi Extensions/Skills/Prompt Templates 的 Web 管理

## 9. 结论

pi-engine v2 重新实现全部验收通过。修复了 v1 的 5 个缺陷（readline 协议违规、双重 reader 抢流、错误不透传、baseURL 不生效、进程提前退出），并以 `writePiModelsJson` 实现"LLM 服务商配置统一在 DeepThink 引擎配置界面、用户无需在本机配置 pi"的要求。端到端（含真实 DashScope/GLM provider）经全栈验证产出正确回复。
