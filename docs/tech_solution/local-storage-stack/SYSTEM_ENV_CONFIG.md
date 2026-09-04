# DeepThink 本机持久化存储栈 — 系统环境配置说明

> 部署日期：2026-09-05 ｜ 端口：Web=9999 ｜ PG=5432 ｜ Redis=6380 ｜ MinIO=9000/9001

## 1. 架构总览

DeepThink 在本机以「Web 进程 + 三件套存储后端」运行，全部数据持久化，重启不丢：

```
┌──────────────────────────────────────────────────────────────┐
│  本机 node 进程  (~/deepthink/dist/index.js, port 9999)       │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ DeepThink Web App                                      │  │
│  │  - Hono HTTP server + WS                                │  │
│  │  - SQLite 兼容层 → PG 同步桥(pg-sync-driver)           │  │
│  │  - object-store 抽象(fs / s3)                           │  │
│  └─────────┬──────────────┬───────────────────┬────────────┘  │
└────────────┼──────────────┼───────────────────┼──────────────┘
             │ DATABASE_URL  │ REDIS_URL          │ S3_*
   ┌─────────▼─────┐  ┌──────▼──────┐  ┌──────────▼──────────┐
   │ PostgreSQL 16  │  │ Redis 7     │  │ MinIO (S3 兼容)     │
   │ + pgvector     │  │ AOF 持久化  │  │ bucket=deepthink    │
   │ + pg_trgm      │  │ :6380       │  │ :9000 API / :9001   │
   │ :5432          │  │             │  │   Console           │
   │ pg_data volume │  │ redis_data  │  │ minio_data volume   │
   └────────────────┘  └─────────────┘  └─────────────────────┘
```

## 2. 存储后端职责分工

| 后端 | 端口 | 职责 | 持久化 |
|------|------|------|--------|
| **PostgreSQL 16 + pgvector** | 5432 | 关系数据（消息/会话/用户/技能/MCP/路由…全部业务表）、向量检索（pgvector HNSW）、全文检索（pg_trgm GIN） | named volume `pg_data` |
| **Redis 7** | 6380 | 跨进程事件总线（WS 广播）、Agent IPC 通道、分布式 Leader 选举、共享并发计数器 | AOF + named volume `redis_data` |
| **MinIO** | 9000 / 9001 | S3 兼容对象存储，trace-io 大 I/O 落盘（对话 trace、产物 ref） | named volume `minio_data` |

### 2.1 为什么不需要独立的 Milvus / Elasticsearch

用户最初要求启用 Milvus 和 ES。经代码核查（`grep -ri milvus|elasticsearch src/` 零命中，`package.json` 无依赖），**DeepThink 当前不集成 Milvus / ES**。原因：这两类能力已由 PostgreSQL 内嵌扩展覆盖，独立引入会增加运维复杂度而无功能增益：

| 能力 | 独立方案 | DeepThink 实际方案 | 理由 |
|------|----------|-------------------|------|
| 向量检索 | Milvus | **pgvector**（PG 扩展，HNSW 索引，`<=>` 余弦 KNN） | 向量数据与业务数据同库，避免双写一致性问题；73 表里 `kb_documents_vec vector(1536)` 已就绪 |
| 全文检索 | Elasticsearch | **pg_trgm**（PG 扩展，GIN 索引，`ILIKE` 模糊匹配） | 知识库检索量级在 PG 单机承受范围；避免额外 ES 集群 |

> 如未来确需独立 Milvus/ES（例如向量库过亿级、全文检索高并发），再单独立项：加容器 + 写 embeddings/搜索 client + 改 `object-store.ts`/`searchKbDocuments` 分支。

## 3. .env 配置文件

文件位置：`deploy/local/.env.local-storage`

```bash
# --- 应用 ---
WEB_PORT=9999
WEB_SESSION_SECRET=local-dev-session-secret-change-me
TZ=Asia/Shanghai
NODE_ENV=production
LOG_LEVEL=info
TRUST_PROXY=false
MAX_FILE_SIZE_MB=50
DEEPTHINK_DATA_DIR=/home/me/deepthink/data-local
DATA_DIR=/home/me/deepthink/data-local

# --- PostgreSQL(关系数据 + 向量 + 全文) ---
DATABASE_URL=postgresql://deepthink:deepthink123@127.0.0.1:5432/deepthink

# --- Redis(事件总线 / IPC / 选主 / 并发计数) ---
REDIS_URL=redis://127.0.0.1:6380

# --- MinIO / S3 对象存储(trace-io 大 I/O 落盘) ---
OBJECT_STORE_PROVIDER=s3
S3_ENDPOINT=http://127.0.0.1:9000
S3_BUCKET=deepthink
S3_REGION=us-east-1
S3_FORCE_PATH_STYLE=true
S3_ACCESS_KEY_ID=deepthink
S3_SECRET_ACCESS_KEY=deepthink123

# --- LLM / 工具(按需) ---
# ANTHROPIC_API_KEY=
# ANTHROPIC_BASE_URL=
# ZHIPU_API_KEY=
```

### 3.1 环境变量语义速查

