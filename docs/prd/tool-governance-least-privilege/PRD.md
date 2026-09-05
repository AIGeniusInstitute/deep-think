# PRD：企业级工具治理与最小权限基线（Tool Governance & Least-Privilege Baseline）

> 分支：`feat/tool-governance-least-privilege`
> 工作区：`~/deepthink/.worktrees/feat-enterprise-platform-gaps`
> 来源：`docs/企业级Agent平台技术架构与开发路线图深度研究.md` 审计落地
> 日期：2026-09-05

## 1. 背景

《企业级 Agent 平台技术架构与开发路线图深度研究》指出，企业 Agent 平台的共性架构中，**工具层是风险边界**——"默认只读，写操作需授权与幂等键"是 Codex（默认只读 + 证据链）、Claude Cowork（每工具权限 + OTel）、腾讯 WorkBuddy（企业 Skill/MCP + 五维隔离）的共性设计。研究文档第六节"五个硬骨头"之 6.1 安全与权限、6.3 工具生态均把"工具副作用分级 + 幂等 + 审计 + 凭据保护"列为企业平台不可跳过的基线。

DeepThink 已有 MCP Registry（HTTP→MCP 转换引擎）、Skills 版本快照、harness-eval、auth_audit_log、balance_transactions 幂等键、embedding.ts AES-256-GCM 加密等可复用模式，但工具层本身缺少副作用分级、写操作幂等、调用审计、限流与凭据加密——这是"工具是风险边界"原则下最该先做硬的缺口。

## 2. 目标

把 DeepThink MCP Registry 从"可被滥用的免费 HTTP 代理"升级为"受治理的企业工具网关"：

- 每个工具声明副作用等级（read/write/admin），默认只读，写操作需显式标记。
- 写操作支持幂等键，重放返回缓存结果而非重复执行。
- 每次 tools/call 留下审计行（user/tool/args_hash/结果/耗时/request_id）。
- MCP Gateway 对 per-user + per-tool 限流，写操作更严。
- 工具凭据（authHeader、registry token）落库加密，明文不再出现在 DB。

## 3. 非目标（本次不做）

下列 gap 经审计确认存在但不在本次范围，列入后续路线：

- 多租户/组织隔离（最致命，需 schema 大改 + 全链路 userId→tenantId 涟漪，单独立项）
- 企业 SSO/SAML/OIDC/SCIM
- ABAC 策略引擎与 PII 检测、提示注入规则引擎
- 按场景的模型路由、Prompt 版本注册表
- 知识层文档分块 + rerank + 引用展示
- 生产 agent 容器硬化（container-runner.ts，需独立验证 agent-runner 不破坏）
- OpenTelemetry/OTLP export、Compliance/GDPR API、告警系统

## 4. 竞品设计吸收

| 平台 | 吸收点 | 落地映射 |
|---|---|---|
| Codex | 默认只读沙箱 + "日志+测试+引用"证据链 | 工具副作用分级：未声明 = read（最保守） |
| Claude Cowork | 每工具权限 + OTel 覆盖 skill/connector 调用 | tool_call_audit_log 全量留痕 + 可按 request_id 串联 |
| WorkBuddy Enterprise | 企业 Skill/MCP 连接 + 五维隔离 | 凭据加密存储 + per-tool 限流配额 |
| 百炼 Agent 2.0 | 知识库/MCP 统一为工具 | 副作用等级成为 Tool Manifest 一等字段 |

## 5. 功能点与验收标准

### F1. 工具副作用分级（read/write/admin）

**需求**
- `mcp_registry_tools` 新增 `side_effect` 列，取值 `read` | `write` | `admin`，默认 `read`。
- 创建/更新工具时，若未显式传 `sideEffect`，由 `httpBinding.method` 自动推断：`GET=read`，`POST/PUT/PATCH=write`，`DELETE=admin`。
- `RegistryToolCreateSchema` / `RegistryToolUpdateSchema` 新增可选 `sideEffect` 字段（zod enum）。
- REST `toolToApi` 输出与 MCP `tools/list` 输出均包含 `sideEffect`。
- OpenAPI 导入（`/import-openapi/confirm`）按 method 自动推断 sideEffect 写入。

**验收标准**
- AC1.1 创建 GET 工具不传 sideEffect → DB `side_effect='read'`，API 返回 `sideEffect:'read'`。
- AC1.2 创建 DELETE 工具不传 sideEffect → `side_effect='admin'`。
- AC1.3 显式传 `sideEffect:'write'` 且 method=GET → 以显式值为准（DB=write）。
- AC1.4 PATCH 更新 sideEffect 生效。
- AC1.5 MCP `tools/list` 返回的 tool 对象含 `sideEffect` 字段。
- AC1.6 老库（无 side_effect 列）启动自动 `ensureColumn` 补列，默认 read，不报错。

