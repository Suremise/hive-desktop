# Release Notes

## Unreleased

### Codex, and a choice of coding agents
- **Codex** (OpenAI) runs in Hive alongside **Claude Code**. Each agent chooses its provider, so a project can mix them, for example a Claude Code agent writing code while a Codex agent reviews. Hive shows each CLI's own terminal.
- **Settings → Providers** turns providers on and off and sets the default provider. New installs start with every provider off, with a banner linking there; updating from 0.1 keeps Claude Code on. Turning a provider off while its agents run asks whether to stop them.
- **One settings page per provider** (path, default model, effort and permission mode, extra arguments, update checks, API prices), with overrides per provider in Project Settings.
- **Help → Agent Setup…** has a tab per provider for install, sign-in, updates, and Codex's one-time Windows sandbox setup, which Hive starts for you. It explains the choice between Codex's default sandbox and its non-admin one, and offers **Upgrade** from the non-admin one later.
- Codex's permission presets: Read only, Ask for approval, **Approve for me** (the default) and Full access (off unless enabled, like Bypass). Presets and Plan mode switch live in a running Codex session.
- File locks work for Codex agents; with **Ask me**, Hive asks you in a notification (**Allow**) because Codex can't show its own approval for it.
- Workspace skills, MCP servers and Hive's own tools reach Codex agents too; file locks, status, notifications, compaction, transcripts, backups and the Sessions tab work for both.
- The status bar has a plan-usage item per provider, and provider icons show on agent tabs, panes and sessions.

### Agents
- **All agents are equal, and a project starts with none.** **Add Agent** adds one in a click (your default provider, its default settings, in the project folder); its **▾** opens **Add Agent…** to choose the provider, a worktree and settings. New Session and Resume add an agent when a project has none. Any agent can work in a worktree, and any can be removed once stopped.
- **The layout follows as you add agents**: two columns for two, three for three, the grid for four. Choosing a layout by hand still works, and removing an agent leaves it as it is.
- **Updating from 0.1 clears every project's agents** (and resets the layout), since there is no longer a built-in Agent 1. Your sessions stay in the Sessions tab and can be resumed by an agent you add again.
- Starting a new conversation inside the CLI (Claude Code's `/clear` or `/resume`, Codex's `/new`) is now followed: Hive records and backs up the new conversation instead of carrying on with the old one.

### Skills
- **Simpler skills: no more switches.** Every Hive skill in the workspace reaches every agent in every project. Skills that were turned off in the workspace or a project are on again after updating.
- **The Skills view shows the workspace's Hive skills**, where you add (**+**, or **Add Skill from File** with a `.md` or a `.zip`), edit and delete them.
- **A project's Skills tab lists everything its agents get**: the Hive skills (with **Edit in workspace**), then per provider the project's own **Local (User Managed)** skills, which you can now add, edit and delete there, and your user and plugin skills (view only). A local skill can be added for Claude Code and Codex at once.
- **Six skills come with Hive**, for working with several agents and sessions: `handover`, `pick-up`, `merge-ready`, `review-agent-work`, `split-work` and `workspace-note`. New workspaces start with them. In an existing workspace they're listed greyed out: **Restore** adds one. When a later Hive improves them, **Revert to default** on a skill's page brings your copy up to date (the old copy goes to the Recycle Bin).

### Several windows
- **File → New Window** (Ctrl+K Ctrl+N) opens another Hive window, like VS Code, so you can work in several workspaces at once. Each window has its own projects and agents; settings, the tray and updates are shared.
- Opening a workspace that's already open in another window brings that window forward. Closing a window stops its workspace's agents, asking first as quitting does; so do Close Workspace and opening another workspace in the window, which used to refuse while agents were running. Hive reopens the windows that were open when it quit.
- Agent API: `X-Hive-Workspace` or `?workspace=` names the workspace a request is for, `GET /v1/workspaces` lists them, and a project can be named `<workspace>/<project>`. The `hive` tools always use their session's workspace.

### A tidier project view
- **Every agent has its own header and footer**, with one agent or several. The header has its status, session and buttons (Compact, a red **Stop**, Archive & New, or Resume and New Session), which turn into icons and then fold into ⋯ as the pane narrows. The footer has its model and effort, permission mode, context and cost.
- **The project header is about the project**: Active, Explorer, Terminal and a new **Stop All Agents**, which lists the agents it will stop and asks first. The status bar keeps app-wide items only.
- A narrow window no longer pushes the right side of the project view off screen.
- Right-click in a Codex terminal pastes once. Codex also pastes on right-click, and it was being sent the click as well as Hive's paste; right-click in Hive's terminals is now always Hive's copy or paste.
- Pressing ← on an empty Claude Code prompt no longer moves the session out of Hive: Hive turns off Claude Code's agent view in its sessions, which put the session into Claude Code's background service, where Stop couldn't end it and resuming failed. **Settings → Claude Code → Allow background sessions** turns it back on. If a conversation is in the background anyway, resuming it offers **Stop It and Resume**.
- The status bar's icons are all drawn in its text colour, Hive's own mark and the providers' included, so the Claude mark no longer disappears on the amber bar.
- Switching a session you haven't typed in yet to Don't ask or Bypass (which restarts it) now starts a new session in that mode, instead of failing to resume a conversation that doesn't exist yet.

