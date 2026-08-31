# 技术方案：DeepThink 平台核心能力开发

> 分支：`feat/platform-capabilities` ｜ 关联 PRD：`docs/prd/platform-capabilities/PRD.md`

## 0. 总体架构决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 原子 step 存储 | **新建 `trace_steps` 表**，而非扩展 `chat_trace_nodes` | 既有 chat_trace_nodes 是"粗粒度 DAG 节点"语义（turn/tool/skill/subagent），原子步骤（thinking/compact/memory）粒度不同、量级更大，混表会污染既有查询；新建表 + 共享 `trace_id` 关联 |
| 全链路 ID | `trace_id`（会话级）+ `span_id`（步骤级，UUIDv7）+ `parent_span_id` | 与既有 `parent_node_id` 并存，不破坏旧链路 |
| JSON Schema 引擎 | `ajv` + `ajv-formats` | 事实标准，零运行时依赖冲突，Draft-07 |
| webhook 出站 | 复用 `url-safety.ts` SSRF 校验 + 自建 HMAC 调用器 | 不引入第三方 webhook 库，Simplicity First |
| 大 I/O 持久化 | `trace_tool_calls.output_ref` 文件路径 + `data/trace-io/{traceId}/{toolUseId}.json` | DB 仅存 ref，避免行膨胀 |
| 普通会话回放 | 复用 Graph `ReplayPlayer` 组件 + 通用 timeline API | 不重复造时间轴组件 |

## 1. P1 — 全过程结构化 Trace（基座）

### 1.1 数据模型（`src/db.ts`）

新建表 `trace_steps`（迁移版本 v54）：
```sql
CREATE TABLE trace_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,           -- 会话级唯一
  span_id TEXT NOT NULL,            -- 步骤级 UUIDv7
  parent_span_id TEXT,              -- 父步骤
  chat_jid TEXT,                    -- 关联会话
  graph_run_id TEXT,                 -- 图执行实例（可空）
  graph_node_id TEXT,
  node_type TEXT NOT NULL,          -- thinking|compact|memory_recall|memory_write|tool_select|llm_call|permission_check|context_audit|turn|tool|skill|subagent|review|goal_check
  title TEXT,
  input_summary TEXT,               -- 截断摘要（<=8KB）
  output_summary TEXT,
  evidence_json TEXT,                -- [{type,ref,detail}]
  output_ref TEXT,                  -- 大 I/O 文件路径
  tokens INTEGER,
  status TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  UNIQUE(trace_id, span_id)
);
CREATE INDEX idx_trace_steps_chat ON trace_steps(chat_jid, started_at);
CREATE INDEX idx_trace_steps_trace ON trace_steps(trace_id, started_at);
```
扩展 `trace_tool_calls`：`ALTER TABLE trace_tool_calls ADD COLUMN output_ref TEXT;`（>64KB 时存 ref）。

### 1.2 StreamEvent 扩展（`src/stream-event.types.ts`，canonical，build 时复制到 src/container/web）

`traceNode` 字段增量（向后兼容，可选）：
```ts
traceNode?: {
  // 既有字段...
  traceId?: string; spanId?: string; parentSpanId?: string;
  evidence?: Evidence[]; outputRef?: string;
}
```
新增 `nodeType` 取值：`'thinking'|'compact'|'memory_recall'|'memory_write'|'tool_select'|'llm_call'|'permission_check'|'context_audit'`。

### 1.3 Allocator 注入（`container/agent-runner/src/trace-node-allocator.ts`）

- `decorate(event)` 的 switch 扩展分支：
  - `thinking_delta` → 产出 `nodeType:'thinking'` traceNode（首 delta 起 span，末 delta/stop 结 span，summary 取前 500 字）。
  - `compact_boundary` → `nodeType:'compact'`，input_summary 含 pre/post token + trigger。
  - `memory_recall` → `nodeType:'memory_recall'`，summary 含召回 memory scope+path 列表。
- 新增 `startLlmCall()/endLlmCall()`：包装 sdkQuery 调用，产出 `llm_call` span（input=prompt 摘要、output=raw response 摘要）。

### 1.4 持久化扩展（`src/chat-trace-persist.ts`）

