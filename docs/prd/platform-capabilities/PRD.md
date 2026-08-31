# PRD：DeepThink 平台核心能力开发（Skills/CLI · 校验节点/Hooks · 测试评测 · 评测看板 · 全过程结构化 Trace）

> 分支：`feat/platform-capabilities` ｜ worktree：`.worktrees/feat-platform-capabilities`
> 创建日期：2026-08-31 ｜ 负责人：DeepThink 自主交付

## 1. 背景与目标

平台需补齐五大基础能力，使 Agent 从"能跑"升级为"可观测、可校验、可评测、可溯源"：

1. **Skills 与 CLI**：在线注册/调试 Skills，支持 CLI 与 Chat 交互接入。
2. **校验节点与 Hooks**：UI 可配置的结果校验节点（JSON Schema），业务逻辑校验通过 Hooks 交给业务系统。
3. **测试与评测**：标准化自动化测试体系——① OpenAPI 接口自动化 ② 模型返回业务规则校验 ③ 全链路埋点+在线回放 ④ 用例集沉淀与最小化回归。
4. **评测功能**：评测看板，判断 Agent 效果进步/退化。
5. **全过程结构化 Trace**：模型推理、工具调用 I/O、上下文压缩、记忆读写、LLM 执行 I/O、工具选择，每个原子步骤结构化 JSON、可溯源、判断有证据。

## 2. 现状基线（探查结论摘要）

### 2.1 已有
- Skills：在线创建/编辑/优化/上传/调试、skills.sh 搜索安装、Plugin marketplace 不可变 catalog + per-user runtime materialize、Plugin slash 命令索引+DMI 展开、MCP Registry（HTTP→MCP+OpenAPI 导入）。
- 评测：harness-eval（YAML 用例+4 种断言+单轮 sdkQuery）+ harness-meta-loop（propose→eval→judge→promote/rollback）+ harness-registry（版本快照/diff/回滚）。5 个 YAML 用例已沉淀。
- Trace：`chat_trace_nodes`/`loop_trace_nodes`/`trace_tool_calls`/`graph_node_runs` 四表 + `StreamEvent.traceNode` 载体 + `TraceNodeAllocator` span 树 + `persistTraceNodeFromStreamEvent` 持久化 + Graph `ReplayPlayer` 时间轴回放 + chat-trace DAG UI。
- 测试：vitest 单元测试约 110 文件，harness 三件套有专属单测。
- Open Platform：`/v1/chat/completions`、`/v1/agents/:id/chat/completions`、`/v1/models` 已实现（MaaS + Agent-as-a-Service + 计费）。

### 2.2 缺口（本次必须补齐）
- **Skills**：`debugSkill` 是"假调试"（`sdkQuery maxTurns:1 allowedTools:[]`，无真实工具执行）；无 `/skill` slash 命令；无 skill 版本管理；MCP Registry 与 Skill 体系割裂无统一面；无平台 CLI skill 子命令；无 skill 执行 trace。
- **校验/Hooks**：无 JSON Schema 校验引擎（未引入 ajv）；`GraphNode.outputSchema/inputSchema` 声明但 runner 不消费、UI 无编辑器；Open Platform 返回结果直接回传无校验 seam；无业务系统 webhook 回调机制（无 webhookUrl 字段、无出站调用器、无 HMAC/超时/重试/幂等）；校验结果无持久化。
- **测试评测**：`/v1/*` 零接口测试；harness 断言种类太少（无 JSON 结构/schema/LLM-as-judge/数值比较），仅单轮无工具；普通会话无时间轴回放；无端到端 traceId 贯穿；无接口级用例集与最小回归机制；`.github/workflows` 仅 release.yml，无 CI 测试门禁。
- **评测看板**：HarnessPage 仅版本/提案管理；`/api/harness/eval-runs` 数据未被前端消费成图表；无 pass 率趋势、跨版本对比、用例维度钻取、失败归因。
- **Trace**：不覆盖 thinking/compact/memory_recall/memory_write/tool_select/llm_call 原子步骤（无 traceNode 无持久化）；无 span_id/parent_step_id 全链路；普通 turn/tool 节点无 evidence/provenance 字段；编排决策（supervisor pre-dispatch/orchestrator plan/team decompose）无 trace；工具 I/O 截断 64KB。

## 3. 需求拆解、验收标准与测试用例

### 能力一：Skills 与 CLI

