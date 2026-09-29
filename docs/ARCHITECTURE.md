# Hive Architecture

This document explains how Hive is put together, for anyone changing the code. Product decisions live in [SPEC.md](SPEC.md).

## Processes

```
┌──────────────────────────── Electron main process ───────────────────────────┐
│ index.ts        app lifecycle, window, quit flow, settings side-effects      │
│ workspace.ts    open workspace, .hive folders, project list, git exclude     │
│ sessions.ts     launch/stop sessions, status from hooks, backups, usage      │
│ agents/         AgentAdapter interface + ClaudeCodeAdapter, transcript parser│
│ ptyHost.ts      node-pty processes, output buffers                           │
│ servers.ts      hook server (random port) + Agent API (configured port)      │
│ skills.ts mcp.ts notes.ts git.ts files.ts   feature services                 │
│ ipc.ts          typed IPC handlers        tray.ts   system tray              │
│ updater.ts      Hive's own updates (electron-updater, GitHub Releases)       │
└──────────────┬───────────────────────────────────────────────▲──────────────┘
               │ IPC (preload bridge: window.hive)              │ HTTP hooks
┌──────────────▼───────────────┐                  ┌────────────┴─────────────┐
│ Renderer (React + zustand)   │                  │ claude (Claude Code CLI) │
│ xterm.js terminals, Monaco   │◄── pty output ───│ one per running session  │
└──────────────────────────────┘                  │  └─ hive MCP server ─────┼──► Agent API
                                                  └──────────────────────────┘
```

- The **renderer** never touches the filesystem or processes. Every request goes through `window.hive.invoke(channel, …)`; channels and their types are declared once in `src/shared/api.ts` (`HiveRequests`) and implemented in `src/main/ipc.ts`, so both sides are type-checked against the same contract.
- **Events** flow the other way through `emit()` in `src/main/events.ts` (`HiveEvent` in `src/shared/types.ts`). The Agent API's SSE stream subscribes to the same events.
- **Files tab** operations live in `files.ts`; every path is resolved against the project and refused if it escapes it. Deletes use `shell.trashItem`. While a Files or Images tab is open, a reference-counted recursive `fs.watch` sends `files-changed` events with the changed folders (not forwarded to the Agent API).
- **File editor**: `components/FileView.tsx` holds the previewer registry (`PREVIEWERS`: match by file name, whether it needs the text, whether it is editable, default view). `files:read`/`files:write` in `files.ts` do the I/O; writes pass the modified time they started from and fail with `CONFLICT` if the file changed. `CodeEditor` ignores values it emitted itself, so React lagging behind fast typing can't overwrite newer keystrokes.
- **Images** are shown through the privileged `hive-img:` protocol (`hive-img://img/<encoded path>`), which only serves image and PDF files inside the workspace; the CSP allows it in `img-src` and `frame-src`. `webPreferences.plugins` is on for Chromium's PDF viewer.
- **Pty output** goes over its own `pty:data` channel for throughput. The main process keeps the last 512 KB per pty so a reloaded window can replay it.

## Launching a session

`sessions.start()`:

1. Resolves effective settings (`effective()`): workspace-enabled skills and MCP servers minus the project's opt-outs, plus model, effort, permission mode and args. Bypass is downgraded unless the global opt-in is on.
2. Restores the transcript from `.hive/sessions` if resuming and Claude Code no longer has it.
3. `ClaudeCodeAdapter.prepareLaunch()` rebuilds `Project/.hive/launch/` from scratch:
   - `plugin/` — a session-only Claude Code plugin containing copies of the enabled skills (`--plugin-dir`)
   - `mcp.json` — enabled servers plus the built-in `hive` server (`--mcp-config … --strict-mcp-config`)
   - `settings.json` — HTTP hooks pointing at Hive's hook server (`--settings`); `SessionStart`, which can't be an HTTP hook, is a `curl.exe` command posting to the same server
4. Spawns `claude` in a pty with `--session-id` (new) or `--resume` (existing), so Hive always knows the session ID and therefore the transcript path.
5. Records a **launch signature** (hash of the effective settings). `liveInfo()` compares it with the current settings to show "restart to apply".

## Status

Claude Code calls the hook server for `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Notification`, `Stop`, `PreCompact` and `SessionEnd`. The hook token is passed to the pty as `HIVE_HOOK_TOKEN` and referenced from `settings.json` through `allowedEnvVars`, so it is never written to disk. `handleHook()` maps events to `SessionStatus`, triggers the chime and desktop notifications, and marks events unseen when the window isn't in focus.

## Usage

`agents/transcript.ts` parses Claude Code's JSONL transcripts (`~/.claude/projects/<encoded path>/<session>.jsonl`):

