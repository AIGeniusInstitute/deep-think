# 执行状态：start-prod 实例看门狗自动重启

> 需求编号：start-prod-watchdog
> 最后更新：2026-08-31

## 执行进度总览

| 阶段 | 状态 | 说明 |
|------|------|------|
| 0. 创建 worktree | ✅ 完成 | `worktree-start-prod-watchdog` 分支 |
| 1. PRD 文档 | ✅ 完成 | `docs/prd/start-prod-watchdog/prd.md`（含 AC1–AC6 + 测试用例 T1–T5） |
| 2. 技术方案 | ✅ 完成 | `docs/tech_solution/start-prod-watchdog/tech_solution.md` |
| 3. 方案实施 | ✅ 完成 | `scripts/deepthink-watchdog.sh` + `Makefile` 接线 |
| 4. 测试与修复 | ✅ 完成 | 独立 fake server 测试 + 真实后端接线验证，AC1–AC6 全通过 |
| 5. 测试报告 | ✅ 完成 | `docs/test_report/start-prod-watchdog/test_report.md` |
| 6. 合并 main + push | ⏳ 待执行 | 见下方 |

## 方案实施明细

### 交付物

| 文件 | 变更 |
|------|------|
| `scripts/deepthink-watchdog.sh` | 新增（+x），看门狗主循环 |
| `Makefile` | `_start-direct` 增加 `START_DIRECT_DAEMON=1` 守护分支；`start-prod` 传 `PROD_LOG/PROD_PIDFILE/PROD_STOP_FLAG`；`stop-prod` 写 `.stop` 停止标记 |

### 看门狗核心语义

- 主循环：`while true` 内 `node dist/index.js &` 拉起子进程，记录 pid 到 pidfile。
- 三个停止标记检查点（闭合竞态）：
  1. 循环顶部 —— 启动前发现 `.stop` 直接退出；
  2. 运行中轮询（`FLAG_POLL`，默认 2s）—— 发现 `.stop` 主动杀 node 后退出；
  3. node 退出后 —— 发现 `.stop` 则正常退出不重启，否则 `RESTART_DELAY`（默认 3s）后重启。
- 退出前统一清理 `.stop` 与 `.pid`。

### 与参考实现（prime-ai-harness）的关键差异

- 参考用 `setsid` 脱离会话；macOS（Darwin）无 `setsid`，改用 `nohup`（POSIX 可移植，`nohup` 令 SIGHUP 被忽略且 SIG_IGN 经 fork/exec 传播到 node）。技术方案中已记录此偏离理由。

## 测试结论（详见 test_report）

- 独立 fake server 测试：连续 `kill -9` 三次（59107→59123→59156→59174）均自动重启、看门狗不退出；`touch STOP` + SIGTERM 后正常退出、端口释放、标记清理。**AC1–AC6 全通过**。
- 真实后端接线：`make start-prod` 命令立即返回、看门狗后台拉起 node；node 因既有 better-sqlite3 ABI 不匹配启动即崩，看门狗正确进入自动重启循环；`make stop-prod` 写标记后干净退出。**接线正确**。

## 待执行

1. commit（简体中文 message）
2. 合并 `worktree-start-prod-watchdog` → `main`
3. push 到 main
