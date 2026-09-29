import http, { type IncomingMessage, type ServerResponse } from 'http'
import { randomBytes, timingSafeEqual } from 'crypto'
import { app } from 'electron'
import { join, basename } from 'path'
import { readFile } from 'fs/promises'
import type { AgentApiInfo, HiveEvent, ToastLevel } from '../shared/types'
import { DEFAULT_API_PORT, MAIN_AGENT, projectAgents } from '../shared/defaults'
import { agentService } from './agentService'
import { config } from './config'
import { emit, onHiveEvent, toast } from './events'
import { readJson, writeJsonAtomic, writeTextAtomic } from './fsutil'
import { createLogger } from './logger'
import { listMcp } from './mcp'
import { assertInShared, createHandover, notesTree } from './notes'
import { writePty } from './ptyHost'
import { sessions } from './sessions'
import { listSkills } from './skills'
import { workspace } from './workspace'

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
// Hook server: receives Claude Code HTTP hooks. Random port, token from env.
// ---------------------------------------------------------------------------

let hookServer: http.Server | null = null

export async function startHookServer(): Promise<string> {
  hookServer = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/hook')) return send(res, 404, { error: 'not found' })
    if (!tokenMatches(req.headers.authorization, sessions.hookToken)) return send(res, 401, { error: 'unauthorized' })
    try {
      const body = JSON.parse((await readBody(req)) || '{}')
      if (req.url.startsWith('/hook?statusline')) {
        // The reply becomes Claude Code's status line, so send nothing.
        res.writeHead(204)
        res.end()
        sessions.handleStatusLine(body)
        return
      }
      // PreToolUse waits for Hive's file-lock decision; other hooks are answered at once so they never slow the agent down.
      const reply = body.hook_event_name === 'PreToolUse' ? sessions.preToolUse(body) : null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(reply ?? {}))
      await sessions.handleHook(body)
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
  return {
    enabled: s.enabled,
    running: !!apiServer?.listening,
    url: apiServer?.listening ? `http://127.0.0.1:${apiPort()}` : null,
    token: apiToken,
    error: apiError
  }
}

/** Environment passed to sessions so agents (and the Hive MCP server) can reach the API. */
export function apiEnv(): Record<string, string> {
  const info = apiInfo()
  if (!info.running || !info.url) return {}
  return { HIVE_API_URL: info.url, HIVE_API_TOKEN: apiToken, HIVE_API_TOKEN_FILE: tokenFile() }
}

function projectByName(name: string): string {
  if (!workspace.path) throw new HttpError(409, 'No workspace is open')
  const p = join(workspace.path, decodeURIComponent(name))
  if (!workspace.isProjectPath(p)) throw new HttpError(404, `Unknown project "${name}"`)
  return p
}

async function projectSummary(p: string) {
  const info = await workspace.projectInfo(p)
  return {
    name: info.name,
    path: info.path,
    active: info.active,
    branch: info.branch,
    status: info.live?.status ?? 'stopped',
    sessionId: info.live?.sessionId ?? null,
    statusMessage: info.live?.statusMessage ?? null,
    restartNeeded: info.restartNeeded,
    agents: info.agents.map((a) => ({
      id: a.id,
      name: a.name,
      branch: a.worktree?.branch ?? null,
      worktree: a.worktree?.path ?? null,
      status: a.live?.status ?? 'stopped',
      sessionId: a.live?.sessionId ?? null,
      statusMessage: a.live?.statusMessage ?? null
    })),
    settings: info.config
  }
}

/** The agent an API call is for: an agent id or name, else Agent 1. */
async function agentParam(p: string, value: unknown): Promise<string> {
  if (typeof value !== 'string' || !value) return MAIN_AGENT
  const a = projectAgents(await workspace.projectConfig(p)).find((x) => x.id === value || x.name.toLowerCase() === value.toLowerCase())
  if (!a) throw new HttpError(404, `Unknown agent "${value}"`)
  return a.id
}

type Handler = (ctx: { params: string[]; query: URLSearchParams; body: any }) => Promise<unknown>

const routes: { method: string; pattern: RegExp; handler: Handler }[] = []
function route(method: string, path: string, handler: Handler): void {
  const pattern = new RegExp('^' + path.replace(/:[a-zA-Z]+/g, '([^/]+)') + '/?$')
  routes.push({ method, pattern, handler })
}

