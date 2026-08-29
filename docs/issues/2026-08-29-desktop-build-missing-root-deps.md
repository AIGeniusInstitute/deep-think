# desktop-pack-linux 构建报错：根目录后端依赖未安装导致 tsc not found

- 日期：2026-08-29
- 影响范围：桌面版打包链 `desktop-pack-linux` / `desktop-build` / `desktop-build-deps`（根目录后端依赖缺口）
- 严重度：中（根 `node_modules` 缺失时打包必现，`make install` 可绕过）
- 修复范围说明：本 issue 仅修复"根目录后端依赖无保护"这一缺口。`desktop-build-deps` 中 `web-install` 排在 `build` 之后的 ordering 问题是**另一个既存缺口**（全新 clone、web 依赖也缺失时会在 web 构建失败），不在本 issue 范围内，仅在 §8 标注。

## 1. 用户现象

执行 `make desktop-pack-linux` 打包 Linux 安装包，前端（web）和 agent-runner 都编译成功，最后报：

```
[web] npm run build:web exited with code 0
[agent-runner] npm --prefix container/agent-runner run build exited with code 0
make: *** [Makefile:153：build] 错误 1
```

前端、agent-runner 都显示成功，却整体失败，且没有任何明显的 TypeScript 错误信息，令人困惑。

## 2. 问题描述

`make build`（Makefile:153）执行 `npm run build:all`，该脚本用 `concurrently` 并发跑三件事：后端 `npm run build`（= `tsc`）、web 构建、agent-runner 构建。

web 和 agent-runner 各自有独立的 `node_modules`，构建成功；但**根目录后端 `node_modules` 不存在**，导致后端 `tsc` 命令找不到（`sh: 1: tsc: not found`），后端构建失败，连带 `build:all` / `make build` 整体返回非 0，在 Makefile:153 报错。

`concurrently --group` 的输出把后端那条 `tsc: not found` 的 stderr 卷到了顶部、被 web/agent-runner 的成功输出淹没，所以用户看到的是"都成功却失败"的假象。

## 3. 根因

代码层面：构建链对依赖安装的保护是**不对称**的。

- `web` 有 `web-install` 条件保护（`web/node_modules` 缺失或 `web/package.json` 更新则自动 `npm install`）。
- `agent-runner` 在 `desktop-build-deps` 的 recipe 里**无条件**重装。
- **根目录后端没有任何保护**：`desktop-build-deps: build sync-types web-install`，`build` 直接跑 `tsc`，根 `node_modules` 缺失即挂。

而生产启动路径 `_start-direct` 早已有等价的保护模式：

```makefile
@if [ ! -d node_modules ] || [ package.json -nt node_modules ] || ...; then \
    echo "📦 依赖有更新，安装依赖..."; $(MAKE) install; fi
```

但**打包链没有**。因此一旦根 `node_modules` 缺失（如全新 clone 后只装了 web/agent-runner、或误删根 `node_modules`），直接 `make desktop-pack-linux` 就会撞到 `tsc not found`——本次用户正是此状态（web/agent-runner 依赖都在，唯独根目录缺失）。

基础设施层面无因素，纯 Makefile 依赖保护缺口。

外部依据：
- npm 12+ 默认禁用 git 依赖（EALLOWGIT），见 Makefile:474 注释。
- `@whiskeysockets/baileys` 在 dependencies 里有 `github:` 依赖（Makefile:475-476 注释），故根目录安装必须带 `--allow-git=all`。

## 4. 复现路径

1. 全新 clone 仓库（或 `rm -rf node_modules`，保留 `web/node_modules` 与 `container/agent-runner/node_modules`）。
2. 直接执行 `make desktop-pack-linux`（不先 `make install`）。
3. 观察到 web/agent-runner 成功、`make: *** [Makefile:153：build] 错误 1`。

最小复现（不打包，只跑构建）：

```bash
rm -rf node_modules          # 仅删根目录依赖，保留 web/agent-runner
make build                   # 后端 tsc not found → 整体失败
npm run build                # 单独跑后端，可见真实错误：sh: 1: tsc: not found
```

## 5. 诊断方法

```bash
# 1. 看根目录是否有 tsc（核心判据）
ls node_modules/.bin/tsc
# 期望存在；若 "没有那个文件或目录" → 根依赖缺失

# 2. 单独跑后端构建，拿到被 concurrently 淹没的真实错误
npm run build
# 报 sh: 1: tsc: not found 即确认

# 3. 确认 web/agent-runner 依赖却在（解释"为何它们成功"）
ls web/node_modules/.bin/vite container/agent-runner/node_modules/.bin/tsc
```

