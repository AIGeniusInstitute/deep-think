# 测试报告：平台核心能力开发（platform-capabilities）

> 分支：`feat/platform-capabilities` ｜ worktree：`.worktrees/feat-platform-capabilities`
> 日期：2026-08-31 ｜ Node：22.x ｜ vitest：4.1.10

## 1. 执行摘要

| 阶段 | 交付 | 测试结果 |
|---|---|---|
| P1 全过程 Trace（后端基座） | trace_steps 表 + span 链路 + 大 I/O 落盘 + timeline API + allocator + persist 路由 | 27/27 通过 |
| P1 前端 trace UI | DagView/DagNodeDetail 原子 nodeType 渲染 + evidence 链 + TraceNodeEntry 扩展 | typecheck exit 0 |
| P2 校验节点与 Hooks | json-schema-validator + validate 节点 + OpenPlatform 校验 seam + webhook 调用器 + 节点 UI | 16/16 通过 |
| P3 测试与评测 | 评测断言扩展（4 类）+ 评测看板（recharts）+ CI 最小回归 | 11/11 通过 + smoke 83 |
| P4 Skills 与 CLI | debugSkill real 模式 + skill_versions 版本管理 + 工具总览页 | 5/5 通过 |

**全量回归：1634 passed / 16 skipped / 0 failed**（Node 22，5.0s tests）
**最小回归（smoke）：83 passed / < 60s**（CI 门禁集）

## 2. 测试矩阵

### P1 — 全过程结构化 Trace
| 用例 | 文件 | 结果 |
|---|---|---|
| thinking_delta 流式累积 | tests/chat-trace-store.test.ts | ✅ |
| compact_boundary 持久化 | tests/chat-trace-store.test.ts | ✅ |
| memory_recall 分支 | tests/chat-trace-store.test.ts | ✅ |
| span 链路（trace_id/span_id/parent_span_id） | tests/chat-trace-store.test.ts | ✅ |
| 自动 turn（startTurn/endTurn） | tests/chat-trace-store.test.ts | ✅ |
| trace_steps upsert/merge | tests/chat-trace-store.test.ts | ✅ |
| evidence_json 写入 | tests/chat-trace-store.test.ts | ✅ |
| 大 I/O（>64KB）落盘 + output_ref | tests/chat-trace-store.test.ts | ✅ |
| 原子/粗粒度路由 | tests/chat-trace-store.test.ts | ✅ |
| schema_version = 58 | tests/units/workflows.test.ts, super-agent-team-trace.test.ts | ✅ |

### P2 — 校验节点与 Hooks
| 用例 ID | 文件 | 结果 |
|---|---|---|
| TC2.1.1a schema 合法通过 | tests/units/json-schema-validator.test.ts | ✅ |
| TC2.1.1b 缺失必填字段失败 | tests/units/json-schema-validator.test.ts | ✅ |
| TC2.1.1c 类型错误失败 | tests/units/json-schema-validator.test.ts | ✅ |
| TC2.1.2 非法 schema 被 isSchemaValid 拒绝 | tests/units/json-schema-validator.test.ts | ✅ |
| 非法 schema 返回 $ 级错误不抛 | tests/units/json-schema-validator.test.ts | ✅ |
| ajv-formats（email） | tests/units/json-schema-validator.test.ts | ✅ |
| errors 携带 schemaPath 证据 | tests/units/json-schema-validator.test.ts | ✅ |
| TC2.2 graph validate 节点 pass/fail/retry/fallback | tests/units/graph-validate-node.test.ts | ✅ (7/7) |
| TC2.3.1 schema fail→422 / passthrough / retry | tests/open-platform-validation.test.ts | ✅ |
| TC2.3.1d 非 JSON 响应 schema 失败 | tests/open-platform-validation.test.ts | ✅ |
| TC2.4.1 hook accept（200 + accept:true） | tests/open-platform-validation.test.ts | ✅ |
| TC2.4.2 hook reject（accept:false）+ block | tests/open-platform-validation.test.ts | ✅ |
| TC2.5.1 hook 超时 3 次重试后 errored | tests/open-platform-validation.test.ts | ✅ |
| TC2.5.2 幂等去重（同 request_id 覆盖非新增） | tests/open-platform-validation.test.ts | ✅ |
| TC2.5.3 HMAC-SHA256 签名头 | tests/open-platform-validation.test.ts | ✅ |

