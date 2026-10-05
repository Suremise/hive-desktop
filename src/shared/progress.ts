import type { ProgressRun } from './types'

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
export const MAX_TOTAL = 100_000
export const MAX_ESTIMATE_MS = 7 * 24 * 3_600_000

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
