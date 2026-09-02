# 技术方案：一级菜单简化

> 需求 ID：simplify-nav | 分支：`feat/simplify-nav` | 日期：2026-09-02

## 1. 影响文件清单

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `web/src/components/layout/nav-items.ts` | 编辑 | 精简 `baseNavItems` 至 7 项 |
| `web/src/components/settings/types.ts` | 编辑 | `SettingsTab` 联合类型新增 12 个 key |
| `web/src/components/settings/SettingsNav.tsx` | 编辑 | 新增 `appItems` 分组「应用入口」 |
| `web/src/pages/SettingsPage.tsx` | 编辑 | VALID_TABS / FULLPAGE_TABS / sectionTitle / mobileTabs / 渲染分支 |

## 2. nav-items.ts 改动

`baseNavItems` 仅保留 7 项（去掉 team/collaborations/opc/workflows/marketplace/engines/sandbox/tasks/loops/supervisor/harness/billing/memory）。`filterNavItems` 逻辑不变（billing 已不在一级菜单，无需 `requiresBilling` 判断，但保留函数签名与现有调用兼容）。

## 3. SettingsTab 类型扩展

```ts
export type SettingsTab =
  | ... (现有)
  | 'team' | 'collaborations' | 'opc' | 'workflows' | 'marketplace'
  | 'engines' | 'sandbox' | 'tasks' | 'loops' | 'supervisor' | 'harness' | 'billing';
```

## 4. SettingsNav 新增分组

新增 `appItems: NavItem[]`，group 改为 `'apps'`（NavItem.group 联合类型新增 `'apps'`）。该组在 `visibleItems` 中以「应用入口」标题渲染，置于「更多功能」之后。billing 项仅在 `billingEnabled` 时可见——为此 `SettingsNav` 需新增 `billingEnabled` prop。

图标沿用原一级菜单图标（Users/Handshake/Building2/Workflow/ShoppingBag/Cpu/Boxes/Clock4/Repeat/ShieldCheck/GitBranch/Wallet）。

## 5. SettingsPage 渲染扩展

- `VALID_TABS` 追加 12 个 key；
- `FULLPAGE_TABS` 追加 12 个 key（均为全页组件）；
- `sectionTitle` 追加 12 项标题；
- `mobileTabs` 追加 12 项（billing 受 `billingEnabled` 控制）；
- 渲染分支 `FULLPAGE_TABS.includes` 内追加 12 个 `activeTab === 'xxx' && <XxxPage />`；
- 新增 lazy import 12 个页面组件（与 App.tsx 一致的 lazy 模式）；
- 向 `SettingsNav` 透传 `billingEnabled`。

权限：这些应用入口对当前登录用户均默认可见（与原一级菜单一致——原一级菜单对所有登录用户均可见，billing 受 billingEnabled 控制）。不引入新的权限门槛。

## 6. 向后兼容

- 原 `/team` `/opc` 等路由在 App.tsx 中保留，深链可直达；
- `filterNavItems(billingEnabled)` 签名不变，`UnifiedSidebar` / `BottomTabBar` 调用点零改动。

## 7. 风险与回滚

- 风险：设置页 tab 数量增多导致移动端横向 tab 条变长——可接受，已有横向滚动。
- 回滚：`git revert` 单分支 commit 即可，无 schema / 后端变更。