### Other new features
- **Hand Over to…** in the agent menu hands an agent's work to another agent, of either provider, through a handover; the Sessions tab links the two sessions. Also `POST /v1/projects/{name}/handover` in the Agent API.
- **A new Overview**: a project summary for a chosen period (tokens, API-equivalent cost, sessions, prompts) across providers, the agents running now, a section per provider with its plan limits, and a table by agent.
- **Estimated costs** for providers that don't report one, from a price table you can edit in each provider's settings.
- **Share one AGENTS.md** in the Memory tab, so Claude Code and Codex agents read the same project instructions.
- Agent API: `provider` on agents, sessions, usage and status; `providers` in `/v1/status`; `HIVE_PROVIDER` and `HIVE_RUN_ID` in session environments. Calls that name no `agent` use the project's only agent; with several they answer 400, with none 409.
- **Codex models come from Codex itself**, so new ones appear in the model picker without a Hive update.
- **The transcript viewer** loads the latest messages first and earlier ones as you scroll up, so long sessions open quickly. A running session updates only when you switch on **Follow** or click **Refresh** (Settings → Sessions sets the default).
- **Overview updates** can be live (at most every 15 seconds, the default), every minute, or only on **Refresh** (Settings → Sessions).
- In the dark theme, the outlines of fields, cards and dialog options are lighter, so they stand out from the background.
- The format help beside an MCP server's definition can be resized by dragging the edge between them.

### Reliability and security
- Hive keeps a last good copy of its settings and records (`.bak`). A file that can't be read is set aside and the copy restored, with a notification, instead of Hive starting over.
- Hive's copies of workspace skills for Codex are marked, so a `hive-…` folder of your own in `.agents/skills` is never removed.
- "Hand Over to…" waits until the handover has actually been written before the other agent starts.
- A Codex permission change is confirmed by Codex before the badge shows it ("Switching to …"); the earlier method could pick the wrong preset.
- Much less file reading while agents work: session lists read each file once, and Codex sessions are found without re-scanning every time.
- Hive tells you once if a CLI version writes transcripts it doesn't understand, instead of showing zeros.
- The hook token is no longer written to the log. The window refuses web permissions it doesn't need, IPC is accepted only from Hive's own page, and links inside the workspace can't be used to open files outside it.
- Links to sections within the user guide now work in Hive's Docs view.
- Electron 44.5.1.

### Notes
- The end-to-end test suites are now in the repository (`tests/e2e`), with a lint step and a GitHub Actions workflow for pull requests and pushes.
- `config.json` moves to a new format; Hive copies the old one to `config.v1-backup.json` first and keeps writing the old fields, so 0.1.x can still read it.

## 0.1.1 — 29 September 2026

### Fixes
- Hive's project and session files could be corrupted, and session records or agents lost, when two agents finished or started at the same moment. Writes are now atomic per write and changes to the same file are made one at a time.
- A Markdown file with a `%` in an image or link path (such as `50%.png`) blanked the whole window. Such paths now work, and a problem in one tab now shows a message in that tab (**Try Again**, **Open Logs**) instead of blanking Hive; sessions keep running.
- An agent could be told about another project's handover when one project's name begins another's (`hive` and `hive-website`).
- Starting the same agent twice at once (a double click, or the UI and the Agent API together) could leave a Claude Code process Hive no longer tracked. The second start is now refused.
- Archiving a session could keep an older copy of its transcript instead of the latest.
- The Agent API refuses session IDs that aren't IDs, and reports conflicts (agent already running, conversation open elsewhere) as 409 instead of 500.
- Hive only opens the Claude Code files it shows (your `CLAUDE.md`, auto memory and skills), never credentials or settings.
- Session names containing `"`, `%` or `&` no longer break launching when Claude Code was installed with npm.
- MCP servers imported from a project no longer record the project's full local path in the committed definition.
- The Sessions tab could show messages twice when a running session's transcript was read by two things at once (the live update and a search, say).
- **Archive & New** no longer starts a new session when archiving failed.
- Plan usage warnings respect **Settings → Notifications → Desktop notifications**.
- A new Hive skill whose description contains `:` or `#` no longer breaks its front matter, and copying a skill to the workspace checks its folder name.
- Unsaved changes in the Files tab are no longer lost without warning: quitting lists the files and saves or discards them as you choose, reloading or switching workspace offers to save first, deleting warns, and renaming or moving a file keeps its changes.
- Far fewer disk writes while agents work: plan usage is saved only when it changes (at most once a minute), and transcript backups are copied at most once a minute during a turn, plus at the end of each turn.

## 0.1.0 — 29 September 2026

The first public release of Hive. Everything below is what this version does; later releases list what changed.

