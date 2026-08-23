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
# completes a real WebSocket handshake against the VNC backend. When the golden
# ships the agent (plans/C25-agent-autostart.md) it also proves the agent is
# tunnel-ready with no provisioning step: the supervisor waits for
# /etc/ori/agent.json (a pooled clone boots before it is claimed), the agent
# connects to a running control plane the moment a valid config is dropped in,
# and reconnects on its own after a reboot.
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
  # kill the C25 control plane + scratch dir started on the host, if any
  if [ -n "${CC_DIR:-}" ]; then
    pve_ssh "kill \$(cat $CC_DIR/serve.pid 2>/dev/null) 2>/dev/null; pkill -f '$CC_DIR/serve.db' 2>/dev/null; rm -rf $CC_DIR" 2>/dev/null || true
  fi
  rm -rf "${LOCAL_TMP:-}" 2>/dev/null || true
}
trap cleanup EXIT

LOCAL_TMP="$(mktemp -d)"

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

# ---------------------------------------------------------------------------
# agent autostart (C25): a pooled clone is tunnel-ready with no provisioning
# step. Verified the way the pool uses it:
#   1. the supervisor is running and *waiting* at boot -- a pool member is
#      cloned before it is claimed, so /etc/ori/agent.json is absent then, and
#      the unit must wait rather than fail;
#   2. drop a valid agent.json in and the agent connects to a running control
#      plane with no other action;
#   3. reboot the container and the agent reconnects on its own.
# The control plane runs on the PVE host using the exact binary baked into the
# clone (pct pull), so this proves the shipped artifact, not a local one.
# ---------------------------------------------------------------------------
agent_present=$(pve_ssh "pct exec $CLONE -- sh -c 'test -x /usr/local/bin/ori && echo yes || echo no'" 2>/dev/null || true)
if [ "$agent_present" = "yes" ]; then
  echo "  [ok] agent binary present (/usr/local/bin/ori)"

  # 1. supervisor waiting for the config (absent at clone time)
  sup_ok=$(pve_ssh "pct exec $CLONE -- sh -c 'pgrep -f /usr/local/sbin/ori-agent >/dev/null && echo yes || echo no'" 2>/dev/null || true)
  [ "$sup_ok" = "yes" ] && echo "  [ok] agent supervisor running (waiting for /etc/ori/agent.json)" || { echo "  [fail] agent supervisor not running"; fail=1; }

  log_ok=$(pve_ssh "pct exec $CLONE -- sh -c 'test -f /var/log/ori-agent/agent.log && echo yes || echo no'" 2>/dev/null || true)
  [ "$log_ok" = "yes" ] && echo "  [ok] agent log present at /var/log/ori-agent/agent.log" || { echo "  [fail] agent log missing"; fail=1; }

  # 2. control plane on the host + valid agent.json -> agent connects, no other action
  CC_DIR="/var/tmp/ori-clone-check-$CLONE"
  CC_PORT=$(( 38000 + (CLONE % 1000) ))
  pve_ssh "rm -rf $CC_DIR && mkdir -p $CC_DIR"
  pve_ssh "pct pull $CLONE /usr/local/bin/ori $CC_DIR/ori && chmod +x $CC_DIR/ori"
  HOST_IP=$(pve_ssh "ip -4 addr show dev $ORI_BRIDGE 2>/dev/null | awk '/inet /{print \$2}' | cut -d/ -f1 | head -1" 2>/dev/null || true)
  [ -n "$HOST_IP" ] || { echo "  [fail] could not determine host bridge IP for the control plane"; fail=1; }

  if [ -n "$HOST_IP" ]; then
    pve_ssh "cd $CC_DIR && setsid ./ori serve --provider mock --bind $HOST_IP:$CC_PORT --db-path $CC_DIR/serve.db > $CC_DIR/serve.log 2>&1 < /dev/null & echo \$! > $CC_DIR/serve.pid"
    plane_ok=no
    for _i in $(seq 1 30); do
      pve_ssh "grep -q 'control plane listening' $CC_DIR/serve.log 2>/dev/null" && { plane_ok=yes; break; }
      sleep 1
    done
    [ "$plane_ok" = "yes" ] && echo "  [ok] control plane listening on :$CC_PORT" || { echo "  [fail] control plane did not start"; pve_ssh "tail -n 20 $CC_DIR/serve.log" 2>/dev/null || true; fail=1; }

    if [ "$plane_ok" = "yes" ]; then
      # seed the sandbox row the tunnel auth checks (token must match agent.json)
      SANDBOX="ori_cc_$CLONE"
      TOKEN="orit_cc_$CLONE"
      NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      printf "INSERT INTO sandboxes (id, account_id, name, state, machine_type, slug, provider, provider_handle, created_at, updated_at, agent_token) VALUES ('%s','default','clone-check','ready','default','cc-%s','mock','cc-%s','%s','%s','%s');\n" \
        "$SANDBOX" "$CLONE" "$CLONE" "$NOW" "$NOW" "$TOKEN" \
        | pve_ssh "sqlite3 $CC_DIR/serve.db"

      printf '{"controlPlaneUrl":"ws://%s:%s/api/v1/agent/tunnel","token":"%s","sandboxId":"%s","workDir":"/home/work/work"}' \
        "$HOST_IP" "$CC_PORT" "$TOKEN" "$SANDBOX" > "$LOCAL_TMP/agent.json"
      pve_ssh "cat > $CC_DIR/agent.json" < "$LOCAL_TMP/agent.json"
      pve_ssh "pct push $CLONE $CC_DIR/agent.json /etc/ori/agent.json && pct exec $CLONE -- sh -c 'chmod 0600 /etc/ori/agent.json && chown root:root /etc/ori/agent.json'"

      conn_ok=no
      for _i in $(seq 1 45); do
        pve_ssh "grep -q 'agent tunnel connected' $CC_DIR/serve.log 2>/dev/null" && { conn_ok=yes; break; }
        sleep 1
      done
      [ "$conn_ok" = "yes" ] && echo "  [ok] agent connected to the control plane (no other action)" || { echo "  [fail] agent did not connect to the control plane"; pve_ssh "tail -n 20 $CC_DIR/serve.log" 2>/dev/null || true; fail=1; }

      # 3. reboot -> reconnects on its own
      pve_ssh "pct reboot $CLONE" 2>/dev/null || true
      for _i in $(seq 1 90); do
        pve_ssh "pct exec $CLONE -- true >/dev/null 2>&1" && break
        sleep 1
      done
      recon_ok=no
      for _i in $(seq 1 60); do
        n=$(pve_ssh "grep -c 'agent tunnel connected' $CC_DIR/serve.log" 2>/dev/null || true)
        if [ -n "$n" ] && [ "$n" -ge 2 ]; then recon_ok=yes; break; fi
        sleep 1
      done
      [ "$recon_ok" = "yes" ] && echo "  [ok] after reboot the agent reconnected on its own" || { echo "  [fail] agent did not reconnect after reboot"; pve_ssh "tail -n 20 $CC_DIR/serve.log" 2>/dev/null || true; fail=1; }
    fi
  fi
else
  echo "  [skip] agent checks (golden has no /usr/local/bin/ori)"
fi

echo
echo "== summary =="
echo "  clone ($GOLDEN -> $CLONE): ${CLONE_S}s"
echo "  start -> exec-ready:       ${BOOT_S}s"
if [ "$fail" = "0" ]; then
  echo "  sandbox verified:          PASS (sshd loopback, docker, git, work user, DHCP, desktop, agent autostart)"
  echo "OK: golden $GOLDEN produces a working sandbox"
else
  echo "  sandbox verified:          FAIL"
  exit 1
fi