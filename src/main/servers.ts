import http, { type IncomingMessage, type ServerResponse } from 'http'
import { AsyncLocalStorage } from 'async_hooks'
import { randomBytes, timingSafeEqual } from 'crypto'
import { app } from 'electron'
import { basename, dirname, join, relative, resolve as resolvePath } from 'path'
import { readFile } from 'fs/promises'
import type { AgentApiInfo, AssistantControl, EffortLevel, HiveEvent, LiveSessionState, PermissionMode, ProviderId, ToastLevel } from '../shared/types'
import { DEFAULT_API_PORT, projectAgents } from '../shared/defaults'
import { PROVIDERS, agentProvider, isKnownProvider, isProviderEnabled, offeredModes, projectDefaultProvider } from '../shared/providers'
import { CLAUDE_CODE } from '../shared/claude'
import * as assistant from './assistantControl'
import { addAgent, updateAgent } from './projectAgents'
import { providerService } from './providerService'
import { config } from './config'
import { emit, onHiveEvent, toast } from './events'
import { readJson, withFileLock, writeJsonAtomic, writeTextAtomic } from './fsutil'
import { createLogger } from './logger'
import { listMcp } from './mcp'
import { assertInShared, createHandover, notesTree } from './notes'
import { writePty } from './ptyHost'
import { sessions } from './sessions'
import { listSkills } from './skills'
import { transcripts } from './transcripts'
import { contextWorkspace, inWorkspace, openWorkspaces, workspace, workspaceOf, type WorkspaceService } from './workspace'

const log = createLogger('servers')
const MAX_BODY = 2 * 1024 * 1024

function tokenMatches(header: string | undefined, token: string): boolean {
  const got = Buffer.from((header ?? '').replace(/^Bearer\s+/i, ''))
  const want = Buffer.from(token)
  return got.length === want.length && timingSafeEqual(got, want)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request body too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(text)
}

// ---------------------------------------------------------------------------
// Hook server: receives the agents' CLI hooks. Random port, token from env; ?run=<runId> names the launch.
// ---------------------------------------------------------------------------

let hookServer: http.Server | null = null

export async function startHookServer(): Promise<string> {
  hookServer = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/hook')) return send(res, 404, { error: 'not found' })
    if (!tokenMatches(req.headers.authorization, sessions.hookToken)) return send(res, 401, { error: 'unauthorized' })
    try {
      const body = JSON.parse((await readBody(req)) || '{}')
      const query = new URL(req.url, 'http://127.0.0.1').searchParams
      const run = query.get('run')
      if (query.has('statusline')) {
        // The reply becomes Claude Code's status line, so send nothing.
        res.writeHead(204)
        res.end()
        sessions.handleStatusLine(run, body)
        return
      }
      // A hook about to edit files waits for Hive's file-lock decision; other hooks are answered at once so they never slow the agent down.
      const reply = body.hook_event_name === 'PreToolUse' ? sessions.preToolUse(run, body) : null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(reply ?? {}))
      await sessions.handleHook(run, body)
    } catch (e) {
      log.warn('hook error', e)
      if (!res.headersSent) send(res, 400, { error: 'bad request' })
    }
  })
  await new Promise<void>((resolve) => hookServer!.listen(0, '127.0.0.1', resolve))
  const addr = hookServer.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  sessions.hookUrl = `http://127.0.0.1:${port}/hook`
  log.info(`Hook server listening on ${sessions.hookUrl}`)
  return sessions.hookUrl
}

// ---------------------------------------------------------------------------
// Agent API: documented REST API for agents and scripts. See docs/AGENT_API.md.
// ---------------------------------------------------------------------------

let apiServer: http.Server | null = null
let apiToken = ''

/**
 * Who made a request: a caller with the Agent API's token (agents' hive tools, scripts), which Settings → Agent
 * API governs, or a workspace's Hive Assistant with its own token, which Settings → Assistant → Control governs.
 */
type Caller = { kind: 'api' } | { kind: 'assistant'; workspace: string }
const callerStore = new AsyncLocalStorage<Caller>()

function assistantCaller(): string | null {
  const c = callerStore.getStore()
  return c?.kind === 'assistant' ? c.workspace : null
}
let apiError: string | undefined
const sseClients = new Set<ServerResponse>()

function tokenFile(): string {
  return join(app.getPath('userData'), 'agent-api.json')
}

async function loadToken(): Promise<string> {
  const saved = await readJson<{ token?: string }>(tokenFile(), {})
  if (saved.token && saved.token.length >= 32) return saved.token
  return regenerateToken()
}

export async function regenerateToken(): Promise<string> {
  apiToken = randomBytes(32).toString('hex')
  await writeJsonAtomic(tokenFile(), { token: apiToken, note: 'Bearer token for the Hive Agent API. Regenerate it in Settings → Agent API.' })
  return apiToken
}

/** HIVE_API_PORT overrides the setting; development builds default to the next port so they don't clash with the installed app. */
function apiPort(): number {
  const env = Number(process.env.HIVE_API_PORT)
  if (env > 0) return env
  const port = config.settings.agentApi.port
  return !app.isPackaged && port === DEFAULT_API_PORT ? port + 1 : port
}

