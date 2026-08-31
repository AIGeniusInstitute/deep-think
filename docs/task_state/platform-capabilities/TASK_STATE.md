# 任务状态：平台核心能力开发

> 分支：`feat/platform-capabilities` ｜ worktree：`.worktrees/feat-platform-capabilities`

## 总进度

| 阶段 | 状态 | 测试 | 说明 |
|---|---|---|---|
| P1 全过程 Trace（基座）—后端 | ✅ 完成 | ✅ 27/27 + 全量 1594/0 | thinking/compact/memory_recall 持久化 + span 链路 + 大 I/O 落盘 + API |
| P1 前端 trace UI | ⏳ 待开始 | — | DagView 新 nodeType 渲染 + 普通会话 ReplayPlayer |
| P1 memory_write / llm_call trace | ⏳ 待开始 | — | memory 写入 hook + sdkQuery 编排层 trace |
| P2 校验节点与 Hooks | ✅ 完成 | ✅ 16/16 | ajv validator + validate 节点 + OpenPlatform seam + webhook + 幂等 + 节点 UI |
| P3 测试与评测 / 看板 | ✅ 完成（在线回放复用 P1 timeline） | ✅ 83 smoke + 1629 全量 | 断言扩展 + 评测看板 + CI 最小回归 |
| P4 Skills 与 CLI | ✅ 完成（/skill IM 命令待 IM→user 解析） | ✅ 5/5 | real 调试 + skill_versions + 工具总览 |

## P1 后端已落地清单

### 数据模型（src/db.ts）
- [x] v56→v57 迁移：新建 `trace_steps` 表（trace_id/span_id/parent_span_id/evidence_json/output_ref）
- [x] `trace_tool_calls` 加 `output_ref` 列（大 I/O 落盘 ref）
- [x] `chat_trace_nodes` 加 trace_id/span_id/parent_span_id/evidence_json/output_ref 列
- [x] `upsertTraceStep` / `listTraceSteps` / `listTraceStepsByTrace` / `getTraceStep` 函数
- [x] `upsertChatTraceNode` 扩展写入 span 链路字段
- [x] `upsertTraceToolCall` 扩展写入 output_ref

### 类型与 allocator（stream-event.types.ts + trace-node-allocator.ts）
- [x] traceNode.nodeType 扩展 9 种原子类型（thinking/compact/memory_recall/memory_write/tool_select/llm_call/permission_check/context_audit/validation）
- [x] traceNode 加 traceId/spanId/parentSpanId/evidence/outputRef 字段
- [x] canonical 同步到 container/agent-runner + web 副本
- [x] allocator 进程级 traceId + span 生成
- [x] decorate 新增 thinking_delta（流式累积）/ compact_boundary / memory_recall 分支
- [x] 通用 stamp：所有 traceNode 写 traceId/spanId/parentSpanId

### 持久化与 API（chat-trace-persist.ts + routes/chat-trace.ts）
- [x] persistTraceNodeFromStreamEvent 区分粗粒度（chat_trace_nodes）/原子（trace_steps）路由
- [x] 大 I/O（>64KB）落盘到 data/trace-io/{traceId}/{spanId}.{side}.json，DB 存 output_ref
- [x] GET /api/groups/:jid/trace/steps（可选 nodeType 过滤）
- [x] GET /api/groups/:jid/trace/steps/:spanId/io（路径穿越防护读取大 I/O）
- [x] GET /api/groups/:jid/trace/timeline（粗粒度+原子合并时间轴）

### 测试
- [x] trace-node-allocator.test.ts +6 用例（thinking/compact/memory_recall/span 链路/自动 turn）
- [x] chat-trace-store.test.ts +4 用例（trace_steps upsert/merge/evidence/大 I/O 落盘/路由）
- [x] 修复 workflows + super-agent-team-trace 的 schema_version 断言 56→57

## 验证结果
- `npx tsc --noEmit`（src + agent-runner）：exit 0
- `npx vitest run`（全量 Node 22）：1610 passed / 16 skipped / **0 failed**（P2 新增 16 用例：json-schema-validator 7 + open-platform-validation 9）

## P2 已落地清单