### P3 — 测试与评测
| 用例 | 文件 | 结果 |
|---|---|---|
| json_schema 断言 pass/fail/non-JSON | tests/units/harness-eval.test.ts | ✅ |
| json_path equals/contains/exists | tests/units/harness-eval.test.ts | ✅ |
| numeric_range in/out bounds | tests/units/harness-eval.test.ts | ✅ |
| extractJsonPath 点/括号导航 | tests/units/harness-eval.test.ts | ✅ |
| scoreCaseAsync llm_judge 注入/无 judge/错误捕获 | tests/units/harness-eval.test.ts | ✅ |
| smoke 集（CI 门禁） | Makefile test-smoke / .github/workflows/test.yml | ✅ 83/83 |
| 评测看板渲染 | web/src/components/harness/EvalDashboard.tsx | typecheck exit 0 |

### P4 — Skills 与 CLI
| 用例 | 文件 | 结果 |
|---|---|---|
| skill_versions 自增 version | tests/skill-versions.test.ts | ✅ |
| list 返回 newest first | tests/skill-versions.test.ts | ✅ |
| 按版本取 + content_hash | tests/skill-versions.test.ts | ✅ |
| 用户隔离 | tests/skill-versions.test.ts | ✅ |
| 缺失版本返回 null | tests/skill-versions.test.ts | ✅ |

## 3. 验证命令与证据

```bash
# 后端类型检查
npx tsc --noEmit                         # exit 0
cd web && npx tsc --noEmit               # exit 0

# 全量测试（Node 22）
npx vitest run
# → Test Files  137 passed | 4 skipped (141)
# → Tests       1634 passed | 16 skipped (1650)

# 最小回归（CI 门禁，< 60s）
make test-smoke
# → 6 files / 83 tests / ~1s tests
```

## 4. 已知限制与后续

- **`/skill` IM 斜杠命令**：需 IM sender → DeepThink userId 解析器（group.owner_im_id 为 IM id 非 user id），按 Surgical Changes 原则暂缓；web `/tools` 页 + `/skill_evolution` 已覆盖 Skill 调用面。
- **llm_judge 实际 LLM 调用**：scoreCaseAsync 已支持注入 judge；接入真实 sdkQuery 评判需在 harness 评测运行器处注入（后续 PRD 迭代）。
- **在线回放前端**：后端 `/trace/timeline` API 已就绪；ReplayPlayer 前端组件为 P1 后续。
- **DB 迁移**：schema_version 56→58，两步迁移（v57 trace_steps + v58 校验/webhook/skill_versions）均为 additive 或 drop+recreate+copy 事务，向后兼容。

## 5. 验收标准对照（PRD AC 抽样）

- AC「每个原子步骤结构化 json 可溯源」→ trace_steps 表 + span 链路 + evidence_json ✅
- AC「UI 可配置 JSON Schema 校验节点」→ ValidateSection Monaco 编辑器 + onFail 选择器 ✅
- AC「业务逻辑校验通过 Hooks 交给业务系统」→ result-hooks.ts HMAC + 超时 + 重试 + 幂等 ✅
- AC「全链路数据埋点支持在线回放」→ GET /trace/timeline（粗+原子合并）✅
- AC「评测看板检测 Agent 进步/回归」→ EvalDashboard pass-rate 趋势 + verdict 着色 ✅
- AC「最小化回归」→ Makefile test-smoke + CI workflow < 60s ✅
