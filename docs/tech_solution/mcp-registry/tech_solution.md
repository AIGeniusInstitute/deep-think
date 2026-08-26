# MCP Server 注册中心 — 技术方案

> 分支：`feat/mcp-registry` · 依赖 PRD：`docs/prd/mcp-registry/prd.md`

## 1. 架构决策与权衡

### 1.1 暴露方式：主服务侧 streamable-HTTP MCP 端点（Path A）

**决策**：在 DeepThink **主服务**（`src/`，Hono）上实现一个 streamable-HTTP MCP 端点 `/api/mcp-registry/mcp`，作为 id=`__registry` 的 http 类型 MCP Server 注入 Agent。转换引擎（HTTP 调用）在主服务侧执行。

**为何不选 Path B（agent-runner 内 in-process/stdio）**：
- 用户参考设计明确描述了「MCP 聚合网关 + streamable-HTTP + 多租户端点 + Bearer Token」的网关形态，Path A 与之对齐。
- 转换引擎单一来源（主服务），有网络出站能力、有 DB，不必在 agent-runner（独立编译产物）里复制一份。
- claude 引擎原生支持 http 类型 MCP（`loadUserMcpServers` 已把 http/sse 透传给 SDK 的 `mcpServers`），**agent-runner 零改动**即可让 claude 引擎接入。
- codex/opencode 引擎目前仅注入 `deepthink` stdio bridge，连用户既有 http MCP 都未透传；注入 `__registry` http 条目是顺带补齐能力（见 §6）。
- pi 引擎当前不桥接 MCP，v1 不覆盖（列入演进）。

**风险与缓解**：
- *streamable-HTTP 传输合规性*：MCP 协议即 JSON-RPC 2.0 over HTTP，v1 子集（initialize / notifications/initialized / tools/list / tools/call）以 `application/json` 同步响应即可合规；端到端测试（T7）以真实 Agent 验证，循环修复直到 Agent 能 list+call。
- *容器→主服务 HTTP 回连*：Docker 默认 bridge 网络无法直接 `localhost:9898`。方案：`buildContainerArgs` 增 `--add-host=host.docker.internal:host-gateway`（标准、无害），docker 模式注入 URL `http://host.docker.internal:${WEB_PORT}/...`；host 模式（agent-runner 为子进程）用 `http://127.0.0.1:${WEB_PORT}/...`。

### 1.2 不引入新依赖（Simplicity First）
- 不给主服务 `package.json` 增加 `@modelcontextprotocol/sdk`（主服务 node_modules 为 git 跟踪符号链接，npm install 会破坏运行态）。MCP 端点直接用 Hono 手写 JSON-RPC 响应。
- 复用现有 `better-sqlite3` / `zod` / `hono`。

## 2. 数据模型（SQLite，`src/db.ts`）

新增两表 + 一 token 表，紧邻 `agent_definitions` 建表区：

```sql
CREATE TABLE IF NOT EXISTS mcp_registry_servers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mcp_reg_srv_user ON mcp_registry_servers(user_id);

CREATE TABLE IF NOT EXISTS mcp_registry_tools (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,              -- MCP 工具本地名 ^[a-zA-Z_][a-zA-Z0-9_]*$
  description TEXT NOT NULL DEFAULT '',
  input_schema TEXT NOT NULL,      -- JSON Schema object 序列化
  http_binding TEXT NOT NULL,      -- JSON: {method,url,headers,paramMapping,bodyTemplate,authHeader,responseMapping,timeoutMs}
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (server_id) REFERENCES mcp_registry_servers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mcp_reg_tool_srv ON mcp_registry_tools(server_id);
CREATE INDEX IF NOT EXISTS idx_mcp_reg_tool_user ON mcp_registry_tools(user_id);

CREATE TABLE IF NOT EXISTS mcp_registry_tokens (
  user_id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
```

### httpBinding 结构（TS）
```ts
interface HttpBinding {
  method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE';
  url: string;                       // http(s)，支持 {pathVar} 占位
  headers?: Record<string,string>;   // 静态头
  paramMapping?: {
    path?: Record<string,string>;    // argName -> url 占位名
    query?: Record<string,string>;   // argName -> query 参数名
    header?: Record<string,string>;  // argName -> 请求头名
    body?: Record<string,string>;    // argName -> body JSON 字段名
  };
  bodyTemplate?: Record<string,unknown>; // 静态 body 模板（与 body 映射合并）
  authHeader?: { name: string; value: string }; // 凭证，主服务侧注入，不透传 Agent
  responseMapping?: {
    extract?: string;                // 点路径，如 "data.current"
    toText?: string;                 // 可选模板 {{field}}（v1 简单实现）
    truncate?: number;               // 字符截断，默认 20000
  };
  timeoutMs?: number;                // 默认 15000，上限 60000
}
```

