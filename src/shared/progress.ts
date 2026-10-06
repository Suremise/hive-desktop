import type { ProgressRun } from './types'
import { formatDateTime } from './dates'
import { providerName } from './providers'

/**
 * The Progress panel's rules, shared by the main process (staleness, taskbar progress) and the panel (time left,
 * what to show): one place, so the two can't disagree.
 */

/** How long a run may go without a report when nothing says how long its steps take. */
export const STALE_NO_ESTIMATE_MS = 10 * 60_000
/** Grace on top of a run's own estimate before it counts as stale. */
export const STALE_GRACE_MS = 2 * 60_000
/** A passed run stays in the panel's list this long before it fades into Recent. */
export const PASSED_SHOWN_MS = 10_000

/** Open runs one agent (or the Assistant, or scripts in a workspace) may have at once. */
export const MAX_OPEN_PER_OWNER = 5
/** Runs kept in a workspace, whoever reported them: ended ones make room (oldest first); beyond it, no new run starts. */
export const MAX_RUNS_PER_WORKSPACE = 30
export const MAX_TITLE = 120
export const MAX_STEP_NAME = 120
export const MAX_COMMAND = 200
export const MAX_SUMMARY = 500
export const MAX_LOG_PATH = 400
/** Recent keeps this many ended runs. */
export const RECENT_RUNS = 10
export const MAX_TOTAL = 100_000
export const MAX_ESTIMATE_MS = 7 * 24 * 3_600_000

/**
 * Whether a run is in the panel's list (else under Recent): a running one; a failed or stale one until the user has
 * seen it, and a few seconds more (as a passed one); a passed one for a few seconds. A dismissed one never.
 */
export function isListed(r: Pick<ProgressRun, 'state' | 'dismissed' | 'finishedAt' | 'seenAt'>, now: number): boolean {
  if (r.dismissed) return false
  if (r.state === 'running') return true
  if (r.state === 'passed') return r.finishedAt !== null && now - r.finishedAt < PASSED_SHOWN_MS
  return r.seenAt === null || now - r.seenAt < PASSED_SHOWN_MS
}

/** Whether a run has a bar in the folded strip: listed, and not a failure (or stall) the user has already seen. */
export function inStrip(r: Pick<ProgressRun, 'state' | 'dismissed' | 'finishedAt' | 'seenAt'>, now: number): boolean {
  return isListed(r, now) && !((r.state === 'failed' || r.state === 'stale') && r.seenAt !== null)
}

/** Whether a run is under Recent: no longer listed, and ended (or a stale one the user has seen). */
export function isRecent(r: Pick<ProgressRun, 'state' | 'dismissed' | 'finishedAt' | 'seenAt'>, now: number): boolean {
  return !isListed(r, now) && (r.finishedAt !== null || r.state === 'stale')
}

/** Whether a run failed or went stale and the user hasn't seen it yet (the panel asks main to mark it seen). */
export const unseenTrouble = (r: Pick<ProgressRun, 'state' | 'dismissed' | 'seenAt'>): boolean => (r.state === 'failed' || r.state === 'stale') && !r.dismissed && r.seenAt === null

/** Whether a run is still open: running or stale, and not ended (finished, or a stale one the user dismissed). */
export function isOpenRun(run: Pick<ProgressRun, 'state' | 'finishedAt'>): boolean {
  return (run.state === 'running' || run.state === 'stale') && run.finishedAt === null
}

/** The time left in ms as of `now` (never negative), or null without an estimate. */
export function timeLeft(run: Pick<ProgressRun, 'estimateMs' | 'updatedAt'>, now: number): number | null {
  return run.estimateMs === null ? null : Math.max(0, run.updatedAt + run.estimateMs - now)
}

/**
 * Whether a running run has gone quiet for longer than expected: with steps and an estimate, a step's share of the
 * time left plus a grace; with an estimate only, the estimate plus the grace; with neither, ten minutes.
 */
export function isOverdue(run: Pick<ProgressRun, 'estimateMs' | 'updatedAt' | 'total' | 'step'>, now: number): boolean {
  const quiet = now - run.updatedAt
  if (run.estimateMs === null) return quiet > STALE_NO_ESTIMATE_MS
  const stepsLeft = run.total !== null ? Math.max(1, run.total - (run.step ?? 0)) : 1
  return quiet > run.estimateMs / stepsLeft + STALE_GRACE_MS
}

