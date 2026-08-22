#!/usr/bin/env bash
# Install the `ori` binary. Designed for `curl -fsSL <url> | bash` and safe to
# re-run. Detects OS/arch, verifies a SHA-256 checksum before touching the
# install path, installs to a user-writable directory (no sudo), refuses to
# silently downgrade, and never crosses a channel boundary without saying so.
#
# How it decides what to install:
#   * reads the self-update version contract `latest.json` from a release base
#     URL (same contract as GET /cli/version, docs/SPEC-API.md):
#       { "version": "…", "channel": "stable",
#         "platforms": { "<target>": { "url", "sha256", "size" } } }
#   * resolves its own target triple from OS + arch
#   * downloads the tarball, verifies sha256 from the contract, extracts `ori`
#
# Configuration (env, or CLI flags for `bash install.sh --dir …`):
#   ORI_INSTALL_BASE_URL  release base URL, or a local dist/ directory
#                         (required unless a URL is passed as $1)
#   ORI_INSTALL_VERSION   version to install (default: "latest")
#   ORI_INSTALL_DIR       install directory (default: $HOME/.local/bin)
#   ORI_INSTALL_FORCE=1   allow downgrade / channel jump / overwrite
#
# Examples:
#   ORI_INSTALL_BASE_URL=https://dl.example.com/ori bash install.sh
#   ORI_INSTALL_BASE_URL=./dist bash install.sh
#   curl -fsSL https://dl.example.com/ori/install.sh | \
#     ORI_INSTALL_BASE_URL=https://dl.example.com/ori bash

set -euo pipefail

# ---------------------------------------------------------------------------
# args / env
# ---------------------------------------------------------------------------

BASE_URL="${ORI_INSTALL_BASE_URL:-}"
VERSION="${ORI_INSTALL_VERSION:-latest}"
INSTALL_DIR="${ORI_INSTALL_DIR:-$HOME/.local/bin}"
FORCE="${ORI_INSTALL_FORCE:-0}"

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --base-url) BASE_URL="$2"; shift 2 ;;
    --yes | --force) FORCE=1; shift ;;
    -h | --help)
      cat <<'EOF'
usage: install.sh [--dir PATH] [--version X] [--base-url URL] [--yes]

Installs the `ori` binary. Reads ORI_INSTALL_BASE_URL (a release base URL or a
local dist/ directory), verifies the SHA-256 checksum, and installs to a
user-writable path (default $HOME/.local/bin). Never downgrades silently and
never crosses a channel boundary without --yes.
EOF
      exit 0 ;;
    *) BASE_URL="$1"; shift ;;
  esac
done

[ -n "$BASE_URL" ] || {
  echo "error: no release base URL. Set ORI_INSTALL_BASE_URL or pass it as an argument." >&2
  exit 2
}

# A local directory (no scheme, or file://) reads artifacts directly instead of
# over HTTP — used for verification and air-gapped installs.
case "$BASE_URL" in
  file://*) LOCAL_DIR="${BASE_URL#file://}" ;;
  *://*) LOCAL_DIR="" ;;
  *) LOCAL_DIR="$BASE_URL" ;;
esac

log() { printf 'install.sh: %s\n' "$*"; }
die() { printf 'install.sh: error: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# target resolution
# ---------------------------------------------------------------------------

OS="$(uname -s)"
MACH="$(uname -m)"
case "$OS" in
  Darwin) OS_TARGET="darwin" ;;
  Linux) OS_TARGET="linux" ;;
  *) die "unsupported OS: $OS (matrix: macOS + Linux)" ;;
esac
case "$MACH" in
  arm64 | aarch64) ARCH_TARGET="aarch64" ;;
  x86_64 | amd64) ARCH_TARGET="x86_64" ;;
  *) die "unsupported arch: $MACH (matrix: arm64 + x86_64)" ;;
esac

case "$OS_TARGET:$ARCH_TARGET" in
  darwin:aarch64) TRIPLE="aarch64-apple-darwin" ;;
  darwin:x86_64) TRIPLE="x86_64-apple-darwin" ;;
  linux:x86_64) TRIPLE="x86_64-unknown-linux-musl" ;;
  linux:aarch64) TRIPLE="aarch64-unknown-linux-musl" ;;
esac

log "detected $OS/$MACH -> $TRIPLE"

