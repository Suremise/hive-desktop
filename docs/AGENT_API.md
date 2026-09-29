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
| `HIVE_PROJECT` | Name of the project the session belongs to |
| `HIVE_PROJECT_PATH` | Full path of the project |
| `HIVE_WORKSPACE` | Full path of the workspace |
| `HIVE_SESSION_ID` | Claude Code session ID |

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
| 400 | Invalid request (missing field, bad JSON) |
| 401 | Missing or wrong token |
| 403 | Blocked (cross-origin request, or a disabled feature such as session input) |
| 404 | Unknown route, project or file |
| 409 | Conflict with the current state (no workspace open, session already running…) |
| 413 | Body larger than 2 MB |

---

## Endpoints

### Health

`GET /v1/health` — no token required.

```json
{ "ok": true, "app": "Hive", "version": "0.1.0" }
```

### Status

`GET /v1/status` — app version, Claude Code install info, the open workspace and running sessions.

```json
{
  "app": { "name": "Hive", "version": "0.1.0" },
  "agent": { "found": true, "version": "2.1.283", "source": "PATH", "updateAvailable": false, "loggedIn": true },
  "workspace": { "name": "work", "path": "D:\\work" },
  "liveSessions": [{ "project": "api", "agent": "Agent 1", "sessionId": "6f1c…", "status": "working" }]
}
```

### Workspace

`GET /v1/workspace` — `{ name, path, config }` where `config` lists globally enabled skills and MCP servers, or `null` if no workspace is open.

### Projects

`GET /v1/projects` — every project in the workspace.

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
    { "id": "main", "name": "Agent 1", "branch": null, "worktree": null, "status": "waiting", "sessionId": "6f1c…", "statusMessage": "Claude needs your permission to use Bash" },
    { "id": "a2", "name": "Reviewer", "branch": "hive/reviewer", "worktree": "D:\\work.worktrees\\api\\reviewer", "status": "stopped", "sessionId": null, "statusMessage": null }
  ],
  "settings": { "model": "opus", "effort": "inherit", "permissionMode": "inherit", "chime": "inherit", "skills": { "disabled": [] }, "mcp": { "disabled": [] } }
}
```

`status` is one of `stopped`, `starting`, `ready`, `working`, `waiting`, `finished`, `error`. A project can have up to four agents; the top-level `status`, `sessionId` and `statusMessage` are Agent 1's (or, when it isn't running, the first running agent's), and `agents` lists every agent. Endpoints that act on a session take an optional `agent` — its `id` or name — and default to Agent 1.

`POST /v1/projects/{name}/activate` — mark the project as being worked on.

`POST /v1/projects/{name}/deactivate` — mark it as not being worked on (fails with 409 while a session is running).

### Sessions

`GET /v1/projects/{name}/sessions` — Hive and external sessions for the project, newest first, each with usage and a re-cache estimate.

`POST /v1/projects/{name}/sessions` — start a session. Body (all optional):

```json
{ "resumeId": "6f1c…", "name": "Fix login bug", "agent": "Reviewer" }
```

Omit `resumeId` to start a new session. Returns the live session state (which includes `agentId` and `cwd`, the folder it runs in). Resuming fails if that conversation is already open in another agent, or if it ran in a different folder than the agent works in.

`POST /v1/projects/{name}/stop[?agent=…]` — stop one agent's session, or every running agent of the project when `agent` is omitted.

`GET /v1/projects/{name}/usage[?sessionId=…][&agent=…]` — usage for the agent's live session (Agent 1 by default; or the most recent Hive session, or the one given).

```json
{
  "sessionId": "6f1c…",
  "title": "Fix login bug",
  "model": "claude-opus-5-5",
  "inputTokens": 1204,
  "outputTokens": 48211,
  "cacheWriteTokens": 190233,
  "cacheReadTokens": 2811093,
  "contextTokens": 84211,
  "requests": 57,
  "compactions": [{ "timestamp": "…", "trigger": "auto", "preTokens": 968490, "postTokens": 14813 }],
  "cacheTtlSeconds": 3600,
  "lastActivity": "2026-09-28T12:30:00Z"
}
```

`POST /v1/projects/{name}/input` — type into the running session. **Disabled by default**; enable *Allow sending input to sessions* in Settings → Agent API.

```json
{ "text": "Run the tests and fix any failures", "submit": true, "agent": "Agent 2" }
```

`submit` (default `true`) presses Enter after the text.

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

Returns `{ ok: true, path }`. Hive shows a notification with a link to the note.

### Skills and MCP

`GET /v1/skills[?project=name]` — Hive, Machine and Plugin skills, plus Local skills for the project if given.

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

Event types: `session-status`, `session-exit`, `workspace-changed`, `notes-changed`, `skills-changed`.

```bash
curl -N -H "Authorization: Bearer $HIVE_API_TOKEN" "$HIVE_API_URL/v1/events"
```

---

## The built-in `hive` MCP server

When **Provide Hive tools to sessions** is on (the default), Hive adds an MCP server named `hive` to every session it starts. It wraps the API above:

| Tool | Endpoint |
|---|---|
| `hive_list_projects` | `GET /v1/projects` |
| `hive_project_status` | `GET /v1/projects/{name}` |
| `hive_session_usage` | `GET /v1/projects/{name}/usage` |
| `hive_list_shared_notes` | `GET /v1/shared` |
| `hive_read_shared_note` | `GET /v1/shared/file` |
| `hive_write_shared_note` | `PUT /v1/shared/file` |
| `hive_read_latest_handover` | `GET /v1/shared`, then `GET /v1/shared/file` for the newest `handovers/<date>-<project>-*.md` |
| `hive_create_handover` | `POST /v1/shared/handovers` |
| `hive_notify` | `POST /v1/notify` |
| `hive_list_skills` | `GET /v1/skills` |

Tools default to the session's own project, so an agent can simply say *"create a handover"*.

The server's instructions tell the agent that handovers and shared notes live in the workspace and should be read with these tools rather than by searching the file system. When the project has a handover, the instructions also name the latest one, so a new session knows it is there from the start.

The server is a small Node script bundled with Hive and run by Hive's own executable, so nothing else needs to be installed.

## Security notes

- The API binds to `127.0.0.1` only; it is not reachable from other machines.
- Any local program that can read the token can use the API. Regenerate the token in Settings if it leaks.
- Session input is off by default because it lets one agent drive another project's session.
- Shared-note paths are confined to `.hive/shared`.
