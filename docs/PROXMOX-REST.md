# Proxmox REST API — verified recipe

Every call below was executed against the project's real host and the timings
are measured, not estimated. Credentials come from `.env.local` (untracked).

Base: `https://<host>:8006/api2/json`
Auth header: `Authorization: PVEAPIToken=<user>@<realm>!<tokenid>=<secret>`

Self-signed certificates are normal on Proxmox. Accept a configured CA, or an
explicit `insecure_skip_verify` that defaults to **off** and logs loudly when on.

## The UPID contract — read this first

Every mutating call returns a **UPID string** as `data`, not a completed
operation. HTTP 200 means *queued*:

```
UPID:<node>:<pid-hex>:<pstart-hex>:<starttime-hex>:<type>:<vmid>:<user>:
```

Poll `GET /nodes/{node}/tasks/{upid}/status` until `status == "stopped"`, then
check `exitstatus == "OK"`. Anything else is a failure, and a non-OK exitstatus
with HTTP 200 is the shape a bug will take here.

The UPID goes into the task path as-is. It contains `:`, `@` and `!`, all of
which are legal in a path segment — **verified: both raw and percent-encoded
forms return HTTP 200**, so no encoding is required (an earlier note here
claimed otherwise and was wrong).

Observed poll sequence on create: `running/None` → `running/None` → `stopped/OK`.

## Verified sequence and timings

| Step | Call | Measured |
|---|---|---|
| next free id | `GET /cluster/nextid` | — |
| create | `POST /nodes/{n}/lxc` | **2.66 s** incl. UPID poll |
| start | `POST /nodes/{n}/lxc/{vmid}/status/start` | **3.58 s** incl. UPID poll |
| status | `GET /nodes/{n}/lxc/{vmid}/status/current` | returns `status`, `name`, `cpus`, `maxmem` |
| addresses | `GET /nodes/{n}/lxc/{vmid}/interfaces` | see the trap below |
| snapshot | `POST /nodes/{n}/lxc/{vmid}/snapshot` (`snapname=`) | UPID |
| linked clone | `POST /nodes/{n}/lxc/{vmid}/clone` (`full=0`, `snapname=`) | ~1.7 s |
| stop | `POST /nodes/{n}/lxc/{vmid}/status/stop` | UPID |
| destroy | `DELETE /nodes/{n}/lxc/{vmid}?force=1&purge=1` | UPID |

`purge=1` on destroy also removes the VM from backup and HA configuration.
Without it you leak references that break later operations on a reused vmid.

Create parameters that worked (form-encoded, not JSON):

```
vmid, ostemplate=local:vztmpl/<template>, hostname, storage=local-lvm,
rootfs=local-lvm:8, cores, memory, net0=name=eth0,bridge=vmbr0,ip=dhcp,
unprivileged=1, ostype=alpine, features=nesting=1
```

## Trap: `/interfaces` returns loopback

The first entry in the response is the loopback interface:

```json
{"data":[{"hwaddr":"00:00:00:00:00:00","inet":"127.0.0.1/8","inet6":"::1/128", ...}]}
```

A "wait until an `inet` address appears" check therefore succeeds **immediately**
and hands back `127.0.0.1` as the sandbox address. Address discovery must:

- filter to the expected interface name (`eth0`), and
- reject loopback and link-local ranges, and
- poll with a deadline, because the DHCP lease takes ~0.85 s after start and the
  interface may report no usable address before that.

Getting this wrong produces a sandbox that looks ready and is unreachable.

## Other notes

- `GET /cluster/nextid` is advisory only. Two concurrent creates can both be
  handed the same id, so allocate from our own store with a uniqueness
  constraint and treat this endpoint as a cross-check.
- Storage must be snapshot-capable. `local-lvm` here is LVM-thin and supports
  both snapshots and `full=0` linked clones; a `dir` storage supports neither.
  Verify at startup, not on the first fork.
- `pct suspend` (CRIU) fails on this kernel — see `docs/BENCHMARKS.md`. There is
  no live-suspend path to implement.
