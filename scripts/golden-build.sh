#!/usr/bin/env bash
# Build an ori **golden image**: a stopped LXC container on a Proxmox host
# with a snapshot named `base`, which the warm pool (plans/C5-pool.md) linked
# clones (`pct clone --full 0 --snapname base`) to serve `ori new` in under a
# second. Clone timings in docs/BENCHMARKS.md (1.65-1.83 s) are only valid from
# a stopped, clean golden -- this script produces exactly that.
#
#   - base template: ubuntu (default tier) or alpine (fast tier)
#   - unprivileged + nesting=1 (docker-in-sandbox), docker-in-LXC config lines
#   - installs sshd (loopback only), the ori agent binary, docker, git, a
#     non-root `work` user, and a VNC/desktop stack
#   - stops the container, then snapshots it as `base`
#   - idempotent: a re-run with the same --vmid rebuilds the golden cleanly
#   - prints the resulting vmid + snapshot as the pool's config input
#
# Only ever touches the vmid it is told to own. On failure it destroys the
# half-built container (trap). It leaves the finished golden in place -- that is
# the deliverable the pool clones from.
#
# Requires scripts/lib.sh and $ORI_REPO_ROOT/.env.local (see infra/README.md).

set -euo pipefail
ORI_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$ORI_SCRIPT_DIR/lib.sh"

TIER=ubuntu
VMID=""
AGENT_BIN=""
DESKTOP=1
ROOTFS_GB=""
MEMORY=2048
SWAP=512
CORES=2
FORCE=0

usage() {
  cat <<'EOF'
usage: golden-build.sh [options]

  --template ubuntu|alpine   golden base (default: ubuntu)
  --vmid N                   vmid for the golden image. Default: reuse the
                             tagged golden for this tier, else scan for a free
                             vmid outside the test range (9000-9099).
  --agent-bin PATH           bake the ori agent binary into the image. This is
                             the single `ori` binary (the agent is a role, run
                             as `ori agent`). Default: $ORI_PVE_AGENT_BIN, else
                             the freshest x86_64-unknown-linux-musl `ori` built
                             by scripts/build-all.sh (target/cross-*).
  --rootfs-size GB           rootfs size (default: 16 ubuntu / 8 alpine)
  --memory MB                container memory  (default 2048)
  --swap MB                  container swap    (default 512)
  --cores N                  container cores   (default 2)
  --no-desktop               skip the VNC/desktop stack
  --force                    rebuild even if the vmid holds a non-golden
                             container (use with care)
  -h, --help                 this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --template) TIER="$2"; shift 2 ;;
    --vmid) VMID="$2"; shift 2 ;;
    --agent-bin) AGENT_BIN="$2"; shift 2 ;;
    --rootfs-size) ROOTFS_GB="$2"; shift 2 ;;
    --memory) MEMORY="$2"; shift 2 ;;
    --swap) SWAP="$2"; shift 2 ;;
    --cores) CORES="$2"; shift 2 ;;
    --no-desktop) DESKTOP=0; shift ;;
    --force) FORCE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "error: unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

case "$TIER" in
  ubuntu) OST=ubuntu; TEMPLATE_VOLID="${ORI_PVE_TEMPLATE_UBUNTU:-}"; [ -z "$ROOTFS_GB" ] && ROOTFS_GB=16 ;;
  alpine) OST=alpine; TEMPLATE_VOLID="${ORI_PVE_TEMPLATE_ALPINE:-}"; [ -z "$ROOTFS_GB" ] && ROOTFS_GB=8 ;;
  *) echo "error: --template must be ubuntu or alpine (got '$TIER')" >&2; exit 2 ;;
esac
[ -n "$TEMPLATE_VOLID" ] || {
  echo "error: ORI_PVE_TEMPLATE_${TIER^^} is not set in .env.local" >&2
  exit 2
}

GOLDEN_TAG="ori-golden"
GOLDEN_DESC_PREFIX="ori golden image"