- 新增 `persistTraceStep(chatJid, event)`：识别新 nodeType，upsert 到 `trace_steps`（best-effort，失败 warn）。
- 在 `src/index.ts:3685,4824` 的 stream event 处理点与 graph-runner 镜像点调用 `persistTraceStep`。
- 工具 I/O 落盘：`upsertTraceToolCall` 检测 input/output > 64KB → 写 `data/trace-io/{traceId}/{toolUseId}.{in|out}.json`，DB 存 `output_ref`。

### 1.5 记忆写入 trace hook

在记忆写入路径（`mcp__deepthink__memory_append` / `Edit CLAUDE.md` 的平台封装层，位于 `src/index.ts` memory 处理段）注入 `memory_write` StreamEvent → allocator → 持久化。记录 scope+path+content 摘要。

### 1.6 编排层 LLM call trace

`src/sdk-query.ts` 的 `sdkQuery()` 增加可选 `traceContext` 参数（traceId/parentSpanId/title）；调用前后发 `llm_call` 事件。supervisor/orchestrator/team/reviewer 调用处透传 traceContext。

### 1.7 Trace 读取 API（`src/routes/chat-trace.ts`）

- `GET /api/groups/:jid/trace/steps?traceId=&nodeType=` → 返回 trace_steps 列表（含 evidence、outputRef）。
- `GET /api/groups/:jid/trace/steps/:spanId/io` → 按 output_ref 读取完整大 I/O。

### 1.8 前端 trace UI（`web/src/components/chat/`）

- `DagView` / `DagNodeDetail` 增量渲染新 nodeType 节点 + evidence 列表 + output_ref 链接。
- 普通会话：`ChatPage` 新增"回放"入口 → 复用 `ReplayPlayer`，数据源改为 `/trace/steps`。

**P1 测试**：扩展 `tests/trace-node-allocator.test.ts` + `tests/chat-trace-store.test.ts` 覆盖新 nodeType、span 链、evidence、大 I/O 落盘。

## 2. P2 — 校验节点与 Hooks

### 2.1 JSON Schema 引擎
- `package.json` 加 `ajv`+`ajv-formats` 依赖（`--no-save` 临时装后 `git checkout -- node_modules` 恢复符号链接，正式提交改 package.json）。
- `src/graph-engineering/json-schema-validator.ts`（新）：`compileSchema(schema)` → `validate(data)` → `{valid, errors}`。

### 2.2 validate 节点
- `graph-types.ts`：`NodeType` 加 `'validate'`；`GraphNode` 已有 `outputSchema` 现在被消费；新增 `onFail`∈`{fail,retry,fallback}` + `fallbackValue?`。
- `graph-registry.ts validateDefinition`：校验 `outputSchema` 合法性（ajv.compile 不抛错）。
- `graph-runner.ts runValidateNode()`：取 `state[node_<upstream>_output]` → JSON.parse → validate → 产 `GraphValidationResult`，失败按 onFail 处理（retry 回退上游，attempt++，GATE_RETRY_MAX 复用）。

### 2.3 校验节点 UI
- `web/src/components/workflow/NodePalette.tsx` + `workflow-constants.ts`：加 validate 节点（图标 `ShieldCheck`）。
- `WorkflowNodeInspector.tsx`：加 `ValidateSection`——Monaco JSON schema 编辑器 + onFail 选择 + 上游节点选择。

### 2.4 Open Platform 结果校验 seam
- `src/open-platform/api-keys.ts` / `agent-service.ts`：DB 表加列 `validation_schema TEXT`、`validation_hook_url TEXT`、`hook_secret TEXT`、`hook_failure_action TEXT DEFAULT 'passthrough'`、`on_schema_fail TEXT DEFAULT 'fail'`。
- `src/open-platform/result-validation.ts`（新）：`validateResult(policy, resultText)` → JSON.parse + ajv + 调 hook。
- `maas.chatCompletion` / `agent-service.runAgent` 返回前插入校验；失败按 `on_schema_fail`/`hook_failure_action` 处理（422 错误 / 重试 provider / 透传）。

### 2.5 业务 webhook 出站调用器
- `src/open-platform/result-hooks.ts`（新）：`callValidationHook(url, secret, payload)`：
  - SSRF 校验复用 `url-safety.ts`。
  - HMAC-SHA256 签名 `X-DT-Signature: t=...&v1=...`（类 Stripe）。
  - 超时 10s，重试 3 次指数退避（1s/2s/4s）。
  - 幂等：payload 带 `request_id`，DB `webhook_calls` 表去重（`UNIQUE(policy_id, request_id)`）。
