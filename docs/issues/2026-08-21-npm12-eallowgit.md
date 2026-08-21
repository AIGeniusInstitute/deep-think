# npm 12 默认禁用 git 依赖与 install scripts 导致 make start-prod 失败

- 日期：2026-08-21
- 影响范围：`make install` / `make start` / `make start-prod` / `make dev`（所有触发 `npm install` 的路径）
- 触发条件：Node ≥ 26 / npm ≥ 12（本机 npm 12.0.2）且 `node_modules` 缺失或过期

## 1. 用户现象

执行 `make start-prod PORT=9999` 直接报错退出：

```
📦 依赖有更新，安装依赖...
npm install --registry=https://registry.npmmirror.com
npm error code EALLOWGIT
npm error Fetching packages of type "git" have been disabled
npm error Refusing to fetch "@whiskeysockets/eslint-config@github:whiskeysockets/eslint-config"
make[2]: *** [install] Error 1
```

## 2. 问题描述

npm 12 引入供应链安全默认值变更，两处同时踩坑：

1. **`allow-git = "none"`**：npm 12 起默认拒绝解析 `git:` 协议依赖。而 `@whiskeysockets/baileys`（WhatsApp 通道）把 **两个 GitHub git 依赖**声明在常规 `dependencies` 里：
   - `libsignal: "github:WhiskeySockets/libsignal-node"`
   - `@whiskeysockets/eslint-config: "github:whiskeysockets/eslint-config"`（上游打包 bug——eslint 配置被发布为运行时依赖）

   项目根 `package.json` 无 lock file，每次 `npm install` 都要重新解析整棵树，必然撞上 EALLOWGIT。

2. **`allow-scripts = [""]`**：npm 12 起依赖包的 install/postinstall 脚本默认被拦截，只打 warning 不失败。导致 `better-sqlite3`（prebuild-install 下载 native binding）**静默不构建**——install 看似成功，`node dist/index.js` 启动时才炸 `Could not locate the bindings file`。同样被拦的还有 `node-pty`、`protobufjs`、`esbuild`、`fsevents`、`@anthropic-ai/claude-code`（agent-runner）、`sharp`（web）。

附带环境问题（非代码 bug）：本机网络无法直连 Docker Hub（`registry-1.docker.io` 超时），`_ensure-docker-image` 拉取 `node:22-slim` 元数据超时导致镜像构建失败。

## 3. 根因

- npm 12.0 变更：`--allow-git <all|none|root>` 与 `--allow-scripts <pkg-list>` 安全模型，默认值 `allow-git=none`、`allow-scripts=[""]`（可用 `npm config ls -l | grep allow` 验证）。
- baileys 上游：https://github.com/WhiskeySockets/Baileys 的 `package.json` 将 eslint-config 与 libsignal 以 `github:` 引用放进 `dependencies`。
- Docker Hub 在当前网络不可达（`Head "https://registry-1.docker.io/v2/...": context deadline exceeded`）。

## 4. 复现路径

1. `rm -rf node_modules web/node_modules container/agent-runner/node_modules`
2. 用 npm ≥ 12 执行 `make install`
3. 第一步：根项目 `npm install` 报 `EALLOWGIT` 退出
4. 若手动加 `--allow-git=all` 绕过，install "成功" 但 `node_modules/better-sqlite3/build/Release/` 不存在，`node -e "require('better-sqlite3')"` 抛错

## 5. 诊断方法

```bash
# npm 版本与安全默认值
npm -v                                   # 12.0.2
npm config ls -l | grep -E 'allow-git|allow-scripts'

# baileys 的 git 依赖（上游打包 bug 证据）
npm view @whiskeysockets/baileys@6.17.16 dependencies --json | grep github

# install scripts 拦截记录
npm install-scripts ls

# native 模块是否真的构建了
ls node_modules/better-sqlite3/build/Release/
node -e "require('better-sqlite3')(':memory:').exec('select 1'); console.log('OK')"

# Docker Hub 连通性
docker pull node:22-slim   # context deadline exceeded 即中招
```

## 6. 修复方案

**Makefile**（根项目 install 增加 git 放行；子项目无 git 依赖，无需加）：

```diff
 install: ## 安装全部依赖并编译 agent-runner
-	$(PKG) install $(NPM_FLAGS)
+	@# --allow-git=all：npm 12 起默认禁用 git 依赖（EALLOWGIT），而 @whiskeysockets/baileys
+	@# 的 dependencies 里有 github:WhiskeySockets/libsignal-node 和
+	@# github:whiskeysockets/eslint-config（上游打包 bug）两个 git 依赖，必须显式放行
+	$(PKG) install $(NPM_FLAGS) --allow-git=all
```

**package.json × 3**（用 `npm install-scripts approve` 写入 `allowScripts` 白名单，只放行真正需要跑构建脚本的包）：

- 根：`better-sqlite3`、`node-pty`、`protobufjs`、`esbuild`、`fsevents`（npm 默认 pinned 到 `pkg@version`）
- `container/agent-runner`：`@anthropic-ai/claude-code`（**unpinned**——SDK 用 `"*"` 每日浮动版本，pin 住会在下次 `make update-sdk` 后失效再次被拦）
- `web`：`sharp`、`esbuild`、`fsevents`

批准后需 `npm rebuild <pkgs>` 让已安装但被跳过脚本的包补跑一次（`npm install` 对已存在的包不会重跑脚本）。

**环境侧（不入库）**：Docker Hub 不可达时经镜像源拉取基础镜像并 retag：

```bash
docker pull docker.m.daocloud.io/library/node:22-slim
docker tag docker.m.daocloud.io/library/node:22-slim node:22-slim
```

选型理由：不改 `.npmrc`（子项目各自有 package.json，`.npmrc` 的项目级作用域只认最近 package.json 所在目录，覆盖不到 web/ 和 agent-runner/）；不用 `--dangerously-allow-all-scripts`（放行面过大）；`allowScripts` 写进 package.json 可随仓库分发，团队所有人一次到位。

## 7. 处理卡住的状态

- install "成功"但 sqlite 缺 binding：`npm rebuild better-sqlite3` 补跑脚本即可，无需删 node_modules。
- Docker build 卡在 `load metadata for docker.io/library/node:22-slim`：先手动 pull+retag 基础镜像（见上），BuildKit 命中本地镜像后不再访问 registry。

## 8. 经验沉淀 / 预防

- npm 大版本升级（11 → 12）属于破坏性变更，升级 Node（本机 26.7.0 自带 npm 12）后第一件事跑 `make install` 验证。
- `npm install` 出现 `npm warn install-scripts ... blocked` 字样时**必须**核实 native 模块产物存在（`ls node_modules/<pkg>/build/Release/`），warning 不影响 exit code，最容易静默翻车。
- baileys 官方已更名 `baileys` 包（deprecated 警告），未来升级换官方包名可一并甩掉这两个 git 依赖。
- 弱网/受限网络环境下，Docker Hub 与 deb.debian.org 双慢是镜像构建时间的大头（本次 sandbox 镜像构建约 80 分钟），属预期行为，不要误判为构建挂死：用 `stat -f %m <log>` 看日志是否持续更新、`netstat -ib` 看收包速率。