# The agent is a role of the single `ori` binary — not a separate artifact.
# Default to the freshest cross-built x86_64 musl binary (what build-all.sh
# produces), falling back to $ORI_PVE_AGENT_BIN / an explicit --agent-bin.
resolve_agent_bin() {
  local best="" cand
  if [ -n "$AGENT_BIN" ]; then
    if [ -f "$AGENT_BIN" ]; then
      printf '%s' "$AGENT_BIN"
    else
      printf 'MISSING:%s' "$AGENT_BIN"
    fi
    return
  fi
  if [ -n "${ORI_PVE_AGENT_BIN:-}" ] && [ -f "$ORI_PVE_AGENT_BIN" ]; then
    printf '%s' "$ORI_PVE_AGENT_BIN"
    return
  fi
  for cand in \
    "$ORI_REPO_ROOT/target/cross-x86/x86_64-unknown-linux-musl/release/ori" \
    "$ORI_REPO_ROOT/target/cross-x86_64/x86_64-unknown-linux-musl/release/ori" \
    "$ORI_REPO_ROOT/target/x86_64-unknown-linux-musl/release/ori"; do
    [ -f "$cand" ] || continue
    # freshest wins
    if [ -z "$best" ] || [ "$cand" -nt "$best" ]; then
      best="$cand"
    fi
  done
  printf '%s' "$best"
}
AGENT_BIN="$(resolve_agent_bin)"
case "$AGENT_BIN" in
  MISSING:*)
    echo "error: agent binary not found: ${AGENT_BIN#MISSING:}" >&2
    exit 2 ;;
esac

# The golden is amd64; a wrong-arch binary fails only inside the container at
# exec, which is the silent failure this card exists to kill. Check up front.
if [ -n "$AGENT_BIN" ]; then
  AGENT_BIN_KIND="$(file -b "$AGENT_BIN" 2>/dev/null || true)"
  case "$AGENT_BIN_KIND" in
    *x86-64*static*) echo "agent binary: $AGENT_BIN ($AGENT_BIN_KIND)" ;;
    *x86-64*)
      echo "WARN: agent binary is x86-64 but not statically linked: $AGENT_BIN_KIND" >&2 ;;
    *)
      echo "error: agent binary is not an x86-64 Linux ELF: $AGENT_BIN_KIND" >&2
      exit 2 ;;
  esac
fi

# ---------------------------------------------------------------------------
# vmid helpers
# ---------------------------------------------------------------------------

is_golden_ct() { # <vmid> -> 0 if the container carries our golden tag/desc
  local body
  body=$(pve_get "/api2/json/nodes/$ORI_NODE/lxc")
  printf '%s' "$body" | jq -e --argjson v "$1" --arg t "$GOLDEN_TAG" --arg d "$GOLDEN_DESC_PREFIX" \
    '.data[]? | select(.vmid == $v) | select(((."tags" // "") | contains($t)) or ((."description" // "") | contains($d)))' \
    >/dev/null 2>&1
}

resolve_existing_golden_vmid() {
  local body v
  body=$(pve_get "/api2/json/nodes/$ORI_NODE/lxc")
  v=$(printf '%s' "$body" | jq -r --arg t "$GOLDEN_TAG" --arg tier "$TIER" \
    '.data[]? | select((."tags" // "") | contains($t)) | select((."description" // "") | contains("tier="+$tier)) | .vmid' | head -1)
  [ -n "$v" ] && [ "$v" != "null" ] && printf '%s' "$v"
}

is_vmid_free() { # <vmid> -> 0 if not present on the node
  local body
  body=$(pve_get "/api2/json/nodes/$ORI_NODE/lxc")
  ! printf '%s' "$body" | jq -e --argjson v "$1" '.data[]? | select(.vmid == $v)' >/dev/null 2>&1
}

