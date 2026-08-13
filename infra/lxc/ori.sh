#!/usr/bin/env bash
# ori — one-command LXC install / update, community-scripts style.
#
#     bash -c "$(curl -fsSL https://raw.githubusercontent.com/meta-boy/ori/main/infra/lxc/ori.sh)"
#
# Run it on a Proxmox host: it creates the container if there isn't one and
# installs the stack inside. Run the SAME line again to update in place —
# git pull, deps, migrations, dashboard rebuild, restart. Nothing else to
# remember, no second script.
#
# On a terminal it asks: default settings, or advanced (ID, hostname, resources,
# bridge, storage per content type, branch, image tier) with a confirmation
# summary. With no terminal, no whiptail, or ORI_DEFAULTS=1 it takes the defaults
# and prints them — a pipe or a cron run must never block on a dialog.
#
# Run it inside an existing Debian/Ubuntu container instead and it skips
# straight to the install/update (that is also how the host stage invokes it).
#
# Knobs, all env-overridable (any value set here skips its prompt):
#   CTID=210 CT_HOSTNAME=ori CORES=4 RAM=6144 DISK=40 BRIDGE=vmbr0 STORAGE=local-lvm
#   ORI_REPO=https://github.com/meta-boy/ori ORI_BRANCH=main
#   ORI_IMAGE_TIER=core        # 'core' ~10min/4GB, 'full' ~25min/9GB (default)
#   ORI_SKIP_IMAGE=1           # update without touching the base image
#
# The container is PRIVILEGED with nesting on, and that is not a shortcut that
# can be tightened away: every ori is a docker container run with --privileged,
# --cgroupns=host and a read-write /sys/fs/cgroup so systemd works inside it
# (see packages/api/src/drivers/docker.ts). An unprivileged container cannot
# give it those. Treat the container as equivalent to root on the host, which
# is exactly what a sandbox host is.

set -euo pipefail

CTID="${CTID:-}"
CT_HOSTNAME="${CT_HOSTNAME:-ori}"
# Sized for a modest home host (a 4-core/16GB box also running other things), not
# for a server. The image build is the disk floor: 4GB at tier core, 9GB at full.
CORES="${CORES:-4}"
RAM="${RAM:-6144}"
DISK="${DISK:-40}"
BRIDGE="${BRIDGE:-vmbr0}"
STORAGE="${STORAGE:-}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
# 24.04 because that is the host distro every e2e run in docs/DEPLOY.md was verified on.
TEMPLATE_NAME="${TEMPLATE_NAME:-ubuntu-24.04-standard}"

ORI_REPO="${ORI_REPO:-https://github.com/meta-boy/ori}"
ORI_BRANCH="${ORI_BRANCH:-main}"
ORI_DIR="${ORI_DIR:-/opt/ori}"
ORI_IMAGE_TIER="${ORI_IMAGE_TIER:-full}"
ORI_PORT="${ORI_PORT:-8787}"
SELF_URL="${SELF_URL:-https://raw.githubusercontent.com/meta-boy/ori/$ORI_BRANCH/infra/lxc/ori.sh}"

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Download this script to $1. The cache-buster is load-bearing: raw.githubusercontent
# serves through a CDN with a ~5 minute TTL, so a fresh push is invisible without it and
# an update silently reruns the previous version.
fetch_self() {
  curl -fsSL -H 'Cache-Control: no-cache' -o "$1" "$SELF_URL?nocache=$(date +%s)" ||
    die "could not download $SELF_URL"
  # A CDN error page executed as root is a bad day. Check it is the script.
  head -n1 "$1" | grep -q '^#!/usr/bin/env bash' || die "$SELF_URL did not return the installer"
}

# ---------------------------------------------------------------------------
# Settings: defaults, or a whiptail walkthrough like the community scripts.
# ---------------------------------------------------------------------------
# Prompting is only ever an offer. No terminal, no whiptail, or ORI_DEFAULTS=1
# (cron, CI, a pipe) means take the defaults and say so — never block.
interactive() {
  [ -z "${ORI_DEFAULTS:-}" ] && [ -t 0 ] && [ "${TERM:-dumb}" != dumb ] &&
    command -v whiptail >/dev/null 2>&1
}

