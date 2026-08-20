# OPC（一人公司）模块 PRD

> 分支：`feat/opc-one-person-company`
> 作者：DeepThink
> 日期：2026-08-21
> 状态：实施中

## 1. 背景与目标

在 DeepThink 平台一级菜单中新增 **OPC（One-Person Company / 一人公司）** 模块。让单个用户借助 DeepThink 既有的多智能体协同、技能、知识库、循环、任务等能力，构建并运营一家「一人公司」：设定商业目标 → 驱动智能体网络协同执行 → 以企业级运营视角跟踪目标与运行状态。

OPC 不重造 agent 基础设施，而是在既有能力之上叠加一层**编排/配置/目标驱动**层。

## 2. 范围与非范围

### 范围（In Scope）
1. 一级菜单新增「OPC」入口，新增 `/opc` 路由与 `OpcPage`。
2. **OPC 公司 CRUD**：名称、愿景、商业目标概述、运营策略、规模层级、覆盖领域、成果分成配置。
3. **OPC 商业目标 CRUD**：挂载在公司下，含标题、描述、领域、验收标准、度量、状态。
4. **目标驱动的智能体网络协同**：在目标上一键「启动团队」——委托既有 `POST /api/team/runs`，以目标为 goalText，自动解析用户主工作区作为 groupFolder/chatJid；完成后把 runId/teamBuildId 回写关联到目标。
5. **运营总览**：公司详情页展示目标看板（按状态分组）与关联运行，模拟企业级运营视角。
6. **成果分成配置**：公司级配置合作方与分成比例（仅配置存储，不做计费扣款集成）。

### 非范围（Out of Scope）
- 不实现真实资金结算 / 钱包扣款（复用既有 billing 模块属投机，本期不做）。
- 不重造多智能体分解算法、graph 引擎、技能/MCP 体系——一律复用既有。
- 不做物理团队/组织架构管理（明确取消，符合一人公司定位）。
- 不做多租户/权限分级（OPC 数据按 owner_user_id 隔离即可）。

## 3. 功能点与验收标准

### F1 一级菜单 OPC 入口
- **验收**：左侧栏 `UnifiedSidebar` 与移动端 `BottomTabBar` 均出现「OPC」图标项；点击跳转 `/opc`；当前位于 `/opc` 时高亮。账单开关不影响该项显示。

### F2 OPC 公司 CRUD
- **验收**：
  - 在 `/opc` 页可创建公司（名称必填，其余可选）。
  - 公司列表按创建时间倒序展示，展示名称/规模层级/状态。
  - 可编辑公司全部字段、可删除公司（删除时其下目标一并删除）。
  - 字段：name(必填)、vision、commercial_goals、operating_strategy、scale_tier(enum: solo/small/mid)、domains(json array string)、revenue_share(json)、status(enum: active/archived)。

### F3 OPC 商业目标 CRUD
- **验收**：
  - 公司详情页可创建目标（title 必填，domain 选填，acceptance_criteria 选填，metrics 选填）。
  - 目标按状态分组展示：draft / active / running / completed / failed。
  - 可编辑、可删除目标。
  - 目标状态默认 `draft`。

### F4 目标驱动的智能体网络协同（启动团队）
- **验收**：
  - 目标卡片存在「启动团队」按钮（status ≠ running 时可用）。
  - 点击后：前端解析用户主工作区（groups 中 `is_my_home`）得到 groupFolder + chatJid；调用既有 `useTeamStore.buildTeam`，goalText = 目标标题+验收标准，userLanguage 透传。
  - 构建成功后：把返回的 runId 与 teamBuildId 通过 `PUT /api/opc/objectives/:id` 回写到目标，目标状态置 `running`。
  - 构建失败：目标状态置 `failed`，错误信息展示在卡片，不抛未捕获异常。
  - 已关联 runId 的目标可点击「查看运行」跳转 `/team` 并恢复该 run 可视化（复用 team store openHistory）。

### F5 运营总览
- **验收**：公司详情页顶部展示统计：目标总数、各状态计数、运行中数量。无目标时显示空态引导。