# ---------------------------------------------------------------------------
# fetch helpers
# ---------------------------------------------------------------------------

fetch() { # <relative-path> -> stdout
  local rel="$1"
  if [ -n "$LOCAL_DIR" ]; then
    cat "$LOCAL_DIR/$rel"
  else
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "$BASE_URL/$rel"
    elif command -v wget >/dev/null 2>&1; then
      wget -qO- "$BASE_URL/$rel"
    else
      die "neither curl nor wget found"
    fi
  fi
}

# scalar extractors for the JSON contract (any whitespace; objects flattened
# to one line first)
flatten() { tr '\n' ' '; }
json_str() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1; }
pf_field() { # <triple> <url|sha256|size> — value kept raw (quotes for strings)
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*{[^}]*\"$2\"[[:space:]]*:[[:space:]]*\([^,}]*\)[^}]*}.*/\1/p" | head -1
}
strip_quotes() { tr -d '"'; }

sha_of() { # <file>
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# ---------------------------------------------------------------------------
# version comparison (dot-separated numeric)
# ---------------------------------------------------------------------------

ver_cmp() { # a b -> echo -1|0|1 (dot-separated numeric compare; portable)
  local a="$1" b="$2" i ma mb m av bv
  IFS=. read -ra ia <<< "$a"
  IFS=. read -ra ib <<< "$b"
  ma=${#ia[@]}; mb=${#ib[@]}
  m=$((ma > mb ? ma : mb))
  for ((i = 0; i < m; i++)); do
    av="${ia[$i]:-0}"; bv="${ib[$i]:-0}"
    av="${av%%[!0-9]*}"; bv="${bv%%[!0-9]*}"
    av="${av:-0}"; bv="${bv:-0}"
    if ((10#$av > 10#$bv)); then echo 1; return 0; fi
    if ((10#$av < 10#$bv)); then echo -1; return 0; fi
  done
  echo 0
}
ver_gt() { # a b -> 0 if a>b
  [ "$(ver_cmp "$1" "$2")" = "1" ]
}

installed_version() { # -> version or empty
  local bin="$INSTALL_DIR/ori"
  if [ -x "$bin" ]; then
    "$bin" --version 2>/dev/null | sed -n 's/^ori \([0-9][0-9.]*\).*/\1/p'
  fi
}

installed_channel() { # -> channel or empty (from the CLI's config.json)
  local cfg
  if [ "$OS_TARGET" = "darwin" ]; then
    cfg="$HOME/Library/Application Support/ori/config.json"
  else
    cfg="${XDG_CONFIG_HOME:-$HOME/.config}/ori/config.json"
  fi
  if [ -f "$cfg" ]; then
    sed -n 's/.*"channel"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$cfg" | head -1
  fi
}

# ---------------------------------------------------------------------------
# resolve manifest + checksum for the requested version
# ---------------------------------------------------------------------------

AVAILABLE_VERSION=""
AVAILABLE_CHANNEL=""
TARBALL_URL=""
EXPECTED_SHA=""

if [ "$VERSION" = "latest" ]; then
  log "checking $BASE_URL/latest.json"
  MANIFEST="$(fetch latest.json)" || die "could not fetch latest.json from $BASE_URL"
  AVAILABLE_VERSION="$(printf '%s' "$MANIFEST" | flatten | json_str version)"
  AVAILABLE_CHANNEL="$(printf '%s' "$MANIFEST" | flatten | json_str channel)"
  [ -n "$AVAILABLE_VERSION" ] || die "manifest has no version field"
  [ -n "$AVAILABLE_CHANNEL" ] || AVAILABLE_CHANNEL="stable"
  TARBALL_URL="$(printf '%s' "$MANIFEST" | flatten | pf_field "$TRIPLE" url | strip_quotes)"
  EXPECTED_SHA="$(printf '%s' "$MANIFEST" | flatten | pf_field "$TRIPLE" sha256 | strip_quotes)"
  [ -n "$TARBALL_URL" ] || die "no artifact for $TRIPLE in $BASE_URL/latest.json"
else
  AVAILABLE_VERSION="$VERSION"
  TARBALL_URL="ori-$VERSION-$TRIPLE.tar.gz"
  SUMS="$(fetch sha256sums.txt)" || die "could not fetch sha256sums.txt from $BASE_URL"
  EXPECTED_SHA="$(printf '%s' "$SUMS" | grep "ori-$VERSION-$TRIPLE.tar.gz" | awk '{print $1}')"
  [ -n "$EXPECTED_SHA" ] || die "no checksum for ori-$VERSION-$TRIPLE.tar.gz in sha256sums.txt"
  # channel is best-effort for pinned installs
  MANIFEST="$(fetch latest.json 2>/dev/null || true)"
  AVAILABLE_CHANNEL="$(printf '%s' "$MANIFEST" | flatten | json_str channel)"
  [ -n "$AVAILABLE_CHANNEL" ] || AVAILABLE_CHANNEL="stable"
fi

# ---------------------------------------------------------------------------
# guards: no downgrade, no silent channel jump, no overwrite
# ---------------------------------------------------------------------------

CUR_VER="$(installed_version)"
if [ -n "$CUR_VER" ]; then
  if ver_gt "$CUR_VER" "$AVAILABLE_VERSION"; then
    if [ "$FORCE" = "1" ]; then
      log "WARNING: $INSTALL_DIR/ori is $CUR_VER, newer than $AVAILABLE_VERSION; --force given, installing anyway"
    else
      die "$INSTALL_DIR/ori is already $CUR_VER (newer than available $AVAILABLE_VERSION); refusing to downgrade (set ORI_INSTALL_FORCE=1 to override)"
    fi
  elif [ "$CUR_VER" = "$AVAILABLE_VERSION" ]; then
    log "already up to date: $INSTALL_DIR/ori is $CUR_VER"
    exit 0
  fi
fi

CUR_CHANNEL="$(installed_channel)"
if [ -n "$CUR_CHANNEL" ] && [ -n "$AVAILABLE_CHANNEL" ] \
  && [ "$CUR_CHANNEL" != "$AVAILABLE_CHANNEL" ]; then
  if [ "$FORCE" = "1" ]; then
    log "WARNING: channel $AVAILABLE_CHANNEL != configured channel $CUR_CHANNEL; --force given, proceeding"
  else
    die "channel boundary: configured channel is '$CUR_CHANNEL' but the release is '$AVAILABLE_CHANNEL'; refusing to update across channels (set ORI_INSTALL_FORCE=1 to override)"
  fi
fi

# ---------------------------------------------------------------------------
# download, verify, install
# ---------------------------------------------------------------------------

log "downloading $TARBALL_URL (v$AVAILABLE_VERSION, $AVAILABLE_CHANNEL)"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
if [ -n "$LOCAL_DIR" ]; then
  cp "$LOCAL_DIR/$TARBALL_URL" "$TMP"
else
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$BASE_URL/$TARBALL_URL" -o "$TMP"
  else
    wget -qO "$TMP" "$BASE_URL/$TARBALL_URL"
  fi
fi

GOT_SHA="$(sha_of "$TMP")"
if [ -z "$EXPECTED_SHA" ]; then
  die "no checksum published for $TARBALL_URL; refusing to install unverifiable artifact"
fi
if [ "$GOT_SHA" != "$EXPECTED_SHA" ]; then
  die "checksum mismatch for $TARBALL_URL (expected $EXPECTED_SHA, got $GOT_SHA); not installing"
fi
log "checksum verified ($GOT_SHA)"

mkdir -p "$INSTALL_DIR"
NEW="$INSTALL_DIR/.ori.new.$$"
trap 'rm -f "$NEW"; rm -f "$TMP"' EXIT
tar -xOzf "$TMP" ori > "$NEW" 2>/dev/null \
  || tar -xOzf "$TMP" ./ori > "$NEW" \
  || die "tarball does not contain an 'ori' entry"
chmod 0755 "$NEW"
mv -f "$NEW" "$INSTALL_DIR/ori"
rm -f "$TMP"

# ---------------------------------------------------------------------------
# report
# ---------------------------------------------------------------------------

log "installed ori $AVAILABLE_VERSION ($TRIPLE) to $INSTALL_DIR/ori"
if ! printf '%s' ":$PATH:" | grep -Fq ":${INSTALL_DIR}:"; then
  log "note: $INSTALL_DIR is not on your PATH. Add it with:"
  printf '       export PATH="%s:$PATH"\n' "$INSTALL_DIR"
fi
"$INSTALL_DIR/ori" --version