.PHONY: verify test spec fmt lint ledger dashboard dev debug stop preflight lint-infra e2e-local e2e-survival e2e-firecracker e2e-fc-bench e2e-ssh cli sdk e2e-sdk check-all

verify: typecheck lint ledger dashboard test

# The dashboard is a Vite build now (React + Tailwind + shadcn), so it has to be built before
# the control plane can serve it. Cheap (~1s) and it keeps `make verify` honest: the serving
# tests assert against real built output rather than hardcoded filenames.
dashboard:
	@bun run --cwd packages/dashboard build > /dev/null && echo "dashboard built"

# Validates infra/ with the real parsers: caddy validate + fmt, shellcheck,
# systemd-analyze verify. NOT part of `verify` because none of those tools exist on
# macOS -- a check that skips silently on the dev machine reports success while
# validating nothing, which is how a Caddyfile that could not even adapt stayed
# committed for hours. Run this on Linux (or in CI) before trusting infra/.
lint-infra:
	bash scripts/validate-infra.sh

# The loop protocol in plans/LOOP.md picks "the FIRST task with status TODO", so a
# duplicated row or a stale next: pointer sends an agent into an infinite re-do.
# Both have already happened once. This gate makes the ledger fail loudly instead.
ledger:
	node scripts/check-state.mjs plans/STATE.md

