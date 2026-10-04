#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${ROOT_DIR}/local/logs"
BRAIN_LOG="${LOG_DIR}/brain.log"
SECURE_API_LOG="${LOG_DIR}/secure-agent-api.log"
BRAIN_ALIAS_LOG="${ROOT_DIR}/brain-logs.log"
SECURE_API_ALIAS_LOG="${ROOT_DIR}/secure-api-logs.log"
PERSIST_ROOT="${LEGIONCODE_LOCAL_PERSIST_DIR:-}"
PERSIST_HELPER="${ROOT_DIR}/scripts/local-dev/local-persist.mjs"

if [[ -z "${PERSIST_ROOT}" || "${PERSIST_ROOT}" != /* ]]; then
  echo "[local-dev] set LEGIONCODE_LOCAL_PERSIST_DIR to an absolute persistent root shared by workers using the same database" >&2
  exit 1
fi

mkdir -p "${LOG_DIR}"
: > "${BRAIN_LOG}"
: > "${SECURE_API_LOG}"
: > "${BRAIN_ALIAS_LOG}"
: > "${SECURE_API_ALIAS_LOG}"

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  local writers_stopped=1
  stop_worker_group "${BRAIN_PID:-}"
  stop_worker_group "${SECURE_API_PID:-}"
  if worker_group_alive "${BRAIN_PID:-}" || worker_group_alive "${SECURE_API_PID:-}"; then
    writers_stopped=0
    echo "[local-dev] a worker process group is still live; persistence locks are retained to prevent concurrent writers" >&2
    exit_code=1
  fi
  wait "${BRAIN_PID:-}" 2>/dev/null || true
  wait "${SECURE_API_PID:-}" 2>/dev/null || true
  if [[ "${writers_stopped}" == "0" ]]; then
    exit "${exit_code}"
  fi
  if [[ -n "${BRAIN_LOCK_TOKEN:-}" ]]; then
    LEGIONCODE_LOCAL_PERSIST_LOCK_TOKEN="${BRAIN_LOCK_TOKEN}" node "${PERSIST_HELPER}" release brain "$$" || true
  fi
  if [[ -n "${SECURE_API_LOCK_TOKEN:-}" ]]; then
    LEGIONCODE_LOCAL_PERSIST_LOCK_TOKEN="${SECURE_API_LOCK_TOKEN}" node "${PERSIST_HELPER}" release secure-agent-api "$$" || true
  fi
  exit "${exit_code}"
}

worker_group_alive() {
  [[ -n "$1" ]] && kill -0 -- "-$1" 2>/dev/null
}

stop_worker_group() {
  local worker_pid="$1"
  [[ -n "${worker_pid}" ]] || return 0
  kill -TERM -- "-${worker_pid}" 2>/dev/null || true
  for _ in {1..20}; do
    worker_group_alive "${worker_pid}" || return 0
    sleep 0.1
  done
  kill -KILL -- "-${worker_pid}" 2>/dev/null || true
  for _ in {1..50}; do
    worker_group_alive "${worker_pid}" || return 0
    sleep 0.1
  done
}

wait_for_worker_exit() {
  while true; do
    if ! kill -0 "${BRAIN_PID}" 2>/dev/null; then
      wait "${BRAIN_PID}"
      return $?
    fi
    if ! kill -0 "${SECURE_API_PID}" 2>/dev/null; then
      wait "${SECURE_API_PID}"
      return $?
    fi
    sleep 1
  done
}

filter_worker_logs() {
  awk '
    /\[wrangler:info\].*(GET|POST|OPTIONS) \/api\/(run\/summary|run\/events|run\/activity|git\/status) 200 OK/ { next }
    { print; fflush() }
  '
}

trap cleanup EXIT INT TERM

if ! (
  cd "${ROOT_DIR}/apps/brain"
  node ./scripts/validate-local-wrangler-config.mjs
); then
  exit 1
fi

if ! (
  cd "${ROOT_DIR}/apps/secure-agent-api"
  node ./scripts/validate-local-wrangler-config.mjs
); then
  exit 1
fi

node "${PERSIST_HELPER}" prepare
BRAIN_LOCK_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
SECURE_API_LOCK_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
LEGIONCODE_LOCAL_PERSIST_LOCK_TOKEN="${BRAIN_LOCK_TOKEN}" node "${PERSIST_HELPER}" acquire brain "$$"
LEGIONCODE_LOCAL_PERSIST_LOCK_TOKEN="${SECURE_API_LOCK_TOKEN}" node "${PERSIST_HELPER}" acquire secure-agent-api "$$"

echo "[local-dev] Writing Brain logs to ${BRAIN_LOG}"
echo "[local-dev] Writing secure-agent-api logs to ${SECURE_API_LOG}"
echo "[local-dev] Also writing Brain logs to ${BRAIN_ALIAS_LOG}"
echo "[local-dev] Also writing secure-agent-api logs to ${SECURE_API_ALIAS_LOG}"

pushd "${ROOT_DIR}/apps/brain" >/dev/null
LEGIONCODE_LOCAL_PERSIST_LOCK_TOKEN="${BRAIN_LOCK_TOKEN}" python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' node "${ROOT_DIR}/scripts/local-dev/worker-group-supervisor.mjs" brain "$$" -- pnpm exec wrangler dev \
  --config wrangler.local.jsonc \
  --port 8788 \
  --inspector-port 9230 \
  --persist-to "${PERSIST_ROOT}/workers/brain" \
  > >(filter_worker_logs | tee "${BRAIN_LOG}" "${BRAIN_ALIAS_LOG}") 2>&1 &
BRAIN_PID=$!
LEGIONCODE_LOCAL_PERSIST_LOCK_TOKEN="${BRAIN_LOCK_TOKEN}" node "${PERSIST_HELPER}" attach brain "${BRAIN_PID}"
popd >/dev/null

pushd "${ROOT_DIR}/apps/secure-agent-api" >/dev/null
LEGIONCODE_LOCAL_PERSIST_LOCK_TOKEN="${SECURE_API_LOCK_TOKEN}" python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' node "${ROOT_DIR}/scripts/local-dev/worker-group-supervisor.mjs" secure-agent-api "$$" -- pnpm exec wrangler dev \
  --config wrangler.local.jsonc \
  --port 8787 \
  --inspector-port 9229 \
  --persist-to "${PERSIST_ROOT}/workers/secure-agent-api" \
  > >(filter_worker_logs | tee "${SECURE_API_LOG}" "${SECURE_API_ALIAS_LOG}") 2>&1 &
SECURE_API_PID=$!
LEGIONCODE_LOCAL_PERSIST_LOCK_TOKEN="${SECURE_API_LOCK_TOKEN}" node "${PERSIST_HELPER}" attach secure-agent-api "${SECURE_API_PID}"
popd >/dev/null

wait_for_worker_exit
