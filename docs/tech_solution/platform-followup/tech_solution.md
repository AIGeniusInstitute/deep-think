# 技术方案：平台核心能力后续三项

> 分支：`feat/platform-followup` ｜ worktree：`.worktrees/feat-platform-followup`

## 设计原则

- **Simplicity First**：memory_write 在主进程 persist 层合成（不动 agent-runner）；llm_call 经可选 `trace` 参数（向后兼容）；ReplayPlayer 用列表 + scrubber（不引入新依赖）。
- **Surgical Changes**：只动必要文件；trace 失败不阻断主流程（best-effort + try/catch）。

## 1. ReplayPlayer 前端

### 1.1 数据源
`GET /api/groups/:jid/trace/timeline` 已返回 `{ timeline: TimelineItem[] }`，每项带 `kind: 'node'|'step'`、`spanId/traceId/parentSpanId/nodeType/title/status/outputRef/startedAt/endedAt`。

### 1.2 新文件 `web/src/components/chat/TraceReplayPlayer.tsx`
- props: `{ chatJid: string }`
- 拉取 timeline → store action `loadTraceTimeline(jid)`；state `traceTimeline: Record<string, TimelineItem[]>`。
- 渲染：垂直列表，每项按 nodeType 取色/标签（复用 `DagView.tsx` 的 `NODE_TYPE_COLORS`/`NODE_TYPE_LABEL_ZH`，导出后 import）。
- 控件：play/pause 按钮 + range input（0..timeline.length-1）；自动推进 800ms/步；当前项高亮 + `scrollIntoView`。
- 详情：点击展开 title/status/time；`outputRef` 存在时显示「查看大 I/O」按钮，调 `GET /trace/steps/:spanId/io?traceId=` 拉取内容。
- 空态：无 timeline 提示「该会话暂无 trace 数据」。

### 1.3 store `web/src/stores/chat.ts`
- `ChatState` 加 `traceTimeline: Record<string, TimelineItem[]>`。
- action `loadTraceTimeline(jid)`：`api.get('/api/groups/:jid/trace/timeline')` → set。
- `TimelineItem` 类型在组件内定义并导出供 store 引用（或 store 内定义）。

### 1.4 接入 `web/src/components/chat/ChatView.tsx`
- `SIDEBAR_TABS` 加 `{ id: 'replay', icon: History, label: '回放' }`。
- `SidebarTab` union 加 `'replay'`。
- tab content 分支：`sidebarTab === 'replay' ? <TraceReplayPlayer chatJid={groupJid} /> :`。
- import `History` from lucide-react + `TraceReplayPlayer`。

## 2. memory_write trace（主进程合成）

### 2.1 缺口
`memory_append` MCP 工具执行时产出 `tool_use_start`/`tool_result` 流事件（已在 agent-runner）。主进程 `persistTraceNodeFromStreamEvent` 已对每个流事件调用。`tool_result` 事件携带 `toolUseId`+`toolResult` 但不携带 `toolName`；`tool_use_start` 携带 `toolName`。

### 2.2 方案 `src/chat-trace-persist.ts`
- 模块级 `Map<string, string> toolNameByUseId`（key=`${chatJid}|${toolUseId}`）。
- 导出纯函数 `maybeSynthesizeMemoryWrite(chatJid, event): TraceStepUpsertInput | null`：
  - `tool_use_start` 且 `event.toolUseId + event.toolName`：记录映射；返回 null。
  - `tool_result` 且 `event.toolUseId`：查映射、删除；若 toolName==='memory_append' → 构造 `TraceStepUpsertInput`（node_type 'memory_write'，span_id `mw-${toolUseId尾8位}`，trace_id 取 event.traceNode.traceId 或 fallback `chat-${chatJid}-${uuid}`，parent_span_id 取 event.traceNode.parentSpanId，chat_jid=chatJid，output_summary=truncate(toolResult, 2KB)，status 'done'，started/ended=now）；返回。否则返回 null。
  - 其它事件返回 null。
- `persistTraceNodeFromStreamEvent` 末尾调 `const mw = maybeSynthesizeMemoryWrite(chatJid, event); if (mw) upsertTraceStep(mw)`（best-effort try/catch）。
- 工具名常量 `MEMORY_WRITE_TOOL = 'memory_append'`。

### 2.3 测试 `tests/units/memory-write-trace.test.ts`
- TC：tool_use_start(memory_append) → 记录；紧接 tool_result → 返回 memory_write step（node_type 校验、chat_jid、span_id 前缀 `mw-`）。
- TC：非 memory_append 工具（如 Read）tool_result → 返回 null。
- TC：无前置 tool_use_start 的 tool_result → 返回 null（无映射）。

## 3. llm_call trace（sdkQuery 可选 trace 参数）

