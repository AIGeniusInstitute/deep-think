# PRD：DeepThink 多人协作工作能力建设 —— 共享工作区 + 多协作模式 + 共享上下文/记忆/任务状态

> 状态：草案 v1，待评审
> 分支：`feat/multi-user-collaboration`（worktree：`~/deepthink/.worktrees/feat-multi-user-collaboration`）
> 作者：DeepThink
> 日期：2026-09-01
> 关联既有能力：复用 `graph-engineering`（DAG 编排与执行引擎，已落地）、`agent-team/team-builder`（自主拆解 + 创建 Agent 集群 + 组装 GraphDefinition，已落地）、共享工作区底座（`group_members` 表 + folder 级文件/对话/trace/任务天然共享，已落地）、`agent-orchestration`（编排者-工作者模式，已落地）。

---

## 0. 背景与动机

DeepThink 已具备单 Agent 串行执行（Loop）、DAG 编排执行（Graph Engineering）、自主组建 Agent 团队（Super Agent Team）三档能力。但当前协作能力存在三处缺口，无法支撑「多人协作共同完成一件超级复杂任务」：

1. **无协作模式概念**：现有 `team-builder` 的拆解 prompt 硬编码「调研→实现→评审→验收」串行链（`team-prompt.ts:19-20,84`），本质只有 orchestrator-worker 一种风格。全仓搜索 `peer`/`critic`/`adversarial`/`debate`/`对等`/`批判`/`对抗` 关键字在协作语义上**零命中**（见探查结论）。用户无法选择「对等并行脑暴」「批评对抗论证」等协作范式。
2. **协作专属产物层缺失**：现有 team 产出仅在 graph run 的 `node_<id>_output` state 与 `graph_node_runs` 表里流转，无面向多参与者的「共享工作区产物文件」——协作成员（人 + Agent）看不到彼此交付物的统一视图，也无协作级的共享记忆 / 任务状态。
3. **群记忆写入受单 owner 锁**：`data/groups/{folder}/CLAUDE.md` 物理上同群多用户共享，但 `routes/memory.ts` 的 `isUserOwnedFolder`（`created_by === user.id`）阻断了非创建者写入（`memory.ts:128-142`），协作成员无法向群级共享记忆贡献内容。

本 PRD 在既有引擎之上新增**协作模式层 + 共享协作产物层 + 协作记忆共享通道**，让多参与者（多人 + 多 Agent）在一个共享工作区里，按三种协作范式（编排者-工作者 / 对等并行 / 批评对抗）共同完成超复杂任务，并以软件工程开发、创新脑暴、唯心唯物理性批判三个场景为验收案例。

## 1. 目标

**需求1（共享协作工作区）**：用户创建一个「协作」时，绑定一个共享群工作区（复用 `group_members` 多人共享底座），协作的全过程产物（成员交付物、最终交付物、协作记忆、协作任务状态）落入该共享工作区的协作专属目录 `data/groups/{folder}/collaborations/{collabId}/`，群内全体成员（owner + members）可读可写。协作成员（人）可经 `POST /api/groups/:jid/members` 加入共享工作区（既有能力）。

**需求2（三种协作模式）**：用户创建协作时选择一种协作模式，DeepThink 按模式自主拆解任务、设计角色、组装对应拓扑的 GraphDefinition 并启动运行：
- **编排者-工作者（orchestrator-worker）**：编排者拆解任务、分派给各专职工作者、串行依赖链交付、末尾 gate 验收。复用现有 team-builder 默认拓扑（调研→实现→评审→验收）。
- **对等并行（peer）**：N 个对等角色各自独立产出不同视角方案（无相互依赖，可并行），各自写入共享工作区产物文件；末尾 gate 以行为证据（shellCheck 校验产物文件齐备）+ LLM 综合评审汇聚多视角。
- **批评对抗（critic-adversarial）**：产出者产出初稿 → 批判者（adversarial gate，主动找漏洞/反例/逻辑谬误的严格 persona + 行为证据断言）批判 → 不通过则产出者带批判反馈重做（复用既有 gate-failure-rollback 闭环，GATE_RETRY_MAX=2），形成「产出→批判→修订」对抗循环。

