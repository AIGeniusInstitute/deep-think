# 执行状态：一级菜单简化

> 需求 ID：simplify-nav | 分支：`feat/simplify-nav` | 日期：2026-09-02

## 进度

| 阶段 | 状态 | 产物 |
|------|------|------|
| 0 worktree | ✅ | `.worktrees/feat-simplify-nav`（基于 main 9410ea2） |
| 1 PRD | ✅ | docs/prd/simplify-nav/README.md |
| 2 技术方案 | ✅ | docs/tech_solution/simplify-nav/README.md |
| 3 编码 | ✅ | 4 文件改动（见下） |
| 4 测试 | ✅ | docs/test_report/simplify-nav/test-report.html |
| 5 合并 main | ⏳ | 待执行 |

## 改动文件

1. `web/src/components/layout/nav-items.ts` — `baseNavItems` 精简至 7 项
2. `web/src/components/settings/types.ts` — `SettingsTab` 新增 12 key
3. `web/src/components/settings/SettingsNav.tsx` — 新增 `appItems`「应用入口」分组 + `billingEnabled` prop
4. `web/src/pages/SettingsPage.tsx` — VALID_TABS/FULLPAGE_TABS/sectionTitle/mobileTabs/渲染分支扩展 + 计费 store

## 验证记录

- `npx tsc --noEmit` → 退出 0
- `npx vite build` → ✓ built in 9.38s
- 浏览器自动化（playwright-core + 系统 google-chrome）：
  - 桌面一级菜单 nav a[href] 去重唯一路径 = 7
  - 移动 .floating-nav = 7 项
  - SettingsNav 出现「应用入口」分组 + 12 tab
  - Bug 按钮存在、console errors=0
  - TeamPage 内容渲染正常、深链 /team 可达

## 部署验证方式

运行态服务来自 `~/prod/deepthink`（非 `~/deepthink`）。验证时临时将 worktree 产物 dist 部署至 `~/prod/deepthink/web/dist` 截图取证，验证后已恢复原 prod dist。
