# Hive — notes for Claude

Hive is a Windows desktop app (Electron + TypeScript + React) for running Claude Code sessions across the projects in a workspace. **You are probably running inside Hive right now**, developing Hive itself.

- Product decisions: [docs/SPEC.md](docs/SPEC.md) — the source of truth. Update it when a decision changes.
- How the code fits together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- User-facing docs (bundled into the app's Docs view): [docs/USER_GUIDE.md](docs/USER_GUIDE.md), [docs/AGENT_API.md](docs/AGENT_API.md), [CHANGELOG.md](CHANGELOG.md)

## Project conventions

- Design is settled before code: when asked to discuss or plan, don't change code; list the open questions and confirm when they're answered. Once a build is agreed, go end to end (code, tests, docs, installer).
- User-visible behaviour changes go into SPEC.md and the user guide in the same change.
- Hive is unreleased (0.1.0 in development; the GitHub repository is private until the first release). Until then `CHANGELOG.md` is a feature summary of 0.1.0, not a change log: keep it current when a feature is added or changes, but don't list fixes or bump the version. Proper release notes and version bumps start with the first public release. Don't create GitHub releases or tags unless asked.
- Personal, machine-specific notes belong in `CLAUDE.local.md` (git-ignored), not here.

## Commands

```bash
npm install            # after cloning; also run: npx install-electron --no  (Electron downloads its binary lazily)
npm run dev            # dev build with hot reload — runs alongside the installed Hive (see below)
npm run typecheck      # tsc for main/preload/shared and renderer
npm test               # vitest unit tests (tests/)
npm run build          # typecheck + production bundles into out/
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
- **Monaco 0.57** deep imports drop the `esm/vs/` prefix: `monaco-editor/editor/editor.worker?worker`.
- **Claude Code login**: never automate key presses on Claude Code's login screens in test sessions; warn the user before any test that may open a browser sign-in.
- Hive must only use the **standalone Claude Code CLI**. Copies bundled in editor extensions are deliberately rejected (SPEC §11).

## Driving the app for verification

Build with `npx electron-vite build`, then drive `node_modules/electron/dist/electron.exe .` with Playwright's `_electron` (`playwright-core` is a dev dependency). Pass `HIVE_USER_DATA=<temp dir>` so tests never touch real profiles, delete `ELECTRON_RUN_AS_NODE` from the child env, and use a throwaway workspace folder. Take screenshots and look at them. To test updates, set `HIVE_UPDATE_FEED` to a local HTTP server serving a `latest.yml` (generic provider); unpackaged builds then check it, cache downloads in `%LOCALAPPDATA%\hive-test-updater`, and never install what they download. `window.hive.invoke(channel, ...)` in the page calls any IPC channel from `src/shared/api.ts`.

## Code map

| Path | What |
|---|---|
| `src/main/index.ts` | App lifecycle, window, quit flow, settings side effects |
| `src/main/sessions.ts` | Launch/stop/resume per agent, hook handling → status, file locks (PreToolUse), transcript backups, usage |
| `src/main/projectAgents.ts`, `src/main/worktrees.ts` | A project's agents (up to 4): add/update/remove/merge; git worktree operations |
| `src/main/agents/` | `AgentAdapter` interface, `ClaudeCodeAdapter`, transcript parser |
| `src/main/servers.ts` | Hook server (random port) and Agent API |
| `src/main/updater.ts`, `src/renderer/src/components/Updates.tsx` | Hive's own updates (electron-updater, GitHub Releases): state, status bar item, update dialog |
| `src/main/mcp/hive-mcp.ts` | Built-in `hive` MCP server (Node built-ins only) |
| `src/main/workspace.ts` | Workspace/project discovery, `.hive` folders, git exclude |
| `src/main/files.ts` | Files/Images tab back end: project file operations, find, live watch, session images |
| `src/main/transcripts.ts`, `src/main/agents/conversation.ts` | Sessions tab transcript viewer: incremental JSONL → conversation parser, search, Markdown export |
| `src/shared/api.ts` | The typed IPC contract — add channels here first |
| `src/renderer/src/commands.ts` | Every command + keybinding (menus, palette, shortcuts) |
| `src/renderer/src/views/` | Project view and tabs (`FilesTab.tsx` has Files and Images, `SessionsTab.tsx` the transcript viewer), settings, notes, skills, MCP, docs |
| `src/renderer/src/components/FileView.tsx` | Files tab editor + previewer registry (markdown, CSV, HTML, SVG, images, PDF) |
| `src/renderer/src/components/AgentPanes.tsx`, `AgentDialogs.tsx` | Session tab agent strip, layouts and panes; Add Agent, Agent Settings and Merge dialogs |
