# syntax=docker/dockerfile:1

# ==========================================
# 🔧 GLOBAL CONFIGURATION
# ==========================================
ARG GO_IMAGE=docker.io/library/golang:1.23-bookworm@sha256:167053a2bb901972bf2c1611f8f52c44d5fe7e762e5cab213708d82c421614db
ARG REDIS_REPO_URL=https://github.com/Puneet-Pal-Singh/go-redis.git
ARG REDIS_REPO_REF=0c1f4b75474c3c7f64474ee0b0ddb1ef75df96e2
ARG BASE_IMAGE=docker.io/cloudflare/sandbox:0.12.3@sha256:23f67e16131b780865a5fa5aa3c8607408a730105c248836409f4e02bb6bf042
ARG SANDBOX_IMAGE_PLATFORM=linux/amd64
ARG UBUNTU_SNAPSHOT=20260802T000000Z

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

ARG UBUNTU_SNAPSHOT
ENV DEBIAN_FRONTEND=noninteractive
# 1. Install only the runtime packages we actually need.
# cloudflare/sandbox already includes node, npm, npx, git, and curl, so we do not reinstall them here.
# The packaged Rust compiler brings its linker explicitly; the previous Rustup-only layer exposed rustc
# but could not produce binaries because no linker was installed.
RUN sed -i -E "s#http://(archive|security).ubuntu.com/ubuntu/#https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}/#g" /etc/apt/sources.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
    gh=2.4.0+dfsg1-2 \
    netcat-openbsd=1.218-4ubuntu1 \
    python3=3.10.6-1~22.04.1 \
    python3-pip=22.0.2+dfsg-1ubuntu0.7 \
    ripgrep=13.0.0-2ubuntu0.1 \
    rustc=1.75.0+dfsg0ubuntu1~bpo0-0ubuntu0.22.04.1 \
    && apt-get clean \
    && rm -rf /var/cache/apt/* /var/lib/apt/lists/*

# 2. Add only the lockfile-pinned TypeScript runner required by the Node plugin.
COPY container-tools/package.json container-tools/package-lock.json /opt/legioncode/container-tools/
RUN npm ci --prefix /opt/legioncode/container-tools --omit=dev --no-audit --no-fund \
    && ln -s /opt/legioncode/container-tools/node_modules/.bin/tsx /usr/local/bin/tsx \
    && npm cache clean --force

# 3. Preinstall only the hash-locked lightweight Python packages we want available by default.
# Heavy libraries like numpy/pandas can still be installed on demand by the Python plugin.
COPY container-requirements.txt /tmp/container-requirements.txt
RUN python3 -m pip install --no-cache-dir --only-binary=:all: --require-hashes \
    -r /tmp/container-requirements.txt \
    && rm /tmp/container-requirements.txt

# 4. Copy Pre-compiled Go Binary from Stage 1
COPY --from=go-builder /app/redis-binary /usr/local/bin/my-redis-server
RUN chmod +x /usr/local/bin/my-redis-server && mkdir -p /data

WORKDIR /root
