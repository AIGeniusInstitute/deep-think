# DeepThink K8s 部署指南

## 前置条件

1. K8s 集群(1.24+)
2. nginx-ingress controller(或兼容的 Ingress controller)
3. 默认 StorageClass(支持动态 PVC 供应)
4. `kubectl` 已配置好集群访问

## 快速部署

### 1. 构建镜像

```bash
# 在仓库根目录构建
docker build -t deepthink-server:latest -f deploy/docker/Dockerfile.server .

# 推送到你的镜像仓库(如果是远程集群)
docker tag deepthink-server:latest <registry>/deepthink-server:latest
docker push <registry>/deepthink-server:latest
```

### 2. 创建 Secret

```bash
cp deploy/k8s/secret.yaml.example deploy/k8s/deepthink-secret.yaml
# 编辑 deepthink-secret.yaml，填入真实密钥
kubectl apply -f deploy/k8s/deepthink-secret.yaml
```

### 3. 修改域名和镜像

```bash
# 修改 Ingress 中的 host
sed -i 's/deepthink.example.com/your-domain.com/' deploy/k8s/ingress.yaml

# 如使用私有镜像仓库，修改 Kustomize
cd deploy/k8s
kustomize edit set image deepthink-server=<registry>/deepthink-server:latest
```

### 4. 部署

```bash
# 方式 A: Kustomize (推荐)
kubectl apply -k deploy/k8s/

# 方式 B: 直接应用各文件
kubectl apply -f deploy/k8s/namespace.yaml
kubectl apply -f deploy/k8s/configmap.yaml
kubectl apply -f deploy/k8s/deepthink-secret.yaml
kubectl apply -f deploy/k8s/pvc.yaml
kubectl apply -f deploy/k8s/deployment.yaml
kubectl apply -f deploy/k8s/service.yaml
kubectl apply -f deploy/k8s/ingress.yaml
kubectl apply -f deploy/k8s/hpa.yaml
kubectl apply -f deploy/k8s/backup-cronjob.yaml
```

### 5. 验证部署

```bash
# 查看 Pod 状态
kubectl -n deepthink get pods -w

# 等待 Running + Ready
kubectl -n deepthink wait --for=condition=ready pod -l app.kubernetes.io/name=deepthink --timeout=120s

# 测试健康检查
kubectl -n deepthink port-forward svc/deepthink 9999:9898
curl http://localhost:9999/health   # → {"status":"ok"}
curl http://localhost:9999/ready    # → {"status":"ready"}

# 查看 Ingress
kubectl -n deepthink get ingress
```

### 6. 初始化管理员

首次部署后需要创建管理员账号:

```bash
kubectl -n deepthink exec -it deploy/deepthink -- node -e "
  // 使用 reset-admin 或 admin-account-cli
  require('./dist/reset-admin.js');
"
```

或通过 Web UI 在 `https://your-domain.com/login` 首次登录(默认 admin / 88888888,建议立即改密)。

## 数据持久化验证

```bash
# 写入测试数据
kubectl -n deepthink exec deploy/deepthink -- ls /data/db/

# 删除 Pod 重建
kubectl -n deepthink delete pod -l app.kubernetes.io/name=deepthink

# 等待新 Pod 启动后检查数据是否还在
kubectl -n deepthink exec deploy/deepthink -- ls /data/db/
```

## 扩缩容

### Phase 1 (当前): 单副本

```bash
# 手动垂直扩容(增加资源)
kubectl -n deepthink patch deploy deepthink -p '{
  "spec": {"template": {"spec": {"containers": [{"name":"deepthink","resources":{"limits":{"cpu":"8000m","memory":"8Gi"}}}]}}}}'
```

### Phase 2: 多副本水平扩容

需要先完成 PostgreSQL 迁移和 Redis 集成:

```bash
# 1. 配置 PostgreSQL + Redis
# 2. 修改 PVC 为 ReadWriteMany (NFS/CephFS)
# 3. 修改 Deployment:
kubectl -n deepthink patch deploy deepthink -p '{"spec":{"strategy":{"type":"RollingUpdate"},"replicas":2}}'
# 4. 修改 HPA:
kubectl -n deepthink patch hpa deepthink -p '{"spec":{"minReplicas":2,"maxReplicas":10}}'
```

## 备份与恢复

### 手动备份

```bash
kubectl -n deepthink exec deploy/deepthink -- node -e "
  const Database = require('better-sqlite3');
  const src = new Database('/data/db/messages.db', { readonly: true });
  src.backup('/data/backups/messages-manual-' + Date.now() + '.db');
  src.close();
"
```

### 自动备份

已配置 CronJob,每天 03:00 自动备份,保留最近 7 份:

```bash
kubectl -n deepthink get cronjob deepthink-backup
kubectl -n deepthink get jobs -n deepthink
```

### 恢复

```bash
# 1. 停止服务
kubectl -n deepthink scale deploy deepthink --replicas=0

# 2. 恢复数据库
kubectl -n deepthink cp messages-backup.db deepthink-xxx:/data/db/messages.db

# 3. 启动服务
kubectl -n deepthink scale deploy deepthink --replicas=1
```

## 监控

```bash
# Pod 资源使用
kubectl -n deepthink top pod

# 日志
kubectl -n deepthink logs -f deploy/deepthink

# 事件
kubectl -n deepthink get events --sort-by='.lastTimestamp'
```

## 故障排查

| 问题 | 诊断 | 解决 |
|---|---|---|
| Pod CrashLoopBackOff | `kubectl logs` | 检查 env/secret 配置 |
| PVC Pending | `kubectl describe pvc` | 检查 StorageClass |
| Ingress 502 | `kubectl describe ingress` | 检查 Service/Pod ready |
| WS 连接断开 | 检查 ingress annotations | 确认 proxy-read-timeout |
| better-sqlite3 报错 | 检查 node 版本 | Dockerfile 用 node:22 |
