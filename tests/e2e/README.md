# End-to-end suites

Each suite starts the dev build of Hive with Playwright's `_electron`, in a throwaway profile and workspace, and
checks a feature the way a user would use it. They run on your machine, not in CI: they need the real CLIs.

```bash
npm run e2e -- --build          # build first, only if the dev build in out/ isn't from this source, then every suite
npm run e2e                      # every suite (the packaged ones only with --packaged); same as --all
npm run e2e -- agents transcript # just these
npm run e2e -- --affected        # the suites the changes since main need (affected.mjs), uncommitted ones included
npm run e2e -- <suites> --build --record # and print a run record for the card (saved with the run's logs, and the latest as logs/run-record.md)
npm run e2e -- --fingerprint     # the code's fingerprint, to compare with a run record
npm run e2e -- <suites> --repeat 3 --build --record # three runs, stopping at the first that fails; one record for all
npm run dist && npm run e2e -- --packaged   # also the installed-app suites (dist/win-unpacked)
```

A suite passes when it exits cleanly and prints no `FAIL` line. The runner prints a summary; each suite's output
is kept in a folder of its own for each run, `logs/run-<date>-<time>` under the work folder, with `-2`, `-3`… when
another run started in the same second. The last ten finished runs are kept: a run still going (`.active` in its folder,
with its runner's process id) is never pruned, so runners started side by side don't remove each other's logs. A runner started inside a suite (`progressreport`
runs one) keeps its runs under `logs/nested`, so they never push real runs out (`logs.mjs`). It knows it is inside a
suite from `E2E_RUN_SUITE`, which the runner sets for each suite: Hive drops `HIVE_` variables from its sessions, so
`HIVE_E2E_PORT` doesn't reach an agent's shell.

**The build.** The suites run the dev build in `out/`. `--build` builds it first, only when it isn't from the source
as it is now: a build made with `--build` is stamped with a hash of everything it was made from (the paths and contents
of `src`, `resources`, `docs`, the root files the app bundles and the build config; `build.mjs`), so an added, changed
or deleted file is noticed whatever its modification time. A build made another way (`npx electron-vite build`) has no
stamp: the runner warns that it may hold other code, and a run record made with it is marked not valid. So use
`--build` with `--record`.

**Several at once.** Suites run four at a time (`--jobs N` for another number; `--jobs 1` runs them one after
another). Each gets its own profile, folders and Agent API port: the runner sets `HIVE_E2E_PORT` and `HIVE_API_PORT`,
and suites read the port with `lib.port(<default>)` (the default is used when a suite runs on its own). Suites that
start the real Claude Code or use the Codex test home share those with each other, so they run one at a time in a lane
of their own, beside the rest. Those marked `serial` in `suites.mjs` (with the reason: window focus, a shared test
home) and the installer's run last, alone.

## Which suites to run, and who runs them

For a card in the builder/reviewer loop (the `card-loop` skill), so a round doesn't run the same suites twice on the
same code while every required check still runs:

- **The builder** runs the suites the card names and moves the card to Review with a **run record**
  (`--build --record`): the code's fingerprint (HEAD, plus a hash of any uncommitted changes), each suite's result and time,
  and the logs folder. Paste the printed block into the card comment.
- **The reviewer** checks the record's fingerprint is the code it's reviewing (`npm run e2e -- --fingerprint` in the
  builder's folder) and trusts it for those suites. It reruns the quick checks (`npm run typecheck`, `npm run lint`,
  `npm test`) and the one or two suites closest to the riskiest change, and spends the rest of its time on its own
  probes. It reruns more when there's no record, the fingerprint differs, or a result looks wrong.