**测试用例**
- TC1: POST 创建 GET 工具（无 sideEffect）→ GET 该工具断言 side_effect=read。
- TC2: POST 创建 DELETE 工具（无 sideEffect）→ 断言 admin。
- TC3: POST 创建 sideEffect=write + method=GET → 断言 write。
- TC4: PATCH 更新 sideEffect=admin → 断言 admin。
- TC5: MCP tools/list 包含 sideEffect 字段。
- TC6: OpenAPI confirm 导入 POST 工具 → 断言 write。

### F2. 写操作幂等键（Idempotency-Key）

**需求**
- MCP `tools/call` 与 REST `/tools/:id/test` 支持请求头 `Idempotency-Key`（非空字符串，≤128 字符）。
- 仅对 `side_effect != read` 的工具生效；read 工具忽略幂等键（无副作用，重放无风险）。
- 命中逻辑：以 `(user_id, tool_id, idempotency_key)` 为唯一键；命中且上次成功 → 返回缓存结果（标注 `idempotent_replay:true`）；命中且上次失败 → 允许重试（不返回缓存失败）。
- 未命中：正常执行，结果缓存（content + isError + status + created_at）写入新表 `tool_call_idempotency`，TTL 24h（按 created_at 清理）。

**验收标准**
- AC2.1 写工具 + Idempotency-Key + 成功 → 首次执行返回结果，DB 有 1 行 idempotency 记录。
- AC2.2 同 key 再次调用 → 返回缓存结果，`idempotent_replay=true`，上游 HTTP 不被再次调用（用 mock 计数）。
- AC2.3 read 工具 + Idempotency-Key → 正常每次执行，不写 idempotency 行，无 replay 标记。
- AC2.4 首次失败（isError=true）+ 同 key 再调 → 重新执行（不返回缓存失败）。
- AC2.5 不同 key 调用同一写工具 → 各自独立执行。

**测试用例**
- TC7: 写工具 + key=K1 成功 → 再 K1 → mock 上游被调 1 次，第二次返回 `idempotent_replay:true`。
- TC8: read 工具 + key=K2 调两次 → 上游被调 2 次。
- TC9: 写工具失败 + key=K3 → 再 K3 → 上游被调 2 次（重试）。

### F3. MCP Gateway 调用审计（tool_call_audit_log）

**需求**
- 新表 `tool_call_audit_log`：`id, user_id, tool_id, tool_name, side_effect, args_hash, request_id, idempotency_key, result_status(success/error), http_status, duration_ms, created_at`。
- 每次 `tools/call` 与 `/tools/:id/test` 执行后写一行（无论成功/失败/超时）。
- `args_hash` = sha256(JSON.stringify(args)) 前 16 字符（不存原始参数，避免泄露 PII）。
- `request_id` 从 F4 注入（无则生成 UUID）。
- 新增 `GET /api/mcp-registry/audit-log`（admin 权限），分页 + 按 user/tool/side_effect/时间过滤。
- `result_status` 取值 `success` | `error`；`http_status` 为上游 HTTP 状态码（失败无上游则 null）。

**验收标准**
- AC3.1 任意 tools/call 后 audit_log 表 +1 行，字段齐全。
- AC3.2 失败调用（isError=true）result_status=error。
- AC3.3 args_hash 一致 = 相同参数；不存原始 args。
- AC3.4 admin 可 GET /audit-log 过滤生效；非 admin 403。
- AC3.5 审计写入不影响主流程性能（异步 fire-and-forget 或事务后写，失败仅 warn log）。

**测试用例**
- TC10: tools/call 成功 → audit 行 result_status=success, http_status=200。
- TC11: tools/call 上游 500 → result_status=error, http_status=500。
- TC12: 相同参数两次调用 → args_hash 相同。
- TC13: 非 admin GET /audit-log → 403。

### F4. 统一请求 ID 与 MCP Gateway 限流

**需求**
- MCP `/mcp` 端点与 REST 工具调用入口注入 `requestId`：优先取 `X-Request-Id` 头，无则生成 UUID；响应头回写 `X-Request-Id`。
- 限流：per-user + per-tool 滑动窗口（内存计数，单 Pod；多 Pod 暂降级为 best-effort，不阻塞主流程）。
  - 默认配额：read 120/min、write 30/min、admin 10/min（可由 `mcp_registry_servers` 的 `rate_limit_override` JSON 覆盖，本次只实现全局默认 + per-user 维度，per-tool 维度以 tool_id 参与 key）。
  - 超限返回 JSON-RPC error -32000 `Rate limit exceeded`（HTTP 429）。
