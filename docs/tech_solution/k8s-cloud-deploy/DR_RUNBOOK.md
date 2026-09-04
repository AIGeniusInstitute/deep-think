# DeepThink 灾备与多集群恢复 Runbook (DR)

> 适用于 K8s 云端生产部署。定义 RPO/RTO、备份分层、恢复步骤、跨集群故障转移。

## 1. 备份分层架构

| 层 | 工具 | 频率 | RPO | 用途 |
|---|---|---|---|---|
| L1 实时 WAL | Litestream sidecar | 秒级(1s) | ~1s | SQLite 模式下 messages.db 秒级恢复(单 PVC 故障) |
| L2 数据库逻辑备份 | Backup CronJob | 每日 03:00 | 24h | PG `pg_dump` / SQLite `.backup`(对象存储/backup PVC) |
| L3 集群元数据+PV 快照 | Velero Schedule | 每日 03:17 + 每时 :23 | 1h(元数据)/24h(PV) | 全命名空间恢复(灾备集群) |
| L4 跨集群 | 共享对象存储 | 同 L2/L3 | — | 主集群全毁时,灾备集群从对象存储恢复 |

**冗余原则**:任一层失效,下层兜底。Litestream 防 PVC 故障;CronJob 防 PG 损坏;Velero 防命名空间/集群级灾难。

## 2. RPO / RTO 目标

| 场景 | RPO | RTO |
|---|---|---|
| 单 Pod 崩溃(数据在 PVC) | 0(数据持久) | < 30s(K8s 重启) |
| 单 PVC 损坏(SQLite 模式) | ~1s(Litestream) | < 5min(restore + 重启) |
| PG 数据损坏 | 24h(pg_dump) | < 15min(恢复 dump) |
| 命名空间误删 | 1h(Velero 元数据)/24h(PV) | < 30min(velero restore) |
| 主集群全毁 | 24h(跨集群对象存储) | < 2h(灾备集群拉起) |

## 3. 前置条件(集群级,不在本仓库清单内)

- **Velero operator** 已安装:`velero install --provider aws --bucket <bucket> --backup-location-config region=...`
- **BackupStorageLocation** 指向 S3/MinIO(主灾备集群共享同一 bucket)
- **VolumeSnapshotLocation** 配置(CRUD 快照)
- **存储类**支持 snapshot(如 CSI driver)
- **Litestream overlay**(可选,SQLite 模式):`kubectl apply -k deploy/k8s/overlays/with-litestream/`

## 4. 恢复步骤

### 4.1 Pod 崩溃(数据在 PVC,PVC 完好)
K8s 自动重启 Pod,无需人工介入。验证:
```bash
kubectl -n deepthink rollout status deployment/deepthink-web
kubectl -n deepthink port-forward svc/deepthink 8080:9898
curl localhost:8080/health   # {"status":"ok"}
```

### 4.2 PG 数据损坏(从 pg_dump 恢复)
```bash
# 1. 找最近备份
kubectl -n deepthink create job --from=cronjob/deepthink-backup manual-backup
kubectl -n deepthink logs job/manual-backup   # 确认 dump 落盘
# 2. 恢复(PG 模式)
kubectl -n deepthink cp <backup-pod>:/data/backups/pg-<ts>.sql.gz /tmp/restore.sql.gz
gunzip /tmp/restore.sql.gz
kubectl -n deepthink exec -i postgres-0 -- psql -U deepthink deepthink < /tmp/restore.sql
# 3. 重启 web 让连接池重建
kubectl -n deepthink rollout restart deployment/deepthink-web
```

### 4.3 命名空间级恢复(Velero)
```bash
# 列出可用备份
velero backup get
# 从指定备份恢复(灾备集群同样命令,前提 BackupStorageLocation 指同一 bucket)
velero restore create --from-backup deepthink-daily-backup-<ts> --include-namespaces deepthink
velero restore describe <restore-name> --details   # 确认 Completed
```

### 4.4 跨集群故障转移(主集群全毁)
```bash
# 在灾备集群:
# 1. 配置 BackupStorageLocation 指向主集群的备份 bucket
velero backup-location create shared --provider aws --bucket <bucket> --config region=...
# 2. 同步备份元数据(Velero 能读到主集群写入的备份)
velero backup get   # 应能看到主集群的 deepthink-daily-backup-*
# 3. 恢复
velero restore create --from-backup deepthink-daily-backup-<ts> --include-namespaces deepthink
# 4. 切 DNS 到灾备集群 Ingress LB
kubectl -n deepthink get ingress   # 获取灾备 LB 地址,更新 DNS A 记录
```

## 5. 巡检与告警建议

| 巡检项 | 命令 | 频率 | 告警阈值 |
|---|---|---|---|
| Backup CronJob 成功 | `kubectl -n deepthink get jobs -l job-name=deepthink-backup` | 每日 | 连续 2 次失败 |
| Velero 备份成功 | `velero backup get` | 每日 | Phase != Completed |
| Litestream 副本延迟 | sidecar `/metrics`(端口 9090) | 持续 | lag > 5s |
| PVC 使用率 | `kubectl -n deepthink get pvc -o json` | 每日 | > 80% |
| PG 连接数 | `kubectl exec postgres-0 -- psql -c "select count(*) from pg_stat_activity"` | 每时 | > 80% max_connections |

## 6. 演练

每季度执行一次"主集群全毁"演练(4.4 步骤),验证 RTO < 2h。