## 6. 修复方案

新增 `root-install` guard 目标，镜像现有 `web-install` 的条件安装模式，并把它作为 `desktop-build-deps` 的首个前置依赖（在 `build` 之前执行）。不改动 `build` 本身，避免拖慢日常 dev 构建（`make build` 在 dev 流程中被频繁调用）。

```diff
 web-install: ## 安装 web/ 子项目依赖（仅在 package.json 变化或 node_modules 缺失时装）
 	@if [ ! -d web/node_modules ] || [ web/package.json -nt web/node_modules ]; then \
 		echo "▶ web/node_modules 缺失或过期，执行 npm install..."; \
 		cd web && npm install --no-audit --no-fund $(NPM_FLAGS); \
 	fi
 	@touch web/node_modules

+root-install: ## 安装根目录后端依赖（仅在 package.json 变化或 node_modules 缺失时装）
+	@# --allow-git=all 同 install：@whiskeysockets/baileys 有 github: 依赖，npm 12 起默认 EALLOWGIT
+	@if [ ! -d node_modules ] || [ package.json -nt node_modules ]; then \
+		echo "▶ 根目录 node_modules 缺失或过期，执行 npm install..."; \
+		npm install --no-audit --no-fund $(NPM_FLAGS) --allow-git=all; \
+	fi
+	@touch node_modules
+
-desktop-build-deps: build sync-types web-install ## 编译桌面版所需的所有产物（后端 + 前端 + agent-runner）
+desktop-build-deps: root-install build sync-types web-install ## 编译桌面版所需的所有产物（后端 + 前端 + agent-runner）
```

**选型理由**：
- 镜像 `web-install` 既有模式，零新概念，符合"外科手术式改动"。
- `--allow-git=all` 与 `install` 目标一致，否则根 `npm install` 会因 baileys 的 `github:` 依赖报 EALLOWGIT 失败。
- 只挂在 `desktop-build-deps`（打包链），不动 `build`——`make build` 在 dev 中被频繁调用，每次都 stat 检查虽便宜但无必要，且避免改变 `build` 语义。
- 前置依赖顺序：GNU make 在无 `-j` 时按列出顺序处理前置依赖，`root-install` 列在 `build` 之前可保证先装后编译；该路径不与 `-j` 并发使用。

## 7. 处理卡住的状态（如适用）

不适用。无 stuck 运行态，纯构建期问题。

若已在缺失根依赖的状态下卡住，解除方式：

```bash
make install          # 一次性装齐根 + agent-runner + web
# 或仅补根依赖：
npm install --no-audit --no-fund --registry=https://registry.npmmirror.com --allow-git=all
```

## 8. 经验沉淀 / 预防

- **构建链依赖保护要对称**：凡是会被"全新 clone 直接跑"的顶层目标（`desktop-pack-*` / `desktop-build` / `desktop-build-deps`），其涉及的每个子项目的 `node_modules` 都应有条件安装 guard，不能假设用户先跑过 `make install`。本次根目录缺 guard 导致 `tsc not found`，已补 `root-install`。
- **concurrently 输出会淹没真实错误**：`build:all` 用 `concurrently --group` 并发跑三路构建，后端 `tsc: not found` 的 stderr 被卷到顶部、被 web/agent-runner 的成功输出覆盖，造成"都成功却失败"的误导。调试此类整体失败时，应单独跑各子构建（`npm run build`）拿真实错误。
- **既存缺口（本 issue 未修，留作后续）**：`desktop-build-deps: ... build sync-types web-install` 里 `build`（`build:all` 内含 web 构建）排在 `web-install` **之前**。在 web 依赖也缺失的真正全新 clone 上，web 构建会先于 `web-install` 执行而失败（`Cannot find module 'zustand'`）。修复方向：把 `web-install`（及 agent-runner install）提到 `build` 之前。本次未一并改动，遵循外科手术式改动原则，单独 issue 处理。
- **巡检**：可在 CI 加一步 `rm -rf node_modules && make desktop-build-deps` 的烟测，确保打包链自给自足。本地可用：
  ```bash
  # 快速验证根依赖 guard 生效（不实际重装）
  make -n root-install
  ```
