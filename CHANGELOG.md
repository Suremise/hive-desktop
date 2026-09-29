# Release Notes

## 0.1.0 — in development

Hive's first version, not yet released. Until then this page describes what Hive does rather than listing each change; release notes start with the first public release.

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
- Effort, permission mode, chime and extra arguments per project, each inheriting global defaults. Bypass permissions sits behind an explicit opt-in. Project Settings has categories and search, like Settings.
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
- Command palette, keyboard shortcuts (Alt+1 … Alt+0 for project tabs), notification centre, searchable settings with tooltips.
- Completion chime, Windows notifications and system tray with attention badge.
- A quit dialog that lists running sessions and can wait for agents to finish.
- Claude Code setup: detection, one-click install, update and sign-in. The standalone Claude Code CLI is required; editor-extension copies are not used.
- **Automatic updates** from GitHub releases: checked and downloaded in the background, installed when Hive quits or with **Restart and Update**, never mid-session. The status bar shows progress; Help → Check for Updates; Settings → Updates to check, download and install manually instead, or to get pre-releases.
- Any number of sessions across projects; only the terminals on screen use the graphics card.
- Open source under the MIT License; the licence and third-party notices are in the Docs view and linked from About.