**需求3（共享上下文/记忆/任务状态）**：
- 共享上下文：协作运行在共享群工作区，群内 `chat_jid` 维度的对话历史、trace、运行时 task_state 天然共享（既有能力，无改动）。
- 共享记忆：新增协作级共享记忆文件 `data/groups/{folder}/collaborations/{collabId}/shared-memory.md`，经协作 API 读写，权限走 `canAccessGroup`（群成员即可写，绕开单 owner 锁），供多参与者共同累积协作要点。
- 共享任务状态：新增 `collaborations` 表持久化协作元数据（mode/scenario/status/plan/run_id/participants）；协作运行期间持久化各成员节点产出到 `collaborations/{collabId}/deliverables/{nodeId}.md` + `manifest.json`，全体成员可见进度。
- 共享产物：协作终态时把最终交付物（terminal 节点产出）写入 `collaborations/{collabId}/final-deliverable.md`，群成员可经协作 API 读取下载。

**需求4（三场景验收案例）**：以三个场景固化验收：
- **软件工程开发流程**（orchestrator-worker 模式）：调研→设计→编码→测试→验收，产出可运行代码 + 测试通过。
- **创新脑暴方案**（peer 模式）：N 个对等角色各自产出不同视角的创新方案，汇聚成方案集。
- **唯心主义唯物主义理性批判**（critic-adversarial 模式）：一个立场产出论点 → 对立批判者找逻辑谬误/反例 → 产出者修订 → 验收「经得起批判」。

## 2. 设计原则（约束本 PRD 范围）

1. **协作 = GraphDefinition + 模式参数**，不发明新执行引擎。三种模式产出的都是标准 `GraphDefinition`（`graph-engineering/graph-types.ts`），节点复用 `agent`/`gate` 既有类型，运行 100% 复用 `graph-orchestrator`/`graph-runner`/`graph-scheduler`，**零改动 graph-engineering 核心**。
2. **复用 team-builder**：协作组建复用 `team-builder.ts` 的 `decompose` + `createMemberAgent` + `registerDefinition` + `startGraphRun` 主干，仅扩展 ① `mode`/`scenario` 输入字段 ② `team-prompt` 模式分支模板 ③ `assembleGraphDefinition` 模式分支拓扑。不另起一套拆解/创建/组装逻辑（Simplicity First）。
3. **复用共享工作区底座**：多人共享走既有 `group_members` + folder 级共享（文件/对话/trace/任务天然共享），不新建跨 folder 共享机制。新增的协作产物层落在 folder 内的 `collaborations/{collabId}/` 子目录，权限复用 `canAccessGroup`。
4. **Surgical Changes**：不改动 `graph-scheduler`/`graph-orchestrator`/`graph-runner` 核心；不改动既有 `team-builder` 默认行为（mode 缺省 = orchestrator-worker，等价旧行为）；不改动 `TeamPage`/`/api/team/*` 既有路由（新增 `/api/collaborations/*`）；`team_builds` 表不动，新增 `collaborations` 表。
5. **Simplicity First**：P0 只做「三模式组建 + 共享产物持久化 + 协作记忆共享 + 协作 CRUD/UI + 三场景验收」。协作中动态 re-plan、跨工作区引用、细粒度成员权限分级列为 P1/P2。
6. **Goal-Driven**：每个功能点附可测验收标准与测试用例，闭环验证。

## 3. 关键决策与假设

> 以下 4 项是影响实现路径的关键判断，编码前需确认。

**A1. 协作模式加在 `TeamTaskInput`（输入层），由 team-builder + team-prompt 按 mode 分支，不改 `TeamPlanSchema`（LLM 产物 schema）。**
- 理由：`TeamTaskInput` 已有 `executionMode`/`draft`/`maxTeamSize`/`toolset` 等可选驱动字段（`team-plan.ts:86-107`），加 `mode`/`scenario` 完全符合既有扩展模式；mode 驱动 prompt 模板分支 + 图组装策略，plan schema 本身只描述结构与图，无需改。
- 三模式拓扑全部用 `agent`+`gate` 节点表达（不依赖 `parallel`/`aggregate`/`branch`），理由见 A2。
- **若用户期望 mode 进 LLM 产物 schema 以便 plan 可序列化模式，请在此项明确否决**，否则按输入层驱动推进。

**A2. 三模式拓扑均用 agent+gate 表达，零改 graph-engineering。**
- 依据探查：`composeAgentPrompt`（`graph-runner.ts:314-330`）**不注入上游产出到 agent 节点**（仅 goalAnchor + gate_feedback），即下游 agent 无法读上游 agent 产出。但 `gate` 节点的 LLM reviewer **会读 `upstreamNodeId` 产出**（`graph-runner.ts:501-534`），且 gate 失败会**回退重跑上游 agent 并注入批判反馈**（`graph-runner.ts:317-323` + `graph-orchestrator.ts:378-396`，GATE_RETRY_MAX=2）。
- 据此：
  - **orchestrator-worker**：串行 agent 链 → gate（现有默认，零改）。
  - **peer**：N 个并行 agent（`dependsOn:[]`）→ 各自按 prompt 把方案写入共享工作区文件 `collaborations/{collabId}/peer/{member}.md` → 终端 gate `shellCheck` 校验 N 个产物文件齐备（行为证据，多输入汇聚经文件系统实现 fan-in，规避 gate 单 upstreamNodeId 限制）+ LLM 综合评审。
  - **critic-adversarial**：producer(agent) → critic(gate，adversarial persona：主动找漏洞/反例/逻辑谬误，strict assertions) → 不通过则 producer 带批判反馈重做（复用既有 gate-rollback）。critic 即 gate，其 verdict 文本持久化为 gate 节点产出。