### Workspaces and projects
- Open or create a workspace; every subfolder is a project.
- `.hive` folders for workspace data (shared notes, skills, MCP servers — meant to be committed) and project data (settings, sessions, backups — excluded from git automatically).
- Mark projects as "working on" to run sessions and get status, without noise from the rest.
- **Compact project list**: collapse the Projects sidebar to a rail of initials and status dots (Ctrl+Alt+B, the chevron, or drag the edge narrow).

### Sessions
- One Claude Code session per project, several running at once, each in its own terminal.
- Live status from Claude Code hooks: ready, working, waiting for input, finished.
- New, resume, stop, archive, rename and adopt sessions started outside Hive. **Stop** is tinted red and **Resume** amber in the project header.
- **Resume per agent**: Resume opens the agent's own last session, and **▾** picks any recent session from its folder; a conversation can only be open in one agent at a time. Each pane shows the name of the session its agent is running.
- **Up to four agents per project**, each in the project folder or in its own git worktree on its own branch, with their own name and optionally their own model, effort and permission mode. Show them one at a time, in two or three columns, or in a grid; one status dot per project in the sidebar.
- **File locks** between agents sharing a folder: an agent that tries to edit a file another agent is editing is told to wait or work on something else (or you're asked, or it's warned — your choice).
- **Worktrees**: Hive creates them next to the workspace, copies `.env` files and runs an optional setup command; review a worktree agent's changes in the Changes and Files tabs and **Merge** them back (squash or merge, conflicts detected before anything changes).
- **Switch permission mode without restarting**: click the mode badge (or Ctrl+Alt+M) and pick one; Hive switches the running session live, and shows the real mode even when you press Shift+Tab in the terminal. Changing the setting offers to switch running agents.
- **Compact** button next to Stop: summarises the conversation so later messages are cheaper, with an optional focus for what to keep. It turns orange, as does the context count in the status bar, when the context passes *Suggest compacting above* (200,000 tokens by default).
- Paste screenshots into a session with Ctrl+V, or drag files from Explorer onto the terminal to paste their paths. Images are kept in the project's `.hive/images` folder.
- Transcript backups so sessions survive Claude Code's cleanup; archived sessions are never deleted.

### Reading and reviewing
- **Sessions** tab: every session of the project with a transcript viewer — the whole conversation including what came before each compaction, thinking and tool calls folded to one line, image thumbnails, live updates for the running session, search across one or all transcripts, copy, export as Markdown and resume.
- **Files** tab: a file browser (create, rename, delete to the Recycle Bin, cut/copy/paste, drag to move, find by name, git status colours, live updates) with an editor and previews for Markdown (with a split view), CSV/TSV, HTML, SVG, images and PDFs.
- **Images** tab: every image sent to the project's sessions, grouped by session.
- **Changes** tab with side-by-side git diffs; **Memory** tab for `CLAUDE.md` and Claude Code's auto memory.
- The lists in the Sessions, Files, Changes and Memory tabs and the Docs view, and the Markdown split view, can be resized by dragging the divider; double-click it to reset.

### Models and usage
- Model setting (global and per project) with the latest of each family, pinned versions, older versions, a custom model ID and **1M context** where the model has one.
- Effort, permission mode, chime and extra arguments per project, each inheriting global defaults. Sessions start in **Auto** permission mode by default. Bypass permissions sits behind an explicit opt-in. Project Settings has categories and search, like Settings.
- Token use, cache state, re-cache estimate, compaction history and API-equivalent cost per session.
- **Plan usage**: the status bar and Overview show how much of your subscription's 5-hour and weekly limits is used, with a notification at 80% and 95% of each. The numbers come from Claude Code; Hive doesn't use your credentials.

### Skills and MCP servers
- Hive skills and MCP servers deployed in the workspace, enabled globally and turned off per project.
- Machine, plugin and local Claude skills listed for reference, with "Copy to workspace".
- Project `.mcp.json` servers detected and kept disabled until copied to the workspace.
- Secret detection for MCP definitions.

### Agent API
- Local HTTP API with bearer-token auth and a server-sent event stream.
- Built-in `hive` MCP server giving agents tools for projects, shared notes, handovers (including the latest handover) and notifications.

### App
- VS Code-style interface with honey-orange accents, dark and light themes.
- Command palette and Go to Project (Ctrl+P), notification centre, searchable settings with tooltips.
- **Configurable keyboard shortcuts** for every command (Settings → Keyboard Shortcuts), with per-project shortcuts for project and session commands, and new defaults for agents, layouts, tabs, compacting and the permission mode.
- Completion chime, Windows notifications and system tray with attention badge.
- A quit dialog that lists running sessions and can wait for agents to finish.
- Claude Code setup: detection, one-click install, update and sign-in. The standalone Claude Code CLI is required; editor-extension copies are not used.
- **Automatic updates** from GitHub releases: checked and downloaded in the background, installed when Hive quits or with **Restart and Update**, never mid-session. The status bar shows progress; Help → Check for Updates; Settings → Updates to check, download and install manually instead, or to get pre-releases.
- Any number of sessions across projects; only the terminals on screen use the graphics card.
- Open source under the MIT License; the licence and third-party notices are in the Docs view and linked from About.
