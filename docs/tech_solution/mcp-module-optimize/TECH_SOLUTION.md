# 技术方案 — MCP 模块功能优化

## 1. 方案总览

两个改动方向：

1. **前端导航合并**：把 `/mcp-registry`、`/mcp-servers` 收敛为一个一级菜单「MCP」，页内用 Tabs 切换两个子视图。
2. **MCP 工具测试能力补全**：新增一个轻量 MCP client（`src/mcp-client.ts`），让「MCP 服务器」模块能对任意 stdio/http/sse 服务器执行 `tools/list` 与 `tools/call`，并在详情面板提供工具列表 + 试调 UI。

核心决策（Think Before Coding 记录）：

- **保留 DeepThink 现有的 DB 化注册中心架构**，不照搬参考实现的文件存储 + gateway。理由：
  - DeepThink 注册中心已完整：DB CRUD、试调、OpenAPI 导入、`loadUserMcpServers()` 自动注入 `__registry` 聚合 MCP 服务器到 Agent（`src/mcp-utils.ts`），等价于参考实现的 gateway/publish 链路。
  - 迁移会推翻已上线的 `mcp_registry_*` 表与 `__registry` 注入逻辑，违反「Surgical Changes」。
- **工具测试能力只补「MCP 服务器」这一侧**（参考实现里 `src/mcp-client.ts` + `mcp-servers.ts` 的 `/:id/tools`、`/:id/tools/call`），注册中心侧的试调已存在。

## 2. 前端导航合并

### 2.1 路由与导航

- `web/src/components/layout/nav-items.ts`：删除 `{ path: '/mcp-registry', ... }` 条目。
- `web/src/App.tsx`：
  - 移除 `McpRegistryPage` import。
  - 将 `<Route path="/mcp-registry" .../>` 改为 `<Route path="/mcp-registry" element={<Navigate to="/mcp-servers?tab=registry" replace />} />`。
  - 保留 `/mcp-servers` 路由指向改造后的 `McpServersPage`。

### 2.2 页面结构

- `McpServersPage.tsx` 改为 Tab 容器：
  - 使用现有 `@/components/ui/tabs`（`Tabs` / `TabsList` / `TabsTrigger` / `TabsContent`）。
  - 顶部 `PageHeader` 标题改为「MCP」，subtitle 随当前 Tab 动态变化。
  - 用 `useSearchParams()` 读取 `tab`（默认 `servers`），切换时同步写回，保证 `/mcp-registry` 重定向落点正确。
  - Tab 1 `servers`：现有服务器列表 + 详情（原样保留）。
  - Tab 2 `registry`：渲染 `RegistryPanel`（由原 `McpRegistryPage` 改造）。

### 2.3 注册中心页 → 面板

- 把 `web/src/pages/McpRegistryPage.tsx` 迁移为 `web/src/components/mcp-servers/RegistryPanel.tsx`：
  - 去掉外层 `PageHeader`、`min-h-full`、`max-w-7xl` 页面级 chrome（它在 Tab 内渲染）。
  - 保留两栏主从布局与全部子组件（`AddServerDialog` / `ToolEditorDialog` / `OpenApiImportDialog` / `TestToolDialog`）。
  - 修正相对 import 路径（`../../stores/mcp-registry`、`../mcp-registry/*`）。

## 3. MCP 工具测试能力

### 3.1 依赖

- 根 `package.json` 增加 `"@modelcontextprotocol/sdk": "^1.30.0"`（与参考实现一致；本机 node_modules 已含 1.30.0）。项目不提交 `package-lock.json`。

### 3.2 `src/mcp-client.ts`（新增）

提供两个纯函数式 API，每次调用都「一次性连接 → 完成后 `finally` 关闭」，保证 stdio 子进程必被回收：

```ts
export function buildTransport(cfg): Transport   // 内部
export async function listMcpTools(cfg): Promise<McpToolInfo[]>
export async function callMcpTool(cfg, toolName, args): Promise<McpToolCallResult>
```

- `buildTransport` 按 `cfg.type` 选择：
  - `http` → `StreamableHTTPClientTransport`
  - `sse` → `SSEClientTransport`（兼容旧客户端）
  - 默认 → `StdioClientTransport`（env 用 `{ ...getDefaultEnvironment(), ...cfg.env }` 合并，避免丢失 PATH）