ask() { # ask <title> <prompt> <default> -> echoes the answer, or the default
  local out
  out="$(whiptail --title "ori" --inputbox "$2" 9 62 "$3" 3>&1 1>&2 2>&3)" || die "cancelled"
  printf '%s\n' "${out:-$3}"
}

# One storage per content type. `pvesm status -content <type>` columns are
# name, type, status, total, used, free — same shape select_storage() reads.
pick_storage() { # pick_storage <content> <label> [preselect]
  local content="$1" label="$2" pre="${3:-}"
  local -a rows=() menu=()
  local tag type free

  while read -r tag type _ _ _ free _; do
    [ -n "$tag" ] || continue
    rows+=("$tag")
    menu+=("$tag" "$type  free $(numfmt --to=iec --from-unit=1024 --format %.1f "$free" 2>/dev/null || echo "$free")B" "OFF")
  done < <(pvesm status -content "$content" 2>/dev/null | awk 'NR>1')

  [ ${#rows[@]} -gt 0 ] || die "no storage on this host holds '$content' content"

  # A preselected (env-provided) storage wins, but only if it really qualifies.
  if [ -n "$pre" ]; then
    printf '%s\n' "${rows[@]}" | grep -qx "$pre" || die "storage '$pre' cannot hold '$content' content"
    printf '%s\n' "$pre"
    return
  fi
  # Nothing to ask when the host offers exactly one.
  if [ ${#rows[@]} -eq 1 ] || ! interactive; then
    printf '%s\n' "${rows[0]}"
    return
  fi
  local sel
  sel="$(whiptail --title "ori" --radiolist \
    "Which storage for the $label?\n(space selects, enter confirms)" \
    16 64 6 "${menu[@]}" 3>&1 1>&2 2>&3)" || die "cancelled"
  printf '%s\n' "${sel:-${rows[0]}}"
}

host_settings() {
  local advanced=no
  if interactive; then
    local choice
    choice="$(whiptail --title "ori — self-hosted cloud sandboxes" --menu \
      "Install ori into a new LXC container on this host." 14 66 3 \
      "1" "Default settings (${CORES} cores, $((RAM / 1024))GB RAM, ${DISK}GB disk)" \
      "2" "Advanced settings (choose ID, resources, storage, tier)" \
      "3" "Exit" 3>&1 1>&2 2>&3)" || die "cancelled"
    case "$choice" in
    2) advanced=yes ;;
    3) die "cancelled" ;;
    esac
  else
    log "no terminal (or ORI_DEFAULTS set) — using defaults"
  fi

  if [ "$advanced" = yes ]; then
    CTID="$(ask "Container ID" "Container ID (blank = next free)" "$CTID")"
    CT_HOSTNAME="$(ask "Hostname" "Hostname (also how a rerun finds this container to update)" "$CT_HOSTNAME")"
    CORES="$(ask "Cores" "CPU cores" "$CORES")"
    RAM="$(ask "RAM" "RAM in MB" "$RAM")"
    # The base image alone is 4-9GB and every sandbox writes into the container.
    DISK="$(ask "Disk" "Disk in GB (the base image alone is 4-9GB)" "$DISK")"
    BRIDGE="$(ask "Bridge" "Network bridge" "$BRIDGE")"
    ORI_BRANCH="$(ask "Branch" "Git branch of $ORI_REPO to install" "$ORI_BRANCH")"
    local tier
    tier="$(whiptail --title "ori" --menu "Base image tier" 12 66 2 \
      "core" "desktop only, ~4GB, ~10 min" \
      "full" "the whole polyglot toolchain, ~9GB, ~25 min" 3>&1 1>&2 2>&3)" || die "cancelled"
    ORI_IMAGE_TIER="$tier"
  fi

  STORAGE="$(pick_storage rootdir "container disk" "$STORAGE")"
  TEMPLATE_STORAGE="$(pick_storage vztmpl "OS template" "$TEMPLATE_STORAGE")"

  local summary
  summary="$(printf 'ID:        %s\nHostname:  %s\nResources: %s cores, %s MB RAM, %s GB disk\nNetwork:   %s (dhcp)\nStorage:   %s (disk), %s (template)\nSource:    %s @ %s\nImage:     tier %s\nType:      privileged, nesting=1' \
    "${CTID:-next free}" "$CT_HOSTNAME" "$CORES" "$RAM" "$DISK" "$BRIDGE" \
    "$STORAGE" "$TEMPLATE_STORAGE" "$ORI_REPO" "$ORI_BRANCH" "$ORI_IMAGE_TIER")"

  if interactive; then
    whiptail --title "ori — confirm" --yesno "$(printf '%s\n\nCreate it?' "$summary")" 18 70 || die "cancelled"
  fi
  printf '%s\n' "$summary" >&2
}

# ---------------------------------------------------------------------------
# Host stage: create (or find) the container, then run the guest stage in it.
# ---------------------------------------------------------------------------
host_stage() {
  [ "$(id -u)" -eq 0 ] || die "run as root on the Proxmox host"

  # An existing container with our hostname IS the update target. Re-running the
  # one-liner must never build a second copy of the stack.
  if [ -z "$CTID" ]; then
    # `|| true`, because under `set -o pipefail` a non-zero pct here would abort the
    # whole script before printing anything. "no container yet" is not an error.
    CTID="$(pct list 2>/dev/null | awk -v h="$CT_HOSTNAME" 'NR>1 && $NF==h {print $1; exit}' || true)"
  fi

  if [ -n "$CTID" ] && pct config "$CTID" >/dev/null 2>&1; then
    if interactive && ! whiptail --title "ori" --yesno \
      "Container $CTID ($CT_HOSTNAME) already exists.\n\nUpdate the stack inside it?\n\n(pull, migrate, rebuild the dashboard, restart)" 13 60; then
      die "cancelled"
    fi
    log "container $CTID ($CT_HOSTNAME) exists — updating in place"
    # A container created before these options existed needs them retrofitted, and
    # LXC only reads the config at start, so it has to be bounced.
    if host_lxc_raw "$CTID" && [ "$(pct status "$CTID")" = "status: running" ]; then
      log "restarting $CTID to pick up the new LXC options"
      pct stop "$CTID" && pct start "$CTID"
    fi
  else
    host_settings
    CTID="${CTID:-$(pvesh get /cluster/nextid)}"
    host_create "$CTID"
  fi

  host_start "$CTID"

  # Push this same script in rather than making the container fetch it: the Ubuntu
  # template has no curl at all, and a second fetch could get a different (CDN-cached)
  # version than the host just ran. One file, one version, one download.
  local staged="/tmp/ori-install.$$.sh"
  if [ -r "${BASH_SOURCE[0]}" ]; then
    cp "${BASH_SOURCE[0]}" "$staged"          # run from a checkout
  else
    fetch_self "$staged"                      # run via curl | bash — no file to copy
  fi
  pct push "$CTID" "$staged" /root/ori-install.sh --perms 0755
  rm -f "$staged"

  log "running the installer inside $CTID"
  pct exec "$CTID" -- env \
    ORI_STAGE=guest ORI_REPO="$ORI_REPO" ORI_BRANCH="$ORI_BRANCH" ORI_DIR="$ORI_DIR" \
    ORI_IMAGE_TIER="$ORI_IMAGE_TIER" ORI_PORT="$ORI_PORT" SELF_URL="$SELF_URL" \
    ORI_SKIP_IMAGE="${ORI_SKIP_IMAGE:-}" \
    bash /root/ori-install.sh

  local ip
  ip="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
  log "done — dashboard at http://${ip:-<container-ip>}:$ORI_PORT/"
  printf '  sign up on the dashboard with the invite printed above; for another:\n'
  # pct exec runs with a minimal PATH that excludes /usr/local/bin, so these have
  # to be absolute paths or the hints fail with "command not found".
  printf '    pct exec %s -- /usr/local/bin/ori-invite --days 7\n' "$CTID"
  printf '  another API key:  pct exec %s -- /usr/local/bin/ori-key --name laptop\n' "$CTID"
  printf '  update later:     bash -c "$(curl -fsSL %s)"\n' "$SELF_URL"
  printf '    or:             pct exec %s -- /usr/local/bin/ori-update\n' "$CTID"
}

# Wait for the container to be running AND have an address. `pct exec` succeeds long
# before either, so skipping this turns a slow DHCP lease into "apt-get update failed".
host_start() {
  local ctid="$1" i ip=""

  [ "$(pct status "$ctid")" = "status: running" ] || pct start "$ctid"
  for i in $(seq 10); do
    [ "$(pct status "$ctid")" = "status: running" ] && break
    [ "$i" -eq 10 ] && die "CT $ctid never reached running ($(pct status "$ctid"))"
    sleep 1
  done

  log "waiting for the container's network"
  for i in $(seq 60); do
    ip="$(pct exec "$ctid" -- ip -4 addr show dev eth0 2>/dev/null | awk '/inet / {print $2}' | cut -d/ -f1)"
    [ -n "$ip" ] && break
    sleep 2
  done
  [ -n "$ip" ] || die "CT $ctid got no IPv4 on eth0 — check bridge $BRIDGE and DHCP"
  pct exec "$ctid" -- getent hosts archive.ubuntu.com >/dev/null 2>&1 ||
    warn "DNS in the container cannot resolve archive.ubuntu.com yet; apt may fail"
}

# Resolve a template, downloading it if this host has none. The awkward parts are
# real pveam behaviour: `pveam available` prints "<section> <name>" (the name is
# field 2) and lists every arch/variant, and only `pveam list <storage>` says what
# is actually on disk.
host_template() {
  local tmpl
  tmpl="$(pveam list "$TEMPLATE_STORAGE" 2>/dev/null |
    awk -v n="$TEMPLATE_NAME" 'NR>1 && $1 ~ n {print $1}' | sort -V | tail -n1)"
  if [ -n "$tmpl" ]; then
    printf '%s\n' "$tmpl"
    return
  fi

  pveam update >/dev/null 2>&1 || warn "pveam update failed; using the cached catalog"
  local avail
  avail="$(pveam available -section system 2>/dev/null |
    grep -E '\.(tar\.zst|tar\.xz|tar\.gz)$' | awk '{print $2}' |
    grep -E "^${TEMPLATE_NAME}_.*_$(dpkg --print-architecture)\." | sort -V | tail -n1)"
  [ -n "$avail" ] || die "no '$TEMPLATE_NAME' template in the catalog: pveam available -section system"
  log "template: downloading $avail to $TEMPLATE_STORAGE"
  pveam download "$TEMPLATE_STORAGE" "$avail" >&2 || die "pveam download $avail failed"
  printf '%s\n' "$TEMPLATE_STORAGE:vztmpl/$avail"
}

