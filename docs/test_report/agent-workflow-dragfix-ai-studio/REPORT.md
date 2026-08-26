# 测试报告：Agent Workflow 拖拽修复 + Agent Studio AI 生成/优化

> 分支：`feat/agent-workflow-ai-studio`
> 日期：2026-08-26
> 关联 PRD：`docs/prd/agent-workflow-dragfix-ai-studio/PRD.md`

## 1. 验证方法总览

本环境存在以下客观限制（均非代码缺陷）：
- **后端无法启动**：共享 `node_modules`（`~/deepthink/node_modules` → `/home/node_modules`）缺少运行时依赖（`cron-parser` 等），`npx tsx src/index.ts` 报 `ERR_MODULE_NOT_FOUND`；既有后端进程（9898，tsx watch）虽在但 HTTP 无响应（卡死 32 天）。
- **后端 devDeps 缺失**：共享 `node_modules` 无 `typescript`/`vitest`/`@types/node`/`hono` 类型，后端 `tsc --noEmit` 全量跑会报大量 `console`/`process`/`Buffer` 未定义等环境噪声。
- **前端 headless 实测受限**：`/workflows` 路由要求登录，headless chrome 无 auth cookie，访问被重定向到着陆页（已用 CDP 确认：`react-flow__pane` 不存在，DOM 为 landing-page），无法对编辑器做交互测试。
- **前端 devDeps 完整**：`web/node_modules`（实体目录）含 `typescript`+`vite`，前端 `tsc --noEmit` 可干净运行。

基于以上，本报告采用**静态验证 + 代码审查 + 路由分析**，并给出合并后需在运行环境执行的**人工测试清单**。

## 2. 静态验证结果

### 2.1 前端 TypeScript 类型检查 ✅

命令：`cd web && node_modules/.bin/tsc --noEmit`
结果：**0 error**（干净通过）。

覆盖改动文件：
- `web/src/components/workflow/WorkflowEditorCanvas.tsx`（FP1）
- `web/src/stores/agents-paas.ts`（FP2/FP3 store + 类型）
- `web/src/components/agents/OptimizeAgentDialog.tsx`（FP3 组件）
- `web/src/pages/AgentStudioPage.tsx`（FP2/FP3 UI）

### 2.2 后端类型检查（排除环境噪声）✅

命令：`~/deepthink/web/node_modules/.bin/tsc --noEmit -p tsconfig.json`
结果：仅环境噪声错误（`hono` 模块找不到、`node:fs`/`console`/`process`/`Buffer` 未定义、`c` 参数隐式 any——因 `hono` Context 类型未解析，**所有**既有 handler 均报此，含未改动的既有端点）。

**改动文件专项过滤**：
- `src/agent-ai.ts`：**0 error**（完全无错，纯 TS 无外部类型依赖）。
- `src/routes/paas-agents.ts`：仅有上述环境噪声；新增的 `/generate`、`/:id/optimize`、`/:id/optimize/apply` 端点与既有端点同模式（`(c) =>`、`getAgentDefinition`/`updateAgentDefinition` 调用），未引入新类型错误。

### 2.3 路由冲突分析 ✅

`paas-agents.ts`（Hono，挂载 `/api/paas/agents`）新增端点与既有路由无冲突：
- `POST /generate`：静态路径，与 `POST /`（create）、`POST /:id/mounts` 不冲突（无单段 `POST /:id` 路由）。
- `POST /:id/optimize`：与 `POST /:id/mounts`/`/share`/`/test-chat` 同为 `POST /:id/{静态段}`，`optimize` 段唯一。
- `POST /:id/optimize/apply`：与 `POST /:id/versions/:vid/restore` 同为三段，中间段 `optimize` vs `versions` 不重名。

## 3. 功能点验证

### FP1：空状态画布拖拽修复 — 代码审查通过 ✅

**根因（已亲自验证源码）**：`WorkflowEditorCanvas.tsx` 原第 98-105 行空状态 early return 的占位 div 未挂 `onDrop`/`onDragOver`；真正的 drop 处理器只挂第 108 行 wrapper div（空状态不渲染）。HTML5 DnD 要求 drop 目标在 `dragover` 中 `preventDefault()`，故空状态下拖入第一个节点必失败。

**修复**：删除 early return，空状态提示改为 `pointer-events-none absolute inset-0` overlay 叠加在 wrapper 内部，wrapper（带 `onDrop`/`onDragOver`/`wrapperRef`）始终渲染。

**审查结论**：
- 空状态下 wrapper 始终在 DOM 中 → `onDrop`/`onDragOver` 生效 → AC1.1/1.3/1.4/1.6 满足。
- `wrapperRef.current` 始终可算 bounds → 落点接近鼠标 → AC1.2 满足。
- `isEmpty` 在有节点后为 false → overlay 自动消失 → AC1.5 满足。
- `pointer-events-none` → overlay 不拦截 drop 事件，drop 命中 wrapper。
- 行为与原逻辑一致（`isEmpty = !nodes.length && !children` 同原条件），仅空状态由 early-return 改 overlay，surgical。