export function apiInfo(): AgentApiInfo {
  const s = config.settings.agentApi
  // With the Agent API off, the server still runs for the Hive Assistant alone.
  const running = s.enabled && !!apiServer?.listening
  return {
    enabled: s.enabled,
    running,
    url: running ? `http://127.0.0.1:${apiPort()}` : null,
    token: apiToken,
    error: apiError
  }
}

/** The server's address for the Hive Assistant, which reaches it whether or not the Agent API is turned on. */
export function assistantApiUrl(): string | null {
  return apiServer?.listening ? `http://127.0.0.1:${apiPort()}` : null
}

/** Environment passed to sessions so agents (and the Hive MCP server) can reach the API. */
export function apiEnv(): Record<string, string> {
  const info = apiInfo()
  if (!info.running || !info.url) return {}
  return { HIVE_API_URL: info.url, HIVE_API_TOKEN: apiToken, HIVE_API_TOKEN_FILE: tokenFile() }
}

/** An open workspace by its folder path or its name. A name two open workspaces share is refused (409): use the path. */
export function findWorkspace(want: string): WorkspaceService | null {
  const v = want.toLowerCase()
  const byPath = /[\\/]/.test(want) ? resolvePath(want).toLowerCase() : null
  const hits = openWorkspaces().filter((w) => (byPath ? w.path!.toLowerCase() === byPath : basename(w.path!).toLowerCase() === v))
  if (hits.length > 1) {
    throw new HttpError(409, `Several open workspaces are named "${want}" (${hits.map((w) => w.path).join(', ')}): say which by its full path in the X-Hive-Workspace header or ?workspace=`)
  }
  return hits[0] ?? null
}

/** The workspace a request names (X-Hive-Workspace header, or ?workspace=), else the only open one. */
function requestWorkspace(req: IncomingMessage, url: URL): WorkspaceService | null {
  const own = assistantCaller()
  if (own) {
    const w = openWorkspaces().find((x) => x.path!.toLowerCase() === own)
    if (!w) throw new HttpError(409, "The Assistant's workspace isn't open in Hive")
    return w
  }
  const header = req.headers['x-hive-workspace']
  const raw = typeof header === 'string' && header ? decodeURIComponent(header) : url.searchParams.get('workspace')
  if (raw) {
    const w = findWorkspace(raw)
    if (!w) throw new HttpError(404, `Unknown workspace "${raw}": it isn't open in Hive`)
    return w
  }
  const open = openWorkspaces()
  return open.length === 1 ? open[0] : null
}

/** The request's workspace, for calls about a whole workspace (shared notes, MCP servers…). */
function requireWorkspace(): WorkspaceService {
  const w = contextWorkspace()
  if (w) return w
  if (!openWorkspaces().length) throw new HttpError(409, 'No workspace is open')
  throw new HttpError(400, 'Several workspaces are open in Hive: say which with ?workspace=<name> or the X-Hive-Workspace header')
}

/**
 * A project by name: "<project>" in the request's workspace (or, with none named, in whichever open
 * workspace has it: 409 if several do), or "<workspace>/<project>" (encoded as %2F in a URL path).
 */
function projectByName(name: string): string {
  const raw = decodeURIComponent(name)
  if (!openWorkspaces().length) throw new HttpError(409, 'No workspace is open')
  const slash = raw.search(/[\\/]/)
  let project = raw
  let candidates: WorkspaceService[]
  if (slash > 0) {
    const w = findWorkspace(raw.slice(0, slash))
    if (!w) throw new HttpError(404, `Unknown workspace "${raw.slice(0, slash)}": it isn't open in Hive`)
    candidates = [w]
    project = raw.slice(slash + 1)
  } else {
    const ctx = contextWorkspace()
    candidates = ctx ? [ctx] : openWorkspaces()
  }
  const own = assistantCaller()
  // The Assistant looks after its own workspace only.
  if (own) candidates = candidates.filter((w) => w.path!.toLowerCase() === own)
  const hits = candidates.map((w) => join(w.path!, project)).filter((p) => workspace.isProjectPath(p))
  if (!hits.length) throw new HttpError(404, `Unknown project "${raw}"`)
  if (hits.length > 1) throw new HttpError(409, `"${project}" is a project in several open workspaces: name it as <workspace>/<project>, e.g. ${basename(dirname(hits[0]))}/${project}`)
  return hits[0]
}

async function projectSummary(p: string) {
  const info = await workspace.projectInfo(p)
  return {
    name: info.name,
    path: info.path,
    workspace: basename(workspaceOf(p).path ?? ''),
    active: info.active,
    branch: info.branch,
    status: info.live?.status ?? 'stopped',
    sessionId: info.live?.sessionId ?? null,
    statusMessage: info.live?.statusMessage ?? null,
    restartNeeded: info.restartNeeded,
    agents: info.agents.map((a) => ({
      id: a.id,
      name: a.name,
      provider: a.live?.provider ?? agentProvider(a, info.config, config.settings),
      branch: a.worktree?.branch ?? null,
      worktree: a.worktree?.path ?? null,
      status: a.live?.status ?? 'stopped',
      sessionId: a.live?.sessionId ?? null,
      statusMessage: a.live?.statusMessage ?? null
    })),
    settings: info.config
  }
}

