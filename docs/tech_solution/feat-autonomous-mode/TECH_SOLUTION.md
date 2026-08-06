# 技术方案：DeepThink 全托管模式

> 文档版本：v1.0
> 创建日期：2026-08-06
> 关联 PRD：`docs/prd/feat-autonomous-mode/PRD.md`

---

## 1. 架构总览

### 1.1 设计原则

- **最小侵入**：所有新增分支条件 `if (autonomous)`，未命中走原路径，保证 default 行为不变
- **复用既有机制**：compaction auto-continue (line 2760) 作为自动续接模板；AskUserQuestion accumulator (line 64) 作为提问检测钩子；autonomy bus 作为事件总线
- **三层防护**：CLAUDE.md override（prompt 层） + Supervisor clarify 旁路（决策层） + 端回合自动续接（执行层）
- **硬刹车保守**：首版宁误杀不放过，所有阈值可配置

### 1.2 数据流

```
用户消息 (含 autonomous=true)
  │
  ▼
src/web.ts: handleWebUserMessage
  │
  ├─ 查询 autonomous 配置（per-message body / per-group container_config）
  │
  ▼
src/supervisor.ts: runSupervisorPreDispatch (autonomous hint=true)
  │ prompt 限制 action ∈ {delegate, auto, delegate_team}，禁用 clarify
  │
  ▼ （ clarify 被禁 → 不会停下问用户 ）
  │
src/index.ts:8433 buildContainerInput (含 autonomous: true)
  │
  ▼
src/container-runner.ts: runContainerAgent/runHostAgent
  │
  ├─ writeAgentProjectClaudeMd(group, agentDef, autonomous=true)
  │   追加 autonomous override 段到 data/groups/{folder}/CLAUDE.md
  │
  ▼
container/agent-runner/src/index.ts: main loop
  │
  ├─ systemPromptAppend 注入 <autonomous-mode> 块
  │
  ├─ runQuery() → SDK → 流式事件
  │   │
  │   ├─ stream-processor.ts 跟踪 AskUserQuestion + 累积 text
  │   │
  │   ├─ 硬刹车 1：Bash 工具 input 匹配破坏性正则 → exit
  │   ├─ 硬刹车 2：token 累计超 maxTokens → exit
  │   ├─ 硬刹车 3：轮次计数超 maxTurns → exit
  │   └─ 硬刹车 4：连续 3 轮输出 hash 相同 → exit
  │
  ▼ 单轮结束
line 2944
  │
  ├─ if (containerInput.autonomous && streamProcessor.lastTurnAskedUser)
  │     注入合成 IPC 消息 "无需提问，按最佳判断继续推进"
  │     进入下一轮 runQuery()
  │
  └─ else
       await waitForIpcMessage() （原路径，监督者模式）
```

### 1.3 数据持久化

| 数据 | 存储 | 字段 |
|---|---|---|
| per-group autonomous | `data/config/supervisor-enabled.json` 扩展为 `autonomous-enabled.json` 或合并结构 | `groups: { [chatJid]: boolean }` |
| scheduled_tasks.autonomous | DB schema v25 新增列 | `autonomous INTEGER DEFAULT 0` |
| per-run state（轮次/token/hash） | in-memory（agent-runner 进程内） | 不持久化 |
| 紧急停止信号 | IPC `_close` sentinel | 已有机制，复用 |

## 2. 文件改动清单

### 2.1 类型层

| 文件 | 行号 | 改动 |
|---|---|---|
| `container/agent-runner/src/types.ts` | 11-98 | `ContainerInput` 加 `autonomous?: boolean; maxTurns?: number; maxTokens?: number;` |
| `src/container-runner.ts` | 238-... | host 端 `ContainerInput` 同步加同 3 个字段 |
| `src/types.ts` | 50-77 | `RegisteredGroup.container_config` JSON 形状文档化 `autonomous?: boolean` |

### 2.2 Supervisor clarify 旁路

