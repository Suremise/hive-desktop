# Release Notes

## Unreleased

### Sessions
- **Long transcripts are flagged sooner: at 20 MB instead of 50 MB.** Well before 50 MB a long conversation slows down the coding agent and Hive. If you kept the old 50 MB default, it moves to 20 MB; a size you chose yourself, **Never** and project settings are kept. To go back, set **Settings → Sessions → Warn when a transcript is over** to 50.

### Task board
- **Agents keep to their own project's cards.** An agent can see and change only its project's cards on the board: another project's cards are for that project's agents, the Assistant and you. Before, an agent in one project could list, read, comment on and move any card in the workspace. An agent also can't read or type into another project's agents' conversations any more, where those cards appear as their tasks. Each agent now calls Hive with a token of its own, so it can't get round this by saying it is someone else. The Assistant and your board still see everything.
- **Moving a card to another project takes it from its agent**, and its history says whose it was. Give it to one of the new project's agents afterwards (the card dialog does this when you change both).
- **"Check the latest comment"**: agents can read just a card's newest comment instead of the whole card, which keeps long cards from filling their context.
- **Agents move a card to Doing when they start on it.** Hand an agent a card in its conversation (*"task #59 please"*) and it moves the card to Doing before it starts, then to Review when it's done. This includes a card back from Review with follow-up work, which before stayed in Review while the agent changed it. (**Start…** on the board already moved cards to Doing.)
- **Agents can move cards to Done.** Ask an agent *"looks good, move #65 to done"* and it does; the Assistant can too. Agents still move finished work to Review by default, for you to check. Every move is in the card's history with who made it, and a card can be moved back out of Done from the board or by asking. Before, only you could move cards into or out of Done.

### Fixes
- When several agents finished together, their notification came a few seconds later even if you had turned notifications off or come back to Hive's window meanwhile. It is now left out then; with agents in two windows, only those whose window you aren't looking at are told.
- After **Compact**, an agent you had already given a new message could show as **Ready** while it worked on it, when the coding agent didn't report the compaction's end and Hive noticed it later. A new message after a compaction now counts as the compaction being over, and the agent stays **working**.
- **Task board**: a card's number (#79) was hard to read, in faint grey on the card. It now has the same contrast as the rest of the card's text, in both themes and with column colours.
- In a narrow agent pane, **Merge…**'s count spilled out of its button over its neighbour, and a long agent name, branch or card pushed the header's buttons (even ⋯) off its edge. The buttons now always fit: a count widens its button, and the agent's details shorten instead (hover for the full text).
- **Compact**'s spinner in the agent header stood still while the conversation compacted. It now turns until the compaction has finished, in the Assistant's header too.
- In the compact Projects sidebar, a project's count of agents needing you was cut off at the top of the first tile (and at the side at larger zoom), and could cover the status dot of the project above. The badges and dots now always show in full.
- **Codex agents said they needed you while they were still working.** In **Approve for me**, every action Codex's own reviewer was checking showed the agent as waiting for your input, with a chime and a notification, though nobody had asked you anything; a rejected action could leave it showing as waiting until its turn ended. Hive now goes by Codex itself: an agent needs you only while Codex actually shows you an approval or a question. A question Codex asks while it carries on working shows as **has a question for you**, and is in the list of agents that need you until you answer it.
- **File links in the terminal**: a path printed in different case from the file (`SRC/APP.TS`) opened the Files tab without selecting the file or showing its line. Paths with spaces (quoted, or like `C:/ws/my app/src/app.ts`) and names with brackets (`app/[slug]/page.tsx`) are now links too, and a piece of a longer path no longer links to some other file.
- Changing a number setting and then ticking **Never** straight away could leave the number saved and Never unticked, mostly in Project Settings. A number box now saves one change at a time, and your last choice wins.
- **Help → Copy Diagnostics…** left some of your own text in the log lines it copied: card titles, what the Hive Assistant did, session names, and the names and folders of workspaces you had opened before. Hive now marks your text as it writes its log and the report leaves it out, including what an agent was started with; lines an older version wrote show only their time and source, and folders that aren't Hive's or the coding agents' own are hidden. The report also says which Windows sandbox Codex uses.

