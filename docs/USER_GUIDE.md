# Hive User Guide

Hive is a desktop workspace for coding with AI agents. It runs coding agents (**Claude Code** and **Codex**) for each project you're working on, side by side, and keeps track of what each one is doing, how many tokens it uses, and the skills and MCP servers it has.

## Getting started

1. **Install Hive.** Download `Hive-Setup-<version>.exe` from the [latest release](https://github.com/Suremise/hive-desktop/releases/latest) and run it. The installer isn't code-signed yet, so Windows SmartScreen may warn you; choose **More info → Run anyway**. From then on Hive keeps itself up to date (see [Updating Hive](#updating-hive)).
2. **Choose your coding agents.** Hive runs the standalone command-line tools of **Claude Code** (Anthropic) and **Codex** (OpenAI); they aren't included with Hive. A new install starts with both turned off: turn on the ones you use in **Settings → Providers** (the banner at the top links there). **Help → Agent Setup…** finds each CLI and offers a one-click install with the official installer if it's missing, and walks you through signing in (and, for Codex, its one-time Windows sandbox setup). The copies inside VS Code (or Cursor) extensions are not used. See [Coding agents](#coding-agents-claude-code-and-codex).
3. **Open or create a workspace** (**File → Open Workspace…** or **New Workspace…**). A workspace is any folder whose subfolders are your projects.
4. **Mark the projects you're working on** with the toggle next to each project.
5. **Add an agent and start it.** A new project has no agents: **New Session** (Ctrl+Shift+N) adds one with your default provider and starts it, or use **Add Agent** above the terminal. The agent opens in the Session tab. Switch to another project and start another — sessions keep running in the background.

## Coding agents: Claude Code and Codex

Hive calls the coding agents it can run **providers**. Each agent in a project chooses its own, so a project can have a Claude Code agent and a Codex agent working side by side. Hive shows each CLI's own terminal, exactly as it looks when you run it yourself.

- **Turning providers on and off.** **Settings → Providers** lists them with their install state. A provider that is off can't start agents; its agents stay listed, greyed out. Turning one off while its agents run asks whether to stop them now or let them finish. **Default provider** is what new agents use (a project can choose its own in Project Settings).
- **Setup.** **Help → Agent Setup…** has a tab per provider: install, sign in, and updates. Claude Code signs in with a Claude plan or an Anthropic Console account; Codex with a ChatGPT plan or an OpenAI API key. On Windows, Codex also needs its sandbox set up once (without it, Codex asks before every command); see [Codex's Windows sandbox](#codexs-windows-sandbox).
- **Settings per provider.** Each provider has its own page (**Settings → Claude Code**, **Settings → Codex**): the CLI's path, default model, effort and permission mode, extra arguments, update checks and its price table. **Settings → Claude Code → Allow background sessions** is off by default: in Claude Code, pressing ← on an empty prompt (easy to do while moving through text) opens its agent view and moves the session into Claude Code's background service, where Hive can no longer see or stop it. Hive turns that off for the sessions it starts; `claude` in your own terminals is unaffected. If a session is in the background anyway (you turned the setting on, or moved it there outside Hive), resuming it shows a notification with **Stop It and Resume**, which stops Claude Code's background job and resumes the conversation here. Projects override them per provider in Project Settings.
- **The icons** on agent tabs, pane headers and the Sessions list show which provider each agent and session uses.
- **Conversations stay with their provider.** A Claude Code session can only be resumed by a Claude Code agent, and a Codex session by a Codex agent. To move work to another provider, use **Hand Over to…** (see [Sessions](#sessions)).
- **What both share.** The workspace's Hive skills and MCP servers and Hive's own `hive` tools reach every agent. Neither CLI loads MCP servers from your user settings in Hive sessions. Hive never changes either CLI's own configuration files.

## Workspaces and projects

A **workspace** is a folder of projects. When you open one, Hive creates a `.hive` folder in it:

```
MyWorkspace/
  .hive/
    shared/       notes, instructions and handovers for every project
    skills/       Hive skills (one folder per skill; a new workspace starts with Hive's six)
    mcp/          MCP server definitions (one .json per server)
    workspace.json
  ProjectA/
  ProjectB/
```

The workspace `.hive` folder is meant to be **committed** so a team can share skills, MCP servers and notes. Don't put secrets in it.

Each **project** (every subfolder except dot-folders) gets its own `.hive` folder for Hive's metadata: project settings, the session list and transcript backups. Hive adds it to the project's `.git/info/exclude`, so it's never committed and your `.gitignore` is left alone.

### Several windows

Like VS Code, Hive can show several workspaces at once, each in its own window: **File → New Window** (Ctrl+K Ctrl+N) opens one on the welcome page, where you open or create a workspace. Each window is a full Hive with its own projects, agents, shared notes, skills and MCP servers; settings, the tray and updates are shared.

- **Open Workspace** replaces the workspace in the current window. If its agents are running, Hive asks first (*Switch workspace?*), then stops them; to keep them running, open the other workspace in a new window instead. If the workspace is already open in another window, that window comes forward instead, so two windows never run agents on the same project. A folder inside a workspace open in another window (or one containing it) can't be opened as a workspace: its projects would belong to both.
- **File → Close Workspace** stops every agent in every project of the workspace, asking first (*Close this workspace?*).
- **Closing a window** closes its workspace and stops its agents, asking first as quitting does (*Close this window?*). Closing the last window keeps Hive in the tray, as before.
- **Quitting** stops the agents of every window. When Hive starts again, it reopens the windows that were open, each with its workspace, where they were.
- Notifications and the tray menu take you to the window showing the project.

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

Each agent of a project runs one session at a time (most projects have just one agent; see [Several agents in one project](#several-agents-in-one-project)). A project without agents shows **No agents yet**: New Session and Resume add one for you.

**Where things are.** The project header is about the project: its name and combined status, the **Active** switch, **Explorer** (reveal the folder), **Terminal** (open an external terminal there), **Stop All Agents** while any runs (it lists them and asks first), and **⋯** for Changes and Project Settings. Agents are added from the agent strip's **Add Agent** button. Everything about one agent is on its own pane, whether a project has one agent or four:

- **The agent header**: its status, provider, name, worktree branch, the session it's running, then its buttons: **Compact**, **Stop** and **Archive & New** while it runs; **Resume**, **Resume a Session…** and **New Session** when it doesn't; **Merge…** for a worktree agent; and **⋯** with everything else. As the pane gets narrower the buttons show only their icons, then fold into **⋯**.
- **The agent footer**: its model and effort (click for Agent Settings), its permission mode (click to switch), the context it uses (amber past your Compact threshold) and the session's cost.

The status bar keeps what concerns the whole app: the workspace, branch, running agents, plan limits, the Agent API, each CLI's version and Hive's updates.

An agent's header and the **Session** menu let you:

- **New Session** — start fresh. If one is running, Hive stops it first (after asking).
- **Resume** — continue a previous conversation. Hive shows how many tokens resuming will re-cache if the prompt cache has expired. A new agent can resume sessions whose agent is gone (for example after the upgrade to 0.2, which starts every project without agents).
- **Stop** — end the session. The conversation is kept and can be resumed.
- **Compact** — summarise the conversation so far so every later message is cheaper. Available once the agent has finished; it turns orange when the context passes your threshold (**Settings → Sessions → Suggest compacting above**, 200,000 tokens by default, and overridable per project in Project Settings). You can add an optional focus ("keep the API decisions, drop the test output"); left empty, the agent decides what to keep. Nothing is lost: the full history stays in the session's transcript. Anything you had half-typed is cleared first; press Ctrl+Y in the session to get it back.
- **Hand Over to…** (agent menu) — hand this agent's work to another agent of the project, which may use another provider. Hive asks this agent to write a handover (if it's running and idle; untick to use the latest handover instead), then starts the other agent, or messages it if it's already running, and tells it to read the handover and carry on. The new session shows a **handed over** badge in the Sessions tab that links back. It needs **Settings → Agent API → Provide Hive tools to sessions**. If the other agent's CLI asks something first (for example whether to trust the folder), answer it in its terminal.
- **Archive & New** — archive the current conversation and start a clean one. This is the cheapest way to continue after a long session: the new session starts with an empty context instead of re-caching the old one. Write a handover first (see below) so the new session knows where to pick up.

### Reading past sessions

The **Sessions** tab lists every session of the project on the left, newest first, with when it was last used and its context size. Sessions started outside Hive (in VS Code or a terminal) appear as *external*; **Adopt** them to manage them in Hive. Tick **Archived** to include archived sessions.

Select a session to read its transcript on the right, including everything before each compaction. It opens at the latest messages; scroll up to load earlier ones. A running session doesn't update on its own unless you switch on **Follow** (the Session tab always shows the agent working); otherwise click **Refresh**. **Settings → Sessions → Follow running sessions** sets the default.

- Your messages and Claude's replies are shown in full.
- Thinking and each tool call are collapsed to one line (for example "Bash · Run the login tests" or "Edit · src/app.ts"). Click one to see its input and result; very long output is shortened, with **Show all**. The expand button in the toolbar opens or closes them all.
- Each compaction is a divider showing whether it was manual or automatic, the context size before and after, and the size of the first request after it (which also carries Claude Code's instructions and tools). Click it to read the summary the agent continued from.
- Slash commands such as `/compact` appear with their output, and pasted images as thumbnails; click one to view it.

The transcript opens at the latest message. For the running session it updates as the agent works, and scrolls with it while you are at the bottom.

**Search** (Ctrl+F in the tab) looks through messages, replies, tool calls and results, and compaction summaries. Choose **This session** or **All sessions**; the matches replace the list on the left, grouped by session, and clicking one opens the transcript at that point with the matches highlighted. Clear the search to get the list back.

From the toolbar you can **Copy** a message or reply (hover it), **Export as Markdown** to save the whole conversation as a readable file, **Resume** a session that isn't running (with several agents, **▾** chooses which one continues it), **Show** the agent that is running it, and rename, archive or adopt it.

### Several agents in one project

A project can have up to twelve agents working at once, for example one building a feature while another reviews or writes tests. All agents are equal: any of them can work in a worktree, and any can be removed once stopped. **Add Agent** above the terminal adds one straight away, with your default provider (**Settings → Providers → Default provider**, or the project's in Project Settings) and its default settings, working in the project folder. Its **▾** opens **Add Agent…**, where you choose:

- **Name** — "Agent 2" by default; rename it any time (double-click its tab).
- **Where it works**:
  - **Project folder** — shares the folder with the project's other agents.
  - **New worktree** — its own checkout of the project on its own branch (`hive/agent-2` by default, based on the branch you pick). Its work stays separate until you merge it. Hive creates worktrees next to the workspace, in `<workspace>.worktrees\<project>\<agent>`, and copies git-ignored files such as `.env` into them (**Project Settings → Agents & Worktrees → Copy into new worktrees**). If the project needs setting up first, set a **Setup command** such as `npm install`: it runs in the agent's pane before the agent starts, and if it fails you can retry or start without it.
  - **Existing worktree** — a worktree of the project that no agent uses, such as one you kept when removing an agent.
- **Provider** — Claude Code or Codex (only enabled providers can be chosen). Changing an agent's provider later clears its model settings and its last session, since conversations can't move between providers.
- **Settings** — the agent can use its own model, effort and permission mode, for example Sonnet for a reviewer while Opus codes, or a Codex reviewer next to a Claude Code agent. Left on *Project's*, it follows Project Settings for its provider.

**Layouts.** The layout follows as you add agents: two columns for two, three for three, a 2×2 grid for four, a 3×2 grid for five or six. The buttons at the right of the agent row choose one yourself: one at a time (click an agent to switch), two columns, three columns, a grid of four or a grid of six. A layout you choose stays as agents are added; choosing the one that shows all the agents makes it follow them again. Three columns and the grids work best on a wide window, or with the sidebar hidden (Ctrl+B).

**Pages.** Six agents fit on a page; a seventh opens **page 2** (agents 7–12). The **1 · 2** buttons next to the layouts switch pages, or press Ctrl+Alt+PageDown / Ctrl+Alt+PageUp; a dot on a page's button shows its most urgent agent (one waiting for you, say). Each page has its own layout, so page 1 can show one agent at a time while page 2 shows all six. Clicking an agent on the other page goes there. Each agent runs its own copy of its CLI, so Hive notes the memory use when you add the seventh. Each pane has its own header with the agent's status and buttons; click a pane to make it the **focused** agent. The buttons in the project header, the Session menu, pasting screenshots and **Insert into Session** act on the focused agent. Ctrl+Alt+] and Ctrl+Alt+[ move between agents, across pages. Clicking an agent that isn't on screen shows it in the focused pane.

**Which conversation each agent has.** Each agent's header shows the name of the session it is running (hover for details, click to read it in the Sessions tab). A conversation can only be open in one agent at a time. **Resume** reopens the agent's own last session and is greyed out when it has none. Its **▾** lists the recent sessions from the agent's folder: pick one to continue it in this agent, including a paused conversation another agent in the same folder started. Sessions that are open in another agent are greyed out; clicking one takes you to that agent. Agents in their own worktree only see that worktree's sessions.

The sidebar keeps one status dot per project, showing the most urgent agent (needs input, then working…), with the number of running agents next to the name. The project header's status says how many agents are in that state (for example *Working · 1 of 2 agents*); hover it for each agent's state. Notifications name the agent, e.g. "hive · Agent 2 finished".

**File locks.** Agents sharing the project folder could otherwise edit the same file at the same time. When an agent edits a file, Hive notes that it is working on it; if another agent then tries to edit that file, Hive tells it to wait or work on something else, and it carries on with other work. The claim ends when the first agent finishes its task. The files an agent holds show as a lock with a count on its tab. **Settings → Agents & Worktrees → File locks** (or per project) chooses what happens: **Block** (default), **Ask me** (you approve the edit; Codex can't show its own approval for this, so Hive holds the edit back and shows a notification with **Allow**, and Codex waits until you allow it), **Warn** (the edit goes ahead, the agent is told), or **Off**. Locks cover the agents' file edits, not shell commands (formatters, `npm install`, `git checkout`), and not files agents share outside the project such as the CLIs' own settings or memory — keep that in mind when several agents work in one folder. Agents in their own worktrees never get in each other's way.

**Reviewing and merging a worktree agent's work.** In the **Changes** and **Files** tabs, the selector at the top switches between the project folder and each agent's worktree. For a worktree, Changes lists everything the agent changed since its branch started (its commits and uncommitted edits). When it is done, choose **Merge** (pane header, agent menu or Changes tab):

- Uncommitted changes are committed on the agent's branch first, with the message you enter.
- The branch is merged into the branch checked out in the project folder: **Squash** (one commit, the default; **Settings → Agents & Worktrees → Default merge style**) or **Merge** (keeps the agent's commits).
- If the same files changed on both sides, nothing is merged. Hive lists the files and can send an agent in the project folder instructions to do the merge and resolve the conflicts, or copy them for you.
- **Remove the worktree and branch afterwards** is ticked by default (stop the agent first).

**Remove Agent** asks whether to keep a worktree agent's worktree and branch or delete them; **Discard** deletes them straight away. Their sessions stay in the Sessions tab, labelled with the agent and branch. Two dev servers from different agents can clash on the same port; give them different ports.

### Archiving and backups

Claude Code and Codex delete old transcripts after a while. Hive keeps a copy of every session transcript in the project's `.hive/sessions` folder, and archived sessions in `.hive/archive`. Images you paste or drop into a session are kept in `.hive/images`. None of these are deleted. If the CLI has removed a transcript, Hive restores it from the backup when you resume.

### Token use, cache and compaction

The **Overview** tab updates as sessions change (at most every 15 seconds; **Settings → Sessions → Overview updates** can make it every minute or only when you click **Refresh**). It starts with a **project summary** for the period you choose (All time at first, or Today, 7 days, 30 days), across every provider: tokens, API-equivalent cost, sessions and prompts. Below it are the agents **running now** (with how full each one's context is), a section per provider with its totals and plan limits, a table **by agent**, and the focused agent's session:

- **Context** — how many tokens the conversation occupies right now.
- **Cache** — whether Anthropic's prompt cache is still warm (5-minute or 1-hour lifetime) and how long it has left (Claude Code).
- **Re-cache on resume** — an estimate of the tokens written to cache on the first message after resuming, once the cache has expired.
- **Compactions** — each time the agent summarised the conversation to free space, with before/after sizes.
- **API-equivalent cost** — what the session would have cost at API prices. On a subscription you are not charged this; it is a measure of how heavy the session is. Claude Code calculates it itself; for Codex, Hive **estimates** it from a price table (shown with **≈**). Hive ships the published prices, and you can change them in each provider's settings page (**API prices**) if they change or you have different rates. A model without a price shows no cost.

### Plan usage

If you use a subscription (a Claude plan for Claude Code, a ChatGPT plan for Codex), the status bar shows how much of each plan's limits is used, one item per provider, for example **5h 34% · Week 12%**: the rolling 5-hour allowance and the weekly one. Hover it to see when each resets; the **Overview** tab shows them with meters in each provider's section. The numbers are for your whole account (every session, not just Hive's) and come from the CLI while a session is running, so after a quiet spell they show when they were last updated. The status bar darkens at 80% and turns red at 95%, and Hive notifies you once when you pass 80% and 95% of each limit in each reset period.

Each agent's footer shows its model and **effort**, e.g. *Opus 5.5 (default) · High*: what the running session reports, otherwise what new sessions will use.

## Hive Assistant

Each workspace has a **Hive Assistant**, its overseer, in a panel on the right. Show or hide it with **Ctrl+Alt+I**; hidden, it folds into a narrow **Hive Assistant** strip down the right edge, and clicking the strip opens it. Each workspace remembers whether it's open, and dragging its left edge makes it wider (double-click the edge for the default width). Hiding the panel doesn't stop the Assistant.

Ask it anything about the workspace: what the agents are doing, what a project is, what changed, what things cost, or for a plan or a review. It reads any project's files and uses Hive's own tools to see projects, agents, usage, shared notes and handovers. **For now it only looks and advises**: it doesn't edit files or start, stop or prompt agents, and if it tries to change something its provider asks you first. It will be able to do more in later versions.

**The panel.** At the top: the Assistant's status, its persona (click to switch), Start or Compact and Stop (in **⋯** when the panel is narrow), and **⋯** (New Conversation while it runs or Resume when it doesn't, Resume a Conversation…, Assistant Settings…, Manage Personas…). Under it, the workspace at a glance: agents waiting for you (or in trouble) first, then your active projects and their agents, and clicking one takes you there. Inactive projects fold into one row at the end; click it to show them. Drag the line under it to give it more or less room. Then the Assistant's terminal, and a footer with its model and effort, permission mode, context and cost, as agents have. While it isn't running, the panel offers **Start Assistant**, **Resume** and its past conversations. While the panel is hidden, the strip shows a dot for what the Assistant is doing.

It doesn't use one of a project's agent slots, and it runs in the workspace folder. Closing the workspace or the window, or quitting, stops it like any agent (the dialogs call it "Assistant"), and its conversations can be resumed.

### Personas

A **persona** is who the Assistant is: its role and its character, written as instructions in a Markdown file in the workspace's `.hive/personas` folder. Hive comes with four, each with a serious job and a character to match:

- 🗼 **Overseer** (the default): a lighthouse keeper who keeps a watch log of the workspace. Projects are ships, and an agent waiting for you is signalling.
- 🎩 **Planner**: plans every task like a heist, with the job, the crew, the vault and always the getaway.
- 🦎 **Reviewer**: reviews code like a hushed wildlife documentary narrator, with real findings ranked by severity.
- 🛫 **Orchestrator**: coordinates the agents like an air traffic controller. For now it writes the instructions for you to pass on.

Whatever the character, they speak plainly about errors, security and anything you must decide.

The **Personas** view (the person icon on the left) lists them. Click one to read or edit it, **+** to write your own, and the bin to delete one. Hive's own come back with **Restore** or **Revert to Default**. **Use in This Workspace** makes one the Assistant's. Switching persona while the Assistant is running asks first, because it starts a new conversation. A conversation keeps the persona it started with.

### Assistant settings

**Settings → Assistant** sets the defaults for every workspace:

- The provider (Claude Code or Codex, whatever your agents use).
- The default persona.
- For each provider: its model, effort, permission mode and extra arguments.

It starts lighter than your agents, to spend fewer tokens: Claude Code's Sonnet with low effort. Its mode, like your agents', approves safe actions itself and only asks about risky ones: **Auto** for Claude Code and **Approve for me** for Codex. **Assistant Settings** in the panel changes any of them for one workspace. Changing its provider or persona restarts it, after asking.

## Skills

Skills are instructions an agent loads when they're relevant. There are no switches: every skill an agent can see is always available to it. Hive shows where each one comes from:

| Level | Where | Who gets it | In Hive |
|---|---|---|---|
| **Hive** | `Workspace/.hive/skills/<name>/SKILL.md` | Every agent in every project, of every provider | Add, edit and delete in the **Skills** view |
| **Local (User Managed)** | `Project/.claude/skills` (Claude Code), `Project/.agents/skills` (Codex) | That provider's agents, in that project | Add, edit and delete in the project's **Skills** tab |
| **User** | `~/.claude/skills` (Claude Code), `~/.codex/skills` (Codex) | That provider's agents, everywhere | View only |
| **Plugin** | Claude Code plugins you've installed | Claude Code agents, everywhere | View only |

**The Skills view** (the sparkle in the activity bar) lists the workspace's Hive skills. **+** creates one from a starter `SKILL.md`; **Add Skill from File** adds a `.md` (it becomes the skill's `SKILL.md`) or a `.zip` (unpacked as the skill's folder: use a zip for a skill with scripts or other files). Select a skill to read it; **Edit** changes it, and the bin deletes it (to the Recycle Bin).

**A project's Skills tab** lists everything its agents get: the Hive skills first, then a section per provider with its local skills, your user skills and plugin skills. Hive skills are shared by every project, so their **Edit in workspace** button takes you to the Skills view to edit them there. Local skills belong to the project: add (with **+** or from a `.md` or `.zip`), edit and delete them right there. When both Claude Code and Codex are on, adding a local skill offers to add it for the other provider too, since each reads its own folder. **Copy to workspace** turns a local or user skill into a Hive skill for every agent.

**Skills that come with Hive.** A new workspace starts with six Hive skills: `handover` (wrap up a session in a handover), `pick-up` (continue from the latest handover, checking it against the code first), `merge-ready` (get a worktree agent's branch ready to review and merge), `review-agent-work` (one agent reviews another's work without changing it), `split-work` (plan how several agents can work on one task side by side) and `workspace-note` (record a decision or convention in the shared notes). They're ordinary Hive skills: edit or delete them as you like. A bundled skill you've deleted stays in the Skills view, greyed out, with **Restore**. When your copy differs from the one in your version of Hive (because you edited it, or a newer Hive improved it), its page offers **Revert to default**; that's also how to bring an existing workspace's copies up to date after updating Hive. The replaced copy goes to the Recycle Bin.

When a session starts, Hive copies the Hive skills into the project's `.hive/launch` folder and points Claude Code at it (Claude Code shows them as `hive:<name>`). Codex only reads skills from the project's `.agents/skills` folder, so for Codex agents Hive copies them there as `hive-<name>` folders (and keeps them out of git); those copies aren't listed as local skills. A running session keeps the version it started with; changes reach new sessions.

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

Enable servers in the MCP view, and turn them off per project in the project's **MCP** tab. Sessions of every provider use **only** the servers Hive enables. If a project has its own `.mcp.json` (or, for Codex, `.codex/config.toml` servers), Hive tells you which of its servers aren't in the workspace and offers to copy them there; until then they stay disabled.

Reference secrets with environment variables (`${NAME}`), never literal values — Hive warns when a definition looks like it contains one. Sessions get the environment Hive was started with, so after setting a variable (for example in Windows' *Edit environment variables for your account*), quit Hive completely, including from the tray, and open it again.

A server can be a program Hive starts (`command`, `args`, `env`, as above) or one reached over HTTP (`"type": "http"`, `"url"` and optional `"headers"`), the same fields as in Claude Code's `.mcp.json`. To keep a server's own code with the workspace, put it in a folder next to its definition, for example `.hive/mcp/notes/server.js`, and refer to it as `${HIVE_MCP_DIR}`, which Hive replaces with the path of the `.hive/mcp` folder: `"args": ["${HIVE_MCP_DIR}/notes/server.js"]`. Keep build output and `node_modules` out of git there.

A server you add or change is used by sessions started afterwards; restart a running session to give it the change.

### The built-in `hive` server

Every session also gets Hive's own MCP server, which lets agents list projects, read and write shared notes, write handovers and notify you. Try: *"Write a handover for the next session using the hive tools."* A new session is told about these tools and about the project's latest handover, so *"read the handover"* is enough to pick up where the last session stopped. See the [Agent API reference](AGENT_API.md).

## Shared notes and handovers

The **Shared Notes** view edits the markdown files in `.hive/shared`. Use it for team conventions, instructions every agent should follow, and **handovers** — notes a session writes before it ends so the next session (or another project) can continue. Handovers go in `shared/handovers`, named by date and project (`2026-09-29-api-auth-refactor.md`), with the project on a `**Project:**` line at the top. When project names overlap, such as `hive` and `hive-website`, that line decides whose handover it is.

## Memory

A project's **Memory** tab shows what each provider its agents use reads about it, grouped by provider:

- **Claude Code:** `CLAUDE.md` (project instructions read at the start of every session, usually committed), `CLAUDE.local.md` (your personal project instructions, not committed), the **User CLAUDE.md** (for all your projects) and **Auto memory** (facts Claude Code chose to remember about this project).
- **Codex:** `AGENTS.md` (project instructions) and the **User AGENTS.md** (for all your projects).

All of them can be edited here.

**One set of instructions for both.** When a project has Claude Code and Codex agents, each reads its own file. **Share one AGENTS.md…** at the top of the list makes `AGENTS.md` the shared file: `CLAUDE.md` gets an `@AGENTS.md` line, which makes Claude Code read it too. Anything else in `CLAUDE.md` stays and applies to Claude Code only. If there's no `AGENTS.md` yet, what's in `CLAUDE.md` moves into it, so nothing is lost.

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

Files with unsaved changes get a ● in the tree. The edits are kept while you look at other files or tabs, and follow a file you rename or move in the Files tab. Deleting a file with unsaved changes warns you first. When you quit, Hive lists the files with unsaved changes and saves them or discards them, as you choose; reloading the window or switching workspace offers to save them first. Unsaved changes are not kept if Hive crashes, so save often. If a file changes on disk while you have unsaved edits, for example because the agent edited it, Hive tells you and lets you **Reload** it or **Overwrite with mine**. A file without edits simply updates. Binary files and files over 5 MB aren't opened; use **Open in Default App** for those.

## Images

The **Images** tab shows every screenshot and image pasted or dropped into the project's sessions, grouped by session (newest first), with archived sessions at the bottom. Click one to view it large and use ← / → to move between them. From the viewer or the right-click menu you can **Insert into Session**, **Copy Image**, **Copy Path**, **Reveal** it, or **Delete** it (to the Recycle Bin). You can also drag a thumbnail onto the **Session** tab.

## Changes

The **Changes** tab lists files changed in the project's git working tree and shows each one as a side-by-side diff against the last commit — a quick way to review what the agent did.

## Project settings

Each project can override the global defaults in its **Settings** tab, which has the same categories and search as Settings:

| Category | Setting | What it does |
|---|---|---|
| Providers | Default provider | The provider new agents in this project use |
| Claude Code, Codex | | One page per provider, with the settings below for that provider's agents |
| Claude Code | Model | **Latest** (Fable, Opus, Sonnet, Haiku — always the newest in that family), a **pinned version** such as Opus 5.5 (Show older versions lists the 4.x models too), or a custom model ID. **1M context** uses the larger context window where the model has one. The same choice is in Settings → Claude Code → Default model. |
| | Effort | Reasoning effort: low → max |
| | Permission mode | How much the agent asks before acting (below) |
| | Extra arguments | Additional command-line arguments for the CLI |
| Sessions | Suggest compacting above | When the Compact button turns orange (see [Sessions](#sessions)) |
| | Completion chime | On, off or inherit |
| Agents & Worktrees | Agents, file locks, copy into new worktrees, setup command | See [Several agents in one project](#several-agents-in-one-project) |
| Keyboard Shortcuts | | Shortcuts for project and session commands in this project (see [Keyboard shortcuts](#keyboard-shortcuts)) |

Changes apply to new sessions. If you change something while a session is running, Hive shows **Restart session**, which restarts it with the new settings and continues the same conversation. The permission mode is the exception: it can be switched in a running session (below).

### Permission modes

| Mode | Behaviour |
|---|---|
| Manual | Asks before edits and commands |
| Accept edits | Edits files without asking; asks before commands |
| Plan | Read-only planning until you approve |
| Auto | A safety classifier approves low-risk actions and asks about risky ones (default) |
| Don't ask | Never asks; anything not pre-approved is refused |
| Bypass permissions | Never asks; allows everything |

**Bypass permissions** only appears after you tick **Settings → Claude Code → Enable the Bypass permissions option**. Projects using it show a red warning. Use it only for disposable work.

Codex has its own presets:

| Preset | Behaviour |
|---|---|
| Read only | Reads files; asks before any edit or internet access |
| Ask for approval | Edits files and runs commands in its sandbox; asks before internet access or edits outside the project |
| Approve for me | An automatic reviewer approves safe actions and asks only about risky ones (default) |
| Full access | No sandbox and no approvals |

When you switch a running Codex agent's preset, the badge says **Switching to …** until Codex confirms it; if Codex doesn't, the badge goes back and Hive tells you.

### Codex's Windows sandbox

On Windows, Codex runs commands in a sandbox, which it sets up once. **Help → Agent Setup… → Codex → Set up** opens Codex's setup, which offers two choices. With either, Codex agents in **Ask for approval** or **Approve for me** edit files in their own folder (the project, or the agent's worktree) and run commands there without asking, and ask before going online or writing anywhere else. Hive's own features (status, file locks, handovers, shared notes) work the same with both.

- **Set up default sandbox** (recommended): commands run under two local Windows accounts that Codex creates for them (`CodexSandboxOffline` and `CodexSandboxOnline`), with a firewall rule that keeps them offline unless you allow it. It isolates commands best. Windows asks for Administrator permission once.
- **Use non-admin sandbox**: needs no Administrator permission. Commands run under your own account with restricted rights. It protects your files and blocks internet access in most cases, but Codex warns it carries more risk if the agent is tricked by instructions hidden in a file or web page it reads (prompt injection).

Once Codex has set the sandbox up, Hive closes it and Agent Setup says so. With the non-admin sandbox, Agent Setup shows **Upgrade** to switch to the default one later. Codex agents that are running keep their sandbox until they restart. **Full access** doesn't use the sandbox at all.

**Full access** is like Bypass: it only appears after you tick **Settings → Codex → Enable the Full access option**, and projects using it show a red warning. Codex's **Plan** mode is separate from the preset: choose **Plan** in the mode menu (or press Shift+Tab in the terminal), and the badge shows "· Plan". In Codex's sandbox the `.git` folder is read-only, so Codex asks before committing.

**Switching mode while an agent runs.** The mode badge in each agent's footer shows the mode its session is really in. Click it, or press **Ctrl+Alt+M**, and choose another: Hive switches it straight away, without a restart, the same way pressing **Shift+Tab** in the terminal does (which Hive also notices). Don't ask and Bypass permissions can't be reached that way, so choosing them restarts the session in that mode and carries on the same conversation. For Codex, Hive picks the preset from Codex's `/permissions` menu. The switch applies to that session only; the settings decide what new sessions start in. When you change the setting while agents are running, Hive offers to **Switch Now**.

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

Closing the (last) window keeps Hive running in the tray so sessions continue. The tray icon shows a red dot when an agent has finished or needs you, and its menu lists your active projects, grouped by workspace when several windows are open. Quit from the tray menu or **File → Exit**.

### Quitting

Quitting stops every running session, in every window. Nothing is lost: each conversation is kept and you can resume it next time. So Hive only asks first when an agent is **in the middle of something** (working, or waiting for your answer). Otherwise it just closes and a notification tells you which sessions to resume.

When it asks, you see each session and what it's doing, and can choose:

- **Quit now**: stop everything straight away.
- **Quit when agents finish**: Hive hides and quits by itself once no agent is working. Until then the tray menu has **Quit Now** and **Cancel Pending Quit**, and opening the window shows a banner with the same choices.
- **Cancel**: keep working.

If files have unsaved changes (in the Files tab, or a shared note, skill, instruction or memory file, or MCP server you're editing), Hive always asks, lists them at the top, and saves them (**Save and quit**) or discards them, as you choose. A file that changed on disk since you opened it isn't overwritten: Hive stays open so you can decide.

Tick **Don't ask again** to stop the question about sessions, or change it any time in **Settings → General → Confirm before quitting** (*When an agent is working*, *Whenever sessions are running*, or *Never*).

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Command palette | Ctrl+Shift+P |
| Go to project | Ctrl+P |
| Settings | Ctrl+, |
| New window | Ctrl+K Ctrl+N |
| New session / resume / stop | Ctrl+Shift+N / Ctrl+Shift+R / Ctrl+Shift+X |
| Compact the conversation | Ctrl+Alt+C |
| Switch permission mode | Ctrl+Alt+M (Shift+Tab inside the terminal) |
| Add agent | Ctrl+Alt+Shift+N |
| Focus agent 1–9 / next / previous | Ctrl+1 … Ctrl+9 / Ctrl+Alt+] / Ctrl+Alt+[ |
| Layout: one at a time, two columns, three columns, grid of four, grid of six | Ctrl+Alt+1 … Ctrl+Alt+5 |
| Next / previous agent page | Ctrl+Alt+PageDown / Ctrl+Alt+PageUp |
| Focus the session terminal | Ctrl+` |
| Next / previous project | Ctrl+PageDown / Ctrl+PageUp |
| Project tabs | Alt+1 … Alt+9, Alt+0 (Session, Overview, Sessions, Files, Images, Changes, Memory, Skills, MCP, Settings); Ctrl+Tab / Ctrl+Shift+Tab for the next / previous tab |
| Toggle sidebar | Ctrl+B (outside the terminal) |
| Compact / expand the project list | Ctrl+Alt+B |
| Notifications | Ctrl+Alt+U |
| Show / hide the Hive Assistant | Ctrl+Alt+I |
| External terminal in the project | Ctrl+Shift+` |
| Documentation | F1 |

In the terminal, Ctrl+C copies when text is selected (otherwise it interrupts the agent) and Ctrl+V pastes. Right-click copies or pastes text. See **Help → Keyboard Shortcuts** for the full list.

**Changing shortcuts.** **Settings → Keyboard Shortcuts** lists every command. Click the pencil (or double-click a shortcut) and press the keys you want; press a second combination straight after for a chord such as Ctrl+K Ctrl+S. You can remove a shortcut, reset one, or reset them all. Hive warns when a shortcut is already used, and won't take keys you need for typing and editing (a key without Ctrl or Alt, Ctrl+C/V/X/A/Z/Y, Shift+Tab). A project can have its own shortcuts for project and session commands in **Project Settings → Keyboard Shortcuts**; they apply while that project is selected.

**Screenshots and files.** With a screenshot on the clipboard (for example from Win+Shift+S), press **Ctrl+V** in a session: Hive saves the image in the project's `.hive/images` folder and pastes its path, and Claude Code attaches it as `[Image #1]`. You can also **drag files** from Explorer onto the terminal to paste their paths; images are copied into `.hive/images` first. The images are kept per session, so you can always see what was sent (see [Images](#images)).

## Troubleshooting

- **"… was damaged and has been restored"** — one of Hive's settings or record files couldn't be read (for example after a hand edit). Hive went back to its last good copy (`.bak`) and kept the damaged file next to it as `.corrupt-<date>`.
- **"Claude Code is required" / "Codex is required"** — install the CLI from **Help → Agent Setup…**, or set its path in the provider's settings page. Having the VS Code extension isn't enough; Hive needs the standalone CLI.
- **"… is turned off"** — turn the provider on in **Settings → Providers**.
- **Codex asks before every command** — its Windows sandbox isn't set up: **Help → Agent Setup… → Codex → Set up**.
- **Status dots don't change** — status comes from the CLI's hooks. A Codex agent shows **Ready** once its prompt appears, and reports its session with your first message. Restart the session; if it persists, check **Help → Open Logs Folder**.
- **Agent API port in use** — change the port in Settings → Agent API.
- **"This tab ran into a problem"** — something in that view failed, for example on an unusual file. Your sessions keep running. Click **Try Again** or switch to another tab; if it keeps happening, **Open Logs** has the details for a bug report.
- **Where is my data?** — app settings in `%APPDATA%\Hive`, workspace data in `Workspace/.hive`, project data in `Project/.hive`.
- **How many sessions can run?** — as many as your machine can handle, across any number of projects. Each is a CLI process; Hive only draws the terminals you can see with the graphics card, so dozens of background sessions don't slow the window down.

## Licence

Hive is open source under the [MIT License](../LICENSE). It includes open-source libraries (xterm.js, Monaco, React and others) under their own permissive licences, listed with their full texts in [Third-Party Notices](../THIRD_PARTY_NOTICES.md); both are in the Docs view and linked from **Help → About Hive**. Electron's and Chromium's licences are in the folder Hive is installed in (`LICENSES.chromium.html`). Claude and Claude Code are products of Anthropic, and Codex and ChatGPT products of OpenAI, installed separately under their makers' terms; the provider logos are their owners' trademarks, used to identify their products. Hive is not affiliated with Anthropic or OpenAI.