- usage is summed once per API request (Claude Code writes one entry per content block with repeated usage);
- context size is the last request's `input + cache_read + cache_creation`, or `postTokens` after a compaction;
- compactions come from `system/compact_boundary` entries;
- the cache TTL is detected from `ephemeral_1h_input_tokens`.

Results are cached by file mtime and size. While a session runs, a 5-second poll copies the transcript to `.hive/sessions` and emits `usage-changed`.

## Status line and plan usage

Hive's generated `launch/settings.json` sets Claude Code's `statusLine` to a `curl.exe` command that posts the status JSON to `/hook?statusline` on the hook server, which replies 204 (an empty status line). `sessions.handleStatusLine` copies effort, model name and cost into the live state; `planUsage.ts` parses `rate_limits`, stores the report in `config.json`, emits `plan-usage`, and raises the 80%/95% warnings once per reset period.

## Transcript viewer

The Sessions tab reads the conversation itself through `transcripts.ts` (IPC `transcript:*`). `agents/conversation.ts` has `ConversationParser`, which turns JSONL entries into display items: user messages, replies, thinking, tool calls (matched to their `tool_result` by id), slash and `!` commands with output, notices, and compactions (the `isCompactSummary` message becomes the divider's summary; the next request's usage gives its real size). Sidechain entries, meta messages and attachments are skipped.

Transcripts are append-only, so the parser is incremental: `feed()` takes the bytes after its offset and stops at the last newline, leaving a line Claude Code is still writing for next time. `transcripts.ts` keeps a parser per session (LRU of six), reads only the new bytes when the file grows, and starts again if the file is replaced (for example by Hive's backup). `transcript:read` returns null when the size hasn't changed, which is what the viewer polls every 2 seconds for a running session. Tool input and output are shortened to 4,000 characters for display; `transcript:tool` returns the full call. Images are not sent with the items: the parser records each image's line range, and `transcript:image` reads that line and returns a data URL. Search (`searchItems`) and Markdown export (`transcriptMarkdown`) work on the full items in main.

## Agents in a project

A project has up to four agents (`ProjectConfig.agents`, with `projectAgents()` in `shared/defaults.ts` always putting Agent 1, id `main`, first). `SessionManager` keys live sessions by project + agent id; Agent 1's terminal keeps the old key `session:<project>` and the others add `#<id>` (`agentPtyKey`). Hooks and the status line already carry `session_id`, so they find their agent without any routing. `ProjectInfo.agents` carries each agent's definition and live state; `ProjectInfo.live` stays as Agent 1's (else the first running) session for older callers. The renderer keeps the focused agent and pane assignment per project in the store (`focusedAgent`, `paneAgents`, `paneAssignment`, `showAgent`) and derives the single project dot with `mostUrgent`.

- **Launch**: each agent has its own launch folder (`launch/` or `launch-<id>/`) because `prepareLaunch` replaces the folder. The pty's cwd is the agent's worktree when it has one. A worktree's setup command runs first in the same pty key (`quietExit`, so the renderer doesn't see an exit), then Claude Code continues in that terminal with the setup output carried over (`continueBuffer`).
- **Transcripts**: Claude Code files transcripts by folder, so a worktree agent's live in another `~/.claude/projects` folder. Session records keep `agentId`, `cwd` and `branch`, and `sessions.claudeTranscript()` looks in the record's folder, the project folder and every agent's worktree. Backups and images stay in the project's `.hive`.
- **File locks**: `sessions.preToolUse()` answers the `PreToolUse` hook (matcher `Edit|Write|MultiEdit|NotebookEdit`) synchronously in the hook server. Locks are a map from absolute path to the holding session, released on `Stop`, `SessionEnd`, exit or after 15 minutes; held files are published as `LiveSessionState.lockedFiles`.
- **Worktrees**: `main/worktrees.ts` wraps git (`worktree add/list/remove`, branch status, `merge-tree` conflict check, squash or `--no-ff` merge with `reset --merge` on failure, copying ignored files by pattern). `main/projectAgents.ts` adds, updates, removes and merges agents. `workspace.assertRoot()` accepts a project or a registered agent worktree, so the Files and Changes IPC can work in worktrees; `git:status`/`git:diff` take a base branch and compare with the merge base.
- **Rendering**: `components/AgentPanes.tsx` has the agent strip, `TerminalLayer` (every agent terminal of every project stays mounted and is positioned into its pane) and the pane frames drawn over it. `TerminalView` holds a WebGL renderer only while visible, within a window-wide budget (`WEBGL_BUDGET`, 8): a terminal that becomes visible takes the context of the longest-hidden one if the budget is used up, and hidden ones release theirs after 30 seconds anyway. Chromium's own limit is about 16 contexts per window, beyond which it silently drops the oldest.

## Adding another agent adapter

