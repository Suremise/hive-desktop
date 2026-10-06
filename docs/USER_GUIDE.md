# Hive User Guide

Hive is a desktop workspace for coding with AI agents. It runs coding agents (**Claude Code** and **Codex**) for each project you're working on, side by side, and keeps track of what each one is doing, how many tokens it uses, and the skills and MCP servers it has.

## Getting started

1. **Install Hive.** Download `Hive-Setup-<version>.exe` from the [latest release](https://github.com/Suremise/hive-desktop/releases/latest) and run it. The installer isn't code-signed yet, so Windows SmartScreen may warn you; choose **More info → Run anyway**. From then on Hive keeps itself up to date (see [Updating Hive](#updating-hive)).
2. **Choose your coding agents.** Hive runs the standalone command-line tools of **Claude Code** (Anthropic) and **Codex** (OpenAI); they aren't included with Hive. A new install starts with both turned off: turn on the ones you use in **Settings → Providers** (the banner at the top links there). **Help → Agent Setup…** finds each CLI and offers a one-click install with the official installer if it's missing, and walks you through signing in (and, for Codex, its one-time Windows sandbox setup). The copies inside VS Code (or Cursor) extensions are not used. See [Coding agents](#coding-agents-claude-code-and-codex).
3. **Open or create a workspace** (**File → Open Workspace…** or **New Workspace…**). A workspace is any folder whose subfolders are your projects.
4. **Mark the projects you're working on** with the toggle next to each project.
5. **Add an agent and start it.** A new project has no agents: **New Session** (Ctrl+Shift+N) adds one with your default provider and starts it, or use **Add Agent** above the terminal. The agent opens in the Session tab. Switch to another project and start another — sessions keep running in the background.

### Tips

Hive shows a **tip** about something it can do when it starts, at most one a day, in a small card in the bottom-right corner: **Try it** does it, **Learn more** opens the part of this guide about it, and **Next tip** shows another. A few tips come at the moment they help, once each: the first time a transcript turns amber, the context passes your Compact threshold, you add a second agent, or you paste a screenshot. Tips about things you already do are skipped. The card never blocks anything: it steps aside while you type in a terminal under it, sits left of the Assistant's panel while that is open, and moves up above a bar with buttons (such as **Resume** and **New** when a conversation has ended). **Don't show tips** turns them off (**Settings → General → Show a tip when Hive starts** turns them back on); **Help → Tips…** lists them all, searchable, either way.

### Moving dialogs

Any dialog (Add Agent, Agent Settings, a card, a question…) can be moved out of the way: drag it by its header. It stays inside the window, and **Escape** while dragging puts it back. A dialog opens in the middle again next time. A question over a dialog moves on its own, and Escape closes just the question. The image viewers stay where they are.

## Coding agents: Claude Code and Codex

Hive calls the coding agents it can run **providers**. Each agent in a project chooses its own, so a project can have a Claude Code agent and a Codex agent working side by side. Hive shows each CLI's own terminal, exactly as it looks when you run it yourself.

- **Turning providers on and off.** **Settings → Providers** lists them with their install state. A provider that is off can't start agents; its agents stay listed, greyed out. Turning one off while its agents run asks whether to stop them now or let them finish. **Default provider** is what new agents use (a project can choose its own in Project Settings).
- **Setup.** **Help → Agent Setup…** has a tab per provider: install, sign in, and updates. Claude Code signs in with a Claude plan or an Anthropic Console account; Codex with a ChatGPT plan or an OpenAI API key. On Windows, Codex also needs its sandbox set up once (without it, Codex asks before every command); see [Codex's Windows sandbox](#codexs-windows-sandbox).
- **Settings per provider.** Each provider has its own page (**Settings → Claude Code**, **Settings → Codex**): the CLI's path, default model, effort and permission mode, extra arguments, update checks, the fallback lists of models and effort levels, and its price table (see [Models, effort levels and prices](#models-effort-levels-and-prices)). **Settings → Claude Code → Use 200K context (instead of 1M)** is off by default: current Claude models have a 1M-token context window, and turning this on holds sessions to 200K, so Claude Code compacts a long conversation sooner and each message sends less. Projects and agents can choose for themselves, and it applies to sessions started afterwards. **Settings → Claude Code → Allow background sessions** is off by default: in Claude Code, pressing ← on an empty prompt (easy to do while moving through text) opens its agent view and moves the session into Claude Code's background service, where Hive can no longer see or stop it. Hive turns that off for the sessions it starts; `claude` in your own terminals is unaffected. If a session is in the background anyway (you turned the setting on, or moved it there outside Hive), resuming it shows a notification with **Stop It and Resume**, which stops Claude Code's background job and resumes the conversation here. Projects override them per provider in Project Settings.
- **The icons** on agent tabs, pane headers and the Sessions list show which provider each agent and session uses.
- **Conversations stay with their provider.** A Claude Code session can only be resumed by a Claude Code agent, and a Codex session by a Codex agent. To move work to another provider, use **Hand Over to…** (see [Sessions](#sessions)).
- **What both share.** The workspace's Hive skills (those for project agents), its MCP servers and Hive's own `hive` tools reach every agent, whichever provider it uses. Neither CLI loads MCP servers from your user settings in Hive sessions. Hive never changes either CLI's own configuration files.

### Models, effort levels and prices

Hive asks each CLI which models it has and what each can do, so a new model, or one your plan now includes, shows up without waiting for a Hive update. Claude Code and Codex answer for your installed version and your account (asking uses no tokens, and never starts a session). **Settings → <provider> → Models (fallback)** says where the models come from now, for example *From Claude Code 2.1.289*.

- **Model pickers** list the models the CLI reports; any other model can still be typed as a custom model ID.
- **Effort pickers** offer the levels the chosen model takes: Haiku has no effort setting, Opus 4.6 stops at Max, GPT-5.5 at Extra high. An effort you chose that the model doesn't take stays chosen and is marked *(not offered with …)*, with a warning; Hive doesn't change it for you.
- **Default effort.** With no effort chosen, the agent's footer and the pickers show the model's own default once the CLI has said what it is, for example *Medium (default)*.
- **When the CLI can't be asked** (not installed, an older version, an unexpected answer), Hive uses the fallback lists in **Settings → <provider>**: **Models (fallback)** and **Effort levels (fallback)**. You can add, remove and rename entries (mark a model **Older** to keep it behind *Show older versions*), and **Reset to defaults** goes back to Hive's own list, which then follows Hive's updates. The lists stay folded while the CLI's answer is in use; **Show the list** opens them.
- **API prices** are Hive's starting prices, labelled with the date they were checked: edit any that are out of date, add a model, remove one, or **Reset to defaults**. Hive never fetches prices.

## Workspaces and projects

A **workspace** is a folder of projects. When you open one, Hive creates a `.hive` folder in it:

```
MyWorkspace/
  .hive/
    shared/       notes, instructions and handovers for every project
    skills/       Hive skills (one folder per skill, Hive's own included)
    mcp/          MCP server definitions (one .json per server)
    tasks/        the task board (one .json per card)
    workspace.json
  ProjectA/
  ProjectB/
```

The workspace `.hive` folder is meant to be **committed** so a team can share skills, MCP servers and notes. Don't put secrets in it.

Each **project** (every subfolder except dot-folders) gets its own `.hive` folder for Hive's metadata: project settings, the session list and transcript backups. Hive adds it to the project's `.git/info/exclude`, so it's never committed and your `.gitignore` is left alone.

### Recent workspaces

**File → Open Recent** and the welcome page list the 12 workspaces you opened last, the most recent first.

- **Remove one** with its **✕** (on hover) or by right-clicking it → **Remove from Recent**. Only the list forgets it: the folder is left alone.
- **File → Open Recent → Clear Recently Opened…** (also in the command palette) forgets them all, after asking; workspaces open in a window stay.
- **A folder that isn't there any more** (moved, deleted, or on a drive that isn't connected) is greyed, with *not found*. It stays in the list, since a drive may come back. Opening it says it can't be found and offers **Remove from Recent**.
- **A workspace open in another window** says *open in another window*; choosing it brings that window forward.

Every window's list follows a change made in another.

### Moving a workspace

Move the workspace folder (in Explorer, to another drive…) while Hive doesn't have it open, then open it from its new place. A few things are kept by full path and still point to the old folder: agents' worktrees (and git's links to them), the folders sessions ran in, and Claude Code's conversations and memory, which it files under each folder's path in `~/.claude/projects`. Hive notices and says so in a banner, **This workspace was moved from …**. **Repair…** shows what it will do, and does it when you choose **Repair**:

- **Worktrees.** Hive keeps them in a folder beside the workspace (`<workspace>.worktrees`). Move that folder along, or leave it where it was: Repair finds each agent's worktree either way and links it to the moved project again (`git worktree repair`). One it can't find is listed: **Recreate worktree** makes it again on the agent's branch, which is kept in the repository, with its commits (**Create a new worktree** when the branch is gone too); or **Locate…** its folder; or **Remove the agent's worktree link** (the agent then works in the project folder; the worktree's folder, if it turns up, is left as it is). Locate or deal with every missing worktree you mean to keep before recreating another: recreating tidies git's list of missing worktrees, which would lose the links a moved one still needs, so Repair refuses and says which.
- **Sessions** point to the new folders, so they resume where they ran.
- **Claude Code's conversations and memory** are copied to the folder for the new path, so agents keep what they remembered. The old folders stay, and a file already there is never overwritten (Repair lists it).
- **Open Recent** lists the new folder instead of the old one, and the projects you had marked **Working on** are marked again.

Stop the workspace's agents first: Repair waits until none is running. It never moves or deletes anything at the old place, and running it again repeats nothing it has done. A file it couldn't copy (a folder it can't write to, say) is listed, and the banner stays: Repair tries it again, after a restart too. A file of Claude Code's that is already at the new place with other content is shown and left as it is. A project folder renamed or moved into the workspace on its own is repaired the same way. If the workspace was copied rather than moved, worktrees left beside the original stay with it.

The banner's **✕** hides it for now; **Repair Moved Workspace…** in the command palette opens Repair until it's done.

**A worktree folder that's gone.** If an agent's worktree folder was deleted (after its work was merged, say) or never came along (a workspace copied to another computer), starting the agent offers to **Recreate** the worktree on its branch, with its commits, at the same place; the project's worktree setup command runs first, as for a new worktree. When the branch is gone too, it offers a new worktree on it from the branch it started from, or to remove the agent's worktree link. If the old place can't be used (a drive that isn't connected), the worktree goes where Hive makes new ones, and the agent's sessions follow it.

### Several windows

Like VS Code, Hive can show several workspaces at once, each in its own window: **File → New Window** (Ctrl+K Ctrl+N) opens one on the welcome page, where you open or create a workspace. Each window is a full Hive with its own projects, agents, shared notes, skills and MCP servers; settings, the tray and updates are shared.

- **Open Workspace** replaces the workspace in the current window. If its agents are running, Hive asks first (*Switch workspace?*), then stops them; to keep them running, open the other workspace in a new window instead. If the workspace is already open in another window, that window comes forward instead, so two windows never run agents on the same project. A folder inside a workspace open in another window (or one containing it) can't be opened as a workspace: its projects would belong to both.
- **File → Close Workspace** stops every agent in every project of the workspace, asking first (*Close this workspace?*), and keeps the window open, on the welcome page.
- **Closing a window** (its **X**, or **File → Close Window**, Ctrl+Shift+W) closes its workspace and stops its agents, asking first as quitting does (*Close this window?*). Closing the last window keeps Hive in the tray, or quits Hive (asking first) when **Settings → General → Close to tray** is off.
- **Quitting** (**File → Exit**, Ctrl+Q, or the tray's Quit) stops the agents of every window. With several windows open, the menu says **Exit Hive (all windows)**, and its dialog says it closes them all and lists the agents under their workspaces (two workspaces with the same folder name also show the parent folder that tells them apart; hover a workspace for its full path); **Close this window only** there closes just the window it is shown in, as Close Window does. When Hive starts again, it reopens the windows that were open, each with its workspace, where they were.
- Notifications and the tray menu take you to the window showing the project.

### Always on Top

Keep a Hive window above your other apps, so a test run, an emulator or a browser can work underneath without covering it: click the **pin** in the title bar, just left of the window buttons, or use **View → Always on Top** (Ctrl+Alt+O), or the command palette. The pin is lit, and the menu item checked, while the window stays on top; click it again to turn it off.

- **Each window has its own.** Pinning one window leaves the others as they are.
- **It's remembered with the workspace.** Reopen the workspace, or start Hive again, and its window is on top again. A new window, and a workspace you never pinned, start off; so does the welcome page.
- It's your desk's preference, kept by Hive on this computer, not in the workspace's `.hive` folder: someone else opening the same workspace isn't affected.
- On top means above other apps' windows. Windows' own system screens (sign-in prompts, the Start menu) still come in front.

### Working on a project

The switch next to a project marks it as one you're **working on**. Only active projects run sessions, show live status and send notifications, so a workspace with dozens of projects stays quiet. Turning a project on never starts a session by itself.

Status dots:

| Dot | Meaning |
|---|---|
| Hollow | Active, no session |
| Blue | Session starting / ready for a prompt |
| Pulsing orange | Agent is working |
| Pulsing yellow | Agent needs your input (e.g. a permission prompt) |
| Slow, faint orange | Agent is waiting on background tasks it started (e.g. a test run) and carries on when they end |
| Blue ring | Agent is waiting for cards on the board to change, and carries on when one does (see [Card loops](#card-loops)) |
| Green | Agent finished its task |
| Glow | Something happened you haven't looked at yet (it goes once the agent's pane has been on screen) |

The sidebar and the lists in the Sessions, Files, Changes and Memory tabs can be made wider or narrower by dragging their right-hand edge, as can the two halves of a split view in the Files tab. Double-click the edge to reset it. Hive remembers the sizes.

A project's tabs (Session, Overview, Performance, Tasks and the rest) shrink to **icons** when their names don't fit, as in a narrow window or with the sidebar and panels open; the tab you're on keeps its name. Hover a tab for its name and shortcut. They get their names back once there's room. In a very narrow window the tabs scroll sideways, keeping the one you're on in view.

### Removing a project

**Project → Remove Project…** (also in a project's right-click menu and the **⋯** at the top of a project) offers three ways. The dialog lists what each one touches: running agents (stopped first; their conversations are kept), the folder, the project's handovers, its cards on the task board and its worktrees.

- **Hide**: Hive leaves the project out until you restore it. Nothing is moved or deleted; its cards are archived meanwhile.
- **Remove from Hive**: the folder stays on disk, and its handovers and cards are packed into it (`.hive/removed`), so you can move it somewhere else, or into another workspace. Wherever Hive sees the folder again, the project shows a banner offering to **Restore** them (or **Discard** them). A worktree can't go with the folder: if one has work that isn't merged yet, merge or discard it first.
- **Delete**: the folder, its worktrees and its handovers go to the Recycle Bin, and its cards are deleted. Type the project's name to confirm.

The coding agents' own transcripts (in `~/.claude` and `~/.codex`) are never touched. **Settings → Workspace** lists the hidden and removed projects, with **Restore**, which brings each back with its cards (and, for a removed one, its handovers). If a removed project's folder has left the workspace, **Forget** stops listing it.

**Compact project list.** To give the terminals more room while keeping an eye on every project, collapse the Projects sidebar to a narrow rail of status dots: click the **‹** chevron at the top of the list, press **Ctrl+Alt+B**, or drag the sidebar's edge almost all the way left. Each project shows as a tile with its initials and status dot; hover it for the name, status and agents, click to open it, right-click for the usual menu. Click **›** at the top of the rail (or press Ctrl+Alt+B again, or drag the edge out) to get the full list back. Shared Notes, Skills and MCP Servers always open at full width.

## Sessions

Each agent of a project runs one session at a time (most projects have just one agent; see [Several agents in one project](#several-agents-in-one-project)). A project without agents shows **No agents yet**: New Session and Resume add one for you.

**Where things are.** The project header is about the project: its name and combined status, the **Active** switch, **Resume All Agents** while any stopped agent has a session to resume (running agents are left alone; if one can't resume, a notification says which and why, and the others still resume), **Stop (All)** while any runs (it lists them and asks first), **Start New (All)** and **Archive and Start New (All)**, and **⋯** for **Explorer** (reveal the folder), **Terminal** (open an external terminal there), Project Settings and Remove Project….

**Fresh sessions for every agent.** **Start New (All)** gives every agent of the project a new session at once: it lists them and asks once, saying which are in the middle of something (a working agent is interrupted). Running agents are stopped first; their conversations stay in the Sessions tab, to resume later. **Archive and Start New (All)** does the same for every agent that has a session, archiving each one first (as an agent's own **Archive and Start New…** does), so the old transcripts move to the project's `.hive/archive`. If an agent can't start, one notice says which and why; the others still start. Both are also in the **Session** menu and the command palette. Agents are added from the agent strip's **Add Agent** button. Everything about one agent is on its own pane, whether a project has one agent or four:

- **The agent header**: its status, provider, name, worktree branch and card, then its buttons: **Compact** and **Stop** while it runs; **Resume**, **Resume a Session…** and **New Session** when it doesn't; **Merge** for a worktree agent; and **⋯** with everything else. Compact, Stop and Merge are always small icon buttons (hover for what they do; Merge shows its count of work not merged yet beside its icon); as the pane gets narrower the other buttons show only their icons too, then they all fold into **⋯**, and they get their labels back as soon as there's room again. In a narrow pane the agent's name, branch, status and card shorten (hover for the full text) so the buttons always fit. While the conversation is compacting, Compact shows a turning spinner until it has finished.
- **The agent footer**: its model and effort (click for Agent Settings), its permission mode (click to switch), and on the right the session it's running (its icon: hover for its name), the context it uses, with how full the model's context window is once the CLI has said (*84k · 42%*: the last request's input plus its output, thinking included, which is what the CLI compacts on, so a turn that thinks a lot shows at once; hover for the two parts and where Claude Code compacts by itself: by default about 167K of a 200K window (967K of 1M), or as its settings change it, which the tooltip names: an auto-compact window set with `autoCompactWindow` (also per model), `--autocompact` or `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, an earlier percentage, or auto-compaction turned off (`autoCompactEnabled`, `DISABLE_AUTO_COMPACT`, `DISABLE_COMPACT`); Hive reads them when the session starts and never changes them; amber past your Compact threshold; click to see the session in the Overview, with its compaction history, as its tooltip says), the size of the conversation's transcript (amber past **Settings → Sessions → Warn when a transcript is over**; click for Hand Over to…) and the session's cost (click it to see the session's details in the Overview: that agent's session, scrolled to). In a narrow pane, items show just their icon to make room, in turn: the transcript size, then the context's tokens, then the whole context (hover any of them for the figures); then the permission mode's name shortens, and only in a very narrow pane is the cost cut off.

The status bar keeps what concerns the whole app: the workspace, branch, running agents, the agents that need you (see [Agents that need you](#agents-that-need-you)), plan limits, the Agent API, each CLI's version and Hive's updates.

An agent's header and the **Session** menu let you:

- **New Session** — start fresh. If one is running, Hive stops it first (after asking).
- **Resume** — continue a previous conversation. If the prompt cache has expired, Hive shows how many tokens resuming will re-cache and offers **Archive and Start Fresh** instead. A new agent can resume sessions whose agent is gone (for example after the upgrade to 0.2, which starts every project without agents).
- **Stop** — end the session. The conversation is kept and can be resumed.
- **Compact** — summarise the conversation so far so every later message is cheaper. Available once the agent has finished; it turns orange when the context passes your threshold (**Settings → Sessions → Suggest compacting above**, 200,000 tokens by default, and overridable per project in Project Settings). The Hive Assistant has its own threshold, since it usually runs a bigger context: **Settings → Assistant → Highlight Compact over**, 500,000 tokens by default. You can add an optional focus ("keep the API decisions, drop the test output"); left empty, the agent decides what to keep. Nothing is lost: the full history stays in the session's transcript. Anything you had half-typed is cleared first; press Ctrl+Y in the session to get it back.
- **Hand Over to…** (agent menu) — hand this agent's work to another agent of the project, which may use another provider, or to the agent itself **in a new conversation** (see [Long conversations](#long-conversations)). Hive asks this agent to write a handover (if it's running and idle; untick to use the latest handover instead), then starts the other agent, or messages it if it's already running, and tells it to read that handover and carry on. Hive waits for a handover from that agent's own conversation, so one another agent writes meanwhile isn't picked up. Every handover an agent writes starts with a header Hive fills in: the project, the **author** (the agent and its CLI, e.g. *Claude (Claude Code)*), the **session** it was written in (to resume it with questions) and the date, in your time with UTC in brackets. The new session shows a **handed over** badge in the Sessions tab that links back. It needs **Settings → Agent API → Provide Hive tools to sessions**. If the other agent's CLI asks something first (for example whether to trust the folder), answer it in its terminal.
- **Archive and Start New…** (in the agent's **⋯** menu, or **Archive Session and Start New…** in the command palette) — archive the current conversation and start a clean one. This is the cheapest way to continue after a long session: the new session starts with an empty context instead of re-caching the old one. Write a handover first (see below) so the new session knows where to pick up.

### Reading past sessions

The **Sessions** tab shows every session of the project on the left as a tree, like the Files tab: by **provider** (Claude Code, Codex), then by **agent**, then the sessions themselves, newest first, with when each was last used and its context size. Sessions started outside Hive (in VS Code or a terminal) and adopted ones go under **Not from an agent**; started outside Hive, they show as *external*: **Adopt** them to manage them in Hive. A session keeps its own agent: if you remove an agent and add another with the same name, the old sessions stay under **Coder (removed)** (or **Removed agent**, for sessions from before Hive kept agents' names). Each session says where it ran, such as **Project folder** or **Worktree · hive/reviewer** (hover for the full folder), and the **Ran in** line over its transcript names the agent too. **Resume in …** says which agent would resume it now, and its ▾ menu shows where each agent works. Tick **Archived** to include archived sessions.

Every branch shows how many sessions it holds. Branches start folded, except your focused agent's and the way down to the session you're reading; Hive remembers what you open and fold for each project. **Expand All** and **Collapse All** are in the header, and on every branch's menu.

**Sub-sessions.** Some sessions are started by the CLI for another one rather than by you: in **Approve for me**, Codex starts a short **guardian review** to judge each action, and saves each as its own session. They sit under the session that started them, which says how many it has (*3 guardian reviews*), so they don't crowd the list. They can be read like any session, but never resumed. One whose session isn't listed any more stays under its own agent.

**Keys** work as in the Files tab: ↑ and ↓ move (moving onto a session shows it), → opens a branch, ← folds it or goes up to the branch above, Enter folds or opens a branch, F2 renames and Delete deletes.

**Archive or delete a whole branch.** Right-click a provider, an agent or a session with sub-sessions (or use the **⋯** on its row) for **Archive All…**, **Unarchive All** and **Delete All…**. Hive asks once, naming how many sessions and which branch, then archives or deletes each of them. Sessions that are running, or whose files are in use (another program has the transcript or Hive's copy of it open, its CLI is still writing it, Hive is reading it for an export or search, or it's open in another Hive window), are left alone, and the result says which and why: *Deleted 2 sessions; 2 skipped: 1 running, 1 in use*. Try those again once they're free. A session is never half deleted: either all of Hive's copies of it go, or none. If the transcript you're reading is one of them, Hive closes it first and says so.

**Sessions you can't resume** show a muted *can't resume* marker, and their **Resume** button is greyed out: hover it to see why. A sub-session isn't a conversation; its provider is turned off or not installed; neither the CLI nor Hive has its transcript any more; or no agent can run it (it ran in a worktree no agent of its provider uses). If its agent was removed, hovering **Resume** says which agent resumes it now.

Select a session to read its transcript on the right, including everything before each compaction. It opens at the latest messages; scroll up to load earlier ones. A running session doesn't update on its own unless you switch on **Follow** (the Session tab always shows the agent working); otherwise click **Refresh**. **Settings → Sessions → Follow running sessions** sets the default.

- Your messages and Claude's replies are shown in full.
- Thinking and each tool call are collapsed to one line (for example "Bash · Run the login tests" or "Edit · src/app.ts"). Click one to see its input and result; very long output is shortened, with **Show all**. The expand button in the toolbar opens or closes them all.
- Each compaction is a divider showing whether it was manual or automatic, the context size before and after, and the size of the first request after it (which also carries Claude Code's instructions and tools). Click it to read the summary the agent continued from.
- Slash commands such as `/compact` appear with their output, and pasted images as thumbnails; click one to view it.

The transcript opens at the latest message. For the running session it updates as the agent works, and scrolls with it while you are at the bottom.

**Search** (Ctrl+F in the tab) looks through every session: names, dates, providers and agents, and the transcripts' messages, replies, tool calls and results, and compaction summaries. The tree keeps only the sessions that match, with their branches opened and each session's matches listed under it; the line under the search box counts them. Click a match to open the transcript at that point with the matches highlighted. Clear the search to get the whole tree back.

From the toolbar you can **Copy** a message or reply (hover it), **Export as Markdown** to save the whole conversation as a readable file, **Resume** a session that isn't running (with several agents, **▾** chooses which one continues it), **Show** the agent that is running it, and rename (the tag), archive, delete or adopt it. Rename, delete and **⋯** (the rest) also show when you hover a session in the tree, or right-click it.

**Deleting a session** removes it from Hive: Hive's copies of its transcript go to the Recycle Bin and it no longer shows in the tree. What it used (tokens, cost, prompts) stays in the Overview's totals. A running session has to be stopped first, and one whose files are in use waits until they're free. Claude Code and Codex keep their own copy, so their own resume lists still have it.

### Dates and times

Hive shows dates as **2026-10-04** and times as **14:05** by default: sessions named by when they started, the session lists and their tooltips, transcripts, exports and the rest. **Settings → General → Date format** chooses *yyyy-mm-dd*, *dd/mm/yyyy*, *mm/dd/yyyy* or *System* (your Windows language's own), and **Time format** *24-hour* or *12-hour* (2:05 PM). Names you give sessions stay as you typed them; only the automatic ones follow the format. How long ago a session was last active (*2 hours ago*) stays as it is: hover it for the date and time.

### Several agents in one project

A project can have up to twelve agents working at once, for example one building a feature while another reviews or writes tests. All agents are equal: any of them can work in a worktree, and any can be removed once stopped. **Add Agent** above the terminal adds one straight away, with your default provider (**Settings → Providers → Default provider**, or the project's in Project Settings) and its default settings, working in the project folder. Its **▾** opens **Add Agent…**, where you choose:

- **Name** — "Agent 2" by default; rename it any time (double-click its tab). Its **Role** (Agent Settings), such as *builder* or *reviewer*, says what it is for; templates save it (see [Agent templates](#agent-templates)).
- **Where it works**:
  - **Project folder** — shares the folder with the project's other agents.
  - **New worktree** — its own checkout of the project on its own branch (`hive/agent-2` by default, based on the branch you pick). Its work stays separate until you merge it. Hive creates worktrees next to the workspace, in `<workspace>.worktrees\<project>\<agent>`, and copies git-ignored files such as `.env` into them (**Project Settings → Agents & Worktrees → Copy into new worktrees**). If the project needs setting up first, set a **Setup command** such as `npm install`: it runs in the agent's pane before the agent starts, and if it fails you can retry or start without it.
  - **Existing worktree** — a worktree of the project that no agent uses, such as one you kept when removing an agent.
- **Provider** — Claude Code or Codex (only enabled providers can be chosen). Changing an agent's provider later clears its model settings and its last session, since conversations can't move between providers.
- **Settings** — the agent can use its own model, effort and permission mode, for example Sonnet for a reviewer while Opus codes, or a Codex reviewer next to a Claude Code agent. Left on *Project's*, it follows Project Settings for its provider.

**Layouts.** The layout follows as you add agents: two columns for two, three for three, a 2×2 grid for four, a 3×2 grid for five or six. The buttons at the right of the agent row choose one yourself: one at a time (click an agent to switch), two columns, three columns, a grid of four or a grid of six. A layout you choose stays as agents are added; choosing the one that shows all the agents makes it follow them again. Three columns and the grids work best on a wide window, or with the sidebar hidden (Ctrl+B).

**Pages.** The project has one layout, and a page holds as many agents as it has panes, so every agent on a page has its own pane: with four agents in three columns, page 1 shows three and page 2 the fourth; six agents in a grid of four are two pages (4 and 2). Left automatic, the layout shows every agent up to a 3×2 grid, and a seventh opens page 2. **One at a time** has no pages: the agent tabs choose who is shown. The numbered buttons next to the layouts switch pages, or press Ctrl+Alt+PageDown / Ctrl+Alt+PageUp; a dot on a page's button shows its most urgent agent (one waiting for you, say), and its tooltip says which agents are there. Changing the layout re-pages at once. Clicking an agent on another page goes there. Each agent runs its own copy of its CLI, so Hive notes the memory use when you add the seventh. Each pane has its own header with the agent's status and buttons; click a pane to make it the **focused** agent. The buttons in the project header, the Session menu, pasting screenshots and **Insert into Session** act on the focused agent. Ctrl+Alt+] and Ctrl+Alt+[ move between agents, across pages. With **One at a time**, clicking an agent shows it.

**Arranging agents.** Drag an agent (its tab, or its pane by the header) onto another agent's pane to **swap** them, running or not; onto an empty pane to move it there. Drag a tab along the strip to move it between others, like browser tabs (a bar shows where it will land). To swap with an agent on another page, hold the dragged agent over that page's button for a moment: the page shows, and you drop it on a pane there. Drop it on a page button itself to move it to that page's last place. The panes always show the agents in their order, so what you see is what's saved. Or use **Move Left** / **Move Right** in the agent's menu, or **Ctrl+Alt+Shift+Left / Right** for the focused agent. The order is saved with the project; nothing is stopped or restarted.

**Which conversation each agent has.** Each agent's footer shows the session it is running as an icon, on the right before the context: hover for its name and when it started, click to read it in the Sessions tab, right-click to rename it. Until a session has a name, it is named by when it started, e.g. *2026-10-04 14:05* (in your date and time format: **Settings → General → Date format** and **Time format**). You can rename a session in Hive (the footer or the Sessions tab) or in Claude Code with `/rename`: whichever you did last is the name Hive shows, and resuming the session keeps it. A conversation can only be open in one agent at a time. **Resume** reopens the agent's own last session and is greyed out when it has none. Its **▾** lists the recent sessions from the agent's folder: pick one to continue it in this agent, including a paused conversation another agent in the same folder started. Sessions that are open in another agent are greyed out; clicking one takes you to that agent. Agents in their own worktree only see that worktree's sessions.

The sidebar keeps one status dot per project, showing the most urgent agent (needs input, then working…), with the number of running agents next to the name. The project header's status says how many agents are in that state (for example *Working · 1 of 2 agents*); hover it for each agent's state. Notifications name the agent, e.g. "hive · Agent 2 finished".

**Background tasks.** An agent can start something and end its turn while it runs, such as a long test run. Claude Code is told when the task ends and carries on by itself, so Hive shows the agent as **waiting on background tasks** ("Waiting on 1 background task") rather than finished, and only says it has finished (chime and notification) once it really has. Meanwhile the Assistant waits for it and won't give it a new task, and quitting asks first, since the task would stop. Codex isn't told when its background terminals end, so a Codex agent shows as finished with the count next to it ("Finished · 1 background task running"). Hive can't tell a test run from something that never ends, such as a dev server, so it stops counting a task after an hour; change that in **Settings → Agents & Worktrees → Count background tasks for up to**.

**File locks.** Agents sharing the project folder could otherwise edit the same file at the same time. When an agent edits a file, Hive notes that it is working on it; if another agent then tries to edit that file, Hive tells it to wait or work on something else, and it carries on with other work. The claim ends when the first agent finishes its task. The files an agent holds show as a lock with a count on its tab. **Settings → Agents & Worktrees → File locks** (or per project) chooses what happens: **Block** (default), **Ask me** (you approve the edit; Codex can't show its own approval for this, so Hive holds the edit back and shows a notification with **Allow**, and Codex waits until you allow it; Hive tells it to go ahead as soon as it has finished replying and you aren't typing in its terminal), **Warn** (the edit goes ahead, the agent is told), or **Off**. Locks cover the agents' file edits, not shell commands (formatters, `npm install`, `git checkout`), and not files agents share outside the project such as the CLIs' own settings or memory — keep that in mind when several agents work in one folder. Agents in their own worktrees never get in each other's way.

If git can't read the changes, the **Changes** tab says why, with **Retry**. The same goes for every list and search: if one can't be read, Hive says so with **Retry** rather than showing nothing, and if a refresh fails the last results stay, with a note saying when they're from. They are always the same project's (or workspace's): switching to another project never shows the last one's.

**Reviewing and merging a worktree agent's work.** In the **Changes** and **Files** tabs, the selector at the top switches between the project folder and each agent's worktree. For a worktree, Changes lists everything the agent changed since its branch started (its commits and uncommitted edits). When it is done, choose **Merge** (pane header, agent menu or Changes tab):

- Uncommitted changes are committed on the agent's branch first, with the message you enter.
- The branch is merged into the branch checked out in the project folder: **Merge** (the default; keeps the agent's commits and their messages, plus a merge commit) or **Squash** (one commit, with the message you enter). Change the default in **Settings → Agents & Worktrees → Default merge style**.
- If the same files changed on both sides, nothing is merged. Hive lists the files and can send an agent in the project folder instructions to do the merge and resolve the conflicts, or copy them for you.
- **Remove the worktree and branch afterwards** (and the agent) is off by default: an agent can keep its worktree and work on task after task, merging as it goes. Tick it when its work is finished (stop the agent first).
- **Squash** with the worktree kept offers **Move the branch to main afterwards** (ticked). The squash commit holds all the branch's work, so the branch is moved there and the agent's next merge brings only what is new. Without it, the branch keeps its old commits and its next merge may conflict with its own earlier work. Hive only moves it when nothing would be lost, and tells you if it couldn't.

**Working with one agent for a while.** With **Merge** and the worktree kept, an agent can do a task and merge it, then the next task and merge again, or several tasks and one merge. When the project folder's branch moves on (another agent's work was merged), ask the agent to merge it into its branch before its next task, so it works on current code.

**Work not merged yet** shows on the agent: the **Merge** button in its header (its icon is a branch merging) turns orange with the number of commits on its branch that aren't in the project folder's branch, and its tab in the agent strip shows the same number with an up arrow. A **•** instead of a number means uncommitted files only. Hover either for the details ("2 commits not merged into main · 1 uncommitted file"). Hive checks when the agent finishes a turn or stops, when you come back to Hive's window, after a merge, and every minute while something is left to merge. **Merge…** is greyed out while the agent is in the middle of a task (working, asking you something, or waiting on background tasks it started), because merging commits its unfinished files; hover it to see why, and merge once it has finished.

**Remove Agent** asks whether to keep a worktree agent's worktree and branch or delete them; **Discard** deletes them straight away. Their sessions stay in the Sessions tab, labelled with the agent and branch. Two dev servers from different agents can clash on the same port; give them different ports.

### Agent templates

Set a project's agents up once, see them work, and reuse the setup anywhere: a **template** saves each agent's name, role, provider, model, effort, permission mode and context setting, whether it works in its own worktree, and the project's layout. Conversations, worktree folders and branches aren't saved: they belong to the project.

The agent strip, next to the layouts, has three controls (icons when the window is narrow, one **Templates** menu when narrower still):

- **Save Template…** names the template and saves it for this project only (kept in its private `.hive` folder) or, ticked, for every project in the workspace. Saving with a name that's already there asks before replacing it; saving again is how you change a template.
- **Template ▾** lists the workspace's and this project's templates (the same name can be in both) and loads one. Loading **replaces every agent** of the project: Hive first lists who goes and who comes. It won't load while an agent runs or is starting (stop it first), while a worktree agent has uncommitted work (commit or discard it first) or Hive can't check its worktree, or while a provider the template needs is turned off or not installed (it says which, with a way into Agent Setup). The removed agents' conversations stay in the Sessions tab, their worktrees and branches stay on disk (to merge, or reuse with **Add Agent → Existing worktree**), and their open cards go back (Doing ones to Todo). No agent of the project can start while a template loads. If an agent can't be created, or the agents change meanwhile, nothing changes.
- **Add Agent from Template ▾** adds one agent from a template and leaves the others alone; a name that's taken gets a number ("Builder 2").

**Roles.** An agent's **Role** (Agent Settings), such as *builder* or *reviewer*, says what it is for: templates save it, and the agent's tab tooltip shows it. Leave it empty and the agent's name is its role. **Save Agents as Template…** is in the command palette too.

### Managing and sharing templates

The **Templates** view (its icon is next to Skills on the activity bar) lists the workspace's templates and each project's, grouped by where they're kept; the drop-down at the top shows all of them, the workspace's, or one project's. A project's **Templates** tab lists its own templates and the workspace's, each marked with where it's kept.

Select a template to see what it holds: each agent's name, role, coding agent, model, effort, mode and whether it works in its own worktree, and the layout. You can't edit a template there: to change one, set a project's agents up the way you want and save them again under the same name. With a template selected:

- **Load into Project…** (in the view, you choose the project) or **Load into This Project…** (in a project's tab) replaces the project's agents and layout, with the same list of who goes and who comes, and the same checks, as **Template ▾**.
- **Rename…** renames it where it's kept. Another template there can't have the same name.
- **Duplicate…** copies it into the workspace or any project. A name that's already taken there gets a number: "Pair (2)".
- **Export…** saves it as one file, such as `Build and review.hive-template.json`, wherever you choose. Templates live in `.hive`, which git ignores, so exporting is how you share one. The file holds only the template: no folder paths, sessions or names of people.
- **Delete** sends it to the Recycle Bin.

**Import…** (the download icon at the top of the list) opens a template file and asks where to keep it: the workspace, or a project. Hive checks the file first and refuses one it can't use, saying why: not a template, made by a newer Hive, or more than 12 agents. Nothing is half imported. If a template of that name is already there, choose **Replace** or **Keep Both** (the imported one gets a number). A template whose coding agent this Hive doesn't know, from a newer Hive say, is imported and marked: Hive won't load it until it knows that agent.

### Archiving and backups

Claude Code and Codex delete old transcripts after a while. Hive keeps a copy of every session transcript in the project's `.hive/sessions` folder, and archived sessions in `.hive/archive`. Images you paste or drop into a session are kept in `.hive/images`. Hive only deletes them when you ask (deleting a session sends its transcript copies to the Recycle Bin; its images stay). If the CLI has removed a transcript, Hive restores it from the backup when you resume.

**Storage.** **Project Settings → Storage** (or **Project Storage and Clean Up…** in the command palette) shows how much space Hive keeps for the project: transcript backups (`.hive/sessions`), the archive (`.hive/archive`), images (`.hive/images`) and each agent's worktree. It's measured in the background, so a large worktree never holds up the window, and leaving the page stops measuring; **Refresh** measures again. The coding agents' own transcripts (in `~/.claude` and `~/.codex`) aren't counted. **Settings → Workspace → Storage** shows the workspace's total and its biggest projects, the Hive Assistant included; **Storage** next to one opens its page.

**Clean Up…** on that page moves old files to the Recycle Bin. Nothing is cleaned up automatically. Choose what goes:

- **Images of archived sessions** last active more than 90 days ago (or the number of days you set). This is the only option on at first.
- **Images of deleted sessions**, and of launches that never got a session (folders named `run-…`).
- **Hive's backups of archived sessions** last active more than a number of days ago, only where Claude Code or Codex still has the transcript. The session stays: you can still resume and read it, from the CLI's copy, for as long as the CLI keeps it.
- **Backups of archived sessions the CLI no longer has.** Hive's copy is the last one, so these sessions are deleted, as **Delete Session** does: they can't be resumed or read afterwards. The dialog warns you when this is on.

The dialog lists every file that will go, with its size and the total, before anything happens; **Move … to the Recycle Bin** removes exactly those. Running sessions and sessions that aren't archived are never touched, also when one is resumed or unarchived while the dialog is open: it's skipped and listed in the result. What the cleaned-up sessions used still counts in the Overview and the Workspace Overview.

### Token use, cache and compaction

The **Overview** tab updates as sessions change (at most every 15 seconds; **Settings → Sessions → Overview updates** can make it every minute or only when you click **Refresh**). It starts with the project's **cards at a glance**, as on the Workspace Overview but for this project only: how many are On Hold, in Todo, Doing, Waiting for review, Passed and Done, and how many are stalled or blocked. They update as cards change, and clicking a number opens the project's **Tasks** tab. A project without cards says so, with **Open Tasks**. Then a **project summary** for the period you choose (All time at first, or Today, 7 days, 30 days), across every provider: tokens, API-equivalent cost, sessions and prompts. Periods are calendar days (Today is since midnight; 7 days is today and the six days before), and they count only what happened in them: a session that has been running since Monday adds only today's work to Today. For 7 and 30 days a small chart shows the tokens of each day; hover a day for its cost and prompts. Below it are the agents **running now** (with how full each one's context is), a section per provider with its totals and plan limits, a table **by agent**, and one agent's session: its running session, else its most recent one. It follows the focused agent; with several agents, a picker next to the heading shows another's.

- **Context** — how many tokens the conversation occupies right now: the last request's input plus its output (thinking included), which stays in the conversation. That is what the agent compacts on, so a turn that thinks for 70K tokens can take a context showing 116K to 189K and set off a compaction; the compaction history says so ("turn added 72.4k output").
- **Cache** — whether Anthropic's prompt cache is still warm (5-minute or 1-hour lifetime) and how long it has left (Claude Code).
- **Re-cache on resume** — an estimate of the tokens written to cache on the first message after resuming, once the cache has expired.
- **Compactions** — each time the agent summarised the conversation to free space, with before/after sizes, newest first, ten to a page (**Rows per page** changes that, and is remembered). Filter by trigger (auto or manual) or by date and time, and click a column's header to sort by it (again for the other way, a third time for newest first). Click a compaction, or press Enter on it, to read it in the **Sessions** tab, at its divider with the summary the agent continued from. Clicking the context in an agent's footer brings you here.
- **API-equivalent cost** — what the session would have cost at API prices. On a subscription you are not charged this; it is a measure of how heavy the session is. Claude Code calculates it itself; for Codex, Hive **estimates** it from a price table (shown with **≈**). Hive ships the published prices as starting values, and you can change, add and remove them in each provider's settings page (**API prices**) if they change or you have different rates. For a model Hive has no price for, the cost shows as unknown (**$?** in the agent's footer, **Unknown** on the Overview; a total that includes such sessions shows what is known with **+ ?**); hover it to see which model, and add its price under **API prices** to see the estimate.

### Long conversations

A conversation's transcript keeps everything that happened in it, and compacting doesn't make it smaller: it only shortens what the agent has in its context. A very long one (100 MB and more) slows down the CLI and Hive, and can make typing in the terminals stutter. The size shows in each agent's footer, next to the context, and turns amber past **Settings → Sessions → Warn when a transcript is over** (20 MB; projects can set their own). Hive also tells you once when a conversation passes it.

To start afresh without losing the thread, click the size (or choose **Hand Over to…** in the agent's menu) and pick the agent itself, **in a new conversation**: the agent writes a handover, Hive ends its conversation (it stays in the Sessions tab) and starts a new one that reads the handover and carries on. The Assistant sees each agent's transcript size too, and can suggest it.

**Usage cache.** Hive remembers each transcript's token counts, also across restarts, so the Overview and session lists open without reading every transcript again. A transcript is read again only if it changed while Hive was closed, such as a session you continued outside Hive. **Settings → Sessions → Usage cache size** sets how many it keeps (5,000), and **Clear the usage cache** starts afresh.

### Workspace Overview

The **Workspace Overview** (in the activity bar, or **Ctrl+Shift+O**) adds up the whole workspace: every project and the Hive Assistant. It opens on the last **7 days** (or Today, 30 days, All time) and shows:

- the task board at a glance: cards per column, stalled and blocked, each opening the board;
- tokens, API-equivalent cost, sessions and prompts for the period;
- for 7 and 30 days, a chart of tokens per day, stacked by project (the six busiest, the rest as Other); each day is a tile of its own, as in the Performance chart, so quiet days still show; hover a day for each project's share;
- every agent running now, in any project (click one to go to it);
- a table **by project**, with the Assistant as its own row: click a column to sort, or a row to open that project's Overview;
- each provider's totals and plan limits.

Hidden and removed projects aren't counted. It updates like the project Overview, and reads no more than it does: token counts come from the usage cache.

### Plan usage

If you use a subscription (a Claude plan for Claude Code, a ChatGPT plan for Codex), the status bar shows how much of each plan's limits is used, one item per provider, for example **5h 34% · Week 12%**: the rolling 5-hour allowance and the weekly one. Hover it to see when each resets; the **Overview** tab shows them with meters in each provider's section. The numbers are for your whole account (every session, not just Hive's) and come from the CLI while a session is running, so after a quiet spell they show when they were last updated. The status bar darkens at 80% and turns red at 95%, and Hive notifies you once when you pass 80% and 95% of each limit in each reset period.

Each agent's footer shows its model and **effort**, e.g. *Opus 5.5 (default) · High*: the model that actually runs, as the running session reports it, otherwise the model new sessions will use. An alias such as **Opus** shows as the model it stands for (*Opus 5.5*), with *chosen as Opus* in the tooltip; the model pickers list it as *Opus (Opus 5.5)*. *(default)* means the model is inherited, not chosen for this agent or project. With no effort chosen, the effort is the model's own default once the CLI has said it (*Medium (default)*).

### Performance metrics

Hive counts what its own parts cost, for each workspace: its Agent API's requests (how many, how long, how big), its tools' replies as the agents got them, what each session was given at launch (Hive's guidance, the Assistant's persona, the skills), and its skill service's work, alongside the providers' own reported token usage. Only totals are kept, never prompts, replies, tokens or paths, for 30 days, in the workspace's `.hive/metrics` folder (kept out of git). Hive doesn't guess token counts: what it measures is exact bytes and characters, and token usage is what the providers report.

It's on by default: **Settings → Sessions → Record performance metrics** turns it off (what was recorded stays), and **Reset performance metrics** clears the workspace's. Scripts can read them with the Agent API (`GET /v1/metrics`).

### Performance view

**Performance** in the activity bar shows these metrics for the whole workspace; each project's **Performance** tab (next to Overview) shows only that project's. Pick the last **24 hours**, **7 days** or **30 days**, and filter by who did the work (project agents, the Assistant, scripts) and by provider. In the activity bar view, the sidebar (or **Scope**) picks the whole workspace, its own work (the Assistant, scripts) or one project. Everything on the page follows the filters, the chart and Export too; where a filter can't apply (Hive doesn't record API requests per provider, for example) the page says so. You see:

- how long Hive was recording in the range: metrics are only kept while the workspace is open in Hive with recording on, so time before that, while Hive was closed or recording was off, or before a reset is **not recorded** (no data, not zero), and so is history Hive removed to keep its metrics file small, which the page says;
- cards: Agent API requests (per hour recorded) and how many failed or were cancelled, their latency (p50 and p95), the data sent and received, the characters Hive's tools gave the models, and what each session got at launch;
- a chart of requests per hour (24 hours) or per day, failures in red and hours not recorded hatched; hover a bar for its tool calls and launches;
- tables of Hive's tools (sorted by the characters they cost a model's context), Agent API routes, the guidance given at launch in parts (Hive's core instructions, what it adds for the project, the Assistant's role and persona, the skills' catalog), and the providers' own usage for project agents and the Assistant apart: tokens, requests, context (each session's latest, not added up), compactions and API-equivalent cost (≈ where Hive estimated it, **unknown** where a session reported nothing; not a bill). If a project's session history couldn't be read, the page says the totals are partial;
- for the whole workspace, the skill service's scans and cache, and Hive-wide event streams.

It refreshes every minute while you look at it (and **Refresh** at once); reading it doesn't add to the numbers. A note says when measurements were dropped because a limit was full, and **What isn't measured** lists what it can't see. **Export** saves what the page shows (its scope, range and filters) as a JSON file with its units, coverage and Hive's version; **Shift+click** Export to replace project names with project-1, project-2… and leave out the workspace's path, before sharing it.

### Comparing before and after

**Compare** (at the top of the Performance page) puts a baseline next to a run, to see whether a change made Hive's
traffic and guidance smaller while the work still got done:

- **Keep current view** saves what the page shows now (its scope, range and filters). Keep one before a change and
  another after it, then pick them as **Baseline** and **Run**. They are compared per hour Hive was recording, with what
  makes either partial noted. Real use isn't a controlled workload, so a difference can be the work that was done.
- **Import…** reads a Performance export or a **scenario benchmark**: the `benchmark.json` that Hive's development
  scenarios write (tests/scenarios in Hive's source). A benchmark compares scenario by scenario, **correctness first**:
  *smaller, still correct* only if every check that passed still passes and still runs, and no more calls, failures or
  retries were made. A smaller result that lost a check is *smaller but failing*, not an improvement. The table shows the
  checks passed ✓, failed ✗ and skipped – on each side; click a scenario for every measure, its samples and spread, and
  which checks changed. Something that wasn't measured shows as **unknown**, never as zero, and a scenario that wasn't
  fully measured isn't judged.
- If the two measured different things (other scenarios, provider, model or filters, or a fake against a real model), the
  page says **Not comparable** and why.
- The scope is the page's: the whole workspace, **Workspace's own work** or one project each keep their own list. A
  project's Performance tab compares only that project's own kept views and exports; given a workspace export, it asks
  before using that project's part, and an export that holds other projects' data is refused. Scenario benchmarks are
  compared with the whole workspace selected.
- While comparing, the range and filters of **Now** are hidden: each file keeps the ones it was made with (shown above the
  table). They only shape what **Keep current view** saves.
- A fake provider's token counts are simulated, so they're never compared; a model trial's are, when both report them.
- Up to 20 are kept in the workspace's `.hive/metrics/benchmarks` folder (this machine's); when it's full, the oldest
  unpinned one goes. **Pin** one to keep it. If the folder's list is damaged, Hive rebuilds it from the files it finds
  (keeping the old list aside) and says so: nothing kept is deleted for it. Files Hive can't account for go to the
  folder's `quarantine` subfolder instead of being deleted. A removal that can't finish (a file in use) is retried
  later, and the comparison doesn't come back to the list.

### Progress panel

Long runs, such as test suites and builds, can report their progress to Hive, and the **Progress panel** shows them: which agent is running what, how far along it is and about how long is left. It sits on the right, beside the Hive Assistant's panel. Show or fold it with **Ctrl+Alt+P** (Toggle Progress Panel); each workspace remembers whether it's open, and dragging its left edge makes it wider.

- **Folded**, it is a narrow **Progress** strip down the right edge with a small bar for each run, so you can see something is going without giving it room. It has bars for the newest six; more runs show as **+N** under them (red when one of those failed, amber when one stopped reporting), and hovering it lists them. It never opens by itself; click the strip to open it.
- **Each run** shows the agent and its project, what is running ("e2e: 12 suites"), a bar, the step ("4 of 12: carddialog"), how long it has taken and, once Hive has an estimate, about how long is left. A run that doesn't report steps shows a moving bar and the time. Long titles end in "…" (hover for the whole command). Click the agent's name to show that agent: its pane flashes and its terminal takes the keyboard, also when it was already on screen (from the keyboard, **Tab** to the name and press **Enter** or **Space**).
- **Details:** click anywhere else on a run, or on one under **Recent** (or the chevron at the end of its row, which points down while the details are closed and up while they're open), to see everything Hive has for it: the command (with **Copy command**), the agent, project and provider, when it started and ended (in your date and time format), how long it took against what was expected, its steps, its state and why, the exit code, a log or run record when the command named one, and a failure's summary. **Copy details** copies all of it as text, a line per field, ready to paste to the Assistant. **Open log** opens the log in its app and **Show in folder** shows it in Explorer, wherever it is; if the log has gone, Hive says so. **Show the agent** is there too; for a script's run, or one whose agent has since been removed, it says why there's no agent to show. **Escape** closes the details.
- **Filter by project:** when the runs come from more than one project, a dropdown at the top shows **All projects**, or one project's runs (running and under Recent alike), or **Assistant and scripts** for runs that aren't a project's. Choose a project with several agents and a second dropdown narrows it to one agent. Each workspace remembers its choice, and the folded strip shows only those runs too, with a filter mark and how many there are in all.
- **When a run ends:** a passed one shows ✓ and the time it took for a few seconds, then fades into **Recent**. A failed one shows ✗ and stays until you've seen it (the panel open while you use Hive), then a few seconds more, and then goes to **Recent** too, marked red; the strip's and the taskbar's red clear as soon as you've seen it. A run that stops reporting for longer than expected says **Stopped reporting** (one whose agent stops says so), and goes the same way. **Dismiss** (✕) moves a failed or stopped one to Recent at once. Recent keeps the last 10.
- **The taskbar:** while runs are going, Hive's taskbar button fills with their combined progress (a moving bar for runs without steps), and turns red when one fails, until you look at the panel. So you can keep an eye on a long run from another app or with Hive minimised.
- **The Assistant** can see an agent's progress too, so you can ask it how long until an agent's tests finish.

Runs come from what agents run: a tool or script reports through the Agent API (`/v1/progress`, see the Agent API reference), as the agent that started it. **Settings → General → Progress panel** turns it all off; agents can still report, and Hive ignores it.

#### Show progress for any command

Any command can show in the panel by running it with **`hive-progress`** in front, for example `hive-progress -- npm test`. Agents do this by themselves for tests, builds and other commands they expect to take more than about 30 seconds, in the background too, so you see them without asking. To have them do it only when you ask, turn off **Settings → General → Agents show long commands in the Progress panel** (agents started or restarted afterwards follow it; with the Progress panel off, they don't use it either). The panel shows the command under the agent's name with the time it has taken and, from the second time, about how long is left (from how long the same command took before). The command's output and result are unchanged, and outside Hive it simply runs the command.

A command shows real steps when it prints lines like `##hive-progress step=4 total=12 name=carddialog`; any project's test runner can print them (see the Agent API reference). A total printed after a slow start still counts: the bar moves without steps until then, and shows them from then on. `hive-progress` is on the path of every session Hive starts, in Claude Code's and Codex's shells. A command that reports its own progress, such as Hive's own test runners, still shows as one row when an agent wraps it.

## Task board

The **Task Board** (in the activity bar, or **Ctrl+Shift+J**) is the workspace's list of work, as cards in six columns: **On Hold**, **Todo**, **Doing**, **Review**, **Passed** and **Done**. You, the Hive Assistant and the agents all use it, so it's where you can see at a glance what is planned, what is being worked on and what is waiting for you.

- **Cards.** Each has a number (#12), a title, a description (Markdown: what to do and how to tell it's done), a project, and optionally the agent working on it. Add labels, mark it **blocked** with a reason (it shows in red), list the cards it **depends on** and related ones, and comment. Its history shows who changed what and when: you, the Assistant, or an agent. **New Card** (or **Ctrl+Alt+T**) adds one. An open card can be moved out of the way, as any dialog can: drag it by its header (Escape while dragging puts it back; see [Moving dialogs](#moving-dialogs)).
- **The columns.** **On Hold** is for work you've parked: nobody picks it up until you move it to **Todo**, and only you and the Assistant put cards there (an agent that tries is told to ask you). **Todo** is ready to start, **Doing** is being worked on and **Review** is waiting for its review. A card that passes its review goes to **Passed**: reviewed, but not merged yet. **Done** means merged: the agent that built it moves it there once its branch is merged, or you do. A **blocked** card stays where it is, marked in red, in any column. Cards On Hold or in Passed are never called stalled.
- **Fold what you don't need.** The arrow in a column's header collapses it to a narrow strip with its name and how many cards it has; the other columns widen to fill the board, and a click on the strip (or Enter) opens it again. Drop a card on a strip and it goes to the top of that column. Each card has an arrow too, which folds it to one line: its number, its title, its agent's dot and any blocked or stalled marker; a folded card still opens with a click and drags like any other. A column's **⋯** (or right-click its header) has **Collapse All Cards** and **Expand All Cards**. Hive remembers which columns and cards you folded, for each workspace, after a restart too; a new card starts open.
- **Moving cards.** Drag a card to another column, or within one to reorder it, or right-click it for **Move to**. In a long column, hold the card near the top or bottom of the column and it scrolls until you can drop the card where you want, even at the very top or bottom. Moving a card into **Doing** from another column (dragging it, **Move to → Doing**, or changing **Column** in the card dialog and saving) asks who works on it: **Nobody yet** (it goes to Doing with no agent, also taking it from the agent it had), **Assign an agent** (any agent of its project, busy ones too; nothing is sent to it and nothing starts), or **Assign and start**, which starts the card as **Start…** does. The card's agent is the default. **Cancel** leaves the card where it was, with its agent; in the card dialog your other changes stay unsaved until you choose. Reordering within Doing doesn't ask. Ask the Assistant to move a card to Doing and it asks the same, unless you've said (*"have Claude start #12"*, *"assign #12 to Claude without starting it"*). A column's order is its priority, top first. Agents and the Assistant can put cards in order too: ask *"put the bugs at the top of Todo"* or *"prioritise Todo"* and the board changes as you watch; each card they move says so in its history. The order of Done stays yours. A Doing card shows what its agent is doing right now (working, waiting for you, finished…); a green edge means its agent has finished and the card is waiting for you to look. Nothing moves by itself: agents move their cards to Review when they're done.
- **What each agent is working on.** An agent with a card in Doing shows it as a small chip: `#4` on its tab in the agent strip, `#4` and the title in its pane header and in the Overviews' running lists (+1 when it has more). Click it to open the card. Hover the project in the sidebar to see each agent's card. The Sessions tab shows which cards a session **worked on**.
- **Colours.** Each column has its own colour (On Hold grey, Todo slate blue, Doing blue, Review purple, Passed teal, Done green) on its heading and as a light tint on its cards, so a card's colour shows where it is. Change them in **Settings → Board → Column colours**, or turn them off with **Colour columns**.
- **Each agent works on its project's cards.** An agent sees and changes only its own project's cards: another project's are for that project's agents, the Assistant and you. A card it adds is its project's, and a card linked to another project's shows that card's number only. The Assistant and your board see everything. Moving a card to another project takes it from its agent (its history says whose it was), so give it to one of the new project's agents afterwards; the card dialog does that for you when you change both. Ask an agent to *"check the latest comment on #65"* and it reads just that comment, not the whole card.
- **Review, Passed, then Done.** An agent you give a card to in its conversation (*"task #59 please"*) moves it to Doing when it starts, also when the card is back from Review, Passed or Done with more to do; when that work is done it goes to Review, even if it was in Done before. Agents move a card to Review when they finish its work; a reviewer moves it to Passed when it passes. Done means merged: an agent moves its cards there after merging its work, or when you ask (*"merged, move #65 to done"*); the Assistant too. Every move is in the card's history with who made it, and you can move a card back out of Done at any time, or ask an agent to. Putting Done in order, archiving and deleting stay yours. Archive a card when you no longer need to see it; deleting sends it to the Recycle Bin. **Archived (n)** in the board's toolbar shows the archived cards as a table, the most recently archived first: sort by any heading, filter by number, title, agent, project, label or the column a card was archived from, and choose how many rows a page shows. The board's search narrows it too. Click a row to open the card. **Unarchive** brings a card back to the end of the column it came from; tick several (or the box in the heading, for every card the filters show) and **Unarchive Selected** brings them all back. A card in Doing that nobody is working on (no agent has it, or its agent was removed or isn't running) shows as **stalled**, in amber, and the board's sidebar lists these under **Stalled**; start it again or move it back. An agent that moves a card into Doing takes it, so its card doesn't show as stalled: also one another agent had in Todo, Review, Passed or Done (the history says so), but not one already in Doing with someone else. When you remove an agent that still has open cards, Hive asks whether to move them back (Doing ones to Todo, with nobody) or leave them. The Assistant points out stalled cards when it looks at the board and suggests who could take them, but asks before changing anything. Cards in Done are archived for you after 14 days there; change that, or turn it off with 0, in **Settings → Board → Archive Done cards after**.
- **An agent reviews a card.** Ask an agent to review one (*"review #87"*): the card stays in **Review** with the agent that did the work, and shows **Reviewing: Codex** while it does (in amber if the reviewer has stopped or been removed). The reviewer's tab shows the card with an eye. Its verdict goes on the card as a comment. A card that passes goes to **Passed**; one that fails stays in Review for its fixes. One agent reviews a card at a time, and the review ends by itself if the reviewer stops or the card is moved. If the review finds things to fix, ask an agent to fix them: that is work on the card, which moves it to Doing.
- **Start.** **Start…** on a card gives it to an agent of its project, with the card as its prompt, and moves it to Doing. If you've changed the card, the button reads **Save and Start…**: your changes are saved first, so the agent gets the card as you see it. Choose an agent that is stopped (it starts a new conversation on the card) or idle (it gets the card as its next message), a new agent, or a new agent in its own worktree. The agent gets the card and Hive's **work-on-card** skill, which tells it to keep the card up to date and move it to Review when it's done. You can start a card in Review or Done again for more work: it moves to Doing, the agent is told it's back for more work and gets the card's latest comment (the feedback it came back with), and it goes to Review when that's done. Asked to have an agent act on review feedback, the Assistant does the same, with a note saying what to do.
- **Nothing is lost by closing.** Closing a card with unsaved changes or a half-written comment asks **Keep Editing** or **Discard**. **Save** saves the comment you're writing too.
- **One project.** The sidebar filters the board by project and lists the cards waiting for review; the badge on the activity bar counts them. Each project also has a **Tasks** tab with its own cards.
- **With the Assistant.** Ask it to plan work as cards, start them on agents and follow them: *"split the login rework into cards for web and start the first two"*. Agents can add cards for follow-up work they find instead of doing it unasked.

The cards are kept in `.hive/tasks`, one file each, so a workspace you commit shares its board.

### Card loops

Two agents can take a list of cards in turn, one building and one reviewing, without you passing each card between them. Tell one agent *"work through #111 to #117 as the builder"* and another *"review #111 to #117 as they come in"*. Both use Hive's **card-loop** skill. The builder does a card and moves it to Review. The reviewer reviews it and passes it, or sends it back with findings; the builder fixes them and moves it to Review again. When a card passes, the builder starts the next one.

A card sent back with findings stays in Review. The builder moves it to Doing while it fixes them, then back to Review; if it moves it to Review without it leaving, the card is **returned for review** all the same (*Returned for review, round 2* in its history) and the reviewer is woken. You can return such a card yourself: right-click it → **Move to → Review (next round)**.

- **Waiting costs nothing.** While one agent waits for the other, it isn't running: it ends its turn and Hive wakes it with a short line when the card changes (*"[Hive] #112 is in Review; latest comment by Codex…"*). The agent shows a blue ring in the sidebar and **Waiting for #112 → Review** in its pane header.
- **Cancel** in the pane header ends the wait (also **Cancel Card Watch** in the agent's **⋯** menu). Typing to the agent doesn't, and Hive doesn't wake it while you're typing there. A waiting agent takes no other work: the Assistant won't prompt it and **Start…** can't choose it.
- **How long it waits.** With no change for two hours, Hive wakes the agent, which tells you. Say *"wait: 4h"* for longer, up to a day.
- **Rounds.** A round is one build and its review: a card that passes its first review passed in round 1, and each fix with its review is another round. When the fifth round's review fails, the agents stop and ask you what to do, with a line per round. Say *"rounds: 10"* to allow more. A finding that comes back because a fix missed part of it doesn't stop them sooner: the reviewer marks it *recurring* and it is another round. A finding the builder disputes does: they stop and ask you.
- **Passed, then Done.** The reviewer moves a card that passes to **Passed**. Once the builder has merged its branch (when you ask it to, or have said it may), it moves its Passed cards to **Done**, which means merged.
- **Clear wake lines.** The line names the reviewer when a review passed or failed (*"#112 is in Review: Codex (hive) failed it"*). An agent waiting on **another agent's card** (one its own card depends on) is told whose card it is, and that Passed isn't merged: *"#111 (Claude's card) is in Passed: Codex (hive) passed it (Passed isn't merged)"*. Passed means the review passed; the work is merged when it reaches Done.
- **Cards reviewed together.** When two watched cards change at about the same moment (one passed, the other failed), the line names both. A change that lands just after an agent was woken still reaches it: its next wait counts what others changed since its last wake.
- **Closing Hive or stopping an agent** keeps its wait: resume the agent and it is woken if its card changed meanwhile. Hive asks first, as it does for a working agent, and says what it waits for. **Quit when agents finish** waits for a waiting agent only while the other agent is working on its card.
- **While it waits** you can still **Compact** it (it is woken once that's done). **Merge…** waits until it has finished, or until you cancel its wait.

## Hive Assistant

Each workspace has a **Hive Assistant**, its overseer, in a panel on the right. Show or hide it with **Ctrl+Alt+I**; hidden, it folds into a narrow **Hive Assistant** strip down the right edge, and clicking the strip opens it. Each workspace remembers whether it's open, and dragging its left edge makes it wider (double-click the edge for the default width). Hiding the panel doesn't stop the Assistant.

**On the left instead.** If Windows notifications or other apps cover the right of the screen, put the panel on the left: **View → Move Assistant Panel to the Left** (also in the command palette and the panel's **⋯** menu), or **Settings → Assistant → Panel side**. There it sits between the project list and your work, folds into its strip on that side and widens from its right edge. The choice is the same in every workspace and window, and Hive keeps it when it restarts.

Ask it anything about the workspace: what the agents are doing, what a project is, what changed, what things cost, or for a plan or a review. It reads any project's files and uses Hive's own tools to see projects, agents, usage, shared notes and handovers. It doesn't edit project files itself: the agents do the work. What else it may do, from only advising to running agents and creating projects, is up to you (see **What the Assistant may do** below).

**The panel.** At the top: the Assistant's status, its persona (click to switch), Compact and Stop while it runs; when it doesn't, **Resume** (|▷) to go back to its last conversation and New conversation, or Start if there is nothing to resume (in **⋯** when the panel is narrow, apart from Resume), and **⋯** (New Conversation while it runs or Resume when it doesn't, Resume a Conversation…, All Conversations…, Assistant Settings…, Manage Personas…). Under it, the workspace at a glance: agents waiting for you (or in trouble) first, then your active projects, each with its agents listed under it, and clicking one takes you there. Inactive projects fold into one row at the end; click it to show them. Drag the line under it to give it more or less room. Then the Assistant's terminal, and a footer with its model and effort, permission mode, context and cost, as agents have. While it isn't running, the panel offers **Start Assistant**, **Resume** and its past conversations. While the panel is hidden, the strip shows a dot for what the Assistant is doing.

It doesn't use one of a project's agent slots, and it runs in the workspace folder. Closing the workspace or the window, or quitting, stops it like any agent (the dialogs call it "Assistant"), and its conversations can be resumed.

### What the Assistant may do

**Settings → Assistant → Control** decides, for every workspace:

- **Look and advise**: it reads and suggests; you act.
- **Control agents**: when you ask it, it also adds agents, changes their settings, starts and stops them, gives idle ones tasks, hands one agent's work over to another, and adds, changes and starts cards on the task board. Ask *"add two agents to web: one to fix the login tests, one to update the docs"*, or *"ask Codex to review hive, then hand its findings over to Claude to fix"*, and it does.
- **Control agents and create projects** (the default): also new projects.

It never removes agents, discards worktrees, archives or deletes cards, or removes projects, and never edits project files itself: the agents do the work. It won't type into an agent that is working, asking you something, or that you have just typed in: for 15 seconds after your last key, unless that key was Enter (**Settings → Assistant → Pause after you type** and **Enter ends the pause**). Before it stops an agent in the middle of something, or moves a card to Done, a card at the top of its panel asks you (**Stop** or **Don't stop**, **Move it** or **Leave it**). It makes at most 30 changes for each message you send, and everything it does is listed under **Done by the Assistant** in its panel. Your view never moves: an agent it adds on the project you're looking at shows a dot on its page's button, and another project opens on the new agent's page the next time you go to it.

When an agent's CLI asks whether to trust a new folder before it starts, the agent shows as **waiting** for you: answer in its terminal.

### The Assistant view

The **Hive Assistant** button in the activity bar (the robot) opens everything else about it. At the top, **Used so far**: its conversations, prompts, tokens and API-equivalent cost, for Today, 7 days, 30 days or All time. These aren't counted in any project's Overview. Below that:

- **Personas** lists its personas (below).
- **All Conversations** shows every conversation you've had with it, in the same tree as a project's **Sessions** tab (by provider, with any sessions a conversation started under it). Search them, read any in full, export, rename, archive, delete or resume one, or archive or delete a whole branch. **Show** on the running conversation opens the panel.
- **All Images** shows the screenshots and images you've pasted or dropped into its conversations, grouped by conversation, newest first, like a project's **Images** tab. Click one to view it, or right-click it to copy, open or reveal it. Click a conversation's name to read it. The bin next to it moves all of that conversation's images to the Recycle Bin (none if another program has one open). Images of a conversation that is running can't be deleted until it stops.

The panel's **⋯** menu opens the same view with **All Conversations…** or **Manage Personas…**; the command palette has **Show Assistant Conversations**, **Show Assistant Personas** and **Show Assistant Images**.

### Personas

A **persona** is who the Assistant is: its role and its character, written as instructions in a Markdown file in the workspace's `.hive/personas` folder. Hive comes with four, each with a serious job and a character to match:

- 🗼 **Overseer** (the default): a lighthouse keeper who keeps a watch log of the workspace. Projects are ships, and an agent waiting for you is signalling.
- 🎩 **Planner**: plans every task like a heist, with the job, the crew, the vault and always the getaway.
- 🦎 **Reviewer**: reviews code like a hushed wildlife documentary narrator, with real findings ranked by severity.
- 🛫 **Orchestrator**: coordinates the agents like an air traffic controller, sequencing who goes first and who holds.

Whatever the character, they speak plainly about errors, security and anything you must decide. A persona is a character and a focus: what the Assistant may do is **Settings → Assistant → Control**, whatever a persona says, and how it runs agents and cards comes from Hive's own skills. Hive keeps its own personas up to date in each workspace as it does its skills (below): one you've edited stays as you wrote it.

The **Personas** section of the Assistant view (below) lists them. Click one to read or edit it, **+** to write your own, and the bin (on hover, or at the top of an open one) to delete one. Hive's own come back with **Restore** or **Revert to Default**. **Use in This Workspace** makes one the Assistant's. Switching persona while the Assistant is running asks first, because it starts a new conversation. A conversation keeps the persona it started with.

### Assistant settings

**Settings → Assistant** sets the defaults for every workspace:

- The provider (Claude Code or Codex, whatever your agents use).
- The default persona.
- **Highlight Compact over**: the context size at which the Assistant's **Compact** button and the context in its footer turn orange, as an agent's do past **Settings → Sessions → Suggest compacting above**. It's 500,000 tokens by default, higher than your agents' 200,000, since the Assistant usually works with a bigger context; **Never** turns it off.
- For each provider: its model, effort, permission mode, extra arguments and, for Claude Code, **Use 200K context (instead of 1M)**.

It uses the same model and effort as your agents (each provider's defaults in Settings), since a lighter model or low effort makes it careless: it may say it will check on an agent later and never do. Its mode, like your agents', approves safe actions itself and only asks about risky ones: **Auto** for Claude Code and **Approve for me** for Codex. Claude Code says which models it runs in Auto, for your version and account (currently not **Haiku**), and the settings warn you when you pick a model without it in Auto, for the Assistant or an agent: the session then runs in Manual instead (asking before edits and commands), and Hive shows that mode. **Assistant Settings** in the panel changes any of them for one workspace. Changing its provider or persona restarts it, after asking.

## Skills

Skills are instructions an agent loads when they're relevant. There are no switches: every skill an agent can see is always available to it. Hive shows where each one comes from:

| Level | Where | Who gets it | In Hive |
|---|---|---|---|
| **Hive** | `Workspace/.hive/skills/<name>/SKILL.md` | Its audience: the project agents (every agent in every project, of every provider; the default), the Hive Assistant, or both | Add, edit and delete in the **Skills** view |
| **Local (User Managed)** | `Project/.claude/skills` (Claude Code), `Project/.agents/skills` (Codex) | That provider's agents, in that project | Add, edit and delete in the project's **Skills** tab |
| **User** | `~/.claude/skills` (Claude Code), `~/.codex/skills` (Codex) | That provider's agents, everywhere | View only |
| **Plugin** | Claude Code plugins you've installed | Claude Code agents, everywhere | View only |

**The Skills view** (the sparkle in the activity bar) lists the workspace's Hive skills. **+** creates one from a starter `SKILL.md`; **Add Skill from File** adds a `.md` (it becomes the skill's `SKILL.md`) or a `.zip` (unpacked as the skill's folder: use a zip for a skill with scripts or other files). Select a skill to read it; **Edit** changes it, and the bin deletes it (to the Recycle Bin). A warning over the list, and over a Hive skill while you edit it, reminds you that editing these skills may change how agents behave in Hive: they're instructions every agent (or the Assistant) follows.

**A project's Skills tab** lists everything its agents get: the Hive skills first (those for the Hive Assistant alone aren't listed; a note under them says how many there are), then one provider's local skills, your user skills and plugin skills, folded under its name: click it to open them. Pick the provider from the dropdown above them: it starts on the project's default provider. Hive remembers, for each project, the provider you last picked and which groups you left open or folded. Hive skills are shared by every project, so their **Edit in workspace** button takes you to the Skills view to edit them there. Local skills belong to the project: add (with **+** or from a `.md` or `.zip`), edit and delete them right there. When both Claude Code and Codex are on, adding a local skill offers to add it for the other provider too, since each reads its own folder. **Copy to workspace** turns a local or user skill into a Hive skill: the project agents in every project get it, unless its header names another audience (the notification says who).

**Skills that come with Hive.** Hive gives every workspace its own skills for working with Hive:

- for agents: `work-on-card` (carry a card from Doing to Review), `review-agent-work` (review another agent's work without changing it, marking the card), `merge-ready` (get a branch ready to review and merge) and `use-hive-api` (scripts that call Hive's Agent API);
- for the Hive Assistant: `coordinate-agents` (plan work as cards, brief and start agents, follow them);
- for both: `handover` (wrap up for a later session), `pick-up` (carry on from a handover, checking it against the current state), `split-work` (plan how several agents can share a task) and `workspace-note` (record a decision or convention in the shared notes).

They're ordinary Hive skills: edit or delete them as you like. **Hive keeps them up to date**: when a new version of Hive improves one, a copy you haven't changed is updated when the workspace next opens, and a skill new in that version is added. If you edit, delete or replace one while Hive is updating it, your version stays and the update waits for the next time (if Hive was interrupted mid-update, anything of yours it had set aside is kept beside the skill as `<name>-conflict-<date>`). A copy you've edited is left as you wrote it: its page offers **Revert to default** (with **Update available** when Hive has a newer version than the one you edited). A skill you've deleted stays deleted: it's listed greyed out, with **Restore**. Revert and Restore send your copy to the Recycle Bin.

**Who gets a skill.** Each Hive skill's page shows who gets it: **Project agents**, **Assistant** or **Agents + Assistant** (in the list, the last two are marked). Your own Hive skills go to the project agents. If a skill's header can't be read, or its audience is misspelt, nobody gets it until you fix it: it's marked **Not given**, with the reason on hover. To write one for the Assistant, add `audience: assistant` (or `all`, for both) under `metadata:` in its `SKILL.md`'s header:

```yaml
---
name: weekly-report
description: Summarise the week's cards and agents for the user. Use when asked for a weekly report.
metadata:
  audience: assistant
---
```

When a session starts, Hive copies the Hive skills into the agent's own launch folder in the project's `.hive` and points Claude Code at it (Claude Code shows them as `hive:<name>`), so a running Claude Code agent keeps the version it started with. Codex only reads skills from the folder it works in (`.agents/skills`), so for Codex agents Hive copies them there as `hive-<name>` folders (and keeps them out of git); those copies aren't listed as local skills. Codex agents sharing a folder share those copies, so after one starts with a changed skill, the others use the new version too. Either way, a restarted session has the current skills.

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

Every session also gets Hive's own MCP server, which lets agents list projects, read and write shared notes, write handovers, read and update the task board, and notify you. Try: *"Write a handover for the next session using the hive tools."* A new session is told about these tools and about the project's latest handover, so *"read the handover"* is enough to pick up where the last session stopped. See the [Agent API reference](AGENT_API.md).

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

The **Images** tab shows every screenshot and image pasted or dropped into the project's sessions, grouped by session (newest first), with archived sessions at the bottom. Click one to view it large and use ← / → to move between them. From the viewer or the right-click menu you can **Insert into Session**, **Copy Image**, **Copy Path**, **Reveal** it, or **Delete** it (to the Recycle Bin). Click a session's name to read its transcript, or its bin to move all of its images to the Recycle Bin at once. A running session's images can't be deleted until it stops: **Delete** is greyed out (in the viewer too; hover it to see why). You can also drag a thumbnail onto the **Session** tab.

## Changes

The **Changes** tab lists files changed in the project's git working tree and shows each one as a side-by-side diff against the last commit — a quick way to review what the agent did.

Hive checks your projects' git status in the background (this tab, branch status, the Files tab's dimmed entries) without writing to the repository's index, so your own `git add` or `git commit`, or an agent's, never fails with *"index.lock: File exists"* because of it. Hive's own git actions, such as **Merge**, still update it as git does. If git is busy when the Files tab lists a folder, ignored entries keep their dimming and the folder is listed again a moment later.

## Project settings

Each project can override the global defaults in its **Settings** tab, which has the same categories and search as Settings:

| Category | Setting | What it does |
|---|---|---|
| Providers | Default provider | The provider new agents in this project use |
| Claude Code, Codex | | One page per provider, with the settings below for that provider's agents |
| Claude Code | Model | The models Claude Code reports (aliases such as Opus, Fable, Sonnet and Haiku always follow the newest in that family; pinned versions such as Opus 4.8 stay put), or a custom model ID. Without Claude Code's answer, the fallback list in Settings → Claude Code. Current models have the 1M-token context window already; for Opus 4.6 or Sonnet 4.6 with 1M, type a custom model ID such as `claude-opus-4-6[1m]`. The same choice is in Settings → Claude Code → Default model. |
| | Effort | Reasoning effort, from the levels the chosen model takes (see [Models, effort levels and prices](#models-effort-levels-and-prices)) |
| | Use 200K context (instead of 1M) | Claude Code only: Inherit, On or Off. On holds this project's agents to a 200K context window |
| | Permission mode | How much the agent asks before acting (below) |
| | Extra arguments | Additional command-line arguments for the CLI |
| Sessions | Suggest compacting above | When the Compact button turns orange (see [Sessions](#sessions)) |
| | Warn when a transcript is over | When a conversation's transcript size turns amber |
| | Completion chime | On, off or inherit |
| Agents & Worktrees | Agents, file locks, copy into new worktrees, setup command | See [Several agents in one project](#several-agents-in-one-project) |
| Keyboard Shortcuts | | Shortcuts for project and session commands in this project (see [Keyboard shortcuts](#keyboard-shortcuts)) |

**Number settings**, here and in Settings, save when you press Enter or click away. An empty box inherits the global value here; in Settings it just puts the saved value back. A number out of range, or text that isn't a number, isn't saved: the range shows under the box. Settings that can be turned off have a **Never** (or **No pause**) checkbox beside the number; untick it to get your last number back.

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

In **Approve for me**, Codex's reviewer decides on risky actions itself: while it does, the agent stays **Working…** with a small shield beside its status (hover it to see what's being checked), and Hive doesn't ask for you. Hive tells you an agent needs you only when Codex actually puts a question or an approval to you.

### Codex's Windows sandbox

On Windows, Codex runs commands in a sandbox, which it sets up once. **Help → Agent Setup… → Codex → Set up** opens Codex's setup, which offers two choices. With either, Codex agents in **Ask for approval** or **Approve for me** edit files in their own folder (the project, or the agent's worktree) and run commands there without asking, and ask before going online or writing anywhere else. Hive's own features (status, file locks, handovers, shared notes) work the same with both.

- **Set up default sandbox** (recommended): commands run under two local Windows accounts that Codex creates for them (`CodexSandboxOffline` and `CodexSandboxOnline`), with a firewall rule that keeps them offline unless you allow it. It isolates commands best. Windows asks for Administrator permission once.
- **Use non-admin sandbox**: needs no Administrator permission. Commands run under your own account with restricted rights. It protects your files and blocks internet access in most cases, but Codex warns it carries more risk if the agent is tricked by instructions hidden in a file or web page it reads (prompt injection).

Once Codex has set the sandbox up, Hive closes it and Agent Setup says so. With the non-admin sandbox, Agent Setup shows **Upgrade** to switch to the default one later. Codex agents that are running keep their sandbox until they restart. **Full access** doesn't use the sandbox at all.

**Full access** is like Bypass: it only appears after you tick **Settings → Codex → Enable the Full access option**, and projects using it show a red warning. Codex's **Plan** mode is separate from the preset: choose **Plan** in the mode menu (or press Shift+Tab in the terminal), and the badge shows "· Plan". In Codex's sandbox the `.git` folder is read-only, so Codex asks before committing.

**Switching mode while an agent runs.** The mode badge in each agent's footer shows the mode its session is really in. Click it, or press **Ctrl+Alt+M**, and choose another: Hive switches it straight away, without a restart, the same way pressing **Shift+Tab** in the terminal does (which Hive also notices). Don't ask and Bypass permissions can't be reached that way, so choosing them restarts the session in that mode and carries on the same conversation. For Codex, Hive picks the preset from Codex's `/permissions` menu. The switch applies to that session only; the settings decide what new sessions start in. When you change the setting while agents are running, Hive offers to **Switch Now**. This works with `NO_COLOR` set too (Claude Code then shows its footer without colours): Hive reads the mode as it appears on the terminal's screen and leaves your `NO_COLOR` preference as it is.

## Updating Hive

Hive keeps itself up to date from its GitHub releases. By default it checks shortly after starting and every six hours, downloads a new version in the background, and installs it the next time you quit Hive — it never restarts on its own, so your agents are never interrupted.

- While a new version downloads, the status bar shows the progress; when it's ready it says **Restart to update to X.Y.Z**. Click it to see what's new.
- **Restart and Update** (in that dialog, the notification or the tray menu) closes Hive, installs the update and opens Hive again. If agents are working, Hive asks first, and you can let them finish. Stopped sessions can be resumed as usual.
- **Skip This Version** stops Hive offering that version; the next one is offered as normal.
- **Help → Check for Updates…** checks straight away and tells you the result.
- **Settings → Updates** turns automatic checks and downloads off, chooses whether updates install **automatically when Hive quits** or **only when you choose Restart and Update**, and can include pre-release (beta) versions.

Updates are checked against their published checksum before they install.

## Notifications

When an agent finishes (for one waiting on background tasks, once they have ended) or needs input, Hive plays a chime and tells you: with a **banner in Hive** while you're using it, and with a **Windows notification** when Hive is in the background. Click either to jump to the project. Configure them in **Settings → Notifications**; each project can override the chime.

Agents that finish together don't flood you: they chime once, and get one notice (**3 agents finished in hive**: *Claude, Codex, Agent 3*, or across projects *hive (2), web (1)*), shown a few seconds after the last of them. If you turn notifications off meanwhile, it isn't shown. An agent asking for your input is always told at once, on its own.

### Banners in Hive

Windows notifications always appear at the bottom right of the screen, over the Assistant's panel where you type, so while any Hive window is focused Hive shows its own **banner** in that window instead:

- **Where:** at the top centre, or wherever **Banner position** puts it (any corner, or the middle of the top or bottom edge). Several stack, the newest nearest the edge.
- **How long:** a banner for an agent that finished goes after **6 seconds** (it stays while the pointer is on it). One for an agent **waiting for you** stays until you click it, dismiss it (×), or answer the agent, wherever you answer it. **Banners for an agent waiting for you stay until handled** can make them close like the others.
- **Click** a banner to go to its project, in whichever window has it. From the keyboard, **Tab** to its text and press **Enter** (or Space) to go there, or Tab on to **×** to dismiss it; a banner stays while it has the focus, as it does under the pointer.
- **Show banners for:** *All workspaces* (the default: the window you're in shows notices from every Hive window, and clicking one brings up that window), *This workspace*, or *This project* (the project the window shows). A notice it leaves out shows nothing at all, but it still counts in its own window's **Agents that need you** list and taskbar button.
- **While Hive is focused:** *Show in Hive* (the default), *Show nothing*, or *Windows notification* (a Windows notification even while you use Hive, as before).

With no Hive window focused, you get Windows notifications as always. Plan usage warnings show in Hive as before, and as a Windows notification only when Hive is in the background. The chime, the taskbar count and the taskbar flash work the same either way.

Hive's own messages (warnings, what an action did) are kept in the **Notifications** panel: the bell at the bottom of the activity bar, or **Ctrl+Alt+U**. While some are unread the bell shows a dot and turns orange; opening the panel marks them read.

### Agents that need you

With agents working in several projects, the status bar tells you who is waiting on you: **2 need you**. Click it for the list, oldest first, with how long each has been waiting:

- **Needs input**: an agent waiting for your answer, such as a permission. It stays in the list until you answer it.
- **Asks**: an agent that asked you a question but carries on working meanwhile (Codex can). Its pane says **has a question for you**, and it stays in the list until you answer the question in its terminal.
- **Finished**: an agent that finished while you weren't looking at it: in another project, on another page of agents, on another tab, or while Hive was in the background. It leaves the list once its pane is on screen.

Click a row to go to that agent (the Assistant's opens its panel). The **Projects** icon in the activity bar shows the same number, and each project in the sidebar shows how many of its agents need you.

With Hive behind other windows, its **taskbar button** shows the count too: a red badge over the icon, and the number before the window's title (in Alt+Tab and when you hover the button). When an agent comes to ask you something while Hive is in the background, the button flashes until you switch to it. Turn either off in **Settings → Notifications** (turning the flash off also stops one that has started).

Below them, **To review** lists worktree agents that have stopped or finished with work not merged yet, with a summary such as *3 files, +120 −40 · 2 commits*, and buttons for **Changes** and **Merge…**. They don't add to the count; one leaves the list once its work is merged or it starts working again. When nothing needs you but there is work to review, the status bar says **1 to review**.

### Sleep and shutdown

Agents work while you're away from the keyboard, so Hive keeps Windows from **sleeping** while any agent is working or waiting on background tasks, and lets it sleep again as soon as none is. The screen can still turn off and lock. The status bar says **Keeping the PC awake: 2 agents working** while it does. **Settings → General → Keep the PC awake while agents work** chooses *When plugged in* (the default: on a laptop's battery, it may sleep), *Always, on battery too* or *Never*.

When Windows shuts down, restarts or signs you out, Hive backs up the agents' transcripts first, in the moment Windows gives it, without holding up the shutdown. After the PC wakes from sleep, Hive reads each agent's state and plan usage again.

## The system tray

Closing the (last) window keeps Hive running in the tray so sessions continue. The tray icon shows a red dot when an agent needs you. Its menu lists the agents that need you and those with work to review, from every window (click one to go to it), then your active projects, grouped by workspace when several windows are open. Quit from the tray menu or **File → Exit**.

### Quitting

Quitting stops every running session, in every window. Nothing is lost: each conversation is kept and you can resume it next time. So Hive only asks first when an agent is **in the middle of something** (working, waiting for your answer, or waiting on background tasks it started). Otherwise it just closes and a notification tells you which sessions to resume.

When it asks, you see each session and what it's doing, and can choose:

- **Quit now**: stop everything straight away.
- **Quit when agents finish**: Hive hides and quits by itself once no agent is working or waiting on background tasks. Until then the tray menu has **Quit Now** and **Cancel Pending Quit**, and opening the window shows a banner with the same choices.
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
| Close window | Ctrl+Shift+W |
| New session / resume / stop | Ctrl+Shift+N / Ctrl+Shift+R / Ctrl+Shift+X |
| Compact the conversation | Ctrl+Alt+C |
| Switch permission mode | Ctrl+Alt+M (Shift+Tab inside the terminal) |
| Add agent | Ctrl+Alt+Shift+N |
| Focus agent 1–9 / next / previous | Ctrl+1 … Ctrl+9 / Ctrl+Alt+] / Ctrl+Alt+[ |
| Layout: one at a time, two columns, three columns, grid of four, grid of six | Ctrl+Alt+1 … Ctrl+Alt+5 |
| Next / previous agent page | Ctrl+Alt+PageDown / Ctrl+Alt+PageUp |
| Focus the session terminal | Ctrl+` |
| Next / previous project | Ctrl+PageDown / Ctrl+PageUp |
| Project tabs | Alt+1 … Alt+9, Alt+0 (Session, Overview, Sessions, Files, Images, Changes, Memory, Skills, MCP, Settings; Tasks has none, but you can give it one); Ctrl+Tab / Ctrl+Shift+Tab for the next / previous tab |
| Task board / new card | Ctrl+Shift+J / Ctrl+Alt+T |
| Workspace Overview | Ctrl+Shift+O |
| Toggle sidebar | Ctrl+B (outside the terminal) |
| Compact / expand the project list | Ctrl+Alt+B |
| Notifications | Ctrl+Alt+U |
| Show / hide the Hive Assistant | Ctrl+Alt+I |
| Show / fold the Progress panel | Ctrl+Alt+P |
| External terminal in the project | Ctrl+Shift+` |
| Documentation | F1 |

In the terminal, Ctrl+C copies when text is selected (otherwise it interrupts the agent) and Ctrl+V pastes. Right-click copies or pastes text. See **Help → Keyboard Shortcuts** for the full list.

**Changing shortcuts.** **Settings → Keyboard Shortcuts** lists every command. Click the pencil (or double-click a shortcut) and press the keys you want; press a second combination straight after for a chord such as Ctrl+K Ctrl+S. You can remove a shortcut, reset one, or reset them all. Hive warns when a shortcut is already used, and won't take keys you need for typing and editing (a key without Ctrl or Alt, Ctrl+C/V/X/A/Z/Y, Shift+Tab). A project can have its own shortcuts for project and session commands in **Project Settings → Keyboard Shortcuts**; they apply while that project is selected.

**Open a file from the terminal.** File paths an agent prints, like `src/main/app.ts:42`, are links: hover one to see it underlined, and **Ctrl+click** it to open the file in the project's [Files](#files) tab with the cursor on that line. A worktree agent's paths open in its worktree, and a path into another project in the workspace opens in that project. Only files that exist are linked; a plain click still just selects text. Paths with spaces are linked too, most reliably when they're in quotes (`"docs/my notes.md"`).

**Screenshots and files.** With a screenshot on the clipboard (for example from Win+Shift+S), press **Ctrl+V** in a session: Hive saves the image in the project's `.hive/images` folder and pastes its path, and Claude Code attaches it as `[Image #1]`. You can also **drag files** from Explorer onto the terminal to paste their paths; images are copied into `.hive/images` first. The images are kept per session, so you can always see what was sent (see [Images](#images)).

## Troubleshooting

- **"… was damaged and has been restored"** — one of Hive's settings or record files couldn't be read (for example after a hand edit). Hive went back to its last good copy (`.bak`) and kept the damaged file next to it as `.corrupt-<date>`.
- **"Claude Code is required" / "Codex is required"** — install the CLI from **Help → Agent Setup…**, or set its path in the provider's settings page. Having the VS Code extension isn't enough; Hive needs the standalone CLI.
- **"… is turned off"** — turn the provider on in **Settings → Providers**.
- **Codex asks before every command** — its Windows sandbox isn't set up: **Help → Agent Setup… → Codex → Set up**.
- **An agent couldn't start** — when its CLI quits before it has started (a setting it refuses, a broken install), the bar under its terminal turns red with **Couldn't start:** and what the CLI said, a hint where Hive recognises the problem, **Retry** and **Agent Settings…** (or **Agent Setup…**). Its tab and header turn red, the attention inbox lists it, and if its pane isn't on screen a notification says so. Fix the setting, then Retry; the terminal above keeps everything the CLI printed.
- **Status dots don't change** — status comes from the CLI's hooks. A Codex agent shows **Ready** once its prompt appears, and reports its session with your first message. Restart the session; if it persists, check **Help → Open Logs Folder**.
- **Agent API port in use** — change the port in Settings → Agent API.
- **"Hive's window stopped and was reloaded"** — the window's page crashed (memory, a graphics driver, a bug). Your agents run outside it, so they kept going: Hive reloaded the window, which reconnects to their terminals as **View → Reload** does. Unsaved edits in the Files tab are lost, and the note says how many. If it crashes again within a minute, Hive asks instead: **Reload**, **Open Logs** or **Quit Hive**. If the window stops responding, after a few seconds Hive offers **Wait** or **Reload**, and the question goes away if the window recovers.
- **"This tab ran into a problem"** — something in that view failed, for example on an unusual file. Your sessions keep running. Click **Try Again** or switch to another tab; if it keeps happening, **Open Logs** has the details for a bug report.
- **Reporting a bug** — **Help → Copy Diagnostics…** shows a summary for a bug report: Hive's and Windows' versions, your coding agents, counts of projects and agents, the settings that change how Hive behaves and the last 50 lines of its log. Your folders, workspace, project and agent names (also those of workspaces you opened before), card titles, what you asked agents to do, and anything that looks like a key or token are taken out, and the dialog shows exactly what will be copied. Click **Copy** and paste it into the report.
- **Where is my data?** — app settings in `%APPDATA%\Hive`, workspace data in `Workspace/.hive`, project data in `Project/.hive`.
- **How many sessions can run?** — as many as your machine can handle, across any number of projects. Each is a CLI process; Hive only draws the terminals you can see with the graphics card, so dozens of background sessions don't slow the window down.

## Licence

Hive is open source under the [MIT License](../LICENSE). It includes open-source libraries (xterm.js, Monaco, React and others) under their own permissive licences, listed with their full texts in [Third-Party Notices](../THIRD_PARTY_NOTICES.md); both are in the Docs view and linked from **Help → About Hive**. Electron's and Chromium's licences are in the folder Hive is installed in (`LICENSES.chromium.html`). Claude and Claude Code are products of Anthropic, and Codex and ChatGPT products of OpenAI, installed separately under their makers' terms; the provider logos are their owners' trademarks, used to identify their products. Hive is not affiliated with Anthropic or OpenAI.
