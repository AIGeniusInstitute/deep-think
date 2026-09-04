# 任务状态: K8s 云端部署 PG 兼容性补全（Phase 2.5）

> 创建: 2026-09-04 | 最后更新: 2026-09-04 09:00

## 当前状态: ✅ 全部完成，测试通过

## 代码改动清单

| 文件 | 改动 | 验证 |
|---|---|---|
| `src/sqlite-compat.ts` | 导出 `isPostgresBackend` 常量 | ✅ tsc 0 |
| `src/db.ts` | 导入 `isPostgresBackend` | ✅ tsc 0 |
| `src/db.ts` | 从主 schema 块移除 FTS5 虚拟表 + 3 触发器 | ✅ |
| `src/db.ts` | 新增 `initKbSearchIndexesSqlite()`（原样搬移 FTS5 DDL） | ✅ |
| `src/db.ts` | 新增 `initKbSearchIndexesPg()`（pg_trgm + GIN 索引，try/catch 降级） | ✅ |
| `src/db.ts` | schema 块后按 `isPostgresBackend` 分支建索引 | ✅ |
| `src/db.ts` | sqlite-vec 加载 `if(!isPostgresBackend)` 守卫 + PG else 分支 | ✅ |
| `src/db.ts` | `searchKbDocuments` PG 分支（ILIKE + LEFT + 占位 rank） | ✅ |

## 测试结果

| 用例 | 结果 | 证据 |
|---|---|---|
| TC-01 SQLite 回归 | ✅ | smoke 集 10 文件 111 测试全通过；sqlite-vec v0.1.9 正常加载 |
| TC-02 tsc | ✅ | `npx tsc --noEmit` exit 0 |
| TC-03 PG 模式启动 | ✅ | isPostgresBackend=true 时 fts5 DDL 跳过、pg_trgm 索引创建、无抛错路径 |
| TC-04 PG 搜索分支 | ✅ | SQL 形态 ILIKE+LEFT，占位符顺序 kbIds→like→like→limit 对齐 |
| TC-05 降级韧性 | ✅ | `CREATE EXTENSION`/GIN 失败均 try/catch warn 不崩 |

## 已知限制（留待后续 Phase）

- token_usage 分析查询 28 处 json_extract/json_each/json_type 在 PG 模式报错（非热路径）
- pgvector ANN 向量索引未接线（PG 下线性扫描可用）
