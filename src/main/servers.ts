import http, { type IncomingMessage, type ServerResponse } from 'http'
import { AsyncLocalStorage } from 'async_hooks'
import { randomBytes, timingSafeEqual } from 'crypto'
import { app } from 'electron'
import { basename, dirname, join, relative, resolve as resolvePath } from 'path'
import { stat } from 'original-fs/promises'
import type { AgentApiInfo, AssistantControl, EffortLevel, HiveEvent, LiveSessionState, PermissionMode, ProviderId, SkillInfo, TaskCard, TaskColumn, TaskPatch, TaskStartTarget, ToastLevel } from '../shared/types'
import { DEFAULT_API_PORT, HIVE_DIR, projectAgents, stopAsksUser, transcriptWarnLimit } from '../shared/defaults'
import { PROVIDERS, agentProvider, isKnownProvider, isProviderEnabled, offeredModes, projectDefaultProvider, providerName } from '../shared/providers'
import { fallbackEfforts, modelGroups } from '../shared/models'
import { ASSISTANT_AGENT_ID, ASSISTANT_DIR, ASSISTANT_NAME } from '../shared/assistant'
import { timeLeft } from '../shared/progress'
import { ProgressError, admitReport, type ProgressCaller } from './progress'
import { progress, progressGate } from './progressService'
import { COLUMN_CHOICES, columnLabel, isTaskColumn, reviewStalled, stalledReason } from '../shared/tasks'
import type { HandoverAuthor } from '../shared/hiveGuidance'
import { newestComments, progressLabel, taskRow, withoutHistory, type ProjectRow, type SkillRow, type TaskChange, type TaskReorder, type TaskView } from '../shared/toolReplies'
import * as assistant from './assistantControl'
import { SettingRefused, applySetting, checkedValue, entryOf, projectOf, restartText, settingDetail, settingRows } from './settingsTools'
import { settingChangeTexts, settingPath, type SettingEntry, type SettingScope } from '../shared/settingsCatalog'
import { addAgent, updateAgent } from './projectAgents'
import { providerService } from './providerService'
import { config } from './config'
import { emit, onHiveEvent, toast } from './events'
import { cancelWatch, encodeSince, registerWatch, scopedCard } from './watches'
import { alreadyThere, cardChange, changesBetween, decodeSince, markOf, movedIntoSince, readCondition, AGENT_WAIT_MAX_SECONDS, WAIT_MAX_SECONDS, WATCH_DEFAULT_LIMIT_MINUTES, WATCH_MAX_LIMIT_MINUTES, type CardChange, type CardMark } from '../shared/watch'
import { insideReal, readCapped, readJson, writeJsonAtomic } from './fsutil'
import { GUIDANCE_REVISION, skillRevisions } from './guidance'
import agentApiDoc from '../../docs/AGENT_API.md?raw'
import { createLogger } from './logger'
import { listMcp } from './mcp'
import { assertInShared, createHandover, NoteConflict, notesTree, readNote, writeNote } from './notes'
import { mergeSlots } from './mergeSlotHost'
import { DEFAULT_WAIT_MS, MAX_WAIT_MS, MergeSlotError, slotBranch, slotCards, type SlotAgent } from './mergeSlots'
import { writePty } from './ptyHost'
import { sessions } from './sessions'
import * as tasks from './tasks'
import { startTask } from './taskStart'
import { hiveSkills, listSkills, skillFiles, validSkillName } from './skills'
import { transcripts } from './transcripts'
import { contextWorkspace, inWorkspace, openWorkspaces, workspace, workspaceFor, workspaceOf, type WorkspaceService } from './workspace'
import { lastCardRead, newDecisions, noteCardRead, noticeText } from './decisionNotices'
import { appMetrics, clock as metricsClock, knownRoute, metricsHandle, recordApi, recordCatalog, recordMcp, MCP_REPORT_LIMITS, type MetricsHandle } from './metrics'
import { metricsReport } from './metricsUsage'
import type { MetricOutcome, MetricsQuery } from '../shared/metrics'
import { agentForToken, agentToken, agentTokenFile, type AgentIdentity } from './agentTokens'
import { hookTokenMatches } from './hookTokens'
import { unusedWorktreeCounts } from './unusedWorktrees'

const log = createLogger('servers')
const MAX_BODY = 2 * 1024 * 1024

function tokenMatches(header: string | undefined, token: string): boolean {
  const got = Buffer.from((header ?? '').replace(/^Bearer\s+/i, ''))
  const want = Buffer.from(token)
  return got.length === want.length && timingSafeEqual(got, want)
}

