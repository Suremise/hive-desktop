/**
 * Hive MCP server (stdio). Launched by Claude Code for sessions started from Hive, using Hive's own
 * executable with ELECTRON_RUN_AS_NODE=1. It exposes the Hive Agent API as MCP tools.
 *
 * Self-contained on purpose: only Node built-ins, so it runs from the packaged app without extra files.
 *
 * Replies are lean (shared/toolReplies.ts): every character goes into the agent's context and is paid for again on
 * each later turn. A change confirms what changed, a listing returns a short line per item, full detail comes on
 * request; structured reads are compact JSON. Each tool's description says what its reply holds and how to get more.
 */
import { appendFileSync, readFileSync } from 'fs'
import { createInterface } from 'readline'
import { hiveInstructions, projectHandovers, withLatestHandover } from '../../shared/hiveGuidance'
import { ASSISTANT_ONLY_TOOLS, assistantTools } from '../../shared/assistantTools'
import { COLUMN_IDS } from '../../shared/tasks'
import { MAX_ROWS, changedText, createdText, noteText, notesListText, noteWrittenText, projectListText, reorderText, settingChangedText, settingListText, settingText, skillListText, taskListText, taskWaitText, type NoteEntry, type ProjectRow, type SettingDetail, type SettingRow, type SkillRow, type TaskChange, type TaskReorder, type TaskRow } from '../../shared/toolReplies'

const VERSION = '1.0.0'
const API = (process.env.HIVE_API_URL || 'http://127.0.0.1:47821').replace(/\/$/, '')
const PROJECT = process.env.HIVE_PROJECT || ''
/** The session's workspace: with several Hive windows open, the API answers for this one. */
const WORKSPACE = process.env.HIVE_WORKSPACE || ''
/** The Hive Assistant's session gets the tools to run agents, as far as its control level allows. */
const ASSISTANT = process.env.HIVE_ROLE === 'assistant'
const CONTROL = process.env.HIVE_ASSISTANT_CONTROL || 'projects'
/** Settings → Assistant → Control → Change settings: hive_update_setting is offered only then. */
const CHANGE_SETTINGS = process.env.HIVE_ASSISTANT_SETTINGS === '1'

function token(): string {
  const t = process.env.HIVE_API_TOKEN
  // The Assistant uses its own token (from its file): HIVE_API_TOKEN, which a CLI hands on from its own
  // environment, would be the Agent API's, and Hive would take its calls for an ordinary caller's.
  if (t && !t.includes('${') && !ASSISTANT) return t
  try {
    const file = process.env.HIVE_API_TOKEN_FILE
    if (file) return JSON.parse(readFileSync(file, 'utf8')).token ?? ''
  } catch {
    // fall through
  }
  return ''
}

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', ...(WORKSPACE ? { 'X-Hive-Workspace': encodeURIComponent(WORKSPACE) } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let data: unknown = text
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    // keep text
  }
  if (!res.ok) throw new Error(typeof data === 'object' && data && 'error' in data ? String((data as { error: unknown }).error) : `HTTP ${res.status}`)
  return data
}

const projectArg = {
  type: 'string',
  description: `Project name. Defaults to the current project${PROJECT ? ` ("${PROJECT}")` : ''}.`
}
const agentArg = { type: 'string', description: "The agent's name (e.g. \"Agent 2\") or id. Optional when the project has one agent." }
const settingsArgs = {
  provider: { type: 'string', description: 'Provider id (hive_list_providers). Default: the project\'s default provider.' },
  model: { type: 'string', description: 'Model (hive_list_providers). Empty follows the project.' },
  effort: { type: 'string', description: 'Effort level (hive_list_providers). Empty follows the project.' },
  mode: { type: 'string', description: 'Permission mode (hive_list_providers). Empty follows the project.' },
  context200k: { type: 'string', enum: ['on', 'off', ''], description: "Use a 200K context window instead of the model's 1M one, for providers with context200k (hive_list_providers). Empty follows the project." }
}
const agentPath = (a: Record<string, any>): string => `/v1/projects/${proj(a)}/agents/${enc(a.agent || '')}`
/** Which agent is changing a card, for its history (Hive fills in the name). */
const columnArg = { type: 'string', enum: [...COLUMN_IDS] }
const cardsArg = (what: string) => ({ type: 'array', items: { type: 'number' }, description: what })

interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run: (args: Record<string, any>) => Promise<unknown>
}

interface NoteFile {
  relPath: string
  name: string
  isDir: boolean
  children?: NoteFile[]
  modified?: string
}

/** This project's handovers, newest first (see projectHandovers). */
async function handovers(project?: string): Promise<NoteFile[]> {
  const tree = (await api('GET', '/v1/shared')) as NoteFile[]
  let all: string[] = []
  try {
    all = ((await api('GET', '/v1/projects')) as { name: string }[]).map((x) => x.name)
  } catch {
    // Without the project list, the file name alone decides.
  }
  return projectHandovers(tree, project, all, async (relPath) => ((await api('GET', `/v1/shared/file?path=${enc(relPath)}`)) as { content: string }).content)
}

