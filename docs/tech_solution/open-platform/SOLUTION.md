# 技术方案：DeepThink 开放平台（Agent Service）

> 分支：`feature/open-platform`
> 参考：Prime AI Harness 开放平台实现（协议适配层、鉴权、计费闭环均可复用，Agent worker 模型需适配 DeepThink 既有数据模型）

---

## 1. 总体架构

```
外部业务系统 (CRM/OA/电商/医疗)
        │  Authorization: Bearer sk-xxx
        ▼
┌─────────────────────────────────────────────┐
│ Hono 子应用 /v1（不挂 authMiddleware，不走 Cookie）│
│  ├─ GET  /v1/models                          │
│  ├─ POST /v1/chat/completions     → maas.ts  │
│  └─ POST /v1/agents/:id/chat/completions     │
│                              → agent-service.ts│
└──────────────┬──────────────────────────────┘
               │  verifyApiKey (SHA-256 比对)
               │  checkOpenPlatformBilling (前置 402)
               ▼
┌─────────────────────────────────────────────┐
│ open-platform 核心模块                         │
│  ├─ api-keys.ts     密钥生成/哈希/校验         │
│  ├─ maas.ts         OpenAI ⇄ Anthropic 适配   │
│  ├─ agent-service.ts Agent 执行（SDK query）   │
│  └─ billing.ts      计量 + 扣费闭环           │
└──────────────┬──────────────────────────────┘
               ▼
   runtime-config(getClaudeProviderConfig) / db / billing / mcp-utils

控制台侧（登录态，走 authMiddleware，复用同一底层执行函数）：
  /api/open-platform/keys   — API Key 管理
  /api/open-platform/usage  — 用量聚合
  /api/open-platform/pricing— 模型定价（admin）
  /api/open-platform/debug/* — 在线调试（复用 maas / agent-service）
```

设计要点：**对外 `/v1/*` 与内部调试 `/api/open-platform/debug/*` 复用同一套底层执行与计费函数**，仅鉴权从 Bearer sk- 换成会话 Cookie，保证「控制台里调到的」与「外部 SDK 调到的」完全一致。

## 2. 数据模型（`db.ts`）

### 2.1 `api_keys` 表

```sql
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,       -- sha256(rawKey)，永不存明文
  key_prefix TEXT NOT NULL,     -- 展示前缀（sk- + 前 8 可见字符）
  scopes TEXT NOT NULL DEFAULT '["maas","agent"]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
```

安全模型：明文 key 格式 `sk-` + base64url(32 随机字节)，仅在创建时返回一次；落库只存 sha256 哈希与展示前缀；校验用 `key_hash` 索引等值查询（无字符串比较时序侧信道）。

### 2.2 `model_pricing` 表