#### S1.1 真实工具链 Skill 调试
- **需求**：`POST /api/skills/:id/debug` 支持"真实调试模式"——在隔离 sandbox agent 会话中以指定 skill 目录 + 受控工具权限（`allowed-tools` frontmatter 白名单）执行，产出真实工具调用 trace，而非纯文本模拟。
- **验收标准**：
  - AC1.1.1：对一个含 `Bash`/`Read` 工具引用的 skill 调试，返回结果包含至少 1 条真实工具调用记录（toolName + input + output）。
  - AC1.1.2：`allowed-tools` frontmatter 声明的工具白名单在调试会话中被强制执行（白名单外工具调用被拒绝并记录）。
  - AC1.1.3：调试会话产生的 trace 落入 `chat_trace_nodes`/`trace_tool_calls`（chat_jid 约定 `skill-debug:{skillId}:{ts}`），可在 trace UI 查看。
- **测试用例**：
  - TC1.1.1：构造一个调用 `Read` 工具的 skill，debug 返回 output 非空且 `trace_tool_calls` 新增 1 行 tool_name='Read'。
  - TC1.1.2：skill 声明 `allowed-tools: [Read]`，调试中模型尝试调 `Bash` 时被拒绝（permission_denied 入 trace）。

#### S1.2 `/skill` slash 命令
- **需求**：在 IM/Web Chat 中支持 `/skill <name> [args]` 显式触发某 skill 运行（不依赖模型自主决策）。
- **验收标准**：
  - AC1.2.1：`/skill <name>` 在 `handleCommand` 分发中识别，未找到 skill 时返回明确错误。
  - AC1.2.2：触发后该 skill 在当前会话以受控权限执行，产出 trace。
- **测试用例**：
  - TC1.2.1：`/skill nonexistent` 返回 "skill not found" 且不中断会话。
  - TC1.2.2：`/skill <valid>` 执行后 trace 出现 nodeType='skill' 节点。

#### S1.3 Skill 版本管理
- **需求**：用户级 skill 支持版本快照（每次保存生成版本）、版本列表、diff、回滚。
- **验收标准**：
  - AC1.3.1：`GET /api/skills/:id/versions` 返回版本列表（id, createdAt, message）。
  - AC1.3.2：`GET /api/skills/:id/versions/:vid/diff` 返回与当前版本的 diff。
  - AC1.3.3：`POST /api/skills/:id/versions/:vid/rollback` 回滚到指定版本。
- **测试用例**：TC1.3.1 连续保存 3 次→版本列表≥3；TC1.3.2 回滚到 v1 后内容等于 v1。

#### S1.4 统一工具总览
- **需求**：前端提供"工具/Skill 总览"页，聚合 user skills + plugin skills + MCP registry tools。
- **验收标准**：AC1.4.1 总览页分三段列出三类资源，每项可跳转对应管理页。

> CLI 子命令（`deepthink skill debug/list`）作为 S1.5 可选项，优先级低于 Web 能力；如时间允许再补。

### 能力二：校验节点与 Hooks

#### V2.1 JSON Schema 校验引擎
- **需求**：引入 `ajv`，在 graph 校验节点与 Open Platform 结果校验处消费 `outputSchema`。
- **验收标准**：
  - AC2.1.1：`graph-types.ts` 新增 `validate` 节点类型，`outputSchema` 为合法 JSON Schema Draft-07。
  - AC2.1.2：`validateDefinition` 校验 `outputSchema` 本身合法性（非法 schema 注册即拒）。
  - AC2.1.3：`graph-runner` 运行 validate 节点时对上游 `state[node_<id>_output]` 做 `JSON.parse` + ajv 校验，输出 `GraphValidationResult`。
- **测试用例**：
  - TC2.1.1：schema `{type:'object',required:['x']}` + 上游输出 `{"x":1}` → pass；`{"y":1}` → fail 且 error 含 "missing x"。
  - TC2.1.2：非法 schema（`{type:'notAType'}`）注册被 `validateDefinition` 拒绝。

#### V2.2 校验节点 UI
- **需求**：`NodePalette` 新增 validate 节点；`WorkflowNodeInspector` 新增 schema 编辑器（Monaco JSON）+ 失败动作选择（fail / retry-upstream / fallback-default）。
- **验收标准**：AC2.2.1 画布可拖入 validate 节点；AC2.2.2 Inspector 可编辑 schema 并保存；AC2.2.3 失败动作可配置且持久化到 graph 定义。

#### V2.3 Open Platform 结果校验 seam
- **需求**：API Key 或 Agent 定义可挂载"结果校验策略"（JSON Schema + 失败动作）。
- **验收标准**：
  - AC2.3.1：`/v1/chat/completions` 与 `/v1/agents/:id/chat/completions` 在返回前执行校验；校验失败按策略（422 返回错误 / 重试 / 透传）。
  - AC2.3.2：校验结果（schema 合规性、错误明细）写入 trace。
- **测试用例**：TC2.3.1 Agent 挂载 schema 要求 `{"summary":string}`，provider 返回无 summary → 422 + 错误体含 ajv 错误路径。