- 限流 key：`mcp:rl:{userId}:{toolId}` 滑动窗口 60s。

**验收标准**
- AC4.1 响应头含 `X-Request-Id`，与请求头一致或新生成。
- AC4.2 请求头带 `X-Request-Id: abc` → 响应头 abc，audit 行 request_id=abc。
- AC4.3 read 工具连续调用 >120 次/分钟 → 第 121 次返回 429/-32000。
- AC4.4 write 工具 30 次/分钟超限；admin 10 次/分钟超限。
- AC4.5 限流计数仅在进程内存（无 Redis 时不报错）。

**测试用例**
- TC14: 请求带 X-Request-Id → 响应头一致 + audit request_id 一致。
- TC15: read 工具调 121 次（同 user 同 tool）→ 第 121 次 429。
- TC16: write 工具调 31 次 → 第 31 次 429。
- TC17: 不同 user 互不影响（user A 用尽配额不影响 user B）。

### F5. 凭据加密存储（AES-256-GCM）

**需求**
- 复用 `runtime-config.ts` 的 `getOrCreateEncryptionKey`（CLAUDE_CONFIG_KEY_FILE，32 字节 AES key）。
- `http_binding.authHeader.value` 落库前加密：DB 存 `enc:v1:base64(iv|tag|data)`，引擎执行时解密注入。
- `mcp_registry_tokens.token` 同样加密存储；`getOrCreateRegistryToken`/`rotateRegistryToken` 返回明文（仅创建时），DB 存密文。
- `getUserIdByRegistryToken` 解密比对（或改为 hash 比对：存 sha256(token)，查询时 hash 输入比对——本方案选 hash 比对，避免每次解密全表）。
- 已有明文数据迁移：启动时检测 `authHeader.value` 不以 `enc:v1:` 开头则加密回写（一次性迁移）；token 表新增 `token_hash` 列，旧明文迁移后保留 hash。

**验收标准**
- AC5.1 新建工具带 authHeader → DB http_binding JSON 中 authHeader.value 形如 `enc:v1:...`，非明文。
- AC5.2 引擎执行时正确解密注入上游 header，调用成功。
- AC5.3 新建 registry token → DB 不含明文 token（存 token_hash）。
- AC5.4 `getUserIdByRegistryToken(明文)` 能正确比对返回 userId。
- AC5.5 老明文数据启动迁移后 DB 不再含明文 authHeader.value。
- AC5.6 无加密 key 文件时自动生成（复用 getOrCreateEncryptionKey），不报错。

**测试用例**
- TC18: 创建带 authHeader 工具 → 直接查 DB http_binding 字段不含明文 value。
- TC19: 执行该工具 → 上游收到正确 Authorization 头。
- TC20: rotate token → DB tokens 表无明文；用新 token 调 /mcp 鉴权成功。
- TC21: 老明文 authHeader 数据 → 重启服务后 → DB 已加密。

## 6. 数据库变更

- `mcp_registry_tools.side_effect TEXT NOT NULL DEFAULT 'read'`（ensureColumn）
- `mcp_registry_servers.rate_limit_override TEXT`（ensureColumn，JSON，可空）
- 新表 `tool_call_audit_log`（F3）
- 新表 `tool_call_idempotency`（F2）
- `mcp_registry_tokens.token_hash TEXT`（ensureColumn）；`token` 列保留但迁移后不再用于鉴权查询（兼容期）
- schema_version 59 → 60

## 7. 风险与权衡

- **限流单 Pod 内存**：多 Pod 下限流不全局一致（用户可能在不同 Pod 各得配额）。权衡：本次接受 best-effort，因全量限流需 Redis 滑动窗口（已有 redis-bus，但接入涟漪大，列入后续）。不阻塞主流程。
- **幂等缓存内存/磁盘**：存 SQLite（持久化、跨重启），TTL 24h 清理。写量不大，性能可接受。
- **加密 key 与 runtime-config 共享**：复用既有 key 文件，零新依赖；key 文件丢失=凭据不可解（等同 key 轮换失败），与现有 provider 凭据加密同风险等级。
- **向后兼容**：老明文数据启动一次性迁移；迁移失败不阻断启动（warn log，逐条 try/catch）。

## 8. 后续路线（非本次）

见第 3 节非目标列表 + 研究文档第五节路线图 M4–M12。
