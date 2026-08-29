.PHONY: dev dev-backend dev-web dev-isolated dev-start dev-stop build build-backend build-web start start-prod \
       typecheck typecheck-backend typecheck-web typecheck-agent-runner \
       format format-check install install-host-tools clean reset-init migrate-data update-sdk ensure-latest-sdk sync-types \
       backup restore help _ensure-docker-image _ensure-sandbox-image \
       sandbox-build logs status stop stop-prod \
       _check-sync _build-web-if-stale _build-ar-if-stale _build-backend-if-stale \
       _start-pm2 _start-direct \
       admin-create admin-passwd admin-set \
       desktop-install web-install desktop-build-deps desktop-build desktop-fetch-node \
       desktop-rebuild-natives desktop-dev desktop-pack-mac desktop-pack-mac-x64 \
       desktop-pack-mac-all desktop-pack-win desktop-pack-linux

# ─── Runtime ────────────────────────────────────────────────
# 本项目只用原生 Node 工具链运行（npm / npx / tsx / node），不使用 bun。
# 原因：主服务的 WebSocket 走 `ws` 包 + @hono/node-server 的 `server.on('upgrade')`
# 握手，该模式在 bun 的 HTTP server 下不触发，会导致 WS 全部握手失败（HTTP/接口正常，
# 但前端实时流式卡片/通知全失效，飞书等 stdout 通道不受影响）。
PORT    ?= $(or $(WEB_PORT),9898)
PKG     := npm
RUN     := npx
RUNNER  := npx tsx src/index.ts
# 国内 npm 镜像源：编译/构建/打包相关命令统一追加，加速国内依赖安装与 SDK 更新
NPM_FLAGS := --registry=https://registry.npmmirror.com

# ─── Development ─────────────────────────────────────────────

# 单行 shell 片段：运行 dev 命令前暂停 pm2 中的 deepthink，退出（正常/中断/终止）时恢复。
# 用法示例：@$(PM2_GUARD); <command>
PM2_GUARD = PM2_WAS_RUNNING=0; \
	if command -v pm2 >/dev/null 2>&1 && pm2 show deepthink 2>/dev/null | grep -q 'online'; then \
	  PM2_WAS_RUNNING=1; \
	  echo "⏸  暂停 pm2 deepthink..."; \
	  pm2 stop deepthink; \
	fi; \
	trap "if [ \"$$PM2_WAS_RUNNING\" = '1' ]; then echo '▶  恢复 pm2 deepthink...'; pm2 start deepthink; fi" EXIT INT TERM

dev: ## 启动前后端（首次自动安装依赖和构建容器镜像）；自动暂停 pm2，退出后恢复
	@if [ ! -d node_modules ] || [ package.json -nt node_modules ] || [ web/package.json -nt web/node_modules ] || [ container/agent-runner/package.json -nt container/agent-runner/node_modules ]; then echo "📦 依赖有更新，安装依赖..."; $(MAKE) install; fi
	@$(MAKE) _ensure-docker-image
	@$(MAKE) _ensure-sandbox-image
	@$(MAKE) _ensure-native-abi
	@$(PKG) --prefix container/agent-runner run build $(NPM_FLAGS) --silent 2>/dev/null || $(PKG) --prefix container/agent-runner run build $(NPM_FLAGS)
	@$(PM2_GUARD); \
	echo "🚀 使用 $(PKG) 启动..."; \
	$(PKG) run dev:all

# 隔离 dev：独立端口 + 独立数据目录，与生产实例（/opt/DeepThink 桌面 app 或 pm2）并存，
# 不抢端口、不共享 SQLite、不触发 PM2_GUARD。适合在 DeepThink agent 会话里跑（agent
# shell 会继承生产实例的 WEB_PORT/DEEPTHINK_DATA_DIR，必须显式覆盖，否则会撞生产库）。
# 用法: make dev-isolated
#       make dev-isolated ISOLATED_PORT=9899 ISOLATED_DATA_DIR=/tmp/dt
ISOLATED_PORT ?= 9898
ISOLATED_DATA_DIR ?= /tmp/deepthink-dev-$(ISOLATED_PORT)

dev-isolated: ## 隔离跑 dev（独立端口+独立数据目录，不碰生产实例；可覆盖 ISOLATED_PORT/ISOLATED_DATA_DIR）
	@if [ ! -d node_modules ] || [ package.json -nt node_modules ]; then echo "📦 依赖有更新，安装依赖..."; $(MAKE) install; fi
	@$(MAKE) _ensure-native-abi
	@$(PKG) --prefix container/agent-runner run build $(NPM_FLAGS) --silent 2>/dev/null || $(PKG) --prefix container/agent-runner run build $(NPM_FLAGS)
	@mkdir -p $(ISOLATED_DATA_DIR)
	@echo "🚀 隔离 dev: 后端 :$(ISOLATED_PORT)  数据目录 $(ISOLATED_DATA_DIR)"
	@echo "   Web UI: http://127.0.0.1:5173 (vite) → 代理到后端 :$(ISOLATED_PORT)"
	@echo "   首次访问走 Setup 注册首个 admin。Ctrl-C 退出。"
	WEB_PORT=$(ISOLATED_PORT) \
	DEEPTHINK_DATA_DIR=$(ISOLATED_DATA_DIR) \
	VITE_API_PROXY_TARGET=http://127.0.0.1:$(ISOLATED_PORT) \
	VITE_WS_PROXY_TARGET=ws://127.0.0.1:$(ISOLATED_PORT) \
	$(PKG) run dev:all

dev-backend: ## 仅启动后端（tsx 直跑 TS）；自动暂停 pm2，退出后恢复
	@$(MAKE) _ensure-native-abi; $(PM2_GUARD); $(RUNNER)

dev-web: ## 仅启动前端
	cd web && $(PKG) run dev

# 后台 dev：把 `dev`（前后端）放到独立 session 里后台跑，日志落盘、PID/进程组号
# 写入 pidfile，便于 make dev-stop 整组杀掉。与前台 `make dev` 行为一致：启动前
# 暂停 pm2 deepthink（避免抢端口 $(PORT)），停止时再恢复。
# 用法：
#   make dev-start          # 后台启动，日志 → $(DEV_LOG)
#   make dev-stop           # 停止后台 dev 并恢复 pm2
#   make dev-start DEV_LOG=/tmp/x.log DEV_PIDFILE=/tmp/x.pid  # 覆盖路径
DEV_LOG     ?= /tmp/deepthink-dev.log
DEV_PIDFILE ?= /tmp/deepthink-dev.pid
DEV_PM2_FLAG ?= /tmp/deepthink-dev.pm2
# dev 实际占用的端口：后端 = $(PORT)（WEB_PORT 或默认 9898），前端 = vite 默认 5173。
# dev-stop 按这两个端口做兜底清理（见 dev-stop 注释）。
DEV_WEB_PORT ?= 5173

