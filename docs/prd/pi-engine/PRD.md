# PRD：引入 pi 作为 DeepThink 第四 Agent 执行引擎

- **版本**：v1.0
- **创建日期**：2026-07-25
- **负责人**：DeepThink 团队
- **分支**：`feat/pi-engine`（基于 `main`）
- **参考实现**：`atomcode-engine` / `codex-engine` / `opencode-engine`（`container/agent-runner/src/`）

## 1. 背景与目标

### 1.1 背景

DeepThink 目前的 Agent 执行引擎层采用「判别联合 + switch 分发 + 同构 adapter 函数」的轻量约定式架构，已支持四种引擎：

| 引擎值 | 实现 | 进程模型 | 协议 |
|--------|------|----------|------|
| `claude`（默认） | Claude Agent SDK `query()` | in-process | SDK 事件流 |
| `atomcode` | `atomcode-engine.ts` | 长驻 HTTP/SSE daemon | SSE `/chat` |
| `codex` | `codex-engine.ts` | 每 turn spawn CLI | JSONL stdout |
| `opencode` | `opencode-engine.ts` | 长驻 HTTP serve | REST + SSE |

开源项目 **pi**（`~/pi`，TypeScript monorepo，版本 0.82.0）是一套 self-extensible coding agent harness，由三层核心包构成：

- `@earendil-works/pi-ai`：统一多 provider LLM API（OpenAI/Anthropic/Google/DeepSeek/GLM/Qwen 等 20+ provider，含自动模型发现、流式工具调用、thinking、OAuth）
- `@earendil-works/pi-agent-core`：通用 agent runtime（transport 抽象、状态管理、工具执行、事件流、context compaction、会话存储、skills/prompt-templates harness）
- `@earendil-works/pi-coding-agent`：**CLI 入口包**（`pi` bin），含 read/bash/edit/write/grep/find/ls 内置工具、四种运行模式（interactive TUI / print / json / **RPC**）、会话管理、配置

pi 原生提供 **RPC 模式**（`pi --mode rpc`）：stdin 读 JSONL 命令、stdout 写 JSONL 事件/响应，长驻进程（`return new Promise(() => {})`）。其 README 与 `rpc-types.ts` 注释明确标注 RPC 模式「for process integration」——这正是 DeepThink agent-runner 子进程驱动外部引擎的标准姿势。

### 1.2 目标

把 pi 作为 DeepThink 的 **第四 Agent 执行引擎** 接入主聊天对话流，使用户可以：

1. 在主对话页面顶部切换器选择 pi 引擎（与 Claude/AtomCode/Codex/OpenCode 并列）
2. 在 Web 设置界面**配置 pi**：启动命令、CLI 脚本路径、默认 provider/model、Provider 管理、连接测试
3. 在 pi 引擎下进行多轮编码对话，会话上下文跨 turn 持续

### 1.3 非目标（明确排除，首版不实现）

- ❌ pi 引擎调用 DeepThink 内置 MCP 工具的桥接（`send_message`/`schedule_task`/`memory_*`）。pi 核心运行时无 MCP client/server 实现（grep `@modelcontextprotocol/sdk` 在 pi src 无命中，仅 shrinkwrap 间接依赖），与 atomcode 引擎首版一致（PRD §3.1 A3）。后续可仿 codex/opencode 的 `mcp-bridge.js` 模式补桥接。
- ❌ 跨引擎会话历史连续性（与 atomcode/codex/opencode 一致：切换引擎即开新会话，UI 历史展示不丢失）
- ❌ 图片输入（pi RPC `prompt` 命令支持 images 字段，但首版 text-only，与 codex 首版一致）
- ❌ pi Extensions / Skills / Prompt Templates / Themes 的 Web 管理 UI（首版仅做 provider/model 配置）
- ❌ 替换 Claude SDK 作为默认引擎（pi 作为可选第四引擎，默认仍是 Claude）
- ❌ Docker 容器模式下的 pi 烤入（首版只支持宿主机模式 / host-binary bind-mount，与 atomcode 首版一致 A1）

## 2. 用户故事

### US-1：主对话切换到 pi 引擎

