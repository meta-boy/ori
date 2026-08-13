#!/usr/bin/env bash
# Run every test file in its OWN process against its OWN database.
#
# Why: bun runs test FILES in parallel against a single Postgres. Several files write
# fleet-wide state -- starts_log drives the 600/hour and 1500/day ceilings, and the reaper
# scans every ori row -- so one file changes another file's result. Symptoms were a
# full-suite count that drifted 291-293 while every failing test passed in isolation,
# plus 17 unnamed hook failures, plus a cross-tenant 404 test that only failed in company.
#
# This costs a createdb+migrate per file (~1s) and buys a number that means something.
# The alternative, per-file databases inside test/api/helpers.ts, needs every file to
# await its setup; worth doing eventually (see the task list), but this needs no test
# changes at all.
#
# Usage: scripts/test-isolated.sh [file...]   (default: every *.test.ts)
set -uo pipefail
cd "$(dirname "$0")/.."

RUN_ID="$$"                         # keeps concurrent runs off each other's databases
PGC="${PGC:-ori-postgres-1}"        # docker container running Postgres
PGUSER_="${PGUSER_:-ori}"
ADMIN_DB="${ADMIN_DB:-ori}"
HOSTPORT="${HOSTPORT:-localhost:5432}"

psql_admin() { docker exec -i "$PGC" psql -U "$PGUSER_" -d "$ADMIN_DB" -q -t -c "$1" >/dev/null 2>&1; }

if [ "$#" -gt 0 ]; then
  files=("$@")
else
  mapfile -t files < <(find test packages/*/test -name '*.test.ts' -type f -not -name '._*' 2>/dev/null | sort)
fi

total_pass=0
total_fail=0
failed_files=()

for f in "${files[@]}"; do
  # Per-file AND per-run. The name used to be derived from the file path alone, which
  # meant two concurrent runs -- an agent's `make test` and mine, the normal case here --
  # picked identical database names and dropped each other's mid-test.
  slug=$(printf '%s' "$f" | shasum | cut -c1-8)
  dbname="ori_t_${slug}_${RUN_ID}"

  psql_admin "DROP DATABASE IF EXISTS ${dbname} WITH (FORCE)"
  psql_admin "CREATE DATABASE ${dbname}"
  url="postgres://${PGUSER_}:ori@${HOSTPORT}/${dbname}"

  if ! DATABASE_URL="$url" bun run packages/api/scripts/migrate.ts >/dev/null 2>&1; then
    echo "MIGRATE FAILED for $f ($dbname)"
    failed_files+=("$f (migrate)")
    total_fail=$((total_fail + 1))
    psql_admin "DROP DATABASE IF EXISTS ${dbname} WITH (FORCE)"
    continue
  fi

  out=$(DATABASE_URL="$url" bun test "$f" 2>&1)
  # Strip ANSI colour before counting: with FORCE_COLOR=1 (a dev shell, or a CI that sets
  # it) bun colours the summary line, and `^ *[0-9]+ pass` then matches nothing, so every
  # file reported "0 pass" while the gate stayed green — a check that cannot fail is not a
  # check. The counts are what decide pass/fail, so they must be colour-blind.
  plain=$(printf '%s' "$out" | sed -e 's/\x1b\[[0-9;]*m//g')
  p=$(printf '%s' "$plain" | grep -oE '^ *[0-9]+ pass' | grep -oE '[0-9]+' | head -1)
  fl=$(printf '%s' "$plain" | grep -oE '^ *[0-9]+ fail' | grep -oE '[0-9]+' | head -1)
  p=${p:-0}; fl=${fl:-0}
  total_pass=$((total_pass + p))
  total_fail=$((total_fail + fl))

  if [ "$fl" != "0" ]; then
    printf 'FAIL %-46s %s pass %s fail\n' "$f" "$p" "$fl"
    printf '%s\n' "$out" | grep '(fail)' | sed 's/^/       /' | head -6
    failed_files+=("$f")
  else
    printf 'ok   %-46s %s pass\n' "$f" "$p"
  fi

  psql_admin "DROP DATABASE IF EXISTS ${dbname} WITH (FORCE)"
done

echo
echo "TOTAL: ${total_pass} pass, ${total_fail} fail across ${#files[@]} files"
if [ ${#failed_files[@]} -gt 0 ]; then
  echo "failing files:"
  for x in "${failed_files[@]}"; do echo "  - $x"; done
  exit 1
fi
exit 0