host_create() {
  local ctid="$1" tmpl
  # Storages were resolved (and validated against their content type) in
  # host_settings; vztmpl and rootdir are separate types and usually separate
  # storages — templates on 'local', disks on 'local-lvm'.
  tmpl="$(host_template)"

  log "creating privileged CT $ctid on $STORAGE (${CORES} cores, ${RAM}MB, ${DISK}G)"
  # nesting=1 is what allows docker inside the container at all. No keyctl: that
  # option exists only for unprivileged containers, and this one is privileged
  # (see the header — the sandboxes need it). ostype comes from the template.
  pct create "$ctid" "$tmpl" \
    -hostname "$CT_HOSTNAME" \
    -tags ori \
    -cores "$CORES" -memory "$RAM" -swap 512 \
    -rootfs "$STORAGE:$DISK" \
    -net0 "name=eth0,bridge=$BRIDGE,ip=dhcp" \
    -features nesting=1 \
    -unprivileged 0 \
    -onboot 1 ||
    die "pct create failed"

  host_lxc_raw "$ctid"
}

# Raw LXC options pct has no flag for, appended to the container's config.
#
# Without these, dockerd installs and starts fine and then every `docker run`
# fails with "AppArmor enabled on system but the docker-default profile could not
# be loaded ... Access denied. You need policy admin privileges to manage
# profiles": the container's AppArmor profile forbids loading profiles, and
# Docker loads one for every container it starts. Nothing inside the container can
# fix that — it is the LXC profile that has to step aside.
#
# devices.allow + an empty cap.drop are the rest of the standard docker-in-LXC
# recipe: the sandboxes need device nodes and full capabilities.
#
# pct warns "explicitly configured lxc.apparmor.profile overrides the following
# settings: features:nesting" when it starts. That is expected and harmless here:
# what nesting contributes to AppArmor is a laxer profile, and unconfined is
# laxer still. Nesting's other effects (mount permissions, cgroups) are untouched.
#
# Returns 0 if it changed the config (caller must restart the container), 1 if
# it was already there.
host_lxc_raw() {
  local ctid="$1"
  # Overridable only so test-host-stage.sh can point it at a temp dir instead of
  # writing container configs on a real host.
  local conf="${PVE_LXC_CONF_DIR:-/etc/pve/lxc}/${ctid}.conf"
  [ -f "$conf" ] || die "no config at $conf"
  grep -q '^lxc.apparmor.profile' "$conf" && return 1

  log "config: AppArmor unconfined + device access (docker needs both)"
  cat >>"$conf" <<'RAW'
# ori: docker inside this container loads an AppArmor profile per container,
# which the default LXC profile denies. See infra/lxc/ori.sh.
lxc.apparmor.profile: unconfined
lxc.cgroup2.devices.allow: a
lxc.cap.drop:
RAW
  return 0
}

