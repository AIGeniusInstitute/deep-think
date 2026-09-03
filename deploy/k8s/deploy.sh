#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# DeepThink K8s 一键部署脚本
# 职责：生成 Secret → 配置域名/镜像 → kubectl apply -k → 等待就绪 → 初始化 admin
# 用法：
#   ./deploy/k8s/deploy.sh                          # 交互/默认
#   ./deploy/k8s/deploy.sh --domain deepthink.io \
#       --image registry.cn-hangzhou.aliyuncs.com/ai/deepthink-server:latest \
#       --apikey sk-ant-xxx --pg-password Str0ngPgPass
# 参数：
#   --domain      Ingress 域名（默认 deepthink.example.com）
#   --image       服务镜像（默认 deepthink-server:latest，本机构建）
#   --registry    私有镜像仓库前缀（等同 --image，简写）
#   --apikey      ANTHROPIC_API_KEY（必填，或经 --secret-file 复用既有 Secret）
#   --pg-password PostgreSQL 密码（默认随机生成）
#   --secret-file 复用已存在的自建 Secret 文件（跳过自动生成）
#   --namespace   命名空间（默认 deepthink，与 kustomization 一致）
#   --no-wait     不等待 Pod 就绪
#   --no-admin    跳过 admin 初始化
# 前置：kubectl 已配好集群访问；集群有默认 StorageClass + Ingress controller。
# ──────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
K8S_DIR="$ROOT/deploy/k8s"
NS="${NAMESPACE:-deepthink}"
DOMAIN="deepthink.example.com"
IMAGE="deepthink-server:latest"
APIKEY=""
PG_PASSWORD=""
SECRET_FILE=""
WAIT=1
DO_ADMIN=1

while [ $# -gt 0 ]; do
  case "$1" in
    --domain)      DOMAIN="$2"; shift 2 ;;
    --image)       IMAGE="$2"; shift 2 ;;
    --registry)     IMAGE="$2/deepthink-server:latest"; shift 2 ;;
    --apikey)       APIKEY="$2"; shift 2 ;;
    --pg-password)  PG_PASSWORD="$2"; shift 2 ;;
    --secret-file)  SECRET_FILE="$2"; shift 2 ;;
    --namespace)    NS="$2"; shift 2 ;;
    --no-wait)      WAIT=0; shift ;;
    --no-admin)     DO_ADMIN=0; shift ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

g() { printf '\033[32m%s\033[0m\n' "$*"; }
y() { printf '\033[33m%s\033[0m\n' "$*"; }
b() { printf '\033[36m%s\033[0m\n' "$*"; }
e() { printf '\033[31m%s\033[0m\n' "$*" >&2; }

# ── 前置检查 ─────────────────────────────────────────────────
b "▶ 检查 kubectl 与集群连通性..."
command -v kubectl >/dev/null 2>&1 || { e "❌ 未安装 kubectl"; exit 1; }
kubectl cluster-info >/dev/null 2>&1 || { e "❌ kubectl 无法连接集群（检查 kubeconfig）"; exit 1; }
g "✅ 集群连通"

# ── 1. 生成/复用 Secret ─────────────────────────────────────
b "▶ [1/4] 处理 Secret..."
SECRET_APPLIED="$NS/deepthink-secret"
if [ -n "$SECRET_FILE" ]; then
  b "   使用自建 Secret 文件：$SECRET_FILE"
  kubectl apply -f "$SECRET_FILE"
elif kubectl -n "$NS" get secret deepthink-secret >/dev/null 2>&1; then
  y "   Secret deepthink-secret 已存在，复用（如需更新先 kubectl -n $NS delete secret deepthink-secret）"
else
  [ -z "$APIKEY" ] && { e "❌ 请通过 --apikey 提供 ANTHROPIC_API_KEY，或用 --secret-file 指定既有 Secret 文件"; exit 1; }
  [ -z "$PG_PASSWORD" ] && PG_PASSWORD="$(openssl rand -hex 16)"
  SESSION_SECRET="$(openssl rand -hex 32)"
  DATABASE_URL="postgresql://deepthink:${PG_PASSWORD}@postgres:5432/deepthink"
  kubectl -n "$NS" create secret generic deepthink-secret \
    --from-literal=WEB_SESSION_SECRET="$SESSION_SECRET" \
    --from-literal=ANTHROPIC_API_KEY="$APIKEY" \
    --from-literal=PG_USER=deepthink \
    --from-literal=PG_PASSWORD="$PG_PASSWORD" \
    --from-literal=DATABASE_URL="$DATABASE_URL" \
    --dry-run=client -o yaml | kubectl apply -f -
  g "   ✅ Secret 已生成（PG 密码已随机生成，如需固定下次用 --pg-password）"
