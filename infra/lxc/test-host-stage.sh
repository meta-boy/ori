#!/usr/bin/env bash
# Dry-run the host stage of ori.sh against stubbed Proxmox CLIs.
#
# It cannot prove pct accepts these arguments — only a real host can — but it does
# prove the script reaches `pct create` with the flags it means to, picks the
# template and storages from the documented output formats, and takes the update
# path instead of a second create when the container already exists. Those are the
# three things that were wrong by inspection before this existed.
#
#     infra/lxc/test-host-stage.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"
mkdir -p "$BIN"
export PATH="$BIN:$PATH"
export CALLS="$TMP/calls"
: >"$CALLS"
# Never touch a real /etc/pve, in case someone runs this on an actual host.
export PVE_LXC_CONF_DIR="$TMP/pve-lxc"
mkdir -p "$PVE_LXC_CONF_DIR"

# --- stubs, printing the real tools' output formats -------------------------
cat >"$BIN/pveversion" <<'EOF'
#!/usr/bin/env bash
echo "pve-manager/8.3.0/stub"
EOF

cat >"$BIN/pveam" <<'EOF'
#!/usr/bin/env bash
echo "pveam $*" >>"$CALLS"
case "$1" in
  list)      [ -n "${STUB_TEMPLATE_ON_DISK:-}" ] && printf 'NAME\nlocal:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst\n' ;;
  available) printf 'system\tubuntu-24.04-standard_24.04-1_amd64.tar.zst\nsystem\tubuntu-24.04-standard_24.04-2_amd64.tar.zst\nsystem\tdebian-13-standard_13.1-1_amd64.tar.zst\n' ;;
  update)    : ;;
  download)  : ;;
esac
EOF

cat >"$BIN/pvesm" <<'EOF'
#!/usr/bin/env bash
echo "pvesm $*" >>"$CALLS"
# `pvesm status -content <type>` header + rows: Name Type Status Total Used Free
case "$*" in
  *"-content vztmpl"*) printf 'Name Type Status Total Used Available %%\nlocal dir active 1 1 1 1%%\n' ;;
  *"-content rootdir"*) printf 'Name Type Status Total Used Available %%\nlocal-lvm lvmthin active 1 1 1 1%%\nlocal dir active 1 1 1 1%%\n' ;;
esac
EOF

cat >"$BIN/pct" <<'EOF'
#!/usr/bin/env bash
echo "pct $*" >>"$CALLS"
case "$1" in
  list)   printf 'VMID       Status     Lock         Name\n'
          [ -n "${STUB_CT_EXISTS:-}" ] && printf '106        running                 ori\n'
          exit 0 ;;
  config) [ -n "${STUB_CT_EXISTS:-}" ] || exit 2 ;;
  status) echo "status: running" ;;
  start)  : ;;
  # The real pct writes the container config; host_lxc_raw appends to it.
  create) printf 'arch: amd64\nhostname: ori\n' >"$PVE_LXC_CONF_DIR/$2.conf" ;;
  push)   : ;;
  exec)   shift; shift
          # `pct exec <id> -- ip -4 addr show dev eth0` is the network wait
          case "$*" in
            *"ip -4 addr show"*) echo "    inet 10.0.0.9/24 scope global eth0" ;;
            *getent*) : ;;
            *"hostname -I"*) echo "10.0.0.9" ;;
            *) : ;;   # the installer itself: a no-op here
          esac ;;
esac
EOF

cat >"$BIN/dpkg" <<'EOF'
#!/usr/bin/env bash
[ "$1" = "--print-architecture" ] && echo amd64
EOF

# Answers the dialogs the way a user picking "Advanced" would. $STUB_WHIPTAIL_ANSWERS
# is a newline-separated queue; each call takes the next line and writes it to fd 3,
# which is where whiptail --menu/--inputbox/--radiolist put their result.
cat >"$BIN/whiptail" <<'EOF'
#!/usr/bin/env bash
echo "whiptail $*" >>"$CALLS"
case "$*" in *--yesno*) exit "${STUB_WHIPTAIL_YESNO:-0}" ;; esac
queue="$TMPDIR_STUB/answers"
answer="$(head -n1 "$queue" 2>/dev/null)"
sed -i '1d' "$queue" 2>/dev/null || true
echo "$answer" >&3
EOF