### 3.1 `src/sdk-query.ts`
- 类型 `export interface LlmCallTrace { chatJid: string; traceId?: string; parentSpanId?: string | null; label?: string }`。
- 模块级 `let llmCallCounter = 0;` 生成 `span_id = llm-${++llmCallCounter}`。
- `sdkQuery(prompt, opts?: { model?; timeout?; trace?: LlmCallTrace })`：
  - 若 `opts?.trace`：`const tr = opts.trace; const traceId = tr.traceId ?? randomUUID(); const spanId = 'llm-'+(++llmCallCounter); const label = tr.label ?? 'LLM Call'; const start = Date.now();`
  - 执行 query；finally：若 trace，`try { upsertTraceStep({ trace_id: traceId, span_id: spanId, parent_span_id: tr.parentSpanId ?? null, chat_jid: tr.chatJid, node_type: 'llm_call', title: label, input_summary: prompt.slice(0,500), output_summary: (result??'').slice(0,1000), status: err?'failed':'done', started_at: new Date(start).toISOString(), ended_at: new Date().toISOString() }) } catch {}`
- `sdkQueryMessages` 同理加 `trace?` 参数 + 相同逻辑（抽 `recordLlmCallTrace(tr, prompt, result, start, failed)` helper 复用）。
- import `upsertTraceStep` from `./db.js`。

### 3.2 注入点
- `src/agent-team/team-builder.ts:67,71`：`sdkQuery(prompt, { timeout, trace: { chatJid: input.chatJid, label: 'Team Decompose' } })`。
- `src/supervisor-agent.ts:516`：opts 加 `trace: { chatJid: session.chat_jid, label: 'Supervisor Decision' }`；deps 接口(:390) opts 类型加 `trace?`。
- `src/index.ts:11610`：`sdkQuery(prompt, { model: opts.model, timeout: 60_000, trace: opts.trace })`。
- `src/skill-ai.ts` debugSkill：加可选 `trace?` 参数透传给 sdkQueryMessages。

### 3.3 测试 `tests/units/llm-call-trace.test.ts`
- mock `@anthropic-ai/claude-agent-sdk` query + db upsertTraceStep（spy）。
- TC：sdkQuery(prompt, { trace: {chatJid:'g1'} }) → upsertTraceStep 被调一次，node_type 'llm_call'，chat_jid 'g1'，status 'done'。
- TC：sdkQuery(prompt, {})（无 trace）→ upsertTraceStep 不被调。
- TC：query 抛错 → status 'failed'，仍写入。

## 4. `/skill` IM 命令

### 4.1 `src/im-command-utils.ts`
- `OWNER_REQUIRED_IM_COMMANDS` 加 `'skill'`。

### 4.2 `src/routes/skills.ts`
- 导出 `getSkillDetail`（现 private）+ `SkillDetail` 类型（供 index.ts 复用）。

### 4.3 `src/skill-ai.ts`
- `debugSkill(skillContent, testInput, mode='ai', trace?: LlmCallTrace)`：real 模式 sdkQueryMessages 调用透传 `trace`（import LlmCallTrace from sdk-query）。

### 4.4 `src/index.ts` handleCommand
- `case 'skill': return handleSkillImCommand(chatJid, rawArgs, group);`（group 已在 handleCommand 解析，传引用避免重取）。
- 新函数 `handleSkillImCommand(chatJid, rawArgs, group)`：
  - parse：`const sp = rawArgs.split(/\s+/); skillId=sp[0]; testInput=rawArgs.slice(sp[0].length).trim();`
  - 校验 skillId + testInput 非空。
  - `const userId = group?.created_by;` 若无 → `⚠️ 该工作区未关联 DeepThink 账号，无法调用 Skill`。
  - `const skill = getSkillDetail(skillId, userId);` 若 !skill → `⚠️ 未找到 Skill: ${skillId}`；若 !skill.enabled → `⚠️ Skill 已禁用: ${skillId}`。
  - `const r = await debugSkill(skill.content, testInput, 'real', { chatJid, label: 'Skill: '+skillId });`
  - 若 'error' in r → `⚠️ ${r.error}`；否则返回 `truncate(r.output, 4000)`。
  - 冷却：复用 recallCooldowns 模式？加 `skillCooldowns` Map，10s 冷却防刷。

### 4.5 测试 `tests/skill-im-command.test.ts`
- mock getSkillDetail + debugSkill。
- TC：owner + 有效 skill + input → 调 debugSkill real + 返回 output。
- TC：缺 input → 提示用法。
- TC：skill 不存在 → 错误提示。
- TC：group 无 created_by → 错误提示。

## 5. 风险与缓解

- **trace 写入失败**：全部 best-effort try/catch，不阻断 query/IM 回复。
- **IM 长耗时**：/skill real 模式 60s 超时；飞书走 WS（非 webhook 3s 限制），与 /recall 同模式，可接受；加冷却防刷。
- **getSkillDetail 导出耦合**：routes/skills.ts 已是模块，导出函数无循环依赖风险（index.ts 已 import 多 route 模块）。