1. Implement `AgentAdapter` (`src/main/agents/types.ts`) — locate, install/update commands, `prepareLaunch`, `buildCommand`, transcript and memory locations.
2. Translate Hive's neutral skill folders and MCP definitions into the agent's own format in `prepareLaunch`.
3. Map the agent's lifecycle signals to `handleHook()` (or poll its logs).
4. Add an `agent` field choice to project settings.

The rest of Hive (projects, sessions list, terminals, notes, API) is agent-neutral.

## Renderer structure

| Path | Purpose |
|---|---|
| `store.ts` | zustand store: data from main plus UI state |
| `commands.ts` | every command with label, category and keybinding — drives menus, palette and shortcuts |
| `actions.ts` | user flows with confirmations and error toasts |
| `components/` | shell (title bar, activity bar, status bar, sidebar), overlays, terminal, editors |
| `views/` | project view and tabs, settings, notes, skills, MCP, docs, welcome |

Terminals use xterm.js's WebGL renderer with `rescaleOverlappingGlyphs`, so symbols drawn from a wider fallback font (such as the close button in Claude Code's panels) are squeezed into their cell instead of being half painted over; the DOM renderer is the fallback if WebGL is unavailable. The terminal mounts in an unpadded child of its host, because the fit addon measures the parent.

Terminals for every project that has had a session stay mounted (hidden) so switching projects is instant and keeps scrollback.

## Windows app identity

The installed app uses the app user model ID `com.hive.desktop` (the Start menu and desktop shortcuts carry it, and each window sets it with `setAppDetails`), which gives the taskbar button and notifications the Hive name and icon. Dev and test builds run as `electron.exe` and use `com.hive.desktop.dev`, registered under `HKCU\Software\Classes\AppUserModelId` as "Hive Dev". Sharing one ID made Windows show Electron's name and icon for the installed Hive.

## Packaging and updates

`electron-builder.yml` builds an NSIS installer. `@lydell/node-pty` ships prebuilt N-API binaries (no native rebuild), unpacked from the asar archive together with `out/main/hive-mcp.js`, which Claude Code runs through Hive's executable with `ELECTRON_RUN_AS_NODE=1`.

`updater.ts` wraps electron-updater. It turns off electron-updater's own auto-download and starts downloads itself, so *Download automatically* and skipped versions are honoured; `autoInstallOnAppQuit` follows *Install updates*. State changes go to the renderer as `update-state` events (`UpdateState`); the status bar item, update dialog, About and Settings (`components/Updates.tsx`) all render from that one state. **Restart and Update** sets a flag and calls the normal `requestQuit()`; `quitNow()` ends with `installNow()` (`quitAndInstall(silent, runAfter)`) instead of `app.quit()`, so the quit dialog, *wait for agents* and transcript backups all still apply. With `HIVE_UPDATE_FEED` (unpackaged builds only) the updater uses a generic feed from a config file in the profile, a separate download cache (`hive-test-updater`), and never installs. Releases are published by `scripts/release.mjs` — see `RELEASING.md`.

## Permission mode of a running session

`LiveSessionState.permissionMode` is what the session is really in. It starts as the launch mode and is updated from two sources: `watchModeOutput()` in `sessions.ts` keeps a 600-character tail of the terminal output (control sequences replaced by spaces) and reads Claude Code's footer with `footerMode()` (`shared/defaults.ts`), and `handleHook()` reads `permission_mode` from every hook. `setPermissionMode()` writes Shift+Tab (`ESC [ Z`) and waits up to 1.5 s per press for the footer to change, stopping when the target shows, the mode stops changing or the cycle comes round again. `canSwitchLive()` says which targets need `restartInMode()` instead (stop, wait for exit, `start({ resumeId, permissionMode })`). The permission mode is left out of the launch signature, so a changed setting doesn't raise "restart to apply"; instead `liveInfo()` calls `noticeModeSetting()`, which compares the effective mode with the one the session was configured with and, once per change, batches a "Switch Now" toast (`session.applyPermissionModes` → `applyModeSettings()`).

## Keyboard shortcuts

`Command.keybinding` in `commands.ts` is the default. `commandKeybinding(id)` resolves the one in force with `resolveKeybinding()`: the selected project's `config.keybindings` (only for categories in `PROJECT_KEYBINDING_CATEGORIES`), then `settings.keybindings`, then the default; `null` means none. Everything that shows or matches shortcuts (palette, menus, tooltips, `matchKeybinding`, the terminal's `isAppShortcut`) goes through it. `eventToKey()` names keys by `KeyboardEvent.code`. The editor (`components/Keybindings.tsx`) records in a capturing keydown listener and sets `recordingKeys` so the global handler in `App.tsx` stands aside. Global overrides are written with `settings:setKeybinding` (the settings deep merge can't delete a key); project ones replace the project's whole `keybindings` object.
