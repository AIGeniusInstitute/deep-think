# 2026-08-25 npm 12 安装限制（EALLOWREMOTE / EALLOWGIT）导致 make desktop-pack-mac 失败

## 1. 用户现象

执行 `make desktop-pack-mac` 时，`[web]` 和 `[agent-runner]` 两个子构建都成功（exit code 0），但最终报：

```
make: *** [build] Error 1
```

打包中止，没有产出 `.dmg`。从终端输出看不到任何 backend 的错误信息（concurrently 按组输出，backend 的报错被淹没或未展示）。

## 2. 问题描述

两层问题叠加：

1. **直接原因**：`make build`（`build:all`）中 backend 子任务执行 `npm run build` → `tsc`，但根目录 `node_modules` 是一个**悬空的符号链接**（指向 `../../node_modules`，即 `/Users/node_modules`，不存在），`tsc: command not found` → backend 构建失败 → `make build` 失败 → `desktop-pack-mac` 依赖链（`desktop-build-deps: build ...`）中断。web 和 agent-runner 各有独立 `node_modules`，所以它们不受影响。
   这个符号链接是被误提交进 git 的（commit `65765ff`，`git ls-files -s node_modules` 显示 mode 120000 symlink）。新 clone / 新 worktree 会自带这个悬空链接，而不是干净的"无 node_modules"状态。
2. **深层原因**：重装根目录依赖时被 npm 12 的新安全默认值拦截，无法完成安装：
   - `EALLOWREMOTE`: `Fetching packages of type "remote" have been disabled`（`zod-to-json-schema@https://registry.npmmirror.com/...`）
   - `EALLOWGIT`: `Fetching packages of type "git" have been disabled`（`@whiskeysockets/eslint-config@github:whiskeysockets/eslint-config`）

## 3. 根因

npm 12 起引入了 `allow-remote` / `allow-git` / `allow-file` 等安装来源门禁，默认值均为 `none`：

- **EALLOWREMOTE**：本机 `package-lock.json` 是用 npmmirror 源生成的——全部 553 个依赖的 `resolved` 都 pin 在 `registry.npmmirror.com`，而 npm 配置的 registry 是 `registry.npmjs.org`。tarball host 与配置 registry 不一致时，npm 12 把它当作 "remote tarball" 拒绝拉取。npm 官方文档明确说明：*"If your registry serves tarballs from a different host, set replace-registry-host or override this setting."*
  依据：https://docs.npmjs.com/cli/v12/using-npm/config#allow-remote （本地 npm 12.0.2 安装内文档同文）
- **EALLOWGIT**：运行时依赖 `@whiskeysockets/baileys`（WhatsApp 通道用）在其 `dependencies` 里声明了 `@whiskeysockets/eslint-config: github:whiskeysockets/eslint-config` 这个 git 依赖（上游打包失误，把 eslint 配置当正式依赖发布）。npm 12 默认拒绝一切 git 依赖（`allow-git=none`），而 `allow-git` 只接受 `all/none/root`，传递依赖只能用 `all` 放行。

注意：`package-lock.json` 在本仓库是 gitignored（机器本地文件），所以每台新机器/新 worktree 首次 `npm install` 都会撞上这两个门禁。

## 4. 复现路径

前置：npm ≥ 12（`npm --version` 确认），registry 为默认 `registry.npmjs.org`。

1. 删除根目录 `node_modules`（或在新 clone / 新 worktree 中，lockfile 为本机文件不存在时会全新解析）
2. `npm install`
   - 有 npmmirror 版 lockfile：报 `EALLOWREMOTE`（zod-to-json-schema）
   - 无 lockfile（全新解析）：报 `EALLOWGIT`（@whiskeysockets/eslint-config）
3. `make desktop-pack-mac` → `make build` → backend `tsc: command not found` → `Error 1`

## 5. 诊断方法

```bash
# 看是哪个子构建挂了（backend 的报错在 [backend] 前缀下）
npm run build 2>&1 | tail -5
# → sh: tsc: command not found

# 确认 npm 版本与门禁配置
npm --version                          # 12.0.2
npm config get allow-remote            # none
npm config get allow-git               # none

# 确认 lockfile 的 registry 指向
grep -c 'registry.npmjs.org' package-lock.json    # 0
grep -c 'registry.npmmirror.com' package-lock.json # 553

# 找出是谁引入了 git 依赖
grep -n -B3 'github:whiskeysockets' package-lock.json
# → @whiskeysockets/baileys 的 dependencies
```

