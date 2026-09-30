# Hive — Specification (v0.2)

Hive is a desktop app for AI-assisted ("vibe") coding. It looks and feels like a streamlined VS Code, but its centre of gravity is the **agent session**, not the text editor. It organises code into Workspaces and Projects, runs CLI agent sessions (Claude Code and Codex, up to four agents per active project), and manages the skills, MCP servers and shared notes those sessions use.

This document is the source of truth for product decisions. Update it when decisions change.

---

## 1. Goals and non-goals

**Goals**
- Open or create a Workspace; list its Projects in a left-hand pane.
- Run Claude Code and Codex sessions per active Project in embedded terminals, several at once; each agent chooses its provider, so a project can mix them.
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
- Providers beyond Claude Code and Codex. The provider framework (§10) is built for more; each needs its own adapter.
- Moving a conversation between providers. Work moves through a handover (**Continue with…**, §6.2).
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
| Tests | Vitest (unit, in CI) and Playwright `_electron` end-to-end suites (`tests/e2e`, local: they need the CLIs) |
| Checks | TypeScript, oxlint (`.oxlintrc.json`; typescript-eslint doesn't support TypeScript 7 yet), GitHub Actions on every push to `main` and on pull requests |

Process model: the **main process** owns the filesystem, ptys, hook server, Agent API and agent adapters. The **renderer** is UI only and talks to main through a typed preload bridge (`contextIsolation: true`, `sandbox: true`, no `nodeIntegration`).

Robustness and safety rules:

- **Hive's JSON files** (`project.json`, `sessions.json`, `config.json`…) are written to a temporary file and renamed into place, each write with its own temporary file, so a crash or two writes at once never leave a partial file. The files Hive keeps (`config.json`, `workspace.json`, `project.json`, `sessions.json`) also get a `.bak` copy of the last good version with every save; a file that can't be read is set aside as `<file>.corrupt-<time>`, the `.bak` restored and the user told (or, with no good copy, defaults used and the user told), so a damaged file never silently turns into lost settings or session records. Read-modify-write changes to one project's `project.json` or `sessions.json` are serialised, so changes made at the same moment (two agents finishing together) are all kept.
- **Session IDs** from the renderer, the Agent API or the file system are checked (letters, digits, `-`, `_`) before they are used in a file name.
- **Starting an agent** is reserved before anything else happens, so two starts at once (a double click, or the UI and the Agent API) start it only once; the other is refused.
- **The window** only uses the clipboard; every other permission a page can ask for is refused, and a build's CSP allows no network connections. IPC calls are accepted only from Hive's own top-level page (not an embedded preview). Paths from the window are checked against the workspace by their real location too (following links and junctions), for `file:read`/`file:write`, `hive-img:` and shared notes.
- **Files the renderer may open** outside the workspace are limited to what Hive shows from each provider's config folder: Claude Code's user `CLAUDE.md` and auto-memory files and Codex's user `AGENTS.md` (editable), and `SKILL.md` files (read-only), never credentials or settings.
- **The UI** catches errors per view: a failure in one tab or view shows a message there (**Try Again**, **Open Logs**) instead of blanking the window, and running sessions are unaffected.

Primary platform is Windows 11. Code avoids Windows-only assumptions where cheap.

---

## 3. Concepts

- **Workspace** — a folder that contains Projects. One workspace is open per window. Hive remembers recent workspaces.
- **Project** — any direct child folder of the workspace, excluding dot-folders (so `.hive` is never a project). Creating a project in Hive creates the folder.
- **Active project** — a project switched on with its toggle. Only active projects get a terminal, watchers, status indicators and notifications. Activating a project **never** starts or resumes a session; it offers "Resume last session" and "New session". Deactivating requires stopping the live session (after confirmation). Active state is personal, so it is stored in app data, not in the workspace.
- **Provider** — the CLI an agent runs: **Claude Code** (Anthropic) or **Codex** (OpenAI). The UI uses product names, and "provider" where a generic word is needed. Providers are enabled in Settings → Providers; a fresh install has none enabled (a banner links to the settings), and an upgrade from 0.1 keeps Claude Code enabled. With none enabled, no agent can start and none can be added.
- **Agent** — one of up to four session slots in a project. **All agents are equal** and a new project has **none**: agents are added (Add Agent) and removed (when stopped) freely, and each works in the project folder or in its own **git worktree** (a separate checkout on its own branch). Agents are named ("Agent 1", "Agent 2"…, renamable), have random ids that are never reused, and always store their **provider**, chosen when they are added; defaults never move an existing agent. An agent can override the project's model, effort and permission mode for its provider. Changing an agent's provider clears those overrides and its last session. Each agent has at most one live session. Agents of a disabled provider stay listed, greyed out, and can't start. Upgrading from 0.1 clears every project's agents and layout (their sessions stay and can be resumed by an agent added again).
- **Session** — one conversation of a provider's CLI. Claude Code sessions have a UUID Hive chooses; Codex chooses its own ID, which Hive learns from the first hook (with the first prompt). A session can only be resumed by an agent of the same provider. A project has at most one live session per agent plus any number of past (resumable) and archived sessions.
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
    project.json.bak, sessions.json.bak   # last good copies (see §2)
    launch-<agent id>/    # Claude Code agents: regenerated on every launch — do not edit
      plugin/.claude-plugin/plugin.json
      plugin/skills/<skill>/...     # copies of enabled Hive skills
      mcp.json
      settings.json                 # hooks Hive injects
      sync.json                     # hash of each item copied
  .agents/skills/hive-<skill>/  # Codex agents: copies of enabled Hive skills (Codex reads skills only here),
                                # each with a .hive-copy marker (only marked folders are replaced or removed);
                                # git-excluded with a /.agents/skills/hive-*/ line in .git/info/exclude
```

Codex takes everything else from `-c` overrides on its command line (§6.4), so it needs no launch folder.

Worktrees Hive creates for agents live **next to the workspace**, in `<Workspace>.worktrees/<Project>/<agent>` (e.g. `D:\Dev\HIVE.worktrees\hive\agent-2`), so the project's own tools (tsc, test runners, search, file watchers) don't scan a second copy of the code, and Hive doesn't take them for projects. Transcripts, backups and images of worktree agents still live in the project's `.hive` folder.

### 4.3 App data (`%APPDATA%/Hive/`)

- `config.json` — settings, recent workspaces, active projects per workspace, window state. Version 2 keeps each provider's settings in `settings.providers[<id>]` and plan usage per provider and limit. Before the first version-2 save, the 0.1 file is copied to `config.v1-backup.json`, and the 0.1 `settings.claude` block is still written, so 0.1 can read the file again.
- `agent-api.json` — Agent API token.
- `logs/hive.log`

### 4.4 Schemas

```jsonc
// <Workspace>/.hive/workspace.json
{ "version": 1, "skills": { "enabled": ["handover"] }, "mcp": { "enabled": ["github"] } }

// <Project>/.hive/project.json
{
  "version": 2,                          // 2 since 0.2.0: reading an older file clears its agents and layout
  "skills": { "disabled": [] },          // subset of globally enabled
  "mcp":    { "disabled": [] },
  "chime": "inherit",                     // inherit | on | off
  "defaultProvider": "inherit",           // inherit | claude-code | codex — for new agents
  "providers": {                          // per-provider overrides; each field inherit | value
    "claude-code": { "model": "inherit", "effort": "inherit", "permissionMode": "inherit", "extraArgs": "" },
    "codex":       { "model": "gpt-6-sol", "effort": "high", "permissionMode": "approve-for-me", "extraArgs": "" }
  },
  "agents": [ { "id": "a-7b21e4aa", "name": "Reviewer", "provider": "codex", … } ],   // none at first
  "sessionLayout": "columns2",            // single | columns2 | columns3 | grid; follows the count when an agent is added
  // 0.1's flat model/effort/permissionMode/extraArgs are still written (Claude Code's values) for downgrades.
}

// <Project>/.hive/sessions.json
{ "version": 1, "sessions": [ { "id": "…", "agent": "claude-code", "agentId": "a2", "name": "…",
  "createdAt": "…", "lastActiveAt": "…", "archived": false,
  "transcriptPath": "…",        // Codex: where its rollout file is (it can't be found from the folder)
  "continuedFrom": "…" } ] }    // the session whose work this one continues (Continue with…)
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

**Provider** — stored on each agent when it is added. The project's default provider, else the global one (Settings → Providers), is what **Add Agent** uses: its quick add adds an agent with that provider and its default settings in the project folder; **Add Agent…** (▾) chooses the provider, where it works and its settings.

**Model, effort, permission mode, chime** — per provider: the global value is on the provider's settings page (Settings → Claude Code, Settings → Codex), the project's in Project Settings under the provider's name, and the project value overrides unless it is `inherit`. An agent's own model, effort or permission mode (set when adding it, or in its settings) overrides the project's; unset, it follows the project. A mode that isn't allowed (e.g. Bypass after the option was turned off) falls back to the project's, then the global one.

**Agents** — *File locks* (global Settings → Agents & Worktrees, default **Block**; project override), *Copy into new worktrees* (global list, default `.env*`; project override), *Setup command* (project only, empty by default), *Default merge style* (global, default **Squash**).

**Permission mode**
- Global default: **Auto** (Claude Code's safety classifier approves low-risk actions and asks about risky ones; Manual asked too often to be a good default for supervising several agents).
- Project dropdown: Inherit, Manual, Accept edits, Plan, Auto, Don't ask — always available.
- **Bypass permissions** is only offered when Settings → Claude Code → "Enable the Bypass permissions option" is ticked (ticking asks for confirmation). Projects using it show a warning indicator.
- If the option is later unticked, projects set to bypass revert to Inherit and the user is told which ones changed.
- **In a running session** the mode can be switched without a restart. Hive knows the session's real mode from its launch flag, from Claude Code's footer as the terminal redraws (`⏵⏵ auto mode on`, `⏸ plan mode on`, …) and from `permission_mode` in hooks, so a Shift+Tab typed in the terminal shows in Hive at once. Choosing a mode (the mode badge in the project header, a pane header or the status bar, or **Switch Permission Mode…**, Ctrl+Alt+M) sends Shift+Tab until the footer shows it. Claude Code's cycle is Manual → Accept edits → Plan → Auto; Don't ask leaves it once left, and Bypass is only in it for a session launched in Bypass (it shows Claude Code's own warning the first time), so those two restart the session in the mode and resume the same conversation, after confirmation. Not while the agent is asking something (Shift+Tab could change the answer). A live switch affects that session only.
- **Codex presets**: Read only (`-s read-only -a on-request`), Ask for approval (`-s workspace-write -a on-request`), **Approve for me** (`--approve-for-me`: Codex's reviewer approves low-risk actions; the default, like Auto) and **Full access** (`-s danger-full-access -a never`). Full access is treated like Bypass: only offered when Settings → Codex → "Enable the Full access option" is ticked (with confirmation), badged as a warning, and reverted to Inherit when unticked. A running Codex session switches preset live: Hive clears the input (Ctrl+U), types `/permissions`, and picks the preset from Codex's menu; Plan mode is a separate toggle (Shift+Tab, shown as "· Plan" on the badge).
- **Changing the setting** (global, project or agent) never restarts anything and no longer marks sessions "restart to apply". New sessions use it; for running agents whose setting changed, a notification offers **Switch Now**, which switches them live (or reports which couldn't be).

---

## 6. Session lifecycle

§6.1 and §6.3 describe Claude Code; §6.4 is how Codex differs. Every launch has a **run ID**, so hooks reach the right agent before the session ID is known (hook URL `<hook server>?run=<runId>`).

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

Environment added to the pty: `HIVE_HOOK_TOKEN`, `HIVE_API_URL`, `HIVE_API_TOKEN`, `HIVE_API_TOKEN_FILE`, `HIVE_PROJECT`, `HIVE_PROJECT_PATH`, `HIVE_WORKSPACE`, `HIVE_AGENT` (the agent's name), `HIVE_PROVIDER`, `HIVE_RUN_ID` and, when known at launch, `HIVE_SESSION_ID`. Every provider's own session variables inherited from Hive's environment (e.g. `CLAUDECODE`, `CODEX_THREAD_ID`) are removed.

Each Claude Code agent launches from its own folder (`launch-<agent id>/`), because a launch replaces the folder while the project's other agents may still read theirs (skills are read when used).

Rebuilding `launch/` on every launch guarantees anything disabled globally is gone after a restart or app relaunch.

### 6.2 Operations

| Action | Behaviour |
|---|---|
| New session | New UUID. A live session is stopped first (with confirmation). In a project without agents, New Session (and Resume) first adds one with the quick add, then starts it. |
| Resume | `--resume <uuid>`, in an agent that works in the folder the session ran in (sessions record their agent, folder and branch). Shows the re-cache estimate (§9) first. If the session has no transcript yet (nothing was typed before it stopped or was restarted), it is started fresh with `--session-id <uuid>` instead. **One conversation runs in one agent at a time**: the main process refuses to resume a session that is open in another agent (two terminals would both append to its transcript), for the UI and the Agent API alike; the UI shows that agent instead. A paused session can move between agents that share its folder (never across worktrees); the record then names the new agent, and any other agent whose *last session* it was forgets it. |
| Stop | Ends the pty. Session stays resumable. |
| Compact | Header button next to Stop, Session menu, command palette. Enabled only while the agent is idle (Ready/Finished) and the conversation has content. A dialog shows the context size and cache state and takes an optional **focus**; empty lets the agent decide what to keep. Hive sends Ctrl+U (clears half-typed input; Claude Code's Ctrl+Y restores it), then `/compact [focus]`. Status shows "Compacting…" until `PostCompact`, a new compaction in the transcript, a refusal in the output ("Not enough messages to compact"), no `PreCompact` within 20 s, or 10 minutes. The button and the status-bar context count turn orange above *Suggest compacting above* (global, default 200,000 tokens; per-project override; 0 never). The full pre-compaction history stays in the transcript and Hive's backup. |
| Archive | Copies the current transcript to `.hive/archive/` (or moves the backup there if Claude Code no longer has it), removes the active backup and marks the session archived. Never deleted. Can be unarchived. |
| Adopt | Sessions for the project started outside Hive are listed and can be adopted into `sessions.json`. |
| Add agent | Up to four per project. **Add Agent** is a split button: the main part adds one at once (the default provider with its default settings, in the project folder, named "Agent n"); **▾ Add Agent…** opens the dialog: provider, name, where it works (project folder, new worktree with branch `hive/<name>` from a chosen base branch, or an existing unused worktree of the project), optional model/effort/permission overrides, and "Start a session now". Adding an agent sets the layout that shows every agent (1 one at a time, 2 two columns, 3 three columns, 4 the grid) and focuses the new one; choosing a layout by hand still works. |
| Merge (worktree agent) | Commits the worktree's uncommitted changes (with the message given), checks for conflicts with `git merge-tree` without touching anything, then merges into the branch checked out in the project folder: **squash** (one commit, default) or **merge** (`--no-ff`). Refused while the project folder has staged changes. On conflict nothing changes; the dialog lists the files and offers to send merge instructions to an idle agent in the project folder, or copy them. Optionally removes the worktree, branch and agent afterwards (agent must be stopped). |
| Remove agent | Any agent, once stopped. A worktree agent asks whether to keep the worktree and branch (reusable via "existing worktree") or delete both. The layout stays as it was. |
| Discard (worktree agent) | Stops it, deletes the worktree and branch, removes the agent. |
| Continue with… (agent menu) | Hands the agent's work to another agent of the project, of any provider (conversations can't move between providers). Optionally the source (running and idle) is first asked to write a handover with `hive_create_handover`; Hive waits until a handover for the project newer than the one before exists (up to 15 minutes; if the agent finishes, asks something or stops without writing one, Hive says so and nothing starts). The target then starts a new session (waiting up to 5 minutes for it to be ready, e.g. while the user answers a trust question), or, if it is running and idle, gets the message in its session: read the latest handover with `hive_read_latest_handover` and continue. The target's session record gets `continuedFrom`; the Sessions tab shows a **continued** badge linking to the source session. Needs Hive's tools in sessions; busy agents can't be chosen. Also `POST /v1/projects/{name}/continue`. |

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

**Another conversation in the same CLI** (Claude Code `/clear` or `/resume`, Codex `/new`): its first prompt's hook carries a different session id for the same launch. Hive then backs up the old conversation, records the new one (as the agent's session to resume) and follows it — usage, backups, the context meter. Only a prompt switches: helpers a CLI runs for itself (subagents) can report other ids.

Hooks are normalised by each adapter into one set of events (start, prompt, tool start/end, needs input, stop, interrupt, compact start/end, end), so the status rules above are shared by every provider.

**File locks.** Hooks are matched to sessions by `session_id`, so every agent reports its own status. For file edits, `PreToolUse` asks Hive first: the first agent to edit a file (absolute path) claims it; while the claim holds, another agent's edit of the same file gets, depending on the lock mode, `permissionDecision: "deny"` with a reason naming the holder (**Block**, default), `"ask"` (**Ask me**: Claude Code's permission prompt), or `additionalContext` warning it (**Warn**); **Off** skips the check. For CLIs whose hooks can't hand an edit to their own approval prompt (Codex rejects `"ask"` and then runs the tool; descriptor capability `lockAsk`), **Ask me** denies the edit, telling the agent to stop and wait, and Hive shows a notification with **Allow**; Allow lets that agent edit that file until its claims are released and, if the agent is idle, tells it to go ahead. A claim is released when the holder's turn ends (`Stop`), when its session ends, or 15 minutes after its last edit. Denials return at once, so agents can't deadlock; if Hive doesn't answer, the edit goes ahead. Only these tools are covered: shell commands, formatters and Claude Code's own config writes (`~/.claude.json`) are not — concurrency there is the developer's responsibility. Agents in different worktrees never collide (different paths). Claimed files are shown on the agent's tab and pane header (lock icon with a count; the list on hover).

**Status line** (Claude Code): `launch/settings.json` also sets Claude Code's `statusLine` to the same `curl.exe` command, posting to `/hook?statusline`. The hook server answers 204 with no body, so Claude Code shows no status line in the terminal. From the JSON Hive takes the session's effort (`effort.level`), model name and cost (`cost.total_cost_usd`) into the live state, and the plan limits (`rate_limits.five_hour` / `seven_day`: `used_percentage`, `resets_at`) into `config.json` (`planUsage`, account-wide, last report wins). Claude Code reports with every status-line update, many times a minute while agents work, so the latest report is kept in memory and written only when a shown value changes (a whole percentage or a reset time), at most once a minute, and on quit. Warnings at 80% and 95% are shown once per limit per reset period (`planWarnings`; a reset time within 30 minutes of the stored one counts as the same period). Hive never calls Anthropic's usage API or reads credentials itself.

### 6.4 Codex

Tested with Codex 0.159. Hive never edits Codex's own `config.toml`; everything is passed as `-c key=value` overrides (TOML values):

```
codex [resume <id>] --no-daemon          # options must follow "resume <id>"
      -c hooks.<Event>=[…] -c hooks.state={…trusted hashes…}
      [-m <model>] [-c model_reasoning_effort=<e>] <preset flags (§5)>
      -c developer_instructions="<the hive MCP server's instructions>"
      -c mcp_servers.<name>={…}          # each enabled workspace server
      -c mcp_servers.<other>.enabled=false   # the user's and the project's own servers
      [extra args]
```

- **Hooks**: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Stop, Interrupt, PreCompact, PostCompact, SessionEnd, each a command hook. Codex runs hook commands through PowerShell on Windows, so the command is `curl.exe -s -m 5 -X POST -H "Authorization: Bearer <token>" -H "Content-Type: application/json" --data-binary "@-" "<url>"`. Codex only runs hooks it trusts: Hive passes the trust records in one `hooks.state` table, keyed by `<session-flags config path>:<event label>:0:0` with `sha256:` of the hook's canonical JSON. For each new Codex version Hive checks its hashes against Codex's own (the app server's `hooks/list`) once, and uses Codex's if they differ.
- **Ready**: Codex fires SessionStart only with the first prompt, so Hive marks the agent ready when Codex's prompt appears in the terminal, and records the session (its ID and rollout path) at the first hook.
- **Status**: PermissionRequest, and PreToolUse for `request_user_input`, mean **waiting**; Interrupt (Esc) means **ready** and releases the agent's file locks. File locks use PreToolUse with `apply_patch` (paths from the patch; in code mode too).
- **Live preset changes** go through Codex's `/permissions` menu: Hive clears the input, types `/permissions` and the preset's number (the arrow keys wrap around, so counting presses picked the wrong preset). The badge shows "Switching to X…" until Codex confirms, from its "Permission selection requested: X" line or the rollout's `thread_settings_applied`, within 12 seconds; otherwise it reverts and says so.
- **Models** come from Codex itself (`codex debug models`: the listed models, in Codex's order) when the CLI is found, so new models appear without a Hive update; Hive's own list is the fallback.
- **Live details** (model, effort, context, plan limits, preset, Plan mode) come from the tail of the rollout file (`token_count` events and `thread_settings_applied`), read as it grows.
- **Sandbox**: on Windows Codex needs its sandbox set up once (`windows.sandbox` in its config); without it every command asks for approval. Agent Setup runs Codex read-only in a scratch folder and brings up Codex's own setup prompt (default or non-admin sandbox): with no sandbox yet, by choosing "Ask for approval" in `/permissions`; with the non-admin sandbox on (`unelevated`), by typing `/setup-default-sandbox`, which only exists then. Agent Setup explains the two choices in Hive's terms (`ReadinessIssue.detail`), and with the non-admin sandbox shows an info item with **Upgrade** (the same task). Codex stays open after its setup, so the task ends itself once Codex's config names a new sandbox (`CommandSpec.done`); Agent Setup then shows that the task succeeded (the issue it was started for is gone) instead of the terminal.
- **Resume**: `codex resume <id>` restores a rollout only at its original path, so Hive keeps that path in `sessions.json` and restores a backup there when Codex's copy is gone.
- `.git` is read-only in Codex's workspace-write sandbox (committing asks for approval).

---

## 7. Skills and MCP

### 7.1 Skill levels

| Level | Location | Loaded | Managed by Hive |
|---|---|---|---|
| **Hive** | `<Workspace>/.hive/skills/`, copied into `<Project>/.hive/launch/plugin/skills/` | Only when enabled | Yes — global and project toggles |
| **Machine** | `~/.claude/skills/` and installed Claude Code plugins | Always | No — listed read-only |
| **Local** | `<Project>/.claude/skills/` | Always, in that project | No — listed read-only, with "Copy to workspace" |

For Codex, Hive skills are copied into `<agent folder>/.agents/skills/hive-<name>` on each launch (removing Hive copies no longer enabled), since Codex reads skills only from there; Machine skills are `~/.codex/skills`, Local skills the project's own `.agents/skills`.

Hive skills are added manually (a remote repository is a future idea). The workspace folder is a store only; no agent loads from it directly. Copies are used (not links) so a live session keeps a fixed version; edits reach the next session.

### 7.2 MCP servers

One file per server: `<Workspace>/.hive/mcp/<name>.json`, in Claude Code's format plus an optional `description`:

```json
{ "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }, "description": "GitHub issues and PRs" }
```

Enabled servers are merged into `launch/mcp.json` for Claude Code, and passed to Codex as `-c mcp_servers.<name>={…}` (with `default_tools_approval_mode = "approve"`). The user's own servers and a project's own (`.mcp.json` for Claude Code, `.codex/config.toml` for Codex) are not loaded, by the same rule as §5. Secrets are passed as environment references only; a definition whose values can't be passed safely to Codex is skipped with a log warning. Server code in `<Workspace>/.hive/mcp/<name>/` is referenced in place, not duplicated. Hive warns when a definition looks like it contains a literal secret.

### 7.3 Built-in Hive MCP server

If "Provide Hive tools to sessions" is on (default), every session, of every provider, also gets a `hive` MCP server (bundled script run via Hive's own executable) exposing the Agent API as tools: list projects, project status, read/write shared notes, read the latest handover, create handovers, notify the user, session usage. Its MCP instructions (sent on `initialize`) tell the agent when to use each tool, and that handovers and shared notes live in the workspace, not the project. If the project has a handover, the instructions name the latest one. A handover belongs to a project when its file name is `<date>-<project slug>-<title slug>.md` (as `hive_create_handover` writes it). When project names overlap (`hive`, `hive-website`), a file that could belong to either is decided by its `- **Project:** <name>` header line. Codex doesn't show MCP server instructions to the model, so Hive passes the same text to Codex as `developer_instructions`.

---

## 8. Git

- Project: `.hive/` is added to `.git/info/exclude` (idempotent) when the project is a git repo; re-checked on activation.
- Workspace: `.hive/` is **not** excluded; it is meant to be committed.
- The Changes tab shows `git status` and a Monaco diff (HEAD vs working tree) per file.

---

## 9. Usage, compaction and memory

Each provider's adapter reads its own transcripts into one usage shape. Codex: rollout files under `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl` (`token_count` events for tokens, context window and plan limits; `session_index.jsonl` for titles). Claude Code: `~/.claude/projects/<encoded-path>/<session-id>.jsonl`, where the encoded path replaces every non-alphanumeric character of the project path with `-` (matched case-insensitively).

**Model choice** (global default and per project): Latest aliases, pinned versions and older versions (hidden until requested), from a list built into Hive of the models Claude Code knows; a custom model ID; and a 1M-context toggle (`[1m]` suffix) for Fable, Opus 4.6+ and Sonnet 4.5+. Availability for the account is only known when a session starts.

**Metrics per session**
- Input, output, cache-write, cache-read tokens (assistant `message.usage`, de-duplicated by request id).
- Current context size: the last assistant entry's `input + cache_read + cache_creation`.
- Compactions from `system/compact_boundary` entries: trigger, `preTokens`, `postTokens`.
- Cache TTL detected from `cache_creation.ephemeral_1h_input_tokens` vs `ephemeral_5m_input_tokens` (overridable in settings).
- Model, Claude Code version, session title (`ai-title` / `custom-title`), last activity.
- API-equivalent cost from `cost-state` entries (`totalCostUSD`), shown on the Overview as "API-equivalent cost". For providers that don't report cost (Codex), Hive **estimates** it from a price table (per million tokens: input, cached input, cache write, output), shown with "≈". Hive ships the published API prices (checked 30 Sep 2026; Claude's cache writes are 1.25× input and cache reads 0.1× unless listed) and each provider's settings page has an editable table; the user's prices override Hive's. A model with no price shows no cost. It is the API-equivalent value, not what a subscription charges.

**Keeping up with the CLIs**: a transcript of over 200 KB in which Hive finds no requests at all is taken as a format change it doesn't understand, and the user is told once per provider version. Sample transcripts per supported CLI version are unit-test fixtures (`tests/fixtures`).

**Overview tab**: a period (Today, 7 days, 30 days, All time) and a project summary across every provider (tokens, API-equivalent cost, sessions, prompts), the agents running now (context against the model's window, cost), then one section per provider used (its totals and its plan limits: Claude Code's 5-hour and weekly, Codex's primary and secondary windows), a table by agent, and the focused agent's session details. It (and the session lists) update per **Settings → Sessions → Overview updates**: **Live** (default: as sessions change, at most every 15 seconds, only while shown), **Every minute**, or **Only on Refresh**; the Overview has a Refresh button. A session list reads each project and session file once.

**Re-cache estimate on resume**: if time since last activity exceeds the TTL, "Resume will re-cache ≈ N tokens" (N = current context size); otherwise "cache likely warm (≈ M min left)". Always labelled as an estimate.

**Transcript backups**: while a session is live Hive copies its transcript to `<Project>/.hive/sessions/` at most once a minute while it changes, at the end of every turn (`Stop`) and when the session exits, so sessions survive Claude Code's own cleanup without rewriting large files every few seconds.

**Memory tab**: grouped by provider. Claude Code: `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`, the user `CLAUDE.md` and its auto-memory folder for the project. Codex: `AGENTS.md` and the user `AGENTS.md`. When a project's agents use more than one provider and they don't read the same instructions, **Share one AGENTS.md…** makes AGENTS.md the shared file: CLAUDE.md gets an `@AGENTS.md` import line (anything else in it stays, for Claude Code only); with no AGENTS.md yet, CLAUDE.md's content moves into it first, so nothing is lost. Providers declare the import line in their descriptor (`instructionsImport`); those that read AGENTS.md themselves need none.

All parsing lives in the adapter, tolerates unknown fields, and degrades to "unavailable".

---

## 10. Provider framework

A provider is two pieces:

- **Descriptor** (`src/shared/providers.ts`, static data both processes use): id, product and company names, icon, permission modes (with danger flags and labels), effort levels, model groups, capabilities (fixed session IDs, live mode switch by cycle or menu, Plan toggle, prompt-cache TTL, reports cost, compact focus, 1M context, image paste), terminal keys the CLI reserves, instructions file and import line, setup notes.
- **Adapter** (`src/main/providers/<id>/`, `ProviderAdapter`): locate the CLI and check readiness (login, sandbox), setup tasks, launch (`prepareLaunch`, `buildCommand`), hook normalisation and file-lock replies, live details (status line or transcript tail), mode-switch keys, transcripts (path, restore, list, usage, conversation parser, images, export), memory sources, allowed files and skill folders, the project's own MCP servers.

The registry (`src/main/providers/index.ts`) lists the adapters; the rest of Hive (sessions, Overview, settings pages, status bar, Agent Setup, Sessions tab) works from descriptors and adapters without naming a provider. Adding a provider means a descriptor, an adapter, an icon and a price table. Skills and MCP are stored in a Hive-neutral form; adapters translate them at launch.

---

## 11. Provider installation and updates

The same rules apply to every provider's CLI; the details below are Claude Code's. Codex: installed with OpenAI's installer (`irm https://chatgpt.com/codex/install.ps1 | iex`) into `%LOCALAPPDATA%\Programs\OpenAI\Codex`, signed in with a ChatGPT plan or an API key, plus the one-time sandbox setup (§6.4). **Agent Setup** (Help menu) has a tab per provider with its install, sign-in, sandbox and update steps, and the readiness banner links to it for enabled providers that need something.

- Not bundled (proprietary; redistribution would need Anthropic's permission).
- **The standalone CLI is required** (Claude Code and Codex alike). Copies bundled with editor extensions (VS Code, Cursor, Windsurf) are never used, even if set manually: they move on every extension update and can't be updated with `claude update`. If only an extension is present, the setup dialog explains that the CLI is still needed.
- Discovery: settings path → `PATH` → `~/.local/bin/claude.exe` → npm global.
- Not found → first-run dialog offers a one-click install using Anthropic's official installer, run in a visible terminal.
- On launch (if enabled): read `claude --version`, compare with the latest published version, offer **Update** (`claude update`) in a visible terminal. Never updates while sessions are live.
- Auth is handled by each CLI itself. Hive never touches credentials, and never edits a CLI's own config files.

### 11.1 Hive's own updates

- **electron-updater** against GitHub Releases of `Suremise/hive-desktop` (`publish:` in `electron-builder.yml`). It reads `latest.yml`, downloads the NSIS installer (differentially when a `.blockmap` is available) and checks its SHA-512 before installing. Only published releases of a public repository are seen (drafts are not); no token ships with the app. With no published release, checks report "No release of Hive has been published yet". 0.1.0 (29 Sep 2026) was the first published release.
- **Settings → Updates**: *Check for updates automatically* (on: 30 s after start, then every 6 hours), *Download updates automatically* (on), *Install updates* — **Automatically, when Hive quits** (default) or **Manually, with Restart and Update** — and *Include pre-releases* (off). Hive never installs while it is running: sessions are never cut off by an update.
- **Restart and Update** goes through the normal quit flow (the quit dialog when agents are working, including *wait for them*), then installs silently and reopens Hive. Cancelling the quit cancels the update.
- **Where it shows**: the status bar's version item becomes *Hive X available*, *Downloading Hive X… N%* or *Restart to update to X* (click: update dialog); a notification when a download is ready; the update dialog (version, date, size, progress, release notes from the GitHub release, **Download**, **Skip This Version**, **Later**, **Restart and Update**, **On GitHub**); **Help → Check for Updates…** (always shows the result: up to date, available, or the error); the About panel and Settings → Updates (status and **Check Now**); the tray menu (*Restart to Update*). After an update, a notification links to the release notes.
- **Skip This Version** stops automatic checks offering that version; a manual check still shows it.
- Development builds never check (the status bar says so); tests point `HIVE_UPDATE_FEED` at a local feed, with their own download cache, and never run what they download.
- Releasing: `npm run release` uploads a draft release (installer, `latest.yml`, blockmap) with the `gh` login; it is published by hand on GitHub. See `RELEASING.md`.

---

## 12. Agent API

Local HTTP API on `127.0.0.1:<port>` (default 47821), bearer-token auth, token in `%APPDATA%/Hive/agent-api.json` and passed to sessions as `HIVE_API_TOKEN`. Errors use 400 (bad input), 401, 403, 404, 409 (conflicts with the current state) and 500 (unexpected). Endpoints under `/v1` for app status, workspace, projects, sessions, usage, shared notes, skills, MCP, notifications and a server-sent events stream. Full reference: `docs/AGENT_API.md`.

---

## 13. UI

- **Title bar** with menu bar (File, Edit, View, Session, Help), native window controls.
- **Activity bar**: Projects, Shared Notes, Skills, MCP Servers; Docs and Settings at the bottom.
- **Sidebar** per activity: project list (active toggle, status dot, warning for bypass, context menu), notes tree, skill/MCP lists with toggles.
- **Compact project list**: the Projects sidebar collapses to a 48 px rail — one tile per project with its initials ("web-dashboard" → WD, "hive" → Hi) and its combined status dot, working-on projects first, then a divider and the others. Hover shows the name, status, branch and each agent's state; click selects, double-click starts a session, right-click gives the usual project menu. Toggle it with the chevron in the list header or on the rail, **Ctrl+Alt+B**, or by dragging the sidebar edge below 120 px (dragging out again restores the earlier width). Only the Projects view compacts; Notes, Skills and MCP always show at full width. Kept in the app config (`ui.sidebarCompact`). Ctrl+B still hides the sidebar entirely.
- **Agents** (Session tab): a strip above the terminal lists the project's agents (status dot, provider icon, name, branch for worktree agents, lock count) and the **Add Agent** split button (quick add, or ▾ Add Agent…); a project without agents shows "No agents yet" with Add Agent, New Session (adds one and starts it) and All Sessions, and — once there is more than one agent — the layout: **one at a time** (the strip switches agents), **two columns**, **three columns** or a **2×2 grid**. Each pane has a header (status, branch, the running **session's name**, Compact, Stop / Resume, Resume a Session, New Session, Merge, menu with Agent Settings, Review Changes, Remove, Discard). **Resume** is a split button wherever it appears (project header, pane header, pane placeholders): the main part resumes the agent's own session — its last one, else the latest it ran in its folder, skipping archived ones and any open in another agent (worked out in main as `AgentInfo.resume`) — and is disabled with an explanation when there is none; **▾** opens a picker of the 10 most recent sessions from the agent's folder with when each was last active, which agent last ran it and an expired-cache warning; sessions open in another agent are greyed and clicking one shows that agent. The session name (Claude Code's title while the Hive name is still the automatic "<project> · <date>" one) shows in each pane header and, for the focused agent, in the project header; hover for when it started and its ID, click to read it in the Sessions tab. The agent strip's tooltips say what each agent is running or what Resume would open. Clicking a pane or its terminal focuses that agent; the project header's buttons, keyboard shortcuts, Ctrl+V images and Insert into Session act on the focused agent. Clicking an agent that isn't on screen puts it in the focused pane. Empty panes offer Add Agent. Adding an agent sets the layout to show every agent (§6.2). Ctrl+Alt+] / Ctrl+Alt+[ cycle agents. The sidebar keeps **one dot per project** (the most urgent agent's state: needs input, then working…), with a count when several agents run; the project header badge does the same, with each agent's status on hover. Notifications, the quit dialog and the tray name the agent when a project has several. There is no limit on running sessions across projects. Only visible terminals use WebGL, within a budget of 8 contexts per window (Chromium drops the oldest context beyond about 16, which could be a terminal on screen): hidden terminals keep theirs for 30 seconds so switching back is instant, or give it up at once when a visible terminal needs one; the rest draw with xterm's DOM renderer.
- **Session terminal**: Ctrl+V pastes text; if the clipboard holds only an image, Hive saves it to `.hive/images/<session id>/` and pastes the path, which Claude Code attaches. Files dropped on the terminal are pasted as paths; dropped images are copied into the same folder first, so the transcript and the image history line up. Right-click pastes text only. (Claude Code's own Alt+V image paste still works, but its image is not kept by Hive.)
- **Project view tabs**: Session (terminal), Overview (usage, compaction, re-cache), Sessions (list and transcript viewer), Files (file browser), Images (session images), Changes (git diff), Memory, Skills, MCP, Settings (project overrides).
- **Files tab**: tree of the project folder with create (file/folder, inline name, `a/b/c` creates intermediate folders), rename (F2), delete to the Recycle Bin (Del, confirmed), cut/copy/paste and duplicate, multi-select, drag to move (Ctrl copies), drop from Explorer to copy in, drag onto the Session tab to paste paths, open in the default app, reveal, copy path. Git status colours; git-ignored entries and `.hive` dimmed; `.git` hidden. Folders load on expand; a recursive `fs.watch` keeps the tree live while the tab is open. Find searches the project (`git ls-files`, so ignored files are excluded). Selecting a file opens it in the right pane as an **editor** (Monaco, Ctrl+S saves, UTF-8 with BOM preserved, 5 MB limit, binary files refused). Previews come from a registry in `FileView.tsx`: Markdown (Preview/Split/Edit, front matter hidden, Monaco-coloured code blocks, relative images and links), CSV/TSV table, HTML in a no-permission sandboxed iframe, SVG as an image, images and PDF (Chromium viewer) through `hive-img:`. Unsaved edits are kept as in-memory drafts across file and tab switches (marked ● in the tree). Renaming or moving a file or folder in the tab carries its drafts along; deleting warns that unsaved changes will be lost; quitting always asks while any file has unsaved edits (listed, with **Save them** or **Discard the changes**; a file that changed on disk is never overwritten, and Hive stays open), and **Reload Window** and switching or closing the workspace offer **Save All** first. Drafts are not kept across a crash (hot exit is a possible later addition). Saves carry the file's modified time and are refused if it changed on disk; the user chooses Reload or Overwrite. Clean files follow changes on disk. Third-party preview plugins are deferred.
- **Sessions tab**: the project's sessions (Hive, external, optionally archived) on the left; selecting one shows its transcript read-only on the right, read from Claude Code's file or Hive's backup. Your messages and Claude's replies (Markdown) are shown in full; thinking and each tool call (one-line summary: the command's description, the file, the pattern…) collapse, with input and result on expand. Tool input/output over 4,000 characters is shortened, with **Show all**. Subagent work appears as its Agent tool call with the final report. Each compaction is an inline divider with trigger, size before and after, the first request's real size after it (including instructions and tools) and the collapsible summary. Slash commands and `!` commands show with their output. Pasted images show as thumbnails (the base64 stored in the transcript, loaded lazily) and open in a viewer that also shows where the image came from. The view opens at the latest message and loads the latest 200 items; earlier ones load as you scroll up (or click), keeping your place, and a search hit further back loads from just before it. A running session is followed (2-second poll of the appended bytes, while you are at the bottom) only with **Follow** switched on (off by default: Settings → Sessions → Follow running sessions); otherwise **Refresh** loads what is new. Search (Ctrl+F) switches between **This session** and **All sessions**; hits list in the left pane (grouped by session for all), and clicking one opens that transcript, expands the item and highlights the matches. Per-message Copy, **Export as Markdown** (tool calls, thinking and summaries as `<details>`), **Resume** for sessions that are not running — **Resume in ▾** to choose the agent when several work in the session's folder (by default the agent that last ran it, or another one that isn't running) — and **Show** for a running one, which opens that agent's terminal; plus Rename, Archive and Adopt. Parsing is incremental and cached per transcript in main (`transcripts.ts`, `agents/conversation.ts`); blocks off screen use `content-visibility: auto`.
- **Images tab**: thumbnails of `.hive/images`, grouped by session, archived sessions last. Viewer with keyboard navigation; insert into session, copy image, copy path, reveal, delete to the Recycle Bin. Served to the renderer through the `hive-img:` protocol, restricted to image files inside the workspace.
- **Resizable panes**: the sidebar, the list beside the Sessions, Files, Changes and Memory tabs and the Docs view, and the Markdown/HTML split view have a drag handle (orange on hover). Double-click resets to the default. Sizes are kept per pane, not per project, in the app config (`ui.panes`); list widths are limited so the main area keeps at least 320 px, and the split stays between 20% and 80%.
- **Settings page**: JetBrains/VS Code style — searchable, category tree, every setting has a tooltip. **Project Settings** uses the same layout with its own categories (Claude Code, Sessions, Agents & Worktrees, Advanced) and search; overridden values are marked.
- **Files and Changes tabs** get a selector (Project folder / each worktree agent) when agents work in worktrees. For a worktree, Changes lists everything that differs from where its branch left the base branch (its commits and uncommitted edits, `git diff <merge-base>` plus untracked files), diffs against that point, and offers Merge.
- **Command palette** (Ctrl+Shift+P; **Go to Project**, Ctrl+P, lists projects only), toasts and notification centre.
- **Keyboard shortcuts** are configurable. Settings → Keyboard Shortcuts lists every command with its shortcut, where it comes from (default, changed, removed), conflicts (a warning, and a question before saving one) and keys that go to Claude Code while the terminal has focus. A shortcut is recorded by pressing it; a second combination within 1.2 s makes a chord. Refused: keys without Ctrl or Alt (except F-keys), Ctrl+C/V/X/A/Z/Y and Shift+Tab. Overrides are stored in `settings.keybindings` (`null` removes a default). **Project Settings → Keyboard Shortcuts** overrides the Project and Session commands for that project only, in `.hive/project.json` (`keybindings`), over the global ones. Keys are matched by physical key (`KeyboardEvent.code`), so Shift and AltGr don't change a combination's name. Defaults besides the existing ones: Ctrl+P Go to Project, Ctrl+Tab / Ctrl+Shift+Tab next/previous project tab, Ctrl+1…4 focus agent N, Ctrl+Alt+1…4 layouts, Ctrl+Alt+M permission mode, Ctrl+Alt+C Compact, Ctrl+Alt+Shift+N Add Agent, Ctrl+` focus the session terminal, Ctrl+Shift+` external terminal, Ctrl+Alt+U notifications. Help → Keyboard Shortcuts shows the current ones and links to the editor.
- **Providers**: Settings → Providers enables and disables each provider (disabling one with running agents asks whether to stop them now or let them run) and sets the default provider; each provider has its own settings page (path, default model, effort and permission mode, dangerous-mode option, extra arguments, update checks, price table). Provider icons (official marks) show on agent tabs, pane headers, the Sessions list and pickers. A banner shows while no provider is enabled, or an enabled one needs setup.
- **Status bar**: workspace, branch, session counts, plan usage per provider (one item each: Claude Code's 5-hour and weekly %, Codex's windows; reset times on hover; darker at 80%, red at 95%), model and effort / permission of the focused agent's provider (effort as the running session reports it, else the configured one; model shown by name: a project override plainly, an inherited one as "Opus (default)"; Claude Code's own default is named from its settings' `model` or the model last seen in a session started without `--model`, else "Claude Code default"), context size, each enabled provider's CLI version, Agent API state, Hive's own version (opens About; dev builds show "Hive Dev"), notifications.
- **About** dialog (versions, data folder, update status with Check Now, licence links: Hive's MIT License and the third-party notices open in the Docs view, the Chromium licences file opens from the install folder), **Docs** view (user guide, Agent API reference, release notes, licence, third-party notices, shortcuts), first-run Claude Code setup.

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
- **Quitting** stops all sessions (they stay resumable). Setting *Confirm before quitting*: **When an agent is working** (default; working or waiting on a prompt), **Whenever sessions are running**, or **Never** (the earlier on/off setting migrates to working/never). The confirmation is an in-app dialog (the window is shown first) listing each session with its status, marking the ones that would be interrupted, with *Don't ask again* (about sessions), *Cancel*, *Quit when agents finish* (only when an agent is working) and *Quit now*. Files with unsaved edits in the Files tab are listed at the top and always make Hive ask, whatever the setting, with the choice to save or discard them (the buttons read *Save and quit…* when saving). No native message boxes.
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
4. Permission mode: global default Auto (Manual until 0.1.0 development), per-project and per-agent override, bypass behind an opt-in setting.
5. Machine and Local skills are always on and read-only in Hive.
6. The standalone Claude Code CLI is mandatory; editor-extension copies are not supported.
7. Pasted and dropped images are saved in the project's `.hive/images` (by session) and passed to the agent as paths, so each image is kept and tied to the point in the transcript where it was sent.
8. Deleting from the Files and Images tabs moves items to the Recycle Bin; Hive never deletes project files permanently. Images are never removed automatically.
9. Transcripts are read-only in Hive: the Sessions tab shows and exports them but never edits them. Claude Code owns the file and only ever appends to it.
10. Up to four agents per project, each in the project folder or its own Hive-managed git worktree (Hive creates, merges and removes worktrees itself rather than using Claude Code's `--worktree`, because the worktree must outlive sessions).
11. Agents sharing a folder are protected by Hive-enforced per-file locks (Block by default). Concurrent changes to shared config and memory are a documented risk, not prevented.
12. Worktrees live next to the workspace (`<Workspace>.worktrees/<Project>/<agent>`). New worktrees get `.env*` copied by default and an optional per-project setup command. Merging defaults to squash; after a merge the worktree and branch are removed unless unticked.
13. Hive is open source under the **MIT License** (`LICENSE`, © 2026 Darren Marshall). Everything it ships is under permissive licences (mostly MIT and ISC; DOMPurify MPL-2.0 or Apache-2.0; codicons CC-BY-4.0; sax BlueOak-1.0.0; argparse Python-2.0); `THIRD_PARTY_NOTICES.md` lists them with full texts and is regenerated by `scripts/licenses.mjs` on every build. Electron's and Chromium's licences ship in the install folder (electron-builder adds `LICENSE.electron.txt` and `LICENSES.chromium.html`).
14. Hive updates itself from GitHub Releases with electron-updater: checked and downloaded automatically by default, installed only when Hive quits or with Restart and Update (or only manually, by setting), never while it runs.
15. The permission mode of a running session is switched live (Shift+Tab driven by Hive, confirmed from the footer), not by restarting; settings changes are offered to running agents, never forced.
16. Every command's shortcut is configurable globally, and project and session commands per project.
17. Providers: Claude Code and Codex, chosen per agent, so a project can mix them; each CLI's own terminal UI is shown (Hive doesn't draw conversations). The framework is built for more providers.
18. Workspace skills and MCP servers are shared by every provider; user-level MCP servers load for none, and a project's own servers follow the same rule for each CLI.
19. Fresh installs start with every provider disabled; upgrades from 0.1 keep Claude Code enabled. No enabled provider is a valid state.
20. Codex defaults to Approve for me; Full access is opt-in like Bypass. Hive drives Codex's `/permissions` menu for live changes.
21. Cost for providers that don't report it is estimated from a shipped, user-editable price table and always marked as an estimate.
22. Conversations never move between providers; **Continue with…** hands work over through a handover. Projects that mix providers can share one `AGENTS.md`, imported by `CLAUDE.md`.
23. Agents are all equal and a project starts with none; the provider is stored on each agent. Upgrading from 0.1 clears existing agents (their sessions stay).
24. Hive keeps a last good copy of its own JSON files and never silently replaces a damaged one.
