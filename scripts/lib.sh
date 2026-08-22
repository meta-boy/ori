#!/usr/bin/env bash
# Shared helpers for ori infra scripts (golden-build.sh, preflight.sh).
# Source this file; do not execute it directly.
#
# Everything talks to the Proxmox REST API (token auth) for lifecycle and to
# the host over SSH (ORI_PVE_SSH) for pct exec / config-file surgery that the
# API does not expose. Credentials come from $ORI_REPO_ROOT/.env.local, which
# is git-ignored; nothing here ever prints a secret.

if [ "${ORI_LIB_LOADED:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi
ORI_LIB_LOADED=1

set -euo pipefail

ORI_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

load_ori_env() {
  if [ -f "$ORI_REPO_ROOT/.env.local" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$ORI_REPO_ROOT/.env.local"
    set +a
  fi
}

require_ori_env() {
  local missing=0
  local v
  for v in ORI_PVE_HOST ORI_PVE_TOKEN_ID ORI_PVE_TOKEN_SECRET ORI_PVE_NODE \
    ORI_PVE_STORAGE ORI_PVE_BRIDGE ORI_PVE_SSH; do
    if [ -z "${!v:-}" ]; then
      echo "error: $v is not set. Define it in $ORI_REPO_ROOT/.env.local" >&2
      missing=1
    fi
  done
  [ "$missing" = 0 ] || exit 2
}

load_ori_env
require_ori_env

ORI_NODE="${ORI_PVE_NODE}"
ORI_STORAGE="${ORI_PVE_STORAGE}"
ORI_BRIDGE="${ORI_PVE_BRIDGE}"
ORI_TEST_MIN="${ORI_PVE_TEST_VMID_MIN:-9000}"
ORI_TEST_MAX="${ORI_PVE_TEST_VMID_MAX:-9099}"

# Defaults for the pool that preflight reports headroom against. Operators can
# override in .env.local.
ORI_POOL_DEPTH="${ORI_PVE_POOL_DEPTH:-8}"
ORI_POOL_SLOT_GB="${ORI_PVE_POOL_SLOT_GB:-8}"

# ---------------------------------------------------------------------------
# curl + ssh
# ---------------------------------------------------------------------------

read -r -a ORI_SSH_ARGS <<< "${ORI_PVE_SSH}"
ORI_AUTH="Authorization: PVEAPIToken=${ORI_PVE_TOKEN_ID}=${ORI_PVE_TOKEN_SECRET}"

# pve_curl <method> <path> [curl args...]
#   echoes the response body; sets $ORI_HTTP to the http status code.
pve_curl() {
  local method="$1" path="$2"
  shift 2
  local out
  out=$(curl -sk -sS --max-time "${ORI_PVE_TIMEOUT:-40}" -w $'\n%{http_code}' \
    -X "$method" -H "$ORI_AUTH" "$ORI_PVE_HOST$path" "$@")
  ORI_HTTP="${out##*$'\n'}"
  printf '%s' "${out%$'\n'*}"
}

pve_get()  { pve_curl GET "$@"; }
pve_post() { pve_curl POST "$@"; }
pve_del()  { pve_curl DELETE "$@"; }

urlenc() { jq -rn --arg v "$1" '$v|@uri'; }

# pve_wait_task <node> <upid> [timeout_s]
#   Poll a Proxmox task (UPID) to completion. A 200 from a mutating call only
#   means "queued"; nothing here treats it as done.
pve_wait_task() {
  local node="$1" upid="$2" timeout="${3:-300}"
  local body status exitstatus i=0
  while [ "$i" -lt "$timeout" ]; do
    body=$(pve_get "/api2/json/nodes/$node/tasks/$(urlenc "$upid")/status")
    status=$(printf '%s' "$body" | jq -r '.data.status // "unknown"')
    if [ "$status" = "stopped" ]; then
      exitstatus=$(printf '%s' "$body" | jq -r '.data.exitstatus // ""')
      if [ -n "$exitstatus" ] && [ "$exitstatus" != "OK" ]; then
        echo "error: task $upid failed (exitstatus=$exitstatus)" >&2
        return 1
      fi
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  echo "error: task $upid did not finish within ${timeout}s" >&2
  return 1
}

# pve_ssh <command...> — run a command on the Proxmox host.
pve_ssh() {
  ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
    -o ConnectTimeout="${ORI_PVE_SSH_CONNECT_TIMEOUT:-20}" \
    "${ORI_SSH_ARGS[@]}" "$@"
}

# ---------------------------------------------------------------------------
# LXC helpers
# ---------------------------------------------------------------------------

# cid_exists <vmid> -> 0/1
cid_exists() {
  local body
  body=$(pve_get "/api2/json/nodes/$ORI_NODE/lxc/$1/status/current")
  printf '%s' "$body" | jq -e '.data != null' >/dev/null 2>&1
}

# cid_status <vmid> -> echoes running|stopped|unknown
cid_status() {
  local body
  body=$(pve_get "/api2/json/nodes/$ORI_NODE/lxc/$1/status/current")
  printf '%s' "$body" | jq -r '.data.status // "unknown"'
}

# cid_start / cid_stop <vmid> — start/stop and wait for the task.
cid_start() {
  local upid
  upid=$(pve_post "/api2/json/nodes/$ORI_NODE/lxc/$1/status/start" | jq -r '.data // empty')
  [ -n "$upid" ] && pve_wait_task "$ORI_NODE" "$upid" 120
}
cid_stop() {
  local upid
  upid=$(pve_post "/api2/json/nodes/$ORI_NODE/lxc/$1/status/stop" | jq -r '.data // empty')
  [ -n "$upid" ] && pve_wait_task "$ORI_NODE" "$upid" 120
}

# cid_snapshot <vmid> <name>
cid_snapshot() {
  local upid
  upid=$(pve_post "/api2/json/nodes/$ORI_NODE/lxc/$1/snapshot" \
    --data-urlencode "snapname=$2" | jq -r '.data // empty')
  [ -n "$upid" ] && pve_wait_task "$ORI_NODE" "$upid" 300
}

# cid_snapshot_del <vmid> <name> — delete a snapshot (container must be stopped).
cid_snapshot_del() {
  local upid
  upid=$(pve_del "/api2/json/nodes/$ORI_NODE/lxc/$1/snapshot/$2" | jq -r '.data // empty')
  [ -n "$upid" ] && pve_wait_task "$ORI_NODE" "$upid" 120
}

# cid_destroy <vmid> [--force] — destroy, purging config. Removes snapshots first
# when stopped so no thin-pool snapshot LV is orphaned.
cid_destroy() {
  local vmid="$1" force=0 args=() body snaps upid
  shift || true
  [ "${1:-}" = "--force" ] && force=1
  if cid_exists "$vmid"; then
    local st
    st=$(cid_status "$vmid")
    if [ "$st" = "running" ]; then
      cid_stop "$vmid" || true
    fi
    # best-effort snapshot removal; ignore failures
    body=$(pve_get "/api2/json/nodes/$ORI_NODE/lxc/$vmid/snapshot")
    while IFS= read -r snaps; do
      [ -n "$snaps" ] && [ "$snaps" != "current" ] && cid_snapshot_del "$vmid" "$snaps" >/dev/null 2>&1 || true
    done <<< "$(printf '%s' "$body" | jq -r '.data[]?.name // empty')"
    if [ "$force" = "1" ]; then
      args=(--data-urlencode force=1 --data-urlencode purge=1)
    fi
    upid=$(pve_del "/api2/json/nodes/$ORI_NODE/lxc/$vmid" "${args[@]}" | jq -r '.data // empty')
    [ -n "$upid" ] && pve_wait_task "$ORI_NODE" "$upid" 120
  fi
}

# lxc_ensure_docker_config <vmid> — idempotently append the docker-in-LXC config
# lines. Measured on this host: without these, docker in an unprivileged LXC
# cannot load its storage driver or start containers.
lxc_ensure_docker_config() {
  local vmid="$1"
  pve_ssh "grep -q 'lxc.apparmor.profile: unconfined' /etc/pve/lxc/$vmid.conf 2>/dev/null || cat >> /etc/pve/lxc/$vmid.conf <<'EOF'
lxc.apparmor.profile: unconfined
lxc.cgroup2.devices.allow: a
lxc.cap.drop:
lxc.mount.entry: tmpfs sys/module tmpfs rw,nosuid,nodev,noexec,relatime,mode=755 0 0
EOF
"
}

# exec_ready <vmid> <timeout_s> — wait until pct exec succeeds.
exec_ready() {
  local vmid="$1" timeout="${2:-120}" i=0
  while [ "$i" -lt "$timeout" ]; do
    if pve_ssh "pct exec $vmid -- true >/dev/null 2>&1"; then
      return 0
    fi
    sleep 2
    i=$((i + 2))
  done
  echo "error: container $vmid never became exec-ready within ${timeout}s" >&2
  return 1
}

# find_free_vmid <min> <max> — lowest unused vmid in [min,max].
find_free_vmid() {
  local min="$1" max="$2"
  local body
  body=$(pve_get "/api2/json/nodes/$ORI_NODE/lxc")
  local vmid
  for ((vmid = min; vmid <= max; vmid++)); do
    if ! printf '%s' "$body" | jq -e --argjson v "$vmid" '.data[]? | select(.vmid == $v)' >/dev/null 2>&1; then
      printf '%s' "$vmid"
      return 0
    fi
  done
  echo "error: no free vmid in [$min,$max]" >&2
  return 1
}

# timings — wall-clock helpers. start_timer <name>; stop_timer <name>
ORI_TS_START="$(date +%s)"
ORI_STEPS=()
ORI_STEP_TS=()
start_timer() { ORI_STEP_TS["${#ORI_STEPS[@]}"]="$(date +%s)"; ORI_STEPS+=("$1"); }
stop_timer() { :; }
step_time() { # index -> seconds
  local idx="$1" now
  now=$(date +%s)
  echo "$((now - ORI_STEP_TS[idx]))"
}