**作为** DeepThink 用户，
**我希望** 在主对话页面顶部引擎切换器选择 "pi"，
**以便** 在同一对话窗口内使用 pi 引擎的编码能力，对比不同引擎输出。

**验收标准**：
- 对话页引擎切换器出现 "pi" 选项，与 Claude/AtomCode/Codex/OpenCode 并列
- pi 全局未 enable 时该选项置灰 + tooltip "请在设置页启用 pi 引擎"
- 切换到 pi 后，后续发送的消息由 pi 引擎处理
- 切换不丢失对话历史展示（UI 上历史消息仍可见，来自 DB）
- 切换引擎后首条消息提示 "已切换至 pi 引擎，新会话开始"
- 切换器状态持久化到该会话（`registered_groups.engine='pi'`），刷新页面后保持

### US-2：pi 引擎配置

**作为** DeepThink 管理员，
**我希望** 在系统设置页配置 pi 启动命令、CLI 脚本路径、默认 provider/model、Provider（含 API Key），
**以便** 不离开 Web 界面即可完成 pi 的全部配置。

**验收标准**：
- 设置页新增 "pi 引擎" 独立区块（与 AtomCode/Codex/OpenCode 区块并列）
- 启用开关、启动命令（binaryPath，默认 `node`）、CLI 脚本路径（cliScriptPath）、工作目录可保存到 `data/config/pi.json`
- "测试连接" 按钮可一键 spawn `pi --mode rpc` + 发 `get_state` 命令 + 检测响应，返回 ok/error 与版本信息
- Provider 管理：列表展示、新增、编辑、删除、设为默认（provider/apiKey/baseURL/model）
- API Key 字段脱敏显示（`hasApiKey: true/false`，编辑时才暴露明文输入）
- 默认 provider/model 字段

### US-3：pi 引擎多轮对话

**作为** 用户，
**我希望** 在 pi 引擎下连续发送多条消息，pi 记住前文，
**以便** 进行真正的多轮编码协作。

**验收标准**：
- 第一条消息后，pi 返回流式回复（文本增量 + 工具调用可见）
- 第二条消息基于前文上下文回答（pi session 续接，非全新会话）
- 会话 ID 持久化到 `sessions.pi_session_id`，agent-runner 重启后自动续接

### US-4：引擎不可用时的降级

**作为** 用户，
**当** 切换到 pi 引擎但 pi 进程不可启动 / 不可达时，
**我希望** 收到明确的错误提示，
**以便** 知道发生了什么而不是看到卡死。

**验收标准**：
- 发送消息时若 pi 不可启动（binaryPath 不存在 / cliScriptPath 不存在 / spawn 失败 / RPC 就绪超时 30s），Agent 在 10 秒内返回明确错误流式消息："pi 引擎不可用：[原因]。请在设置页检查配置。"
- 不影响其他引擎正常使用

## 3. 关键假设与权衡

### 3.1 假设清单（Think Before Coding 原则）

