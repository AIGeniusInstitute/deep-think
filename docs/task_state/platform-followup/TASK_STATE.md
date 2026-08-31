# 任务状态：平台核心能力后续三项（platform-followup）

> 分支：`feat/platform-followup` ｜ worktree：`.worktrees/feat-platform-followup`
> 关联：platform-capabilities（a3b5d91）暂缓项收口

## 总进度

| 项 | 状态 | 测试 | 说明 |
|---|---|---|---|
| ReplayPlayer 前端 | ✅ 完成 | typecheck exit 0 | TraceReplayPlayer + 侧栏「回放」tab + timeline store |
| memory_write trace | ✅ 完成 | 6/6 | 主进程 persist 层合成，不动 agent-runner |
| llm_call trace | ✅ 完成 | 5/5 | sdkQuery/sdkQueryMessages 可选 trace 参数 + 编排层注入 |
| /skill IM 命令 | ✅ 完成 | 9/9 | owner 门控 + created_by 解析 + real 模式执行 |

全量回归：**1653 passed / 16 skipped / 0 failed**（Node 22）；smoke：**102 / <60s**。

## 落地清单

### ReplayPlayer 前端
- [x] `web/src/stores/chat.ts`：`TimelineItem` 类型 + `traceTimeline` state + `loadTraceTimeline` action
- [x] `web/src/components/chat/TraceReplayPlayer.tsx`（新）：拉取 `/trace/timeline`，渲染粗+原子合并时间轴；play/pause + range scrubber + 自动推进 800ms/步 + scrollIntoView；项展开看 span/trace/status/time；outputRef 大 I/O 经 `/trace/steps/:spanId/io` 拉取
- [x] `DagView.tsx`：导出 `NODE_TYPE_COLORS`/`NODE_TYPE_LABELS` 供复用（DRY）
- [x] `ChatView.tsx`：SIDEBAR_TABS + `'replay'`（History 图标）+ SidebarTab union + 渲染分支
- [x] 前端 `npx tsc --noEmit`：exit 0

### memory_write trace（主进程合成）
- [x] `src/chat-trace-persist.ts`：`MEMORY_WRITE_TOOL='memory_append'` + `toolNameByUseId` 映射 + `maybeSynthesizeMemoryWrite(chatJid, event)` 纯函数
  - tool_use_start 记 toolName；tool_result 消费，memory_append → 构造 `memory_write` trace_step（span `mw-{尾8}`，traceId/parent 取 traceNode，status done）
  - `persistTraceNodeFromStreamEvent` 末尾调 upsertTraceStep（best-effort）
- [x] 测试：memory_append→step；非 memory_append→null；无前置→null；traceId 兜底；长内容截断；非 tool 事件→null

### llm_call trace
- [x] `src/sdk-query.ts`：`LlmCallTrace` 类型 + `llmCallCounter` + `recordLlmCallTrace` helper；`sdkQuery`/`sdkQueryMessages` 加可选 `trace` 参数；finally 写 `llm_call` trace_step（done/failed）
- [x] 注入：`agent-team/team-builder.ts`（Team Decompose）、`supervisor-agent.ts`（Supervisor Decision，deps 接口扩 trace?）、`index.ts:11610`（透传 opts.trace）、`skill-ai.ts` debugSkill（透传）
- [x] 测试：有 trace→写 step（done）；无 trace→不写；失败→status failed；sdkQueryMessages 同

### /skill IM 命令
- [x] `src/skill-im-command.ts`（新）：`handleSkillImCommand` 独立模块（可单测）；解析/冷却/created_by 解析/getSkillDetail/debugSkill real/IM 截断
- [x] `src/im-command-utils.ts`：`OWNER_REQUIRED_IM_COMMANDS` + `'skill'`
- [x] `src/routes/skills.ts`：导出 `getSkillDetail` + `SkillDetail`
- [x] `src/index.ts`：`case 'skill'` + import handleSkillImCommand；移除冗余 getSkillDetail/debugSkill import
- [x] 测试：有效调用/用法提示/无 created_by/未找到/禁用/error/截断/冷却

## 验证
- 后端 `npx tsc --noEmit`：exit 0
- 前端 `npx tsc --noEmit`：exit 0
- 全量 `npx vitest run`：1653 passed / 16 skipped / 0 failed
- smoke `make test-smoke`：9 files / 102 tests / ~1s
