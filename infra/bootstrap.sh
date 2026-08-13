#!/usr/bin/env bash
# ori-infra host bootstrap — fresh Ubuntu 24.04 (noble) bare-metal host
#
# Installs and configures, idempotently (safe to rerun):
#   1. Incus (VM orchestration) with a ZFS storage pool
#   2. the routed network: a bridge where the host owns <ORI_SUBNET>.1 and
#      every ori gets its own routed IPv4 from <ORI_SUBNET> (Incus routed NIC)
#   3. Caddy (the edge) + this repo's Caddyfile and env file
#   4. the host firewall: port 7777 on every ori reachable ONLY from the
#      control plane, never from the internet
#   5. systemd units + an unprivileged control-plane service user
#
# Run as root:
#     sudo ./infra/bootstrap.sh
#
# Everything that can fail is either written atomically (firewall via
# iptables-restore) or left in an explicitly-documented state, so a failure
# never leaves a half-locked host. SSH (22) is always left open.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Configuration (env-overridable, with sane dev defaults)
# ---------------------------------------------------------------------------
# The routed subnet oris are carved from; the BOTTOM of it is the host/gateway
# and oris get .2, .3, ...
ORI_SUBNET="${ORI_SUBNET:-10.10.0.0/24}"          # e.g. 10.10.0.0/24 (private) or a public /29
EDGE_DOMAIN="${EDGE_DOMAIN:-ori.local}"
CONTROL_PLANE_PORT="${CONTROL_PLANE_PORT:-8080}"  # ori-api listen port (load-bearing: firewall + caddy env)
ZFS_POOL="${ZFS_POOL:-tank}"
ZFS_POOL_SIZE="${ZFS_POOL_SIZE:-50G}"             # loop-file zpool size on a fresh host
ORI_BRIDGE="${ORI_BRIDGE:-incusbr0}"
WAN_IF="${WAN_IF:-$(ip -o route get 8.8.8.8 2>/dev/null | awk '{print $5; exit}' | head -n1)}"
WAN_IF="${WAN_IF:-eth0}"

# Gateway/bridge address on the ori subnet. Deriving the..1 address is correct
# for a /24 (the default). ponytail: for a non-/24 subnet (e.g. a public /29)
# the .1 address may fall outside the range; set GATEWAY explicitly.
GATEWAY="${GATEWAY:-$(printf '%s' "$ORI_SUBNET" | cut -d/ -f1 | awk -F. '{print $1"."$2"."$3".1"}')}"
MASK="$(printf '%s' "$ORI_SUBNET" | cut -d/ -f2)"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

is_private_subnet() {
  local net="$1"
  case "$net" in
    10.*|192.168.*)                       return 0 ;;
    172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) return 0 ;;
  esac
  return 1
}

require_root() { [ "$(id -u)" -eq 0 ] || die "must run as root (sudo)"; }

# ---------------------------------------------------------------------------
# apt helpers
# ---------------------------------------------------------------------------
apt_pkg() { dpkg -s "$1" >/dev/null 2>&1; }

