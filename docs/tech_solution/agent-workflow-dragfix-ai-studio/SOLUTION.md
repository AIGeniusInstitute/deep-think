# 技术方案：Agent Workflow 拖拽修复 + Agent Studio AI 生成/优化

> 分支：`feat/agent-workflow-ai-studio`
> 关联 PRD：`docs/prd/agent-workflow-dragfix-ai-studio/PRD.md`
> 日期：2026-08-26

## 0. 范围与复用盘点

| 需求 | 复用的既有能力 | 新增 |
|---|---|---|
| FP1 拖拽修复 | `WorkflowEditorCanvas.tsx` 既有 onDrop/onDragOver/wrapper 结构 | 改空状态渲染路径 |
| FP2 AI 生成 Agent | `sdkQuery`（`src/sdk-query.ts`）、`skill-ai.ts` 范式、`paas-agents.ts` 既有 create、`AgentStudioPage` 新建弹窗、`agents-paas.ts` store | `src/agent-ai.ts`、`POST /api/paas/agents/generate`、store `generateAgent`、弹窗「AI 生成」按钮 |
| FP3 AI 优化 Agent | `skill-ai.ts`/`routes/skills.ts` optimize 范式、`OptimizeSkillDialog.tsx` 范式、`paas-agents.ts` 既有 PATCH、`AgentDefinitionPatchSchema` | `optimizeAgentContent`、`POST /:id/optimize` + `/optimize/apply`、store `optimizeAgent`/`applyOptimizedAgent`、`OptimizeAgentDialog` 组件、详情面板「AI 优化」按钮 |

LLM 调用统一走 `sdkQuery(prompt, { timeout })`（maxTurns=1、无工具、纯文本 in/out，复用 web 设置页配置的 provider），不引入新调用链。

---

## 1. FP1：空状态画布拖拽修复

### 1.1 根因（已验证）

`web/src/components/workflow/WorkflowEditorCanvas.tsx:98-105`：

```tsx
if (!nodes.length && !children) {
  return (
    <div className="...border-dashed...">
      <p>从左侧拖拽节点到这里开始编排</p>
      ...
    </div>
  );
}
```

空状态走 early return，占位 div **未挂 `onDrop`/`onDragOver`**；真正的 drop 处理器只挂在第 108 行 wrapper div 上（空状态不渲染该 wrapper）。HTML5 DnD 要求 drop 目标在 `dragover` 中 `preventDefault()` 才生效，故空状态下拖拽永远失败。

### 1.2 修复方案（overlay 方案）

删除 early return，把空状态提示作为**绝对定位 overlay** 叠加在 wrapper 内部，使 wrapper（含 drop 处理器）始终渲染：

```tsx
export function WorkflowEditorCanvas({ children }: CanvasProps) {
  // ...hooks 不变...
  const isEmpty = !nodes.length && !children;

  return (
    <div ref={wrapperRef} className="flex-1 min-h-0 relative" onDrop={onDrop} onDragOver={onDragOver}>
      {isEmpty && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center text-muted-foreground p-8">
          <p className="text-sm">从左侧拖拽节点到这里开始编排</p>
          <p className="text-xs mt-1 text-muted-foreground/70">支持 Agent / 验收门 / 分支 / 人工等节点</p>
        </div>
      )}
      <ReactFlow ... 既有配置不变 ...>
        ...
      </ReactFlow>
    </div>
  );
}
```

关键点：
- `pointer-events-none`：overlay 不拦截 ReactFlow 的事件（拖拽 drop 命中 wrapper，不命中 overlay）。
- `absolute inset-0 z-10`：覆盖在画布上，有节点后 `isEmpty` 为 false 自动消失（满足 AC1.5）。
- `wrapperRef` 始终指向 wrapper，`bounds` 始终可算（满足 AC1.2 落点接近鼠标）。
- ReactFlow 渲染空 nodes/edges 正常（ReactFlow 支持空画布 + fitView）。

### 1.3 不改的

- 不动 `NodePalette.tsx`（`draggable` + `onDragStart` 写 dataTransfer 正常）。
- 不动 `stores/workflow-editor.ts` 的 `addNode`。
- 不换 DnD 库（继续原生 HTML5 DnD）。

---

## 2. FP2：Agent Studio AI 自动生成 Agent

### 2.1 新增 `src/agent-ai.ts`（镜像 `skill-ai.ts`）

```ts
import { sdkQuery } from './sdk-query.js';

const GENERATION_TIMEOUT_MS = 90_000;

const GENERATION_PROMPT = `You are an expert at designing AI agents. Based on the user's name and description, generate a complete, professional agent configuration.