- **若用户期望 critic 是独立 agent 节点（能产出独立批判报告而非 pass/fail verdict），需扩展 `composeAgentPrompt` 注入上游产出**——这是对 graph-runner 的微小改动（agent 节点设 `upstreamNodeId` 时注入）。P0 暂不做，以 gate-as-critic 交付；若评审要求 agent-critic，作为 A2 的备选落地（改动局限在 `composeAgentPrompt` 一函数，向后兼容）。

**A3. 新增 `collaborations` 表，不复用 `team_builds`。**
- 理由：`team_builds`（`db.ts:529-543`）无 mode/scenario/participants/definition_id/shared_artifacts_path 字段，且其语义是「单用户一键组建即跑」。协作要承载模式/场景/共享产物路径/参与者快照，强行加列会污染既有语义。新增极简 `collaborations` 表解耦，schema 58→59。
- 协作 run_id 仍是标准 `graph_runs` 行，`/api/graph/runs/:id` 与 GraphPage 可视化不变。

**A4. 共享记忆走协作专属文件 + `canAccessGroup`，不改 `isUserOwnedFolder`。**
- 理由：`isUserOwnedFolder`（`memory.ts:128-142`）的单 owner 锁是有意安全设计（防跨用户 token 劫持等）。P0 不改群级 `CLAUDE.md` 写入 ACL，而是在协作目录下新增 `shared-memory.md`，经协作路由读写、权限走 `canAccessGroup`（群成员即可写），绕开单 owner 锁且不削弱既有安全边界。
- **若用户期望协作成员直接写群级 `CLAUDE.md`，需扩展 `isUserOwnedFolder` 认 `group_members`，请在此项明确否决**，否则按协作专属文件推进。

## 4. 功能点与验收标准

### F1. 协作创建（mode + scenario + 共享工作区绑定）
**描述**：用户在 Web「协作」页输入任务目标、选择模式（orchestrator-worker/peer/critic-adversarial）、可选选择场景预设（软件工程/创新脑暴/哲学批判/自定义），选择目标共享工作区（group），点击「组建协作并启动」。后端 `POST /api/collaborations` 立即返回 collabId（status=running），`buildCollaboration`（decompose + 成员创建 + 模式拓扑组装 + 注册 + 启动 GraphRun）在后台 detached 执行，结果/错误回写 `collaborations` 记录，前端轮询 `GET /api/collaborations/:id` 拿终态。

**验收标准（AC）**：
- AC1.1 `POST /api/collaborations` 入参校验：`goalText` 非空、`mode` ∈ 三值、`groupFolder`+`chatJid` 非空；非法返 400。
- AC1.2 合法请求立即返 `{ok, collabId, status:'running'}`（<1s），后台 detached 组建，进程级 unhandledRejection 有 logger 兜底。
- AC1.3 协作记录落 `collaborations` 表，含 mode/scenario/owner_user_id/group_folder/chat_jid/goal_text/status。
- AC1.4 共享产物目录 `data/groups/{folder}/collaborations/{collabId}/` 在组建时创建（含 `peer/`、`deliverables/` 子目录）。
- AC1.5 非 owner 用户访问他人协作 → 404 不泄露存在性（与 team 路由一致）。

### F2. 三模式拆解 prompt 分支（team-prompt 扩展）
**描述**：`buildDecompositionPrompt` 按 `mode` 分支生成不同 persona/约束/示例：orchestrator-worker 用既有串行链 prompt；peer 用「对等角色、多视角并行产出、各自写文件」prompt；critic-adversarial 用「产出者 + 批判者配对、批判者主动找漏洞」prompt。场景预设注入 goalText/acceptanceCriteria 模板。

