# Deploying to a remote host, reachable through a tunnel

Everything here was verified on an Ubuntu 24.04 x86_64 host (32 cores, 30 GB RAM, Docker 29.6.2,
compose v5.3.1). The two "on Linux" notes are things that work on a Mac and silently break on
Linux, so they are called out rather than buried.

## Why a tunnel is safe here

Every path the control plane serves requires a credential:

| path | credential |
|---|---|
| `/api/ori/v1/*` | `Authorization: Bearer ori_live_…`, checked against a stored sha256 |
| `/internal/oris/:id/*` | a per-ori machine token, derived from the server secret and therefore unguessable |
| `/desktop/*` | a signed, ori-bound, short-lived token, or the cookie it sets |

The plan's unauthenticated `/internal/edge/ask` and `/internal/edge/validate` endpoints are for
the Caddy on-demand-TLS path and **are not implemented**, so there is nothing open to expose. If
you ever build them, they must bind to localhost only — they drive certificate issuance.

## Prerequisites

```bash
# user-local, no sudo, nothing system-wide
curl -fsSL https://bun.sh/install | bash
mkdir -p ~/.local/bin
curl -fsSL -o /tmp/r.bz2 https://github.com/restic/restic/releases/download/v0.17.3/restic_0.17.3_linux_amd64.bz2
bunzip2 -f /tmp/r.bz2 && mv /tmp/restic ~/.local/bin/ && chmod +x ~/.local/bin/restic
curl -fsSL -o ~/.local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x ~/.local/bin/cloudflared
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"   # put this in ~/.bashrc
```

Docker must work **without** sudo, because the driver shells out to it:

```bash
sudo usermod -aG docker "$USER"    # then open a new session
docker ps                          # must succeed
```

`restic` has to be on the control plane's `PATH` — it is invoked as a subprocess for every
snapshot and restore.

## 1. Configuration

```bash
cd ~/ori
cp .env.example .env
```

Then edit `.env`. Three values matter for a real deployment:

**`ORI_SNAPSHOT_SECRET`** — generate a strong one and **back it up somewhere other than this
host**:

```bash
openssl rand -hex 32
```

Read `docs/OPERATIONS.md` before you shrug at this. It derives every snapshot repository's
password *and*, since the token change, every ori's machine and agent tokens. Lose it and every
snapshot in the system is permanently unreadable — a bucket backup without it is ciphertext you
cannot open. Change it and every running ori becomes unreachable and every snapshot orphaned.

**`S3_ENDPOINT_FOR_ORI`** — **on Linux this is not `host.docker.internal`.** That name only
exists on Docker Desktop. The value depends on which driver you run, and getting it wrong makes
everything look healthy until the first snapshot fails.

**Firecracker driver:** point it at the FC bridge gateway (`ORI_FC_SUBNET`'s `.1`, e.g.
`172.30.0.1`), which is the guest's default route:

```
S3_ENDPOINT_FOR_ORI=http://172.30.0.1:9000
```

Do **not** use the docker bridge gateway (`172.17.0.1`) here. `172.17.0.0/16` is docker's own
default subnet, so the moment a box runs `docker run` it creates its own `docker0` at
`172.17.0.1` — and restic inside the guest then dials the box's own docker0 instead of the host
MinIO, so every snapshot fails on a box that used Docker. Since "Docker just works inside" is
the whole point, this collision is not theoretical. The FC bridge gateway avoids it because
nothing in a default docker setup lives on `172.30.0.0/16`. MinIO must publish on `0.0.0.0:9000`
(the compose file does) so the host answers on its FC-bridge address.

**Docker driver:** the ori containers sit on the docker bridge, so the bridge gateway is correct
for them:

```bash
docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'   # e.g. 172.17.0.1
```

```
S3_ENDPOINT_FOR_ORI=http://172.17.0.1:9000
```

`S3_ENDPOINT` stays `http://localhost:9000` on either driver — that one is the control plane's
own view.

**`ORI_PUBLIC_URL`** — the public origin, once you know it:

```
ORI_PUBLIC_URL=https://oris.example.com
```

The desktop URL is built from this. Leave it unset behind a tunnel and every desktop link points
at `localhost:8787` and does nothing from your laptop. It is deliberately not inferred from a
request header — a `Host` header is attacker-controlled, and this value ends up in a URL carrying
a credential.

Setting it to an `https://` origin also matters for the desktop cookie: the cookie that carries
the token to noVNC's assets is marked `Secure` only when the origin is https, which is exactly
what you want through a tunnel.

## 2. Bring up the dependencies

```bash
docker compose up -d                       # postgres + minio + the bucket init
bun run packages/api/scripts/migrate.ts
```

## 3. Build the base image

```bash
image/build-docker.sh                      # ~10 minutes, once per host
```

The image is built locally and never pushed, so it has to be built on every host that runs oris.

On x86_64 this gets **real `google-chrome-stable`**. The arm64 build cannot: Chrome ships no
arm64 Linux package, so an arm64 host falls back to snap-backed chromium, which will not launch
on a fresh ori. If the desktop matters, run oris on x86_64.

## 4. Build the dashboard

```bash
bun run --cwd packages/dashboard build
```

The dashboard is a Vite + React + Tailwind + shadcn build now, so this is a real step and the
output is gitignored. Skip it and `/dashboard` returns `503 dashboard not built` rather than a
confusing wall of 404s. `make verify` builds it too, so a local check covers it.

## 5. A key, and the server

```bash
bun scripts/create-key.ts --name laptop     # prints the secret ONCE
bun packages/api/src/index.ts               # or run it under systemd, see infra/
```

## 6. The tunnel

A quick tunnel needs no account and gives an ephemeral `*.trycloudflare.com` name — good for
checking it works:

```bash
cloudflared tunnel --url http://localhost:8787
```

A named tunnel on your own domain survives restarts, and is what you want for real. It needs an
interactive login:

```bash
cloudflared tunnel login
cloudflared tunnel create ori
cloudflared tunnel route dns ori oris.example.com
cloudflared tunnel run --url http://localhost:8787 ori
```

Then set `ORI_PUBLIC_URL=https://oris.example.com` and **restart the control plane** — it reads
that value at startup.

## 7. From your laptop

```bash
ori login <key> --api-url https://oris.example.com
ori status
ori new --type small
```

`--api-url` is persisted in `~/.config/ori/config.json`, so later commands need only `ori`.

## Sizing on a shared host

A `default` ori asks for 8 GB and a `large` for 16 GB. On a host with ~13 GB free and other
workloads running, `--type small` (2 vCPU / 4 GB) is the honest choice; `default` will fit once
and then fail. `ori list` shows what is active, and the reaper auto-stops oris at their TTL.

## What is NOT covered

Public per-ori port hosting (`*.on.<domain>`) needs a routed IPv4 block and the Caddy edge in
`infra/`, which is written and lint-clean but has never been deployed. A tunnel gives you the
control plane and the desktop; it does not give each ori its own public hostname.
