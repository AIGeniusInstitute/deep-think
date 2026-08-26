# MCP Server 注册中心 — PRD

> 状态：Draft v1 · 负责人：DeepThink · 分支：`feat/mcp-registry`

## 1. 背景与目标

DeepThink 现已支持「为每个用户配置外部 MCP Server（stdio / http / sse）」，Agent 启动时通过 `loadUserMcpServers` 注入。但用户要让 Agent 调用一条**业务 HTTP 接口**时，没有低成本路径——要么自己写一个 MCP Server 进程，要么放弃。

**目标**：在 DeepThink 主服务内新增 **MCP Server 注册中心**——一个「HTTP API → MCP 工具」聚合网关。用户把任意 HTTP 接口（含参数映射、凭证、响应提取规则）注册进来，DeepThink 即以标准 MCP 协议（streamable-HTTP）把这些工具统一透出给该用户的所有 Agent。对 Agent 而言，它就是一个 MCP Server；对业务方而言，零改造接入。

**非目标（v1 不做，列入演进）**：多租户 RBAC / 工具粒度 ACL、限流熔断、LLM 响应摘要、Webhook 反向通知、OPTIONS 自动探测、`tools/search` 语义检索、resources/prompts 映射、SSE 流式长响应。这些在 v1 之后再迭代。

## 2. 核心概念与数据模型

```
User
 └── RegistryServer（逻辑分组，如 "weather-service"）
      └── RegistryTool（映射自一个 HTTP 接口）
           ├── inputSchema   (JSON Schema，由参数映射生成/手填)
           ├── httpBinding   (method/url/headers/paramMapping/bodyTemplate/responseMapping/timeoutMs)
           └── enabled
```

两张表（详见技术方案）：
- `mcp_registry_servers`：id, user_id, name, description, enabled, created_at
- `mcp_registry_tools`：id, server_id, user_id, name, description, input_schema(json), http_binding(json), tool_name_prefix, enabled, created_at

Agent 侧看到的是**一个聚合 MCP Server**（id 固定 `__registry`，type=http），其 `tools/list` 返回该用户所有 `enabled` 工具的合集。

## 3. 功能点与验收标准

### F1. 注册中心 Server 分组 CRUD
**描述**：用户可创建 / 查看 / 改名 / 删除 / 启用禁用 RegistryServer（仅作分组容器）。
**验收标准**：
- AC1.1 `GET /api/mcp-registry/servers` 返回当前用户所有 server，含 tool_count、enabled。
- AC1.2 `POST /api/mcp-registry/servers` 创建（name 必填、唯一性校验）。
- AC1.3 `PATCH /api/mcp-registry/servers/:id` 可改 name/description/enabled。
- AC1.4 `DELETE /api/mcp-registry/servers/:id` 删除 server 并级联删除其下所有 tool。
- AC1.5 跨用户隔离：A 用户看不到 / 改不到 B 用户的 server。

### F2. Tool 手动注册 CRUD
**描述**：在某个 server 下手动注册一个工具，填写 name、description、inputSchema、httpBinding。
**验收标准**：
- AC2.1 `GET /api/mcp-registry/servers/:id/tools` 返回该 server 下工具列表。
- AC2.2 `POST /api/mcp-registry/servers/:id/tools` 创建工具；校验 name（`^[a-zA-Z_][a-zA-Z0-9_]*$`）、inputSchema 为合法 JSON Schema object、httpBinding.method ∈ {GET,POST,PUT,PATCH,DELETE}、url 非空且为 http(s)。
- AC2.3 `PATCH /api/mcp-registry/tools/:id` 可改任意字段 + enabled。
- AC2.4 `DELETE /api/mcp-registry/tools/:id` 删除。
- AC2.5 工具的 MCP 暴露名带 server 前缀避免冲突：`{serverName}__{toolName}`（参考聚合端点命名约定）。

### F3. OpenAPI 导入
**描述**：粘贴 OpenAPI/Swagger JSON 或填 URL，解析出候选工具列表，用户勾选后批量导入。
**验收标准**：
- AC3.1 `POST /api/mcp-registry/import-openapi/preview` 接受 `{ serverId, source: 'json'|'url', content, includePaths? }`，返回候选工具数组（每条含建议 name、description、inputSchema、httpBinding 预填）。
- AC3.2 `POST /api/mcp-registry/import-openapi/confirm` 接受 `{ serverId, tools: [...] }`，批量创建工具（复用 AC2.2 的校验）。
- AC3.3 解析失败 / 非 OpenAPI 文档时返回 400 + 明确错误信息，不写库。
- AC3.4 `includePaths` 过滤生效（只保留指定 path）。

### F4. 工具试调（Test）
**描述**：在保存前/后可填参数试调一次，走完整转换引擎，返回结果。
**验收标准**：
- AC4.1 `POST /api/mcp-registry/tools/:id/test` 接受 `{ arguments }`，执行转换引擎并返回 `{ status, httpStatus, body, extracted }`。
- AC4.2 试调不依赖 Agent，纯主服务侧执行。
- AC4.3 后端 HTTP 5xx / 网络超时返回结构化错误，不抛 500。

