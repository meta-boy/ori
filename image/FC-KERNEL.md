# Building the pinned Firecracker guest kernel

`ORI_DRIVER=firecracker` boots the ori rootfs under Firecracker on a KVM host.
The guest needs its own kernel: the **config is the versioned artifact**
(`image/fc-kernel.config`), never the binary. The binary is a build product and
is deliberately not committed.

- Kernel pin: **v6.12 LTS** (Firecracker supports modern kernels; pin, don't float).
- Build type: **static** — everything built in (`=y`), no modules, so the guest
  boots without an initramfs straight onto `/dev/vda` (ext4, whole-disk image).
- Required host packages: `build-essential flex bison libelf-dev libssl-dev bc`
  (Ubuntu names).

## Exact commands

```sh
# 1. host deps (Ubuntu/Debian)
sudo apt-get install -y build-essential flex bison libelf-dev libssl-dev bc

# 2. fetch a pinned kernel tree (shallow clone; ~300 MiB)
KERNEL=v6.12
FC_CONFIG="$PWD/image/fc-kernel.config"          # from this repo
ORI_FC_KERNEL="${ORI_FC_KERNEL:-/var/lib/ori/fc/kernels/vmlinux-6.12}"
KERNEL_DIR="$(mktemp -d)"
git clone --depth 1 --branch "$KERNEL" \
    https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git \
    "$KERNEL_DIR/linux"
cd "$KERNEL_DIR/linux"

# 3. start from a bootable x86_64 base plus the KVM-guest fragment. (There is NO
#    `microvm_defconfig` make target in the mainline tree — Firecracker ships a
#    full .config instead. x86_64_defconfig + kvm_guest.config are the real
#    targets that produce a virtio-capable guest, and the fragment below adds the
#    rest.)
make x86_64_defconfig
make kvm_guest.config

# 4. apply the committed fragment (image/fc-kernel.config) on top
cp "$FC_CONFIG" .ori-fragment.config
cat .ori-fragment.config >> .config
make olddefconfig

# 5. GATE: every required feature must survive olddefconfig (it silently drops
#    symbols whose dependencies are unmet). Treat any miss as a build error.
grep -E \
  '^(CONFIG_OVERLAY_FS|CONFIG_BRIDGE|CONFIG_BRIDGE_NETFILTER|CONFIG_VETH|CONFIG_TUN|CONFIG_PSI|CONFIG_EXT4_FS|CONFIG_VIRTIO|CONFIG_VIRTIO_MMIO|CONFIG_VIRTIO_BLK|CONFIG_VIRTIO_NET|CONFIG_VIRTIO_VSOCKETS|CONFIG_CGROUPS|CONFIG_CGROUP_BPF|CONFIG_NAMESPACES|CONFIG_NF_TABLES|CONFIG_NF_NAT|CONFIG_IP_NF_IPTABLES|CONFIG_IP_NF_TARGET_MASQUERADE|CONFIG_IP_NF_NAT)=y$' \
  .config >/dev/null \
  || { echo "error: a required kernel feature is missing from .config" >&2; exit 1; }

# 6. review the resolved config against the committed fragment (optional)
make savedefconfig
diff <(sort .ori-fragment.config) <(sort defconfig) | head

# 7. build vmlinux
make -j"$(nproc)" vmlinux

# 8. place the artifact where the driver reads it (ORI_FC_KERNEL)
sudo install -D -m 0644 vmlinux "$ORI_FC_KERNEL"
```

## Where the artifact goes

The driver reads `ORI_FC_KERNEL` (default `/var/lib/ori/fc/kernels/vmlinux-6.12`)
and records the path per machine in the Firecracker metadata JSON. If you rebuild
with a different kernel tag, commit a changed `image/fc-kernel.config` and bump
the artifact filename (e.g. `vmlinux-6.12`) — snapshot restore requires the exact
same kernel that produced the memory image, so the version lives in the filename
and the metadata, not in a floating "latest".

## Boot arguments the driver passes

```
root=/dev/vda rw console=ttyS0 panic=1 <ip=>...   # ip= is the per-ori static IP, no DHCP
```

`root=/dev/vda` matches the whole-disk image from `image/build-fc.sh` and the
`/dev/vda` fstab entry in `image/vm-overlay/etc/fstab`. `console=ttyS0` uses the
Firecracker serial console (`CONFIG_SERIAL_8250_CONSOLE` in the fragment). No
initramfs: the root fs and all needed drivers are built in.
