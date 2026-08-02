# syntax=docker/dockerfile:1

# ==========================================
# 🔧 GLOBAL CONFIGURATION
# ==========================================
ARG GO_IMAGE=docker.io/library/golang:1.23-bookworm@sha256:167053a2bb901972bf2c1611f8f52c44d5fe7e762e5cab213708d82c421614db
ARG REDIS_REPO_URL=https://github.com/Puneet-Pal-Singh/go-redis.git
ARG REDIS_REPO_REF=0c1f4b75474c3c7f64474ee0b0ddb1ef75df96e2
ARG BASE_IMAGE=docker.io/cloudflare/sandbox:0.12.3@sha256:23f67e16131b780865a5fa5aa3c8607408a730105c248836409f4e02bb6bf042
ARG SANDBOX_IMAGE_PLATFORM=linux/amd64

# ==========================================
# Stage 1: The Go Builder (Go-Redis)
# ==========================================
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS go-builder

ARG REDIS_REPO_URL
ARG REDIS_REPO_REF
ARG TARGETOS=linux
ARG TARGETARCH=amd64

WORKDIR /app
RUN git init \
    && git remote add origin "${REDIS_REPO_URL}" \
    && git fetch --depth 1 origin "${REDIS_REPO_REF}" \
    && git checkout --detach FETCH_HEAD
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -o redis-binary ./cmd/redis-server/

# ==========================================
# Stage 2: Final Runtime Image
# ==========================================
FROM --platform=${SANDBOX_IMAGE_PLATFORM} ${BASE_IMAGE}
USER root

ENV DEBIAN_FRONTEND=noninteractive
# 1. Install only the runtime packages we actually need.
# cloudflare/sandbox already includes node, npm, npx, git, and curl, so we do not reinstall them here.
# The packaged Rust compiler brings its linker explicitly; the previous Rustup-only layer exposed rustc
# but could not produce binaries because no linker was installed.
RUN apt-get update && apt-get install -y --no-install-recommends \
    gh \
    netcat-openbsd \
    python3 \
    python3-pip \
    ripgrep \
    rustc \
    && apt-get clean \
    && rm -rf /var/cache/apt/* /var/lib/apt/lists/*

# 2. Add only the TypeScript runner required by the Node plugin.
RUN npm install -g --no-audit --no-fund tsx@4.20.6 \
    && npm cache clean --force

# 3. Preinstall only the lightweight Python packages we actually want available by default.
# Heavy libraries like numpy/pandas can still be installed on demand by the Python plugin.
RUN python3 -m pip install --no-cache-dir redis requests

# 4. Copy Pre-compiled Go Binary from Stage 1
COPY --from=go-builder /app/redis-binary /usr/local/bin/my-redis-server
RUN chmod +x /usr/local/bin/my-redis-server && mkdir -p /data

WORKDIR /root