fi

# ── 2. 配置域名 + 镜像 ──────────────────────────────────────
b "▶ [2/4] 配置 Ingress 域名 ($DOMAIN) 与镜像 ($IMAGE)..."
INGRESS_TMP="$(mktemp)"
cp "$K8S_DIR/ingress.yaml" "$INGRESS_TMP"
sed -i "s|deepthink.example.com|$DOMAIN|g" "$INGRESS_TMP"

# 临时覆盖：用 kustomize 的 patches 思路，但为零依赖改用 sed 生效到 deployment
# （不修改仓库源文件，只在本次 apply 生效）
DEPLOY_TMP="$(mktemp)"
cp "$K8S_DIR/deployment.yaml" "$DEPLOY_TMP"
if [ "$IMAGE" != "deepthink-server:latest" ]; then
  sed -i "s|deepthink-server:latest|$IMAGE|g" "$DEPLOY_TMP"
fi

# 用临时目录组织 apply，保持 kustomization 其余资源不变
TMP_K="$(mktemp -d)"
cp "$K8S_DIR"/*.yaml "$TMP_K/"
cp "$INGRESS_TMP" "$TMP_K/ingress.yaml"
cp "$DEPLOY_TMP" "$TMP_K/deployment.yaml"
# secret.yaml.example 不能 apply，移除（真实 Secret 已在步骤1创建）
rm -f "$TMP_K/secret.yaml.example"
# kustomization 引用了 secret.yaml.example，需替换为空（已 apply 过真实 Secret）
sed -i '/secret.yaml.example/d' "$TMP_K/kustomization.yaml"

# ── 3. apply ────────────────────────────────────────────────
b "▶ [3/4] kubectl apply -k ..."
kubectl apply -k "$TMP_K"
rm -rf "$TMP_K" "$INGRESS_TMP" "$DEPLOY_TMP"

# ── 4. 等待就绪 + 初始化 admin ───────────────────────────────
if [ "$WAIT" = "1" ]; then
  b "▶ [4/4] 等待 Pod 就绪（最长 5 分钟）..."
  kubectl -n "$NS" rollout status deployment/deepthink-web --timeout=300s || \
    { e "❌ web-server 未就绪"; kubectl -n "$NS" get pods; exit 1; }
  kubectl -n "$NS" rollout status deployment/deepthink-agent-runner --timeout=300s || \
    y "⚠️  agent-runner 未就绪（非阻塞，可稍后 kubectl rollout status 查看）"
  g "✅ 所有 Deployment 就绪"
fi

if [ "$DO_ADMIN" = "1" ]; then
  b "▶ 初始化管理员账号（默认 admin/88888888，建议登录后立即改密）..."
  POD="$(kubectl -n "$NS" get pod -l app=deepthink -o name | grep deepthink-web | head -1 | sed 's|pod/||')"
  if [ -n "$POD" ]; then
    kubectl -n "$NS" exec "$POD" -- node -e "
      const { createAdmin } = require('./dist/admin-account-cli.js');
    " 2>/dev/null || \
    y "⚠️  自动 admin 初始化失败，请通过端口转发访问 Web UI 走 Setup 向导：
       kubectl -n $NS port-forward svc/deepthink 8080:9898
       然后浏览器打开 http://localhost:8080"
  fi
fi

echo ""
g "═══════════════════════════════════════════════"
g " ✅ DeepThink K8s 部署完成"
b "   命名空间：$NS"
b "   Ingress 域名：$DOMAIN（需将 DNS A 记录指向 Ingress LB）"
b "   获取 LB 地址：kubectl -n $NS get ingress"
b "   端口转发（域名未生效前）：kubectl -n $NS port-forward svc/deepthink 8080:9898"
b "   查看状态：kubectl -n $NS get pods,svc,hpa"
b "   查看日志：kubectl -n $NS logs -l app=deepthink --tail=50"
b "   扩缩容：kubectl -n $NS scale deployment/deepthink-web --replicas=N"
g "═══════════════════════════════════════════════"
