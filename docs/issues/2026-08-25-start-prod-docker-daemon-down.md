# 2026-08-25 start-prod 在 Docker daemon 未运行时硬失败

## 1. 用户现象

执行 `make start-prod PORT=9999`，依赖安装、agent-runner / web 构建全部正常通过，但随后卡在 Docker 镜像构建阶段并直接退出：

```
🐳 Docker 镜像不存在，正在构建...
ERROR: failed to connect to the docker API at unix:///Users/edy/.docker/run/docker.sock; check if the path is correct and if the daemon is running: dial unix ...: no such file or directory
make[2]: *** [_ensure-docker-image] Error 1
make: *** [start-prod] Error 2
```

Web 服务完全无法启动，用户没有手动操作 Docker 的意图（该实例 admin 主容器是宿主机模式，本不需要 Docker）。

## 2. 问题描述

启动链 `start-prod → _start-direct → _ensure-docker-image` 中，daemon 探测逻辑失效：Docker daemon 未运行时探测依然"通过"，随后 `docker image inspect` 因连不上 daemon 而失败，被误判为"镜像不存在"并触发 `./container/build.sh`，build 同样连不上 daemon 而硬失败，整个启动链被堵死。

## 3. 根因

Makefile `_ensure-docker-image` 原探测命令（Makefile:353，2026-07-18 issue 引入）：

```make
if ! docker version --format '{{.Client.APIVersion}}|{{.Server.APIVersion}}' 2>/dev/null | grep -q '|'; then
```

意图是"Client/Server 任一侧拿不到 → grep 不到 `|` → 判定握手失败"。但实测（docker CLI 29.7.2，daemon 宕机）：

```
$ docker version --format '{{.Client.APIVersion}}|{{.Server.APIVersion}}'
1.55|                                     ← stdout：client 部分正常打印，分隔符照常输出
failed to connect to the docker API ...  ← stderr
exit=1
```

daemon 宕机时 CLI 会把 client 侧的 API 版本和模板里的字面量 `|` 先打印出来（Server 部分为空），所以 `grep -q '|'` **永远命中**——探测形同虚设，直接放行进入后续 `docker image inspect` 分支。

设计层面还有一个前置问题：admin 主容器是 `host` 模式（宿主机进程），后端启动本身不依赖 Docker daemon；daemon 宕机本应降级告警放行，而不是硬失败。

## 4. 复现路径

1. 退出 Docker Desktop（确认 `ls ~/.docker/run/docker.sock` 不存在）
2. `make start-prod PORT=9999`
3. 观察到依赖安装、构建全部正常，最后死在 `ERROR: failed to connect to the docker API`
4. `make start`（裸跑模式）同样命中

## 5. 诊断方法

```bash
# daemon 是否可达（exit 0 = 正常）
docker info >/dev/null 2>&1; echo $?

# 证明原探测命令在 daemon 宕机时依然输出 '1.55|'（grep '|' 必命中）
docker version --format '{{.Client.APIVersion}}|{{.Server.APIVersion}}'; echo "exit=$?"
# 输出: 1.55|   + stderr 报错 + exit=1
```

## 6. 修复方案

`Makefile` `_ensure-docker-image`：改用 `docker info` 判定 daemon 可达性；不可达时用报错文案区分两种失败：

```diff
 _ensure-docker-image: ## (内部) 检测 Docker 镜像是否需要构建/重建
 	@if command -v docker >/dev/null 2>&1; then \
-	  if ! docker version --format '{{.Client.APIVersion}}|{{.Server.APIVersion}}' 2>/dev/null | grep -q '|'; then \
-	    echo "❌ docker CLI 无法与 daemon 通信（常见原因：客户端 API 版本过旧，被 daemon 拒绝）。"; \
-	    ... \
-	    exit 1; \
-	  fi; \
+	  if ! docker info >/dev/null 2>&1; then \
+	    if docker version 2>&1 | grep -q 'too old'; then \
+	      echo "❌ docker CLI 无法与 daemon 通信（常见原因：客户端 API 版本过旧，被 daemon 拒绝）。"; \
+	      ...（保留原 old-CLI 硬错误路径）...
+	      exit 1; \
+	    fi; \
+	    echo "⚠️ Docker daemon 未运行，跳过镜像检查（admin 宿主机模式不受影响；member 容器模式需启动 Docker 后重新 make）"; \
+	    exit 0; \
+	  fi; \
```

`_ensure-sandbox-image`：加同款 daemon 宕机守卫（原逻辑 `docker image inspect` 在 daemon 宕机时失败 → 会触发注定失败的沙箱 build）：

```diff
 _ensure-sandbox-image: ## (内部) 检测沙箱镜像是否需要构建/重建
 	@if command -v docker >/dev/null 2>&1; then \
+	  if ! docker info >/dev/null 2>&1; then \
+	    echo "⚠️ Docker daemon 未运行，跳过沙箱镜像检查（代码执行/浏览器自动化沙箱将不可用）"; \
+	    exit 0; \
+	  fi; \
 	  if ! docker image inspect deepthink-sandbox:latest >/dev/null 2>&1; then \
```

**选型理由**：

- `docker info` 是标准的 daemon 健康探测（CLI/daemon 握手全链路），比解析 `docker version --format` 的部分输出可靠；
- 用 stderr 是否含 `too old` 区分「CLI 过旧」（2026-07-18 issue 的场景，daemon 在跑但拒绝旧 CLI，重建无意义必须先修 CLI → 保留硬错误）和「daemon 未运行」（降级放行，admin host 模式可正常用）；
- daemon 宕机选择**告警跳过**而非硬失败：后端启动不依赖 Docker（admin 主容器 host 模式），member 容器模式在真正要拉容器时才需要 Docker，届时错误会由容器调度层给出。

## 7. 处理卡住的状态（如适用）

不适用（无 stuck 运行态）。用户侧如需 member 容器模式，启动 Docker Desktop 后重新 `make start-prod` 即可，镜像检查会正常执行。

## 8. 经验沉淀 / 预防

- **教训**：用 `--format` 模板 + `grep` 探测时，模板里的字面量（如 `|`）在"部分字段缺失"时依然会被打印，grep 必命中——探测命令要在真实故障态下验证，而不是只在正常态下验证。
- 2026-07-18 的探测修复只覆盖了"CLI 过旧"场景，未考虑"daemon 整体宕机"场景，且当时的探测方式对后者天然失效。写健康检查时先枚举故障矩阵（daemon down / CLI old / daemon up）再选探测命令。
- 降级策略：启动链中"增强能力"（Docker 容器隔离、沙箱）的检查应可降级告警，"核心依赖"才硬失败。`make start` / `make start-prod` 的核心是 Web 服务本身。
- 巡检建议：`docker info >/dev/null 2>&1 || echo "daemon down"` 可作为 shell prompt / status 命令的轻量探针（Makefile `status` 目标已有类似容错）。

**验证记录**：

| 场景 | 验证方式 | 结果 |
|------|---------|------|
| daemon 宕机 | stub docker CLI（模拟 `failed to connect`）跑 `make _ensure-docker-image` / `_ensure-sandbox-image` | 均告警跳过，exit 0 ✅ |
| CLI 过旧 | stub docker CLI（模拟 `client version 1.42 is too old`）跑 `make _ensure-docker-image` | 保留原硬错误（Error 1）✅ |
| daemon 正常 | 真实 daemon（Docker Desktop 启动后）跑 `make _ensure-docker-image` | 守卫通过，正常进入 sentinel/构建分支 ✅ |