/** The agent an API call is for: an agent id or name, else the project's only agent (400 with several, 409 with none). */
async function agentParam(p: string, value: unknown): Promise<string> {
  if (typeof value !== 'string' || !value) {
    const agents = projectAgents(await workspace.projectConfig(p))
    if (agents.length === 1) return agents[0].id
    throw agents.length ? new HttpError(400, 'This project has several agents: say which one with "agent" (its id or name)') : new HttpError(409, 'This project has no agents yet')
  }
  const a = projectAgents(await workspace.projectConfig(p)).find((x) => x.id === value || x.name.toLowerCase() === value.toLowerCase())
  if (!a) throw new HttpError(404, `Unknown agent "${value}"`)
  return a.id
}

type Handler = (ctx: { params: string[]; query: URLSearchParams; body: any }) => Promise<unknown>

/** How recently the user must not have typed in an agent's terminal for anything else to type there. */
const USER_TYPING_MS = 60_000

const LEVEL_NAME: Record<AssistantControl, string> = { look: 'Look and advise', agents: 'Control agents', projects: 'Control agents and create projects' }

/**
 * A change the Hive Assistant asks for: refused beyond its control level or this turn's limit, else run and
 * recorded (its panel's list and hive.log). Other callers can't make these changes through the API.
 */
async function assistantChange<T>(need: AssistantControl, what: string, fn: () => Promise<{ done: string; result: T }>): Promise<T> {
  const ws = assistantCaller()
  if (!ws) throw new HttpError(403, `Only the Hive Assistant can ${what} through the Agent API.`)
  const line = what.charAt(0).toUpperCase() + what.slice(1)
  if (!assistant.allows(need)) {
    assistant.record(ws, line, 'not allowed by Settings → Assistant → Control')
    throw new HttpError(403, `The user's settings (Settings → Assistant → Control: ${LEVEL_NAME[assistant.controlLevel()]}) don't let you ${what}. Tell the user what you would do instead.`)
  }
  if (!assistant.countAction(ws)) {
    assistant.record(ws, line, `limit of ${assistant.MAX_ACTIONS_PER_TURN} changes for one message`)
    throw new HttpError(429, `You have made ${assistant.MAX_ACTIONS_PER_TURN} changes for this message, the most Hive allows for one. Tell the user what is done and ask whether to go on.`)
  }
  try {
    const { done, result } = await fn()
    assistant.record(ws, done)
    return result
  } catch (e) {
    assistant.record(ws, line, (e as Error).message)
    throw e
  }
}

/** For routes that change something and that other callers may use too: the Assistant needs the control level. */
function assistantMay(need: AssistantControl, what: string): void {
  const ws = assistantCaller()
  if (!ws || assistant.allows(need)) return
  assistant.record(ws, what.charAt(0).toUpperCase() + what.slice(1), 'not allowed by Settings → Assistant → Control')
  throw new HttpError(403, `The user's settings (Settings → Assistant → Control: ${LEVEL_NAME[assistant.controlLevel()]}) don't let you ${what}. Tell the user what you would do instead.`)
}

const routes: { method: string; pattern: RegExp; handler: Handler }[] = []
function route(method: string, path: string, handler: Handler): void {
  const pattern = new RegExp('^' + path.replace(/:[a-zA-Z]+/g, '([^/]+)') + '/?$')
  routes.push({ method, pattern, handler })
}

route('GET', '/v1/status', async () => ({
  app: { name: 'Hive', version: app.getVersion() },
  /** Claude Code's install info, as before providers; `providers` has every provider's. */
  agent: providerService.info(CLAUDE_CODE),
  providers: providerService.all(),
  /** The request's workspace (or the only open one); `workspaces` lists every window's. */
  workspace: contextWorkspace()?.path ? { name: basename(contextWorkspace()!.path!), path: contextWorkspace()!.path } : null,
  workspaces: openWorkspaces().map((w) => ({ name: basename(w.path!), path: w.path })),
  // The Hive Assistant belongs to its workspace, not a project; it sees its own workspace's sessions only.
  liveSessions: sessions.liveStates().filter((s) => !assistantCaller() || workspaceOf(s.projectPath).path?.toLowerCase() === assistantCaller()).map((s) => ({ workspace: basename(workspaceOf(s.projectPath).path ?? ''), project: workspace.isAssistantHome(s.projectPath) ? null : basename(s.projectPath), agent: s.agentName ?? null, provider: s.provider, sessionId: s.sessionId || null, status: s.status }))
}))

route('GET', '/v1/workspace', async () => {
  if (!openWorkspaces().length) return null
  const w = requireWorkspace()
  return { name: basename(w.path!), path: w.path, config: w.config }
})

route('GET', '/v1/workspaces', async () => openWorkspaces().map((w) => ({ name: basename(w.path!), path: w.path })))

route('GET', '/v1/projects', async () => {
  // The request's workspace, else every open workspace's projects (each says its workspace).
  const ctx = contextWorkspace()
  const out = []
  for (const w of ctx ? [ctx] : openWorkspaces()) for (const p of await w.listProjectPaths()) out.push(await projectSummary(p))
  return out
})

route('GET', '/v1/projects/:name', async ({ params }) => projectSummary(projectByName(params[0])))

