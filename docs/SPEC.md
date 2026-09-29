# Hive — Specification (v0.1)

Hive is a desktop app for AI-assisted ("vibe") coding. It looks and feels like a streamlined VS Code, but its centre of gravity is the **agent session**, not the text editor. It organises code into Workspaces and Projects, runs one CLI agent session per active project, and manages the skills, MCP servers and shared notes those sessions use.

This document is the source of truth for product decisions. Update it when decisions change.

---

## 1. Goals and non-goals

**Goals**
- Open or create a Workspace; list its Projects in a left-hand pane.
- Run a Claude Code session per active Project in an embedded terminal, several at once.
- Show per-session stats: tokens, cache use, compactions, estimated re-cache cost on resume.
- Review and edit the agent's memory for a project.
- Manage Hive skills and MCP servers at workspace ("global") scope with project-level opt-outs.
- Per-project model, effort and permission mode, with global defaults.
- Indicate session state (working / waiting / finished) with optional chime and desktop notifications.
- Review changes (git diff) made by the agent.
- Expose an Agent API (HTTP + built-in MCP server) so agents can interact with Hive.
- Minimise and close to the system tray. Ship as a Windows installer.

**Non-goals (for now)**
- A full code editor. Monaco is used for notes, memory, skills and diffs.
- Agents other than Claude Code. The architecture allows them (§10) but only one adapter ships.
- Automatic session restore. Resuming is always a user action.
- Cloud sync, accounts, multi-user. A remote skill repository is a future idea.

---

## 2. Technology

| Area | Choice |
|---|---|
| Shell | Electron, TypeScript throughout, built with electron-vite |
| UI | React + zustand, VS Code-style layout, `@vscode/codicons` |
| Terminal | `xterm.js` with its WebGL renderer (DOM fallback) + `node-pty` prebuilt (`@lydell/node-pty`, Windows ConPTY) |
| Editor / diff | Monaco (bundled locally, no CDN) |
| File watching | `chokidar` |
| Docs rendering | `marked` |
| Packaging | `electron-builder` (NSIS installer) |
| Tests | Vitest |

Process model: the **main process** owns the filesystem, ptys, hook server, Agent API and agent adapters. The **renderer** is UI only and talks to main through a typed preload bridge (`contextIsolation: true`, `sandbox: true`, no `nodeIntegration`).

Primary platform is Windows 11. Code avoids Windows-only assumptions where cheap.

---

## 3. Concepts

- **Workspace** — a folder that contains Projects. One workspace is open per window. Hive remembers recent workspaces.
- **Project** — any direct child folder of the workspace, excluding dot-folders (so `.hive` is never a project). Creating a project in Hive creates the folder.
- **Active project** — a project switched on with its toggle. Only active projects get a terminal, watchers, status indicators and notifications. Activating a project **never** starts or resumes a session; it offers "Resume last session" and "New session". Deactivating requires stopping the live session (after confirmation). Active state is personal, so it is stored in app data, not in the workspace.
- **Agent** — one of up to four session slots in a project. **Agent 1** always works in the project folder; others work in the project folder too or in their own **git worktree** (a separate checkout on its own branch). Agents are named ("Agent 2", renamable) and can override the project's model, effort and permission mode. Each agent has at most one live session.
- **Session** — one Claude Code conversation, identified by a UUID Hive chooses. A project has at most one live session per agent plus any number of past (resumable) and archived sessions.
- **Global scope** — settings in app data or `<Workspace>/.hive/workspace.json`, applied to every project unless the project overrides them.
- **Project scope** — overrides in `<Project>/.hive/project.json`.

---

## 4. On-disk layout

### 4.1 Workspace (committed to git if the workspace is a repo)

```
<Workspace>/
  .hive/
    workspace.json        # global skill/MCP enablement
    shared/               # cross-session notes, handovers, instructions (markdown)
      handovers/
    skills/
      <skill-name>/SKILL.md (+ supporting files)
    mcp/
      <server-name>.json  # one MCP server definition (§7.2)
      <server-name>/      # optional server code
    README.md             # explains the folder to humans browsing the repo
```

