# PRD：DeepThink 开放平台 — Agent Service（LLM MaaS + Agent as a Service）

> 状态：已评审，进入实施
> 分支：`feature/open-platform`（worktree：`.worktrees/open-platform`）
> 作者：DeepThink
> 日期：2026-08-28
> 参考实现：Prime AI Harness 开放平台能力（`feature/agent-service` → `feature/open-platform-p1` → `feature/open-platform-debug`）

---

## 0. 背景与动机

DeepThink 目前是一个「自用」的企业级 Agent 工作台：用户在 Agent Studio 创建 Agent，通过 IM 群 / Web 测试对话驱动，能力封闭在平台内部。企业客户的核心诉求是——**把在 DeepThink 里调教好的 Agent 变成可以被外部业务系统调用的服务（Agent Service）**，让 CRM / OA / 电商 / 医疗系统等第三方应用像调用一个 HTTP 接口一样调用 Agent，同时把底层大模型能力以标准 LLM API 形式开放（Model as a Service，MaaS）。

当前缺少的能力：

1. **无外部访问凭证体系**：只有会话 Cookie 鉴权（`deepthink_session`，HMAC 签名），面向浏览器，外部系统无法用「API Key」长期、安全地调用。
2. **无开发者/租户入驻机制**：没有「应用（Application）」「开发者（Developer）」的概念，无法把某个用户/工作区的 Agent 能力授权给外部应用。
3. **无标准 LLM API**：底层 provider 是 Anthropic Messages 协议，外部系统期望的是 OpenAI 风格的 `/v1/chat/completions`。
4. **无 Agent 同步/流式调用接口**：现有 Agent 运行依赖 IM 群队列（`/api/messages` → `group-queue` → `container-runner`），是异步、IM 驱动的，外部系统无法同步等待、也无法拿流式 SSE。
5. **无控制台内调试能力**：开发者必须离开页面、借助外部工具（curl/脚本）才能验证自己的 API，接入示例过于简陋（仅 curl）。

本需求建设 **DeepThink 开放平台（Agent Service）**：开发者入驻 → 创建应用拿 API Key → 用标准 HTTP SDK（OpenAI 风格 LLM MaaS + Agent as a Service）调用平台内主 Agent / Agent Studio Agent，并在控制台内完成在线调试与代码接入示例。

## 1. 目标

1. **开放平台基础能力**：租户（复用现有 `users` 工作区）→ 开发者入驻（创建「应用」）→ API Key（创建/列表/吊销，SHA-256 哈希存储，只展示一次明文）。
2. **LLM MaaS**：OpenAI 风格 `/v1/models`、`/v1/chat/completions`，Bearer API Key 鉴权，代理到该租户配置的 LLM provider，支持流式（SSE）与非流式。
3. **Agent as a Service**：`/v1/agents/{agentId}/chat/completions`，加载 Agent 的 system prompt / model / maxTurns / temperature / MCP 挂载 / workers，同步（或流式）执行并返回 Agent 文本结果。
4. **独立计费闭环**：MaaS 与 AaaS 调用接入现有 billing 体系——调用前余额/配额校验（不足 402 拦截），调用后计量 token 与成本并扣费。
5. **在线调试 + 代码示例**：`/open-platform` 页面提供 LLM / Agent 两个可视化 Playground，以及 MaaS/AaaS × curl/Python/Node.js 六段可复制接入示例。

## 2. 范围（Scope）

### 2.1 纳入范围（P0）

- 数据模型：`api_keys` 表（应用/密钥）+ `model_pricing` 表（模型定价）。
- API Key 管理 REST：`/api/open-platform/keys`（登录态，走 `authMiddleware`）创建/列表/吊销。
- API Key 鉴权中间件：`Authorization: Bearer sk-...`，SHA-256 哈希比对，解析出 `user_id` 与 scopes。
- LLM MaaS：`POST /v1/chat/completions`（OpenAI 风格，含 stream）、`GET /v1/models`。
- Agent as a Service：`POST /v1/agents/:agentId/chat/completions`（同步 + 流式 SSE）。
- 协议适配层：OpenAI Chat Completions ⇄ Anthropic Messages 双向转换（含 usage、错误映射、SSE 分片）。
- 独立计费闭环：`model_pricing` 定价 + MaaS/AaaS 前置校验 + 后置计量扣费（`usage_records.source='open-platform'`）。
- 前端开放平台管理页：`OpenPlatformPage`（`/open-platform`），API Key 管理 + 用量概览 + 在线调试 + 代码示例。
- 测试用例 + 测试报告 + issue 沉淀。

### 2.2 不纳入范围（Non-goals）

