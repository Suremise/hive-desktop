import { randomUUID } from 'crypto'
import type { ProgressRun, ProgressSource, ProviderId } from '../shared/types'
import { MAX_COMMAND, MAX_ESTIMATE_MS, MAX_OPEN_PER_OWNER, MAX_RUNS_PER_WORKSPACE, MAX_STEP_NAME, MAX_SUMMARY, MAX_TITLE, MAX_TOTAL, isOpenRun, isOverdue, timeLeft } from '../shared/progress'

/**
 * Long runs agents report (tests, builds) for the Progress panel, per workspace, in memory: a restart forgets them,
 * and a reporter treats an unknown id as nothing to update. Who may update a run is decided by who started it (the
 * caller's token), never by what a request says.
 */

/** Who reports or changes a run, as the Agent API knows the caller. */
export type ProgressCaller =
  | { source: 'agent'; workspacePath: string; projectPath: string; agentId: string; agentName: string; provider: ProviderId | null }
  | { source: 'assistant'; workspacePath: string; agentName: string; provider: ProviderId | null }
  | { source: 'api'; workspacePath: string }

/** Whether reports are taken now, and a number that changes every time that setting changes (off, or on again). */
export interface ProgressGate {
  on: () => boolean
  generation: () => number
}

/**
 * Admits one report: with reporting off it is ignored; otherwise its caller is resolved (which may wait), and only if
 * reporting is still on and hasn't been switched off and on meanwhile is the change made. The change itself runs with
 * no wait between that check and it, so a report can't land in a store the setting has cleared.
 */
export async function admitReport<C, T>(gate: ProgressGate, ignored: T, resolve: () => Promise<C>, change: (caller: C) => T): Promise<T> {
  if (!gate.on()) return ignored
  const generation = gate.generation()
  const caller = await resolve()
  if (!gate.on() || gate.generation() !== generation) return ignored
  return change(caller)
}

export class ProgressError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export interface ProgressDeps {
  now: () => number
  /** A workspace's runs changed (newest first): tell its window. Called at most every `emitEveryMs` per workspace. */
  changed: (workspacePath: string, runs: ProgressRun[]) => void
  /** Whether a run's agent still has a running session (a stopped one's runs go stale). */
  ownerRunning: (run: ProgressRun) => boolean
  emitEveryMs?: number
}

const key = (p: string): string => p.toLowerCase()

/** Optional integer field: undefined when absent, else a whole number in range (400 otherwise). */
function int(v: unknown, name: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ProgressError(400, `${name} must be a number`)
  const n = Math.round(v)
  if (n < min || n > max) throw new ProgressError(400, `${name} must be between ${min} and ${max}`)
  return n
}

