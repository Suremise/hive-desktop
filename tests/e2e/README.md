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
npm run e2e -- <suites> --build --keep-files # passed suites' screenshots and files kept too, in the run's log folder (<run>\<suite>)
npm run e2e -- --clear-dir <folder>          # empty a probe's or a suite's own folder from Node, for a rerun into the same place
npm run dist && npm run e2e -- --packaged   # also the installed-app suites (dist/win-unpacked)
```

**Two tiers.** The **fake tier** is every suite that starts no real CLI: those with no `needs`, those that run the
fake Claude Code or fake Codex, and `copilot` and `copilotsize` (`needs: ['copilot']`), which run the real Copilot CLI offline against a
scripted stand-in model: no sign-in and no cost, so it is in the full set, and skipped where Copilot isn't installed. The **real tier** is the suites that start the real Claude Code (`needs: ['claude']` in
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
when their CLI isn't installed, Claude Code says its test home isn't signed in (`claude auth status`, only for
`claudeHome: 'test'` suites), or the Codex test home has no sign-in. A suite that can't run on a machine says so with `lib.skip('<why>')`. The runner prints a summary; each suite's output
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
`npm run dist` builds `out/` the same way (under the worktree's build lock) and stamps it, so a run straight after it
needs no `--build` (#274).

**The installer's suites** (`packaged*`) test `dist\win-unpacked`, not `out/`: a run of only those doesn't look at
`out/` (unless `HIVE_PROGRESS_CHECK_DEV=1`). Instead the runner checks what `dist\win-unpacked` itself was built from:
`npm run dist` records that inside it (`win-unpacked\.hive-build-info.json`) once it is sure, and removes it when it
starts. Not `dist\build-info.json`: that describes the installer set, which a worktree's `npm run dist` copies into the
main checkout's `dist` without `win-unpacked`, so there it can describe another build than the one the suites would
run. When the record's code isn't the fingerprint of the code now, or there is none, the runner warns and a run
record is marked not valid. So `npm run dist`, then
`npm run e2e -- packaged packaged-mcp packaged-progress --record`, gives a valid record without `--build`; a `dist` from
another commit, or from before an edit, is reported.

**Several at once.** Suites run four at a time (`--jobs N` for another number; `--jobs 1` runs them one after
another). Each gets its own profile, folders and Agent API port: the runner sets `HIVE_E2E_PORT` and `HIVE_API_PORT`,
and suites read the port with `lib.port(<default>)` (the default is used when a suite runs on its own). Suites that
start the real Claude Code or use the Codex test home share those with each other, so they run one at a time in a lane
of their own, beside the rest. Those marked `serial` in `suites.mjs` (with the reason: window focus, a shared test
home) and the installer's run last, alone.

**Several runners at once** (agents in different worktrees each checking their card). Each runner claims a **lane**
when it starts (`lanes.mjs`): a range of ten Agent API ports (lane *k*'s first slot is 47940 + 20*k*, the CLI lane the
port below) and a folder of its own for its suites' profiles, workspaces and screenshots (`lanes\<k>` in the work
folder, a folder per suite in it, below). Claims are files in `%LOCALAPPDATA%\hive-test\e2e-lanes`
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
  **Every test copy of Hive gets the CLI homes** (#382, #452): Hive looks for the CLIs when it starts, and their sign-in
  checks (`claude auth status`, `codex login status`, Copilot's `config.json` and `gh auth status`) read the home they
  are given, else yours. `lib.hiveEnv` gives `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME` and `GH_CONFIG_DIR` as
  empty folders of the suite's (`<suite folder>\cli-homes\claude`, `\codex`, `\copilot` and `\gh`, `runContext.cliHomes`;
  the empty gh config hides your GitHub CLI login, which Copilot falls back to) unless the suite gives a test home (the
  fake Claude Code's, `lib.ownClaudeHome`, the Codex test home). `lib.cjs` refuses to start a test Hive with one missing
  or pointing at your own `~/.claude`, `~/.codex`, `~/.copilot` or `%APPDATA%\GitHub CLI` (however the path is spelled),
  and makes the empty ones.
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
`lib.cjs`, `runContext.cjs`, `lanes.mjs`, `build.mjs` or the scenario harness. Two checkers can run at once, from two
worktrees (#207): each keeps what it makes (its worktrees, decoy, heavy-run pool) in a folder of its own,
`%LOCALAPPDATA%\hive-test\concurrency\run-<pid>-<time>` (`tempWorktrees.mjs`), and removes only that. A setup that
fails part way removes its own worktree; the folder of a checker that crashed is removed by the next one, unless it
was kept with `--keep`. Two started from the same worktree share its build, so its "built once" checks may fail.

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
  and the logs folder. Paste the printed block into the card comment. When real suites ran, the record also names the
  real CLIs' versions as the suites' test copies of Hive selected them ("Real CLIs (as Hive selected them): Claude Code
  2.1.292, Codex 0.160.1"; each Hive notes its choice in the suite's `hive-clis.jsonl`, `HIVE_TEST_CLI_LOG`), and
  `run-record.json` beside it holds them per suite: `npm run tested-clis` makes the release's "Tested with" manifest
  from it (#365, RELEASING.md). The runner itself never starts a CLI.
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

- **Claude Code**, installed. **No real suite runs it in your own `~/.claude`** (#368): each one says its home in
  `suites.mjs` (`claudeHome`), and `tests/e2esuites.test.ts` fails for one that doesn't. Suites that start sessions
  without sending a prompt (`claude-real`, `mode`, `plan`, `compact`, `agentview`, and `claudehome`, below) run it in a
  home of their own (`claudeHome: 'own'`, `lib.ownClaudeHome(name)`): a new `<suite folder>\<name>-claude-home` each
  run, with onboarding done and a made-up API key approved, so it starts at its prompt with no sign-in and no tokens.
  The one that sends prompts (`assistantresume`) uses the signed-in Claude Code test home (`claudeHome: 'test'`,
  below). The runner asks Claude Code about the test home's sign-in only, and refuses a Claude suite with no home. Each
  test copy of Hive notes the home its CLIs run in (`HIVE_TEST_CLI_LOG`), and the run record names each real suite's
  ("Real CLIs' homes"); a real suite that ran in your own `~/.claude` or `~/.codex` makes the record not valid. The
  first run in a test folder answers Claude Code's "trust this folder" question (never a sign-in screen). Suites about Hive's own behaviour that only need some
  session running (`quit`, `windows`, `launchrace`, `resume`) use the fake (#194), and so do `agents`, `image`,
  `assistant` and `restart` (#195), whose few checks that only the real Claude Code can answer are in `claude-real`: a
  session starting in a worktree, a relaunch with a new setting (Restart session) bringing the same session back, and
  the Assistant's launch (in the workspace folder, asking for Auto; with Haiku, Claude Code's fallback to Manual).
  These suites (`needs: ['claude']` in `suites.mjs`) are the real tier: only with `--real`, `--only-real`, by name or
  when `--affected` needs them. Run them when what they test can't be done with the fake Claude Code (below), and
  prefer the fake where it covers the case. Warn the user first if one could
  reach a sign-in screen; never send key presses to one.
- **`claudehome`** (#345) runs the real Claude Code in a home of its own (`claudeHome: 'own'` in `suites.mjs`), never
  the default one: a new folder each run with onboarding done and a made-up API key approved in its `.claude.json`, so
  Claude Code starts at its prompt with no sign-in, and is sent nothing (no tokens, nothing reaches Anthropic). It
  checks Hive's hooks with it: SessionStart and the status line (curl reading the header from the launch's auth file)
  reaching Hive, the launch's settings, MCP config and auth file in its private folder in Hive's user data, and the
  token refused once the session ends. The runner asks about no sign-in for it. The other real Claude suites that send
  no prompt now do the same with `lib.ownClaudeHome()` (#368).
- **`claudesettings`** (#333) runs the real Claude Code in a home of its own too, with `-p --init-only` (hooks only,
  no conversation: no sign-in, no tokens), the Claude Code a test copy of Hive selects in that home (started briefly). A SessionStart hook in each settings file shows which
  files it reads under `--setting-sources` and `--restricted`, and which `--settings` files it refuses (over 2 MiB, a
  folder, missing): what Hive's compaction reader and its launch read of a user's `--settings` assume. Run it after a
  Claude Code update; a failure means `providers/claude/autoCompact.ts` no longer matches the CLI.
- **`assistantresume`** (#334) sends prompts (five short ones, with Haiku), so it runs in the **Claude Code test home**
  (`claudeHome: 'test'` in `suites.mjs`: `CLAUDE_TEST_HOME`, `%LOCALAPPDATA%\hive-test\claude`), never your own
  `~/.claude`. Sign in to it once by hand (as for the model trials, tests/scenarios/README.md), then `/exit`:
  ```powershell
  New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\hive-test\claude" | Out-Null; $env:CLAUDE_CONFIG_DIR="$env:LOCALAPPDATA\hive-test\claude"; claude
  ```
  `HIVE_TEST_CLAUDE_HOME` points it at another test home. Without that sign-in the suite is skipped for the
  environment, and never falls back to your own home. It checks that a resumed Assistant answers from its current mode's instructions (a
  codeword only those give), not the system prompt Claude Code recorded: after Restart in This Mode… and after a switch
  while it was stopped. `node tests/e2e/assistantresume.cjs --snapshot-on` is its negative control (the recorded
  prompt asked for: the old codeword comes back).
- **Codex** for the `codex*` suites, signed in to the **test home** `%LOCALAPPDATA%\hive-test\codex` (never your
  own `~/.codex`). Sign in once:
  ```powershell
  New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\hive-test\codex" | Out-Null; $env:CODEX_HOME="$env:LOCALAPPDATA\hive-test\codex"; codex login
  ```
  The suites add their folders to that home's trusted projects and use its non-admin Windows sandbox. They send a
  few short prompts to a small model. Without a sign-in they are skipped.

## Where they work

Everything goes in `%LOCALAPPDATA%\hive-test\e2e` (override with `HIVE_E2E_DIR`). In it:

- `lanes\<k>\<suite>`: the profiles (`HIVE_USER_DATA`), workspaces and screenshots of each suite a runner in lane *k*
  runs (above). The runner gives each suite a folder of its own in its lane's as `HIVE_E2E_DIR`, which `lib.WORK`
  reads, made fresh when the suite starts (`<suite>-2`… while an earlier run keeps it: Housekeeping, below). When the
  suite passes (or skips), the whole folder is removed; when it fails, it stays for a look (the runner prints where,
  and copies its screenshots and reports into the run's log folder) and goes with that run's logs.
- `logs\run-<date>-<time>`: each run's logs and run record, from every lane (above); `logs\run-record.md` is the latest
  record. The newest ten finished runs are kept, counted across every worktree's and agent's runs. A run that **failed**
  (a suite failed, or its record isn't valid) is kept a day beyond that (the newest twenty such; #223), and its failed
  suites' own files are copied into it, in `<run folder>\<suite>`: the files at the top of the suite's folder
  (screenshots, notification logs, reports) and its folders of screenshots and reports at any depth (`*shots`, such as
  `restart-shots` or `pshots`; `screenshots`, `artifacts`, `reports`; #284), never a profile, workspace, CLI home or
  sign-in file at any depth (inside a screenshot folder too), and never through a link (a suite folder with a link
  anywhere on its path isn't read at all). A file over 20 MB, or past 500 files or 200 MB in all, is left out (`keepSuiteFiles` in
  `logs.mjs`). The runner says so when the run ends, with anything it left out, so the run folder is the path to cite in
  a card. A suite writing screenshots into a folder of its own names it to match.
- The work folder itself: suites run on their own (`node tests/e2e/<suite>.cjs`) keep their folders there (each run
  empties its own subfolders, and its screenshots replace the last run's). To keep a run's screenshots, run it through
  the runner with `--keep-files` instead: they land in that run's new log folder.

Nothing touches your Hive profile, your clipboard, your real Claude Code and Codex homes (#368, #382: above) or your
**Recycle Bin**. What Hive moves to the
Recycle Bin (Delete in Files, notes, skills, templates, cards, session copies, Clean Up, Delete Project) a test copy
moves into its suite's trash folder instead, `<suite folder>\trash` (`HIVE_TEST_TRASH_DIR`, set by `lib.hiveEnv`;
without it, a test profile's `test-trash`), which goes with the suite's folder (#414). A move is one rename, whole or not at all (an item on another drive than
that folder is refused, changing nothing), and then a line in its `trash.jsonl` (`{ at, from, to }`; best effort: a
line that can't be written is a warning in the test copy's log, and the deletion still counts): a suite checks what it deleted arrived with `lib.trashed(path)` (`board`, `files`,
`storage`, `sessiontree`). Hive's one way there is `trash()` in `src/main/trash.ts` (`tests/trash.test.ts` fails for a
direct `shell.trashItem` anywhere else); the installed app and `npm run dev` use the real Recycle Bin. The runner counts
the Recycle Bin, read only, before and after a run, and says so under the summary and in the run record ("Recycle Bin:
266 items before and after the run").
`HIVE_TEST_CODEX_HOME` points the Codex suites at another test home.

## Housekeeping

What the tests leave in `%LOCALAPPDATA%\hive-test` is removed once it is no longer needed (`clean.mjs`, #253). The e2e
runner and the scenario runner do it when they finish (at most a minute; what is left goes next time), and
**`npm run test:clean`** does it on demand and prints each area's size (`--dry-run` lists what would go, and what is
kept and why, without removing anything; `--days N` sets the age, default 3).
- **Goes:** in a lane no runner holds (the clean-up claims it meanwhile, so no runner starts there), every suite
  folder no run's logs claim, whatever its age (a failed suite's is claimed until its run is pruned: below), and
  anything left from before suites had folders of their own; in scenario lanes, numbered copies (`<scenario>-2`…) and
  folders older than the age; in `e2e`, anything but `lanes` and `logs` older than the age (suites run on their own,
  probes); and anything else in `hive-test` older than the age (one-off folders and files).
- **Stays:** the CLI test homes (`codex`, `claude`: their sign-ins; never opened), scenario results and baselines, the
  claims and locks, the concurrency checker's folders (it removes its own), the Progress panel's timings; logs (the
  runner keeps the newest ten runs); a lane a runner holds.
- **Evidence stays, whoever deletes** (`evidence.cjs`): anything a card that isn't Done cites is kept by the clean-up,
  by the runners' own deletions (a suite's or scenario's earlier folder, a passed suite's folders, log pruning,
  scenario results and older baselines) and listed as `kept: … (cited by #n)`. A card cites a path by writing it: the
  thing itself (`e2e\review158-dark.png`), a path inside a folder (`evidence\x.png` keeps `evidence`;
  `lanes\0\board\board.png` keeps that suite's folder, not the rest of the lane), or a folder as a whole
  (`hive-test\evidence`, `lanes\0\board\`). A name alone isn't a citation, nor an area: `hive-test\e2e`, `scratch`, and
  **a lane** (`e2e\lanes\0`), which is where runs keep their suites' folders, not evidence (#285: cards naming lane 0
  kept every folder every later run made there, 2,078 of them, 23 GB in six hours). The cards are read from the
  workspace's board, found up from this repository's main checkout, afresh for every deletion (a card that cites
  something a moment before it would go keeps it). **Without the board** (none found, or a card that can't be read)
  the runners don't start: nothing they made could be removed. Set `HIVE_TEST_NO_BOARD=1` on a machine where no Hive
  board cites test output. Should the board become unreadable during a run, nothing is deleted meanwhile and what
  stays is tied to the run.
- **A suite's folder** in its lane (`lanes\<k>\<suite>`): when the suite passes, the whole folder goes; when it fails
  (or something in it must stay), it is tied to the run (`.kept-folders.json` in the run's log folder) and goes when
  that run's logs are pruned (the newest ten runs, a failed run a day): only in a lane the pruning runner may work in
  (its own, or an idle one it claims; in a lane another runner holds it is left, and the clean-up removes it once the
  lane is idle, since no run claims it then), and only if every entry of that list is a suite folder in a lane
  (`e2e\lanes\<k>\<suite>`, or a nested run's inside one), never a test home, results or a lane itself. While an earlier run keeps `<suite>`, a run
  takes `<suite>-2` (…), at most 32 copies: past that the suite is refused, saying what keeps them, rather than filling
  the disk.
- Links in what goes (a worktree's `node_modules` junction) are removed as links, never followed.

**Probes** (a reviewer's or builder's screenshots, scripts and profiles outside a suite) take **a new folder each run**,
so nothing needs deleting before a rerun (#304): `require('./tests/e2e/lib.cjs').probeDir('<what>')` makes
`hive-test\scratch\<what>-<date>-<time>-<random>`, which the clean-up prunes by age; or a new folder of your own in your
scratchpad (Claude Code's session scratchpad, or `%TEMP%`). Never in the lanes or logs. A folder that has to be reused
is emptied from Node with `npm run e2e -- --clear-dir <folder>` (`clearDir` in `evidence.cjs`): only inside a Claude
Code scratchpad, a `hive…` folder in `%TEMP%`, or `hive-test\scratch` or `e2e` outside the lanes and logs; never an area
itself, a CLI test home, a link or what a card cites. Cite evidence a card needs by its full path: it stays until the
card is Done.

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

**The registry's PATH** (unpackaged builds only, #472): Hive adds the folders of the PATH Windows gives new programs to its own before it looks for the CLIs. A test copy (a test profile) never reads the machine's: `HIVE_TEST_REGISTRY_PATH` (`;`-separated folders, none when unset) stands in for it, and a suite can change it while Hive runs, as an installer would (`freshpath`). So a suite's PATH without a CLI (or git, `gitmissing`) stays without it.

**Quiet test copies** (unpackaged builds only): a copy of Hive started with a test profile (`HIVE_USER_DATA`, which every suite sets) is quiet, however it was started (the runner, `node tests/e2e/<suite>.cjs`, a scenario or a Playwright script), and so is one started with `HIVE_TEST_QUIET=1`. `HIVE_TEST_QUIET=0` turns it off, for a suite that needs a real window (listed in `LOUD` in `tests/testQuiet.test.ts`, which fails for a suite that starts Hive without a test profile or turns quiet off unlisted). So the copies of Hive the suites start never interrupt you: their windows open off screen, to the left of your screens, and never take focus (`showInactive`; Chromium's occlusion tracking is off for them, so they still draw), and they raise no Windows notification, taskbar flash or chime (`src/main/testQuiet.ts`; the window still counts a chime, for `window.__hiveChimes`). Set `HIVE_TEST_NOTIFY_LOG=<file>` to have each notification, flash and chime they would have made written there as a JSON line (`{ kind, title, body }`); `bursts` checks its notifications that way. The message Hive shows when it can't start from its install folder (`src/main/installDir.ts`) is recorded there too (`kind: 'dialog'`), and `HIVE_TEST_DIALOG_SNAPSHOT=<png>` draws it off screen to that picture without showing it; `HIVE_TEST_INSTALL_DIR` makes Hive check a test folder's permissions instead of its own folder's (`installdir`). Suites that need a focused window stub it (`inbox`, `progress`, `taskbar`) rather than taking OS focus. Maximising is simulated the same way: `carddialog` gives its off-screen window a screen's work-area size, makes `isMaximized()` say so and emits `maximize`/`unmaximize`, which checks Hive's handling of them (the card kept in the window, the title-bar buttons dimmed) but not Electron's and Windows' own maximise. For that, run it on its own with **`HIVE_E2E_NATIVE=1 node tests/e2e/carddialog.cjs`** (PowerShell: `$env:HIVE_E2E_NATIVE='1'; node tests/e2e/carddialog.cjs`): the same checks with the real `maximize()`/`unmaximize()` in a normal window, which **comes on screen, takes the focus and fills the screen** while it runs, so only when asked. The runner drops `HIVE_E2E_NATIVE`, so full and `--affected` runs stay quiet.

**Tips** are off in every test copy of Hive (`lib.hiveEnv` sets `HIVE_TEST_TIPS=off`, unpackaged builds only: a profile that doesn't set *Show a tip when Hive starts* gets it off), so no tip card covers what a suite clicks. A suite about tips (`tips`) turns them on in its profile.

**A fake Claude Code** (`fake-claude/fake-claude.cmd`) runs agents without signing in or spending tokens: set it as
the profile's Claude Code path (`settings.providers['claude-code'].executablePath`) and start Hive with
`CLAUDE_CONFIG_DIR` pointing at a test folder. It goes through Hive's real Claude Code adapter: it asks to trust a
new folder (Enter trusts it), sends Claude Code's hooks, writes its transcripts, starts on a task given on the
command line, and answers each prompt after a second (`work N` takes N seconds; `edit <file>` makes an Edit, with
its file lock; `pad N` adds N KB to its transcript; `ask` sends a permission prompt; `window N` makes its status line report an N-token context window; `boardmove N COLUMN` moves card N as its hive tools would, and `boardreview N ACTION [COLUMN]` reviews it (both recording the answer in `fake-calls.jsonl`); `background N` starts a background command that ends after N seconds, whose task notification then
starts a turn by itself; `/compact [focus]` compacts (PreCompact, a compaction in the transcript after 1 s or `hold N` seconds, PostCompact; `compactfail` in the focus fails it, and with no messages yet it says "Not enough messages to compact."); it records a conversation's system prompt (the `--append-system-prompt-file`) on its first request and uses that record on resume, as Claude Code does, unless launched with `--system-prompt-snapshot off`, and `whatmode` in a prompt ends its reply with the mode that prompt is in (#334); `--model fail-start` makes it refuse to start, printing an error and exiting with 1). Each launch is recorded in `fake-launches.jsonl` in `CLAUDE_CONFIG_DIR` (its options and
`CLAUDE_CODE_*` variables). `assistant-control`, `context`, `background`, `longsession`, `resumeall`, `cardchip`, `sessionorigin`, `assistantend`, `tipcorner`, `review`, `reorder`, `busy`, `startfail`, `filelinks`, `quitwait`, `rendercrash`, `bursts`, `taskbar`, `ctxpercent`, `donemove`, `doingmove`, `paneheader`, `tabstrip`, `closewindow`, `storage`, `skilldelivery`, `quit`, `windows`, `launchrace`, `resume`, `agents`, `image`, `assistant`, `restart` and `board` use it (`board` also deletes a small test folder, as Delete Project does, and `storage` its fixture images and backups, as Clean Up does: into the suite's own trash folder, below). `codex-background` checks Codex's background
terminals with the real Codex (one short prompt).

**Copilot offline** (`fake-copilot-api.cjs`, #453): no fake CLI, the real one. `startFakeCopilotApi()` starts a scripted stand-in for Copilot's model, an OpenAI-compatible chat completions API on a port of its own; `copilotTestEnv(api, dir)` gives a test Hive the environment for it: Copilot offline in its BYOK mode (`COPILOT_OFFLINE`, `COPILOT_PROVIDER_BASE_URL`, `COPILOT_MODEL=gpt-4.1`), its own `COPILOT_HOME`, a fake profile folder, and the GitHub CLI's login hidden (`GH_CONFIG_DIR` empty, `gh` off PATH: with no stored login Copilot signs in with `gh auth token`). The "model" does a prompt's steps, separated by ` then `, one per request: `skill NAME`, `hive TOOL {json}`, `boardmove`/`boardreview`/`boardcomment`, `work N`, `edit PATH OLD NEW`, `write PATH TEXT`, `shell COMMAND`, `question` (Copilot's ask_user) and `say TEXT` (the last reply). Copilot then runs its own tools, hooks, MCP servers and transcript as it would for a real model; each request is logged with the tools it offered. Never run `copilot login` or `logout` for a test: its sign-in is in Windows Credential Manager, per account, not in `COPILOT_HOME`. `copilot` and `copilotsize` use it; so does `npm run scenarios -- --provider fake-copilot`.

**A fake Codex** (`fake-codex/fake-codex.cmd`) does the same for Codex: set it as `settings.providers.codex.executablePath` and start Hive with `CODEX_HOME` pointing at a test folder (with `[windows] sandbox = "unelevated"` in its `config.toml`, so nothing is left to set up). It reports itself as Codex 0.160.0 (`FAKE_CODEX_VERSION` changes it) and sends Codex's hooks and terminal titles for a few prompts: `review allow` / `review deny` (its auto-reviewer answers a permission request), `approve` (an approval prompt: `y` approves, Esc rejects) and `question` (an async question it works on beside: `a` answers it). `attention` uses it, and so does `skilldelivery` (with the fake Claude Code); each launch is recorded in `fake-launches.jsonl` in `CODEX_HOME` (its folder and arguments).

Print `PASS name` / `FAIL name` per check, and add the suite to `SUITES` in `run.mjs`.

**Agent behaviour** (do agents use Hive's skills and keep its board rules?) is tested by the scenarios in `tests/scenarios` (`npm run scenarios`), which reuse `lib.cjs` and the fake CLIs, with opt-in model trials: see its README.
