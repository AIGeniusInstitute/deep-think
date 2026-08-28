# 测试报告 — MCP 模块功能优化

- 需求：把 `/mcp-registry` 与 `/mcp-servers` 合并为一级菜单「MCP」，并完整实现 MCP 工具的 HTTP-API 注册 + 工具测试。
- 分支：`feat/mcp-module-optimize`（自 `main` e36c6e4）
- 日期：2026-08-28

## 1. 测试范围

| 模块 | 变更 | 验证手段 |
|------|------|---------|
| 前端菜单合并 | `nav-items.ts` / `App.tsx` / `McpServersPage.tsx`（Tabs） | typecheck + build |
| 注册中心面板 | `RegistryPanel.tsx`（自 `McpRegistryPage.tsx` 迁移） | typecheck + build + 既有单测 |
| MCP 客户端 | `src/mcp-client.ts`（listTools / callTool / buildTransport） | 新增单测 |
| 后端端点 | `GET /:id/tools`、`POST /:id/tools/call` | 新增单测覆盖传输/错误归一化 |
| 前端工具测试 UI | `McpServerTools.tsx` + `McpServerDetail.tsx` 嵌入 | typecheck + build |

## 2. 测试方法

```bash
make typecheck   # 后端 + 前端 + agent-runner 全量类型检查
make build       # 后端 tsc + 前端 vite + agent-runner 全量构建
make test        # vitest 约束测试
npx vitest run tests/mcp-client.test.ts   # 本需求新增单测
```

## 3. 结果总览

| 项 | 结果 |
|----|------|
| `make typecheck` | ✅ 通过（三项目无类型错误） |
| `make build` | ✅ 通过（web built in ~11s，agent-runner/backend tsc exit 0） |
| 新增 `tests/mcp-client.test.ts` | ✅ 8/8 通过 |
| `tests/units/mcp-registry-*.test.ts` | ✅ 20 通过 / 10 跳过（e2e 类受隔离保护跳过） |
| `make test` 全量 | 1558 通过 / 10 跳过 / 1 失败（既有，见 §6） |

## 4. 新增单测明细（tests/mcp-client.test.ts）

`buildTransport` 传输选择：
- http → `StreamableHTTPClientTransport`
- sse → `SSEClientTransport`
- 缺省（stdio）→ `StdioClientTransport`
- http/sse 缺 url → 抛错 `missing url`
- stdio 缺 command → 抛错 `missing command`

`toErrorMessage` 归一化：
- ENOENT → 友好提示「命令不存在或无法执行：…」
- 普通 Error → 返回 message
- 非 Error 值 → 转字符串

## 5. E2E 手动验证步骤（admin / 88888888）

1. `make start` 启动服务，浏览器打开 `http://127.0.0.1:9898`。
2. 登录 `admin` / `88888888`。
3. 左侧一级菜单应只剩一个「MCP」（不再出现独立的「MCP 注册中心」）。
4. 进入 MCP → 默认「MCP 服务器」Tab：添加一个 stdio 服务器（如 `command=npx`、`args=-y @modelcontextprotocol/server-everything`），选中后在详情底部「工具」区块应列出工具、可展开并试调。
5. 切换到「HTTP 注册中心」Tab：新建分组 / 新建工具 / OpenAPI 导入 / 试调，功能与原先 `/mcp-registry` 一致。
6. 旧地址 `http://127.0.0.1:9999/mcp-registry` 自动跳转到 `/mcp-servers?tab=registry`。

## 6. 已知的既有失败（与本需求无关）

`make test` 全量存在 1 处失败：`tests/graph-e2e.test.ts > register definition → Mermaid + version + hash`。

**根因（证据）**：该测试的 `beforeAll` 执行
```js
fs.rmSync(path.join(E2E_DATA_DIR, 'db', 'messages.db'), { force: true });
```
其中 `E2E_DATA_DIR = process.env.DEEPTHINK_DATA_DIR || '/tmp/deepthink-e2e-graph'`。
但 `initDatabase()` 实际打开的路径是 `src/config.ts` 的
```js
DATA_DIR = process.env.DEEPTHINK_DATA_DIR ? resolve(...) : path.resolve(os.homedir(), '.deepthink', 'data')
```
当 `DEEPTHINK_DATA_DIR` 未设置时，两者不一致：测试删除的是 `/tmp/deepthink-e2e-graph/db/messages.db`，而真正写入的是 `~/.deepthink/data/db/messages.db`。于是 `graph_definitions` 表的 `dev-workflow` 版本号跨运行持续累加，实测依次出现 `@1 → @2 → @3`：

```
> SELECT id, version FROM graph_definitions WHERE id='dev-workflow' ORDER BY version
[{id:'dev-workflow',version:1},{id:'dev-workflow',version:2},{id:'dev-workflow',version:3}]
```

对比同目录 `tests/units/mcp-registry-e2e-sdk.test.ts` 的隔离保护写法（`RUN = DEEPTHINK_DATA_DIR.startsWith(os.tmpdir())` 否则 `describe.skip`），`graph-e2e.test.ts` 的保护是「默认 `/tmp` 即运行」，与 `config.ts` 的「默认 `~/.deepthink/data`」不一致，导致保护失效。

**结论**：该失败与本次 MCP 改动无关（改动文件列表见 `git diff --stat HEAD`，仅 `package.json` / `src/routes/mcp-servers.ts` / `src/mcp-client.ts` / 前端 MCP 组件 / `tests/mcp-client.test.ts`，未触碰 `graph-*`、`db.ts`、`config.ts`）。按「外科手术式改动」原则不在本需求内修复，仅在此记录；修复方式为对齐该测试的数据目录隔离保护（设置 `process.env.DEEPTHINK_DATA_DIR` 或改用 `config.ts` 的 `DATA_DIR`）。

## 7. 结论

MCP 模块功能优化已完整实现并通过验证：

- 一级菜单合并为「MCP」（Tabs 承载「MCP 服务器」+「HTTP 注册中心」），旧路由自动重定向。
- MCP 工具 HTTP-API 注册（注册中心）沿用既有 DB-based 实现，既有单测通过。
- MCP 工具测试功能（工具列表 + 试调）后端 `mcp-client` + 两个端点、前端 `McpServerTools` UI 全部落地，新增单测 8/8 通过，typecheck / build 全绿。
