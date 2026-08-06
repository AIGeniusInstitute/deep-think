# Docker 镜像构建卡在 apt-get install（deb.debian.org 国内超时）

## 1. 用户现象

执行 `make start-prod PORT=9999` 触发 Docker 镜像重建后，构建在 apt 阶段卡住 1700+ 秒仍未完成，CPU 空转，用户被迫 `Ctrl+Z` 挂起。

## 2. 问题描述

`container/Dockerfile` 第 10 行的 `apt-get install` 一大坨系统包（chromium + 编译器 + Python + 各类 CLI 工具）默认从 `deb.debian.org` 拉取，国内裸网络下带宽极低、单包耗时数十秒，整层 ~440 MB 装完需要 30 分钟以上。同 Dockerfile 内 `npm`/`pip`/`go` 三类依赖均已配国内镜像，唯独 `apt` 漏配。

## 3. 根因

- 容器构建上下文不读宿主机 `/etc/apt/sources.list` 与 `/etc/apt/apt.conf.d/*`，宿主配的镜像源对 `docker build` 完全无影响。
- `node:22-slim` (Debian bookworm) 默认源指向 `deb.debian.org` 与 `security.debian.org`，国内裸连带宽不稳。
- 缺乏 BuildKit cache mount，每次重建都从零下载所有 .deb，无任何跨构建复用。

## 4. 复现路径

```bash
docker image rm deepthink-agent:latest -f
./container/build.sh
# 在国内网络下观察 [stage-0 2/19] RUN apt-get update && apt-get install ... 步骤耗时 > 1700s
```

## 5. 诊断方法

```bash
# 看构建卡在哪一步
docker buildx ls
docker buildx inspect --bootstrap

# 复现 apt 拉取慢
docker run --rm node:22-slim sh -c "apt-get update -qq && apt-get install -y --no-install-recommends --print-uris chromium | head"
# 输出里如果 URL 域名是 deb.debian.org 即命中本问题
```

## 6. 修复方案

`container/Dockerfile`：在 apt 步前加 `ARG APT_MIRROR` 默认清华源，sed 替换 `debian.sources`，并将 `apt-get install` 改为 `--mount=type=cache` 双 cache mount（`/var/cache/apt` + `/var/lib/apt/lists`），删除原 `rm -rf /var/lib/apt/lists/*`（cache mount 会自动管理、不进 image layer），改用 `apt-get clean` 释放 .deb 引用。

```dockerfile
ARG APT_MIRROR=mirrors.tuna.tsinghua.edu.cn
RUN if [ -n "${APT_MIRROR}" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" \
        /etc/apt/sources.list.d/debian.sources; \
    fi
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ... \
    locales \
    && apt-get clean \
    && sed -i '/en_US.UTF-8/s/^# //' /etc/locale.gen && locale-gen \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd
```

`container/build.sh`：`export DOCKER_BUILDKIT=1` 启用 BuildKit，新增 `APT_MIRROR` 透传 `--build-arg`，海外构建可 `APT_MIRROR= ./container/build.sh` 关掉换源。

**选型理由**：
- 默认清华源（`mirrors.tuna.tsinghua.edu.cn`）国内带宽足、覆盖 bookworm 全包；遇同步滞后可 `APT_MIRROR=mirrors.aliyun.com` 临时覆盖。
- cache mount 与现有 `NPM_REGISTRY`/`PIP_INDEX_URL` ARG 风格一致，海外用户/CI 一行 `--build-arg` 即可切回 upstream。
- 不动 `uv:latest` `COPY --from` 的层序（issue #403 注释仍生效）。

## 7. 处理卡住的状态

```bash
# 把挂起的构建拉回前台再 Ctrl+C 终止
fg
# 清掉旧 buildkit cache，确保换源生效
docker buildx prune -f
# 重新构建
./container/build.sh
```

## 8. 经验沉淀 / 预防

- **新增任何一类外部依赖源（apt / pip / npm / go mod / docker base image）都要同步配国内镜像**，并默认开镜像源、提供 ARG 覆盖开关。本次漏配 apt 是因为 Dockerfile 内已配三类镜像源，给人一种"都已经配过"的错觉。
- **重建触发的根因不一定是构建脚本本身**：本次触发源是 `container/agent-runner/src/*.ts` 在 8/7 改过、sentinel 是 7/28，Makefile `_ensure-docker-image` 正确判定 STALE，重建是必要的；问题在重建过程太慢。排查这类"构建慢"问题应先看哪个步骤最慢、再针对该步骤的下载源做修复，而不是整体调优。
- **BuildKit cache mount 对国内镜像源是叠加增益而非替代**：换镜像源解决首次下载慢，cache mount 解决后续重建复用，两者互补。
- 巡检建议：CI 定期 `docker buildx prune --all` 后跑一次完整 build，记录每步耗时，单步 > 5min 即告警。
