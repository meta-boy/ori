#!/usr/bin/env bash
# ori — install or update the CLI.
#
#     curl -fsSL https://raw.githubusercontent.com/meta-boy/ori/main/install.sh | bash
#
# Installing and updating are the same operation on purpose: one script, one code path, so an
# update can never take a route that was never tested. Re-running it when you are already on
# the newest version does nothing and says so.
#
# Options (flags, or the environment variable — both work through a pipe):
#   --version vX.Y.Z   ORI_VERSION      install a specific release (default: latest)
#   --dir PATH         ORI_INSTALL_DIR  where to put the binary (default: /usr/local/bin,
#                                       falling back to ~/.local/bin when that needs root)
#   --force            ORI_FORCE=1      reinstall even if the version already matches
#   --uninstall                         remove the binary and say what was left behind
#   --no-verify        ORI_NO_VERIFY=1  skip the checksum check (do not)
#
# What it does NOT do: touch your shell profile, install a background updater, or send
# anything anywhere. It downloads one file, checks its sha256 against the release's
# SHA256SUMS, and moves it into place.
set -euo pipefail

REPO="${ORI_REPO:-meta-boy/ori}"
VERSION="${ORI_VERSION:-latest}"
INSTALL_DIR="${ORI_INSTALL_DIR:-}"
FORCE="${ORI_FORCE:-}"
NO_VERIFY="${ORI_NO_VERIFY:-}"
UNINSTALL=""

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?--version needs a tag}"; shift 2 ;;
    --dir)     INSTALL_DIR="${2:?--dir needs a path}"; shift 2 ;;
    --force)   FORCE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --no-verify) NO_VERIFY=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" 2>/dev/null || true; exit 0 ;;
    *) printf 'ori install: unknown option %s\n' "$1" >&2; exit 2 ;;
  esac
done

# Colour only when a human is watching; a piped log should stay plain.
if [ -t 2 ]; then B=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[1;31m'; GRN=$'\033[1;32m'; RST=$'\033[0m'
else B=""; DIM=""; RED=""; GRN=""; RST=""; fi
say()  { printf '%s==>%s %s\n' "$B" "$RST" "$*" >&2; }
note() { printf '    %s%s%s\n' "$DIM" "$*" "$RST" >&2; }
die()  { printf '%serror:%s %s\n' "$RED" "$RST" "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed"; }
need uname
need mktemp

# curl or wget, whichever exists — a minimal container usually has exactly one.
if command -v curl >/dev/null 2>&1; then
  fetch()      { curl -fsSL "$1"; }
  fetch_to()   { curl -fsSL -o "$2" "$1"; }
  fetch_code() { curl -fsSL -o /dev/null -w '%{http_code}' "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch()      { wget -qO- "$1"; }
  fetch_to()   { wget -qO "$2" "$1"; }
  fetch_code() { wget -q --server-response -O /dev/null "$1" 2>&1 | awk '/HTTP\//{c=$2} END{print c}'; }
else
  die "neither curl nor wget is installed"
fi

# --- platform ----------------------------------------------------------------
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux)  os=linux ;;
  *) die "unsupported OS: $(uname -s) (ori ships darwin and linux builds)" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64)  arch=x64 ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac
ASSET="ori-${os}-${arch}"

# --- where does it go --------------------------------------------------------
# /usr/local/bin is on everyone's PATH; ~/.local/bin is the fallback that needs no root. A
# script that silently sudos is worse than one that tells you which it picked.
SUDO=""
if [ -z "$INSTALL_DIR" ]; then
  if [ -w /usr/local/bin ] 2>/dev/null; then
    INSTALL_DIR=/usr/local/bin
  elif command -v sudo >/dev/null 2>&1 && [ -d /usr/local/bin ]; then
    INSTALL_DIR=/usr/local/bin
    SUDO=sudo
  else
    INSTALL_DIR="$HOME/.local/bin"
  fi
elif [ ! -w "$INSTALL_DIR" ] && [ -d "$INSTALL_DIR" ] && command -v sudo >/dev/null 2>&1; then
  SUDO=sudo
fi
TARGET="$INSTALL_DIR/ori"

# --- uninstall ---------------------------------------------------------------
if [ -n "$UNINSTALL" ]; then
  if [ -e "$TARGET" ]; then
    $SUDO rm -f "$TARGET"
    say "removed $TARGET"
  else
    say "nothing to remove at $TARGET"
  fi
  note "left alone: ~/.config/ori (your key and control-plane URL), ~/.ssh/ori_ed25519"
  exit 0
fi

# --- which release -----------------------------------------------------------
if [ "$VERSION" = latest ]; then
  BASE="https://github.com/$REPO/releases/latest/download"
else
  case "$VERSION" in v*) ;; *) VERSION="v$VERSION" ;; esac
  BASE="https://github.com/$REPO/releases/download/$VERSION"
