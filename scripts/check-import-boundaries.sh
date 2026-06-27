#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$PROJECT_ROOT"
node --test scripts/gates/check-architecture-boundaries.test.mjs
node --test scripts/gates/check-lifecycle-authority-boundaries.test.mjs
node scripts/gates/check-architecture-boundaries.mjs
