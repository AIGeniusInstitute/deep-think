# 技术方案：start-prod 实例看门狗自动重启

> 需求编号：start-prod-watchdog
> 创建日期：2026-08-31

## 1. 总体设计

新增 `scripts/deepthink-watchdog.sh`（bash 看门狗脚本），`start-prod` 不再直接前台 `node`，改为 `setsid bash deepthink-watchdog.sh …` 拉起看门狗，由看门狗循环拉起并监督 `node`。用**停止标记文件**区分「意外被杀」与「主动停止」：

```
start-prod ──► setsid bash deepthink-watchdog.sh <PORT> <DATA_DIR> <LOG> <STOP_FLAG> <PIDFILE>
                   │
                   └─► 循环：node dist/index.js
                         ├─ node 存活：每 FLAG_POLL 秒查 STOP_FLAG，有则杀 node 并退出
                         ├─ node 意外退出：无 STOP_FLAG → sleep RESTART_DELAY → 重启
                         └─ node 退出 + 有 STOP_FLAG → 清理标记退出（不重启）

stop-prod  ──► touch STOP_FLAG ──► _stop-port（SIGTERM → 5s → SIGKILL 杀 node）
```

看门狗以 `DEEPTHINK_DATA_DIR="$DATA_DIR" WEB_PORT="$PORT"` 环境变量启动 `node dist/index.js`，与 `_start-direct` 前台路径的语义完全一致。

## 2. 关键决策与理由

| 决策 | 理由 |
|------|------|
| **停止标记文件**而非 pid 比对区分停止/重启 | 看门狗无法从「node 退出」这一事实判断是意外还是主动，必须靠外部信号。标记文件最简、跨进程可见、无需额外 IPC。 |
| **shell 看门狗**而非 pm2 / systemd / Node supervisor | pm2 未安装且 `start-prod` 定位就是「多开 pm2 单进程之外」；systemd 无法覆盖 macOS 桌面端；shell 脚本与 Makefile 既有 `setsid`/`lsof`/bash 栈一致，零新依赖。 |
| **`setsid` 启动看门狗（而非 node）** | 看门狗成为独立会话 leader（`PPID=1`、`TT=?`），终端断开不掉线；node 作为其子进程继承脱离。 |
| **运行中轮询 STOP_FLAG（默认 2s）而非阻塞 `wait`** | 阻塞 `wait` 无法在「node 活着但停止请求已到」时及时响应；轮询让 stop 请求在 ≤2s 内被感知，同时彻底关闭「stop-prod 恰好在重启间隙执行」的竞态。 |
| **循环顶部 + 启动后 + node 退出后三处查标记** | 覆盖「重启间隙收到停止请求」「启动瞬间收到停止请求」等竞态窗口，保证 stop 后绝不误重启。 |
| **`RESTART_DELAY=3s` 固定延迟** | 避免崩溃循环以毫秒级刷屏/刷 CPU；先不做最大重启次数熔断（非目标，后续可加）。 |
| **`stop-prod` 先 touch 标记再 `_stop-port`** | `_stop-port` 沿用既有 SIGTERM→SIGKILL 逻辑杀 node；看门狗发现 node 死亡 + 标记存在即退出。两者叠加，杀 node 由 `_stop-port` 兜底、防重启由标记保证。 |

## 3. 看门狗脚本逻辑

```bash
#!/usr/bin/env bash
set -u
PORT="$1"; DATA_DIR="$2"; LOG_FILE="$3"; STOP_FLAG="$4"; PIDFILE="$5"
RESTART_DELAY="${RESTART_DELAY:-3}"
FLAG_POLL="${FLAG_POLL:-2}"

child=""
stop_child() {           # SIGTERM 优雅关闭 → 最多 5s → SIGKILL
  ...
}
trap 'stop_child; rm -f "$STOP_FLAG" "$PIDFILE"; exit 0' TERM INT

while true; do
  [ -f "$STOP_FLAG" ] && { log "检测到停止标记，退出不重启"; rm -f "$STOP_FLAG" "$PIDFILE"; exit 0; }  # ① 顶部
  DEEPTHINK_DATA_DIR="$DATA_DIR" WEB_PORT="$PORT" node dist/index.js >> "$LOG_FILE" 2>&1 &
  child=$!; echo "$child" > "$PIDFILE"
  while kill -0 "$child" 2>/dev/null; do                              # ② 运行中轮询
    [ -f "$STOP_FLAG" ] && { log "检测到停止标记，停止 node"; stop_child; rm -f "$STOP_FLAG" "$PIDFILE"; exit 0; }
    sleep "$FLAG_POLL"
  done
  child=""
  [ -f "$STOP_FLAG" ] && { log "node 已退出，检测到停止标记，正常退出不重启"; rm -f "$STOP_FLAG" "$PIDFILE"; exit 0; }  # ③ 退出后
  log "node 意外退出，${RESTART_DELAY}s 后自动重启"
  sleep "$RESTART_DELAY"
done
```

## 4. Makefile 改动

- `_start-direct`：新增 `START_DIRECT_DAEMON=1` 后台守护分支（镜像既有 `dev-start` 的 `setsid` 后台化模式）。守护分支：清停止标记 → `setsid bash scripts/deepthink-watchdog.sh …` → 端口就绪轮询（校验看门狗 pid 存活 + 端口 LISTEN）→ 成功/失败提示。
- `start-prod`：新增导出 `PROD_LOG` / `PROD_PIDFILE` / `PROD_STOP_FLAG`（`logs/deepthink-<PORT>.{log,pid,stop}`），并传 `START_DIRECT_DAEMON=1`。
- `stop-prod`：`_stop-port` 之前先 `touch logs/deepthink-<PORT>.stop`。

## 5. 涉及文件

| 文件 | 变更 |
|------|------|
| `scripts/deepthink-watchdog.sh` | 新增（看门狗脚本） |
| `Makefile` | `start-prod` / `_start-direct` / `stop-prod` 三处小改 |
| `docs/prd/start-prod-watchdog/prd.md` | 新增 |
| `docs/tech_solution/start-prod-watchdog/tech_solution.md` | 本文档 |
| `docs/task_state/start-prod-watchdog/task_state.md` | 新增（执行状态） |
| `docs/test_report/start-prod-watchdog/test_report.md` | 新增（测试报告） |

## 6. 风险与对策

| 风险 | 对策 |
|------|------|
| 崩溃循环刷屏/刷 CPU | `RESTART_DELAY=3s` 固定延迟兜底；日志落盘便于事后审计（后续可加最大重启次数熔断）。 |
| stop 请求落在重启间隙导致误重启 | 三处标记检查（顶部/运行中/退出后）+ 运行中轮询，竞态窗口压缩到毫秒级并已被轮询覆盖。 |
| 看门狗自身被误杀 | `trap TERM INT` 先杀子进程再退出；`stop-prod` 的 `_stop-port` 仍按端口兜底清 node。 |
| 残留停止标记阻塞下次启动 | `start-prod` 启动时 `rm -f "$PROD_STOP_FLAG"`；看门狗退出前也清理标记。 |
| `_start-direct` 顶部端口占用检查与看门狗重启冲突 | 端口占用检查只发生在守护分支启动**前**（一次性）；看门狗重启 node 时旧 node 已死，端口必然空闲，无冲突。 |
