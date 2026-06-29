# syntax=docker/dockerfile:1
# # ==========================================
# # 🔧 CONFIGURATION (Edit these lines only)
# # ==========================================
# ARG GO_VERSION=1.23-bookworm
# ARG REDIS_REPO_URL=https://github.com/Puneet-Pal-Singh/go-redis.git
# ARG BASE_IMAGE=docker.io/cloudflare/sandbox:0.7.0

# # ==========================================
# # Stage 1: The Builder
# # ==========================================
# FROM golang:${GO_VERSION} AS builder

# # Re-declare ARG because they reset after FROM
# ARG REDIS_REPO_URL 

# WORKDIR /app

# # 1. Clone the repo using the variable
# #    If you change the link at the top, this updates automatically.
# RUN git clone ${REDIS_REPO_URL} .

# # 2. Build
# RUN CGO_ENABLED=0 GOOS=linux go build -o my-redis-server ./cmd/redis-server/

# # ==========================================
# # Stage 2: The Runtime
# # ==========================================
# FROM ${BASE_IMAGE}

# USER root

# # 1. Install Dependencies (Official Redis included for testing)
# RUN apt-get update && \
#     apt-get install -y python3 python3-pip netcat-openbsd redis-server && \
#     rm -rf /var/lib/apt/lists/*

# # 2. Install Python Libs
# RUN python3 -m pip install redis requests numpy pandas

# # 3. Copy Binary
# COPY --from=builder /app/my-redis-server /usr/local/bin/my-redis-server
# RUN chmod +x /usr/local/bin/my-redis-server

# # 4. Setup Data Dir
# RUN mkdir -p /data

# WORKDIR /root

# -----------------------------------------------------------------------------------------------
# # ==========================================
# # 🔧 CONFIGURATION
# # ==========================================
# ARG GO_VERSION=1.23-bookworm
# ARG REDIS_REPO_URL=https://github.com/Puneet-Pal-Singh/go-redis.git
# ARG BASE_IMAGE=docker.io/cloudflare/sandbox:0.7.0

# # Stage 1: The Builder (Go-Redis)
# FROM golang:${GO_VERSION} AS builder
# ARG REDIS_REPO_URL 
# WORKDIR /app
# RUN git clone ${REDIS_REPO_URL} .
# RUN CGO_ENABLED=0 GOOS=linux go build -o my-redis-server ./cmd/redis-server/

# # Stage 2: The Universal Runtime
# FROM ${BASE_IMAGE}
# USER root

# # 1. Install System Dependencies
# RUN apt-get update && \
#     apt-get install -y \
#     python3 python3-pip \
#     netcat-openbsd redis-server \
#     curl git build-essential \
#     && rm -rf /var/lib/apt/lists/*

# # 2. Install Node.js (v20 LTS) & TS Tools
# RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
#     apt-get install -y nodejs && \
#     npm install -g typescript tsx

# # 3. Install Rust (Minimal Profile)
# ENV RUSTUP_HOME=/usr/local/rustup \
#     CARGO_HOME=/usr/local/cargo \
#     PATH=/usr/local/cargo/bin:$PATH
# RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path

# # 4. Install Python Libs
# RUN python3 -m pip install redis requests numpy pandas

# # 5. Copy Go-Redis Binary
# COPY --from=builder /app/my-redis-server /usr/local/bin/my-redis-server
# RUN chmod +x /usr/local/bin/my-redis-server

# # 6. Setup Data Dir
# RUN mkdir -p /data
# WORKDIR /root


# ----------------------------------------------------------------------------------------------------
# ==========================================
# 🔧 GLOBAL CONFIGURATION
# ==========================================
ARG GO_VERSION=1.23-bookworm
ARG REDIS_REPO_URL=https://github.com/Puneet-Pal-Singh/go-redis.git
ARG BASE_IMAGE=docker.io/cloudflare/sandbox:0.7.0
ARG SANDBOX_IMAGE_PLATFORM=linux/amd64

# ==========================================
# Stage 1: The Go Builder (Go-Redis)
# ==========================================
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION} AS go-builder

ARG REDIS_REPO_URL 
ARG TARGETOS=linux
ARG TARGETARCH=amd64

WORKDIR /app
RUN git clone ${REDIS_REPO_URL} .
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -o redis-binary ./cmd/redis-server/

# ==========================================
# Stage 2: Final Runtime Image
# ==========================================
FROM --platform=${SANDBOX_IMAGE_PLATFORM} ${BASE_IMAGE}
USER root

ENV DEBIAN_FRONTEND=noninteractive
ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo
ENV PATH=/usr/local/cargo/bin:$PATH

# 1. Install only the runtime packages we actually need.
# cloudflare/sandbox already includes node, npm, npx, git, and curl, so we do not reinstall them here.
# We intentionally avoid shipping a full C toolchain in the base image for launch; Python packages that
# require native compilation can still be handled as a future optimization path if they become essential.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip \
    netcat-openbsd \
    ripgrep \
    gh \
    && rm -rf /var/lib/apt/lists/*

# 2. Add only the TypeScript runner required by the Node plugin.
RUN npm install -g --no-audit --no-fund tsx@4.20.6 \
    && npm cache clean --force

# 3. Install the minimal Rust toolchain used by the Rust plugin.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path
RUN rm -rf /usr/local/cargo/registry /usr/local/cargo/git

# 4. Preinstall only the lightweight Python packages we actually want available by default.
# Heavy libraries like numpy/pandas can still be installed on demand by the Python plugin.
RUN python3 -m pip install --no-cache-dir redis requests

# 5. Copy Pre-compiled Go Binary from Stage 1
COPY --from=go-builder /app/redis-binary /usr/local/bin/my-redis-server
RUN chmod +x /usr/local/bin/my-redis-server && mkdir -p /data

EXPOSE 3000

WORKDIR /root
