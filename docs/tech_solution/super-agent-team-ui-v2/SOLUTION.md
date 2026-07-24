# 技术方案：超级 Agent 团队 — TeamPage 执行视图增强 v2

> 关联 PRD：`docs/prd/super-agent-team-ui-v2/PRD.md`
> 分支：`feat/super-agent-team-ui-v2`
> 状态：v1
> 日期：2026-07-24

## 0. 设计总则

本迭代**不动后端执行层**（graph-orchestrator/scheduler/runner/agent-runner/chat-trace-persist/DB schema 零改动），仅做：
- 后端少量字段扩展（TeamTaskInput + team-builder 落实 + team 路由 list + listTeamBuilds）
- 前端 TeamPage 执行视图重构 + 新建 AgentConversationPanel + 增强 NodeTraceSubgraph + 自写分割条

**复用**：graph store 2s 轮询、`GraphDagView`/`GraphNodeDetail`/`NodeTraceSubgraph`、`ApprovalCard`、cancel/approve/trace 端点、plan 持久化（team_builds.plan_json）。

## 1. 架构总览

```
TeamPage（/team）
 ├─ landing（未启动）：任务目标 + 高级选项（默认展开，3 新字段）+ 组建按钮 + 历史任务入口
 └─ execution（lastRunId set）：
     ├─ 顶栏：← 新建团队 | run 状态 | 终止任务
     └─ ResizableSplitter
         ├─ 左：AgentConversationPanel（轮询派生消息流）
         └─ 右：GraphDagView（DAG + 节点详情 + NodeTraceSubgraph）
```

数据流（全轮询，无 WS）：
```
buildTeam(input) ─POST /api/team/runs→ buildId
  └─轮询 GET /api/team/runs/:buildId → completed{runId, plan}
     └─graphStore.startPolling(runId) ─2s→ GET /api/graph/runs/:id → {run, nodeRuns}
        └─AgentConversationPanel 派生消息 + 节点 completed 时拉一次 trace
        └─GraphDagView 渲染 nodeRuns（角色名来自 plan.members 反查）
        └─run 终态 → 停轮询
```

## 2. 后端改动（surgical）

### 2.1 `src/agent-team/team-plan.ts` — TeamTaskInput 加 3 可选字段

```ts
export interface TeamTaskInput {
  goalText: string;
  background?: string;
  acceptanceCriteria?: string;
  ownerUserId: string;
  groupFolder: string;
  chatJid: string;
  userLanguage?: string;
  // v2 新增（全部可选，缺失退化既有行为）
  maxTeamSize?: number;        // 1–12，截断成员数
  toolset?: string[];          // 允许的 skill/mcp id 白名单；空=不限
  executionMode?: 'auto' | 'semi-auto'; // semi-auto=agent 后插 human 审批门
}
```

### 2.2 `src/agent-team/team-prompt.ts` — decompose prompt 注入约束

`buildDecompositionPrompt(input)` 在【约束】段追加：
- `maxTeamSize` 存在：`7. 团队成员数不超过 ${maxTeamSize} 人。`
- `toolset` 存在：`8. 成员的 skills/mcpServers 只能从允许集合 [${toolset.join(', '}] 中选择。`

### 2.3 `src/agent-team/team-builder.ts` — 落实 3 字段

**buildTeam** 在 `decompose` 后、`createMemberAgent` 前插入：
```ts
// maxTeamSize：按依赖闭包保留被引用成员，截断多余
if (input.maxTeamSize && plan.members.length > input.maxTeamSize) {
  const referenced = new Set(plan.graph.nodes.filter(n=>n.agentMember).map(n=>n.agentMember!));
  const keep = plan.members.filter(m=>referenced.has(m.name));
  // 补足到 maxTeamSize（优先按声明顺序）
  for (const m of plan.members) if (keep.length<input.maxTeamSize && !keep.includes(m)) keep.push(m);
  plan = { ...plan, members: keep };
}
// toolset：过滤每个 member 的 skills/mcpServers
if (input.toolset && input.toolset.length) {
  const allowed = new Set(input.toolset);
  plan = { ...plan, members: plan.members.map(m => ({
    ...m, skills: m.skills.filter(s=>allowed.has(s)), mcpServers: m.mcpServers.filter(s=>allowed.has(s)),
  }))};
}
```

**assembleGraphDefinition** 在 agent 节点 push 后、edge 构建前，`executionMode==='semi-auto'` 时插入 human 审批门：
```ts
if (input.executionMode === 'semi-auto' && gn.type === 'agent') {
  const hId = `${gn.id}-review`;
  nodes.push({
    id: hId, type: 'human', title: `${gn.title} 产出确认`,
    approvalPrompt: `${gn.title} 产出是否通过？`, agentMember: gn.agentMember,
    approvalOptions: [{label:'通过，继续下游',value:'approve'},{label:'打回重做',value:'reject'}],
    approvalStateKey: `node_${gn.id}_approval`,
  });
  edges.push({id:`${gn.id}->${hId}`, from:gn.id, to:hId, type:'data'});
  // 下游原本 dependsOn gn 的节点改 dependsOn hId？——不：保留 dependsOn gn，
  // human 门只作为旁路确认不阻断数据流？不符 AC6.5。
}
```
**选型**：human 门**串入依赖链**——原本 `dependsOn:[gn]` 的下游节点改为 `dependsOn:[hId]`，使 human pause 真正阻塞下游（AC6.5）。实现：在 for 循环里先收集 `agentNodeId→reviewNodeId` 映射，构建 edge 时把 `dep===gn.id` 重写为 `dep===hId`。gate 节点的 `upstreamNodeId` 同理重写。