const enc = (s: string): string => encodeURIComponent(s)
const proj = (a: Record<string, any>): string => {
  const p = a.project || PROJECT
  if (!p) throw new Error('project is required')
  return enc(p)
}

const tools: Tool[] = [
  {
    name: 'hive_list_projects',
    description: 'List all projects in the open Hive workspace: one line each with whether it is on, its branch, and its agents with their provider and status (working, waiting, idle, stopped). hive_project_status gives one project in full.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => projectListText((await api('GET', '/v1/projects?view=short')) as ProjectRow[])
  },
  {
    name: 'hive_project_status',
    description: "One project's status and settings, and its agents (each in the project folder or a git worktree) with their ids, branches and running sessions, as JSON.",
    inputSchema: { type: 'object', properties: { project: projectArg } },
    run: (a) => api('GET', `/v1/projects/${proj(a)}`)
  },
  {
    name: 'hive_session_usage',
    description: 'Token usage, cache use and compaction history for a project session (the live one by default), as JSON. days=true adds its usage by day.',
    inputSchema: { type: 'object', properties: { project: projectArg, sessionId: { type: 'string' }, days: { type: 'boolean' } } },
    run: (a) => {
      const q = [a.sessionId ? `sessionId=${enc(a.sessionId)}` : '', a.days ? '' : 'days=false'].filter(Boolean).join('&')
      return api('GET', `/v1/projects/${proj(a)}/usage${q ? `?${q}` : ''}`)
    }
  },
  {
    name: 'hive_list_shared_notes',
    description: 'List the shared notes, instructions and handovers stored in the workspace (.hive/shared): one path per line, with the date it last changed. hive_read_shared_note reads one.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => notesListText((await api('GET', '/v1/shared')) as NoteEntry[])
  },
  {
    name: 'hive_read_shared_note',
    description: 'Read a shared note by its path relative to .hive/shared (e.g. "handovers/2026-01-01-auth.md"), with its revision.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: async (a) => noteText((await api('GET', `/v1/shared/file?path=${enc(a.path)}`)) as { path: string; content: string; revision?: string })
  },
  {
    name: 'hive_write_shared_note',
    description: "Create or overwrite a shared note (markdown) in .hive/shared; append=true adds to the end. expectedRevision (from reading it): written only if the note hasn't changed since, else refused with its current revision. Replies with the path, size and new revision.",
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean' }, expectedRevision: { type: 'string' } },
      required: ['path', 'content']
    },
    run: async (a) => {
      // Passed on as given: Hive refuses an empty or non-string revision rather than writing unguarded.
      const body = { content: a.content, append: !!a.append, ...(a.expectedRevision !== undefined ? { expectedRevision: a.expectedRevision } : {}) }
      const r = (await api('PUT', `/v1/shared/file?path=${enc(a.path)}`, body)) as { path: string; revision?: string }
      return noteWrittenText(r.path, String(a.content ?? '').length, !!a.append, r.revision)
    }
  },
  {
    name: 'hive_read_latest_handover',
    description: 'The newest handover for a project (this one by default), as its text.',
    inputSchema: { type: 'object', properties: { project: projectArg } },
    run: async (a) => {
      const project = a.project || PROJECT
      const [latest] = await handovers(project)
      if (!latest) return `No handover found for ${project ? `"${project}"` : 'the workspace'}. Use hive_list_shared_notes to see all shared notes.`
      return noteText((await api('GET', `/v1/shared/file?path=${enc(latest.relPath)}`)) as { path: string; content: string })
    }
  },
  {
    name: 'hive_create_handover',
    description: "Save a handover in the workspace's shared notes for a project (this one by default). Hive writes its header (title, project, author, session, date): content starts at the first heading. Replies with its path.",
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, content: { type: 'string' }, project: projectArg },
      required: ['title', 'content']
    },
    // Hive writes the header (project, author, session, date) from the agent these tools belong to.
    run: async (a) => {
      const r = (await api('POST', '/v1/shared/handovers', { title: a.title, content: a.content, project: a.project || PROJECT, ...(process.env.HIVE_AGENT_ID ? { agent: process.env.HIVE_AGENT_ID, agentProject: PROJECT } : {}) })) as { path: string }
      // Its path in the shared notes, as hive_read_shared_note takes it.
      return `Handover saved as ${r.path.replace(/\\/g, '/').replace(/^.*\/\.hive\/shared\//, '')}.`
    }
  },
  {
    name: 'hive_notify',
    description: 'Show the user a notification in Hive. Levels: info (default), success, warning, error.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, message: { type: 'string' }, level: { type: 'string', enum: ['info', 'success', 'warning', 'error'] } },
      required: ['title']
    },
    run: async (a) => {
      await api('POST', '/v1/notify', { title: a.title, message: a.message, level: a.level, source: PROJECT || 'agent' })
      return 'Notification shown.'
    }
  },
  {
    name: 'hive_list_providers',
    description: 'The coding-agent providers: whether each is on and installed, and the models, effort levels and permission modes to use when adding or changing agents (JSON).',
    inputSchema: { type: 'object', properties: {} },
    run: () => api('GET', '/v1/providers')
  },
  {
    name: 'hive_agent_activity',
    description: "What one agent is doing: status, background tasks, transcript size (transcriptMB; past transcriptWarnMB it slows down, so suggest a handover to a new conversation), the start of the task it was last given and of its latest reply, its last tool calls this turn, locked files, and how long ago the user typed in its terminal. Texts are clipped: the task to 300 characters, the reply to 500, the last 3 tool calls (100 characters each); detail=true raises that to 2000, 3000 and the last 10 calls (200 each). toolCalls is how many calls this turn had, and clipped gives the whole length of a text that was cut. Hive gives no more of a conversation than that: for the rest, the card's comments or the agent itself.",
    inputSchema: { type: 'object', properties: { project: projectArg, agent: agentArg, detail: { type: 'boolean' } } },
    run: (a) => api('GET', `${agentPath(a)}/activity${a.detail ? '?detail=true' : ''}`)
  },
  {
    name: 'hive_wait_for_agents',
    description:
      "Wait until agents stop working (finished, idle, or waiting for the user), up to timeoutSeconds (default 50, at most 600); without agents, every busy agent in the workspace. An agent waiting on background tasks it started (status background) still counts as working; ignoreBackground=true stops at the end of its turn. An agent watching cards (status watching, statusMessage what for) isn't waited for: it carries on when its card changes. Replies with each one's status and background tasks, and whether it timed out: call again to keep waiting.",
    inputSchema: {
      type: 'object',
      properties: {
        agents: { type: 'array', items: { type: 'object', properties: { project: { type: 'string' }, agent: { type: 'string' } }, required: ['project'] } },
        timeoutSeconds: { type: 'number' },
        ignoreBackground: { type: 'boolean' }
      }
    },
    run: (a) => api('POST', '/v1/agents/wait', { agents: a.agents, timeoutSeconds: a.timeoutSeconds ?? 50, ignoreBackground: a.ignoreBackground === true })
  },
  {
    name: 'hive_create_project',
    description: 'Create a project: a new folder in the workspace, turned on. Only when the user asked for one.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Folder name.' } }, required: ['name'] },
    run: async (a) => {
      const p = (await api('POST', '/v1/projects', { name: a.name })) as { name: string }
      return `Created the project ${p.name} (on). It has no agents yet: add one with hive_add_agent.`
    }
  },
  {
    name: 'hive_activate_project',
    description: 'Turn a project on (it shows under Working On in Hive). Starting an agent does this too.',
    inputSchema: { type: 'object', properties: { project: projectArg }, required: ['project'] },
    run: async (a) => {
      const p = (await api('POST', `/v1/projects/${proj(a)}/activate`)) as { name: string }
      return `${p.name} is on.`
    }
  },
  {
    name: 'hive_add_agent',
    description:
      "Add an agent to a project. It works in the project folder, or with worktree in its own git worktree and branch (only if the user asked for one or agreed). With prompt it starts at once on that task; with start and no prompt it starts idle. Replies with its name, id, provider, folder and status.",
    inputSchema: {
      type: 'object',
      properties: {
        project: projectArg,
        name: { type: 'string', description: 'Default: "Agent n".' },
        ...settingsArgs,
        worktree: { type: 'boolean' },
        branch: { type: 'string', description: 'Worktree branch (default hive/<name>).' },
        base: { type: 'string', description: 'Branch the worktree starts from (default the current one).' },
        start: { type: 'boolean' },
        prompt: { type: 'string', description: 'The first task, in full: it reads nothing else from you.' }
      },
      required: ['project']
    },
    run: async (a) => {
      const r = (await api('POST', `/v1/projects/${proj(a)}/agents`, { name: a.name, provider: a.provider, model: a.model, effort: a.effort, mode: a.mode, context200k: a.context200k, worktree: a.worktree, branch: a.branch, base: a.base, start: a.start, prompt: a.prompt })) as {
        agent: { id: string; name: string; worktree?: { path: string; branch: string } | null }
        project: { name: string; agents: { id: string; provider: string; status: string }[] }
      }
      const now = r.project.agents.find((x) => x.id === r.agent.id)
      const where = r.agent.worktree ? `its worktree ${r.agent.worktree.path} (branch ${r.agent.worktree.branch})` : 'the project folder'
      return `Added ${r.agent.name} (id ${r.agent.id}) to ${r.project.name}: ${now?.provider ?? 'its provider'}, in ${where}, ${now?.status ?? 'stopped'}.`
    }
  },
  {
    name: 'hive_update_agent',
    description: "Change an agent's name, provider, model, effort, permission mode or 200K context. A running agent takes the change when restarted; its provider changes only while it is stopped.",
    inputSchema: { type: 'object', properties: { project: projectArg, agent: agentArg, name: { type: 'string' }, ...settingsArgs }, required: ['project', 'agent'] },
    run: (a) => api('PATCH', agentPath(a), { name: a.name, provider: a.provider, model: a.model, effort: a.effort, mode: a.mode, context200k: a.context200k })
  },
  {
    name: 'hive_start_agent',
    description: "Start a stopped agent: a new conversation, or resume=true for its last one; with prompt, on that task. For work on a card, use hive_start_task instead (it moves the card and gives it to the agent). A folder new to the CLI first asks the user to trust it (the agent shows as waiting): tell the user. Replies with its status and session id.",
    inputSchema: { type: 'object', properties: { project: projectArg, agent: agentArg, resume: { type: 'boolean' }, prompt: { type: 'string' } }, required: ['project', 'agent'] },
    run: async (a) => {
      const st = (await api('POST', `${agentPath(a)}/start`, { resume: a.resume, prompt: a.prompt })) as { agentName?: string; status: string; sessionId?: string }
      return `${a.resume ? 'Resumed' : 'Started'} ${st.agentName ?? a.agent} in ${a.project || PROJECT}: ${st.status}${st.sessionId ? `, session ${st.sessionId}` : ''}. Follow it with hive_wait_for_agents.`
    }
  },
  {
    name: 'hive_stop_agent',
    description: 'Stop a running agent; its conversation is kept. If it is busy, Hive asks the user first and this waits for their answer: give a reason.',
    inputSchema: { type: 'object', properties: { project: projectArg, agent: agentArg, reason: { type: 'string' } }, required: ['project', 'agent'] },
    run: (a) => api('POST', `${agentPath(a)}/stop`, { reason: a.reason })
  },
  {
    name: 'hive_prompt_agent',
    description:
      "Type a task into an idle running agent and send it. Refused while it is working, starting, waiting on background tasks or for the user, or just after the user typed there. Write the task in full: the agent sees nothing else from you. For work on a card, use hive_start_task.",
    inputSchema: { type: 'object', properties: { project: projectArg, agent: agentArg, text: { type: 'string' } }, required: ['project', 'agent', 'text'] },
    run: (a) => api('POST', `${agentPath(a)}/prompt`, { text: a.text })
  },
  {
    name: 'hive_hand_over',
    description:
      "Hand one agent's work to another in the same project (Hand Over to…): Hive has `from` (running and idle) write a handover, waits for it, then starts `to` (or tells it, if idle) to read it and carry on. handover=false hands over the latest one instead. `to` the same as `from` carries on in a new conversation, making a long transcript short. Returns at once: follow with hive_wait_for_agents.",
    inputSchema: { type: 'object', properties: { project: projectArg, from: agentArg, to: agentArg, handover: { type: 'boolean' } }, required: ['project', 'from', 'to'] },
    run: (a) => api('POST', `/v1/projects/${proj(a)}/handover`, { from: a.from, to: a.to, handover: a.handover })
  },
  {
    name: 'hive_list_tasks',
    description: `${ASSISTANT ? "The task board's cards" : "Your project's cards on the task board"} in board order (by column, top first: the order is priority), a line each: number, title, project, its agent and what it is doing, labels, blocked, what it waits for, stalled, reviewer, comment count. ${ASSISTANT ? 'project narrows it to one project, ' : "Another project's cards it links to or waits for show as numbers only. "}column to one column; archived=true lists archived cards; details=true gives every card as JSON (large). At most ${MAX_ROWS} lines a reply: offset carries on.`,
    inputSchema: {
      type: 'object',
      properties: {
        ...(ASSISTANT ? { project: { type: 'string', description: "Only this project's cards." } } : {}),
        column: columnArg,
        archived: { type: 'boolean' },
        details: { type: 'boolean', description: 'Every card in full (descriptions, comments, history).' },
        offset: { type: 'number', description: 'Skip this many cards (the reply says where to carry on).' }
      }
    },
    run: async (a) => {
      const q = [a.project ? `project=${enc(a.project)}` : '', a.column ? `column=${enc(a.column)}` : '', a.archived ? 'archived=true' : '', a.details ? '' : 'view=short'].filter(Boolean).join('&')
      const list = await api('GET', `/v1/tasks${q ? `?${q}` : ''}`)
      return a.details ? list : taskListText(list as TaskRow[], { archived: !!a.archived, offset: Number(a.offset) || 0 })
    }
  },
  {
    name: 'hive_wait_for_tasks',
    description:
      "Wait for cards to change: a column move, a new comment, a review verdict or a new agent (changes narrows it). column alone: only until one is in that column (at once if it already is; nothing else counts); column with changes including \"column\": until one moves into it (a card there must leave and come back, or be returned for review), or another change listed. wake=true: Hive types one line into this session when one changes, naming every watched card that changed (or after limitMinutes with none, default 120); a watch started after a wake also counts what others changed since that wake: end your turn after calling it; nothing runs, and no other work is given to you, meanwhile. Without wake, it waits here up to timeoutSeconds (default 300, at most 840) and replies with each change (column, by whom, the latest comment's first line) or no change, with since: pass it back to the next wait so nothing between them is missed. cancel=true ends your watch. Your project's cards only.",
    inputSchema: {
      type: 'object',
      properties: {
        cards: { type: 'array', items: { type: 'number' }, description: 'Card numbers (#12 is 12).' },
        changes: { type: 'array', items: { type: 'string', enum: ['column', 'comment', 'verdict', 'agent'] }, description: 'What counts (default: any).' },
        column: columnArg,
        wake: { type: 'boolean' },
        limitMinutes: { type: 'number' },
        timeoutSeconds: { type: 'number' },
        since: { type: 'string' },
        cancel: { type: 'boolean' }
      }
    },
    run: async (a) =>
      taskWaitText(
        (await api('POST', '/v1/tasks/wait', {
          ...(a.cancel ? { cancel: true } : { cards: a.cards, changes: a.changes, column: a.column, wake: a.wake === true, limitMinutes: a.limitMinutes, timeoutSeconds: a.timeoutSeconds, since: a.since })
        })) as Parameters<typeof taskWaitText>[0]
      )
  },
  {
    name: 'hive_read_task',
    description:
      'One card as JSON: description, comments, links, agent and reviewer. comments=n gives only its newest n comments (commentsOmitted counts the others); latestComment=true only the newest (comment null if none); history=true adds who changed what and when (historyEntries says how many entries there are).',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'number', description: 'The card number (#12 is 12).' },
        comments: { type: 'number', description: 'Only the newest n comments.' },
        latestComment: { type: 'boolean', description: 'Only the newest comment.' },
        history: { type: 'boolean' }
      },
      required: ['number']
    },
    run: (a) => {
      const n = enc(String(a.number))
      if (a.latestComment) return api('GET', `/v1/tasks/${n}/comments/latest`)
      const q = [a.history ? '' : 'history=false', Number(a.comments) > 0 ? `comments=${Math.floor(Number(a.comments))}` : ''].filter(Boolean).join('&')
      return api('GET', `/v1/tasks/${n}${q ? `?${q}` : ''}`)
    }
  },
  {
    name: 'hive_create_task',
    description: `Add a card, in todo unless column says otherwise (never done${ASSISTANT ? '' : ' or hold'}). ${ASSISTANT ? "Give it a project: without one it is about the workspace and can't be started on an agent." : "It is your project's: you can't add cards for other projects or the whole workspace (tell the user)."}${ASSISTANT ? '' : ' Created in doing without agent, it is given to you.'} Replies with its number and place.`,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string', description: 'Markdown: what to do and how to tell it is done, in full (whoever starts it reads only the card).' },
        project: projectArg,
        agent: { type: 'string', description: 'Give it to this agent of the project (name or id).' },
        column: columnArg,
        labels: { type: 'array', items: { type: 'string' } },
        blocked: { type: 'string', description: "Why it can't go on yet." },
        blockedBy: cardsArg('Cards that have to be done first.'),
        links: cardsArg('Related cards.')
      },
      required: ['title']
    },
    run: async (a) => createdText((await api('POST', '/v1/tasks', { title: a.title, description: a.description, project: a.project ?? PROJECT, agent: a.agent, column: a.column, labels: a.labels, blocked: a.blocked, blockedBy: a.blockedBy, links: a.links, reply: 'short' })) as TaskChange)
  },
  {
    name: 'hive_update_task',
    description: ASSISTANT
      ? "Change a card and/or comment on it. column moves it: into doing it keeps its agent (or none) and starts nothing; when the user only says to move a card to doing, ask whether they want nobody on it, an agent assigned (agent), or an agent started on it (hive_start_task). position (top, bottom) or before (a card in the column it ends in) places it; blocked sets a reason (empty clears it); blockedBy and links replace their lists; agent gives it to an agent of its project (empty takes it away); project moves it to another project, taking it from its agent. hold parks a card and done means merged: move a card to either only when the user asks. Archived cards can't change. Replies with what changed and where the card is now."
      : "Change a card of your project and/or comment on it. column moves it: into doing from another column without agent gives it to you. position (top, bottom) or before (a card in the column it ends in) places it; blocked sets a reason (empty clears it); blockedBy and links replace their lists; agent gives it to an agent of the project (empty takes it away). review: on a card in review, start marks you as its reviewer (it keeps its column and agent: reviewing isn't working on it); passed or failed, with your verdict as comment, ends your review (passed with column passed moves it on: reviewed, not merged); your own card failed and still in review, column review returns it for its next round (wakes its reviewer). done means merged: move your card there once its work is merged, or when the user asks. hold is the user's (refused). A card in doing with another agent is its work in progress: you can't move it to review, passed or done (refused). Archived cards can't change. Replies with what changed and where the card is now.",
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'number' },
        comment: { type: 'string', description: 'Added to its comments.' },
        column: columnArg,
        position: { type: 'string', enum: ['top', 'bottom'], description: ASSISTANT ? 'The top (highest priority) or bottom of its column.' : "The top (highest priority) or bottom of your project's cards in its column." },
        before: { type: 'number', description: 'Just above this card, which must be in the column the card ends up in.' },
        blocked: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        ...(ASSISTANT ? { project: { type: 'string' } } : {}),
        agent: { type: 'string', description: 'Agent name or id; empty takes it from its agent.' },
        labels: { type: 'array', items: { type: 'string' } },
        blockedBy: cardsArg('Cards that have to be done first (replaces the list).'),
        links: cardsArg('Related cards (replaces the list).'),
        ...(ASSISTANT ? {} : { review: { type: 'string', enum: ['start', 'passed', 'failed'] } })
      },
      required: ['number']
    },
    run: async (a) => {
      const body: Record<string, unknown> = { reply: 'short' }
      for (const k of ['comment', 'column', 'position', 'before', 'blocked', 'title', 'description', 'project', 'agent', 'labels', 'blockedBy', 'links', 'review']) if (a[k] !== undefined) body[k] = a[k]
      return changedText((await api('PATCH', `/v1/tasks/${enc(String(a.number))}`, body)) as TaskChange)
    }
  },
  {
    name: 'hive_reorder_tasks',
    description: `Put cards in priority order in one call: the listed cards, already in that column, go to its top in the order given; the others keep their order below.${ASSISTANT ? '' : " Your project's cards only: other projects' cards keep their places."} The order of done is the user's.`,
    inputSchema: {
      type: 'object',
      properties: {
        column: { type: 'string', enum: COLUMN_IDS.filter((c) => c !== 'done') },
        cards: cardsArg('Card numbers, highest priority first.')
      },
      required: ['column', 'cards']
    },
    run: async (a) => reorderText((await api('POST', '/v1/tasks/reorder', { column: a.column, cards: a.cards, reply: 'short' })) as TaskReorder)
  },
  {
    name: 'hive_start_task',
    description:
      'Start a card on an agent of its project: Hive moves it to doing, gives it to the agent and sends the card as its prompt. For any work on a card, also more on one in review or done: note says what to do now. agent: one that is stopped or idle; without it, Hive adds a new agent (worktree=true for its own git worktree, only if the user asked). Follow with hive_wait_for_agents. Replies with the agent that has it.',
    inputSchema: {
      type: 'object',
      properties: { number: { type: 'number' }, agent: agentArg, note: { type: 'string', description: 'What to do now, added to the card in the prompt.' }, worktree: { type: 'boolean' }, name: { type: 'string', description: "A new agent's name." }, provider: settingsArgs.provider },
      required: ['number']
    },
    run: async (a) => {
      const r = (await api('POST', `/v1/tasks/${enc(String(a.number))}/start`, { agent: a.agent, note: a.note, worktree: a.worktree, name: a.name, provider: a.provider, reply: 'short' })) as { agent: string; added: boolean; card: TaskRow }
      return `Started #${r.card.number} ${r.card.title} on ${r.added ? 'a new agent, ' : ''}${r.agent}${r.card.project ? ` in ${r.card.project}` : ''}; the card is in ${r.card.column === 'doing' ? 'Doing' : r.card.column}. Follow it with hive_wait_for_agents.`
    }
  },
  {
    name: 'hive_list_skills',
    description: ASSISTANT
      ? "The skills on this machine and in the workspace, a line each: the workspace's Hive skills with who gets them (agents, the Assistant or all) and each provider's user and plugin skills. With project, what that project's agents are given instead: the Hive skills for agents, user and plugin skills, and the project's local skills. A listing of what's there, not of what a running session loaded."
      : "The skills for this project's agents, a line each: the workspace's Hive skills for agents (not those for the Assistant alone), each provider's user and plugin skills, and the project's local skills. A listing of what's there, not of what a running session loaded.",
    inputSchema: { type: 'object', properties: { project: projectArg } },
    run: async (a) => {
      const p = a.project || PROJECT
      return skillListText((await api('GET', `/v1/skills${p ? `?project=${enc(p)}` : ''}`)) as SkillRow[])
    }
  },
  {
    name: 'hive_list_settings',
    description:
      "Hive's settings, a line each: id = value (and its default when it differs), [read-only] for those only the user changes, and its name; with query, only those matching every word (\"compact\", \"notifications\"), each with what it does. scope narrows them to app, provider or project; project adds that project's own settings (Project Settings, ids project.…). At most 200 lines: offset carries on. hive_read_setting explains one.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        scope: { type: 'string', enum: ['app', 'provider', 'workspace', 'project'] },
        project: { type: 'string', description: "A project's own settings too (its name)." },
        offset: { type: 'number', description: 'Skip this many settings (the reply says where to carry on).' }
      }
    },
    run: async (a) => {
      const q = [a.query ? `query=${enc(a.query)}` : '', a.scope ? `scope=${enc(a.scope)}` : '', a.project ? `project=${enc(a.project)}` : ''].filter(Boolean).join('&')
      return settingListText((await api('GET', `/v1/settings${q ? `?${q}` : ''}`)) as SettingRow[], { query: a.query, offset: Number(a.offset) || 0 })
    }
  },
  {
    name: 'hive_read_setting',
    description: "One setting in full: where the user finds it, its value and default, what it takes, what it does, when it helps, whether a change waits for a restart, and whether you may change it. project: the project, for a project's setting (project.…).",
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'From hive_list_settings, e.g. sessions.transcriptWarnMB.' }, project: { type: 'string' } }, required: ['id'] },
    run: async (a) => settingText((await api('GET', `/v1/settings/${enc(a.id)}${a.project ? `?project=${enc(a.project)}` : ''}`)) as SettingDetail)
  },
  {
    name: 'hive_update_setting',
    description:
      "Change one of Hive's settings to value, as Settings would: only when the user asked or agreed. project: the project, for a project's setting (null inherits Hive's). Refused for [read-only] settings (permission modes, the Agent API, what Hive runs, your own Control): tell the user where to change those. It shows in your panel's list with old → new, where the user can revert it, and counts towards your 30 changes per message. Replies with old → new and when it applies.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, value: { type: ['string', 'number', 'boolean', 'null', 'object', 'array'], description: 'What hive_read_setting says it takes (a table is an object or a list).' }, project: { type: 'string' } },
      required: ['id', 'value']
    },
    run: async (a) => settingChangedText((await api('PATCH', `/v1/settings/${enc(a.id)}`, { value: a.value, project: a.project })) as Parameters<typeof settingChangedText>[0])
  }
]

