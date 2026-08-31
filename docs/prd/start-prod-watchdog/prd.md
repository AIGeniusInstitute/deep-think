# PRD：start-prod 实例看门狗自动重启

> 需求编号：start-prod-watchdog
> 创建日期：2026-08-31

## 1. 背景与问题

当前 `make start-prod PORT=<PORT>` 通过 `_start-direct` 复用前台路径 `WEB_PORT=$(PORT) node dist/index.js`，进程绑定启动它的终端前台进程组。SSH 断线 / 关窗口即被 `SIGHUP` 杀死，且 `node dist/index.js` 进程因**崩溃 / OOM / 误 kill** 等意外原因退出后不会自动拉起，端口不再监听，隔离生产实例中断，需人工重新 `make start-prod`。

（本项目 `pm2` 未安装时 `make start` 与 `make start-prod` 均走 `_start-direct` 前台裸跑路径；`start-prod` 定位为「隔离多开生产实例」，与 pm2 单进程托管互斥，故无法借力 pm2 的 `restart` 机制。）

## 2. 目标

`make start-prod PORT=<PORT>` 启动的隔离实例获得**后台守护 + 看门狗（watchdog）自动重启**能力：

- `node` 意外退出（崩溃/OOM/被 kill）→ 自动重启，服务自愈。
- `make stop-prod PORT=<PORT>` 主动停止 → 强制杀死，**不**自动重启。
- 命令立即返回，进程脱离终端（SSH 断线不掉线）。

## 3. 非目标

- 不改动默认实例 `make start` 的行为（本需求只覆盖 `start-prod` 隔离实例；默认实例的 pm2 路径已自带重启，前台路径语义不变）。
- 不引入 systemd（无法跨 macOS/Linux 桌面端）；不引入 pm2（未安装且 `start-prod` 定位就是多开 pm2 单进程之外）。
- 不做崩溃循环熔断（最大重启次数限制）——先以固定重启延迟兜底，避免刷屏。

## 4. 用户故事

- 作为运维，当我 `make start-prod PORT=9999` 后，即使 node 进程被 OOM 或误 kill，服务也能在数秒内自动恢复，端口重新监听。
- 作为运维，当我 `make stop-prod PORT=9999` 时，服务被彻底停止、端口释放，且不会再自动拉起。

## 5. 验收标准（Acceptance Criteria）

| 编号 | 验收标准 |
|------|---------|
| AC1 | `make start-prod PORT=<PORT>` 命令立即返回，看门狗 + node 进程均已后台脱离终端（`PPID=1`、`TT=?`）。 |
| AC2 | 手动 `kill -9 <node pid>` 模拟崩溃后，看门狗在 `RESTART_DELAY`(默认 3s) 内拉起**新的** node 进程，端口重新监听，`/api/health` 恢复 healthy。 |
| AC3 | 看门狗日志记录 `node 意外退出…自动重启` 事件。 |
| AC4 | `make stop-prod PORT=<PORT>` 后：node 进程退出、端口释放，且等待超过 `RESTART_DELAY` 后 node **不会**再次出现（看门狗已退出）。 |
| AC5 | `stop-prod` 写下的停止标记被清理；下一次 `start-prod` 能正常启动（无残留标记干扰）。 |
| AC6 | 连续 `kill` 多次（≥2 次）后仍能持续自动重启，看门狗自身不退出。 |

## 6. 测试用例

| 用例 | 步骤 | 预期 |
|------|------|------|
| T1 启动 | `make start-prod PORT=9998` | 立即返回；watchdog + node 均 `PPID=1`、`TT=?`；`:9998` 监听；`/api/health` healthy |
| T2 崩溃重启 | T1 后 `kill -9 <node pid>` | 3s 内新 node 出现、`:9998` 重新监听、health 恢复；日志含「自动重启」 |
| T3 重复崩溃 | T2 后再 `kill -9 <新 node pid>` | 再次自动重启（看门狗不退出） |
| T4 主动停止 | `make stop-prod PORT=9998` | node 退出、`:9998` 释放；等 >3s 后无新 node、watchdog 进程消失 |
| T5 再启动 | T4 后 `make start-prod PORT=9998` | 正常启动（无残留停止标记） |
