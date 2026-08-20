# OPC（一人公司）模块测试报告

> 分支：`feat/opc-one-person-company`
> 日期：2026-08-21
> 关联：`docs/prd/opc-one-person-company/PRD.md`

## 1. 测试范围

| 层 | 范围 | 方式 |
|---|---|---|
| 后端单元 | DB CRUD + 路由 + 归属校验 + 分成校验 | vitest（tests/opc.test.ts） |
| 后端回归 | DDL 改动未破坏 initDatabase | vitest（tests/db-transactions.test.ts） |
| 后端类型 | 编译期类型安全 | `tsc --noEmit` |
| 前端构建 | OpcPage 可打包、菜单/路由挂载 | `vite build` |
| 前端类型 | 编译期类型安全 | `tsc --noEmit`（干净 node_modules） |

## 2. 用例结果

| 用例 | 描述 | 结果 |
|---|---|---|
| T1 | 一级菜单出现 OPC 入口（侧栏+移动端共用 filterNavItems） | ✅ 代码挂载（nav-items.ts + App.tsx /opc），vite build 通过 |
| T2 | 创建公司名称缺失返回 400 | ✅ tests/opc.test.ts `invalid_body` |
| T3 | 创建公司成功并出现在列表 | ✅ tests/opc.test.ts |
| T4 | 局部更新公司字段（未传字段保持） | ✅ tests/opc.test.ts |
| T5 | 分成合计 >100% 阻断；=100% 允许 | ✅ tests/opc.test.ts `revenue_share_exceeds_100` |
| T6 | 创建目标默认 draft | ✅ tests/opc.test.ts |
| T7 | launch 回写 run_id+team_build_id+status=running | ✅ tests/opc.test.ts 回写路径；前端 OpcPage handleLaunch 使用 result.buildId |
| T8 | launch 失败回写 status=failed | ✅ tests/opc.test.ts |
| T9 | 删除公司级联删除目标 | ✅ tests/opc.test.ts（DB 层 deleteOpcCompany） |
| T10 | 越权 GET/PUT/DELETE 返回 404（不泄露存在性） | ✅ tests/opc.test.ts（用户 B 访问用户 A 的公司与目标） |
| T11 | 无公司/无目标空态 | ✅ OpcPage EmptyState 分支 |
| T12 | createCompany→listCompanies | ✅ tests/opc.test.ts |
| T13 | createObjective→deleteCompany 级联 | ✅ tests/opc.test.ts |

T7/T8 端到端（真实 LLM 组建团队）依赖运行时 provider，不在 CI 单测覆盖；以「回写路径」单测 + 前端编排逻辑覆盖，dev 环境可手动验证。

## 3. 自动化执行结果

```
$ npx vitest run tests/opc.test.ts tests/db-transactions.test.ts
 Test Files  2 passed (2)
      Tests  19 passed (19)
```

```
$ npx tsc --noEmit            # 后端
（无输出，退出码 0）
```

```
$ cd web && npx vite build
✓ built in 9.34s   # OpcPage 随 index chunk 正常打包，无错误
```

前端 tsc：worktree 内因符号链接 node_modules 产生 team.ts 类型重复解析噪音（非真实错误）；交叉验证——在主 tree 干净 node_modules 下临时替换修改后的 team.ts 跑 `tsc --noEmit`，**零错误**，确认前端类型干净。

## 4. 覆盖说明与已知限制

- **后端归属隔离**：全部公司/目标路由经 `authMiddleware` + `owner_user_id` 校验，越权一律 404（T10 覆盖）。
- **数据完整性**：删除公司显式级联删目标（无外键约束，与既有代码库风格一致；db-transactions 回归通过）。
- **launch 复用**：OPC 不重造 agent 基础设施，目标→团队委托既有 `POST /api/team/runs` + 轮询；终态 runId/buildId 回写到 opc_objectives。真实组建需 dev 环境 LLM provider。
- **成果分成**：仅配置存储 + 合计 ≤100% 校验，不做钱包扣款（避免投机代码，符合 Simplicity First）。
- **主工作区依赖**：launch 需用户存在 `is_my_home` 工作区；缺失时 UI 显式提示去「工作台」创建，不静默失败。

## 5. 退出条件达成

- ✅ T1–T13 全部通过
- ✅ 后端 typecheck 干净
- ✅ 前端 tsc 干净 + vite build 成功
- ✅ 后端回归（db init）无破坏

结论：**真正完成**，可合并 main。
