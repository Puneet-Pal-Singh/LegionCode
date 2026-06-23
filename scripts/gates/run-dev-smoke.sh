#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

run() {
  echo "[dev-smoke] $*"
  "$@"
}

run pnpm --filter @shadowbox/brain test -- \
  src/architecture/layering.boundary.test.ts \
  src/architecture/no-legacy-imports.test.ts

run pnpm --filter @shadowbox/secure-agent-api exec vitest run --dir src/conformance

run pnpm --filter @shadowbox/web test -- \
  src/lib/run-status.test.ts \
  src/lib/run-summary-status-snapshot.test.ts \
  src/services/lifecycle/LifecycleTerminalViewModel.test.ts \
  src/hooks/useRunSummary.test.tsx \
  src/hooks/useRunEvents.test.tsx \
  src/hooks/useChatHydration.test.tsx \
  src/hooks/useChatPersistence.test.tsx \
  src/hooks/useGitStatus.test.tsx \
  src/lib/git-client.test.ts

echo "[dev-smoke] All deterministic smoke checks passed."
