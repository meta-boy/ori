#!/usr/bin/env bash
# Build the ori-image Incus VM image (P12) from the same image/provision.sh and
# publish it under an alias. Requires a running Incus daemon on a real host.
set -euo pipefail

cd "$(dirname "$0")"

ALIAS="${ORI_IMAGE_ALIAS:-ori-base/1.0}"
BASE_IMAGE="${ORI_BASE_IMAGE:-ubuntu:24.04}"
INSTANCE="${ORI_IMAGE_INSTANCE:-ori-image-builder}"

if ! command -v incus >/dev/null 2>&1; then
    echo "error: 'incus' is not installed on this machine." >&2
    echo "       build-incus.sh must run on a host with Incus (Ubuntu host, see infra/bootstrap.sh, P12)." >&2
    echo "       The local provision.sh and Docker build have nothing to do with Incus." >&2
    exit 1
fi

if ! incus remote list >/dev/null 2>&1 && ! incus info >/dev/null 2>&1 2>/dev/null; then
    echo "error: incus daemon is not responding. Start it with 'incus admin init' first." >&2
    exit 1
fi

echo ">>> pulling base ${BASE_IMAGE} (VM)"
incus launch "${BASE_IMAGE}" "${INSTANCE}" -t virtual-machine >/dev/null

cleanup() { incus delete --force "${INSTANCE}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo ">>> provisioning ${INSTANCE} with image/provision.sh"
incus config set "${INSTANCE}" raw.lxc "lxc.apparmor.profile=unconfined" >/dev/null 2>&1 || true
incus start "${INSTANCE}"
incus file push provision.sh "${INSTANCE}/root/provision.sh"
incus exec "${INSTANCE}" -- chmod +x /root/provision.sh
incus exec "${INSTANCE}" -- bash /root/provision.sh

echo ">>> publishing as image alias ${ALIAS}"
incus publish "${INSTANCE}" --alias "${ALIAS}" --compression none

echo "Done: published Incus VM image alias '${ALIAS}'."
echo "P12 driver builds VMs from it via low-level 'incus launch <alias>'."
echo "NB: launch a temp VM and publish creates a VM image that inherits systemd
as PID1, so the units written by provision.sh (sshd/docker/desktop/agent) run."