```sql
CREATE TABLE IF NOT EXISTS model_pricing (
  model_id TEXT PRIMARY KEY,
  input_price_per_mtok REAL NOT NULL DEFAULT 0,   -- 美元 / 每百万 input token
  output_price_per_mtok REAL NOT NULL DEFAULT 0,  -- 美元 / 每百万 output token
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 2.3 新增数据访问函数

- `createApiKey` / `getApiKeyByHash` / `getApiKeyById` / `listApiKeys` / `getApiKey` / `deleteApiKey` / `touchApiKeyLastUsed`
- `getModelPricing` / `listModelPricing` / `upsertModelPricing` / `deleteModelPricing`
- `getOpenPlatformUsage(days, userId?)` — 按 `source='open-platform'` 聚合请求数/输入/输出 token/成本（按天 + 汇总）
- `getAgentDefinitionById(id)` — 新增单参查询（供 Agent Service 用；现有 `getAgentDefinition(id, userId)` 需 user_id，不适用于「先查 Agent 再判断属主」的场景）

表在 `initDb()` 的大 CREATE TABLE 块内以 `CREATE TABLE IF NOT EXISTS` 声明，老库启动时自动补建，无需数据迁移，也无需递增 `SCHEMA_VERSION`（与参考实现一致，`SCHEMA_VERSION` 保持 `'56'`）。

## 3. 协议适配层（`maas.ts`）

### 3.1 provider 解析 `resolveProvider()`

复用 `getClaudeProviderConfig()` 直连该租户已配置的 provider。鉴权头对齐 `buildClaudeEnvLines` 语义：

- `apiKey` → `x-api-key`
- `Bearer token` → `authorization: Bearer ...`
- 无 Bearer 的第三方 token → `x-api-key`

端点拼到 `/v1/messages`（`baseUrl` 可能已含 `/v1`）。

### 3.2 OpenAI → Anthropic 请求转换

- `system` 角色消息抽取为顶层 `system` 字段（Anthropic 无 `role=system`）。
- 仅转发 `user` / `assistant` 消息。
- 透传 `temperature` / `max_tokens` / `top_p` / `model`。

### 3.3 Anthropic → OpenAI 响应转换

- 非流式：`content[]` 中 `text` 块拼接 → `choices[0].message.content`；`usage` → `prompt_tokens` / `completion_tokens` / `total_tokens`。
- `stop_reason` → `finish_reason`：`end_turn`/`stop_sequence`→`stop`，`max_tokens`→`length`，`tool_use`→`tool_calls`。
- 流式：解析 Anthropic SSE 的 `message_start`（发 role + input_tokens）、`content_block_delta`（发 text delta）、`message_delta`（finish_reason + output_tokens）、`message_stop`（终块 + onUsage 计费回调）、`error`。

## 4. Agent as a Service（`agent-service.ts`）

### 4.1 权限与解析 `resolveAgent(agentId, userId)`

1. `getAgentDefinitionById(agentId)` 不存在 → 404。
2. `def.user_id !== userId && !isAdmin` → 403。
3. `def.enabled !== 1` → 400。
4. model = `def.model || provider.anthropicModel`。

### 4.2 MCP 挂载 `resolveAgentMcpServers`

`listAgentMounts(agentDefId).filter(resource_type==='mcp_server')` → `loadUserMcpServers(userId)` 取出配置 → 组装 SDK `mcpServers`（type/command/args/env/url）。

### 4.3 workers 适配（与 Prime 的差异点）

Prime 用非规范化 `agent_workers` 表（`AgentWorkerJoin` 含 `worker_name`/`worker_system_prompt` 等冗余列）；**DeepThink 用规范化 `agent_worker_links` 表（`orchestrator_id`/`worker_id` 双 FK 指向 `agent_definitions`），`listAgentWorkers(orchestratorId)` 返回 `AgentDefinitionRow[]`（JOIN 得到完整 worker 定义）**。

因此 `buildWorkerAgents` 直接映射 `AgentDefinitionRow` 字段：

| SDK 子 Agent 字段 | DeepThink 来源 |
|---|---|
| name（key） | `sanitizeAgentName(def.name)` |
| description | `def.name` + `def.description` |
| prompt | `def.system_prompt`（空则回退默认） |
| model | `def.model` |
| maxTurns | `def.max_turns` |
| enabled 过滤 | `def.enabled === 1` |

### 4.4 身份注入（关键，防人设泄漏）

SDK `query()` 会加载用户级 `CLAUDE.md`（含「你是 DeepThink」平台默认身份）作为 memory，生效顺序在裸 `systemPrompt` 之后，会覆盖自定义人设。因此**不用裸字符串 `systemPrompt`**，而是对象形式 + 显式身份覆盖指令（与 `container-runner.ts` 同构）：

```ts
systemPrompt: {
  type: 'preset',
  preset: 'claude_code',
  append: `<agent-definition>\n${system_prompt}\n</agent-definition>\n<agent-identity-override>...</agent-identity-override>`,
}
```

### 4.5 执行

- `buildQueryOptions`：合并 env（`buildClaudeEnvLines`）、`model`、`maxTurns`、`temperature`、`permissionMode:'bypassPermissions'`、`includePartialMessages:true`、`abortController`（同步 120s / 流式 300s 硬超时）。
- `runAgent`：遍历 `query()` 事件，取 `result`（`subtype==='success'`）的 `result` 文本。
- `streamAgent`：仅流主 Agent 文本（`stream_event` + `parent_tool_use_id == null` 的 `content_block_delta`/`text_delta`），忽略子 Agent/工具内部增量。
- 计费：`result` 事件携带 `usage` / `total_cost_usd` / `duration_ms` / `num_turns` → `billAgentResult`。

## 5. 计费闭环（`billing.ts`）

复用现有 `billing.ts`：

- **前置** `checkOpenPlatformBilling(userId)`：admin 豁免；否则 `checkBillingAccess`，不足返回 402。
- **后置** `billOpenPlatformUsage(userId, usage)`：admin 豁免；否则 `insertUsageRecord(source='open-platform', groupFolder='open-platform')` + `updateUsage` + `deductUsageCost`。
- **MaaS 成本** `computeMaaSCostUSD(model, in, out)`：查 `model_pricing`，未配置返回 0（token 仍计量）。
- **AaaS 成本**：直接取 SDK `result.total_cost_usd`。
- 计量/扣费失败只记 warn 日志，不阻断流式响应。

## 6. 路由

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/v1/models` | Bearer | 租户可用模型 |
| POST | `/v1/chat/completions` | Bearer | MaaS（含 stream） |
| POST | `/v1/agents/:agentId/chat/completions` | Bearer | AaaS（含 stream） |
| GET/POST | `/api/open-platform/keys` | Cookie | 列表 / 创建 |
| DELETE | `/api/open-platform/keys/:id` | Cookie | 吊销 |
| GET | `/api/open-platform/usage` | Cookie | 用量聚合 |
| GET/PUT/DELETE | `/api/open-platform/pricing[/:modelId]` | Cookie(admin) | 模型定价 |
| GET | `/api/open-platform/debug/meta` | Cookie | provider 默认模型 |
| POST | `/api/open-platform/debug/chat` | Cookie | LLM 调试 |
| POST | `/api/open-platform/debug/agent` | Cookie | Agent 调试 |

