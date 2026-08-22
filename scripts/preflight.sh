#!/usr/bin/env bash
# Preflight a Proxmox host before `ori serve` trusts it.
#
# Validates, in order:
#   1. tools + API reachability, node online
#   2. storage is snapshot-capable (LVM-thin or ZFS) and serves images
#   3. templates for both tiers are present
#   4. bridge exists (DHCP is proven live in the round trip)
#   5. the API token can create / clone / snapshot / destroy — proven with a
#      real round trip on a scratch vmid in the test range, then cleaned up
#      (permission bits lie; a round trip does not)
#   6. the bridge actually hands out DHCP (scratch container gets an IP)
#   7. CRIU live suspend is unavailable (asserted + recorded, so nothing later
#      assumes live suspend works: `pct suspend` measured rc=255 on this kernel)
#   8. free space and pool headroom against the configured pool depth
#
# Exits non-zero on any hard failure. The scratch round trip always cleans up,
# including on failure (trap).

set -euo pipefail
ORI_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$ORI_SCRIPT_DIR/lib.sh"

PASS=0
FAIL=0
WARN=0
INFO=0

report() { # kind msg
  case "$1" in
    PASS) PASS=$((PASS + 1)); echo "[PASS] $2" ;;
    FAIL) FAIL=$((FAIL + 1)); echo "[FAIL] $2" ;;
    WARN) WARN=$((WARN + 1)); echo "[WARN] $2" ;;
    INFO) INFO=$((INFO + 1)); echo "[INFO] $2" ;;
  esac
}

# scratch vmids we own this run; the trap removes them, on success too
SCRATCH_A=()
SCRATCH_B=""

cleanup_scratch() {
  local v
  if [ -n "$SCRATCH_B" ]; then
    cid_destroy "$SCRATCH_B" 2>/dev/null || true
  fi
  for v in "${SCRATCH_A[@]}"; do
    cid_destroy "$v" 2>/dev/null || true
  done
}
trap cleanup_scratch EXIT

# ---------------------------------------------------------------------------
# 1. tools + API + node
# ---------------------------------------------------------------------------

echo "== 1. tools / API / node =="
ok=1
for tool in curl jq ssh; do
  if command -v "$tool" >/dev/null 2>&1; then
    report PASS "found $tool ($(command -v "$tool"))"
  else
    report FAIL "missing $tool"
    ok=0
  fi
done

if [ "$ok" = "1" ]; then
  vbody=$(pve_get /api2/json/version)
  if [ "$ORI_HTTP" != "200" ]; then
    report FAIL "Proxmox API unreachable at $ORI_PVE_HOST"
    ok=0
  else
    report PASS "Proxmox API reachable: $(printf '%s' "$vbody" | jq -r '.data.release + " (pve-manager " + .data.version + ")"')"
    nbody=$(pve_get "/api2/json/nodes/$ORI_NODE/status")
    if printf '%s' "$nbody" | jq -e '.data.status == "online"' >/dev/null 2>&1; then
      report PASS "node $ORI_NODE online"
    else
      report FAIL "node $ORI_NODE not online: $(printf '%s' "$nbody" | jq -r '.data.status // .')"
      ok=0
    fi
  fi
fi
[ "$ok" = "1" ] || exit 1

# ---------------------------------------------------------------------------
# 2. storage snapshot-capable
# ---------------------------------------------------------------------------

echo "== 2. storage ($ORI_STORAGE) =="
sbody=$(pve_get "/api2/json/nodes/$ORI_NODE/storage/$ORI_STORAGE/status")
if [ "$ORI_HTTP" != "200" ]; then
  report FAIL "storage $ORI_STORAGE unknown on $ORI_NODE"
  exit 1
fi
STYPE=$(printf '%s' "$sbody" | jq -r '.data.type // "unknown"')
SCONTENT=$(printf '%s' "$sbody" | jq -r '.data.content // ""')
SENABLED=$(printf '%s' "$sbody" | jq -r '.data.enabled // 0')
SAVAIL=$(printf '%s' "$sbody" | jq -r '.data.avail // 0')
STOTAL=$(printf '%s' "$sbody" | jq -r '.data.total // 0')
case "$STYPE" in
  lvmthin | zfspool)
    report PASS "storage type $STYPE supports snapshots + linked clones"
    ;;
  *)
    report FAIL "storage type '$STYPE' cannot snapshot or linked-clone. A 'dir' storage will fail on the first fork; use LVM-thin or ZFS."
    exit 1
    ;;
esac
[ "$SENABLED" = "1" ] || report FAIL "storage $ORI_STORAGE is disabled"
case "$SCONTENT" in
  *images*) report PASS "storage serves container images" ;;
  *) report FAIL "storage content '$SCONTENT' does not include 'images'" ;;
esac
SAVAIL_GB=$(awk "BEGIN{printf \"%.1f\", $SAVAIL/1024/1024/1024}")
STOTAL_GB=$(awk "BEGIN{printf \"%.1f\", $STOTAL/1024/1024/1024}")
report INFO "storage: ${SAVAIL_GB}G available of ${STOTAL_GB}G"

