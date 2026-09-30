# Hive Architecture

This document explains how Hive is put together, for anyone changing the code. Product decisions live in [SPEC.md](SPEC.md).

## Processes

```
┌──────────────────────────── Electron main process ───────────────────────────┐
│ index.ts        app lifecycle, window, quit flow, settings side-effects      │
│ workspace.ts    open workspace, .hive folders, project list, git exclude     │
│ sessions.ts     launch/stop sessions, status from hooks, backups, usage      │
│ providers/      ProviderAdapter registry; claude/ and codex/ adapters        │
│ providerService.ts  each provider's install info, setup tasks                │
│ ptyHost.ts      node-pty processes, output buffers                           │
│ servers.ts      hook server (random port) + Agent API (configured port)      │
│ skills.ts mcp.ts notes.ts git.ts files.ts   feature services                 │
│ ipc.ts          typed IPC handlers        tray.ts   system tray              │
│ updater.ts      Hive's own updates (electron-updater, GitHub Releases)       │
└──────────────┬───────────────────────────────────────────────▲──────────────┘
               │ IPC (preload bridge: window.hive)              │ HTTP hooks
┌──────────────▼───────────────┐                  ┌────────────┴─────────────┐
│ Renderer (React + zustand)   │                  │ claude / codex CLIs      │
│ xterm.js terminals, Monaco   │◄── pty output ───│ one per running session  │
└──────────────────────────────┘                  │  └─ hive MCP server ─────┼──► Agent API
                                                  └──────────────────────────┘
```

