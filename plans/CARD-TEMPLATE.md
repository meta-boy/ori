#### T-P3-04 — Stop and archive a ori
deps  T-P3-03
files packages/api/src/routes/oris.ts, packages/api/src/lifecycle/stop.ts, test/api/stop.test.ts
contract
  POST /oris/{oriId}/stop  body {force?: boolean}
  200 {ok:true, type:"ori.stopping", id:"or_…", status:"archiving", ori:Ori}
  409 resume_failed if state not in RUNNABLE|running
steps
  1. …
  2. …
verify bun test test/api/stop.test.ts
done
  - state transitions running|ready|idle -> archiving -> archived
  - final snapshot requested before destroy; destroy skipped if it fails
  - usage ledger closed at archive time