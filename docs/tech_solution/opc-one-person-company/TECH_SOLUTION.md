# OPC（一人公司）模块技术方案

> 分支：`feat/opc-one-person-company`
> 日期：2026-08-21
> 关联 PRD：`docs/prd/opc-one-person-company/PRD.md`

## 1. 设计原则

- **复用优先**：多智能体分解/graph/技能/MCP 一律复用既有 `team` 子系统，OPC 仅做目标→团队 launch 的「编排」。
- **Surgical Changes**：后端仅新增 `src/routes/opc.ts` + `db.ts` 内追加表与函数；前端仅新增 `OpcPage` + `opc` store + `nav-items.ts` 一行 + `App.tsx` 一路由。不重构既有代码。
- **数据隔离**：所有表带 `owner_user_id`，路由层 `authMiddleware` + 按 owner 过滤，越权返回 404。

## 2. 后端

### 2.1 DB（src/db.ts）

在 `initDatabase()` DDL 段追加（紧跟 team_builds 之后，保持「相邻表聚集」）：

```sql
CREATE TABLE IF NOT EXISTS opc_companies (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  vision TEXT,
  commercial_goals TEXT,
  operating_strategy TEXT,
  scale_tier TEXT NOT NULL DEFAULT 'solo',
  domains_json TEXT,
  revenue_share_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opc_companies_owner ON opc_companies(owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS opc_objectives (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  domain TEXT,
  acceptance_criteria TEXT,
  metrics_json TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  team_build_id TEXT,
  run_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opc_objectives_company ON opc_objectives(company_id, created_at DESC);
```

### 2.2 Row 类型（src/db.ts 末尾类型区，仿 TeamBuildRow）

```ts
export interface OpcCompanyRow { id; owner_user_id; name; vision; commercial_goals; operating_strategy; scale_tier; domains_json; revenue_share_json; status; created_at; updated_at; }
export interface OpcObjectiveRow { id; company_id; owner_user_id; title; description; domain; acceptance_criteria; metrics_json; status; team_build_id; run_id; created_at; updated_at; }
```

### 2.3 DB 函数（src/db.ts，仿 team_builds 函数块）

- `createOpcCompany(input): string`
- `getOpcCompany(id): OpcCompanyRow | undefined`
- `listOpcCompanies(ownerUserId): OpcCompanyRow[]`
- `updateOpcCompany(id, fields): void` — 动态拼 SET 子句（仅更新传入字段）
- `deleteOpcCompany(id): void` — 先 `DELETE FROM opc_objectives WHERE company_id=?` 再删公司
- `createOpcObjective(input): string`
- `getOpcObjective(id): OpcObjectiveRow | undefined`
- `listOpcObjectivesByCompany(companyId): OpcObjectiveRow[]`
- `updateOpcObjective(id, fields): void` — 动态 SET
- `deleteOpcObjective(id): void`

> deleteOpcCompany 内做级联删目标，避免引入外键约束迁移（既有代码库不依赖 FK）。

### 2.4 路由（src/routes/opc.ts，仿 src/routes/team.ts）

```ts
export const opcRoutes = new Hono<{ Variables: Variables }>();
opcRoutes.use('*', authMiddleware);
```

- `GET /companies` → listOpcCompanies(user.id)
- `POST /companies` → zod 校验 name 必填、scale_tier enum、revenue_share 可选；createOpcCompany
- `PUT /companies/:id` → 校验归属（getOpcCompany.owner===user.id 否则 404）；updateOpcCompany
- `DELETE /companies/:id` → 校验归属；deleteOpcCompany
- `GET /companies/:id/objectives` → 校验公司归属；listOpcObjectivesByCompany
- `POST /companies/:id/objectives` → 校验公司归属；createOpcObjective
- `PUT /objectives/:id` → 校验目标归属；updateOpcObjective（status/team_build_id/run_id 回写）
- `DELETE /objectives/:id` → 校验归属；deleteOpcObjective

归属校验：取 row → row.owner_user_id !== user.id 返回 404（不泄露存在性）。

### 2.5 路由注册（src/web.ts）

仿 team：
```ts
import { opcRoutes } from './routes/opc.js';
...
app.route('/api/opc', opcRoutes);
```

## 3. 前端

### 3.1 菜单（web/src/components/layout/nav-items.ts）
`baseNavItems` 追加 `{ path: '/opc', icon: Building2, label: 'OPC' }`，置于 `/team` 附近（团队之后）。`filterNavItems` 无需改动。

### 3.2 路由（web/src/App.tsx）
`OpcPage` 用 lazy import；在受保护 layout 区追加 `<Route path="/opc" element={<Suspense><OpcPage/></Suspense>} />`。

### 3.3 Store（web/src/stores/opc.ts，zustand，仿 team.ts）
状态：companies, objectives, loading, error。
方法：
- `loadCompanies()` → GET /api/opc/companies
- `createCompany(input)` → POST
- `updateCompany(id, patch)` → PUT
- `deleteCompany(id)` → DELETE + 刷新
- `loadObjectives(companyId)` → GET /api/opc/companies/:id/objectives
- `createObjective(companyId, input)` → POST
- `updateObjective(id, patch)` → PUT
- `deleteObjective(id)` → DELETE
- `launchObjective(objective, plan)` — **复用 team store**：
  1. 从 `useGroupsStore` groups 找 `is_my_home` → groupFolder + chatJid；找不到则报错引导。
  2. 调 `useTeamStore.getState().buildTeam({ goalText: objective.title + (acceptance_criteria? ' | '+criteria : ''), groupFolder, chatJid, acceptanceCriteria: objective.acceptance_criteria, userLanguage: 'zh-CN' })`。
  3. 成功：`updateObjective(id, { status:'running', team_build_id?, run_id: returnedRunId })`。
  4. 失败：`updateObjective(id, { status:'failed' })` + toast。

> launchObjective 放在组件内调用更顺（需同时访问 team store + groups store + opc store），store 仅暴露 CRUD。最终决定：在 OpcPage 组件内编排 launch 逻辑，调用各 store 原子方法。store 不直接耦合 team store——保持 store 单一职责。

### 3.4 页面（web/src/pages/OpcPage.tsx）
- 左：公司列表（可折叠）；右：选中公司详情。
- 公司详情：统计卡（目标总数/各状态/运行中） + 分成配置（只读摘要，编辑走编辑弹窗） + 目标看板（按 status 分组列）。
- 目标卡片：标题/领域/状态徽标/「启动团队」/「查看运行」按钮。
- 编辑公司/创建公司/创建目标用 Dialog（复用 `@/components/ui` + `@/components/common` 既有组件）。
- launch 编排：组件内 `handleLaunch(obj)`，try/catch + toast，成功 updateObjective 回写 runId。
- 「查看运行」：`useTeamStore.openHistory(teamBuildId)` 后 `navigate('/team')`。

## 4. 测试

- 后端单元（vitest，tests/ 下新增 opc.test.ts）：createCompany→list→update→delete 级联；createObjective→updateObjective 回写 run_id；越权 GET 返回 404。
- 前端：T1–T11 手动/在 dev 环境验证；typecheck。

## 5. 风险与取舍
- **launch 依赖主工作区**：用户必须有 home group，否则 launch 引导去 /chat 创建。已在 UI 提示，不静默失败。
- **team builder 耗时**：buildTeam 内部已异步 + 轮询，OPC 直接复用，无新增长阻塞。
- **不做计费集成**：revenue_share 仅配置存储，明确不接钱包，避免投机代码。
