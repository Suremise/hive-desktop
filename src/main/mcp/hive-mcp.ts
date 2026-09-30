/**
 * Hive MCP server (stdio). Launched by Claude Code for sessions started from Hive, using Hive's own
 * executable with ELECTRON_RUN_AS_NODE=1. It exposes the Hive Agent API as MCP tools.
 *
 * Self-contained on purpose: only Node built-ins, so it runs from the packaged app without extra files.
 */
import { readFileSync } from 'fs'
import { createInterface } from 'readline'
import { hiveInstructions, projectHandovers, withLatestHandover } from '../../shared/hiveGuidance'

const VERSION = '1.0.0'
const API = (process.env.HIVE_API_URL || 'http://127.0.0.1:47821').replace(/\/$/, '')
const PROJECT = process.env.HIVE_PROJECT || ''
/** The session's workspace: with several Hive windows open, the API answers for this one. */
const WORKSPACE = process.env.HIVE_WORKSPACE || ''

function token(): string {
  const t = process.env.HIVE_API_TOKEN
  if (t && !t.includes('${')) return t
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
    run: (a) => api('POST', '/v1/shared/handovers', { title: a.title, content: a.content, project: a.project || PROJECT })
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
    name: 'hive_list_skills',
    description: "List skills available to the project's agents: Hive (the workspace's, given to every agent), each provider's user and plugin skills, and the project's local skills.",
    inputSchema: { type: 'object', properties: { project: projectArg } },
    run: (a) => api('GET', `/v1/skills?project=${proj(a)}`)
  }
]

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
      return reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
    case 'tools/call': {
      const tool = tools.find((t) => t.name === params?.name)
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
