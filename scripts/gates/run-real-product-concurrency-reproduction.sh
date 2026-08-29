#!/usr/bin/env bash
set -euo pipefail

echo "[gate:real-product-concurrency] Requires an authenticated deployed /agents/ route, deterministic runtime fixtures, and a controlled secure-runtime-unavailable fixture."
echo "[gate:real-product-concurrency] Skips are explicit unless SHADOWBOX_REAL_CONCURRENCY_GATE=1."

SHADOWBOX_REAL_CONCURRENCY_GATE=1 \
  corepack pnpm --filter @shadowbox/web test:browser -- \
  real-product-concurrency-reproduction.spec.ts
