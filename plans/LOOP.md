You are implementing ONE task from plans/. Do not improvise.

1. Read plans/STATE.md. Choose the FIRST task with status TODO whose deps are all DONE.
2. Read that task's card in the phase file. Read ONLY the files the card lists under `files`.
3. Implement exactly what the card says. Constraints:
   - Do not create or edit files outside the card's `files` list.
   - Do not add, remove, or upgrade dependencies unless the card says so.
   - Do not edit openapi/ori-v1.yaml or packages/contract/** unless the card id starts with T-P1.
   - Do not weaken, skip, or delete a test to make it pass.
   - No new abstraction, config knob, or interface that the card does not name.
4. Run the card's `verify` command. On failure, fix and rerun. Max 5 attempts.
5. Then run `make verify`. It must pass. It runs the whole suite, not just your task.
6. If either still fails: set the task to BLOCKED in STATE.md with the command and the last 20 lines of
   output, commit nothing, and stop.
7. On success: set the task to DONE in STATE.md, `git add -A && git commit -m "<task-id>: <subject>"`, stop.
8. STOP after one task. Do not start the next one.

If the card is wrong, ambiguous, or contradicts packages/contract: set status NEEDS-SPEC with one sentence
saying what is ambiguous, and stop. Guessing is worse than stopping.