- 超时：connect 15s / list 30s / call 120s。
- 错误统一转为中文可读消息（ENOENT → 「命令不存在或无法执行」）。

### 3.3 `src/routes/mcp-servers.ts`（新增两个端点）

```ts
GET  /api/mcp-servers/:id/tools      // listMcpTools(entry) → { tools }
POST /api/mcp-servers/:id/tools/call // callMcpTool(entry, toolName, args) → { content, isError, structuredContent }
```

- 复用现有 `readMcpServersFile()` + `validateServerId()`。
- `tools/call` 入参校验：`toolName` 非空字符串且 ≤ `MAX_MCP_KEY_LEN`；`args` 为 plain object。
- 底层错误 → 502（`listMcpTools`/`callMcpTool` 抛错时）。

### 3.4 前端工具面板

- 新增 `web/src/components/mcp-servers/McpServerTools.tsx`：
  - `apiFetch`（带 `timeoutMs`）请求 `/tools` 与 `/tools/call`，不入 store（工具为选中后按需加载的瞬态数据）。
  - `buildArgsTemplate()`：按 `inputSchema.properties` 生成 JSON 参数模板（default 优先，否则按类型给占位）。
  - `formatContent()`：把 `content[]` 规范化为可读文本（text 内容尝试 pretty-print JSON）。
- `McpServerDetail.tsx` 在只读视图的配置区块与 footer 之间插入 `<McpServerTools server={server} />`。

## 4. 数据流

```
前端 McpServerTools
  → GET /api/mcp-servers/:id/tools
      → mcp-client.listMcpTools(cfg)
          → MCP SDK Client.connect → tools/list → close
  → POST /api/mcp-servers/:id/tools/call
      → mcp-client.callMcpTool(cfg, toolName, args)
          → MCP SDK Client.connect → tools/call → close
```

注册中心侧（已有，不改变）：

```
Web 注册中心 / OpenAPI 导入 → db(mcp_registry_servers/tools)
  → loadUserMcpServers() 注入 __registry 聚合 MCP 服务器
  → Agent 经 /api/mcp-registry/mcp 调用 → executeRegistryTool() → 后端 HTTP
```

## 5. 涉及文件清单

| 文件 | 改动 |
|------|------|
| `web/src/components/layout/nav-items.ts` | 删 `/mcp-registry` 条目 |
| `web/src/App.tsx` | 移除 McpRegistryPage import；`/mcp-registry` 重定向 |
| `web/src/pages/McpServersPage.tsx` | 改为 Tabs 容器 |
| `web/src/components/mcp-servers/RegistryPanel.tsx` | 新增（由 McpRegistryPage 迁移） |
| `web/src/pages/McpRegistryPage.tsx` | 删除 |
| `web/src/components/mcp-servers/McpServerTools.tsx` | 新增 |
| `web/src/components/mcp-servers/McpServerDetail.tsx` | 嵌入 McpServerTools |
| `src/mcp-client.ts` | 新增 |
| `src/routes/mcp-servers.ts` | 新增 tools / tools/call 端点 |
| `package.json` | 增加 `@modelcontextprotocol/sdk` |
| `tests/` | 新增单测（见下） |

## 6. 测试策略

- **单测（vitest）**：
  - `tests/units/mcp-registry-engine.test.ts`：覆盖 `sanitizeServerPrefix`、`extractByPath`、`parseRegistryToolRow`，以及 `executeRegistryTool` 的参数映射 / 响应映射 / 错误映射 / 截断（stub `globalThis.fetch`）。
  - `tests/mcp-client-transport.test.ts`：覆盖 `buildTransport` 的错误分支（http 缺 url / stdio 缺 command）与 `toErrorMessage`（ENOENT 映射）。
- **类型检查**：`make typecheck`。
- **构建**：`make build`。
- **端到端**：登录 admin，验证导航合并 + 注册中心工具注册/试调 + `web-search` stdio 服务器的工具列表/试调。

## 7. 风险与回滚

- 新增 `@modelcontextprotocol/sdk` 仅被 `src/mcp-client.ts` 使用，纯 JS 无 native 依赖，无跨平台风险。
- `McpServerTools` 每次连接独立，异常不污染主进程；`finally close` 保证不泄漏子进程。
- 前端重定向用 `<Navigate replace>`，不产生历史栈垃圾。