| 文件 | 行号 | 改动 |
|---|---|---|
| `src/supervisor.ts` | 23-58 | `runSupervisorPreDispatch(userMessage, userLanguage, opts?: { autonomous?: boolean })`，autonomous=true 时 prompt 限制 `action ∈ {delegate, auto, delegate_team}`，移除 `clarify` 选项 |
| `src/supervisor.ts` | 36 | prompt 文本："**禁止 clarify**：本任务为全托管模式，目标已明确，不允许向用户提问。缺失信息请按合理假设推进，并在 instruction 中说明你的假设。" |
| `src/supervisor.ts` | 60-83 | `parseDecision` 在 autonomous=true 时若 LLM 仍返回 clarify，自动降级为 `delegate`（不阻断流程） |
| `src/web.ts` | 480-530 | 计算 `autonomous` 标志（per-message + per-group 合并）；autonomous=true 时跳过 clarify 分支 |
| `src/web.ts` | 305 | `MessageCreateSchema` 加 `autonomous?: boolean` body 字段 |
| `src/web-context.ts` | 224 | `WebDeps.runSupervisorPreDispatch` 签名加 opts 参数 |
| `src/supervisor-config.ts` | 8-50 | 扩展为 `AutonomousConfig`：`{ groups: Record<chatJid, { supervisor: boolean; autonomous: boolean }> }`；新增 `isAutonomousEnabled(chatJid)` / `setAutonomousEnabled` / `getAllAutonomousEnabled` |
| `src/supervisor-agent.ts` | 565-580 | autonomous=true 时 escalate 不调用 `storePromptMessage + enqueueMessageCheck`，改为发 `autonomous.brake_triggered` 事件 + 日志 + 自动注入续接消息 |

### 2.3 CLAUDE.md 注入

| 文件 | 行号 | 改动 |
|---|---|---|
| `src/container-runner.ts` | 1187-1212 | `writeAgentProjectClaudeMd(group, agentDef, autonomous?)`：autonomous=true 时即使没有 agentDef 也写入 autonomous override 段 |
| `src/container-runner.ts` | 1214 | 新增 `buildAutonomousOverrideMd()` 函数，返回固定 override 文本（见 §3） |

### 2.4 端回合自动续接 + 硬刹车（agent-runner）

| 文件 | 行号 | 改动 |
|---|---|---|
| `container/agent-runner/src/stream-processor.ts` | 64 | 暴露 `lastTurnAskedUser: boolean` getter，重置方法 `resetTurnAskedFlag()` |
| `container/agent-runner/src/stream-processor.ts` | 406-411 | AskUserQuestion 工具调用命中时设 `lastTurnAskedUser = true` |
| `container/agent-runner/src/stream-processor.ts` | 新增 ~1300 | 暴露 `getFullTextSinceLastReset()` 用于循环检测 + 征询性正则匹配 |
| `container/agent-runner/src/index.ts` | 1542-1567 | `promptPieces` 追加 autonomous override piece（当 `containerInput.autonomous`） |
| `container/agent-runner/src/index.ts` | 新增 ~100 | `runAutonomousChecks()` 函数：轮次/token/循环/破坏性命令 4 项检查 |
| `container/agent-runner/src/index.ts` | 2944-2962 | autonomous 分支：检测 `lastTurnAskedUser` → 注入合成续接消息 → `continue` 主循环 |
| `container/agent-runner/src/index.ts` | 2536（runQuery 调用后） | 调用 `runAutonomousChecks()`，任一命中则 `writeOutput({status: 'error', error: 'brake: xxx'})` + `process.exit(1)` |

### 2.5 API & DB

| 文件 | 改动 |
|---|---|
| `src/db.ts` | SCHEMA_VERSION 24→25；`scheduled_tasks` 加列 `autonomous INTEGER DEFAULT 0`（用 ensureColumn 模式，向后兼容） |
| `src/routes/groups.ts` | PATCH /api/groups/:jid 接受 body `autonomous?: boolean`；GET /api/groups/:jid 返回字段；调用 `setAutonomousEnabled` |
| `src/routes/tasks.ts` | POST/PATCH 接受 `autonomous?: boolean`；持久化到 scheduled_tasks |
| `src/routes/config.ts` | 加路由 GET/PUT `/api/config/autonomous`（per-group 列表读写） |
| `src/routes/autonomous.ts` (新) | GET /api/autonomous/active（活跃任务列表，监控用） |
| `src/routes/monitor.ts` | GET /api/monitor 返回 `autonomous_active` 计数 |

