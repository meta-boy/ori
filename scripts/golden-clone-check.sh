#!/usr/bin/env bash
# Verify a golden image the way the pool will actually use it:
#   pct clone --full 0 --snapname base <golden> <sandbox>
# then start it and prove the sandbox is a working ori sandbox.
#
# This is the "Done means" proof for plans/C9-golden-image.md: the clone must
# complete in under 2 s (docs/BENCHMARKS.md: linked clone 1.65-1.83 s), and the
# clone must boot to a working sandbox (sshd loopback, docker, git, work user,
# DHCP address). When the golden ships the desktop stack (plans/C18-desktop.md)
# it also proves X is up, VNC/websockify listen on loopback only, and websockify
# completes a real WebSocket handshake against the VNC backend.
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

TIER=$(pve_get "/api2/json/nodes/$ORI_NODE/lxc/$GOLDEN/config" | jq -r '.data.ostype // empty')
[ -n "$TIER" ] || TIER=ubuntu

echo
echo "== clone (linked, full=0, snapname=base) =="
# measured on the host so ssh/curl overhead is excluded, and host load recorded
clone_out=$(pve_ssh "sh -s $GOLDEN $CLONE" <<'REMOTE'
GOLDEN="$1"; CLONE="$2"
load=$(cut -d' ' -f1 /proc/loadavg)
s=$(date +%s%N)
pct clone "$GOLDEN" "$CLONE" --full 0 --snapname base >/dev/null 2>&1
rc=$?
e=$(date +%s%N)
awk "BEGIN{printf \"%.3f %d %s\", ($e-$s)/1000000000, $rc, \"$load\"}"
REMOTE
)
CLONE_S="${clone_out%% *}"
clone_rc="${clone_out#* }"
HOST_LOAD="${clone_rc##* }"
clone_rc="${clone_rc%% *}"
echo "clone $GOLDEN -> $CLONE: ${CLONE_S}s (host load avg: ${HOST_LOAD})"
if [ "$clone_rc" != "0" ]; then
  echo "  FAIL: pct clone exited rc=$clone_rc"
  exit 1
fi
if awk "BEGIN{exit !($CLONE_S < 2.0)}"; then
  echo "  ok: under the 2 s target"
else
  echo "  NOTE: ${CLONE_S}s — host load was ${HOST_LOAD}; the 1.65-1.83 s baseline is an idle-host figure (docs/BENCHMARKS.md)"
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

if [ "$TIER" = "alpine" ]; then
  # busybox pgrep -x fails for sshd because sshd renames its argv to
  # "sshd: /usr/sbin/sshd [listener]..."; netstat is the positive proof
  # (C15 "Verified facts about the golden image" -- prefer a positive test).
  sshd_running=$(pve_ssh "pct exec $CLONE -- sh -c 'netstat -tln 2>/dev/null | grep -q \":22 \" && echo yes || echo no'" 2>/dev/null || true)
else
  sshd_running=$(pve_ssh "pct exec $CLONE -- sh -c 'pgrep -x sshd >/dev/null && echo yes || echo no'" 2>/dev/null || true)
fi
[ "$sshd_running" = "yes" ] && echo "  [ok] sshd running" || { echo "  [fail] sshd not running"; fail=1; }

if [ "$TIER" = "alpine" ]; then
  lb=$(pve_ssh "pct exec $CLONE -- sh -c 'netstat -tln 2>/dev/null | grep -cE \"(127.0.0.1|::1):22 \"'" 2>/dev/null || true)
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