/** A run's fraction done (0–1), or null when it has no steps. */
export function fractionDone(run: Pick<ProgressRun, 'total' | 'step'>): number | null {
  if (run.total === null || run.total <= 0) return null
  return Math.min(1, Math.max(0, (run.step ?? 0) / run.total))
}

export interface TaskbarProgress {
  /** none: no bar. indeterminate: runs without steps. error: a run failed and the user hasn't looked yet. */
  mode: 'none' | 'normal' | 'indeterminate' | 'error'
  /** 0–1 for normal and error. */
  value: number
}

/**
 * The taskbar's bar for a workspace: the combined steps of its running runs; indeterminate when none of them has steps;
 * red while a failure is unseen.
 */
export function taskbarProgress(runs: readonly ProgressRun[], failureUnseen: boolean): TaskbarProgress {
  const running = runs.filter(isOpenRun)
  const counted = running.filter((r) => fractionDone(r) !== null)
  const done = counted.reduce((n, r) => n + Math.min(r.step ?? 0, r.total!), 0)
  const total = counted.reduce((n, r) => n + r.total!, 0)
  const value = total > 0 ? done / total : running.length ? 0 : 1
  if (failureUnseen) return { mode: 'error', value: running.length ? value : 1 }
  if (!running.length) return { mode: 'none', value: 0 }
  return counted.length ? { mode: 'normal', value } : { mode: 'indeterminate', value: 0 }
}

/** How many runs the folded strip shows a bar for; the rest are counted below them. */
export const STRIP_BARS = 6

/** A run's state in a sentence. */
export const RUN_STATE_WORDS: Record<ProgressRun['state'], string> = { running: 'running', failed: 'failed', stale: 'stopped reporting', passed: 'passed' }

export interface StripRuns {
  /** The runs with a bar, newest first. */
  bars: ProgressRun[]
  /** The rest, counted ("+3") and listed on hover. */
  more: ProgressRun[]
  /** The count's colour: a failed run among the rest, else a stale one. */
  moreState: 'failed' | 'stale' | null
  /** Every run in a few words, for the strip's name: "8 runs: 5 running, 2 failed, 1 stopped reporting". */
  summary: string
}

