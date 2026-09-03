#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# DeepThink Docker 一键部署脚本（单机容器化，最简生产部署）
# 职责：生成密钥 → 构建镜像 → compose up → 等待健康 → 输出访问信息
# 用法：
#   ./deploy/docker/deploy.sh                    # 默认 9999 端口
#   ./deploy/docker/deploy.sh --port 8080 --apikey sk-ant-xxx
# 参数：
#   --port        宿主机映射端口（默认 9999）
#   --apikey      ANTHROPIC_API_KEY（不提供则首次走 Web Setup 向导录入）
#   --no-build    复用已有镜像不重新构建
#   --data-dir    数据持久化宿主路径（默认 docker volume deepthink-data）
# 前置：Docker + docker compose。
# ──────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT/deploy/docker/docker-compose.yml"
PORT=9999
APIKEY=""
NO_BUILD=0
DATA_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --port)     PORT="$2"; shift 2 ;;
    --apikey)   APIKEY="$2"; shift 2 ;;
    --no-build)  NO_BUILD=1; shift ;;
    --data-dir)  DATA_DIR="$2"; shift 2 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

g() { printf '\033[32m%s\033[0m\n' "$*"; }
y() { printf '\033[33m%s\033[0m\n' "$*"; }
b() { printf '\033[36m%s\033[0m\n' "$*"; }
e() { printf '\033[31m%s\033[0m\n' "$*" >&2; }

command -v docker >/dev/null 2>&1 || { e "❌ 未安装 Docker"; exit 1; }
docker info >/dev/null 2>&1 || { e "❌ Docker daemon 未运行"; exit 1; }
g "✅ Docker 可用"

# ── 生成 .env ───────────────────────────────────────────────
ENV_FILE="$ROOT/deploy/docker/.env"
b "▶ 生成 $ENV_FILE ..."
SESSION_SECRET="$(openssl rand -hex 32)"
{
  echo "# DeepThink Docker 部署环境变量（deploy.sh 自动生成，勿提交）"
  echo "WEB_PORT=9898"
  echo "HOST_PORT=$PORT"
  echo "WEB_SESSION_SECRET=$SESSION_SECRET"
  [ -n "$APIKEY" ] && echo "ANTHROPIC_API_KEY=$APIKEY"
  [ -n "$DATA_DIR" ] && echo "# 持久化宿主路径=$DATA_DIR"
} > "$ENV_FILE"

# compose override：用宿主路径替代 named volume（如指定）
OVERRIDE_FILE="$ROOT/deploy/docker/docker-compose.override.yml"
if [ -n "$DATA_DIR" ]; then
  mkdir -p "$DATA_DIR"
  cat > "$OVERRIDE_FILE" <<YAML
services:
  deepthink:
    volumes:
      - $DATA_DIR:/data
YAML
  g "   持久化路径：$DATA_DIR"
else
  rm -f "$OVERRIDE_FILE"
fi

# ── 构建镜像 ─────────────────────────────────────────────────
if [ "$NO_BUILD" = "0" ]; then
  b "▶ 构建镜像（首次约 5-10 分钟）..."
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build
else
  g "✅ --no-build，复用已有镜像"
fi

# ── 启动 ─────────────────────────────────────────────────────
b "▶ 启动容器..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d

# ── 健康检查 ─────────────────────────────────────────────────
b "▶ 等待健康检查通过（最长 60s）..."
for i in $(seq 1 30); do
  if curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; then
    g "✅ 服务健康（第 ${i}*2 秒）"
    break
  fi
  sleep 2
done

echo ""
g "═══════════════════════════════════════════════"
g " ✅ DeepThink Docker 部署完成"
b "   Web UI：http://localhost:$PORT"
if [ -z "$APIKEY" ]; then
  b "   首次访问走 Setup 向导录入 API Key"
else
  b "   管理员：admin / 88888888（建议登录后立即改密）"
fi
b "   日志：docker compose -f $COMPOSE_FILE logs -f"
b "   停止：docker compose -f $COMPOSE_FILE down"
b "   备份：见 docs/ops/runbook.md §备份与恢复"
g "═══════════════════════════════════════════════"