dev-start: ## 后台启动 dev（前后端，日志 → $(DEV_LOG)）；自动暂停 pm2 deepthink，make dev-stop 恢复
	@if [ -f $(DEV_PIDFILE) ] && kill -0 $$(cat $(DEV_PIDFILE) 2>/dev/null) 2>/dev/null; then \
	  echo "⚠️  后台 dev 已在运行（pgid $$(cat $(DEV_PIDFILE))），如需重启先 make dev-stop"; exit 1; \
	fi
	@if [ ! -d node_modules ] || [ package.json -nt node_modules ] || [ web/package.json -nt web/node_modules ] || [ container/agent-runner/package.json -nt container/agent-runner/node_modules ]; then echo "📦 依赖有更新，安装依赖..."; $(MAKE) install; fi
	@$(MAKE) _ensure-docker-image
	@$(MAKE) _ensure-sandbox-image
	@$(MAKE) _ensure-native-abi
	@$(PKG) --prefix container/agent-runner run build $(NPM_FLAGS) --silent 2>/dev/null || $(PKG) --prefix container/agent-runner run build $(NPM_FLAGS)
	@if command -v pm2 >/dev/null 2>&1 && pm2 show deepthink 2>/dev/null | grep -q 'online'; then \
	  echo "⏸  暂停 pm2 deepthink（make dev-stop 时恢复）..."; pm2 stop deepthink; echo "1" > $(DEV_PM2_FLAG); \
	else echo "0" > $(DEV_PM2_FLAG); fi
	@echo "🚀 后台启动 dev（日志 $(DEV_LOG)）..."
	@setsid $(PKG) run dev:all > $(DEV_LOG) 2>&1 & echo $$! > $(DEV_PIDFILE)
	@sleep 2
	@if kill -0 $$(cat $(DEV_PIDFILE)) 2>/dev/null; then \
	  echo "✅ dev 已后台启动 (pgid $$(cat $(DEV_PIDFILE)))"; \
	  echo "   Web UI: http://127.0.0.1:5173   后端: http://127.0.0.1:$(PORT)"; \
	  echo "   实时日志: tail -f $(DEV_LOG)"; \
	  echo "   停止: make dev-stop"; \
	else echo "❌ dev 启动失败，查看日志: $(DEV_LOG)"; tail -20 $(DEV_LOG); rm -f $(DEV_PIDFILE); exit 1; fi

dev-stop: ## 停止后台 dev（杀进程组 + 按端口兜底）并恢复 pm2 deepthink（如由 dev-start 暂停）
	@if [ -f $(DEV_PIDFILE) ] && kill -0 $$(cat $(DEV_PIDFILE) 2>/dev/null) 2>/dev/null; then \
	  PGID=$$(cat $(DEV_PIDFILE)); \
	  echo "⏳ 停止后台 dev（进程组 $$PGID）..."; \
	  kill -TERM -$$PGID 2>/dev/null || kill -TERM $$PGID 2>/dev/null; \
	  i=0; while [ $$i -lt 5 ] && kill -0 $$PGID 2>/dev/null; do sleep 1; i=$$((i+1)); done; \
	  if kill -0 $$PGID 2>/dev/null; then \
	    echo "⚠️  SIGTERM 后仍存活，升级为 SIGKILL..."; kill -KILL -$$PGID 2>/dev/null || kill -KILL $$PGID 2>/dev/null; sleep 1; \
	  fi; \
	  rm -f $(DEV_PIDFILE); \
	  echo "✅ 已停止后台 dev进程组"; \
	else \
	  echo "⚠️  后台 dev 未运行（无 $(DEV_PIDFILE) 或进程已退出）"; rm -f $(DEV_PIDFILE) 2>/dev/null; \
	fi
	@# 端口兜底：dev:all 走 concurrently，主进程崩溃后子进程（vite/tsx）可能脱离进程组
	@# 成为孤儿继续占用端口，此时 pidfile 已失效、进程组已不可达。按 dev 实际占用的端口
	@# （后端 $(PORT)、前端 $(DEV_WEB_PORT)）杀掉仍在 LISTEN 的残留进程。只杀 TCP LISTEN
	@# 进程（项目规约：禁止 `lsof -ti:PORT | xargs kill`，会误杀 Docker 等连接进程）。
	@for p in $(PORT) $(DEV_WEB_PORT); do \
	  if lsof -ti:$$p -sTCP:LISTEN >/dev/null 2>&1; then \
	    pids=$$(lsof -ti:$$p -sTCP:LISTEN); \
	    echo "🧹 端口 $$p 仍有残留监听 (pid $$pids)，发送 SIGTERM..."; \
	    kill $$pids 2>/dev/null; \
	    j=0; while [ $$j -lt 3 ] && lsof -ti:$$p -sTCP:LISTEN >/dev/null 2>&1; do sleep 1; j=$$((j+1)); done; \
	    if lsof -ti:$$p -sTCP:LISTEN >/dev/null 2>&1; then \
	      echo "⚠️  SIGTERM 后端口 $$p 仍被占用，升级为 SIGKILL..."; kill -9 $$pids 2>/dev/null; sleep 1; \
	    fi; \
	    if lsof -ti:$$p -sTCP:LISTEN >/dev/null 2>&1; then \
	      echo "❌ 端口 $$p 仍被占用，请手动处理：lsof -ti:$$p -sTCP:LISTEN | xargs ps -fp"; \
	    else \
	      echo "✅ 端口 $$p 已释放"; \
	    fi; \
	  fi; \
	done
	@if [ -f $(DEV_PM2_FLAG) ] && [ "$$(cat $(DEV_PM2_FLAG) 2>/dev/null)" = "1" ]; then \
	  echo "▶  恢复 pm2 deepthink..."; pm2 start deepthink >/dev/null 2>&1 || true; \
	  rm -f $(DEV_PM2_FLAG); \
	fi

# ─── Build ───────────────────────────────────────────────────

build: sync-types ## 编译前后端及 agent-runner
	$(PKG) run build:all $(NPM_FLAGS)
	@touch .build-sentinel

build-backend: ## 仅编译后端
	$(PKG) run build $(NPM_FLAGS)

build-web: ## 仅编译前端
	cd web && $(PKG) run build $(NPM_FLAGS)

# ─── Production ──────────────────────────────────────────────

start: ensure-latest-sdk ## 一键启动生产环境（pm2 托管时自动走 pm2 restart；否则前台阻塞）。可用 PORT=xxxx 指定端口
	@# pm2 注册过 deepthink 就路由到 pm2，避免裸跑和 pm2 抢端口
	@if command -v pm2 >/dev/null 2>&1 && pm2 describe deepthink >/dev/null 2>&1; then \
	  $(MAKE) --no-print-directory _start-pm2; \
	else \
	  $(MAKE) --no-print-directory _start-direct; \
	fi

_start-pm2: ## (内部) pm2 托管模式：build 后 pm2 restart
	@echo "🔄 检测到 pm2 托管 deepthink，改走 pm2 restart（端口 $(PORT)）"
	@$(MAKE) _check-sync _build-web-if-stale _build-ar-if-stale _build-backend-if-stale _ensure-native-abi
	@$(MAKE) _ensure-sandbox-image
	@WEB_PORT=$(PORT) pm2 restart deepthink --update-env
	@sleep 2
	@pm2 logs deepthink --lines 20 --nostream || true
	@echo "✅ 启动完成，查看实时日志：pm2 logs deepthink"