/** The folded strip's runs: a bar for each of the newest few, the rest counted, and all of them in words. */
export function stripRuns(runs: readonly ProgressRun[]): StripRuns {
  const more = runs.slice(STRIP_BARS)
  const moreState = more.some((r) => r.state === 'failed') ? 'failed' : more.some((r) => r.state === 'stale') ? 'stale' : null
  const counts = (Object.keys(RUN_STATE_WORDS) as ProgressRun['state'][])
    .map((s) => [runs.filter((r) => r.state === s).length, RUN_STATE_WORDS[s]] as const)
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`)
  const summary = runs.length === 0 ? '' : runs.length === 1 ? `1 run, ${counts[0].replace(/^1 /, '')}` : `${runs.length} runs: ${counts.join(', ')}`
  return { bars: runs.slice(0, STRIP_BARS), more, moreState, summary }
}

/** "4 min", "1 h 5 min", "40 s": a duration for the panel. */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const min = Math.round(s / 60)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return `${h} h${min % 60 ? ` ${min % 60} min` : ''}`
}

/** One line of a run's details (#251): its label, its text, and whether it is a command or a path (shown as code). */
export interface RunDetail {
  label: string
  text: string
  code?: boolean
}

/**
 * Everything Hive has for a run, in the order its details show it: what ran (its title and command), who (agent,
 * project, provider), when it started and ended (in the user's date and time format), how long against what was
 * expected, its steps, its state and why, the exit code and a log the reporter named. `project` is its project's name.
 */
export function runDetails(r: ProgressRun, project: string | null, now: number): RunDetail[] {
  const took = (r.finishedAt ?? now) - r.startedAt
  const steps = r.total !== null ? `${Math.min(r.step ?? 0, r.total)} of ${r.total} done${r.stepName ? ` · last: ${r.stepName}` : ''}` : r.stepName ? `Last: ${r.stepName}` : null
  const state =
    r.state === 'stale'
      ? `Stopped reporting: ${r.staleReason === 'agent-stopped' ? 'its agent stopped before it finished' : `no report for ${shortDuration(now - r.updatedAt)}`}`
      : `${RUN_STATE_WORDS[r.state][0].toUpperCase()}${RUN_STATE_WORDS[r.state].slice(1)}${r.dismissed ? ' (dismissed)' : ''}`
  const out: RunDetail[] = [{ label: 'Run', text: r.title }]
  if (r.command) out.push({ label: 'Command', text: r.command, code: true })
  out.push({ label: 'Agent', text: `${r.agentName}${project ? ` · ${project}` : ''}` })
  if (r.provider) out.push({ label: 'Provider', text: providerName(r.provider) })
  out.push({ label: 'Started', text: formatDateTime(r.startedAt) })
  if (r.finishedAt !== null) out.push({ label: 'Ended', text: formatDateTime(r.finishedAt) })
  out.push({ label: 'Took', text: `${shortDuration(took)}${r.finishedAt === null ? ' so far' : ''}${r.expectedMs !== null ? ` · expected about ${shortDuration(r.expectedMs)}` : ''}` })
  if (steps) out.push({ label: 'Steps', text: steps })
  out.push({ label: 'State', text: state })
  if (r.exitCode !== null) out.push({ label: 'Exit code', text: String(r.exitCode) })
  if (r.logPath) out.push({ label: 'Log', text: r.logPath, code: true })
  return out
}

/** A run's details as plain text for pasting (Copy details, #251): a "Label: text" line for each, then its summary. */
export function runDetailsText(r: ProgressRun, project: string | null, now: number): string {
  const lines = runDetails(r, project, now).map((d) => `${d.label}: ${d.text}`)
  if (r.summary) lines.push(`Summary: ${r.summary}`)
  return lines.join('\n')
}


/** The Progress panel's filter (#251): `project` is ALL_PROJECTS, NO_PROJECT (the Assistant's and scripts' runs) or a project's path in lower case; `agent` narrows a project to one agent's runs. */
export interface ProgressFilter {
  project: string
  agent?: string
}
export const ALL_PROJECTS = '*'
export const NO_PROJECT = '-'
export const SHOW_ALL: ProgressFilter = { project: ALL_PROJECTS }

const projectOf = (r: ProgressRun): string => (r.projectPath ? r.projectPath.toLowerCase() : NO_PROJECT)
const agentOf = (r: ProgressRun): string => r.agentId ?? r.agentName

/** The filter's choices for these runs: each project that has runs, by its name, then "Assistant and scripts" when some run has no project. */
export function filterChoices(runs: readonly ProgressRun[], nameOf: (projectPath: string) => string): { value: string; label: string }[] {
  const seen = new Map<string, string>()
  for (const r of runs) if (r.projectPath && !seen.has(projectOf(r))) seen.set(projectOf(r), nameOf(r.projectPath))
  const out = [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))
  if (runs.some((r) => !r.projectPath)) out.push({ value: NO_PROJECT, label: 'Assistant and scripts' })
  return out
}

/** The agents with runs in a project, for the agent filter (named as their runs name them). */
export function agentChoices(runs: readonly ProgressRun[], project: string): { value: string; label: string }[] {
  const seen = new Map<string, string>()
  for (const r of runs) if (projectOf(r) === project && !seen.has(agentOf(r))) seen.set(agentOf(r), r.agentName)
  return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * The filter that applies to these runs: the chosen one while its project (and agent) still has runs and the runs span
 * more than one project; otherwise every run (the filter is hidden when there is nothing to choose between).
 */
export function activeFilter(runs: readonly ProgressRun[], chosen: ProgressFilter | undefined): ProgressFilter {
  if (!chosen || chosen.project === ALL_PROJECTS) return SHOW_ALL
  const projects = new Set(runs.map(projectOf))
  if (projects.size < 2 || !projects.has(chosen.project)) return SHOW_ALL
  if (chosen.agent && !runs.some((r) => projectOf(r) === chosen.project && agentOf(r) === chosen.agent)) return { project: chosen.project }
  return chosen
}

/** The runs a filter shows. */
export function filterRuns(runs: readonly ProgressRun[], f: ProgressFilter): ProgressRun[] {
  if (f.project === ALL_PROJECTS) return [...runs]
  return runs.filter((r) => projectOf(r) === f.project && (!f.agent || agentOf(r) === f.agent))
}