### 2.6 前端

| 文件 | 改动 |
|---|---|
| `web/src/stores/autonomous-store.ts` (新) | Zustand store：`activeRuns`、`groupSettings`、`fetchActiveRuns`、`stopRun(id)` |
| `web/src/components/chat/AutonomousToggle.tsx` (新) | 输入框旁 toggle 按钮，控制 per-message autonomous |
| `web/src/components/chat/StopButton.tsx` (新) | 红色"停止"按钮，调 POST /api/messages/:id/stop |
| `web/src/components/settings/AutonomousSection.tsx` (新) | per-group autonomous toggle 表 |
| `web/src/pages/ChatPage.tsx` | 集成上述两个组件 |
| `web/src/pages/SettingsPage.tsx` | 集成 AutonomousSection |
| `web/src/pages/TasksPage.tsx` | 创建任务表单加 autonomous checkbox |
| `web/src/pages/MonitorPage.tsx` | 加自主任务区 + 紧急停止 |
| `web/src/stream-event.types.ts` | 加 `autonomous_started` / `autonomous_continued` / `autonomous_aborted` / `autonomous_brake` StreamEvent 类型（同步源 shared/stream-event.ts） |

### 2.7 可观测性

| 文件 | 改动 |
|---|---|
| `src/autonomy/autonomy-types.ts` | Capability union 加 `'execution'` 已有；事件类型加 `autonomous.started/continued/aborted/brake_triggered` |
| `src/autonomy/autonomy-metrics.ts` | EVENT_HANDLERS 加 4 个事件 → `execution.autonomous_runs` / `execution.autonomous_aborts` 度量 |
| `container/agent-runner/src/index.ts` | autonomous 触发点 emit 对应事件（经 IPC → 主服务 → autonomy bus） |

### 2.8 测试

| 文件 | 覆盖 |
|---|---|
| `tests/units/supervisor-autonomous.test.ts` (新) | U-1 |
| `tests/units/clarify-bypass.test.ts` (新) | U-2 |
| `tests/units/end-of-turn-detection.test.ts` (新) | U-3 |
| `tests/units/loop-detector.test.ts` (新) | U-4 |
| `tests/units/destructive-command.test.ts` (新) | U-5 |
| `tests/units/turn-counter.test.ts` (新) | U-6 |
| `tests/units/autonomous-directive.test.ts` (新) | U-7 |
| `tests/units/auto-continue.test.ts` (新) | U-8 |
| `tests/units/scheduled-task-autonomous.test.ts` (新) | U-9 |
| `tests/units/group-autonomous-config.test.ts` (新) | U-10 |
| `tests/e2e/autonomous-mode.mjs` (新) | E-1 |
| `tests/e2e/autonomous-brake.mjs` (新) | E-2 |
| `tests/e2e/autonomous-stop-button.mjs` (新) | E-3 |

## 3. 关键代码片段

### 3.1 Autonomous Override 段（注入 CLAUDE.md 与 systemPromptAppend）

```markdown
## Autonomous Override（系统注入，本任务专用）

本任务标记为 **全托管模式**（autonomous=true）。以下规则**显式压过** `Think Before Coding` 原则中的 "if unclear, halt and ask"：

1. **禁止向用户提问**。不得调用 AskUserQuestion 工具，不得在文本中输出征询性短语（"你说一声"、"下一步要继续哪个方向"、"请确认"等）。
2. **缺失信息按合理假设推进**。在响应开头用 <assumption> 标签声明你的假设，然后继续执行。
3. **方向分叉时按以下优先级决策**：
   a. 推进进度 > 单节密度 > 篇幅
   b. 任务已交付部分优先扩展至目标，再进入下一节
   c. 任务未全部完成前禁止总结性收尾
4. **唯一允许停止的情况**：硬刹车触发（轮次/token 超限、循环输出、破坏性命令检测）。这些由系统强制终止，你无需也无法干预。
5. 如果你的最佳判断是"任务无法完成"（如目标本质不可达），**直接输出失败原因并停止**，不要询问用户怎么办。

本 override 仅在本任务期间生效，任务结束后自动失效。
```

### 3.2 Supervisor prompt 修改

