# MCP Server 注册中心 — 执行状态

> 分支：`feat/mcp-registry` · 起始：2026-08-26

## 里程碑进度
- [x] M0 worktree + PRD + 技术方案
- [x] M1 DB 表 + 访问器 + zod + REST CRUD（F1,F2）
- [x] M2 转换引擎 + 试调 API（F4,F5）
- [x] M3 OpenAPI 解析 + 导入（F3）
- [x] M4 MCP 端点 + 自动注入 + docker 回连（F6）+ 端到端
- [x] M5 前端页（F7）
- [x] M6 codex/opencode 透传 + 回归 + test_report
  - 注：codex/opencode 透传、PaaS 按代理挂载、pi-engine 支持按 PRD v1 范围明确 **延后**，见 test_report §7

## 日志
- 2026-08-26 23:10 完成 PRD + 技术方案，确定 Path A（主服务 streamable-HTTP 端点）。开始 M1。
- 2026-08-26 23:20 完成 M1-M3：3 张表 + 访问器 + zod schema + REST CRUD + 转换引擎 + OpenAPI 解析器。
- 2026-08-26 23:26 完成 M4-M5：MCP JSON-RPC 端点 + 自动注入（loadUserMcpServers 注入 `__registry` + docker `--add-host`）+ 前端页（master/detail + 4 Dialog）。
- 2026-08-26 23:34 测试全绿：engine 20 + openapi 7 + integration 7 + e2e-sdk 3 = 30/30（`--no-file-parallelism`，临时 DATA_DIR）。全套回归 322 passed/10 skipped，无回归。
- 2026-08-26 23:38 task_state 更新完成，撰写 test_report，准备 commit + merge main + push。
