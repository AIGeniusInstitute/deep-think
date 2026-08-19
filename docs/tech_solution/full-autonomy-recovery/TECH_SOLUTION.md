# 技术方案：DeepThink 全自主恢复引擎（Full Autonomy Recovery Engine）

> 分支：`feat/full-autonomy-recovery` ｜ worktree：`~/deepthink/.worktrees/feat-full-autonomy-recovery`
> 创建日期：2026-08-19
> 关联 PRD：`docs/prd/full-autonomy-recovery/PRD.md`
> 上游：`feat-autonomous-mode`（已合并，本方案在其上叠加恢复层，不改其既有断言）

---

## 0. 设计原则

1. **Surgical Changes**：只改 4 处 `process.exit(1)` + 新增 1 个恢复模块 + 2 个事件类型 + 接入点。不动既有自主层总线/度量/学习采集器。
2. **镜像现有 auto-continue 模式**：恢复注入完全复用 `index.ts:3152-3174` 的"合成 prompt + runQuery(auto-continue)"通路，零新控制流。
3. **不可恢复兜底**：每类刹车 `MAX_RECOVERY_ATTEMPTS=3` 硬上限，超限走原 `exit(1)` 路径。全局 turn/token 硬上限不变。
4. **Sutton 对齐**：摩擦不死→改策略续跑（generate-and-test）；经验回注（continual learning 近似）。

---

## 1. 总体架构

```
container/agent-runner/src/index.ts (主循环 while(true))
  ├─ runQuery() → queryResult.autonomousSignals
  ├─ [现有] autonomous_started / hash push
  ├─ ──[改造] 4 道刹车 → requestRecovery()──┐
  │                                            │
  │   terminal? ──yes──→ 原 writeOutput(brake)+exit(1)  [兜底]
  │   no → emit autonomous_recovering + 注入恢复prompt + runQuery(continue)
  │                          ↑ 镜像 3152-3174 auto-continue
  ├─ [现有] end-of-turn askedUser → auto-continue
  └─ waitForIpcMessage()

新增 container/agent-runner/src/autonomy-recovery.ts
  ├─ RecoveryState (per-brake 计数器 + 衰减)
  ├─ requestRecovery(brakeType, ctx, state) → {terminal, prompt, strategy}
  └─ buildRecoveryPrompt(brakeType, ctx) → 逐刹车策略文本

shared/stream-event.ts (事件类型源)
  └─ + 'autonomous_recovering' | 'autonomous_recovered'
     + autonomous.strategy / autonomous.attempt 字段
```

---

## 2. P0 详细设计

### 2.1 新增模块 `container/agent-runner/src/autonomy-recovery.ts`

