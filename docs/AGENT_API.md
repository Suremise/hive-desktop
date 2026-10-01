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

Sessions started from Hive receive these environment variables, so an agent can call the API with no configuration:

| Variable | Value |
|---|---|
| `HIVE_API_URL` | Base URL of the API |
| `HIVE_API_TOKEN` | Bearer token |
| `HIVE_API_TOKEN_FILE` | Path of the file holding the token (`agent-api.json`), which stays current if the token is regenerated |
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
| 403 | Blocked (cross-origin request, a disabled feature such as session input, or a change only the user makes, such as moving a card to Done) |
| 404 | Unknown route, project, card or file |
| 409 | Conflict with the current state (no workspace open, the project has no agents, agent already running or starting or busy, conversation open in another agent, session archived, provider turned off or not installed…) |
| 500 | Unexpected error; details are in Hive's log |
| 413 | Body larger than 2 MB |

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

`GET /v1/status` — app version, each provider's install info, the request's workspace (`null` if several are open and none is named), every open workspace (`workspaces`) and running sessions.

```json
{
  "app": { "name": "Hive", "version": "0.2.0" },
  "agent": { "provider": "claude-code", "found": true, "version": "2.1.283", "source": "PATH", "updateAvailable": false, "loggedIn": true },
  "providers": [
    { "provider": "claude-code", "found": true, "version": "2.1.283", "source": "PATH", "updateAvailable": false, "loggedIn": true },
    { "provider": "codex", "found": true, "version": "0.159.0", "source": "PATH", "updateAvailable": false, "loggedIn": true }
  ],
  "workspace": { "name": "work", "path": "D:\\work" },
  "workspaces": [{ "name": "work", "path": "D:\\work" }],
  "liveSessions": [{ "workspace": "work", "project": "api", "agent": "Agent 1", "provider": "claude-code", "sessionId": "6f1c…", "status": "working" }]
}
```

A workspace's Hive Assistant is listed in `liveSessions` with `"project": null` and `"agent": "Assistant"`. It isn't a project, so the project endpoints don't reach it.

`agent` is Claude Code's install info, kept for scripts written for 0.1; use `providers`.

### Workspace

`GET /v1/workspace` — `{ name, path, config }` for the request's workspace, where `config` lists the workspace-enabled MCP servers, or `null` if no workspace is open.

`GET /v1/workspaces` — every open workspace (one per window): `[{ name, path }]`.

### Projects