route('GET', '/v1/status', async () => ({
  app: { name: 'Hive', version: app.getVersion() },
  agent: agentService.info,
  workspace: workspace.path ? { name: basename(workspace.path), path: workspace.path } : null,
  liveSessions: sessions.liveStates().map((s) => ({ project: basename(s.projectPath), agent: s.agentName ?? null, sessionId: s.sessionId, status: s.status }))
}))

route('GET', '/v1/workspace', async () => {
  if (!workspace.path) return null
  return { name: basename(workspace.path), path: workspace.path, config: workspace.config }
})

route('GET', '/v1/projects', async () => {
  const out = []
  for (const p of await workspace.listProjectPaths()) out.push(await projectSummary(p))
  return out
})

route('GET', '/v1/projects/:name', async ({ params }) => projectSummary(projectByName(params[0])))

route('POST', '/v1/projects/:name/activate', async ({ params }) => {
  const p = projectByName(params[0])
  workspace.setActive(p, true)
  await workspace.refresh()
  return projectSummary(p)
})

route('POST', '/v1/projects/:name/deactivate', async ({ params }) => {
  const p = projectByName(params[0])
  if (sessions.liveFor(p)) throw new HttpError(409, 'Stop the running session before deactivating the project')
  workspace.setActive(p, false)
  await workspace.refresh()
  return projectSummary(p)
})

route('GET', '/v1/projects/:name/sessions', async ({ params }) => sessions.list(projectByName(params[0])))

route('POST', '/v1/projects/:name/sessions', async ({ params, body }) => {
  const p = projectByName(params[0])
  return sessions.start(p, { resumeId: body?.resumeId, name: body?.name, agentId: await agentParam(p, body?.agent) })
})

route('POST', '/v1/projects/:name/stop', async ({ params, query, body }) => {
  const p = projectByName(params[0])
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
  if (!config.settings.agentApi.allowSessionInput) throw new HttpError(403, 'Session input is disabled. Enable it in Settings → Agent API.')
  const p = projectByName(params[0])
  const agentId = await agentParam(p, body?.agent)
  if (!sessions.liveFor(p, agentId)) throw new HttpError(409, agentId === MAIN_AGENT ? 'No running session for this project' : 'That agent is not running')
  const text = String(body?.text ?? '')
  writePty(sessions.key(p, agentId),text + (body?.submit === false ? '' : '\r'))
  return { ok: true }
})

route('GET', '/v1/shared', async () => notesTree())

route('GET', '/v1/shared/file', async ({ query }) => {
  const rel = query.get('path')
  if (!rel) throw new HttpError(400, 'path is required')
  const abs = assertInShared(rel)
  return { path: rel, content: await readFile(abs, 'utf8').catch(() => { throw new HttpError(404, 'Not found') }) }
})

route('PUT', '/v1/shared/file', async ({ query, body }) => {
  const rel = query.get('path') ?? body?.path
  if (!rel) throw new HttpError(400, 'path is required')
  const abs = assertInShared(rel)
  const content = String(body?.content ?? '')
  if (body?.append) {
    const existing = await readFile(abs, 'utf8').catch(() => '')
    await writeTextAtomic(abs, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + content)
  } else await writeTextAtomic(abs, content)
  emit({ type: 'notes-changed' })
  return { ok: true, path: rel }
})

route('POST', '/v1/shared/handovers', async ({ body }) => {
  if (!body?.title || !body?.content) throw new HttpError(400, 'title and content are required')
  const file = await createHandover(String(body.project ?? ''), String(body.title), String(body.content))
  emit({ type: 'notes-changed' })
  toast('info', 'Handover created', `${body.project ? body.project + ': ' : ''}${body.title}`, [{ label: 'Open', command: 'notes.open', args: [file] }])
  return { ok: true, path: file }
})

route('GET', '/v1/skills', async ({ query }) => {
  const project = query.get('project')
  return listSkills(project ? projectByName(project) : undefined)
})

route('GET', '/v1/mcp', async () => (await listMcp()).map(({ name, def, globallyEnabled, error }) => ({ name, description: def?.description ?? '', globallyEnabled, error })))

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
  if (url.pathname === '/v1/health') return send(res, 200, { ok: true, app: 'Hive', version: app.getVersion() })
  if (!tokenMatches(req.headers.authorization, apiToken)) return send(res, 401, { error: 'Missing or invalid bearer token' })

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
    const result = await r.handler({ params, query: url.searchParams, body })
    send(res, 200, result ?? null)
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500
    if (status === 500) log.error(`API ${req.method} ${url.pathname}`, e)
    send(res, status, { error: (e as Error).message })
  }
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
  const s = config.settings.agentApi
  if (!s.enabled) return apiInfo()
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