```ts
export type BrakeType = 'destructive_command' | 'turn_limit' | 'token_limit' | 'loop_detected';

export interface RecoveryContext {
  destructiveCmd?: string;
  turnCount: number;
  maxTurns: number;
  totalTokens: number;
  maxTokens: number;
  goalSnippet?: string;
}

export interface RecoveryResult {
  terminal: boolean;
  prompt?: string;     // 注入的恢复提示（terminal 时无）
  strategy?: string;   // 事件载荷用
  attempt?: number;
  // turn_limit 恢复时返回新的 maxTurns（升档）
  newMaxTurns?: number;
  // token_limit/turn_limit 恢复时要求先凝结
  requireCompaction?: boolean;
  // loop_detected 恢复时要求清空 hash 窗口
  clearHashWindow?: boolean;
  // destructive 恢复时要求清除 destructive 信号
  clearDestructiveSignal?: boolean;
}

export const MAX_RECOVERY_ATTEMPTS = 3;
const TURN_BUDGET_STEPS = [50, 100, 150, 200]; // 升档阶梯，200 为硬上限

export class RecoveryState {
  private attempts: Record<BrakeType, number> = {
    destructive_command: 0, turn_limit: 0, token_limit: 0, loop_detected: 0,
  };
  // 该类刹车成功推进 ≥1 轮后衰减（见 AC1.1.3），避免历史惩罚永久累积
  private sinceLastBrake: Record<BrakeType, number> = { ...all 0 };

  request(brake: BrakeType, ctx: RecoveryContext): RecoveryResult {
    const attempt = ++this.attempts[brake];
    if (attempt > MAX_RECOVERY_ATTEMPTS) {
      return { terminal: true };
    }
    return buildRecovery(brake, ctx, attempt);
  }

  // 主循环每轮成功后调用：各类刹车 sinceLastBrake++；>=2 轮未再触发则 attempts 衰减 1
  tickSuccess() {
    (Object.keys(this.attempts) as BrakeType[]).forEach((b) => {
      this.sinceLastBrake[b]++;
      if (this.sinceLastBrake[b] >= 2 && this.attempts[b] > 0) {
        this.attempts[b] = Math.max(0, this.attempts[b] - 1);
        this.sinceLastBrake[b] = 0;
      }
    });
  }
}

function buildRecovery(brake: BrakeType, ctx: RecoveryContext, attempt: number): RecoveryResult {
  switch (brake) {
    case 'destructive_command':
      return {
        terminal: false, attempt,
        strategy: 'safe_alternative',
        clearDestructiveSignal: true,
        prompt: [
          '【系统提示：恢复指令】',
          `你刚才拟执行的命令被安全规则拦截：${(ctx.destructiveCmd || '').slice(0, 200)}`,
          '请改用安全等价方案，禁止重放原命令：',
          '- rm -rf / → 限定到具体子路径，或用 mv 移到 /tmp，或用 trash 工具',
          '- git push --force → 改用普通 git push，或新建分支后再推送',
          '- git reset --hard → 用 git restore 指定文件，或先 stash',
          '- DROP/TRUNCATE TABLE → 改用 DELETE 带条件，或先备份',
          '- mkfs/dd to device → 停止，这不可安全替代，换任务路径',
          '选择安全方案后继续推进任务目标。',
        ].join('\n'),
      };
    case 'turn_limit': {
      const idx = TURN_BUDGET_STEPS.indexOf(ctx.maxTurns);
      const nextMax = idx >= 0 && idx < TURN_BUDGET_STEPS.length - 1
        ? TURN_BUDGET_STEPS[idx + 1]
        : (ctx.maxTurns >= 200 ? -1 : 200);
      if (nextMax < 0) return { terminal: true }; // 硬上限
      return {
        terminal: false, attempt,
        strategy: 'checkpoint_compact_resume',
        newMaxTurns: nextMax,
        requireCompaction: true,
        prompt: [
          '【系统提示：恢复指令】',
          `已执行 ${ctx.turnCount} 轮，触达轮次预算。已为你检查点存档并凝结上下文。`,
          `轮次预算提升至 ${nextMax}。请基于凝结后的进度摘要继续推进，不要重复已完成步骤。`,
          `任务目标：${(ctx.goalSnippet || '').slice(0, 300)}`,
        ].join('\n'),
      };
    }
    case 'token_limit':
      return {
        terminal: false, attempt,
        strategy: 'force_compact_resume',
        requireCompaction: true,
        prompt: [
          '【系统提示：恢复指令】',
          '上下文 token 触达上限，已强制凝结。请基于凝结后的进度摘要继续推进任务，',
          '不要重复已完成步骤，聚焦未完成子任务。',
          `任务目标：${(ctx.goalSnippet || '').slice(0, 300)}`,
        ].join('\n'),
      };
    case 'loop_detected':
      return {
        terminal: false, attempt,
        strategy: 'reflect_and_pivot',
        clearHashWindow: true,
        prompt: [
          '【系统提示：恢复指令】',
          '你已连续 3 轮产出相同结果，陷入循环。请明确反思当前策略为何无法推进，然后改用不同方法：',
          '- 换工具（用 web_search 查资料 / 用 sandbox_run_code 验证 / 用浏览器抓取）',
          '- 换路径（拆解为更小子任务、从另一入口切入）',
          '- 查文档或过往经验（memory_search）',
          '反思后必须产出与之前不同的行动。',
        ].join('\n'),
      };
  }
}
```

