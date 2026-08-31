# better-sqlite3 ABI 不匹配导致后端启动即崩，且 _ensure-native-abi 探测失效

## 1. 用户现象

执行 `make start` / `make start-prod` 后，后端进程反复崩溃重启，日志反复出现类似：

```
Error: The module '.../better-sqlite3/build/Release/better_sqlite3.node'
was compiled against a different Node.js version using
NODE_MODULE_VERSION 127. This version of Node.js requires
NODE_MODULE_VERSION 147. Please try re-compiling or re-installing
the module (for instance, using `npm rebuild` or `npm install`).
```

表现为：服务起不来、`/api/health` 无响应（或端口短暂监听又退出）。

## 2. 问题描述

宿主机 Node 升级到 v26.7.0（ABI 147）后，根目录 `node_modules/better-sqlite3` 的 native binding 仍是以旧 Node 22（ABI 127）编译的产物。`dist/index.js` 启动时 `new Database()` 加载 `.node` 二进制，因 ABI 不匹配抛 `ERR_DLOPEN_FAILED`，进程退出。

本应兜底自动重编译的 `make _ensure-native-abi` 目标**没有拦截到**这次 ABI 不匹配，导致问题在每次启动时都复现，需要手动 `npm rebuild better-sqlite3`。

## 3. 根因

1. **ABI 不匹配（环境）**：`better-sqlite3` 的 native binding 编译时使用的 Node ABI 与运行时 Node ABI 不一致。本机 node 从 v22 升到 v26，`build/Release/better_sqlite3.node` 未重编。
2. **探测失效（代码）**：`Makefile` 的 `_ensure-native-abi` 目标用 `node -e "require('better-sqlite3')"` 判断「能否加载」。但 better-sqlite3 的 native binding 是**惰性加载**的——入口 `lib/index.js` 只 `module.exports = require('./database')`，真正 `require('bindings')('better_sqlite3.node')` 发生在 `Database` 构造函数内（`lib/database.js` 第 48 行）。因此 `require('better-sqlite3')` 单独执行时**不会加载 `.node` 二进制**，永远返回成功，探测形同虚设。

   正确做法：实例化一个内存数据库并执行查询，强制触发 native 加载——这正是桌面版 `desktop-rebuild-natives` 目标（`Makefile` 第 687 行）已经在用的写法。

## 4. 复现路径

1. 把根目录 `node_modules/better-sqlite3/build/Release/better_sqlite3.node` 换成旧 ABI 产物（或直接在 v26 下保留 v22 编译的产物）。
2. 运行 `make _ensure-native-abi` —— 修复前返回成功（误判「能加载」）。
3. 运行 `node dist/index.js` —— 启动即 `ERR_DLOPEN_FAILED` 崩溃。

## 5. 诊断方法

```bash
# 1) 确认当前 Node 的 ABI 版本
node -p "process.versions.modules"

# 2) 真正加载 native binding（含实例化 + 查询）——这才是有效的探测
node -e "require('better-sqlite3')(':memory:').exec('select 1')"

# 3) 对比：仅 require 不实例化，不会触发 native 加载（无效探测）
node -e "require('better-sqlite3')"

# 4) 手动修复
npm rebuild better-sqlite3
```

## 6. 修复方案

`Makefile` 的 `_ensure-native-abi` 目标，把两处 `require('better-sqlite3')` 探测改为「实例化 + 查询」：

```diff
-	elif node -e "require('better-sqlite3')" 2>/dev/null; then :; \
+	elif node -e "require('better-sqlite3')(':memory:').exec('select 1')" 2>/dev/null; then :; \
 	else \
 	  echo "🔄 检测到原生模块（better-sqlite3）ABI 与当前 Node $$(node --version) 不匹配，正在重新编译..."; \
 	  npm rebuild better-sqlite3 --no-progress 2>&1 | tail -5 | sed 's/^/   /'; \
-	  if ! node -e "require('better-sqlite3')" 2>/dev/null; then \
+	  if ! node -e "require('better-sqlite3')(':memory:').exec('select 1')" 2>/dev/null; then \
```

选型理由：与桌面版 `desktop-rebuild-natives` 目标（第 687 行）已有的、已验证的写法对齐，强制触发 native binding 实际加载；改动仅两行、无新依赖。

## 7. 处理卡住的状态

本次没有「卡住」的运行态需要救活。若遇到后端反复崩溃重启（看门狗/裸跑都在崩），先：

```bash
# 看门狗守护实例：先写停止标记再停
make stop-prod PORT=<PORT>
# 确认端口已释放
lsof -ti:<PORT> -sTCP:LISTEN
# 重编 native 后重新启动
npm rebuild better-sqlite3
make start-prod PORT=<PORT>
```

## 8. 经验沉淀 / 预防

- **native 模块探测必须「真正加载」**：`require('pkg')` 不等于加载其 `.node` 二进制。凡 native 依赖（better-sqlite3、node-pty、sqlite-vec 等）的 ABI 探测，都要实例化/调用到会触发 `require('bindings')` 的路径。
- **本仓库其他 native 依赖现状**：`node-pty` 走 prebuilds（N-API，ABI 稳定）、`sqlite-vec` 纯 JS/扩展加载，均不受 Node 大版本 ABI 影响，唯独 `better-sqlite3` 是 node-gyp 编译、ABI 敏感。故只需管好 better-sqlite3 一处。
- **巡检/告警建议**：CI 或启动脚本可加一步 `node -e "require('better-sqlite3')(':memory:').exec('select 1')"` 作为健康自检；Node 升级后立即执行 `npm rebuild better-sqlite3`。
