#!/usr/bin/env bash
# Build every release target of the `ori` binary and stage reproducible release
# artifacts under dist/ (plans/C10-release.md).
#
#   aarch64-apple-darwin        client on Apple Silicon            — host cargo
#   x86_64-apple-darwin         client on Intel Mac                — host cargo
#   x86_64-unknown-linux-musl   server + agent, x86_64 golden      — cross
#   aarch64-unknown-linux-musl  server + agent, arm64 golden       — cross
#
# The Linux targets are statically linked musl so the `agent` role is a static
# drop-in for any golden image. The `agent` role is #[cfg(target_os = "linux")]
# (crates/ori-cli/src/command/agent.rs): the macOS builds compile without it and
# error on `ori agent` at runtime.
#
# Agent size budget: the agent binary is baked into every sandbox image, so this
# build FAILS if either musl `ori` exceeds $ORI_AGENT_SIZE_BUDGET_BYTES
# (default 20971520 = 20 MiB). Tighten it as the binary grows.
#
# Artifacts:
#   dist/ori-<version>-<target>.tar.gz   single static `ori` binary
#   dist/sha256sums.txt                  sha256 of every tarball
#   dist/latest.json                     the self-update version contract:
#                                        {version, channel, publishedAt,
#                                         platforms: {<target>: {url, sha256,
#                                         size}}} — mirrors GET /cli/version
#                                        (docs/SPEC-API.md). install.sh reads it.
#
# Each target builds into its own CARGO_TARGET_DIR. This is load-bearing: cross
# containers share the mounted target dir, and their host-side artifacts are
# linked against each image's libc — sharing the dir corrupts the next build
# (see the GLIBC note in Cross.toml).
#
# Usage: scripts/build-all.sh [--target <triple>] [--version X] [--dist DIR]
#                             [--clean] [--skip-bootstrap]
#
# On macOS/Apple Silicon this bootstraps what cross needs (container-host
# toolchain via rustup --force-non-host, amd64 image pulls for Rosetta). On
# Linux it just runs cross.

set -euo pipefail
ORI_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ORI_REPO_ROOT"

# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------

DIST_DIR="$ORI_REPO_ROOT/dist"
VERSION=""
TARGETS_TO_BUILD=()
CLEAN=0
SKIP_BOOTSTRAP=0
CHANNEL="${ORI_CHANNEL:-stable}"
AGENT_SIZE_BUDGET="${ORI_AGENT_SIZE_BUDGET_BYTES:-20971520}"

usage() {
  cat <<'EOF'
usage: build-all.sh [options]

  --target <triple>   build only this target (repeatable). Default: all four.
  --version X         override the version (default: crates/ori-cli's version)
  --dist DIR          artifact output dir (default: <repo>/dist)
  --clean             remove per-target build dirs and dist/ first
  --skip-bootstrap    skip the cross/docker/toolchain bootstrap
  -h, --help          this help

Targets: aarch64-apple-darwin x86_64-apple-darwin
         x86_64-unknown-linux-musl aarch64-unknown-linux-musl
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGETS_TO_BUILD+=("$2"); shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --dist) DIST_DIR="$2"; shift 2 ;;
    --clean) CLEAN=1; shift ;;
    --skip-bootstrap) SKIP_BOOTSTRAP=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "error: unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

ALL_TARGETS=(
  aarch64-apple-darwin
  x86_64-apple-darwin
  x86_64-unknown-linux-musl
  aarch64-unknown-linux-musl
)

if [ "${#TARGETS_TO_BUILD[@]}" -eq 0 ]; then
  TARGETS_TO_BUILD=("${ALL_TARGETS[@]}")
fi
for t in "${TARGETS_TO_BUILD[@]}"; do
  case " ${ALL_TARGETS[*]} " in
    *" $t "*) ;;
    *) echo "error: unknown target: $t" >&2; exit 2 ;;
  esac
done

OS="$(uname -s)"
MACH="$(uname -m)"

# ---------------------------------------------------------------------------
# version
# ---------------------------------------------------------------------------

if [ -z "$VERSION" ]; then
  VERSION="$(cargo metadata --no-deps --format-version 1 2>/dev/null \
    | jq -r '.packages[] | select(.name == "ori-cli") | .version')"
fi
[ -n "$VERSION" ] || { echo "error: could not determine version" >&2; exit 1; }

TOOLCHAIN_CHANNEL="$(sed -n 's/^channel *= *"\(.*\)"/\1/p' rust-toolchain.toml)"
[ -n "$TOOLCHAIN_CHANNEL" ] || TOOLCHAIN_CHANNEL=stable

# ---------------------------------------------------------------------------
# tools + bootstrap
# ---------------------------------------------------------------------------

