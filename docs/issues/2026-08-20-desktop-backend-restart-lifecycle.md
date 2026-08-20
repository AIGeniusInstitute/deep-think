# Electron BackendSupervisor 二次启动生命周期失效

- 日期：2026-08-20
- 影响范围：桌面版托盘重启、配置导入/导出、更新前自动备份
- 修复文件：`desktop/src/backend-supervisor.ts`

## 1. 用户现象

桌面版首次启动正常，但任何复用同一个 `BackendSupervisor` 实例的
`stop() -> start()` 都可能等待 60 秒后报错：

```text
Backend did not become ready within 60000ms
```

可直接触发的入口包括：

- 托盘 -> 重启服务；
- 文件 -> 导出配置；
- 文件 -> 导入配置；
- 自动更新下载完成后的更新前备份。

新后端进程可能已经监听端口，但调用方仍收到失败。若新端口与旧端口不同，
主窗口还会继续指向已经停止的旧服务。

## 2. 根因

旧实现用一个永久布尔值同时表达“用户已停止服务”和“是否允许本次探针或
崩溃重启”：

1. `stop()` 设置 `stopped = true`；
2. 后续 `start()` 不将它恢复为 `false`；
3. HTTP ready probe 看到 `stopped` 后立即退出，不再轮询；
4. 二次启动的 child 退出时，`onExit()` 也因 `stopped` 为真而不再拉起。

后端正常输出是 `Web server started`，不匹配 supervisor 的 `started on`
ready 正则，所以通常无法靠 stdout 绕过已停用的 HTTP probe。

仅在 `start()` 中补 `stopped = false` 仍不完整：

- 已排定的 crash restart timer 会在手动 stop/start 后再次 spawn；
- SIGKILL 后迟到的旧 child `exit` 可能操作新 child 的共享 ready callbacks；
- 并发 `start()` 会覆盖 `proc`、`port` 和 ready callbacks；
- 如果内部 crash restart 复用会重置计数的 public `start()`，三次重试预算会失效。

## 3. 修复设计

修复保持 `start()` / `stop()` 的公开接口不变，并增加四个局部约束：

1. **显式生命周期 generation**：每次 public `start()` 与 `stop()` 都推进
   generation。child 的 stdout、exit 和 ready wait 均捕获创建它的 generation。
2. **child identity**：只有同时匹配当前 generation 和当前 `proc` 的事件才能
   写日志、resolve/reject ready 或安排重启；旧 child 的迟到事件会被忽略。
3. **timer 所有权**：保存 crash restart timer。stop 或新的显式 start 会取消旧
   timer；timer 回调也再次校验自身、generation、停止状态和当前 child。
4. **启动 single-flight**：同一时刻的多个 `start()` 共享 `startPromise`，只 spawn
   一次。public start 重置 restart budget；内部 timer 直接启动同一 generation 的
   新 attempt，不重置预算。

`stop()` 始终使用进入该次 stop 时捕获的 child 引用发送 SIGTERM/SIGKILL，
不会通过可被新启动覆盖的 `this.proc` 杀错进程。新 start 若遇到仍在执行的 stop，
会等待它完成后再 spawn。

## 4. 回归测试

`tests/desktop-backend-supervisor-lifecycle.test.ts` 完全 mock Electron 外部边界：

- `child_process.spawn` / `execFileSync`；
- `findFreePort`；
- 日志文件系统；
- HTTP `fetch`；
- 所有 backoff、probe 和 stop timeout timer。

覆盖场景：

1. start -> stop -> start，二次 HTTP probe 正常 ready；
2. 二次启动后的 child 崩溃，仍自动拉起；
3. 已排定 restart 后 stop/manual start，不产生额外 child；
4. SIGKILL 后旧 child 的迟到 stdout/exit 不干扰新 ready 或安排重启；
5. 并发 start 只 spawn 一次；
6. stop 取消尚在端口选择阶段的 start 后，可建立全新生命周期；
7. ready 超时后，存活但未 ready 的进程不会被后续 start 误报为成功；
8. 内部 crash restart 保留三次预算，第四次崩溃后停止。

## 5. 边界

- 本次不改变端口选择、ready 关键字、退避间隔或最大重试次数。
- 本次不修改菜单、配置归档或更新器调用方式。
- ready 超时后保留未就绪 child，并要求调用方显式 stop 后再启动；是否自动终止该
  child 是独立策略问题，不在本修复范围内。