`web.ts` 挂载：`app.route('/v1', openPlatformRoutes)`、`/api/open-platform/keys`、`/api/open-platform/debug`、`/api/open-platform`。

SSE 通用：`toSseStream(gen)` 把产出 OpenAI chunk JSON 字符串的 async generator 包装成 `ReadableStream`，每块 `data: {json}\n\n`，结束追加 `data: [DONE]\n\n`。

## 7. 前端（`OpenPlatformPage`）

单文件 `web/src/pages/OpenPlatformPage.tsx`（零外链依赖），复用既有 `@/components/ui/*` 组件与 `sonner` toast：

- **用量概览**：四张卡片（调用次数 / Token / 成本 / API Key 数）+ 内联 SVG 折线图（每日请求数/成本，不引第三方图表库）。
- **在线调试**：LLM / Agent 两个 Tab；LLM 含 model/system/user/stream/temperature/max_tokens，Agent 含下拉选 Agent + user/stream；流式用原生 `fetch` 消费 SSE 逐字追加。
- **API Key 管理**：列表（脱敏）、创建（弹窗展示完整 key 仅一次 + 复制）、吊销确认。
- **接入示例**：MaaS/AaaS × curl/Python/Node.js 六段，含鉴权头 + 端点 + 流式写法 + 复制按钮。

接线：`App.tsx` 加 `<Route path="/open-platform">`，`nav-items.ts` 加 `{ path:'/open-platform', icon: KeyRound, label:'开放平台' }`。

## 8. 关键风险与对策

- **Agent 身份泄漏**：对象形式 `systemPrompt` + `<agent-identity-override>`（见 §4.4）。
- **流式计费时机**：收尾异步完成，漏计风险与 IM 链路同等级。
- **SDK 成本估算**：`total_cost_usd` 是估算值（SDK 注释明示），与 IM 链路一致。
- **前置校验竞态**：`checkBillingAccess` 有 30s LRU 缓存，扣费后已 `invalidateUserBillingCache`。
