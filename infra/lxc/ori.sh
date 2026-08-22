#!/usr/bin/env bash
# infra/lxc/ori.sh — the docker-in-LXC config for an ori container.
#
# Referenced by the running ori control-plane container on the project host
# (/etc/pve/lxc/106.conf):
#
#   # ori: docker inside this container loads an AppArmor profile per
#   # container, which the default LXC profile denies. See infra/lxc/ori.sh.
#
# Why these lines (measured on the project host, kernel 7.0.0-3-pve):
#   lxc.apparmor.profile: unconfined
#       the default LXC profile denies the apparmor LSM work docker does
#       per container; unconfining the *outer* container is required.
#   lxc.cgroup2.devices.allow: a
#       docker needs device cgroup access inside the sandbox.
#   lxc.cap.drop:            (empty — drop nothing)
#       the default cap.drop strips CAP_MAC_ADMIN/others docker relies on.
#   lxc.mount.entry: tmpfs sys/module tmpfs ...
#       UNPRIVILEGED containers only. An unprivileged container's uid-100000
#       root can never open /sys/kernel/security/apparmor/profiles (the kernel
#       gates it on CAP_MAC_ADMIN in the init user namespace), so dockerd's
#       apparmor self-check fails. Masking /sys/module makes dockerd's probe
#       for apparmor module parameters return ENOENT, which moby treats as
#       "apparmor not enabled" — docker then runs cleanly (overlayfs).
#
# Usage:
#   infra/lxc/ori.sh <vmid>            apply the config (idempotent)
#   infra/lxc/ori.sh <vmid> --remove   strip the lines
#
# Runs over SSH to the Proxmox host (from .env.local) or directly if pct is
# present locally. The container must be STOPPED for the changes to be picked
# up (they take effect at the next start).

set -euo pipefail
ORI_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "$ORI_SCRIPT_DIR/.env.local" ]; then
  # shellcheck source=../scripts/lib.sh
  . "$ORI_SCRIPT_DIR/scripts/lib.sh"
else
  # Running directly on the Proxmox host: no .env.local needed.
  set -euo pipefail
fi

if [ -n "${ORI_PVE_SSH:-}" ]; then
  run() { pve_ssh "$*"; }
else
  run() { "$@"; }
fi

usage() {
  cat <<EOF
usage: infra/lxc/ori.sh <vmid> [--remove]
EOF
}

VMID=""
REMOVE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --remove) REMOVE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *)
      [ -z "$VMID" ] || { echo "error: unexpected argument: $1" >&2; usage; exit 2; }
      VMID="$1"; shift ;;
  esac
done
[ -n "$VMID" ] || { usage >&2; exit 2; }

CONF="/etc/pve/lxc/$VMID.conf"

if ! run "test -f $CONF"; then
  echo "error: $CONF not found on the host (container $VMID does not exist?)" >&2
  exit 1
fi

UNPRIV=0
if run "grep -q '^unprivileged: 1' $CONF"; then
  UNPRIV=1
fi

BUILD_CONFIG() {
  printf '%s\n' \
    "lxc.apparmor.profile: unconfined" \
    "lxc.cgroup2.devices.allow: a" \
    "lxc.cap.drop:"
  if [ "$UNPRIV" = "1" ]; then
    printf '%s\n' "lxc.mount.entry: tmpfs sys/module tmpfs rw,nosuid,nodev,noexec,relatime,mode=755 0 0"
  fi
}

if [ "$REMOVE" = "1" ]; then
  if run "grep -q '^lxc.apparmor.profile: unconfined' $CONF"; then
    run "sed -i '/^lxc.apparmor.profile: unconfined$/d;/^lxc.cgroup2.devices.allow: a$/d;/^lxc.cap.drop:$/d;/^lxc.mount.entry: tmpfs sys\\/module /d' $CONF"
    echo "removed docker-in-LXC config from $CONF"
  else
    echo "no docker-in-LXC config present on $CONF; nothing to remove"
  fi
  exit 0
fi

# Apply (idempotent): append only the lines that are missing.
BUILD_CONFIG | while IFS= read -r line; do
  if ! run "grep -qF -- '$line' $CONF"; then
    run "printf '%s\\n' '$line' >> $CONF"
  fi
done

echo "docker-in-LXC config for $VMID (unprivileged=$UNPRIV):"
run "grep -E '^(lxc\\.|unprivileged:)' $CONF"
echo
echo "stop the container and start it again for the config to take effect."
exit 0