```typescript
// src/supervisor.ts:27-41
export async function runSupervisorPreDispatch(
  userMessage: string,
  userLanguage: string,
  opts?: { autonomous?: boolean },
): Promise<SupervisorDecision | null> {
  const autonomousDirective = opts?.autonomous
    ? [
        '【全托管模式】',
        '- **禁止 clarify**：目标已明确，不允许向用户提问。',
        '- 缺失信息请按合理假设推进，并在 instruction 中说明假设。',
        '- action 只能是 delegate / auto / delegate_team 三选一。',
      ].join('\n')
    : '';

  const prompt = [
    '用户将以下任务托管给你（Supervisor）。请判断如何处理。',
    '',
    `用户语言：${userLanguage}`,
    '',
    autonomousDirective,
    '',
    '【用户消息】',
    userMessage.slice(0, 4000),
    '',
    '请输出严格 JSON（不要 markdown 代码块）：',
    '{"action":"clarify"|"delegate"|"auto"|"delegate_team","instruction"?:string,"question"?:string}',
    ...(opts?.autonomous
      ? ['- 注意：当前为全托管模式，clarify 已被禁用。即便你认为目标模糊，也必须选 delegate 并按合理假设推进。']
      : [
          '- clarify: 消息模糊，向用户提问。question 字段必填。',
          '- delegate: 意图清晰，原样转发。instruction 字段填原消息精简版。',
          '- auto: 意图清晰但可优化表达，instruction 字段填你重写的指令。',
          '- delegate_team: 任务复杂、需要多角色协作。',
        ]),
  ].join('\n');
  // ...rest unchanged
}

// parseDecision: autonomous=true 时 clarify 自动降级为 delegate
export function parseDecision(raw: string, opts?: { autonomous?: boolean }): SupervisorDecision | null {
  // ... existing parsing ...
  if (action === 'clarify' && opts?.autonomous) {
    logger.warn('Supervisor returned clarify in autonomous mode, downgrading to delegate');
    return { action: 'delegate', instruction: parsed.instruction ?? userMessage };
  }
  // ...
}
```

### 3.3 端回合自动续接

```typescript
// container/agent-runner/src/index.ts:2944 (after "Query ended, waiting for next IPC message...")
if (containerInput.autonomous) {
  const askedUser = streamProcessor.lastTurnAskedUser;
  const brakeCheck = runAutonomousChecks(); // { triggered: boolean; reason?: string }
  if (brakeCheck.triggered) {
    log(`Hard brake triggered: ${brakeCheck.reason}`);
    writeOutput({
      status: 'error',
      result: null,
      error: `autonomous_brake: ${brakeCheck.reason}`,
    });
    process.exit(1);
  }
  if (askedUser) {
    log('Autonomous mode: agent asked user, injecting synthetic continue message');
    const autoContinuePrompt = [
      '【系统提示】无需向用户提问。请按你的最佳判断继续推进任务目标。',
      '如果你刚才在 <assumption> 中声明了假设，请直接基于该假设执行。',
      '如果当前子任务已完成，进入下一个子任务。',
      '如果所有子任务都已完成，输出最终交付物。',
    ].join('\n');
    containerInput.turnId = generateTurnId();
    const autoContResult = await runQuery(
      autoContinuePrompt,
      sessionId,
      mcpServerConfig,
      containerInput,
      memoryRecallPrompt,
      resumeAt,
      true,
      DEFAULT_ALLOWED_TOOLS,
      undefined,
      undefined,
      'autonomous_continue', // new sourceKind
    );
    // ... handle result like compaction auto-continue ...
    continue; // skip waitForIpcMessage
  }
}

// Fall through to wait for IPC (supervisor mode default path)
const nextMessage = await waitForIpcMessage();
```

### 3.4 硬刹车实现