# create_golden <vmid> — exit 0 ok, 1 hard failure, 2 "vmid already exists"
create_golden() {
  local vmid="$1" resp upid
  resp=$(pve_post "/api2/json/nodes/$ORI_NODE/lxc" \
    --data-urlencode "vmid=$vmid" \
    --data-urlencode "ostemplate=$TEMPLATE_VOLID" \
    --data-urlencode "storage=$ORI_STORAGE" \
    --data-urlencode "hostname=ori-golden-$TIER-$vmid" \
    --data-urlencode "rootfs=${ORI_STORAGE}:${ROOTFS_GB}" \
    --data-urlencode "memory=$MEMORY" \
    --data-urlencode "swap=$SWAP" \
    --data-urlencode "cores=$CORES" \
    --data-urlencode "net0=name=eth0,bridge=${ORI_BRIDGE},ip=dhcp,type=veth" \
    --data-urlencode "unprivileged=1" \
    --data-urlencode "features=nesting=1" \
    --data-urlencode "ostype=$OST" \
    --data-urlencode "description=$GOLDEN_DESC_PREFIX tier=$TIER template=$TEMPLATE_VOLID" \
    --data-urlencode "tags=$GOLDEN_TAG")
  if [ "$(pve_http)" != "200" ]; then
    if printf '%s' "$resp" | grep -qi "already exists"; then
      return 2
    fi
    echo "error: create vmid $vmid failed: $(printf '%s' "$resp" | jq -r '.message // .' 2>/dev/null)" >&2
    return 1
  fi
  upid=$(printf '%s' "$resp" | jq -r '.data // empty')
  [ -n "$upid" ] || { echo "error: create vmid $vmid returned no task" >&2; return 1; }
  pve_wait_task "$ORI_NODE" "$upid" 300
}

# rebuild_existing <vmid> — replace a previous golden (ours, or --force)
rebuild_existing() {
  local vmid="$1"
  if is_golden_ct "$vmid"; then
    echo "existing golden $vmid is ours; rebuilding cleanly"
  elif [ "$FORCE" = "1" ]; then
    echo "existing container $vmid is NOT a tagged golden; --force given, rebuilding"
  else
    echo "error: vmid $vmid already exists and is not an ori golden image." >&2
    echo "       pass --force to destroy it, or choose a different --vmid." >&2
    exit 1
  fi
  cid_destroy "$vmid"
}

# ---------------------------------------------------------------------------
# cleanup trap — destroy what this invocation created on any failure
# ---------------------------------------------------------------------------