## 3. DB 访问器（`src/db.ts`，新增导出）

仿 `getAgentDefinition`/`listAgentMounts` 风格：
- `listRegistryServers(userId)` / `getRegistryServer(id,userId)` / `createRegistryServer` / `updateRegistryServer` / `deleteRegistryServer`
- `listRegistryToolsByServer(serverId,userId)` / `listEnabledRegistryTools(userId)`（MCP 端点用）/ `getRegistryTool(id,userId)` / `createRegistryTool` / `updateRegistryTool` / `deleteRegistryTool`
- `getOrCreateRegistryToken(userId)`：返回 per-user token（`crypto.randomUUID()`，首次惰性生成）。
- `getUserIdByRegistryToken(token)`：MCP 端点鉴权反查。

## 4. REST CRUD API（新文件 `src/routes/mcp-registry.ts`，挂载 `/api/mcp-registry`）

| Method | Path | 说明 |
|--------|------|------|
| GET | `/servers` | 列当前用户 server（带 tool_count） |
| POST | `/servers` | 建 server |
| PATCH | `/servers/:id` | 改 name/desc/enabled |
| DELETE | `/servers/:id` | 删（级联 tool） |
| GET | `/servers/:id/tools` | 列 tool |
| POST | `/servers/:id/tools` | 建 tool（zod 校验） |
| PATCH | `/tools/:id` | 改 tool |
| DELETE | `/tools/:id` | 删 tool |
| POST | `/tools/:id/test` | 试调（走转换引擎） |
| POST | `/import-openapi/preview` | 解析 OpenAPI → 候选工具 |
| POST | `/import-openapi/confirm` | 批量导入 |
| GET | `/token` | 查看/轮换 registry token（管理用） |

所有路由用 `authMiddleware`，`c.get('user')` 取 userId，跨用户隔离。字段上限沿用 `routes/mcp-servers.ts` 的 `MAX_MCP_*` 常量口径。

### 4.1 zod 校验（`src/schemas.ts` 增 `registryToolCreateSchema`）
- name: `/^[a-zA-Z_][a-zA-Z0-9_]*$/`，长度 ≤64
- inputSchema: object 且 `type==='object'`（简化校验，允许任意 properties）
- httpBinding.method enum、url 非空 http(s)、timeoutMs 0–60000
- description ≤1024

## 5. 转换引擎（新文件 `src/mcp-registry/engine.ts`）

核心函数 `executeRegistryTool(tool, arguments) -> McpToolResult`：

```ts
async function executeRegistryTool(tool, args): Promise<{
  content: { type:'text'; text:string }[];
  isError: boolean;
}> 
```

流程（对应 AC5.1–5.5）：
1. **参数校验**：对 inputSchema 做轻量必填校验（required 字段存在）；缺参返回 isError + 提示。
2. **路径变量**：`paramMapping.path` → 替换 url 中 `{name}`。未消费的 url 占位若仍有 `{x}` 视为缺参。
3. **query**：`paramMapping.query` → 拼 querystring。
4. **header**：`paramMapping.header` → 请求头；合并静态 `headers`；合并 `authHeader`（凭证在此注入，**仅引擎可见**）。
5. **body**：method ∈ {POST,PUT,PATCH} 时，合并 `bodyTemplate` + `paramMapping.body` 映射的参数 → JSON body。
6. **调用**：`fetch(url, {method,headers,body, signal: AbortSignal.timeout(timeoutMs)})`。Node 18+ 内置 fetch。
7. **响应提取**：`extract` 点路径取子树（`a.b.c`，数组索引 `[0]` 支持）；未配置则整体；`toText` 模板 `{{field}}` 替换；超 `truncate`(默认 20000) 截断并附 `…(truncated)`。
8. **错误映射**：
   - HTTP 4xx → `isError:true`，text 含 `HTTP <status>: <摘要>`。
   - HTTP 5xx / fetch 网络错 / AbortTimeout → `isError:true`，text 含错误类别。
   - 不抛 JSON-RPC 错（保护协议层）；引擎层错误统一以 isError ToolResult 返回。
   - 注：AC5.4 要求 4xx→INVALID_PARAMS、5xx→INTERNAL_ERROR 的「JSON-RPC 错误码映射」仅在 MCP 端点 `tools/call` 出口处应用（见 §6）；引擎内部用 isError 统一，端点层按需转译。