### 引擎与节点（graph-engineering/）
- [x] `json-schema-validator.ts`（新）：ajv Draft-07 + formats，`validateJson`(no-throw) / `isSchemaValid` / `compileSchema`
- [x] `graph-types.ts`：`GraphNodeType` 加 `'validate'`；`GraphNode` 加 `onFail`∈{fail,retry,fallback} + `fallbackValue?`，`outputSchema` 被消费
- [x] `graph-runner.ts`：`runValidateNode` 取 `state[node_<upstream>_output]`→JSON.parse→validate→`GraphValidationResult`；`applyValidateOnFail`（fail/retry 返回 failed，fallback 写 fallbackValue+completed）
- [x] `graph-registry.ts validateDefinition`：validate 节点 outputSchema 非空且可编译
- [x] db.ts：`GraphNodeRunRow.node_type` + `'validate'`；v57 graph_node_runs CHECK 重建

### Open Platform 结果校验（open-platform/）
- [x] db.ts v57→v58 迁移：`api_keys`+`agent_definitions` 加 `validation_schema/validation_hook_url/hook_secret/hook_failure_action/on_schema_fail` 列；新建 `webhook_calls` 表（幂等 UNIQUE(policy_type,policy_id,request_id)）
- [x] `ValidationPolicy` 类型 + `getApiKeyValidationPolicy`/`getAgentDefValidationPolicy`/`updateApiKeyValidation`/`updateAgentDefValidation`/`recordWebhookCall`/`listWebhookCalls`
- [x] `result-hooks.ts`（新）：HMAC-SHA256 签名 + 10s 超时 + 3 次指数退避重试 + SSRF 复用 url-safety + webhook_calls 幂等去重
- [x] `result-validation.ts`（新）：schema→hook 两段管线，结构化 evidence（validation trace step 契约）+ `decideValidationAction`（pass/reject/retry 决策）
- [x] `routes/open-platform.ts`：`authenticate` 透传 keyId；`/chat/completions` 与 `/agents/:id/chat/completions` 非流式路径插入 `applyResultValidation`（pass/reject/422/bounded retry + X-Validation header）
- [x] 管理路由：`PATCH /api/open-platform/keys/:id/validation` + `PATCH /api/paas/agents/:id/validation`（schema 编译时校验 + action 白名单）

### 测试
- [x] `tests/units/json-schema-validator.test.ts` 7 用例（合法/非法 schema、缺失字段、format、schemaPath 证据）
- [x] `tests/open-platform-validation.test.ts` 9 用例（422、passthrough、retry、hook accept/reject、timeout 3×、幂等去重、HMAC 签名）
- [x] schema_version 断言 57→58

### 前端（web/src/components/workflow/ + chat/）
- [x] `workflow-constants.ts`：GraphNodeType + `'validate'`；NODE_TYPE_COLORS/LABEL_ZH + validate；PALETTE_TYPES + validate；`defaultNodeFields` validate 默认（outputSchema/onFail/fallbackValue/upstreamNodeId）
- [x] `WorkflowNodeInspector.tsx`：`ValidateSection`——Monaco schema 编辑器（@monaco-editor/react）+ 实时 JSON 合法性指示 + onFail 选择器（fail/retry/fallback）+ fallbackValue 兜底 + 上游节点选择
- [x] `chat/DagView.tsx` + `DagNodeDetail.tsx`：NODE_TYPE_COLORS/LABELS 补全 9 种原子类型；DagNodeDetail 新增证据链渲染（evidence_json 解析）+ 大 I/O output_ref 展示
- [x] `stores/chat.ts`：TraceNodeEntry.node_type 扩展 15 种 + trace_id/span_id/parent_span_id/evidence_json/output_ref 字段
- [x] 前端 `npx tsc --noEmit`：exit 0

## P3 已落地清单

### 评测断言扩展（harness-eval.ts）
- [x] `AssertionKind` + `json_schema`/`json_path`/`numeric_range`/`llm_judge`
- [x] `EvalAssertion` + operator/expected/min/max 字段；`parseCaseYaml` 解析新字段
- [x] `extractJsonPath`（$.a.b[0].c 点/括号路径，无依赖）
- [x] `scoreAssertion` 新增 4 类（json_schema 复用 validateJson、json_path equals/contains/exists、numeric_range 边界、llm_judge sync 占位）
- [x] `scoreCaseAsync` + `LlmJudge` 注入（llm_judge 异步评判，错误捕获）
- [x] `tests/units/harness-eval.test.ts` +11 用例（json_schema pass/fail/non-JSON、json_path equals/contains/exists、numeric_range in/out、extractJsonPath、scoreCaseAsync judge/no-judge/error）

