---
name: ori-sandboxes
description: Use when work needs a disposable Linux machine rather than this one — running untrusted or destructive commands, reproducing a clean environment, testing an installer, exploring several variants in parallel, or a job that outlives the session — on a system where the `ori` CLI is installed or an ori control plane is reachable.
---

# ori sandboxes

A real Ubuntu machine with its own disk, ssh and Docker, ready in ~20 seconds and thrown away
after. `ori --help` lists every command; this is what to reach for, and the four behaviours
that each cost someone an hour.

Reach for one when the command could damage this host (`rm -rf`, `dd`, a package manager, an
unread `install.sh`), when the code is untrusted, when you need a clean environment to
reproduce something or to prove an installer works from nothing, when you want several
variants of one prepared state, or when the job should outlive your session.

```bash
ori new --type default --ttl 7200 --json   # → {"ok":true,"id":"or_xxxxxxxx","state":"ready"}
ori ssh  or_xxxxxxxx 'make test'           # real work
ori exec or_xxxxxxxx 'cat /etc/os-release' # quick probe
ori stop or_xxxxxxxx                       # snapshot, destroy the container
ori delete or_xxxxxxxx --yes               # and reclaim the storage
```

`--json` on any command gives parseable JSONL. `ori exec` propagates the command's exit code.

## Four behaviours that bite

**`ori exec` is capped at 30s** (`--timeout N`, max 60 — the server's ceiling). Longer work goes
through `ori ssh <id> '<command>'`, which has no cap. A killed exec exits `124`, a signalled one
`128+n`.

**`nproc` and `free` inside a sandbox report the host's numbers.** A `nano` shows 4 CPUs and
14 GB while holding 1 CPU and 512 MB, because the container shares the host's cgroup namespace.
`make -j$(nproc)` there gets OOM-killed. Ask from outside:

```bash
ori info or_xxxxxxxx --json | jq '{vcpu, memoryGB}'   # → {"vcpu":1,"memoryGB":0.5}
```

**TTL defaults to one hour** and then auto-stops, mid-job if the job is slow. Pass
`--ttl <seconds>`, or `--no-auto-stop`.

**`stop` keeps snapshots forever; only `delete` frees the storage.** The asymmetry is deliberate
— a stopped sandbox stays resumable — but an agent that only ever stops leaves the bucket
growing. `delete` refuses while the sandbox runs, so stop first.

## Sizes

`nano` 1 CPU / 0.5 GB · `small` 1 / 1 · `default` 2 / 2 · `large` 4 / 4. `nano` suits shell
work and greps; builds, `npm install` and compilers want `default` or `large` — an undersized
box fails as a `SIGKILL`, not as a clear error.

## Files, forks, and what survives

No `scp` subcommand; pipe through ssh.

```bash
tar c src | ori ssh or_xxxxxxxx 'tar x -C /home/user'
ori ssh or_xxxxxxxx 'cat /home/user/result.json' > result.json
```

A fork copies the parent's latest **snapshot**, not its current disk. Forking a running sandbox
is allowed and silently gives you state up to a minute old, because snapshots run on a 60s
cadence. Stop first — that takes a final snapshot:

```bash
ori ssh base 'apt-get install -y the-toolchain && ./configure'
ori stop base
for v in a b c; do ori fork base --json; done    # three independent copies
```

Across a stop and `resume`, files and *enabled* systemd units come back. Processes started by
hand do not — resume rebuilds the machine. Anything that must survive belongs in a unit.

## Limits

No public port hosting yet: nothing outside reaches a sandbox except through `ori`. Account
secrets are injected as environment variables — `ori resume --no-env` and `ori fork --no-env`
start without them. The fleet caps at 100 active sandboxes and 600 starts an hour, so a runaway
loop hits `start_limit_reached` rather than the host's limits.
