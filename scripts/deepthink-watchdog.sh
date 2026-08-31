#!/usr/bin/env bash
# DeepThink 单实例看门狗：node 意外退出时自动重启；检测到停止标记时正常退出不重启。
#
# 用法（由 Makefile start-prod 调用，勿手动直跑）:
#   deepthink-watchdog.sh <PORT> <DATA_DIR> <LOG_FILE> <STOP_FLAG> <PIDFILE>
#
#   PORT      服务端口（node 的 WEB_PORT）
#   DATA_DIR  数据目录（node 的 DEEPTHINK_DATA_DIR）
#   LOG_FILE  node 的 stdout/stderr 与看门狗日志共用文件
#   STOP_FLAG stop-prod 写下的停止标记文件；存在则退出不重启
#   PIDFILE   记录当前 node 子进程 pid（供诊断）
#
# 环境变量（可覆盖）:
#   RESTART_DELAY  意外退出后重启前的等待秒数，默认 3（避免崩溃循环刷屏）
#   FLAG_POLL      运行中轮询停止标记的间隔秒数，默认 2（决定"停止请求"的最大感知延迟）
set -u

PORT="$1"
DATA_DIR="$2"
LOG_FILE="$3"
STOP_FLAG="$4"
PIDFILE="$5"

RESTART_DELAY="${RESTART_DELAY:-3}"
FLAG_POLL="${FLAG_POLL:-2}"

log() { echo "[watchdog] $(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG_FILE"; }

child=""

# 停掉当前 node 子进程：SIGTERM 优雅关闭 → 最多 5s → SIGKILL 兜底
stop_child() {
  if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then
    kill "$child" 2>/dev/null
    local i=0
    while [ $i -lt 5 ] && kill -0 "$child" 2>/dev/null; do sleep 1; i=$((i+1)); done
    if kill -0 "$child" 2>/dev/null; then kill -9 "$child" 2>/dev/null; fi
  fi
  child=""
}

# 收到 TERM/INT 时先杀子进程再退出（兜底：stop-prod 直接对看门狗发信号也能干净收场）
trap 'stop_child; rm -f "$STOP_FLAG" "$PIDFILE"; exit 0' TERM INT

while true; do
  # 循环顶部先查停止标记（覆盖"重启间隙收到停止请求"的场景）
  if [ -f "$STOP_FLAG" ]; then log "检测到停止标记，退出不重启"; rm -f "$STOP_FLAG" "$PIDFILE"; exit 0; fi

  DEEPTHINK_DATA_DIR="$DATA_DIR" WEB_PORT="$PORT" node dist/index.js >> "$LOG_FILE" 2>&1 &
  child=$!
  echo "$child" > "$PIDFILE"
  log "启动 node (pid=$child, port=$PORT)"

  # 运行中轮询：node 存活就每 FLAG_POLL 秒查一次停止标记；node 退出则跳出
  while kill -0 "$child" 2>/dev/null; do
    if [ -f "$STOP_FLAG" ]; then
      log "检测到停止标记，停止 node (pid=$child)"
      stop_child
      rm -f "$STOP_FLAG" "$PIDFILE"
      exit 0
    fi
    sleep "$FLAG_POLL"
  done
  child=""

  # node 已退出：再次确认是否有停止标记（stop-prod 已杀 node 但标记稍后写入的兜底）
  if [ -f "$STOP_FLAG" ]; then log "node 已退出，检测到停止标记，正常退出不重启"; rm -f "$STOP_FLAG" "$PIDFILE"; exit 0; fi

  log "node 意外退出，${RESTART_DELAY}s 后自动重启"
  sleep "$RESTART_DELAY"
done
