# PRD: K8s 云端部署 PG 兼容性补全（Phase 2.5）

> 版本: 1.0 | 创建: 2026-09-04 | 状态: approved | 上游: k8s-cloud-deploy (Phase 1-2 已交付)

## 1. 背景

`feat/k8s-cloud-deploy`（Phase 1）与 `feat/full-horizontal-scaling`（Phase 2）已合并 main：
K8s 清单、Dockerfile、健康检查、Redis 事件总线、PostgreSQL 同步驱动（pg-sync-driver +
sql-translator + sqlite-compat）、分布式 Agent IPC、4+3 缺口修复均已交付，本地 kind 集群
通过 3 大验证（pub/sub 广播、选主、PG 多写并发）。

**但**：PG 模式从未真正端到端启动过——kind 验证只测了裸写并发，未走 `initDatabase()` 全
schema 初始化。审查发现 PG 模式启动即崩：

| # | 缺口 | 根因 | 影响 |
|---|------|------|------|
| G1 | FTS5 虚拟表 + 触发器在 PG 创建 | `CREATE VIRTUAL TABLE ... USING fts5` 与 SQLite 触发器 `BEGIN...END` 内联体在 PG 非法语法 | `initDatabase()` 抛错，**Pod CrashLoopBackOff，PG 模式无法启动** |
| G2 | `searchKbDocuments` 用 `MATCH/snippet()/bm25()` | FTS5 专有函数，PG 无 | 知识库搜索在 PG 模式报错 |
| G3 | sqlite-vec 在 PG 模式尝试加载 | `sqliteVec.load(db)` 对 PgDatabase 无 `loadExtension` → 抛错被 catch | 不致命但日志噪声；向量搜索已有线性降级 |
| G4 | pg_trgm/pgvector 扩展未初始化 | postgres.yaml 用 pgvector 镜像但无 `CREATE EXTENSION` | KB 搜索无 GIN 索引，全表扫描 |

## 2. 目标

让 **PG 模式真正可启动**，使云端多 Pod 水平扩缩容端到端可用：
1. PG 模式 `initDatabase()` 不再崩溃（G1）
2. 知识库全文搜索在 PG 模式可用（G2/G4）
3. sqlite-vec 加载按后端分支，消除噪声日志（G3）

## 3. 非目标（显式排除，遵循 Simplicity First）

- ❌ 401 个 db.ts 函数 async 重写（PRD Phase 3，未来）
- ❌ json_extract/json_each → PG `->>`/`jsonb_array_elements` 翻译（28 处，均在 token_usage
  统计分析端点，非核心热路径；字符串正则翻译易破坏正常查询，风险/收益不合理，留待后续 Phase）
- ❌ pgvector 向量索引接线（向量搜索已有线性扫描降级，PG 下可用但慢；pgvector 为后续 Phase）
- ❌ 真实云厂商 K8s 集群部署验证（需云凭证，不在本地可完成范围）

## 4. 功能需求与验收标准

### 4.1 FTS5 DDL 后端分支
- [ ] PG 模式：`initDatabase()` 不创建 `kb_documents_fts` 虚拟表与 3 个触发器
- [ ] SQLite 模式：FTS5 虚拟表 + 触发器照常创建（零行为变更）
- [ ] PG 模式 `initDatabase()` 全程不抛错

### 4.2 PG 全文搜索（pg_trgm）
- [ ] PG 模式：`initKbSearchIndexesPg()` 执行 `CREATE EXTENSION IF NOT EXISTS pg_trgm` + 两个 GIN 索引
- [ ] `CREATE EXTENSION` 失败时 warn 并降级（managed PG 无超管权限不崩）
- [ ] `searchKbDocuments` 在 PG 模式走 `ILIKE` + `LEFT(content,200)` 分支，返回结构与 SQLite 一致

### 4.3 sqlite-vec 后端守卫
- [ ] PG 模式：跳过 `sqliteVec.load(db)`，`vecExtensionLoaded=false`，走线性扫描
- [ ] SQLite 模式：sqlite-vec 照常加载（零行为变更）

### 4.4 兼容性
- [ ] 不设 `DATABASE_URL` 时，默认 SQLite 行为与改动前完全一致
- [ ] 后端 `tsc --noEmit` exit 0
- [ ] smoke 测试集（111 项）全通过

## 5. 测试用例

| 编号 | 用例 | 步骤 | 预期 |
|---|---|---|---|
| TC-01 | SQLite 回归 | `npx vitest run`（smoke 集） | 全通过，sqlite-vec 正常加载 |
| TC-02 | tsc | `npx tsc --noEmit` | exit 0 |
| TC-03 | PG 模式启动 | 模拟 isPostgresBackend=true 走 init 分支 | fts5 DDL 跳过、pg_trgm 索引创建、不抛错 |
| TC-04 | PG 搜索分支 | searchKbDocuments PG 分支 SQL 形态 | ILIKE + LEFT，占位符顺序正确 |
| TC-05 | 降级韧性 | pg_trgm 不可用 | warn 不崩，搜索降级 seq scan |
