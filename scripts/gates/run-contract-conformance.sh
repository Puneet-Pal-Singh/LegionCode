#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

run() {
  echo "[contract-conformance] $*"
  "$@"
}

run corepack pnpm --filter @repo/contract-conformance check-types
run corepack pnpm --filter @repo/contract-conformance test -- \
  src/lifecycle.test.ts \
  src/lifecycle-golden-matrix.test.ts
run corepack pnpm --filter @repo/artifact-store test -- src/InMemoryArtifactStore.test.ts
run corepack pnpm --filter @repo/event-store test -- src/MemoryEventStore.test.ts
run corepack pnpm --filter @repo/persistence test -- src/canonical-events/PostgresEventStore.test.ts
run corepack pnpm --filter @repo/workspace-core test -- src/repository.test.ts
run corepack pnpm --filter @repo/git-service test -- src/GitService.test.ts
run corepack pnpm --filter @repo/worker-protocol test -- src/protocol.test.ts
run corepack pnpm --filter @repo/platform-client-sdk test -- src/platform/http-transport.test.ts

echo "[contract-conformance] All canonical contract suites passed."