# ---------------------------------------------------------------------------
# 3. templates present
# ---------------------------------------------------------------------------

echo "== 3. templates =="
tbody=$(pve_get "/api2/json/nodes/$ORI_NODE/storage/local/content")
have_tmpl() { # volid e.g. local:vztmpl/foo.tar.zst
  printf '%s' "$tbody" | jq -e --arg v "${1#local:}" '.data[]? | select(.volid | contains($v))' >/dev/null 2>&1
}
if have_tmpl "${ORI_PVE_TEMPLATE_ALPINE:-}"; then
  report PASS "alpine template present: $ORI_PVE_TEMPLATE_ALPINE"
else
  report FAIL "alpine template missing: $ORI_PVE_TEMPLATE_ALPINE"
fi
if have_tmpl "${ORI_PVE_TEMPLATE_UBUNTU:-}"; then
  report PASS "ubuntu template present: $ORI_PVE_TEMPLATE_UBUNTU"
else
  report FAIL "ubuntu template missing: $ORI_PVE_TEMPLATE_UBUNTU"
fi

# ---------------------------------------------------------------------------
# 4. bridge exists
# ---------------------------------------------------------------------------

echo "== 4. bridge ($ORI_BRIDGE) =="
nwbody=$(pve_get "/api2/json/nodes/$ORI_NODE/network")
if printf '%s' "$nwbody" | jq -e --arg b "$ORI_BRIDGE" \
  '.data[]? | select(.type == "bridge" and .iface == $b and .active == 1)' >/dev/null 2>&1; then
  report PASS "bridge $ORI_BRIDGE exists and is active"
else
  report FAIL "bridge $ORI_BRIDGE not found or inactive"
  exit 1
fi

# ---------------------------------------------------------------------------
# 5. token round trip + DHCP + CRIU
# ---------------------------------------------------------------------------

echo "== 5. token round trip (create / snapshot / clone / destroy) =="
ROUNDTRIP_START="$(date +%s)"
TMPL_SCRATCH="${ORI_PVE_TEMPLATE_ALPINE}"

pick_scratch() { # -> free vmid in test range
  local v
  v=$(find_free_vmid "$ORI_TEST_MIN" "$ORI_TEST_MAX")
  printf '%s' "$v"
}

create_scratch() { # <vmid> -> 0 ok / 2 exists
  local vmid="$1" resp
  resp=$(pve_post "/api2/json/nodes/$ORI_NODE/lxc" \
    --data-urlencode "vmid=$vmid" \
    --data-urlencode "ostemplate=$TMPL_SCRATCH" \
    --data-urlencode "storage=$ORI_STORAGE" \
    --data-urlencode "hostname=ori-preflight" \
    --data-urlencode "rootfs=${ORI_STORAGE}:4" \
    --data-urlencode "memory=512" \
    --data-urlencode "swap=0" \
    --data-urlencode "cores=1" \
    --data-urlencode "net0=name=eth0,bridge=${ORI_BRIDGE},ip=dhcp,type=veth" \
    --data-urlencode "unprivileged=1" \
    --data-urlencode "features=nesting=1" \
    --data-urlencode "ostype=alpine" \
    --data-urlencode "description=ori preflight scratch" \
    --data-urlencode "tags=ori-preflight")
  if [ "$ORI_HTTP" != "200" ]; then
    printf '%s' "$resp" | grep -qi "already exists" && return 2
    echo "error: scratch create failed: $(printf '%s' "$resp" | jq -r '.message // .')" >&2
    return 1
  fi
  pve_wait_task "$ORI_NODE" "$(printf '%s' "$resp" | jq -r '.data')" 240
}

roundtrip_ok=1
BASE=""
CLONE=""

# allocate the scratch pair (retry on races with anything else using the range)
attempt=0
while [ "$attempt" -lt 8 ]; do
  attempt=$((attempt + 1))
  BASE=$(pick_scratch)
  if create_scratch "$BASE"; then
    break
  fi
  rc=$?
  if [ "$rc" = "1" ]; then exit 1; fi
  echo "scratch vmid $BASE was taken concurrently; retrying" >&2
  sleep 1
done
[ "$BASE" != "" ] || { report FAIL "could not allocate a scratch vmid in [$ORI_TEST_MIN,$ORI_TEST_MAX]"; exit 1; }
SCRATCH_A+=("$BASE")
report PASS "create: vmid $BASE from alpine template (permission + template verified)"

# find a free clone vmid now (list may have changed)
CLONE=$(find_free_vmid "$ORI_TEST_MIN" "$ORI_TEST_MAX")

# start -> DHCP
cid_start "$BASE"
report PASS "start: vmid $BASE"

echo "== 5a. DHCP on $ORI_BRIDGE =="
dhcp_ok=0
for i in $(seq 1 40); do
  ip=$(pve_ssh "pct exec $BASE -- sh -c 'ip -4 addr show dev eth0 2>/dev/null'" 2>/dev/null | grep -oE 'inet [0-9.]+' | awk '{print $2}' | head -1 || true)
  if [ -n "$ip" ]; then
    dhcp_ok=1
    break
  fi
  sleep 2
