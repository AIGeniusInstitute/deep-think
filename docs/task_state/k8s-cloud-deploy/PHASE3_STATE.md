# 任务状态: Phase 3 云端生产化改造

> 创建: 2026-09-04 | 最后更新: 2026-09-04

## 当前状态: ✅ 代码完成,tsc + smoke 102/102 通过;真实云集群端到端验证进行中

## 交付项(6 项,原 PRD 标"Phase 3 未来")

| # | 项 | 状态 | 实现要点 |
|---|---|---|---|
| 27 | PG 完整迁移(真实 PG 验证) | 🟡脚手架齐全 | sqlite-compat PG 后端 + pg-sync-driver 同步桥 + sql-translator(基础)。initDatabase 已在 PG 启动(83400ce 修 4 缺口)。全量查询验证进行中 |
| 28 | sqlite-vec → pgvector | ✅ | `db.ts` initKbSearchIndexesPg:`CREATE EXTENSION vector` + `kb_documents_vec vector(1536)` + HNSW `vector_cosine_ops`;updateDocEmbedding PG 分支 `?::vector`+ON CONFLICT;vectorSearchViaPgvector(`<=>` KNN,退化线性) |
| 29 | FTS5 → PG 全文索引 | ✅(pg_trgm) | `initKbSearchIndexesPg`:`pg_trgm` + 2 GIN 索引;searchKbDocuments PG 分支 ILIKE+LEFT(content,200)(83400ce)。注:用 pg_trgm 而非 tsvector,语义贴近 SQLite LIKE |
| 30 | MinIO/S3 对象存储 | ✅ | `src/object-store.ts` 插件式 fs/s3 后端(trace-io)。动态 import @aws-sdk/client-s3(variable name,tsc 不解析)。chat-trace 读写两端经 object-store,ref 对称(fs 绝对路径 / `s3://bucket/key`) |
| 31 | Litestream WAL 实时备份 | ✅ | `deploy/k8s/overlays/with-litestream/`:ConfigMap + backup PVC + sidecar patch(strategic merge)。默认本地 /backup 副本,可切 S3(env 注入)。仅 SQLite 模式 |
| 32 | 多集群灾备 | ✅ | `deploy/k8s/velero-schedule.yaml`(每日全备+每时增量,含 PV 快照,PG pre-hook pg_dump)+ `docs/tech_solution/k8s-cloud-deploy/DR_RUNBOOK.md`(RPO/RTO 表+4 级恢复步骤+跨集群故障转移+巡检告警) |

## 代码改动清单

### 新文件
| 文件 | 功能 |
|---|---|
| `src/object-store.ts` | 插件式大文件存储(fs/s3),trace-io 落盘抽象 |
| `deploy/k8s/overlays/with-litestream/` | Litestream sidecar overlay(4 文件) |
| `deploy/k8s/velero-schedule.yaml` | Velero 灾备调度 |
| `docs/tech_solution/k8s-cloud-deploy/DR_RUNBOOK.md` | 灾备恢复手册 |

### 修改文件
| 文件 | 改动 |
|---|---|
| `src/db.ts` | pgvector ANN(HNSW + `vector(1536)` + `<=>` KNN + updateDocEmbedding PG 分支) |
| `src/chat-trace-persist.ts` | offloadLargeIo 改走 object-store(putTraceIo) |
| `src/routes/chat-trace.ts` | 读端改走 object-store(getTraceIo),保留 fs 路径穿越守卫 |
| `package.json` | 加 optionalDependencies:@aws-sdk/client-s3 / redis / pg(修复幽灵依赖) |
| `deploy/docker/Dockerfile.server` | Stage 1 加 python3/make/g++(node-pty 编译)、npm ci→install 兼容(后恢复 ci 靠 lockfile 拷入)、lockfile 由构建上下文提供 |

## 验证

| 项 | 结果 |
|---|---|
| 后端 tsc --noEmit | ✅ exit 0 |
| make test-smoke | ✅ 9 files / 102 tests |
| 向后兼容(fs 模式,无 OBJECT_STORE_PROVIDER) | ✅ object-store 默认 fs,行为同旧 |
| Docker 镜像构建 | 🔄 --no-cache 重建中(前次因幽灵依赖 redis/pg + 构建缓存失败,已修) |

## 待办

- [ ] Docker 镜像构建完成确认
- [ ] C: kind `kubectl apply -k` 端到端验证(Pod Running→登录→发消息→删 Pod→数据存活)
- [ ] item 27 深化:真实 PG 跑核心查询路径,定位并修复 sql-translator 未覆盖的 SQLite 模式(strftime / INSERT OR REPLACE 等)
- [ ] kind 上启用 Redis 验证 A(并发计数器)跨 Pod 生效