route('POST', '/v1/projects/:name/activate', async ({ params }) => {
  const p = projectByName(params[0])
  if (assistantCaller()) {
    return assistantChange('agents', `activate the project ${basename(p)}`, async () => {
      workspace.setActive(p, true)
      await workspaceOf(p).refresh()
      return { done: `Activated ${basename(p)}`, result: await projectSummary(p) }
    })
  }
  workspace.setActive(p, true)
  await workspaceOf(p).refresh()
  return projectSummary(p)
})

route('POST', '/v1/projects/:name/deactivate', async ({ params }) => {
  const p = projectByName(params[0])
  assistantMay('agents', `deactivate the project ${basename(p)}`)
  if (sessions.liveFor(p)) throw new HttpError(409, 'Stop the running session before deactivating the project')
  workspace.setActive(p, false)
  await workspaceOf(p).refresh()
  return projectSummary(p)
})

route('GET', '/v1/projects/:name/sessions', async ({ params }) => sessions.list(projectByName(params[0])))

route('POST', '/v1/projects/:name/sessions', async ({ params, body }) => {
  const p = projectByName(params[0])
  if (assistantCaller()) throw new HttpError(400, 'Use hive_start_agent (POST /v1/projects/{name}/agents/{agent}/start) to start agents.')
  return sessions.start(p, { resumeId: body?.resumeId, name: body?.name, agentId: await agentParam(p, body?.agent) })
})

route('POST', '/v1/projects/:name/stop', async ({ params, query, body }) => {
  const p = projectByName(params[0])
  if (assistantCaller()) throw new HttpError(400, 'Use hive_stop_agent (POST /v1/projects/{name}/agents/{agent}/stop) to stop agents.')
  const agent = query.get('agent') ?? body?.agent
  sessions.stop(p, agent ? await agentParam(p, agent) : undefined)
  return { ok: true }
})

route('GET', '/v1/projects/:name/usage', async ({ params, query }) => {
  const p = projectByName(params[0])
  const agent = query.get('agent')
  const id = query.get('sessionId') ?? sessions.liveFor(p, agent ? await agentParam(p, agent) : undefined)?.sessionId ??(await sessions.list(p)).find((s) => s.source === 'hive')?.id
  if (!id) throw new HttpError(404, 'No sessions for this project')
  return sessions.usage(p, id)
})

route('POST', '/v1/projects/:name/input', async ({ params, body }) => {
  if (assistantCaller()) throw new HttpError(400, 'Use hive_prompt_agent (POST /v1/projects/{name}/agents/{agent}/prompt) to give agents work.')
  if (!config.settings.agentApi.allowSessionInput) throw new HttpError(403, 'Session input is disabled. Enable it in Settings → Agent API.')
  const p = projectByName(params[0])
  const agentId = await agentParam(p, body?.agent)
  if (!sessions.liveFor(p, agentId)) throw new HttpError(409, 'That agent is not running')
  const text = String(body?.text ?? '')
  writePty(sessions.key(p, agentId),text + (body?.submit === false ? '' : '\r'))
  return { ok: true }
})

route('POST', '/v1/projects/:name/handover', async ({ params, body }) => {
  const own = assistantCaller()
  if (!own && !config.settings.agentApi.allowSessionInput) throw new HttpError(403, 'Session input is disabled. Enable it in Settings → Agent API.')
  const p = projectByName(params[0])
  const from = await agentParam(p, body?.from)
  if (typeof body?.to !== 'string' || !body.to) throw new HttpError(400, 'to is required')
  const to = await agentParam(p, body.to)
  if (from === to) throw new HttpError(400, 'from and to must be different agents')
  const handover = body?.handover !== false
  const start = async (): Promise<void> => {
    // It can take minutes (the handover is written first): answer now, report failures in Hive.
    void sessions.handOver(p, from, to, { handover }).catch((e) => {
      toast('error', 'Could not hand over the work', (e as Error).message, undefined, p)
      if (own) assistant.record(own, `Hand over in ${basename(p)}`, (e as Error).message)
    })
  }
  if (!own) {
    await start()
    return { ok: true }
  }
  const names = projectAgents(await workspace.projectConfig(p))
  const name = (id: string): string => names.find((a) => a.id === id)?.name ?? id
  return assistantChange('agents', `hand ${name(from)}'s work over to ${name(to)} in ${basename(p)}`, async () => {
    // Known at once rather than minutes later: without Hive's tools agents can't write or read a handover.
    if (!sessions.hiveMcp(p)) throw new HttpError(409, "The project's agents don't have Hive's tools (Settings → Agent API is off, or Provide Hive tools to sessions), so they can't write or read a handover. Tell the user.")
    for (const id of [from, to]) {
      if (Date.now() - sessions.userTypedAt(p, id) < USER_TYPING_MS) throw new HttpError(409, `The user typed in ${name(id)}'s terminal in the last minute. Ask the user before handing over.`)
    }
    await start()
    return {
      done: `Handing ${name(from)}'s work over to ${name(to)} in ${basename(p)}${handover ? '' : ' (from the latest handover)'}`,
      result: { ok: true, note: `Hive ${handover ? `asks ${name(from)} for a handover, waits until it exists, then ` : ''}starts ${name(to)} on it. Use hive_wait_for_agents to follow; problems show as notifications and in your actions.` }
    }
  })
})