human 节点字段（既有 GraphNode 已支持 approvalPrompt/approvalOptions/approvalStateKey，见 PRD P1 §9.2 已实现）：复用既有 `runHumanNode` pause + `POST /approve` + ApprovalCard。

### 2.4 `src/routes/team.ts` — body schema + list 路由

```ts
const TeamRunBodySchema = z.object({
  goalText: z.string().min(1),
  background: z.string().optional(),
  acceptanceCriteria: z.string().optional(),
  groupFolder: z.string().min(1),
  chatJid: z.string().min(1),
  userLanguage: z.string().optional(),
  maxTeamSize: z.number().int().min(1).max(12).optional(),
  toolset: z.array(z.string()).optional(),
  executionMode: z.enum(['auto','semi-auto']).optional(),
});
// POST handler 把三字段塞进 input
// 新增 list 路由
teamRoutes.get('/runs', (c) => {
  const authUser = c.get('user');
  const rows = listTeamBuilds(authUser.id, 20);
  return c.json({ runs: rows.map(r => ({ id:r.id, teamName: r.plan_json?JSON.parse(r.plan_json).teamName:null, goalText:r.goal_text, status:r.status, runId:r.run_id, createdAt:r.created_at })) });
});
```
注意：list 路由必须放在 `teamRoutes.get('/runs/:buildId')` **之前**注册，否则 `/runs` 会被 `/runs/:buildId` 捕获为 buildId=undefined（Hono 字面匹配优先，但保险起见前置）。

### 2.5 `src/db.ts` — listTeamBuilds

```ts
export function listTeamBuilds(ownerUserId: string, limit = 20): TeamBuildRow[] {
  return db.prepare(
    `SELECT * FROM team_builds WHERE owner_user_id=? ORDER BY created_at DESC LIMIT ?`
  ).all(ownerUserId, limit) as TeamBuildRow[];
}
```
既有 `idx_team_builds_owner` 索引覆盖。无 schema 变更。

## 3. 前端改动

### 3.1 `web/src/stores/team.ts` — 扩展

- `buildTeam` 入参加 `maxTeamSize/toolset/executionMode`，透传 body。
- 新增 `teamHistory: TeamBuildSummary[]` + `loadHistory()` → `GET /api/team/runs`。
- 新增 `openHistory(buildId)` → 设 lastRunId/lastPlan（从 `GET /api/team/runs/:buildId` completed 态拿 runId+plan）+ 触发 graph polling。

### 3.2 新建 `web/src/components/team/AgentConversationPanel.tsx`

核心：从 `useGraphStore`（currentRun, currentNodeRuns）+ `useTeamStore`（lastPlan）派生消息。

```ts
interface ConvMessage {
  id: string;            // `${nodeRunId}:${phase}` 去重键
  role: string;         // 角色名（plan.members 反查）or 'system'
  roleType: 'system'|'agent'|'tool'|'error';
  text: string;
  ts: string | null;    // started_at
  nodeRunId?: string;
  kind: 'text'|'tool'|'status'|'error'|'system'|'approval';
}
```

派生逻辑（useMemo + ref 记录已发射消息，幂等）：
1. `lastPlan` → 系统消息"已组建 N 个 Agent 角色：…"（id=`team:formed`）。
2. 遍历 `currentNodeRuns`，按 `started_at` 排序：
   - status running 且未发过 start → status 消息"{role} 开始执行：{title}"。
   - status completed 且未发过 → 文本消息（output_summary）；若未拉过 trace，异步拉一次 → 工具摘要消息（若 toolCalls>0）。
   - status failed → error 消息。
   - status skipped → 系统消息。
3. `currentRun.status` completed → 最终总结（末端 gate 节点 output_summary）；failed/cancelled → 系统消息。
4. human paused + approvalRequest → approval 卡（复用 ApprovalCard，调 `approveNode`）。

**自动滚动**：`useRef` 滚动容器 + `MutationObserver`/轮询后 `scrollHeight` 检测；用户向上滚（`scrollHeight - scrollTop - clientHeight > 80`）→ 不自动拉回 + 显示"回到底部"浮动按钮；点击 → `scrollTop = scrollHeight`。

**角色映射**：`roleByMember = Map(plan.members.map(m=>[m.name, m.role]))`；nodeRun→plan 节点映射靠 `node_id`（plan.graph.nodes[].id）。agent 节点角色 = `roleByMember.get(planNode.agentMember)`；非 agent 用 `planNode.title`。