Output STRICTLY a JSON object (no code fences, no prose) with these fields:
- name: string (1-80 chars, concise professional name; may refine the user's name)
- description: string (<=500 chars, clear one-line purpose)
- system_prompt: string (<=20000 chars, a complete professional system prompt with role, responsibilities, constraints, output format; in the user's language)
- model: string | null (suggested model id, or null to inherit platform default)
- engine: "claude" | "atomcode" | "codex" | "opencode" | "pi" (suggested engine, default "claude")
- max_turns: number | null (1-200, suggested autonomy budget, or null)
- temperature: number | null (0-2, suggested, or null)

User name: {{NAME}}
User description: {{DESCRIPTION}}

Output ONLY the JSON object.`;

export interface GeneratedAgentFields {
  name: string;
  description: string;
  system_prompt: string;
  model: string | null;
  engine: 'claude' | 'atomcode' | 'codex' | 'opencode' | 'pi';
  max_turns: number | null;
  temperature: number | null;
}

export async function generateAgentContent(
  description: string,
  suggestedName?: string,
): Promise<{ fields: GeneratedAgentFields } | { error: string }> {
  // 校验 description >= 10
  // fillTemplate → sdkQuery → stripCodeFences → JSON.parse + 字段兜底
  // engine 越界回退 'claude'
  // model 空串 → null
  // max_turns/temperature 越界 → null
}
```

容错策略（与 skill-ai 一致的 stripCodeFences + 额外 JSON 解析兜底）：
- LLM 偶尔包 ```json fence → strip。
- 偶尔前后带 prose → 取第一个 `{` 到最后一个 `}` 子串再 parse。
- 字段缺失 → 用合理默认（name 用 suggestedName 或 description 截断，description 空串，system_prompt 空串）。
- parse 失败 → 返回 `{ error: 'AI generated invalid JSON ...' }`。

### 2.2 后端端点 `POST /api/paas/agents/generate`（`paas-agents.ts`）

注意路由注册顺序：`POST /generate` 是静态路径，与既有 `POST /`（create）、`POST /:id/mounts` 不冲突（无 `POST /:id` 单段路由）。为安全放在文件靠前（create 之前）。

```ts
paasAgentsRoute.post('/generate', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (description.length < 10) return c.json({ error: 'description must be at least 10 characters' }, 400);
  const suggestedName = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined;
  const result = await generateAgentContent(description, suggestedName);
  if ('error' in result) return c.json({ error: result.error }, 502);
  return c.json({ fields: result.fields });  // 不落库
});
```

### 2.3 前端 store `generateAgent`（`agents-paas.ts`）

```ts
generateAgent: async (data: { name?: string; description: string }) => Promise<GeneratedAgentFields | null>;
// POST /api/paas/agents/generate，返回 fields 或 null
```

### 2.4 前端 UI（`AgentStudioPage.tsx` 新建弹窗）

新建弹窗（`showCreate` Card）顶部增加「AI 生成」区：name + description 输入已有，加一个「AI 生成」按钮（Wand2 图标）。点击 → `setGenerating(true)` → 调 `generateAgent({ name, description })` → 成功后 `setName/setDescription/setSystemPrompt/setModel/setEngine/setMaxTurns/setTemperature` 填入（保留用户已填的可被覆盖，提示「已填入 AI 生成结果，可再编辑后创建」）。失败 → `toast.error`。

不自动落库——用户在表单里可再编辑，点「创建」走既有 `handleCreate`（满足 A4 预览→确认→落库）。

弹窗状态新增：`generating`、`maxTurns`、`temperature`（既有弹窗未暴露 maxTurns/temperature，AI 生成会填入并展示为只读提示行，用户可在详情面板后续调整；为 surgical 不在此扩展弹窗的完整编辑——仅在 AI 生成后显示已填值的简要提示，落库随 create 一起提交）。

> 简化决策：`create` action 现已支持 `max_turns`/`temperature` 字段（store create 签名已含），`handleCreate` 把 `maxTurns`/`temperature` 一并传给 `create` 即可，弹窗里加两个可选输入（被 AI 生成填充）。

---

## 3. FP3：Agent Studio AI 优化 Agent

### 3.1 `agent-ai.ts` 增加 `optimizeAgentContent`

```ts
const OPTIMIZATION_TIMEOUT_MS = 90_000;

const OPTIMIZATION_PROMPT = `You are an expert at improving AI agent prompts. Optimize the given agent's system_prompt and description.

Focus:
- Make description clearer and more action-oriented.
- Tighten and clarify system_prompt: role, responsibilities, constraints, output format, edge cases.
- Preserve the agent's core intent and language.
- Do NOT change the name.

{{FEEDBACK_LINE}}

Current name: {{NAME}}
Current description:
{{DESCRIPTION}}

Current system_prompt:
{{SYSTEM_PROMPT}}

Output STRICTLY a JSON object (no fences, no prose):
{ "description": string, "system_prompt": string }`;

export async function optimizeAgentContent(
  current: { name: string; description: string; system_prompt: string },
  feedback?: string,
): Promise<{ description: string; system_prompt: string } | { error: string }>;
```

只优化 `description` + `system_prompt`（A3：不动 engine/model/挂载）。

### 3.2 后端端点（`paas-agents.ts`）

```ts
// POST /:id/optimize — 返回预览，不落库
paasAgentsRoute.post('/:id/optimize', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const row = getAgentDefinition(id, user.id);
  if (!row) return c.json({ error: 'Agent definition not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const feedback = typeof body.feedback === 'string' ? body.feedback : undefined;
  const result = await optimizeAgentContent(
    { name: row.name, description: row.description, system_prompt: row.system_prompt },
    feedback,
  );
  if ('error' in result) return c.json({ error: result.error }, 502);
  return c.json({
    optimized_description: result.description,
    optimized_system_prompt: result.system_prompt,
    original_description: row.description,
    original_system_prompt: row.system_prompt,
  });
});

// POST /:id/optimize/apply — 写回（前端把预览结果回传，后端 PATCH）
paasAgentsRoute.post('/:id/optimize/apply', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const row = getAgentDefinition(id, user.id);
  if (!row) return c.json({ error: 'Agent definition not found' }, 404);
  const body = await c.req.json().catch(() => ({})) as { description?: unknown; system_prompt?: unknown };
  const patch: Record<string, string> = {};
  if (typeof body.description === 'string') patch.description = body.description;
  if (typeof body.system_prompt === 'string') patch.system_prompt = body.system_prompt;
  if (!Object.keys(patch).length) return c.json({ error: 'No fields to apply' }, 400);
  const updated = updateAgentDefinition(id, user.id, patch);
  if (!updated) return c.json({ error: 'Agent definition not found' }, 404);
  return c.json({ agent: serializeAgentDef(updated) });
});
```

路由冲突排查：`POST /:id/optimize` 与 `POST /:id/mounts`、`POST /:id/versions/:vid/restore`、`POST /:id/share`、`POST /:id/test-chat` 同为 `POST /:id/{静态段}`，各静态段互不重名，无冲突。`POST /:id/optimize/apply` 与 `POST /:id/versions/:vid/restore` 同为三段，中间段 `optimize` vs `versions` 互不重名，无冲突。

### 3.3 前端 store `agents-paas.ts`

```ts
optimizeAgent: async (id, feedback?) => Promise<{ optimized_description; optimized_system_prompt; original_description; original_system_prompt } | null>;
applyOptimizedAgent: async (id, { description?, system_prompt? }) => Promise<boolean>;
```

### 3.4 前端 `OptimizeAgentDialog` 组件（镜像 `OptimizeSkillDialog`）

新建 `web/src/components/agents/OptimizeAgentDialog.tsx`，结构镜像 `OptimizeSkillDialog`：
- 反馈 textarea（可选）→「生成优化预览」按钮。
- 预览：对 `system_prompt` 跑 LCS diff（复用 `OptimizeSkillDialog` 的 `computeDiff`，可抽到 `lib/diff.ts` 共用，或就地复制——为 surgical，就地复制同一函数，不重构 skills 组件）。
- 「放弃」/「应用优化」按钮 → 调 `applyOptimizedAgent`。

### 3.5 前端 UI（`AgentStudioPage.tsx` 详情面板）

详情面板工具栏（`<div className="flex items-center justify-between">` 第 133 行右侧按钮区）增加「AI 优化」按钮（Wand2 图标）→ 打开 `OptimizeAgentDialog`（传入 `selected.id` + `selected.name`）。

---

## 4. 实施步骤

1. FP1：改 `WorkflowEditorCanvas.tsx`（删 early return + overlay）。
2. FP2/FP3 后端：新建 `src/agent-ai.ts`；`paas-agents.ts` 加 `/generate`、`/:id/optimize`、`/:id/optimize/apply`。
3. FP2/FP3 前端 store：`agents-paas.ts` 加 `generateAgent`/`optimizeAgent`/`applyOptimizedAgent` + 类型。
4. FP2 前端 UI：`AgentStudioPage` 新建弹窗加 AI 生成按钮 + maxTurns/temperature 输入。
5. FP3 前端 UI：新建 `OptimizeAgentDialog.tsx`；`AgentStudioPage` 详情面板加 AI 优化按钮 + 挂载对话框。
6. 验证：后端 tsc + 前端 tsc + 单元测试（`tests/units/`）+ 浏览器手测（FP1 拖拽、FP2/FP3 端到端）。

## 5. 验证清单（对齐 PRD AC）

- [ ] AC1.1–1.6 拖拽（空/非空、各类型、光标、overlay 消失）
- [ ] AC2.1–2.6 AI 生成（填充、engine 枚举、<10 字符校验、失败提示、保存落库、API 不落库）
- [ ] AC3.1–3.7 AI 优化（预览、diff、应用写回、取消、反馈、API 两步）
- [ ] AC4.1–4.4 编排端到端（拖拽编排+连线+保存+重开、AI draft+单节点编辑、运行高亮）

## 6. 风险

- **provider 不可用**：`sdkQuery` 返回 null/空 → `agent-ai.ts` 返回 `{ error }` → 前端 toast，UI 不崩（已设计）。
- **LLM 输出非合法 JSON**：strip fences + 子串提取 + 字段兜底，仍失败则返回 error（已设计）。
- **路由顺序**：`/generate`、`/:id/optimize` 已排查无冲突。
- **worktree 无 node_modules**：已 symlink 共享 node_modules，tsc 可用（注意 npx tsc stub 坑，直接用 `node_modules/.bin/tsc`）。