/** Agents get Hive's common tools; the Assistant also those its control level allows. */
const allowed = new Set(assistantTools(CONTROL, CHANGE_SETTINGS))
const offered = tools.filter((t) => (ASSISTANT ? !ASSISTANT_ONLY_TOOLS.includes(t.name) || allowed.has(t.name) : !ASSISTANT_ONLY_TOOLS.includes(t.name)))

const INSTRUCTIONS = hiveInstructions(PROJECT, ASSISTANT ? 'assistant' : 'agent', process.env.HIVE_PROGRESS_COMMANDS !== '0')

async function instructions(): Promise<string> {
  // Without a project (the Hive Assistant's session) there is no "latest handover for this project".
  if (!PROJECT) return INSTRUCTIONS
  try {
    const latest = await Promise.race([handovers(PROJECT || undefined), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500))])
    if (latest[0]) return withLatestHandover(INSTRUCTIONS, latest[0].relPath)
  } catch {
    // Hive not reachable yet: the static instructions still apply.
  }
  return INSTRUCTIONS
}

/**
 * Tests only (Hive passes HIVE_TEST_MCP_LOG to this server in development builds): each tool call this server ran, with
 * whose it was and whether it worked, so tests (tests/scenarios) see what was executed, not what a transcript mentions.
 */
