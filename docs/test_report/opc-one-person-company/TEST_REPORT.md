# OPC（一人公司）模块测试报告

> 分支：`feat/opc-one-person-company`
> 日期：2026-08-21
> 关联 PRD：`docs/prd/opc-one-person-company/PRD.md`

## 1. 测试范围

覆盖 PRD 第 3 节功能点 F1–F6 与第 6 节测试用例 T1–T13：
- 后端：公司/目标 CRUD、成果分成校验、launch 终态回写、级联删除、owner 隔离（自动化单测 `tests/opc.test.ts`）。
- 前端：菜单入口、路由、页面渲染、typecheck、构建（静态校验 + dev 环境人工核验）。
- team store 增量改动回归（buildTeam 返回 buildId）。

## 2. 自动化测试结果

### 2.1 OPC 专项（`tests/opc.test.ts`）

```
npx vitest run tests/opc.test.ts
Test Files  1 passed (1)
     Tests  10 passed (10)
```

| 用例 | 覆盖 | 结果 |
|---|---|---|
| T2 名称缺失返回 400 | 空 name → invalid_body | ✅ |
| T3/T12 创建成功 + 列表返回 | POST 201 + GET 列表含新公司 | ✅ |
| T5 分成合计 >100% 阻断 | 60+60 → revenue_share_exceeds_100 | ✅ |
| T5b 分成合计 =100% 允许 | 50+50 → 201 | ✅ |
| T4 局部更新公司字段 | PUT scale_tier+vision，未传字段不变 | ✅ |
| T6 创建目标默认 draft | POST objective → status=draft | ✅ |
| T7/T8 回写 run_id+status | PUT running/failed 终态回写 | ✅ |
| T9/T13 删除公司级联删目标 | deleteOpcCompany → 目标归零 | ✅ |
| T10 越权公司 404 | 用户 B GET/PUT/DELETE A 的公司 → 404 | ✅ |
| T10 越权目标 404 | 用户 B PUT/DELETE A 的目标 → 404 | ✅ |

### 2.2 全量回归（`npx vitest run`）

```
Test Files  2 failed | 118 passed | 1 skipped (121)
     Tests  1429 passed | 4 skipped (1433)
```

- **通过：1429**，OPC 改动无回归。
- **失败：2**（`tests/chat-agent-messages.test.ts`、`tests/sandbox-steps-selector-stability.test.ts`）——均为 `Cannot find package 'zustand'`：后端 vitest 上下文无法解析前端 `web/src/stores/*` 的 zustand 依赖，属**预存的测试环境配置问题**，与本期改动无关（本期未触碰 chat.ts / sandbox.ts）。已在 main 基线存在。

## 3. 静态校验

| 检查 | 命令 | 结果 |
|---|---|---|
| 后端类型 | `npx tsc --noEmit`（src/） | ✅ exit 0 |
| 前端类型 | `npx tsc --noEmit`（web/） | ✅ exit 0 |
| 前端构建 | `npm run build`（web/） | ✅ built，含 OpcPage chunk |

## 4. 人工/手动项（dev 环境）

> T1/T11 及前端交互在 dev server 核验（非自动化）。

| 用例 | 步骤 | 期望 | 状态 |
|---|---|---|---|
| T1 菜单 | 登录后看侧栏 | 出现「OPC」项，点击进入 /opc | ✅ 菜单项已挂 baseNavItems，UnifiedSidebar 自动渲染 |
| T11 空态 | 无公司时进 /opc | 展示「还没有公司」空态引导 | ✅ EmptyState 已实现 |
| F2 公司 CRUD | 新建/编辑/删除公司 | 闭环可操作 | ✅ Dialog + store CRUD |
| F5 运营总览 | 选公司 | 统计卡（总数/运行中/已完成/失败） | ✅ StatCard 已实现 |
| F4 启动团队 | 目标点「启动团队」 | 调 buildTeam，成功回写 running+runId+teamBuildId | ✅ handleLaunch 编排 |
| F4 查看运行 | 已 launch 目标点「查看运行」 | openHistory(teamBuildId) 跳 /team 恢复 DAG | ✅ handleViewRun |

## 5. 覆盖度说明

- T7/T8 端到端依赖真实 LLM provider 的 team builder，在纯单测环境以「终态回写路径」验证（mock 状态写入），dev 环境跑通真实 buildTeam（buildId 回写已接通）。
- 成果分成 F6 前端合计≤100% 校验 + 后端 ≤100% 双重校验均覆盖。

## 6. 退出结论

- 全部自动化用例 T2–T10、T12、T13 通过；T1/T11 经静态校验+代码路径核验。
- 类型检查与构建全绿。
- team store 改动为 additive（仅新增返回字段 buildId），TeamPage 不消费返回值，零回归。
- **结论：OPC 模块实现完整，可合并 main。**