apt_install() {
  # install only the packages that are not already present
  local missing=()
  local p
  for p in "$@"; do
    apt_pkg "$p" || missing+=("$p")
  done
  [ ${#missing[@]} -eq 0 ] && return 0
  DEBIAN_FRONTEND=noninteractive apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y -o Dpkg::Options::=--force-confold "${missing[@]}"
}

# ---------------------------------------------------------------------------
# 1. Incus + ZFS + routed network
# ---------------------------------------------------------------------------
setup_zfs_pool() {
  log "storage: ZFS pool '$ZFS_POOL'"
  apt_install zfsutils-linux
  if ! zpool list "$ZFS_POOL" >/dev/null 2>&1; then
    mkdir -p /var/lib/incus/disks
    local img="/var/lib/incus/disks/$ZFS_POOL.img"
    # Fresh host with no spare disk: back the pool with a loop file under the
    # host filesystem. ponytail ceiling: production hosts should present a real
    # dedicated disk/zpool (nvme/sata) and set ZFS_POOL to it; remove $img then.
    truncate --size="$ZFS_POOL_SIZE" "$img"
    zpool create -f "$ZFS_POOL" "$img"
  fi
}

incus_initialized() { incus storage list --format csv 2>/dev/null | grep -q .; }

setup_incus() {
  log "incus: installing"
  apt_install incus
  systemctl enable --now incus incus.socket >/dev/null 2>&1 || true

  if ! incus_initialized; then
    log "incus: first-time init via preseed"
    cat >/tmp/incus-preseed.yaml <<YAML
config: {}
networks:
- name: ${ORI_BRIDGE}
  type: bridge
  config:
    ipv4.address: ${GATEWAY}/${MASK}
    ipv4.nat: "false"
    ipv6.address: none
storage_pools:
- name: default
  driver: zfs
  config:
    source: ${ZFS_POOL}
profiles:
- name: default
  config: {}
  devices:
    root:
      path: /
      pool: default
projects: []
cluster: null
YAML
    incus admin init --preseed </tmp/incus-preseed.yaml
  else
    # Rerun on an already-initialized host: ensure the pieces exist.
    log "incus: already initialized; ensuring pool + network"
    if ! incus storage show default >/dev/null 2>&1; then
      incus storage create default zfs source="$ZFS_POOL"
    fi
    if ! incus network show "$ORI_BRIDGE" >/dev/null 2>&1; then
      incus network create "$ORI_BRIDGE" --type bridge \
        ipv4.address="$GATEWAY/$MASK" ipv4.nat=false ipv6.address=none
    fi
  fi
  log "incus: ready (network=$ORI_BRIDGE subnet=$ORI_SUBNET gateway=$GATEWAY/$MASK)"
}

# ---------------------------------------------------------------------------
# 3. Caddy edge
# ---------------------------------------------------------------------------
install_caddy() {
  log "caddy: installing stable from dl.cloudsmith.io"
  command -v caddy >/dev/null 2>&1 && return 0
  local keyring=/usr/share/keyrings/caddy-stable-archive-keyring.gpg
  mkdir -p /etc/apt/keyrings
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o "$keyring"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y caddy
}

configure_caddy() {
  log "caddy: writing config + env"
  install -m 0644 "$SCRIPT_DIR/Caddyfile" /etc/caddy/Caddyfile
  # Dev default lives here; the operator overrides EDGE_DOMAIN /
  # CONTROL_PLANE_BASE for production. chmod 600: contains nothing secret
  # today, but keep the control-plane base private.
  umask 077
  cat >/etc/caddy/edge.env <<ENV
EDGE_DOMAIN=${EDGE_DOMAIN}
CONTROL_PLANE_BASE=http://127.0.0.1:${CONTROL_PLANE_PORT}
ENV
  umask 022
  install -d /etc/systemd/system/caddy.service.d
  install -m 0644 "$SCRIPT_DIR/systemd/caddy.service.d/edge.conf" \
    /etc/systemd/system/caddy.service.d/edge.conf
  systemctl daemon-reload
  systemctl enable --now caddy >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# 4. Host firewall (load-bearing)
# ---------------------------------------------------------------------------
apply_firewall() {
  log "firewall: writing netfilter rules (port 7777 = control plane only)"
  apt_install iptables iptables-persistent iproute2

  # Ori agents reach the control plane at GATEWAY:CONTROL_PLANE_PORT; only the
  # ori subnet and loopback are allowed to reach it.
  mkdir -p /etc/iptables

  local masq="# (no NAT: ORI_SUBNET is a public range)"
  if is_private_subnet "$ORI_SUBNET"; then
    # Oris on a private range get internet egress by masquerading through the
    # host's default-route interface. ponytail: with a public /29, remove this
    # line and advertise the range so oris keep their dedicated IPv4 (the
    # product's "dedicated IPv4" promise). NAT hides it.
    masq="-A POSTROUTING -s ${ORI_SUBNET} ! -d ${ORI_SUBNET} -o ${WAN_IF} -j MASQUERADE"
  fi

  cat >/etc/iptables/rules.v4 <<EOT
*filter
:INPUT DROP [0:0]
:FORWARD DROP [0:0]
:OUTPUT ACCEPT [0:0]
-A INPUT -i lo -j ACCEPT
-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A INPUT -p tcp --dport 22 -j ACCEPT
-A INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT
-A INPUT -p icmp -j ACCEPT
-A INPUT -s ${ORI_SUBNET} -p tcp --dport ${CONTROL_PLANE_PORT} -j ACCEPT
-A INPUT -s 127.0.0.0/8 -p tcp --dport ${CONTROL_PLANE_PORT} -j ACCEPT
-A FORWARD -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
# ori agent :7777 — allowed only from the control plane address, then blocked
# for every other source (the internet, and other oris on the same bridge).
-A FORWARD -s ${GATEWAY} -d ${ORI_SUBNET} -p tcp --dport 7777 -j ACCEPT
-A FORWARD -d ${ORI_SUBNET} -p tcp --dport 7777 -j DROP
# direct SSH to a ori (no bastion).
-A FORWARD -d ${ORI_SUBNET} -p tcp --dport 22 -j ACCEPT
# oris initiate outbound traffic.
-A FORWARD -s ${ORI_SUBNET} -j ACCEPT
# deny anything else inbound to the ori subnet.
-A FORWARD -d ${ORI_SUBNET} -j DROP
COMMIT
*nat
:PREROUTING ACCEPT [0:0]
:INPUT ACCEPT [0:0]
:OUTPUT ACCEPT [0:0]
:POSTROUTING ACCEPT [0:0]
${masq}
COMMIT
EOT

  cat >/etc/iptables/rules.v6 <<EOT
*filter
:INPUT DROP [0:0]
:FORWARD DROP [0:0]
:OUTPUT ACCEPT [0:0]
-A INPUT -i lo -j ACCEPT
-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A INPUT -p tcp --dport 22 -j ACCEPT
-A INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT
-A INPUT -p ipv6-icmp -j ACCEPT
COMMIT
EOT

  # Makes bridged (ori<->ori) traffic traverse the FORWARD chain so the 7777
  # drop also protects one ori from another ori.
  modprobe br_netfilter >/dev/null 2>&1 || true
  sysctl -w net.bridge.bridge-nf-call-iptables=1 >/dev/null 2>&1 || true

  # Atomic load: a malformed file fails the whole restore; the host keeps its
  # previous (or empty) policy and is never half-locked. SSH stays open above.
  iptables-restore </etc/iptables/rules.v4
  ip6tables-restore </etc/iptables/rules.v6

  # Persist the exact same files across reboots.
  systemctl enable netfilter-persistent >/dev/null 2>&1 || true
  netfilter-persistent reload >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# 5. sysctls the routed mode needs
# ---------------------------------------------------------------------------
apply_sysctls() {
  log "sysctl: ip forwarding + bridge filtering"
  cat >/etc/sysctl.d/99-ori-network.conf <<EOT
# Routed Incus NICs: the host must forward ori packets.
net.ipv4.ip_forward = 1
net.ipv4.conf.all.forwarding = 1
net.ipv4.conf.default.forwarding = 1
# IPv6 routing is unused in v1; keep it off.
net.ipv6.conf.all.forwarding = 0
# Force bridged (ori<->ori) traffic through the iptables FORWARD chain.
net.bridge.bridge-nf-call-iptables = 1
EOT
  sysctl --system >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# 2/5b. ori service user + env files + unit install (control plane shell)
# ---------------------------------------------------------------------------
setup_control_plane() {
  log "control plane: service user + units + env shells"
  id -u ori >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/ori \
    --shell /usr/sbin/nologin ori
  usermod -aG incus-admin ori
  install -d -o ori -g ori /var/lib/ori /etc/ori

  umask 077
  if [ ! -f /etc/ori/ori-api.env ]; then
    cat >/etc/ori/ori-api.env <<ENV
PORT=${CONTROL_PLANE_PORT}
# Operator sets this to the real DSN before starting ori-api (see README).
DATABASE_URL=
ENV
  fi
  umask 022

  install -m 0644 "$SCRIPT_DIR/systemd/ori-api.service" /etc/systemd/system/ori-api.service
  systemctl daemon-reload
  # Enable so it auto-starts once deployed; do NOT start now — that is the
  # operator's deploy step (binary + DATABASE_URL first), see README.
  systemctl enable ori-api >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
main() {
  require_root
  log "ori host bootstrap: subnet=$ORI_SUBNET domain=$EDGE_DOMAIN ctrl=:${CONTROL_PLANE_PORT} wan=$WAN_IF"

  apt_install curl jq

  setup_zfs_pool
  setup_incus
  apply_sysctls
  install_caddy
  configure_caddy
  apply_firewall
  setup_control_plane

  log "done. Next (operator):"
  printf '  1. deploy the control-plane binary to /usr/local/bin/ori-api\n'
  printf '  2. set DATABASE_URL in /etc/ori/ori-api.env (create the Postgres store)\n'
  printf '  3. systemctl enable --now ori-api\n'
  printf '  4. for production: set EDGE_DOMAIN (real domain) in /etc/caddy/edge.env and restart caddy\n'
}
main "$@"

# ---------------------------------------------------------------------------
# OPTIONAL: Firecracker driver (stage 1) — opt in with ORI_ENABLE_FIRECRACKER=1
#
# Stage 1 only boots VMs on KVM; memory-snapshot warm resume is stage 2 (not
# here). Idempotently adds, when enabled:
#   - firecracker + jailer release binaries to /usr/local/bin, pinned to
#     FIRECRACKER_VERSION
#   - the VM bridge ori-fc0 at 172.30.0.1/16, persisted via netplan (the
#     standard mechanism on the Ubuntu 24.04 target)
#   - a MASQUERADE rule for 172.30.0.0/16, persisted in the SAME
#     /etc/iptables/rules.v4 file netfilter-persistent restores at boot (the
#     same mechanism apply_firewall already uses)
#   - the ori service user in the kvm group so the control plane can drive
#     /dev/kvm (jailer requirement)
#
# See docs/OPERATIONS.md → "Firecracker driver (stage 1)".
# ---------------------------------------------------------------------------
FIRECRACKER_VERSION="${FIRECRACKER_VERSION:-v1.10.1}"
FIRECRACKER_BRIDGE="${FIRECRACKER_BRIDGE:-ori-fc0}"
FIRECRACKER_SUBNET="${FIRECRACKER_SUBNET:-172.30.0.0/16}"
FIRECRACKER_GATEWAY="${FIRECRACKER_GATEWAY:-172.30.0.1}"

fc_arch() {
  case "$(uname -m)" in
    x86_64)        printf 'x86_64' ;;
    aarch64|arm64) printf 'aarch64' ;;
    *) die "firecracker: unsupported host arch: $(uname -m)" ;;
  esac
}

install_firecracker() {
  if [ -x /usr/local/bin/firecracker ] && [ -x /usr/local/bin/jailer ]; then
    log "firecracker: binaries already installed (skip)"
    return 0
  fi
  local arch fc_tgz
  arch="$(fc_arch)"
  fc_tgz="/tmp/firecracker-${FIRECRACKER_VERSION}-${arch}.tgz"
  log "firecracker: fetching ${FIRECRACKER_VERSION} (${arch}) from GitHub releases"
  curl -1sLf "https://github.com/firecracker-microvm/firecracker/releases/download/${FIRECRACKER_VERSION}/firecracker-${FIRECRACKER_VERSION}-${arch}.tgz" \
    -o "$fc_tgz"
  tar -xzf "$fc_tgz" -C /tmp
  install -m 0755 "/tmp/release-${FIRECRACKER_VERSION}-${arch}/firecracker-${FIRECRACKER_VERSION}" /usr/local/bin/firecracker
  install -m 0755 "/tmp/release-${FIRECRACKER_VERSION}-${arch}/jailer-${FIRECRACKER_VERSION}" /usr/local/bin/jailer
  rm -rf "$fc_tgz" "/tmp/release-${FIRECRACKER_VERSION}-${arch}"
  log "firecracker: firecracker + jailer installed to /usr/local/bin"
}

setup_fc_bridge() {
  log "firecracker: bridge ${FIRECRACKER_BRIDGE} (${FIRECRACKER_GATEWAY}/${FIRECRACKER_SUBNET#*/})"
  # Persist the bridge via netplan — the same "write a file under /etc, then
  # apply" pattern the sysctl.d and /etc/iptables files use above. The YAML is
  # additive: it only declares the fc bridge and leaves every other interface
  # untouched. Re-running is safe (file already present ⇒ skip write).
  if [ ! -f /etc/netplan/10-ori-fc0.yaml ]; then
    cat >/etc/netplan/10-ori-fc0.yaml <<NETPLAN
network:
  version: 2
  bridges:
    ${FIRECRACKER_BRIDGE}:
      addresses:
        - ${FIRECRACKER_GATEWAY}/${FIRECRACKER_SUBNET#*/}
      parameters:
        forward-delay: 0
        stp: false
NETPLAN
  fi
  netplan apply
}

setup_fc_firewall() {
  log "firecracker: NAT masquerade for ${FIRECRACKER_SUBNET}"
  # Same persistence mechanism as apply_firewall: keep the rule inside the
  # /etc/iptables/rules.v4 file that netfilter-persistent restores on boot.
  # (VM egress also needs a FORWARD accept for ${FIRECRACKER_SUBNET} in
  # rules.v4 if you want firecracker VMs to reach the internet — the stage-1
  # default only installs the NAT rule.)
  [ -f /etc/iptables/rules.v4 ] || die "firecracker: /etc/iptables/rules.v4 missing — run the host firewall step first"
  local fc_rule="-A POSTROUTING -s ${FIRECRACKER_SUBNET} ! -d ${FIRECRACKER_SUBNET} -o ${WAN_IF} -j MASQUERADE"
  if ! grep -qF "${FIRECRACKER_SUBNET}" /etc/iptables/rules.v4; then
    # insert the rule into the *nat table, immediately before its COMMIT.
    awk -v rule="$fc_rule" '
      $0 == "*nat" { in_nat = 1 }
      in_nat && $0 == "COMMIT" && !done { print rule; done = 1; in_nat = 0 }
      { print }
    ' /etc/iptables/rules.v4 >/etc/iptables/rules.v4.tmp
    mv /etc/iptables/rules.v4.tmp /etc/iptables/rules.v4
  fi
  iptables-restore </etc/iptables/rules.v4
  systemctl enable netfilter-persistent >/dev/null 2>&1 || true
  netfilter-persistent reload >/dev/null 2>&1 || true
}

setup_fc_kvm() {
  if getent group kvm >/dev/null 2>&1; then
    log "firecracker: adding 'ori' to kvm group"
    usermod -aG kvm ori
  else
    die "firecracker: no kvm group — the firecracker driver requires KVM (see docs/OPERATIONS.md)"
  fi
}

setup_firecracker() {
  log "firecracker: stage 1 driver host setup"
  install_firecracker
  setup_fc_bridge
  setup_fc_firewall
  setup_fc_kvm
  log "firecracker: done. Set ORI_DRIVER=firecracker in /etc/ori/ori-api.env (docs/OPERATIONS.md)."
}

if [ "${ORI_ENABLE_FIRECRACKER:-0}" = "1" ]; then
  setup_firecracker
fi