function testLog(name: string, args: unknown, error: string | null): void {
  const file = process.env.HIVE_TEST_MCP_LOG
  if (!file) return
  try {
    const line = { at: new Date().toISOString(), tool: name, role: ASSISTANT ? 'assistant' : 'agent', project: PROJECT, agent: process.env.HIVE_AGENT_ID ?? null, ok: error === null, ...(error ? { error } : {}), args: JSON.stringify(args ?? {}).slice(0, 4000) }
    appendFileSync(file, JSON.stringify(line) + '\n')
  } catch {
    // A test log that can't be written doesn't change the call.
  }
}

function reply(id: unknown, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function replyError(id: unknown, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}

// ---------------------------------------------------------------------------
// Performance metrics: what each tool call gave the model (its final text), and the tool list as this session got it,
// reported to Hive (POST /v1/metrics/mcp) a batch at a time, after the replies, with this session's own token. Only
// sizes, times and outcomes: never arguments or replies. A report that can't be sent is dropped.
// ---------------------------------------------------------------------------

interface CallReport {
  tool: string
  mode: 'compact' | 'detail'
  ok: boolean
  chars: number
  bytes: number
  ms: number
}
const pending: CallReport[] = []
let catalog: { tools: number; toolsBytes: number } | null = null
let flushTimer: NodeJS.Timeout | null = null
/** At most this many calls in one report (the API's limit), sent at most every 2 seconds. */
const REPORT_MAX = 50

/** A report's own budget: one send at a time, given up after this (it never holds the bridge open longer). */
const REPORT_TIMEOUT_MS = 3000
/** Calls waiting to be reported, at most: past this the oldest are dropped (only sizes are lost, never a reply). */
const PENDING_MAX = 500
let sending = false

function flushReports(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  if (sending || (!pending.length && !catalog)) return
  const calls = pending.splice(0, REPORT_MAX)
  const body = { calls, ...(catalog ? { catalog } : {}) }
  catalog = null
  sending = true
  // Not api(): a report has its own short deadline, and never waits as long as a tool call may.
  const stop = new AbortController()
  const deadline = setTimeout(() => stop.abort(), REPORT_TIMEOUT_MS)
  deadline.unref?.()
  void fetch(API + '/v1/metrics/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', ...(WORKSPACE ? { 'X-Hive-Workspace': encodeURIComponent(WORKSPACE) } : {}) },
    body: JSON.stringify(body),
    signal: stop.signal
  })
    .then((res) => res.arrayBuffer())
    // Hive didn't take it in time (or at all): what is still waiting is dropped too, so a stalled endpoint costs at most
    // one deadline, not one per batch.
    .catch(() => {
      pending.length = 0
      catalog = null
    })
    .finally(() => {
      clearTimeout(deadline)
      sending = false
      // The next batch: at once if the CLI has gone and no call is running, else after the usual wait.
      if (pending.length || catalog) {
        if (inputClosed && calling === 0) flushReports()
        else scheduleReports()
      }
    })
}

