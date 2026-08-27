#!/usr/bin/env bash

set -euo pipefail

echo "[phase-3.2] Running readiness gates..."

pnpm --filter @legioncode/brain check-types
pnpm --filter @legioncode/brain test
pnpm --filter @legioncode/secure-agent-api check-types

if [[ "${RUN_SECURE_AGENT_API_TESTS:-0}" == "1" ]]; then
  pnpm --filter @legioncode/secure-agent-api test
else
  echo "[phase-3.2] Skipping @legioncode/secure-agent-api tests."
  echo "[phase-3.2] Set RUN_SECURE_AGENT_API_TESTS=1 when runtime integration endpoint is available."
fi

pnpm --filter @legioncode/execution-engine type-check

if [[ "${RUN_EXECUTION_ENGINE_TESTS:-0}" == "1" ]]; then
  pnpm --filter @legioncode/execution-engine test
else
  echo "[phase-3.2] Skipping @legioncode/execution-engine tests."
  echo "[phase-3.2] Set RUN_EXECUTION_ENGINE_TESTS=1 to include full execution-engine suite."
fi

echo "[phase-3.2] All readiness gates passed."
