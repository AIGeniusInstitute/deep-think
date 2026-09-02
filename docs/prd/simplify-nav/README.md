# PRD：一级菜单简化

> 需求 ID：simplify-nav
> 创建日期：2026-09-02
> 分支：`feat/simplify-nav`

## 1. 背景

DeepThink Web 端当前一级侧边导航（`UnifiedSidebar` + 移动端 `BottomTabBar`）共有 **20 个**一级菜单项（工作台、团队、协作、OPC、开放平台、Agent、工作流、Skill、知识库、市场、MCP、记忆管理、引擎、沙箱、任务、循环、监督者、Harness、账单、设置）。菜单项过多导致：

- 主导航信息密度过高，核心能力被淹没；
- 新用户上手成本大，找不到高频入口；
- 一级菜单承担了"功能罗列"而非"主线导航"的职责。

## 2. 目标

简化一级菜单至 **7 项**主线入口，将其余功能入口收纳进「设置」页二级导航，保持可达性不降低。底部"报告问题"按钮与个人头像区域不变。

## 3. 一级菜单最终结构（保留项）

| 顺序 | 标签 | 路由 | 图标 |
|------|------|------|------|
| 1 | 工作台 | `/chat` | MessageCircle |
| 2 | Agent | `/agents` | Bot |
| 3 | Skill | `/skills` | Puzzle |
| 4 | MCP | `/mcp-servers` | Server |
| 5 | 知识库 | `/knowledge-bases` | BookOpen |
| 6 | 开放平台 | `/open-platform` | KeyRound |
| 7 | 设置 | `/settings` | User |

底部不变：报告问题（Bug 图标）、个人头像 Popover（个人设置 / 退出登录）。

## 4. 收纳进设置的功能（新增 Settings Tab）

| 原 一级菜单 | 新 Settings Tab key | 渲染页面 | 备注 |
|------------|---------------------|----------|------|
| 团队 | `team` | TeamPage | 全页 |
| 协作 | `collaborations` | CollaborationPage | 全页 |
| OPC | `opc` | OpcPage | 全页 |
| 工作流 | `workflows` | WorkflowEditorPage | 全页 |
| 市场 | `marketplace` | MarketplacePage | 全页 |
| 引擎 | `engines` | EnginesPage | 全页 |
| 沙箱 | `sandbox` | SandboxPage | 全页 |
| 任务 | `tasks` | TasksPage | 全页 |
| 循环 | `loops` | LoopsPage | 全页 |
| 监督者 | `supervisor` | SupervisorPage | 全页 |
| Harness | `harness` | HarnessPage | 全页 |
| 账单 | `billing` | BillingPage | 全页，仅 billing 开启时可见 |
| 记忆管理 | `memory`（已存在） | MemoryPage | 无需新增 |

新增分组「**应用入口**」承载上述 12 个新 tab，置于「更多功能」组之下。

## 5. 不改动范围（Surgical）

- 各页面组件本身（TeamPage / OpcPage …）一律不动；
- 后端路由（`/team`、`/opc` …）保留，保证深链与书签可达；
- 设置页既有分组与 tab 不删减（skills/mcp-servers/agent-definitions 等保留，避免破坏既有习惯）；
- 底部 Bug 报告、头像区域不动。

## 6. 验收标准

### AC-1 桌面端一级菜单项数
登录后，左侧窄导航栏一级菜单**恰好 7 项**，依次为：工作台、Agent、Skill、MCP、知识库、开放平台、设置；顺序与第 3 节一致。

### AC-2 移动端底栏项数
窄屏（<lg）浮动底栏一级菜单**恰好 7 项**，顺序同 AC-1。

### AC-3 底部区域不变
一级菜单下方仍存在"报告问题"按钮与个人头像；点击头像 Popover 内仍为「个人设置 / 退出登录」两项。

### AC-4 收纳项在设置页可达
进入「设置 → 应用入口」分组，可见 12 项（账单仅在 billing 开启时可见）。逐一点击均可正确切换并渲染对应页面（无空白、无报错）。

### AC-5 深链回退
直接访问 `/team`、`/opc`、`/harness` 等原路由仍可正常打开对应页面（路由未删，向后兼容）。

### AC-6 高频入口功能正常
工作台（/chat）、Agent（/agents）、Skill（/skills）、MCP（/mcp-servers）、知识库（/knowledge-bases）、开放平台（/open-platform）、设置（/settings）7 个一级入口点击均可正常跳转且高亮当前项。

### AC-7 TypeScript 编译通过
`web/` 下 `tsc --noEmit` 无新增报错。

## 7. 测试用例

| 用例 | 操作 | 预期 | 对应 AC |
|------|------|------|---------|
| TC-01 | 桌面端登录，统计左侧一级菜单项 | 恰好 7 项，顺序正确 | AC-1 |
| TC-02 | 桌面端依次点击 7 项 | 每项跳转正确，当前项高亮 | AC-1/6 |
| TC-03 | 调窄窗口至 <lg，查看底栏 | 底栏恰好 7 项 | AC-2 |
| TC-04 | 查看底部 | 报告问题按钮 + 头像 Popover 两项 | AC-3 |
| TC-05 | 设置→应用入口，逐一点击 12 项 | 均正确渲染 | AC-4 |
| TC-06 | 地址栏直接访问 /team、/opc、/harness | 正常打开 | AC-5 |
| TC-07 | `cd web && npx tsc --noEmit` | 无新增错误 | AC-7 |