done
if [ "$dhcp_ok" = "1" ]; then
  report PASS "DHCP handed out $ip on $ORI_BRIDGE (container boot -> IP)"
else
  report FAIL "no DHCP address appeared on $ORI_BRIDGE within 80s"
  roundtrip_ok=0
fi

echo "== 5b. CRIU live suspend =="
SUSPEND_OUT="$(pve_ssh "timeout 45 pct suspend $BASE" 2>&1 || true)"
SUSPEND_RC=$?
if [ "$SUSPEND_RC" = "0" ]; then
  report WARN "pct suspend SUCCEEDED — CRIU live suspend is now available; update Capabilities.live_suspend=true (this kernel measured rc=255)"
  LIVE_SUSPEND=true
else
  report PASS "CRIU unavailable, recorded live_suspend=false (pct suspend rc=$SUSPEND_RC: $(printf '%s' "$SUSPEND_OUT" | tail -1))"
  LIVE_SUSPEND=false
fi

# stop -> snapshot -> clone -> destroy
cid_stop "$BASE"
T_SNAP="$(date +%s)"
cid_snapshot "$BASE" preflight
SNAP_S="$(( $(date +%s) - T_SNAP ))"
report PASS "snapshot: vmid $BASE snapname=preflight (${SNAP_S}s)"

T_CLONE="$(date +%s)"
cres=$(pve_post "/api2/json/nodes/$ORI_NODE/lxc/$BASE/clone" \
  --data-urlencode "newid=$CLONE" \
  --data-urlencode "snapname=preflight" \
  --data-urlencode "full=0")
if [ "$ORI_HTTP" != "200" ]; then
  report FAIL "clone to $CLONE failed: $(printf '%s' "$cres" | jq -r '.message // .')"
  roundtrip_ok=0
else
  pve_wait_task "$ORI_NODE" "$(printf '%s' "$cres" | jq -r '.data')" 180
  SCRATCH_B="$CLONE"
  CLONE_S="$(( $(date +%s) - T_CLONE ))"
  report PASS "linked clone: $BASE -> $CLONE (full=0, snapname=preflight) in ${CLONE_S}s"
fi

# destroy the clone, then the original
if [ "$SCRATCH_B" != "" ]; then
  cid_destroy "$SCRATCH_B"
  SCRATCH_B=""
  report PASS "destroy clone $CLONE"
fi
cid_destroy "$BASE"
report PASS "destroy original $BASE"
BASE=""
ROUNDTRIP_S="$(( $(date +%s) - ROUNDTRIP_START ))"
report INFO "round trip total: ${ROUNDTRIP_S}s (create+start+dhcp+suspend+stop+snapshot+clone+destroy)"

[ "$roundtrip_ok" = "1" ] || exit 1

# ---------------------------------------------------------------------------
# 6. free space / pool headroom
# ---------------------------------------------------------------------------

echo "== 6. pool headroom =="
sbody=$(pve_get "/api2/json/nodes/$ORI_NODE/storage/$ORI_STORAGE/status")
SAVAIL=$(printf '%s' "$sbody" | jq -r '.data.avail // 0')
SAVAIL_GB=$(awk "BEGIN{printf \"%.1f\", $SAVAIL/1024/1024/1024}")
POOL_GB=$((ORI_POOL_DEPTH * ORI_POOL_SLOT_GB))
HEADROOM_GB=$(awk "BEGIN{printf \"%.1f\", $SAVAIL/1024/1024/1024 - $POOL_GB}")
report INFO "free: ${SAVAIL_GB}G | pool footprint (depth ${ORI_POOL_DEPTH} x ${ORI_POOL_SLOT_GB}G): ${POOL_GB}G | headroom after pool: ${HEADROOM_GB}G"
if awk "BEGIN{exit !($HEADROOM_GB < 0)}"; then
  report FAIL "pool does not fit on $ORI_STORAGE (headroom ${HEADROOM_GB}G)"
elif awk "BEGIN{exit !($HEADROOM_GB < 10)}"; then
  report WARN "pool fits but headroom is thin (${HEADROOM_GB}G < 10G)"
else
  report PASS "pool fits with ${HEADROOM_GB}G headroom"
fi

# ---------------------------------------------------------------------------
# summary
# ---------------------------------------------------------------------------

echo
echo "summary: ${PASS} passed, ${FAIL} failed, ${WARN} warnings, ${INFO} info"
echo
echo "machine-readable:"
echo "  ORI_PREFLIGHT_PASS=$([ "$FAIL" = 0 ] && echo 1 || echo 0)"
echo "  ORI_LIVE_SUSPEND=$LIVE_SUSPEND"
echo "  ORI_STORAGE_TYPE=$STYPE"
echo "  ORI_STORAGE_AVAIL_GB=$SAVAIL_GB"
echo "  ORI_POOL_FOOTPRINT_GB=$POOL_GB"
echo "  ORI_POOL_HEADROOM_GB=$HEADROOM_GB"

[ "$FAIL" = 0 ] || exit 1
echo "preflight OK: host is fit for ori serve"
exit 0