fi

installed=""
if [ -x "$TARGET" ]; then
  # `ori version --json` on anything recent; older builds have no version command at all,
  # which is itself the answer ("older than versioning").
  installed="$("$TARGET" version 2>/dev/null | head -1 || true)"
fi

# --- already current? --------------------------------------------------------
# The promise at the top of this file, finally kept: re-running when you are already on the
# target version does nothing. Until now every `ori update` downloaded ~100MB and moved a
# byte-identical binary into place, however recently you had updated.
#
# `--force` overrides exactly this, so the skip is the only part that has to be careful: when
# the wanted version cannot be resolved (offline, rate-limited, a private mirror that has no
# GitHub API), fall through and install rather than refuse to do anything.
if [ -z "$FORCE" ] && [ -n "$installed" ]; then
  # "ori v0.4.1 (e7af73a) darwin-arm64" -> "v0.4.1". A dev build says "dev" and never matches.
  current="$(printf '%s\n' "$installed" | awk '{print $2}')"
  want="$VERSION"
  if [ "$want" = latest ]; then
    # No jq on a minimal host: the tag is the first "tag_name" in the release JSON. GitHub's
    # unauthenticated limit is 60/hour per IP, which nobody running an installer will hit.
    want="$(fetch "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null |
      sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  fi
  case "$want" in
    v*)
      if [ "$current" = "$want" ]; then
        say "already on ${GRN}${current}${RST} — nothing to do ${DIM}(--force to reinstall)${RST}"
        exit 0
      fi
      ;;
  esac
fi

say "installing $ASSET from ${VERSION}"
[ -n "$installed" ] && note "currently installed: $installed"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

say "downloading"
fetch_to "$BASE/$ASSET" "$tmp/ori" || die "download failed: $BASE/$ASSET
    (does that release include a build for ${os}-${arch}?)"
[ -s "$tmp/ori" ] || die "downloaded an empty file from $BASE/$ASSET"

# --- checksum ----------------------------------------------------------------
# The binary is about to be run as you. A published SHA256SUMS costs one request to check.
if [ -z "$NO_VERIFY" ]; then
  if fetch_to "$BASE/SHA256SUMS" "$tmp/SHA256SUMS" 2>/dev/null && [ -s "$tmp/SHA256SUMS" ]; then
    expected="$(awk -v a="$ASSET" '$2 == a || $2 == "*"a {print $1}' "$tmp/SHA256SUMS" | head -1)"
    if [ -z "$expected" ]; then
      note "SHA256SUMS has no entry for $ASSET — skipping verification"
    else
      if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp/ori" | awk '{print $1}')"
      elif command -v shasum >/dev/null 2>&1; then actual="$(shasum -a 256 "$tmp/ori" | awk '{print $1}')"
      else actual=""; note "no sha256sum or shasum — skipping verification"; fi
      if [ -n "$actual" ]; then
        [ "$actual" = "$expected" ] || die "checksum mismatch for $ASSET
    expected $expected
    actual   $actual
    Refusing to install. Re-run, and if it persists open an issue — do not use --no-verify."
        note "sha256 ok"
      fi
    fi
  else
    note "no SHA256SUMS published for this release — skipping verification"
  fi
fi

chmod +x "$tmp/ori"

# Gatekeeper quarantines anything downloaded; without this the first run dies with a dialog
# about an unidentified developer. The binaries are unsigned, which this does not change —
# it only stops macOS refusing a file you just asked for.
if [ "$os" = darwin ] && command -v xattr >/dev/null 2>&1; then
  xattr -d com.apple.quarantine "$tmp/ori" 2>/dev/null || true
fi

new="$("$tmp/ori" version 2>/dev/null | head -1 || echo unknown)"
if [ -z "$FORCE" ] && [ -n "$installed" ] && [ "$installed" = "$new" ]; then
  say "${GRN}already up to date${RST} — $installed"
  note "re-run with --force to reinstall anyway"
  exit 0
fi

# --- install -----------------------------------------------------------------
$SUDO mkdir -p "$INSTALL_DIR" || die "could not create $INSTALL_DIR"
[ -n "$SUDO" ] && note "using sudo to write to $INSTALL_DIR"
# install(1) replaces the file atomically, which matters when the binary being overwritten is
# the one running this — an in-place cp can produce "text file busy" or a truncated binary.
$SUDO install -m 0755 "$tmp/ori" "$TARGET" || die "could not install to $TARGET"

say "${GRN}installed${RST} $new → $TARGET"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    note "$INSTALL_DIR is not on your PATH. Add it:"
    note "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.$(basename "${SHELL:-bash}")rc"
    ;;
esac

if [ -z "$installed" ]; then
  cat >&2 <<EOF

    next:
      ori login <api-key> --api-url https://your-control-plane
      ori new --type nano
      ori ssh <id>
EOF
fi