```typescript
// container/agent-runner/src/index.ts (new module-level state)
const autonomousState = {
  turnCount: 0,
  tokenCount: 0,
  outputHashes: [] as string[],
};

const DESTRUCTIVE_PATTERNS = [
  /rm\s+-rf\s+\/(\s|$)/,
  /git\s+push\s+(-f|--force|--force-with-lease)/,
  /git\s+reset\s+--hard/,
  /git\s+checkout\s+--\s+\./,
  /DROP\s+TABLE/i,
  /DROP\s+DATABASE/i,
  /TRUNCATE\s+TABLE/i,
  /DELETE\s+FROM\s+\w+\s*;(\s|$)/i, // unguarded DELETE
  /:\(\)\s*\{\s*:\s*\|\s*:.*\}\s*;/, // fork bomb
  /\bmkfs\./,
  /\bdd\s+if=.*of=\/dev\//,
];

function runAutonomousChecks(): { triggered: boolean; reason?: string } {
  const maxTurns = containerInput.maxTurns ?? 50;
  const maxTokens = containerInput.maxTokens ?? 1_000_000;

  if (autonomousState.turnCount >= maxTurns) {
    return { triggered: true, reason: `turn_limit_exceeded (${maxTurns})` };
  }
  if (autonomousState.tokenCount >= maxTokens) {
    return { triggered: true, reason: `token_limit_exceeded (${maxTokens})` };
  }

  // Loop detection: 3 consecutive identical hashes
  const hashes = autonomousState.outputHashes;
  if (hashes.length >= 3) {
    const last3 = hashes.slice(-3);
    if (last3[0] === last3[1] && last3[1] === last3[2]) {
      return { triggered: true, reason: 'loop_detected (3 identical turns)' };
    }
  }
  return { triggered: false };
}

// Hook into stream-processor for destructive command detection
// In stream-processor.ts: when tool_use_start for 'Bash' arrives with input
// matching DESTRUCTIVE_PATTERNS, set brakeFlag = 'destructive_command' and
// the main loop's runAutonomousChecks will pick it up.
```

### 3.5 DB schema migration (v24→v25)

```typescript
// src/db.ts
const SCHEMA_VERSION = 25; // was 24

// In ensureColumn section near line 1294
ensureColumn(db, 'scheduled_tasks', 'autonomous', {
  type: 'INTEGER',
  default: 0,
  notNull: true,
});
```

### 3.6 supervisor-config.ts 扩展

```typescript
// src/supervisor-config.ts
interface AutonomousConfig {
  groups: Record<string, { supervisor: boolean; autonomous: boolean }>;
}

export async function isAutonomousEnabled(chatJid: string): Promise<boolean> {
  const cfg = await loadConfig();
  return cfg.groups[chatJid]?.autonomous ?? false;
}

export async function setAutonomousEnabled(chatJid: string, enabled: boolean): Promise<void> {
  const cfg = await loadConfig();
  cfg.groups[chatJid] = { ...cfg.groups[chatJid], autonomous: enabled };
  await saveConfig(cfg);
}
```

## 4. 端回合检测：双信号

### 4.1 信号 A：AskUserQuestion 工具调用

`stream-processor.ts:64` 已经累积 AskUserQuestion 工具 input。新增暴露：

```typescript
// stream-processor.ts
private lastTurnAskedUser = false;

// In tool_use_start handler for AskUserQuestion:
this.lastTurnAskedUser = true;

get lastTurnAskedUserFlag(): boolean {
  return this.lastTurnAskedUser;
}

resetTurnAskedFlag(): void {
  this.lastTurnAskedUser = false;
}
```

### 4.2 信号 B：文本征询正则

```typescript
const ASKING_PATTERNS = [
  /\?\s*$/, // ends with ?
  /？\s*$/, // ends with full-width ？
  /你说一声/,
  /你说/,
  /要继续/,
  /可以继续/,
  /要扩展/,
  /要哪个方向/,
  /请确认/,
  /请告诉我/,
  /要我开始/,
  /是否继续/,
  /要不要/,
  /你看/,
  /请回复/,
];
```

匹配时机：单轮 query() 结束后，取 `streamProcessor.getFullTextSinceLastReset()` 末尾 500 字符做匹配。任一命中 → `lastTurnAskedUser = true`。

### 4.3 双信号合并

`lastTurnAskedUser = signalA || signalB`。单信号不触发（避免误判）。**注**：AskUserQuestion 工具调用是强信号，单独命中也可触发（这是 SDK 一等公民的提问机制）。文本正则弱信号需配合工具调用或多个正则同时命中。

