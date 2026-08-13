#!/usr/bin/env bash
# Build the ori Firecracker guest rootfs (ORI_DRIVER=firecracker) as a sparse raw
# ext4 disk image. Same docker invocation as image/build-docker.sh, then converts
# the exported rootfs into a bootable disk for a KVM host.
#
# Usable sizes must match packages/contract MACHINE_TABLE (usableGB):
#   nano 6, small 8, default 20, large 36
# Default builds ONE base image (36 GiB, the largest requestable type); per-type
# images pass PER_TYPE_GB=6/8/20/36. create() copies this base and resize2fs's the
# copy to the requested type's size.
set -euo pipefail

cd "$(dirname "$0")"

if [[ "$(uname -s)" == "Darwin" ]]; then
    echo "error: build-fc.sh must run on a Linux build host." >&2
    echo "       Firecracker is KVM-only; the docker/export/loop-mount pipeline needs Linux." >&2
    exit 1
fi

IMAGE="${IMAGE:-ori-base:latest}"
OUT="${ORI_FC_IMAGE:-ori-fc-base.img}"
PER_TYPE_GB="${1:-${PER_TYPE_GB:-36}}"
if ! [[ "$PER_TYPE_GB" =~ ^[0-9]+$ ]] || (( PER_TYPE_GB <= 0 )); then
    echo "error: PER_TYPE_GB must be a positive integer of GiB; got '$PER_TYPE_GB'." >&2
    exit 1
fi

for cmd in docker truncate mkfs.ext4 tar losetup e2fsck; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "error: '$cmd' not found (e.g. Ubuntu: apt install e2fsprogs docker.io)." >&2
        exit 1
    fi
done

if [[ "$(id -u)" -eq 0 ]]; then
    SUDO=()
else
    SUDO=(sudo)
fi

CTR=""
ROOTFS_TAR=""
MNT=""
LOOP=""
cleanup() {
    if [[ -n "$LOOP" && -n "$MNT" ]]; then
        "${SUDO[@]}" umount -f "$MNT" >/dev/null 2>&1 || true
        "${SUDO[@]}" losetup -d "$LOOP" >/dev/null 2>&1 || true
    fi
    [[ -n "$CTR" ]] && docker rm -f "$CTR" >/dev/null 2>&1 || true
    [[ -n "$ROOTFS_TAR" && -f "$ROOTFS_TAR" ]] && rm -f "$ROOTFS_TAR" || true
    [[ -n "$MNT" && -d "$MNT" ]] && rmdir "$MNT" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo ">>> building ${IMAGE} (same invocation as build-docker.sh)"
docker build -t "$IMAGE" --build-arg ORI_IMAGE_TIER="${ORI_IMAGE_TIER:-full}" .

CTR="ori-fc-builder-$$"
ROOTFS_TAR="$(mktemp /tmp/ori-fc-rootfs.XXXXXX.tar)"
MNT="$(mktemp -d /tmp/ori-fc-mnt.XXXXXX)"

echo ">>> exporting rootfs from ${IMAGE}"
docker create --name "$CTR" "$IMAGE" /bin/true >/dev/null
docker export "$CTR" > "$ROOTFS_TAR"
docker rm "$CTR"
CTR=""

SIZE_BYTES=$(( PER_TYPE_GB * 1024 * 1024 * 1024 ))
echo ">>> creating ${PER_TYPE_GB} GiB sparse ext4 image ${OUT}"
truncate -s "$SIZE_BYTES" "$OUT"
mkfs.ext4 -q -m 0 -L ori-root "$OUT"

echo ">>> mounting image via loop device (this step needs root)"
LOOP="$("${SUDO[@]}" losetup --find --show "$OUT")"
"${SUDO[@]}" mount "$LOOP" "$MNT"

echo ">>> unpacking rootfs"
"${SUDO[@]}" tar -C "$MNT" -xpf "$ROOTFS_TAR"

echo ">>> applying image/vm-overlay (fstab, ori-seed.service, enable symlink)"
"${SUDO[@]}" cp -a vm-overlay/etc "$MNT"/

echo ">>> unmasking time sync for VM use (the docker image masks it)"
"${SUDO[@]}" rm -f \
    "$MNT/etc/systemd/system/systemd-timesyncd.service" \
    "$MNT/etc/systemd/system/chrony.service" \
    "$MNT/etc/systemd/system/chronyd.service"

echo ">>> checking filesystem"
"${SUDO[@]}" umount "$MNT"
"${SUDO[@]}" losetup -d "$LOOP"
LOOP=""
e2fsck -f -y "$OUT"

printf '\nDone: %s (%s GiB, sparse).\n' "$OUT" "$PER_TYPE_GB"
printf '%s\n' '  Root device is /dev/vda (whole-disk ext4, no partition table).' \
              '  /dev/vdb is the optional per-ori seed disk (ext4, built with mke2fs -d).' \
              '  create() copies this base and resizes per type with resize2fs' \
              '  (MACHINE_TABLE usableGB: nano 6, small 8, default 20, large 36).' \
              '  Set ORI_FC_IMAGE to write the artifact outside this repo.'
