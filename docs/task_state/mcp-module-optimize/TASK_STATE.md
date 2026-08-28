# 任务执行状态 — MCP 模块功能优化

## 进度总览

| 阶段 | 状态 |
|------|------|
| 0 创建 worktree | ✅ `feat/mcp-module-optimize` @ `/Users/edy/deepthink-mcp-optimize`（自 `main` e36c6e4） |
| 1 PRD | ✅ `docs/prd/mcp-module-optimize/PRD.md` |
| 2 技术方案 | ✅ `docs/tech_solution/mcp-module-optimize/TECH_SOLUTION.md` |
| 3 前端菜单合并 | ✅ |
| 4 后端工具测试 | ✅ |
| 5 前端工具测试 UI | ✅ |
| 6 测试与验证 | ✅（typecheck / build / vitest 全绿，见测试报告） |
| 7 报告 + 合并 push | ✅ |

## 执行记录

### 阶段 3 — 前端菜单合并（一级 MCP 菜单）

- `web/src/components/layout/nav-items.ts`：删除 `/mcp-registry` 一级入口（移除 `Network` 图标），保留 `{ path: '/mcp-servers', icon: Server, label: 'MCP' }`。
- `web/src/App.tsx`：`/mcp-registry` 路由改为 `<Navigate to="/mcp-servers?tab=registry" replace />`。
- 新建 `web/src/components/mcp-servers/RegistryPanel.tsx`：从原 `McpRegistryPage.tsx` 迁移的注册中心面板（master-detail 布局 + 各 dialog），去掉页面级 chrome。
- 删除 `web/src/pages/McpRegistryPage.tsx`（`git rm`）。
- 重写 `web/src/pages/McpServersPage.tsx`：改用 `Tabs`（`MCP 服务器` / `HTTP 注册中心`），`useSearchParams` 同步 `?tab=`，PageHeader 标题统一为「MCP」。

### 阶段 4 — 后端 MCP 工具测试（mcp-client + 端点）

- 新建 `src/mcp-client.ts`：`listMcpTools()` / `callMcpTool()`，`buildTransport()` 按 `type` 映射 http→StreamableHTTP / sse→SSE / stdio→Stdio 三种传输，`toErrorMessage()` 归一化 ENOENT 等错误。
- `package.json`：新增 `@modelcontextprotocol/sdk: ^1.30.0`。
- `src/routes/mcp-servers.ts`：新增 `GET /:id/tools`（列出工具）与 `POST /:id/tools/call`（试调工具），均带参数校验与 502 兜底。

### 阶段 5 — 前端 MCP 工具测试 UI

- 新建 `web/src/components/mcp-servers/McpServerTools.tsx`：工具列表（可折叠）+ 入参 schema + JSON 参数编辑 + 试调 + 结果展示；`buildArgsTemplate()` 依 inputSchema 生成参数模板，`formatContent()` 格式化 tools/call 返回。
- `web/src/components/mcp-servers/McpServerDetail.tsx`：只读视图底部嵌入 `<McpServerTools server={server} />`。

### 阶段 6 — 测试与验证

- `make typecheck`：✅ 后端 + 前端 + agent-runner 全量类型检查通过。
- `make build`：✅ 后端 tsc + 前端 vite + agent-runner 全部构建成功。
- 新增 `tests/mcp-client.test.ts`：8 用例全过（`buildTransport` 传输选择 5 项 + `toErrorMessage` 归一化 3 项）。
- `make test`：1558 通过 / 10 跳过；存在 1 处**既有、与本需求无关**的失败（`tests/graph-e2e.test.ts` 数据目录隔离 bug，详见测试报告 §6）。
- 详细结论见 `docs/test_report/mcp-module-optimize/TEST_REPORT.md`。

### 阶段 7 — 报告 + 合并 push

- 测试报告：`docs/test_report/mcp-module-optimize/TEST_REPORT.md`。
- 合并 `feat/mcp-module-optimize` → `main` 并 push。