修正：信号 A 单独触发；信号 B 需 2+ 个正则同时命中。

## 5. 硬刹车条件汇总

| 刹车 | 阈值 | 默认 | 配置 |
|---|---|---|---|
| 轮次超限 | `turnCount >= maxTurns` | 50 | `ContainerInput.maxTurns` |
| Token 超限 | `tokenCount >= maxTokens` | 1,000,000 | `ContainerInput.maxTokens` |
| 循环输出 | 连续 3 轮 text_delta hash 相同 | - | 不可配 |
| 破坏性命令 | Bash 工具 input 匹配黑名单正则 | - | 不可配 |
| 用户紧急停止 | 收到 `_close` sentinel | - | 已有机制 |

## 6. CLAUDE.md override 注入位置选择

### 6.1 候选 A：扩展现有 `writeAgentProjectClaudeMd`

`src/container-runner.ts:1187`：当前仅在 `agentDef?.systemPrompt` 存在时写。改为 `autonomous=true` 时即使无 agentDef 也写一个最小 CLAUDE.md，包含 override 段。

### 6.2 候选 B：systemPromptAppend 直接注入

`container/agent-runner/src/index.ts:1542-1567`：在 `promptPieces` 末尾追加 `{ name: 'autonomous.md', text: '<autonomous-mode>...</autonomous-mode>' }`。

**决策**：A + B 双重注入。
- A 写入 CLAUDE.md：作为 project memory，**SDK 层面**会被加载到 user memory 之后，对所有 turn 生效。
- B 注入 systemPromptAppend：作为 system prompt 一等片段，**强约束**当前 query，无法被 agent 通过修改 CLAUDE.md 规避。

理由：CLAUDE.md override 是软约束（agent 可能"忘记"），system prompt 是硬约束。两者并行，覆盖更全。

## 7. 风险与回滚

### 7.1 回滚策略

- 任一改动均带 `autonomous` 条件守卫，未命中走原路径
- DB schema 用 `ensureColumn` 增量加列，不破坏现有数据
- `supervisor-config.ts` 旧字段 `groups: Record<chatJid, boolean>` 自动迁移到新结构 `{ supervisor, autonomous }`

### 7.2 灰度策略（可选，不在本版交付）

可加 `AUTONOMOUS_MODE_ENABLED` 全局开关，默认 false，开启后 `setAutonomousEnabled` 才生效。本版直接交付，靠 per-group/per-message 显式开关控制。

### 7.3 已知风险

| 风险 | 缓解 |
|---|---|
| 文本征询正则误命中（agent 自然语言中带"？"但非提问）| 弱信号需 2+ 正则同时命中；AskUserQuestion 工具调用作为强信号独立判定 |
| Agent 用迂回方式询问（如"如果你同意，我就..."）| 正则覆盖 14 种常见模式 + 持续迭代 |
| 全托管任务跑飞烧 token | Token 上限刹车 + 用户紧急停止 + UI 显示实时 token 消耗 |
| 默认监督者模式被误改 | 所有改动带 `if (autonomous)` 守卫，default 路径不变 |
| scheduled_tasks 表迁移失败 | `ensureColumn` idempotent + 自动 catch error |

## 8. 实施计划

### 阶段 1：基础设施（类型 + DB + Supervisor 旁路）
1. ContainerInput 加字段（types.ts + container-runner.ts:238）
2. SCHEMA_VERSION 25 + scheduled_tasks.autonomous 列
3. supervisor.ts 接受 autonomous hint + parseDecision 降级
4. supervisor-config.ts 加 autonomous 字段
5. web.ts 计算并透传 autonomous

### 阶段 2：执行层（agent-runner 改造）
6. stream-processor.ts 暴露 lastTurnAskedUser + reset
7. container-runner.ts writeAgentProjectClaudeMd 注入 override
8. agent-runner index.ts systemPromptAppend 注入 override
9. agent-runner index.ts 端回合自动续接
10. agent-runner index.ts 4 项硬刹车

### 阶段 3：API + 持久化
11. routes/groups.ts PATCH autonomous
12. routes/tasks.ts POST/PATCH autonomous
13. routes/config.ts autonomous 路由
14. routes/autonomous.ts 新文件（active 列表 + 紧急停止）