#### V2.4 业务系统 Hooks（webhook）
- **需求**：per API Key / per Agent 配置 `validationHookUrl` + HMAC secret；结果产出后 POST 给业务系统，业务系统返回 `{pass:boolean, reason?:string}` 决定是否放行。
- **验收标准**：
  - AC2.4.1：webhook 出站调用器支持 HMAC-SHA256 签名头、超时（默认 10s）、重试（3 次指数退避）、幂等（基于 request_id 去重）。
  - AC2.4.2：业务系统返回非 2xx 或超时按 `hookFailureAction`（fail / skip / passthrough）处理。
  - AC2.4.3：hook 调用记录（request/response/latency/status）写入 trace + DB。
- **测试用例**：
  - TC2.4.1：mock 业务系统返回 `{"pass":false,"reason":"rule X"}` → 主链路按 fail 策略阻断，trace 记 hook 调用。
  - TC2.4.2：业务系统超时 → 重试 3 次后按 skip/passthrough 处理，trace 记 3 次尝试。

#### V2.5 校验管线串联
- **需求**：schema 校验 → hook 校验串联，都过才返回结果。
- **验收标准**：AC2.5.1 管线顺序固定（schema 先 hook 后），任一失败即按该环节策略处理；AC2.5.2 管线总结果持久化。

### 能力三：测试与评测体系

#### T3.1 OpenAPI 接口自动化
- **需求**：为 `/v1/*` 与核心 `/api/*` 建接口级测试，覆盖鉴权（401/403/scope）、流式/非流式、错误码、计费扣减。
- **验收标准**：
  - AC3.1.1：`tests/api/open-platform.test.ts` 覆盖 `/v1/models`、`/v1/chat/completions`（stream + non-stream）、`/v1/agents/:id/chat/completions`。
  - AC3.1.2：错误码矩阵用例（无 API key→401、scope 不足→403、余额不足→402/计费拒绝）。
- **测试用例**：TC3.1.1 无 key 请求 /v1/chat/completions → 401；TC3.1.2 余额=0 → 计费拒绝；TC3.1.3 stream 响应解析出 SSE delta。

#### T3.2 模型返回业务规则校验扩展
- **需求**：harness-eval 断言扩展为：`json_schema` / `json_path` / `numeric_range` / `llm_judge`（在现有 contains/not_contains/regex/no_error 基础上）。
- **验收标准**：
  - AC3.2.1：YAML 用例支持 `assertions[].kind: json_schema` 等新类型。
  - AC3.2.2：`scoreAssertion` 对新类型正确打分。
- **测试用例**：TC3.2.1 `json_schema` 断言对合法/非法 JSON 一一通过/失败。

#### T3.3 全链路埋点 + 在线回放
- **需求**：普通 Agent 会话支持时间轴回放（复用 Graph `ReplayPlayer`）；引入端到端 `traceId` 贯穿 IM→queue→container→agent→tool→IM。
- **验收标准**：
  - AC3.3.1：普通会话 trace 节点带 `traceId`，全链路同 id。
  - AC3.3.2：Chat 页可打开回放时间轴，scrubber 拖动展示各步骤状态。
- **测试用例**：TC3.3.1 一次含工具调用的会话，所有 trace 节点 traceId 一致；TC3.3.2 回放时间轴节点数 ≥ 实际步骤数。

#### T3.4 用例集沉淀 + 最小化回归
- **需求**：接口用例集支持 `priority`（smoke/full）标签与 `--smoke` 子集运行；CI gate。
- **验收标准**：
  - AC3.4.1：`vitest.config` 或自定义 runner 支持 `smoke` 过滤。
  - AC3.4.2：`.github/workflows/test.yml` 在 PR 时跑 `make test-smoke` 门禁。
- **测试用例**：TC3.4.1 `make test-smoke` 仅跑 smoke 用例且 < 60s。

### 能力四：评测看板

#### E4.1 评测看板页
- **需求**：新增 `/harness` 看板 tab，消费 `/api/harness/eval-runs`。
- **验收标准**：
  - AC4.1.1：pass 率趋势曲线（recharts，按 version/case 维度）。
  - AC4.1.2：跨版本 pass 率对比柱状图。
  - AC4.1.3：用例维度热力图（case × version 红绿矩阵）。
  - AC4.1.4：失败用例钻取（点击 cell → 该 case 该版本 eval run 详情 + trace 链接）。
- **测试用例**：TC4.1.1 页面加载后图表节点数 = 版本数；TC4.1.2 点失败 cell 跳转 trace。

### 能力五：全过程结构化 Trace

