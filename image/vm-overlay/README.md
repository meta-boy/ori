# vm-overlay — what a Firecracker guest rootfs needs that the docker image lacks

`image/build-fc.sh` builds the docker base image (same `docker build` as
`build-docker.sh`), exports the rootfs into a sparse raw ext4 disk, and applies
this overlay on top. The overlay mirrors the guest rootfs under `etc/`; only the
`etc/` tree is copied (`cp -a vm-overlay/etc "$MNT"/`), so this README never
lands inside the image.

## etc/fstab

The image is a **whole-disk ext4** filesystem (no partition table), so the root
entry is `/dev/vda`, not `/dev/vda1`:

- `/dev/vda / ext4 defaults,noatime 0 1` — the root filesystem.
- `/dev/vdb /run/ori-seed ext4 defaults,nofail,x-systemd.device-timeout=2 0 2` —
  the per-ori **seed disk**, a second virtio-blk device. `nofail` keeps a
  machine that boots without a seed disk (noEnv forced-cold) from hanging on the
  device wait. `/run` is tmpfs, so `/run/ori-seed` is a fresh empty mount point
  at every boot.

## etc/systemd/system/ori-seed.service

Installs the two per-ori payloads that must never ship in a shared base image:

- `/run/ori-seed/ori-agent` → `/usr/local/bin/ori-agent` (mode 0755)
- `/run/ori-seed/ori.env` → `/etc/ori.env` (mode 0644)

The seed disk is built by the driver with `mke2fs -d` on the host (no root
needed) and attached as `/dev/vdb`. `ConditionPathExists=/dev/vdb` makes the
unit a no-op when no seed disk is attached. `Before=ori-agent.service` guarantees
the binary and env exist before the guest agent starts; `After=local-fs.target`
means the fstab entry (if the seed was present at boot) has already mounted
`/run/ori-seed`, and the `mountpoint -q || mount` ExecStart is belt-and-braces
for a disk attached after boot. `WantedBy=multi-user.target` plus the enable
symlink (`etc/systemd/system/multi-user.target.wants/ori-seed.service`) is the
static `systemctl enable`, done in the overlay instead of a chroot.

## Unmasking time sync — why the overlay "removes symlinks"

The docker image **masks** `systemd-timesyncd` (and chrony if installed) the way
container systemd builds do: a symlink `/etc/systemd/system/<unit>.service ->
/dev/null`. A masked unit cannot be started by anything — an enable symlink in
`.wants` loses to the `/dev/null` unit file — so "unmask" cannot be expressed as
an overlay *file*; it must **remove** the mask symlinks.

That removal is load-bearing for VMs: inside a container the host owns the clock,
but in a VM the **guest owns its clock**, and snapshot/resume makes it
load-bearing (the guest wakes in the past; NTP + chrony makestep re-align it).
`build-fc.sh` therefore deletes these mask symlinks from the mounted rootfs:

```
/etc/systemd/system/systemd-timesyncd.service
/etc/systemd/system/chrony.service
/etc/systemd/system/chronyd.service
```

Once unmasked, the stock Ubuntu enablement applies again (timesyncd is enabled
by default unless chrony replaced it). Note that a `fstab`/boot-time failure
here is silent in docker (the container doesn't need NTP) and would only surface
as clock skew after a resume — the build script's `rm -f` is idempotent.