- The **renderer** never touches the filesystem or processes. Every request goes through `window.hive.invoke(channel, …)`; channels and their types are declared once in `src/shared/api.ts` (`HiveRequests`) and implemented in `src/main/ipc.ts`, so both sides are type-checked against the same contract.
- **Events** flow the other way through `emit()` in `src/main/events.ts` (`HiveEvent` in `src/shared/types.ts`). The Agent API's SSE stream subscribes to the same events.
- **Several windows** (`windows.ts`): each `BrowserWindow` has its own `WorkspaceService` (`createWorkspaceService()` in `workspace.ts`). The `workspace` everyone imports is a stand-in: a method given a project or worktree path goes to the workspace owning it (`workspaceFor()`), anything else to the workspace of the current work, set with `inWorkspace()` (AsyncLocalStorage) by `registerIpc` (the calling window's), the Agent API (the request's: `X-Hive-Workspace`, `?workspace=`, or the only one open) and `sessions.effective()`; without one, the last focused window's (logged once, as it means a call site forgot to say). Background work that knows its project uses `workspaceOf(projectPath)`. `emit()` asks the router in `windows.ts` where an event goes: a project's to the window showing it, a workspace's to its window (or the calling one), app-wide ones to all; `emitTo(win, …)` targets one. Terminal output goes by the pty key (`session:<project>#<agent>` to its window, task terminals to all). Quitting and closing a window (`index.ts`) ask in the window concerned (`HiveWindow.question`); each window reports its own unsaved files.
- **Files tab** operations live in `files.ts`; every path is resolved against the project and refused if it escapes it. Deletes use `shell.trashItem`. While a Files or Images tab is open, a reference-counted recursive `fs.watch` sends `files-changed` events with the changed folders (not forwarded to the Agent API).
- **Unsaved edits** (drafts) live in a module-level map in `FileView.tsx`, keyed by absolute path, with the root and relative path for saving. The Files tab calls `moveDrafts()` after renames and moves and `discardDrafts()` after deletes; `saveAllDrafts()` saves them all, refusing conflicts. Every change of the set is reported to main (`files:setUnsaved`), which makes `requestQuit()` ask and sends the list with `quit-request`; the quit dialog saves or discards before answering. `actions.saveUnsavedFirst()` guards Reload Window and workspace switches.
- **Writes that repeat**: plan usage from the status line is kept in memory and saved only when a shown value changes, at most once a minute (`planUsage.ts`); transcript backups copy at most once a minute during a turn, plus at `Stop` and exit (`BACKUP_INTERVAL_MS` in `sessions.ts`).
- **File editor**: `components/FileView.tsx` holds the previewer registry (`PREVIEWERS`: match by file name, whether it needs the text, whether it is editable, default view). `files:read`/`files:write` in `files.ts` do the I/O; writes pass the modified time they started from and fail with `CONFLICT` if the file changed. `CodeEditor` ignores values it emitted itself, so React lagging behind fast typing can't overwrite newer keystrokes.
- **Images** are shown through the privileged `hive-img:` protocol (`hive-img://img/<encoded path>`), which only serves image and PDF files inside the workspace; the CSP allows it in `img-src` and `frame-src`. `webPreferences.plugins` is on for Chromium's PDF viewer.
- **Hive's own files**: `writeJsonAtomic`/`writeTextAtomic` (`fsutil.ts`) write a uniquely named temp file and rename it (retrying briefly while Windows holds the target). Changes that read a file and write it back go through `withFileLock`: use `workspace.mutateProjectConfig()` / `updateAgent()` for `project.json` and `workspace.mutateSessions()` / `upsertSession()` for `sessions.json`, never read-then-`updateProjectConfig` with a value computed outside the lock (one provider's project settings: `project:updateProvider`, which merges under the lock). The files Hive keeps are read with `readKeptJson()` and written with `writeKeptJson()`, which also writes `<file>.bak`; an unreadable file is set aside (`<file>.corrupt-<time>`), the `.bak` restored and `onCorruptFile` (a notification, set up in `index.ts`; startup reports wait for the window) told.
- **IPC** is accepted only from a Hive window's top-level frame (`registerIpc`), provider ids are checked (`knownProvider`), and `index.ts` refuses every permission request except the clipboard's. A build's CSP drops the dev server's `ws:`/`localhost` (`hive-production-csp` in `electron.vite.config.ts`).
- **File IPC** (`file:read`, `file:write`, open/reveal): paths must be in the workspace or its worktrees (checked by their real location too: `insideReal()` in `fsutil.ts`, also used by `hive-img:` and shared notes), or be one of the provider files Hive shows (each adapter's `fileAllowed()`: Claude Code's user `CLAUDE.md` and auto memory, Codex's user `AGENTS.md`, read-only `SKILL.md`).
- **Session IDs** are validated with `assertSessionId()` (`shared/defaults.ts`) wherever they reach a path: `sessions.start/usage/archive/rename/adopt`, `backupPath`, each adapter's `transcriptPath`, the transcript viewer.
- **Pty output** goes over its own `pty:data` channel for throughput. The main process keeps the last 512 KB per pty so a reloaded window can replay it.

## Providers

A provider is a **descriptor** (`src/shared/providers.ts`, plus `shared/claude.ts` and `shared/codex.ts`; static data used by both processes: names, icon, permission modes, efforts, models, capabilities, reserved terminal keys, instructions file) and an **adapter** (`src/main/providers/<id>/adapter.ts`, `ProviderAdapter` in `providers/types.ts`). `providers/index.ts` is the registry (`allProviders()`, `providerAdapter(id)`). Shared helpers resolve settings: `providerSettings`, `projectProviderConfig`, `agentProvider` (agent → project default → global default), `agentLaunchSettings` (model, effort and an allowed mode), `isProviderEnabled`. The UI reads descriptors and never switches on a provider id; capabilities (`liveModeSwitch: 'cycle' | 'menu'`, `planModeToggle`, `reportsCost`, `promptCacheTtl`, `compactFocus`, `imagePaste`…) turn features on and off.

Adding a provider: a descriptor added to `PROVIDERS`, an adapter added to the registry, an icon in `renderer/src/assets/providers/`, prices in `shared/prices.ts`, a `migrate…` step if settings change shape, and tests. Nothing else should need to change; if it does, move that knowledge into the descriptor or adapter.

- **Settings**: `AppSettings.providers[id]` (`ProviderSettings`) and `defaultProvider`; `ProjectConfig.providers[id]` and `defaultProvider`. `migrateConfig()`/`migrateProjectConfig()` in `shared/defaults.ts` read 0.1 files; `withLegacySettings()`/`withLegacyProjectFields()` keep writing the 0.1 fields, and `config.ts` backs the 0.1 file up once.
- **Runs**: each launch gets a `runId` (`LiveSessionState.runId`, `sessions.runs`). Hook and status-line URLs carry `?run=<runId>`, so `findLaunch()` finds the agent even before a provider reports its session id (Codex does so with the first prompt; `recordSession()` then writes the record, including `transcriptPath`).
- **Hooks**: `adapter.normalizeHook()` turns each CLI's JSON into a `NormalizedHook` (session id, transcript path, mode, and an event of kind start / prompt / toolStart / toolEnd / needsInput / stop / interrupt / compactStart / compactEnd / end); `handleHook()` only sees those. `adapter.lockReply()` shapes the file-lock answer.
- **Live details**: Claude Code posts its status line (`handleStatusLine`); Codex's model, effort, context window, plan limits, preset and Plan mode come from the rollout tail (`readDetails()` → `adapter.transcriptDetails()`, from `detailsOffset`). Both end in `applyDetails()` and `reportPlanUsage(provider, usage)`.
- **Mode switching**: `liveModeSwitch: 'cycle'` sends Shift+Tab until the footer (`adapter.footerMode`) shows the target (Claude Code); `'menu'` types the adapter's `modeMenuKeys()` (Codex: Ctrl+U, `/permissions`, arrows, Enter). `setPlanMode()` sends `planToggleKey`.
- **Readiness and setup**: `adapter.readiness()` returns `ReadinessIssue`s (not installed, signed out, sandbox) with a task; `providerService.runProviderTask()` runs install/login/update/setup in a visible terminal, typing `CommandSpec.keys` once `readyPattern` shows (Codex's sandbox setup, through `/permissions`).
- **Cost**: `shared/prices.ts` (`SHIPPED_PRICES`, `modelPrice()`, `estimateCost()`) prices sessions without a reported cost; user prices (`ProviderSettings.prices`) win. `usageFor()` fills `costUsd`/`costEstimated`, and price changes clear the usage cache.

### Codex

`providers/codex/adapter.ts` launches `codex [resume <id>] --no-daemon` with `-c` overrides only (it never writes Codex's config): hooks and their trust records (`hookOverrides()`, `hookHash()`: sha256 of the sorted-key JSON of the hook identity, checked once per Codex version against the app server's `hooks/list`), model and effort, the preset flags (`CODEX_MODE_FLAGS`), `developer_instructions` (the hive MCP server's instructions, `shared/hiveGuidance.ts`), `mcp_servers.<name>` tables (`codexMcpServer()`) and `.enabled=false` for the user's and the project's own servers. Skills are copied to `<cwd>/.agents/skills/hive-*` (`syncSkills()`), excluded from git; each copy has a `.hive-copy` marker with the source hash, so only Hive's copies are replaced or removed and unchanged ones aren't copied again. Live preset switches type `/permissions` and the preset's number (`modeMenuKeys`); `sessions.setPermissionMode()` shows `modeSwitching` until `modeFromOutput()` reads Codex's confirmation or the rollout's settings say so. `listModels()` reads `codex debug models` for the model picker (`AgentInstallInfo.models`). SessionStart only arrives with the first prompt, so `readyOutput` (the composer's placeholder) marks the agent ready. `providers/codex/rollout.ts` parses rollouts: usage (`parseRollout`), live details (`rolloutDetails`, `rolloutPlanUsage`), the Sessions tab conversation (`CodexConversationParser`, including code-mode `exec` calls to `tools.apply_patch`), and `patchPaths()` for file locks.

## Hand Over to…

`sessions.handOver(project, from, to, { handover })` optionally types a handover request into the source (`sendPrompt()`: Ctrl+U, text, Enter) and waits until `sessions.latestHandover()` (set in `index.ts` from the shared notes) shows a newer handover for the project, failing if the agent finishes, asks or stops without one; starts the target if it isn't running and waits for **ready**; types the pick-up prompt; then writes `handedOverFrom` on the target's session record once its id is known. The renderer's `HandOverDialog` (`AgentDialogs.tsx`) and `POST /v1/projects/{name}/handover` call it.

## Launching a session

`sessions.start()` (Claude Code shown; Codex differs as above):

1. Resolves effective settings (`effective()`, run in the project's workspace): every Hive skill in the workspace, the workspace-enabled MCP servers minus the project's opt-outs, plus model, effort, permission mode and args. Bypass is downgraded unless the global opt-in is on.
2. Restores the transcript from `.hive/sessions` if resuming and Claude Code no longer has it.
3. `adapter.prepareLaunch()` — for Claude Code, rebuilds `Project/.hive/launch/` from scratch:
   - `plugin/` — a session-only Claude Code plugin containing copies of the Hive skills (`--plugin-dir`)
   - `mcp.json` — enabled servers plus the built-in `hive` server (`--mcp-config … --strict-mcp-config`)
   - `settings.json` — HTTP hooks pointing at Hive's hook server (`--settings`); `SessionStart`, which can't be an HTTP hook, is a `curl.exe` command posting to the same server
4. Spawns `claude` in a pty with `--session-id` (new) or `--resume` (existing), so Hive always knows the session ID and therefore the transcript path.
5. Records a **launch signature** (hash of the effective settings). `liveInfo()` compares it with the current settings to show "restart to apply".

## Status

Claude Code calls the hook server (URL `?run=<runId>`) for `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Notification`, `Stop`, `PreCompact` and `SessionEnd`. The hook token is passed to the pty as `HIVE_HOOK_TOKEN` and referenced from `settings.json` through `allowedEnvVars`, so it is never written to disk. `handleHook()` maps the normalised events to `SessionStatus`, triggers the chime and desktop notifications, and marks events unseen when the window isn't in focus.

## Usage

Each adapter's `parseUsage()` reads its transcripts into `SessionUsage` (Codex: `codex/rollout.ts`). `providers/claude/usage.ts` parses Claude Code's JSONL transcripts (`~/.claude/projects/<encoded path>/<session>.jsonl`):

- usage is summed once per API request (Claude Code writes one entry per content block with repeated usage);
- context size is the last request's `input + cache_read + cache_creation`, or `postTokens` after a compaction;
- compactions come from `system/compact_boundary` entries;
- the cache TTL is detected from `ephemeral_1h_input_tokens`.

Results are cached by file mtime and size. While a session runs, a 5-second poll checks the transcript (copied to `.hive/sessions` at most once a minute during a turn) and emits `usage-changed`; for providers without a reported cost, the estimate (a full parse) is worked out at most every 30 seconds and at turn ends. `sessions.list()` reads `sessions.json` and `project.json` once for the whole list (`ListContext`); the Codex adapter reuses its rollout listing for 10 seconds and remembers missing rollouts for a minute. In the renderer, `useSessions()` (Overview, Sessions tab) reloads per `settings.sessions.overviewRefresh`: live at most every 15 seconds, every minute, or on Refresh. A large transcript with no requests at all raises a one-time "may not understand this version" notice (`checkUnderstood`).

## Status line and plan usage

Hive's generated `launch/settings.json` sets Claude Code's `statusLine` to a `curl.exe` command that posts the status JSON to `/hook?statusline` on the hook server, which replies 204 (an empty status line). `sessions.handleStatusLine` copies effort, model name and cost into the live state; `planUsage.ts` parses `rate_limits`, stores the report in `config.json`, emits `plan-usage`, and raises the 80%/95% warnings once per reset period.

## Transcript viewer

The Sessions tab reads the conversation itself through `transcripts.ts` (IPC `transcript:*`), with the parser of the session's provider (`adapter.conversationParser()`). `providers/claude/conversation.ts` has Claude Code's `ConversationParser`, which turns JSONL entries into display items: user messages, replies, thinking, tool calls (matched to their `tool_result` by id), slash and `!` commands with output, notices, and compactions (the `isCompactSummary` message becomes the divider's summary; the next request's usage gives its real size). Sidechain entries, meta messages and attachments are skipped.

Transcripts are append-only, so the parser is incremental: `feed()` takes the bytes after its offset and stops at the last newline, leaving a line Claude Code is still writing for next time. `transcripts.ts` keeps a parser per session (LRU of six), reads only the new bytes when the file grows, and starts again if the file is replaced (for example by Hive's backup). `transcript:read(project, id, { knownSize, from })` returns the items from `from` on (by default the latest `TRANSCRIPT_WINDOW`, 200) with the total, or null when the size hasn't changed; the viewer loads earlier windows as you scroll up (keeping its distance from the bottom), and polls every 2 seconds for a running session only with Follow on (`settings.sessions.followTranscripts`). Tool input and output are shortened to 4,000 characters for display; `transcript:tool` returns the full call. Images are not sent with the items: the parser records each image's line range, and `transcript:image` reads that line and returns a data URL. Search (`searchItems`) and Markdown export (`transcriptMarkdown`), in `providers/conversation.ts`, work on the full items in main for every provider.

## Agents in a project

A project has up to four agents, all equal (`ProjectConfig.agents` as added; `projectAgents()` in `shared/defaults.ts`), and a new one has none. Ids are random (`a-<hex>`, `projectAgents.addAgent`) so session records of a removed agent never attach to a new one, and the provider is stored at once. `migrateProjectConfig()` clears 0.1's agents and layout (project.json version 2). Calls that name no agent use the project's only one (`sessions.soleAgent()`; the Agent API answers 400/409 otherwise), and the renderer's `focusedAgentId()` is null without agents: `actions.quickAddAgent()` adds one (the default provider, if on and installed; else the Add Agent dialog), which New Session and Resume use. Adding sets `sessionLayout` from the count (`layoutForAgents`). `SessionManager` keys live sessions by project + agent id; terminals are `session:<project>#<id>` (`agentPtyKey`). Hooks and the status line carry the launch's `runId` (and `session_id`), so they find their agent without any other routing; a prompt hook with another session id for the same run moves the agent to that conversation (`switchSession`). `resumeRecord()` offers an agent its own sessions, then sessions no current agent owns. `ProjectInfo.agents` carries each agent's definition and live state; `ProjectInfo.live` is the first running agent's session. The renderer keeps the focused agent and pane assignment per project in the store (`focusedAgent`, `paneAgents`, `paneAssignment`, `showAgent`) and derives the single project dot with `mostUrgent`.

- **Launch**: each Claude Code agent has its own launch folder (`launch-<id>/`) because `prepareLaunch` replaces the folder. The pty's cwd is the agent's worktree when it has one. A worktree's setup command runs first in the same pty key (`quietExit`, so the renderer doesn't see an exit), then Claude Code continues in that terminal with the setup output carried over (`continueBuffer`).
- **Transcripts**: Claude Code files transcripts by folder, so a worktree agent's live in another `~/.claude/projects` folder. Session records keep `agentId`, `cwd` and `branch` (and, for Codex, `transcriptPath`), and `sessions.providerTranscript()` looks in the record's folder, the project folder and every agent's worktree. Backups and images stay in the project's `.hive`.
- **File locks**: `sessions.preToolUse()` answers the `PreToolUse` hook (Claude Code: matcher `Edit|Write|MultiEdit|NotebookEdit`; Codex: `apply_patch`, every path in the patch) synchronously in the hook server. Locks are a map from absolute path to the holding session, released on `Stop`, `SessionEnd`, exit or after 15 minutes; held files are published as `LiveSessionState.lockedFiles`.
- **Worktrees**: `main/worktrees.ts` wraps git (`worktree add/list/remove`, branch status, `merge-tree` conflict check, squash or `--no-ff` merge with `reset --merge` on failure, copying ignored files by pattern). `main/projectAgents.ts` adds, updates, removes and merges agents. `workspace.assertRoot()` accepts a project or a registered agent worktree, so the Files and Changes IPC can work in worktrees; `git:status`/`git:diff` take a base branch and compare with the merge base.
- **Rendering**: `components/AgentPanes.tsx` has the agent strip, `TerminalLayer` (every agent terminal of every project stays mounted and is positioned into its pane) and the pane frames drawn over it. `TerminalView` holds a WebGL renderer only while visible, within a window-wide budget (`WEBGL_BUDGET`, 8): a terminal that becomes visible takes the context of the longest-hidden one if the budget is used up, and hidden ones release theirs after 30 seconds anyway. Chromium's own limit is about 16 contexts per window, beyond which it silently drops the oldest.

## Tests and checks

- **Unit tests** (`tests/*.test.ts`, Vitest) cover pure logic: migrations, settings resolution, parsers (with CLI transcript fixtures in `tests/fixtures`), prices, kept files and path guards. `electron` resolves to `tests/electron-stub.ts` (vitest alias), so they need no Electron binary.
- **End-to-end suites** (`tests/e2e`, `npm run e2e`) drive the dev build with Playwright `_electron`; see `tests/e2e/README.md`. They need the CLIs and sign-ins, so they run locally, not in CI.
- **Lint**: oxlint with `.oxlintrc.json` (typescript-eslint doesn't support TypeScript 7 yet). `npm run lint` fails on warnings and runs in `npm run build`.
- **CI** (`.github/workflows/ci.yml`): typecheck, lint and unit tests on Windows for every push to `main` and pull request.

## Renderer structure

| Path | Purpose |
|---|---|
| `store.ts` | zustand store: data from main plus UI state |
| `commands.ts` | every command with label, category and keybinding — drives menus, palette and shortcuts |
| `actions.ts` | user flows with confirmations and error toasts |
| `components/` | shell (title bar, activity bar, status bar, sidebar), overlays, terminal, editors |
| `views/` | project view and tabs, settings, notes, skills, MCP, docs, welcome |
| `components/Skills.tsx` | skill rows, the skill page (`SkillDetail`), adding (new or from a `.md`/`.zip`), deleting, restore/revert of bundled skills; used by the Skills view (Hive skills) and the project's Skills tab (Hive, then Local, User and Plugin per provider). Main side: `skills.ts` (listing, `skillFromZip`, `addBundledSkills` for new workspaces from `resources/skills`) |
| `components/ErrorBoundary.tsx` | catches render errors: around each project tab (reset when the tab or project changes), the other views, and the whole app (offers Reload Window) |

Terminals use xterm.js's WebGL renderer with `rescaleOverlappingGlyphs`, so symbols drawn from a wider fallback font (such as the close button in Claude Code's panels) are squeezed into their cell instead of being half painted over; the DOM renderer is the fallback if WebGL is unavailable. The terminal mounts in an unpadded child of its host, because the fit addon measures the parent.

Terminals for every project that has had a session stay mounted (hidden) so switching projects is instant and keeps scrollback.

## Windows app identity

The installed app uses the app user model ID `com.hive.desktop` (the Start menu and desktop shortcuts carry it, and each window sets it with `setAppDetails`), which gives the taskbar button and notifications the Hive name and icon. Dev and test builds run as `electron.exe` and use `com.hive.desktop.dev`, registered under `HKCU\Software\Classes\AppUserModelId` as "Hive Dev". Sharing one ID made Windows show Electron's name and icon for the installed Hive.

## Packaging and updates

`electron-builder.yml` builds an NSIS installer. `@lydell/node-pty` ships prebuilt N-API binaries (no native rebuild), unpacked from the asar archive together with `out/main/hive-mcp.js`, which both CLIs run through Hive's executable with `ELECTRON_RUN_AS_NODE=1`.

`updater.ts` wraps electron-updater. It turns off electron-updater's own auto-download and starts downloads itself, so *Download automatically* and skipped versions are honoured; `autoInstallOnAppQuit` follows *Install updates*. State changes go to the renderer as `update-state` events (`UpdateState`); the status bar item, update dialog, About and Settings (`components/Updates.tsx`) all render from that one state. **Restart and Update** sets a flag and calls the normal `requestQuit()`; `quitNow()` ends with `installNow()` (`quitAndInstall(silent, runAfter)`) instead of `app.quit()`, so the quit dialog, *wait for agents* and transcript backups all still apply. With `HIVE_UPDATE_FEED` (unpackaged builds only) the updater uses a generic feed from a config file in the profile, a separate download cache (`hive-test-updater`), and never installs. Releases are published by `scripts/release.mjs` — see `RELEASING.md`.

## Permission mode of a running session

`LiveSessionState.permissionMode` is what the session is really in (Claude Code described here; Codex's comes from `thread_settings_applied` in its rollout and switches through its `/permissions` menu, see Providers). It starts as the launch mode and is updated from two sources: `watchModeOutput()` in `sessions.ts` keeps a 600-character tail of the terminal output (control sequences replaced by spaces) and reads Claude Code's footer with `footerMode()` (`shared/defaults.ts`), and `handleHook()` reads `permission_mode` from every hook. `setPermissionMode()` writes Shift+Tab (`ESC [ Z`) and waits up to 1.5 s per press for the footer to change, stopping when the target shows, the mode stops changing or the cycle comes round again. `canSwitchLive()` says which targets need `restartInMode()` instead (stop, wait for exit, `start({ resumeId, permissionMode })`). The permission mode is left out of the launch signature, so a changed setting doesn't raise "restart to apply"; instead `liveInfo()` calls `noticeModeSetting()`, which compares the effective mode with the one the session was configured with and, once per change, batches a "Switch Now" toast (`session.applyPermissionModes` → `applyModeSettings()`).

## Keyboard shortcuts

`Command.keybinding` in `commands.ts` is the default. `commandKeybinding(id)` resolves the one in force with `resolveKeybinding()`: the selected project's `config.keybindings` (only for categories in `PROJECT_KEYBINDING_CATEGORIES`), then `settings.keybindings`, then the default; `null` means none. Everything that shows or matches shortcuts (palette, menus, tooltips, `matchKeybinding`, the terminal's `isAppShortcut`) goes through it. `eventToKey()` names keys by `KeyboardEvent.code`. The editor (`components/Keybindings.tsx`) records in a capturing keydown listener and sets `recordingKeys` so the global handler in `App.tsx` stands aside. Global overrides are written with `settings:setKeybinding` (the settings deep merge can't delete a key); project ones replace the project's whole `keybindings` object.