# ---------------------------------------------------------------------------
# Guest stage: install or update the stack. Every step is a no-op when already done.
# ---------------------------------------------------------------------------
guest_stage() {
  [ "$(id -u)" -eq 0 ] || die "run as root inside the container"
  export DEBIAN_FRONTEND=noninteractive
  export PATH="/usr/local/bin:$PATH"
  # The template ships no generated locales, so anything perl-based prints a
  # paragraph of warnings on every apt call. C.UTF-8 is built in and always valid.
  export LANG=C.UTF-8 LC_ALL=C.UTF-8

  log "packages"
  apt-get update -qq
  apt-get install -y -qq curl git ca-certificates jq bzip2 unzip make openssl restic \
    >/dev/null

  if ! command -v docker >/dev/null; then
    log "docker"
    curl -fsSL https://get.docker.com | sh >/dev/null
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
  docker info >/dev/null 2>&1 || die "docker is not usable — is the container privileged with nesting=1?"

  if ! command -v bun >/dev/null; then
    log "bun"
    BUN_INSTALL=/usr/local curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash >/dev/null
  fi

  local fresh=no
  if [ -d "$ORI_DIR/.git" ]; then
    log "repo: updating $ORI_DIR"
    git -C "$ORI_DIR" fetch --quiet origin "$ORI_BRANCH"
    git -C "$ORI_DIR" checkout --quiet "$ORI_BRANCH"
    git -C "$ORI_DIR" reset --hard --quiet "origin/$ORI_BRANCH"
  else
    log "repo: cloning into $ORI_DIR"
    git clone --quiet --branch "$ORI_BRANCH" "$ORI_REPO" "$ORI_DIR"
    fresh=yes
  fi
  cd "$ORI_DIR"

  write_env
  log "dependencies"
  bun install --silent

  log "postgres + minio"
  # --wait only on the long-running services. minio-init is a one-shot that creates
  # the bucket and exits 0, and `--wait` counts any exited container as a failure —
  # which aborted this script right before the migrations on a real host.
  docker compose up -d --wait postgres minio >/dev/null
  # Attached, so this returns when the bucket actually exists rather than when the
  # container has merely started.
  docker compose up minio-init >/dev/null 2>&1 ||
    warn "bucket init failed; snapshots will not work until it does: docker compose logs minio-init"
  bun run packages/api/scripts/migrate.ts

  log "dashboard"
  bun run --cwd packages/dashboard build >/dev/null

  if [ -n "${ORI_SKIP_IMAGE:-}" ]; then
    warn "skipping the base image (ORI_SKIP_IMAGE set)"
  elif [ "$fresh" = no ] && docker image inspect ori-base:latest >/dev/null 2>&1; then
    # An update should not spend 25 minutes rebuilding an image nothing changed in.
    log "base image: already built — to rebuild, docker rmi ori-base:latest first"
  else
    log "base image (tier=$ORI_IMAGE_TIER) — this is the slow one, 10-25 min"
    ORI_IMAGE_TIER="$ORI_IMAGE_TIER" image/build-docker.sh
  fi

  install_unit
  install -m 0755 /dev/stdin /usr/local/bin/ori-update <<UPD
#!/usr/bin/env bash
# Re-runs the installer's guest stage. Same thing the host one-liner does.
exec env ORI_STAGE=guest ORI_DIR="$ORI_DIR" ORI_BRANCH="$ORI_BRANCH" ORI_REPO="$ORI_REPO" \\
  ORI_IMAGE_TIER="$ORI_IMAGE_TIER" ORI_PORT="$ORI_PORT" SELF_URL="$SELF_URL" \\
  bash -c 'set -eo pipefail
    t=\$(mktemp)
    # ?nocache: raw.githubusercontent is CDN-cached for ~5 min, so without it an
    # update right after a push reruns the old script and looks like a no-op.
    curl -fsSL -H "Cache-Control: no-cache" -o "\$t" "\$SELF_URL?nocache=\$(date +%s)"
    head -n1 "\$t" | grep -q "^#!/usr/bin/env bash"
    bash "\$t"; rm -f "\$t"'
UPD

  # Wrappers so minting a credential is one word and needs no memory of where the
  # checkout lives or that bun is not on pct exec's PATH.
  install -m 0755 /dev/stdin /usr/local/bin/ori-invite <<INV
#!/usr/bin/env bash
# Mint a single-use sign-up invite for the dashboard. Printed once, stored hashed.
cd "$ORI_DIR" && exec /usr/local/bin/bun scripts/create-invite.ts "\$@"
INV
  install -m 0755 /dev/stdin /usr/local/bin/ori-key <<KEY
#!/usr/bin/env bash
# Mint an ori_live_ API key for the CLI. Printed once, stored hashed.
cd "$ORI_DIR" && exec /usr/local/bin/bun scripts/create-key.ts "\$@"
KEY

  systemctl restart ori-api
  sleep 2
  systemctl is-active --quiet ori-api || die "ori-api failed to start: journalctl -u ori-api -n50"

  # Credentials only when there is no way in yet — keyed on the database, not on a
  # fresh clone, because a half-finished install leaves the repo in place and a rerun
  # still has to hand over something usable.
  #
  # "Can sign in" means a password hash, NOT merely a row in users: every API key mints
  # a service identity with password_hash NULL ("cannot sign in", per db/schema.ts), and
  # counting those would silently skip the invite on any host where a key was made first.
  local humans keys
  humans="$(psql_count "select count(*) from users where password_hash is not null")"
  keys="$(psql_count "select count(*) from api_keys")"

  if [ "${keys:-1}" = 0 ]; then
    log "an API key (shown once — the CLI authenticates with it)"
    bun scripts/create-key.ts --name lxc || warn "key creation failed; run it yourself: ori-key --name lxc"
  fi
  if [ "${humans:-1}" = 0 ]; then
    # Sign-up is invite-only on purpose: every account can spawn containers on this
    # host. Without an invite the dashboard shows a sign-up form nobody can complete.
    log "a sign-up invite for the dashboard (shown once, single-use)"
    bun scripts/create-invite.ts --note "created by infra/lxc/ori.sh" ||
      warn "invite creation failed; run it yourself: ori-invite"
  else
    log "$humans dashboard account(s) already exist — no invite minted"
  fi

  log "ori-api is up on :$ORI_PORT — dashboard at /, API at /api/ori/v1"
  # Both of these are the only way to get another one; keys and invites are shown
  # once and stored as hashes.
  cat >&2 <<HINT

  another sign-up invite:  ori-invite              (or: ori-invite --days 7 --note alice)
  another API key:         ori-key --name laptop
  both print once and store only a hash, so there is no way to read an old one back.
HINT
}