- **Follow-up rounds** run the suites the fixes affect (`--affected`). **Before a card passes**, every suite it names
  has run on its final code (the builder's last record).
- **Before a merge to main**, and before a release, run the **full set**: `npm run e2e -- --all --build --record` (with the
  real CLIs signed in), so suites no card named still pass. CI runs only the unit tests.
- **When a change could make tests flaky** (the runner, `lib.cjs`, running suites side by side, waits), run it several
  times: `npm run e2e -- --all --build --record --repeat 3`. The repeat stops at the first run that fails, and its one
  record is valid only if every run passed on the same code. A failure means fix it and start a new repeat: a later
  passing run doesn't make up for an earlier failure.

`--affected` errs towards more: a change to a file every part of Hive goes through (the IPC contract, types, the store,
`lib.cjs`, the fake CLIs…) or to code no area names means every suite. Add an area to `affected.mjs` when you add a
suite or a source file; `tests/e2esuites.test.ts` checks every suite and source file is covered.

**Progress in Hive.** Run from an agent's session in Hive, the runner shows in that Hive's Progress panel: **e2e: N
suites**, a step per suite, and the time left from how long each suite took before (kept in
`%LOCALAPPDATA%\hive-test\progress-timings.json`). `npm test` does the same, a step per test file. It reports to the
Hive that launched the agent, never to the test copies the suites start (the session's `HIVE_*` variables aren't
passed to them), and it never changes the output or the results. Turn it off with `--no-progress` (e2e) or
`HIVE_PROGRESS=0` (both). The reporting is all in `tests/progressReport.mts`.

`packaged-progress` checks the `hive-progress` wrapper as installed (`dist/win-unpacked`), against a stand-in for the
Agent API; `HIVE_PROGRESS_CHECK_DEV=1 node tests/e2e/packaged-progress.cjs` checks the dev build's copy.

## What they need

- **Claude Code**, installed and signed in. Suites that start sessions (`agents`, `image`, `mode`, `plan`,
  `compact`, `restart`, `resume`, `quit`, `agentview`, `windows`, `launchrace`, `assistant`) never send it a prompt. The first run in a test folder answers Claude
  Code's "trust this folder" question (never a sign-in screen), so later runs don't ask.
  These suites (`needs: ['claude']` in `run.mjs`) aren't skipped automatically. Run them when what they test can't be
  done with the fake Claude Code (below), and prefer the fake where it covers the case. Warn the user first if one could
  reach a sign-in screen; never send key presses to one.
- **Codex** for the `codex*` suites, signed in to the **test home** `%LOCALAPPDATA%\hive-test\codex` (never your
  own `~/.codex`). Sign in once:
  ```powershell
  New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\hive-test\codex" | Out-Null; $env:CODEX_HOME="$env:LOCALAPPDATA\hive-test\codex"; codex login
  ```
  The suites add their folders to that home's trusted projects and use its non-admin Windows sandbox. They send a
  few short prompts to a small model. Without a sign-in they are skipped.

## Where they work

Everything goes in `%LOCALAPPDATA%\hive-test\e2e` (override with `HIVE_E2E_DIR`): profiles (`HIVE_USER_DATA`),
workspaces, screenshots and logs. Nothing touches your Hive profile, your clipboard or your real Codex home.
`HIVE_TEST_CODEX_HOME` points the Codex suites at another test home.

## Writing one

Start from an existing suite and use `lib.cjs`:
- `port(<default>)` for its Agent API port (never a fixed number, so it can run beside others); add it to an area in
  `affected.mjs` and to `suites.mjs` (sorted), with `serial: '<why>'` if it can't run beside others;
- `until(fn, ms)` to wait for something to happen rather than a fixed `sleep()`, which is slower and flakier;
- `enableProviders()` for the profile, `launch()`;
- `addAgent()` / `soloAgent()`: projects start without agents;
- `acceptClaudeTrust()`, `trustForCodex()`, `gitProject()`, `samplePng()`.

**Slow or failing calls** (unpackaged builds only): `HIVE_TEST_SLOW_IPC="tasks:start=2000,git:diff=3000*1"` delays those IPC calls (`*n`: only the first n) and `HIVE_TEST_FAIL_IPC="git:status*1"` makes them fail. Hive reads them again when they change, so a suite can set them in the main process while it runs (`app.evaluate(() => { process.env.HIVE_TEST_SLOW_IPC = '…' })`). `busy`, `changes` and `loadfail` use them.

**Quiet test copies** (unpackaged builds only): `run.mjs` and `lib.launch` set `HIVE_TEST_QUIET=1`, so the copies of Hive the suites start never interrupt you: their windows open off screen, to the left of your screens, and never take focus (`showInactive`; Chromium's occlusion tracking is off for them, so they still draw), and they raise no Windows notification, taskbar flash or chime (`src/main/testQuiet.ts`; the window still counts a chime, for `window.__hiveChimes`). Set `HIVE_TEST_NOTIFY_LOG=<file>` to have each notification, flash and chime they would have made written there as a JSON line (`{ kind, title, body }`); `bursts` checks its notifications that way. Suites that need a focused window stub it (`inbox`, `progress`, `taskbar`) rather than taking OS focus.

**Tips** are off in suites run by `run.mjs` (`HIVE_TEST_TIPS=off`, unpackaged builds only: a profile that doesn't set *Show a tip when Hive starts* gets it off), so no tip card covers what a suite clicks. A suite about tips (`tips`) turns them on in its profile.

**A fake Claude Code** (`fake-claude/fake-claude.cmd`) runs agents without signing in or spending tokens: set it as
the profile's Claude Code path (`settings.providers['claude-code'].executablePath`) and start Hive with
`CLAUDE_CONFIG_DIR` pointing at a test folder. It goes through Hive's real Claude Code adapter: it asks to trust a
new folder (Enter trusts it), sends Claude Code's hooks, writes its transcripts, starts on a task given on the
command line, and answers each prompt after a second (`work N` takes N seconds; `edit <file>` makes an Edit, with
its file lock; `pad N` adds N KB to its transcript; `ask` sends a permission prompt; `window N` makes its status line report an N-token context window; `boardmove N COLUMN` moves card N as its hive tools would, and `boardreview N ACTION [COLUMN]` reviews it (both recording the answer in `fake-calls.jsonl`); `background N` starts a background command that ends after N seconds, whose task notification then
starts a turn by itself; `/compact [focus]` compacts (PreCompact, a compaction in the transcript after 1 s or `hold N` seconds, PostCompact; `compactfail` in the focus fails it, and with no messages yet it says "Not enough messages to compact."); `--model fail-start` makes it refuse to start, printing an error and exiting with 1). Each launch is recorded in `fake-launches.jsonl` in `CLAUDE_CONFIG_DIR` (its options and
`CLAUDE_CODE_*` variables). `assistant-control`, `context`, `background`, `longsession`, `resumeall`, `cardchip`, `sessionorigin`, `assistantend`, `tipcorner`, `review`, `reorder`, `busy`, `startfail`, `filelinks`, `quitwait`, `rendercrash`, `bursts`, `taskbar`, `ctxpercent`, `donemove`, `doingmove`, `paneheader`, `storage`, `skilldelivery` and `board` use it (`board` also sends a small test folder to the Recycle Bin, as Delete Project does, and `storage` sends its fixture images and backups there, as Clean Up does). `codex-background` checks Codex's background
terminals with the real Codex (one short prompt).

**A fake Codex** (`fake-codex/fake-codex.cmd`) does the same for Codex: set it as `settings.providers.codex.executablePath` and start Hive with `CODEX_HOME` pointing at a test folder (with `[windows] sandbox = "unelevated"` in its `config.toml`, so nothing is left to set up). It reports itself as Codex 0.160.0 (`FAKE_CODEX_VERSION` changes it) and sends Codex's hooks and terminal titles for a few prompts: `review allow` / `review deny` (its auto-reviewer answers a permission request), `approve` (an approval prompt: `y` approves, Esc rejects) and `question` (an async question it works on beside: `a` answers it). `attention` uses it, and so does `skilldelivery` (with the fake Claude Code); each launch is recorded in `fake-launches.jsonl` in `CODEX_HOME` (its folder and arguments).

Print `PASS name` / `FAIL name` per check, and add the suite to `SUITES` in `run.mjs`.

**Agent behaviour** (do agents use Hive's skills and keep its board rules?) is tested by the scenarios in `tests/scenarios` (`npm run scenarios`), which reuse `lib.cjs` and the fake CLIs, with opt-in model trials: see its README.