command -v cargo >/dev/null 2>&1 || { echo "error: cargo not found" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "error: jq not found" >&2; exit 1; }

needs_cross=0
for t in "${TARGETS_TO_BUILD[@]}"; do
  case "$t" in
    *-unknown-linux-*) needs_cross=1 ;;
  esac
done

if [ "$needs_cross" = "1" ]; then
  if ! command -v cross >/dev/null 2>&1; then
    echo "== installing cross (needed for the musl targets) =="
    cargo install cross --locked
  fi
  command -v docker >/dev/null 2>&1 || { echo "error: cross needs docker" >&2; exit 1; }
  docker info >/dev/null 2>&1 || { echo "error: docker daemon not running" >&2; exit 1; }
fi

# Cross on a macOS host needs the container-host toolchain installed on the host
# (rustup refuses otherwise) and, on Apple Silicon, the amd64 image pulled so
# Docker can run it under Rosetta. Both are safe no-ops on Linux.
bootstrap() {
  [ "$SKIP_BOOTSTRAP" = "1" ] && return 0
  echo "== cross bootstrap ($OS/$MACH) =="
  if [ "$OS" = "Darwin" ]; then
    local chost="${TOOLCHAIN_CHANNEL}-x86_64-unknown-linux-gnu"
    if ! rustup toolchain list | grep -q "^${chost}"; then
      rustup toolchain add "$chost" --profile minimal --force-non-host
    fi
    rustup target add --toolchain "$chost" x86_64-unknown-linux-musl
    rustup target add --toolchain "$chost" aarch64-unknown-linux-musl
  fi
  if [ "$MACH" = "arm64" ] || [ "$MACH" = "aarch64" ]; then
    docker pull --platform linux/amd64 ghcr.io/cross-rs/x86_64-unknown-linux-musl:0.2.5
    docker pull --platform linux/amd64 ghcr.io/cross-rs/aarch64-unknown-linux-musl:0.2.5
  fi
}

# ---------------------------------------------------------------------------
# build one target
# ---------------------------------------------------------------------------

sha_cmd() {
  if command -v sha256sum >/dev/null 2>&1; then echo "sha256sum"; else echo "shasum -a 256"; fi
}
file_size() { # bytes
  if [ "$OS" = "Darwin" ]; then stat -f%z "$1"; else stat -c%s "$1"; fi
}

target_dir() { # <triple> -> build dir under the repo
  case "$1" in
    *apple-darwin) printf '%s' "$ORI_REPO_ROOT/target/native" ;;
    *) printf '%s' "$ORI_REPO_ROOT/target/cross-${1/-unknown-linux-musl/}" ;;
  esac
}

binary_path() { # <triple> -> release binary
  printf '%s' "$(target_dir "$1")/$1/release/ori"
}

build_target() {
  local triple="$1"
  local kind tdir bin
  case "$triple" in
    *apple-darwin) kind=native ;;
    *) kind=cross ;;
  esac
  tdir="$(target_dir "$triple")"
  bin="$(binary_path "$triple")"
  log="$ORI_REPO_ROOT/target/build-logs/$triple.log"

  echo
  echo "== build $triple ($kind, target dir: ${tdir#$ORI_REPO_ROOT/}) =="
  if [ "$CLEAN" = "1" ] && [ -d "$tdir" ]; then
    rm -rf "$tdir"
  fi
  mkdir -p "$tdir" "$(dirname "$log")"

  if [ "$kind" = "native" ]; then
    if [ "$OS" = "Darwin" ] && [ "$triple" = "x86_64-apple-darwin" ]; then
      rustup target add x86_64-apple-darwin
    fi
    if ! CARGO_TARGET_DIR="$tdir" cargo build --release --locked --target "$triple" \
      -p ori-cli --bin ori > "$log" 2>&1; then
      echo "error: $triple build failed; tail of $log:" >&2
      tail -n 40 "$log" >&2
      exit 1
    fi
  else
    if ! CARGO_TARGET_DIR="$tdir" cross build --release --locked --target "$triple" \
      -p ori-cli --bin ori > "$log" 2>&1; then
      echo "error: $triple build failed; tail of $log:" >&2
      tail -n 40 "$log" >&2
      exit 1
    fi
  fi
  echo "  build ok (log: target/build-logs/$triple.log)"

  [ -x "$bin" ] || { echo "error: $triple build produced no binary at $bin" >&2; exit 1; }

  # agent size budget: the agent is baked into every golden image (linux only)
  if [[ "$triple" == *-unknown-linux-* ]]; then
    local size
    size="$(file_size "$bin")"
    echo "  agent binary ($triple): $((size / 1024)) KiB"
    if [ "$size" -gt "$AGENT_SIZE_BUDGET" ]; then
      echo "error: $triple agent binary is $size bytes, over the $AGENT_SIZE_BUDGET byte budget" >&2
      echo "       raise ORI_AGENT_SIZE_BUDGET_BYTES only with justification; bloat multiplies per sandbox" >&2
      exit 1
    fi
  fi
}