### 2.2 改造 `index.ts` 4 道刹车（核心 diff）

在 `index.ts:2546-2552` 自治状态块后追加：
```ts
import { RecoveryState } from './autonomy-recovery.js';
const recoveryState = new RecoveryState();
```

把 `index.ts:3032-3127` 的 4 个 `process.exit(1)` 块各自替换为恢复分支。以破坏性命令为例（其余 3 个同构）：

```ts
// Hard brake 1: destructive Bash command detected this turn.
const destructiveCmd = signals.lastTurnDestructiveCmd;
if (destructiveCmd) {
  const recovery = recoveryState.request('destructive_command', {
    destructiveCmd, turnCount: autonomousTurnCount, maxTurns, totalTokens, maxTokens, goalSnippet: prompt.slice(0, 300),
  });
  if (recovery.terminal) {
    log(`Unrecoverable brake: destructive_command (attempts exhausted)`);
    writeOutput({ /* ...原 brake 输出... */ });
    process.exit(1);
  }
  // 恢复路径：emit recovering + 注入 prompt + auto-continue
  log(`Recovery attempt ${recovery.attempt}/3 for destructive_command`);
  writeOutput({ status:'stream', result:null, streamEvent:{
    eventType:'autonomous_recovering', displayLevel:'primary', statusText:'autonomous_recovering',
    autonomous:{ reason:'destructive_command', strategy:recovery.strategy, attempt:recovery.attempt, turnCount:autonomousTurnCount, message:destructiveCmd.slice(0,200) } } });
  // 镜像 auto-continue 通路（3152-3174）
  containerInput.turnId = generateTurnId();
  const recResult = await runQuery(recovery.prompt!, sessionId, mcpServerConfig, containerInput, memoryRecallPrompt, resumeAt, true, DEFAULT_ALLOWED_TOOLS, undefined, undefined, 'autonomous_recover');
  if (recResult.newSessionId) { sessionId = recResult.newSessionId; latestSessionId = sessionId; }
  if (recResult.lastAssistantUuid) { resumeAt = recResult.lastAssistantUuid; }
  if (recResult.closedDuringQuery) { /* autonomous_aborted user_stop */ break; }
  continue; // 跳过本轮后续（askedUser 检测等），回到 while 顶
}
```

**turn_limit 恢复**额外动作：恢复前 `if (recovery.newMaxTurns) containerInput.maxTurns = recovery.newMaxTurns;`，且 `requireCompaction` 时复用现有 compaction 通路（见 2.3）。

**token_limit 恢复**：`requireCompaction` 同上。

**loop_detected 恢复**：`recovery.clearHashWindow` 时 `autonomousOutputHashes.length = 0;`。

**每轮成功衰减**：在 autonomous 分支末尾（3127 之后、askedUser 之前）加 `recoveryState.tickSuccess();`，表示本轮无刹车命中、推进成功。

### 2.3 凝结复用现有通路

`requireCompaction` 不新写凝结逻辑——直接复用 `index.ts:2637-2657` 的 context-overflow 重试（已调 SDK 自动压缩）。具体：恢复路径注入 prompt 后，若 `requireCompaction`，先触发一次 `consecutiveCompactions` 递增 + 让 SDK 在下一 query 自然压缩（runQuery 内部已处理 overflow）。若凝结已达 `MAX_CONSECUTIVE_COMPACTIONS=3`，恢复降级为 terminal（避免无限凝结）。**这是 P0 最小实现**；P1 可加显式摘要调用。

### 2.4 事件类型

