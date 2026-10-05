# End-to-end suites

Each suite starts the dev build of Hive with Playwright's `_electron`, in a throwaway profile and workspace, and
checks a feature the way a user would use it. They run on your machine, not in CI: they need the real CLIs.

```bash
npm run e2e -- --build          # build first, only if the dev build in out/ isn't from this source, then the full set
npm run e2e                      # the full set: every fake-tier suite (the packaged ones only with --packaged); same as --all
npm run e2e -- --all --real      # everything, the real tier (real Claude Code and Codex) too
npm run e2e -- --only-real       # only the real tier
npm run e2e -- agents transcript # just these
npm run e2e -- --affected        # the suites the changes since main need (affected.mjs), uncommitted ones included, real ones too
npm run e2e -- <suites> --build --record # and print a run record for the card (saved with the run's logs, and the latest as logs/run-record.md)
npm run e2e -- --fingerprint     # the code's fingerprint, to compare with a run record
npm run e2e -- <suites> --repeat 3 --build --record # three runs, stopping at the first that fails; one record for all
npm run e2e -- --all --no-wait   # a heavy run: fail at once rather than wait while two others hold the test slots
npm run dist && npm run e2e -- --packaged   # also the installed-app suites (dist/win-unpacked)
```

**Two tiers.** The **fake tier** is every suite that starts no real CLI: those with no `needs`, and those that run the
fake Claude Code or fake Codex. The **real tier** is the suites that start the real Claude Code (`needs: ['claude']` in
`suites.mjs`) or the real Codex in its test home (`needs: ['codex']`): they test what fakes can't (hooks reaching Hive,
the CLIs' transcript formats, session binding, usage, their trust and mode screens, Codex's sandbox), but they are slow,
cost tokens and fail for reasons that aren't the code. The full set (`--all`, or nothing named) is the fake tier, and
the runner lists the real suites it left out ("Not run: the real tier"), in its output and the run record. `--real` adds
the real tier, `--only-real` runs only it; a suite named always runs.

A suite passes when it exits cleanly and prints no `FAIL` line. **Environment failures are a SKIP, not a FAIL**, but
only where it is certain: a real suite marks each step that waits on the CLI answering (a turn) with
`lib.cliStep(name, { session: <pty key> }, fn)`, and its `check` reports to `lib.checked(ok)`. When a check in such a step
fails and a **new** usage or rate limit, sign-in or network error (`lib.environmentProblems`) appeared **in that step's
session** during it, the suite stops there with `SKIPPED environment: <why> (in "<step>", <session>)`, which the run
record lists under **Skipped for the environment**. It stays a FAIL when the step threw (an exception is never the
environment's: a bug, a rejected IPC call, a file error; so a step's waits on the CLI end in a check, not a throw), when
anything failed before the step, when another FAIL line was printed (a page error), when the error is in another
session or was already there before the step (the CLI recovered), or when the suite's checks don't report to
`lib.checked`; an `ENVIRONMENT` line in its output
says it saw the error but couldn't put the failure down to it. Hive's own checks about the turn (what it recorded,
counted, showed) go after the step, outside it. The runner skips real suites up front, with an `environment:` reason,
when their CLI isn't installed, Claude Code says it isn't signed in (`claude auth status`), or the Codex test home has no
sign-in. A suite that can't run on a machine says so with `lib.skip('<why>')`. The runner prints a summary; each suite's output
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
`--build` with `--record`. Runners in the same worktree build it once between them (Run context, below).

**Several at once.** Suites run four at a time (`--jobs N` for another number; `--jobs 1` runs them one after
another). Each gets its own profile, folders and Agent API port: the runner sets `HIVE_E2E_PORT` and `HIVE_API_PORT`,
and suites read the port with `lib.port(<default>)` (the default is used when a suite runs on its own). Suites that
start the real Claude Code or use the Codex test home share those with each other, so they run one at a time in a lane
of their own, beside the rest. Those marked `serial` in `suites.mjs` (with the reason: window focus, a shared test
home) and the installer's run last, alone.

