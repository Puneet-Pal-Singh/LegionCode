#!/usr/bin/env bash
set -euo pipefail

echo "[rebuild-governance] Validating feature flags, changed paths, and lifecycle metadata"
node scripts/gates/check-rebuild-governance.mjs

echo "[rebuild-governance] Running migration safety checks"
corepack pnpm --filter @repo/persistence test -- \
  src/migrations/PostgresMigrationRunner.test.ts \
  src/canonical-events/canonical-event-migration.test.ts \
  src/runtime-events/runtime-event-inbox-status.test.ts \
  src/config/database.test.ts \
  src/workspace-manifests/workspace-manifest-migration.test.ts \
  src/run-projections/run-projection-migration.test.ts \
  src/thread-projections/thread-projection-migration.test.ts

echo "[rebuild-governance] Running governance script regression tests"
node --test scripts/gates/check-rebuild-governance.test.mjs
