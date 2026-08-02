#!/usr/bin/env bash
set -euo pipefail

echo "[gate:golden-repo-to-pr] Running hermetic prompt-to-PR lifecycle conformance gate"
echo "[gate:golden-repo-to-pr] Invariant: prompt -> approval -> tool/edit -> diff/artifacts -> commit/push/PR -> reload/replay must use canonical runtime, worker, git, artifact, and platform-client contracts."

corepack pnpm --filter @repo/rebuild-golden-conformance check-types
corepack pnpm --filter @repo/rebuild-golden-conformance test -- src/golden-repo-to-pr.test.ts
corepack pnpm --filter @shadowbox/web exec playwright install chromium
corepack pnpm --filter @shadowbox/web test:browser -- runtime-lifecycle-golden.spec.ts
corepack pnpm --filter @shadowbox/web test:browser -- real-product-route-gate.spec.ts