- 开放平台独立的支付/充值入口：复用现有账单页余额充值。
- 按 API Key 维度的独立配额：计费对象是 Key 所属用户，不细分到单把 Key。
- OpenAI 完整协议（function calling / tools / logprobs）：只保证 `messages` / `stream` / `temperature` / `max_tokens` / `model` 核心字段。
- 多租户跨用户授权：API Key 仅能调用所属用户自己的 Agent。
- KB / Skill 挂载传播到外部 Agent 调用：本轮传播 system prompt / model / maxTurns / temperature / MCP 挂载 / workers。
- 调试历史持久化、请求并发限制、耗时统计看板。

## 3. 功能点与验收标准

### F1：开发者入驻与 API Key 管理

- 用户登录平台后，可创建「应用」并获得一把 `sk-...` API Key（只在创建时完整展示一次）。
- 用户可列出自己的 API Key（脱敏）、可吊销某把 Key；管理员可查看全部 Key。

**验收标准**：
- `POST /api/open-platform/keys` 创建返回完整 key；再次 `GET` 列表只返回 `key_prefix + 掩码`。
- `DELETE /api/open-platform/keys/:id` 后，用该 key 调用 `/v1/*` 返回 401。
- 未登录调用管理接口返回 401。

### F2：LLM MaaS（OpenAI 风格 chat completions）

- 外部系统带 API Key 调用 `POST /v1/chat/completions`，body 为 OpenAI 风格。
- 非流式返回 `{id, object:"chat.completion", choices:[{message:{role,content}, finish_reason}], usage}`。
- 流式（`stream:true`）返回 SSE，`data: {...delta...}` 分片，末尾 `data: [DONE]`。
- `GET /v1/models` 返回该租户可用模型列表。

**验收标准**：
- 非流式返回内容与底层 provider 一致，`role=assistant`，`finish_reason` 正确。
- 流式能收到多条 delta 且以 `[DONE]` 结束。
- 错误 provider 配置 / 模型名返回结构化 4xx/5xx（映射 OpenAI 错误格式）。

### F3：Agent as a Service

- 外部系统带 API Key 调用 `POST /v1/agents/{agentId}/chat/completions`，`messages` 的最后一条 user 作为 Agent 输入。
- 服务端加载该 Agent 的 system_prompt / model / maxTurns / temperature，注入 MCP 挂载与 workers，用 Claude Agent SDK `query()` 同步执行，返回 Agent 文本。
- 流式（`stream:true`）时以 SSE 返回 Agent 增量文本。

**验收标准**：
- 调用一个已存在的 Agent，返回内容符合其 system_prompt 设定的人格（**不含平台默认身份**）。
- 调用不存在的 Agent 返回 404；调用他人 Agent（API Key 属主 != Agent 属主）返回 403。
- disabled 的 Agent 返回 400。

### F4：独立计费闭环（MaaS + AaaS）

- 调用前校验属主余额/配额（不足 402 + 结构化错误），调用后按模型定价计量成本并扣费。
- MaaS 成本按 `model_pricing` 计算；AaaS 成本取自 SDK `result.total_cost_usd`。
- admin 与 billing 关闭时豁免。

**验收标准**：
- 非 admin 用户余额不足时调 MaaS/AaaS 返回 402，且不产生 provider 调用。
- 调用成功后 `usage_records` 出现 source=`open-platform` 的记录，`cost_usd` 与 `model_pricing` 一致，余额递减。
- admin 调用不计费（无 open-platform 记录、余额不变）。
- 未配置定价的模型：token 仍计量，`cost_usd=0`，余额不变。

### F5：在线调试 + 代码接入示例

- `/open-platform` 页面新增 LLM / Agent 两个 Playground，复用与对外 `/v1/*` 完全相同的底层执行与计费逻辑。
- 接入示例扩充为 MaaS/AaaS × curl/Python/Node.js 六段，含流式 SSE 与鉴权，一键复制。

**验收标准**：
- 页面加载后模型输入框回填 provider 默认模型名；Agent 下拉列出当前用户可见的 enabled Agent。
- 填消息发送，非流式返回文本 + usage；开 stream 逐字增量输出，结束后停止。
- 空消息 / 未选 Agent 时前端提示校验错误，不发请求。
- 六段示例代码均可切换展示，含鉴权头 + 端点 + 流式写法，「复制」可复制到剪贴板。

## 4. 非功能需求（NFR）

- **安全**：API Key 仅以 SHA-256 哈希入库，日志/响应永不回显明文；鉴权失败统一 401 且不泄露细节；成本与用量记录不回显到 `/v1/*` 响应。
- **幂等**：同一次调用扣费一次（复用 `deductUsageCost` 的 `usage_{msgId}` 语义）。
- **可观测**：每次调用记录 last_used_at；扣费/计量失败只记 warn 日志，不阻断流式响应。
- **兼容**：不动现有 `authMiddleware` / 会话 Cookie 体系与 IM 消息链路计费；`usage_records.source` 用新值 `open-platform` 区分。

