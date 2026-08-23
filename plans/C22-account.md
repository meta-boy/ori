# C22 — account surface: webhooks, teams, retention, dashboard, self-update

**Owns:** the remaining account-level commands. All currently stubs.

## `ori webhook {create,list,rotate,remove}`

Account-wide lifecycle notifications for `ready | error | archived`.

- **HMAC-sign every delivery** with a per-webhook secret, and put the signature
  in a header along with a timestamp so a receiver can reject replays. An
  unsigned webhook is an unauthenticated POST that anyone who learns the URL can
  forge.
- Signing secret is shown **once** at creation, like an API key.
- Retry with backoff, and **cap it**. A dead endpoint must not accumulate
  unbounded pending deliveries; drop after N attempts and record that it was
  dropped rather than retrying forever.
- Deliveries happen off the request path — a slow receiver must never slow a
  sandbox `ready`.

## `ori team {list,switch}`

Billing scope. The `team` field is already modelled on the sandbox. Sticky:
`switch` applies to every subsequent `new`. `--personal` overrides for one
command. Return a single personal scope if there is no team backend yet, rather
than erroring.

## `ori data-retention {status,enable}`

Delete-on-stop: when enabled, sandbox data is destroyed after each stop rather
than snapshotted. **Irreversible and destructive** — require explicit
confirmation, and make `status` state plainly what is currently true. Note the
interaction the user will hit: with retention enabled, `resume` and `fork` have
nothing to restore from, so say so at enable time rather than letting them
discover it on the next resume.

## `ori dashboard` and `ori self-update`

`dashboard` opens the control plane's URL in a browser — trivial, but do not
hardcode a domain; derive it from the configured api-url.

`self-update` checks `GET /cli/version` and installs. `install.sh` and
`latest.json` already implement the contract (checksum verified before writing,
refuses downgrades, refuses channel jumps) — reuse it rather than writing a
second updater. Never cross a channel boundary silently.

## Done means

Each command driven through the real CLI. For webhooks specifically: stand up a
local receiver, confirm the signature verifies, then confirm a dead endpoint's
deliveries stop being retried instead of growing without bound.