## 0.3.1 — 2 October 2026

### Fixes
- **Remove Project** refused a project whose agent worktree was saved under a short Windows folder name (such as `C:\Users\JOHNSM~1\…`), saying git didn't list it as one of the project's worktrees. **Add Agent → existing worktree** had the same problem. Paths are now compared by their real, full name.

## 0.3.0 — 2 October 2026

### Agent footer
- **Context as a percentage of the window**: the footer shows *84k · 42%* once the CLI has reported the session's context window, so you can see how close it is to needing Compact whether the model has 200K or 1M. In a narrow pane only the percentage shows; the tooltip has both numbers.

### Notifications
- **The taskbar button shows when agents need you**: a badge with the count over Hive's icon, the count before the window title (Alt+Tab), and a flash when an agent starts waiting for your answer while Hive is in the background. Each window shows its own workspace. Both can be turned off in **Settings → Notifications**.
- **Agents finishing together chime once and get one notification**: "3 agents finished in hive" naming them, or "3 agents finished" with how many in each project, instead of a chime and a pop-up each. An agent asking for your input is still told at once, on its own.

### Sleep and shutdown
- **The PC stays awake while agents work.** A PC set to sleep after a while idle no longer sleeps mid-task because nobody touched the keyboard; once no agent is working it may sleep again (the screen can still turn off and lock). The status bar says so while it lasts. **Settings → General → Keep the PC awake while agents work**: *When plugged in* (default), *Always* or *Never*.
- **Windows shutting down, restarting or signing you out** no longer loses the end of a transcript: Hive backs them up first, without holding up the shutdown.
- **After sleep**, agents' states and plan usage are read again straight away.

### When Hive's window crashes
- **A crashed window reloads by itself**, and says your agents kept running (they run outside the window, so they always did). Before, the window just went blank, and quitting Hive to fix it stopped the agents. If it crashes again within a minute, Hive asks: **Reload**, **Open Logs** or **Quit Hive**.
- **A window that stops responding** gets **Wait** or **Reload** after a few seconds; the question goes away if it recovers.

### Bug reports
- **Help → Copy Diagnostics…** gathers what a bug report needs (Hive's and Windows' versions, your coding agents and whether they're signed in, counts, the settings that change how Hive behaves, and the end of Hive's log) and shows it before copying. Folders, names, keys and tokens are taken out.

### Terminal
- **Ctrl+click a file path to open it.** File paths in an agent's or the Assistant's terminal (`src/app.ts`, `tests/x.test.ts:42:7`, stack traces) are links: Ctrl+click opens the file in the project's Files tab with the cursor on that line, in the agent's worktree for a worktree agent, or in another project of the workspace when the path leads there. Only files that exist are underlined.

### Tips
- **A tip when Hive starts**: once a day, a small card in the bottom-right corner shows something Hive can do, with **Try it**, **Learn more** (the user guide at that section) and **Next tip**. It never gets in the way, and steps aside while you type in a terminal under it.
- **Tips at the right moment**, once each: the first time a transcript turns amber, the context passes your Compact threshold, you add a second agent or you paste a screenshot. Tips about things you already do are skipped.
- **Help → Tips…** lists them all, grouped and searchable. **Don't show tips** on the card, or **Settings → General → Show a tip when Hive starts**, turns them off.

