#!/usr/bin/env bash
# Validate infra/ with the real parsers. None of these tools exist on macOS, so this
# is a no-op there and MUST be run on Linux (or in CI) before trusting infra/.
#
# It is not part of `make verify` for exactly that reason: a check that silently skips
# on the dev machine would report success while validating nothing. Run `make lint-infra`
# on a Linux host. First real run of this found two defects that had been sitting in a
# committed, "reviewed", 814-line infra/ for hours:
#   - the Caddyfile did not adapt at all ({env.VAR} is not substituted in a site address)
#   - ConditionPathExists sat in [Service], where systemd ignores it, so the guard was inert
set -uo pipefail
cd "$(dirname "$0")/.."

rc=0
skipped=()
checked=0

hr() { printf '\n=== %s ===\n' "$1"; }

hr "caddy validate"
if command -v caddy >/dev/null 2>&1; then
  # The Caddyfile reads CONTROL_PLANE_BASE; supply a dev value so adaptation can proceed.
  # EDGE_DOMAIN is deliberately NOT needed by the site address any more -- see the comment
  # block in infra/Caddyfile.
  if EDGE_DOMAIN="${EDGE_DOMAIN:-ori.local}" \
     CONTROL_PLANE_BASE="${CONTROL_PLANE_BASE:-http://127.0.0.1:8080}" \
     caddy validate --config infra/Caddyfile --adapter caddyfile 2>&1 | grep -q "Valid configuration"; then
    echo "OK: infra/Caddyfile adapts"
  else
    echo "FAIL: infra/Caddyfile did not adapt"
    EDGE_DOMAIN="${EDGE_DOMAIN:-ori.local}" \
    CONTROL_PLANE_BASE="${CONTROL_PLANE_BASE:-http://127.0.0.1:8080}" \
    caddy validate --config infra/Caddyfile --adapter caddyfile 2>&1 | grep -E "^Error" | head -3
    rc=1
  fi
  # Formatting drift is a warning from caddy itself; treat it as a failure so the file
  # stays canonical and diffs stay readable.
  if caddy fmt infra/Caddyfile | diff -q - infra/Caddyfile >/dev/null; then
    echo "OK: infra/Caddyfile is caddy-fmt clean"
  else
    echo "FAIL: infra/Caddyfile is not formatted -- run: caddy fmt --overwrite infra/Caddyfile"
    rc=1
  fi
  checked=$((checked + 2))
else
  skipped+=("caddy validate + fmt (caddy not installed)")
fi

hr "shellcheck"
if command -v shellcheck >/dev/null 2>&1; then
  # Skip AppleDouble sidecars: macOS tar/copy emits ._foo.sh next to foo.sh, and
  # shellcheck reads them as real scripts with binary garbage on line 1.
  mapfile -t sh_files < <(find infra image -name '*.sh' -type f -not -name '._*' 2>/dev/null | sort)
  for f in "${sh_files[@]}"; do
    if shellcheck -S warning "$f"; then
      echo "OK: $f"
    else
      rc=1
    fi
    checked=$((checked + 1))
  done
else
  skipped+=("shellcheck (not installed)")
fi

hr "systemd-analyze verify"
if command -v systemd-analyze >/dev/null 2>&1; then
  for u in infra/systemd/*.service; do
    [ -e "$u" ] || continue
    # "not executable / No such file" is expected: the binaries are not deployed on a dev
    # host. Everything else -- unknown keys, bad sections, malformed directives -- is real.
    out=$(systemd-analyze verify "$u" 2>&1 |
      grep -vE "is not executable: No such file|netplan-ovs-cleanup|/lib/systemd/system/" || true)
    if [ -n "$out" ]; then
      echo "FAIL: $u"
      echo "$out" | head -5
      rc=1
    else
      echo "OK: $u"
    fi
    checked=$((checked + 1))
  done
else
  skipped+=("systemd-analyze verify (not installed)")
fi

hr "summary"
echo "checks run: $checked"
if [ ${#skipped[@]} -gt 0 ]; then
  echo "SKIPPED (this host cannot validate these -- run on Linux):"
  for s in "${skipped[@]}"; do echo "  - $s"; done
  # Skips are loud but not fatal, so a Mac dev can still run the target. CI must run it
  # on Linux, where nothing is skipped.
fi
[ "$rc" -eq 0 ] && echo "RESULT: pass" || echo "RESULT: fail"
exit "$rc"