`shared/stream-event.ts`：
- `StreamEventType` 联合追加 `'autonomous_recovering' | 'autonomous_recovered'`。
- `autonomous` 接口追加 `strategy?: string; attempt?: number;`。
- 同步副本（`container/agent-runner/src/stream-event.types.ts`、`src/stream-event.types.ts`、`web/src/stream-event.types.ts`）由 `make build` 生成。

### 2.5 前端渲染（最小）

`web/src/components/loops/InlineLoopCard.tsx` 或 autonomous banner：识别 `autonomous_recovering` 渲染黄色 banner（"恢复中：{strategy}，第 {attempt}/3 次"）；`autonomous_recovered` 渲染绿色一行（已恢复）。**P0 只做事件透传 + banner，不改 DAG 面板**。

---

## 3. P1 详细设计

### 3.1 F3 自主知识/工具缺口消解

**落点**：`index.ts:3129-3135` 的 `askedUser` 检测块。在现有"注入 auto-continue prompt"**之前**插入消解尝试：

新增 `container/agent-runner/src/gap-resolver.ts`：
```ts
export type GapKind = 'knowledge_gap' | 'tool_gap' | 'decision';
export async function classifyAndResolve(turnText: string, emit): Promise<{resolved: boolean; prompt?: string; kind: GapKind}> {
  const kind = classifyGap(turnText); // 规则：含"是什么/怎么/哪里/哪个版本"→knowledge_gap；含"缺少/没有...工具/能力"→tool_gap；其余→decision
  if (kind === 'knowledge_gap') {
    const query = extractQuery(turnText);
    const results = await webSearch(query);   // 复用 mcp-tools web_search
    const fetched = await webFetchTop(results); // top-1 web_fetch
    if (fetched) return { resolved: true, kind, prompt: `【系统提示：已自动检索】\n${fetched}\n据此继续，不再提问。` };
    return { resolved: false, kind: 'decision' }; // 回退
  }
  if (kind === 'tool_gap') { /* install_skill/create_skill 尝试，失败回退 */ }
  return { resolved: false, kind: 'decision' };
}
```

`index.ts` 接入：`askedUser` 命中 → `const r = await classifyAndResolve(turnText, ...)` → `r.resolved` 用 `r.prompt` 作 auto-continue prompt；否则走现有 `<assumption>` prompt。

### 3.2 F4 经验回注入执行

**落点**：
- `src/agent-team/team-builder.ts` 的 `decompose()`（`:276` 起）调 `buildDecompositionPrompt` 前，`const lessons = await searchLessons('decision', [task keywords])`，把 top-3 lesson 文本 prepend 到分解 prompt。
- `src/loop-orchestrator.ts` 的 `executeGoalLoop`（`:434`）首轮 `runOneIteration` 前，同样 `searchLessons('execution', [goal keywords])` prepend。

`searchLessons` 已存在于 `autonomy-learning.ts:121`，无需新增。仅在调用点注入。

---

## 4. P2 详细设计

### 4.1 F5 适应闭环补全
`src/autonomy/autonomy-adapt.ts` 的 5s tick（`:102-113`）消费信号时：若 signal 有 `target_run_id`，调 `sdkQuery` 生成策略调整文本，写回 `payload_json.adjustment`，emit `adaptation.adjusted(adjustment, latency_ms)`。调整注入：对应 loop_run/graph_run 的下一轮 prompt（经 `autonomy_signals` → 读取方注入）。失败 try/catch 回退现有"标记 applied"。

### 4.2 F6 gate 失败自动续跑
`src/graph-engineering/graph-runner.ts` 的 `runGateNode`（`:434-496`）失败返回前，检查 `gateRetryCount < GATE_RETRY_MAX=2`：把失败证据（assertions 失败项 + shellCheck 输出）注入上游 agent 节点 goalAnchor + 调 `graph-orchestrator` 重置上游 node_run 状态为 pending 触发重跑。需在 `graph-orchestrator.ts:executeGraph` 的 completed-set 逻辑里支持"重置 pending 节点"。超限 → 现有 failed。