// ---------------------------------------------------------------------------
// Agents and projects for the Hive Assistant (Settings → Assistant → Control). Reading is open to every caller.
// ---------------------------------------------------------------------------

/** The providers agents can run: whether each is on and installed, and its models, effort levels and modes. */
route('GET', '/v1/providers', async () => {
  const s = config.settings
  return PROVIDERS.map((p) => {
    const info = providerService.info(p.id)
    return {
      id: p.id,
      name: p.name,
      enabled: isProviderEnabled(s, p.id),
      installed: info.found,
      version: info.version,
      problem: info.readiness?.find((r) => r.level === 'error')?.message ?? null,
      isDefault: s.defaultProvider === p.id,
      defaultModel: info.defaultModel ?? null,
      models: info.models?.length ? info.models : p.modelGroups.flatMap((g) => g.models.map((m) => ({ value: m.value, label: m.label }))),
      efforts: p.effortLevels,
      modes: offeredModes(p.id, s).map((m) => ({ value: m.value, label: m.label, description: m.description }))
    }
  })
})

route('POST', '/v1/projects', async ({ body }) => {
  const name = String(body?.name ?? '').trim()
  if (!name) throw new HttpError(400, 'name is required')
  return assistantChange('projects', `create the project "${name}"`, async () => {
    await workspace.createProject(name)
    const p = join(workspace.path!, name)
    workspace.setActive(p, true)
    await workspace.refresh()
    return { done: `Created the project ${name}`, result: await projectSummary(p) }
  })
})

const busy = (s: LiveSessionState | null): boolean => !!s && (s.status === 'working' || s.status === 'waiting' || s.status === 'starting')
const STATUS_WORDS: Record<string, string> = { working: 'working', waiting: 'waiting for the user', starting: 'starting', ready: 'idle', finished: 'idle (finished its task)', error: 'in error', stopped: 'stopped' }
const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n)}…` : t)

async function agentDefOf(p: string, agentId: string) {
  const a = projectAgents(await workspace.projectConfig(p)).find((x) => x.id === agentId)
  if (!a) throw new HttpError(404, 'Unknown agent')
  return a
}

/** Settings from a request body: an agent's provider, model, effort and mode (empty clears an override). */
function agentSettings(body: any): { provider?: ProviderId; model?: string; effort?: EffortLevel; permissionMode?: PermissionMode } {
  const out: { provider?: ProviderId; model?: string; effort?: EffortLevel; permissionMode?: PermissionMode } = {}
  if (body?.provider !== undefined) {
    if (!isKnownProvider(String(body.provider))) throw new HttpError(400, `Unknown provider "${body.provider}". hive_list_providers lists them.`)
    out.provider = String(body.provider) as ProviderId
  }
  if (body?.model !== undefined) out.model = String(body.model)
  if (body?.effort !== undefined) out.effort = String(body.effort) as EffortLevel
  if (body?.mode !== undefined) out.permissionMode = String(body.mode) as PermissionMode
  return out
}

route('POST', '/v1/projects/:name/agents', async ({ params, body }) => {
  const p = projectByName(params[0])
  const project = basename(p)
  return assistantChange('agents', `add an agent to ${project}`, async () => {
    const set = agentSettings(body)
    const provider = set.provider ?? projectDefaultProvider((await workspace.projectConfig(p)), config.settings)
    if (!isProviderEnabled(config.settings, provider)) throw new HttpError(409, `${PROVIDERS.find((x) => x.id === provider)?.name ?? provider} is turned off in Settings → Providers.`)
    const def = await addAgent(p, {
      name: body?.name ? String(body.name) : undefined,
      location: body?.worktree ? 'new-worktree' : 'project',
      branch: body?.branch ? String(body.branch) : undefined,
      base: body?.base ? String(body.base) : undefined,
      ...set,
      provider
    })
    // The view stays where the user has it; the new agent is marked for them.
    emit({ type: 'agent-added', projectPath: p, agentId: def.id })
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
    let started = ''
    if (body?.start || prompt) {
      try {
        await sessions.start(p, { agentId: def.id, prompt: prompt || undefined })
        started = prompt ? ` and started it on: ${clip(prompt.replace(/\s+/g, ' '), 80)}` : ' and started it'
      } catch (e) {
        started = ` (it didn't start: ${(e as Error).message})`
      }
    }
    return { done: `Added ${def.name} to ${project}${def.worktree ? ` (worktree, branch ${def.worktree.branch})` : ''}${started}`, result: { agent: def, project: await projectSummary(p) } }
  })
})

route('PATCH', '/v1/projects/:name/agents/:agent', async ({ params, body }) => {
  const p = projectByName(params[0])
  const agentId = await agentParam(p, params[1] && decodeURIComponent(params[1]))
  const a = await agentDefOf(p, agentId)
  return assistantChange('agents', `change ${a.name}'s settings in ${basename(p)}`, async () => {
    const def = await updateAgent(p, agentId, { ...(body?.name !== undefined ? { name: String(body.name) } : {}), ...agentSettings(body) })
    const live = sessions.liveFor(p, agentId)
    return { done: `Changed ${def.name}'s settings in ${basename(p)}${live ? ' (it applies them when restarted)' : ''}`, result: def }
  })
})

