# 多人协作工作能力建设 · 任务执行状态

> 分支：`feat/multi-user-collaboration`（worktree）
> 起止：2026-09-01
> 工作流：需求开发任务（worktree → PRD → tech_solution → 编码+task_state → test_report → 合并 main + push）

## 1. 目标摘要

为 DeepThink Agent 平台建设「多人协作」能力：支持 编排者-工作者 / 对等 / 批评对抗 三种工作模式，创建群共享工作区（产物/上下文/记忆/任务状态），智能编排多人协作分工，共同完成超级复杂任务。以软件工程开发、创新脑暴、唯心/唯物理性批判为验收场景。

## 2. 工作流执行进度

| 步骤 | 内容 | 状态 |
| --- | --- | --- |
| 0 | 创建 worktree `feat/multi-user-collaboration` | ✅ 完成 |
| 1 | PRD + 验收标准 + 测试用例 → `docs/prd/multi-user-collaboration/PRD.md` | ✅ 完成 |
| 2 | 技术方案 → `docs/tech_solution/multi-user-collaboration/SOLUTION.md` | ✅ 完成 |
| 3 | 编码实施 + task_state（本文件） | ✅ 完成 |
| 4 | 测试用例 + Issue 修复闭环 + 测试报告 HTML → `docs/test_report/multi-user-collaboration/REPORT.html` | ✅ 完成 |
| 5 | 合并 worktree → main + push 双远端 | ⏳ 待执行 |

## 3. 交付物清单

### 后端（src/）

| 文件 | 变更类型 | 说明 |
| --- | --- | --- |
| `src/db.ts` | 修改 | 新增 `collaborations` 表（schema 58→59）+ `CollaborationRow` 接口 + 5 个 db 函数（create/get/complete/fail/list），仿 `team_builds` 模式 |
| `src/agent-team/team-plan.ts` | 修改 | `TeamTaskInput` 增 `mode?` / `scenario?` / `collaborationId?`（未改 Schema，mode 为输入驱动） |
| `src/agent-team/team-prompt.ts` | 修改 | 新增 `SCENARIO_PRESETS`（3 预设）、`buildDecompositionPromptByMode` 分发器、`buildPeerDecompositionPrompt`、`buildCriticDecompositionPrompt`；`buildFallbackPlan` 改为 mode 感知 |
| `src/agent-team/team-builder.ts` | 修改 | `decompose()` 改用 `buildDecompositionPromptByMode`（单行行为变更，默认 mode = legacy 提示词，向后兼容） |
| `src/agent-team/collaboration-builder.ts` | **新增** | `buildCollaboration`：applyScenario → buildTeam（mode 感知）→ completeCollaboration → detached `pollRunAndPersist`；`persistSharedArtifacts` 落盘 deliverables/manifest/final-deliverable/shared-memory |
| `src/routes/collaborations.ts` | **新增** | Hono 路由：POST/GET runs、GET runs/:id、GET deliverables(manifest+单文件)、GET/POST memory；`canAccessCollaboration`（owner OR group_member OR admin） |
| `src/web-context.ts` | 修改 | `WebDeps` 增 `buildCollaboration` |
| `src/index.ts` | 修改 | 装配 `webDeps.buildCollaboration` |
| `src/web.ts` | 修改 | 挂载 `/api/collaborations` 路由 |

### 前端（web/）

| 文件 | 变更类型 | 说明 |
| --- | --- | --- |
| `web/src/stores/collaborations.ts` | **新增** | zustand store：buildCollaboration（POST→poll）、loadHistory、openHistory、reset；带 token 取消的轮询 |
| `web/src/pages/CollaborationPage.tsx` | **新增** | 仿 TeamPage：模式三选卡片、场景预设、目标输入、高级选项、执行视图（复用 GraphDagView + AgentConversationPanel）、历史列表、共享产物入口 |
| `web/src/components/layout/nav-items.ts` | 修改 | 增「协作」导航项（Handshake 图标） |
| `web/src/App.tsx` | 修改 | lazy 导入 CollaborationPage + Route `/collaborations` |

### 测试

| 文件 | 变更类型 | 说明 |
| --- | --- | --- |
| `tests/units/collaborations.test.ts` | **新增** | 16 项单测：mode 感知提示词(TC5-8)、applyScenario(TC8)、mode 感知 fallback、拓扑组装(peer parallel+gate/critic producer→critic gate/ow serial 向后兼容)、cycle check |

### 文档

| 文件 | 说明 |
| --- | --- |
| `docs/prd/multi-user-collaboration/PRD.md` | 8 大功能(F1-F8)、验收标准、测试用例 TC1-TC19、风险 |
| `docs/tech_solution/multi-user-collaboration/SOLUTION.md` | 架构、数据模型、模块改动、API 契约 |
| `docs/task_state/multi-user-collaboration/TASK_STATE.md` | 本文件 |
| `docs/test_report/multi-user-collaboration/REPORT.html` | HTML 测试报告（单文件，内嵌 CSS/JS） |

## 4. 关键设计决策

1. **零侵入 graph-engineering 核心**：三种协作模式均用 `agent + gate` 节点表达，无需 aggregate/branch。原因：`composeAgentPrompt` 不向 agent 节点注入上游输出（仅 goalAnchor + gate_feedback），而 gate 节点会读 `upstreamNodeId` 输出并在失败时回退重跑上游（GATE_RETRY_MAX=2）。peer 用文件扇入（shellCheck 校验 N 文件齐备），critic 复用 gate-rollback 形成对抗循环。
2. **共享记忆不动 isUserOwnedFolder 安全边界**：协作专属共享记忆置于 `collaborations/{collabId}/shared-memory.md`，授权走 `canAccessCollaboration`（群成员可访问），无需修改创建者独占写策略。
3. **异步组建模式**：POST `/api/collaborations/runs` 立即返回 `collabId`，`buildCollaboration` 经 `setImmediate` detach 执行，前端轮询 `GET /runs/:id` 到终态，与 `team_builds` 一致。
4. **向后兼容**：默认 mode = `orchestrator-worker` = legacy 提示词与单 agent fallback，既有 team 流程零影响。

## 5. 验证结果摘要

| 维度 | 结果 |
| --- | --- |
| 后端 `npx tsc --noEmit` | ✅ 0 errors |
| 前端 `tsc --noEmit` + `vite build` | ✅ pass |
| 单元测试 `collaborations.test.ts` | ✅ 16/16 pass |
| better-sqlite3 ABI | ⚠ 26 个依赖 DB 的 vitest 文件因 NODE_MODULE_VERSION 127 vs 137 失败（**main 基线同样失败**，属环境问题非代码缺陷；9999 应用在 nvm Node v22.23.1 下运行正常） |
| 集成测试（9998 隔离实例） | ✅ 三场景组建成功、mode 拓扑正确、peer run 到达终态、共享产物全部持久化、共享记忆 API 读写正常、404 隔离正常 |

详见 `docs/test_report/multi-user-collaboration/REPORT.html`。

## 6. 待办（步骤 5）

- [ ] worktree 内 `git add`（排除 node_modules 符号链接）+ commit
- [ ] 合并 `feat/multi-user-collaboration` → `main`
- [ ] `git push origin main`（双远端：gitcode + github）
