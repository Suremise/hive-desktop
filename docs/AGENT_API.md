# Hive Agent API

The Agent API lets AI agents, scripts and other tools talk to Hive: list projects and their session status, read and write shared notes, create handovers, send notifications and (optionally) drive sessions.

There are two ways to use it:

1. **The built-in `hive` MCP server** — every session started from Hive gets it automatically. Agents just call the tools. No setup needed.
2. **The HTTP API** — for scripts and anything else. Described below.

> The API only listens on `127.0.0.1` and every request (except `/v1/health`) needs a bearer token. Requests that carry a browser `Origin` header are rejected, so web pages cannot call it.

## Connecting

| | |
|---|---|
| Base URL | `http://127.0.0.1:47821` (port configurable in **Settings → Agent API**) |
| Auth | `Authorization: Bearer <token>` |
| Token | Settings → Agent API → Access token, or `%APPDATA%\Hive\agent-api.json` |
| Format | JSON request and response bodies (`Content-Type: application/json`) |

Sessions started from Hive receive these environment variables, so an agent can call the API with no configuration. An agent's token works like the workspace token, except on the task board, where it confines the agent to its own project's cards (see **Task board**):

| Variable | Value |
|---|---|
| `HIVE_API_URL` | Base URL of the API |
| `HIVE_API_TOKEN` | The agent's own bearer token for this launch (not the workspace token in `agent-api.json`): the API knows from it which project's agent is calling, and it stops working when the agent stops |
| `HIVE_API_TOKEN_FILE` | Path of the file holding that token, which Hive rewrites at each launch |
| `HIVE_PROJECT` | Name of the project the session belongs to |
| `HIVE_AGENT` | Name of the agent running the session (e.g. `Agent 1`) |
| `HIVE_PROJECT_PATH` | Full path of the project |
| `HIVE_WORKSPACE` | Full path of the workspace |
| `HIVE_PROVIDER` | The provider running the session: `claude-code` or `codex` |
| `HIVE_SESSION_ID` | The session ID, when it is known at launch (Claude Code; Codex chooses its own ID with the first prompt, so its sessions don't get this) |
| `HIVE_RUN_ID` | An ID for this launch of the agent, unique even before the session ID is known |

### Example (PowerShell)

```powershell
$h = @{ Authorization = "Bearer $env:HIVE_API_TOKEN" }
Invoke-RestMethod "$env:HIVE_API_URL/v1/projects" -Headers $h
```

### Example (bash / curl)

```bash
curl -s -H "Authorization: Bearer $HIVE_API_TOKEN" "$HIVE_API_URL/v1/projects"
```

### Errors

Errors return a non-2xx status and `{ "error": "message" }`.

| Status | Meaning |
|---|---|
| 400 | Invalid request (missing field, bad JSON, invalid session ID, `agent` needed because the project has several) |
| 401 | Missing or wrong token |
| 403 | Blocked (cross-origin request, a disabled feature such as session input, or a change only the user makes, such as archiving a card or putting Done in order) |
| 404 | Unknown route, project, card, skill or file, or one outside the caller's scope (another project's card looks missing to its agents) |
| 409 | Conflict with the current state (no workspace open, the project has no agents, agent already running or starting or busy, conversation open in another agent, session archived, provider turned off or not installed…) |
| 500 | Unexpected error; details are in Hive's log |
| 413 | Body larger than 2 MB, or a skill file larger than 512 KB |

---

## Several windows

Hive can show several workspaces, each in its own window (**File → New Window**). The API serves all of them:

- A request is for one workspace: the one named by the `X-Hive-Workspace` header (its folder path, URL-encoded) or the `workspace` query parameter (its name or path), else the only one open. A name that two open workspaces share (`C:\Clients\foo` and `D:\Clients\foo`) is refused with 409, listing both paths: name the workspace by its path instead. The `hive` MCP server sends its session's workspace, so an agent's tools always see its own workspace.
- `{name}` in `/v1/projects/{name}` is a project in the request's workspace. With several windows open and no workspace named, a name is looked up in every open workspace: a name found in two answers **409**; say `<workspace>/<project>` instead (`/` encoded as `%2F` in the path: `/v1/projects/work%2Fapi`).
- Calls about a whole workspace (`/v1/workspace`, shared notes, the task board, skills without a project, MCP servers) answer **400** when several are open and none is named.

## Endpoints

### Health

`GET /v1/health` — no token required.

```json
{ "ok": true, "app": "Hive", "version": "0.1.0" }
```

### Status