**AC**：
- AC2.1 mode=orchestrator-worker（或缺省）的 prompt 与现有 prompt 行为等价（向后兼容）。
- AC2.2 mode=peer 的 prompt 明确要求成员并行、无相互依赖、各自把方案写入指定文件路径。
- AC2.3 mode=critic-adversarial 的 prompt 明确要求产出者 + 末尾批判 gate（adversarial persona + strict assertions）。
- AC2.4 scenario 预设正确填充 goalText/acceptanceCriteria（软件工程/脑暴/哲学批判三套）。

### F3. 模式拓扑组装（assembleGraphDefinition 扩展）
**描述**：`assembleGraphDefinition` 按 `mode` 分支组装图拓扑：
- orchestrator-worker：现有逻辑（串行 agent 链 + 末尾行为证据 gate）。
- peer：N 个 agent 节点 `dependsOn:[]`，prompt 含「写入 `collaborations/{collabId}/peer/{member}.md`」指令；终端 gate `dependsOn` 全部 N 节点，`shellCheck` = 校验 N 文件齐备的 shell，`successCriteria` = 综合评审。
- critic-adversarial：producer(agent) → critic(gate, `upstreamNodeId`=producer, adversarial `successCriteria` + strict `assertions`)。

**AC**：
- AC3.1 三模式产出的 GraphDefinition 经 `validateDefinition`（既有，无环+无 dangling）通过。
- AC3.2 peer 拓扑：N agent 节点均 `dependsOn:[]`（并行），终端 gate `dependsOn` 含全部 N 节点 id。
- AC3.3 critic 拓扑：存在 producer agent + critic gate，gate.`upstreamNodeId` = producer.id，gate.`assertions` 非空。
- AC3.4 orchestrator-worker 拓扑与改动前 assembleGraphDefinition 输出一致（向后兼容，单测对比）。

### F4. 共享产物持久化
**描述**：协作终态（completed）时，后端读取该 run 的 `graph_node_runs` 各节点产出，写入 `collaborations/{collabId}/deliverables/{nodeId}.md` + `manifest.json`（节点→成员→角色→产出摘要），并把 terminal 节点产出写入 `final-deliverable.md`。群成员可经 `GET /api/collaborations/:id/deliverables` 列出、`GET /api/collaborations/:id/deliverables/:nodeId` 读单个。

**AC**：
- AC4.1 协作 completed 后 `deliverables/` 含每个 agent 节点一个 `.md`，内容 = 该节点产出（来自 `graph_node_runs.output_summary` 或 `node_<id>_output` state）。
- AC4.2 `manifest.json` 列出全部成员节点 + 角色 + 交付物标题 + 文件名。
- AC4.3 `final-deliverable.md` 内容 = terminal 节点产出。
- AC4.4 群成员（owner 或 group_member）可读；非成员 404。

### F5. 协作共享记忆
**描述**：`data/groups/{folder}/collaborations/{collabId}/shared-memory.md`，经 `GET/POST /api/collaborations/:id/memory` 读写，权限走 `canAccessGroup`（群成员即可写）。多参与者共同累积协作要点、决策、待办。

**AC**：
- AC5.1 群 owner 可读写 `shared-memory.md`。
- AC5.2 群 member（非创建者）可读写 `shared-memory.md`（绕开 `isUserOwnedFolder` 单 owner 锁）。
- AC5.3 非群成员 404。

### F6. 协作 CRUD 路由
**描述**：`/api/collaborations`（list 当前用户协作历史）、`POST`（创建）、`GET /:id`（轮询状态/plan/runId）、`GET /:id/deliverables`、`GET /:id/deliverables/:nodeId`、`GET/POST /:id/memory`。全部 `authMiddleware`，owner/group_member 校验。

**AC**：
- AC6.1 list 返回当前用户协作历史（newest first，含 mode/status/teamName）。
- AC6.2 `GET /:id` 终态：completed → {runId, plan, mode, scenario}；failed → {error}；running → {status:'running'}。
- AC6.3 非 owner 且非群成员 → 404。

### F7. 协作前端页（CollaborationPage）
**描述**：新增 `/collaborations` 页（侧栏入口），形态参考 TeamPage：目标输入 + 模式选择（三选一卡片）+ 场景预设（可选）+ 高级选项（复用 maxTeamSize/toolset/executionMode）+ 共享工作区选择 + 「组建协作并启动」。运行态复用 `GraphDagView` + `AgentConversationPanel`（split view）。协作历史列表。共享产物/记忆侧抽屉。

**AC**：
- AC7.1 模式三选一 UI 可见且选中态明确。
- AC7.2 场景预设选择后自动填充 goalText/acceptanceCriteria。
- AC7.3 组建中显示「组建协作中…」，轮询拿终态后切执行态。
- AC7.4 执行态复用 GraphDagView DAG + AgentConversationPanel。
- AC7.5 协作历史可重开。
- AC7.6 前端 typecheck + 生产构建通过。

