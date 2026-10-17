import { app, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'original-fs'
import { join } from 'path'
import { ASSISTANT_AGENT_ID } from '../shared/assistant'
import { msg, tr } from '../shared/i18n'
import { HEARTBEAT_MS, RUN_MARKER, parseRunMarker, resumeFailedLine, unexpectedCloseText, type LeftMerge, type ResumeReport, type RunMarker, type RunningAgent } from '../shared/unexpectedClose'
import type { ToastAction } from '../shared/types'
import { assistantHome } from './assistantControl'
import { config } from './config'
import { createDelivery } from './deliveries'
import { emit, onHiveEvent, toast } from './events'
import { crashDumps, type CrashDump } from './exitLog'
import { createLogger, userText } from './logger'
import { sessions } from './sessions'
import { inWorkspace, openWorkspaces, workspaceOf } from './workspace'

/**
 * Hive closing unexpectedly (#984, shared/unexpectedClose.ts): the marker in the profile while Hive runs, and at the next
 * start the notice of a run that ended without quitting (when it was last seen, what was running, a crash dump of it,
 * a merge left half done), the Assistant told, and the agents resumed only if Settings → Sessions says so.
 */
const log = createLogger('lastRun')
const HIVE = { kind: 'hive', name: 'Hive' } as const // i18n-ignore: the product's name, as a delivery's sender

/** What the last run left, found at this start: null when it quit normally (or this is the first run). */
export interface UnexpectedClose {
  /** When it was last seen (its last heartbeat, or the marker's time when the marker couldn't be read). */
  lastSeen: string
  startedAt: string | null
  agents: RunningAgent[]
  workspaces: string[]
  /** A crash dump made during that run (#985). */
  dump: CrashDump | null
  merges: LeftMerge[]
}

let found: UnexpectedClose | null = null
/** The notice is out: a merge found later is told on its own. */
let told = false
let telling = false
/** Startup work the notice waits for (startupStep): each restored workspace opening, and its merge slots recovered. */
const startup = new Set<Promise<unknown>>()

/**
 * Startup work the notice depends on: a restored workspace opening (index.ts), a workspace's merge slots recovered
 * (ipc.ts, as it opens: before its opening is done). Only while there is a notice to give and it isn't out yet.
 */
export function startupStep(p: Promise<unknown>): void {
  if (!found || told) return
  const step: Promise<unknown> = p.catch(() => undefined).finally(() => startup.delete(step))
  startup.add(step)
}

/** Until every startup step has ended, steps added meanwhile (a workspace's recovery, as it opens) included. */
async function startupDone(): Promise<void> {
  if (startup.size) log.info(`The notice waits for ${startup.size} startup step(s): workspaces opening, merge slots recovered`)
  while (startup.size) await Promise.allSettled([...startup])
}
/** The agents left to resume from the notice (once). */
let toResume: RunningAgent[] = []
let startedAt = ''
let ended = false
let timer: NodeJS.Timeout | null = null
let soon: NodeJS.Timeout | null = null

const markerFile = (): string => join(app.getPath('userData'), RUN_MARKER)

/** At start, before this run's marker is written: whether the last run left its marker, and what it says. */
export function checkLastRun(file = markerFile()): UnexpectedClose | null {
  found = null
  if (!existsSync(file)) return null
  let text = ''
  let at = new Date().toISOString()
  try {
    text = readFileSync(file, 'utf8')
    at = statSync(file).mtime.toISOString()
  } catch {
    // Read as a marker without its details.
  }
  const m = parseRunMarker(text)
  const since = m ? Date.parse(m.startedAt) : NaN
  const dump = crashDumps().find((d) => Number.isNaN(since) || d.at >= since) ?? null
  found = { lastSeen: m?.lastSeen ?? at, startedAt: m?.startedAt ?? null, agents: m?.agents ?? [], workspaces: m?.workspaces ?? [], dump, merges: [] }
  toResume = found.agents
  log.warn(`The last run of Hive ended without quitting: last seen ${found.lastSeen}${m ? ` (Hive ${m.hive}, started ${m.startedAt})` : ' (its marker could not be read)'}; ${found.agents.length} agent(s) were running${found.agents.length ? `: ${found.agents.map((a) => `${userText(a.agentName)} in ${userText(a.project)}`).join(', ')}` : ''}${dump ? `; a crash dump from ${new Date(dump.at).toISOString()}` : '; no crash dump'}`) // i18n-ignore: a line of hive.log
  return found
}

/** What the last run left, found at this start (Copy Diagnostics, tests). */
export const lastUnexpectedClose = (): UnexpectedClose | null => found

/** The agents running now, as the marker lists them (the Assistant's own session is the Assistant's, not an agent's). */
function runningAgents(): RunningAgent[] {
  const out: RunningAgent[] = []
  for (const s of sessions.liveStates()) {
    let ws: ReturnType<typeof workspaceOf>
    try {
      ws = workspaceOf(s.projectPath)
    } catch {
      continue
    }
    if (ws.isAssistantHome(s.projectPath)) continue
    const project = ws.info()?.projects.find((p) => p.path.toLowerCase() === s.projectPath.toLowerCase())?.name ?? s.projectPath.split(/[\\/]/).pop() ?? s.projectPath
    out.push({ workspace: ws.path ?? '', projectPath: s.projectPath, project, agentId: s.agentId, agentName: s.agentName ?? s.agentId, provider: s.provider, sessionId: s.sessionId, ...(s.sessionName ? { sessionName: s.sessionName } : {}) })
  }
  return out
}

/** Writes this run's marker now: written whole beside it and renamed into place, so a reader never sees half of one. */
function writeMarker(): void {
  if (ended) return
  const marker: RunMarker = { version: 1, pid: process.pid, startedAt, lastSeen: new Date().toISOString(), hive: app.getVersion(), workspaces: openWorkspaces().flatMap((w) => (w.path ? [w.path] : [])), agents: runningAgents() }
  const file = markerFile()
  try {
    writeFileSync(`${file}.tmp`, `${JSON.stringify(marker, null, 2)}\n`)
    renameSync(`${file}.tmp`, file)
  } catch (e) {
    log.warn("Couldn't write the running marker", e)
  }
}

/** This run's marker: written now, every minute, and soon after an agent starts or stops. Once, after checkLastRun(). */
export function startRunMarker(): void {
  startedAt = new Date().toISOString()
  writeMarker()
  timer = setInterval(writeMarker, HEARTBEAT_MS)
  timer.unref()
  onHiveEvent((e) => {
    if (e.type !== 'session-exit' && e.type !== 'session-status' && e.type !== 'workspace-changed') return
    if (soon) return
    soon = setTimeout(() => {
      soon = null
      writeMarker()
    }, 2000)
    soon.unref()
  })
  // Windows ending the session is a clean end too: Hive may be ended without quitting after it.
  const watch = (w: BrowserWindow): void => void w.on('session-end', () => endRunMarker('Windows is ending the session')) // i18n-ignore: why, for hive.log
  for (const w of BrowserWindow.getAllWindows()) watch(w)
  app.on('browser-window-created', (_e, w) => watch(w))
  app.on('will-quit', () => endRunMarker('Hive is quitting')) // i18n-ignore: why, for hive.log
}

/** A normal end (quitting, an update, a restart, Windows ending the session): the marker goes, and isn't written again. */
export function endRunMarker(why: string): void {
  if (ended) return
  ended = true
  if (timer) clearInterval(timer)
  if (soon) clearTimeout(soon)
  try {
    rmSync(markerFile(), { force: true })
    log.info(`Removed the running marker: ${why}`)
  } catch (e) {
    log.warn("Couldn't remove the running marker", e)
  }
}

/**
 * A merge slot hold Hive closed under (mergeSlotHost.ts): told in the notice when the last run closed unexpectedly and
 * the notice isn't out yet. False when it isn't (the caller tells it on its own).
 */
export function addLeftMerge(m: LeftMerge): boolean {
  if (!found || told) return false
  found.merges.push(m)
  return true
}

/** Resumes the agents that were running, one at a time; one already running again, or with no conversation, is left. */
async function resumeAgents(agents: readonly RunningAgent[]): Promise<ResumeReport> {
  const out: ResumeReport = { resumed: [], failed: [] }
  for (const a of agents) {
    if (sessions.liveFor(a.projectPath, a.agentId) || !a.sessionId) continue
    try {
      await inWorkspace(workspaceOf(a.projectPath), () => sessions.start(a.projectPath, { agentId: a.agentId, resumeId: a.sessionId, ...(a.sessionName ? { name: a.sessionName } : {}) }))
      out.resumed.push(a.agentName)
      log.info(`Resumed ${userText(a.agentName)} in ${userText(a.project)} after the unexpected close`)
    } catch (e) {
      out.failed.push({ name: a.agentName, error: e instanceof Error ? e.message : String(e) })
      log.warn(`Couldn't resume ${userText(a.agentName)} in ${userText(a.project)} after the unexpected close: ${userText(e instanceof Error ? e.message : String(e))}`)
    }
  }
  return out
}

/** The notice's Resume All: the agents the notice listed, resumed once; the result told. */
export async function resumeAfterClose(): Promise<ResumeReport> {
  const agents = toResume
  toResume = []
  const r = await resumeAgents(agents)
  if (r.failed.length) toast('error', tr(msg({ id: 'main.unexpectedClose.resumeFailedTitle', defaultMessage: "Some agents couldn't resume", description: "A notice's title: resuming the agents that were running when Hive closed unexpectedly failed for some." })), resumeFailedLine(r))
  else toast('success', tr(msg({ id: 'main.unexpectedClose.resumedTitle', defaultMessage: '{n, plural, =0 {Nothing to resume} one {Resumed one agent} other {Resumed # agents}}', description: "A notice's title: the agents that were running when Hive closed unexpectedly were resumed ({n} of them; 0: all were running again or had no conversation)." }), { n: r.resumed.length }))
  return r
}

/** The line the Assistant finds in its inbox (agent-facing: English). */
function assistantLine(c: UnexpectedClose, r: ResumeReport | null): string {
  const agents = c.agents.map((a) => `${a.agentName} (${a.project})`).join(', ') // i18n-ignore: the Assistant's inbox (agent-facing, English)
  const resumed = r ? `Hive resumed ${r.resumed.length} of them (the user's setting)${r.failed.length ? `; ${r.failed.length} couldn't resume` : ''}.` : 'Nothing was resumed: the user decides.' // i18n-ignore: the Assistant's inbox (agent-facing, English)
  return `Hive closed unexpectedly: last seen ${c.lastSeen}. ${c.agents.length ? `${c.agents.length} agent(s) were running: ${agents}. ${resumed}` : 'No agents were running.'} Check for card loops and lanes that stalled and tell the user; don't restart anything yourself.` // i18n-ignore: the Assistant's inbox (agent-facing, English)
}

/** Tells each workspace's Assistant that was open in the last run (one there to tell), for its next start. */
async function tellAssistants(c: UnexpectedClose, r: ResumeReport | null): Promise<void> {
  const homes = new Set([...c.workspaces, ...c.agents.map((a) => a.workspace)].filter(Boolean).map((w) => w.toLowerCase()))
  for (const ws of homes) {
    const home = assistantHome(ws)
    // A session host's own config is in its .hive folder: none, the workspace has no Assistant to tell.
    if (!existsSync(join(home, '.hive', 'project.json'))) continue
    await createDelivery(home, { agentId: ASSISTANT_AGENT_ID, kind: 'control', from: HIVE, body: assistantLine(c, r) }).catch((e) => log.warn('telling the Assistant Hive closed unexpectedly', e))
  }
}

/**
 * Once Hive's window is up: the notice of the last run's unexpected close, if there was one. With Settings → Sessions →
 * Resume agents after an unexpected close on, the agents are resumed first and the notice says so; off (the default),
 * the notice offers Resume All and nothing resumes on its own. The Assistant is told either way.
 */
export async function tellUnexpectedClose(): Promise<void> {
  const c = found
  if (!c || told || telling) return
  telling = true
  // The restored workspaces opened and their merge slots recovered: their merges are in the notice, and the agents
  // can be resumed in them. However long they take: the notice waits for them, not for a time.
  await startupDone()
  const auto = config.settings.sessions.resumeAfterUnexpectedClose === true
  const r = auto && c.agents.length ? await resumeAgents(c.agents) : null
  if (r) toResume = []
  told = true
  const actions: ToastAction[] = []
  if (!r && c.agents.length) actions.push({ label: tr(msg({ id: 'main.unexpectedClose.resumeAll', defaultMessage: 'Resume All', description: 'A button in the notice that Hive closed unexpectedly: resumes the agents that were running.' })), command: 'session.resumeAfterClose' })
  actions.push({ label: tr(msg({ id: 'main.unexpectedClose.overview', defaultMessage: 'Show Overview', description: "A button in the notice that Hive closed unexpectedly: shows the Workspace Overview, with every project's agents." })), command: 'view.overview' })
  // It stays up for two minutes (a notice with buttons goes after 15 s), and in the Notifications panel after.
  const title = tr(msg({ id: 'main.unexpectedClose.title', defaultMessage: 'Hive closed unexpectedly', description: "The notice's title at start when the last run of Hive ended without quitting (killed, a crash, the power)." }))
  emit({ type: 'toast', toast: { id: randomUUID(), level: 'warning', title, message: unexpectedCloseText({ ...c, dump: !!c.dump }, r), actions, timestamp: new Date().toISOString(), timeoutMs: 120_000 } })
  await tellAssistants(c, r)
}

/** Copy Diagnostics' line about the last run (English, for the maintainer). */
export function lastRunDiagnostics(): string {
  const c = found
  if (!c) return '- The last run quit normally (or this is the first).' // i18n-ignore: Copy Diagnostics' report, in English
  return `- The last run ended without quitting: last seen ${c.lastSeen}${c.startedAt ? `, started ${c.startedAt}` : ''}; ${c.agents.length} agent(s) were running; ${c.dump ? 'a crash dump of it was kept' : 'no crash dump'}${c.merges.length ? `; ${c.merges.length} merge(s) left half done` : ''}` // i18n-ignore: Copy Diagnostics' report, in English
}