### F5. HTTP→MCP 转换引擎
**描述**：Agent `tools/call` 时的核心：参数校验 → 参数映射 → 凭证注入 → HTTP 调用 → 响应提取 → 错误映射。
**验收标准**：
- AC5.1 **参数映射**：支持 `paramMapping.{path|query|header|body}`，每项为 `{ argName: targetName }`；路径变量 `{var}` 替换 url；query 拼接；header 注入；body 为 JSON。
- AC5.2 **凭证注入**：httpBinding.authHeader（name+value）注入到请求头，**不透传给 Agent**（Agent 只看到 inputSchema 参数）。
- AC5.3 **响应提取**：`responseMapping.extract` 为点路径（如 `data.current`），从响应 JSON 取子树；未配置则返回整体（超长截断到 20000 字符）。
- AC5.4 **错误映射**：4xx → MCP `INVALID_PARAMS`(-32602) 带状态码与摘要；5xx/超时/网络错 → MCP `INTERNAL_ERROR`(-32603)；Tool 执行自身抛错以 MCP `isError:true` 的 ToolResult 返回（不破坏 JSON-RPC）。
- AC5.5 **超时**：httpBinding.timeoutMs 生效（默认 15000，上限 60000）。

### F6. MCP streamable-HTTP 端点 + 自动注入
**描述**：主服务暴露 `/api/mcp-registry/mcp` 端点，实现 initialize / notifications/initialized / tools/list / tools/call；并作为 id=`__registry` 的 http 类型 MCP Server 自动注入到拥有启用工具的用户。
**验收标准**：
- AC6.1 `POST /api/mcp-registry/mcp` 处理 JSON-RPC `initialize`，返回 `protocolVersion:"2025-06-18"`、`capabilities.tools.listChanged=true`、`serverInfo`，并设置 `Mcp-Session-Id` 响应头。
- AC6.2 `tools/list` 返回该（Token 解析出的）用户所有 enabled 工具，符合 MCP Tool 规范（name/description/inputSchema）。
- AC6.3 `tools/call` 走 F5 转换引擎，返回标准 `content:[{type:text,text:...}]` + `isError` 旗标。
- AC6.4 `notifications/initialized`（通知，无 id）返回 202。
- AC6.5 鉴权：端点用 Bearer Token（per-user registry token，存在 users 表/配置），无效 token 返回 401；Agent 注入时 `headers:{Authorization:"Bearer <token>"}`。
- AC6.6 自动注入：当用户存在 ≥1 个 enabled tool 时，`loadUserMcpServers` 结果合并 `__registry` http 条目（指向本端点 + token）；0 个时不注入。
- AC6.7 Agent 实测：在真实 DeepThink 会话中，Agent 的 `tools/list` 能看到注册的工具，Agent `tools/call` 能拿到正确结果（端到端验收，见 §5）。

### F7. 前端管理页
**描述**：`/mcp-registry` 页面，server 列表 + 详情（工具列表）+ 新建/编辑工具 Dialog + OpenAPI 导入 Dialog + 试调。
**验收标准**：
- AC7.1 导航新增「MCP 注册中心」入口（nav-items.ts），路由 `/mcp-registry`。
- AC7.2 页面遵循 McpServersPage 的 master/detail + PageHeader + SearchInput + EmptyState 骨架。
- AC7.3 新建/编辑工具 Dialog：name、description、inputSchema(JSON 文本框)、httpBinding(method/url/headers KV/paramMapping/bodyTemplate/extract/timeoutMs/authHeader)，校验 + toast。
- AC7.4 OpenAPI 导入 Dialog：source 切换 json/url，preview 列表可勾选，confirm 批量导入。
- AC7.5 试调按钮：弹框填 arguments(JSON) → 显示 status/httpStatus/body/extracted。

## 4. 安全与治理（v1 范围）
- 用户隔离：所有数据按 `user_id` 隔离；MCP 端点用 per-user Bearer Token 鉴权。
- 凭证不外泄：httpBinding 的 authHeader 仅在主服务侧注入，Agent 永远拿不到原始凭证（不写入 inputSchema、不出现在 tools/list）。
- 输入上限：沿用现有 MCP 字段上限口径（string ≤4096、args/headers ≤50 等），防止 servers.json / DB 膨胀。
- URL scheme 限制：仅 http/https，禁 file/ftp 等。
- 描述 Lint：注册时对 tool description 做长度上限（≤1024），不强制内容审核（v1）。

## 5. 端到端验收（Goal-Driven）
**成功标准**：在 worktree 起服务后，用一个本地 mock HTTP 接口（如 `httpbin` 或自起 echo server）注册为工具，DeepThink Agent 在会话中能 `tools/list` 看到该工具、`tools/call` 调用并拿到提取后的正确响应。全部 F1–F7 的 AC 通过。

## 6. 测试用例（汇总，详见 test_report）
| ID | 覆盖 | 步骤摘要 | 期望 |
|----|------|---------|------|
| T1 | F1 AC1.1–1.5 | CRUD server + 跨用户隔离 | 隔离生效 |
| T2 | F2 AC2.1–2.5 | CRUD tool + 命名校验 + 前缀 | 前缀 `{server}__{tool}` |
| T3 | F3 AC3.1–3.4 | OpenAPI preview/confirm + includePaths + 非法文档 | 候选正确、非法 400 |
| T4 | F4 AC4.1–4.3 | 工具试调 + 5xx/超时 | 结构化错误 |
| T5 | F5 AC5.1–5.5 | 参数映射 path/query/header/body + 凭证注入 + 提取 + 错误映射 + 超时 | 全过 |
| T6 | F6 AC6.1–6.6 | MCP initialize/list/call/initialized/401/自动注入 | 协议合规 |
| T7 | F6 AC6.7 | Agent 端到端（mock echo 接口） | Agent 拿到正确结果 |
| T8 | F7 AC7.1–7.5 | 前端页 CRUD/导入/试调 | UI 通路 |

## 7. 演进方向（v1 之后）
多租户 RBAC / 工具粒度 ACL、限流熔断（per-tool/per-agent/per-backend）、LLM 响应摘要、`tools/search` 语义检索、resources/prompts 映射、SSE 流式长响应、Webhook 长任务反向通知、工具市场化目录。
