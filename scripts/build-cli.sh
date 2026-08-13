#!/usr/bin/env bash
# Compile the `ori` CLI to a single self-contained binary per platform.
#
# Ori distributes its CLI as one prebuilt binary fetched from
# /api/ori/cli/download?platform=<os>-<arch>, which is why the CLI is a
# thin client with no runtime dependency on this repo: a user should not need bun, node or a
# checkout to run it.
#
# Usage:
#   scripts/build-cli.sh                 # this machine only (fast, for local use)
#   scripts/build-cli.sh --all           # every supported platform
set -euo pipefail
cd "$(dirname "$0")/.."

ENTRY="packages/cli/src/index.ts"
OUT_DIR="dist/cli"
mkdir -p "$OUT_DIR"

host_target() {
  local os arch
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
  esac
  echo "bun-${os}-${arch}"
}

# The four platforms ori itself serves.
ALL_TARGETS=(bun-darwin-arm64 bun-darwin-x64 bun-linux-arm64 bun-linux-x64)

if [ "${1:-}" = "--all" ]; then
  targets=("${ALL_TARGETS[@]}")
else
  targets=("$(host_target)")
fi

# Stamped into the binary so `ori version` can answer without a network call or a file beside
# it. VERSION comes from the release tag when one is being cut, else `git describe`.
VERSION="${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "version $VERSION ($COMMIT)"

for t in "${targets[@]}"; do
  name="ori-${t#bun-}"
  echo "building $name"
  # --minify keeps the binary a sane size; the CLI is one file so there is nothing to split.
  bun build --compile --minify --target "$t" --outfile "$OUT_DIR/$name" "$ENTRY" \
    --define ORI_BUILD_VERSION="\"$VERSION\"" --define ORI_BUILD_COMMIT="\"$COMMIT\"" >/dev/null
  chmod +x "$OUT_DIR/$name"
  printf '  %s  %s\n' "$name" "$(du -h "$OUT_DIR/$name" | cut -f1)"
done

echo
echo "binaries in $OUT_DIR"
echo "install this machine's:  cp $OUT_DIR/ori-$(host_target | sed 's/^bun-//') /usr/local/bin/ori"
