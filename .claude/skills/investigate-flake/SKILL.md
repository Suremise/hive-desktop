---
name: investigate-flake
description: Investigate a test that fails intermittently in Hive - does it still happen, reproduce it alone and under load, find the race, fix it with a condition rather than a timeout, prove the fix with repeated runs, and close it only with evidence. Use when a card or a run says a test is flaky, intermittent, passes alone but fails in a full run, or fails under load.
---

# Investigate a flaky test

A flake is a test whose result depends on timing or on what else is running. Each step below is one check, and the record of each is what closes the card.

## 1. Does it still happen?

- Find its history first: the card that cites it, the run records and logs (`%LOCALAPPDATA%\hive-test\e2e\logs`, one folder per run), and the test's own log. Note the commit each failure ran on: a failure on older code proves nothing about today's.
- Reproduce it alone: `npm run e2e -- <suite>` for an e2e suite, `npx vitest run <file>` for a unit test. This shows whether the test fails at all. It does not load the machine.
- Reproduce it under load, and make sure the load is there. A repeat of one suite is only repeats: suites are not run beside each other. The load is the full set, which runs suites four at a time (`--jobs 4` is the default): `npm run e2e -- --all --build --record`, repeated with `--repeat 5`. For a unit test, the load is the full unit suite (`npx vitest run`), run five times in a row while it is the only thing you're testing.
- Write down, for each run: the command, the count (runs, passes, failures), the failing check, the load (the full set, `--jobs`, what else was running), and whether Windows Defender exclusions were on (scanning can hide a flake, or cause one).

## 2. Find the race

- Read the failing check's name and its log line, then compare what the test waits for with what it assumes. A flake is a gap between the two.
- Typical causes in Hive: a Windows file lock (EPERM on teardown, `index.lock` in git), a wake or a keypress not yet taken, focus or timing in the UI, lane folders shared between runs, a real CLI home (#368), an antivirus scan holding a file.
- If the state at the failure is unknown, add evidence to the test (a screenshot, the page's status, the file's contents) and run it again before changing anything.

## 3. Fix with a condition, not a timeout

- Wait for the observable state: `lib.until(fn, ms)` with a check that says what is awaited, not a fixed `sleep()`.
- Teardown that can hit a lock retries with a cap, and each run uses its own folder.
- Don't delete from a shell on a computed path, whatever the shell (`rm -rf`, `Remove-Item -Recurse`, or any recursive delete). Use what the repo provides: `lib.probeDir('<what>')` for a new folder, `npm run e2e -- --clear-dir <folder>` to empty one, and `npm run test:clean` to prune what tests leave. The rule and the helpers are in AGENTS.md (no shell deletes on computed paths) and [tests/e2e/README.md](../../../tests/e2e/README.md) (Housekeeping); don't invent a second procedure.
- A longer timeout is not a fix, and neither is skipping the test. If the only option is a timeout, say so on the card and ask.

## 4. Prove it

- Repeat the fixed test under the load that showed the flake, on a verified build: the full set five times (`npm run e2e -- --all --build --record --repeat 5`), or the full unit suite five times. A repeat of one suite alone doesn't count as that load. A later pass doesn't make up for an earlier failure: start a new repeat.
- Where it is cheap, check that the old wait fails in the same conditions. A fix that passes either way proves nothing.

## 5. Closing

- "No longer reproduces" needs that evidence: the repeats under the load that showed the flake, on the commit that's being closed, with the environment noted (Defender exclusions on or off). Leave a watch-for note on the card.
- Link duplicate cards to the one that's fixed. The user archives them.

## Report

Cause, evidence (run folders and their paths, commits), fix (what changed and why it's a condition), and runs (commands, counts, load, environment). Follow [tests/e2e/README.md](../../../tests/e2e/README.md) for the runner, the record and `--repeat`, and AGENTS.md for test isolation: don't restate them here.