/** A request's body as text. `onChunk` hears each chunk's bytes as they arrive (a partial or refused body too). */
function readBody(req: IncomingMessage, onChunk?: (bytes: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      onChunk?.(c.length)
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
    message: string,
    /** More of the reply's body, beside `error` (a conflict's current revision). */
    public extra?: Record<string, unknown>
  ) {
    super(message)
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : JSON.stringify(body)
  const m = apiRequests.get(res)
  if (m) m.responseBytes = Buffer.byteLength(text, 'utf8')
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
  res.end(text)
}

// ---------------------------------------------------------------------------
// Hook server: receives the agents' CLI hooks. Random port; ?run=<runId> names the launch, whose own token it needs.
// ---------------------------------------------------------------------------

let hookServer: http.Server | null = null

export async function startHookServer(): Promise<string> {
  hookServer = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/hook')) return send(res, 404, { error: 'not found' })
    const query = new URL(req.url, 'http://127.0.0.1').searchParams
    const run = query.get('run')
    // Only the launch's own token, while it runs (#345).
    if (!hookTokenMatches(run, req.headers.authorization)) return send(res, 401, { error: 'unauthorized' })
    try {
      const body = JSON.parse((await readBody(req)) || '{}')
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
/** Who is calling: a script with the workspace token, the Assistant, or a project agent (by its own token). */
/** An Assistant caller keeps the token it came with: one launch's, which its later work is checked against (#186). */
type Caller = { kind: 'api' } | { kind: 'assistant'; workspace: string; token: string } | ({ kind: 'agent' } & AgentIdentity)
const callerStore = new AsyncLocalStorage<Caller>()

/** The project agent making the call (known by its token), or null. */
function agentCaller(): AgentIdentity | null {
  const c = callerStore.getStore()
  return c?.kind === 'agent' ? c : null
}

function assistantCaller(): string | null {
  const c = callerStore.getStore()
  return c?.kind === 'assistant' ? c.workspace : null
}

/** The token the Assistant's request came with (its launch's), or null for another caller. */
function assistantCallerToken(): string | null {
  const c = callerStore.getStore()
  return c?.kind === 'assistant' ? c.token : null
}
let apiError: string | undefined
/** Event-stream clients, with the project agent each is (null: a script, which gets every event). */
const sseClients = new Map<ServerResponse, AgentIdentity | null>()

/** What an Agent API request is measured as (metrics.ts), filled in as it is handled and recorded when it ends. */
interface ApiRequest {
  route: string
  /** The workspace's metrics as they were when the request came in: recorded there, or not at all if it has closed. */
  handle: MetricsHandle | null
  project: string | null
  role: 'agent' | 'assistant' | 'api' | 'unknown'
  requestBytes: number
  responseBytes: number
  /** Not counted as API traffic: the bridge's own metrics reports, event streams (counted as streams), the health check. */
  skip: boolean
  authenticated: boolean
}
const apiRequests = new WeakMap<ServerResponse, ApiRequest>()

/** How a request ended, for its metrics: an aborted one is cancelled, else by its status. */
function outcomeOf(res: ServerResponse): MetricOutcome {
  if (!res.writableFinished) return 'cancelled'
  const s = res.statusCode
  return s < 400 ? 'ok' : s === 401 || s === 403 ? 'denied' : s < 500 ? 'client-error' : 'server-error'
}

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

/**
 * Environment passed to an agent's session so it (and its hive tools) can reach the API: with the agent's own token
 * for this launch (agentTokens.ts), never the workspace's, so the API knows which project's agent is calling.
 */
export function apiEnv(projectPath: string, agentId: string): Record<string, string> {
  const info = apiInfo()
  const token = agentToken(projectPath, agentId)
  if (!info.running || !info.url || !token) return {}
  return { HIVE_API_URL: info.url, HIVE_API_TOKEN: token, HIVE_API_TOKEN_FILE: agentTokenFile(projectPath, agentId) }
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
  // An agent's calls are about its own workspace, whatever the request names.
  const agent = agentCaller()
  if (agent) {
    const w = openWorkspaces().find((x) => x.path!.toLowerCase() === agent.workspace.toLowerCase())
    if (!w) throw new HttpError(409, "The agent's workspace isn't open in Hive")
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

/** A watching agent's watch, as every status reply gives it (small: what for and until when); undefined otherwise. */
const watchingOf = (live: LiveSessionState | null | undefined) =>
  live?.status === 'watching' && live.watch ? { cards: live.watch.cards, ...(live.watch.column ? { column: live.watch.column } : {}), changes: live.watch.changes, label: live.watch.label, limitAt: live.watch.limitAt } : undefined
/** An agent's open progress run, as status replies give it (small: what, how far, time left); undefined without one. */
function progressOf(projectPath: string, agentId: string) {
  const r = progress.openRunOf(projectPath, agentId)
  if (!r) return undefined
  const etaMs = timeLeft(r, Date.now())
  return { title: r.title, ...(r.total !== null ? { step: r.step ?? 0, total: r.total } : {}), ...(r.stepName ? { stepName: r.stepName } : {}), ...(etaMs !== null ? { etaMs } : {}), ...(r.state === 'stale' ? { stale: true } : {}) }
}

/** An agent's status message: a watching agent's is what it waits for. */
const statusMessageOf = (live: LiveSessionState | null | undefined): string | null =>
  live?.status === 'watching'
    ? (live.watch?.label ?? null)
    : live?.status === 'signin'
      ? `Its CLI's sign-in has expired: the user must sign in again (${live.signIn?.message ?? 'not signed in'})`
      : (live?.statusMessage ?? live?.mergeSlot ?? null)

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
    statusMessage: statusMessageOf(info.live),
    restartNeeded: info.restartNeeded,
    agents: info.agents.map((a) => ({
      id: a.id,
      name: a.name,
      provider: a.live?.provider ?? agentProvider(a, info.config, config.settings),
      branch: a.worktree?.branch ?? null,
      worktree: a.worktree?.path ?? null,
      status: a.live?.status ?? 'stopped',
      sessionId: a.live?.sessionId ?? null,
      statusMessage: statusMessageOf(a.live),
      ...(watchingOf(a.live) ? { watching: watchingOf(a.live) } : {}),
      ...(progressOf(p, a.id) ? { progress: progressOf(p, a.id) } : {}),
      // An action under the CLI's automatic review (as asked); never a question for the user.
      reviewing: a.live?.review ?? null,
      backgroundTasks: a.live?.backgroundTasks ?? 0,
      // The guidance and skill revisions it launched with (compare with GET /v1/status's to spot an old launch).
      launched: a.live?.launched ?? null
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

/** `signal` aborts when the client goes away before its reply (a long wait it no longer waits for). */
type Handler = (ctx: { params: string[]; query: URLSearchParams; body: any; signal: AbortSignal }) => Promise<unknown>

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

const routes: { method: string; pattern: RegExp; template: string; handler: Handler }[] = []
function route(method: string, path: string, handler: Handler): void {
  const pattern = new RegExp('^' + path.replace(/:[a-zA-Z]+/g, '([^/]+)') + '/?$')
  routes.push({ method, pattern, template: path, handler })
  // The template (/v1/tasks/:n), never the path asked for, is what a request is counted under.
  knownRoute(path)
}

/** The Agent API's contract version: goes up when a route or field changes in a way a client would notice. */
export const API_VERSION = 2

/** Who Hive takes a request's caller for, and what it may reach (GET /v1/status). */
async function callerInfo(): Promise<Record<string, unknown>> {
  const own = assistantCaller()
  if (own) return { role: 'assistant', workspace: basename(own), control: assistant.controlLevel() }
  const a = agentCaller()
  if (a) {
    const def = await workspace
      .projectConfig(a.projectPath)
      .then((cfg) => projectAgents(cfg).find((x) => x.id === a.agentId))
      .catch(() => undefined)
    return { role: 'agent', project: basename(a.projectPath), agent: def?.name ?? a.agentId, scope: 'project' }
  }
  return { role: 'api', scope: 'workspace' }
}

route('GET', '/v1/status', async () => ({
  app: { name: 'Hive', version: app.getVersion() },
  api: { version: API_VERSION },
  caller: await callerInfo(),
  // The guidance this Hive gives sessions, and the request's workspace's Hive skills (null without one).
  guidance: { revision: GUIDANCE_REVISION, skills: contextWorkspace() ? await inWorkspace(contextWorkspace()!, () => skillRevisions()) : null },
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

/** A project in a short listing (?view=short): its state and agents, without ids, paths or settings. */
async function projectRow(p: string): Promise<ProjectRow> {
  const s = await projectSummary(p)
  return { name: s.name, workspace: s.workspace, active: s.active, branch: s.branch, agents: s.agents.map((a) => ({ name: a.name, provider: a.provider, status: a.status, branch: a.branch, backgroundTasks: a.backgroundTasks, ...(a.watching ? { watching: a.watching.label } : {}), ...(a.progress ? { progress: progressLabel(a.progress) } : {}) })) }
}

route('GET', '/v1/projects', async ({ query }) => {
  // The request's workspace, else every open workspace's projects (each says its workspace).
  const ctx = contextWorkspace()
  const short = query.get('view') === 'short'
  const out = []
  for (const w of ctx ? [ctx] : openWorkspaces()) for (const p of await w.listProjectPaths()) out.push(short ? await projectRow(p) : await projectSummary(p))
  return out
})

// One project, with its unused worktrees (#353) when it has any, for the Assistant to mention: counts only, here alone
// (a git check per worktree, too much for every listing). Removing them is the user's (no route).
route('GET', '/v1/projects/:name', async ({ params }) => {
  const p = projectByName(params[0])
  const unused = await unusedWorktreeCounts(p)
  return { ...(await projectSummary(p)), ...(unused ? { unusedWorktrees: unused } : {}) }
})

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

/**
 * A project agent (by its own token) looks into and types into only its own project's agents: another project's
 * conversations can hold that project's cards (a card started on an agent is its prompt), which are not its to see.
 * Status stays open to it (projects, project status, waiting for agents); the Assistant and scripts see everything.
 */
function ownProjectOnly(p: string, what: string): void {
  const a = agentCaller()
  if (a && resolvePath(a.projectPath).toLowerCase() !== resolvePath(p).toLowerCase()) {
    throw new HttpError(403, `${what} is only for your own project's agents (${basename(a.projectPath)}). Another project's work is for its own agents, the Hive Assistant and the user.`)
  }
}

route('GET', '/v1/projects/:name/sessions', async ({ params }) => {
  const p = projectByName(params[0])
  ownProjectOnly(p, "Reading an agent's sessions")
  return sessions.list(p)
})

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
  const usage = await sessions.usage(p, id)
  // ?days=false: without the usage by day, which grows with every day the session runs.
  if (usage && query.get('days') === 'false') {
    const { days: _days, ...rest } = usage
    return rest
  }
  return usage
})

route('POST', '/v1/projects/:name/input', async ({ params, body }) => {
  if (assistantCaller()) throw new HttpError(400, 'Use hive_prompt_agent (POST /v1/projects/{name}/agents/{agent}/prompt) to give agents work.')
  if (!config.settings.agentApi.allowSessionInput) throw new HttpError(403, 'Session input is disabled. Enable it in Settings → Agent API.')
  const p = projectByName(params[0])
  ownProjectOnly(p, 'Typing into an agent')
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
  const handover = body?.handover !== false
  // Known at once rather than later in a notification: from the latest handover, there has to be one.
  if (!handover && !(await sessions.latestHandover(p))) throw new HttpError(409, `There is no handover for ${basename(p)} yet. Hand over with a new handover (handover: true) instead.`)
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
      if (sessions.userMayBeTyping(p, id)) throw new HttpError(409, `The user has just typed in ${name(id)}'s terminal and may still be writing there. Ask the user before handing over.`)
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
      // What the pickers offer: the CLI's own models, else the fallback list in Settings (#125).
      models: modelGroups(p.id, info, s).filter((g) => !g.unavailable).flatMap((g) => g.models.map((m) => ({ value: m.value, label: m.label }))),
      efforts: fallbackEfforts(p.id, s),
      // Whether agents can be given context200k (a 200K window instead of the model's 1M).
      context200k: p.capabilities.contextLimit,
      modes: offeredModes(p.id, s).map((m) => ({ value: m.value, label: m.label, description: m.description }))
    }
  })
})

// --- Hive's settings (#186): anyone with a token reads them (the settings catalog's entries with their values); only
// the Hive Assistant changes them, with Settings → Assistant → Control → Change settings on, and never a sensitive one.
const SETTING_SCOPES: readonly SettingScope[] = ['app', 'provider', 'workspace', 'project']

/** A settings call's project, by name (null without one). */
const settingsProject = (name: unknown): string | null => (typeof name === 'string' && name.trim() ? projectByName(name.trim()) : null)

/** Runs a settings call, turning what settingsTools refuses into the API's answer. */
async function settingsCall<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throw e instanceof SettingRefused ? new HttpError(e.status, e.message) : e
  }
}

route('GET', '/v1/settings', ({ query }) =>
  settingsCall(async () => {
    const scope = query.get('scope') || undefined
    if (scope && !SETTING_SCOPES.includes(scope as SettingScope)) throw new HttpError(400, `scope is one of ${SETTING_SCOPES.join(', ')}.`)
    const p = settingsProject(query.get('project'))
    if (scope === 'project' && !p) throw new HttpError(400, "A project's settings need its name: project=<name>.")
    return settingRows({ query: query.get('query') ?? '', scope: scope as SettingScope | undefined, project: await projectOf(p) })
  })
)

route('GET', '/v1/settings/:id', ({ params, query }) => settingsCall(async () => settingDetail(entryOf(decodeURIComponent(params[0])), await projectOf(settingsProject(query.get('project'))))))

route('PATCH', '/v1/settings/:id', ({ params, body }) =>
  settingsCall(async () => {
    const e = entryOf(decodeURIComponent(params[0]))
    const p = settingsProject(body?.project)
    if (e.scope === 'project' && !p) throw new HttpError(400, `${e.id} is a project's setting: say which project.`)
    return settingsChange(e, body?.value, e.scope === 'project' ? p : null)
  })
)

/**
 * A setting the Hive Assistant changes: only with Change settings on, never a sensitive one (its own Control included),
 * within this turn's limit of changes, and listed in its panel with old → new for Revert. Other callers can't.
 */
async function settingsChange(e: SettingEntry, value: unknown, projectPath: string | null) {
  const path = settingPath(e)
  const where = projectPath ? ` in ${basename(projectPath)}` : ''
  const ws = assistantCaller()
  if (!ws) throw new HttpError(403, `Only the Hive Assistant can change Hive's settings through the Agent API: the user changes them in ${path}.`)
  const line = `Change ${path}${where}`
  if (config.settings.assistant?.changeSettings !== true) {
    assistant.record(ws, line, 'not allowed: Settings → Assistant → Control → Change settings is off')
    throw new HttpError(403, `The user's settings don't let you change settings (Settings → Assistant → Control → Change settings is off). Tell the user how to change it in ${path}, or that turning Change settings on lets you.`)
  }
  if (e.sensitive) {
    assistant.record(ws, line, 'only the user can change it')
    throw new HttpError(403, `${e.readOnly} Tell the user how, instead.`)
  }
  // Checked before it counts as a change: a value it can't take is the Assistant's to fix, not one of its 30.
  await settingsCall(() => checkedValue(e, value, projectPath))
  if (!assistant.countAction(ws)) {
    assistant.record(ws, line, `limit of ${assistant.MAX_ACTIONS_PER_TURN} changes for one message`)
    throw new HttpError(429, `You have made ${assistant.MAX_ACTIONS_PER_TURN} changes for this message, the most Hive allows for one. Tell the user what is done and ask whether to go on.`)
  }
  // Asked again at the moment of the change (a project's under its lock, after any wait for it): Change settings may have
  // been turned off, or the Assistant stopped, meanwhile.
  // The same session, too: one started since (a restart) mustn't carry out this one's pending change.
  const token = assistantCallerToken() ?? ''
  const stillAllowed = (): void => {
    if (config.settings.assistant?.changeSettings !== true) throw new SettingRefused(403, `Settings → Assistant → Control → Change settings was turned off before the change was made: nothing changed. Tell the user how to change ${path} themselves.`)
    if (!assistant.isCurrentToken(ws, token)) throw new SettingRefused(409, "The Assistant's session that asked for this ended before the change was made: nothing changed.")
  }
  try {
    // The value as sent (applySetting checks it again): a provider's prices take null, Hive's own, as more than {}.
    const r = await applySetting(e, value, projectPath, stillAllowed)
    // What changed, as the list and the reply show it: a table's changed entries, not its size.
    const { oldText, newText } = settingChangeTexts(e, r.old, r.new, r.removed)
    const changed = JSON.stringify(r.old) !== JSON.stringify(r.new) || !!r.removed
    if (changed) {
      assistant.record(ws, `Changed ${path}${where}: ${oldText} → ${newText}`, undefined, { setting: { id: e.id, ...(projectPath ? { project: projectPath } : {}), path, old: r.old, new: r.new, ...(r.removed ? { removed: r.removed } : {}), oldText, newText } })
    }
    const restart = restartText(e)
    return { id: e.id, title: e.title, path, ...(projectPath ? { project: basename(projectPath) } : {}), changed, old: oldText, new: newText, ...(restart ? { restart } : {}) }
  } catch (err) {
    assistant.record(ws, line, (err as Error).message)
    throw err instanceof SettingRefused ? new HttpError(err.status, err.message) : err
  }
}

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

const busy = (s: LiveSessionState | null): boolean => !!s && (s.status === 'working' || s.status === 'waiting' || s.status === 'starting' || s.status === 'background' || s.status === 'signin')
const STATUS_WORDS: Record<string, string> = {
  working: 'working',
  waiting: 'waiting for the user',
  signin: 'waiting for the user to sign in to its CLI again (its sign-in expired)',
  starting: 'starting',
  background: 'waiting on background tasks it started',
  watching: 'waiting for cards to change (a card watch: its card loop pauses until it is resumed)',
  ready: 'idle',
  finished: 'idle (finished its task)',
  error: 'in error',
  stopped: 'stopped'
}
const tasksWord = (n: number): string => `${n} background task${n === 1 ? '' : 's'}`
const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n)}…` : t)

async function agentDefOf(p: string, agentId: string) {
  const a = projectAgents(await workspace.projectConfig(p)).find((x) => x.id === agentId)
  if (!a) throw new HttpError(404, 'Unknown agent')
  return a
}

/** Settings from a request body: an agent's provider, model, effort, mode and 200K context (empty clears an override). */
function agentSettings(body: any): { provider?: ProviderId; model?: string; effort?: EffortLevel; permissionMode?: PermissionMode; use200kContext?: boolean | null } {
  const out: { provider?: ProviderId; model?: string; effort?: EffortLevel; permissionMode?: PermissionMode; use200kContext?: boolean | null } = {}
  if (body?.provider !== undefined) {
    if (!isKnownProvider(String(body.provider))) throw new HttpError(400, `Unknown provider "${body.provider}". hive_list_providers lists them.`)
    out.provider = String(body.provider) as ProviderId
  }
  if (body?.model !== undefined) out.model = String(body.model)
  if (body?.effort !== undefined) out.effort = String(body.effort) as EffortLevel
  if (body?.mode !== undefined) out.permissionMode = String(body.mode) as PermissionMode
  const c = body?.context200k
  if (c !== undefined) {
    if (c === true || c === 'on') out.use200kContext = true
    else if (c === false || c === 'off') out.use200kContext = false
    else if (c === null || c === '') out.use200kContext = null
    else throw new HttpError(400, 'context200k is "on", "off" or "" (follow the project).')
  }
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
      use200kContext: set.use200kContext ?? undefined,
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
    // Stopping an agent in the middle of something is the user's call: also one watching cards (its card loop stops).
    if (stopAsksUser(st.status) && ws) {
      const said = typeof body?.reason === 'string' ? clip(body.reason.trim(), 300) : ''
      const reason = said ? ` Its reason: ${said}${/[.!?]$/.test(said) ? '' : '.'}` : ''
      const yes = await assistant.ask(ws, {
        title: `Stop ${a.name} in ${basename(p)}?`,
        message: `The Assistant wants to stop ${a.name}, which is ${st.status === 'watching' && st.watch ? `${st.watch.label.replace(/^Waiting/, 'waiting')} (a card watch: its card loop pauses until it is resumed)` : (STATUS_WORDS[st.status] ?? st.status)}.${reason} Its conversation is kept and can be resumed.`,
        yes: 'Stop',
        no: "Don't stop"
      })
      if (!yes) throw new HttpError(409, `The user chose not to stop ${a.name}. Leave it running.`)
      // The answer can come minutes later: only the run the user was asked about, and only if Control still allows it.
      if (sessions.liveFor(p, agentId)?.runId !== st.runId) return { done: `${a.name} in ${basename(p)} had already stopped`, result: { ok: true, wasRunning: false } }
      if (!assistant.allows('agents')) throw new HttpError(403, `The user's settings (Settings → Assistant → Control: ${LEVEL_NAME[assistant.controlLevel()]}) no longer let you stop agents.`)
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
    if (st.status === 'signin') throw new HttpError(409, `${a.name}'s CLI needs the user to sign in again (its sign-in expired). Tell the user; nothing it is given runs until then.`)
    if (st.status === 'watching') throw new HttpError(409, `${a.name} is ${st.watch?.label.replace(/^Waiting/, 'waiting') ?? 'waiting on cards'} (a card watch): it takes no other work until it is woken or the user cancels the watch.`)
    if (st.status === 'background') {
      throw new HttpError(409, `${a.name} is waiting on ${tasksWord(st.backgroundTasks ?? 0)} it started (such as a test run) and carries on by itself when they end. Wait for it (hive_wait_for_agents), then give it the task. If it seems stuck, tell the user.`)
    }
    if (sessions.userMayBeTyping(p, agentId)) throw new HttpError(409, `The user has just typed in ${a.name}'s terminal and may still be writing there. Ask the user before giving it a task.`)
    await sessions.sendPrompt(p, agentId, text)
    return { done: `Gave ${a.name} in ${basename(p)} a task: ${clip(text.replace(/\s+/g, ' '), 80)}`, result: { ok: true } }
  })
})