### 阶段 4：前端
15. web/src/stores/autonomous-store.ts
16. web/src/components/chat/AutonomousToggle.tsx + StopButton.tsx
17. web/src/components/settings/AutonomousSection.tsx
18. ChatPage / SettingsPage / TasksPage / MonitorPage 集成
19. shared/stream-event.ts 加 4 个事件类型 + make sync-types

### 阶段 5：可观测性
20. autonomy-types.ts 加事件类型
21. autonomy-metrics.ts 加 EVENT_HANDLERS
22. emit 触发点

### 阶段 6：测试
23. 10 个单测文件
24. 3 个 e2e 文件

### 阶段 7：验收 + 文档
25. 跑全量测试
26. 写测试报告
27. 合并 worktree → main
28. push

## 9. 度量指标

实施完成后需在 PR 中提供：

- 单测：10 文件 / 预期 ≥ 30 test cases 全绿
- E2E：3 文件 / 预期全绿
- typecheck：`make typecheck` 全绿
- 现有约束测试：`make test` 全绿（无回归）
- 长任务验证：手工触发一次全托管写作任务，验证不中断 + 硬刹车可触发

## 10. 关键 file:line 速查

```
# 类型
container/agent-runner/src/types.ts:11              ← ContainerInput（runner）
src/container-runner.ts:238                        ← ContainerInput（host）
src/types.ts:50-77                                 ← RegisteredGroup

# Supervisor
src/supervisor.ts:23-58                            ← runSupervisorPreDispatch
src/supervisor.ts:60-83                            ← parseDecision
src/supervisor-config.ts:36-49                     ← enabled toggles
src/web.ts:480-530                                 ← clarify consumer
src/web.ts:305                                     ← MessageCreateSchema
src/web-context.ts:224                             ← WebDeps

# Mid-task supervisor
src/supervisor-agent.ts:565-580                    ← escalate side-effect

# Agent-runner
container/agent-runner/src/index.ts:1542-1567      ← systemPromptAppend assembly
container/agent-runner/src/index.ts:2760-2835     ← compaction auto-continue (template)
container/agent-runner/src/index.ts:2944-2962      ← end-of-turn wait site
container/agent-runner/src/stream-processor.ts:64 ← AskUserQuestion accumulator

# CLAUDE.md injection
src/container-runner.ts:1187-1212                  ← writeAgentProjectClaudeMd
src/container-runner.ts:1214                       ← buildAgentProjectClaudeMdContent

# DB
src/db.ts:344-361                                  ← scheduled_tasks schema
src/db.ts:741-749                                  ← registered_groups schema
src/db.ts:1294-1300                                ← ensureColumn pattern

# API entry points
src/web.ts:302                                     ← POST /api/messages
src/index.ts:8433                                  ← ContainerInput assembly
src/index.ts:8482                                  ← runContainerAgent
src/task-scheduler.ts:612                          ← scheduled task launch
```

## 11. 附录：破坏性命令正则（含理由）

| 正则 | 命中场景 | 理由 |
|---|---|---|
| `rm\s+-rf\s+\/(\s\|$)` | `rm -rf /` | 删根 |
| `git\s+push\s+(-f\|--force)` | `git push --force` | 覆盖远程历史 |
| `git\s+reset\s+--hard` | `git reset --hard` | 丢弃未提交工作 |
| `git\s+checkout\s+--\s+\.` | `git checkout -- .` | 还原所有改动 |
| `DROP\s+TABLE` | SQL DROP TABLE | 删表 |
| `DROP\s+DATABASE` | SQL DROP DATABASE | 删库 |
| `TRUNCATE\s+TABLE` | SQL TRUNCATE | 清表 |
| `DELETE\s+FROM\s+\w+\s*;(\s\|$)` | unguarded DELETE | 清表 |
| `:\(\)\s*\{\s*:\s*\|\s*:.*\}\s*;` | fork bomb `:(){ :|: & };` | 进程风暴 |
| `\bmkfs\.` | `mkfs.ext4 /dev/sda` | 格盘 |
| `\bdd\s+if=.*of=\/dev\/` | `dd if=... of=/dev/sda` | 写裸盘 |
