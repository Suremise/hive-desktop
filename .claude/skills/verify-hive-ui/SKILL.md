---
name: verify-hive-ui
description: Check a change to Hive's window works by driving the real app - build the exact code under review, run the matching end-to-end suites or a short Playwright script in a throwaway profile, and look at screenshots. Use when developing or reviewing Hive and a change affects what the user sees or clicks, or when source and running behaviour seem to disagree.
---

# Verify Hive's UI

Unit tests don't show what the user sees. This is how to see it without touching a real Hive.

## Build what you are checking

- Build the code under review, in its own worktree: `npx electron-vite build` there. Suites run `out/` of the folder they're started from, so a build from another branch tests something else.
- When behaviour and source disagree, first find out which build ran. The installed Hive (`%LOCALAPPDATA%\Programs\Hive`) and a dev build are different code. `GET /v1/status` gives `app.version` and `guidance.revision`, and `/v1/projects/{name}` gives each running agent's `launched` revisions.
- Clear `ELECTRON_RUN_AS_NODE` from the shell first. With it set, `electron.exe` runs as plain Node.

## Choose the suites

[tests/e2e/README.md](../../../tests/e2e/README.md) lists them, with what each needs. Run them through the runner, which turns tips off and keeps logs: `npm run e2e -- <suite> <suite>`.

- Pick the suites for the feature you changed (`board`, `review`, `cardchip` for the task board; `assistant*` for the Assistant; `skills` for skills). Not every suite for a CSS change.
- Prefer the fake Claude Code and fake Codex (no sign-in, no tokens). Real-CLI suites cost tokens; Codex ones need the test home, which the user signs in to once. Warn the user before anything that may open a browser sign-in, and never press keys on a CLI's login screen.
- Suites that share a port or a test folder run one after another: the runner does that, so don't start two runners at once.
- Each suite works in `%LOCALAPPDATA%\hive-test\e2e` (`HIVE_E2E_DIR`), with its own `HIVE_USER_DATA` profile and workspace. Never point a test at the user's profile, clipboard, `~/.claude` or `~/.codex`.

## A one-off check

Start from an existing suite and its `lib.cjs` helpers (`launch`, `fitWindow`, `addAgent`, `gitProject`). In the page, `window.hive.invoke(channel, …)` calls any IPC channel. Then:

- **Click what the user clicks.** Use Playwright's own clicks, which check hit-testing: an element covered by an overlay, a dialog or a tip fails the click, as it would for the user. `elementFromPoint` at the target's centre tells you what's on top.
- **Look at screenshots** (`page.screenshot`), and read them; don't only save them. Check light and dark themes, a narrow window and zoom when layout changed, and nested overlays (a dialog over a panel over a pane).
- **Drag and drop**: Playwright drops only on a mouse-up straight after a move, and sends few dragover events, so move in small steps.

## Cleaning up

Stop only what you started: test Electron processes are found by their test profile in the command line (`hive-test\e2e\<suite>-profile`) or Playwright's `--remote-debugging-port=0`. Never kill `Hive.exe` or `electron.exe` by name: the installed Hive hosting this session is one of them.

## Report

Say what you ran (suites, builds, commits), what passed, what failed with the key line, and what you couldn't check (a real CLI suite skipped, a packaged-only behaviour).