**Several runners at once** (agents in different worktrees each checking their card). Each runner claims a **lane**
when it starts (`lanes.mjs`): a range of ten Agent API ports (lane *k*'s first slot is 47940 + 20*k*, the CLI lane the
port below) and a folder of its own for its suites' profiles, workspaces and screenshots (`lanes\<k>` in the work
folder, below). Claims are files in `%LOCALAPPDATA%\hive-test\e2e-lanes`
(`lane-<k>.json`, with the runner's process id), taken under a short lock and released when the runner ends; a crashed
runner's claim expires (its process is gone, or it is a day old). A lane is only taken when nothing is listening on
its ports, so anything else holding them (an older runner without lanes, another app) moves the runner to the next
one. The runner prints its lane, its suites' folder and its logs folder when it starts. Ten runners at once is the
most: the eleventh stops and says so.
A runner started inside a suite claims no lane: it takes ports 1000 above its parent suite's (`portBase` in
`runner.mjs`) and its suites' folders in `nested` inside the parent's (`E2E_RUN_DIR`). Logs stay in one place for every
lane (`logs/` below), so `.active` there shows every run still going. Suites keep their test projects outside the
repository, so its `CLAUDE.md` (which imports `AGENTS.md`) never applies to their Claude Code sessions: Claude Code
would ask each session whether to allow the import. `update` keeps its download cache per lane too (`%LOCALAPPDATA%\hive-test-updater-<k>`, through
`HIVE_UPDATE_CACHE`). The Codex test home stays shared: it holds the one sign-in, and copies of it would share a
refresh token. Codex runs any number of sessions in one home. What the suites change there, the trusted folders in its
`config.toml`, goes through `lib.trustForCodex`, under a lock beside the file (`config.toml.lock`, broken after 30 s
as a crash's), so two runners trusting their lanes' folders at once never lose one. A suite that runs out of time (10 minutes) is stopped with everything it started, so its test
Hive doesn't keep holding the lane's port.

**Run context.** Tests assume nothing about the machine they run on or the shell they were started from: everything
a run uses of its own comes from one place, `runContext.cjs` (with `lanes.mjs` for ports and folders and `build.mjs`
for the build), and the e2e runner, `lib.cjs` and the scenario harness all take it from there.

- **Environments are built from an allowlist.** A suite (from the runner), a test copy of Hive (`lib.hiveEnv({
  HIVE_USER_DATA, … })`, which `lib.launch()` uses) and a child that is part of Hive, such as the hive MCP server or the
  `hive-progress` wrapper (`lib.childEnv({ … })`), get Windows' own variables, the user's folders and the network's
  proxy and certificates (`ALLOW`), plus what the context sets: the profile, quiet and tips off, the suite's folder
  (`HIVE_E2E_DIR`) and port (`HIVE_E2E_PORT`, which a test Hive gets as `HIVE_API_PORT`), the CLI test homes a suite
  names. Nothing else of the parent's: not an agent session's `HIVE_*` variables or an outer `hive-progress`'s
  `HIVE_PROGRESS_*`, not `NO_COLOR`/`FORCE_COLOR`, `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `CLAUDE_*` or `ANTHROPIC_*`
  (the real tier uses the CLIs' own sign-in) or `GIT_*`. So a run started from an agent's shell inside `hive-progress`
  behaves as one started from a plain one, and there is no strip list to keep growing.
- **Test settings are passed on by name** (`PASS_ENV`, each with what it is for): `HIVE_TEST_CODEX_HOME`,
  `HIVE_TEST_CLAUDE_HOME`, `HIVE_TEST_QUIET` (`0` shows the copies), `HIVE_TEST_PROGRESS_TIMINGS`,
  `HIVE_PROGRESS_CHECK_DEV`, `HIVE_EXE`, `REPLYSIZE_OUT`. A new setting a suite must get from the person running it is
  added there. `HIVE_E2E_NATIVE` never is: it only works with a suite run on its own.
- **No child environment from `process.env`.** `lib.cjs` refuses to start a test Hive whose environment `lib.hiveEnv`
  didn't build, and `tests/e2esuites.test.ts` fails for a suite, the runner or the scenario harness that spreads or
  passes `process.env`. The fake CLIs are the exception: they stand for Claude Code and Codex, which start their MCP
  servers from their own environment (a test Hive's session's, already the context's). A suite's own tools (git, a
  PowerShell query) run in the suite's environment, which under the runner is the context's.
- **The runners' own tools get it too** (#208). The runners, their modules, `lib.cjs` and the scenario harness run in
  the shell they were started from, so every child they start themselves is given an environment: the build
  (`devBuild` in `build.mjs`), the git of the run record's fingerprint, `--affected` and the concurrency checker's
  worktrees, `where.exe`, `taskkill` (`runContext.baseEnv()`, the allowlist alone). A `GIT_DIR` or `GIT_WORK_TREE` in
  the shell can't point their git at another repository, and `NODE_OPTIONS` or npm's `npm_config_*` don't reach the
  build. The unit test fails for a `child_process` call there without `env`. The deliberate exception is the runners'
  progress reporting (`tests/progressReport.mts`): it is no child, and reads the Hive variables of the shell it was
  started from, to report to the Hive that started it.
- **Folders, ports and CLI homes**: the lane (above), the Codex test home under its `config.toml` lock, the Claude Code
  test home for the model trials (`CLAUDE_TEST_HOME`); each suite keeps its own `CLAUDE_CONFIG_DIR` folders in its lane.
- **The build, once per worktree** (`build.mjs`): runners started at the same time in one worktree share its `out/`,
  so the first that finds it stale takes the worktree's build lock (`%LOCALAPPDATA%\hive-test\build-locks`, a folder
  per worktree with its holder's process id), looks again, builds once and stamps it; the others wait (`Waited for
  another runner's build`) and find it fresh. A runner that only checks waits too, so it never reads half a build. A
  lock whose runner is gone is broken; a failed build lets go of it. Worktrees don't wait for each other.

`isolation` checks what a suite, a test Hive, a child and the `hive-progress` wrapper get, with an agent shell's
variables put into the suite's own environment. **`npm run e2e:concurrency`** (`concurrency.mjs`, `--repeat N`) starts
four runs at once with both builds stale: an e2e runner and a scenario run in this worktree, two e2e runners in a
second worktree it makes for the check (a git worktree of `HEAD` with the uncommitted changes, sharing `node_modules`
through a junction, removed afterwards), one in each worktree with an agent shell's environment (`NO_COLOR`,
`HIVE_PROGRESS_WRAPPED`, a token…) and one with a plain one. It checks that every run passes in a lane, folders, ports
and logs folder of its own, and that each worktree is built once and stamped. Run it after changing the runner,
`lib.cjs`, `runContext.cjs`, `lanes.mjs`, `build.mjs` or the scenario harness.

