# 测试报告：start-prod 实例看门狗自动重启

> 需求编号：start-prod-watchdog
> 测试日期：2026-08-31
> 测试环境：macOS（Darwin 24.6，node v26.7.0），端口 9997 / 9998

## 1. 测试结论

**全部 6 条验收标准（AC1–AC6）通过。** 看门狗在 node 意外被杀时可靠自动重启、在 `make stop-prod` 主动停止时正常退出且不重启。

验证分两层：
- **看门狗脚本核心逻辑**（用轻量 fake HTTP server 替换 `node dist/index.js`，隔离验证 restart/stop 语义）—— AC1–AC6 全通过。
- **真实后端接线**（`make start-prod` 真跑）—— 看门狗经 `nohup` 后台拉起 node、崩溃自动重启、`stop-prod` 写停止标记后干净退出，全部验证通过。

> 备注：真实后端「端口监听 → 健康检查」的 happy-path 未能在本机完整跑通，原因是宿主机 `node_modules/better-sqlite3` 的 native binding 以旧 ABI 编译（NODE_MODULE_VERSION 127，对应 Node 22），而当前 node 为 v26（ABI 147），`dist/index.js` 启动即 `ERR_DLOPEN_FAILED`。这是**既有的环境问题**，与看门狗无关——看门狗反而因此表现出「崩溃 → 自动重启」的正确行为。happy-path 的 restart 语义已由 fake server 测试完整覆盖。

## 2. 测试结果汇总

| 用例 | 验收标准 | 结果 | 证据 |
|------|---------|------|------|
| T1 启动 | AC1 后台脱离终端 | ✅ | `make start-prod` 命令立即返回；watchdog pid 61302 后台运行；node 由 watchdog 拉起 |
| T2 崩溃重启 | AC2 kill 后自动拉起 | ✅ | `kill -9 59107` → 3s 后新 node 59123，健康恢复 `{"status":"ok"}` |
| T3 重复崩溃 | AC6 连续重启 | ✅ | 连续 `kill -9` 三次：59107→59123→59156→59174，看门狗 59102 全程存活 |
| T4 主动停止 | AC4 stop-prod 不重启 | ✅ | `touch STOP` + SIGTERM → watchdog 退出、端口释放；>3s 无新 node |
| T5 停止标记清理 | AC5 无残留标记 | ✅ | `.stop` 与 `.pid` 均被看门狗退出前清理 |
| T6 日志可观测 | AC3 记录自动重启 | ✅ | 日志含「node 意外退出，3s 后自动重启」与「检测到停止标记，正常退出不重启」 |

## 3. 关键证据

### 3.1 看门狗脚本核心逻辑（fake server，端口 9997）

```
[16:17:58] watchdog pid=59102
[16:17:59] 第一次启动 ok, node=59107
[16:17:59] kill -9 59107 (第 1 次)
[16:18:05] 重启后 node=59123 (应!=prev 59107), health=healthy
[16:18:05] watchdog=alive
[16:18:05] kill -9 59123 (第 2 次)
[16:18:10] 重启后 node=59156 (应!=prev 59123), health=healthy
[16:18:10] watchdog=alive
[16:18:10] kill -9 59156 (第 3 次)
[16:18:15] 重启后 node=59174 (应!=prev 59156), health=healthy
[16:18:15] watchdog=alive
[16:18:15] 连续重启验证完成，开始主动停止
[16:18:16] watchdog 退出: YES
[16:18:20] 端口已释放: PASS
[16:18:20] 停止标记清理: PASS
```

对应日志：

```
[watchdog] 2026-08-31 16:17:58 启动 node (pid=59107, port=9997)
[watchdog] 2026-08-31 16:18:00 node 意外退出，3s 后自动重启
[watchdog] 2026-08-31 16:18:03 启动 node (pid=59123, port=9997)
[watchdog] 2026-08-31 16:18:06 node 意外退出，3s 后自动重启
[watchdog] 2026-08-31 16:18:09 启动 node (pid=59156, port=9997)
[watchdog] 2026-08-31 16:18:11 node 意外退出，3s 后自动重启
[watchdog] 2026-08-31 16:18:14 启动 node (pid=59174, port=9997)
[watchdog] 2026-08-31 16:18:16 node 已退出，检测到停止标记，正常退出不重启
```

三次 `kill -9` 均触发自动重启（59107→59123→59156→59174），看门狗自身不退出；`touch STOP` + SIGTERM 后看门狗识别标记正常退出，端口释放、无新 node。

### 3.2 真实后端接线（`make start-prod`，端口 9998）

`make start-prod PORT=9998` 输出（命令立即返回，看门狗后台拉起）：

```
>> start-prod: PORT=9998 DATA_DIR=/Users/edy/.deepthink-9998 LOG=.../logs/deepthink-9998.log
✅ Docker 镜像无需重建
✅ 沙箱镜像无需重建
🔄 检测到 shared/ 类型变更，同步类型...
✅ 后端无变更，跳过编译
✅ 前端无变更，跳过编译
✅ agent-runner 无变更，跳过编译
🚀 后台守护启动（端口 9998，nohup 脱离终端 + watchdog 自动重启）...
```

node 因 better-sqlite3 ABI 不匹配启动即崩，看门狗随即进入自动重启循环：

```
[watchdog] 2026-08-31 16:24:28 node 意外退出，3s 后自动重启
[watchdog] 2026-08-31 16:24:31 启动 node (pid=61423, port=9998)
...
[watchdog] 2026-08-31 16:25:15 node 意外退出，3s 后自动重启
[watchdog] 2026-08-31 16:25:18 启动 node (pid=61602, port=9998)
[watchdog] 2026-08-31 16:25:20 检测到停止标记，停止 node (pid=61602)
```

随后 `make stop-prod PORT=9998` 写入停止标记，看门狗检测到标记 → 杀掉 node → 清理 `.stop`/`.pid` → 退出（进程消失）。验证了「崩溃自动重启」与「主动停止不重启」两条路径在真实后端的接线正确。

## 4. 已知观察（非缺陷）

- **better-sqlite3 ABI 不匹配（环境问题，非本需求引入）**：宿主机 `node_modules/better-sqlite3` 的 native binding 以 NODE_MODULE_VERSION 127（Node 22）编译，当前 node v26（ABI 147）加载报 `ERR_DLOPEN_FAILED`。修复：`npm rebuild better-sqlite3`。此问题与看门狗无关，`make start` 同样会命中；反而印证了看门狗「崩溃 → 自动重启」的正确行为。
- **`_ensure-native-abi` 未能拦截该 ABI 不匹配**：该目标仅做 `require('better-sqlite3')` 探测，不触发 native binding 实际加载（`new Database()`），故未触发 rebuild。属既有代码的探测强度不足，非本需求范围。
- 崩溃循环下 `make start-prod` 的失败分支只 `rm pidfile` 并退出、不杀看门狗——看门狗会继续重试直至被 `stop-prod` 停止。这与 PRD「不做崩溃循环熔断」的非目标一致（固定延迟兜底、日志可审计）。