| 变量 | 作用 | 不设的后果 |
|------|------|-----------|
| `DATABASE_URL` | PG 连接串；设置即启用 PG 模式（sqlite-compat 三后端选择） | 走 SQLite 本地文件（单进程，不可水平扩） |
| `REDIS_URL` | Redis 连接串；启用事件总线/选主/IPC | 单进程模式（no-op 降级，无跨进程广播） |
| `OBJECT_STORE_PROVIDER` | `fs`（本地文件）/ `s3`（MinIO/S3） | 默认 `fs`，trace-io 落 `DATA_DIR` |
| `S3_ENDPOINT` | MinIO/S3 端点（`s3` 模式必填） | `isS3Enabled=false`，回退 `fs` |
| `S3_FORCE_PATH_STYLE` | MinIO 必须 `true`（path-style） | 默认 true，无需动 |
| `DATA_DIR` / `DEEPTHINK_DATA_DIR` | 本地文件兜底目录（groups/ipc/config/db） | 默认 `process.cwd()`（重启随 cwd 漂移） |

## 4. 启动 / 停止

### 4.1 启动存储栈

```bash
cd ~/deepthink
docker compose -f deploy/local/docker-compose.yml up -d
# 等 healthy（pgvector 扩展 + minio bucket 自动初始化）
docker compose -f deploy/local/docker-compose.yml ps
```

### 4.2 构建 + 启动 Web 应用

```bash
cd ~/deepthink
npm run build                          # tsc → dist/
set -a && . deploy/local/.env.local-storage && set +a
nohup node dist/index.js > logs/local-storage-server.log 2>&1 &
disown
```

### 4.3 验证

```bash
curl http://127.0.0.1:9999/health      # {"status":"ok"}
curl http://127.0.0.1:9999/ready       # {"status":"ready"}
# 首次启动 setup admin（fresh PG 库无用户）
curl -X POST http://127.0.0.1:9999/api/auth/setup \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"88888888"}'
# 登录
curl -X POST http://127.0.0.1:9999/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"88888888"}'
# 查 PG
docker exec deepthink-pg psql -U deepthink -d deepthink \
  -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"  # 73
```

### 4.4 停止

```bash
pkill -f "deepthink/dist/index.js"                  # 停 Web
docker compose -f deploy/local/docker-compose.yml down   # 停存储栈（volume 保留）
docker compose -f deploy/local/docker-compose.yml down -v  # 连数据一起删（谨慎）
```

## 5. 数据持久化保证

| 数据类别 | 落盘位置 | 重启容器是否丢 |
|---------|---------|--------------|
| 业务关系数据（消息/会话/用户/技能…） | PG `pg_data` volume | 不丢 |
| 向量（知识库 embedding） | PG `kb_documents_vec` + HNSW | 不丢 |
| 对话 trace 大 I/O | MinIO `deepthink` bucket / `minio_data` | 不丢 |
| 事件总线/IPC 消息 | Redis `redis_data`（AOF） | 持久部分不丢（非持久 pub/sub 语义） |
| 本地兜底文件（groups/ipc/config） | `DATA_DIR=/home/me/deepthink/data-local` | 不丢（主机目录） |

## 6. 关键实现点（供二次开发参考）

- **SQLite→PG 同步桥**：`src/pg-sync-driver.ts` 用 worker_threads + Atomics.wait/notify + receiveMessageOnPort，保持 better-sqlite3 同步 API，让 401 个 db.ts 函数零改写。
- **SQL 方言翻译**：`src/sql-translator.ts` 运行时翻译——`?→$1`、`datetime('now')→NOW()`、`BLOB→BYTEA`、`REAL→DOUBLE PRECISION`、`INTEGER PRIMARY KEY→BIGSERIAL`、`INTEGER→BIGINT`（**ms 时间戳必须 BIGINT，PG integer 4 字节会溢出 22003**）、`INSERT OR IGNORE/REPLACE→ON CONFLICT DO NOTHING`、`PRAGMA table_info→information_schema`、`sqlite_master→pg_indexes`。
- **PG fresh 库**：建表后提前写 `schema_version=59`，跳过 v15/17/24/27/28 等版本门控迁移（规避 json_extract 等 SQLite 专有函数）。
- **对象存储对称**：`src/object-store.ts` 写端返回 `s3://bucket/key` ref，读端按 ref 解析，fs/s3 双后端对称。

## 7. 已知限制

| 项 | 说明 |
|----|------|
| 28 处 `json_extract` 运行时查询 | token_usage 分析路径，PG 报错（非启动阻塞，非热路径） |
| 多副本 init 竞态 | 本机单进程不涉及；多副本需加 init Job |
| secret 弱密码 | `deepthink123` 仅本机演示，生产必换强密码 + Secret 管理 |
| Milvus / ES 未集成 | 见 §2.1，pgvector + pg_trgm 已覆盖 |

## 8. 验收记录（2026-09-05）

- Web 进程：pid 1458027，端口 9999 LISTEN，日志无 ERROR、无 22003
- `/health` 200、`/ready` 200
- setup admin：success，admin 写入 PG
- login：success，`last_login_at` 写回 PG（读写双向持久化）
- PG：73 表，`autonomy_capabilities.updated_at/last_event_at` = `bigint`
- Redis：6380 PONG，事件总线 connected
- MinIO：bucket `deepthink` 就绪，S3 health 200
