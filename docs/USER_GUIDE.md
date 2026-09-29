# Hive User Guide

Hive is a desktop workspace for coding with AI agents. It runs a Claude Code session for each project you're working on, side by side, and keeps track of what each one is doing, how many tokens it uses, and the skills and MCP servers it has.

## Getting started

1. **Install the Claude Code CLI.** Hive runs the standalone Claude Code command-line tool in each project; it is required and not included with Hive. The copy inside the VS Code (or Cursor) extension is not used. On first launch Hive looks for the CLI and offers a one-click install with Anthropic's official installer if it's missing (**Help → Claude Code Setup**). In your first session, choose a theme, sign in, and press Enter at "Login successful" so the sign-in is saved.
2. **Open or create a workspace** (**File → Open Workspace…** or **New Workspace…**). A workspace is any folder whose subfolders are your projects.
3. **Mark the projects you're working on** with the toggle next to each project.
4. **Start a session** with **New Session** (Ctrl+Shift+N). Claude Code opens in the Session tab. Switch to another project and start another — sessions keep running in the background.

## Workspaces and projects

A **workspace** is a folder of projects. When you open one, Hive creates a `.hive` folder in it:

```
MyWorkspace/
  .hive/
    shared/       notes, instructions and handovers for every project
    skills/       Hive skills (one folder per skill)
    mcp/          MCP server definitions (one .json per server)
    workspace.json
  ProjectA/
  ProjectB/
```

The workspace `.hive` folder is meant to be **committed** so a team can share skills, MCP servers and notes. Don't put secrets in it.

Each **project** (every subfolder except dot-folders) gets its own `.hive` folder for Hive's metadata: project settings, the session list and transcript backups. Hive adds it to the project's `.git/info/exclude`, so it's never committed and your `.gitignore` is left alone.

### Working on a project

The switch next to a project marks it as one you're **working on**. Only active projects run sessions, show live status and send notifications, so a workspace with dozens of projects stays quiet. Turning a project on never starts a session by itself.

Status dots:

| Dot | Meaning |
|---|---|
| Hollow | Active, no session |
| Blue | Session starting / ready for a prompt |
| Pulsing orange | Agent is working |
| Pulsing yellow | Agent needs your input (e.g. a permission prompt) |
| Green | Agent finished its task |
| Glow | Something happened you haven't looked at yet |

The sidebar and the lists in the Sessions, Files, Changes and Memory tabs can be made wider or narrower by dragging their right-hand edge, as can the two halves of a split view in the Files tab. Double-click the edge to reset it. Hive remembers the sizes.

**Compact project list.** To give the terminals more room while keeping an eye on every project, collapse the Projects sidebar to a narrow rail of status dots: click the **‹** chevron at the top of the list, press **Ctrl+Alt+B**, or drag the sidebar's edge almost all the way left. Each project shows as a tile with its initials and status dot; hover it for the name, status and agents, click to open it, right-click for the usual menu. Click **›** at the top of the rail (or press Ctrl+Alt+B again, or drag the edge out) to get the full list back. Shared Notes, Skills and MCP Servers always open at full width.

## Sessions

