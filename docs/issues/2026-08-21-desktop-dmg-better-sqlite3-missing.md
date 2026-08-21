# macOS dmg 安装后启动报"后端服务启动失败"：better-sqlite3 原生 binding 缺失

- 日期：2026-08-21
- 影响范围：npm ≥ 12 环境下打包的所有桌面版 dmg（macOS / Windows / Linux 通用）
- 触发条件：用 npm 12 打包，且打包时根 `package.json` 尚无 `allowScripts` 白名单（或白名单未覆盖 better-sqlite3）

## 1. 用户现象

双击安装 `DeepThink.dmg`，把 app 拖入 `/Applications` 后启动，弹窗报错：

```
后端服务启动失败：
Backend exited before ready (code=1 signal=null)
```

## 2. 问题描述

桌面版后端启动即退出（exit 1）。`~/Library/Application Support/DeepThink/logs/backend.log` 中：

```
ERROR (98682): Failed to start deepthink
    err: {
      "type": "Error",
      "message": "Could not locate the bindings file. Tried:
        → /Applications/DeepThink.app/Contents/Resources/node_modules/better-sqlite3/build/Release/better_sqlite3.node
        ..."
    }
2026-08-21T05:51:33.708Z [supervisor] backend exited code=1 signal=null
```

## 3. 根因

时间线（本机 git log + app 内文件 mtime 佐证）：

| 时间 | 事件 |
|------|------|
| 11:38 | dmg 打包。`desktop-rebuild-natives` 执行 `npm rebuild`，npm 12 默认 `allow-scripts=[""]` **静默拦截** better-sqlite3 的 install 脚本（`prebuild-install || node-gyp rebuild`），输出 "rebuilt dependencies successfully" 但实际无产物 |
| 11:42 | commit `1e9e7fc` 修复 npm 12 rebuild 参数不兼容（`--target` → `npm_config_target` 环境变量），但未触及 allow-scripts 问题 |
| 13:08 | commit `3b7d206` 才给根 package.json 加上 `allowScripts` 白名单，**但未重新 rebuild / 重新打包** |
| 13:51 | 用户安装 11:38 的旧 dmg 并启动 → 崩 |

两个因素叠加：

1. **11:38 打包时 allowScripts 白名单不存在**，npm 12 拦截 install 脚本 → `node_modules/better-sqlite3/build/` 整个目录不存在（已实地验证 dmg 内 app 包与打包机本地 node_modules 均无该目录）。electron-builder 的 `extraResources` 把 `../node_modules` 原样拷入 dmg，缺失的 binding 一起进了安装包。
2. **`desktop-rebuild-natives` 无产物校验**：`npm rebuild` 静默失败时打包流程继续走完，缺陷直达终端用户。

better-sqlite3 是项目里唯一 ABI 敏感的运行时原生模块（classic `NODE_MODULE` addon，Node 22 = ABI 127，本机 dev Node 26 = ABI 147）。`node-pty` 的 `pty.node` 是 N-API（`nm -gU` 可见 napi 符号），跨 ABI 兼容无需重建；agent-runner 的 node_modules 无任何 `.node` 文件。

外部依据：

- npm 12 安全默认值变更：`--allow-git <all|none|root>`（默认 none）、`--allow-scripts <pkg-list>`（默认 `[""]` 即全拦截）。`npm config ls -l | grep allow` 可验证。
- 前置 issue：[`2026-08-21-npm12-eallowgit.md`](2026-08-21-npm12-eallowgit.md)（allowScripts 白名单）、[`2026-08-21-npm12-desktop-build-fail.md`](2026-08-21-npm12-desktop-build-fail.md)（rebuild 参数）

## 4. 复现路径

1. 用 npm 12，从根 package.json 临时删掉 `allowScripts` 字段（模拟 11:38 状态）
2. `rm -rf node_modules && npm install --allow-git=all`（install "成功"，`ls node_modules/better-sqlite3/build/` 不存在）
3. `make desktop-pack-mac`（rebuild 静默跳过，dmg 正常产出）
4. 安装 dmg 并启动 → 弹"后端服务启动失败"

## 5. 诊断方法

```bash
# 查看崩溃原因
tail -50 ~/Library/Application\ Support/DeepThink/logs/backend.log

# dmg 内 binding 是否存在（正常应有 build/Release/better_sqlite3.node）
ls /Applications/DeepThink.app/Contents/Resources/node_modules/better-sqlite3/build/Release/

# 打包机本地 node_modules 同样检查
ls node_modules/better-sqlite3/build/Release/

# npm 12 是否在拦截 install scripts（列出被拦的包）
npm install-scripts ls

# 用内置 Node 实测 binding 可加载（ABI 匹配性）
dev-resources/node/node -e "require('better-sqlite3')(':memory:').exec('select 1'); console.log('OK')"

# binding 是哪个 ABI（127=Node 22，147=Node 26；或直接看报错信息）
node -e "require('better-sqlite3')" 2>&1 | grep NODE_MODULE_VERSION
```

