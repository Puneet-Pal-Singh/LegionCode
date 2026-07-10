#!/usr/bin/env bash
set -euo pipefail

echo "[gate:staging-cutover] Running local staging/cutover substitute"
echo "[gate:staging-cutover] Invariant: cutover cannot proceed unless final Plan 023 golden, governance, and CI wiring gates are blocking."

node --test scripts/gates/check-staging-cutover-readiness.test.mjs
node scripts/gates/check-staging-cutover-readiness.mjs

if [[ "${STAGING_CUTOVER_MODE:-local}" == "remote" ]]; then
  : "${STAGING_WEB_URL:?STAGING_WEB_URL is required when STAGING_CUTOVER_MODE=remote}"
  : "${STAGING_BRAIN_URL:?STAGING_BRAIN_URL is required when STAGING_CUTOVER_MODE=remote}"
  : "${STAGING_WORKER_URL:?STAGING_WORKER_URL is required when STAGING_CUTOVER_MODE=remote}"
  echo "[gate:staging-cutover] Remote staging endpoints are configured; remote smoke execution is intentionally owned by deployment automation."
else
  echo "[gate:staging-cutover] No remote staging endpoints configured; blocking on hermetic local substitute."
fi

corepack pnpm gate:golden-repo-to-pr