### 4.3 F7 外部交互经验归档
`container/agent-runner/src/mcp-tools.ts` 的 `web_search`(`:2143`)/`web_fetch`(`:2227`)/`sandbox_run_code`(`:1862`) 执行末尾，emit 一条 `perception`/`execution` capability 的 autonomy 事件携带 (query/url, 摘要)，宿主 `autonomy-learning.ts` 订阅后写 `autonomy_lessons`。需扩 `autonomy-learning.ts` 订阅一个新事件类型 `execution.tool_artifact`。

---

## 5. 改动文件清单

| 文件 | 改动 | 阶段 |
|---|---|---|
| `container/agent-runner/src/autonomy-recovery.ts` | **新增** RecoveryState + requestRecovery + buildRecovery | P0 |
| `container/agent-runner/src/index.ts` | 改 4 处 exit(1)→恢复分支；加 recoveryState + tickSuccess | P0 |
| `shared/stream-event.ts` + 3 副本 | +2 事件类型 +2 字段 | P0 |
| `web/src/components/loops/InlineLoopCard.tsx` | recovering/recovered banner（最小） | P0 |
| `container/agent-runner/src/gap-resolver.ts` | **新增** 分类+消解 | P1 |
| `container/agent-runner/src/index.ts` | askedUser 前插消解 | P1 |
| `src/agent-team/team-builder.ts` | decompose 前注入 lessons | P1 |
| `src/loop-orchestrator.ts` | executeGoalLoop 首轮注入 lessons | P1 |
| `src/autonomy/autonomy-adapt.ts` | 信号消费时 LLM re-plan | P2 |
| `src/graph-engineering/graph-runner.ts` + `graph-orchestrator.ts` | gate 失败重跑上游 | P2 |
| `container/agent-runner/src/mcp-tools.ts` + `src/autonomy/autonomy-learning.ts` | 工具产出归档 lesson | P2 |

---

## 6. 测试计划

| 用例 | 类型 | 阶段 |
|---|---|---|
| `tests/units/recovery-state.test.ts` | 单测：计数器边界+独立性+衰减 | P0 |
| `tests/units/recovery-turn-budget.test.ts` | 单测：升档+硬上限 | P0 |
| `tests/units/stream-event-recovery.test.ts` | 单测：事件 round-trip | P0 |
| `tests/e2e/autonomous-recovery-destructive.mjs` | E2E：破坏命令恢复 | P0 |
| `tests/e2e/autonomous-recovery-loop.mjs` | E2E：循环检测恢复 | P0 |
| `tests/units/gap-classifier.test.ts` | 单测：缺口分类+消解 | P1 |
| `tests/units/lessons-reinjection.test.ts` | 单测：lessons 注入 prompt | P1 |
| `tests/units/adapt-replan.test.ts` | 单测：信号→LLM 调整 | P2 |
| `tests/units/gate-auto-resume.test.ts` | 单测：gate 失败重跑 | P2 |
| `tests/units/tool-artifact-lesson.test.ts` | 单测：工具产出归档 | P2 |

**回归红线**：现有 `1226+/1239+` 测试基线不下降（全部新增功能用新文件，不改既有断言）。

---

## 7. 验收（对照 PRD §5 量化标准）

| 指标 | 验证方式 |
|---|---|
| 可恢复刹车自动恢复率 ≥ 80% | E2E destructive+loop 两个场景，恢复后继续推进即算恢复 |
| 知识缺口消解率 ≥ 70% | gap-classifier 单测覆盖 |
| lessons 回注入 ≥ 1 执行入口 | lessons-reinjection 单测断言 prompt 含 lesson |
| web/sandbox 产出归档 100% | tool-artifact-lesson 单测 |
| adapt 信号 100% 产出非空调整 | adapt-replan 单测 |
| gate 失败自动重跑 ≥ 1 次 | gate-auto-resume 单测 |
| 不可恢复时仍兜底 exit | recovery-state 单测第 4 次命中→terminal |