# Fast, shared-DB run. Bun runs test FILES in parallel against one Postgres and several
# files write fleet-wide state (starts_log drives the 600/h + 1500/day ceilings; the
# reaper scans every ori), so this drifts by a few tests. Fine for a tight edit loop;
# do NOT trust its number. `make verify` uses the isolated runner instead.
test-fast:
	bun test test/api test/contract packages/*

# One process and one database per test file. Deterministic: 304 pass, 0 fail.
test:
	bash scripts/test-isolated.sh

typecheck:
	bunx tsc --noEmit

lint:
	bunx tsc --noEmit

# Placeholder: regeneration/drift-check for the OpenAPI contract.
spec:
	bun test test/contract

# Real end-to-end against the Docker driver: a container boots systemd, the guest agent
# comes up inside it, and bytes written through the public API are verified on the
# container's own disk. NOT part of `verify` — needs Docker and takes ~a minute. Skips
# with a message (exit 0) when Docker or ori-base:latest is missing.
e2e-local:
	bun test/e2e/local.ts

# Does a ori's disk really survive? Destroys a container and rebuilds it from restic in
# object storage, then checks ori's four documented claims (files, packages, enabled units
# survive; hand-run processes do not) and that a fork is independent of its parent. Needs
# Docker + ori-base:latest + postgres + minio; skips with a message otherwise.
e2e-survival:
	bun test/e2e/survival.ts

# Real Firecracker microVM: kernel + nano rootfs boot under KVM, the guest agent comes up
# on :7777, and destroy tears the machine dir down. Needs Linux with /dev/kvm, `firecracker`
# on PATH, and ORI_FC_KERNEL / ORI_FC_ROOTFS set (plus ORI_FC_AGENT_BINARY, the guest-agent
# binary the driver seeds); skips with a message (exit 0) otherwise, so it stays green on
# hosts without KVM.
e2e-firecracker:
	bun test/e2e/firecracker.ts

# Real Firecracker snapshot-resume benchmark: boots a nano microVM under KVM, snapshots and
# resumes it three times, and reports BOOT_MS / SNAPSHOT_MS / mem bytes / RESUME_MS (median)
# against ORI_FC_RESUME_BUDGET_MS (default 1000). Same host requirements and skip behaviour
# as e2e-firecracker; FAILs (exit 1) when the median resume exceeds the budget.
e2e-fc-bench:
	bun test/e2e/fc-resume-bench.ts

# Can you actually ssh into a ori? Authorises a real generated key and performs a real
# login, because "the file landed with mode 0600" has been true before while sshd still
# refused it. Also checks an unauthorised key and password auth are both refused.
e2e-ssh:
	bun test/e2e/ssh.ts

# Compile the CLI to a single self-contained binary (no bun/node needed to run it), the way
# a CLI should be distributed. `make cli` builds for this machine; --all does all four platforms.
cli:
	bash scripts/build-cli.sh

# Regenerate the SDK types from the spec. The client is generated on purpose: if the OpenAPI
# document is not faithful enough to generate from, the compatibility claim is not real.
sdk:
	bunx openapi-typescript openapi/ori-v1.yaml -o packages/sdk-ts/src/schema.d.ts

# Does a client GENERATED from the spec work against this server? The contract harness proves
# responses validate; it does not prove the spec can be generated FROM. Different failures.
e2e-sdk:
	bun test/e2e/sdk.ts

# Everything, in dependency order, so a single command answers "does this actually work?".
# Not the default target: it needs Docker, postgres, minio and restic, and takes a few minutes.
check-all: verify cli
	@echo "\n=== e2e-local ==="      && $(MAKE) --no-print-directory e2e-local
	@echo "\n=== e2e-ssh ==="        && $(MAKE) --no-print-directory e2e-ssh
	@echo "\n=== e2e-sdk ==="        && $(MAKE) --no-print-directory e2e-sdk
	@echo "\n=== e2e-survival ==="   && $(MAKE) --no-print-directory e2e-survival
	@echo "\n=== lint-infra (skips off-Linux) ===" && $(MAKE) --no-print-directory lint-infra
	@echo "\nall checks done"

# P12. Needs a Linux host with /dev/kvm and an Incus install; there is nothing to run yet.
e2e-host:
	@echo "e2e-host: not implemented (needs an Incus host)"

# ---------------------------------------------------------------------------
# Running the control plane
# ---------------------------------------------------------------------------
# `dev` for normal work, `debug` when you need a breakpoint. Both preflight the things whose
# absence produces a confusing failure rather than a clear one:
#   - postgres/minio down  -> every request 500s on a connection error
#   - no .env              -> ORI_SNAPSHOT_SECRET is unset and snapshots throw at use, not boot
#   - no base image        -> sandboxes fail to create, which reads as a driver bug
#   - dashboard not built  -> /dashboard 503s
# Checking takes a second. Debugging any of them from the symptom takes much longer.
.PHONY: dev debug stop preflight

ORI_PORT ?= 8787
INSPECT_PORT ?= 6499

preflight:
	@printf 'checking dependencies\n'
	@docker compose ps --status running --format '{{.Service}}' 2>/dev/null | grep -q postgres \
		|| { printf '  postgres is not running -> run: docker compose up -d\n'; exit 1; }
	@docker compose ps --status running --format '{{.Service}}' 2>/dev/null | grep -q minio \
		|| { printf '  minio is not running -> run: docker compose up -d\n'; exit 1; }
	@test -f .env || { printf '  no .env -> run: cp .env.example .env\n'; exit 1; }
	@docker image inspect ori-base:latest >/dev/null 2>&1 \
		|| printf '  WARNING ori-base:latest is missing; creating a sandbox will fail -> image/build-docker.sh\n'
	@test -f packages/dashboard/dist/index.html \
		|| printf '  WARNING dashboard not built; /dashboard will 503 -> make dashboard\n'
	@printf '  ok\n'

# Stop whatever is already listening, so `make dev` twice does not fail on EADDRINUSE with a
# message that blames the port rather than the previous run.
stop:
	@pkill -f 'bun (--hot |--inspect[^ ]* )*packages/api/src/index.ts' 2>/dev/null || true
	@sleep 1
	@lsof -nP -iTCP:$(ORI_PORT) -sTCP:LISTEN >/dev/null 2>&1 \
		&& printf 'port $(ORI_PORT) still busy: %s\n' "$$(lsof -nP -iTCP:$(ORI_PORT) -sTCP:LISTEN | tail -1)" \
		|| printf 'stopped\n'

# Hot reload. Edits to the API are picked up without a restart -- EXCEPT the reaper's interval,
# which is started once at boot, so a change to reaper.ts needs a real restart to take effect.
dev: preflight stop
	@printf '\ncontrol plane  http://localhost:$(ORI_PORT)/api/ori/v1\n'
	@printf 'dashboard      http://localhost:$(ORI_PORT)/dashboard\n\n'
	PORT=$(ORI_PORT) bun --hot packages/api/src/index.ts

# Debug mode: the same, plus Bun's inspector.
#
# --inspect, not --inspect-brk: breaking before the first line means the server never binds and
# every health check fails while you are still attaching. Set a breakpoint and reload instead.
# Use `make debug BRK=1` when you genuinely need to catch something during module evaluation.
debug: preflight stop
	@printf '\ncontrol plane  http://localhost:$(ORI_PORT)/api/ori/v1\n'
	@printf 'dashboard      http://localhost:$(ORI_PORT)/dashboard\n'
	@printf 'inspector      the ws:// URL Bun prints below -- open it in Chrome DevTools\n'
	@printf '               (chrome://inspect, or paste the devtools:// link)\n\n'
	PORT=$(ORI_PORT) ORI_LOG_LEVEL=debug bun $(if $(BRK),--inspect-brk,--inspect)=$(INSPECT_PORT) --hot packages/api/src/index.ts
