# C5 — warm pool manager (inside `ori-server`)

**You own:** `crates/ori-server/src/pool/**` and its migration. Coordinate with
C3 rather than editing its handlers; expose a `PoolManager` API it calls.

Read: `docs/BENCHMARKS.md` — this card exists because of those numbers.

## Why this is not an optimization

Cold create on Proxmox is **6.4 s**. Claiming a pre-started container is
**0.89 s**. the target's create-to-ready is **0.76 s**. There is no way to boot a
machine in under a second, so the pool *is* how the target gets hit. Build it
with the server, not after it.

## Deliver

1. **Pool keyed by `(provider, machine_type, environment_version)`.** Each key
   holds N pre-created, **already started** instances, linked-cloned (`full=0`)
   from a golden snapshot for that key.

2. **Atomic claim.** Single statement:
   ```sql
   UPDATE pool_slots SET claimed_by = ?, claimed_at = ?
   WHERE id = (SELECT id FROM pool_slots
               WHERE pool_key = ? AND claimed_by IS NULL
               ORDER BY created_at LIMIT 1)
   RETURNING id, instance_handle;
   ```
   Two concurrent `ori new` calls receiving the same container is the worst
   failure this system can produce — one tenant's secrets inside another
   tenant's sandbox. It must be impossible at the database level, not merely
   unlikely under the application's locking. Write the concurrency test that
   fires 50 simultaneous claims against a pool of 10 and asserts exactly 10
   distinct winners and 40 clean misses.

3. **Claim path** = claim slot → inject env/secret files/repos → set hostname →
   register sandbox row → emit `ready`. Budget ≤1.5 s; the injection is the only
   real work (measured 0.89 s).

4. **Background refill**, rate-limited, never on a request path. Refill uses
   linked clone + start (1.7 s + ~4 s). Cap concurrent refills — 8 parallel
   clones on this 8-core host is already contention.

5. **Pool miss** → cold path, and say so in the NDJSON stream (`cloning` state)
   rather than silently taking 7 s and looking broken.

6. **Never recycle between tenants.** A released instance is destroyed, not
   returned to the pool. Scrubbing a used container well enough to hand to a
   different tenant is not a thing to be clever about; destroy it and refill.

7. **Golden snapshot lifecycle.** Rebuilt when the environment version changes.
   Pool members for a superseded version are drained, not reused. Rebuild is a
   background job with a lock so two servers cannot rebuild concurrently.

8. **Drain on shutdown** and reconcile on startup: slots in the DB whose
   container the provider no longer has are dropped, not handed out.

## Done means

- The 50-claims-against-10-slots concurrency test passes deterministically.
- A test that a released slot is destroyed rather than re-pooled.
- A benchmark test asserting claim latency stays under the `docs/BENCHMARKS.md`
  budget against a `MockProvider` with injected latency.
