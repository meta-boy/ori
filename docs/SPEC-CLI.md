# `ori` CLI specification

One binary, three roles:

```
ori <command>     client        (macOS + Linux, arm64 + x64)
ori serve         control plane (the self-hosted backend)
ori agent         guest agent   (inside each sandbox; Linux only)
```

Global flags on every subcommand: `--api-url <URL>` (env `ORI_API_URL`),
`--json`, `--no-update`.

`--json` **auto-enables when stdout is not a TTY.** A piped `ori list` that
emits a decorated table breaks every script consuming it.

## Lifecycle

| Command | Purpose | Flags |
|---|---|---|
| `ori new` | create a sandbox | `--type small\|default\|large`, `--ttl <secs>`, `--no-auto-stop`, `-e/--env KEY=VALUE` (repeatable), `--no-env`, `--setup-file <path>`, `--environment <name>`, `--from <snapshot>`, `--team <id>`, `--personal` |
| `ori list` | list sandboxes | `--filter <rspte>` (default `r`), `--all` |
| `ori info <id>` | detail for one | |
| `ori stop <id>` | snapshot, then power off | `--force` (skip snapshot; **loses** everything since the last one) |
| `ori resume <id>` | start a stopped sandbox | `--type`, `--ttl`, `--no-auto-stop`, `-e/--env`, `--no-env`, `--environment` |
| `ori fork <id>` | new sandbox from a snapshot of another | same as resume; TTL defaults to 1 h and is not inherited |
| `ori extend <id>` | change the auto-stop deadline | `--hours <n>`, `--ttl <secs>`, `--no-auto-stop` |
| `ori delete <id>` | permanently delete | `--yes` to skip the confirm |
| `ori operation <id>` | async operation status | |

`<id>` accepts `current`/`self` when run inside a sandbox.

## Access

| Command | Purpose | Flags |
|---|---|---|
| `ori ssh <id> [cmd...]` | interactive shell, or run one command | |
| `ori exec <id> <cmd...>` | run via the API, no SSH | `--cwd <dir>`, `--timeout <1-600>` (default 30), `--detach`, `--status <pid>` |
| `ori scp <src> <dst>` | copy files; `<id>:<path>` for remote | `-r/--recursive` |
| `ori forward <id>` | forward a TCP port to localhost | `--remote <port>` (required), `--local <port>`, `--bind <addr>` (default 127.0.0.1) |
| `ori host <id> <port>` | expose a port on a stable HTTPS URL | `--private` (default), `--public`, `--title <text>` |
| `ori desktop <id>` | open the graphical desktop | `--vnc`, `--public` |

**Exit codes.** `exec` and `ssh` exit with the *remote* command's code.
Otherwise: 0 success, 1 local/usage error, 2 API error. A script running
`ori exec <id> mycmd || handle` must be able to distinguish a failed remote
command from a failed API call.

`ori host` must report when nothing is listening on the port, and say that a
service bound to `127.0.0.1` is unreachable and must bind `0.0.0.0` — the most
common user error with this feature. Returning a URL that 404s is not enough.

## Snapshots

| Command | Purpose |
|---|---|
| `ori snapshots [id]` | list, all sandboxes or one (`--limit`, `--all`) |
| `ori snapshot <id> <name>` | save under a name; reusing a name replaces it |
| `ori snapshot latest <id>` | most recent snapshot |
| `ori snapshot tree <snap-id>` | files and sizes captured |
| `ori snapshot pull <snap-id>` | download and reassemble locally (`-o <dir>`) |
| `ori snapshot delete <snap-id>` | delete one filesystem snapshot (`--yes`) |
| `ori snapshot rm <name>` | remove a named snapshot |

## Environments

`ori env` manages named bundles of repos, variables, secret files and safety
toggles. Any mutation **mints a new version**; running sandboxes stay pinned to
the version they started with until `ori env upgrade`.

`list`, `info <name>`, `new <name>`, `rename <old> <new>`, `default <name>`,
`rm <name>`, `set <name>` (toggles), `set-var`, `rm-var`, `set-file`,
`rm-file`, `add-repo`, `rm-repo`, `upgrade <name>`.

`--no-env` creates a sandbox with none of the account's stored secrets — for
sandboxes handed to third parties. It is **one-way**: the sandbox stays no-env
across resume and fork, and inherited secrets are scrubbed.

## Account

`login [key]` (`--google`, `--email <addr>`), `logout`, `status`,
`api-key {create,list,rotate,revoke}`, `webhook {create,list,rotate,remove}`,
`team {list,switch}`, `data-retention {status,enable}`, `dashboard`,
`self-update`, `completions <bash|zsh|fish|powershell>`.

Secrets (API keys, webhook signing secrets) are shown **once** at creation;
afterwards only a prefix and last four.

`completions` includes dynamic sandbox-id completion with a short cache
(~15 s) so pressing Tab does not hammer the API.

## Client-side files

| Path | Contents | Mode |
|---|---|---|
| `~/.config/ori/config.json` (Linux), `~/Library/Application Support/ori/config.json` (macOS) | token, api url, channel | **0600** |
| `~/.ssh/ori_ed25519` | auto-managed key for `ssh`/`scp`/`forward` | 0600 |

Use the `directories` crate; do not hand-roll platform paths. `ori status`
prints the resolved config path.

## Agent commands (v1: endpoints only)

`ori prompt`, `ori interrupt`, `ori events` drive a coding agent inside a
sandbox. For v1 implement the endpoints and the event-stream shape, and return
a clear "not implemented in this build" error. Do not fabricate agent output.
