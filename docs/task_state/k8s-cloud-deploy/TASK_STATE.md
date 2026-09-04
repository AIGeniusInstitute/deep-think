# 任务状态: K8s 云端部署与数据持久化改造

> 创建: 2026-09-02 | 最后更新: 2026-09-04
> ⚠️ 本文档曾滞后（仅反映 Phase 1），已于 2026-09-04 校准至 main 实际状态。
> Phase 2-4 均已合并 main，详见各阶段 PRD/技术方案/测试报告。

## 当前状态: ✅ Phase 1-4 全部交付并合并 main

## 阶段交付总览

| 阶段 | 内容 | 合并 commit | 文档 |
|---|---|---|---|
| Phase 1 | 单副本可部署：/health /ready、SIGTERM 优雅关闭、Dockerfile.Server、13 个 K8s 清单、HPA | cd5abc7 | PRD/TECH 本目录 |
| Phase 2 | 真正横向多 Pod 无状态化：Redis 事件总线 + 分布式选主 + PG 同步驱动 + SQL 翻译器 + 三后端选择 | 21530d2 | `docs/{prd,tech_solution,task_state,test_report}/full-horizontal-scaling/` |
| 数据层 | PG/Redis K8s 部署（pgvector:pg16）+ SQLite→PG 迁移脚本 | 21530d2 | 同上 |
| Phase 4 | Agent IPC Redis 消息驱动 + agent-runner 独立 Deployment + 主机端 Redis 桥接 + mcp-bridge 走 Redis + Web 订阅 ipc-out + Runner 长驻循环 | c52bdd8 + c77ae9a | `docs/test_report/{agent-ipc-redis,ipc-remaining}/` |
| 缺口修复 1 | trace-io 落盘对齐 PVC / agent-runner 挂共享 PVC / LPUSH-BRPOP 单投递 / 备份 CronJob 分支化 | a6108ad | `docs/issues/2026-09-03-k8s-deploy-data-persistence-gaps.md` |
| 缺口修复 2 | trace 读取端守卫 / 备份换 postgres 镜像 / 多租户 per-user global+owner-home memory payload | b4e88b4 | `docs/issues/2026-09-03-k8s-persistence-gaps-followup.md` |
| 运维工具链 | 一键部署 deploy.sh + 桌面打包配置完善 | ec720f8 | — |

## 现状审查结论（2026-09-04 代码级核查，32 项）

26 项 ✅ 已实现，3 项 🟡 真实小缺陷（本次修），6 项 ❌ Phase 3 延期项（原 PRD 标注"未来"）。详见审计报告（会话内）。

### 本次（2026-09-04）修复的小缺陷

| 缺陷 | 修复 | 验证 |
|---|---|---|
| closePgSyncDriver 未在 shutdown 调用 → PG worker_thread 靠 OS 回收 | `src/index.ts` shutdown handler 在 closeDatabase 后调用 closePgSyncDriver | 待 tsc + /health 验证 |
| TASK_STATE.md 滞后（仍写 Phase 1 完成） | 本文件校准至 Phase 1-4 全交付 | 本文件 |
| 共享并发计数器 incrCounter/decrCounter 未接线（多 Pod 计费并发上限失效） | ⏳ 需设计确认，不擅改并发/计费关键代码 | 见下方"待确认 A" |

## 待确认事项（需用户决策，不擅自启动）

### A. 共享并发计数器接线（Phase 2 收尾）
- 现状：`redis-bus.ts:236-264` 的 `incrCounter/decrCounter` 全代码库无调用方。
- 影响：用户级计费并发上限（`index.ts:11666` userConcurrentLimitFn）用进程内 `hasDirectActiveRunner` 计数，多 Pod 分布式下少算 → 用户跨 Pod 突破计费并发上限。
- 设计选项：① userConcurrentLimitFn 改 async（ripple through sync enqueue，改动面大）；② registerProcess/release 处维护 Redis 计数 + 本地缓存供 sync 检查器读；③ 下沉到 agent-runner 侧 BLPOP 前限流。
- 需用户确认采用哪种。

### B. Phase 3 大项（原 PRD 明确"未来"，6 项均未实现）
| # | 项 | 工作量 | 说明 |
|---|---|---|---|
| 27 | PG 完整迁移（db.ts 11636 行在真实 PG 验证） | 多日 | 翻译器不完整（strftime/INSERT OR REPLACE/FTS5/vec0 四类） |
| 28 | sqlite-vec → pgvector | 中 | 需 db.ts 加 PG 分支 `CREATE EXTENSION vector` + `vector(1536)` |
| 29 | FTS5 → PG 全文索引（tsvector/pg_trgm） | 中 | 需 PG 分支 + 混合检索重写 |
| 30 | MinIO/S3 对象存储（trace-io/downloads） | 中 | 需对象存储抽象层 |
| 31 | Litestream WAL 实时备份 | 小 | 仅配置，无代码 |
| 32 | 多集群灾备（Velero/跨集群同步） | 大 | 需运维方案 |
- 需用户确认优先级与范围。

## 历史测试结果（均已通过）

| 用例 | 结果 | 证据 |
|---|---|---|
| Phase 1：健康检查/优雅关闭/PVC 持久化/tsc | ✅ | curl 200、exit 0、Marker 存活 |
| Phase 2：Redis pub/sub 广播 + SET NX 选主 + PG 3 Pod 并发 600 行零丢失 | ✅ | kind 集群 deepthink-test 三大验证 |
| Phase 4：tsc + smoke 102 项 + 向后兼容零回归 | ✅ | `docs/test_report/ipc-remaining/` |
| K8s UI 自动化 26 项 | ✅ | `docs/test_report/k8s-cloud-deploy/TEST_REPORT.html` |

## 待办（未来 / 需确认后启动）

- [ ] A. 共享并发计数器接线（需设计确认）
- [ ] B. Phase 3 六项（需用户确认优先级）
- [ ] 真实云集群端到端验证（当前仅 kind + 单进程 UI 冒烟，未做 `kubectl apply -k` 全链路）
