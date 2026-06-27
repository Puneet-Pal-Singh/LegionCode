#!/bin/bash
#
# Runtime Conformance Gate (SHA-41)
#
# Validates deterministic runtime behavior, provider parity, boundary guards,
# fallback policy, observability, and run isolation.
#

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SCARY_OUTPUT_PATTERN='Memory subsystem operation failed|invalid canonical id|missing checkpoint|duplicate user prompt|terminal turn with active thinking|approval stuck|tool timeout without typed failure|read/grep unavailable|fallback path usage|non-canonical run id'
PNPM_SHIM_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$PNPM_SHIM_DIR"
}

trap cleanup EXIT

cat > "$PNPM_SHIM_DIR/pnpm" <<'EOF'
#!/usr/bin/env bash
exec corepack pnpm "$@"
EOF
chmod +x "$PNPM_SHIM_DIR/pnpm"
export PATH="$PNPM_SHIM_DIR:$PATH"

run_checked() {
  local label="$1"
  shift
  local output_file
  output_file="$(mktemp)"

  echo -e "${YELLOW}[runtime-conformance-gate] ${label}...${NC}"
  if ! "$@" >"$output_file" 2>&1; then
    cat "$output_file"
    rm -f "$output_file"
    echo -e "${RED}[runtime-conformance-gate] ✗ ${label} failed${NC}"
    exit 1
  fi

  if grep -Eiq "$SCARY_OUTPUT_PATTERN" "$output_file"; then
    cat "$output_file"
    rm -f "$output_file"
    echo -e "${RED}[runtime-conformance-gate] ✗ ${label} emitted blocked runtime warning/error text${NC}"
    exit 1
  fi

  rm -f "$output_file"
}

echo -e "${YELLOW}[runtime-conformance-gate] Starting checks...${NC}"

run_checked "Type checking workspace" pnpm check-types
echo -e "${GREEN}[runtime-conformance-gate] ✓ Type checks passed${NC}"

run_checked "Brain boundary + fallback policy checks" pnpm --filter @shadowbox/brain test -- src/architecture/portability-guards.test.ts src/runtime/contracts/portability-boundary.test.ts src/architecture/no-silent-fallbacks.test.ts
run_checked "Execution-engine boundary checks" pnpm --filter @shadowbox/execution-engine test -- tests/unit/runtime-adapter-boundary.test.ts tests/unit/runtime-core-decomposition.test.ts
run_checked "UI-kit provider transport boundary checks" pnpm --filter @repo/ui-kit test -- src/architecture/provider-transport-boundary.test.ts
echo -e "${GREEN}[runtime-conformance-gate] ✓ Boundary + fallback policy checks passed${NC}"

run_checked "Determinism + provider parity checks" pnpm --filter @shadowbox/execution-engine test -- src/runtime/lib/RoutingDetector.test.ts src/runtime/engine/RunManifestPolicy.test.ts src/runtime/llm/LLMGateway.provider-matrix.test.ts src/runtime/engine/RunEngine.test.ts
echo -e "${GREEN}[runtime-conformance-gate] ✓ Determinism + provider parity checks passed${NC}"

run_checked "Brain observability + parity smoke checks" pnpm --filter @shadowbox/brain test -- src/core/observability/ByokObservability.test.ts src/runtime/parity-smoke.test.ts
run_checked "Platform client parity checks" pnpm --filter @repo/platform-client-sdk test -- src/providers/cross-client-contract-parity.test.ts src/providers/cross-client-lifecycle-parity.test.ts
echo -e "${GREEN}[runtime-conformance-gate] ✓ Observability + parity smoke checks passed${NC}"

run_checked "Isolation + retry reliability checks" pnpm --filter @shadowbox/execution-engine test -- src/runtime/engine/RunEngine.isolation.test.ts src/runtime/orchestration/TaskScheduler.test.ts
echo -e "${GREEN}[runtime-conformance-gate] ✓ Isolation + retry reliability checks passed${NC}"

echo -e "${GREEN}[runtime-conformance-gate] ✓ All checks passed${NC}"
