# ori-image Docker driver base image (P4-07).
# systemd as PID 1 so sshd / docker / (lazily) desktop and the guest agent
# all run as real services inside the container. ubuntu:24.04 only.
FROM ubuntu:24.04

# systemd needs to be PID 1 to work; this is the standard working recipe in a
# privileged container.
ENV container=docker
ENV DEBIAN_FRONTEND=noninteractive
STOPSIGNAL SIGRTMIN+3

# Branding assets provision.sh installs (the wallpaper). Copied before it runs, and left in
# place rather than deleted: the wallpaper is referenced by path at session start.
COPY branding/ /opt/ori/branding/

# provision.sh reads this to decide core vs full. An ARG is visible to RUN as an env
# var, so it reaches the script without an ENV that would also bake into the image.
ARG ORI_IMAGE_TIER=full

COPY provision.sh /opt/ori-provision.sh
RUN chmod +x /opt/ori-provision.sh \
    && /opt/ori-provision.sh \
    && rm -f /opt/ori-provision.sh

# guest agent :7777, sshd :22
EXPOSE 7777 22

VOLUME ["/sys/fs/cgroup", "/run"]

# systemd PID1
CMD ["/lib/systemd/systemd"]