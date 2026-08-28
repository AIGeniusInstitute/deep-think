# 测试报告：DeepThink 开放平台（Agent Service）

> 分支：`feature/open-platform`
> 日期：2026-08-28
> 参考实现：Prime AI Harness 开放平台

---

## 1. 测试范围与方法

| 维度 | 方法 | 结果 |
|---|---|---|
| 静态类型检查 | `make typecheck`（后端 + 前端 + agent-runner） | ✅ 全绿 |
| 单元/约束测试 | `make test`（vitest） | ✅ 1587 passed / 14 skipped / 0 failed |
| 生产构建 | `make build`（后端 tsc + 前端 vite + agent-runner） | ✅ 退出码 0 |
| 集成测试 | 隔离数据目录 + 真实 provider，curl 全链路 | ✅ 30+ 步骤全通过 |

集成测试环境：
- 服务以 `DEEPTHINK_DATA_DIR=~/.deepthink-open-platform-test/data` 隔离启动，端口 `9899`。
- Provider 继承 shell 环境变量 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`（`deepseek-v4-pro`），`getClaudeProviderConfig()` 的 env fallback 生效，MaaS/AaaS 均发起**真实 LLM 调用**。
- 账号：`admin / 88888888`（setup 创建），`opmember2 / member12345`（member，`must_change_password=false`）。

---

## 2. 测试用例执行结果（T1–T20）

| 编号 | 用例 | 结果 | 关键证据 |
|---|---|---|---|
| T1 | 创建 API Key | ✅ | `POST /api/open-platform/keys` → 201，返回 `key:"sk-4XoyLUOr..."`、`key_prefix`、`id`、`masked_key` |
| T2 | 列表脱敏 | ✅ | `GET /keys` 仅含 `key_prefix` + `masked_key:"sk-4XoyLUOr..."`，无明文 |
| T3 | 吊销 Key | ✅ | `DELETE /keys/:id` → 200；随后 `GET /v1/models` 用该 key → 401 `Invalid API key` |
| T4 | 未登录访问管理接口 | ✅ | 无 Cookie `GET /api/open-platform/keys` → 401 `Unauthorized` |
| T5 | MaaS 非流式 | ✅ | 200，`choices[0].message.role=assistant`，content 非空，`finish_reason=stop`，usage 正确 |
| T6 | MaaS 流式 | ✅ | `Content-Type: text/event-stream`，多条 `data:` delta，末条 `data: [DONE]` |
| T7 | 无 key / 错 key | ✅ | 无/错 Bearer → 401 `Invalid API key`（`type:authentication_error`） |
| T8 | 模型列表 | ✅ | `GET /v1/models` → 200，`data:[{id:"deepseek-v4-pro", owned_by:"deepthink"}]` |
| T9 | Agent 同步调用 | ✅ | coffee-bot（人设「咖啡小助手」）问「你是谁」→「我是咖啡店的客服小助手。」，符合人设 |
| T10 | Agent 不存在 | ✅ | 随机 agentId → 404 `Agent not found` |
| T11 | Agent 越权 | ✅ | member key 调 admin 的 agent → 403 `You do not have access to this agent` |
| T12 | Agent disabled | ✅ | 禁用后调用 → 400 `Agent is disabled` |
| T13 | MaaS 计费前置拦截 | ✅ | 启用 billing 后 member 无套餐 → 402 `余额不足…`，且 `usage_records` 无新增（requests 不变） |
| T14 | MaaS 计费计量扣费 | ✅ | member 调 MaaS（87 in / 31 out），`cost_usd=0.0003165`，与定价 `1.5/6.0 每 mtok` 精确一致 |
| T15 | AaaS 计费 | ✅ | member 建 agent + 调 AaaS → 成功，`usage_records` 新增 `source=open-platform` 记录，`cost_usd` 取 SDK `total_cost_usd` |
| T16 | admin 豁免 | ✅ | admin 多次 MaaS/AaaS/debug 调用后，`usage` 聚合不含 admin 记录 |
| T17 | debug meta | ✅ | `GET /api/open-platform/debug/meta` → `{defaultModel:"deepseek-v4-pro", hasProvider:true}` |
| T18 | LLM 非流式调试 | ✅ | `POST /api/open-platform/debug/chat` → 200，返回助手文本 + usage |
| T19 | Agent 流式调试 | ✅ | `POST /api/open-platform/debug/agent`（stream:true）→ SSE 逐字增量 + `[DONE]` |
| T20 | 用量统计接口 | ✅ | `GET /api/open-platform/usage?days=7` → summary + daily（请求数/token/成本），member 仅见自己、admin 见全部 |

**结论：T1–T20 全部通过。**

---

## 3. 发现问题与修复

### 3.1 `owned_by` 泄漏 Prime 标识（已修复）

- **现象**：`GET /v1/models` 返回 `owned_by: "primeharness"`，暴露了参考实现 Prime AI Harness 的标识。
- **根因**：`src/routes/open-platform.ts` 从参考实现拷贝时，`owned_by` 字段保留为 `'primeharness'`。
- **修复**：改为 `'deepthink'`（`src/routes/open-platform.ts:94`）。
- **验证**：修复后 `GET /v1/models` → `owned_by: "deepthink"`，并回归 MaaS 非流式仍正常。

### 3.2 推理模型 + 过小 max_tokens 导致空 content（非缺陷，记录）

- **现象**：MaaS 非流式 `max_tokens=64` 时 `content:""`、`finish_reason:"length"`。
- **根因**：provider `deepseek-v4-pro` 是推理模型，Anthropic 响应先产出 `thinking` 块（非 `text` 块）。64 token 全被思考占用，未产出正文。
- **结论**：`anthropicToOpenAi` 只提取 `type==='text'` 块（正确跳过 `thinking`），行为正确；`max_tokens` 需大于思考预算才能拿到正文。放大到 1024 后 `content` 正常返回。
- **说明**：MaaS 层有意不把 `thinking` 内容混入 `content`（OpenAI 兼容语义），与参考实现一致。

---

## 4. 未覆盖项（如实说明）

- **前端浏览器 E2E（F5）**：OpenPlatformPage 为从参考实现拷贝的单文件页，已通过 `make build`（vite 编译）验证；其依赖的 10 个后端端点（keys/usage/pricing/debug/meta/chat/agent + /v1/*）已全部在集成测试中验证。未做 Playwright 级浏览器渲染测试（本环境无浏览器自动化套件）。
- **AaaS 流式超时**：`STREAM_TIMEOUT_MS=300s` 硬超时路径未触发实测（正常流式很快完成）。

---

## 5. 结论

开放平台五大功能点（F1 API Key 管理 / F2 MaaS / F3 AaaS / F4 计费闭环 / F5 调试与示例）实现完整，后端 20 条验收用例全绿，静态检查与单元测试全绿，符合合并 main 条件。