`GET /v1/projects` — every project in the request's workspace; with several windows open and none named, every open workspace's projects. Each has `workspace` (its workspace's name). Projects hidden or removed from Hive (Project → Remove Project…) aren't listed and can't be named.

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
    { "id": "a-3f9c01d2", "name": "Agent 1", "provider": "claude-code", "branch": null, "worktree": null, "status": "waiting", "sessionId": "6f1c…", "statusMessage": "Claude needs your permission to use Bash" },
    { "id": "a-7b21e4aa", "name": "Reviewer", "provider": "codex", "branch": "hive/reviewer", "worktree": "D:\\work.worktrees\\api\\reviewer", "status": "stopped", "sessionId": null, "statusMessage": null }
  ],
  "settings": { "model": "opus", "effort": "inherit", "permissionMode": "inherit", "chime": "inherit", "skills": { "disabled": [] }, "mcp": { "disabled": [] } }
}
```

`status` is one of `stopped`, `starting`, `ready`, `working`, `waiting`, `background`, `finished`, `error`. **background** means the agent's turn has ended but background tasks it started (a test run, say) are still running, and it carries on by itself when they end (Claude Code). Each agent also has `backgroundTasks`, how many of those are running; Codex agents count theirs but stay `finished`, since Codex isn't told when they end. `provider` is the CLI the agent runs (`claude-code` or `codex`); each agent chooses its own, so a project can mix them. `settings` is the project's configuration, with per-provider overrides under `providers`. A project has up to twelve agents, all equal, in the order they were added; a new project has none. The top-level `status`, `sessionId` and `statusMessage` are the first running agent's, and `agents` lists every agent. Agent ids are random (`a-…`) and never reused. Endpoints that act on a session take an optional `agent` — its `id` or name. Without one, the project's only agent is used; a project with several answers 400 (say which), one with none 409.

`POST /v1/projects/{name}/activate` — mark the project as being worked on.

`POST /v1/projects/{name}/deactivate` — mark it as not being worked on (fails with 409 while a session is running).

### Sessions

`GET /v1/projects/{name}/sessions` — Hive and external sessions for the project, newest first, each with usage and a re-cache estimate.

`POST /v1/projects/{name}/sessions` — start a session. Body (all optional):

```json
{ "resumeId": "6f1c…", "name": "Fix login bug", "agent": "Reviewer" }
```

Omit `resumeId` to start a new session. Returns the live session state (which includes `agentId` and `cwd`, the folder it runs in). Fails with 409 if the agent is already running or starting, if that conversation is already open in another agent, or if it ran in a different folder than the agent works in, or if the project has no agents yet (agents are added in Hive); with 400 if `resumeId` isn't a session ID.

`POST /v1/projects/{name}/stop[?agent=…]` — stop one agent's session, or every running agent of the project when `agent` is omitted.

`GET /v1/projects/{name}/usage[?sessionId=…][&agent=…]` — usage for the agent's live session (see above for which agent), else the most recent Hive session, or the one given. `days` breaks it down by local calendar day (`YYYY-MM-DD`): tokens, requests, prompts, compactions and that day's API-equivalent cost (`costUsd`, `costEstimated`). Session lists include the same.

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

`GET /v1/providers` — the coding-agent providers: whether each is turned on and installed (`enabled`, `installed`, `version`, `problem`), whether it's the default, and the `models`, `efforts` and `modes` an agent can use.

`GET /v1/projects/{name}/agents/{agent}/activity` — what one agent is doing: `status`, `statusMessage` and `backgroundTasks`, `transcriptMB` (its conversation's transcript, or null) and `transcriptWarnMB` (the size past which Hive flags it, or null), `currentTask` (its last prompt), `latestReply`, `recentTools` (tool calls since that prompt), `lockedFiles` (relative to its folder), its branch and worktree, its session, and `userTypedSecondsAgo` (when the user last typed in its terminal). `{agent}` is the agent's name or id.

`POST /v1/agents/wait` — waits until agents stop working (finished, idle, waiting for the user or stopped), or `timeoutSeconds` (5–600, default 300). An agent waiting on its background tasks (`background`) still counts as working, since it carries on when they end; `"ignoreBackground": true` stops waiting at the end of its turn instead. Without `agents`, it waits for every busy agent in the workspace.

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
| `POST /v1/projects/{name}/agents` | Control agents | Adds an agent: `name`, `provider`, `model`, `effort`, `mode`, `worktree` (with `branch`, `base`); `start` starts it, and `prompt` starts it on that task, given on the CLI's command line |
| `PATCH /v1/projects/{name}/agents/{agent}` | Control agents | Changes `name`, `provider`, `model`, `effort` or `mode` (empty clears an override) |
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

The workspace's board: cards in four columns, `todo`, `doing`, `review` and `done`, kept in `.hive/tasks`. Every caller can read and change cards; **moving a card into or out of `done` is the user's**, so other callers get `403` (the Hive Assistant's request instead asks the user in its panel and waits for the answer: `409` if they say no). Archived cards can't be changed (`403`), and archiving and deleting are only in Hive.

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
  "archived": false, "createdAt": "…", "createdBy": "Assistant", "updatedAt": "…"
}
```

`agent` is the agent the card is given to, with what it is doing now (`status` is `removed` if the agent no longer exists), or `null`. `project` is the project's folder name, or `""` for a card about the workspace. `by` and `createdBy` say who: `You`, `Assistant`, an agent (`"Agent 1 (web)"`, when its `hive` tools made the change) or `Agent API` (any other caller).

`GET /v1/tasks/{n}` — one card (`#12` or `12`).

`POST /v1/tasks` — add a card. `title` is required; `description`, `project`, `agent` (name or id, in that project), `column` (not `done`), `labels`, `blocked` (a reason), `blockedBy` and `links` (card numbers) are optional.

```json
{ "title": "Add tests for the redirect", "project": "web", "description": "…", "labels": ["tests"], "blockedBy": [12] }
```

`PATCH /v1/tasks/{n}` — change a card and/or comment on it: any of `title`, `description`, `project` (its agent is cleared unless `agent` is given), `agent` (empty takes it from its agent), `column`, `before` (the card it goes in front of in its column; `null` the end), `labels`, `blocked` (empty clears it), `blockedBy`, `links`, and `comment`.

```json
{ "column": "review", "comment": "Fixed in auth/callback.ts; tests pass." }
```

`POST /v1/tasks/{n}/comments` `{ "text" }` — add a comment.

