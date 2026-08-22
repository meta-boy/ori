# C8 — conformance + latency harness

**You own:** `tests/conformance/**`, `scripts/conformance.sh`.

## Purpose

Two failure modes this catches that unit tests structurally cannot:

1. **Client and server agreeing while both are wrong.** `ori-cli` and
   `ori-server` share DTO definitions from `ori-proto`, so a misnamed field
   round-trips happily through both. The harness asserts the observed JSON
   against `docs/SPEC-API.md` **by key name**, treating the spec as the
   authority rather than the code.
2. **Wire compatibility that is far too slow to be usable.** Correct output at
   5× the latency budget is not a working sandbox platform.

## Deliver

`scripts/conformance.sh`:

1. Start `ori serve` on an ephemeral port with a scratch SQLite file and a
   configured provider (Docker locally; Proxmox behind env vars from
   `.env.local`).
2. Mint an API key and drive the CLI against it in a temp `HOME`, so the suite
   cannot touch a developer's real credentials or a production control plane.
   **Assert the resolved api-url is the local instance before running
   anything** — a conformance suite that can reach production is a liability.
3. Exercise the full surface, asserting `--json` shape and exit code:
   `status`, `limits`, `list`, `list --all`, `new`, `info`, `exec`, `stop`,
   `resume`, `fork`, `snapshot`, `snapshots`, `env list`, `api-key list`,
   `extend`, `delete`, `operation`.
4. Diff observed field names against `docs/SPEC-API.md`, failing on a **missing
   or extra key**, not merely on a parse error.
5. Assert the NDJSON streams are flushed per line — record inter-line arrival
   times and fail if every line lands in one burst at the end.
6. Verify state-machine rejections: `resume` on a running sandbox is 409,
   `stop` on a stopped one is idempotent.
7. **Snapshot fidelity**, which is the whole product promise: write a marker
   file, `stop`, `resume`, assert the marker survived; `fork`, assert the marker
   is present in the child; write to the child, assert the parent is
   **unaffected**.
8. Tear down everything it created, including on failure (`trap`). A leaked
   container costs real money on a real backend.

Then a **latency table**: each operation's wall time against the budgets in
`docs/BENCHMARKS.md`, printed as a table, failing the run if `new` or `exec`
regresses past budget.

## Done means

`scripts/conformance.sh` exits 0 against a Docker-backed `ori serve`, prints
the latency table, and leaves nothing behind. Record any command that cannot
pass, and why, in `docs/DIVERGENCES.md` — an honest gap list is the deliverable
here, not a green tick hiding three unimplemented commands.
