#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# DeepThink 一键部署脚本（本地源码模式 / 单机生产）
# 职责：检查前置依赖 → 安装依赖 → 编译 → 初始化数据目录 → 设置 admin → 启动
# 幂等：可安全重复执行，已有产物/依赖会跳过。
# 用法：
#   ./scripts/bootstrap.sh                 # 全量，前台启动
#   ./scripts/bootstrap.sh --prod PORT=9999 # 隔离数据目录后台守护启动
#   ./scripts/bootstrap.sh --no-start       # 只装不启
#   ADMIN_NAME=alice ADMIN_PASS=Str0ng ./scripts/bootstrap.sh
# 环境变量（可选）：
#   ADMIN_NAME / ADMIN_PASS  管理员账号（默认 admin/88888888）
#   WEB_PORT                 端口（默认 9898）
#   DEEPTHINK_DATA_DIR       数据目录（默认 ~/.deepthink/data）
# ──────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── 参数解析 ──────────────────────────────────────────────────
NO_START=0
PROD_DAEMON=0
PORT="${WEB_PORT:-9898}"
DATA_DIR="${DEEPTHINK_DATA_DIR:-$HOME/.deepthink/data}"
ADMIN_NAME="${ADMIN_NAME:-admin}"
ADMIN_PASS="${ADMIN_PASS:-88888888}"

for arg in "$@"; do
  case "$arg" in
    --no-start) NO_START=1 ;;
    --prod)     PROD_DAEMON=1 ;;
    PORT=*)     PORT="${arg#PORT=}" ;;
    *) echo "⚠️  未知参数: $arg" ;;
  esac
done

# ── 颜色 ─────────────────────────────────────────────────────
g() { printf '\033[32m%s\033[0m\n' "$*"; }
y() { printf '\033[33m%s\033[0m\n' "$*"; }
b() { printf '\033[36m%s\033[0m\n' "$*"; }
e() { printf '\033[31m%s\033[0m\n' "$*" >&2; }

# ── 前置依赖检查 ─────────────────────────────────────────────
b "▶ [1/6] 检查前置依赖..."

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    e "❌ 缺少依赖：$1"
    case "$1" in
      node) e "   安装 Node ≥ 20：https://nodejs.org/ 或 nvm install 22" ;;
      npm)  e "   随 Node 一同安装" ;;
      git)  e "   apt install git / brew install git" ;;
    esac
    exit 1
  fi
}
require git
require node
require npm

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then
  e "❌ Node 版本过低（$(node --version)），需 ≥ 20。"
  exit 1
fi
g "✅ Node $(node --version) / npm $(npm --version)"

# 可选：Docker（容器/沙箱模式需要）
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  g "✅ Docker $(docker --version | grep -oE '[0-9.]+' | head -1) 可用"
else
  y "⚠️  Docker 未运行（容器模式/沙箱代码执行/浏览器自动化将不可用，本地 Node 模式不受影响）"
fi

# ── 安装依赖 + 编译 ───────────────────────────────────────────
b "▶ [2/6] 安装依赖并编译（首次约 3-5 分钟，国内走 npmmirror）..."
# 复用 Makefile 的 install target（含 allow-git、agent-runner 编译）
make install

# ── 初始化数据目录 ───────────────────────────────────────────
b "▶ [3/6] 初始化数据目录：$DATA_DIR"
mkdir -p "$DATA_DIR"
# 迁移仓库内旧 ./data（若存在且目标为默认目录）
if [ -d "$ROOT/data" ] && [ -n "$(ls -A "$ROOT/data" 2>/dev/null)" ]; then
  y "⚠️  检测到仓库内旧 ./data，迁移到 $DATA_DIR ..."
  cp -a "$ROOT/data/." "$DATA_DIR/"
  echo "   旧 ./data 保留原位，确认无误后可删除"
fi

# ── 设置管理员账号 ──────────────────────────────────────────
b "▶ [4/6] 设置管理员账号（$ADMIN_NAME）"
# admin-set 幂等：不存在则创建，已存在则改密码并吊销旧会话
DEEPTHINK_DATA_DIR="$DATA_DIR" make admin-set ADMIN_NAME="$ADMIN_NAME" ADMIN_PASS="$ADMIN_PASS" || \
  y "⚠️  admin-set 未成功（可稍后经 Web Setup 向导手动注册）"

# ── 构建容器镜像（可选）──────────────────────────────────────
b "▶ [5/6] 检查容器镜像..."
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  if [ ! -f .docker-build-sentinel ] || ! docker image inspect deepthink-agent:latest >/dev/null 2>&1; then
    y "▶ 构建容器镜像 deepthink-agent（用于 agent 执行环境）..."
    ./container/build.sh || y "⚠️  容器镜像构建失败，agent 容器模式暂不可用（本地 Node 模式不受影响）"
  else
    g "✅ deepthink-agent 镜像已存在"
  fi
  if ! docker image inspect deepthink-sandbox:latest >/dev/null 2>&1; then
    y "▶ 构建沙箱镜像 deepthink-sandbox（代码执行/浏览器自动化）..."
    make sandbox-build || y "⚠️  沙箱镜像构建失败"
  else
    g "✅ deepthink-sandbox 镜像已存在"
  fi
else
  y "⚠️  Docker 未运行，跳过镜像构建（本地 Node 模式仍可完整运行，仅 agent 容器隔离/沙箱不可用）"
fi

# ── 启动 ─────────────────────────────────────────────────────
b "▶ [6/6] 启动服务"
if [ "$NO_START" = "1" ]; then
  g "✅ --no-start 模式，跳过启动。手动启动：make start"
  exit 0
fi

if [ "$PROD_DAEMON" = "1" ]; then
  g "▶ 后台守护模式启动（隔离数据目录 ~/.deepthink-$PORT）..."
  make start-prod PORT="$PORT"
  echo ""
  g "✅ DeepThink 已后台启动"
  b "   Web UI：http://localhost:$PORT"
  b "   管理员：$ADMIN_NAME / $ADMIN_PASS"
  b "   日志：tail -f logs/deepthink-$PORT.log"
  b "   停止：make stop-prod PORT=$PORT"
else
  g "▶ 前台启动（Ctrl-C 退出）..."
  echo ""
  b "   Web UI：http://localhost:$PORT"
  b "   管理员：$ADMIN_NAME / $ADMIN_PASS"
  echo ""
  WEB_PORT="$PORT" DEEPTHINK_DATA_DIR="$DATA_DIR" make start
fi