/** How much of an agent's last task and reply its activity shows without detail (GET …/activity?detail=true for all). */
/** How much of an agent's activity a reply carries: the short form, and with detail. */
const ACTIVITY_SHORT = { task: 300, reply: 500, tools: 3, summary: 100 }
const ACTIVITY_DETAIL = { task: 2000, reply: 3000, tools: 10, summary: 200 }

/** What an agent is doing: its status, the task it was last given, its latest reply, its recent tool calls, its locked files. */
async function agentActivity(p: string, agentId: string, detail = false) {
  const info = await workspace.projectInfo(p)
  const a = info.agents.find((x) => x.id === agentId)
  if (!a) throw new HttpError(404, 'Unknown agent')
  const st = a.live
  const sessionId = st?.sessionId || a.lastSessionId || a.resume?.id || ''
  let currentTask: string | null = null
  let latestReply: string | null = null
  let recentTools: { tool: string; summary: string; failed: boolean }[] = []
  let toolCalls = 0
  // What was cut short, so the caller knows what it hasn't read: each text's whole length in characters.
  const clipped: { currentTask?: number; latestReply?: number } = {}
  const lim = detail ? ACTIVITY_DETAIL : ACTIVITY_SHORT
  if (sessionId) {
    const t = await transcripts.read(p, sessionId).catch(() => null)
    const items = t?.items ?? []
    const lastUser = items.map((x) => x.kind).lastIndexOf('user')
    const task = lastUser >= 0 ? items[lastUser] : null
    if (task?.kind === 'user') {
      currentTask = clip(task.text, lim.task)
      if (task.text.length > lim.task) clipped.currentTask = task.text.length
    }
    const reply = [...items].reverse().find((x) => x.kind === 'assistant')
    if (reply?.kind === 'assistant') {
      latestReply = clip(reply.text, lim.reply)
      if (reply.text.length > lim.reply) clipped.latestReply = reply.text.length
    }
    const turn = items.slice(Math.max(0, lastUser)).flatMap((x) => (x.kind === 'tool' ? [{ tool: x.tool.name, summary: clip(x.tool.summary, lim.summary), failed: x.tool.isError }] : []))
    toolCalls = turn.length
    recentTools = turn.slice(-lim.tools)
  }
  const folder = a.worktree?.path ?? p
  const typed = sessions.userTypedAt(p, agentId)
  return {
    project: info.name,
    agent: a.name,
    id: a.id,
    provider: st?.provider ?? agentProvider(a, info.config, config.settings),
    status: st?.status ?? 'stopped',
    statusMessage: statusMessageOf(st),
    ...(watchingOf(st) ? { watching: watchingOf(st) } : {}),
    ...(progressOf(p, a.id) ? { progress: progressOf(p, a.id) } : {}),
    reviewing: st?.review ?? null,
    backgroundTasks: st?.backgroundTasks ?? 0,
    branch: a.worktree?.branch ?? null,
    worktree: a.worktree?.path ?? null,
    sessionId: sessionId || null,
    // A long transcript slows the CLI and Hive; handing over to itself (a new conversation) makes it short again.
    transcriptMB: st?.transcriptBytes !== undefined ? Math.round((st.transcriptBytes / (1024 * 1024)) * 10) / 10 : null,
    transcriptWarnMB: transcriptWarnLimit(info.config, config.settings.sessions.transcriptWarnMB) || null,
    sessionName: st?.sessionName ?? null,
    currentTask,
    latestReply,
    /** This turn's tool calls: how many, and the last few (three; ten with detail), each summary clipped. */
    toolCalls,
    recentTools,
    ...(Object.keys(clipped).length ? { clipped } : {}),
    lockedFiles: sessions.locksFor(p, agentId).map((f) => relative(folder, f) || f),
    userTypedSecondsAgo: typed ? Math.round((Date.now() - typed) / 1000) : null
  }
}