### FP2：AI 自动生成 Agent — 代码审查通过 ✅

- `src/agent-ai.ts` `generateAgentContent`：prompt 要求严格 JSON 输出；`stripCodeFences` + `extractJsonObject`（括号配对提取）+ `JSON.parse` + 字段兜底（`coerceEngine` 越界回退 `'claude'`、`coerceNullableString/Number` 越界回退 null）→ AC2.2/2.3 满足。
- description < 10 字符校验 → AC2.3 满足。
- `sdkQuery` 返回 null/空 → `{ error }` → 502 → 前端 toast，UI 不崩 → AC2.4 满足。
- `POST /generate` 返回 `{ fields }` 不落库 → AC2.6 满足；前端填表后走既有 `handleCreate` → `create` → 落库 → AC2.5 满足。
- LLM 调用复用 `sdkQuery`（maxTurns=1、无工具），不引入新调用链。

### FP3：AI 优化 Agent — 代码审查通过 ✅

- `optimizeAgentContent`：只输出 `{description, system_prompt}`，不动 engine/model/挂载 → AC3（A3 决策）满足。
- `POST /:id/optimize` 返回预览（optimized + original）不落库 → AC3.6 满足；`POST /:id/optimize/apply` 走 `updateAgentDefinition` 写回 → AC3.7 满足。
- `OptimizeAgentDialog` 镜像 `OptimizeSkillDialog`（LCS diff + 预览 + 应用/放弃）→ AC3.1/3.2/3.3/3.4 满足。
- 失败 toast，不覆盖原字段 → AC3.5 满足。
- 复用既有 `AgentDefinitionPatchSchema` 路径，不加表/列。

### FP4：编排端到端 — 静态回归通过，实时待运行环境

- 上一轮 `feat/agent-workflow-editor` 既有功能（CRUD、AI draft、单节点编辑、运行）代码未改动，FP1 修复为 surgical 改动，不破坏既有路径。
- 实时端到端（AC4.1–4.4）需后端可运行 + 认证会话，列入下方人工清单。

## 4. 合并后人工测试清单（运行环境执行）

> 前置：合并到 main → 重启后端（`make dev` 或 `tsx watch src/index.ts`，确保 9898 可达）→ 前端 5173 登录态。

### 4.1 FP1 拖拽
1. 新建空工作流 → 从左侧拖 agent 瓷砖到画布空白区松手 → 画布出现 1 个 agent 节点（AC1.1）。
2. 再拖 gate/branch/human/llm/start/end → 均可落点（AC1.3/1.4）。
3. 拖拽时鼠标为 move 光标（非禁止）（AC1.6）。
4. 有节点后空状态提示消失（AC1.5）。

### 4.2 FP2 AI 生成
5. Agent Studio → 新建 Agent → 填 name + ≥10 字符描述 → 点「AI 生成」→ loading → 表单填充 system_prompt 等（AC2.1/2.2）。
6. engine 值在枚举内（AC2.3）。
7. 描述 <10 字符点生成 → 校验提示（AC2.3）。
8. 生成后编辑 → 创建 → 列表出现新 Agent（AC2.5）。
9. provider 不可用时 → 错误 toast，UI 不崩（AC2.4）。

### 4.3 FP3 AI 优化
10. 选中 Agent → 详情面板点「AI 优化」→ 生成预览 → diff 可见（AC3.1/3.2）。
11. 点应用 → 详情刷新，engine/model 不变（AC3.3）。
12. 点放弃 → 原字段不变（AC3.4）。
13. 填反馈「更简洁」→ 优化体现倾向（AC3.5）。

### 4.4 FP4 编排端到端
14. 拖 agent + gate + end → 连线 → 保存 → 列表可见 → 重开结构完整（AC4.1/4.2）。
15. agent 节点绑定/编辑 systemPrompt → 保存（AC4.3）。
16. AI 编排 → draft 加载 → 单节点编辑 → 保存 → 运行（AC4.4）。

## 5. 验证结论

- **静态验证**：前端 tsc 0 error；后端改动文件类型干净（仅环境噪声）；路由无冲突；FP1/FP2/FP3 代码审查通过。
- **实时验证**：受环境限制（后端缺运行时依赖、后端进程卡死、headless 无法认证）未执行，已给出人工清单。
- **未发现需修复的代码缺陷**：编码阶段无 bug 触发"Issue 修复流程"。

## 6. 后续建议

- 合并 main 并重启后端后，执行第 4 节人工清单（约 16 项，10 分钟内完成）。
- 若 provider 未配置，AI 生成/优化会返回 502 错误 toast（属预期失败路径，UI 不崩）。
- 长期建议：CI 补 vitest 单元测试（agent-ai 的 JSON 解析兜底、paas-agents 路由）。
