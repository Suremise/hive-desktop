# Hive — notes for Claude

Hive is a Windows desktop app (Electron + TypeScript + React) for running Claude Code sessions across the projects in a workspace. **You are probably running inside Hive right now**, developing Hive itself.

- Product decisions: [docs/SPEC.md](docs/SPEC.md) — the source of truth. Update it when a decision changes.
- How the code fits together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- User-facing docs (bundled into the app's Docs view): [docs/USER_GUIDE.md](docs/USER_GUIDE.md), [docs/AGENT_API.md](docs/AGENT_API.md), [CHANGELOG.md](CHANGELOG.md)

## Project conventions

- Design is settled before code: when asked to discuss or plan, don't change code; list the open questions and confirm when they're answered. Once a build is agreed, go end to end (code, tests, docs, installer).
- User-visible behaviour changes go into SPEC.md and the user guide in the same change.
- Hive is released: 0.1.0 was the first public release (29 Sep 2026) on the public repository `Suremise/hive-desktop`, and installed copies update themselves from its GitHub Releases. Add an **Unreleased** section at the top of `CHANGELOG.md` for user-visible changes (features and notable fixes) as they're made; it becomes the next version's notes. Versions follow semver while in 0.x: 0.1.x for fixes, 0.x.0 for features, 1.0 once settings formats and the Agent API are stable. Don't bump the version, create GitHub releases or tags unless asked; releasing is in [RELEASING.md](RELEASING.md).
- Agent-facing tool replies are lean: a change confirms what changed, a listing returns short rows, full detail on request. Don't trim context the agent needs (instructions, descriptions). The short forms are in `src/shared/toolReplies.ts`; `tests/e2e/replysize.cjs` measures every tool's reply and holds each to a size.
- Personal, machine-specific notes belong in `CLAUDE.local.md` (git-ignored), not here.

## Commands

```bash
npm install            # after cloning; also run: npx install-electron --no  (Electron downloads its binary lazily)
npm run dev            # dev build with hot reload — runs alongside the installed Hive (see below)
npm run typecheck      # tsc for main/preload/shared and renderer
npm test               # vitest unit tests (tests/); also run by CI (.github/workflows/ci.yml) on push/PR
npm run lint           # oxlint (.oxlintrc.json), fails on warnings; part of build and CI
npm run e2e            # end-to-end suites (tests/e2e) against the dev build — needs npx electron-vite build first
npm run build          # typecheck + lint + production bundles into out/
npm run dist           # build + NSIS installer → dist/Hive-Setup-<version>.exe
npm run icons          # regenerate PNG/ICO from build/*.svg
npm run licenses       # regenerate THIRD_PARTY_NOTICES.md (also part of build)
npm run release        # build + upload a DRAFT GitHub release — only when asked (RELEASING.md)
```

Hive is MIT-licensed (`LICENSE`). `THIRD_PARTY_NOTICES.md` is generated from what ships: the main process's `dependencies` plus the renderer libraries listed in `scripts/licenses.mjs` (`RENDERER`). When a new library is bundled into the renderer, add it there; commit the regenerated file. Only add dependencies with permissive licences (MIT, BSD, ISC, Apache-2.0 and similar) unless the maintainer agrees otherwise.

npm 11 blocks install scripts by default; esbuild and electron-winstaller are approved in package.json. If a new dependency needs a script, `npm approve-scripts <pkg>`.

## Developing Hive from inside Hive

- `npm run dev` (unpackaged) uses its own profile `%APPDATA%\Hive-Dev` and Agent API port **47822**, and its title bar says **Hive Dev**. The installed app uses `%APPDATA%\Hive` and port 47821. Both can run at once.
- To update an installed copy: `npm run dist`, then quit Hive, run the installer, reopen and resume the sessions (conversations are kept). Leave running the installer to the user.
- Dev and test builds use the Windows app ID `com.hive.desktop.dev` ("Hive Dev"); never give them the installed app's `com.hive.desktop`, or Windows shows Electron's icon and name for the real Hive.
- Never kill Hive processes by name — the installed Hive hosting this session is also `Hive.exe`/`electron.exe`. Target processes by command line (e.g. paths containing `out\main` or a test profile).

## Gotchas

- **ELECTRON_RUN_AS_NODE**: shells started by the Claude Code VS Code extension inherit `ELECTRON_RUN_AS_NODE=1`, which makes `electron.exe` run as plain Node (`app` is undefined). Hive strips it from session environments, but if you see "Cannot read properties of undefined (reading 'setPath')", clear it.
- **PowerShell 5.1 encoding**: `Get-Content`/`Set-Content` read UTF-8 without a BOM as ANSI and corrupt characters like `—` and `·`. Edit files with the Edit/Write tools (or Python with `encoding='utf-8'`), never round-trip them through PowerShell text cmdlets.
- **zustand selectors** must not return fresh objects/arrays (`?? []`) — that loops forever (React error #185). Use a stable constant such as `NO_PROJECTS`.
- **`setActivity(view)` toggles** the sidebar when that view is already shown (it's the activity bar's click). To just show a view (from a command or action), use `showView(view)`.
- **Shortcuts**: never read `Command.keybinding` directly for display or matching; use `commandKeybinding(id)`, which applies the user's and the project's overrides.
- **Agents**: a project can have none, and all are equal (no built-in Agent 1, no `'main'` id). Calls that name no agent use `sessions.soleAgent()`; renderer code gets `null` from `focusedAgentId()` when there are none and uses `actions.quickAddAgent()`.
- **Several windows**: each window has its own workspace. `workspace.x(projectPath, …)` finds the right one by path, but path-less calls (`workspace.path`, `skillsDir`, `refresh()`…) need the current work's workspace: IPC and Agent API calls have it; background code must use `workspaceOf(projectPath)` or `inWorkspace(ws, fn)`. Send a window-specific event with `emitTo(win, …)`.
- **Hive Assistant**: its home `.hive/assistant` is a session host like a project (one agent, `assistant`) but is never in `workspace.projects`. Session code takes `workspace.assertSessionHost()`, not `assertProject()`; renderer code that looks a session's project up by path uses `findProject()`, which includes `workspace.assistant`. It calls the Agent API with its own per-launch token (`assistantControl.ts`); Settings → Assistant → Control, not Settings → Agent API, governs those calls, and every change it makes goes through `assistantChange()` in `servers.ts` (level, the 30-per-message limit, the activity list).
- **Kept files** (`config.json`, `workspace.json`, `project.json`, `sessions.json`): read with `readKeptJson()` and write with `writeKeptJson()` (keeps a `.bak`, recovers damaged files), never `readJson`/`writeJsonAtomic`.
- **Tests**: e2e suites live in `tests/e2e` (see its README): use `lib.cjs`, work under `%LOCALAPPDATA%\hive-test\e2e`, never the real clipboard, profile or `~/.codex`. Unit tests get `tests/electron-stub.ts` for `electron`. Lint is oxlint because typescript-eslint doesn't support TypeScript 7.
- **project.json / sessions.json**: change them with `workspace.mutateProjectConfig()`/`updateAgent()` and `workspace.mutateSessions()`/`upsertSession()`, which lock the file; computing a new value outside the lock and writing it loses concurrent changes (two agents finishing at once).
- **Renderer errors**: a throw while rendering is caught by the nearest `ErrorBoundary`; don't rely on it — guard parsing of file content (e.g. `decodeURIComponent` on paths from Markdown) where it happens.
- **hive-mcp.js** runs outside the asar (the CLIs start it), so it may only require Node built-ins and `out/main/chunks/*` (unpacked in `electron-builder.yml`); code it shares with main is split into those chunks. After `npm run dist`, check it with `npm run e2e -- packaged-mcp` (stdio calls against `dist/win-unpacked/resources/app.asar.unpacked/out/main/hive-mcp.js`).
- **Monaco 0.57** deep imports drop the `esm/vs/` prefix: `monaco-editor/editor/editor.worker?worker`.
- **CLI logins**: never automate key presses on Claude Code's or Codex's login screens in test sessions; warn the user before any test that may open a browser sign-in.
- Hive must only use the **standalone CLIs** (Claude Code, Codex). Copies bundled in editor extensions are deliberately rejected (SPEC §11).
- **Providers**: never switch on a provider id in shared code or the UI; put the difference in the descriptor (`capabilities`) or the adapter. Hive never edits a CLI's own config files (`~/.claude/settings.json`, `~/.codex/config.toml`); Codex gets everything through `-c` overrides.
- **Codex hooks** run through PowerShell on Windows: only the exact `curl.exe … --data-binary "@-" "<url>"` form in `hookCommand()` works, and changing a hook's command, timeout or matcher changes its trust hash (`hookHash()`, tested against hashes from Codex in `tests/codex.test.ts`).
- **Testing Codex**: point `CODEX_HOME` at a test home (never the user's `~/.codex`); the maintainer signs in there once (tests/e2e/README.md). Codex's SessionStart only fires with the first prompt.

## Driving the app for verification

Build with `npx electron-vite build`, then drive `node_modules/electron/dist/electron.exe .` with Playwright's `_electron` (`playwright-core` is a dev dependency). Pass `HIVE_USER_DATA=<temp dir>` so tests never touch real profiles, delete `ELECTRON_RUN_AS_NODE` from the child env, and use a throwaway workspace folder. Take screenshots and look at them. To test updates, set `HIVE_UPDATE_FEED` to a local HTTP server serving a `latest.yml` (generic provider); unpackaged builds then check it, cache downloads in `%LOCALAPPDATA%\hive-test-updater`, and never install what they download. `window.hive.invoke(channel, ...)` in the page calls any IPC channel from `src/shared/api.ts`.

To test what the window does while an action is slow or fails, set `HIVE_TEST_SLOW_IPC` / `HIVE_TEST_FAIL_IPC` (unpackaged builds only; see `tests/e2e/README.md`).

## Code map

| Path | What |
|---|---|
| `src/main/index.ts` | App lifecycle, window, quit flow, settings side effects |
| `src/main/sessions.ts` | Launch/stop/resume per agent (any provider), normalised hooks → status, file locks (PreToolUse), transcript backups, usage and cost, Continue with… |
| `src/shared/assistant.ts`, `assistantTools.ts`, `src/main/personas.ts`, `assistantControl.ts`, `src/renderer/src/components/Assistant.tsx`, `AssistantView.tsx`, `Personas.tsx` | The Hive Assistant (one per workspace, a session host at `.hive/assistant` whose settings are overlaid from Settings → Assistant) and its personas (`.hive/personas`, shipped in `resources/personas`) |
| `src/main/projectAgents.ts`, `src/main/worktrees.ts` | A project's agents (up to 12, six to a page): add/update/remove/merge; git worktree operations |
| `src/shared/providers.ts`, `claude.ts`, `codex.ts` | Provider descriptors (names, modes, models, capabilities) and settings resolution helpers |
| `src/main/providers/` | `ProviderAdapter` interface, registry, `claude/` and `codex/` adapters (launch, hooks, transcripts, usage, conversation parsers) |
| `src/main/providerService.ts` | Each provider's install info, readiness and setup tasks (Agent Setup) |
| `src/shared/prices.ts`, `instructions.ts` | Price tables and cost estimates; shared AGENTS.md logic |
| `src/main/servers.ts` | Hook server (random port) and Agent API |
| `src/main/updater.ts`, `src/renderer/src/components/Updates.tsx` | Hive's own updates (electron-updater, GitHub Releases): state, status bar item, update dialog |
| `src/main/mcp/hive-mcp.ts` | Built-in `hive` MCP server (Node built-ins only) |
| `src/main/workspace.ts` | Workspace/project discovery, `.hive` folders, git exclude; one `WorkspaceService` per window behind the `workspace` stand-in |
| `src/main/windows.ts` | Hive's windows (one workspace each) and where each event and terminal's output goes |
| `src/main/files.ts` | Files/Images tab back end: project file operations, find, live watch, session images |
| `src/main/transcripts.ts`, `src/main/providers/conversation.ts` | Sessions tab transcript viewer: per-provider incremental parsers, search, Markdown export |
| `src/shared/api.ts` | The typed IPC contract — add channels here first |
| `src/renderer/src/commands.ts` | Every command + keybinding (menus, palette, shortcuts) |
| `src/renderer/src/views/` | Project view and tabs (`FilesTab.tsx` has Files and Images, `SessionsTab.tsx` the transcript viewer), the Workspace Overview (`WorkspaceOverview.tsx`), settings, notes, skills, MCP, docs |
| `src/renderer/src/components/FileView.tsx` | Files tab editor + previewer registry (markdown, CSV, HTML, SVG, images, PDF) |
| `tests/`, `tests/e2e/` | Unit tests (Vitest, fixtures in `tests/fixtures`); end-to-end suites (`lib.cjs`, `run.mjs`, and a fake Claude Code in `fake-claude/` for suites that run agents without signing in) |
| `src/renderer/src/components/AgentPanes.tsx`, `AgentDialogs.tsx` | Session tab agent strip, layouts and panes; Add Agent, Agent Settings, Continue with… and Merge dialogs |