## 6. 修复方案

**修复一（13:08 commit `3b7d206` 已落地）**：根 package.json 增加 `allowScripts` 白名单放行 better-sqlite3 等包，使 `npm rebuild` 真正执行 `prebuild-install`。本次已实测：`npm_config_target=v22.11.0 npm rebuild better-sqlite3` 产出 NODE_MODULE_VERSION 127 binding，内置 Node v22.11.0 加载通过。

**修复二（本次）**：`desktop-rebuild-natives` 增加产物硬校验，静默失败在打包期就终止：

```diff
 desktop-rebuild-natives: desktop-fetch-node ## ...
 	@echo "[desktop] rebuilding native modules against node $(DESKTOP_NODE_VERSION)..."
 	npm_config_target=$(DESKTOP_NODE_VERSION) npm_config_runtime=node npm rebuild $(NPM_FLAGS)
+	@if [ ! -f node_modules/better-sqlite3/build/Release/better_sqlite3.node ]; then \
+	  echo "❌ better-sqlite3 rebuild 后仍无 build/Release/better_sqlite3.node"; \
+	  echo "   多半是 install 脚本被 npm 12 allow-scripts 拦截，检查根 package.json 的 allowScripts 白名单"; \
+	  exit 1; \
+	fi
+	@if ! ./dev-resources/node/node -e "require('better-sqlite3')(':memory:').exec('select 1')" >/dev/null 2>&1; then \
+	  echo "❌ better-sqlite3 binding 无法在内置 Node $(DESKTOP_NODE_VERSION) 下加载（ABI 不匹配）"; \
+	  exit 1; \
+	fi
+	@echo "✅ [desktop] native binding 已通过内置 Node $(DESKTOP_NODE_VERSION) 加载校验"
```

选型理由：校验放在打包链路内（而非事后巡检脚本），是因为 `desktop-pack-mac/win/linux` 都依赖本 target，单点卡住所有平台的静默失败。第二道校验用**内置 Node 二进制实际加载**而非只查文件存在——能同时兜住 ABI 不匹配（例如 `npm_config_target` 未生效、rebuild 用了本机 node-gyp header 的场景）。

**修复三（交付动作）**：用修复后的链路重新 `make desktop-pack-mac` 并实测安装启动（见 §8 验证记录）。

附注：npm 12 对 `npm_config_target` 环境变量会打 warning `Unknown env config "target". This will error in a future major version of npm`——目前实测仍会透传给 install 脚本（prebuild-install 正常识别 target），未来 npm 大版本升级若真移除，需要换 `prebuild-install --target` 直调或改用 `npm_config_target` 的官方替代，届时有第二道加载校验兜底不会静默漏出。

## 7. 处理卡住的状态

- 已安装坏 dmg 的用户：重新安装新 dmg 即可（用户数据在 `~/Library/Application Support/DeepThink/data`，覆盖安装不影响）。
- 打包机本地 node_modules 处于"无 binding"状态时：`npm rebuild better-sqlite3`（有 allowScripts 白名单后即可生效）。
- 打包后本地 node_modules 的 binding 是 Node 22 ABI（127），本机 dev（Node 26）下次 `make dev` / `make start` 会由 `_ensure-native-abi` 自动重编译回本机 ABI，属预期行为。

## 8. 经验沉淀 / 预防

- npm 12 的三类静默失败（EALLOWGIT 会报错、allow-scripts 只打 warning、rebuild 参数移除）里，**allow-scripts 拦截是最危险的**：install/rebuild 表面成功，产物缺失在运行时才爆。任何依赖原生模块的构建链路都必须有"产物存在 + 目标运行时可加载"两道校验。
- 时间线教训：修复 allowScripts 白名单（13:08）后没有触发"受影响产物需要重建"的后续动作（rebuild + 重打包 + 实测安装），导致用户拿到的还是坏包。修复涉及构建产物时，验收必须是**重新构建产物并实测**，而不是"代码改了"。
- 巡检建议（已内建于 Makefile）：`desktop-rebuild-natives` 的校验即打包期巡检；如需 CI 化，可在 desktop-pack 后追加一步用 dmg 内的 node 加载校验 binding。
