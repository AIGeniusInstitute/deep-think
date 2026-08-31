# 测试报告：平台核心能力后续三项（platform-followup）

> 分支：`feat/platform-followup` ｜ worktree：`.worktrees/feat-platform-followup`
> 日期：2026-08-31 ｜ Node：22.23.1 ｜ vitest：4.1.10

## 1. 执行摘要

| 项 | 交付 | 测试 |
|---|---|---|
| ReplayPlayer 前端 | TraceReplayPlayer + 回放 tab + timeline store | 前端 typecheck exit 0 |
| memory_write trace | persist 层 memory_append→memory_write step 合成 | 6/6 通过 |
| llm_call trace | sdkQuery 可选 trace 参数 + 编排层注入 | 5/5 通过 |
| /skill IM 命令 | owner 门控 + created_by 解析 + real 执行 | 9/9 通过 |

**全量回归：1653 passed / 16 skipped / 0 failed**（+19 用例，原 1634）
**最小回归（smoke）：102 passed / < 60s**（+19 用例，原 83，9 文件）

## 2. 测试矩阵

### memory_write trace（`tests/units/memory-write-trace.test.ts`）
| 用例 | 结果 |
|---|---|
| memory_append tool_result 合成 memory_write step（node_type/chat_jid/trace_id/parent/span 前缀/output/status） | ✅ |
| 非 memory_append 工具（Read）→ null | ✅ |
| 无前置 tool_use_start 的 tool_result → null | ✅ |
| 无 traceNode 时 traceId 兜底 `chat-{jid}`、parent null | ✅ |
| 长内容（3000 字）output_summary 截断 ≤2048 | ✅ |
| 非 tool 事件（text_delta）→ null | ✅ |

### llm_call trace（`tests/units/llm-call-trace.test.ts`）
| 用例 | 结果 |
|---|---|
| sdkQuery + trace → 1 次 upsertTraceStep，node_type llm_call，status done，input/output 摘要，span `llm-N` | ✅ |
| sdkQuery 无 trace → 不写（向后兼容） | ✅ |
| query 抛错 → status failed，仍写入 | ✅ |
| sdkQueryMessages + trace → 写 step（input 取 messages 文本） | ✅ |
| sdkQueryMessages 无 trace → 不写 | ✅ |

### /skill IM 命令（`tests/units/skill-im-command.test.ts`）
| 用例 | 结果 |
|---|---|
| 有效 skill+input → debugSkill real + 正确 trace 参数 + 返回 output | ✅ |
| 缺参数 → 用法提示 | ✅ |
| 缺 input → 用法提示 | ✅ |
| group 无 created_by → 错误提示 | ✅ |
| skill 未找到 → 错误提示 | ✅ |
| skill 禁用 → 错误提示 | ✅ |
| debugSkill error → ⚠️ 前缀 | ✅ |
| 长 output 截断 + 标记 | ✅ |
| 冷却阻止快速二次调用 | ✅ |

### owner 门控回归（`tests/im-owner-gate.test.ts`）
| 用例 | 结果 |
|---|---|
| OWNER_REQUIRED_IM_COMMANDS 含 'skill'（预期列表更新） | ✅ |

## 3. 验证命令

```bash
# 后端类型检查
npx tsc --noEmit                    # exit 0
cd web && npx tsc --noEmit          # exit 0

# 全量测试（Node 22）
npx vitest run
# → Tests 1653 passed | 16 skipped (1669)

# 最小回归（CI 门禁）
make test-smoke
# → 9 files / 102 tests / ~1s
```

## 4. 验收标准对照

- AC-1 ReplayPlayer：组件拉取 timeline、play/pause+scrubber+自动推进、项展开+大 I/O 拉取、回放 tab ✅
- AC-2 memory_write：memory_append→trace_step、timeline 可查、非 memory_append 无副作用、单测 ✅
- AC-3 llm_call：trace 参数→step、无 trace 向后兼容、supervisor/team/skill 透传、单测 ✅
- AC-4 /skill：`/skill <id> <input>`、owner 门控、created_by 解析、缺失/禁用错误、IM 截断 ✅

## 5. 设计取舍说明

- **memory_write 在主进程合成而非 agent-runner**：memory_append 工具结果经流事件回主进程，persist 层有 DB 访问；在主进程合成避免改容器进程 + traceContext 跨进程传递。memory_write 为 DB 落盘（ReplayPlayer/timeline 可见），与 thinking/memory_recall 等原子步同模式。
- **llm_call 经可选 trace 参数**：sdkQuery 多数调用无 chat 上下文（eval/bug-report/tasks），强制传 trace 会侵入；可选参数 + 仅编排层（supervisor/team/skill）注入，向后兼容。
- **/skill 抽独立模块**：index.ts 是 side-effectful 启动模块无法在测试中 import；skill-im-command.ts 独立 + 依赖注入，可单测。