### F8. 三场景验收案例
**描述**：以三场景端到端验证三模式：
- 软件工程（orchestrator-worker）：「实现一个 TODO CLI 并写单元测试，测试通过」。
- 创新脑暴（peer）：「就『AI 时代个人竞争力』产出 3 个不同视角的创新方案」。
- 哲学批判（critic-adversarial）：「就『意识是大脑的涌现属性』产出论点并经对立批判修订，最终经得起批判」。

**AC**：
- AC8.1 三场景协作均能组建成功（decompose 返回合法 plan，run 启动）。
- AC8.2 三场景 run 终态 completed（或在合理重试后 completed/failed 有明确终态）。
- AC8.3 三场景共享产物目录齐备（deliverables + manifest + final-deliverable）。
- AC8.4 软件工程场景 gate shellCheck 跑测试退出码 0；peer 场景 shellCheck 校验 N 方案文件齐备；critic 场景 gate assertions 判定批判通过。

## 5. 非目标（P1/P2）
- 协作中动态 re-plan（已有 `/api/graph/runs/:id/replan`，P0 不做画布内重规划 UI）。
- 跨工作区（跨 folder）产物引用/链接。
- 细粒度成员权限分级（只读/可编辑/可管理）。
- critic 作为独立 agent 节点产出独立批判报告（A2 备选，需扩展 composeAgentPrompt）。
- 协作成员实时协同编辑（OT/CRDT）。

## 6. 测试用例（映射 AC）

| ID | 用例 | 覆盖 AC | 验证手段 |
|----|------|---------|----------|
| TC1 | POST 非法 body 400 | AC1.1 | 单测 |
| TC2 | POST 立即返 collabId + running | AC1.2 | 单测 + curl |
| TC3 | 协作记录落库 + 目录创建 | AC1.3/1.4 | 单测 |
| TC4 | 非 owner 404 | AC1.5/6.3 | 单测 |
| TC5 | orchestrator-worker prompt 等价 | AC2.1 | 单测（prompt 字符串对比） |
| TC6 | peer prompt 含并行+写文件指令 | AC2.2 | 单测 |
| TC7 | critic prompt 含 adversarial gate | AC2.3 | 单测 |
| TC8 | scenario 预设填充 | AC2.4 | 单测 |
| TC9 | peer 拓扑并行 + gate deps 全 N | AC3.2 | 单测 |
| TC10 | critic 拓扑 producer→critic gate | AC3.3 | 单测 |
| TC11 | orchestrator-worker 拓扑向后兼容 | AC3.4/3.1 | 单测 |
| TC12 | 共享产物持久化 deliverables+manifest+final | AC4.1/4.2/4.3 | 集成（运行态） |
| TC13 | 共享记忆 owner/member 可写、非成员 404 | AC5.1/5.2/5.3 | 单测 + curl |
| TC14 | list/GET 终态 | AC6.1/6.2 | 单测 + curl |
| TC15 | 前端 typecheck + build | AC7.6 | tsc + vite build |
| TC16 | 软件工程场景端到端 | AC8.1/8.2/8.3/8.4 | 运行态集成 |
| TC17 | 创新脑暴场景端到端 | AC8.* | 运行态集成 |
| TC18 | 哲学批判场景端到端 | AC8.* | 运行态集成 |
| TC19 | 既有 TeamPage/graph/team 路由不回归 | — | 全量 vitest |

## 7. 风险与缓解
- **R1（decompose 失败）**：LLM 产出非法 plan。缓解：复用 team-builder 的 retry once + fallback 单 agent plan（`team-prompt.ts:buildFallbackPlan`），按 mode 生成对应 fallback 拓扑。
- **R2（peer 成员不写文件）**：LLM 未按 prompt 写产物文件，导致 gate shellCheck 失败。缓解：① prompt 强约束文件路径；② gate 失败回退重跑该 agent（注入 feedback「请将方案写入 X 路径」）；③ 产物持久化 F4 不依赖 agent 写文件（post-run 从 graph_node_runs 兜底）。
- **R3（critic gate 永不通过）**：adversarial assertions 过严。缓解：GATE_RETRY_MAX=2 上限（既有），超限 run failed（明确终态，不死循环）；assertions 设计为「产出含修订标记/回应了批判」而非「无任何漏洞」。
- **R4（运行态测试耗时）**：三场景端到端 run 可能数分钟。缓解：场景目标控制为轻量（TODO CLI/3 方案/单论点），超时设上限。