route('POST', '/v1/projects/:name/agents/:agent/start', async ({ params, body }) => {
  const p = projectByName(params[0])
  const agentId = await agentParam(p, decodeURIComponent(params[1]))
  const a = await agentDefOf(p, agentId)
  return assistantChange('agents', `start ${a.name} in ${basename(p)}`, async () => {
    if (sessions.liveFor(p, agentId)) throw new HttpError(409, `${a.name} is already running. Use hive_prompt_agent to give it work once it's idle.`)
    let resumeId: string | undefined
    if (typeof body?.resume === 'string' && body.resume) resumeId = body.resume
    else if (body?.resume) {
      resumeId = (await workspace.projectInfo(p)).agents.find((x) => x.id === agentId)?.resume?.id
      if (!resumeId) throw new HttpError(409, `${a.name} has no conversation to resume. Start it without resume.`)
    }
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
    const st = await sessions.start(p, { agentId, resumeId, prompt: prompt || undefined })
    return { done: `${resumeId ? 'Resumed' : 'Started'} ${a.name} in ${basename(p)}${prompt ? ` on: ${clip(prompt.replace(/\s+/g, ' '), 80)}` : ''}`, result: st }
  })
})

route('POST', '/v1/projects/:name/agents/:agent/stop', async ({ params, body }) => {
  const p = projectByName(params[0])
  const agentId = await agentParam(p, decodeURIComponent(params[1]))
  const a = await agentDefOf(p, agentId)
  const ws = assistantCaller()
  return assistantChange('agents', `stop ${a.name} in ${basename(p)}`, async () => {
    const st = sessions.liveFor(p, agentId)
    if (!st) return { done: `${a.name} in ${basename(p)} wasn't running`, result: { ok: true, wasRunning: false } }
    // Stopping an agent in the middle of something is the user's call.
    if (busy(st) && ws) {
      const said = typeof body?.reason === 'string' ? clip(body.reason.trim(), 300) : ''
      const reason = said ? ` Its reason: ${said}${/[.!?]$/.test(said) ? '' : '.'}` : ''
      const yes = await assistant.ask(ws, {
        title: `Stop ${a.name} in ${basename(p)}?`,
        message: `The Assistant wants to stop ${a.name}, which is ${STATUS_WORDS[st.status] ?? st.status}.${reason} Its conversation is kept and can be resumed.`,
        yes: 'Stop',
        no: "Don't stop"
      })
      if (!yes) throw new HttpError(409, `The user chose not to stop ${a.name}. Leave it running.`)
    }
    sessions.stop(p, agentId)
    return { done: `Stopped ${a.name} in ${basename(p)}`, result: { ok: true, wasRunning: true } }
  })
})

route('POST', '/v1/projects/:name/agents/:agent/prompt', async ({ params, body }) => {
  const p = projectByName(params[0])
  const agentId = await agentParam(p, decodeURIComponent(params[1]))
  const a = await agentDefOf(p, agentId)
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (!text) throw new HttpError(400, 'text is required')
  return assistantChange('agents', `give ${a.name} in ${basename(p)} a task`, async () => {
    const st = sessions.liveFor(p, agentId)
    // Never over the top of the agent's work, a question to the user, or the user's own typing.
    if (!st) throw new HttpError(409, `${a.name} isn't running. Start it with the task instead (hive_start_agent with prompt).`)
    if (st.status === 'starting') throw new HttpError(409, `${a.name} is still starting. Wait for it (hive_wait_for_agents), then try again.`)
    if (st.status === 'waiting') throw new HttpError(409, `${a.name} is waiting for the user${st.statusMessage ? ` (${st.statusMessage})` : ''}. Tell the user; don't answer for them.`)
    if (st.status === 'working') throw new HttpError(409, `${a.name} is working. Wait until it's idle (hive_wait_for_agents), then give it the task.`)
    if (Date.now() - sessions.userTypedAt(p, agentId) < USER_TYPING_MS) throw new HttpError(409, `The user typed in ${a.name}'s terminal in the last minute. Ask the user before giving it a task.`)
    await sessions.sendPrompt(p, agentId, text)
    return { done: `Gave ${a.name} in ${basename(p)} a task: ${clip(text.replace(/\s+/g, ' '), 80)}`, result: { ok: true } }
  })
})