**消息类型视觉**：system 灰底居中；agent 文本白底左侧角色色条；tool 蓝/灰底 🔧 前缀；error 红底；approval 卡片。

### 3.3 新建 `web/src/components/team/ResizableSplitter.tsx`

自写水平分割条（不引新依赖）：
```tsx
// props: left, right, initialLeftRatio=0.42, minLeft=280, minRight=360
// 鼠标 down on handle → document mousemove 计算比例 → setState; mouseup 解绑
// 用 flex-basis 控制宽度；touch 支持 pointer events
```
键盘无障碍：handle `tabIndex={0}`，`onKeyDown` Left/Right 调比例 4%。

### 3.4 增强 `web/src/components/graph/NodeTraceSubgraph.tsx`

- 每条步骤显示：`#序号`（按展开顺序计数）+ `started_at` 时间戳（`new Date(iso).toLocaleTimeString()`）+ 动作类型标签（turn/tool/skill/subagent/review，中文化）。
- 工具调用 `input_json/output_json`：超长截断（>2000 字符）+ "查看完整"按钮 toggle 展开（本地 state，不破坏既有折叠）。
- 每条步骤右侧"复制"按钮：`navigator.clipboard.writeText(JSON.stringify({ts,role,type,tool,input,output},null,2))`，toast 提示。
- 既有的 parent→children 树、状态色、折叠全部保留。

### 3.5 `web/src/components/graph/GraphDagView.tsx` — 节点角色名

新增可选 prop `roleByNode?: Map<string, {role:string; title:string; type:string}>`：
- 有 prop：节点 label 显示 `{role}`（agent）或 `{title}`（gate/human）+ status。
- 无 prop（GraphPage 调用）：退化为既有 node_id 显示。
TeamPage 传入由 plan 构建的映射；GraphPage 不传。

节点 default 状态 pending 显示"等待中"（中文化 status）。状态色既有保留。

### 3.6 `web/src/pages/TeamPage.tsx` — 重写执行视图

```tsx
// landing：showAdvanced=true（默认展开）；新增 maxTeamSize/toolset/executionMode 输入；
//   历史任务入口（loadHistory → 列表 → openHistory）
// execution（lastRunId）：
//   <顶栏 新建团队 | run.status | 终止任务（cancelRun）>
//   <ResizableSplitter>
//     <AgentConversationPanel plan={lastPlan} />
//     <GraphDagView runId={lastRunId} roleByNode={...} />
//   </ResizableSplitter>
```
- 终止任务按钮：`cancelRun(lastRunId)` + 停轮询；终态后 disabled。
- run 终态（completed/failed/cancelled）后 graph store 内部停止轮询（在 loadRun 检测终态后 clearInterval——既有 startPolling 不停，需在 store 加终态判断或组件层停）。

### 3.7 stores/graph.ts — 终态停轮询

`startPolling` 的 `setInterval` 回调里：loadRun 后若 `currentRun.status` ∈ {completed,failed,cancelled} → stopPolling。避免无限轮询。Surgical：仅 startPolling 内加判断。

## 4. 数据完整性

- 角色名：plan.members[].role（持久化于 team_builds.plan_json + graph_definitions 不存 role，故历史回溯必须经 team_builds.plan_json → `GET /api/team/runs/:buildId` 取 plan）。openHistory 走此路径。
- output_summary：agent 自然语言产出（≤5000 字符，graph-runner.ts:187）。
- trace：`GET /nodes/:nodeId/trace` → traceNodes（turn/tool/skill/subagent，含 started_at）+ toolCalls（input_json/output_json ≤64KB）。

## 5. 测试策略

浏览器 UI 自动化（sandbox browser，admin/88888888）执行 28 用例。重点：
- 用例 1.1/1.2：高级选项默认展开 + 折叠保留。
- 用例 2.1/2.2/2.3：提交留 /team + 组建成功消息 + 失败提示。
- 用例 3.1–3.3：多角色消息 + 类型区分 + 自动滚动/回到底部。
- 用例 4.1–4.4：DAG 角色名 + 状态实时 + 缩放拖拽 + 点击节点详情。
- 用例 5.1–5.5：trace 序号/时间戳/工具/展开/复制/切换/历史回溯。
- 用例 6.1–6.4：并行同步 + 终态 + 失败跳过 + 终止。
- 用例 7.1：刷新后历史回溯。
- 用例 8.1–8.3：分割条 + 1366×768 + 键盘。

遇 bug 走 issue 修复流程（`docs/issues/{date}-{slug}.json`），定位根因（日志 + 代码行）后修复，循环直到全过。

## 6. 不改动清单（Surgical）

- `src/graph-engineering/*`（orchestrator/scheduler/runner/registry/recovery/types）零改动。
- `container/agent-runner/*` 零改动。
- `src/chat-trace-persist.ts` 零改动。
- DB schema 零改动（不加表/列，listTeamBuilds 复用既有表+索引）。
- 既有 `GraphPage` 零改动（GraphDagView 新 prop 向后兼容）。
- 既有 chat trace 行为零回归。