`<Workspace>/.hive/` is intended to be committed so a team can share skills, MCP definitions and notes. MCP definitions must reference secrets via environment variables (§7.2).

### 4.2 Project (entirely git-excluded)

```
<Workspace>/<Project>/
  .hive/
    project.json          # project overrides
    sessions.json         # session index
    sessions/<id>.jsonl   # backup copy of each session transcript
    archive/<id>.jsonl    # transcripts of archived sessions
    images/<id>/<time>.png  # images pasted or dropped into a session; never deleted
    launch/               # regenerated on every launch of Agent 1 — do not edit
      plugin/.claude-plugin/plugin.json
      plugin/skills/<skill>/...     # copies of enabled Hive skills
      mcp.json
      settings.json                 # hooks Hive injects
    launch-<agent id>/    # the same for each other agent (a launch replaces only its own folder)
    sync.json             # hash of each item copied into launch/
```

Worktrees Hive creates for agents live **next to the workspace**, in `<Workspace>.worktrees/<Project>/<agent>` (e.g. `D:\Dev\HIVE.worktrees\hive\agent-2`), so the project's own tools (tsc, test runners, search, file watchers) don't scan a second copy of the code, and Hive doesn't take them for projects. Transcripts, backups and images of worktree agents still live in the project's `.hive` folder.

### 4.3 App data (`%APPDATA%/Hive/`)

- `config.json` — settings, recent workspaces, active projects per workspace, window state.
- `agent-api.json` — Agent API token.
- `logs/hive.log`

### 4.4 Schemas

```jsonc
// <Workspace>/.hive/workspace.json
{ "version": 1, "skills": { "enabled": ["handover"] }, "mcp": { "enabled": ["github"] } }

// <Project>/.hive/project.json
{
  "version": 1,
  "skills": { "disabled": [] },          // subset of globally enabled
  "mcp":    { "disabled": [] },
  "chime": "inherit",                     // inherit | on | off
  "model": "inherit",                     // inherit | alias (fable, opus, sonnet, haiku) | full model id
  "effort": "inherit",                    // inherit | low | medium | high | xhigh | max
  "permissionMode": "inherit",            // inherit | manual | acceptEdits | plan | auto | dontAsk | bypassPermissions
  "extraArgs": ""
}

// <Project>/.hive/sessions.json
{ "version": 1, "sessions": [ { "id": "…", "agent": "claude-code", "name": "…",
  "createdAt": "…", "lastActiveAt": "…", "archived": false } ] }
```

---

## 5. Settings resolution

**Skills and MCP**

```
effective(project) = globalEnabled − projectDisabled
```

- Skills and MCP servers must be deployed to `<Workspace>/.hive/` before any project can use them. Projects can only turn off what is globally on.
- An item disabled globally is off everywhere. The project's own "disabled" entry is kept, so its choice returns if the item is re-enabled globally.
- Changes apply to **new sessions only**, including restarts. A live session keeps what it launched with; the UI shows "settings changed — restart to apply".
- If a project defines MCP servers in its own `.mcp.json` that are not in the workspace, Hive notifies the user that they stay disabled until copied to the workspace, and offers "Copy to workspace". (`--strict-mcp-config` enforces this.)

**Model, effort, permission mode, chime** — project value overrides unless it is `inherit`. An agent's own model, effort or permission mode (set when adding it, or in its settings) overrides the project's; unset, it follows the project.

**Agents** — *File locks* (global Settings → Agents & Worktrees, default **Block**; project override), *Copy into new worktrees* (global list, default `.env*`; project override), *Setup command* (project only, empty by default), *Default merge style* (global, default **Squash**).

**Permission mode**
- Global default: **Manual**.
- Project dropdown: Inherit, Manual, Accept edits, Plan, Auto, Don't ask — always available.
- **Bypass permissions** is only offered when Settings → Claude Code → "Enable bypass permissions option" is ticked (ticking asks for confirmation). Projects using it show a warning indicator.
- If the option is later unticked, projects set to bypass revert to Inherit and the user is told which ones changed.

---

## 6. Session lifecycle (Claude Code)

### 6.1 Launch

On "New session" or "Resume":

