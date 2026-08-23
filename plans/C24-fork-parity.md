# C24 — `fork` a sandbox that has never been stopped

**Owns the seam:** `ori fork` works on any sandbox a user can point at.

## The gap

`fork` clones the newest **stopped-taken** snapshot, which is correct — a
running-taken snapshot costs ~45 s to clone from, permanently
(`docs/BENCHMARKS.md`). But a sandbox that has never been stopped has no such
snapshot, so fork **refuses**:

```
cannot fork a running sandbox that has no stopped snapshot
```

Measured: refuses in 1.64 s. Honest, and unusable — because *create, work, fork*
is the common path, and it is exactly the case that fails. The reference product
forks a running machine in ~5 s.

## The fix

When a running source has no stopped-taken snapshot: **stop it, snapshot, clone,
then restart the source.** Roughly 10 s, with a few seconds of source downtime.

- The source's downtime is real and must be **announced in the event stream**
  before it happens, not discovered. A user whose shell drops mid-fork with no
  warning will read it as a crash.
- Restart the source even if the clone fails. A failed fork must not leave the
  user's sandbox powered off.
- Offer `--no-stop` to refuse instead, for anyone who cannot take the downtime —
  keeping today's behaviour available rather than removing a choice.

## Done means

Against the real host: fork a sandbox created seconds earlier and never stopped —
completes in well under 15 s, child inherits the data, and the **source is
running again afterwards** with its data intact. Then kill the clone mid-flight
and confirm the source still comes back up. Record both in
`docs/BENCHMARKS.md`, replacing the "refuses" row.