route('GET', '/v1/projects/:name/agents/:agent/activity', async ({ params, query }) => {
  const p = projectByName(params[0])
  ownProjectOnly(p, "Reading an agent's activity")
  return agentActivity(p, await agentParam(p, decodeURIComponent(params[1])), query.get('detail') === 'true')
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
  const limit = Math.min(AGENT_WAIT_MAX_SECONDS, Math.max(5, Number(body?.timeoutSeconds) || 300)) * 1000
  // An agent waiting on its background tasks carries on when they end: not done yet, unless the caller says so.
  const throughBackground = body?.ignoreBackground !== true
  const t0 = Date.now()
  const working = (): boolean => targets.some((t) => {
    const s = sessions.liveFor(t.p, t.id)
    return !!s && (s.status === 'working' || s.status === 'starting' || (throughBackground && s.status === 'background'))
  })
  while (working() && Date.now() - t0 < limit) await new Promise((r) => setTimeout(r, 1000))
  const agents = []
  for (const t of targets) {
    const def = projectAgents(await workspace.projectConfig(t.p)).find((a) => a.id === t.id)
    const s = sessions.liveFor(t.p, t.id)
    agents.push({ project: basename(t.p), agent: def?.name ?? t.id, status: s?.status ?? 'stopped', statusMessage: statusMessageOf(s), backgroundTasks: s?.backgroundTasks ?? 0, ...(watchingOf(s) ? { watching: watchingOf(s) } : {}) })
  }
  return { timedOut: working(), waitedSeconds: Math.round((Date.now() - t0) / 1000), agents }
})

// The merge slot (#350): one merge at a time into a project's branch. Its own project's only, for an agent; held by
// a running agent (its launch), never by what a request says.

/** The calling agent as a holder of its project's slot. Scripts and the Assistant can look, not claim. */
async function slotAgent(p: string): Promise<SlotAgent> {
  const a = agentCaller()
  if (!a) throw new HttpError(403, "Only a project's own agents hold its merge slot (with their own token). Scripts and the Assistant can read it.")
  ownProjectOnly(p, 'The merge slot')
  const live = sessions.liveFor(a.projectPath, a.agentId)
  if (!live) throw new HttpError(409, 'Only a running agent can hold the merge slot.')
  const def = projectAgents(await workspace.projectConfig(a.projectPath)).find((x) => x.id === a.agentId)
  return { projectPath: a.projectPath, agentId: a.agentId, agentName: def?.name ?? a.agentId, runId: live.runId }
}

/** The branch a slot call names, or the one the project folder is on (what Hive's Merge dialog merges into). */
async function slotBranchFor(p: string, v: unknown): Promise<string> {
  if (v !== undefined && v !== null) return slotBranch(v)
  const b = await workspace.branch(p)
  if (!b) throw new HttpError(409, "The project folder isn't on a branch: name the branch to merge into.")
  return b
}

const slotCall = async <T>(fn: () => Promise<T> | T): Promise<T> => {
  try {
    return await fn()
  } catch (e) {
    throw e instanceof MergeSlotError ? new HttpError(e.status, e.message) : e
  }
}

route('GET', '/v1/projects/:name/merge-slot', async ({ params, query }) =>
  slotCall(async () => {
    const p = projectByName(params[0])
    ownProjectOnly(p, "Reading a project's merge slot")
    return mergeSlots.status(p, await slotBranchFor(p, query.get('branch') ?? undefined))
  })
)

route('POST', '/v1/projects/:name/merge-slot/claim', async ({ params, body, signal }) =>
  slotCall(async () => {
    const p = projectByName(params[0])
    const agent = await slotAgent(p)
    const branch = await slotBranchFor(p, body?.branch)
    const cards = slotCards(body?.cards)
    const t = body?.timeoutSeconds
    if (t !== undefined && (typeof t !== 'number' || !Number.isFinite(t) || t < 0)) throw new HttpError(400, 'timeoutSeconds must be a number of seconds')
    const waitMs = t === undefined ? DEFAULT_WAIT_MS : Math.min(MAX_WAIT_MS, t * 1000)
    return { ...(await mergeSlots.claim(agent, p, branch, cards, waitMs, signal)), slot: mergeSlots.status(p, branch) }
  })
)

route('POST', '/v1/projects/:name/merge-slot/release', async ({ params, body }) =>
  slotCall(async () => {
    const p = projectByName(params[0])
    const agent = await slotAgent(p)
    return mergeSlots.release(agent, p, await slotBranchFor(p, body?.branch))
  })
)

route('GET', '/v1/shared', async () => inWorkspace(requireWorkspace(), () => notesTree()))

route('GET', '/v1/shared/file', async ({ query }) => {
  const rel = query.get('path')
  if (!rel) throw new HttpError(400, 'path is required')
  const abs = inWorkspace(requireWorkspace(), () => assertInShared(rel))
  return { path: rel, ...(await readNote(abs).catch(() => { throw new HttpError(404, 'Not found') })) }
})

route('PUT', '/v1/shared/file', async ({ query, body }) => {
  const rel = query.get('path') ?? body?.path
  if (!rel) throw new HttpError(400, 'path is required')
  const abs = inWorkspace(requireWorkspace(), () => assertInShared(rel))
  const content = String(body?.content ?? '')
  // Only a write that leaves it out is unguarded: one given (null, empty, not a string) must be a revision.
  const expected: unknown = body && typeof body === 'object' && 'expectedRevision' in body ? body.expectedRevision : undefined
  if (expected !== undefined && (typeof expected !== 'string' || !expected)) throw new HttpError(400, 'expectedRevision must be the revision reading the note gave; nothing was written')
  const { revision } = await writeNote(abs, rel, content, { append: !!body?.append, expectedRevision: expected as string | undefined }).catch((e) => {
    throw e instanceof NoteConflict ? new HttpError(409, e.message, { revision: e.current }) : e
  })
  emit({ type: 'notes-changed' })
  return { ok: true, path: rel, revision }
})

/**
 * Who is writing a handover, for its header: the Assistant (its own token), or the agent whose hive tools sent
 * it (they pass its id and project). Others (scripts, the user) leave no author.
 */
async function handoverAuthor(body: any): Promise<HandoverAuthor | null> {
  const own = assistantCaller()
  if (own) return { author: 'Assistant', session: sessions.liveFor(assistant.assistantHome(own), ASSISTANT_AGENT_ID)?.sessionId || undefined }
  if (typeof body?.agent !== 'string' || !body.agent || typeof body?.agentProject !== 'string') return null
  try {
    const p = projectByName(body.agentProject)
    const cfg = await workspace.projectConfig(p)
    const a = projectAgents(cfg).find((x) => x.id === body.agent)
    if (!a) return null
    const st = sessions.liveFor(p, a.id)
    return { author: `${a.name} (${providerName(st?.provider ?? agentProvider(a, cfg, config.settings))})`, session: st?.sessionId || undefined }
  } catch {
    return null
  }
}

route('POST', '/v1/shared/handovers', async ({ body }) => {
  if (!body?.title || !body?.content) throw new HttpError(400, 'title and content are required')
  // For a named project, its workspace's notes; else the request's workspace.
  // The project's own name, also when it was given as "<workspace>/<project>".
  const project = body.project ? projectByName(String(body.project)) : null
  const ws = project ? workspaceOf(project) : requireWorkspace()
  const name = project ? basename(project) : ''
  const by = await handoverAuthor(body)
  const file = await inWorkspace(ws, () => createHandover(name, String(body.title), String(body.content), by))
  emit({ type: 'notes-changed' })
  toast('info', 'Handover created', `${name ? name + ': ' : ''}${body.title}`, [{ label: 'Open', command: 'notes.open', args: [file] }])
  return { ok: true, path: file }
})

// ---------------------------------------------------------------------------
// The task board. Agents and the Assistant read, change and move cards (Done included); archiving and deleting are
// the user's. Only the Assistant starts cards on agents.
// ---------------------------------------------------------------------------

/**
 * Who is using the board: the Assistant, a project agent (known by its own token: confined to its project's cards,
 * whatever the request says), or a script with the workspace token (the whole board, as the user's board).
 */
async function taskActor(): Promise<tasks.TaskActor> {
  if (assistantCaller()) return { kind: 'assistant' }
  const agent = agentCaller()
  if (agent) {
    const project = basename(agent.projectPath)
    const def = await workspace
      .projectConfig(agent.projectPath)
      .then((cfg) => projectAgents(cfg).find((x) => x.id === agent.agentId))
      .catch(() => undefined)
    return { kind: 'agent', name: `${def?.name ?? agent.agentId} (${project})`, self: { project, agentId: agent.agentId }, scope: project }
  }
  return { kind: 'agent', name: 'Agent API' }
}

/**
 * A card with what its agent is doing now (and its name now), for callers deciding what to do next. `agents` keeps
 * each project's agents for a whole list, so a long board reads each project.json once.
 */