#### R5.1 原子 step 模型与持久化
- **需求**：扩展 `node_type` 枚举或新建 `trace_steps` 表，覆盖 `thinking`/`compact`/`memory_recall`/`memory_write`/`tool_select`/`llm_call`/`permission_check`/`context_audit`。
- **验收标准**：
  - AC5.1.1：`stream-event.types.ts` 的 traceNode 支持 新 `nodeType` 值。
  - AC5.1.2：`TraceNodeAllocator.decorate` 对 thinking_delta/compact_boundary/memory_recall 注入 traceNode 并持久化到 DB。
  - AC5.1.3：记忆写入产生 `memory_write` trace 节点（记录 scope+path+content 摘要）。
  - AC5.1.4：编排层 sdkQuery 调用（supervisor/orchestrator/team/reviewer）产生 `llm_call` trace 节点，持久化原始 prompt 摘要 + raw response 摘要。
- **测试用例**：
  - TC5.1.1：触发 compact 后 `trace_steps` 新增 1 行 nodeType='compact' 且含 pre/post token。
  - TC5.1.2：记忆写入后新增 `memory_write` 节点含 scope/path。

#### R5.2 全链路可溯源 ID
- **需求**：引入 `traceId`（会话级唯一）+ `spanId`（步骤级唯一）+ `parentSpanId`。
- **验收标准**：
  - AC5.2.1：每个 trace 节点带 `traceId`+`spanId`+`parentSpanId`，形成树。
  - AC5.2.2：trace API 返回完整树结构，前端 DAG 正确渲染父子关系。
- **测试用例**：TC5.2.1 一次 turn 的 thinking→tool_select→tool_use→tool_result 链路 spanId 链 parentSpanId 正确串联。

#### R5.3 证据溯源字段
- **需求**：判断类节点（gate/supervisor/eval）支持 `evidence` 结构化字段（type + ref + detail）。
- **验收标准**：
  - AC5.3.1：gate/supervisor 节点 trace 携带 `evidence[]`，每条含 `{type, ref, detail}`。
  - AC5.3.2：trace UI 可展示某判断节点的 evidence 列表，ref 可跳转（trace 节点/文件/日志）。
- **测试用例**：TC5.3.1 gate 节点 evidence 至少 1 条且 ref 指向真实 trace 节点 id。

#### R5.4 工具 I/O 完整性
- **需求**：`trace_tool_calls` 的 64KB 截断改为"截断 + 完整落盘到文件 + trace 记录 file ref"。
- **验收标准**：AC5.4.1 大输出（>64KB）工具结果 trace 节点含 `outputRef` 文件路径，可按需读取完整内容。

## 4. 分阶段实施计划（依赖排序）

> Trace（能力五）是基础，解锁测试回放（T3.3）与校验结果持久化（V2.3/V2.4）。按依赖关系分四阶段。

| 阶段 | 能力点 | 依赖 | 产出 |
|---|---|---|---|
| P1 基座 | R5.1 R5.2 R5.3 R5.4 | 无 | 原子 step 持久化 + 全链路 traceId + evidence + 工具 I/O 完整落盘 |
| P2 校验 | V2.1 V2.2 V2.3 V2.4 V2.5 | P1（校验结果落 trace） | JSON Schema 校验 + validate 节点 UI + Open Platform seam + 业务 webhook |
| P3 测试评测 | T3.1 T3.2 T3.3 T3.4 E4.1 | P1（trace/回放） | OpenAPI 接口测试 + 断言扩展 + 在线回放 + 最小回归 CI + 评测看板 |
| P4 Skills | S1.1 S1.2 S1.3 S1.4 | P1（skill trace） | 真实调试 + /skill 命令 + 版本管理 + 工具总览 |

每阶段完成后跑对应测试用例，全部通过才进入下一阶段；遇 bug 走 Issue 修复流程。

## 5. 非功能需求
- **性能**：trace 持久化不得阻塞主流（保持 best-effort + 异步写入，P99 延迟增量 < 50ms）。
- **存储**：大 I/O 落盘文件 + DB 仅存 ref，避免 `trace_tool_calls` 行膨胀。
- **兼容**：现有 trace 节点（turn/tool/skill/subagent/review/goal_check）类型与字段保持兼容，新类型为增量。
- **安全**：webhook 出站调用走 `url-safety.ts` SSRF 校验复用；HMAC secret 加密存储。

## 6. 风险与取舍
- **规模风险**：5 大能力一次性交付周期长，故分四阶段，每阶段独立可测可合并。
- **截断取舍**：完整 I/O 落盘文件而非 DB，牺牲"单表查询便利"换"存储可控"。
- **调试真实化取舍**：S1.1 真实调试需起 sandbox agent 会话，成本高于纯文本模拟，仅对显式 debug 请求启用。
- **CI 门禁取舍**：smoke 子集 < 60s 保证 PR 流畅，full 测试夜间跑。

## 7. 退出条件（Definition of Done）
- 第 3 节全部 AC 通过、对应 TC 全绿。
- `make test` 全量通过，`make test-smoke` < 60s 通过。
- PRD/技术方案/任务状态/测试报告四件套齐全。
- worktree 合并 main 并 push。
