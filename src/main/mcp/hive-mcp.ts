/**
 * Hive MCP server (stdio). Launched by Claude Code for sessions started from Hive, using Hive's own
 * executable with ELECTRON_RUN_AS_NODE=1. It exposes the Hive Agent API as MCP tools.
 *
 * Self-contained on purpose: only Node built-ins, so it runs from the packaged app without extra files.
 */
import { readFileSync } from 'fs'
import { createInterface } from 'readline'
import { hiveInstructions, projectHandovers, withLatestHandover } from '../../shared/hiveGuidance'
import { ASSISTANT_ONLY_TOOLS, assistantTools } from '../../shared/assistantTools'

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
  mode: { type: 'string', description: 'Permission mode (hive_list_providers). Empty follows the project.' }
}
const agentPath = (a: Record<string, any>): string => `/v1/projects/${proj(a)}/agents/${enc(a.agent || '')}`

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
    description: 'List all projects in the open Hive workspace with their session status (working, waiting, finished, stopped).',
    inputSchema: { type: 'object', properties: {} },
    run: () => api('GET', '/v1/projects')
  },
  {
    name: 'hive_project_status',
    description: "Get the status and settings of one project, and its agents (up to twelve, each in the project folder or a git worktree) with their running sessions.",
    inputSchema: { type: 'object', properties: { project: projectArg } },
    run: (a) => api('GET', `/v1/projects/${proj(a)}`)
  },
  {
    name: 'hive_session_usage',
    description: 'Token usage, cache use and compaction history for a project session (the live one by default).',
    inputSchema: { type: 'object', properties: { project: projectArg, sessionId: { type: 'string' } } },
    run: (a) => api('GET', `/v1/projects/${proj(a)}/usage${a.sessionId ? `?sessionId=${enc(a.sessionId)}` : ''}`)
  },
  {
    name: 'hive_list_shared_notes',
    description: 'List the shared notes, instructions and handovers stored in the workspace (.hive/shared).',
    inputSchema: { type: 'object', properties: {} },
    run: () => api('GET', '/v1/shared')
  },
  {
    name: 'hive_read_shared_note',
    description: 'Read a shared note by its path relative to .hive/shared (e.g. "handovers/2026-01-01-auth.md").',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: (a) => api('GET', `/v1/shared/file?path=${enc(a.path)}`)
  },
  {
    name: 'hive_write_shared_note',
    description: 'Create or overwrite a shared note (markdown) in .hive/shared. Set append=true to add to the end instead.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean' } },
      required: ['path', 'content']
    },
    run: (a) => api('PUT', `/v1/shared/file?path=${enc(a.path)}`, { content: a.content, append: !!a.append })
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
      return api('GET', `/v1/shared/file?path=${enc(latest.relPath)}`)
    }
  },
  {
    name: 'hive_create_handover',
    description:
      'Write a handover note so a future session or another project can continue this work. Include goal, current state, decisions, open issues and next steps.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, content: { type: 'string' }, project: projectArg },
      required: ['title', 'content']
    },
    // Hive writes the header (project, author, session, date) from the agent these tools belong to.
    run: (a) => api('POST', '/v1/shared/handovers', { title: a.title, content: a.content, project: a.project || PROJECT, ...(process.env.HIVE_AGENT_ID ? { agent: process.env.HIVE_AGENT_ID, agentProject: PROJECT } : {}) })
  },
  {
    name: 'hive_notify',
    description: 'Show a notification to the user in Hive (e.g. to flag something important). Levels: info, success, warning, error.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, message: { type: 'string' }, level: { type: 'string', enum: ['info', 'success', 'warning', 'error'] } },
      required: ['title']
    },
    run: (a) => api('POST', '/v1/notify', { title: a.title, message: a.message, level: a.level, source: PROJECT || 'agent' })
  },
  {
    name: 'hive_list_providers',
    description: 'The coding-agent providers (Claude Code, Codex): whether each is turned on and installed, and its models, effort levels and permission modes. Use the values from here when adding or changing agents.',
    inputSchema: { type: 'object', properties: {} },
    run: () => api('GET', '/v1/providers')
  },
  {
    name: 'hive_agent_activity',
    description: "What one agent is doing: its status, how many background tasks it has running, the task it was last given, its latest reply, its recent tool calls (this turn), the files it has locked, and how long ago the user typed in its terminal.",
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
    description: 'Create a project: a new folder in the workspace (turned on). Only when the user asked for one.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Folder name.' } }, required: ['name'] },
    run: (a) => api('POST', '/v1/projects', { name: a.name })
  },
  {
    name: 'hive_activate_project',
    description: 'Turn a project on (it shows under Working On in Hive). Starting an agent does this too.',
    inputSchema: { type: 'object', properties: { project: projectArg }, required: ['project'] },
    run: (a) => api('POST', `/v1/projects/${proj(a)}/activate`)
  },
  {
    name: 'hive_add_agent',
    description:
      "Add an agent to a project (up to 12). It works in the project folder; set worktree only if the user asked for one, or after asking them (its own git branch and folder). With prompt, it starts at once on that task (given on the CLI's command line); with start and no prompt, it starts idle. Hive doesn't move the user's view to it.",
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
    run: (a) => api('POST', `/v1/projects/${proj(a)}/agents`, { name: a.name, provider: a.provider, model: a.model, effort: a.effort, mode: a.mode, worktree: a.worktree, branch: a.branch, base: a.base, start: a.start, prompt: a.prompt })
  },
  {
    name: 'hive_update_agent',
    description: "Change an agent's name, provider, model, effort or permission mode. A running agent applies the change when restarted (its provider only while stopped).",
    inputSchema: { type: 'object', properties: { project: projectArg, agent: agentArg, name: { type: 'string' }, ...settingsArgs }, required: ['project', 'agent'] },
    run: (a) => api('PATCH', agentPath(a), { name: a.name, provider: a.provider, model: a.model, effort: a.effort, mode: a.mode })
  },
  {
    name: 'hive_start_agent',
    description: "Start a stopped agent: a new conversation, or resume=true for its last one. With prompt, it starts on that task (given on the CLI's command line). If its folder is new to the CLI, it first asks the user to trust it (the agent shows as waiting): tell the user.",
    inputSchema: { type: 'object', properties: { project: projectArg, agent: agentArg, resume: { type: 'boolean' }, prompt: { type: 'string' } }, required: ['project', 'agent'] },
    run: (a) => api('POST', `${agentPath(a)}/start`, { resume: a.resume, prompt: a.prompt })
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
      "Hand one agent's work over to another in the same project, of either provider (Hive's Hand Over to…). With handover (the default), Hive asks `from` (running and idle) to write a handover, waits until a new one exists, then starts `to` (or, if it's running and idle, tells it) to read the latest handover and carry on. handover=false skips writing one and hands over the latest. Returns at once: follow with hive_wait_for_agents.",
    inputSchema: { type: 'object', properties: { project: projectArg, from: agentArg, to: agentArg, handover: { type: 'boolean' } }, required: ['project', 'from', 'to'] },
    run: (a) => api('POST', `/v1/projects/${proj(a)}/handover`, { from: a.from, to: a.to, handover: a.handover })
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
        return reply(id, { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] })
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
