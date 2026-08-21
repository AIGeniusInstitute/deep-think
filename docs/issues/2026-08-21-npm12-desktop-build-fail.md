# npm 12 导致桌面打包失败（tsc 缺失 + allow-git 限制 + npm rebuild 参数移除）

## 1. 用户现象

在 macOS 上执行 `make desktop-pack-mac` 打包桌面版，连续遭遇三种失败：

1. 三个子项目（backend / web / agent-runner）同时报 `sh: tsc: command not found`，构建以 exit 127 中止；
2. 安装根目录依赖时报 `npm error Fetching packages of type "git" have been disabled`，拒绝拉取 `@whiskeysockets/eslint-config@github:whiskeysockets/eslint-config`；
3. 依赖装齐后重新打包，又在 `desktop-rebuild-natives` 步骤报 `npm error Unknown cli flags: --target --runtime`，Makefile 以 Error 1 退出。

## 2. 问题描述

本机 npm 为 12.0.2（配合 Node 26），相对旧版 npm 有三个破坏性行为变化，叠加 `node_modules` 缺失，共同导致打包链路三处断点：

- 环境是新 clone / 依赖未安装，`tsc` 不存在属正常现象，先装依赖即可；
- npm 12 新增 `allow-git` 配置，默认值 `none`，默认拒绝拉取 git 协议依赖。根目录依赖 `@whiskeysockets/baileys`（WhatsApp 通道）引用了 `github:whiskeysockets/eslint-config`，被拦截；
- npm 12 移除了 `npm rebuild --target=<ver> --runtime=node` 这两个 CLI 参数（旧版用于把参数透传给 node-gyp 做交叉 ABI 编译），`Makefile` 的 `desktop-rebuild-natives` 目标仍使用旧语法，直接报 `EUNKNOWNCONFIG`。

## 3. 根因

`Makefile:630`（修复前）：

```make
npm rebuild --target=$(DESKTOP_NODE_VERSION) --runtime=node $(NPM_FLAGS)
```

npm 12 的 rebuild 不再接受 `--target` / `--runtime` CLI 参数。这两个参数的实际作用是通过 npm config 传给 node-gyp（`npm_config_target` / `npm_config_runtime`），指定编译目标为桌面版内置 Node（v22.11.0）的 ABI——因为系统 Node 是 v26，直接 rebuild 会产出 ABI 不匹配的 better-sqlite3 原生模块。

外部依据：`npm error Unknown cli flags` 的报错本身即 npm 12 行为；`npm config ls -l` 可见新增的 `allow-git = "none"`、`allow-remote = "none"` 默认项。

## 4. 复现路径

1. 确认 npm ≥ 12：`npm --version`
2. 删除依赖模拟新环境：`rm -rf node_modules web/node_modules container/agent-runner/node_modules`
3. `make desktop-pack-mac` → 观察 `tsc: command not found`
4. `npm install --registry=https://registry.npmmirror.com` → 观察 `EALLOWGIT` git 依赖被拒
5. `npm install --allow-git=all` 装齐依赖后 `make desktop-pack-mac` → 观察 `desktop-rebuild-natives` 报 `Unknown cli flags: --target --runtime`

## 5. 诊断方法

```bash
npm --version                          # 确认 npm 主版本
npm config ls -l | grep allow-git      # 查看默认值（"none" = 禁用 git 依赖）
npm help config | grep -A5 allow-git   # 查文档（合法值: all / none / root）
grep -n 'npm rebuild' Makefile         # 定位旧语法调用点
```

## 6. 修复方案

`Makefile` 的 `desktop-rebuild-natives` 目标，把 CLI 参数改为等价的环境变量形式（`npm_config_*` 环境变量是 npm 长期稳定的配置注入机制，新旧版本均支持，node-gyp 照常读取）：

```diff
 desktop-rebuild-natives: desktop-fetch-node ## 用内置 Node ABI 重新编译根 node_modules 的 native 模块（better-sqlite3 等），避免运行时 ABI 不匹配
 	@echo "[desktop] rebuilding native modules against node $(DESKTOP_NODE_VERSION)..."
-	npm rebuild --target=$(DESKTOP_NODE_VERSION) --runtime=node $(NPM_FLAGS)
+	npm_config_target=$(DESKTOP_NODE_VERSION) npm_config_runtime=node npm rebuild $(NPM_FLAGS)
```

选型理由：
- 环境变量方案与旧 CLI 参数语义完全等价（npm 会把 `npm_config_*` 环境变量注入给 lifecycle 脚本，node-gyp 读取 `npm_config_target` / `npm_config_runtime` 决定目标 ABI）；
- 不引入额外工具（如手动调 node-gyp），保持单行改动。

环境侧（无需入库，操作一次即可）：
- 三项目依赖安装：根目录 `npm install --allow-git=all --registry=https://registry.npmmirror.com`；`web/`、`container/agent-runner/` 正常 `npm install`；
- `chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper`（PTY 模式需要）。

## 7. 处理卡住的状态

无长期 stuck 状态。若 `desktop-pack-mac` 中途失败重跑，注意 `desktop-clean-stale-mount` 目标会自动清理 `/Volumes/DeepThink 1.0.0` 残留挂载点（hdiutil detach 失败 exit 16），无需手工干预。

## 8. 经验沉淀 / 预防

- npm 大版本升级（11 → 12）会移除旧 CLI 参数并收紧默认安全策略（git 依赖、install-scripts 审批），升级后跑一遍 `make build && make desktop-pack-mac` 全链路验证；
- npm 12 的 install-scripts 审批机制会静默跳过部分包的 postinstall（本次拦截了 esbuild / fsevents / @anthropic-ai/claude-code / electron），装完依赖应抽查关键二进制：`node_modules/.bin/esbuild --version`；
- 今后凡 "参数透传给 node-gyp" 的场景，优先用 `npm_config_*` 环境变量而非 CLI 参数，跨 npm 版本更稳。
