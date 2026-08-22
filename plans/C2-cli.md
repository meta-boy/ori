# C2 — `ori-cli`: the client

**You own:** `crates/ori-cli/**`. Nothing else.

Read: **`docs/SPEC-CLI.md`** — that is the literal `--help` output of
every command and subcommand, and it is your specification. Match it.

`clap` derive. Binary role: bare `ori <subcommand>`.

## Deliver

1. **Every command, subcommand, flag, and argument in
   `docs/SPEC-CLI.md`**, with the same short flags, the same defaults,
   the same value names, and help text that says the same thing. Global flags
   `--api-url` (env `ORI_API_URL`), `--json`, `--no-update` on every subcommand.

2. **Two renderers per command.** Human-readable tables/summaries, and `--json`
   emitting the wire shapes from `docs/SPEC-API.md`. `--json` must auto-enable
   when stdout is not a TTY — a piped `ori list` emitting a decorated table
   breaks every script that consumes it.

3. **NDJSON progress rendering** for `new` / `resume` / `fork`: consume the
   event stream and render progress as it arrives. Under `--json`, pass the
   lines through verbatim.

4. **Exit codes that mean something.** `exec` and `ssh` exit with the *remote*
   command's code. Distinguish: 0 success, 1 local/usage error, 2 API error,
   and the remote code for exec/ssh. A script doing `ori exec sandbox true || handle`
   must be able to tell a failed command from a failed API call.

5. **`ssh` / `scp` / `forward`** — manage an ed25519 key at
   `~/.ssh/<app>_ed25519`, create it 0600 if absent, and tunnel through the
   control plane. `scp` parses `<sandbox-id>:<path>`.

6. **Config** at the OS-appropriate path (`~/.config/<app>/config.json` on
   Linux, `~/Library/Application Support/...` on macOS — use `directories`),
   **mode 0600**, holding the token, api url, and channel. `status` prints the
   resolved path.

7. **`completions`** for bash/zsh/fish/powershell, including dynamic sandbox-id
   completion with a short cache (the real one caches ~15 s) so completing does
   not hammer the API.

8. **`ori delete` confirmation.** Destructive, interactive confirm, `--yes` to
   skip. Do not skip the prompt when stdout is piped — skip it only for `--yes`.

9. **Cross-platform.** macOS + Linux, arm64 + x64. No unix-only syscalls outside
   `#[cfg(unix)]`. Windows may be a stub that errors cleanly.

## Done means

- `cargo test -p ori-cli` covering: arg parsing for every subcommand (assert the
  parsed struct, which catches a renamed flag), exit-code mapping, `--json`
  auto-enable when piped, config file created 0600.
- A snapshot test comparing `ori <cmd> --help` against the corresponding block of
  `docs/SPEC-CLI.md` for drift.
