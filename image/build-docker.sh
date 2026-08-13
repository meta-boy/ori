#!/usr/bin/env bash
# Build the ori-image Docker driver base image (P4-07).
set -euo pipefail

cd "$(dirname "$0")"

IMAGE="${IMAGE:-ori-base:latest}"

docker build -t "$IMAGE" --build-arg ORI_IMAGE_TIER="${ORI_IMAGE_TIER:-full}" .

printf '\nBuilt %s. systemd must be PID 1 for sshd/dockerd to run, which needs:\n' "$IMAGE"
printf '%s\n' '  docker run -d --privileged --cgroupns=host \' \
              '    --tmpfs /run --tmpfs /run/lock \' \
              '    -v /sys/fs/cgroup:/sys/fs/cgroup:rw '"$IMAGE"