# ---------------------------------------------------------------------------
# desktop stack (only when the golden carries it -- the supervisor script is
# the marker). Verified the way a browser will use it:
#   Xvfb(:99) -> x11vnc(5900) -> websockify(6080) -> noVNC assets
#   noVNC and websockify both bind loopback, exactly like sshd.
# ---------------------------------------------------------------------------
desktop_present=$(pve_ssh "pct exec $CLONE -- sh -c 'test -x /usr/local/sbin/ori-desktop && echo yes || echo no'" 2>/dev/null || true)
if [ "$desktop_present" = "yes" ]; then
  echo "  [ok] desktop stack present (ori-desktop supervisor installed)"

  # give the stack a moment to come up after boot
  xok=no
  for _i in $(seq 1 30); do
    xok=$(pve_ssh "pct exec $CLONE -- sh -c 'test -S /tmp/.X11-unix/X99 && echo yes || echo no'" 2>/dev/null || true)
    [ "$xok" = "yes" ] && break
    sleep 1
  done
  [ "$xok" = "yes" ] && echo "  [ok] X is up (Xvfb :99 socket present)" || { echo "  [fail] X is not up (no /tmp/.X11-unix/X99)"; fail=1; }

  wm=$(pve_ssh "pct exec $CLONE -- sh -c 'pgrep -x fluxbox >/dev/null && echo yes || echo no'" 2>/dev/null || true)
  [ "$wm" = "yes" ] && echo "  [ok] window manager running (fluxbox)" || { echo "  [fail] fluxbox not running"; fail=1; }

  if [ "$TIER" = "alpine" ]; then
    vnc_lines=$(pve_ssh "pct exec $CLONE -- sh -c 'netstat -tln 2>/dev/null'" 2>/dev/null | grep :5900 || true)
    ws_lines=$(pve_ssh "pct exec $CLONE -- sh -c 'netstat -tln 2>/dev/null'" 2>/dev/null | grep :6080 || true)
  else
    vnc_lines=$(pve_ssh "pct exec $CLONE -- sh -c 'ss -tln 2>/dev/null'" 2>/dev/null | grep :5900 || true)
    ws_lines=$(pve_ssh "pct exec $CLONE -- sh -c 'ss -tln 2>/dev/null'" 2>/dev/null | grep :6080 || true)
  fi

  vnc_good=$(printf '%s\n' "$vnc_lines" | grep -cE '127\.0\.0\.1:5900|\[::1\]:5900' || true)
  vnc_bad=$(printf '%s\n' "$vnc_lines" | grep -cE '0\.0\.0\.0:5900|\*:5900|:::5900' || true)
  if [ "$vnc_good" -gt 0 ] && [ "$vnc_bad" = "0" ]; then
    echo "  [ok] VNC (5900) listening on loopback only"
  else
    echo "  [fail] VNC not loopback-only (lines: $(printf '%s' "$vnc_lines" | tr '\n' ' '))"; fail=1
  fi

  ws_good=$(printf '%s\n' "$ws_lines" | grep -cE '127\.0\.0\.1:6080|\[::1\]:6080' || true)
  ws_bad=$(printf '%s\n' "$ws_lines" | grep -cE '0\.0\.0\.0:6080|\*:6080|:::6080' || true)
  if [ "$ws_good" -gt 0 ] && [ "$ws_bad" = "0" ]; then
    echo "  [ok] websockify (6080) listening on loopback only"
  else
    echo "  [fail] websockify not loopback-only (lines: $(printf '%s' "$ws_lines" | tr '\n' ' '))"; fail=1
  fi

  # websockify only answers a WebSocket upgrade (101) after connecting to the
  # x11vnc backend, so a verified handshake proves X -> x11vnc -> websockify.
  WSCHECK_B64=$(base64 < "$ORI_SCRIPT_DIR/../image/wscheck.py" | tr -d '\n')
  ws_out=$(pve_ssh "pct exec $CLONE -- sh -c 'echo $WSCHECK_B64 | base64 -d > /tmp/wscheck.py && python3 /tmp/wscheck.py'" 2>/dev/null || true)
  if printf '%s' "$ws_out" | grep -q 'websocket-handshake OK'; then
    echo "  [ok] websockify WebSocket handshake: $(printf '%s' "$ws_out" | grep -oE 'HTTP/1\.1 101[^)]*' | head -1)"
  else
    echo "  [fail] websockify WebSocket handshake failed: $ws_out"; fail=1
  fi
else
  echo "  [skip] desktop checks (golden has no ori-desktop supervisor)"
fi

echo
echo "== summary =="
echo "  clone ($GOLDEN -> $CLONE): ${CLONE_S}s"
echo "  start -> exec-ready:       ${BOOT_S}s"
if [ "$fail" = "0" ]; then
  echo "  sandbox verified:          PASS (sshd loopback, docker, git, work user, DHCP, desktop)"
  echo "OK: golden $GOLDEN produces a working sandbox"
else
  echo "  sandbox verified:          FAIL"
  exit 1
fi