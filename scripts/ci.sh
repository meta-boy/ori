#!/usr/bin/env bash
# CI entrypoint: `make verify` (typecheck + lint + test/api + test/contract + packages).
# Offline-runable except for Postgres, which the P2/P3 suites require.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== [ci] verifying DB connectivity =="
if ! pg_isready -h localhost -p 5432 -U ori -d ori >/dev/null 2>&1; then
  echo "error: Postgres not reachable at localhost:5432. Start it via: docker compose up -d postgres" >&2
  exit 1
fi

echo "== [ci] make verify =="
make verify