- 校验管线：`validateResult` 串联 schema→hook，结果写入 trace（复用 P1 trace_steps，nodeType 取 `tool_select` 不合适，新增 `validation` nodeType）。

**P2 测试**：`tests/units/json-schema-validator.test.ts`（合法/非法 schema、缺失字段）；`tests/api/open-platform-validation.test.ts`（422、hook mock、超时重试）。

## 3. P3 — 测试与评测

### 3.1 OpenAPI 接口测试
- `tests/api/open-platform.test.ts`（新）：Hono app `request()` 内存级测试，覆盖 `/v1/models`、`/v1/chat/completions`（mock provider）、stream、401/403/402。
- provider mock：`maas.resolveProvider` 注入 stub。

### 3.2 断言扩展
- `harness-eval.ts`：`scoreAssertion` 扩展 kind：`json_schema`（ajv）、`json_path`（lodash.get 等价，自写以避依赖）、`numeric_range`、`llm_judge`（sdkQuery 单轮评分）。
- YAML schema 文档更新。

### 3.3 在线回放
- `src/routes/chat-trace.ts`：`GET /api/groups/:jid/trace/timeline` → 按 started_at 排序的 step 列表（含 status）。
- 前端普通会话复用 `ReplayPlayer`。

### 3.4 最小回归 CI
- `vitest.config.ts`：`projects` 或 test name pattern 区分 smoke。
- `Makefile`：`test-smoke: vitest run --grep @smoke`。
- `.github/workflows/test.yml`（新）：PR 触发 `make test-smoke`。

### 3.5 评测看板
- `web/src/pages/HarnessPage.tsx`：加 `Dashboard` tab，消费 `harness.ts store.getEvalRuns`。
- `web/src/components/harness/EvalDashboard.tsx`（新）：recharts 趋势线 + 对比柱 + 热力图（自写 CSS grid）+ 失败钻取。

**P3 测试**：接口测试本身即验收；`tests/units/harness-eval.test.ts` 扩展新断言用例。

## 4. P4 — Skills 与 CLI

### 4.1 真实调试
- `skill-ai.ts debugSkill()`：新增 `mode:'real'` 参数 → 起 sdkQuery 会话，`allowedTools` 取 skill frontmatter `allowed-tools`，cwd 指向临时隔离目录，skill 目录挂载。返回真实工具 trace。
- 复用 P1 trace，chat_jid=`skill-debug:{skillId}:{ts}`。

### 4.2 `/skill` 命令
- `src/index.ts handleCommand()`：加 `/skill <name>` 分发 → 解析 skill → 注入 skill 执行 → trace nodeType='skill'。

### 4.3 版本管理
- DB：`skill_versions` 表（id, skill_id, user_id, content, message, created_at）。
- `src/routes/skills.ts`：`GET /:id/versions`、`/:id/versions/:vid/diff`、`POST /:id/versions/:vid/rollback`。
- `skill-content-utils.ts writeSkillContent`：每次写前 snapshot 当前版本。

### 4.4 工具总览
- `web/src/pages/ToolsOverviewPage.tsx`（新）：聚合 user skills + plugin catalog + MCP registry tools，跳转各管理页。

**P4 测试**：`tests/units/skill-versions.test.ts`；`tests/api/skill-debug.test.ts`。

## 5. 实施顺序与里程碑

1. P1.1-1.7 后端 trace → P1.8 前端 → P1 测试 → commit
2. P2.1-2.2 引擎+节点 → P2.3 UI → P2.4-2.5 OP+hook → P2 测试 → commit
3. P3.1-3.5 → P3 测试 → commit
4. P4.1-4.4 → P4 测试 → commit
5. 全量 `make test` + `make test-smoke` → 测试报告 → 合并 main push

## 6. 回滚策略
- 每阶段独立 commit，可单独 revert。
- DB 迁移为增量 ALTER + 新建表，不 DROP 既有列；回滚仅丢失新表数据，不影响旧功能。
- `ajv` 依赖回滚：删 package.json 依赖 + validator 文件即可，不影响既有 graph 流。