| ID | 假设 | 原因 | 影响 |
|----|------|------|------|
| A1 | pi 以 **RPC 模式**（`pi --mode rpc`）接入，单次 spawn 长驻，多 turn 通过 stdin JSONL `prompt` 命令续聊 | pi README 与 `rpc-types.ts` 明确 RPC 模式「for process integration」，专为外部进程驱动设计；相比 codex 的 per-turn spawn（冷启动 2-3s/turn），RPC 长驻避免重复冷启动，且 pi 原生 session 续接；相比 opencode 的 HTTP+SSE serve，RPC 走 stdio JSONL 无需占用端口、无需 Basic Auth | pi-engine 是首个 stdio JSONL 长驻 adapter（codex 是 per-turn spawn JSONL，opencode 是长驻 HTTP+SSE），需手写 stdin/stdout 行级 JSONL 读写 |
| A2 | pi 通过 `node <cli.js> --mode rpc` 启动；`binaryPath` 默认 `node`，`cliScriptPath` 指向 `packages/coding-agent/dist/cli.js` | pi 是 Node 包（非 Rust 二进制），本机 `pi` 不在 PATH、dist 未构建；Node v24.15.0 满足 pi 的 `engines.node >=22.19.0`。双字段（binaryPath + cliScriptPath）兼容「构建后 pi bin」与「node + 脚本」两种姿势 | 配置比 atomcode/codex/opencode 的单 binaryPath 多一字段；测试前需 `npm run build` 构建 pi dist |
| A3 | pi 引擎不调用 DeepThink 内置 MCP（与 atomcode 首版一致） | pi 核心运行时无 MCP client/server；首版不做 MCP↔pi-RPC adapter | pi 引擎下，定时任务/记忆系统/主动推送功能不可用；定时任务调度本身仍由主进程执行，但 Agent 输出无法主动 `send_message` |
| A4 | 每个 agent-runner 进程在用 pi 时启动自己的 `pi --mode rpc` 子进程（独立 `PI_CODING_AGENT_DIR`） | 简化生命周期管理，避免共享进程的并发会话冲突；与 atomcode/codex/opencode 的「每进程独占」一致 | 多个 pi 会话并发时会有多个 pi 子进程，各自独立 session 目录 |
| A5 | pi session ID 独立存储（`sessions` 表新增 `pi_session_id` 列） | pi session ID 格式与 Claude/atomcode/codex/opencode 不同，不能复用同一字段；与现有四引擎一致 | sessions 表 schema 变更，向后兼容（默认 NULL） |
| A6 | Provider 配置由 DeepThink 内 JSON 存储，运行时通过环境变量 + CLI flag 注入 pi（不写 pi 的 `~/.pi/agent/settings.json`） | pi-ai 按 provider 名读对应环境变量（`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`DEEPSEEK_API_KEY`/...）；pi CLI 支持 `--provider`/`--model`/`--api-key` 运行时注入。env 注入比写 settings.json 文件更简洁、无文件竞争 | 设置页的 pi Provider 区独立；provider→envvar 映射表内置常见 provider，未覆盖的 provider 回退到 `--api-key` CLI flag |
| A7 | pi 的 `extension_ui_request`（select/confirm/input/editor）一律回 `cancelled: true` | 外部驱动不实现 TUI 交互；回 cancelled 默认值不阻塞扩展 | 若用户安装了需要 UI 交互的 pi extension，相关交互会被跳过；notify/setStatus 等非阻塞请求忽略 |
| A8 | 一批 prompt 工作完成的权威信号是 `agent_settled` 事件（非 `agent_end`） | `rpc-mode.ts` 注释与 `agent-session.ts` 事件定义明确：`agent_end` 后可能 retry/compaction，`agent_settled` 才是空闲态 | adapter 在 `agent_settled` 后才发 `writeOutput({status:'success'})`，避免提前结束导致后续事件丢失 |

### 3.2 权衡

**为什么选 RPC 模式而非 print/json per-turn spawn？**
pi 的 `--mode rpc` 是专为进程集成设计的长驻协议，单次 spawn 后多 turn 仅通过 stdin 发 `prompt` 命令，避免 codex 那样的 2-3s/turn 冷启动开销。pi session 续接在 RPC 模式下是原生能力（`switch_session`/`--session-id`）。print/json 模式更适合 CLI 一次性使用，不适合 DeepThink 的多轮对话 + IPC follow-up 场景。

**为什么不接入 pi-server（Unix socket daemon）？**
pi-server 仍是实验性包，它内部也是 spawn `pi --mode rpc` 子进程 + Unix socket 路由，多一层抽象无收益且增加 socket 文件管理复杂度。直接驱动 `pi --mode rpc` 最直接。

**为什么 provider 用 env 注入而非写 settings.json？**
codex 写 `config.toml`、opencode 写 `opencode.jsonc` 是因为它们的 provider 配置文件格式是这些引擎的硬契约。pi 同时支持 settings.json 与 env/CLI flag 两条路径；env 注入无文件竞争、无路径管理，更简单（Simplicity First）。仅当 provider 不在 envvar 映射表时回退 CLI `--api-key`。

## 4. 功能需求

### 4.1 后端

#### F-B-1：数据库 Schema 变更

- `registered_groups.engine` 列已存在（`TEXT DEFAULT 'claude'`），仅需在类型联合与校验中加入 `'pi'`
- `sessions` 新增列 `pi_session_id TEXT`（默认 NULL）
- Schema 版本号 +1（按现有 ensureColumn 模式，无破坏性迁移）

#### F-B-2：pi 配置存储

- 文件：`data/config/pi.json`（复用 `writeSecretFile` 模式，0600 权限）
- 字段：
  ```json
  {
    "enabled": false,
    "binaryPath": "node",
    "cliScriptPath": "",
    "workingDir": "/workspace/group",
    "defaultProvider": "anthropic",
    "defaultModel": "claude-sonnet-4-6",
    "thinkingLevel": "off",
    "providers": [
      { "provider": "anthropic", "apiKey": "sk-ant-...", "baseURL": "", "model": "claude-sonnet-4-6" }
    ]
  }
  ```
- `enabled=false` 时，前端切换器置灰，后端拒绝 `engine=pi` 的请求

#### F-B-3：pi 进程生命周期（agent-runner 侧）

- `container/agent-runner/src/pi-engine.ts`：
  - `runPiEngine(opts: RunOpts)` 主入口
  - 读 `PI_BINARY_PATH` / `PI_CLI_SCRIPT_PATH` / `PI_DEFAULT_PROVIDER` / `PI_DEFAULT_MODEL` / `PI_THINKING_LEVEL` / `PI_PROVIDERS_JSON` 等环境变量
  - 选 `PI_CODING_AGENT_DIR`（独立 session 目录，隔离多实例）
  - spawn `binaryPath [cliScriptPath] --mode rpc [--provider P] [--model M] [--thinking T]`，cwd=workingDir，stdio=['pipe','pipe','pipe']
  - 注入 API key 环境变量（按 provider→envvar 映射）
  - 进入 RPC 循环：写 `prompt` 命令到 stdin → 读 stdout JSONL → 翻译 `AgentSessionEvent` 为 StreamEvent → emit；遇 `agent_settled` 触发 `writeOutput({status:'success'})` + 捕获 `pi_session_id`
  - IPC follow-up：监听 `/workspace/ipc/input/` 目录，有新消息时发 `prompt` 命令续聊
  - `_close` sentinel → SIGTERM pi 子进程 → exit
  - `extension_ui_request` → 回 `extension_ui_response { cancelled: true }`
  - 就绪检测：spawn 后发 `get_state` 命令，30s 内收到 `response success` 视为就绪

#### F-B-4：Agent-Runner 引擎分支

- `container/agent-runner/src/index.ts` 的 `main()`：在 opencode 分支后加入：
  ```ts
  if (engine === 'pi') {
    log('Engine = pi, routing to pi-engine adapter');
    const { runPiEngine } = await import('./pi-engine.js');
    try { await runPiEngine({ containerInput, writeOutput, log }); }
    catch (err) { writeOutput({ status:'error', result:null, error:`Pi engine error: ${...}`, turnId }); }
    process.exit(0);
  }
  ```

#### F-B-5：API 路由

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/config/pi` | `manage_system_config` | 获取 pi 配置（脱敏） |
| PUT | `/api/config/pi` | `manage_system_config` | 保存 pi 配置 |
| POST | `/api/config/pi/test` | `manage_system_config` | 测试 pi 可启动性（spawn + get_state） |
| PUT | `/api/groups/:jid` | `manage_group_env` 或群 owner | 切换群的 engine（已有路由，扩展 enum） |

