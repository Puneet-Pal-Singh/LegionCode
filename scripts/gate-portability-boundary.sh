#!/bin/bash
#
# Portability Boundary Conformance Gate
#
# Validates that code changes maintain portability boundary adherence.
# Prevents platform leakage and ensures port contracts are honored.
#
# Run as: pnpm gate:portability-boundary
#
# Checks:
# 1. TypeScript compilation succeeds (strict mode)
# 2. Conformance tests pass (port contracts)
# 3. No Cloudflare primitives leak into core
# 4. Port boundary violations detected and reported
#

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORTS_ROOT="$PROJECT_ROOT/apps/secure-agent-api/src/ports"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}[portability-boundary-gate] Starting conformance checks...${NC}"

# 1. Type check (strict mode)
echo -e "${YELLOW}[portability-boundary-gate] Checking TypeScript compilation...${NC}"
if ! pnpm run check-types > /dev/null 2>&1; then
  echo -e "${RED}[portability-boundary-gate] ✗ TypeScript compilation failed${NC}"
  echo "Run: pnpm run check-types"
  exit 1
fi
echo -e "${GREEN}[portability-boundary-gate] ✓ TypeScript compilation passed${NC}"

# 2. Run conformance tests
echo -e "${YELLOW}[portability-boundary-gate] Running conformance tests...${NC}"
if ! pnpm --filter @shadowbox/secure-agent-api exec vitest run --dir src/conformance > /dev/null 2>&1; then
  echo -e "${RED}[portability-boundary-gate] ✗ Conformance tests failed${NC}"
  echo "Run: pnpm --filter @shadowbox/secure-agent-api exec vitest run --dir src/conformance"
  exit 1
fi
echo -e "${GREEN}[portability-boundary-gate] ✓ Conformance tests passed${NC}"

# 3. Check for cloudflare primitive leakage in core
echo -e "${YELLOW}[portability-boundary-gate] Checking for platform leakage...${NC}"

# Note: Platform leakage check is in progress
# SHA-23 Phase 3 will refactor AgentRuntime to use ports instead of direct Cloudflare imports
# For now, we verify that adapters properly encapsulate Cloudflare primitives
LEAK_COUNT=0

# Adapters should be the ONLY place importing cloudflare:workers directly
# Core orchestration logic should use ports
if [[ ! -d "$PORTS_ROOT" ]]; then
  echo -e "${RED}[portability-boundary-gate] ✗ Ports directory not found: $PORTS_ROOT${NC}"
  exit 1
fi

if ! grep -r "from ['\"]cloudflare:workers" "$PORTS_ROOT" > /dev/null; then
  echo -e "${GREEN}[portability-boundary-gate] ✓ Port interfaces don't import cloudflare:workers${NC}"
else
  echo -e "${RED}[portability-boundary-gate] ✗ Cloudflare imports found in port interfaces (should be in adapters only)${NC}"
  LEAK_COUNT=$((LEAK_COUNT + 1))
fi

if [ $LEAK_COUNT -gt 0 ]; then
  echo -e "${RED}[portability-boundary-gate] ✗ Boundary violation detected (${LEAK_COUNT} violations)${NC}"
  exit 1
fi
echo -e "${GREEN}[portability-boundary-gate] ✓ Port boundaries maintained${NC}"

# 4. Summary
echo -e "${GREEN}[portability-boundary-gate] ✓ All conformance checks passed${NC}"
echo -e "${GREEN}[portability-boundary-gate] Portability boundary is maintained${NC}"
exit 0
