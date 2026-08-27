# Sandbox 浏览器启动后界面仍显示未启动

- 日期：2026-08-19
- 涉及模块：`web/src/components/sandbox/BrowserView.tsx`、`web/src/stores/sandbox.ts`
- 严重度：P1（浏览器实时视图无法进入可用状态）
- 状态：已修复

## 1. 用户现象

在启用浏览器能力的 Sandbox 中点击“启动浏览器”后，REST 请求成功，后端浏览器也已经启动，但界面仍显示“浏览器尚未启动”，且收不到实时画面。

## 2. 根因

`BrowserView` 的 `started` 初始为 `false`，而负责注册 `sandbox_browser_started`、`sandbox_browser_stopped`、`sandbox_browser_frame` 监听并发送订阅的 effect 在 `started=false` 时直接返回。因此组件既等不到 started 事件，也不会订阅帧。

同时，“启动浏览器”按钮通过 REST 调用 `/browser/start`。该接口只返回 `{ started: true }`，不会向当前 WebSocket 广播 started 事件；前端成功后也没有更新 `started`，形成无法自行打破的循环。

## 3. 修复

1. 将每个 session 的启动状态统一放入 Sandbox store，避免 `BrowserView` 和 `SandboxToolbar` 各自维护互不可见的状态。
2. 两个 REST 启动入口都调用 store action；服务端确认 `started=true` 后立即记录状态并发送 `sandbox_browser_subscribe`。
3. 帧和错误监听不再依赖 `started`；started/stopped WebSocket 事件由 store 的常驻 handler 更新状态。
4. `started` 变化只控制 FPS 计时器，不会因 effect cleanup 误发 unsubscribe 并停止刚启动的浏览器。
5. WebSocket 暂不可用时不伪造 subscribed 状态，连接恢复后会重试帧订阅。
6. stopped、取消订阅和销毁 session 时同步清除启动、订阅状态与旧帧；卸载时若 WebSocket 不可用，则通过 REST stop 回收已启动的浏览器。

该方案不会在用户仅打开浏览器视图时自动启动后端浏览器。

## 4. 回归验证

`tests/sandbox-browser-start-lifecycle.test.ts` 覆盖：

- REST 启动成功后进入 started 且发送订阅；
- REST 启动失败时不污染状态；
- WebSocket started/stopped 状态迁移，并在停止时清理旧帧。
- WebSocket 断开时清理订阅、重连时恢复已启动浏览器的帧订阅；
- 取消订阅时清理 started、订阅和旧帧，在线时发送 WS unsubscribe，离线时回退 REST stop。

运行：

```bash
npx vitest run tests/sandbox-browser-start-lifecycle.test.ts
cd web && npx tsc --noEmit
```