chmod +x "$BIN"/*

fail=0
check() { # check <description> <pattern>
  if grep -qF -- "$2" "$CALLS"; then
    echo "ok   $1"
  else
    echo "FAIL $1"
    echo "     expected to find: $2"
    fail=1
  fi
}
refute() {
  if grep -qF -- "$2" "$CALLS"; then echo "FAIL $1 (unexpected: $2)"; fail=1; else echo "ok   $1"; fi
}

# --- 1. fresh host: downloads a template, then creates the container --------
: >"$CALLS"
env -u STUB_CT_EXISTS -u STUB_TEMPLATE_ON_DISK CTID=106 bash "$HERE/ori.sh" >/dev/null

check "picks the newest catalog template for this arch" \
  "pveam download local ubuntu-24.04-standard_24.04-2_amd64.tar.zst"
check "creates the CT from that template" \
  "pct create 106 local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst"
check "privileged"            "-unprivileged 0"
check "nesting enabled"       "-features nesting=1"
check "keyctl left off (privileged containers reject it)" "-features nesting=1 "
refute "no keyctl"            "keyctl"
check "rootfs on a rootdir storage" "-rootfs local-lvm:40"
check "waits for an address"   "ip -4 addr show dev eth0"
check "pushes the installer"   "/root/ori-install.sh"
check "runs the guest stage"   "ORI_STAGE=guest"
# Without this, dockerd starts but every `docker run` dies on "the docker-default
# profile could not be loaded" — the failure seen on a real host.
grep -q '^lxc.apparmor.profile: unconfined' "$PVE_LXC_CONF_DIR/106.conf" &&
  echo "ok   appends AppArmor unconfined to the CT config" ||
  { echo "FAIL AppArmor line missing from the CT config"; fail=1; }
grep -q '^lxc.cgroup2.devices.allow: a' "$PVE_LXC_CONF_DIR/106.conf" &&
  echo "ok   appends device access" ||
  { echo "FAIL device access line missing"; fail=1; }

# --- 1b. rerunning against that CT must not duplicate the raw options -------
: >"$CALLS"
STUB_CT_EXISTS=1 STUB_TEMPLATE_ON_DISK=1 bash "$HERE/ori.sh" >/dev/null
[ "$(grep -c '^lxc.apparmor.profile' "$PVE_LXC_CONF_DIR/106.conf")" = 1 ] &&
  echo "ok   AppArmor line is appended once, not per run" ||
  { echo "FAIL AppArmor line duplicated on rerun"; fail=1; }
refute "no pointless restart when the options are already there" "pct stop"

# --- 1c. a container from before this existed gets them retrofitted ----------
: >"$CALLS"
printf 'arch: amd64\nhostname: ori\n' >"$PVE_LXC_CONF_DIR/106.conf"
STUB_CT_EXISTS=1 STUB_TEMPLATE_ON_DISK=1 bash "$HERE/ori.sh" >/dev/null
check "retrofits an existing container" "pct stop 106"
check "  and starts it again"           "pct start 106"

# --- 2. container already there: update in place, never a second create -----
: >"$CALLS"
STUB_CT_EXISTS=1 STUB_TEMPLATE_ON_DISK=1 bash "$HERE/ori.sh" >/dev/null
refute "no second pct create" "pct create"
check "finds the existing CT by hostname" "pct list"
check "still runs the guest stage"        "ORI_STAGE=guest"

# --- 3. an existing template on disk is reused, not re-downloaded -----------
: >"$CALLS"
env -u STUB_CT_EXISTS STUB_TEMPLATE_ON_DISK=1 CTID=107 bash "$HERE/ori.sh" >/dev/null
refute "no download when the template is present" "pveam download"
check "creates from the on-disk template" \
  "pct create 107 local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst"

# --- 4. no terminal: defaults, no dialogs, no blocking ----------------------
: >"$CALLS"
env -u STUB_CT_EXISTS CTID=108 bash "$HERE/ori.sh" >/dev/null   # stdin is not a tty here
refute "never prompts without a terminal" "whiptail"
check "still creates with the defaults" "-cores 4 -memory 6144"

# --- 5. interactive advanced path: answers drive the pct create -------------
# A tty is faked with `script`, which is how you exercise an isolatty branch without one.
: >"$CALLS"
export TMPDIR_STUB="$TMP"
printf '2\n108\nsandboxes\n4\n8192\n80\nvmbr1\nmain\ncore\nlocal-lvm\nlocal\n' >"$TMP/answers"
if command -v script >/dev/null; then
  # Two non-obvious details, both of which cost an hour:
  #   - the typescript file is where script(1) puts the command's output, so
  #     /dev/null there discards exactly what a failure needs to show;
  #   - script hangs up the pty the moment ITS stdin sees EOF, which kills the
  #     child mid-run with no error at all. `sleep` keeps stdin open; script still
  #     returns as soon as the child exits.
  sleep 20 | env -u STUB_CT_EXISTS TERM=xterm \
    script -qec "bash $HERE/ori.sh" "$TMP/itx.log" >/dev/null 2>&1 || true
  [ -n "${DEBUG:-}" ] && sed -n '1,40p' "$TMP/itx.log"
  check "offers the default/advanced menu"      "Default settings"
  check "advanced answers reach pct create"     "pct create 108 "
  check "  hostname"                            "-hostname sandboxes"
  check "  resources"                           "-cores 4 -memory 8192"
  check "  disk on the chosen storage"           "-rootfs local-lvm:80"
  check "  bridge"                              "bridge=vmbr1"
  check "asks which storage (two qualify)"      "--radiolist"
  check "confirms before creating"              "--yesno"
else
  echo "skip interactive path (no 'script' binary to fake a tty)"
fi

[ "$fail" -eq 0 ] && echo "PASS" || { echo "FAILED"; exit 1; }