## 6. MCP streamable-HTTP 端点（`src/routes/mcp-registry.ts` 内，路径 `/mcp`）

挂载在 `/api/mcp-registry/mcp`。实现一个轻量 JSON-RPC 处理器（不依赖 MCP SDK）：

```
POST /api/mcp-registry/mcp
  Authorization: Bearer <registryToken>
  Accept: application/json, text/event-stream
  Body: JSON-RPC 2.0 {jsonrpc:"2.0", id, method, params?}
```

处理逻辑：
- **鉴权**：解析 `Authorization` → `getUserIdByRegistryToken` → 401 失败。无 cookie 依赖（Agent 无会话 cookie）。
- **`initialize`**：响应 `{protocolVersion:"2025-06-18", capabilities:{tools:{listChanged:true}}, serverInfo:{name:"deepthink-registry",version:"1.0.0"}}`，设 `Mcp-Session-Id` 响应头（`crypto.randomUUID()`，无状态——后续请求不校验 session 存在性，仅回显）。
- **`notifications/initialized`**：无 id 的通知 → 返回 202 Accepted，空体。
- **`tools/list`**：`listEnabledRegistryTools(userId)` → 逐工具映射为 `{name: "{serverName}__{toolName}", description, inputSchema}`。注意 server name 需清洗为 `[a-zA-Z0-9_]`（原样用于前缀，非法字符替换 `_`）。
- **`tools/call`**：params `{name, arguments}` → 按 `__` 拆分定位 tool → `executeRegistryTool` → 返回 `{content:[{type:"text",text}], isError?}`。tool 未找到 → JSON-RPC error -32602 INVALID_PARAMS。
- **响应 Content-Type**：统一 `application/json`（同步响应）。`initialize` 与带 `id` 的请求返回 200 + JSON-RPC 响应体。
- **GET**：返回 405（v1 不实现 SSE 推送通道；listChanged 仅作能力声明，不主动 push）。SDK 对 GET 405 应优雅降级（端到端测试验证）。
- **未知 method**：返回 JSON-RPC error -32601 Method not found。

> 端点不实现 SSE 流式推送（v1 同步即可），`listChanged:true` 仅声明能力、不主动通知——这是可接受的简化（Agent 重连时会重新 list）。

## 7. 自动注入到 Agent（`src/mcp-utils.ts` + `src/container-runner.ts`）

### 7.1 注入合并点
`loadUserMcpServers(userId)`（mcp-utils.ts，被 container-runner 三处调用）末尾合并 `__registry` 条目：

```ts
// mcp-utils.ts — 新增：读 DB，若用户有 enabled tool 则追加 __registry http 条目
import { listEnabledRegistryTools, getOrCreateRegistryToken } from './db.js';
// 在 loadUserMcpServers 返回前：
const enabled = listEnabledRegistryTools(userId);
if (enabled.length > 0) {
  const token = getOrCreateRegistryToken(userId);
  result['__registry'] = {
    type: 'http',
    url: `${getRegistryBaseUrl()}/api/mcp-registry/mcp`,
    headers: { Authorization: `Bearer ${token}` },
  };
}
```

`getRegistryBaseUrl()`：host 模式 `http://127.0.0.1:${WEB_PORT}`；docker 模式 `http://host.docker.internal:${WEB_PORT}`。判定模式：container-runner 调用处已知（Docker vs Host），通过参数或 env 传入。为保持 `loadUserMcpServers` 签名稳定，新增可选第二参 `opts?: { baseUrl?: string }`，默认 host 模式 URL。

### 7.2 container-runner 调用点（3 处）
- L714（Docker 模式）：`loadUserMcpServers(ownerId, { baseUrl: dockerRegistryUrl })`
- L1145（agent-definition flatten，仅 mcpConfig 元数据——此处不动，registry 走全局注入路径）
- L1840（Host 模式）：`loadUserMcpServers(ownerId, { baseUrl: hostRegistryUrl })`

