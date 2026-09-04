# 技术方案: K8s 云端部署 PG 兼容性补全（Phase 2.5）

> 版本: 1.0 | 创建: 2026-09-04

## 1. 架构定位

```
sqlite-compat.ts ──isPostgresBackend──┐
                                      ▼
db.ts initDatabase()
  ├─ sqlite-vec load    ── if(!PG) ── SQLite: vec0 虚拟表；PG: 跳过（线性扫描）
  ├─ schema db.exec(...)  ── 全表 DDL，经 sql-translator 翻译（PG）/ 原样（SQLite）
  ├─ initKbSearchIndexes  ── PG → pg_trgm + GIN；SQLite → FTS5 虚拟表 + 触发器
  └─ searchKbDocuments() ── PG → ILIKE 分支；SQLite → fts5 MATCH/snippet/bm25
```

核心设计：**后端分支标志 `isPostgresBackend` 由 `sqlite-compat.ts` 计算并导出**，db.ts
按标志在三个 SQLite 专有特性点（FTS5、sqlite-vec、全文搜索查询）做分支，其余 401 函数
继续经 pg-sync-driver + sql-translator 透明复用。

## 2. 改动清单

### 2.1 `src/sqlite-compat.ts`
```diff
 const usePostgres = DATABASE_URL.startsWith('postgresql://') || ...;
+/** True when running on the PostgreSQL sync-driver backend (multi-pod cloud mode). */
+export const isPostgresBackend = usePostgres && !isBun;
```
选型：模块加载时即确定，导出常量供 db.ts 单次读取，零运行时开销；`!isBun` 排除 Bun 自带
sqlite 的情况（Bun 不走 PG 桥）。

### 2.2 `src/db.ts` — 导入标志
```diff
-import Database from './sqlite-compat.js';
+import Database, { isPostgresBackend } from './sqlite-compat.js';
```

### 2.3 `src/db.ts` — 从主 schema 块移除 FTS5 DDL
将 `CREATE VIRTUAL TABLE kb_documents_fts USING fts5(...)` 与 3 个触发器从大 `db.exec`
块中抽出，主 schema 只留 `kb_documents` 表 + `idx_kb_docs_kb` 索引。理由：FTS5 DDL 与
SQLite 触发器内联体在 PG 是非法语法，混在大块里会让整个 exec 失败、掩盖后续表创建。

### 2.4 `src/db.ts` — 后端分支的 KB 搜索索引
schema 块之后：
```typescript
if (isPostgresBackend) {
  initKbSearchIndexesPg();
} else {
  initKbSearchIndexesSqlite();   // 原样搬移的 FTS5 DDL + 触发器
}
```

`initKbSearchIndexesPg()`：
```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_kb_docs_content_trgm ON kb_documents USING gin (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_kb_docs_filename_trgm ON kb_documents USING gin (filename gin_trgm_ops);
```
- `CREATE EXTENSION` 包 try/catch：managed PG（RDS/CloudSQL）无超管权限时 warn 降级为
  seq scan，不崩。
- GIN trgm 索引让 `ILIKE '%q%'` 走 trigram 扫描而非全表，性能可接受。
- 选型 pg_trgm 而非 tsvector：pg_trgm 的 `ILIKE` 语义最接近原 FTS5 子串匹配，迁移成本
  最低；tsvector 需维护 tsvector 列 + 触发器，改动大，违背 Simplicity First。

### 2.5 `src/db.ts` — sqlite-vec 加载守卫
```diff
-if (!isPostgresBackend) {
 try { sqliteVec.load(db); ... } catch { vecExtensionLoaded = false; }
+} else {
+  vecExtensionLoaded = false;
+  logger.info('PostgreSQL backend — sqlite-vec skipped, vector search uses linear scan');
+}
```
PG 模式不再尝试 `loadExtension`（PgDatabase 无此方法），消除噪声 warn；向量搜索已有
`vecExtensionLoaded ? vectorSearchViaVec : linear` 分支，PG 下线性扫描即可用。

### 2.6 `src/db.ts` — searchKbDocuments PG 分支
```typescript
if (isPostgresBackend) {
  const like = `%${sanitized}%`;
  return db.prepare(
    `SELECT id as doc_id, kb_id, filename, LEFT(content, 200) as snippet, 0.5 as rank
     FROM kb_documents
     WHERE kb_id IN (${placeholders})
       AND (content ILIKE ? OR filename ILIKE ?)
     ORDER BY rank LIMIT ?`,
  ).all(...kbIds, like, like, limit);
}
// SQLite 原路径（fts5 MATCH/snippet/bm25）保持不变
```
- `LEFT(content,200)` 替代 `snippet()`（PG 无 snippet）；`0.5` 占位 rank（PG 无 bm25）。
- 占位符顺序：kbIds → like → like → limit，与 `.all(...kbIds, like, like, limit)` 对齐。
- `ILIKE` 经 sql-translator 时 `\bLIKE\b` 不匹配（ILIKE 内 LIKE 前为 word char I），
  不被二次转换。

## 3. 已知限制（非本阶段范围）

- **token_usage 分析查询**（28 处 `json_extract/json_each/json_type`）：PG 不识别，这些
  dashboard 端点在 PG 模式会报错。核心对话/Agent/记忆热路径不受影响（JSON 列以文本存取）。
  留待后续 Phase 用 PG 原生 `jsonb` 重写分析查询。
- **pgvector 向量索引**：postgres.yaml 已用 `pgvector/pgvector:pg16` 镜像，但代码端未接
  `<->` 距离查询；向量搜索 PG 下走线性扫描，可用但非 ANN。后续 Phase 接线。

## 4. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 分支逻辑破坏 SQLite 默认行为 | 111 项 smoke 测试回归全通过；FTS5 DDL 原样搬移不改一个字符 |
| pg_trgm 扩展在 managed PG 不可用 | `CREATE EXTENSION` 包 try/catch，warn 降级 seq scan |
| PG 搜索 rank 语义与 bm25 不一致 | 已在 PRD 标注为功能性降级，非精确排序；后续可接 ts_rank |
