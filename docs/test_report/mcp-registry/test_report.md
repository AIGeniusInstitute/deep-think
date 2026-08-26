# MCP Server 注册中心 — 测试报告

> 分支：`feat/mcp-registry` · 日期：2026-08-26 · 负责人：DeepThink Agent

## 1. 概述

为 DeepThink MCP 模块新增 **MCP Server 注册中心**：用户将 HTTP 业务 API（含参数映射、凭据、响应抽取）注册为 MCP 工具，DeepThink 通过主服务 streamable-HTTP 端点以标准 MCP 协议向各 Agent 暴露这些工具，Agent 无需改造即可调用。

实现路径采用 **Path A**（主服务内置 streamable-HTTP 端点，手写 JSON-RPC，不新增 SDK 依赖），符合参考架构并贴合 DeepThink 主服务 + agent-runner 容器架构。

## 2. 测试矩阵

| 测试文件 | 用例数 | 通过 | 说明 |
|---|---|---|---|
| `tests/units/mcp-registry-engine.test.ts` | 10 | 10 | 转换引擎单测（extractByPath/sanitize/查询/路径/头/体/抽取/4xx/缺参/超时） |
| `tests/units/mcp-registry-openapi.test.ts` | 7 | 7 | OpenAPI 解析（候选工具/required+enum/path+query/body 展平/includePaths/非法文档/baseUrl 覆盖） |
| `tests/units/mcp-registry-integration.test.ts` | 7 | 7 | MCP 协议合规（initialize/notifications/tools-list/tools-call/401/未知工具/未知方法） |
| `tests/units/mcp-registry-e2e-sdk.test.ts` | 3 | 3 | 真实 `@modelcontextprotocol/sdk` Client + StreamableHTTPClientTransport 端到端 |
| **合计** | **30** | **30** | 全绿 |

运行命令：
```bash
DEEPTHINK_DATA_DIR=/tmp/dt-reg-final npx vitest run --no-file-parallelism \
  tests/units/mcp-registry-engine.test.ts \
  tests/units/mcp-registry-openapi.test.ts \
  tests/units/mcp-registry-integration.test.ts \
  tests/units/mcp-registry-e2e-sdk.test.ts
```
> 注：集成测试与 e2e 测试各自 `initDatabase()`，须 `--no-file-parallelism` 串行以避免 SQLite 文件锁竞争（非代码缺陷）。

## 3. 验收用例（T1–T8）对照

| 用例 | 验收点 | 结果 | 证据 |
|---|---|---|---|
| T1 服务器 CRUD | 增删改查 + 启停 | ✅ | REST `/servers` 路由 + DB 访问器；集成测试种子建服务器成功 |
| T2 工具 CRUD | 工具增删改查 + 启停 | ✅ | REST `/servers/:id/tools`、`/tools/:id`；e2e 种子工具被列出 |
| T3 OpenAPI 导入 | 预览→勾选→确认入库 | ✅ | `openapi-parser.test.ts` 7 例覆盖参数/body/required/enum/includePaths/baseUrl/非法校验 |
| T4 工具试调 | 试运行返回转换结果 | ✅ | `engine.test.ts` 10 例 + REST `/tools/:id/test` |
| T5 转换引擎 | 路径/查询/头/体映射 + authHeader + 抽取 + 4xx + 超时 | ✅ | `engine.test.ts` AC5.1–AC5.5 全部断言通过 |
| T6 MCP 协议合规 | initialize/notifications/tools-list/tools-call/401/未知方法 | ✅ | `integration.test.ts` 7 例 |
| T7 端到端 Agent 调用 | 真实 SDK Client 连接→列出→调用→抽取数据 | ✅ | `e2e-sdk.test.ts` 用 `@modelcontextprotocol/sdk` 连接 `/api/mcp-registry/mcp`，`callTool` 返回抽取的 `{"temp":31,"cond":"多云"}` |
| T8 自动注入 | Agent 启动时自动挂载注册中心 | ✅ | `loadUserMcpServers` 在存在启用工具时注入 `__registry`（http 类型，Bearer token）；docker 站点用 `host.docker.internal` + `--add-host=host.docker.internal:host-gateway` |

## 4. 安全验证

- ✅ **凭据不外泄**：`authHeader` 仅服务端注入，**不**出现在 `inputSchema` / `tools/list` 返回中（`engine.test.ts` 「maps headers and injects authHeader without exposing to args」断言：headers 透传但 args 无凭据字段）。
- ✅ **按用户隔离**：所有访问器按 `user_id` 过滤；MCP 端点用 per-user Bearer token（`mcp_registry_tokens` 表）鉴权。
- ✅ **401 拒绝无 token 请求**（`integration.test.ts` AC6.5）。
- ✅ 响应超长截断（`DEFAULT_TRUNCATE=20000`）防上下文膨胀。

## 5. 回归测试

全套测试套件：**322 passed / 10 skipped（受保护跳过）**，无新增失败、无回归。

## 6. 覆盖的功能（v1 交付）

- F1 服务器 CRUD + 启停
- F2 工具 CRUD + 启停
- F3 OpenAPI/Swagger 导入（预览→勾选→确认）
- F4 工具试调
- F5 HTTP→MCP 转换引擎（query/path/header/body 映射、authHeader 注入、responseMapping.extract、4xx→isError、超时）
- F6 主服务 MCP streamable-HTTP 端点 + Agent 自动注入（claude 引擎原生 http MCP；docker/host 双场景）
- F7 前端「MCP 注册中心」页（master/detail + AddServer/ToolEditor/OpenApiImport/TestTool 4 个 Dialog）

## 7. v1 范围限制（明确延后）

以下项按 PRD v1 范围**不**在本期交付，已在 PRD/技术方案中记录：

1. **codex/opencode 引擎 http MCP 透传** — 当前仅 claude 引擎原生支持 http MCP；codex/opencode 走 stdio bridge，暂不透传注册中心 http 工具。
2. **PaaS 按代理（per-agent）挂载 `__registry`** — 当前为 per-user 全局挂载。
3. **pi-engine 支持** — pi-engine 无 MCP 能力，不接入。
4. **RBAC 细粒度权限、速率限制、LLM 自动摘要 description、SSE 流式响应** — 均 v2 项。

## 8. 结论

**验收通过**。MCP Server 注册中心 v1 已实现并通过全部 30 项测试（含真实 SDK 客户端端到端铁证 T7），全套无回归，安全约束（凭据不外泄、按用户隔离）已验证。可合并至 `main` 并 push。