# One number out of the control-plane database, or empty if it cannot be read.
# Empty is deliberately NOT treated as zero by the callers: failing to reach postgres
# must not be read as "nothing exists yet" and mint credentials on every rerun.
psql_count() {
  docker exec ori-postgres-1 psql -U ori -d ori -tAc "$1" 2>/dev/null | tr -d '[:space:]' || true
}

# Per-sandbox ceilings, derived from what this container actually has rather than
# from what a machine type asks for. `default` asks for 8GB; on a 6GB container that
# is the control plane, postgres and minio being OOM-killed by the sandbox they exist
# to serve. Half the container, floor 1GB / 1 cpu.
# Echoes: <ct_cpus> <ct_mb> <max_cpus> <max_mb>
sandbox_ceilings() {
  local ct_mb ct_cpus max_mb max_cpus
  ct_mb="$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo)"
  ct_cpus="$(nproc)"
  max_mb=$((ct_mb / 2))
  [ "$max_mb" -lt 1024 ] && max_mb=1024
  max_cpus=$((ct_cpus / 2))
  [ "$max_cpus" -lt 1 ] && max_cpus=1
  printf '%s %s %s %s\n' "$ct_cpus" "$ct_mb" "$max_cpus" "$max_mb"
}

# Settings added after a deployment's .env was written would otherwise never reach it,
# because that file is deliberately never rewritten. Append only what is absent —
# an operator's edited value is never touched.
env_add_missing() {
  local ct_mb ct_cpus max_mb max_cpus
  read -r ct_cpus ct_mb max_cpus max_mb < <(sandbox_ceilings)
  grep -q '^ORI_SANDBOX_MAX_MEMORY_MB=' "$ORI_DIR/.env" && return 0

  log "config: adding sandbox ceilings (${max_cpus} cpus / ${max_mb}MB of ${ct_cpus}/${ct_mb})"
  cat >>"$ORI_DIR/.env" <<ENV

# Added by infra/lxc/ori.sh: no ori gets more than this, whatever its type asks for.
ORI_SANDBOX_MAX_CPUS=$max_cpus
ORI_SANDBOX_MAX_MEMORY_MB=$max_mb
ENV
}