BUILD_OK=0
cleanup() {
  if [ "$BUILD_OK" = "1" ]; then
    return
  fi
  if [ -n "$VMID" ] && cid_exists "$VMID" 2>/dev/null; then
    echo "build failed; destroying half-built container $VMID" >&2
    cid_destroy "$VMID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# allocate the vmid
# ---------------------------------------------------------------------------

if [ -z "$VMID" ] && [ -n "${ORI_PVE_GOLDEN_VMID:-}" ]; then
  VMID="$ORI_PVE_GOLDEN_VMID"
fi

if [ -n "$VMID" ]; then
  if ! [[ "$VMID" =~ ^[0-9]+$ ]] || [ "$VMID" -lt 100 ]; then
    echo "error: --vmid must be a number >= 100 (got '$VMID')" >&2
    exit 2
  fi
  if [ "$VMID" -ge "$ORI_TEST_MIN" ] && [ "$VMID" -le "$ORI_TEST_MAX" ]; then
    echo "error: vmid $VMID is inside the test range ${ORI_TEST_MIN}-${ORI_TEST_MAX};" >&2
    echo "       that range is reserved for scratch/integration tests." >&2
    exit 2
  fi
  if cid_exists "$VMID"; then
    rebuild_existing "$VMID"
  fi
else
  reuse=$(resolve_existing_golden_vmid || true)
  if [ -n "$reuse" ]; then
    VMID="$reuse"
    echo "reusing existing golden vmid $VMID (tier=$TIER)"
    rebuild_existing "$VMID"
  fi
fi

# ---------------------------------------------------------------------------
# build (timed)
# ---------------------------------------------------------------------------

STEPS=()
T_START="$(date +%s)"
mark() { STEPS+=("$(date +%s) $1"); }

if [ -z "$VMID" ]; then
  # scan for a free vmid outside the test range, retrying on races
  candidate=
  rc=0
  for candidate in $(seq 300 9899); do
    [ "$candidate" -ge "$ORI_TEST_MIN" ] && [ "$candidate" -le "$ORI_TEST_MAX" ] && continue
    is_vmid_free "$candidate" || continue
    VMID="$candidate"
    if create_golden "$VMID"; then
      break
    fi
    rc=$?
    if [ "$rc" = "2" ]; then
      echo "vmid $VMID was taken concurrently; trying the next" >&2
      VMID=""
      continue
    fi
    exit "$rc"
  done
  [ -n "$VMID" ] || { echo "error: could not allocate a free vmid" >&2; exit 1; }
else
  if ! create_golden "$VMID"; then
    exit $?
  fi
fi
mark "create"

echo "golden container $VMID created from $TEMPLATE_VOLID"

# docker-in-LXC config (see infra/lxc/ori.sh for why these lines are needed)
lxc_ensure_docker_config "$VMID"
mark "lxc-config"

cid_start "$VMID"
mark "start"
echo "container started; waiting for it to accept exec"
exec_ready "$VMID" 180
mark "exec-ready"

# ---------------------------------------------------------------------------
# provisioning
# ---------------------------------------------------------------------------

LOCAL_TMP="$(mktemp -d)"
trap 'rm -rf "$LOCAL_TMP"' EXIT

PROV_DIR="/var/tmp/ori-golden-$VMID"
pve_ssh "rm -rf $PROV_DIR && mkdir -p $PROV_DIR"

AGENT_FLAG=0
if [ -n "$AGENT_BIN" ]; then
  # C25: the agent is a role of the single `ori` binary. It is pushed as
  # /tmp/ori and installed as /usr/local/bin/ori; the autostart supervisor
  # (image/ori-agent, which owns the wait-for-config / restart / log contract)
  # is pushed as /tmp/ori-agent.
  pve_ssh "cat > $PROV_DIR/ori" < "$AGENT_BIN"
  pve_ssh "pct push $VMID $PROV_DIR/ori /tmp/ori"
  pve_ssh "cat > $PROV_DIR/ori-agent" < "$ORI_SCRIPT_DIR/../image/ori-agent"
  pve_ssh "pct push $VMID $PROV_DIR/ori-agent /tmp/ori-agent"
  AGENT_FLAG=1
else
  echo "error: no ori agent binary found (run scripts/build-all.sh --target x86_64-unknown-linux-musl, or pass --agent-bin)." >&2
  echo "       a golden without the agent silently falls back to the slow exec path; that is not a deliverable." >&2
  exit 1
fi

# Desktop stack: the supervisor + the WebSocket-handshake probe come from
# image/ in the repo (see image/README.md), so the golden build is a pure
# function of this checkout.
if [ "$DESKTOP" = "1" ]; then
  pve_ssh "cat > $PROV_DIR/ori-desktop" < "$ORI_SCRIPT_DIR/../image/ori-desktop"
  pve_ssh "cat > $PROV_DIR/wscheck.py"   < "$ORI_SCRIPT_DIR/../image/wscheck.py"
  pve_ssh "pct push $VMID $PROV_DIR/ori-desktop /tmp/ori-desktop"
  pve_ssh "pct push $VMID $PROV_DIR/wscheck.py /tmp/wscheck.py"
fi

cat > "$LOCAL_TMP/provision.sh" <<'REMOTE'
#!/bin/sh
# Runs inside the freshly-created container. Env from the caller:
#   ORI_TIER, ORI_DESKTOP (0|1), ORI_AGENT (0|1)
set -e
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export DEBIAN_FRONTEND=noninteractive
export LC_ALL=C

echo "== base packages"
if [ "$ORI_TIER" = "ubuntu" ]; then
  apt-get update -qq >/dev/null 2>&1 || { echo "ERROR: apt-get update failed" >&2; exit 1; }
  if ! apt-get install -y -qq openssh-server openssh-client git ca-certificates curl docker.io >/tmp/ori-apt-base.log 2>&1; then
    echo "ERROR: base package install failed" >&2
    tail -n 40 /tmp/ori-apt-base.log >&2
    exit 1
  fi
else
  apk update >/dev/null 2>&1 || { echo "ERROR: apk update failed" >&2; exit 1; }
  if ! apk add --no-cache openssh openssh-client git curl ca-certificates docker docker-cli >/tmp/ori-apk-base.log 2>&1; then
    echo "ERROR: base package install failed" >&2
    tail -n 40 /tmp/ori-apk-base.log >&2
    exit 1
  fi
fi

echo "== sshd loopback-only"
mkdir -p /etc/ssh/sshd_config.d
printf 'ListenAddress 127.0.0.1\nListenAddress ::1\n' > /etc/ssh/sshd_config.d/10-ori-loopback.conf

echo "== boot services"
if [ "$ORI_TIER" = "ubuntu" ]; then
  systemctl enable ssh docker >/dev/null 2>&1 || true
else
  rc-update add sshd default >/dev/null 2>&1 || true
  rc-update add docker default >/dev/null 2>&1 || true
fi

echo "== work user"
if [ "$ORI_TIER" = "ubuntu" ]; then
  id work >/dev/null 2>&1 || useradd -m -s /bin/bash -U work
  usermod -aG docker work
else
  id work >/dev/null 2>&1 || adduser -D -s /bin/sh work
  addgroup work docker >/dev/null 2>&1 || true
fi

# No password login, but the account must NOT be locked.
#
# `passwd -l` (and busybox `adduser -D`, which is the alpine default) put `!`
# in the shadow field, which marks the account *locked* -- and sshd refuses
# public-key auth for a locked account. That produced
# "Permission denied (publickey)" against a correct authorized_keys file, with
# nothing in the sshd config to explain it.
#
# `*` is the right value: no password can ever match, so password login is
# impossible, but the account is not locked and key auth works. sed rather than
# usermod/passwd because busybox has neither flag consistently.
sed -i 's/^work:[^:]*:/work:*:/' /etc/shadow
echo "   work shadow field: $(grep '^work:' /etc/shadow | cut -d: -f2)"

echo "== desktop / VNC (Xvfb -> x11vnc -> websockify -> noVNC, loopback only)"
if [ "$ORI_DESKTOP" = "1" ]; then
  # image size before/after the desktop stack -- the delta is what every
  # pooled clone carries (see image/README.md).
  du -xsk / | cut -f1 > /tmp/ori-size-before

  if [ "$ORI_TIER" = "ubuntu" ]; then
    if ! apt-get install -y -qq --no-install-recommends xvfb fluxbox x11vnc websockify xterm fontconfig fonts-dejavu-core >/tmp/ori-apt-desktop.log 2>&1; then
      echo "ERROR: desktop package install failed" >&2
      tail -n 40 /tmp/ori-apt-desktop.log >&2
      exit 1
    fi
  else
    if ! apk add --no-cache fluxbox xvfb x11vnc websockify novnc xauth xterm fontconfig font-dejavu >/tmp/ori-apk-desktop.log 2>&1; then
      echo "ERROR: desktop package install failed" >&2
      tail -n 40 /tmp/ori-apk-desktop.log >&2
      exit 1
    fi
  fi

  # noVNC static assets. Alpine ships them in the 'novnc' package; ubuntu's
  # 'novnc' deb drags in nodejs, so pin the upstream release instead and
  # verify the checksum so the build is reproducible.
  if [ "$ORI_TIER" = "ubuntu" ]; then
    mkdir -p /usr/share/novnc
    if [ ! -f /usr/share/novnc/vnc.html ]; then
      rc=0
      for _attempt in 1 2 3; do
        if curl -fsSL -o /tmp/novnc.tar.gz \
            https://github.com/novnc/noVNC/archive/refs/tags/v1.5.0.tar.gz; then
          rc=0; break
        fi
        rc=1; sleep 2
      done
      [ "$rc" = 0 ] || { echo "ERROR: noVNC download failed" >&2; exit 1; }
      printf '%s  %s\n' \
        '6a73e41f98388a5348b7902f54b02d177cb73b7e5eb0a7a0dcf688cc2c79b42a' \
        /tmp/novnc.tar.gz | sha256sum -c - >/dev/null 2>&1 \
        || { echo "ERROR: noVNC tarball checksum mismatch" >&2; exit 1; }
      tar xzf /tmp/novnc.tar.gz -C /tmp
      cp -r /tmp/noVNC-1.5.0/* /usr/share/novnc/
      rm -rf /tmp/noVNC-1.5.0 /tmp/novnc.tar.gz
    fi
  fi
  [ -f /usr/share/novnc/vnc.html ] || { echo "ERROR: noVNC assets missing at /usr/share/novnc" >&2; exit 1; }

  # supervisor script (pushed from the repo as /tmp/ori-desktop)
  mkdir -p /usr/local/sbin
  install -m 0755 /tmp/ori-desktop /usr/local/sbin/ori-desktop

  if [ "$ORI_TIER" = "ubuntu" ]; then
    cat > /etc/systemd/system/ori-desktop.service <<'UNIT'
[Unit]
Description=ori desktop stack (Xvfb -> x11vnc -> websockify -> noVNC)
After=multi-user.target

[Service]
Type=simple
ExecStart=/usr/local/sbin/ori-desktop
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
    systemctl enable ori-desktop >/dev/null 2>&1 || true
  else
    cat > /etc/init.d/ori-desktop <<'INIT'
#!/sbin/openrc-run
name="ori-desktop"
description="ori desktop stack (Xvfb -> x11vnc -> websockify -> noVNC)"
command="/usr/local/sbin/ori-desktop"
command_background=true
pidfile="/run/${RC_SVCNAME}.pid"
depend() { need net; }
INIT
    chmod 0755 /etc/init.d/ori-desktop
    rc-update add ori-desktop default >/dev/null 2>&1 || true
  fi

  # start it now; a pooled clone starts it at boot via the unit instead.
  if [ "$ORI_TIER" = "ubuntu" ]; then
    systemctl start ori-desktop >/dev/null 2>&1 || true
  else
    rc-service ori-desktop start >/dev/null 2>&1 || true
  fi

  # fail-fast verification: X is up, VNC + websockify listen on loopback, and
  # websockify completes a WebSocket upgrade (it only answers 101 after it has
  # connected to x11vnc, so the handshake proves the whole chain).
  xok=0
  for _i in $(seq 1 25); do
    [ -S /tmp/.X11-unix/X99 ] && { xok=1; break; }
    sleep 1
  done
  [ "$xok" = 1 ] || { echo "ERROR: Xvfb did not come up" >&2; exit 1; }

  if [ "$ORI_TIER" = "ubuntu" ]; then
    vnc_ss=$(ss -tln 2>/dev/null | grep :5900 || true)
    ws_ss=$(ss -tln 2>/dev/null | grep :6080 || true)
  else
    vnc_ss=$(netstat -tln 2>/dev/null | grep :5900 || true)
    ws_ss=$(netstat -tln 2>/dev/null | grep :6080 || true)
  fi
  if ! printf '%s\n' "$vnc_ss" | grep -qE '127\.0\.0\.1:5900|\[::1\]:5900'; then
    echo "ERROR: x11vnc not listening on loopback (got: $(printf '%s' "$vnc_ss" | tr '\n' ' '))" >&2
    exit 1
  fi
  if ! printf '%s\n' "$ws_ss" | grep -qE '127\.0\.0\.1:6080|\[::1\]:6080'; then
    echo "ERROR: websockify not listening on loopback (got: $(printf '%s' "$ws_ss" | tr '\n' ' '))" >&2
    exit 1
  fi
  python3 /tmp/wscheck.py || { echo "ERROR: websockify WebSocket handshake failed" >&2; exit 1; }

  du -xsk / | cut -f1 > /tmp/ori-size-after
fi

echo "== ori agent"
if [ "$ORI_AGENT" = "1" ]; then
  # image size before/after the agent -- the delta is what every pooled clone
  # carries (see image/README.md). The agent is ~14 MB, but say so rather than
  # leaving the cost unknown.
  du -xsk / | cut -f1 > /tmp/ori-agent-size-before

  install -m 0755 /tmp/ori /usr/local/bin/ori
  mkdir -p /etc/ori

  # C25 autostart supervisor (pushed from the repo as /tmp/ori-agent): waits
  # for /etc/ori/agent.json (a pool member is cloned before it is claimed), so
  # the config arriving after boot does not fail the unit; restarts the agent
  # on exit; logs to /var/log/ori-agent/agent.log.
  install -m 0755 /tmp/ori-agent /usr/local/sbin/ori-agent

  if [ "$ORI_TIER" = "ubuntu" ]; then
    cat > /etc/systemd/system/ori-agent.service <<'UNIT'
[Unit]
Description=ori guest agent (tunnel to control plane)
After=multi-user.target

[Service]
Type=simple
ExecStart=/usr/local/sbin/ori-agent
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
    systemctl enable ori-agent >/dev/null 2>&1 || true
  else
    cat > /etc/init.d/ori-agent <<'INIT'
#!/sbin/openrc-run
name="ori-agent"
description="ori guest agent (tunnel to control plane)"
command="/usr/local/sbin/ori-agent"
command_background=true
pidfile="/run/${RC_SVCNAME}.pid"
depend() { need net; }
INIT
    chmod 0755 /etc/init.d/ori-agent
    rc-update add ori-agent default >/dev/null 2>&1 || true
  fi

  # start it now; a pooled clone starts it at boot via the unit instead. With
  # no agent.json yet it must sit *waiting*, not fail.
  if [ "$ORI_TIER" = "ubuntu" ]; then
    systemctl start ori-agent >/dev/null 2>&1 || true
  else
    rc-service ori-agent start >/dev/null 2>&1 || true
  fi

  # fail-fast: the supervisor is up and its log exists (an empty agent log
  # cost real debugging time earlier).
  agok=0
  for _i in $(seq 1 20); do
    if [ "$ORI_TIER" = "ubuntu" ]; then
      systemctl is-active --quiet ori-agent && { agok=1; break; }
    else
      pgrep -f /usr/local/sbin/ori-agent >/dev/null 2>&1 && { agok=1; break; }
    fi
    sleep 1
  done
  [ "$agok" = 1 ] || { echo "ERROR: ori-agent supervisor not running" >&2; exit 1; }
  [ -f /var/log/ori-agent/agent.log ] || { echo "ERROR: agent log missing at /var/log/ori-agent/agent.log" >&2; exit 1; }

  du -xsk / | cut -f1 > /tmp/ori-agent-size-after
fi

echo "== sshd running now (loopback binding verified at boot too)"
if [ "$ORI_TIER" = "ubuntu" ]; then
  systemctl restart ssh >/dev/null 2>&1 || true
else
  rc-service sshd restart >/dev/null 2>&1 || true
fi

echo "== verify installed surface"
command -v sshd >/dev/null || { echo "ERROR: sshd missing" >&2; exit 1; }
command -v git  >/dev/null || { echo "ERROR: git missing"  >&2; exit 1; }
command -v docker >/dev/null || { echo "ERROR: docker missing" >&2; exit 1; }
id work >/dev/null || { echo "ERROR: work user missing" >&2; exit 1; }
if [ "$ORI_AGENT" = "1" ]; then
  [ -x /usr/local/bin/ori ] || { echo "ERROR: ori binary missing" >&2; exit 1; }
  [ -x /usr/local/sbin/ori-agent ] || { echo "ERROR: ori-agent supervisor missing" >&2; exit 1; }
fi
if [ "$ORI_DESKTOP" = "1" ]; then
  command -v Xvfb      >/dev/null || { echo "ERROR: Xvfb missing" >&2; exit 1; }
  command -v x11vnc    >/dev/null || { echo "ERROR: x11vnc missing" >&2; exit 1; }
  command -v websockify >/dev/null || { echo "ERROR: websockify missing" >&2; exit 1; }
  [ -x /usr/local/sbin/ori-desktop ] || { echo "ERROR: ori-desktop missing" >&2; exit 1; }
fi
rm -f /tmp/ori-provision.sh /tmp/ori /tmp/ori-agent /tmp/ori-desktop /tmp/wscheck.py
echo "provision ok"
if [ "$ORI_DESKTOP" = "1" ]; then
  b=$(cat /tmp/ori-size-before); a=$(cat /tmp/ori-size-after)
  echo "desktop rootfs: before=${b}KiB after=${a}KiB delta=$((a - b))KiB"
fi
if [ "$ORI_AGENT" = "1" ]; then
  b=$(cat /tmp/ori-agent-size-before); a=$(cat /tmp/ori-agent-size-after)
  echo "agent rootfs: before=${b}KiB after=${a}KiB delta=$((a - b))KiB"
fi
REMOTE

pve_ssh "cat > $PROV_DIR/provision.sh" < "$LOCAL_TMP/provision.sh"
pve_ssh "pct push $VMID $PROV_DIR/provision.sh /tmp/ori-provision.sh"

T_PROV="$(date +%s)"
PROV_OUT=$(pve_ssh "pct exec $VMID -- env ORI_TIER=$TIER ORI_DESKTOP=$DESKTOP ORI_AGENT=$AGENT_FLAG sh /tmp/ori-provision.sh")
printf '%s\n' "$PROV_OUT"
DESKTOP_SIZE=""
if [ "$DESKTOP" = "1" ]; then
  DESKTOP_SIZE=$(printf '%s\n' "$PROV_OUT" | grep -oE 'desktop rootfs: .*' | tail -1)
fi
AGENT_SIZE=""
if [ "$AGENT_FLAG" = "1" ]; then
  AGENT_SIZE=$(printf '%s\n' "$PROV_OUT" | grep -oE 'agent rootfs: .*' | tail -1)
fi
mark "provision"

# sanity: sshd is listening, and only on loopback
binds=$(pve_ssh "pct exec $VMID -- sh -c 'ss -tln 2>/dev/null || netstat -tln 2>/dev/null' | grep :22" 2>/dev/null || true)
if [ -n "$binds" ]; then
  if printf '%s' "$binds" | grep -qE '127\.0\.0\.1|\[::1\]'; then
    echo "sshd binds loopback only: $(printf '%s' "$binds" | grep -oE '[0-9.:\[\]]+:22' | tr '\n' ' ')"
  else
    echo "WARN: sshd listener not obviously loopback-only:" >&2
    printf '%s\n' "$binds" >&2
  fi
else
  echo "WARN: could not see an sshd :22 listener (verify in the clone proof)" >&2
fi

# stop -> snapshot base. Clone timings (1.65-1.83 s) are only valid from a
# stopped, clean golden; snapshotting a running container is not our pool path.
cid_stop "$VMID"
mark "stop"
cid_snapshot "$VMID" base
mark "snapshot"

# verify the snapshot actually exists
snap_ok=$(pve_get "/api2/json/nodes/$ORI_NODE/lxc/$VMID/snapshot" | jq -r '[.data[]?.name] | index("base") != null')
[ "$snap_ok" = "true" ] || { echo "error: snapshot 'base' not found after snapshot call" >&2; exit 1; }

pve_ssh "rm -rf $PROV_DIR"

BUILD_OK=1

echo
echo "golden build complete"
echo "  vmid        = $VMID"
echo "  snapshot    = base"
echo "  tier        = $TIER"
echo "  template    = $TEMPLATE_VOLID"
echo "  state       = stopped"
echo "  rootfs      = ${ORI_STORAGE}:${ROOTFS_GB}"
echo "  agent       = $([ "$AGENT_FLAG" = 1 ] && echo "baked-in ($(basename "$AGENT_BIN"))" || echo "not baked (see WARN above)")"
echo "  desktop     = $([ "$DESKTOP" = 1 ] && echo installed || echo skipped)"
[ -n "$AGENT_SIZE" ] && echo "  agent size  = $AGENT_SIZE"
[ -n "$DESKTOP_SIZE" ] && echo "  desktop size= $DESKTOP_SIZE"
echo
echo "timings (wall clock):"
prev="$T_START"
for entry in "${STEPS[@]}"; do
  ts="${entry%% *}"
  name="${entry#* }"
  printf '  %-14s %ss\n' "$name" "$((ts - prev))"
  prev="$ts"
done
printf '  %-14s %ss\n' "total" "$(( $(date +%s) - T_START ))"
echo
echo "pool config input:"
echo "  ORI_GOLDEN_VMID=$VMID"
echo "  ORI_GOLDEN_SNAPSHOT=base"
echo "  ORI_GOLDEN_TIER=$TIER"