1. Resolve effective skills and MCP servers (§5).
2. Rebuild `<Project>/.hive/launch/` from scratch (copy skills, write `mcp.json`, write `settings.json`, record hashes).
3. For a resume, if Claude Code's transcript is missing (e.g. cleaned up) but Hive holds a backup, restore it first.
4. Spawn in a pty, cwd = the agent's folder (the project folder, or its worktree):

```
claude --session-id <uuid> | --resume <uuid>
       --name "<session name>"
       --plugin-dir .hive/launch/plugin
       --mcp-config .hive/launch/mcp.json --strict-mcp-config
       --settings .hive/launch/settings.json
       [--model <m>] [--effort <e>] [--permission-mode <p>] [extra args]
```

Environment added to the pty: `HIVE_HOOK_TOKEN`, `HIVE_API_URL`, `HIVE_API_TOKEN`, `HIVE_PROJECT`, `HIVE_WORKSPACE`, `HIVE_AGENT` (the agent's name).

Each agent launches from its own folder (`launch/` for Agent 1, `launch-<id>/` for the others), because a launch replaces the folder while the project's other agents may still read theirs (skills are read when used).

Rebuilding `launch/` on every launch guarantees anything disabled globally is gone after a restart or app relaunch.

### 6.2 Operations

| Action | Behaviour |
|---|---|
| New session | New UUID. A live session is stopped first (with confirmation). |
| Resume | `--resume <uuid>`, in an agent that works in the folder the session ran in (sessions record their agent, folder and branch). Shows the re-cache estimate (§9) first. If the session has no transcript yet (nothing was typed before it stopped or was restarted), it is started fresh with `--session-id <uuid>` instead. **One conversation runs in one agent at a time**: the main process refuses to resume a session that is open in another agent (two terminals would both append to its transcript), for the UI and the Agent API alike; the UI shows that agent instead. A paused session can move between agents that share its folder (never across worktrees); the record then names the new agent, and any other agent whose *last session* it was forgets it. |
| Stop | Ends the pty. Session stays resumable. |
| Compact | Header button next to Stop, Session menu, command palette. Enabled only while the agent is idle (Ready/Finished) and the conversation has content. A dialog shows the context size and cache state and takes an optional **focus**; empty lets the agent decide what to keep. Hive sends Ctrl+U (clears half-typed input; Claude Code's Ctrl+Y restores it), then `/compact [focus]`. Status shows "Compacting…" until `PostCompact`, a new compaction in the transcript, a refusal in the output ("Not enough messages to compact"), no `PreCompact` within 20 s, or 10 minutes. The button and the status-bar context count turn orange above *Suggest compacting above* (global, default 200,000 tokens; per-project override; 0 never). The full pre-compaction history stays in the transcript and Hive's backup. |
| Archive | Moves the transcript backup to `.hive/archive/`, marks it archived. Never deleted. Can be unarchived. |
| Adopt | Sessions for the project started outside Hive are listed and can be adopted into `sessions.json`. |
| Add agent | Up to four per project. Name, where it works (project folder, new worktree with branch `hive/<name>` from a chosen base branch, or an existing unused worktree of the project), optional model/effort/permission overrides, and "Start a session now". |
| Merge (worktree agent) | Commits the worktree's uncommitted changes (with the message given), checks for conflicts with `git merge-tree` without touching anything, then merges into the branch checked out in the project folder: **squash** (one commit, default) or **merge** (`--no-ff`). Refused while the project folder has staged changes. On conflict nothing changes; the dialog lists the files and offers to send merge instructions to an idle agent in the project folder, or copy them. Optionally removes the worktree, branch and agent afterwards (agent must be stopped). |
| Remove agent | Agent must be stopped. A worktree agent asks whether to keep the worktree and branch (reusable via "existing worktree") or delete both. Agent 1 can't be removed. |
| Discard (worktree agent) | Stops it, deletes the worktree and branch, removes the agent. |

### 6.3 Status via HTTP hooks

`launch/settings.json` registers Claude Code **HTTP hooks** pointing at Hive's local hook server (`127.0.0.1`, random port per app run). The token is sent as `Authorization: Bearer $HIVE_HOOK_TOKEN` using `allowedEnvVars`. `SessionStart` only supports command hooks, so it is a command that pipes the hook JSON to the same server with Windows' `curl.exe`; its token is written into the git-excluded `launch/settings.json` (it changes every time Hive starts).

| Hook | Hive status / action |
|---|---|
| `SessionStart` | **ready** |
| `PreToolUse` (Edit, Write, MultiEdit, NotebookEdit) | File lock check (below); answered before the tool runs |
| `UserPromptSubmit`, `PostToolUse` | **working** |
| `Notification` (permission prompt) | **waiting** — notification if window hidden/unfocused |
| `Stop` | **finished** — chime if enabled; notification if hidden/unfocused |
| `PreCompact` | **working** ("Compacting…"); toast for automatic compaction |
| `PostCompact` | back to **ready** after compaction |
| `SessionEnd` | **stopped** |

Hooks have a short timeout; if Hive is unreachable, Claude Code continues normally.

**File locks.** Hooks are matched to sessions by `session_id`, so every agent reports its own status. For file edits, `PreToolUse` asks Hive first: the first agent to edit a file (absolute path) claims it; while the claim holds, another agent's edit of the same file gets, depending on the lock mode, `permissionDecision: "deny"` with a reason naming the holder (**Block**, default), `"ask"` (**Ask me**: Claude Code's permission prompt), or `additionalContext` warning it (**Warn**); **Off** skips the check. A claim is released when the holder's turn ends (`Stop`), when its session ends, or 15 minutes after its last edit. Denials return at once, so agents can't deadlock; if Hive doesn't answer, the edit goes ahead. Only these tools are covered: shell commands, formatters and Claude Code's own config writes (`~/.claude.json`) are not — concurrency there is the developer's responsibility. Agents in different worktrees never collide (different paths). Claimed files are shown on the agent's tab and pane header (lock icon with a count; the list on hover).

**Status line**: `launch/settings.json` also sets Claude Code's `statusLine` to the same `curl.exe` command, posting to `/hook?statusline`. The hook server answers 204 with no body, so Claude Code shows no status line in the terminal. From the JSON Hive takes the session's effort (`effort.level`), model name and cost (`cost.total_cost_usd`) into the live state, and the plan limits (`rate_limits.five_hour` / `seven_day`: `used_percentage`, `resets_at`) into `config.json` (`planUsage`, account-wide, last report wins). Warnings at 80% and 95% are shown once per limit per reset period (`planWarnings`; a reset time within 30 minutes of the stored one counts as the same period). Hive never calls Anthropic's usage API or reads credentials itself.

---

## 7. Skills and MCP

### 7.1 Skill levels

| Level | Location | Loaded | Managed by Hive |
|---|---|---|---|
| **Hive** | `<Workspace>/.hive/skills/`, copied into `<Project>/.hive/launch/plugin/skills/` | Only when enabled | Yes — global and project toggles |
| **Machine** | `~/.claude/skills/` and installed Claude Code plugins | Always | No — listed read-only |
| **Local** | `<Project>/.claude/skills/` | Always, in that project | No — listed read-only, with "Copy to workspace" |

Hive skills are added manually (a remote repository is a future idea). The workspace folder is a store only; no agent loads from it directly. Copies are used (not links) so a live session keeps a fixed version; edits reach the next session.

### 7.2 MCP servers

One file per server: `<Workspace>/.hive/mcp/<name>.json`, in Claude Code's format plus an optional `description`:

```json
{ "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }, "description": "GitHub issues and PRs" }
```

Enabled servers are merged into `launch/mcp.json`. Server code in `<Workspace>/.hive/mcp/<name>/` is referenced in place, not duplicated. Hive warns when a definition looks like it contains a literal secret.

### 7.3 Built-in Hive MCP server

If "Provide Hive tools to sessions" is on (default), every session also gets a `hive` MCP server (bundled script run via Hive's own executable) exposing the Agent API as tools: list projects, project status, read/write shared notes, read the latest handover, create handovers, notify the user, session usage. Its MCP instructions (sent on `initialize`) tell the agent when to use each tool, and that handovers and shared notes live in the workspace, not the project. If the project has a handover, the instructions name the latest one. A handover belongs to a project when its file name is `<date>-<project>-…md` (as `hive_create_handover` writes it).

---

## 8. Git

- Project: `.hive/` is added to `.git/info/exclude` (idempotent) when the project is a git repo; re-checked on activation.
- Workspace: `.hive/` is **not** excluded; it is meant to be committed.
- The Changes tab shows `git status` and a Monaco diff (HEAD vs working tree) per file.

---

## 9. Usage, compaction and memory

Source: `~/.claude/projects/<encoded-path>/<session-id>.jsonl`, where the encoded path replaces every non-alphanumeric character of the project path with `-` (matched case-insensitively).

**Model choice** (global default and per project): Latest aliases, pinned versions and older versions (hidden until requested), from a list built into Hive of the models Claude Code knows; a custom model ID; and a 1M-context toggle (`[1m]` suffix) for Fable, Opus 4.6+ and Sonnet 4.5+. Availability for the account is only known when a session starts.

**Metrics per session**
- Input, output, cache-write, cache-read tokens (assistant `message.usage`, de-duplicated by request id).
- Current context size: the last assistant entry's `input + cache_read + cache_creation`.
- Compactions from `system/compact_boundary` entries: trigger, `preTokens`, `postTokens`.
- Cache TTL detected from `cache_creation.ephemeral_1h_input_tokens` vs `ephemeral_5m_input_tokens` (overridable in settings).
- Model, Claude Code version, session title (`ai-title` / `custom-title`), last activity.
- API-equivalent cost from `cost-state` entries (`totalCostUSD`), shown on the Overview as "API-equivalent cost".

**Re-cache estimate on resume**: if time since last activity exceeds the TTL, "Resume will re-cache ≈ N tokens" (N = current context size); otherwise "cache likely warm (≈ M min left)". Always labelled as an estimate.

**Transcript backups**: while a session is live Hive copies its transcript to `<Project>/.hive/sessions/` (debounced) and again when it stops, so sessions survive Claude Code's own cleanup.

**Memory tab**: view/edit `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md` and Claude Code's auto-memory folder for the project.

All parsing lives in the adapter, tolerates unknown fields, and degrades to "unavailable".

---

## 10. Agent adapter interface

```ts
interface AgentAdapter {
  id: string; displayName: string;
  locate(): Promise<AgentInstall | null>;
  latestVersion(): Promise<string | null>;
  installCommand(): { file: string; args: string[] };
  updateCommand(install: AgentInstall): { file: string; args: string[] };
  prepareLaunch(ctx: LaunchContext): Promise<void>;
  buildCommand(ctx: LaunchContext): { file: string; args: string[]; env: Record<string, string> };
  transcriptPath(projectPath: string, sessionId: string): string | null;
  listSessions(projectPath: string): Promise<ExternalSession[]>;
  readUsage(transcriptPath: string): Promise<SessionUsage | null>;
  memorySources(projectPath: string): Promise<MemorySource[]>;
}
```

v0.1 ships `ClaudeCodeAdapter` only. Skills and MCP are stored in a Hive-neutral form; adapters translate them in `prepareLaunch`.

---

## 11. Claude Code installation and updates

- Not bundled (proprietary; redistribution would need Anthropic's permission).
- **The standalone Claude Code CLI is required.** Copies bundled with editor extensions (VS Code, Cursor, Windsurf) are never used, even if set manually: they move on every extension update and can't be updated with `claude update`. If only an extension is present, the setup dialog explains that the CLI is still needed.
- Discovery: settings path → `PATH` → `~/.local/bin/claude.exe` → npm global.
- Not found → first-run dialog offers a one-click install using Anthropic's official installer, run in a visible terminal.
- On launch (if enabled): read `claude --version`, compare with the latest published version, offer **Update** (`claude update`) in a visible terminal. Never updates while sessions are live.
- Auth is handled by Claude Code itself. Hive never touches credentials.

---

## 12. Agent API

Local HTTP API on `127.0.0.1:<port>` (default 47821), bearer-token auth, token in `%APPDATA%/Hive/agent-api.json` and passed to sessions as `HIVE_API_TOKEN`. Endpoints under `/v1` for app status, workspace, projects, sessions, usage, shared notes, skills, MCP, notifications and a server-sent events stream. Full reference: `docs/AGENT_API.md`.

---

## 13. UI

- **Title bar** with menu bar (File, Edit, View, Session, Help), native window controls.
- **Activity bar**: Projects, Shared Notes, Skills, MCP Servers; Docs and Settings at the bottom.
- **Sidebar** per activity: project list (active toggle, status dot, warning for bypass, context menu), notes tree, skill/MCP lists with toggles.
- **Compact project list**: the Projects sidebar collapses to a 48 px rail — one tile per project with its initials ("web-dashboard" → WD, "hive" → Hi) and its combined status dot, working-on projects first, then a divider and the others. Hover shows the name, status, branch and each agent's state; click selects, double-click starts a session, right-click gives the usual project menu. Toggle it with the chevron in the list header or on the rail, **Ctrl+Alt+B**, or by dragging the sidebar edge below 120 px (dragging out again restores the earlier width). Only the Projects view compacts; Notes, Skills and MCP always show at full width. Kept in the app config (`ui.sidebarCompact`). Ctrl+B still hides the sidebar entirely.
- **Agents** (Session tab): a strip above the terminal lists the project's agents (status dot, name, branch for worktree agents, lock count), **Add Agent**, and — once there is more than one agent — the layout: **one at a time** (the strip switches agents), **two columns**, **three columns** or a **2×2 grid**. Each pane has a header (status, branch, the running **session's name**, Compact, Stop / Resume, Resume a Session, New Session, Merge, menu with Agent Settings, Review Changes, Remove, Discard). **Resume** is a split button wherever it appears (project header, pane header, pane placeholders): the main part resumes the agent's own session — its last one, else the latest it ran in its folder, skipping archived ones and any open in another agent (worked out in main as `AgentInfo.resume`) — and is disabled with an explanation when there is none; **▾** opens a picker of the 10 most recent sessions from the agent's folder with when each was last active, which agent last ran it and an expired-cache warning; sessions open in another agent are greyed and clicking one shows that agent. The session name (Claude Code's title while the Hive name is still the automatic "<project> · <date>" one) shows in each pane header and, for the focused agent, in the project header; hover for when it started and its ID, click to read it in the Sessions tab. The agent strip's tooltips say what each agent is running or what Resume would open. Clicking a pane or its terminal focuses that agent; the project header's buttons, keyboard shortcuts, Ctrl+V images and Insert into Session act on the focused agent. Clicking an agent that isn't on screen puts it in the focused pane. Empty panes offer Add Agent. Ctrl+Alt+] / Ctrl+Alt+[ cycle agents. The sidebar keeps **one dot per project** (the most urgent agent's state: needs input, then working…), with a count when several agents run; the project header badge does the same, with each agent's status on hover. Notifications, the quit dialog and the tray name the agent when a project has several. There is no limit on running sessions across projects. Only visible terminals use WebGL, within a budget of 8 contexts per window (Chromium drops the oldest context beyond about 16, which could be a terminal on screen): hidden terminals keep theirs for 30 seconds so switching back is instant, or give it up at once when a visible terminal needs one; the rest draw with xterm's DOM renderer.
- **Session terminal**: Ctrl+V pastes text; if the clipboard holds only an image, Hive saves it to `.hive/images/<session id>/` and pastes the path, which Claude Code attaches. Files dropped on the terminal are pasted as paths; dropped images are copied into the same folder first, so the transcript and the image history line up. Right-click pastes text only. (Claude Code's own Alt+V image paste still works, but its image is not kept by Hive.)
- **Project view tabs**: Session (terminal), Overview (usage, compaction, re-cache), Sessions (list and transcript viewer), Files (file browser), Images (session images), Changes (git diff), Memory, Skills, MCP, Settings (project overrides).
- **Files tab**: tree of the project folder with create (file/folder, inline name, `a/b/c` creates intermediate folders), rename (F2), delete to the Recycle Bin (Del, confirmed), cut/copy/paste and duplicate, multi-select, drag to move (Ctrl copies), drop from Explorer to copy in, drag onto the Session tab to paste paths, open in the default app, reveal, copy path. Git status colours; git-ignored entries and `.hive` dimmed; `.git` hidden. Folders load on expand; a recursive `fs.watch` keeps the tree live while the tab is open. Find searches the project (`git ls-files`, so ignored files are excluded). Selecting a file opens it in the right pane as an **editor** (Monaco, Ctrl+S saves, UTF-8 with BOM preserved, 5 MB limit, binary files refused). Previews come from a registry in `FileView.tsx`: Markdown (Preview/Split/Edit, front matter hidden, Monaco-coloured code blocks, relative images and links), CSV/TSV table, HTML in a no-permission sandboxed iframe, SVG as an image, images and PDF (Chromium viewer) through `hive-img:`. Unsaved edits are kept as in-memory drafts across file and tab switches (marked ● in the tree). Saves carry the file's modified time and are refused if it changed on disk; the user chooses Reload or Overwrite. Clean files follow changes on disk. Third-party preview plugins are deferred.
- **Sessions tab**: the project's sessions (Hive, external, optionally archived) on the left; selecting one shows its transcript read-only on the right, read from Claude Code's file or Hive's backup. Your messages and Claude's replies (Markdown) are shown in full; thinking and each tool call (one-line summary: the command's description, the file, the pattern…) collapse, with input and result on expand. Tool input/output over 4,000 characters is shortened, with **Show all**. Subagent work appears as its Agent tool call with the final report. Each compaction is an inline divider with trigger, size before and after, the first request's real size after it (including instructions and tools) and the collapsible summary. Slash commands and `!` commands show with their output. Pasted images show as thumbnails (the base64 stored in the transcript, loaded lazily) and open in a viewer that also shows where the image came from. The view opens at the latest message; a running session is followed (2-second poll of the appended bytes) while you are at the bottom. Search (Ctrl+F) switches between **This session** and **All sessions**; hits list in the left pane (grouped by session for all), and clicking one opens that transcript, expands the item and highlights the matches. Per-message Copy, **Export as Markdown** (tool calls, thinking and summaries as `<details>`), **Resume** for sessions that are not running — **Resume in ▾** to choose the agent when several work in the session's folder (by default the agent that last ran it, or another one that isn't running) — and **Show** for a running one, which opens that agent's terminal; plus Rename, Archive and Adopt. Parsing is incremental and cached per transcript in main (`transcripts.ts`, `agents/conversation.ts`); blocks off screen use `content-visibility: auto`.
- **Images tab**: thumbnails of `.hive/images`, grouped by session, archived sessions last. Viewer with keyboard navigation; insert into session, copy image, copy path, reveal, delete to the Recycle Bin. Served to the renderer through the `hive-img:` protocol, restricted to image files inside the workspace.
- **Resizable panes**: the sidebar, the list beside the Sessions, Files, Changes and Memory tabs and the Docs view, and the Markdown/HTML split view have a drag handle (orange on hover). Double-click resets to the default. Sizes are kept per pane, not per project, in the app config (`ui.panes`); list widths are limited so the main area keeps at least 320 px, and the split stays between 20% and 80%.
- **Settings page**: JetBrains/VS Code style — searchable, category tree, every setting has a tooltip. **Project Settings** uses the same layout with its own categories (Claude Code, Sessions, Agents & Worktrees, Advanced) and search; overridden values are marked.
- **Files and Changes tabs** get a selector (Project folder / each worktree agent) when agents work in worktrees. For a worktree, Changes lists everything that differs from where its branch left the base branch (its commits and uncommitted edits, `git diff <merge-base>` plus untracked files), diffs against that point, and offers Merge.
- **Command palette** (Ctrl+Shift+P), keyboard shortcuts, toasts and notification centre.
- **Status bar**: workspace, branch, session counts, plan usage (5-hour and weekly %, reset times on hover; darker at 80%, red at 95%), model and effort / permission of current project (effort as the running session reports it, else the configured one; model shown by name: a project override plainly, an inherited one as "Opus (default)"; Claude Code's own default is named from its settings' `model` or the model last seen in a session started without `--model`, else "Claude Code default"), context size, Claude Code version, Agent API state, Hive's own version (opens About; dev builds show "Hive Dev"), notifications.
- **About** dialog (versions, data folder, licence links: Hive's MIT License and the third-party notices open in the Docs view, the Chromium licences file opens from the install folder), **Docs** view (user guide, Agent API reference, release notes, licence, third-party notices, shortcuts), first-run Claude Code setup.

### 13.1 Colour scheme

VS Code's dark neutrals with **honey orange** replacing VS Code blue as the accent.

| Token | Dark | Use |
|---|---|---|
| Accent | `#F59E0B` | focus, selection, primary buttons, active indicators |
| Accent strong | `#D97706` | status bar, pressed states |
| Background | `#1E1E1E` / `#252526` / `#2D2D30` | editor / sidebar / panels |
| Info | `#3B9EFF` | links, informational badges |
| Success / Warning / Error | `#4EC96B` / `#F5C451` / `#F2555A` | status dots, bypass warning |

A light theme uses the same accent with VS Code Light neutrals.

---

## 14. Tray, notifications and sound

- Close and minimise go to the tray (each configurable). Quit via tray or File → Exit.
- **Quitting** stops all sessions (they stay resumable). Setting *Confirm before quitting*: **When an agent is working** (default; working or waiting on a prompt), **Whenever sessions are running**, or **Never** (the earlier on/off setting migrates to working/never). The confirmation is an in-app dialog (the window is shown first) listing each session with its status, marking the ones that would be interrupted, with *Don't ask again*, *Cancel*, *Quit when agents finish* (only when an agent is working) and *Quit now*. No native message boxes.
- **Quit when agents finish**: Hive hides, the tray tooltip and menu show the pending quit (*Quit Now*, *Cancel Pending Quit*), a banner shows it if the window is opened, and Hive quits as soon as no agent is working.
- Quitting without a dialog (or after waiting) shows a notification that the stopped sessions can be resumed. Shutdown waits up to 3 s for each session's final transcript backup.
- Tray icon shows an attention badge when a session is waiting or finished unseen. Tray menu lists active projects with status.
- Native Windows notifications for waiting/finished when the window is hidden or unfocused (configurable).
- Chime synthesised in-app (several styles, volume), global on/off with per-project override.

---

## 15. Resolved decisions

1. `<Workspace>/.hive/` is committed.
2. Archived transcripts are preserved, never deleted. Non-archived sessions are backed up too.
3. Skills/MCP must be deployed to the workspace before a project can use them. Project-only MCP servers are disabled until copied.
4. Permission mode: global default Manual, per-project override, bypass behind an opt-in setting.
5. Machine and Local skills are always on and read-only in Hive.
6. The standalone Claude Code CLI is mandatory; editor-extension copies are not supported.
7. Pasted and dropped images are saved in the project's `.hive/images` (by session) and passed to the agent as paths, so each image is kept and tied to the point in the transcript where it was sent.
8. Deleting from the Files and Images tabs moves items to the Recycle Bin; Hive never deletes project files permanently. Images are never removed automatically.
9. Transcripts are read-only in Hive: the Sessions tab shows and exports them but never edits them. Claude Code owns the file and only ever appends to it.
10. Up to four agents per project, each in the project folder or its own Hive-managed git worktree (Hive creates, merges and removes worktrees itself rather than using Claude Code's `--worktree`, because the worktree must outlive sessions).
11. Agents sharing a folder are protected by Hive-enforced per-file locks (Block by default). Concurrent changes to shared config and memory are a documented risk, not prevented.
12. Worktrees live next to the workspace (`<Workspace>.worktrees/<Project>/<agent>`). New worktrees get `.env*` copied by default and an optional per-project setup command. Merging defaults to squash; after a merge the worktree and branch are removed unless unticked.
13. Hive is open source under the **MIT License** (`LICENSE`, © 2026 Darren Marshall). Everything it ships is under permissive licences (MIT; DOMPurify MPL-2.0 or Apache-2.0; codicons CC-BY-4.0); `THIRD_PARTY_NOTICES.md` lists them with full texts and is regenerated by `scripts/licenses.mjs` on every build. Electron's and Chromium's licences ship in the install folder (electron-builder adds `LICENSE.electron.txt` and `LICENSES.chromium.html`).