## 6. 修复方案

在四个 npm 项目目录各新增项目级 `.npmrc`（随仓库提交，对所有构建环境生效），并删除被误提交的 `node_modules` 符号链接（`git rm --cached node_modules`，该路径在 `.gitignore` 中，删除后恢复为正常的本地未跟踪目录）。

根目录 `.npmrc`（额外需要放行 baileys 的 git 依赖）：

```diff
+# lockfile 全部 pin 在 npmmirror（npm 12 起非 registry host 的 tarball 会被 allow-remote=none 拦截）
+registry=https://registry.npmmirror.com
+# @whiskeysockets/baileys 把 github:whiskeysockets/eslint-config 声明为正式依赖（npm 12 起默认拒绝 git 依赖）
+allow-git=all
```

`web/.npmrc`、`container/agent-runner/.npmrc`、`desktop/.npmrc`（只需 registry 一行）：

```diff
+# lockfile pin 在 npmmirror（npm 12 起非 registry host 的 tarball 会被 allow-remote=none 拦截）
+registry=https://registry.npmmirror.com
```

为什么子项目也要一份：npm 的项目级 `.npmrc` 只读取「当前操作的 package.json 所在目录」的 `.npmrc`，不会向上级联到 monorepo 根（实证：根 `.npmrc` 存在时 `cd web && npm install` 仍报 EALLOWREMOTE）。而 `make desktop-pack-mac` 的依赖链会对 web / agent-runner / desktop 各执行一次 `npm install`，这三个子项目的 lockfile 同样 100% pin npmmirror，npm 12 下无一幸免。

选型理由：

- **`registry=npmmirror`** 而不是 `replace-registry-host`：lockfile 已 100% pin npmmirror，直接对齐 registry 后这些 tarball 被 npm 12 识别为 "registry-mediated"，走正常安装路径；且国内网络拉取快。备选方案 `replace-registry-host=registry.npmmirror.com`（把 npmmirror URL 重写到 npmjs.org）也可行，但国内访问 npmjs.org 慢且不稳定。
- **`allow-git=all`** 而不是 `=root`：这个 git 依赖是 baileys 的传递依赖而非根依赖，`root` 档位放行不了；npm 的 `allow-git` 不支持按包名白名单。风险可控——lockfile 里 pin 了精确 commit（`#299e8389...`），可复现。
- 不改 `package-lock.json`（机器本地文件，改了也不入库）；不改全局 `~/.npmrc`（只影响本机，其他机器/worktree 仍会挂）。

验证：根目录 `npm install` 成功（553 packages added）→ `npm run build`（tsc）通过 → `make desktop-pack-mac` 全链路通过并产出 dmg。

## 7. 处理卡住的状态

如果 `make desktop-pack-mac` 已在半途失败：只需重跑 `make desktop-pack-mac`，Makefile 各步骤幂等（web/node_modules 存在则跳过安装）。若根目录 `node_modules` 出现"非目录残留"（本例的实际诱因，`npm install` 时会提示 `Removing non-directory .../node_modules` 后自动清理），无需手工处理，npm 会自行移除后重装。

## 8. 经验沉淀 / 预防

- **npm 12 破坏性默认值**：`allow-remote` / `allow-git` / `allow-file` 默认 `none`，任何 lockfile 里带非 registry-host tarball 或 git 依赖的项目升级 npm 12 后 `npm install` 都会挂。升级 npm 前先 `grep '"resolved": "http' package-lock.json | grep -v <你的 registry> | head` 自查。
- **lockfile 的 registry 应与项目 `.npmrc` 声明一致**：本仓库 lockfile 全量 pin npmmirror 却没有在仓库里声明 registry，属于隐式依赖"开发者本机配置"。这次用项目 `.npmrc` 显式固化，新机器 / CI / worktree 首装不再依赖个人环境。
- **上游打包失误要靠下游门禁放行**：`@whiskeysockets/baileys` 把 eslint 配置发布成运行时依赖是上游问题，等它修复前 `allow-git=all` 是必要妥协；若未来 baileys 迁移到新包名 `baileys`（deprecate 提示），可一并移除该配置。
- **巡检建议**：CI 或 `make install` 前置检查可用 `node -e "const l=require('./package-lock.json');const bad=Object.values(l.packages).filter(p=>p.resolved&&p.resolved.includes('git+'));console.log(bad.length)"` 列出 git 依赖，避免静默漂移。
