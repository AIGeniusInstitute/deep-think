# PRD — MCP 模块功能优化

## 1. 背景与问题

当前 DeepThink 的 MCP 相关能力分散在两个独立的一级菜单下：

| 路径 | 菜单名 | 能力 |
|------|--------|------|
| `/mcp-servers` | MCP | 管理 stdio / http / sse 类型的 MCP 服务器（CRUD + 宿主机同步） |
| `/mcp-registry` | MCP 注册中心 | 把外部 HTTP 接口注册为 MCP 工具（CRUD + OpenAPI 导入 + 试调） |

存在的问题：

1. **入口割裂**：用户要理解两套 MCP 概念（「接一个 MCP 服务器」vs「把一个 HTTP 接口变成 MCP 工具」），两个菜单名还都带「MCP」，认知成本高、导航冗余。
2. **MCP 服务器缺少工具测试能力**：在「MCP 服务器」里添加了一个 stdio/http/sse MCP 服务器后，用户无法直接看到它暴露了哪些工具、也无法在界面上试调工具——只能等 Agent 实际挂载后才知道可用不可用。参考实现（`~/paap/prime-ai-harness`）已经通过一个轻量 MCP client 补上了「工具列表 + 试调」。
3. **HTTP 注册中心能力已基本就绪**（工具注册、试调、OpenAPI 导入、自动注入 `__registry` 聚合 MCP 服务器到 Agent），但缺少针对「注册 + 试调」全链路的自动化测试兜底。

## 2. 目标

1. 把 `/mcp-registry` 与 `/mcp-servers` 合并到**一个一级菜单「MCP」**下，通过页内 Tab 切换两个子视图。
2. **完整实现并测试**「MCP 工具 API 注册」与「工具测试」两大能力：
   - API 注册：HTTP 接口 → MCP 工具（注册中心，已有，补齐测试）。
   - 工具测试：MCP 服务器（stdio/http/sse）的工具列表 + 试调（新增）。

## 3. 用户故事

- 作为用户，我在左侧导航只看到一个「MCP」入口，点进去用两个 Tab 就能分别管理「MCP 服务器」和「HTTP 注册中心」。
- 作为用户，我给 MCP 服务器加了一个 stdio/http 服务后，能点开详情看到它暴露的工具列表，展开某个工具填入 JSON 参数点「运行测试」，直接看到后端返回结果（或错误）。
- 作为用户，我在注册中心把外部 HTTP 接口注册成 MCP 工具后，能立即试调确认映射正确，Agent 也能通过自动注入的 `__registry` MCP 服务器调用这些工具。

## 4. 功能点与验收标准

### F1 — 一级菜单合并（前端）

- 左侧导航移除独立的「MCP 注册中心」项，仅保留一项「MCP」（路径 `/mcp-servers`）。
- `/mcp-servers` 页面顶部出现两个 Tab：`MCP 服务器` 与 `HTTP 注册中心`。
- `MCP 服务器` Tab 内容与现有服务器管理一致；`HTTP 注册中心` Tab 内容与现有注册中心一致（去掉内层 PageHeader，改为面板内工具栏）。
- 旧路径 `/mcp-registry` 访问时重定向到 `/mcp-servers?tab=registry`，不出现 404 / 空白。

**验收标准**：
- [ ] `nav-items.ts` 中不存在 `/mcp-registry` 条目。
- [ ] `/mcp-servers` 可切换两个 Tab，各自内容正确渲染。
- [ ] 访问 `/mcp-registry` 落地到「HTTP 注册中心」Tab。

### F2 — MCP 服务器工具列表（后端）

- `GET /api/mcp-servers/:id/tools`：对指定 MCP 服务器（stdio/http/sse）发起一次性 MCP 连接，执行 `tools/list`，返回 `{ tools: [{ name, description, inputSchema }] }`。
- 连接失败 / 命令不存在等场景返回 502 + 可读错误信息，不崩溃。
- 每次 list/call 后 `finally` 关闭连接，stdio 子进程必被回收。

**验收标准**：
- [ ] 对 `web-search`（stdio）服务器请求 `/tools`，返回工具名与 schema。
- [ ] 对不存在的 server id 返回 404；对命令不存在的 stdio 服务器返回 502 + 中文可读错误。

### F3 — MCP 服务器工具试调（后端）

- `POST /api/mcp-servers/:id/tools/call`，body `{ toolName, args }`：执行 `tools/call`，返回 `{ content, isError, structuredContent? }`。
- 参数校验：`toolName` 非空字符串（≤256）、`args` 为 plain object。

**验收标准**：
- [ ] 对 `web-search` 的工具传入合法 args 返回真实结果。
- [ ] 非法 body（缺 toolName / args 非对象）返回 400。

### F4 — MCP 服务器工具列表 + 试调（前端）

- 在 MCP 服务器详情面板新增「工具」区块：展示工具名、描述、入参 schema（可折叠）。
- 每个工具可展开，输入 JSON 参数（自动生成模板）点「运行测试」，展示结果；错误以红色区分。

**验收标准**：
- [ ] 选择某个 MCP 服务器后，详情区出现工具列表。
- [ ] 展开工具 → 填入参数 → 运行测试 → 看到结果/错误。

### F5 — HTTP 注册中心（已有能力，补齐测试）

- 工具注册（手动 + OpenAPI 导入）、试调、启停、删除行为不变。
- 新增自动化测试覆盖：工具名前缀清洗、JSONPath 提取、参数映射（path/query/header/body）、响应映射（extract/toText/truncate）、错误映射、必填校验、OpenAPI 解析。

**验收标准**：
- [ ] 既有单测 + 新增单测全部通过；`make typecheck`、`make build` 通过。

## 5. 非目标（本期不做）

- 不迁移注册中心为文件存储 / 网关模式：DeepThink 现有 DB 化注册中心 + `__registry` 聚合 MCP 端点架构已完整，保持不动。
- 不做注册中心「上架到公共市场」（参考实现里的 marketplace publish 属另一需求）。
- 不做内置「注册中心管理 MCP 工具」（`REGISTRY_SERVER_ID` 那套，供 Agent 多轮集成），本期聚焦 Web 控制台能力。

## 6. 测试用例

| 编号 | 用例 | 前置 | 步骤 | 预期 |
|------|------|------|------|------|
| T1 | 导航合并 | 登录 admin | 左侧导航 | 只有一个「MCP」项，无「MCP 注册中心」项 |
| T2 | Tab 切换 | 进入 /mcp-servers | 点「HTTP 注册中心」Tab | 显示注册中心面板 |
| T3 | 旧路径重定向 | 登录 admin | 访问 /mcp-registry | 跳转 /mcp-servers?tab=registry 并显示注册中心 |
| T4 | MCP 服务器工具列表 | 已有 stdio 服务器 web-search | GET /api/mcp-servers/web-search/tools | 返回 tools 数组 |
| T5 | MCP 服务器试调 | T4 | POST …/tools/call {toolName,args} | 返回 content + isError |
| T6 | 试调参数校验 | T4 | POST …/tools/call {} | 400（缺 toolName） |
| T7 | 注册中心注册工具 | 登录 admin | 新建分组 + 新建工具（GET 接口） | 工具出现在列表，mcpName 为 `前缀__工具名` |
| T8 | 注册中心试调 | T7 | 点「试调」填入参数 | 返回映射后的文本结果 |
| T9 | 引擎单测 | - | vitest | sanitizeServerPrefix / extractByPath / executeRegistryTool / parseOpenApi 全绿 |
