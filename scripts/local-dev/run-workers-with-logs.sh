#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${ROOT_DIR}/local/logs"
BRAIN_LOG="${LOG_DIR}/brain.log"
SECURE_API_LOG="${LOG_DIR}/secure-agent-api.log"
BRAIN_ALIAS_LOG="${ROOT_DIR}/brain-logs.log"
SECURE_API_ALIAS_LOG="${ROOT_DIR}/secure-api-logs.log"

mkdir -p "${LOG_DIR}"
: > "${BRAIN_LOG}"
: > "${SECURE_API_LOG}"
: > "${BRAIN_ALIAS_LOG}"
: > "${SECURE_API_ALIAS_LOG}"

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  if [[ -n "${BRAIN_PID:-}" ]]; then
    kill "${BRAIN_PID}" 2>/dev/null || true
  fi
  if [[ -n "${SECURE_API_PID:-}" ]]; then
    kill "${SECURE_API_PID}" 2>/dev/null || true
  fi
  wait "${BRAIN_PID:-}" 2>/dev/null || true
  wait "${SECURE_API_PID:-}" 2>/dev/null || true
  exit "${exit_code}"
}

trap cleanup EXIT INT TERM

echo "[local-dev] Writing Brain logs to ${BRAIN_LOG}"
echo "[local-dev] Writing secure-agent-api logs to ${SECURE_API_LOG}"
echo "[local-dev] Also writing Brain logs to ${BRAIN_ALIAS_LOG}"
echo "[local-dev] Also writing secure-agent-api logs to ${SECURE_API_ALIAS_LOG}"

(
  cd "${ROOT_DIR}/apps/brain"
  pnpm exec wrangler dev \
    --config wrangler.local.jsonc \
    --local \
    --port 8788 \
    --inspector-port 9230
) 2>&1 | tee "${BRAIN_LOG}" "${BRAIN_ALIAS_LOG}" &
BRAIN_PID=$!

(
  cd "${ROOT_DIR}/apps/secure-agent-api"
  pnpm exec wrangler dev \
    --config wrangler.local.jsonc \
    --local \
    --port 8787 \
    --inspector-port 9229
) 2>&1 | tee "${SECURE_API_LOG}" "${SECURE_API_ALIAS_LOG}" &
SECURE_API_PID=$!

wait -n "${BRAIN_PID}" "${SECURE_API_PID}"