Each agent of a project runs one session at a time (most projects have just one agent; see [Several agents in one project](#several-agents-in-one-project)). The project header and the **Session** menu let you:

- **New Session** — start fresh. If one is running, Hive stops it first (after asking).
- **Resume** — continue a previous conversation. Hive shows how many tokens resuming will re-cache if the prompt cache has expired.
- **Stop** — end the session. The conversation is kept and can be resumed.
- **Compact** — summarise the conversation so far so every later message is cheaper. Available once the agent has finished; it turns orange when the context passes your threshold (**Settings → Sessions → Suggest compacting above**, 200,000 tokens by default, and overridable per project in Project Settings). You can add an optional focus ("keep the API decisions, drop the test output"); left empty, the agent decides what to keep. Nothing is lost: the full history stays in the session's transcript. Anything you had half-typed is cleared first; press Ctrl+Y in the session to get it back.
- **Archive & New** — archive the current conversation and start a clean one. This is the cheapest way to continue after a long session: the new session starts with an empty context instead of re-caching the old one. Write a handover first (see below) so the new session knows where to pick up.

### Reading past sessions

The **Sessions** tab lists every session of the project on the left, newest first, with when it was last used and its context size. Sessions started outside Hive (in VS Code or a terminal) appear as *external*; **Adopt** them to manage them in Hive. Tick **Archived** to include archived sessions.

Select a session to read its transcript on the right, from the first message to the last, including everything before each compaction:

- Your messages and Claude's replies are shown in full.
- Thinking and each tool call are collapsed to one line (for example "Bash · Run the login tests" or "Edit · src/app.ts"). Click one to see its input and result; very long output is shortened, with **Show all**. The expand button in the toolbar opens or closes them all.
- Each compaction is a divider showing whether it was manual or automatic, the context size before and after, and the size of the first request after it (which also carries Claude Code's instructions and tools). Click it to read the summary the agent continued from.
- Slash commands such as `/compact` appear with their output, and pasted images as thumbnails; click one to view it.

The transcript opens at the latest message. For the running session it updates as the agent works, and scrolls with it while you are at the bottom.

**Search** (Ctrl+F in the tab) looks through messages, replies, tool calls and results, and compaction summaries. Choose **This session** or **All sessions**; the matches replace the list on the left, grouped by session, and clicking one opens the transcript at that point with the matches highlighted. Clear the search to get the list back.

From the toolbar you can **Copy** a message or reply (hover it), **Export as Markdown** to save the whole conversation as a readable file, **Resume** a session that isn't running (with several agents, **▾** chooses which one continues it), **Show** the agent that is running it, and rename, archive or adopt it.

### Several agents in one project

A project can have up to four agents working at once, for example one building a feature while another reviews or writes tests. Click **Add Agent** above the terminal and choose:

- **Name** — "Agent 2" by default; rename it any time (double-click its tab).
- **Where it works**:
  - **Project folder** — shares the folder with the project's other agents.
  - **New worktree** — its own checkout of the project on its own branch (`hive/agent-2` by default, based on the branch you pick). Its work stays separate until you merge it. Hive creates worktrees next to the workspace, in `<workspace>.worktrees\<project>\<agent>`, and copies git-ignored files such as `.env` into them (**Project Settings → Agents & Worktrees → Copy into new worktrees**). If the project needs setting up first, set a **Setup command** such as `npm install`: it runs in the agent's pane before Claude Code starts, and if it fails you can retry or start without it.
  - **Existing worktree** — a worktree of the project that no agent uses, such as one you kept when removing an agent.
- **Settings** — the agent can use its own model, effort and permission mode, for example Sonnet for a reviewer while Opus codes. Left on *Project's*, it follows Project Settings.

**Layouts.** Once there is more than one agent, the buttons at the right of the agent row choose how they are shown: one at a time (click an agent to switch), two columns, three columns, or a grid of four. Three columns and the grid work best on a wide window, or with the sidebar hidden (Ctrl+B). Each pane has its own header with the agent's status and buttons; click a pane to make it the **focused** agent. The buttons in the project header, the Session menu, pasting screenshots and **Insert into Session** act on the focused agent. Ctrl+Alt+] and Ctrl+Alt+[ move between agents. Clicking an agent that isn't on screen shows it in the focused pane.

**Which conversation each agent has.** Each pane header shows the name of the session the agent is running (hover for details, click to read it in the Sessions tab); the project header shows the focused agent's. A conversation can only be open in one agent at a time. **Resume** reopens the agent's own last session and is greyed out when it has none. Its **▾** lists the recent sessions from the agent's folder: pick one to continue it in this agent, including a paused conversation another agent in the same folder started. Sessions that are open in another agent are greyed out; clicking one takes you to that agent. Agents in their own worktree only see that worktree's sessions.

The sidebar keeps one status dot per project, showing the most urgent agent (needs input, then working…), with the number of running agents next to the name. Hover the project header's status for each agent's state. Notifications name the agent, e.g. "hive · Agent 2 finished".

**File locks.** Agents sharing the project folder could otherwise edit the same file at the same time. When an agent edits a file, Hive notes that it is working on it; if another agent then tries to edit that file, Hive tells it to wait or work on something else, and it carries on with other work. The claim ends when the first agent finishes its task. The files an agent holds show as a lock with a count on its tab. **Settings → Agents & Worktrees → File locks** (or per project) chooses what happens: **Block** (default), **Ask me** (you approve the edit), **Warn** (the edit goes ahead, the agent is told), or **Off**. Locks cover the agents' file edits, not shell commands (formatters, `npm install`, `git checkout`), and not files agents share outside the project such as Claude Code's own settings or memory — keep that in mind when several agents work in one folder. Agents in their own worktrees never get in each other's way.

**Reviewing and merging a worktree agent's work.** In the **Changes** and **Files** tabs, the selector at the top switches between the project folder and each agent's worktree. For a worktree, Changes lists everything the agent changed since its branch started (its commits and uncommitted edits). When it is done, choose **Merge** (pane header, agent menu or Changes tab):

- Uncommitted changes are committed on the agent's branch first, with the message you enter.
- The branch is merged into the branch checked out in the project folder: **Squash** (one commit, the default; **Settings → Agents & Worktrees → Default merge style**) or **Merge** (keeps the agent's commits).
- If the same files changed on both sides, nothing is merged. Hive lists the files and can send an agent in the project folder instructions to do the merge and resolve the conflicts, or copy them for you.
- **Remove the worktree and branch afterwards** is ticked by default (stop the agent first).

**Remove Agent** asks whether to keep a worktree agent's worktree and branch or delete them; **Discard** deletes them straight away. Their sessions stay in the Sessions tab, labelled with the agent and branch. Two dev servers from different agents can clash on the same port; give them different ports.

### Archiving and backups

Claude Code deletes old transcripts after a while. Hive keeps a copy of every session transcript in the project's `.hive/sessions` folder, and archived sessions in `.hive/archive`. Images you paste or drop into a session are kept in `.hive/images`. None of these are deleted. If Claude Code has removed a transcript, Hive restores it from the backup when you resume.

### Token use, cache and compaction

The **Overview** tab shows, for the current session:

- **Context** — how many tokens the conversation occupies right now.
- **Cache** — whether Anthropic's prompt cache is still warm (5-minute or 1-hour lifetime) and how long it has left.
- **Re-cache on resume** — an estimate of the tokens written to cache on the first message after resuming, once the cache has expired.
- **Compactions** — each time Claude Code summarised the conversation to free space, with before/after sizes.
- **API-equivalent cost** — what the session would have cost at Anthropic API prices, as Claude Code calculates it. On a subscription you are not charged this; it is a measure of how heavy the session is.

### Plan usage

If you use Claude Code with a Claude subscription, the status bar shows how much of your plan's limits is used, for example **5h 34% · Week 12%**: the rolling 5-hour allowance and the weekly one. Hover it to see when each resets; the **Overview** tab shows both with meters. The numbers are for your whole account (every Claude Code session, not just Hive's) and come from Claude Code while a session is running, so after a quiet spell they show when they were last updated. The status bar darkens at 80% and turns red at 95%, and Hive notifies you once when you pass 80% and 95% of each limit in each reset period.

The model chip in the project header and the status bar also show the **effort**, e.g. *Opus 5.5 (default) · High*: what the running session reports, otherwise what new sessions will use.

## Skills

Skills are instructions an agent can load when they're relevant. Hive shows three levels:

| Level | Where | Managed by Hive |
|---|---|---|
| **Hive** | `Workspace/.hive/skills/<name>/SKILL.md` | Yes — enable for all projects, turn off per project |
| **Machine** | `~/.claude/skills` and installed Claude Code plugins | No — always loaded by Claude Code |
| **Local** | `Project/.claude/skills` | No — always loaded in that project; can be copied to the workspace |

Add a Hive skill by creating a folder with a `SKILL.md` in `.hive/skills`, or with **New Hive Skill** in the Skills view. Enable it in the Skills view; turn it off for a project in that project's **Skills** tab.

When a session starts, Hive copies exactly the enabled skills into the project's `.hive/launch` folder and points Claude Code at it. A skill disabled in the workspace is therefore always gone the next time a session starts, and a running session keeps the version it started with.

## MCP servers

MCP servers give agents extra tools. Each server is a JSON file in `Workspace/.hive/mcp`:

```json
{
  "description": "GitHub issues and pull requests",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
}
```

Enable servers in the MCP view, and turn them off per project in the project's **MCP** tab. Sessions use **only** the servers Hive enables. If a project has its own `.mcp.json`, Hive tells you which of its servers aren't in the workspace and offers to copy them there; until then they stay disabled.

Reference secrets with environment variables (`${NAME}`), never literal values — Hive warns when a definition looks like it contains one.

### The built-in `hive` server

Every session also gets Hive's own MCP server, which lets agents list projects, read and write shared notes, write handovers and notify you. Try: *"Write a handover for the next session using the hive tools."* A new session is told about these tools and about the project's latest handover, so *"read the handover"* is enough to pick up where the last session stopped. See the [Agent API reference](AGENT_API.md).

## Shared notes and handovers

The **Shared Notes** view edits the markdown files in `.hive/shared`. Use it for team conventions, instructions every agent should follow, and **handovers** — notes a session writes before it ends so the next session (or another project) can continue. Handovers go in `shared/handovers`, named by date and project.

## Memory

A project's **Memory** tab shows everything Claude Code remembers about it:

- `CLAUDE.md` — project instructions read at the start of every session (usually committed).
- `CLAUDE.local.md` — your personal project instructions (not committed).
- **User CLAUDE.md** — instructions for all your projects.
- **Auto memory** — facts Claude Code chose to remember about this project.

All of them can be edited here.

## Files

The **Files** tab is a file browser for the project folder.

- **Create:** the New File and New Folder buttons (or right-click a folder) add an entry inside the selected folder; type the name in place. A name like `docs/notes.md` creates the folders in between.
- **Rename** with F2, **delete** with Del. Deleted files go to the **Recycle Bin**, so they can be restored.
- **Cut, copy and paste** with Ctrl+X, Ctrl+C and Ctrl+V, or from the right-click menu, which also has **Duplicate**, **Copy Path** and **Copy Relative Path**. Pasting into another project always copies.
- **Drag and drop:** drag entries onto a folder to move them (hold Ctrl to copy). Drag files in from Explorer to copy them into the project. Drag files onto the **Session** tab to paste their paths into the running session.
- **Open elsewhere:** the buttons above the editor (and the right-click menu) open a file in its default app or reveal it in File Explorer.
- **Find:** the box at the top searches the whole project by name or path (git-ignored files are left out).
- Ctrl+click and Shift+click select several entries; the arrow keys move around the tree.

Names are coloured by git status like in VS Code (modified, new), folders containing changes get a dot, and git-ignored files and the `.hive` folder are dimmed. `.git` is hidden. The tree updates by itself when files change on disk.

### Viewing and editing files

Select a file and it opens on the right, ready to edit, with syntax highlighting for code, SQL, XML, JSON, YAML and many more. **Ctrl+S** (or **Save**) saves it. Some file types also get a nicer view, and the buttons above the file switch between them:

| File | Views |
|---|---|
| Markdown (`.md`) | **Preview** (default) with coloured code blocks, images and clickable links to other files · **Split** (edit on the left, live preview on the right) · **Edit** |
| CSV / TSV | **Table** (default, first 5,000 rows) · **Edit** |
| HTML | **Edit** (default) · **Preview**, sandboxed so scripts don't run · **Split** |
| SVG | **Image** (default) · **Edit** |
| Images, PDF | Viewer (click an image to toggle actual size) |

Files with unsaved changes get a ● in the tree. The edits are kept while you look at other files or tabs, until you save them or Hive closes. If a file changes on disk while you have unsaved edits, for example because the agent edited it, Hive tells you and lets you **Reload** it or **Overwrite with mine**. A file without edits simply updates. Binary files and files over 5 MB aren't opened; use **Open in Default App** for those.

## Images

The **Images** tab shows every screenshot and image pasted or dropped into the project's sessions, grouped by session (newest first), with archived sessions at the bottom. Click one to view it large and use ← / → to move between them. From the viewer or the right-click menu you can **Insert into Session**, **Copy Image**, **Copy Path**, **Reveal** it, or **Delete** it (to the Recycle Bin). You can also drag a thumbnail onto the **Session** tab.

## Changes

The **Changes** tab lists files changed in the project's git working tree and shows each one as a side-by-side diff against the last commit — a quick way to review what the agent did.

## Project settings

Each project can override the global defaults in its **Settings** tab:

| Setting | What it does |
|---|---|
| Model | **Latest** (Fable, Opus, Sonnet, Haiku — always the newest in that family), a **pinned version** such as Opus 5.5 (Show older versions lists the 4.x models too), or a custom model ID. **1M context** uses the larger context window where the model has one. The same choice is in Settings → Claude Code → Default model. |
| Effort | Reasoning effort: low → max |
| Permission mode | How much the agent asks before acting (below) |
| Completion chime | On, off or inherit |
| Extra arguments | Additional Claude Code command-line arguments |

Changes apply to new sessions. If you change something while a session is running, Hive shows **Restart session**, which restarts it with the new settings and continues the same conversation.

### Permission modes

| Mode | Behaviour |
|---|---|
| Manual | Asks before edits and commands |
| Accept edits | Edits files without asking; asks before commands |
| Plan | Read-only planning until you approve |
| Auto | A safety classifier approves low-risk actions and asks about risky ones (default) |
| Don't ask | Never asks; anything not pre-approved is refused |
| Bypass permissions | Never asks; allows everything |

**Bypass permissions** only appears after you tick **Settings → Claude Code → Enable bypass permissions option**. Projects using it show a red warning. Use it only for disposable work.

**Switching mode while an agent runs.** The mode badge next to the model in the project header (and in each pane header, and the status bar) shows the mode the session is really in. Click it, or press **Ctrl+Alt+M**, and choose another: Hive switches it straight away, without a restart, the same way pressing **Shift+Tab** in the terminal does (which Hive also notices). Don't ask and Bypass permissions can't be reached that way, so choosing them restarts the session in that mode and carries on the same conversation. The switch applies to that session only; the settings decide what new sessions start in. When you change the setting while agents are running, Hive offers to **Switch Now**.

## Updating Hive

Hive keeps itself up to date from its GitHub releases. By default it checks shortly after starting and every six hours, downloads a new version in the background, and installs it the next time you quit Hive — it never restarts on its own, so your agents are never interrupted.

- While a new version downloads, the status bar shows the progress; when it's ready it says **Restart to update to X.Y.Z**. Click it to see what's new.
- **Restart and Update** (in that dialog, the notification or the tray menu) closes Hive, installs the update and opens Hive again. If agents are working, Hive asks first, and you can let them finish. Stopped sessions can be resumed as usual.
- **Skip This Version** stops Hive offering that version; the next one is offered as normal.
- **Help → Check for Updates…** checks straight away and tells you the result.
- **Settings → Updates** turns automatic checks and downloads off, chooses whether updates install **automatically when Hive quits** or **only when you choose Restart and Update**, and can include pre-release (beta) versions.

Updates are checked against their published checksum before they install.

## Notifications

When an agent finishes or needs input, Hive can play a chime and show a Windows notification (click it to jump to the project). Configure both in **Settings → Notifications**; each project can override the chime.

## The system tray

Closing the window keeps Hive running in the tray so sessions continue. The tray icon shows a red dot when an agent has finished or needs you, and its menu lists your active projects. Quit from the tray menu or **File → Exit**.

### Quitting

Quitting stops every running session. Nothing is lost: each conversation is kept and you can resume it next time. So Hive only asks first when an agent is **in the middle of something** (working, or waiting for your answer). Otherwise it just closes and a notification tells you which sessions to resume.

When it asks, you see each session and what it's doing, and can choose:

- **Quit now**: stop everything straight away.
- **Quit when agents finish**: Hive hides and quits by itself once no agent is working. Until then the tray menu has **Quit Now** and **Cancel Pending Quit**, and opening the window shows a banner with the same choices.
- **Cancel**: keep working.

Tick **Don't ask again** to stop the question, or change it any time in **Settings → General → Confirm before quitting** (*When an agent is working*, *Whenever sessions are running*, or *Never*).

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Command palette | Ctrl+Shift+P |
| Go to project | Ctrl+P |
| Settings | Ctrl+, |
| New session / resume / stop | Ctrl+Shift+N / Ctrl+Shift+R / Ctrl+Shift+X |
| Compact the conversation | Ctrl+Alt+C |
| Switch permission mode | Ctrl+Alt+M (Shift+Tab inside the terminal) |
| Add agent | Ctrl+Alt+Shift+N |
| Focus agent 1–4 / next / previous | Ctrl+1 … Ctrl+4 / Ctrl+Alt+] / Ctrl+Alt+[ |
| Layout: one at a time, two columns, three columns, grid | Ctrl+Alt+1 … Ctrl+Alt+4 |
| Focus the session terminal | Ctrl+` |
| Next / previous project | Ctrl+PageDown / Ctrl+PageUp |
| Project tabs | Alt+1 … Alt+9, Alt+0 (Session, Overview, Sessions, Files, Images, Changes, Memory, Skills, MCP, Settings); Ctrl+Tab / Ctrl+Shift+Tab for the next / previous tab |
| Toggle sidebar | Ctrl+B (outside the terminal) |
| Compact / expand the project list | Ctrl+Alt+B |
| Notifications | Ctrl+Alt+U |
| External terminal in the project | Ctrl+Shift+` |
| Documentation | F1 |

In the terminal, Ctrl+C copies when text is selected (otherwise it interrupts the agent) and Ctrl+V pastes. Right-click copies or pastes text. See **Help → Keyboard Shortcuts** for the full list.

**Changing shortcuts.** **Settings → Keyboard Shortcuts** lists every command. Click the pencil (or double-click a shortcut) and press the keys you want; press a second combination straight after for a chord such as Ctrl+K Ctrl+S. You can remove a shortcut, reset one, or reset them all. Hive warns when a shortcut is already used, and won't take keys you need for typing and editing (a key without Ctrl or Alt, Ctrl+C/V/X/A/Z/Y, Shift+Tab). A project can have its own shortcuts for project and session commands in **Project Settings → Keyboard Shortcuts**; they apply while that project is selected.

**Screenshots and files.** With a screenshot on the clipboard (for example from Win+Shift+S), press **Ctrl+V** in a session: Hive saves the image in the project's `.hive/images` folder and pastes its path, and Claude Code attaches it as `[Image #1]`. You can also **drag files** from Explorer onto the terminal to paste their paths; images are copied into `.hive/images` first. The images are kept per session, so you can always see what was sent (see [Images](#images)).

## Troubleshooting

- **"Claude Code CLI required"** — install the CLI from **Help → Claude Code Setup**, or set its path in Settings → Claude Code. Having the VS Code extension isn't enough; Hive needs the standalone CLI.
- **Status dots don't change** — status comes from Claude Code hooks. Restart the session; if it persists, check **Help → Open Logs Folder**.
- **Agent API port in use** — change the port in Settings → Agent API.
- **Where is my data?** — app settings in `%APPDATA%\Hive`, workspace data in `Workspace/.hive`, project data in `Project/.hive`.
- **How many sessions can run?** — as many as your machine can handle, across any number of projects. Each is a Claude Code process; Hive only draws the terminals you can see with the graphics card, so dozens of background sessions don't slow the window down.

## Licence

Hive is open source under the [MIT License](../LICENSE). It includes open-source libraries (xterm.js, Monaco, React and others) under their own permissive licences, listed with their full texts in [Third-Party Notices](../THIRD_PARTY_NOTICES.md); both are in the Docs view and linked from **Help → About Hive**. Electron's and Chromium's licences are in the folder Hive is installed in (`LICENSES.chromium.html`). Claude and Claude Code are products of Anthropic, installed separately under Anthropic's terms; Hive is not affiliated with Anthropic.