# .env is written ONCE. Rewriting it on every update would roll
# ORI_SNAPSHOT_SECRET, and a rolled secret orphans every existing snapshot and
# makes every running ori unreachable (docs/OPERATIONS.md).
write_env() {
  if [ -f "$ORI_DIR/.env" ]; then
    log "config: keeping existing .env"
    env_add_missing
    return
  fi
  log "config: writing .env"
  # On Linux there is no host.docker.internal: a ori reaches minio through the
  # docker bridge gateway. Getting this wrong looks healthy until the first snapshot.
  local gw
  gw="$(docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')"
  [ -n "$gw" ] || die "could not read the docker bridge gateway"

  local ct_mb ct_cpus max_mb max_cpus
  read -r ct_cpus ct_mb max_cpus max_mb < <(sandbox_ceilings)

  umask 077
  cat >"$ORI_DIR/.env" <<ENV
DATABASE_URL=postgres://ori:ori@localhost:5432/ori
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=ori-snapshots
S3_ENDPOINT_FOR_ORI=http://$gw:9000
PORT=$ORI_PORT
# No ori gets more than this, whatever its type asks for (${ct_cpus} cpus / ${ct_mb}MB here).
# Raise them if you give the container more, or delete them for the types as written.
ORI_SANDBOX_MAX_CPUS=$max_cpus
ORI_SANDBOX_MAX_MEMORY_MB=$max_mb
# Back this up OFF this container. It derives every snapshot repository password
# and every ori's machine token; lose it and every snapshot is ciphertext forever.
ORI_SNAPSHOT_SECRET=$(openssl rand -hex 32)
# Set this to the public https origin once there is one, then restart ori-api —
# desktop links are built from it and are otherwise localhost-only.
# ORI_PUBLIC_URL=https://oris.example.com
ENV
  umask 022
}

# Root, and no ProtectSystem: the control plane shells out to docker and restic and
# drives the daemon's socket. ponytail ceiling: the container is the security
# boundary here, not the service user. Split it out if this ever shares a host.
install_unit() {
  log "systemd unit"
  cat >/etc/systemd/system/ori-api.service <<UNIT
[Unit]
Description=ori control plane
Wants=network-online.target docker.service
After=network-online.target docker.service

[Service]
Type=simple
WorkingDirectory=$ORI_DIR
EnvironmentFile=$ORI_DIR/.env
ExecStart=/usr/local/bin/bun $ORI_DIR/packages/api/src/index.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable ori-api >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# pveversion exists on a Proxmox host and nowhere else; it is how the community
# scripts tell the two sides apart, and it is right for the same reason here.
if [ "${ORI_STAGE:-}" = guest ] || ! command -v pveversion >/dev/null 2>&1; then
  guest_stage
else
  host_stage
fi
