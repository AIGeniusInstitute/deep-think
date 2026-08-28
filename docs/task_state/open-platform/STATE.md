# 任务执行状态：DeepThink 开放平台（Agent Service）

> 分支：`feature/open-platform`（worktree `~/deepthink/.worktrees/open-platform`）
> 需求文档：`docs/prd/open-platform/PRD.md`
> 技术方案：`docs/tech_solution/open-platform/SOLUTION.md`
> 测试报告：`docs/test_report/open-platform/TEST_REPORT.md`

---

## 执行时间线

| 阶段 | 状态 | 说明 |
|---|---|---|
| 0. 创建 worktree | ✅ | `git worktree add`，分支 `feature/open-platform` |
| 1. PRD | ✅ | 5 功能点 + 验收标准 + T1–T20 测试用例 |
| 2. 技术方案 | ✅ | 架构 / 数据模型 / 协议适配 / 计费闭环 / 风险 |
| 3. 编码实施 | ✅ | 后端 + 前端全部完成，见下表 |
| 4. 测试循环 | ✅ | typecheck + build + 1587 单测 + 30 步集成测试全绿 |
| 5. 测试报告 | ✅ | `docs/test_report/open-platform/TEST_REPORT.md` |
| 6. 合并 main + push | ⏳ | 见下方 |

## 编码产物清单

### 后端

| 文件 | 变更 |
|---|---|
| `src/db.ts` | 新增 `api_keys`、`model_pricing` 表 + 7 个 API Key 函数 + 5 个定价函数 + `getOpenPlatformUsage` + `getAgentDefinitionById` |
| `src/open-platform/api-keys.ts` | 密钥生成 / SHA-256 哈希 / 校验（复用参考实现） |
| `src/open-platform/maas.ts` | OpenAI ⇄ Anthropic 协议适配（非流式 + 流式） |
| `src/open-platform/billing.ts` | 前置校验 + 后置计量扣费闭环 |
| `src/open-platform/agent-service.ts` | Agent 执行（SDK query）+ 身份注入（**适配 DeepThink 规范化 `agent_worker_links` 表**） |
| `src/routes/open-platform.ts` | `/v1/*` 对外路由（Bearer 鉴权） |
| `src/routes/open-platform-keys.ts` | API Key 管理路由 |
| `src/routes/open-platform-debug.ts` | 在线调试路由（复用底层执行函数） |
| `src/routes/open-platform-admin.ts` | 用量统计 + 模型定价路由 |
| `src/web.ts` | 挂载 4 个子应用：`/v1`、`/api/open-platform/keys`、`/debug`、`/api/open-platform` |

### 前端

| 文件 | 变更 |
|---|---|
| `web/src/pages/OpenPlatformPage.tsx` | 开放平台页（用量概览 / 在线调试 / Key 管理 / 代码示例） |
| `web/src/App.tsx` | 新增 `/open-platform` 路由 |
| `web/src/components/layout/nav-items.ts` | 新增「开放平台」导航项 |

### 文档

| 文件 | 状态 |
|---|---|
| `docs/prd/open-platform/PRD.md` | ✅ |
| `docs/tech_solution/open-platform/SOLUTION.md` | ✅ |
| `docs/task_state/open-platform/STATE.md` | ✅（本文件） |
| `docs/test_report/open-platform/TEST_REPORT.md` | ✅ |

## 与参考实现（Prime）的差异点

1. **Agent worker 数据模型**：Prime 用非规范化 `agent_workers` 表；DeepThink 用规范化 `agent_worker_links`（`orchestrator_id`/`worker_id` 双 FK），`listAgentWorkers` 返回 `AgentDefinitionRow[]`。`agent-service.ts` 的 `buildWorkerAgents` 直接映射 `AgentDefinitionRow` 字段。
2. **`owned_by` 标识**：Prime 硬编码 `'primeharness'`，DeepThink 改为 `'deepthink'`。
3. **`SCHEMA_VERSION`**：保持 `'56'` 不变（新表用 `CREATE TABLE IF NOT EXISTS` 自动补建，无需迁移）。

## 关键决策记录

- **身份注入**：Agent Service 用对象形式 `systemPrompt { type:'preset', preset:'claude_code', append:'<agent-definition>…<agent-identity-override>…' }`，而非裸字符串，避免 CLAUDE.md 平台默认身份覆盖自定义 Agent 人设。集成测试已验证：人设明确的 Agent（「咖啡小助手」）回答正确、无平台身份泄漏。
- **计费对象**：API Key 属主；admin 与 billing 关闭时豁免（复用 `checkBillingAccess` 语义）。
- **对外 `/v1/*` 与内部 `/debug/*` 复用同一底层执行 + 计费函数**，保证控制台与外部 SDK 行为一致。
