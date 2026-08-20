# 2026-08-20 - 账号切换后 WebSocket 沿用旧会话

## 1. 用户现象

用户 A 在同一浏览器标签页退出登录，再登录用户 B 后，页面可能仍显示 WebSocket 已连接，但实时消息、流式回复和状态更新不可用。第一次 WebSocket 收发还可能触发 `1008 Unauthorized`，将已经登录的用户 B 再次跳转到登录页。刷新页面后恢复。

## 2. 问题描述

`AppLayout` 挂载时通过全局单例 `wsManager` 建立连接，但卸载时没有关闭连接。退出登录会卸载受保护布局，却不会销毁模块级单例，因此旧 WebSocket 可以跨越登录页继续存活。

用户 B 登录后，新的 `AppLayout` 再次调用 `connect()`。旧连接仍为 `OPEN` 或 `CONNECTING` 时，`WsManager.connect()` 会直接返回，不会使用用户 B 的新 Cookie 发起握手。

## 3. 根因

- `web/src/components/layout/AppLayout.tsx` 的 WebSocket effect 只有 `connect()`，缺少 cleanup。
- `web/src/api/ws.ts` 的 `WsManager` 是模块级单例，路由切换不会自动释放它。
- 后端只在 WebSocket 握手时绑定 session。HTTP 登出会删除 session 和 Cookie，但不会主动遍历并关闭对应的 WebSocket。
- 后端在下一次入站消息或安全广播时复验旧 session，并以 `1008` 关闭连接；前端把该关闭码解释为认证失败并跳转登录页。

## 4. 复现路径

1. 用户 A 登录并进入任意受保护页面，确认 `/ws` 已连接。
2. 用户 A 退出登录，不刷新标签页。
3. 在没有其他 WebSocket 消息触发旧连接关闭的情况下，登录用户 B。
4. 观察没有新的 `/ws` 握手；发送消息或等待一次实时广播。
5. 连接被后端以 `1008` 关闭，用户 B 被跳回登录页。

## 5. 修复方案

让建立连接的 `AppLayout` effect 同时拥有连接清理职责：

```ts
useEffect(() => {
  wsManager.connect();
  return () => wsManager.disconnect();
}, []);
```

退出登录或离开受保护布局时，`disconnect()` 会取消待执行的重连、先清空当前 socket 引用，再关闭底层连接。之后旧 socket 的迟到 `close` 回调会被身份检查忽略，不会重连或跳转。用户 B 进入布局时，现有 `connect()` 会使用新 Cookie 创建全新连接。

后端认证和广播逻辑无需修改。

## 6. 回归测试

`tests/websocket-lifecycle.test.ts` 使用假 WebSocket 和 Vitest 假定时器覆盖：

- `connect -> disconnect -> connect` 会关闭旧连接并创建新实例；
- 当前连接异常关闭后仍按既有策略重连；
- 主动 `disconnect()` 会取消已经排队的重连；
- 主动断开后，旧 socket 迟到的普通关闭不会重连，迟到的 `1008` 关闭不会跳转登录页。

验证命令：

```bash
npx vitest run tests/websocket-lifecycle.test.ts
npm --prefix web run build
git diff --check
```

## 7. 风险与边界

改动只影响受保护布局的 WebSocket 生命周期。React StrictMode 开发模式会执行一次挂载、清理、再挂载；`disconnect()` 先清空实例引用，因此第一次连接的迟到回调不会干扰第二次连接。

常规 WebSocket 入站消息和广播均会在后端复验 session，本问题的主要影响是换号后的连接不可用和错误跳转，不应表述为已确认的跨账号授权绕过。

## 8. 预防

由组件或 effect 创建的长生命周期连接必须在同一 effect 中返回对称 cleanup。涉及认证身份的全局连接还应覆盖“旧连接迟到回调不得影响新连接”的回归测试。