> **注**：pi 的 provider 管理**不**像 atomcode 那样透传 daemon REST（pi 无 daemon REST），而是 DeepThink 内 JSON 存储后运行时注入。因此 provider 增删改即 PUT `/api/config/pi` 的 `providers` 字段，无需独立 provider 子路由（与 codex/opencode 一致）。

#### F-B-6：Container-Runner 分发

- `runContainerAgent` / `runHostAgent`：读取 `group.engine`（默认 `'claude'`），写入 `ContainerInput.engine`
- 若 `engine === 'pi'`：读取 pi 配置，通过环境变量 `PI_BINARY_PATH` / `PI_CLI_SCRIPT_PATH` / `PI_DEFAULT_PROVIDER` / `PI_DEFAULT_MODEL` / `PI_THINKING_LEVEL` / `PI_PROVIDERS_JSON` / `PI_CODING_AGENT_DIR` / `DT_*` 注入容器
- sessions 表查询时，按 engine 选 `pi_session_id` 列

### 4.2 前端

#### F-F-1：ChatPage 引擎切换器

- 位置：消息输入框上方引擎切换器（已有组件 `EngineSwitcher.tsx`）
- 选项新增 `pi`，与 Claude/AtomCode/Codex/OpenCode 并列
- 状态：绑定到 `useGroupsStore.currentGroupEngine`
- 切换时：调用 `PUT /api/groups/:jid`（engine=pi），成功后更新本地状态
- 禁用：pi 全局未 enable 时置灰 + tooltip