### F6 成果分成配置
- **验收**：公司编辑表单含「成果分成」区，可增删合作方行（name + ratio%），保存为公司 `revenue_share` JSON。前端校验合计 ≤ 100%（允许 <100% 作为预留），超出阻断保存并提示。

## 4. 数据模型

### 表 opc_companies
| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | uuid |
| owner_user_id | TEXT NOT NULL | 数据隔离 |
| name | TEXT NOT NULL | 公司名 |
| vision | TEXT | 愿景 |
| commercial_goals | TEXT | 商业目标概述 |
| operating_strategy | TEXT | 运营策略 |
| scale_tier | TEXT | solo/small/mid |
| domains_json | TEXT | 领域数组 JSON |
| revenue_share_json | TEXT | 分成 JSON |
| status | TEXT | active/archived |
| created_at | INTEGER | |
| updated_at | INTEGER | |

索引：`idx_opc_companies_owner(owner_user_id, created_at DESC)`

### 表 opc_objectives
| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | uuid |
| company_id | TEXT NOT NULL | FK→opc_companies.id |
| owner_user_id | TEXT NOT NULL | |
| title | TEXT NOT NULL | |
| description | TEXT | |
| domain | TEXT | |
| acceptance_criteria | TEXT | |
| metrics_json | TEXT | |
| status | TEXT | draft/active/running/completed/failed |
| team_build_id | TEXT | 关联 team_builds.id |
| run_id | TEXT | 关联 graph_runs.id |
| created_at | INTEGER | |
| updated_at | INTEGER | |

索引：`idx_opc_objectives_company(company_id, created_at DESC)`

## 5. API

- `GET /api/opc/companies` — 列当前用户公司
- `POST /api/opc/companies` — 创建
- `PUT /api/opc/companies/:id` — 更新（含 revenue_share）
- `DELETE /api/opc/companies/:id` — 删除（级联删目标）
- `GET /api/opc/companies/:id/objectives` — 列公司下目标
- `POST /api/opc/companies/:id/objectives` — 创建目标
- `PUT /api/opc/objectives/:id` — 更新目标（含 status/team_build_id/run_id 回写）
- `DELETE /api/opc/objectives/:id` — 删除目标

所有路由经 `authMiddleware`，按 owner_user_id 隔离。

## 6. 测试用例

| 用例 | 步骤 | 期望 |
|---|---|---|
| T1 菜单 | 登录后查看侧栏 | 出现「OPC」项，点击进入 /opc |
| T2 创建公司 | 名称留空提交 | 阻断，提示名称必填 |
| T3 创建公司 | 名称「Acme OPC」提交 | 列表出现该公司 |
| T4 编辑公司 | 修改 scale_tier=mid 保存 | 字段更新成功 |
| T5 分成校验 | 加两方各 60% 保存 | 阻断，提示合计超 100% |
| T6 创建目标 | 在公司下新建目标 | 出现在 draft 分组 |
| T7 启动团队 | 目标点「启动团队」 | 调用 team buildTeam；成功后状态=running，runId 回写 |
| T8 启动失败 | team 返回 error | 状态=failed，错误展示 |
| T9 删除公司 | 删除有目标的公司 | 公司与目标均删除 |
| T10 隔离 | 用户A无法 GET/PUT/DELETE 用户B 的公司 | 404 |
| T11 空态 | 无公司 | 展示空态引导 |
| T12 后端单元 | createCompany→listCompanies | 返回含新公司 |
| T13 后端单元 | createObjective→deleteCompany | 目标被级联删除 |

T7/T8 依赖真实 team builder，在无 LLM provider 的纯单测环境以「mock 状态回写」方式验证回写路径；端到端在 dev 环境验证。

## 7. 成功标准（退出条件）
- 全部测试用例 T1–T13 通过。
- `npm run typecheck`（后端）与 `web` 端 `tsc` 无新增类型错误。
- 前端 `/opc` 页可正常渲染、CRUD 闭环可操作。
- 合并到 main 并 push。