`POST /v1/tasks/{n}/start` — **the Hive Assistant only** (Control agents): gives the card to an agent of its project, with the card as its prompt, and moves it to `doing`. `agent` (name or id): an existing agent that is stopped (a new conversation) or idle (its next message); `409` if it is busy. Without `agent`, Hive adds one: `name`, `provider`, and `worktree: true` for its own git worktree. Returns `{ ok, agent, added, card }`.

### Skills and MCP

`GET /v1/skills[?project=name]` — Hive skills (every agent gets them), each provider's user (`level: "machine"`) and plugin skills, plus the project's local skills if a project is given: `{ name, description, level, path, provider?, plugin?, bundled? }`. `bundled` is `same` or `changed` for Hive skills that ship with Hive. Skills have no enabled flag since 0.2.

`GET /v1/mcp` — MCP servers deployed to the workspace: `{ name, description, globallyEnabled, error }`.

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

Event types: `session-status`, `session-exit`, `workspace-changed`, `notes-changed`, `skills-changed`, `tasks-changed` (`{ workspacePath }`: read the board again). Events cover every open workspace, so the Hive Assistant's token is refused here (403); it follows agents with `hive_wait_for_agents`. A client that stops reading (more than 1 MB of events waiting) is disconnected.

```bash
curl -N -H "Authorization: Bearer $HIVE_API_TOKEN" "$HIVE_API_URL/v1/events"
```

---

## The built-in `hive` MCP server

When **Provide Hive tools to sessions** is on (the default), Hive adds an MCP server named `hive` to every session it starts, whatever its provider. It wraps the API above:

| Tool | Endpoint |
|---|---|
| `hive_list_projects` | `GET /v1/projects` |
| `hive_project_status` | `GET /v1/projects/{name}` |
| `hive_session_usage` | `GET /v1/projects/{name}/usage` |
| `hive_list_shared_notes` | `GET /v1/shared` |
| `hive_read_shared_note` | `GET /v1/shared/file` |
| `hive_write_shared_note` | `PUT /v1/shared/file` |
| `hive_read_latest_handover` | `GET /v1/shared`, then `GET /v1/shared/file` for the project's newest handover (see below) |
| `hive_create_handover` | `POST /v1/shared/handovers` |
| `hive_notify` | `POST /v1/notify` |
| `hive_list_skills` | `GET /v1/skills` |
| `hive_list_tasks` | `GET /v1/tasks` |
| `hive_read_task` | `GET /v1/tasks/{n}` |
| `hive_create_task` | `POST /v1/tasks` (the session's project by default) |
| `hive_update_task` | `PATCH /v1/tasks/{n}` (with `comment`) |

Tools default to the session's own project, so an agent can simply say *"create a handover"*. The board tools send the agent's id and project, so a card's history and comments name the agent.

The Hive Assistant's `hive` server always runs (even with this setting or the Agent API off) and has more tools, as far as its control level allows:

| Tool | Endpoint | Control |
|---|---|---|
| `hive_list_providers` | `GET /v1/providers` | any |
| `hive_agent_activity` | `GET /v1/projects/{name}/agents/{agent}/activity` | any |
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

It also has the board tools above; Claude Code runs `hive_create_task` and `hive_update_task` without asking from Control agents up. Claude Code runs these without asking (they are Hive's own, and limited by the control level); Codex gets a 15-minute tool timeout for them, since waiting and asking the user can take minutes.

A handover belongs to a project when its file name is `handovers/<date>-<project>-<title>.md`, as `hive_create_handover` writes it. When another project's name begins the same way (`hive` and `hive-website`), the `**Project:**` line at the top of the handover decides.

The server's instructions (for Codex, which doesn't show MCP server instructions to the model, Hive passes the same text as developer instructions) tell the agent that handovers and shared notes live in the workspace and should be read with these tools rather than by searching the file system. When the project has a handover, the instructions also name the latest one, so a new session knows it is there from the start.

The server is a small Node script bundled with Hive and run by Hive's own executable, so nothing else needs to be installed.

## Security notes

- The API binds to `127.0.0.1` only; it is not reachable from other machines.
- Any local program that can read the token can use the API. Regenerate the token in Settings if it leaks.
- Session input is off by default because it lets one agent drive another project's session.
- The Hive Assistant's token is separate, replaced each time it starts, and limited to its workspace and to Settings → Assistant → Control.
- Shared-note paths are confined to `.hive/shared`.