**Heavy runs queue** (`slots.mjs`, #204). Several agents each running full sets on one machine slowed each other until
tests that pass alone timed out. So at most **two heavy runs** go at once across every worktree
(`HIVE_TEST_HEAVY_SLOTS` changes it): an e2e run of more than five suites (`--all`, `--real`, a big `--affected`) or
any `--repeat`, and a scenario run of more than five scenarios or with `--repeat`. A run of a few suites, a single
scenario, or a runner started inside a suite never waits: e2e or scenarios (`needsSlot`, #211), since its parent's run
holds a slot and waiting behind it would never end. It still keeps apart from its parent (a nested e2e runner in the
parent's `nested` folder with ports above the parent's, a nested scenario run in a lane of its own). A heavy run that finds both slots taken waits for one,
before it builds, in the order runs asked. It prints `Waiting for a test slot …: held by e2e: 68 suites in <worktree>
(process …, 12 min)` and shows in the Progress panel as **e2e: waiting for a test slot** (or **scenarios: …**), naming
who holds them, until it gets one (`Got a test slot after N s`). So a run that seems stuck is usually waiting: that line
says for whom. `--no-wait` fails at once instead (exit 2, saying who holds them). Slots are files in
`%LOCALAPPDATA%\hive-test\heavy-slots` (`slot-<k>.json` held, `wait-<pid>.json` waiting, each with its runner's
process id, under the same claims lock as lanes); a crashed or killed run's slot expires at once (its process is gone).
`npm run e2e:concurrency -- --heavy` checks it: three heavy runs from three worktrees with two slots (in a pool of their
own, `HIVE_TEST_HEAVY_DIR`), one waiting visibly, `--no-wait`, and a killed run's slot.

**Unit tests under load.** `npm test` uses half the cores (`maxWorkers: '50%'` in `vitest.config.ts`) and allows 20 s
a test and 30 s a hook, so a full run beside an e2e set doesn't hit Vitest's 5 s default. A test that needs longer says
so itself (`it(…, 60_000)`), and a test that waits for something waits for it (polling), not for a fixed time.

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
- **Before a merge to main**, run the **full set** (the fake tier): `npm run e2e -- --all --build --record`, so suites
  no card named still pass. Run the **real tier** too (`--all --real`, or `--affected --only-real` for just the real
  suites the branch needs) when `--affected` selects any real suite (the runner says which: a change to providers,
  launching the CLIs, hooks and status, transcripts or `lib.cjs`), **before a release**, and **after updating Claude
  Code or Codex**. A real suite skipped for the environment doesn't block a merge, but the record says so and the
  reviewer decides whether it must run again first. CI runs only the unit tests.
- **When a change could make tests flaky** (the runner, `lib.cjs`, running suites side by side, waits), run it several
  times: `npm run e2e -- --all --build --record --repeat 3`. The repeat stops at the first run that fails, and its one
  record is valid only if every run passed on the same code. A failure means fix it and start a new repeat: a later
  passing run doesn't make up for an earlier failure.

`--affected` errs towards more: a change to a file every part of Hive goes through (the IPC contract, types, the store,
`lib.cjs`, the fake CLIs…) or to code no area names means every fake suite. Real suites come in when an area names
them, or when the change is to Hive's side of every CLI (`REAL_TIER` in `affected.mjs`: `sessions.ts`, the providers,
`providerService`, the terminal host, hook status, transcripts, `lib.cjs`) or to code no area names; a provider's own
adapter (`src/main/providers/claude/`, `codex/`) picks only its real suites. Add an area to `affected.mjs` when you add a
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

- **Claude Code**, installed and signed in. Suites that start sessions (`claude-real`, `mode`, `plan`, `compact`,
  `agentview`) never send it a prompt. The first run in a test folder answers Claude Code's "trust this folder"
  question (never a sign-in screen), so later runs don't ask. Suites about Hive's own behaviour that only need some
  session running (`quit`, `windows`, `launchrace`, `resume`) use the fake (#194), and so do `agents`, `image`,
  `assistant` and `restart` (#195), whose few checks that only the real Claude Code can answer are in `claude-real`: a
  session starting in a worktree, a relaunch with a new setting (Restart session) bringing the same session back, and
  the Assistant's launch (in the workspace folder, asking for Auto; with Haiku, Claude Code's fallback to Manual).
  These suites (`needs: ['claude']` in `suites.mjs`) are the real tier: only with `--real`, `--only-real`, by name or
  when `--affected` needs them. Run them when what they test can't be done with the fake Claude Code (below), and
  prefer the fake where it covers the case. Warn the user first if one could
  reach a sign-in screen; never send key presses to one.
- **Codex** for the `codex*` suites, signed in to the **test home** `%LOCALAPPDATA%\hive-test\codex` (never your
  own `~/.codex`). Sign in once:
  ```powershell
  New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\hive-test\codex" | Out-Null; $env:CODEX_HOME="$env:LOCALAPPDATA\hive-test\codex"; codex login
  ```
  The suites add their folders to that home's trusted projects and use its non-admin Windows sandbox. They send a
  few short prompts to a small model. Without a sign-in they are skipped.

## Where they work

Everything goes in `%LOCALAPPDATA%\hive-test\e2e` (override with `HIVE_E2E_DIR`). In it:

- `lanes\<k>`: the profiles (`HIVE_USER_DATA`), workspaces and screenshots of the suites a runner in lane *k* runs
  (above). The runner gives each suite its lane's folder as `HIVE_E2E_DIR`, which `lib.WORK` reads. There are at most
  ten, each reused by the next runner in that lane (each suite clears its own folders when it starts), so they don't
  pile up.
- `logs\run-<date>-<time>`: each run's logs and run record, from every lane (above); `logs\run-record.md` is the latest
  record.
- The work folder itself: suites run on their own (`node tests/e2e/<suite>.cjs`) keep their folders there.

Nothing touches your Hive profile, your clipboard or your real Codex home.
`HIVE_TEST_CODEX_HOME` points the Codex suites at another test home.

## Writing one

Start from an existing suite and use `lib.cjs`:
- `hiveEnv({ HIVE_USER_DATA, … })` as the environment of every test Hive it starts (or `launch()`), `childEnv({ … })`
  for a child that is part of Hive (the hive MCP server, `hive-progress`); never `process.env` (Run context, above);
- `port(<default>)` for its Agent API port (never a fixed number, so it can run beside others); add it to an area in
  `affected.mjs` and to `suites.mjs` (sorted), with `serial: '<why>'` if it can't run beside others;
- `until(fn, ms)` to wait for something to happen rather than a fixed `sleep()`, which is slower and flakier;
- `enableProviders()` for the profile, `launch()`; `fakeClaude(userData, home, trusted)` to run the fake Claude Code
  (below) when the suite only needs some session running;
- `addAgent()` / `soloAgent()`: projects start without agents;
- `acceptClaudeTrust()`, `trustForCodex()`, `gitProject()`, `samplePng()`;
- `skip('<why>')` when the suite can't run on this machine (the record shows the reason);
- in a real-CLI suite, `cliStep(name, { session }, fn)` around each step that waits on the CLI answering, with
  `checked(ok)` in the suite's `check` (above: how an environment failure there becomes a SKIP).

**Slow or failing calls** (unpackaged builds only): `HIVE_TEST_SLOW_IPC="tasks:start=2000,git:diff=3000*1"` delays those IPC calls (`*n`: only the first n) and `HIVE_TEST_FAIL_IPC="git:status*1"` makes them fail. Hive reads them again when they change, so a suite can set them in the main process while it runs (`app.evaluate(() => { process.env.HIVE_TEST_SLOW_IPC = '…' })`). `busy`, `changes` and `loadfail` use them.

**Quiet test copies** (unpackaged builds only): a copy of Hive started with a test profile (`HIVE_USER_DATA`, which every suite sets) is quiet, however it was started (the runner, `node tests/e2e/<suite>.cjs`, a scenario or a Playwright script), and so is one started with `HIVE_TEST_QUIET=1`. `HIVE_TEST_QUIET=0` turns it off, for a suite that needs a real window (listed in `LOUD` in `tests/testQuiet.test.ts`, which fails for a suite that starts Hive without a test profile or turns quiet off unlisted). So the copies of Hive the suites start never interrupt you: their windows open off screen, to the left of your screens, and never take focus (`showInactive`; Chromium's occlusion tracking is off for them, so they still draw), and they raise no Windows notification, taskbar flash or chime (`src/main/testQuiet.ts`; the window still counts a chime, for `window.__hiveChimes`). Set `HIVE_TEST_NOTIFY_LOG=<file>` to have each notification, flash and chime they would have made written there as a JSON line (`{ kind, title, body }`); `bursts` checks its notifications that way. Suites that need a focused window stub it (`inbox`, `progress`, `taskbar`) rather than taking OS focus. Maximising is simulated the same way: `carddialog` gives its off-screen window a screen's work-area size, makes `isMaximized()` say so and emits `maximize`/`unmaximize`, which checks Hive's handling of them (the card kept in the window, the title-bar buttons dimmed) but not Electron's and Windows' own maximise. For that, run it on its own with **`HIVE_E2E_NATIVE=1 node tests/e2e/carddialog.cjs`** (PowerShell: `$env:HIVE_E2E_NATIVE='1'; node tests/e2e/carddialog.cjs`): the same checks with the real `maximize()`/`unmaximize()` in a normal window, which **comes on screen, takes the focus and fills the screen** while it runs, so only when asked. The runner drops `HIVE_E2E_NATIVE`, so full and `--affected` runs stay quiet.

**Tips** are off in every test copy of Hive (`lib.hiveEnv` sets `HIVE_TEST_TIPS=off`, unpackaged builds only: a profile that doesn't set *Show a tip when Hive starts* gets it off), so no tip card covers what a suite clicks. A suite about tips (`tips`) turns them on in its profile.

**A fake Claude Code** (`fake-claude/fake-claude.cmd`) runs agents without signing in or spending tokens: set it as
the profile's Claude Code path (`settings.providers['claude-code'].executablePath`) and start Hive with
`CLAUDE_CONFIG_DIR` pointing at a test folder. It goes through Hive's real Claude Code adapter: it asks to trust a
new folder (Enter trusts it), sends Claude Code's hooks, writes its transcripts, starts on a task given on the
command line, and answers each prompt after a second (`work N` takes N seconds; `edit <file>` makes an Edit, with
its file lock; `pad N` adds N KB to its transcript; `ask` sends a permission prompt; `window N` makes its status line report an N-token context window; `boardmove N COLUMN` moves card N as its hive tools would, and `boardreview N ACTION [COLUMN]` reviews it (both recording the answer in `fake-calls.jsonl`); `background N` starts a background command that ends after N seconds, whose task notification then
starts a turn by itself; `/compact [focus]` compacts (PreCompact, a compaction in the transcript after 1 s or `hold N` seconds, PostCompact; `compactfail` in the focus fails it, and with no messages yet it says "Not enough messages to compact."); `--model fail-start` makes it refuse to start, printing an error and exiting with 1). Each launch is recorded in `fake-launches.jsonl` in `CLAUDE_CONFIG_DIR` (its options and
`CLAUDE_CODE_*` variables). `assistant-control`, `context`, `background`, `longsession`, `resumeall`, `cardchip`, `sessionorigin`, `assistantend`, `tipcorner`, `review`, `reorder`, `busy`, `startfail`, `filelinks`, `quitwait`, `rendercrash`, `bursts`, `taskbar`, `ctxpercent`, `donemove`, `doingmove`, `paneheader`, `tabstrip`, `closewindow`, `storage`, `skilldelivery`, `quit`, `windows`, `launchrace`, `resume`, `agents`, `image`, `assistant`, `restart` and `board` use it (`board` also sends a small test folder to the Recycle Bin, as Delete Project does, and `storage` sends its fixture images and backups there, as Clean Up does). `codex-background` checks Codex's background
terminals with the real Codex (one short prompt).

**A fake Codex** (`fake-codex/fake-codex.cmd`) does the same for Codex: set it as `settings.providers.codex.executablePath` and start Hive with `CODEX_HOME` pointing at a test folder (with `[windows] sandbox = "unelevated"` in its `config.toml`, so nothing is left to set up). It reports itself as Codex 0.160.0 (`FAKE_CODEX_VERSION` changes it) and sends Codex's hooks and terminal titles for a few prompts: `review allow` / `review deny` (its auto-reviewer answers a permission request), `approve` (an approval prompt: `y` approves, Esc rejects) and `question` (an async question it works on beside: `a` answers it). `attention` uses it, and so does `skilldelivery` (with the fake Claude Code); each launch is recorded in `fake-launches.jsonl` in `CODEX_HOME` (its folder and arguments).

Print `PASS name` / `FAIL name` per check, and add the suite to `SUITES` in `run.mjs`.

**Agent behaviour** (do agents use Hive's skills and keep its board rules?) is tested by the scenarios in `tests/scenarios` (`npm run scenarios`), which reuse `lib.cjs` and the fake CLIs, with opt-in model trials: see its README.