### 评测看板（web/src/components/harness/EvalDashboard.tsx）
- [x] `EvalDashboard.tsx`：跨版本 pass-rate 趋势（recharts LineChart，按版本 verdict 着色点）+ 通过/失败堆叠 BarChart + 最新版本用例明细表 + 汇总卡（版本数/最新 pass-rate/improved/regressed 结论）
- [x] `HarnessPage.tsx` 顶部 tab：「Self-Evolving Harness」/「评测看板」
- [x] 数据源 `getEvalRuns()`（GET /api/harness/eval-runs）

### CI 最小回归
- [x] `Makefile test-smoke`：6 个纯逻辑单测文件，< 60s（实测 83 用例 ~1s tests）
- [x] `.github/workflows/test.yml`：push/PR → Node 22 → smoke 集（pull_request 门禁）
- [x] 在线回放：复用 P1 `GET /trace/timeline`（粗粒度+原子合并时间轴），ReplayPlayer 前端归 P1

### 验证结果（P3 后）
- `npx tsc --noEmit`（src + agent-runner + web）：exit 0
- `npx vitest run` 全量：1629 passed / 16 skipped / **0 failed**
- smoke 集：83 passed / < 60s

## P1 剩余项（后续补）
1. **前端 trace UI**：`web/src/components/chat/DagView.tsx` / `DagNodeDetail.tsx` 渲染新原子 nodeType + evidence 列表；普通会话接入 `ReplayPlayer`（数据源 /trace/timeline）。
2. **memory_write trace**：memory_append/MCP 工具写入路径注入 trace_step（需 traceContext 跨进程传递）。
3. **llm_call trace**：sdk-query.ts 加可选 traceContext 参数，supervisor/orchestrator/team/reviewer 调用处透传，产出 llm_call trace_step（编排决策溯源）。

## 环境备忘
- worktree node_modules → 符号链接主仓库（`ln -sfn /home/me/deepthink/node_modules`）
- web/node_modules → 符号链接（前端测试需要）
- 测试用 Node 22（better-sqlite3 binding 编译于 v22.23.1，NODE_MODULE_VERSION 127）

## P4 已落地清单

### Skills 在线调试（skill-ai.ts + routes/skills.ts）
- [x] `debugSkill` 加 `mode: 'ai'|'real'`：real 模式以 skill 内容为 systemPrompt + test_input 为 user turn 真实执行（sdkQueryMessages），ai 模式保留预测式 DEBUG_PROMPT
- [x] `POST /api/skills/:id/debug` 透传 `mode` 字段，响应含 `mode`

### skill_versions 版本管理（db.ts + routes/skills.ts）
- [x] v58 迁移：`skill_versions` 表（skill_id/user_id/version/content/content_hash/notes，UNIQUE(skill_id,user_id,version)）
- [x] `createSkillVersion`（自动递增 version + sha256 hash）/`listSkillVersions`（newest first）/`getSkillVersion`
- [x] `GET /api/skills/:id/versions` · `POST /api/skills/:id/versions`（快照当前内容）· `POST /api/skills/:id/versions/:version/restore`（回滚前自动 backupSkillContent）
- [x] `tests/skill-versions.test.ts` 5 用例（自增/列表/按版本取/用户隔离/缺失返回 null）

### 工具总览（web/src/pages/ToolsOverviewPage.tsx）
- [x] 统一视图：Skills 网格（启用/禁用/source/allowedTools/版本快照数 badge，调用 /api/skills/:id/versions）+ 汇总卡 + MCP 服务器入口
- [x] 路由 `/tools`（App.tsx lazy 注册）

### 验证结果（P4 后）
- `npx tsc --noEmit`（src + agent-runner + web）：exit 0
- `npx vitest run` 全量：1634 passed / 16 skipped / **0 failed**
- smoke 集：83 passed / < 60s

## P4 未完成（文档化）
- `/skill <id> <input>` IM 斜杠命令：需 IM sender → DeepThink userId 解析器（group.owner_im_id 是 IM id 非 user id），风险较高，按 Surgical Changes 原则暂缓；web 侧 `/tools` 页 + `/skill_evolution` 命令已覆盖 Skill 调用面。