# ---------------------------------------------------------------------------
# stage + checksums + manifest
# ---------------------------------------------------------------------------

stage_target() {
  local triple="$1"
  local tarball="$DIST_DIR/ori-$VERSION-$triple.tar.gz"
  local stage
  stage="$(mktemp -d)"
  cp "$(binary_path "$triple")" "$stage/ori"
  tar -C "$stage" -czf "$tarball" ori
  rm -rf "$stage"
  echo "  staged $tarball"
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

[ "$CLEAN" = "1" ] && rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

if [ "$needs_cross" = "1" ]; then
  bootstrap
fi

for t in "${TARGETS_TO_BUILD[@]}"; do
  build_target "$t"
done

echo
echo "== staging artifacts =="
for t in "${TARGETS_TO_BUILD[@]}"; do
  stage_target "$t"
done

FULL_MATRIX=1
for t in "${ALL_TARGETS[@]}"; do
  case " ${TARGETS_TO_BUILD[*]} " in
    *" $t "*) ;;
    *) FULL_MATRIX=0 ;;
  esac
done

if [ "$FULL_MATRIX" != "1" ]; then
  echo
  echo "note: partial build (${TARGETS_TO_BUILD[*]}); skipped sha256sums.txt + latest.json"
  echo "      (the self-update contract needs all four platforms)"
  exit 0
fi

cd "$DIST_DIR"
SHA_CMD="$(sha_cmd)"
$SHA_CMD ori-*.tar.gz > sha256sums.txt
echo "  wrote sha256sums.txt"

PUBLISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
jq -nc \
  --arg version "$VERSION" \
  --arg channel "$CHANNEL" \
  --arg publishedAt "$PUBLISHED_AT" \
  --arg aurl "ori-$VERSION-aarch64-apple-darwin.tar.gz" \
  --arg asha "$(grep "ori-$VERSION-aarch64-apple-darwin.tar.gz" sha256sums.txt | awk '{print $1}')" \
  --argjson asize "$(file_size "ori-$VERSION-aarch64-apple-darwin.tar.gz")" \
  --arg xurl "ori-$VERSION-x86_64-apple-darwin.tar.gz" \
  --arg xsha "$(grep "ori-$VERSION-x86_64-apple-darwin.tar.gz" sha256sums.txt | awk '{print $1}')" \
  --argjson xsize "$(file_size "ori-$VERSION-x86_64-apple-darwin.tar.gz")" \
  --arg lurl "ori-$VERSION-x86_64-unknown-linux-musl.tar.gz" \
  --arg lsha "$(grep "ori-$VERSION-x86_64-unknown-linux-musl.tar.gz" sha256sums.txt | awk '{print $1}')" \
  --argjson lsize "$(file_size "ori-$VERSION-x86_64-unknown-linux-musl.tar.gz")" \
  --arg l2url "ori-$VERSION-aarch64-unknown-linux-musl.tar.gz" \
  --arg l2sha "$(grep "ori-$VERSION-aarch64-unknown-linux-musl.tar.gz" sha256sums.txt | awk '{print $1}')" \
  --argjson l2size "$(file_size "ori-$VERSION-aarch64-unknown-linux-musl.tar.gz")" \
  '{ version: $version, channel: $channel, publishedAt: $publishedAt,
     platforms: {
       "aarch64-apple-darwin":       { url: $aurl,  sha256: $asha,  size: $asize  },
       "x86_64-apple-darwin":        { url: $xurl,  sha256: $xsha,  size: $xsize  },
       "x86_64-unknown-linux-musl":  { url: $lurl,  sha256: $lsha,  size: $lsize  },
       "aarch64-unknown-linux-musl": { url: $l2url, sha256: $l2sha, size: $l2size }
     } }' > latest.json
echo "  wrote latest.json"

echo
echo "release artifacts (version $VERSION, channel $CHANNEL):"
for f in "$DIST_DIR"/*; do
  printf '  %-70s %s\n' "${f#$DIST_DIR/}" "$(file_size "$f") bytes"
done
echo
echo "self-update contract: $DIST_DIR/latest.json"
echo "install:  ORI_INSTALL_BASE_URL=<url-of-dist> bash install.sh"
echo "golden image agent (C9): use one of the *-unknown-linux-musl.tar.gz binaries"
echo "  as --agent-bin; it is the single 'ori' binary, run as 'ori agent'."