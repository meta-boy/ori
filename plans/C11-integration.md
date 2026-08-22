# C11 — integration: make the workspace one program

**You own:** cross-crate reconciliation. You may edit any crate, but only to
make the pieces fit — not to rewrite another agent's design.

This card exists because C1–C10 were written **in parallel against a spec, not
against each other**. Three predictable classes of breakage:

1. **`TODO(reconcile)` markers.** Agents were told to define a type locally if
   `ori-proto` did not have it yet. Every one of those is now a duplicate
   definition that must collapse into the `ori-proto` original.
2. **Trait drift.** `ori-providers` coded `Provider` against
   `docs/ARCHITECTURE.md`; `ori-proto` is the real definition. Signatures will
   disagree — argument order, `&self` vs `self`, owned vs borrowed, error types.
3. **Duplicated constants.** Machine-type vCPU/RAM/multiplier numbers, state
   strings, and ID prefixes may be restated in several crates. `ori-proto` is
   the single source of truth; delete the copies rather than aligning them.

## Deliver

1. `grep -rn "TODO(reconcile)"` — resolve every one. The fix is almost always
   *delete the local copy and import from `ori-proto`*, not *make the two
   definitions match*.
2. `cargo build --workspace` clean, then `cargo test --workspace` green.
3. `cargo clippy --workspace -- -D warnings` clean. Five crates written by
   different agents will have drifted in error handling and idiom, and this is
   the only thing that holds the line.
4. `cargo fmt --all`.
5. Wire the three binary roles into one `ori` entrypoint: bare subcommands
   route to the client, `serve` to the control plane, `agent` to the guest
   agent (Linux-gated). Verify `ori --help`, `ori serve --help`,
   `ori agent --help` all work from the single binary.
6. Confirm no crate depends on something it should not: `ori-agent` must not
   pull in `ori-providers` (no Proxmox HTTP client inside the guest binary),
   and `ori-proto` must stay I/O-free. Check with `cargo tree`.

## Judgement to apply, not just mechanical fixes

You are the first agent to see the whole system. Where the seams are ugly, say
so plainly in `docs/DIVERGENCES.md`:

- an abstraction that only has one real implementation and is pure indirection
- a `Capabilities` flag nothing actually reads
- error types that get stringified at a boundary and lose their structure
- a layer that exists because the spec implied it, not because the code needs it

Prefer deleting a moving piece over rearranging it. If two crates would be
simpler as one, or a trait method is never called, propose the removal rather
than preserving it out of deference to the spec. The spec was written before
the code existed; the code is now the better source of truth about its own
structure.

## Done means

`cargo build --workspace && cargo test --workspace && cargo clippy --workspace
-- -D warnings` all clean, `ori --help` / `ori serve --help` / `ori agent
--help` work, and `docs/DIVERGENCES.md` lists every gap and every simplification
you would recommend but did not make.
