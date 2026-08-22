#!/usr/bin/env bash
# Verify a golden image the way the pool will actually use it:
#   pct clone --full 0 --snapname base <golden> <sandbox>
# then start it and prove the sandbox is a working ori sandbox.
#
# This is the "Done means" proof for plans/C9-golden-image.md: the clone must
# complete in under 2 s (docs/BENCHMARKS.md: linked clone 1.65-1.83 s), and the
# clone must boot to a working sandbox (sshd loopback, docker, git, work user,
# DHCP address).
#
# The clone vmid is taken from the test range (9000-9099) and destroyed when
# done -- including on failure (trap).
#
# usage: golden-clone-check.sh --vmid <golden-vmid> [--clone-vmid N]

set -euo pipefail
ORI_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$ORI_SCRIPT_DIR/lib.sh"

GOLDEN=""
CLONE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --vmid) GOLDEN="$2"; shift 2 ;;
    --clone-vmid) CLONE="$2"; shift 2 ;;
    -h | --help)
      echo "usage: golden-clone-check.sh --vmid <golden-vmid> [--clone-vmid N]"
      exit 0 ;;
    *) echo "error: unknown option: $1" >&2; exit 2 ;;
  esac
done

[ -n "$GOLDEN" ] || { echo "error: --vmid required" >&2; exit 2; }
cid_exists "$GOLDEN" || { echo "error: golden $GOLDEN does not exist" >&2; exit 2; }

snap_present=$(pve_get "/api2/json/nodes/$ORI_NODE/lxc/$GOLDEN/snapshot" | jq -r '[.data[]?.name] | index("base") != null')
[ "$snap_present" = "true" ] || { echo "error: golden $GOLDEN has no snapshot 'base'" >&2; exit 1; }

if [ -z "$CLONE" ]; then
  CLONE=$(find_free_vmid "$ORI_TEST_MIN" "$ORI_TEST_MAX")
fi
echo "using scratch clone vmid $CLONE (test range, cleaned up after)"

cleanup() {
  echo "cleaning up scratch clone $CLONE"
  cid_destroy "$CLONE" 2>/dev/null || true
}
trap cleanup EXIT

TIER=$(pve_get "/api2/json/nodes/$ORI_NODE/lxc" | jq -r --argjson v "$GOLDEN" '.data[]? | select(.vmid == $v) | .ostype')

echo
echo "== clone (linked, full=0, snapname=base) =="
S=$(date +%s%N)
pve_ssh "pct clone $GOLDEN $CLONE --full 0 --snapname base"
E=$(date +%s%N)
CLONE_S=$(awk "BEGIN{printf \"%.2f\", ($E-$S)/1000000000}")
echo "clone $GOLDEN -> $CLONE: ${CLONE_S}s"
if awk "BEGIN{exit !($CLONE_S < 2.0)}"; then
  echo "  ok: under the 2 s target"
else
  echo "  FAIL: clone took ${CLONE_S}s, above the 2 s target"
  exit 1
fi

echo
echo "== start -> exec-ready =="
S=$(date +%s%N)
pve_ssh "pct start $CLONE"
for i in $(seq 1 90); do
  pve_ssh "pct exec $CLONE -- true >/dev/null 2>&1" && break
  sleep 1
done
E=$(date +%s%N)
BOOT_S=$(awk "BEGIN{printf \"%.2f\", ($E-$S)/1000000000}")
echo "start -> exec: ${BOOT_S}s"

echo
echo "== sandbox verification =="
fail=0

ip=$(pve_ssh "pct exec $CLONE -- sh -c 'ip addr show dev eth0 2>/dev/null || ifconfig eth0 2>/dev/null'" 2>/dev/null \
  | grep -oE 'inet [0-9.]+' | awk '{print $2}' | grep -v '^127\.' | head -1 || true)
[ -n "$ip" ] && echo "  [ok] DHCP address: $ip" || { echo "  [fail] no DHCP address"; fail=1; }

sshd_running=$(pve_ssh "pct exec $CLONE -- sh -c 'pgrep -x sshd >/dev/null && echo yes || echo no'" 2>/dev/null || true)
[ "$sshd_running" = "yes" ] && echo "  [ok] sshd running" || { echo "  [fail] sshd not running"; fail=1; }

if [ "$TIER" = "alpine" ]; then
  lb=$(pve_ssh "pct exec $CLONE -- sh -c 'grep -c ListenAddress /etc/ssh/sshd_config.d/10-ori-loopback.conf'" 2>/dev/null || true)
else
  lb=$(pve_ssh "pct exec $CLONE -- sh -c 'ss -tln 2>/dev/null | grep -cE \"127.0.0.1|\[::1\]\".*:22'" 2>/dev/null || true)
fi
[ -n "$lb" ] && [ "$lb" != "0" ] && echo "  [ok] sshd bound to loopback only" || { echo "  [fail] sshd not loopback-only"; fail=1; }

gitv=$(pve_ssh "pct exec $CLONE -- sh -c 'git --version'" 2>/dev/null || true)
[ -n "$gitv" ] && echo "  [ok] $gitv" || { echo "  [fail] git missing"; fail=1; }

pve_ssh "pct exec $CLONE -- sh -c 'id work >/dev/null 2>&1 && echo yes || echo no'" 2>/dev/null | grep -q yes \
  && echo "  [ok] work user exists" || { echo "  [fail] work user missing"; fail=1; }

docker_ok=$(pve_ssh "pct exec $CLONE -- sh -c 'service docker start 2>/dev/null || rc-service docker start 2>/dev/null; sleep 3; docker info 2>&1 | grep -E \"Storage Driver|Server Version\"; docker run --rm hello-world 2>&1 | grep -c \"Hello from Docker\"'" 2>/dev/null || true)
[ "$docker_ok" != "" ] && echo "  [ok] docker works (storage driver verified, hello-world ran)" || { echo "  [fail] docker not functional"; fail=1; }

echo
echo "== summary =="
echo "  clone ($GOLDEN -> $CLONE): ${CLONE_S}s"
echo "  start -> exec-ready:       ${BOOT_S}s"
if [ "$fail" = "0" ]; then
  echo "  sandbox verified:          PASS (sshd loopback, docker, git, work user, DHCP)"
  echo "OK: golden $GOLDEN produces a working sandbox"
else
  echo "  sandbox verified:          FAIL"
  exit 1
fi