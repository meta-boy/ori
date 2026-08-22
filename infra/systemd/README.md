# ori serve — systemd units

`ori-serve.service` runs the control plane (`ori serve`) on the Proxmox host
(or any long-lived host that can reach it) with:

- **`Restart=always` + `RestartSec=5`** — a crash restarts the server; the
  restart policy is the guard against a dead `ori new` for the whole fleet.
- **Reconciliation on startup** — the loop is *not* just a 30 s tick. While
  the server is down the provider state drifts (pool members stop, orphans
  appear, snapshots are pruned), so the server runs reconciliation once at
  startup, before serving, then every 30 s. See `docs/ARCHITECTURE.md`
  ("State, not statelessness") for the invariants this enforces.
- A dedicated `ori` user + `EnvironmentFile=/etc/ori/serve.env` for the
  Proxmox token and api keys. The environment file is root-only
  (`chmod 600 /etc/ori/serve.env`) — it must never be world-readable or land
  in a config-management template that logs values.

## Install

```bash
sudo useradd --system --home /var/lib/ori --create-home ori
sudo install -d -o ori -g ori /var/lib/ori
sudo install -m 0644 infra/systemd/ori-serve.service /etc/systemd/system/
# secrets + provider config
sudo install -d /etc/ori
sudo install -m 600 /dev/null /etc/ori/serve.env      # fill in, root only
sudo install -m 600 /etc/ori/serve.env /etc/ori/serve.env
sudo systemctl daemon-reload
sudo systemctl enable --now ori-serve
sudo systemctl status ori-serve
```

Startup expectation: the reconcile pass on boot takes a few seconds (it only
touches state that drifted), then the service reaches `active`. If the host
was clean, `ori serve` comes up fast — the heavy lifting (preflight, golden
image, warm pool) is done by `scripts/preflight.sh` and
`scripts/golden-build.sh` *before* the service is trusted to serve.