async function taskView(c: TaskCard, agents = new Map<string, Promise<ReturnType<typeof projectAgents>>>()): Promise<TaskView> {
  let agent: { id: string; name: string; status: string; backgroundTasks: number } | null = null
  let now: { name: string; running: boolean } | null = null
  if (c.agent && c.project) {
    try {
      const p = projectByName(c.project)
      const key = p.toLowerCase()
      if (!agents.has(key)) agents.set(key, workspace.projectConfig(p).then(projectAgents))
      const def = (await agents.get(key)!).find((a) => a.id === c.agent)
      const st = sessions.liveFor(p, c.agent)
      agent = { id: c.agent, name: def?.name ?? c.agentName ?? c.agent, status: def ? (st?.status ?? 'stopped') : 'removed', backgroundTasks: st?.backgroundTasks ?? 0 }
      now = def ? { name: def.name, running: !!st } : null
    } catch {
      agent = { id: c.agent, name: c.agentName ?? c.agent, status: 'removed', backgroundTasks: 0 }
    }
  }
  // Nobody working on a Doing card: the Assistant reports these and suggests who could take them.
  // Entry ids are the card watches' (#224): left out, so replies stay as lean as before.
  // Its decisions first (#357): what the user decided, which agents follow over the description.
  const { number, title, decisions, ...rest } = c
  const view: TaskView = {
    number,
    title,
    ...(decisions?.length ? { decisions: decisions.map(tasks.withoutId) } : {}),
    ...rest,
    comments: c.comments.map(tasks.withoutId),
    history: c.history.map(tasks.withoutId),
    agent,
    stalled: stalledReason(c, now)
  }
  // A review whose reviewer has gone or isn't running (Hive ends those, but one can show while that happens).
  if (c.review && c.project) {
    try {
      const p = projectByName(c.project)
      const key = p.toLowerCase()
      if (!agents.has(key)) agents.set(key, workspace.projectConfig(p).then(projectAgents))
      const def = (await agents.get(key)!).find((a) => a.id === c.review!.agent)
      const why = reviewStalled(c, def ? { name: def.name, running: !!sessions.liveFor(p, def.id) } : null)
      if (why) view.reviewStalled = why
    } catch {
      view.reviewStalled = `${c.review.agentName} was removed.`
    }
  }
  // A project agent sees the cards of other projects it links to or waits for as numbers, marked as such.
  const scope = callerScope()
  const elsewhere = await tasks.refsOutside([...new Set([...c.blockedBy, ...c.links])], scope)
  return elsewhere.length ? { ...view, elsewhere } : view
}

/** The project a project agent's calls are confined to on the board, or null (the Assistant and scripts see it all). */
function callerScope(): string | null {
  const a = agentCaller()
  return a ? basename(a.projectPath) : null
}

/** The short reply a hive tool asks for (reply: "short") instead of the whole card or column. */
const shortReply = (body: any): boolean => body?.reply === 'short'

/** A change to a card, for a short reply: what changed (in its history's words) and where the card is now. */
async function taskChange(c: TaskCard, changes: string[]): Promise<TaskChange> {
  const list = c.archived ? [] : await tasks.listTasks({ column: c.column, scope: callerScope() })
  const i = list.findIndex((x) => x.number === c.number)
  return { number: c.number, title: c.title, column: c.column, position: i >= 0 ? i + 1 : null, of: list.length, project: c.project, agent: c.agent ? (c.agentName ?? c.agent) : null, changes }
}

const taskNumber = (v: string): number => {
  const n = Number(decodeURIComponent(v).replace(/^#/, ''))
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `"${v}" is not a card number`)
  return n
}

function columnParam(v: unknown): TaskColumn | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (!isTaskColumn(v)) throw new HttpError(400, `Unknown column "${String(v)}": ${COLUMN_CHOICES}.`)
  return v
}

