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
import { readFileSync } from 'fs'
import { createInterface } from 'readline'
import { hiveInstructions, projectHandovers, withLatestHandover } from '../../shared/hiveGuidance'
import { ASSISTANT_ONLY_TOOLS, assistantTools } from '../../shared/assistantTools'
import { changedText, createdText, noteText, notesListText, projectListText, reorderText, taskListText, type NoteEntry, type ProjectRow, type TaskChange, type TaskReorder, type TaskRow } from '../../shared/toolReplies'

const VERSION = '1.0.0'
const API = (process.env.HIVE_API_URL || 'http://127.0.0.1:47821').replace(/\/$/, '')
const PROJECT = process.env.HIVE_PROJECT || ''
/** The session's workspace: with several Hive windows open, the API answers for this one. */
const WORKSPACE = process.env.HIVE_WORKSPACE || ''
/** The Hive Assistant's session gets the tools to run agents, as far as its control level allows. */
const ASSISTANT = process.env.HIVE_ROLE === 'assistant'
const CONTROL = process.env.HIVE_ASSISTANT_CONTROL || 'projects'

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
const columnArg = { type: 'string', enum: ['todo', 'doing', 'review', 'done'] }
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
    description: "Get the status and settings of one project, and its agents (up to twelve, each in the project folder or a git worktree) with their ids and running sessions (JSON).",
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
    description: 'Read a shared note by its path relative to .hive/shared (e.g. "handovers/2026-01-01-auth.md").',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: async (a) => noteText((await api('GET', `/v1/shared/file?path=${enc(a.path)}`)) as { path: string; content: string })
  },
  {
    name: 'hive_write_shared_note',
    description: 'Create or overwrite a shared note (markdown) in .hive/shared. Set append=true to add to the end instead. Replies with the path and how much was written.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean' } },
      required: ['path', 'content']
    },
    run: async (a) => {
      const r = (await api('PUT', `/v1/shared/file?path=${enc(a.path)}`, { content: a.content, append: !!a.append })) as { path: string }
      const n = String(a.content ?? '').length.toLocaleString('en')
      return a.append ? `Appended ${n} characters to ${r.path}.` : `Wrote ${r.path} (${n} characters).`
    }
  },
  {
    name: 'hive_read_latest_handover',
    description:
      'Read the most recent handover note for a project (the current one by default). Use this when asked to pick up where a previous session left off, or to "read the handover".',
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
    description:
      'Write a handover note so a future session or another project can continue this work. Include goal, current state, decisions, open issues and next steps. Replies with the path it was saved as.',
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
    description: 'Show a notification to the user in Hive (e.g. to flag something important). Levels: info, success, warning, error.',
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
    description: 'The coding-agent providers (Claude Code, Codex): whether each is turned on and installed, and its models, effort levels and permission modes. Use the values from here when adding or changing agents.',
    inputSchema: { type: 'object', properties: {} },
    run: () => api('GET', '/v1/providers')
  },
  {
    name: 'hive_agent_activity',
    description: "What one agent is doing: its status, how many background tasks it has running, how big its conversation's transcript is (transcriptMB; past transcriptWarnMB it slows things down, so suggest handing it over to a new conversation), the task it was last given, its latest reply, its recent tool calls (this turn), the files it has locked, and how long ago the user typed in its terminal.",
    inputSchema: { type: 'object', properties: { project: projectArg, agent: agentArg } },
    run: (a) => api('GET', `${agentPath(a)}/activity`)
  },
  {
    name: 'hive_wait_for_agents',
    description:
      "Wait until agents stop working (finished, idle, or waiting for the user), up to timeoutSeconds (default 50, at most 600). An agent whose turn has ended but that is waiting on background tasks it started (status background, e.g. a test run) still counts as working, since it carries on when they end; ignoreBackground=true stops waiting at the end of its turn instead. With no agents listed, waits for every busy agent in the workspace. Returns each one's status and background task count; call again to keep waiting.",
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
    description: 'Create a project: a new folder in the workspace (turned on). Only when the user asked for one. Replies with a confirmation.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Folder name.' } }, required: ['name'] },
    run: async (a) => {
      const p = (await api('POST', '/v1/projects', { name: a.name })) as { name: string }
      return `Created the project ${p.name} (on). It has no agents yet: add one with hive_add_agent.`
    }
  },
  {
    name: 'hive_activate_project',
    description: 'Turn a project on (it shows under Working On in Hive). Starting an agent does this too. Replies with a confirmation.',
    inputSchema: { type: 'object', properties: { project: projectArg }, required: ['project'] },
    run: async (a) => {
      const p = (await api('POST', `/v1/projects/${proj(a)}/activate`)) as { name: string }
      return `${p.name} is on.`
    }
  },
  {
    name: 'hive_add_agent',
    description:
      "Add an agent to a project (up to 12). It works in the project folder; set worktree only if the user asked for one, or after asking them (its own git branch and folder). With prompt, it starts at once on that task (given on the CLI's command line); with start and no prompt, it starts idle. Hive doesn't move the user's view to it. Replies with its name, id, provider, folder and status.",
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
    description: "Change an agent's name, provider, model, effort, permission mode or 200K context. A running agent applies the change when restarted (its provider only while stopped).",
    inputSchema: { type: 'object', properties: { project: projectArg, agent: agentArg, name: { type: 'string' }, ...settingsArgs }, required: ['project', 'agent'] },
    run: (a) => api('PATCH', agentPath(a), { name: a.name, provider: a.provider, model: a.model, effort: a.effort, mode: a.mode, context200k: a.context200k })
  },
  {
    name: 'hive_start_agent',
    description: "Start a stopped agent: a new conversation, or resume=true for its last one. With prompt, it starts on that task (given on the CLI's command line). If its folder is new to the CLI, it first asks the user to trust it (the agent shows as waiting): tell the user. Replies with its status and session id.",
    inputSchema: { type: 'object', properties: { project: projectArg, agent: agentArg, resume: { type: 'boolean' }, prompt: { type: 'string' } }, required: ['project', 'agent'] },
    run: async (a) => {
      const st = (await api('POST', `${agentPath(a)}/start`, { resume: a.resume, prompt: a.prompt })) as { agentName?: string; status: string; sessionId?: string }
      return `${a.resume ? 'Resumed' : 'Started'} ${st.agentName ?? a.agent} in ${a.project || PROJECT}: ${st.status}${st.sessionId ? `, session ${st.sessionId}` : ''}. Follow it with hive_wait_for_agents.`
    }
  },
  {
    name: 'hive_stop_agent',
    description: 'Stop a running agent (its conversation is kept). If it is busy, Hive asks the user first and this waits for their answer; give a reason.',
    inputSchema: { type: 'object', properties: { project: projectArg, agent: agentArg, reason: { type: 'string' } }, required: ['project', 'agent'] },
    run: (a) => api('POST', `${agentPath(a)}/stop`, { reason: a.reason })
  },
  {
    name: 'hive_prompt_agent',
    description:
      "Give an idle running agent a task (typed into its terminal and sent). Refused while it is working, starting, waiting on its background tasks or waiting for the user, or when the user has just typed in its terminal. Write the task in full: the agent can't see your conversation.",
    inputSchema: { type: 'object', properties: { project: projectArg, agent: agentArg, text: { type: 'string' } }, required: ['project', 'agent', 'text'] },
    run: (a) => api('POST', `${agentPath(a)}/prompt`, { text: a.text })
  },
  {
    name: 'hive_hand_over',
    description:
      "Hand one agent's work over to another in the same project, of either provider (Hive's Hand Over to…). With handover (the default), Hive asks `from` (running and idle) to write a handover, waits until a new one exists, then starts `to` (or, if it's running and idle, tells it) to read the latest handover and carry on. handover=false skips writing one and hands over the latest. With `to` the same as `from`, the agent carries on in a new conversation instead (its conversation ends and a new one reads the handover): the way to make a long transcript (transcriptMB in hive_agent_activity) short again. Returns at once: follow with hive_wait_for_agents.",
    inputSchema: { type: 'object', properties: { project: projectArg, from: agentArg, to: agentArg, handover: { type: 'boolean' } }, required: ['project', 'from', 'to'] },
    run: (a) => api('POST', `/v1/projects/${proj(a)}/handover`, { from: a.from, to: a.to, handover: a.handover })
  },
  {
    name: 'hive_list_tasks',
    description: `${ASSISTANT ? "The workspace's task board" : "Your project's cards on the workspace's task board (other projects' cards are for their own agents, the Hive Assistant and the user: you can't see or change them)"}: cards in columns todo, doing, review and done, in board order (top of each column first: the order is their priority). One line per card: number, title, project, the agent it's given to and what that agent is doing now, labels, whether it's blocked or stalled, and how many comments it has. hive_read_task gives a card's description and comments; details=true lists every card in full as JSON (large: only when you need all of them). ${ASSISTANT ? "Without project, every project's cards; " : 'A card you wait for or link to in another project shows as its number only (elsewhere lists them). '}archived=true lists the archived ones instead. At most 200 lines: narrow it with ${ASSISTANT ? 'project or column' : 'column'}.`,
    inputSchema: { type: 'object', properties: { ...(ASSISTANT ? { project: { type: 'string', description: 'Only this project\'s cards.' } } : {}), column: columnArg, archived: { type: 'boolean' }, details: { type: 'boolean', description: 'Every card in full (descriptions, comments, history).' } } },
    run: async (a) => {
      const q = [a.project ? `project=${enc(a.project)}` : '', a.column ? `column=${enc(a.column)}` : '', a.archived ? 'archived=true' : '', a.details ? '' : 'view=short'].filter(Boolean).join('&')
      const list = await api('GET', `/v1/tasks${q ? `?${q}` : ''}`)
      return a.details ? list : taskListText(list as TaskRow[], { archived: !!a.archived })
    }
  },
  {
    name: 'hive_read_task',
    description:
      "One card in full, as JSON: its description, comments, links and agent. Its change history (who moved it when) only with history=true; historyEntries says how long it is. latestComment=true gives only its newest comment (author, time, whole text; comment null if it has none): use it when asked to check the latest comment, and read the whole card when you need more of it.",
    inputSchema: { type: 'object', properties: { number: { type: 'number', description: 'The card number (#12 is 12).' }, history: { type: 'boolean' }, latestComment: { type: 'boolean', description: 'Only the newest comment.' } }, required: ['number'] },
    run: (a) => (a.latestComment ? api('GET', `/v1/tasks/${enc(String(a.number))}/comments/latest`) : api('GET', `/v1/tasks/${enc(String(a.number))}${a.history ? '' : '?history=false'}`))
  },
  {
    name: 'hive_create_task',
    description: `Add a card to the workspace's task board (in todo unless column says otherwise; never done). Use it for follow-up work you find but shouldn't do now, or when the user asks. ${ASSISTANT ? "Give it a project (folder name) so it can be started on that project's agents." : "It is your project's: you can't add cards for other projects or the whole workspace (tell the user, or the Hive Assistant can)."} Created in doing with no agent, it is given to you. Replies with its number and place on the board.`,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string', description: 'Markdown: what to do and how to tell it is done, in full (whoever starts it reads only the card).' },
        project: projectArg,
        agent: { type: 'string', description: "Give it to this agent of the project (name or id)." },
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
    description:
      `Change a card on the task board${ASSISTANT ? '' : " (your project's cards only; a card stays in your project)"} and/or comment on it: move it between todo, doing, review and done, set blocked with a reason (empty clears it), change its title, description, project, agent, labels or the cards it depends on, or its place in its column (position top or bottom, or before another card in that column; with or without a column change). Moving a card that has no agent into doing, without agent, gives it to you. When you finish a card's work, move it to review with a comment saying what you did; move it to done only when the user asks (every move is in the card's history, and the user can move it back). Archived cards can't be changed. Replies with what changed and where the card is now (column, place, project, agent).`,
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'number' },
        comment: { type: 'string', description: 'Added to its comments.' },
        column: columnArg,
        position: { type: 'string', enum: ['top', 'bottom'], description: ASSISTANT ? 'Put it at the top (highest priority) or bottom of its column.' : "Put it at the top (highest priority) or bottom of your project's cards in its column." },
        before: { type: 'number', description: 'Put it just above this card, which must be in the same column.' },
        blocked: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        project: { type: 'string' },
        agent: { type: 'string', description: 'Agent name or id; empty takes it from its agent.' },
        labels: { type: 'array', items: { type: 'string' } },
        blockedBy: cardsArg('Cards that have to be done first (replaces the list).'),
        links: cardsArg('Related cards (replaces the list).')
      },
      required: ['number']
    },
    run: async (a) => {
      const body: Record<string, unknown> = { reply: 'short' }
      for (const k of ['comment', 'column', 'position', 'before', 'blocked', 'title', 'description', 'project', 'agent', 'labels', 'blockedBy', 'links']) if (a[k] !== undefined) body[k] = a[k]
      return changedText((await api('PATCH', `/v1/tasks/${enc(String(a.number))}`, body)) as TaskChange)
    }
  },
  {
    name: 'hive_reorder_tasks',
    description:
      (ASSISTANT ? '' : "Your project's cards only: they go above your project's other cards in the column, and other projects' cards keep their places. ") +
      "Put cards in priority order in one call: the listed cards go to the top of the column in the order given, and the column's other cards keep their order below them. The cards must already be in that column (move them first with hive_update_task); only the user orders done. Use this when asked to prioritise, rather than only listing an order. Replies with a confirmation, not the column.",
    inputSchema: {
      type: 'object',
      properties: {
        column: { type: 'string', enum: ['todo', 'doing', 'review'] },
        cards: cardsArg('Card numbers, highest priority first.')
      },
      required: ['column', 'cards']
    },
    run: async (a) => reorderText((await api('POST', '/v1/tasks/reorder', { column: a.column, cards: a.cards, reply: 'short' })) as TaskReorder)
  },
  {
    name: 'hive_start_task',
    description:
      "Start a card: Hive gives it to an agent of its project with the card as the prompt and moves it to doing. agent: an existing agent that is stopped or idle; without agent, Hive adds a new one (worktree=true: in its own git worktree, only if the user asked for one). Follow with hive_wait_for_agents. Replies with the agent that has it.",
    inputSchema: {
      type: 'object',
      properties: { number: { type: 'number' }, agent: agentArg, worktree: { type: 'boolean' }, name: { type: 'string', description: 'A new agent\'s name.' }, provider: settingsArgs.provider },
      required: ['number']
    },
    run: async (a) => {
      const r = (await api('POST', `/v1/tasks/${enc(String(a.number))}/start`, { agent: a.agent, worktree: a.worktree, name: a.name, provider: a.provider, reply: 'short' })) as { agent: string; added: boolean; card: TaskRow; note: string }
      return `Started #${r.card.number} ${r.card.title} on ${r.added ? 'a new agent, ' : ''}${r.agent}${r.card.project ? ` in ${r.card.project}` : ''}; the card is in ${r.card.column === 'doing' ? 'Doing' : r.card.column}. ${r.note}`
    }
  },
  {
    name: 'hive_list_skills',
    description: "List skills available to the project's agents: Hive (the workspace's, given to every agent), each provider's user and plugin skills, and the project's local skills.",
    inputSchema: { type: 'object', properties: { project: projectArg } },
    run: (a) => api('GET', `/v1/skills?project=${proj(a)}`)
  }
]

/** Agents get Hive's common tools; the Assistant also those its control level allows. */
const allowed = new Set(assistantTools(CONTROL))
const offered = tools.filter((t) => (ASSISTANT ? !ASSISTANT_ONLY_TOOLS.includes(t.name) || allowed.has(t.name) : !ASSISTANT_ONLY_TOOLS.includes(t.name)))

const INSTRUCTIONS = hiveInstructions(PROJECT)

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

function reply(id: unknown, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function replyError(id: unknown, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}

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
    case 'tools/list':
      return reply(id, { tools: offered.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
    case 'tools/call': {
      const tool = offered.find((t) => t.name === params?.name)
      if (!tool) return replyError(id, -32602, `Unknown tool: ${params?.name}`)
      try {
        const result = await tool.run(params?.arguments ?? {})
        // Compact: indenting JSON makes it about a third bigger for the model, and no easier for it to read.
        return reply(id, { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] })
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: `Hive error: ${(e as Error).message}` }], isError: true })
      }
    }
    default:
      if (isRequest) replyError(id, -32601, `Method not found: ${method}`)
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch {
    return replyError(null, -32700, 'Parse error')
  }
  for (const m of Array.isArray(msg) ? msg : [msg]) void handle(m as { id?: unknown; method?: string })
})
