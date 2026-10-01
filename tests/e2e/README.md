# End-to-end suites

Each suite starts the dev build of Hive with Playwright's `_electron`, in a throwaway profile and workspace, and
checks a feature the way a user would use it. They run on your machine, not in CI: they need the real CLIs.

```bash
npx electron-vite build          # the suites run the dev build in out/
npm run e2e                      # every suite (the packaged ones only with --packaged)
npm run e2e -- agents transcript # just these
npm run dist && npm run e2e -- --packaged   # also the installed-app suites (dist/win-unpacked)
```

A suite passes when it exits cleanly and prints no `FAIL` line. The runner prints a summary; each suite's output
is kept in `logs/` under the work folder.

## What they need

- **Claude Code**, installed and signed in. Suites that start sessions (`agents`, `image`, `mode`, `plan`,
  `compact`, `restart`, `resume`, `quit`, `agentview`, `windows`, `launchrace`, `assistant`) never send it a prompt. The first run in a test folder answers Claude
  Code's "trust this folder" question (never a sign-in screen), so later runs don't ask.
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
- `enableProviders()` for the profile, `launch()`;
- `addAgent()` / `soloAgent()`: projects start without agents;
- `acceptClaudeTrust()`, `trustForCodex()`, `gitProject()`, `samplePng()`.

**Slow or failing calls** (unpackaged builds only): `HIVE_TEST_SLOW_IPC="tasks:start=2000,git:diff=3000*1"` delays those IPC calls (`*n`: only the first n) and `HIVE_TEST_FAIL_IPC="git:status*1"` makes them fail. Hive reads them again when they change, so a suite can set them in the main process while it runs (`app.evaluate(() => { process.env.HIVE_TEST_SLOW_IPC = '…' })`). `busy` and `changes` use them.

**A fake Claude Code** (`fake-claude/fake-claude.cmd`) runs agents without signing in or spending tokens: set it as
the profile's Claude Code path (`settings.providers['claude-code'].executablePath`) and start Hive with
`CLAUDE_CONFIG_DIR` pointing at a test folder. It goes through Hive's real Claude Code adapter: it asks to trust a
new folder (Enter trusts it), sends Claude Code's hooks, writes its transcripts, starts on a task given on the
command line, and answers each prompt after a second (`work N` takes N seconds; `edit <file>` makes an Edit, with
its file lock; `pad N` adds N KB to its transcript; `background N` starts a background command that ends after N seconds, whose task notification then
starts a turn by itself). `assistant-control`, `background`, `longsession`, `resumeall`, `cardchip`, `reorder`, `busy` and `board` use it (`board` also sends a small test folder to the Recycle Bin, as Delete Project does). `codex-background` checks Codex's background
terminals with the real Codex (one short prompt).

Print `PASS name` / `FAIL name` per check, and add the suite to `SUITES` in `run.mjs`.