/** The fields of a request body a card change may set. */
function taskPatch(body: any): TaskPatch {
  const out: TaskPatch = {}
  // Archiving is the user's (#351), one card or a batch: no call of the Agent API's makes it.
  if (body?.archived !== undefined) throw new HttpError(403, 'Only the user archives cards or brings them back, from the board: ask the user.')
  for (const k of ['title', 'description', 'project', 'blocked'] as const) if (body?.[k] !== undefined) out[k] = body[k] === null ? (null as never) : String(body[k])
  if (body?.agent !== undefined) out.agent = body.agent ? String(body.agent) : null
  if (body?.column !== undefined) out.column = columnParam(body.column)
  if (body?.before !== undefined) out.before = body.before === null ? null : Number(String(body.before).replace(/^#/, ''))
  if (body?.position !== undefined && body.position !== null && body.position !== '') {
    if (body.position !== 'top' && body.position !== 'bottom') throw new HttpError(400, `Unknown position "${String(body.position)}": top or bottom.`)
    out.position = body.position
  }
  for (const k of ['labels', 'blockedBy', 'links'] as const) if (body?.[k] !== undefined) out[k] = body[k]
  if (body?.decision !== undefined && body.decision !== null) out.decision = String(body.decision)
  if (body?.review !== undefined && body.review !== null && body.review !== '') {
    if (body.review !== 'start' && body.review !== 'passed' && body.review !== 'failed') throw new HttpError(400, `Unknown review "${String(body.review)}": start, passed or failed.`)
    out.review = body.review
  }
  return out
}

route('GET', '/v1/tasks', async ({ query }) => {
  requireWorkspace()
  const project = query.get('project') ?? undefined
  // A project agent's list is its project's cards; it can't ask for another project's.
  const cards = await tasks.listTasks({ project: project ? basename(projectByName(project)) : undefined, column: columnParam(query.get('column')), archived: query.get('archived') === 'true' ? true : undefined, scope: callerScope() })
  const agents = new Map<string, Promise<ReturnType<typeof projectAgents>>>()
  const views = await Promise.all(cards.map((c) => taskView(c, agents)))
  // ?view=short: a row per card, without its description, comments and history.
  return query.get('view') === 'short' ? views.map(taskRow) : views
})

route('GET', '/v1/tasks/:n', async ({ params, query }) => {
  requireWorkspace()
  const view = await taskView(await tasks.readTask(taskNumber(params[0]), await taskActor()))
  // Read in full, decisions included: those aren't new to the agent any more (#357).
  const me = agentCaller()
  if (me) noteCardRead(me, view.number)
  const raw = query.get('comments')
  const n = raw === null ? null : Number(raw)
  if (n !== null && (!Number.isInteger(n) || n < 1)) throw new HttpError(400, `comments must be a whole number from 1: "${raw}"`)
  const lean = n === null ? view : newestComments(view, n)
  return query.get('history') === 'false' ? withoutHistory(lean) : lean
})

route('POST', '/v1/tasks', async ({ body }) => {
  requireWorkspace()
  const title = String(body?.title ?? '').trim()
  if (!title) throw new HttpError(400, 'title is required')
  const input = { title, description: body?.description, project: body?.project, agent: body?.agent, column: columnParam(body?.column), labels: body?.labels, blocked: body?.blocked, blockedBy: body?.blockedBy, links: body?.links }
  const actor = await taskActor()
  const reply = async (c: TaskCard) => (shortReply(body) ? taskChange(c, []) : taskView(c))
  if (actor.kind !== 'assistant') return reply(await tasks.createTask(input, actor))
  return assistantChange('agents', `add the task "${clip(title, 60)}" to the board`, async () => {
    const c = await tasks.createTask(input, actor)
    return { done: `Added #${c.number} to the board${c.project ? ` (${c.project})` : ''}: ${clip(c.title, 80)}`, result: await reply(c) }
  })
})

route('PATCH', '/v1/tasks/:n', async ({ params, body }) => {
  requireWorkspace()
  const n = taskNumber(params[0])
  const patch = taskPatch(body)
  const comment = typeof body?.comment === 'string' ? body.comment.trim() : ''
  const actor = await taskActor()
  const changes: string[] = []
  const apply = async (): Promise<TaskCard> => {
    // A change and its comment are saved together: a card watch woken by the change names this comment.
    const c = Object.keys(patch).length ? await tasks.updateTask(n, patch, actor, { said: changes, comment: comment || undefined }) : comment ? await tasks.commentTask(n, comment, actor) : await tasks.readTask(n, actor)
    if (comment) changes.push('Commented')
    return c
  }
  const reply = async (c: TaskCard) => (shortReply(body) ? taskChange(c, changes) : taskView(c))
  if (actor.kind !== 'assistant') return reply(await apply())
  return assistantChange('agents', `change #${n} on the board`, async () => {
    const before = await tasks.getTask(n)
    const placed = (patch.before !== undefined && patch.before !== null) || patch.position !== undefined
    const c = await apply()
    const at = patch.position ? `at the ${patch.position}` : placed ? `before #${patch.before}` : ''
    const what = [
      patch.column && patch.column !== before.column
        ? `moved it to ${columnLabel(patch.column)}${at ? `, ${at}` : ''}`
        : patch.position
          ? `moved it to the ${patch.position} of ${columnLabel(c.column)}`
          : at
            ? `moved it ${at}`
            : '',
      comment ? 'commented' : '',
      patch.decision !== undefined ? 'recorded a decision' : '',
      Object.keys(patch).some((k) => k !== 'column' && k !== 'before' && k !== 'position' && k !== 'decision') ? 'changed it' : ''
    ]
      .filter(Boolean)
      .join(', ')
    return { done: `#${n} ${clip(c.title, 60)}: ${what || 'no change'}`, result: await reply(c) }
  })
})

route('POST', '/v1/tasks/reorder', async ({ body }) => {
  requireWorkspace()
  const column = columnParam(body?.column)
  if (!column) throw new HttpError(400, 'column is required: hold, todo, doing, review or passed')
  const cards = body?.cards
  const actor = await taskActor()
  const view = async (list: TaskCard[]): Promise<TaskView[] | TaskReorder> => {
    // Short: the agent chose the cards and their order; it only needs to know it worked.
    if (shortReply(body)) return { column, top: (cards as unknown[]).map((x) => Number(String(x).replace(/^#/, ''))), count: list.length }
    const agents = new Map<string, Promise<ReturnType<typeof projectAgents>>>()
    return Promise.all(list.map((c) => taskView(c, agents)))
  }
  if (actor.kind !== 'assistant') return view(await tasks.reorderTasks(column, cards, actor))
  const count = Array.isArray(cards) ? cards.length : 0
  return assistantChange('agents', `put ${count} card${count === 1 ? '' : 's'} in order in ${columnLabel(column)}`, async () => {
    const list = await tasks.reorderTasks(column, cards, actor)
    const top = (cards as unknown[]).map((x) => `#${String(x).replace(/^#/, '')}`).join(', ')
    return { done: `Put ${top} at the top of ${columnLabel(column)}`, result: await view(list) }
  })
})

// Only a card's newest comment (its author, time and whole text), for "check the latest comment": the card's
// description, earlier comments and history stay out of the reply. A card without comments gives comment null.
route('GET', '/v1/tasks/:n/comments/latest', async ({ params }) => {
  requireWorkspace()
  return tasks.latestComment(taskNumber(params[0]), await taskActor())
})

route('POST', '/v1/tasks/:n/comments', async ({ params, body }) => {
  requireWorkspace()
  const n = taskNumber(params[0])
  const text = typeof body?.text === 'string' ? body.text : ''
  const actor = await taskActor()
  const reply = async (c: TaskCard) => (shortReply(body) ? taskChange(c, ['Commented']) : taskView(c))
  if (actor.kind !== 'assistant') return reply(await tasks.commentTask(n, text, actor))
  return assistantChange('agents', `comment on #${n}`, async () => ({ done: `Commented on #${n}`, result: await reply(await tasks.commentTask(n, text, actor)) }))
})

/** Bounded waits running now, per caller (an agent, the Assistant, a script): at most WAITS_PER_CALLER at a time. */
const taskWaits = new Map<string, number>()
const WAITS_PER_CALLER = 2

/**
 * Waiting on cards (#128). `wake: true`: the calling agent (or the Assistant) registers a watch and ends its turn; Hive
 * types one line into it when a watched card changes (main/watches.ts). `cancel: true`: ends its watch. Otherwise the
 * call waits itself, up to WAIT_MAX_SECONDS, for a change since `since` (or since the call), driven by the board's
 * change events (no polling). A project agent waits only on its own project's cards.
 */
route('POST', '/v1/tasks/wait', async ({ body }) => {
  const ws = requireWorkspace()
  // The workspace as it is now: the call belongs to it, and stops (409) if it closes or the window opens another.
  const wsPath = ws.path
  const life = ws.lifetime
  if (!wsPath) throw new HttpError(409, 'The workspace was closed')
  const stillOpen = (): void => {
    if (life.aborted || !ws.path || ws.path.toLowerCase() !== wsPath.toLowerCase()) throw new HttpError(409, 'The workspace was closed')
  }
  stillOpen()
  const me = agentCaller()
  const home = assistantCaller() ? ws.assistantHome : null
  const who = me ? { projectPath: me.projectPath, agentId: me.agentId } : home ? { projectPath: home, agentId: 'assistant' } : null
  if (body?.cancel === true) {
    if (!who) throw new HttpError(400, 'Only an agent or the Assistant has a card watch to cancel.')
    const had = await cancelWatch(ws, who.projectPath, who.agentId)
    return { done: had ? 'Cancelled your card watch.' : 'You had no card watch.' }
  }
  const cond = readCondition(body ?? {})
  if (typeof cond === 'string') throw new HttpError(400, cond)
  // Each card must be one the caller may see (a project agent: its project's; others are unknown to it), and stays so:
  // the caller's scope goes with the wait, and every later read is checked against it.
  const actor = await taskActor()
  const scope = tasks.scopeOf(actor)
  for (const n of cond.cards) await tasks.readTask(n, actor)
  stillOpen()
  if (body?.wake === true) {
    if (!who) throw new HttpError(400, 'Only an agent or the Assistant can be woken: a script waits without wake (timeoutSeconds).')
    const limit = body?.limitMinutes === undefined ? WATCH_DEFAULT_LIMIT_MINUTES : Number(body.limitMinutes)
    if (!Number.isFinite(limit) || limit < 1 || limit > WATCH_MAX_LIMIT_MINUTES) throw new HttpError(400, `limitMinutes must be from 1 to ${WATCH_MAX_LIMIT_MINUTES}`)
    const r = await registerWatch(ws, who.projectPath, who.agentId, cond, limit)
    if ('already' in r) return { already: r.already }
    return { watching: r.watching.label, limitAt: r.watching.limitAt }
  }
  const seconds = body?.timeoutSeconds === undefined ? 300 : Number(body.timeoutSeconds)
  if (!Number.isFinite(seconds) || seconds < 1) throw new HttpError(400, `timeoutSeconds must be from 1 to ${WAIT_MAX_SECONDS}`)
  const limitMs = Math.min(WAIT_MAX_SECONDS, seconds) * 1000
  let base: Map<number, CardMark> | null = null
  let sinceAt = Date.now()
  if (body?.since !== undefined) {
    const d = decodeSince(String(body.since))
    if (!d) throw new HttpError(400, 'since must be the since of an earlier reply')
    base = d.marks
    sinceAt = d.at
  }
  const sinceIso = new Date(sinceAt).toISOString()
  const read = (n: number) => scopedCard(ws, wsPath, life, n, scope)
  const marksOf = async (): Promise<Map<number, CardMark>> => {
    const m = new Map<number, CardMark>()
    for (const n of cond.cards) m.set(n, markOf(await read(n)))
    return m
  }
  const callerKey = me ? `${me.projectPath.toLowerCase()}#${me.agentId}` : home ? `assistant:${wsPath}` : `api:${wsPath}`
  const running = taskWaits.get(callerKey) ?? 0
  if (running >= WAITS_PER_CALLER) throw new HttpError(429, `You already have ${running} card waits running: wait for them to end.`)
  taskWaits.set(callerKey, running + 1)
  try {
    const start = await marksOf()
    const from = new Map(cond.cards.map((n) => [n, base?.get(n) ?? start.get(n)!]))
    // A column condition already met when the wait begins answers at once.
    const met = cond.column && !base ? cond.cards.filter((n) => alreadyThere(start.get(n)!, cond)) : []
    if (met.length) return { changes: await Promise.all(met.map(async (n) => cardChange(n, await read(n), ['column']))), timedOut: false, since: encodeSince(start) }
    const check = async (): Promise<{ changes: CardChange[]; now: Map<number, CardMark> }> => {
      const now = await marksOf()
      const changes: CardChange[] = []
      for (const n of cond.cards) {
        const card = await read(n)
        const kinds = changesBetween(from.get(n)!, now.get(n)!, cond, !!cond.moveInto && !!cond.column && movedIntoSince(card, cond.column, sinceIso))
        const reached = alreadyThere(now.get(n)!, cond) && !alreadyThere(from.get(n)!, cond)
        // A card gone (or out of the caller's view) is told as gone: nothing of its state but whether it was archived.
        if (kinds === 'gone') changes.push({ ...cardChange(n, null, 'gone'), ...(card?.archived ? { archived: true } : {}) })
        else if (kinds.length || reached) changes.push(cardChange(n, card, kinds.length ? kinds : ['column']))
      }
      return { changes, now }
    }
    // Listening first, then the first check: a change between the two is seen by one or the other.
    const result = await new Promise<{ changes: CardChange[]; now: Map<number, CardMark> }>((resolve, reject) => {
      // One check at a time; a board change during one checks again after it, so none is missed until the timeout.
      let checking = false
      let again = false
      let ended = false
      const finish = (): void => {
        ended = true
        clearTimeout(timer)
        off()
        life.removeEventListener('abort', onClose)
      }
      const done = (r: { changes: CardChange[]; now: Map<number, CardMark> }): void => {
        if (ended) return
        finish()
        resolve(r)
      }
      const fail = (e: unknown): void => {
        if (ended) return
        finish()
        reject(e)
      }
      const onClose = (): void => fail(new HttpError(409, 'The workspace was closed'))
      const run = (): void => {
        if (ended) return
        if (checking) {
          again = true
          return
        }
        checking = true
        again = false
        void check()
          .then((r) => (r.changes.length ? done(r) : undefined))
          .catch((e) => (life.aborted ? onClose() : log.warn('checking a card wait', e)))
          .finally(() => {
            checking = false
            if (again) run()
          })
      }
      const timer = setTimeout(() => void check().then(done, () => (life.aborted ? onClose() : done({ changes: [], now: start }))), limitMs)
      const off = onHiveEvent((e) => {
        if (e.type === 'tasks-changed' && e.workspacePath.toLowerCase() === wsPath.toLowerCase()) run()
      })
      life.addEventListener('abort', onClose, { once: true })
      run()
    })
    return result.changes.length ? { changes: result.changes, timedOut: false, since: encodeSince(result.now) } : { timedOut: true, since: encodeSince(result.now) }
  } finally {
    const left = (taskWaits.get(callerKey) ?? 1) - 1
    if (left > 0) taskWaits.set(callerKey, left)
    else taskWaits.delete(callerKey)
  }
})

route('POST', '/v1/tasks/:n/start', async ({ params, body }) => {
  requireWorkspace()
  const n = taskNumber(params[0])
  const card = await tasks.readTask(n, await taskActor())
  const target: TaskStartTarget = body?.agent
    ? { kind: 'agent', agentId: String(body.agent) }
    : { kind: 'new-agent', worktree: body?.worktree === true, name: body?.name ? String(body.name) : undefined, provider: body?.provider && isKnownProvider(String(body.provider)) ? (String(body.provider) as ProviderId) : undefined }
  return assistantChange('agents', `start #${n} ${target.kind === 'agent' ? `on ${target.agentId}` : 'on a new agent'}${card.project ? ` in ${card.project}` : ''}`, async () => {
    if (target.kind === 'new-agent' && body?.provider && !isKnownProvider(String(body.provider))) throw new HttpError(400, `Unknown provider "${body.provider}". hive_list_providers lists them.`)
    const r = await startTask(n, target, { kind: 'assistant' }, typeof body?.note === 'string' ? body.note : undefined)
    return {
      done: `Started #${n} on ${r.added ? 'a new agent, ' : ''}${r.agentName} in ${card.project}: ${clip(card.title, 80)}`,
      result: { ok: true, agent: r.agentName, added: r.added, card: shortReply(body) ? taskRow(await taskView(r.card)) : await taskView(r.card) }
    }
  })
})

/** A skill in a listing: what it is and where it comes from, not where it is on disk. */
const skillRow = (s: SkillInfo): SkillRow & Pick<SkillInfo, 'bundled' | 'updateAvailable'> => ({
  name: s.name,
  description: s.description,
  level: s.level,
  ...(s.provider ? { provider: s.provider } : {}),
  ...(s.plugin ? { plugin: s.plugin } : {}),
  ...(s.audience ? { audience: s.audience } : {}),
  ...(s.problem ? { problem: s.problem } : {}),
  ...(s.bundled ? { bundled: s.bundled } : {}),
  ...(s.updateAvailable ? { updateAvailable: s.updateAvailable } : {})
})

route('GET', '/v1/skills', async ({ query }) => {
  const project = query.get('project')
  if (project) {
    const p = projectByName(project)
    // A project's own skills are its agents' business (like its sessions).
    ownProjectOnly(p, "Listing a project's skills")
    // What the project's agents are given: not the Hive skills for the Assistant alone (as its Skills tab).
    return (await inWorkspace(workspaceOf(p), () => listSkills(p))).filter((s) => !(s.level === 'hive' && s.audience === 'assistant')).map(skillRow)
  }
  return (await inWorkspace(requireWorkspace(), () => listSkills())).map(skillRow)
})

/** Largest skill file the API returns; skills are instructions, not data. */
const SKILL_FILE_MAX = 512 * 1024

// One of the workspace's Hive skills: its SKILL.md and the files beside it, or (?file=) one of those files.
route('GET', '/v1/skills/:name', async ({ params, query }) => inWorkspace(requireWorkspace(), async () => {
  const name = decodeURIComponent(params[0])
  const skill = validSkillName(name) ? (await hiveSkills()).find((s) => s.name.toLowerCase() === name.toLowerCase()) : undefined
  if (!skill) throw new HttpError(404, `The workspace has no Hive skill "${name}"`)
  const file = query.get('file') ?? 'SKILL.md'
  // The whole path is checked before anything is read: relative, inside the skill's folder as written and as it
  // really is (a link can't lead out), and a file.
  const parts = file.replace(/\\/g, '/').split('/')
  if (!file || /^[a-z]:|^\//i.test(file) || parts.some((x) => x === '' || x === '.' || x === '..')) throw new HttpError(400, `"${file}" isn't a path inside the skill's folder`)
  const abs = join(skill.path, ...parts)
  if (!insideReal(abs, [skill.path])) throw new HttpError(400, `"${file}" isn't a path inside the skill's folder`)
  const info = await stat(abs).catch(() => null)
  if (!info?.isFile()) throw new HttpError(404, `The skill "${skill.name}" has no file "${file}"`)
  const tooBig = new HttpError(413, `"${file}" is larger than ${SKILL_FILE_MAX / 1024} KB`)
  if (info.size > SKILL_FILE_MAX) throw tooBig
  // What is read is capped too: the file may have grown since the stat.
  const read = await readCapped(abs, SKILL_FILE_MAX)
  if (read.more) throw tooBig
  const out = { name: skill.name, audience: skill.audience ?? 'agents', file: parts.join('/'), content: read.data.toString('utf8') }
  if (query.get('file')) return out
  const list = await skillFiles(skill.path)
  return { ...out, files: list.files, ...(list.truncated ? { filesTruncated: true } : {}) }
}))

// This Hive's own API reference (docs/AGENT_API.md as it shipped), for clients that need more than the status.
route('GET', '/v1/docs/agent-api', async () => ({ version: app.getVersion(), api: API_VERSION, content: agentApiDoc }))

/**
 * The request's workspace's performance metrics (metrics.ts): ?scope=workspace (default) or ?scope=project&project=name,
 * ?from and ?to as ISO times (default the last 24 hours), ?role, ?provider and ?own=1 (the workspace's own work) to
 * narrow it, ?trend=1 for its trend. A project agent sees its own project's only.
 */
route('GET', '/v1/metrics', async ({ query }) => {
  const w = requireWorkspace()
  const agent = agentCaller()
  const asked = query.get('project')
  if (agent && (query.get('scope') !== 'project' || (asked && asked.toLowerCase() !== basename(agent.projectPath).toLowerCase()))) {
    throw new HttpError(403, `An agent reads its own project's metrics: ?scope=project&project=${basename(agent.projectPath)}`)
  }
  const scope: MetricsQuery['scope'] = query.get('scope') === 'project' ? { kind: 'project', project: asked || (agent ? basename(agent.projectPath) : '') } : { kind: 'workspace' }
  if (scope.kind === 'project' && !scope.project) throw new HttpError(400, 'scope=project needs project')
  const role = query.get('role') ?? undefined
  if (role !== undefined && role !== 'agent' && role !== 'assistant' && role !== 'api') throw new HttpError(400, 'role must be agent, assistant or api')
  return metricsReport(w, { scope, from: query.get('from') ?? undefined, to: query.get('to') ?? undefined, trend: query.get('trend') === '1', role, provider: query.get('provider') || undefined, own: query.get('own') === '1' }).catch((e) => {
    throw e instanceof HttpError ? e : new HttpError(400, (e as Error).message)
  })
})


/**
 * The hive MCP bridge's report of its tool calls (the final text each gave the model) and, once per start, its tool
 * list and instructions. From an agent's or the Assistant's own token only, attributed by that token (an agent's
 * project; the Assistant's workspace); checked and bounded: a report that isn't valid is refused, not stored.
 */
route('POST', '/v1/metrics/mcp', async ({ body }) => {
  const agent = agentCaller()
  const own = assistantCaller()
  if (!agent && !own) throw new HttpError(403, "Only the hive MCP bridge reports its calls, with an agent's or the Assistant's token")
  const h = metricsHandle(requireWorkspace())
  const project = agent ? basename(agent.projectPath) : null
  const role = agent ? 'agent' : 'assistant'
  const calls: unknown[] = Array.isArray(body?.calls) ? body.calls : []
  if (calls.length > MCP_REPORT_LIMITS.events) throw new HttpError(400, `At most ${MCP_REPORT_LIMITS.events} calls in one report`)
  let accepted = 0
  for (const c of calls) if (c && typeof c === 'object' && recordMcp(h, project, role, c as Record<string, unknown> as never)) accepted++
  if (body?.catalog && typeof body.catalog === 'object' && recordCatalog(h, project, role, body.catalog)) accepted++
  return { accepted, refused: calls.length + (body?.catalog ? 1 : 0) - accepted }
})

route('GET', '/v1/mcp', async () => (await inWorkspace(requireWorkspace(), () => listMcp())).map(({ name, def, globallyEnabled, error }) => ({ name, description: def?.description ?? '', globallyEnabled, error })))

route('POST', '/v1/notify', async ({ body }) => {
  const level: ToastLevel = ['info', 'success', 'warning', 'error'].includes(body?.level) ? body.level : 'info'
  if (!body?.title) throw new HttpError(400, 'title is required')
  toast(level, String(body.title).slice(0, 200), body.message ? String(body.message).slice(0, 2000) : undefined, undefined, body.source ? String(body.source) : 'agent')
  return { ok: true }
})

// ---------------------------------------------------------------------------
// Progress: long runs (tests, builds) for the Progress panel
// ---------------------------------------------------------------------------

/** Who is reporting progress, by the caller's token: a project agent, this workspace's Assistant, or a script. */
async function progressCaller(): Promise<ProgressCaller> {
  const ws = requireWorkspace()
  const workspacePath = ws.path!
  const life = ws.lifetime
  const caller = await progressCallerIn(workspacePath)
  // Looking the agent up waited: a workspace that closed meanwhile (its runs cleared) must not get a run back.
  if (life.aborted || ws.path?.toLowerCase() !== workspacePath.toLowerCase()) throw new HttpError(409, 'The workspace was closed')
  return caller
}

async function progressCallerIn(workspacePath: string): Promise<ProgressCaller> {
  const a = agentCaller()
  if (a) {
    const cfg = await workspace.projectConfig(a.projectPath)
    const def = projectAgents(cfg).find((x) => x.id === a.agentId)
    return { source: 'agent', workspacePath, projectPath: a.projectPath, agentId: a.agentId, agentName: def?.name ?? a.agentId, provider: def ? agentProvider(def, cfg, config.settings) : null }
  }
  if (assistantCaller()) {
    const live = sessions.liveFor(join(workspacePath, HIVE_DIR, ASSISTANT_DIR), ASSISTANT_AGENT_ID)
    return { source: 'assistant', workspacePath, agentName: `Hive ${ASSISTANT_NAME}`, provider: live?.provider ?? null }
  }
  return { source: 'api', workspacePath }
}

/** A JSON object body, or an empty one. */
const bodyObject = (body: unknown): Record<string, unknown> => (body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {})

/**
 * Runs a progress call: with the panel off, or switched off (or off and on) while the caller was looked up, it is
 * accepted and ignored, so a reporter never fails because of it and nothing lands in a store the setting cleared.
 */
async function progressCall<T>(ignored: T, change: (caller: ProgressCaller) => T): Promise<T> {
  try {
    return await admitReport(progressGate, ignored, progressCaller, change)
  } catch (e) {
    throw e instanceof ProgressError ? new HttpError(e.status, e.message) : e
  }
}

route('POST', '/v1/progress', async ({ body }) =>
  progressCall<{ id: string; ignored?: true }>({ id: `ignored-${randomBytes(6).toString('hex')}`, ignored: true }, (caller) => ({ id: progress.start(caller, bodyObject(body)).id }))
)

route('PATCH', '/v1/progress/:id', async ({ params, body }) =>
  progressCall<{ ok: true; ignored?: true }>({ ok: true, ignored: true }, (caller) => {
    progress.update(caller, decodeURIComponent(params[0]), bodyObject(body))
    return { ok: true }
  })
)

route('POST', '/v1/progress/:id/finish', async ({ params, body }) =>
  progressCall<{ ok: true; ignored?: true }>({ ok: true, ignored: true }, (caller) => {
    progress.finish(caller, decodeURIComponent(params[0]), bodyObject(body))
    return { ok: true }
  })
)

async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Measured from here to the response's end (or the client going away): latency on the monotonic clock, bodies'
  // UTF-8 bytes, outcome. Recorded once it ends, never in the way of the request.
  const started = metricsClock.mono()
  const m: ApiRequest = { route: '(no route)', handle: null, project: null, role: 'unknown', requestBytes: 0, responseBytes: 0, skip: false, authenticated: false }
  apiRequests.set(res, m)
  appMetrics.requestStarted()
  res.once('close', () => {
    appMetrics.requestEnded()
    if (!m.authenticated) appMetrics.unauthenticated()
    else if (!m.skip && m.handle) recordApi(m.handle, m.project, { route: m.route, method: req.method ?? '', role: m.role, outcome: outcomeOf(res), requestBytes: m.requestBytes, responseBytes: m.responseBytes, ms: metricsClock.mono() - started })
  })
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  // Browsers must not be able to drive the API from a web page.
  if (req.headers.origin) return send(res, 403, { error: 'Cross-origin requests are not allowed' })
  const enabled = config.settings.agentApi.enabled
  if (url.pathname === '/v1/health' && enabled) {
    m.authenticated = true
    m.skip = true
    return send(res, 200, { ok: true, app: 'Hive', version: app.getVersion() })
  }
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  const ownWorkspace = bearer ? assistant.assistantForToken(bearer) : null
  // A project agent's own token works while the Agent API is on, as the workspace token does.
  const agent = enabled && bearer && !ownWorkspace ? agentForToken(bearer) : null
  const caller: Caller | null = ownWorkspace
    ? { kind: 'assistant', workspace: ownWorkspace, token: bearer }
    : agent
      ? { kind: 'agent', ...agent }
      : enabled && tokenMatches(req.headers.authorization, apiToken)
        ? { kind: 'api' }
        : null
  if (!caller) return send(res, enabled ? 401 : 403, { error: enabled ? 'Missing or invalid bearer token' : 'The Agent API is turned off in Settings → Agent API' })
  m.authenticated = true
  m.role = caller.kind
  // An agent's work is its project's; the Assistant's and scripts' are the workspace's own (not spread over projects).
  if (caller.kind === 'agent') m.project = basename(caller.projectPath)
  return callerStore.run(caller, () => serveApi(req, res, url))
}

async function serveApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const m = apiRequests.get(res)!
  if (url.pathname === '/v1/health') {
    m.skip = true
    return send(res, 200, { ok: true, app: 'Hive', version: app.getVersion() })
  }

  if (req.method === 'GET' && url.pathname === '/v1/events') {
    // Events are about every open workspace: not for an Assistant, which sees only its own (it has hive_wait_for_agents).
    if (assistantCaller()) return send(res, 403, { error: 'The event stream is for Agent API callers. Use hive_wait_for_agents to follow agents.' })
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    res.write(': connected\n\n')
    sseClients.set(res, agentCaller())
    // A stream is counted as one (connections, events, bytes, how long it stayed open), not as a request's latency.
    m.skip = true
    const opened = metricsClock.mono()
    appMetrics.stream({ connections: 1 })
    req.on('close', () => {
      sseClients.delete(res)
      appMetrics.stream({ openMs: metricsClock.mono() - opened })
    })
    return
  }

  // Whose request it is, for metrics, known before the body is read: an unknown route or a client that goes away while
  // sending its body is still counted for the workspace. (The request's own errors come below, in their usual order.)
  try {
    m.handle = metricsHandle(requestWorkspace(req, url))
  } catch {
    m.handle = null
  }
  const r = routes.find((x) => x.method === req.method && x.pattern.test(url.pathname))
  if (!r) return send(res, 404, { error: `No route for ${req.method} ${url.pathname}` })
  m.route = r.template
  // The bridge's reports about its tool calls are bookkeeping, not traffic: counting them would count every call twice.
  if (r.template === '/v1/metrics/mcp') m.skip = true
  try {
    // Counted as received (a body the client stops sending, or one too large, is counted as far as it came).
    const raw = req.method === 'GET' ? '' : await readBody(req, (bytes) => (m.requestBytes += bytes))
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
    const gone = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) gone.abort()
    })
    const run = (): Promise<unknown> => r.handler({ params, query: url.searchParams, body, signal: gone.signal })
    // A project agent's replies say when a card it works on or reviews has a new decision (#357), whatever it called:
    // the hive tools add the line to their reply. (The bridge's own reports about its calls aren't the agent's.) Its
    // cards as they were when the call began count too, so the call that moves a card on (to Review, say) still hears
    // of a decision it hasn't read, unless the call read it.
    const flagged = r.template !== '/v1/metrics/mcp'
    const began = Date.now()
    const before = flagged ? await decisionsNew(ws) : null
    const result = ws ? await inWorkspace(ws, run) : await run()
    const notice = flagged ? await decisionsNotice(ws, before, began) : null
    send(res, 200, result ?? null, notice ? { 'X-Hive-Notice': encodeURIComponent(notice) } : {})
  } catch (e) {
    const status = e instanceof HttpError ? e.status : e instanceof tasks.TaskPermissionError ? 403 : e instanceof tasks.TaskConflictError ? 409 : statusFor(e as Error)
    if (status === 500) log.error(`API ${req.method} ${url.pathname}`, e)
    send(res, status, { error: (e as Error).message, ...(e instanceof HttpError ? e.extra : undefined) })
  }
}

/** A project agent's cards with decisions new to it (#357), now; null for other callers. Never fails the call. */
async function decisionsNew(ws: WorkspaceService | null): Promise<Map<number, number> | null> {
  const me = agentCaller()
  const w = ws ?? (me ? workspaceFor(me.projectPath) : null)
  if (!me || !w) return null
  try {
    const actor = await inWorkspace(w, taskActor)
    return await newDecisions(w, me, tasks.actorName(actor))
  } catch (e) {
    log.warn('decision notice', e)
    return null
  }
}

/**
 * The "new decision" flag for a project agent's reply to any call (null for others, or when there is none): its cards
 * now, and those it had when the call began (`before`, at `began`) unless the call read them in full.
 */
async function decisionsNotice(ws: WorkspaceService | null, before: Map<number, number> | null, began: number): Promise<string | null> {
  const me = agentCaller()
  const now = await decisionsNew(ws)
  if (!me || !now) return null
  for (const [n, k] of before ?? []) if (!now.has(n) && lastCardRead(me, n) < began) now.set(n, k)
  return noticeText(now)
}

/** The HTTP status for an error thrown by the session and workspace services, which don't know about HTTP. */
function statusFor(e: Error): number {
  const m = String(e?.message ?? '')
  if (/Invalid session id|URI malformed|Unknown provider|Project names cannot/i.test(m)) return 400
  if (/already running|already open|already being opened|is starting|Stop it first|Stop the|archived|No session is running|ran in .* Resume it|is required to run|is turned off|no agents yet|No workspace|busy|no handover|changed while the cards|workspace was closed|card watches|not a conversation/i.test(m)) return 409
  if (/several agents: choose/i.test(m)) return 400
  if (/Not a project|Unknown (project|agent|task)|no longer exists/i.test(m)) return 404
  if (/is archived|is done\.|has no project|needs a title|is too long|Unknown column|labels must|up to \d+ labels|^(blockedBy|links):|Choose a project|comment is empty|Unknown position|before or position|can't go before|, not in (On Hold|Todo|Doing|Review|Passed|Done)|A failed review leaves|There is no card #|^cards:|other project first/i.test(m)) return 400
  return 500
}

function broadcast(event: HiveEvent): void {
  if (!sseClients.size) return
  const allowed: HiveEvent['type'][] = ['session-status', 'session-exit', 'workspace-changed', 'notes-changed', 'skills-changed', 'tasks-changed']
  if (!allowed.includes(event.type)) return
  const payload = event.type === 'workspace-changed' ? { type: event.type, workspace: event.workspace?.path ?? null } : event
  const line = `event: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`
  // A project agent hears about its own project's sessions only: another project's (their names, what they are
  // doing) can tell it about that project's cards. The other events carry no more than a path.
  const about = event.type === 'session-status' ? event.state.projectPath : event.type === 'session-exit' ? event.projectPath : null
  for (const [c, agent] of sseClients) {
    if (agent && about !== null && resolvePath(about).toLowerCase() !== resolvePath(agent.projectPath).toLowerCase()) continue
    // A client that stopped reading would make Hive hold every event for it: it is disconnected instead.
    if (c.writableLength > SSE_MAX_BUFFERED) {
      sseClients.delete(c)
      c.destroy()
    } else {
      c.write(line)
      appMetrics.stream({ events: 1, bytes: Buffer.byteLength(line, 'utf8') })
    }
  }
}

/** How much an event-stream client may fall behind (bytes not yet sent) before it is disconnected. */
const SSE_MAX_BUFFERED = 1024 * 1024

/** The (re)start in progress: settings changed quickly twice restart the server one after the other. */
let apiRestart: Promise<unknown> = Promise.resolve()

export function startApiServer(): Promise<AgentApiInfo> {
  const run = apiRestart.then(startApiServerNow)
  apiRestart = run.catch(() => undefined)
  return run
}

async function startApiServerNow(): Promise<AgentApiInfo> {
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
  for (const c of sseClients.keys()) c.end()
  sseClients.clear()
  if (apiServer) await new Promise<void>((resolve) => apiServer!.close(() => resolve()))
  apiServer = null
}

onHiveEvent(broadcast)