/** Optional text field, trimmed and cut to its limit; undefined when absent. */
function text(v: unknown, name: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new ProgressError(400, `${name} must be text`)
  const s = v.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

export class ProgressStore {
  private runs = new Map<string, ProgressRun[]>()
  private unseenFailure = new Set<string>()
  private pending = new Map<string, NodeJS.Timeout>()
  private lastEmit = new Map<string, number>()

  constructor(private deps: ProgressDeps) {}

  /** A workspace's runs, newest first. */
  list(workspacePath: string): ProgressRun[] {
    return [...(this.runs.get(key(workspacePath)) ?? [])]
  }

  /** Whether a run failed in this workspace since the user last looked at the panel. */
  failureUnseen(workspacePath: string): boolean {
    return this.unseenFailure.has(key(workspacePath))
  }

  /** The user looked at the panel: the taskbar stops showing red. */
  seen(workspacePath: string): void {
    if (this.unseenFailure.delete(key(workspacePath))) this.flush(workspacePath)
  }

  /** The latest open run of one agent (for its status), if any. */
  openRunOf(projectPath: string, agentId: string): ProgressRun | null {
    for (const list of this.runs.values()) {
      const r = list.find((x) => x.source === 'agent' && isOpenRun(x) && x.agentId === agentId && key(x.projectPath ?? '') === key(projectPath))
      if (r) return r
    }
    return null
  }

  start(caller: ProgressCaller, body: Record<string, unknown>): ProgressRun {
    // Every field is checked before anything changes.
    const title = text(body.title, 'title', MAX_TITLE)
    if (!title) throw new ProgressError(400, 'title is required')
    const total = int(body.total, 'total', 1, MAX_TOTAL)
    const step = int(body.step, 'step', 0, total ?? MAX_TOTAL)
    const command = text(body.command, 'command', MAX_COMMAND)
    const stepName = text(body.stepName, 'stepName', MAX_STEP_NAME)
    const estimateMs = int(body.estimateMs, 'estimateMs', 0, MAX_ESTIMATE_MS)
    const list = this.runs.get(key(caller.workspacePath)) ?? []
    const mine = list.filter((r) => isOpenRun(r) && this.owns(caller, r, true))
    if (mine.length >= MAX_OPEN_PER_OWNER) throw new ProgressError(429, `At most ${MAX_OPEN_PER_OWNER} runs can be open at once: finish one first`)
    // The workspace's bound holds whoever reports: ended runs make room (oldest first); open ones are never dropped.
    const kept = this.makeRoom(list)
    if (kept.length >= MAX_RUNS_PER_WORKSPACE) throw new ProgressError(429, `This workspace already has ${MAX_RUNS_PER_WORKSPACE} open runs: finish some first`)
    const now = this.deps.now()
    const run: ProgressRun = {
      id: randomUUID(),
      workspacePath: caller.workspacePath,
      projectPath: caller.source === 'agent' ? caller.projectPath : null,
      agentId: caller.source === 'agent' ? caller.agentId : null,
      agentName: caller.source === 'api' ? 'Script' : caller.agentName,
      provider: caller.source === 'api' ? null : caller.provider,
      source: caller.source as ProgressSource,
      title,
      command: command || null,
      total: total ?? null,
      step: total !== undefined ? (step ?? 0) : (step ?? null),
      stepName: stepName || null,
      estimateMs: estimateMs ?? null,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      state: 'running',
      staleReason: null,
      summary: null,
      dismissed: false
    }
    this.runs.set(key(caller.workspacePath), [run, ...kept])
    this.flush(caller.workspacePath)
    return run
  }

  update(caller: ProgressCaller, id: string, body: Record<string, unknown>): ProgressRun {
    const run = this.find(caller, id)
    if (run.finishedAt !== null) throw new ProgressError(409, 'That run has finished')
    const step = int(body.step, 'step', 0, run.total ?? MAX_TOTAL)
    const stepName = text(body.stepName, 'stepName', MAX_STEP_NAME)
    const estimateMs = int(body.estimateMs, 'estimateMs', 0, MAX_ESTIMATE_MS)
    const now = this.deps.now()
    if (step !== undefined) run.step = step
    if (stepName !== undefined) run.stepName = stepName || null
    // estimateMs is the time left as of updatedAt: without a new one, what is left now keeps the same deadline.
    run.estimateMs = estimateMs !== undefined ? estimateMs : timeLeft(run, now)
    run.updatedAt = now
    run.state = 'running'
    run.staleReason = null
    this.schedule(run.workspacePath)
    return run
  }

  finish(caller: ProgressCaller, id: string, body: Record<string, unknown>): ProgressRun {
    if (typeof body.ok !== 'boolean') throw new ProgressError(400, 'ok (true or false) is required')
    const summary = text(body.summary, 'summary', MAX_SUMMARY)
    const run = this.find(caller, id)
    if (run.finishedAt !== null) throw new ProgressError(409, 'That run has finished')
    const now = this.deps.now()
    run.finishedAt = now
    run.updatedAt = now
    run.state = body.ok ? 'passed' : 'failed'
    run.staleReason = null
    run.summary = summary || null
    if (run.state === 'passed' && run.total !== null) run.step = run.total
    if (run.state === 'failed') this.unseenFailure.add(key(run.workspacePath))
    this.flush(run.workspacePath)
    return run
  }

  /**
   * The user dismissed a finished or stale run: it moves to Recent. A stale one ends there (finishedAt), so it no longer
   * counts as open: not in its agent's status, the taskbar or the open-run limits, and it takes no more reports.
   */
  dismiss(workspacePath: string, id: string): void {
    const run = this.runs.get(key(workspacePath))?.find((r) => r.id === id)
    if (!run || run.state === 'running' || run.dismissed) return
    run.dismissed = true
    if (run.finishedAt === null) run.finishedAt = this.deps.now()
    this.flush(workspacePath)
  }

  /** Marks quiet runs, and runs whose agent stopped, as stale. Called on a timer. */
  sweep(): void {
    const now = this.deps.now()
    for (const list of this.runs.values()) {
      let changed = false
      for (const r of list) {
        if (r.state !== 'running') continue
        const stopped = r.source !== 'api' && !this.deps.ownerRunning(r)
        if (stopped || isOverdue(r, now)) {
          r.state = 'stale'
          r.staleReason = stopped ? 'agent-stopped' : 'quiet'
          changed = true
        }
      }
      if (changed && list[0]) this.flush(list[0].workspacePath)
    }
  }

  /**
   * Forgets a workspace's runs (it closed, or its window switched to another) or every run (the panel was turned off):
   * its window hears there are none (clearing the taskbar), and nothing of it is kept, timers included. Its old ids
   * are unknown from then on.
   */
  clear(workspacePath?: string): void {
    const paths = workspacePath ? [workspacePath] : [...this.runs.values()].map((l) => l[0]?.workspacePath).filter((p): p is string => !!p)
    for (const p of paths) {
      const k = key(p)
      const had = this.runs.delete(k)
      this.unseenFailure.delete(k)
      if (had) this.deps.changed(p, [])
      const t = this.pending.get(k)
      if (t) clearTimeout(t)
      this.pending.delete(k)
      this.lastEmit.delete(k)
    }
  }

  /** Whether a caller may change a run: its own agent, the Assistant its own, a script any in its workspace. */
  private owns(caller: ProgressCaller, r: ProgressRun, forLimit = false): boolean {
    if (key(r.workspacePath) !== key(caller.workspacePath)) return false
    if (caller.source === 'api') return forLimit ? r.source === 'api' : true
    if (caller.source === 'assistant') return r.source === 'assistant'
    return r.source === 'agent' && r.agentId === caller.agentId && key(r.projectPath ?? '') === key(caller.projectPath)
  }

  /** A run the caller may change; another's answers as if it didn't exist. */
  private find(caller: ProgressCaller, id: string): ProgressRun {
    const run = typeof id === 'string' ? this.runs.get(key(caller.workspacePath))?.find((r) => r.id === id) : undefined
    if (!run || !this.owns(caller, run)) throw new ProgressError(404, 'Unknown progress run')
    return run
  }

  /** The list with room for one more if ended runs can make it: the oldest ended ones go first; open ones stay. */
  private makeRoom(list: ProgressRun[]): ProgressRun[] {
    let over = list.length - (MAX_RUNS_PER_WORKSPACE - 1)
    if (over <= 0) return list
    const out = [...list]
    for (let i = out.length - 1; i >= 0 && over > 0; i--) {
      if (out[i].finishedAt !== null) {
        out.splice(i, 1)
        over--
      }
    }
    return out
  }

  /** Tells the window now, unless it was told very recently (then once that interval has passed). */
  private schedule(workspacePath: string): void {
    const k = key(workspacePath)
    if (this.pending.has(k)) return
    const every = this.deps.emitEveryMs ?? 250
    const wait = Math.max(0, (this.lastEmit.get(k) ?? 0) + every - this.deps.now())
    if (wait === 0) return this.flush(workspacePath)
    const t = setTimeout(() => this.flush(workspacePath), wait)
    t.unref?.()
    this.pending.set(k, t)
  }

  private flush(workspacePath: string): void {
    const k = key(workspacePath)
    const t = this.pending.get(k)
    if (t) clearTimeout(t)
    this.pending.delete(k)
    this.lastEmit.set(k, this.deps.now())
    this.deps.changed(workspacePath, this.list(workspacePath))
  }
}
