# DeepThink Sandbox Container
# Runs untrusted code with Docker + seccomp + cgroups hardening.
# See docs/prd/sandbox/sandbox-technical-solution.md §3 for design rationale.

FROM node:22-slim

# China-network mirror: same root cause as the main Dockerfile — sandbox build
# can't read host apt/pip config, deb.debian.org times out on CN networks and
# pypi.org is slow. USTC for apt (Tsinghua's IPv6 node returns 403 for debian
# pool files), Aliyun for pip (serves all packages at ~0.1s). Override with
# `--build-arg APT_MIRROR=` / `--build-arg PIP_INDEX_URL=` for direct connection.
ARG APT_MIRROR=mirrors.ustc.edu.cn
RUN if [ -n "${APT_MIRROR}" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" \
        /etc/apt/sources.list.d/debian.sources; \
    fi

# NOTE: Keep system packages before pip to leverage layer caching.
RUN apt-get update && apt-get install -y --no-install-recommends \
    # --- Python runtime ---
    python3 \
    python3-pip \
    python3-venv \
    ca-certificates \
    # --- Browser automation (Chromium) ---
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-wqy-zenhei \
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
    # --- CLI utilities ---
    curl \
    jq \
    tree \
    file \
    less \
    coreutils \
    && rm -rf /var/lib/apt/lists/*

# Python scientific stack (kept minimal; expand on demand)
ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
RUN pip3 install --no-cache-dir --break-system-packages \
    --index-url "${PIP_INDEX_URL}" \
    numpy \
    requests \
    matplotlib

# Reuse the existing `node` user (uid 1000) — node:22-slim ships with it.
# Creating a new `useradd -u 1000` fails because the uid is already taken.
USER node
WORKDIR /workspace

COPY --chown=node:node entry.sh /entry.sh
COPY --chown=node:node cdp-forwarder.js /usr/local/lib/cdp-forwarder.js
RUN chmod +x /entry.sh

# /workspace is overwritten at runtime by tmpfs (see security.ts buildDockerRunArgs)
VOLUME ["/workspace"]

ENTRYPOINT ["/entry.sh"]