/** What an agent is doing: its status, the task it was last given, its latest reply, its recent tool calls, its locked files. */
async function agentActivity(p: string, agentId: string) {
  const info = await workspace.projectInfo(p)
  const a = info.agents.find((x) => x.id === agentId)
  if (!a) throw new HttpError(404, 'Unknown agent')
  const st = a.live
  const sessionId = st?.sessionId || a.lastSessionId || a.resume?.id || ''
  let currentTask: string | null = null
  let latestReply: string | null = null
  let recentTools: { tool: string; summary: string; failed: boolean }[] = []
  if (sessionId) {
    const t = await transcripts.read(p, sessionId).catch(() => null)
    const items = t?.items ?? []
    const lastUser = items.map((x) => x.kind).lastIndexOf('user')
    const task = lastUser >= 0 ? items[lastUser] : null
    if (task?.kind === 'user') currentTask = clip(task.text, 2000)
    const reply = [...items].reverse().find((x) => x.kind === 'assistant')
    if (reply?.kind === 'assistant') latestReply = clip(reply.text, 3000)
    recentTools = items
      .slice(Math.max(0, lastUser))
      .flatMap((x) => (x.kind === 'tool' ? [{ tool: x.tool.name, summary: clip(x.tool.summary, 200), failed: x.tool.isError }] : []))
      .slice(-10)
  }
  const folder = a.worktree?.path ?? p
  const typed = sessions.userTypedAt(p, agentId)
  return {
    project: info.name,
    agent: a.name,
    id: a.id,
    provider: st?.provider ?? agentProvider(a, info.config, config.settings),
    status: st?.status ?? 'stopped',
    statusMessage: st?.statusMessage ?? null,
    branch: a.worktree?.branch ?? null,
    worktree: a.worktree?.path ?? null,
    sessionId: sessionId || null,
    sessionName: st?.sessionName ?? null,
    currentTask,
    latestReply,
    recentTools,
    lockedFiles: sessions.locksFor(p, agentId).map((f) => relative(folder, f) || f),
    userTypedSecondsAgo: typed ? Math.round((Date.now() - typed) / 1000) : null
  }
}

route('GET', '/v1/projects/:name/agents/:agent/activity', async ({ params }) => {
  const p = projectByName(params[0])
  return agentActivity(p, await agentParam(p, decodeURIComponent(params[1])))
})

/**
 * Waits until agents stop working (or `timeoutSeconds`, at most 10 minutes): the ones named, else every agent
 * working in the workspace. Answers with each one's status, so the caller sees who finished and who needs the user.
 */
route('POST', '/v1/agents/wait', async ({ body }) => {
  const list: { project: string; agent?: string }[] = Array.isArray(body?.agents) ? body.agents : []
  let targets: { p: string; id: string }[] = []
  for (const x of list) {
    const p = projectByName(String(x.project))
    targets.push({ p, id: await agentParam(p, x.agent) })
  }
  if (!list.length) {
    const ws = requireWorkspace()
    targets = sessions.liveStates().filter((s) => busy(s) && workspaceOf(s.projectPath) === ws && !workspace.isAssistantHome(s.projectPath)).map((s) => ({ p: s.projectPath, id: s.agentId }))
  }
  const limit = Math.min(600, Math.max(5, Number(body?.timeoutSeconds) || 300)) * 1000
  const t0 = Date.now()
  const working = (): boolean => targets.some((t) => {
    const s = sessions.liveFor(t.p, t.id)
    return !!s && (s.status === 'working' || s.status === 'starting')
  })
  while (working() && Date.now() - t0 < limit) await new Promise((r) => setTimeout(r, 1000))
  const agents = []
  for (const t of targets) {
    const def = projectAgents(await workspace.projectConfig(t.p)).find((a) => a.id === t.id)
    const s = sessions.liveFor(t.p, t.id)
    agents.push({ project: basename(t.p), agent: def?.name ?? t.id, status: s?.status ?? 'stopped', statusMessage: s?.statusMessage ?? null })
  }
  return { timedOut: working(), waitedSeconds: Math.round((Date.now() - t0) / 1000), agents }
})

route('GET', '/v1/shared', async () => inWorkspace(requireWorkspace(), () => notesTree()))

route('GET', '/v1/shared/file', async ({ query }) => {
  const rel = query.get('path')
  if (!rel) throw new HttpError(400, 'path is required')
  const abs = inWorkspace(requireWorkspace(), () => assertInShared(rel))
  return { path: rel, content: await readFile(abs, 'utf8').catch(() => { throw new HttpError(404, 'Not found') }) }
})

route('PUT', '/v1/shared/file', async ({ query, body }) => {
  const rel = query.get('path') ?? body?.path
  if (!rel) throw new HttpError(400, 'path is required')
  const abs = inWorkspace(requireWorkspace(), () => assertInShared(rel))
  const content = String(body?.content ?? '')
  // Locked from read to write, so two agents appending at once both keep their text.
  await withFileLock(abs, async () => {
    if (body?.append) {
      const existing = await readFile(abs, 'utf8').catch(() => '')
      await writeTextAtomic(abs, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + content)
    } else await writeTextAtomic(abs, content)
  })
  emit({ type: 'notes-changed' })
  return { ok: true, path: rel }
})

route('POST', '/v1/shared/handovers', async ({ body }) => {
  if (!body?.title || !body?.content) throw new HttpError(400, 'title and content are required')
  // For a named project, its workspace's notes; else the request's workspace.
  const ws = body.project ? workspaceOf(projectByName(String(body.project))) : requireWorkspace()
  const file = await inWorkspace(ws, () => createHandover(String(body.project ?? ''), String(body.title), String(body.content)))
  emit({ type: 'notes-changed' })
  toast('info', 'Handover created', `${body.project ? body.project + ': ' : ''}${body.title}`, [{ label: 'Open', command: 'notes.open', args: [file] }])
  return { ok: true, path: file }
})

route('GET', '/v1/skills', async ({ query }) => {
  const project = query.get('project')
  if (project) {
    const p = projectByName(project)
    return inWorkspace(workspaceOf(p), () => listSkills(p))
  }
  return inWorkspace(requireWorkspace(), () => listSkills())
})