#### F-F-2：SettingsPage pi 区块

- 位置：设置页新增独立 Section "pi 引擎"（与 AtomCode/Codex/OpenCode Section 并列）
- 字段：
  - 启用开关（`enabled`）
  - 启动命令（`binaryPath`，默认 `node`）
  - CLI 脚本路径（`cliScriptPath`，文件选择器 + 手动输入）
  - 工作目录（`workingDir`，默认 `/workspace/group`）
  - 默认 provider（`defaultProvider`，如 anthropic/openai/deepseek）
  - 默认 model（`defaultModel`）
  - thinking level（`thinkingLevel`，off/minimal/low/medium/high/xhigh/max）
- 操作按钮：
  - 保存
  - 测试连接（调用 `/test`，展示 ok/error + 版本）
- 子区块：Provider 管理（列表 + 新增表单 + 编辑/删除）
  - 新增表单字段：provider、apiKey、baseURL（可选）、model

#### F-F-3：API 客户端 & Store

- `web/src/api.ts`：新增 `piApi`（getConfig/saveConfig/test）
- `web/src/stores/chat.ts`：`switchEngine` 签名联合加 `| 'pi'`
- `web/src/types.ts`：`GroupInfo.engine` 类型加 `'pi'`

#### F-F-4：EnginesPage 总览卡片

- `web/src/pages/EnginesPage.tsx` 的 `ENGINES` 数组新增 pi 卡片（按 `/api/config/pi` 的 `enabled` 判定）

### 4.3 文档

- `docs/prd/pi-engine/PRD.md`（本文档）
- `docs/tech_solution/pi-engine/SOLUTION.md`
- `docs/task_state/pi-engine/task_state.json`（执行状态结构化数据）
- `docs/test_report/pi-engine/TEST_REPORT.md`

## 5. 非功能需求

- **性能**：pi 子进程 spawn 到 RPC 就绪 ≤ 8s（Node 启动 + 模块加载）；首条消息端到端延迟 ≤ 5s
- **隔离**：每个 agent-runner 进程的 pi 子进程独立 `PI_CODING_AGENT_DIR`，互不影响
- **安全**：API Key 通过 `writeSecretFile`（0600）存储；UI 脱敏显示；Provider 操作仅 admin 可见；运行时 env 注入不写入日志
- **兼容**：Claude/AtomCode/Codex/OpenCode 引擎行为 100% 不变；不引入触发词、不改变现有消息路由
- **可观测**：pi 子进程 stderr 写入 `data/groups/{folder}/logs/pi-engine.log`
- **回滚**：`engine` 列默认 `'claude'`，升级后所有现有群保持原行为；DB 迁移可逆（列保留不删）；`pi.json` 不存在时 `getPiConfig()` 返回 `enabled: false`

## 6. 验收标准（端到端）

1. ✅ `make typecheck` 通过（三端：后端 + 前端 + agent-runner）
2. ✅ `make build` 通过
3. ✅ 设置页能配置 pi binaryPath/cliScriptPath、测试连接、增删 Provider
4. ✅ 宿主机模式：在 admin 主容器（folder=main）切换到 pi 引擎，发送 "你好"，收到 pi 的流式回复
5. ✅ pi 引擎多轮对话：第二条消息基于前文上下文回答（session 续接）
6. ✅ 切换回 Claude 引擎，同一群发消息，Claude SDK 正常工作（不受影响）
7. ✅ pi 不可达时（binaryPath 故意配错），用户收到明确错误提示而非卡死
8. ✅ 切换器与设置页 pi 选项在 pi 全局未 enable 时置灰

