#!/usr/bin/env bash
# Starts a throwaway backend (empty data directory, model libraries stubbed) on
# port 8000 and runs the browser flow against it.
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 tests/e2e/serve.py 8000 > "${TMPDIR:-/tmp}/saleshub-e2e-server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do curl -sf http://127.0.0.1:8000/health >/dev/null && break; sleep 0.5; done
node tests/e2e/flow.js