### Agent header
- **Archive & New** moved from the agent header into its **⋯** menu, as **Archive and Start New…**, leaving more room for the agent's name, card and session.
- **Compact** and **Stop** are small icon buttons, like the Assistant's (hover for what they do).
- **The session's name moved to the agent's footer**, on the right before the context, and no longer repeats the project and agent: until the session has a name it shows when it started (*14:05*). Right-click it to **Rename…**; in a narrow pane it gives way first.
- **The latest rename wins**: rename a session in Hive or with Claude Code's `/rename`, and Hive shows whichever you did last, everywhere it lists the session. Before, a name given in Hive hid any later `/rename`, and resuming put Hive's name back.
- **Merge keeps your agent's commits by default.** The Merge dialog's default is now **Merge** (the agent's commits and their messages, plus a merge commit) instead of Squash, and it no longer removes the worktree unless you tick it, so one agent can merge task after task. If you had Squash saved, it's switched to Merge once; choose Squash again in **Settings → Agents & Worktrees → Default merge style** if you want it.
- **Squash without the old commits coming back**: a squash that keeps the worktree now moves the agent's branch onto the squash commit (**Move the branch afterwards**, ticked), so its next merge doesn't conflict with its own earlier work.
- **No merging mid-task**: **Merge…** is greyed out while the agent is working, asking you something or waiting on background tasks, since a merge would commit its half-finished files. Before, the dialog opened and only said so after you clicked Merge, and a merge while the agent was asking you something went ahead.
- **See when a worktree agent has work to merge**: **Merge…** turns orange with the number of commits not merged into the project folder's branch, and the agent's tab shows it too (↑2). A • means uncommitted files only; hover for the details. It updates when the agent finishes a turn, when you come back to Hive, and after a merge.

### Agents that need you
- **One list of the agents waiting on you.** The status bar says how many agents need you (**2 need you**): those asking you something, and those that finished while you weren't looking. Click it for the list, oldest first, with how long each has waited; click one to go to it. The tray menu has the same list, and the Projects icon and each project in the sidebar show the count.
- **Finished means you haven't seen it.** An agent that finishes in another project, on another page of agents or while Hive is in the background now stays marked until its pane is on screen. Before, a finish only counted as unseen while Hive's window was in the background, and opening a project cleared all of its agents.
- **Work to review**: worktree agents that have finished with work not merged are listed below, with what changed (*3 files, +120 −40 · 2 commits*) and buttons for **Changes** and **Merge…**.

### Lean replies from Hive's tools
- **Hive's tools reply in a few lines, not whole objects**, so agents and the Assistant use far fewer tokens. Listing the board gives one line per card (number, title, project, agent, labels, blocked, comments) instead of every card in full: about 7,500 characters for 76 cards, where it was over 300,000 and too big for Claude Code to take. Changing, commenting on or reordering cards confirms what changed and where the card is now, in about 100 characters instead of the whole card or column. Projects, shared notes, new agents and started agents reply in a line or two too.
- **Full detail on request**: `hive_list_tasks` with `details: true`, `hive_read_task` with `history: true` (the description and comments are always there), `hive_session_usage` with `days: true`. Notes and handovers read as their text, and other structured replies are compact JSON.
- **Agent API**: replies are unchanged unless you ask for the short ones: `GET /v1/tasks?view=short`, `GET /v1/tasks/{n}?history=false`, `"reply": "short"` on card changes, reorders and comments, `GET /v1/projects?view=short` and `GET /v1/projects/{name}/usage?days=false` (AGENT_API.md).

### Task board
- **A task board for the workspace**: cards in **Todo**, **Doing**, **Review** and **Done**, each for a project, with a description, labels, a blocked reason, the cards it depends on, comments and a history of who changed what. Open it from the activity bar (**Ctrl+Shift+J**); each project also has a **Tasks** tab. Drag cards between columns; a Doing card shows what its agent is doing right now.
- **Start** gives a card to an agent (one that is stopped or idle, a new one, or a new one in its own worktree) with the card as its prompt.
- **The Assistant and agents use it too.** Agents read cards, add cards for follow-up work and move their own to Review with a summary; the Assistant plans work as cards and starts them on agents. **Only you move cards to Done**: the Assistant asks first, and agents can't. Archiving and deleting cards are yours too.
- **An agent that moves a card into Doing takes it**: a card nobody had is given to the agent that moved it (or created it in Doing), so it no longer shows as stalled with no agent. A card someone already has keeps them.
- **Stalled cards stand out**: a Doing card whose agent was removed or isn't running (or that has no agent) is marked in amber and listed under **Stalled** in the board's sidebar, and the Assistant points them out. Removing an agent that has open cards asks whether to move them back to Todo or leave them.
- **See what each agent is working on**: an agent with a card in Doing shows it as a chip on its tab, its pane header and the Overviews' running lists (click to open the card), and in the project's sidebar tooltip. Each session remembers the cards it worked on, shown in the Sessions tab.
- **Agents and the Assistant can put cards in order**: a column's order is its priority, and when you ask them to prioritise (*"put the bugs at the top of Todo"*) they reorder the board itself, a card at a time (top, bottom, or before another card) or a whole list in one go. Each card they move says so in its history. The order of Done stays yours.
- **Colour-coded columns**: each column has its own colour on its heading and as a light tint on its cards (Todo slate blue, Doing blue, Review purple, Done green). Pick your own in **Settings → Board → Column colours**, or turn them off.
- **Done cards are archived after 14 days** in Done: **Settings → Board → Archive Done cards after** (0 never).
- Agent API: `/v1/tasks` and the `tasks-changed` event; hive tools `hive_list_tasks`, `hive_read_task`, `hive_create_task`, `hive_update_task`, and `hive_start_task` for the Assistant.

### Workspace Overview
- **A Workspace Overview** (activity bar, **Ctrl+Shift+O**): what the whole workspace used in a period (7 days by default), every project and the Assistant together: tokens, API-equivalent cost, sessions and prompts, a daily chart stacked by project, every agent running now, a sortable table by project, each provider's plan limits, and the task board at a glance. It reads no more than a project's Overview: token counts come from the usage cache.

### Projects
- **Project → Remove Project…**: **Hide** a project (Hive leaves it out until you restore it), **Remove** it from Hive (the folder stays, with its handovers and cards packed into it, so it can move to another workspace and bring them along), or **Delete** it (the folder, its worktrees and its handovers to the Recycle Bin). **Settings → Workspace** lists hidden and removed projects, with **Restore**.

### Agents
- **See why an agent couldn't start**: when its CLI quits before it has started (an argument or setting it refuses, a broken install), the bar under its terminal turns red with what the CLI said and, where Hive recognises it, what to do, with **Retry** and **Agent Settings…**. Its tab and header turn red ("Failed to start"), the attention inbox lists it, and a notification tells you if its pane isn't on screen. Before, the reason was only in the terminal.
- **Arrange a project's agents**: drag a tab in the agent strip or a pane by its header to move an agent, drop a tab on a page button to move it to that page, or use **Move Left / Move Right** (agent menu, Ctrl+Alt+Shift+Left/Right). The order is saved with the project, and running agents carry on.
- **Resume All Agents** in the project header (and the project's right-click menu): resumes every stopped agent's last session in one go, leaving running agents alone. If one can't resume, a notification names it and says why, and the others still resume.
- **Agents waiting on background tasks aren't shown as finished.** When a Claude Code agent ends its turn while a task it started is still running (a test run, say), it shows as **waiting on background tasks** ("Waiting on 1 background task", a slow, faint dot) and carries on by itself when the task ends. The chime and the "finished" notification wait until it really has finished. Codex isn't told when its background terminals end, so Codex agents show as finished with the count next to them.
- **Settings → Agents & Worktrees → Count background tasks for up to** (60 minutes): Hive can't tell a test run from something that never ends, such as a dev server, so it stops counting a task after this long.
- Quitting asks first while an agent waits on background tasks (they would stop), and **Quit when agents finish** waits for them.
- **Long conversations are flagged.** Each agent's footer shows the size of its conversation's transcript, which turns amber past **Settings → Sessions → Warn when a transcript is over** (50 MB), and Hive tells you once. A transcript keeps everything, compacting doesn't shrink it, and a very long one slows down the CLI and Hive. Click the size for **Hand Over to…**.
- **Hand Over to… the agent itself, in a new conversation**: it writes a handover, and a new conversation of its own carries on from it. Hand Over to… is now available with only one agent.
- Clicking the context count in an agent's footer opens the Overview scrolled to that agent's session.
- **Use 200K context (instead of 1M)** for Claude Code: off by default in **Settings → Claude Code**, with Inherit/On/Off in Project Settings, a choice in **Add Agent** and **Agent Settings**, and one for the Assistant. Current Claude models have a 1M-token window; this holds sessions to 200K, so a long conversation compacts sooner. The Agent API and hive tools take it as `context200k`.
- **The 1M context checkbox is gone** from the model pickers: Fable, Opus 4.7+ and Sonnet 5+ always have the 1M window, so it did nothing for them. For Opus 4.6 or Sonnet 4.6 with 1M, type a custom model ID such as `claude-opus-4-6[1m]`; models saved with `[1m]` keep working.

### Usage
- **The Overview and session lists open faster after a restart**: Hive remembers each transcript's token counts on disk, and reads a transcript again only if it changed while Hive was closed. **Settings → Sessions → Usage cache size** (5,000 transcripts) and **Clear the usage cache**.

### Hive Assistant
- **The Assistant uses your agents' model and effort.** It used to start lighter (Sonnet, low effort), which made it careless: it could say it would check on an agent later and never do it. Settings left at the old defaults move to the agents'; ones you chose stay.
- **It waits for agents that are waiting on background tasks**, and won't give them a new task meanwhile (`hive_wait_for_agents` waits through them unless `ignoreBackground` is set; `hive_prompt_agent` refuses them). Its instructions now tell it never to promise a later check without a wait actually running.

### Feedback for slow actions
- **Actions that take a moment show it and can't be interrupted by mistake**: Start (on a card), Remove Project, Save, Delete, Archive and Comment on a card, Compact, Agent Settings, Stop All Agents, and deleting a note or an MCP server show a spinner and what they're doing (**Starting…**, **Deleting…**); while they run the dialog can't be closed (Escape, ×, a click outside) and a second click does nothing. If one fails, the dialog stays open with the error, so you can try again. **Resume All** shows a spinner on its button, and an agent being removed shows one on its tab.

### Fixes
- **`/compact` typed into an idle agent** left it shown as working after the compaction ended, until its next turn. It now shows **Compacting the conversation…** while it compacts and **Ready** afterwards.
- An agent that asked the same question twice, or reported its turn's end twice, now notifies (and chimes) once.
- **A failed load says so, with Retry**, instead of looking like there's nothing: a transcript search that fails no longer shows *No matches*, the Skills tab no longer shows no skills, the Workspace Overview no longer spins forever, and the same goes for the Images, Memory and MCP tabs, the Files tab's filter, the workspace's Skills view and the hidden projects in Settings. When a refresh fails, the last results stay with a note saying when they're from. In **Add Agent**, a git error no longer reads as *Needs a git repository*.
- **Number settings**: clearing a box such as *Suggest compacting above* and clicking away saved 0, which turned the feature off without a word. A cleared box now keeps the saved value (in Project Settings it inherits, as before). A number out of range, or text that isn't a number, shows the range under the box instead of a passing message. Settings that 0 turns off (*Suggest compacting above*, *Warn when a transcript is over*, *Archive Done cards after*, *Pause after you type*) have a **Never** (or **No pause**) checkbox; untick it to get your last number back.
- **Agent Settings** and **Add Agent**: a long model, effort or permission mode name no longer pushes the boxes past the dialog's right edge.
- **Start… on a card you've edited** used the card as last saved, so the agent got the old description. It now reads **Save and Start…** and saves your edits first; if the save fails, nothing starts and the dialog says why.
- **Closing a card with unsaved changes** (Escape, ×, a click outside, Cancel) lost them without a word, including a comment being written. Hive now asks **Keep Editing** or **Discard**; a card with nothing changed closes at once. **Save** also posts a comment you were writing.
- A question asked from inside a dialog (Delete on a card, say) could appear underneath it; questions now always come on top, and Escape closes only the top one.
- The **Changes** tab could show the previous file's diff after you picked another while it loaded, and a git error left it stuck loading or showing another folder's files. It now always shows the selected file's diff, and a failure shows the error with **Retry**; when refreshing a diff already shown fails, the last diff stays with a warning above it that it may be out of date.
- After switching an agent to another conversation, its footer could show the **previous conversation's** context and cost until the new numbers arrived, or for good if reading them failed. It now shows a placeholder until the conversation's own usage is read, and a refresh that fails keeps that conversation's numbers, faded.
- **Merge** refuses when git can't check a worktree for uncommitted changes (a damaged index, say), instead of merging and, with clean-up, removing the worktree with them.
- The **Changes** tab no longer shows the contents of a file outside the project reached through a link (a link is shown as the path it points to, as git stores it).
- **Agent Setup → Codex → Set up** could sometimes not bring up Codex's sandbox prompt: Hive typed `/permissions` while Codex was still busy starting, and Codex queued it. Hive now waits until Codex is idle.
- Hive noticed what a running Codex agent wrote to its rollout (its usage, cost and settings) only about once a minute and at the end of each turn: Windows reported the file's old modified time while Codex kept appending, so Hive now checks the size too.

## 0.2.0 — 1 October 2026

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
- **Up to twelve agents per project**, six to a page: a seventh opens page 2, and the **1 · 2** buttons (or Ctrl+Alt+PageDown / PageUp) switch pages. A new 3×2 grid shows six at once.
- **The layout follows as you add agents**: two columns for two, three for three, a grid for four, the 3×2 grid for five or six. Each page has its own layout, and one you choose stays as agents are added.
- **Updating from 0.1 clears every project's agents** (and resets the layout), since there is no longer a built-in Agent 1. Your sessions stay in the Sessions tab and can be resumed by an agent you add again.
- **The Overview's periods count only what happened in them**: Today is since midnight, and a session running for days adds only today's work to Today (and each day's cost: its share of what Claude Code reported). 7 and 30 days show a chart of tokens per day. The Assistant's **Used so far** has the same periods, and the Agent API's usage includes each day.
- The Overview's session details have an **agent picker** (they followed only the focused agent), and a long compaction history scrolls in its own pane, newest first.
- **Settings → Assistant → Pause after you type** (15 seconds) and **Enter ends the pause**: how long after you type in an agent's terminal the Assistant leaves it alone.
- Hive reads only what's new in a running session's transcript when it updates usage, instead of the whole file each time.
- When resuming would re-cache a large conversation, the warning offers **Archive and Start Fresh** next to **Resume**.
- **Sessions can be deleted** in the Sessions tab (and the Assistant's conversations), when they aren't running. Hive's copies go to the Recycle Bin; the CLI keeps its own. What a deleted session used still counts in the Overview.
- Lists show their delete button on hover (skills, MCP servers, shared notes, personas, sessions), and an open item has one in its top bar. Rename now uses a tag icon instead of the pencil.
- Starting a new conversation inside the CLI (Claude Code's `/clear` or `/resume`, Codex's `/new`) is now followed: Hive records and backs up the new conversation instead of carrying on with the old one.

### Skills
- **Simpler skills: no more switches.** Every Hive skill in the workspace reaches every agent in every project. Skills that were turned off in the workspace or a project are on again after updating.
- **The Skills view shows the workspace's Hive skills**, where you add (**+**, or **Add Skill from File** with a `.md` or a `.zip`), edit and delete them.
- **A project's Skills tab lists everything its agents get**: the Hive skills (with **Edit in workspace**), then per provider the project's own **Local (User Managed)** skills, which you can now add, edit and delete there, and your user and plugin skills (view only). A local skill can be added for Claude Code and Codex at once.
- **Six skills come with Hive**, for working with several agents and sessions: `handover`, `pick-up`, `merge-ready`, `review-agent-work`, `split-work` and `workspace-note`. New workspaces start with them. In an existing workspace they're listed greyed out: **Restore** adds one. When a later Hive improves them, **Revert to default** on a skill's page brings your copy up to date (the old copy goes to the Recycle Bin).

### Hive Assistant
- **The Assistant can run your agents.** Ask it to add agents, start them on tasks, give idle ones more work, hand one agent's work over to another, change their settings, stop them, or create a project. **Settings → Assistant → Control** decides how far it may go: Look and advise, Control agents, or Control agents and create projects (the default). It never removes agents or deletes anything, never types into an agent that's busy, asking you something or that you just typed in, asks you before stopping a busy agent, makes at most 30 changes per message, and lists what it did in its panel. Your view stays where it is.
- An agent whose CLI asks whether to trust a new folder now shows as waiting for you, instead of starting forever.
- **Each workspace has a Hive Assistant, its overseer**, in a panel on the right (Ctrl+Alt+I, or click the Hive Assistant strip down the right edge). Ask it what the agents are doing, about any project, or for a plan or a review. It reads every project and uses Hive's own tools. For now it only looks and advises. It doesn't use a project's agent slot, and hiding the panel doesn't stop it.
- **The panel has everything about it**:
  - its status and persona;
  - Start, Compact, Stop, and its past conversations;
  - the workspace at a glance, with agents waiting for you first (click one to go to it);
  - its terminal;
  - a footer with its model, mode, context and cost.
- **The Hive Assistant view** (activity bar) shows what the Assistant has used so far, all its conversations (searchable, like a project's Sessions tab) and its personas.
- **Personas** decide who the Assistant is, and you can edit them or write your own in the Assistant view. Four come with Hive, each with a serious job and an unexpected character:
  - 🗼 **Overseer**, a lighthouse keeper keeping a watch log;
  - 🎩 **Planner**, who plans every task like a heist;
  - 🦎 **Reviewer**, who reviews code like a wildlife documentary narrator;
  - 🛫 **Orchestrator**, an air traffic controller.
- **Settings → Assistant** sets its provider, default persona, and each provider's model, effort, mode and arguments. It starts lighter than your agents, on Claude Code's Sonnet at low effort. **Assistant Settings** in the panel changes them for one workspace.

### Several windows
- **File → New Window** (Ctrl+K Ctrl+N) opens another Hive window, like VS Code, so you can work in several workspaces at once. Each window has its own projects and agents; settings, the tray and updates are shared.
- Opening a workspace that's already open in another window brings that window forward. Closing a window stops its workspace's agents, asking first as quitting does; so do Close Workspace and opening another workspace in the window, which used to refuse while agents were running. Hive reopens the windows that were open when it quit.
- Agent API: `X-Hive-Workspace` or `?workspace=` names the workspace a request is for, `GET /v1/workspaces` lists them, and a project can be named `<workspace>/<project>`. The `hive` tools always use their session's workspace.

### A tidier project view
- **Every agent has its own header and footer**, with one agent or several. The header has its status, session and buttons (Compact, a red **Stop**, Archive & New, or Resume and New Session), which turn into icons and then fold into ⋯ as the pane narrows. The footer has its model and effort, permission mode, context and cost.
- **The project header is about the project**: Active, Explorer, Terminal and a new **Stop All Agents**, which lists the agents it will stop and asks first. The status bar keeps app-wide items only.
- A narrow window no longer pushes the right side of the project view off screen.
- Running Claude Code agents show their context against the model's window ("39,353 tokens of 1,000,000") in the footer tooltip and the Overview tab, as Codex agents already did.
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
- Choosing Haiku with Auto mode (for the Assistant or an agent) warns that Claude Code may run it in Manual instead.
- Switching a Claude Code agent to Manual with Shift+Tab shows in Hive again (Claude Code 2.1.286 shows Manual without its usual hint), and switching to Manual from Hive no longer offers a restart instead.
- A Claude Code session's cost no longer stands still for hours: Claude Code records it only now and then, so Hive adds its estimate for the work since (shown with ≈). The Overview opens on All time.
- The title bar's bottom line runs all the way under the window buttons.
- Hive keeps a last good copy of its settings and records (`.bak`). A file that can't be read is set aside and the copy restored, with a notification, instead of Hive starting over.
- Hive's copies of workspace skills for Codex are marked, so a `hive-…` folder of your own in `.agents/skills` is never removed.
- "Hand Over to…" waits until the handover has actually been written before the other agent starts.
- A Codex permission change is confirmed by Codex before the badge shows it ("Switching to …"); the earlier method could pick the wrong preset.
- Much less file reading while agents work: session lists read each file once, and Codex sessions are found without re-scanning every time.
- Hive tells you once if a CLI version writes transcripts it doesn't understand, instead of showing zeros.
- The hook token is no longer written to the log. The window refuses web permissions it doesn't need, IPC is accepted only from Hive's own page, and links inside the workspace can't be used to open files outside it.
- Links to sections within the user guide now work in Hive's Docs view.
- **Unsaved edits in shared notes, skills, instruction and memory files and MCP servers are kept** when you change view or file, as the Files tab's are, and quitting, reloading, closing or switching the workspace asks about them. Saving a file that changed on disk since you opened it (an agent edited it) asks before overwriting it.
- Closing or switching a workspace, stopping an agent, quitting or turning a provider off while an agent is still starting now cancels the start, instead of the CLI starting afterwards.
- Turning a provider off lists the agents running it in every window, not only this one's.
- Two agents adding to the same shared note at once both keep their text.
- The Files tab can't read or write through a link (symlink or junction) that leads outside the project; the link itself can still be renamed, moved or deleted.
- A workspace can't be opened inside, or around, one open in another window. A closed workspace's agent worktrees no longer count as part of the next workspace opened in that window.
- Agent API: a workspace name two open workspaces share is refused (409) with both paths, instead of picking one; name it by its path.
- Resizing a pane in one window no longer resets pane sizes changed in another.
- **Transcript backups write only what's new**: Hive appends what a session's transcript gained since the last backup, instead of copying the whole file each time (a long session's transcript can pass 100 MB). A failed backup is tried again at the next look.
- Reading a long transcript for the first time takes it in pieces, so it no longer needs its whole size in memory at once; Hive keeps the usage of at most 200 transcripts in memory. Two reads of one transcript at once can no longer count its lines twice.
- An agent's hooks are handled in order, so a turn's end can't overwrite the start of the next one (it could show Finished while the agent worked), nor release the file locks, approvals or questions of the next turn. A file reached through a junction or link is locked as the same file.
- Hive types one prompt at a time into an agent, and stops if the agent stops or restarts meanwhile.
- The tray menu is rebuilt at most twice a second, not with every status update of a working agent. Hive notes in its log when its main process was busy for more than a quarter of a second, to help track down pauses while typing.
- When the Assistant asks to stop a busy agent, your answer stops only the run it asked about, and only if Control still allows it. When the Assistant stops, its token stops working and its open questions are withdrawn. The Agent API's event stream is for Agent API callers only.
- Saving settings or workspace settings twice in quick succession can no longer leave the older version on disk. Changing the Agent API settings quickly restarts its server once at a time.
- Typing while a note, skill, MCP server or file is being saved keeps the newer text as unsaved (even when you undo back to what it was), and closing or switching after Save All stays open if something was edited while it saved. A deleted note, skill, persona or MCP server can't come back through Save All, and a note with unsaved edits asks to save or discard them before it is renamed.
- Deleting a shared note or an MCP server sends it to the Recycle Bin, like files, skills, personas and sessions.
- **Handovers say who wrote them**: Hive starts every handover an agent writes with its project, **author** (the agent and its CLI), **session** and date (your time, with UTC). **Hand Over to…** waits for the handover from that agent's own session, so another agent's meanwhile isn't picked up, and tells the next agent exactly which handover to read.
- Two handovers, notes or MCP servers created with the same name at once no longer overwrite each other. A handover written for `<workspace>/<project>` is named after the project.
- Saving a file in the Files tab checks and writes it under one lock, so two saves at once can't both pass the check.
- One merge at a time per project, and not while the worktree agent is working. Two agents added at once can't get the same name or worktree, and a new worktree made for an agent that couldn't be added is removed.
- Codex agents in one folder starting together copy the workspace skills one at a time.
- If Hive can't record a session it has just started (a full disk, say), the agent keeps running and is still tracked.
- Two windows opening the same workspace at the same moment can't both have it.
- While the Files tab watches a busy project (a build), it still updates at least once a second, and changes inside `node_modules` are no longer followed. Moving several files where one name is taken in the destination now moves none of them. A project's Overview doesn't update while another view is shown, and a slow load can't show the previous project's sessions or MCP server.
- Dialogs asked for while one is open wait their turn instead of replacing it. A dialog gives the keyboard back to where it was when it closes; the hidden Assistant strip works from the keyboard.
- Removing the New Session shortcut no longer breaks the empty Session tab.
- The Assistant's start screen and the user guide no longer say it can only look and advise. The Sessions tab's **+** comes before Refresh, as in the other lists.
- `npm run release` refuses to upload to a release that is already published.
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