route('GET', '/v1/mcp', async () => (await inWorkspace(requireWorkspace(), () => listMcp())).map(({ name, def, globallyEnabled, error }) => ({ name, description: def?.description ?? '', globallyEnabled, error })))

route('POST', '/v1/notify', async ({ body }) => {
  const level: ToastLevel = ['info', 'success', 'warning', 'error'].includes(body?.level) ? body.level : 'info'
  if (!body?.title) throw new HttpError(400, 'title is required')
  toast(level, String(body.title).slice(0, 200), body.message ? String(body.message).slice(0, 2000) : undefined, undefined, body.source ? String(body.source) : 'agent')
  return { ok: true }
})

async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  // Browsers must not be able to drive the API from a web page.
  if (req.headers.origin) return send(res, 403, { error: 'Cross-origin requests are not allowed' })
  const enabled = config.settings.agentApi.enabled
  if (url.pathname === '/v1/health' && enabled) return send(res, 200, { ok: true, app: 'Hive', version: app.getVersion() })
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  const ownWorkspace = bearer ? assistant.assistantForToken(bearer) : null
  const caller: Caller | null = ownWorkspace ? { kind: 'assistant', workspace: ownWorkspace } : enabled && tokenMatches(req.headers.authorization, apiToken) ? { kind: 'api' } : null
  if (!caller) return send(res, enabled ? 401 : 403, { error: enabled ? 'Missing or invalid bearer token' : 'The Agent API is turned off in Settings → Agent API' })
  return callerStore.run(caller, () => serveApi(req, res, url))
}

async function serveApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (url.pathname === '/v1/health') return send(res, 200, { ok: true, app: 'Hive', version: app.getVersion() })

  if (req.method === 'GET' && url.pathname === '/v1/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    res.write(': connected\n\n')
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
    return
  }

  const r = routes.find((x) => x.method === req.method && x.pattern.test(url.pathname))
  if (!r) return send(res, 404, { error: `No route for ${req.method} ${url.pathname}` })
  try {
    const raw = req.method === 'GET' ? '' : await readBody(req)
    let body: unknown = {}
    if (raw) {
      try {
        body = JSON.parse(raw)
      } catch {
        throw new HttpError(400, 'Body must be JSON')
      }
    }
    const params = url.pathname.match(r.pattern)!.slice(1)
    // With several Hive windows, a request is for one workspace: the one it names, or the only one open.
    const ws = requestWorkspace(req, url)
    const run = (): Promise<unknown> => r.handler({ params, query: url.searchParams, body })
    const result = ws ? await inWorkspace(ws, run) : await run()
    send(res, 200, result ?? null)
  } catch (e) {
    const status = e instanceof HttpError ? e.status : statusFor(e as Error)
    if (status === 500) log.error(`API ${req.method} ${url.pathname}`, e)
    send(res, status, { error: (e as Error).message })
  }
}

/** The HTTP status for an error thrown by the session and workspace services, which don't know about HTTP. */
function statusFor(e: Error): number {
  const m = String(e?.message ?? '')
  if (/Invalid session id|URI malformed|Unknown provider|Project names cannot/i.test(m)) return 400
  if (/already running|already open|already being opened|is starting|Stop it first|Stop the|archived|No session is running|ran in .* Resume it|is required to run|is turned off|no agents yet|No workspace|busy/i.test(m)) return 409
  if (/several agents: choose/i.test(m)) return 400
  if (/Not a project|Unknown (project|agent)|no longer exists/i.test(m)) return 404
  return 500
}

function broadcast(event: HiveEvent): void {
  if (!sseClients.size) return
  const allowed: HiveEvent['type'][] = ['session-status', 'session-exit', 'workspace-changed', 'notes-changed', 'skills-changed']
  if (!allowed.includes(event.type)) return
  const payload = event.type === 'workspace-changed' ? { type: event.type, workspace: event.workspace?.path ?? null } : event
  const line = `event: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`
  for (const c of sseClients) c.write(line)
}

export async function startApiServer(): Promise<AgentApiInfo> {
  await stopApiServer()
  apiError = undefined
  if (!apiToken) apiToken = await loadToken()
  // Runs with the Agent API off too, for the Hive Assistant's token alone (see handleApi).
  apiServer = http.createServer((req, res) => void handleApi(req, res))
  try {
    await new Promise<void>((resolve, reject) => {
      apiServer!.once('error', reject)
      apiServer!.listen(apiPort(), '127.0.0.1', () => {
        apiServer!.off('error', reject)
        resolve()
      })
    })
    log.info(`Agent API listening on 127.0.0.1:${apiPort()}`)
  } catch (e) {
    apiError = (e as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `Port ${apiPort()} is already in use` : (e as Error).message
    log.warn(`Agent API failed to start: ${apiError}`)
    apiServer = null
  }
  return apiInfo()
}

export async function stopApiServer(): Promise<void> {
  for (const c of sseClients) c.end()
  sseClients.clear()
  if (apiServer) await new Promise<void>((resolve) => apiServer!.close(() => resolve()))
  apiServer = null
}

onHiveEvent(broadcast)