`GET /v1/status` — what is running and who you are to it: the app's version, the API's contract version (`api.version`, which goes up when a route or field changes in a way a client would notice), the caller (`role`: `agent` with its `project` and `agent` name, confined to that project; `assistant` with its workspace and `control` level; or `api`, the workspace token), the guidance Hive gives sessions (`guidance.revision`, and each of the request's workspace's Hive skills with who it is for, its content hash, and for a bundled one whether this copy is Hive's or edited and whether a newer version is there to take), each provider's install info, the request's workspace (`null` if several are open and none is named), every open workspace (`workspaces`) and running sessions. Start here before calling anything else.

```json
{
  "app": { "name": "Hive", "version": "0.3.1" },
  "api": { "version": 2 },
  "caller": { "role": "agent", "project": "web", "agent": "Agent 1", "scope": "project" },
  "guidance": { "revision": "3f2a9c41d07be512", "skills": [{ "name": "work-on-card", "audience": "agents", "revision": "9b1c…", "bundled": "same" }] },
  "providers": [
    { "provider": "claude-code", "found": true, "version": "2.1.283", "source": "PATH", "updateAvailable": false, "loggedIn": true },
    { "provider": "codex", "found": true, "version": "0.159.0", "source": "PATH", "updateAvailable": false, "loggedIn": true }
  ],
  "workspace": { "name": "work", "path": "D:\\work" },
  "workspaces": [{ "name": "work", "path": "D:\\work" }],
  "liveSessions": [{ "workspace": "work", "project": "api", "agent": "Agent 1", "provider": "claude-code", "sessionId": "6f1c…", "status": "working" }]
}
```

A skill's `revision` is a hash of its files' content. Hive keeps it between calls and hashes a skill again only once its files have changed (a file written, added, removed or renamed), so polling the status only lists the skills' folders and checks their files' sizes and times, and never gives an outdated revision. A skill's name, description and audience come from the first 64 KB of its `SKILL.md`. Hive uses the first 1000 entries of the workspace's skills folder. A skill whose header can't be read, or whose audience is unknown, has `audience: "none"` and a `problem` (nobody gets it). A skill too big to check (over 64 MB, 2000 files and folders, or folders 12 deep) has an empty `revision` and a `problem` saying which; one that can't be read has an empty `revision`.

A workspace's Hive Assistant is listed in `liveSessions` with `"project": null` and `"agent": "Assistant"`. It isn't a project, so the project endpoints don't reach it.

`GET /v1/docs/agent-api` — this reference as the running Hive shipped it: `{ version, api, content }` (`content` is the Markdown). For a client that needs more than `/v1/status` without guessing routes.

### Workspace

`GET /v1/workspace` — `{ name, path, config }` for the request's workspace, where `config` lists the workspace-enabled MCP servers, or `null` if no workspace is open.

`GET /v1/workspaces` — every open workspace (one per window): `[{ name, path }]`.

### Projects

`GET /v1/projects` — every project in the request's workspace; with several windows open and none named, every open workspace's projects. Each has `workspace` (its workspace's name). Projects hidden or removed from Hive (Project → Remove Project…) aren't listed and can't be named. `?view=short` lists each project without its path, ids, sessions and settings: `{ name, workspace, active, branch, agents: [{ name, provider, status, branch, backgroundTasks, watching?, progress? }] }` (`progress`: an open progress run in a few words, "e2e: 12 suites 4/12, about 6 min left").

`GET /v1/projects/{name}` — one project.

```json
{
  "name": "api",
  "path": "D:\\work\\api",
  "active": true,
  "branch": "main",
  "status": "waiting",
  "sessionId": "6f1c…",
  "statusMessage": "Claude needs your permission to use Bash",
  "restartNeeded": false,
  "agents": [
    { "id": "a-3f9c01d2", "name": "Agent 1", "provider": "claude-code", "branch": null, "worktree": null, "status": "waiting", "sessionId": "6f1c…", "statusMessage": "Claude needs your permission to use Bash", "reviewing": null, "backgroundTasks": 0, "launched": { "guidance": "3f2a9c41d07be512", "skills": { "work-on-card": "9b1c…" } } },
    { "id": "a-7b21e4aa", "name": "Reviewer", "provider": "codex", "branch": "hive/reviewer", "worktree": "D:\\work.worktrees\\api\\reviewer", "status": "stopped", "sessionId": null, "statusMessage": null, "reviewing": null, "backgroundTasks": 0, "launched": null }
  ],
  "settings": { "model": "opus", "effort": "inherit", "permissionMode": "inherit", "chime": "inherit", "mcp": { "disabled": [] } }
}
```

`status` is one of `stopped`, `starting`, `ready`, `working`, `waiting`, `background`, `watching`, `finished`, `error`. **background** means the agent's turn has ended but background tasks it started (a test run, say) are still running, and it carries on by itself when they end (Claude Code). **watching** means its turn has ended with a card watch running (`POST /v1/tasks/wait` with `wake`): Hive wakes it when a watched card changes; its `statusMessage` is what for ("Waiting for #12 → Review"), and it has `watching` (`{ cards, column?, changes, label, limitAt }`; short rows: the label). Each agent also has `backgroundTasks`, how many of those are running; Codex agents count theirs but stay `finished`, since Codex isn't told when they end. `reviewing` is an action the CLI's own automatic reviewer is checking while the agent works (Codex in **Approve for me**: "Codex asks to run …"), else null; nobody is asked, so it isn't a reason to tell the user. `provider` is the CLI the agent runs (`claude-code` or `codex`); each agent chooses its own, so a project can mix them. `settings` is the project's configuration, with per-provider overrides under `providers`. A project has up to twelve agents, all equal, in the order they were added; a new project has none. The top-level `status`, `sessionId` and `statusMessage` are the first running agent's, and `agents` lists every agent. A running agent's `launched` is what it was given at launch: Hive's guidance revision, the content hash of each Hive skill's copy it reads, and `problems` for any skill it didn't get as asked (`{ "handover": "a folder of the user's in .agents/skills is named hive-handover" }`, or an old copy kept because it was in use), to compare with `GET /v1/status` (an agent launched by an older build, or before a skill changed, shows different ones); `null` when it isn't running. Agent ids are random (`a-…`) and never reused. Endpoints that act on a session take an optional `agent` — its `id` or name. Without one, the project's only agent is used; a project with several answers 400 (say which), one with none 409.

`POST /v1/projects/{name}/activate` — mark the project as being worked on.

`POST /v1/projects/{name}/deactivate` — mark it as not being worked on (fails with 409 while a session is running).

### Sessions

`GET /v1/projects/{name}/sessions` — Hive and external sessions for the project, newest first, each with usage and a re-cache estimate. A session a CLI started for another one (a Codex guardian review) has `sub: { parentId, kind }`: it isn't a conversation, and resuming it is refused (`409`).

`POST /v1/projects/{name}/sessions` — start a session. Body (all optional):

```json
{ "resumeId": "6f1c…", "name": "Fix login bug", "agent": "Reviewer" }
```

Omit `resumeId` to start a new session. Returns the live session state (which includes `agentId` and `cwd`, the folder it runs in). Fails with 409 if the agent is already running or starting, if that conversation is already open in another agent, or if it ran in a different folder than the agent works in, or if the project has no agents yet (agents are added in Hive); with 400 if `resumeId` isn't a session ID.

`POST /v1/projects/{name}/stop[?agent=…]` — stop one agent's session, or every running agent of the project when `agent` is omitted.

`GET /v1/projects/{name}/usage[?sessionId=…][&agent=…][&days=false]` — usage for the agent's live session (see above for which agent), else the most recent Hive session, or the one given. `days` breaks it down by local calendar day (`YYYY-MM-DD`): tokens, requests, prompts, compactions and that day's API-equivalent cost (`costUsd`, `costEstimated`); `days=false` leaves it out (it grows with every day the session runs). Session lists include the same.

```json
{
  "sessionId": "6f1c…",
  "provider": "claude-code",
  "title": "Fix login bug",
  "model": "claude-opus-5-5",
  "inputTokens": 1204,
  "outputTokens": 48211,
  "reasoningTokens": 0,
  "cacheWriteTokens": 190233,
  "cacheReadTokens": 2811093,
  "contextTokens": 84211,
  "requests": 57,
  "compactions": [{ "timestamp": "…", "trigger": "auto", "preTokens": 968490, "postTokens": 14813 }],
  "cacheTtlSeconds": 3600,
  "contextWindow": null,
  "costUsd": 4.82,
  "costEstimated": false,
  "lastActivity": "2026-09-28T12:30:00Z"
}
```

`costUsd` is the API-equivalent cost: reported by the provider (Claude Code), or estimated by Hive from its price table (`costEstimated: true`), or `null` for a model without a price. It is not what a subscription plan charges. `reasoningTokens` (Codex) are included in `outputTokens`; `contextWindow` is the model's window when the provider reports it (Codex always; Claude Code while the session is running).

`POST /v1/projects/{name}/input` — type into the running session. **Disabled by default**; enable *Allow sending input to sessions* in Settings → Agent API.

```json
{ "text": "Run the tests and fix any failures", "submit": true, "agent": "Agent 2" }
```

`submit` (default `true`) presses Enter after the text.

`POST /v1/projects/{name}/handover` — hand one agent's work over to another, which may use a different provider (**Hand Over to…** in Hive). Also needs *Allow sending input to sessions*, and Hive's tools in sessions.

```json
{ "from": "Agent 1", "to": "Reviewer", "handover": true }
```

With `handover` (the default), `from` must be running and idle: it is asked to write a handover with `hive_create_handover`, and Hive waits until a new handover for the project exists (not just for the agent to stop). Then `to` starts a new session (or, if it is running and idle, gets the message in its current one) and reads the latest handover. The call returns `{ "ok": true }` at once; the handover can take minutes, and problems are shown as notifications in Hive. The new session's record has `handedOverFrom`, the session whose work it took over. With `to` the same as `from`, the agent carries on in a new conversation: once the handover exists, Hive stops it, starts a new conversation and gives it the handover, which is how a long transcript becomes short again.

### Agents and providers

These read-only calls are open to every caller:

`GET /v1/providers` — the coding-agent providers: whether each is turned on and installed (`enabled`, `installed`, `version`, `problem`), whether it's the default, and the `models`, `efforts` and `modes` an agent can use, and whether its agents can take `context200k`. `models` are the ones the installed CLI reports (else the fallback list in Settings), and `efforts` the effort fallback list: a model may take fewer levels.

`GET /v1/projects/{name}/agents/{agent}/activity[?detail=true]` — what one agent is doing: `status`, `statusMessage`, `reviewing` and `backgroundTasks`, `transcriptMB` (its conversation's transcript, or null) and `transcriptWarnMB` (the size past which Hive flags it, or null), `currentTask` (the start of its last prompt, 300 characters), `latestReply` (the start of its latest reply, 500 characters), `toolCalls` (how many tool calls since that prompt) and `recentTools` (the last three, each summary up to 100 characters), `clipped` (only when a text was cut: `currentTask` and/or `latestReply`, its whole length in characters), `lockedFiles` (relative to its folder), its branch and worktree, its session, `watching` (only while it has a card watch: `{ cards, column?, changes, label, limitAt }`), `progress` (only while it has an open progress run: see Progress below), and `userTypedSecondsAgo` (when the user last typed in its terminal). `detail=true` gives the prompt and reply up to 2,000 and 3,000 characters and the last ten tool calls (200 characters each). Neither is the whole conversation: `toolCalls` and `clipped` say what was left out, and the API gives no more of another agent's conversation than this. `{agent}` is the agent's name or id.

`POST /v1/agents/wait` — waits until agents stop working (finished, idle, waiting for the user or stopped), or `timeoutSeconds` (5–600, default 300). An agent waiting on its background tasks (`background`) still counts as working, since it carries on when they end; `"ignoreBackground": true` stops waiting at the end of its turn instead. An agent with a card watch (`watching`: its turn has ended and it waits for cards to change, `POST /v1/tasks/wait`) doesn't count as working, and its `statusMessage` is the watch's label ("Waiting for #12 → Review"). Without `agents`, it waits for every busy agent in the workspace.

```json
{ "agents": [{ "project": "web", "agent": "Agent 2" }], "timeoutSeconds": 120 }
```

Returns `{ "timedOut": false, "waitedSeconds": 41, "agents": [{ "project": "web", "agent": "Agent 2", "status": "finished", "statusMessage": null, "backgroundTasks": 0 }] }`.

### The Hive Assistant

Each workspace's Hive Assistant calls the API with **its own token**, a new one each time it starts, in a file its `hive` MCP server reads. Hive applies **Settings → Assistant → Control** to its calls instead of Settings → Agent API, and they always concern its own workspace (a request naming another workspace or one of its projects gets 404). With the Agent API turned off, the server still runs and answers the Assistant alone; other callers get `403`.

The changes below are the Assistant's only: other callers get `403`.

| Call | Needs | What it does |
|---|---|---|
| `POST /v1/projects` `{ "name" }` | Control agents and create projects | Creates a project folder in the workspace and turns it on |
| `POST /v1/projects/{name}/activate` | Control agents | Turns a project on (other callers: no restriction, as before) |
| `POST /v1/projects/{name}/agents` | Control agents | Adds an agent: `name`, `provider`, `model`, `effort`, `mode`, `context200k` (`"on"` or `"off"`: a 200K context window instead of the model's 1M, for providers with `context200k`), `worktree` (with `branch`, `base`); `start` starts it, and `prompt` starts it on that task, given on the CLI's command line |
| `PATCH /v1/projects/{name}/agents/{agent}` | Control agents | Changes `name`, `provider`, `model`, `effort`, `mode` or `context200k` (empty clears an override) |
| `POST /v1/projects/{name}/agents/{agent}/start` | Control agents | Starts a stopped agent: a new conversation, or `resume: true` (its last) or a session id; `prompt` as above |
| `POST /v1/projects/{name}/agents/{agent}/stop` | Control agents | Stops it. If it is working, waiting or starting, Hive asks the user in the Assistant's panel (with the optional `reason`) and the call waits for the answer: `409` if they say no |
| `POST /v1/projects/{name}/agents/{agent}/prompt` `{ "text" }` | Control agents | Types a task into an idle agent and sends it. `409` while it is working, starting, waiting on its background tasks or waiting for the user, or when the user has just typed in its terminal (Settings → Assistant → Pause after you type) |
| `POST /v1/projects/{name}/handover` | Control agents | Hand Over to… (below), without needing *Allow sending input to sessions*. `409` at once when the project's agents lack Hive's tools, the user has just typed in either agent's terminal, or (without a new handover) the project has no handover; later failures are listed in its actions |
| `POST /v1/tasks/{n}/start` | Control agents | Starts a card on an agent (see [Task board](#task-board)) |

Changing the task board (`POST /v1/tasks`, `PATCH /v1/tasks/{n}`, comments) is open to other callers too; for the Assistant it needs Control agents and counts as a change.

With **Look and advise** these return `403`. The Assistant can make 30 changes for each message from the user; then `429`. Every change, and every refusal, is listed in the Assistant's panel and in `hive.log`. There is no call to remove agents, discard worktrees, archive or delete cards, or remove projects. For the Assistant, `POST /v1/projects/{name}/sessions`, `/stop` and `/input` answer `400` (it uses the calls above), and `/deactivate` needs Control agents.

### Shared notes

Shared notes live in the workspace's `.hive/shared` folder. Paths are relative to that folder and cannot escape it.

`GET /v1/shared` — the notes tree.

`GET /v1/shared/file?path=handovers/2026-09-28-api-auth.md` — `{ path, content }`.

`PUT /v1/shared/file?path=conventions.md` — create or replace a note:

```json
{ "content": "# Conventions\n…", "append": false }
```

Set `"append": true` to add to the end of an existing note.

`POST /v1/shared/handovers` — write a dated handover note into `shared/handovers/`:

```json
{ "project": "api", "title": "Auth refactor", "content": "## State\n…\n## Next steps\n…" }
```

Returns `{ ok: true, path }`. Hive shows a notification with a link to the note. Hive writes the note's header (`# <title>`, project and date, in local time with UTC in brackets). An agent's `hive_create_handover` also passes `agent` (its id) and `agentProject`, and the Hive Assistant is known by its token; the header then adds `- **Author:** <agent> (<CLI>)` (or `Assistant`) and `- **Session:** <id>`, the conversation it was written in.

### Task board

The workspace's board: cards in four columns, `todo`, `doing`, `review` and `done`, kept in `.hive/tasks`. Callers can read and change cards and move them between all four columns, `done` included; each move is in the card's history with who made it. Agents are asked (their session contract and the work-on-card skill) to move a card they were given to `doing` before they start on it (also one back from `review` or `done` with more work), to move finished work to `review` with a comment saying what they did (also a card that was in `done`), and to `done` only when the user asks. Creating a card in `done` and putting `done` in order are the user's (`403`). Archived cards can't be changed (`403`), and archiving and deleting are only in Hive.

**Who sees what.** The workspace token (scripts) and the Hive Assistant see and change the whole board, as the user does. A project agent, calling with its own token (`HIVE_API_TOKEN`), sees and changes only its project's cards; who it is comes from the token alone, never from the request:

- `GET /v1/tasks` lists its project's cards; asking for another project (`?project=`) is `403`.
- Another project's card, or one with no project, answers as if it didn't exist: reading, changing, commenting on or moving it is `404` (`Unknown task #63`), and naming it in `blockedBy`, `links`, `before` or a reorder is `400` (`there is no card #63`).
- A new card is its project's (also when `project` is left out); another project, or `""`, is `403`, and so is changing a card's `project`.
- A card of its own that waits for or links to another project's card shows that card as a number, listed in `elsewhere`; changing `blockedBy` or `links` keeps those.
- `position` and a reorder place its cards among its project's cards in the column (the top or bottom of those); other projects' cards keep their places. The place a short reply gives (`3rd of 5`) counts its project's cards.
- Another project's agents' conversations hold that project's cards (a card started on an agent is its prompt), so for another project, `GET /v1/projects/{name}/agents/{agent}/activity`, `GET /v1/projects/{name}/sessions` and `POST /v1/projects/{name}/input` are `403`, and the event stream (`/v1/events`) leaves out their session events. Their status (`/v1/projects`, `/v1/projects/{name}`, `/v1/agents/wait`) stays open.

An agent runs as the user, so it could read the workspace token from disk: this keeps agents to their own project's work rather than containing a hostile one.

`GET /v1/tasks[?project=web][&column=review][&archived=true]` — the cards on the board in order (by column, then position), or the archived ones. A card:

```json
{
  "number": 12, "title": "Fix the login redirect", "description": "…markdown…",
  "project": "web", "column": "doing", "order": 3, "labels": ["bug"],
  "blocked": null, "blockedBy": [11], "links": [],
  "agent": { "id": "a-3f9c01d2", "name": "Agent 1", "status": "working", "backgroundTasks": 0 },
  "agentName": "Agent 1",
  "comments": [{ "at": "…", "by": "Agent 1 (web)", "text": "Found it: the callback URL." }],
  "history": [{ "at": "…", "by": "Assistant", "what": "Moved to Doing" }],
  "archived": false, "createdAt": "…", "createdBy": "Assistant", "updatedAt": "…",
  "stalled": null
}
```

`agent` is the agent the card is given to, with what it is doing now (`status` is `removed` if the agent no longer exists), or `null`. `stalled` says why nobody is working on a card in `doing` ("Agent 1 isn't running.", "Agent 2 was removed.", or that no agent has it), and is `null` otherwise; an agent that has finished its turn doesn't make its card stalled. `project` is the project's folder name, or `""` for a card about the workspace. `by` and `createdBy` say who: `You`, `Assistant`, an agent (`"Agent 1 (web)"`, calling with its own token) or `Agent API` (the workspace token).

`GET /v1/tasks/{n}[?history=false][&comments=n]` — one card (`#12` or `12`). `history=false` leaves out its history and gives `historyEntries`, how many entries it has; the description and comments stay. `comments=n` (a whole number from 1) keeps only the newest `n` comments and adds `commentsOmitted`, how many earlier ones there are: a long card's latest feedback without its whole thread.

`GET /v1/tasks/{n}/comments/latest` — only the card's newest comment, for "check the latest comment" without the whole card: `{ "number": 12, "comment": { "at": "…", "by": "Codex (web)", "text": "…the whole comment…" } }`, or `"comment": null` when it has none. The newest is the last one added (comments are kept in the order they were added, so equal times don't matter). The description, earlier comments and history are left out. Who may read it is as for the card (`404` for a card a project agent can't see, as for a missing one). The hive tools' `hive_read_task` gives it with `latestComment: true`.

`POST /v1/tasks` — add a card. `title` is required; `description`, `project`, `agent` (name or id, in that project), `column` (not `done`), `labels`, `blocked` (a reason), `blockedBy` and `links` (card numbers) are optional. Created in `doing` by an agent without `agent`, it is given to that agent.

```json
{ "title": "Add tests for the redirect", "project": "web", "description": "…", "labels": ["tests"], "blockedBy": [12] }
```

`PATCH /v1/tasks/{n}` — change a card and/or comment on it: any of `title`, `description`, `project` (a card that changes project always leaves its agent, and the history says whose it was; naming an `agent` in the same change is `400`: give it to one of the new project's agents in a change of its own), `agent` (empty takes it from its agent), `column`, `position` (`top` or `bottom` of its column) or `before` (the card it goes in front of, which has to be in the column the card ends up in; `null` the end), `labels`, `blocked` (empty clears it), `blockedBy`, `links`, and `comment`. When an agent moves a card into `doing` from another column without `agent`, it is given to that agent (the history says "Given to …"), also when another agent had it; a card already in `doing` keeps its agent. An explicit `agent`, including empty, wins, and the Assistant and other callers give it to nobody. A project agent (its own token) can't move a card that is in `doing` with a different agent to `review` or `done`: `409` ("… is in Doing with Alma, who is working on it: newer work is in progress …"), checked against the card as it was, so an `agent` in the same change doesn't get round it. Its own agent, the Assistant and the workspace token can.

Reviewing a card: `review` in the body. `"start"` marks the card as being reviewed by the calling agent (it has to be in `review`, and `review: "start"` goes on its own, without `column` or `agent`): the card keeps its agent and gains `review` (`{ "agent", "agentName", "since" }`). `"passed"` or `"failed"` ends it, with the verdict as the `comment`; `"passed"` with `"column": "done"` moves it to Done as well. Only a project agent, with its own token, reviews its project's cards (`403` for others); another agent's `start` while one is reviewing is `400`, naming it, and only the reviewer gives the verdict, while its review is going: a verdict after the review ended (the card left `review`, or the reviewer's session ended) is `400`, so start a new review first. The review stops when the card leaves `review` or its project, and when the reviewer's session ends or it is removed. A `"failed"` verdict leaves the card in `review`: its own agent, with its own token, sending `"column": "review"` returns it for review (history "Returned for review, round N"), which wakes a wait for it to move into `review`; once per failed verdict, and any other move to the column a card is in is no change. Card views add `reviewStalled` while a review goes on but its reviewer has gone or isn't running; `?view=short` rows add `reviewing` (`{ "name", "stalled"? }`).

```json
{ "column": "review", "comment": "Fixed in auth/callback.ts; tests pass." }
```

Placing a card with `position` or `before` adds a line to its history when it moves it. A `before` card in another column, or both `position` and `before`, is `400`; placing a card in Done is `403` (the order of Done is the user's).

`GET /v1/tasks` returns cards in board order: by column, then top first. That order is their priority.

`POST /v1/tasks/reorder` — put cards in order: `column` (`todo`, `doing` or `review`) and `cards`, card numbers highest priority first. The listed cards go to the top of the column in that order; the column's other cards keep their order below them. Every listed card has to be in that column already (move it first with `PATCH`), or nothing changes and the answer is `400`; `done` is `403`. Returns the column's cards in their new order.

```json
{ "column": "todo", "cards": [14, 9, 12] }
```

**Short replies.** Every caller gets the replies above unless it asks for short ones, which is what Hive's own tools do (an agent pays for each character of a reply on every later turn):

- `GET /v1/tasks?view=short` — a row per card: `{ number, title, column, project, agent: { name, status, backgroundTasks } | null, labels, blocked, blockedBy, stalled, reviewing?, comments (how many), archived }`, without descriptions, comments or history. (`hive_list_tasks` shows at most 200 of these a reply, with the `offset` to carry on.)
- `"reply": "short"` in the body of `POST /v1/tasks`, `PATCH /v1/tasks/{n}` and `POST /v1/tasks/{n}/comments` — what changed and where the card is now, instead of the card: `{ number, title, column, position (1 at the top; null when archived), of (cards in the column), project, agent (its name or null), changes }`. `changes` is in the words of the card's history (`"Moved to Review"`, `"Commented"`; empty when nothing changed).
- `"reply": "short"` in `POST /v1/tasks/reorder` — `{ column, top (the cards put at the top, in order), count (cards in the column) }` instead of the column.
- `"reply": "short"` in `POST /v1/tasks/{n}/start` — its `card` as a short row.

`POST /v1/tasks/{n}/comments` `{ "text" }` — add a comment.

`POST /v1/tasks/wait` — wait for cards to change. `cards` (1–20 card numbers the caller can see; others are `404`), `changes` (any of `column`, `comment`, `verdict`, `agent`; default all), `column` (`todo`, `doing`, `review`, `done`): alone, until a card is in that column (at once if it already is), and nothing else counts; with `changes` naming `column`, until one *moves into* it (a card already there waits until it leaves and comes back, or is returned for review) or another change listed (`"changes": ["verdict", "column"], "column": "done"`: a verdict, or into Done). `column` with `changes` that don't name it is `400`. A card that leaves the caller's view (another project, for a project agent), is archived or is deleted is reported as gone (`"column": "gone"`, `"changes": "gone"`), with nothing of its state.

- **Bounded** (default): waits up to `timeoutSeconds` (default 300, at most 840) and returns `{ "changes": [{ "number": 12, "column": "review", "changes": ["column", "comment"], "by": "Claudette (web)", "comment": { "by": "Claudette (web)", "firstLine": "Fixed the redirect." } }], "timedOut": false, "since": "…" }`, or `{ "timedOut": true, "since": "…" }`. `by` is who made the card's latest change; Pass `since` back to the next wait to measure from where this one ended, so nothing between them is missed. At most two at once per caller (`429`); `409` if the workspace closes meanwhile.
- **`"wake": true`** (an agent or the Assistant, with its own token; `400` for the workspace token): starts a card watch for the caller and answers at once with `{ "watching": "Waiting for #12 → Review", "limitAt": "…" }`, or `{ "already": { …a change… } }` when a `column` condition is already met. The agent ends its turn; Hive types one line into its session when a card changes (`[Hive] #12 is in Review; latest comment by …`), or after `limitMinutes` (1–1440, default 120) with no change (`[Hive] No change on #12 in 2 h: …`), and the watch ends. The line names every watched card that changed (when they don't all fit in full, briefly or by number, saying details were left out): it is typed 1.5 s after the first change and tells the cards as they are then (`[Hive] #217 is in Review: Codex (hive) passed it (…); #119 is in Review: Codex (hive) failed it (…). …`). The caller's next watch counts what others changed after its last wake (not what it did itself), so a change between a wake and the next watch isn't missed. A new watch replaces the agent's previous one (an `already` answer ends it too). The watch keeps the agent's view of the board: a project agent's project, the Assistant's whole board. Watches are kept in `.hive/watches.json`, and a stopped agent's is delivered when it is resumed. A watch that can't be saved is an error, not a watch; a workspace keeps at most 500 (`409` past that; replacing an agent's own is always allowed).
- **`"cancel": true`**: ends the caller's watch: `{ "done": "Cancelled your card watch." }` or `"You had no card watch."`.

While an agent watches, its status is `watching` (below), `POST …/agents/{agent}/prompt` is `409`, and starting a card on it is refused.

`POST /v1/tasks/{n}/start` — **the Hive Assistant only** (Control agents): gives the card to an agent of its project, with the card as its prompt, and moves it to `doing`. The prompt is the card's own words (title, `note`, description, the cards it depends on) and, when the agent has Hive's tools, a pointer to the work-on-card skill and how many comments to read. A card in `review` or `done` can be started again for more work; the prompt says it is back and carries its latest comment (the feedback it came back with). `note`: what to do now (up to 4000 characters, such as "address the latest review comment"), added to the prompt before the card. If the card is moved to `done` while the start is under way, it stays there and the start fails. `agent` (name or id): an existing agent that is stopped (a new conversation) or idle (its next message); `409` if it is busy. Without `agent`, Hive adds one: `name`, `provider`, and `worktree: true` for its own git worktree. Returns `{ ok, agent, added, card }`.

### Skills and MCP

`GET /v1/skills[?project=name]` — the workspace's Hive skills, each provider's user (`level: "machine"`) and plugin skills, plus, if a project is given, the project's local skills, and then only the Hive skills its agents get (not those whose audience is `assistant`): `{ name, description, level, provider?, plugin?, audience?, bundled?, updateAvailable? }`, without folder paths. `audience` (Hive skills) is who gets it: `agents`, `assistant` or `all` (its `SKILL.md`'s `metadata.audience`; `agents` without one). `problem` (Hive skills) says why nobody gets it: its header can't be read, or its audience isn't `agents`, `assistant` or `all`. `bundled` is `same` or `changed` for Hive skills that ship with Hive, and `updateAvailable` marks a changed copy made from a version this Hive knows to be older than its own. A project agent may list only its own project's skills (`403` for another's).

`GET /v1/skills/{name}[?file=path]` — one of the workspace's Hive skills: `{ name, audience, file, content, files }`, its `SKILL.md` and the list of the files in its folder; with `file` (relative to the skill's folder, `/` between parts), that file instead (`{ name, audience, file, content }`). The whole path is checked before anything is read: an absolute path, `..`, an empty part or a link leading outside the skill's folder is `400`, a file it doesn't have `404`, a file over 512 KB `413` (also when it grew past that while being read: no more than 512 KB is ever read). `files` is in path order, without Hive's `.hive-copy` marker and without following links; it lists at most 200 files, looking at no more than 2000 entries or 8 folders deep, and has `filesTruncated: true` when there may be more (each can still be read with `file`). Reading a skill grants nothing: what a caller may do is still its token's.

`GET /v1/mcp` — MCP servers deployed to the workspace: `{ name, description, globallyEnabled, error }`.

### Performance metrics

`GET /v1/metrics[?scope=workspace|project&project=name&from=…&to=…&trend=1&role=agent|assistant|api&provider=id&own=1]` — the workspace's performance metrics (Hive's API, its tools, its guidance and skill service) for a range (ISO times; default the last 24 hours): `{ scope, workspacePath, from, to, recording, projects, workspace?, skills?, app?, providers, notMeasured, dropped }`. `projects` has a part per project (`api`, `mcp`, `guidance`, `catalog` series); with `scope=workspace` (the default) there is also `workspace` (work of no project: the Assistant, scripts), `skills` (the skill service) and `app` (process-wide: refused requests, event streams, requests in flight). The parts add up to the totals once each. A project agent may only ask for its own project (`scope=project&project=<its project>`; anything else is `403`). Units: UTF-8 bytes, characters (UTF-16 code units), milliseconds (`count`, `totalMs`, `maxMs`, and a `histogram` over bounds of 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000 and 10000 ms, plus one for longer). `providers` is the providers' own reported usage for sessions active in the range (each session's total; `unknown` counts sessions with none reported). Hive estimates no tokens. `notMeasured` lists what isn't measured. Labels are only Hive's route templates, its own tool names and provider ids (anything else is `(other)`). `project` is matched case-insensitively; a project scope's `dropped` counts only that project's dropped measurements, and `lossesUnattributed: true` says some losses in the range couldn't be attributed to any project (so this one's may be more; no count is given); a workspace scope has `droppedUntracked`, the count of those; `guidance[].skillsUnmeasured` counts delivered skills whose copy couldn't be measured (not in the sizes). `role`, `provider` and `own=1` (a workspace scope: the workspace's own work only) narrow every part, the trend and `providers` alike; `filters` echoes them with `notFiltered`, what they couldn't narrow (requests and tool calls aren't per provider). `coverage` (`rangeMs`, `observedMs`, `observedSince`, `stretches`, and `evictedThrough` when history in the range was removed to keep the metrics file under its size limit) says when Hive was recording this workspace: outside it nothing was seen (no data, not zero). `guidance[]` has `guidanceBytes` (core contract), `customBytes` (the project's additions), `roleBytes` and `personaBytes` (the Assistant's), each with its chars. `providers[]` rows are per provider and `role` (`agent`, `assistant`), with `running`, `contextSessions`/`contextAvgTokens`/`contextMaxTokens`/`contextWindow` (a snapshot, not a sum), and sessions with no usage counted in both `unknown` and `costUnknown`; `providersNote` says why it is empty (scripts have no sessions); `providersUnreadable` (of `providersHosts`) counts session histories that couldn't be read, so `providers` is partial. With `trend=1` the report also has `trend` (`{ start, observedMs, requests, failed, cancelled, requestBytes, responseBytes, toolCalls, toolChars, launches, guidanceBytes }` for every hour of a range up to 2 days, else every day, at most 200) and `trendStep` (`hour` or `day`), for the scope's parts. If the workspace closes or switches while the report is read, it is refused (`400`).

`POST /v1/metrics/mcp` — for the hive MCP bridge only (an agent's or the Assistant's own token; `403` otherwise): `{ calls: [{ tool, mode: "compact"|"detail", ok, chars, bytes, ms }], catalog?: { tools, toolsBytes } }`, at most 50 calls. Returns `{ accepted, refused }`; a malformed entry is refused, not stored. Not itself counted as API traffic.

### Progress

Long runs (test suites, builds) report their progress for the Progress panel, which shows each one with its agent, a bar and the time left, and Hive's taskbar button. A run belongs to whoever starts it, known by the caller's token: a project agent's token makes it that agent's, the Assistant's its own, the workspace token a script's ("Script"). Only that agent may update or finish it; the Assistant only its own; a script any run in its workspace. Another caller's run answers `404`, as an unknown one does. Runs are kept in memory, per workspace: after Hive restarts, or once the workspace closes (or its window opens another), an old id is `404`, which a reporter should ignore.

`POST /v1/progress` — start a run. Returns `{ "id": "…" }`.

```json
{ "title": "e2e: 12 suites", "total": 12, "step": 0, "stepName": "about", "estimateMs": 360000, "command": "npm run e2e" }
```

- `title` (required, up to 120 characters): what is running.
- `total` (1–100000) and `step` (0–`total`): `step` counts **finished** steps. Without `total`, the panel shows a moving bar and the time.
- `stepName` (up to 120): the step running now.
- `estimateMs` (0–7 days): the estimated time **left**, counted from this report. The panel shows "about N min left".
- `command` (up to 200): shown on hover.

`PATCH /v1/progress/{id}` — `{ "total"?, "step"?, "stepName"?, "estimateMs"? }`: an update. Returns `{ "ok": true }`. `total` (1–100000) may be set once, on a run started without one (a command that learns how many steps it has after it started): from then on the panel shows its steps, and a `step` already past it is lowered to it; on a run that has a total, `total` is `409`. Without `estimateMs` the deadline stays where it was (the time left keeps counting down); only a new `estimateMs` moves it. A few updates a second are shown; more are merged, not refused. An update after a run went stale (no report for longer than expected) makes it running again. A finished run is `409`.

`POST /v1/progress/{id}/finish` — `{ "ok": true|false, "summary"?, "exitCode"?, "logPath"? }`: the run passed or failed. Returns `{ "ok": true }`. `summary` (up to 500 characters) shows under a failed run; `exitCode` (a whole number) is the command's exit code, and `logPath` (up to 400) a log or run record it wrote: both show in the run's details in the panel.

At most 5 runs can be open at once per agent (per Assistant, per workspace's scripts), and a workspace keeps at most 30 runs whoever reported them: ended ones make room, oldest first, and when all 30 are open another start is `429`. A request that is refused (`400`) changes nothing. A run with no report for longer than expected goes **stale**: with steps and an estimate, a step's share of the time left plus 2 minutes; with only an estimate, the estimate plus 2 minutes; with neither, 10 minutes. An agent's run also goes stale when the agent stops. Dismissing a stale run in the panel ends it: it leaves the agent's status and the taskbar, and further updates are `409`.

With **Settings → General → Progress panel** off, every call is accepted and ignored: a start returns `{ "id": "…", "ignored": true }`, and updates and finishes `{ "ok": true, "ignored": true }`. A report that was already on its way when the setting was turned off (or off and on again) is ignored the same way, and keeps nothing.

An agent's open run shows in its status (`GET /v1/projects/{name}` agents, and its activity) as `progress`: `{ title, step?, total?, stepName?, etaMs?, stale? }`, `etaMs` being the time left now.

#### Reporting a command: `hive-progress`

Every session Hive starts has `hive-progress` on its `PATH` (cmd, PowerShell and Git Bash), so a command needs no code to report:

```bash
hive-progress [--title "e2e"] -- <command> [args...]
```

It runs the command with its output passed through unchanged and ends with its exit code, and reports it as the agent's run: the title (the command line when none is given), the finish (passed when the exit code is 0, otherwise failed with `exit code N`), and an estimate from how long the same command in the same folder took the last few times it passed (kept in Hive's data, never in the project). With no Hive variables, Hive unreachable or a refused call, it just runs the command, and it never fails because of Hive. `HIVE_PROGRESS=0` turns reporting off.

**Steps.** A command (or any project's test runner) that prints lines like this gets real steps:

```
##hive-progress step=4 total=12 name=carddialog
```

`step` is the step starting now, from 1; `total` how many there are; `name` the rest of the line. A line `##hive-progress log=<path>` names a log or run record the command wrote (the rest of the line); `hive-progress` sends it with the finish, with the command's exit code (`npm run e2e` names its run record, or its logs folder). The lines are taken out of the output. `hive-progress` starts its run at the first step line that gives a total, or after 2 seconds, so a total printed early shows as steps from the start. A run started without one takes the first total printed later (sent once with `PATCH`); a different total after that is ignored, the steps aren't.

Hive's own test runners report the same way (`npm run e2e`, a step per suite; `npm test`, a step per file) when they run in an agent's session.

**Inside `hive-progress`.** The command it runs has `HIVE_PROGRESS_WRAPPED=1`, and the run is the wrapper's: a reporter in it should print step lines rather than start a run of its own, which would be a second row. Another `hive-progress` inside one just runs its command; Hive's own runners print step lines.

Agents use `hive-progress` unasked for commands likely to take over 30 seconds, unless **Settings → General → Agents show long commands in the Progress panel**, or the Progress panel itself, is off: Hive's session guidance tells them which.

### Notifications

`POST /v1/notify` — show a notification in Hive.

```json
{ "title": "Build finished", "message": "All 212 tests passed", "level": "success" }
```

`level` is `info` (default), `success`, `warning` or `error`.

### Events (server-sent events)

`GET /v1/events` — a stream of events as they happen:

```
event: session-status
data: {"type":"session-status","state":{"projectPath":"D:\\work\\api","sessionId":"6f1c…","status":"finished",…}}
```

Event types: `session-status`, `session-exit`, `workspace-changed`, `notes-changed`, `skills-changed`, `tasks-changed` (`{ workspacePath }`: read the board again). Events cover every open workspace, so the Hive Assistant's token is refused here (403); it follows agents with `hive_wait_for_agents`. A project agent's own token gets `session-status` and `session-exit` for its own project's sessions only (another project's carry their session names, which can name their cards); the other events carry no more than a path and come to it as to anyone. A client that stops reading (more than 1 MB of events waiting) is disconnected.

```bash
curl -N -H "Authorization: Bearer $HIVE_API_TOKEN" "$HIVE_API_URL/v1/events"
```

---

## The built-in `hive` MCP server

When **Provide Hive tools to sessions** is on (the default), Hive adds an MCP server named `hive` to every session it starts, whatever its provider. It wraps the API above. Its replies are kept short, since everything a tool returns goes into the agent's context: a change confirms what changed and what the agent can't already know (a new card's number, where a card is now), a listing gives one line per item, and full detail comes from the matching read tool or on request (`hive_list_tasks` with `details: true`, `hive_read_task` with `history: true`, `hive_session_usage` with `days: true`). Structured reads such as `hive_project_status` are compact JSON; notes and handovers are read as their text.

| Tool | Endpoint |
|---|---|
| `hive_list_projects` | `GET /v1/projects?view=short`, a line per project |
| `hive_project_status` | `GET /v1/projects/{name}` |
| `hive_session_usage` | `GET /v1/projects/{name}/usage` (`days=false` unless `days: true`) |
| `hive_list_shared_notes` | `GET /v1/shared`, a path per line |
| `hive_read_shared_note` | `GET /v1/shared/file` |
| `hive_write_shared_note` | `PUT /v1/shared/file` |
| `hive_read_latest_handover` | `GET /v1/shared`, then `GET /v1/shared/file` for the project's newest handover (see below) |
| `hive_create_handover` | `POST /v1/shared/handovers` |
| `hive_notify` | `POST /v1/notify` |
| `hive_list_skills` | `GET /v1/skills`, a line per skill (the session's project's, for an agent) |
| `hive_list_tasks` | `GET /v1/tasks?view=short`, a line per card by column (at most 200 a reply, `offset` for the next; `details: true` for whole cards) |
| `hive_read_task` | `GET /v1/tasks/{n}?history=false` (`history: true` for its history, `comments: n` for its newest n comments; `latestComment: true`: `/comments/latest`) |
| `hive_create_task` | `POST /v1/tasks` (the session's project by default), short reply |
| `hive_update_task` | `PATCH /v1/tasks/{n}` (with `comment`), short reply |
| `hive_reorder_tasks` | `POST /v1/tasks/reorder`, short reply |
| `hive_wait_for_tasks` | `POST /v1/tasks/wait` (`wake: true` for a card watch, `cancel: true` to end it), a line per change |

Tools default to the session's own project, so an agent can simply say *"create a handover"*. The board tools send the agent's id and project, so a card's history and comments name the agent.

The Hive Assistant's `hive` server always runs (even with this setting or the Agent API off) and has more tools, as far as its control level allows:

| Tool | Endpoint | Control |
|---|---|---|
| `hive_list_providers` | `GET /v1/providers` | any |
| `hive_agent_activity` | `GET /v1/projects/{name}/agents/{agent}/activity` (`detail: true`: `?detail=true`) | any |
| `hive_wait_for_agents` | `POST /v1/agents/wait` (50 seconds by default; it calls again to keep waiting) | any |
| `hive_activate_project` | `POST /v1/projects/{name}/activate` | Control agents |
| `hive_add_agent` | `POST /v1/projects/{name}/agents` | Control agents |
| `hive_update_agent` | `PATCH /v1/projects/{name}/agents/{agent}` | Control agents |
| `hive_start_agent` | `POST /v1/projects/{name}/agents/{agent}/start` | Control agents |
| `hive_stop_agent` | `POST /v1/projects/{name}/agents/{agent}/stop` | Control agents |
| `hive_prompt_agent` | `POST /v1/projects/{name}/agents/{agent}/prompt` | Control agents |
| `hive_hand_over` | `POST /v1/projects/{name}/handover` | Control agents |
| `hive_start_task` | `POST /v1/tasks/{n}/start` | Control agents |
| `hive_create_project` | `POST /v1/projects` | Control agents and create projects |

It also has the board tools above; Claude Code runs `hive_create_task`, `hive_update_task` and `hive_reorder_tasks` without asking from Control agents up. Claude Code runs these without asking (they are Hive's own, and limited by the control level); Codex gets a 15-minute tool timeout for them, since waiting and asking the user can take minutes.

A handover belongs to a project when its file name is `handovers/<date>-<project>-<title>.md`, as `hive_create_handover` writes it. When another project's name begins the same way (`hive` and `hive-website`), the `**Project:**` line at the top of the handover decides.

The server's instructions (for Codex, which doesn't show MCP server instructions to the model, Hive passes the same text as developer instructions) are Hive's short session contract: that handovers, shared notes, other projects and the board are Hive's and are reached with these tools rather than by searching the file system, which of Hive's skills covers which workflow (`work-on-card`, `review-agent-work`, and `coordinate-agents` for the Assistant), and the board's boundaries in a line, which hold even when a skill is missing. When the project has a handover, the instructions also name the latest one, so a new session knows it is there from the start. The tools' descriptions say what each takes, changes and answers; how to carry out a workflow is the skills'. `GET /v1/status` gives the revision of this guidance, and `GET /v1/projects/{name}` each running agent's `launched` revisions (its guidance and skills at launch).

The server is a small Node script bundled with Hive and run by Hive's own executable, so nothing else needs to be installed.

## Security notes

- The API binds to `127.0.0.1` only; it is not reachable from other machines.
- Any local program that can read the token can use the API. Regenerate the token in Settings if it leaks.
- Session input is off by default because it lets one agent drive another project's session.
- The Hive Assistant's token is separate, replaced each time it starts, and limited to its workspace and to Settings → Assistant → Control.
- Shared-note paths are confined to `.hive/shared`.
