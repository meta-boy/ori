# Firecracker driver — synthesized design

Substrate-class suspend/resume as an opt-in driver (`ORI_DRIVER=firecracker`) for a
Linux/KVM host. The docker driver stays the default. Synthesized from two independent
designs (2026-08-07); both converged on Firecracker and on keeping the existing driver
seam untouched.

## Decisions

1. **Hypervisor: Firecracker.** Snapshot/restore is its production-proven flagship
   (Lambda/Fargate), which is the entire point of this driver. DinD inside the guest gets
   *easier* than docker's `--privileged --cgroupns=host` contortion — a real kernel with
   systemd PID 1 runs plain dockerd. VNC is just TCP; no GPU device model involved. Kata is
   container-shaped, not machine-shaped; Cloud Hypervisor is the fallback if FC's device
   model ever becomes the constraint. Guest kernel needs overlayfs, netfilter, bridge/veth,
   cgroup v2, PSI. Run VMMs under `jailer` in production. FC supports up to 32 vCPUs, so
   every machine type fits.

2. **Image pipeline: reuse the docker build, convert to ext4.** `image/build-fc.sh`:
   `docker build` → `docker export` → untar into sparse raw ext4 (per-type size or
   resize2fs), plus a small VM overlay (fstab; UNMASK timesyncd/chrony — in a VM the guest
   owns its clock and resume makes that load-bearing; ori-seed.service). One pinned guest
   vmlinux, config committed to image/. Per-ori guest agent + identity env ride a **seed
   disk** built with `mke2fs -d` (no root needed), attached as a second virtio-block device;
   ori-seed.service installs both before ori-agent.service. Per-VM rootfs copies via
   `cp --reflink=auto` (document a reflink filesystem as the host recommendation).

3. **Networking: bridge + tap, contract unchanged.** One host bridge (e.g. `ori-fc0`,
   172.30.0.0/16), one tap per VM. Driver allocates the guest IP, passes it via the kernel
   `ip=` boot arg (no DHCP), returns it from create()/start(). GuestClient, sshAddress,
   hostAddress, desktopAddress all get a plain routable-on-host IP. Outbound = one
   MASQUERADE rule. **All state persisted** in per-machine metadata JSON under
   `/var/lib/ori/fc/<machineId>/` (oriId, ip, tap, type, artifact paths, FC version) — a
   snapshot restore needs the same-named tap recreated, and the guest keeps its IP inside
   snapshotted memory, so allocation must survive control-plane restarts.

4. **Snapshot tiers: the memory snapshot IS the warm tier.** The landed
   `SuspendableDriver {stop,start,exists}` seam is the whole integration:
   - stop(): pause → `PUT /snapshot/create` (mem file + vmstate into the machine dir) →
     kill the VMM. The final restic snapshot already ran before this (stop.ts order).
   - start(): recreate tap → spawn VMM → `snapshot/load` → resume → step the guest clock
     (new guest-agent `/clock` endpoint) → return persisted IP. Sub-second, processes intact.
   - Restore failure of any kind (corrupt artifacts, FC version/CPU mismatch recorded in
     metadata) = delete warm artifacts and throw; resume.ts already treats a start() failure
     as warm-miss → cold. Never an error state, never ship mem files to restic.
   - Fork stays cold (duplicated machine identity — host keys, tokens, IP — is a non-goal).
     Resize and noEnv stay forced-cold; noEnv on FC is *structural* — restore without
     attaching the seed/env disk, nothing to scrub.
   - Eviction: mem files cost ≈ machine RAM (nano 0.5G … large 4G), so budget **bytes,
     not count**: `ORI_WARM_MAX_BYTES` ceiling in the same housekeeping sweep, evicting
     fattest/oldest first. Later: balloon-deflate before snapshot.

## Honest risks

- **Clock drift after resume** — guest wakes in the past; mitigated by the /clock step +
  chrony makestep. Documented FC caveat, not a discovery.
- **TCP across resume** — guest↔outside connections die on wake (control plane immune:
  GuestClient is connection-per-call). Document, don't fight.
- **Snapshot fragility is by design** — same FC version/CPU/kernel required; mismatch =
  warm miss, cold restore.
- **Mem-file disk pressure** — byte-budgeted eviction is mandatory, not optional.
- **Cold boot stays seconds** — the sub-second story is resume. (Pre-booted per-type
  template snapshots could fix create later; collides with per-machine identity; deferred.)
- **Host requirements** — /dev/kvm, /dev/net/tun, CAP_NET_ADMIN for the API service;
  bare-metal Linux per infra/bootstrap.sh is the clean target.

## Stages

1. **Boot-only driver** — `packages/api/src/drivers/firecracker.ts` (VMM spawn, FC socket
   API, tap/bridge, IP allocator, persisted metadata, seed disk, address capabilities);
   `image/build-fc.sh` + vm-overlay + kernel config; `ORI_DRIVER` wiring in index.ts;
   infra/bootstrap.sh + systemd unit additions; OPERATIONS.md host requirements. Unit tests
   mock the FC API socket + filesystem; e2e script gated on a firecrackerAvailable() probe.
2. **Snapshot/resume** — stop/start/exists via pause + snapshot/create + snapshot/load;
   guest-agent /clock endpoint; artifact cleanup on failed restore. stop.ts/resume.ts
   unchanged (already capability-driven).
3. **Tier & fleet** — byte-budgeted warm eviction in reaper housekeeping; listAliveIds
   from live VMM processes; sampleStats from cgroups + guest-agent exec.

**macOS testability:** unit layer only (FC is KVM-only). Everything real needs a Linux
host — same split the docker driver already lives with.

## Measured (2026-08-07, Proxmox host, FC v1.10.1, nano 512MB, `make e2e-fc-bench`)

| | |
|---|---|
| cold boot → agent healthy | 3525 ms |
| snapshot create (median) | 156 ms (first: ~490 ms cold page cache) |
| **resume → agent healthy (median)** | **163 ms** |
| process survival | verified — counter kept its pid and state across 3 cycles |
| clock step after resume | within ~1.5 s of host every cycle |

Real-host bugs the e2e caught that mocked tests could not: `command -v` probe outside a
shell, seed ext4 sized without journal overhead, `/drives/{id}` path-param API shape,
deprecated `mem_file_path` vs `mem_backend`, stale tap wedging create/start after a crashed
VMM, and the dead VMM's leftover API socket blocking the fresh one's bind.