function scheduleReports(): void {
  if (flushTimer) return
  flushTimer = setTimeout(flushReports, 2000)
  flushTimer.unref?.()
}

/** Tool calls still running, and whether the CLI has closed our input (it is going away: send what's left at once). */
let calling = 0
let inputClosed = false

function reportCall(r: CallReport): void {
  pending.push(r)
  if (pending.length > PENDING_MAX) pending.splice(0, pending.length - PENDING_MAX)
  if (pending.length >= REPORT_MAX || (inputClosed && calling === 0)) flushReports()
  else scheduleReports()
}

function inputEnded(): void {
  inputClosed = true
  if (calling === 0) flushReports()
}

/** Whether a call asked for the full form (detail, details) rather than the default compact one. */
const modeOf = (args: Record<string, unknown>): CallReport['mode'] => (args.detail === true || args.details === true ? 'detail' : 'compact')

async function handle(msg: { id?: unknown; method?: string; params?: any }): Promise<void> {
  const { id, method, params } = msg
  if (!method) return
  const isRequest = id !== undefined && id !== null
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'hive', version: VERSION },
        instructions: await instructions()
      })
    case 'ping':
      return reply(id, {})
    case 'tools/list': {
      const list = offered.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
      reply(id, { tools: list })
      // Its size as the CLI got it (the tools array's JSON), once a session.
      if (!listed) {
        listed = true
        catalog = { tools: list.length, toolsBytes: Buffer.byteLength(JSON.stringify(list), 'utf8') }
        scheduleReports()
      }
      return
    }
    case 'tools/call': {
      const tool = offered.find((t) => t.name === params?.name)
      if (!tool) return replyError(id, -32602, `Unknown tool: ${params?.name}`)
      const args = (params?.arguments ?? {}) as Record<string, unknown>
      const started = performance.now()
      calling++
      let text: string
      let ok = true
      try {
        const result = await tool.run(args)
        testLog(tool.name, params?.arguments, null)
        // Compact: indenting JSON makes it about a third bigger for the model, and no easier for it to read.
        text = typeof result === 'string' ? result : JSON.stringify(result)
        reply(id, { content: [{ type: 'text', text }] })
      } catch (e) {
        testLog(tool.name, params?.arguments, (e as Error).message)
        ok = false
        text = `Hive error: ${(e as Error).message}`
        reply(id, { content: [{ type: 'text', text }], isError: true })
      }
      // After the reply: the model's text exactly as sent (characters as UTF-16 code units, and UTF-8 bytes).
      calling--
      reportCall({ tool: tool.name, mode: modeOf(args), ok, chars: text.length, bytes: Buffer.byteLength(text, 'utf8'), ms: performance.now() - started })
      return
    }
    default:
      if (isRequest) replyError(id, -32601, `Method not found: ${method}`)
  }
}

let listed = false

createInterface({ input: process.stdin }).on('close', inputEnded).on('line', (line) => {
  if (!line.trim()) return
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch {
    return replyError(null, -32700, 'Parse error')
  }
  for (const m of Array.isArray(msg) ? msg : [msg]) void handle(m as { id?: unknown; method?: string })
})
