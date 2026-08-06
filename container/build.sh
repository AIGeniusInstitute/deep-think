#!/bin/bash
# Build the DeepThink agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="deepthink-agent"
TAG="${1:-latest}"

echo "Building DeepThink agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Build with Docker (CACHEBUST ensures claude-code is always latest)
# --network=host: the build container otherwise gets Docker's default bridge DNS
# (8.8.8.8), which is unreliable inside VPN/tunnel environments and breaks the
# GitHub fetch in the feishu-cli step. Host networking reuses the host's working
# DNS resolver. Override with BUILD_NETWORK=default if your environment differs.
#
# DOCKER_BUILDKIT=1: enables --mount=type=cache (apt cache reuse across rebuilds)
# and syntax directives. Defaults off in some Docker setups; explicitly turn it on.
#
# NPM_REGISTRY / PIP_INDEX_URL / APT_MIRROR / GITHUB_MIRROR: container build does
# NOT read host ~/.npmrc / pip.conf / etc, so host-side mirror configs have no
# effect inside `docker build`. Defaults point to China mirrors (npmmirror /
# Tsinghua) to avoid npm/pip/apt timeouts on CN networks. Overseas/CI users
# override with:
#   NPM_REGISTRY=https://registry.npmjs.org \
#   PIP_INDEX_URL=https://pypi.org/simple \
#   APT_MIRROR= \
#   GITHUB_MIRROR= \
#   ./container/build.sh
# GITHUB_MIRROR uses `${var-default}` (no colon) so GITHUB_MIRROR= (empty) means
# "direct connection" rather than "fall back to default mirror".
export DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-1}"
BUILD_NETWORK="${BUILD_NETWORK:-host}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
PIP_INDEX_URL="${PIP_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}"
APT_MIRROR="${APT_MIRROR-mirrors.tuna.tsinghua.edu.cn}"
GITHUB_MIRROR="${GITHUB_MIRROR-https://gh-proxy.com/}"

build_with_args() {
  docker build \
    --network="${BUILD_NETWORK}" \
    --build-arg CACHEBUST="$(date +%s)" \
    --build-arg NPM_REGISTRY="${NPM_REGISTRY}" \
    --build-arg PIP_INDEX_URL="${PIP_INDEX_URL}" \
    --build-arg APT_MIRROR="${APT_MIRROR}" \
    --build-arg GITHUB_MIRROR="${GITHUB_MIRROR}" \
    -t "${IMAGE_NAME}:${TAG}" .
}

if ! build_with_args; then
  # Restricted/rootless BuildKit builders reject host networking (it's a gated
  # entitlement) instead of falling back. Retry once on the default bridge so
  # those environments still build — bridge DNS may need a working resolver.
  if [ "${BUILD_NETWORK}" = "host" ]; then
    echo "host-network build failed (restricted builder?); retrying with default bridge network..." >&2
    BUILD_NETWORK="default"
    build_with_args
  else
    exit 1
  fi
fi

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"

# Touch sentinel so Makefile can detect stale image
touch "$SCRIPT_DIR/../.docker-build-sentinel"

echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | docker run -i ${IMAGE_NAME}:${TAG}"
