# Tests

Unit tests (Vitest) are the `*.test.ts` files here: `npm test`, or `npx vitest run <file>` for one. The end-to-end
suites are in [e2e](e2e/README.md) and the agent-behaviour scenarios in [scenarios](scenarios/README.md). Helpers:
`tempDir()` (`tempDir.ts`) for a test's folders, `pathAliases.ts` for another name for one, `noGlobalGit.ts` (unit
tests run git with no global config, as CI does), and `electron-stub.ts` standing in for `electron`.

## Tests wait for conditions, never for time

Every test, unit or end-to-end, new or changed, follows these rules. Each one was a flaky test in 0.6.0, failing on a
loaded or slower machine and passing on the one it was written on (#457, #459, #466, #477, #516, #518, #519, #522).
Anyone who clones the repository must get the same results, on any machine and under any load.

- **Wait for what you expect to see, not for a length of time.** Poll the observable state until it holds:
  `lib.until(fn, ms)` in the e2e suites and scenarios, `vi.waitFor(fn)` or `expect.poll(fn)` in unit tests. Say what
  is awaited in the check's name or the failure message. Never `sleep()` and then check, and never read UI or state
  once just after an action that changes it: a click, an IPC call, a hook, a file write, a git command.
- **A timeout bounds a hung run, and never makes a test pass.** Make it generous, and name or explain it. Raising a
  timeout isn't a fix: a change that raises one says why, in the code and on the card.
- **No test depends on another's leftovers.** Each test sets up and removes its own state: folders, git worktrees,
  processes, settings, environment variables. It passes alone, in any order, and when run twice.
- **Tests pass under load.** The full suites run beside other runs (up to two heavy runs on a machine by default, the
  e2e runner's test slots, which a full unit run takes too, and focused unit runs beside them). Before calling a test done, run it under that load, not only
  alone. A machine can be set to take more or fewer heavy runs with `HIVE_TEST_HEAVY_SLOTS` ([e2e](e2e/README.md), "How
  many heavy runs at once"); a test must pass with any number of them.

A sleep that is the point of the test is fine: checking that something does *not* happen within a period, pacing
keystrokes, a fake standing in for a slow CLI. Say so in a comment beside it. Something that is truly waited for with
a sleep, where nothing can be observed, is the exception: say why in the comment.

**`npm run test:waits`** (`scripts/testWaits.mjs`) finds the sleeps a branch adds or changes in the tests since main
(uncommitted and new files too) that a check follows within three lines, with no comment beside or above saying why;
it exits 1 when there is one, and 2 when it can't compare (no `main`, a bad `--base`, git failing): nothing was
checked, so that isn't a pass. Only the first check after a sleep counts, and the sleep is let through only when that
check itself waits (`until`, `waitFor`, `poll`): a wait in a later check doesn't cover an earlier one. A short sleep
needs its comment like a long one. A pause inside a loop that polls state is the loop's way of
waiting for its condition, so it isn't counted: one whose `while` (or `do…while`) condition reads state, or whose body
leaves on an `if` with `break` or `return`, with the check after the loop. A loop that only repeats actions (a counted
`for`, `for…of`, a `while` on a count or a clock) is no poll: a sleep in it before a check, inside the loop or after
it, is found like any other. What it can't see: a single read with no sleep before it, a sleep more than three
lines before its check, and a wait under another helper's name; and a comment counts as the reason whatever it says.
Reviewers look for those and judge the reasons. `-- --all` lists every such sleep in the tests, the older ones too (the
backlog in #524's audit). Builders run it before Review, and reviewers fail a new or changed test that sleeps and then
checks, reads state once after an action, or raises a timeout with no stated reason.

A test that flakes anyway is investigated with the `investigate-flake` skill (`.claude/skills`, `.agents/skills`).
