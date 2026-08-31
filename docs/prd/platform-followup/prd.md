# PRD：平台核心能力后续三项（platform-followup）

> 分支：`feat/platform-followup` ｜ worktree：`.worktrees/feat-platform-followup`
> 日期：2026-08-31 ｜ 关联：platform-capabilities（已交付 a3b5d91）的暂缓项收口

## 1. 背景

`platform-capabilities` 已交付 5 大能力，但文档化记录了 3 个暂缓项。用户要求不留暂缓项，全部做完：

1. **ReplayPlayer 前端** — 后端 `GET /trace/timeline` 已就绪，但前端无消费组件；执行 trace 无法离线回放。
2. **memory_write trace 注入** — `memory_write` nodeType 在 4 处类型 union 声明，但 `TraceNodeAllocator.decorate()` 从不产出，DB 无对应行 → "幽灵 nodeType"。
3. **llm_call trace 注入** — 同上，`llm_call` nodeType 仅声明不产出；`sdkQuery`/`sdkQueryMessages` 在主进程跑 LLM 但无 trace 上下文。
4. **`/skill` IM 命令** — `handleCommand` switch 无 `skill` case；用户无法在 IM 内直接调用 Skill。

## 2. 目标

将上述 4 项全部落地，使：原子 trace step 覆盖 memory 写入与编排层 LLM 调用；执行过程可离线回放；Skill 可经 IM 斜杠命令调用。

## 3. 验收标准（AC）

### AC-1 ReplayPlayer 前端
- AC-1.1 新增 `TraceReplayPlayer` 组件，拉取 `GET /api/groups/:jid/trace/timeline`，渲染粗粒度 node + 原子 step 合并时间轴。
- AC-1.2 含 play/pause + scrubber 滑块，自动推进高亮当前项并滚动可视；支持按 nodeType 着色与标签。
- AC-1.3 项可展开查看详情（title/status/time/outputRef）；大 I/O 经 `outputRef` 可拉取（复用 `/trace/steps/:spanId/io`）。
- AC-1.4 在 ChatView 侧栏新增「回放」tab 入口；前端 typecheck exit 0。

### AC-2 memory_write trace
- AC-2.1 `memory_append` 工具执行后，`trace_steps` 表写入一条 `node_type='memory_write'` 记录，`chat_jid` 正确。
- AC-2.2 记录可在 `GET /trace/timeline` 返回中查到。
- AC-2.3 非 memory_append 工具不产出 memory_write step（无副作用）。
- AC-2.4 单元测试覆盖：tool_use_start→tool_result 流后合成 memory_write step；其它工具返回 null。

### AC-3 llm_call trace
- AC-3.1 `sdkQuery`/`sdkQueryMessages` 接受可选 `trace` 参数；提供时写入 `node_type='llm_call'` trace_step（含 status/durationMs/output 摘要）。
- AC-3.2 不提供 `trace` 时行为不变（向后兼容）。
- AC-3.3 注入点：supervisor-agent 决策、team-builder 分解、/skill 调用透传 `trace`。
- AC-3.4 单元测试覆盖：有 trace→写 step；无 trace→不写；失败状态正确。

### AC-4 `/skill` IM 命令
- AC-4.1 `/{skill} {id} {input}` 形式命令触发 Skill 真实执行（debugSkill real 模式）。
- AC-4.2 owner 门控：仅 group owner 可执行（加入 `OWNER_REQUIRED_IM_COMMANDS`）。
- AC-4.3 sender→userId 解析：owner 验证后取 `group.created_by` 作为 DeepThink userId 查 Skill。
- AC-4.4 缺失/禁用 skill 返回明确错误；成功返回执行输出（IM 安全截断）。

## 4. 非目标

- 不改造 agent-runner 进程（memory_write 在主进程 persist 层合成，避免动容器）。
- 不为所有 sdkQuery 调用点全量注 trace（仅编排层 + /skill 有 chat 上下文者）。
- 不实现 trace 的实时 SSE 推送（memory_write/llm_call 为 DB 落盘，经 ReplayPlayer/timeline 查看）。

## 5. 工作流

worktree → PRD → tech_solution → task_state → 编码 → 测试 → test_report → 合并 main push。