### 7.3 Docker 回连（`src/container-runner.ts` `buildContainerArgs`）
增一行：`args.push('--add-host', 'host.docker.internal:host-gateway');`（紧跟 `--name` 之后，对所有容器统一、标准、无害）。

### 7.4 codex/opencode 透传（`container/agent-runner/src/{codex,opencode}-engine.ts`）
在写 mcp 配置时，除 `deepthink` bridge 外，把用户 `__registry`（以及既有用户 http MCP）按各引擎格式追加：
- codex `config.toml`：`[mcp_servers.__registry]` + `type = "http"` + `url = "..."` + `headers = ["Authorization=Bearer ..."]`（codex TOML 头格式按其约定）。
- opencode `jsonc`：`mcp.__registry = { type:"remote", url, headers }`。
- 元数据（url/token）由 container-runner 经 env `DEEPTHINK_REGISTRY_MCP_JSON` 传入 agent-runner，引擎读取。

> v1 必达：claude 引擎。codex/opencode 透传为同批交付（小改动）；若 TOML 头格式联调卡住，降级为 v1.1，不阻塞合并。

## 8. 前端（`web/src/`）

- **store**：`stores/mcp-registry.ts`（Zustand，仿 `mcp-servers.ts`，`api.get/post/patch/delete` 打 `/api/mcp-registry/*`）。
- **page**：`pages/McpRegistryPage.tsx`（仿 `McpServersPage`：PageHeader + 左 server 列表 + 右 server 详情含 tool 列表 + AddToolDialog/OpenApiImportDialog/TestToolDialog）。
- **components**：`components/mcp-registry/{RegistryServerCard,ToolCard,AddToolDialog,OpenApiImportDialog,TestToolDialog}.tsx`。
- **nav**：`components/layout/nav-items.ts` 增 `{ path:'/mcp-registry', icon: Boxes, label:'MCP 注册中心' }`（或复用 `Server`/`Plug` 图标）。
- **路由**：`App.tsx` 增 `<Route path="/mcp-registry" element={<McpRegistryPage/>} />`。
- httpBinding 表单用 KV 行组件（仿 `AddMcpServerDialog` 的 args/env KV 行）；inputSchema 用 textarea + 客户端 JSON.parse 校验。

## 9. 文件清单

新增：
- `src/routes/mcp-registry.ts` — REST CRUD + MCP 端点
- `src/mcp-registry/engine.ts` — 转换引擎
- `src/mcp-registry/openapi-parser.ts` — OpenAPI 解析（无外部依赖，手写 minimal parser）
- `src/mcp-registry/index.ts` — barrel（可选）
- `web/src/stores/mcp-registry.ts`
- `web/src/pages/McpRegistryPage.tsx`
- `web/src/components/mcp-registry/*.tsx`

修改：
- `src/db.ts` — 3 张表 + 访问器
- `src/schemas.ts` — zod schema
- `src/mcp-utils.ts` — `loadUserMcpServers` 合并 `__registry` + `getRegistryBaseUrl`
- `src/container-runner.ts` — 3 处调用传 baseUrl + `--add-host`
- `src/web.ts` — 挂载 `mcp-registry` 路由
- `web/src/App.tsx` — 路由
- `web/src/components/layout/nav-items.ts` — nav 项
- `container/agent-runner/src/codex-engine.ts` / `opencode-engine.ts` — 透传（v1 stretch）

## 10. 验收测试映射
对应 PRD §6 测试用例 T1–T8：
- T1–T6：Vitest 单测 + 集成（`tests/units/`，仿现有测试目录），覆盖 DB CRUD、engine 映射、MCP 端点 JSON-RPC。
- T7：端到端，worktree 起服务 + 本地 echo http server，真实 DeepThink 会话调用。
- T8：前端手测 + 截图。

## 11. 里程碑
1. M1：DB 表 + 访问器 + zod schema + REST CRUD（F1,F2）+ 单测 T1,T2。
2. M2：转换引擎 + 试调 API（F4,F5）+ 单测 T4,T5。
3. M3：OpenAPI 解析 + 导入（F3）+ 单测 T3。
4. M4：MCP 端点 + 自动注入 + docker 回连（F6）+ 单测 T6 + 端到端 T7。
5. M5：前端页（F7）+ 手测 T8。
6. M6：codex/opencode 透传（stretch）+ 全量回归 + test_report。