## 7. 测试用例

### 7.1 单元/类型测试

| ID | 用例 | 预期 |
|----|------|------|
| TC-U1 | `make typecheck` 三端 | 0 error |
| TC-U2 | `make build` | 0 error，产物含 `container/agent-runner/dist/pi-engine.js` |

### 7.2 配置与连接测试

| ID | 用例 | 步骤 | 预期 |
|----|------|------|------|
| TC-C1 | 保存 pi 配置 | 设置页填 binaryPath=node、cliScriptPath、provider，点保存 | `data/config/pi.json` 写入，GET 返回脱敏配置（apiKey=****XXXX） |
| TC-C2 | 测试连接 | 点"测试连接" | spawn pi --mode rpc + get_state，返回 ok=true + 版本信息 |
| TC-C3 | 测试连接失败 | binaryPath 故意配错为 `/no/such/node`，点测试 | 返回 ok=false + 明确错误（spawn 失败） |

### 7.3 UI 自动化测试（浏览器，admin/88888888）

| ID | 用例 | 步骤 | 预期 |
|----|------|------|------|
| TC-E1 | 设置页 pi 区块可见 | 登录 → 设置页 | 出现 "pi 引擎" Section |
| TC-E2 | 引擎切换器含 pi | 主对话页 | 切换器含 pi 选项 |
| TC-E3 | 未 enable 时置灰 | pi 未 enable 状态下 | pi 选项置灰 + tooltip |
| TC-E4 | enable 后可切换 | enable + 保存 → 切换器点 pi | 切换成功，提示"已切换至 pi 引擎" |
| TC-E5 | pi 对话流式回复 | 切换 pi → 发"你好" | 收到流式文本回复 |
| TC-E6 | pi 多轮上下文 | 发"我叫张三" → 发"我叫什么" | 第二轮回答"张三"（session 续接） |
| TC-E7 | 切回 Claude 不受影响 | 切回 Claude → 发消息 | Claude 正常回复 |
| TC-E8 | 错误降级 | binaryPath 配错 → 发消息 | 10s 内收到明确错误提示 |

## 8. 风险

| 风险 | 缓解 |
|------|------|
| pi RPC JSONL 协议变化 | 锁定 pi 仓库版本 0.82.0；在 pi-engine.ts 加协议健壮性（未知事件类型忽略不崩） |
| pi session 续接语义与预期不符 | 实现时先验证 `--session-id` / `switch_session` 行为，fallback 到 `new_session` + 持久化 |
| pi 子进程 stdout 背压导致管道阻塞 | adapter 持续读取 stdout（readline），不阻塞写入 |
| provider→envvar 映射不全 | 内置常见 provider（anthropic/openai/deepseek/gemini/qwen/zai/moonshot/xai/groq），未覆盖回退 `--api-key` CLI flag |
| Node 版本不满足 | 检测 `node --version`，<22.19 时设置页测试连接返回明确错误 |
| pi 未构建（dist 不存在） | 测试前 `cd ~/pi && npm run build`；cliScriptPath 校验文件存在 |

## 9. 里程碑

| 阶段 | 交付物 |
|------|--------|
| Phase 1：设计 | PRD + 技术方案 |
| Phase 2：后端 | DB 迁移 + runtime-config + routes + container-runner 分发 |
| Phase 3：Agent-Runner | pi-engine.ts + index.ts 分支 |
| Phase 4：前端 | ChatPage 切换器 + SettingsPage pi 区块 + EnginesPage 卡片 |
| Phase 5：构建 pi | `cd ~/pi && npm run build` 产出 dist/cli.js |
| Phase 6：测试 | typecheck + build + E2E 走查（admin/88888888）+ 测试报告 |
| Phase 7：合并 | 提交 + 合并 main + push |