_start-direct: ## (内部) 裸跑模式（无 pm2 或未注册）
	@# 检查端口是否被占用
	@if lsof -ti:$(PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
	  echo "❌ 端口 $(PORT) 已被占用，请先停掉旧进程：make stop"; \
	  lsof -ti:$(PORT) -sTCP:LISTEN | xargs ps -fp 2>/dev/null | tail -1; \
	  exit 1; \
	fi
	@if [ ! -d node_modules ] || [ package.json -nt node_modules ] || [ web/package.json -nt web/node_modules ] || [ container/agent-runner/package.json -nt container/agent-runner/node_modules ]; then echo "📦 依赖有更新，安装依赖..."; $(MAKE) install; fi
	@$(MAKE) _ensure-docker-image
	@$(MAKE) _ensure-sandbox-image
	@$(MAKE) _check-sync
	@$(MAKE) _build-backend-if-stale
	@$(MAKE) _build-web-if-stale
	@$(MAKE) _build-ar-if-stale
	@$(MAKE) _ensure-native-abi
	@echo "🟢 Node 模式：运行编译后的 dist/index.js（端口 $(PORT)，本项目不使用 bun，WebSocket 需要 node）"
	WEB_PORT=$(PORT) node dist/index.js

# start-prod：以独立数据目录启动隔离生产实例，data dir = ~/.deepthink-<PORT>。
# 用法：
#   make start-prod PORT=9999          # 必填，data dir = ~/.deepthink-9999
# 说明：强制走非-pm2 直跑路径（pm2 的 deepthink 是单进程托管，无法多开）。
# 独立 data dir → 独立 DB / 用户表 / user-im 飞书配置 / 会话，互不影响。
# 与默认实例（make start，~/.deepthink/data）及其它端口的实例完全隔离。
start-prod: ## 以隔离 data dir（~/.deepthink-<PORT>）启动生产实例（PORT 必填，不走 pm2）
	@if [ "$(origin PORT)" != "command line" ]; then echo "❌ 用法: make start-prod PORT=9999"; exit 1; fi
	@export DEEPTHINK_DATA_DIR="$(HOME)/.deepthink-$(PORT)"; \
	  echo ">> start-prod: PORT=$(PORT) DATA_DIR=$$DEEPTHINK_DATA_DIR"; \
	  $(MAKE) --no-print-directory _start-direct PORT=$(PORT)

# ─── Internal build checks ────────────────────────────────────

_check-sync: ## (内部) 检测 shared/ 类型变更并同步
	@NEED_SYNC=0; \
	for target in src/stream-event.types.ts web/src/stream-event.types.ts container/agent-runner/src/stream-event.types.ts src/image-detector.ts container/agent-runner/src/image-detector.ts src/channel-prefixes.ts container/agent-runner/src/channel-prefixes.ts; do \
	  if [ ! -f "$$target" ] || [ -n "$$(find shared/ -newer "$$target" -name '*.ts' 2>/dev/null | head -1)" ]; then NEED_SYNC=1; break; fi; \
	done; \
	if [ "$$NEED_SYNC" = "1" ]; then echo "🔄 检测到 shared/ 类型变更，同步类型..."; $(MAKE) sync-types; fi

_build-web-if-stale: ## (内部) 前端变更时重新编译
	@NEED_WEB=0; \
	if [ ! -f web/dist/index.html ]; then NEED_WEB=1; \
	else \
	  for f in web/package.json web/vite.config.ts web/index.html web/tsconfig.json; do \
	    if [ -f "$$f" ] && [ "$$f" -nt web/dist/index.html ]; then NEED_WEB=1; break; fi; \
	  done; \
	  if [ "$$NEED_WEB" = "0" ] && [ -n "$$(find web/src/ -newer web/dist/index.html \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) 2>/dev/null | head -1)" ]; then NEED_WEB=1; fi; \
	fi; \
	if [ "$$NEED_WEB" = "1" ]; then echo "🔨 检测到前端变更，重新编译前端..."; cd web && $(PKG) run build $(NPM_FLAGS); else echo "✅ 前端无变更，跳过编译"; fi

_build-ar-if-stale: ## (内部) agent-runner 变更时重新编译
	@NEED_AR=0; \
	if [ ! -f container/agent-runner/dist/.tsbuildinfo ]; then NEED_AR=1; \
	else \
	  for f in container/agent-runner/package.json container/agent-runner/tsconfig.json; do \
	    if [ -f "$$f" ] && [ "$$f" -nt container/agent-runner/dist/.tsbuildinfo ]; then NEED_AR=1; break; fi; \
	  done; \
	  if [ "$$NEED_AR" = "0" ] && [ -n "$$(find container/agent-runner/src/ -newer container/agent-runner/dist/.tsbuildinfo -name '*.ts' 2>/dev/null | head -1)" ]; then NEED_AR=1; fi; \
	fi; \
	if [ "$$NEED_AR" = "1" ]; then echo "🔨 检测到 agent-runner 变更，重新编译..."; cd container/agent-runner && $(PKG) run build $(NPM_FLAGS); else echo "✅ agent-runner 无变更，跳过编译"; fi

_build-backend-if-stale: ## (内部) 后端变更时重新编译（Node 模式）
	@NEED_BACKEND=0; \
	if [ ! -f dist/index.js ]; then NEED_BACKEND=1; \
	else \
	  for f in package.json tsconfig.json; do \
	    if [ "$$f" -nt dist/index.js ]; then NEED_BACKEND=1; break; fi; \
	  done; \
	  if [ "$$NEED_BACKEND" = "0" ] && [ -n "$$(find src/ -newer dist/index.js -name '*.ts' 2>/dev/null | head -1)" ]; then NEED_BACKEND=1; fi; \
	fi; \
	if [ "$$NEED_BACKEND" = "1" ]; then echo "🔨 检测到后端源码变更，重新编译后端..."; $(PKG) run build $(NPM_FLAGS); else echo "✅ 后端无变更，跳过编译"; fi

logs: ## 实时查看日志（需配合手动后台运行：make start > /tmp/deepthink.log 2>&1 &）
	@tail -f /tmp/deepthink.log

stop: ## 停止服务（pm2 托管时走 pm2 stop，否则杀端口监听进程）
	@if command -v pm2 >/dev/null 2>&1 && pm2 describe deepthink >/dev/null 2>&1; then \
	  pm2 stop deepthink >/dev/null && echo "✅ 已 pm2 stop deepthink（需再起用 pm2 start deepthink）"; \
	else \
	  $(MAKE) --no-print-directory _stop-port PORT=$(PORT); \
	fi

# _stop-port：(内部) SIGTERM -> 轮询验证是否真死 -> 升级 SIGKILL。
# 必要性：node 在 src/index.ts 捕获 SIGTERM 做优雅关闭（最长 30s）；若进程
# 处于 job-control stopped 状态（T，例如前台 make start 后 Ctrl+Z），被捕获的
# SIGTERM 会一直挂在 pending 队列无法投递，进程不死仍占端口。SIGKILL 不可被
# 捕获/阻塞/忽略，对 stopped 进程也生效，作为兜底。
# 安全：SIGKILL 只作用于 SIGTERM 时捕获的 pid，绝不重新 lsof 取 pid 再 kill，
# 避免误杀 SIGTERM 期间新占用端口的无关进程（如 Docker proxy）。
_stop-port: ## (内部) 按端口停止：SIGTERM -> 验证 -> SIGKILL 升级
	@if lsof -ti:$(PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
	  pids=$$(lsof -ti:$(PORT) -sTCP:LISTEN); \
	  echo "⏳ 端口 $(PORT) 被 pid $$pids 占用，发送 SIGTERM…"; \
	  kill $$pids 2>/dev/null; \
	  i=0; while [ $$i -lt 5 ] && lsof -ti:$(PORT) -sTCP:LISTEN >/dev/null 2>&1; do \
	    sleep 1; i=$$((i+1)); \
	  done; \
	  if lsof -ti:$(PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
	    echo "⚠️  SIGTERM 后端口 $(PORT) 仍被占用（进程可能处于 stopped 状态或优雅关闭卡住），升级为 SIGKILL…"; \
	    kill -9 $$pids 2>/dev/null; sleep 1; \
	  fi; \
	  if lsof -ti:$(PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
	    echo "❌ 端口 $(PORT) 仍被占用，请手动处理：lsof -ti:$(PORT) -sTCP:LISTEN | xargs ps -fp"; exit 1; \
	  else \
	    echo "✅ 已停止 DeepThink (端口 $(PORT))"; \
	  fi; \
	else \
	  echo "⚠️  端口 $(PORT) 未被占用，无需停止"; \
	fi

# stop-prod：按端口停止隔离实例（杀该端口监听进程，不走 pm2）。
# 用法：make stop-prod PORT=9999
stop-prod: ## 停止指定端口的隔离实例（PORT 必填，杀该端口监听进程）
	@if [ "$(origin PORT)" != "command line" ]; then echo "❌ 用法: make stop-prod PORT=9999"; exit 1; fi
	@$(MAKE) --no-print-directory _stop-port PORT=$(PORT)

status: ## 查看服务运行状态
	@echo "=== DeepThink 服务状态 ==="
	@if command -v pm2 >/dev/null 2>&1 && pm2 describe deepthink >/dev/null 2>&1; then \
	  echo "🔧 pm2 托管模式（重启请用 pm2 restart deepthink，勿混用 make start/stop）"; \
	  pm2 describe deepthink 2>/dev/null | grep -E "status|pid|uptime|restarts" | head -4 | sed 's/^/   /'; \
	fi
	@if lsof -ti:$(PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
	  echo "✅ 后端进程: 运行中 (端口 $(PORT))"; \
	  curl -s http://localhost:$(PORT)/api/health 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"   健康状态: {d.get('status','unknown')}\")" 2>/dev/null || echo "   健康状态: 无法获取"; \
	else \
	  echo "❌ 后端进程: 未运行 (端口 $(PORT) 未占用)"; \
	fi
	@echo ""
	@echo "=== 日志文件 ==="
	@if [ -f /tmp/deepthink.log ]; then \
	  echo "✅ /tmp/deepthink.log 存在 ($(wc -l < /tmp/deepthink.log) 行)"; \
	  echo "   最近 3 行:"; \
	  tail -3 /tmp/deepthink.log | sed 's/^/   /'; \
	else \
	  echo "⚠️  /tmp/deepthink.log 不存在（未用后台模式启动）"; \
	fi
	@echo ""
	@echo "=== Docker 容器 ==="
	@docker ps --filter "name=deepthink" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || echo "   Docker 未运行或无 DeepThink 容器"

# ─── Quality ─────────────────────────────────────────────────

typecheck: sync-types typecheck-backend typecheck-web typecheck-agent-runner ## 全量类型检查
	@./scripts/check-stream-event-sync.sh
	@./scripts/check-agent-runner-prompts.sh

typecheck-backend:
	$(RUN) tsc --noEmit

typecheck-web:
	cd web && $(RUN) tsc --noEmit

typecheck-agent-runner:
	cd container/agent-runner && $(RUN) tsc --noEmit

test: ## 运行单元测试
	$(RUN) vitest run

format: ## 格式化代码
	$(PKG) run format

format-check: ## 检查代码格式
	$(PKG) run format:check

# ─── Docker Image ─────────────────────────────────────────────

# Docker 镜像源文件：Dockerfile、entrypoint.sh、agent-runner 源码和运行时 prompts
DOCKER_SRC := container/Dockerfile container/entrypoint.sh $(wildcard container/agent-runner/src/*.ts) $(shell find container/agent-runner/prompts -type f 2>/dev/null)

_ensure-docker-image: ## (内部) 检测 Docker 镜像是否需要构建/重建
	@if command -v docker >/dev/null 2>&1; then \
	  if ! docker info >/dev/null 2>&1; then \
	    if docker version 2>&1 | grep -q 'too old'; then \
	      echo "❌ docker CLI 无法与 daemon 通信（常见原因：客户端 API 版本过旧，被 daemon 拒绝）。"; \
	      echo "   诊断：docker version  —— 若报 'client version X is too old' 即命中此问题"; \
	      echo "   修复：见 docs/issues/2026-07-18-docker-cli-too-old.md §6.1（用现代 docker CLI 顶掉旧版）"; \
	      exit 1; \
	    fi; \
	    echo "⚠️ Docker daemon 未运行，跳过镜像检查（admin 宿主机模式不受影响；member 容器模式需启动 Docker 后重新 make）"; \
	    exit 0; \
	  fi; \
	  if ! docker image inspect deepthink-agent:latest >/dev/null 2>&1; then \
	    echo "🐳 Docker 镜像不存在，正在构建..."; \
	    ./container/build.sh; \
	  elif [ ! -f .docker-build-sentinel ]; then \
	    echo "🐳 Docker 镜像 sentinel 缺失，正在重建..."; \
	    ./container/build.sh; \
	  else \
	    STALE=0; \
	    for f in $(DOCKER_SRC); do \
	      if [ "$$f" -nt .docker-build-sentinel ]; then STALE=1; break; fi; \
	    done; \
	    if [ "$$STALE" = "1" ]; then \
	      echo "🐳 检测到容器源码变更，正在重建 Docker 镜像..."; \
	      ./container/build.sh; \
	    else \
	      echo "✅ Docker 镜像无需重建"; \
	    fi; \
	  fi; \
	fi

# ─── Sandbox Docker Image ────────────────────────────────────

# 沙箱镜像源文件：Dockerfile、entry.sh、seccomp-profile.json
SANDBOX_SRC := container/sandbox/Dockerfile container/sandbox/entry.sh container/sandbox/seccomp-profile.json

sandbox-build: ## 构建沙箱镜像 deepthink-sandbox:latest（用于代码执行 + 浏览器自动化）
	@./container/sandbox/build.sh
	@touch .sandbox-docker-build-sentinel

_ensure-sandbox-image: ## (内部) 检测沙箱镜像是否需要构建/重建
	@if command -v docker >/dev/null 2>&1; then \
	  if ! docker info >/dev/null 2>&1; then \
	    echo "⚠️ Docker daemon 未运行，跳过沙箱镜像检查（代码执行/浏览器自动化沙箱将不可用）"; \
	    exit 0; \
	  fi; \
	  if ! docker image inspect deepthink-sandbox:latest >/dev/null 2>&1; then \
	    echo "🐳 沙箱镜像不存在，正在构建..."; \
	    $(MAKE) sandbox-build; \
	  elif [ ! -f .sandbox-docker-build-sentinel ]; then \
	    echo "🐳 沙箱镜像 sentinel 缺失，正在重建..."; \
	    $(MAKE) sandbox-build; \
	  else \
	    STALE=0; \
	    for f in $(SANDBOX_SRC); do \
	      if [ "$$f" -nt .sandbox-docker-build-sentinel ]; then STALE=1; break; fi; \
	    done; \
	    if [ "$$STALE" = "1" ]; then \
	      echo "🐳 检测到沙箱源码变更，正在重建沙箱镜像..."; \
	      $(MAKE) sandbox-build; \
	    else \
	      echo "✅ 沙箱镜像无需重建"; \
	    fi; \
	  fi; \
	fi

# ─── Shared Types ────────────────────────────────────────────

sync-types: ## 同步 shared/ 下的类型定义到各子项目
	@./scripts/sync-stream-event.sh

# ─── SDK ─────────────────────────────────────────────────────

update-sdk: ## 更新 agent-runner + 主服务的 Claude Agent SDK 到最新版本
	cd container/agent-runner && $(PKG) update @anthropic-ai/claude-agent-sdk $(NPM_FLAGS) && $(PKG) run build $(NPM_FLAGS)
	$(PKG) update @anthropic-ai/claude-agent-sdk $(NPM_FLAGS)
	@# npm update 会将 "*" 回写为具体版本，还原它（agent-runner + 主服务）
	@# sed -i.bak ... && rm -f .bak：GNU sed 和 BSD sed 都支持，跨平台一致
	@sed -i.bak 's/"@anthropic-ai\/claude-agent-sdk": "[^"]*"/"@anthropic-ai\/claude-agent-sdk": "*"/' container/agent-runner/package.json && rm -f container/agent-runner/package.json.bak
	@sed -i.bak 's/"@anthropic-ai\/claude-agent-sdk": "[^"]*"/"@anthropic-ai\/claude-agent-sdk": "*"/' package.json && rm -f package.json.bak
	@echo "SDK updated. Run 'make typecheck' to verify."

ensure-latest-sdk: ## 启动前自动检测并更新 SDK（agent-runner + 主服务，有新版才更新）
	@LOCAL=$$(node -p "require('./container/agent-runner/node_modules/@anthropic-ai/claude-agent-sdk/package.json').version" 2>/dev/null || echo "0.0.0"); \
	ROOT_LOCAL=$$(node -p "require('./node_modules/@anthropic-ai/claude-agent-sdk/package.json').version" 2>/dev/null || echo "0.0.0"); \
	LATEST=$$(npm view @anthropic-ai/claude-agent-sdk version --fetch-timeout=5000 2>/dev/null || echo "$$LOCAL"); \
	if [ "$$LOCAL" != "$$LATEST" ]; then \
		echo "🔄 [agent-runner] Claude Agent SDK 有新版本: $$LOCAL → $$LATEST，正在更新..."; \
		(cd container/agent-runner && $(PKG) update @anthropic-ai/claude-agent-sdk $(NPM_FLAGS) && $(PKG) run build $(NPM_FLAGS)); \
		sed -i.bak 's/"@anthropic-ai\/claude-agent-sdk": "[^"]*"/"@anthropic-ai\/claude-agent-sdk": "*"/' container/agent-runner/package.json && rm -f container/agent-runner/package.json.bak; \
		echo "✅ [agent-runner] SDK 更新完成（内置 Claude Code 版本随之更新）"; \
	else \
		echo "✅ [agent-runner] Claude Agent SDK 已是最新 ($$LOCAL)"; \
	fi; \
	if [ "$$ROOT_LOCAL" != "$$LATEST" ]; then \
		echo "🔄 [主服务] Claude Agent SDK 有新版本: $$ROOT_LOCAL → $$LATEST，正在更新..."; \
		$(PKG) update @anthropic-ai/claude-agent-sdk $(NPM_FLAGS); \
		sed -i.bak 's/"@anthropic-ai\/claude-agent-sdk": "[^"]*"/"@anthropic-ai\/claude-agent-sdk": "*"/' package.json && rm -f package.json.bak; \
		echo "✅ [主服务] SDK 更新完成"; \
	else \
		echo "✅ [主服务] Claude Agent SDK 已是最新 ($$ROOT_LOCAL)"; \
	fi

_ensure-native-abi: ## (内部) 探测 better-sqlite3 能否在当前 Node 下加载，ABI 不匹配则自动 npm rebuild
	@if [ ! -d node_modules/better-sqlite3 ]; then :; \
	elif node -e "require('better-sqlite3')" 2>/dev/null; then :; \
	else \
	  echo "🔄 检测到原生模块（better-sqlite3）ABI 与当前 Node $$(node --version) 不匹配，正在重新编译..."; \
	  npm rebuild better-sqlite3 --no-progress 2>&1 | tail -5 | sed 's/^/   /'; \
	  if ! node -e "require('better-sqlite3')" 2>/dev/null; then \
	    echo "❌ better-sqlite3 重新编译后仍无法加载，请手动执行: npm rebuild better-sqlite3"; \
	    exit 1; \
	  fi; \
	  echo "✅ 原生模块已重新编译"; \
	fi

# ─── Setup ───────────────────────────────────────────────────

install-host-tools: ## 安装宿主机模式所需的外部工具（feishu-cli、agent-browser、uv）+ 刷新 builtin-skills 缓存
	@./scripts/install-host-tools.sh

install: ## 安装全部依赖并编译 agent-runner
	@# --allow-git=all：npm 12 起默认禁用 git 依赖（EALLOWGIT），而 @whiskeysockets/baileys
	@# 的 dependencies 里有 github:WhiskeySockets/libsignal-node 和
	@# github:whiskeysockets/eslint-config（上游打包 bug）两个 git 依赖，必须显式放行
	$(PKG) install $(NPM_FLAGS) --allow-git=all
	@# node-pty 的 spawn-helper 预构建二进制可能缺少可执行权限，导致 PTY 模式失败
	@chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper 2>/dev/null || true
	cd container/agent-runner && $(PKG) install $(NPM_FLAGS)
	cd container/agent-runner && $(PKG) run build $(NPM_FLAGS)
	cd web && $(PKG) install $(NPM_FLAGS)
	@# 更新目录 mtime 以配合 start 中的依赖变更检测（[ package.json -nt node_modules ]）
	@touch node_modules web/node_modules container/agent-runner/node_modules

clean: ## 清理构建产物
	rm -rf dist
	rm -rf web/dist
	rm -rf container/agent-runner/dist
	rm -f .build-sentinel .docker-build-sentinel .sandbox-docker-build-sentinel

# ─── Data Directory ─────────────────────────────────────────
# data 目录默认放在用户主目录（~/.deepthink/data），使仓库目录可被删除 /
# 重新 clone 而不丢失运行时配置（凭据 / 用户 / 群组 / Skills / MCP / Plugins）。
# 用 DEEPTHINK_DATA_DIR=... 环境变量覆盖（桌面版自动注入其 userData 目录）。
# `$(or ...)` 让 env 优先于默认值；`?=` 让 `make ... DATA_DIR=xxx` 命令行仍可强制。
DATA_DIR ?= $(or $(DEEPTHINK_DATA_DIR),$(HOME)/.deepthink/data)

migrate-data: ## 迁移仓库内旧 ./data → $(DATA_DIR)（data 目录迁出仓库后用）
	@if [ -d data ] && [ "$$(ls -A data 2>/dev/null)" ]; then \
	  mkdir -p $(DATA_DIR); \
	  cp -a data/. $(DATA_DIR)/; \
	  echo "✅ 已迁移 ./data → $(DATA_DIR)"; \
	  echo "ℹ️  旧 ./data 保留原位，可确认无误后手动删除"; \
	else echo "ℹ️  仓库内无旧 ./data，无需迁移"; fi

reset-init: ## 完全重置为首装状态（清空所有运行时数据）
	rm -rf $(DATA_DIR) store groups
	@echo "✅ 已完全重置为首装状态：$(DATA_DIR)（数据库、配置、工作区、记忆、会话全部清除）"

# ─── Admin Account Ops ───────────────────────────────────────
# 运维脚本：创建 / 修改 管理员账号。
# 用法：
#   make admin-create USERNAME=alice PASSWORD=YourStr0ngPass
#   make admin-passwd USERNAME=alice PASSWORD=NewStr0ngPass
# 省略 PASSWORD 时走交互式隐藏输入，避免密码落入 shell history：
#   make admin-create USERNAME=alice

admin-create: ## 创建管理员账号（USERNAME=xxx [PASSWORD=xxx]，省略 PASSWORD 则交互式输入）
	@if [ -z "$(USERNAME)" ]; then echo "❌ 用法: make admin-create USERNAME=alice [PASSWORD=xxx]"; exit 1; fi
	@ARGS="create $(USERNAME)"; \
	  [ -n "$(PASSWORD)" ] && ARGS="$$ARGS $(PASSWORD)"; \
	  npx tsx src/admin-account-cli.js $$ARGS

admin-passwd: ## 修改管理员密码（USERNAME=xxx [PASSWORD=xxx]，省略 PASSWORD 则交互式输入；清掉该账号所有旧登录会话）
	@if [ -z "$(USERNAME)" ]; then echo "❌ 用法: make admin-passwd USERNAME=alice [PASSWORD=xxx]"; exit 1; fi
	@ARGS="passwd $(USERNAME)"; \
	  [ -n "$(PASSWORD)" ] && ARGS="$$ARGS $(PASSWORD)"; \
	  npx tsx src/admin-account-cli.js $$ARGS

# admin-set：一键设置/重置 admin 账号密码，幂等（不存在则创建，已存在则改密并吊销旧会话）。
# 用法：
#   make admin-set                                    # 默认 admin / 88888888
#   make admin-set ADMIN_NAME=alice ADMIN_PASS=Str0ngPass   # 自定义账号/密码（密码 ≥8 位）
# 说明：用 ADMIN_NAME/ADMIN_PASS 而非 USERNAME/PASSWORD，避免 shell 环境
# 变量 USERNAME（=当前登录用户）污染默认值。
admin-set: ## 设置/重置 admin 账号密码（默认 admin/88888888，可 ADMIN_NAME=/ADMIN_PASS= 覆盖；账号不存在则创建，已存在则改密码并吊销旧会话）
	@U="$(or $(ADMIN_NAME),admin)"; P="$(or $(ADMIN_PASS),88888888)"; \
	  echo ">> admin-set: username=$$U"; \
	  npx tsx src/admin-account-cli.js passwd "$$U" "$$P" 2>/dev/null \
	    || npx tsx src/admin-account-cli.js create "$$U" "$$P"

# ─── Backup / Restore ────────────────────────────────────────

backup: ## 备份运行时数据到 deepthink-backup-{date}.tar.gz（数据源：$(DATA_DIR)）
	@DATE=$$(date +%Y%m%d-%H%M%S); \
	FILE="deepthink-backup-$$DATE.tar.gz"; \
	if [ ! -d "$(DATA_DIR)" ] || [ -z "$$(ls -A $(DATA_DIR) 2>/dev/null)" ]; then \
	  echo "❌ $(DATA_DIR) 不存在或为空，无数据可备份（先 make start 初始化或 make migrate-data 迁移旧数据）"; exit 1; \
	fi; \
	echo "📦 正在打包备份到 $$FILE (源 $(DATA_DIR))..."; \
	tar -czf "$$FILE" \
	  -C "$(DATA_DIR)" \
	  --exclude='ipc' \
	  --exclude='env' \
	  --exclude='deepthink.log' \
	  --exclude='db/messages.db-shm' \
	  --exclude='db/messages.db-wal' \
	  --exclude='groups/*/logs' \
	  --exclude='plugins/catalog' \
	  --exclude='plugins/runtime' \
	  --exclude='harness' \
	  db config groups sessions \
	  $$([ -d $(DATA_DIR)/skills ] && echo skills) \
	  $$([ -d $(DATA_DIR)/mcp-servers ] && echo mcp-servers) \
	  $$([ -d $(DATA_DIR)/plugins/users ] && echo plugins/users) \
	  $$([ -d $(DATA_DIR)/memory ] && echo memory) \
	  2>/dev/null; \
	echo "✅ 备份完成：$$FILE ($$(du -sh $$FILE | cut -f1))"; \
	echo "⚠️  备份含 session-secret.key 与 claude-provider.key 明文，妥善保管，勿提交 git"

restore: ## 从 deepthink-backup-*.tar.gz 恢复数据到 $(DATA_DIR)（用法：make restore 或 make restore FILE=xxx.tar.gz）
	@if [ -n "$(FILE)" ]; then \
	  BACKUP="$(FILE)"; \
	elif [ $$(ls deepthink-backup-*.tar.gz 2>/dev/null | wc -l) -eq 1 ]; then \
	  BACKUP=$$(ls deepthink-backup-*.tar.gz); \
	elif [ $$(ls deepthink-backup-*.tar.gz 2>/dev/null | wc -l) -gt 1 ]; then \
	  echo "❌ 发现多个备份文件，请用 make restore FILE=xxx.tar.gz 指定："; \
	  ls deepthink-backup-*.tar.gz; \
	  exit 1; \
	else \
	  echo "❌ 未找到备份文件，请将 deepthink-backup-*.tar.gz 放到当前目录"; \
	  exit 1; \
	fi; \
	echo "📂 正在从 $$BACKUP 恢复到 $(DATA_DIR)..."; \
	if [ -d $(DATA_DIR) ] && [ "$$(ls -A $(DATA_DIR) 2>/dev/null)" ]; then \
	  echo "⚠️  $(DATA_DIR) 已存在数据，继续将覆盖。是否继续？[y/N] "; \
	  read CONFIRM; \
	  [ "$$CONFIRM" = "y" ] || [ "$$CONFIRM" = "Y" ] || { echo "已取消"; exit 1; }; \
	fi; \
	mkdir -p $(DATA_DIR); \
	tar -xzf "$$BACKUP" -C "$(DATA_DIR)"; \
	if [ ! -f $(DATA_DIR)/config/session-secret.key ]; then \
	  echo "⚠️  警告：备份中缺少 session-secret.key，用户登录 cookie 将失效，需重新登录"; \
	fi; \
	echo "✅ 数据恢复完成 → $(DATA_DIR)"; \
	echo ""; \
	echo "后续步骤："; \
	echo "  1. 如需 Docker 容器支持：./container/build.sh"; \
	echo "  2. 启动服务：make start"; \
	echo "  3. 恢复后须用最新版后端启动（DB schema 向前不兼容旧代码）"

# ─── Desktop (DeepThink) ────────────────────────────────────
# 桌面版：Electron 壳 + 后端 dist + 前端 dist + agent-runner + Node binary。
# 数据目录通过环境变量注入到后端，源码版行为零变化。

DESKTOP_DIR := desktop
DESKTOP_NODE_MODULES := $(DESKTOP_DIR)/node_modules
# 与 scripts/fetch-node-binary.js 默认保持一致；修改时同步更新一处即可。
DESKTOP_NODE_VERSION ?= v22.11.0

# Electron 二进制（electron 包 postinstall + electron-builder 打包）默认从 GitHub
# 下载，国内裸网络常 read ETIMEDOUT。这里默认走 npmmirror 镜像，已配置代理或自有
# 镜像的用户可在 shell 里 export 同名变量覆盖（?= 只在未设置时赋值）。
ELECTRON_MIRROR ?= https://npmmirror.com/mirrors/electron/
ELECTRON_BUILDER_BINARIES_MIRROR ?= https://npmmirror.com/mirrors/electron-builder-binaries/
export ELECTRON_MIRROR ELECTRON_BUILDER_BINARIES_MIRROR

desktop-install: ## 安装桌面版子项目依赖
	cd $(DESKTOP_DIR) && npm install --no-audit --no-fund $(NPM_FLAGS)

web-install: ## 安装 web/ 子项目依赖（仅在 package.json 变化或 node_modules 缺失时装）
	@if [ ! -d web/node_modules ] || [ web/package.json -nt web/node_modules ]; then \
		echo "▶ web/node_modules 缺失或过期，执行 npm install..."; \
		cd web && npm install --no-audit --no-fund $(NPM_FLAGS); \
	fi
	@touch web/node_modules

root-install: ## 安装根目录后端依赖（仅在 package.json 变化或 node_modules 缺失时装）
	@# --allow-git=all 同 install：@whiskeysockets/baileys 有 github: 依赖，npm 12 起默认 EALLOWGIT
	@if [ ! -d node_modules ] || [ package.json -nt node_modules ]; then \
		echo "▶ 根目录 node_modules 缺失或过期，执行 npm install..."; \
		npm install --no-audit --no-fund $(NPM_FLAGS) --allow-git=all; \
	fi
	@touch node_modules

desktop-build-deps: root-install build sync-types web-install ## 编译桌面版所需的所有产物（后端 + 前端 + agent-runner）
	cd container/agent-runner && npm install --no-audit --no-fund $(NPM_FLAGS)
	cd container/agent-runner && npm run build $(NPM_FLAGS)

desktop-build: desktop-build-deps desktop-install ## 编译桌面版 Electron 壳 TypeScript
	cd $(DESKTOP_DIR) && npm run build $(NPM_FLAGS)

desktop-fetch-node: ## 拉取当前平台的 Node.js 二进制到 dev-resources/node
	NODE_VERSION=$(DESKTOP_NODE_VERSION) node scripts/fetch-node-binary.js

desktop-rebuild-natives: desktop-fetch-node ## 用内置 Node ABI 重新编译根 node_modules 的 native 模块（better-sqlite3 等），避免运行时 ABI 不匹配
	@echo "[desktop] rebuilding native modules against node $(DESKTOP_NODE_VERSION)..."
	npm_config_target=$(DESKTOP_NODE_VERSION) npm_config_runtime=node npm rebuild $(NPM_FLAGS)
	@# rebuild 后必须校验产物：npm 12 默认 allow-scripts 拦截 install 脚本时，npm rebuild
	@# 会"成功"但 better-sqlite3 不产出 binding，打进 dmg 后后端启动即崩（见
	@# docs/issues/2026-08-21-desktop-dmg-better-sqlite3-missing.md）
	@if [ ! -f node_modules/better-sqlite3/build/Release/better_sqlite3.node ]; then \
	  echo "❌ better-sqlite3 rebuild 后仍无 build/Release/better_sqlite3.node"; \
	  echo "   多半是 install 脚本被 npm 12 allow-scripts 拦截，检查根 package.json 的 allowScripts 白名单"; \
	  exit 1; \
	fi
	@if ! ./dev-resources/node/node -e "require('better-sqlite3')(':memory:').exec('select 1')" >/dev/null 2>&1; then \
	  echo "❌ better-sqlite3 binding 无法在内置 Node $(DESKTOP_NODE_VERSION) 下加载（ABI 不匹配）"; \
	  exit 1; \
	fi
	@echo "✅ [desktop] native binding 已通过内置 Node $(DESKTOP_NODE_VERSION) 加载校验"

desktop-dev: desktop-build ## 桌面版开发模式：启动 Electron 壳，加载本机后端
	cd $(DESKTOP_DIR) && npm run dev

desktop-clean-stale-mount: ## 打包前清理 macOS 上残留的 DeepThink DMG 挂载点（避免 hdiutil detach 失败，exit code 16）
	@for v in "/Volumes/DeepThink 1.0.0" "/Volumes/DeepThink 1.0.0-x64" "/Volumes/DeepThink"*; do \
		[ -e "$$v" ] || continue; \
		echo "[desktop] 发现残留挂载点: $$v"; \
		holders=$$(lsof -t "$$v" 2>/dev/null); \
		if [ -n "$$holders" ]; then \
			echo "[desktop] 以下进程占用该卷，需先终止:"; \
			ps -p $$holders -o pid,ppid,command 2>/dev/null; \
			echo "[desktop] 终止占用进程..."; \
			echo $$holders | xargs kill 2>/dev/null || true; \
			sleep 2; \
		fi; \
		echo "[desktop] detach $$v"; \
		hdiutil detach "$$v" 2>/dev/null || hdiutil detach -force "$$v" 2>/dev/null || true; \
	done

desktop-pack-mac: desktop-build desktop-rebuild-natives desktop-clean-stale-mount ## 打包 macOS .dmg（仅 arm64，日常本地用）
	cd $(DESKTOP_DIR) && npx $(NPM_FLAGS) electron-builder --config build/mac-arm64.json

desktop-pack-mac-x64: desktop-build desktop-rebuild-natives desktop-clean-stale-mount ## 打包 macOS .dmg（仅 x64，需在 x64/intel Mac 上执行）
	cd $(DESKTOP_DIR) && npx $(NPM_FLAGS) electron-builder --config build/mac-x64.json

desktop-pack-mac-all: desktop-pack-mac desktop-pack-mac-x64 ## 打包 macOS .dmg（arm64 + x64 双架构，发布用）

desktop-pack-win: desktop-build desktop-rebuild-natives ## 打包 Windows .exe（在 Windows runner 上执行）
	TARGET_PLATFORM=win ARCH=x64 NODE_VERSION=$(DESKTOP_NODE_VERSION) node scripts/fetch-node-binary.js
	cd $(DESKTOP_DIR) && npx $(NPM_FLAGS) electron-builder --config build/win.json

desktop-pack-linux: desktop-build desktop-rebuild-natives ## 打包 Linux AppImage/.deb（在 Linux runner 上执行）
	TARGET_PLATFORM=linux ARCH=x64 NODE_VERSION=$(DESKTOP_NODE_VERSION) node scripts/fetch-node-binary.js
	cd $(DESKTOP_DIR) && npx $(NPM_FLAGS) electron-builder --config build/linux.json

# ─── Release ───────────────────────────────────────────────

RELEASE_REPO ?= AIGeniusInstitute/deep-think
RELEASE_NOTES_DIR ?= docs/release-notes

release: ## 发布 release 到 GitHub（用法: make release VERSION=v1.0.0；需先 make desktop-pack-* 并打 tag）
	@if [ -z "$(VERSION)" ]; then echo "❌ 用法: make release VERSION=v1.0.0"; exit 1; fi
	@if ! command -v gh >/dev/null 2>&1; then echo "❌ 未安装 gh CLI"; echo "  安装: brew install gh"; echo "  登录: gh auth login"; exit 1; fi
	@if ! gh auth status >/dev/null 2>&1; then echo "❌ gh 未登录，请先 gh auth login"; exit 1; fi
	@if ! git rev-parse "$(VERSION)" >/dev/null 2>&1; then echo "❌ 本地无 tag $(VERSION)"; echo "  请先: git tag -a $(VERSION) -m 'Release $(VERSION)' && git push origin $(VERSION)"; exit 1; fi
	@if [ ! -d desktop/release ] || [ -z "$$(ls -A desktop/release 2>/dev/null)" ]; then echo "❌ desktop/release 为空"; echo "  请先在对应平台执行: make desktop-pack-mac / desktop-pack-win / desktop-pack-linux"; exit 1; fi
	@NOTES_FILE=$(RELEASE_NOTES_DIR)/$(VERSION).md; \
	  if [ -f "$$NOTES_FILE" ]; then NOTES_ARG="--notes-file $$NOTES_FILE"; else NOTES_ARG="--generate-notes"; fi; \
	  echo "🚀 发布 $(VERSION) 到 $(RELEASE_REPO)..."; \
	  echo "   资产:"; ls desktop/release/ | sed 's/^/   📦 /'; \
	  gh release create "$(VERSION)" \
	    --repo $(RELEASE_REPO) \
	    --title "DeepThink $(VERSION)" \
	    $$NOTES_ARG \
	    --latest \
	    desktop/release/

release-delete: ## 删除 release 及 tag（用法: make release-delete VERSION=v1.0.0）
	@if [ -z "$(VERSION)" ]; then echo "❌ 用法: make release-delete VERSION=v1.0.0"; exit 1; fi
	@echo "🗑  删除 $(VERSION)..."
	gh release delete "$(VERSION)" --repo $(RELEASE_REPO) --yes --cleanup-tag 2>/dev/null || true
	git tag -d "$(VERSION)" 2>/dev/null || true
	git push origin --delete "$(VERSION)" 2>/dev/null || true
	@echo "✅ 已删除 $(VERSION)"

# ─── Help ────────────────────────────────────────────────────

help: ## 显示帮助
	@echo "运行时: 🟢 Node.js（本项目不使用 bun）"
	@echo ""
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'


# DeepThink Ubuntu 桌面版卸载 Makefile
# 用途：在本机(Ubuntu)上彻底卸载 DeepThink 桌面版(deb 包 + AppImage + 用户配置)
#       注意：~/deepthink 是项目源码目录，本脚本【不会】删除它。
# 用法：
#   make uninstall      # 完整卸载（deb 包 / AppImage / 配置，全部清理，保留源码）
#   make stop           # 仅停止运行中的进程
#   make purge-deb      # 仅卸载 deb 包
#   make purge-appimage # 仅删除 AppImage 与临时挂载点
#   make purge-config   # 仅清理用户配置
#   make verify         # 校验卸载是否干净
#   make dry-run        # 仅打印将要执行的步骤，不实际执行

APP            := deepthink-desktop
APP_PKG        := deepthink-desktop
APP_PROC       := deepthink-desktop
APP_MOUNT_TMP  := /tmp/.mount_DeepTh*
OPT_DIR        := /opt/DeepThink
USR_BIN        := /usr/bin/deepthink-desktop
DESKTOP_FILE  := /usr/share/applications/deepthink-desktop.desktop
DOC_DIR        := /usr/share/doc/deepthink-desktop
ICON_GLOB     := /usr/share/icons/hicolor/*/apps/deepthink-desktop.png
ALT_LINK      := /etc/alternatives/deepthink-desktop
CONFIG_DIRS   := $(HOME)/.config/deepthink-desktop $(HOME)/.config/DeepThink
REPO_DIR      := $(HOME)/deepthink

# 默认目标：完整卸载
.DEFAULT_GOAL := uninstall

.PHONY: uninstall stop-desktop purge-deb purge-appimage purge-config verify dry-run

## 完整卸载：停止进程 -> 卸载 deb -> 清理系统残留 -> 清理配置 -> 清理 AppImage -> 校验
uninstall: stop-desktop purge-deb verify

## 停止运行中的 DeepThink 进程（排除当前 shell，避免误杀）
stop-desktop:
	@echo ">> 停止运行中的 $(APP) 进程..."
	@ps -eo pid,args 2>/dev/null \
		| grep -i '$(APP_PROC)' | grep -v grep | grep -v claude \
		| awk '{print $$1}' | while read p; do [ -n "$$p" ] && kill -9 "$$p" 2>/dev/null; done
	@sleep 2
	@ps -eo args 2>/dev/null | grep -i '$(APP_PROC)' | grep -v grep | grep -v claude \
		|| echo "   (无残留进程)"

## 卸载 deb 包（purge，含配置文件）
purge-deb:
	@echo ">> 卸载 deb 包 $(APP_PKG)..."
	@if dpkg -l $(APP_PKG) 2>/dev/null | grep -qE '^ii'; then \
		sudo apt-get purge -y $(APP_PKG); \
	else \
		echo "   (deb 包未安装，跳过)"; \
	fi

## 清理 deb 卸载后可能残留的系统级文件
purge-residual:
	@echo ">> 清理系统级残留文件..."
	@sudo rm -rf $(OPT_DIR) 2>/dev/null || true
	@sudo rm -f  $(USR_BIN) $(DESKTOP_FILE) $(ALT_LINK) 2>/dev/null || true
	@sudo rm -rf $(DOC_DIR) 2>/dev/null || true
	@sudo rm -f  $(ICON_GLOB) 2>/dev/null || true
	@echo "   系统级残留已清理"

## 清理用户配置目录
purge-config:
	@echo ">> 清理用户配置..."
	@for d in $(CONFIG_DIRS); do rm -rf "$$d" 2>/dev/null && echo "   已删除 $$d"; done

## 删除 AppImage 与临时挂载点
purge-appimage:
	@echo ">> 清理 AppImage 与临时挂载点..."
	@rm -rf $(APP_MOUNT_TMP) 2>/dev/null || true
	@if [ -d "$(REPO_DIR)/desktop/release" ]; then \
		rm -f $(REPO_DIR)/desktop/release/DeepThink-*.AppImage 2>/dev/null \
		&& echo "   AppImage 已删除"; \
	else \
		echo "   (无 AppImage 目录，跳过)"; \
	fi

## 校验卸载是否干净
verify:
	@echo ">> 卸载校验："
	@echo "   1. deb 包:"; dpkg -l $(APP_PKG) 2>/dev/null | grep -E '^ii' && echo "   ✗ 仍存在" || echo "   ✓ 无"
	@echo "   2. 可执行命令:"; command -v $(APP) >/dev/null 2>&1 && echo "   ✗ 仍存在: $$(command -v $(APP))" || echo "   ✓ 无"
	@echo "   3. 系统文件残留:"; ls -d $(OPT_DIR) $(USR_BIN) $(DESKTOP_FILE) 2>/dev/null && echo "   ✗ 仍有残留" || echo "   ✓ 无"
	@echo "   4. 用户配置:"; ls -d $(CONFIG_DIRS) 2>/dev/null && echo "   ✗ 仍有残留" || echo "   ✓ 无"
	@echo "   5. 运行进程:"; ps -eo args 2>/dev/null | grep -i '$(APP_PROC)' | grep -v grep | grep -v claude && echo "   ✗ 仍有进程" || echo "   ✓ 无"
	@echo "   6. AppImage 挂载点:"; ls -d $(APP_MOUNT_TMP) 2>/dev/null && echo "   ✗ 仍存在" || echo "   ✓ 无"

## 仅打印将要执行的步骤，不实际执行
dry-run:
	@echo "== Dry-run: 以下为 make uninstall 将执行的步骤（不会实际执行）=="
	@echo "1. 停止 $(APP_PROC) 进程 (kill -9)"
	@echo "2. sudo apt-get purge -y $(APP_PKG)"
	@echo "3. sudo rm -rf $(OPT_DIR); sudo rm -f $(USR_BIN) $(DESKTOP_FILE) $(ALT_LINK); sudo rm -rf $(DOC_DIR); sudo rm -f $(ICON_GLOB)"
	@echo "4. rm -rf $(CONFIG_DIRS)"
	@echo "5. rm -rf $(APP_MOUNT_TMP); rm -f $(REPO_DIR)/desktop/release/DeepThink-*.AppImage"
	@echo "6. make verify"
	@echo "   注：~/deepthink 为项目源码目录，不会被删除。"