## 5. 测试用例

| 编号 | 用例 | 步骤 | 预期 |
|---|---|---|---|
| T1 | 创建 API Key | `POST /api/open-platform/keys {"name":"my-app"}`（带会话 Cookie） | 201，返回 `key`（`sk-...` 完整）、`key_prefix`、`id` |
| T2 | 列表脱敏 | `GET /api/open-platform/keys` | 每项只含 `key_prefix` 与 `masked_key`，无明文 |
| T3 | 吊销 Key | `DELETE /api/open-platform/keys/:id` | 200；随后用该 key 调 `/v1/models` 返回 401 |
| T4 | 未登录访问管理接口 | 不带 Cookie `GET /api/open-platform/keys` | 401 |
| T5 | MaaS 非流式 | 带 key `POST /v1/chat/completions` | 200，`choices[0].message.role=assistant` 且 content 非空 |
| T6 | MaaS 流式 | 同 body 加 `stream:true` | `Content-Type: text/event-stream`，多条 `data:`，末条 `data: [DONE]` |
| T7 | 无 key / 错 key | 无/错 Bearer 调 `/v1/chat/completions` | 401 |
| T8 | 模型列表 | `GET /v1/models`（带 key） | 200，`data` 数组含当前 provider 默认模型 |
| T9 | Agent 同步调用 | 建 agent（system_prompt=「你是客服小明」），调 `/v1/agents/{id}/chat/completions` | 200，回复符合人设 |
| T10 | Agent 不存在 | 调随机 agentId | 404 |
| T11 | Agent 越权 | 用 userA 的 key 调 userB 的 agent | 403 |
| T12 | Agent disabled | 禁用后调用 | 400 |
| T13 | MaaS 计费前置拦截 | 非 admin 用户余额清零后调 `/v1/chat/completions` | 402，`usage_records` 无新增 |
| T14 | MaaS 计费计量扣费 | 余额充足的非 admin 用户调 MaaS | 成功；`usage_records` 出现 source=`open-platform`，`cost_usd>0`；余额递减 |
| T15 | AaaS 计费 | 余额充足的非 admin 用户调 `/v1/agents/:id/chat/completions` | 成功；扣费金额 ≈ SDK `total_cost_usd`；记录 source=`open-platform` |
| T16 | admin 豁免 | admin Key 调 MaaS/AaaS | 正常返回，无 open-platform 记录或 cost=0，余额不变 |
| T17 | debug meta | `GET /api/open-platform/debug/meta`（登录态） | 200，返回 `defaultModel` |
| T18 | LLM 非流式调试 | `POST /api/open-platform/debug/chat`（关 stream） | 200，返回助手文本 + usage |
| T19 | Agent 流式调试 | `POST /api/open-platform/debug/agent`（开 stream） | SSE 逐字增量 |
| T20 | 用量统计接口 | `GET /api/open-platform/usage?days=7` | 返回开放平台专属用量（含请求数/token/成本） |

## 6. 里程碑

- M1：数据模型 + API Key 管理 REST + 鉴权中间件（F1）。
- M2：LLM MaaS 协议适配 + `/v1/chat/completions` + `/v1/models`（F2）。
- M3：Agent as a Service 调用链（F3）。
- M4：独立计费闭环（F4）。
- M5：前端管理页 + 在线调试 + 代码示例（F5）。
- M6：测试用例全绿 + 测试报告 + 合并 main。

## 7. 风险与依赖

- **provider 协议差异**：Anthropic Messages 无 `role=system` 顶层字段（用 `system` 字段），OpenAI 的 `messages` 中 `system` 角色需抽取。
- **Agent 身份泄漏**：SDK `query()` 会加载用户级 `CLAUDE.md`（含平台默认身份）作为 memory，且生效顺序在 system prompt 之后，会覆盖自定义人设。必须用对象形式 `systemPrompt` + `<agent-definition>` + `<agent-identity-override>` 显式压回人设（与 `container-runner` 同构）。
- **SDK 同步调用超时**：外部 API 需设硬超时（同步 120s / 流式 300s）避免悬挂。
- **流式计费时机**：SSE 边生成边发，成本要等流结束才知；计费放在收尾异步完成，进程在流结束后崩溃会漏计一次（与 IM 链路同等级风险，可接受）。
- **MaaS 定价需运维维护**：`model_pricing` 需 admin 按实际采购价配置；未配置时只计量不扣费。
