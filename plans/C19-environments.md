# C19 — environments: the subsystem that makes this multi-user

**Owns the seam:** what a sandbox gets injected into it, defined by a user.

This is the largest single gap. `crates/ori-agent/src/inject.rs` can already
place env vars, secret files and repo checkouts into a sandbox — and **nothing
can define what to place**. The agent has a consumer with no producer.

## The model

A named environment is a bundle of: git repos (with branch), environment
variables, secret files, and safety toggles. Every mutation **mints a new
version**. Running sandboxes stay pinned to the version they started with until
`env upgrade` moves them.

That versioning is the whole point and the part most likely to be cut: it is what
makes changing a secret safe while thirty sandboxes are live.

## Commands

`list`, `info <name>`, `new <name>`, `rename`, `default <name>`, `rm <name>`,
`set` (toggles), `set-var`, `rm-var`, `set-file`, `rm-file`, `add-repo`,
`rm-repo`, `upgrade <name>`.

Tables exist already: `environments`, `environment_versions`, `environment_vars`,
`environment_files`.

## Rules that are not optional

- **Secrets never appear in a log line, at any level, including `debug`.** Not
  the value, not a prefix. This is the one irreversible mistake in this card.
- **Secret files land 0600, owned by the sandbox user, and never pass through a
  world-readable temp path.** The agent already does this — do not undo it by
  staging content somewhere readable on the way.
- A version, once minted, is **immutable**. Mutation creates a new row; it never
  edits an existing one. Editing history is how a sandbox silently changes
  underneath its own pinned version.
- `--no-env` is **one-way**: a sandbox created with it gets nothing from the
  account, stays that way across resume and fork, and inherited secrets are
  scrubbed. Verify the scrub rather than assuming it.
- `env upgrade` pushes to live sandboxes and must **withhold secrets from a
  sandbox whose environment removed them** — the removal is the point of the
  upgrade.

## Done means

Driven through the real CLI: create an environment, set a var and a secret file,
add a repo, launch a sandbox, verify the injection landed with correct
permissions, mint a new version, confirm the running sandbox is **unchanged**,
then `upgrade` and confirm it changed. Plus a test that no secret value appears
anywhere in captured log output.
