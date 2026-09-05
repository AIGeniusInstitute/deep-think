# DeepThink Agent Container
# Runs Claude Agent SDK in isolated Linux VM with full toolchain

FROM node:22-slim

# Install system packages (organized by category)
# NOTE: Keep this layer BEFORE `COPY --from=ghcr.io/astral-sh/uv:latest` so that
# uv:latest digest churn (frequent releases) does not invalidate this ~440MB layer.
# See issue #403.
#
# APT_MIRROR: container build can't read host apt config, China networks time
# out on deb.debian.org. Default to USTC mirror; override with
# `--build-arg APT_MIRROR=` (empty) for direct connection, or another mirror.
# Why USTC not Tsinghua: the Tsinghua mirror's IPv6 node returns HTTP 403 for
# most debian pool .deb files (IPv4 is fine), but buildkit over `--network=host`
# prefers IPv6, so the whole apt-get install layer aborts with exit 100. USTC
# serves both IPv4 and IPv6 at 200 (~0.5s per file).
ARG APT_MIRROR=mirrors.ustc.edu.cn
RUN if [ -n "${APT_MIRROR}" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" \
        /etc/apt/sources.list.d/debian.sources; \
    fi
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    # --- Browser & fonts ---
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    # --- Chromium shared library deps ---
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    # --- Build tools & compilers ---
    build-essential \
    cmake \
    pkg-config \
    # --- Python ecosystem ---
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    # --- Core CLI tools ---
    curl \
    wget \
    git \
    zsh \
    jq \
    tree \
    file \
    less \
    bc \
    patch \
    rsync \
    # --- Compression ---
    zip \
    unzip \
    xz-utils \
    bzip2 \
    # --- Network ---
    openssh-client \
    dnsutils \
    iputils-ping \
    # --- Process & system ---
    procps \
    lsof \
    # --- Text search & dev ---
    ripgrep \
    fd-find \
    shellcheck \
    # --- Multimedia ---
    ffmpeg \
    imagemagick \
    ghostscript \
    graphviz \
    # --- Document & PDF ---
    poppler-utils \
    pandoc \
    # --- Database clients ---
    sqlite3 \
    default-mysql-client \
    postgresql-client \
    redis-tools \
    # --- Locale ---
    locales \
    # cache mounts above stay out of the image layer; lists get reused across
    # rebuilds. apt-get clean releases the .deb refs but the cache persists.
    && apt-get clean \
    # Set up UTF-8 locale
    && sed -i '/en_US.UTF-8/s/^# //' /etc/locale.gen && locale-gen \
    # Symlink fd-find → fd (Debian names it fdfind)
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd

# Install uv (Astral, https://docs.astral.sh/uv/). uv/uvx are standalone binaries
# the agent may invoke inside the container; not used by entrypoint/agent-runner.
# Source: `pip install uv` ships pre-built native binaries per arch — no image
# pull. Pinned to Aliyun mirror: ghcr.io is ~280s/23MB on CN networks and the
# Tsinghua mirror returns 403 for some packages; Aliyun serves `uv` and
# `headroom-ai` at 0.1s. `--break-system-packages`: PIP_BREAK_SYSTEM_PACKAGES
# ENV is set below, but this RUN runs before that ENV takes effect.
RUN pip install --break-system-packages \
      --index-url https://mirrors.aliyun.com/pypi/simple/ uv \
    && uv --version \
    && command -v uvx

# Locale environment
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Allow pip install without venv (Debian 12+ PEP 668) and add user bin to PATH
ENV PIP_BREAK_SYSTEM_PACKAGES=1
ENV PATH="/home/node/.local/bin:${PATH}"

# Create app directory
WORKDIR /app

# Container build does NOT read host ~/.npmrc, so a host-side npm mirror config
# has no effect inside `docker build`. China networks default to npmjs.org and
# time out on `npm install`. Default to npmmirror; override with
# `--build-arg NPM_REGISTRY=https://registry.npmjs.org` for upstream/CI.
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm config set registry "${NPM_REGISTRY}"

# Copy package.json only — no lock file so "*" always resolves to latest SDK
COPY agent-runner/package.json ./

# CACHEBUST after COPY ensures both global and local npm install are cache-busted
# (COPY caches on file content hash, which blocks ARG invalidation propagation)
ARG CACHEBUST=1
RUN npm install -g agent-browser
RUN npm install

# Headroom (https://github.com/chopratejas/headroom) - 工具输出/RAG/日志压缩.
# 装上 binary 但默认不启用——用户在 /mcp-servers 自行添加才生效, 配置:
#   { "command": "headroom", "args": ["mcp", "serve"] }
# 只选 [code,mcp] 两个 extras: [memory] 通过 sentence-transformers 强依赖
# torch + CUDA (cudnn-cu12, cublas, cusparse, cusolver, nccl, triton...),
# 压缩包就 ~2.45GB, 解包 3-6GB 量级. DeepThink 容器无 GPU, 也不需要语义
# embedding 类 retrieve. 用户如真需要 headroom 的 memory 能力, 可在容器内
# 单独 `pip install --index-url https://download.pytorch.org/whl/cpu torch`
# 再 `pip install "headroom-ai[memory]"` 走 CPU 路径. PIP_BREAK_SYSTEM_PACKAGES
# 已在 line 103 设置, 这里无需再传 --break-system-packages.
# Pin 到 ~=0.27.0 (>=0.27.0,<0.28.0): headroom-ai 仍是 PyPI Beta, 且 extras 解析
# 曾因 [memory]→torch 把镜像撑爆; `headroom --version` 自检只挡『装不上』挡不住
# 体积/行为漂移, 故锁定已验证的 ~550MB footprint, 仅允许 0.27.x 补丁更新.
#
# PIP_INDEX_URL default to Aliyun mirror: same root cause as NPM_REGISTRY —
# container build can't read host pip config, China networks time out on pypi.org.
# Aliyun (not Tsinghua): the Tsinghua mirror returns HTTP 403 for `headroom-ai`
# (not synced / filtered), which aborts this layer; Aliyun serves it at 0.1s.
# Override with `--build-arg PIP_INDEX_URL=https://pypi.org/simple`.
ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
RUN pip install --index-url "${PIP_INDEX_URL}" "headroom-ai[code,mcp]~=0.27.0" \
    && headroom --version

# Install feishu-cli (binary + builtin skills), 始终跟踪 gitcode main 最新源码。
#
# 背景: github.com 在国内裸网络下 TCP 不通 (release 下载需先连 github.com 拿
# 302 跳转, 连不上即整步超时); 第三方 ghproxy 镜像 (gh-proxy.com / ghfast.top
# / ghproxy.cc 等) 当前整体不可用 (403 / SSL 超时 / 限流). 原 Dockerfile 通过
# GITHUB_MIRROR ARG 拼 gh-proxy 前缀下载预编译二进制, 该路径已不可靠.
#
# gitcode.com/AIGeniusInstitute/feishu-cli 是 DeepThink 组织维护的源码镜像
# (国内 TCP-OK, ~0.5s), 但只镜像了 main 分支源码, 无 release 预编译二进制 /
# 无版本 tag. 因此改为源码自编译方案, 全程不碰 github.com 与任何 ghproxy 镜像:
#   1. Go 工具链: 从 dl.google.com 下载官方二进制 (国内稳定可达), 编译后清理,
#      不留在主镜像;
#   2. 源码: git clone --depth 1 gitcode 仓库 (拿源码 + skills/);
#   3. 模块依赖: GOPROXY=https://goproxy.cn (国内可达, 已验证可拉 cobra / lark
#      SDK 等 22 个依赖) 拉取;
#   4. CGO_ENABLED=0 纯静态编译, 产物直接放 /usr/local/bin/feishu-cli;
#   5. skills/ 直接来自同一次 clone (省去原本第二个 archive 下载, 二进制与
#      skills 天然同源).
# GITHUB_MIRROR ARG 保留声明仅为兼容 build.sh (仍传该 --build-arg), 本段不再使用.
ARG GITHUB_MIRROR=https://gh-proxy.com/
ARG TARGETARCH
ARG GO_VERSION=1.21.13
RUN set -e && \
    ARCH="${TARGETARCH:-$(dpkg --print-architecture)}" && \
    GO_TARBALL="go${GO_VERSION}.linux-${ARCH}.tar.gz" && \
    echo "Downloading Go ${GO_VERSION} (${ARCH}) from dl.google.com" && \
    curl -fsSL --connect-timeout 30 --max-time 180 --retry 3 --retry-delay 5 \
      "https://dl.google.com/go/${GO_TARBALL}" \
      | tar -xz -C /usr/local && \
    export GOROOT=/usr/local/go && \
    export GOPATH=/tmp/gopath && \
    export PATH="${GOROOT}/bin:${PATH}" && \
    SRC_TMP=$(mktemp -d) && \
    echo "Cloning feishu-cli source from gitcode.com" && \
    git clone --depth 1 https://gitcode.com/AIGeniusInstitute/feishu-cli.git \
      "$SRC_TMP/feishu-cli" && \
    cd "$SRC_TMP/feishu-cli" && \
    echo "Building feishu-cli (GOPROXY=goproxy.cn, CGO_ENABLED=0)" && \
    GOPROXY=https://goproxy.cn,direct GOSUMDB=off GOFLAGS=-mod=mod \
      CGO_ENABLED=0 GOOS=linux GOARCH=${ARCH} \
      go build -trimpath -o /usr/local/bin/feishu-cli . && \
    feishu-cli --version && \
    mkdir -p /opt/builtin-skills && \
    cp -r skills/. /opt/builtin-skills/ && \
    rm -rf /usr/local/go "$GOPATH" "$SRC_TMP" && \
    ls /opt/builtin-skills/

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/memory /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Copy entrypoint script (runs as root, drops to node user via runuser)
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace

# Install oh-my-zsh for node user (ys theme).
# Best-effort: the installer pulls install.sh from raw.githubusercontent.com AND
# git-clones the ohmyzsh repo from github.com — both are flaky behind some
# networks (notably CN), where the clone doesn't fail fast but HANGS. A plain
# `|| echo` can't rescue a hang, so wrap in `timeout` to cap the attempt. It's a
# cosmetic shell theme, NOT required by the agent runtime, so timeout/failure
# must fall back to the default shell rather than abort the whole image build.
RUN timeout -k 5 90 su - node -c 'sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended' \
    && sed -i 's/ZSH_THEME="robbyrussell"/ZSH_THEME="ys"/' /home/node/.zshrc \
    && chsh -s /bin/zsh node \
    || echo "⚠️ oh-my-zsh setup skipped (network slow/unavailable); container keeps default shell"

# Entrypoint runs as root to fix volume permissions, then drops to node user.
# Do NOT add USER node here — entrypoint handles the privilege drop.
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
