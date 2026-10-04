import { useEffect } from 'react'
import { PASSED_SHOWN_MS, fractionDone, isOpenRun, shortDuration, timeLeft } from '@shared/progress'
import type { ProgressRun } from '@shared/types'
import { selectProject } from '../actions'
import { call } from '../api'
import { commandKeybinding } from '../commands'
import { findProject, get, revealAgent, set, setAssistantOpen, setProgressOpen, useProgressOpen, useStore } from '../store'
import { useNow } from '../usage'
import { cx, formatKeybinding } from '../util'
import { ProviderIcon } from './ProviderIcon'
import { PaneResizer, usePaneSize } from './Resizer'
import { Icon, IconButton, Tooltip } from './ui'

/**
 * The Progress panel: long runs agents report (tests, builds), each with its agent, how far along and the time left.
 * On the right, beside the Assistant's panel; folded, a strip with a small bar per run. It never opens by itself.
 */

const NO_RUNS: ProgressRun[] = []

/** Runs shown in the list: open ones, failed and stale ones until dismissed, passed ones for a few seconds. */
function isShown(r: ProgressRun, now: number): boolean {
  if (r.dismissed) return false
  if (r.state === 'passed') return r.finishedAt !== null && now - r.finishedAt < PASSED_SHOWN_MS
  return true
}

/** Shows the agent that reported a run (the Assistant's panel for the Assistant). */
function showRunAgent(r: ProgressRun): void {
  if (r.source === 'assistant') return setAssistantOpen(true)
  if (!r.projectPath || !r.agentId) return
  const p = findProject(get(), r.projectPath)
  if (!p || !p.agents.some((a) => a.id === r.agentId)) return
  selectProject(p.path)
  revealAgent(p, r.agentId)
}

/** This window's runs, loaded when its workspace changes (events keep them current). */
function useProgressRuns(): ProgressRun[] {
  const ws = useStore((s) => s.workspace?.path)
  const on = useStore((s) => s.settings?.general.progressPanel !== false)
  useEffect(() => {
    if (!ws || !on) return
    let current = true
    void call('progress:list').then((runs) => current && set({ progressRuns: runs }))
    return () => {
      current = false
    }
  }, [ws, on])
  return useStore((s) => s.progressRuns ?? NO_RUNS)
}

export function ProgressPanel() {
  const on = useStore((s) => s.settings?.general.progressPanel !== false)
  const open = useProgressOpen()
  const runs = useProgressRuns()
  const focused = useStore((s) => s.windowFocused)
  const width = usePaneSize('progress', 280)
  const anyOpen = runs.some(isOpenRun)
  // Once a second while something runs (elapsed time, time left), else now and then (to fade passed runs).
  const now = useNow(anyOpen || runs.some((r) => r.state === 'passed' && !r.dismissed) ? 1000 : 30000)
  const failedUnseen = runs.some((r) => r.state === 'failed' && !r.dismissed)
  // Looking at the open panel clears the taskbar's red.
  useEffect(() => {
    if (on && open && focused && failedUnseen) void call('progress:seen')
  }, [on, open, focused, failedUnseen, runs])
  if (!on) return null
  const shown = runs.filter((r) => isShown(r, now))
  if (!open) return <ProgressRail runs={shown} />
  const recent = runs.filter((r) => !isShown(r, now) && r.finishedAt !== null).slice(0, 10)
  const kb = commandKeybinding('progress.toggle')

  return (
    <div className="progress-panel" style={{ width }} role="region" aria-label="Progress">
      <PaneResizer paneKey="progress" edge="left" min={220} max={640} keep={300} />
      <div className="progress-header">
        <Icon name="pulse" /> Progress
        <div className="grow" />
        <IconButton icon="chevron-right" title={`Fold the Progress panel${kb ? ` (${formatKeybinding(kb)})` : ''}`} onClick={() => setProgressOpen(false)} />
      </div>
      <div className="progress-body">
        {shown.length === 0 && (
          <div className="pane-empty progress-empty">
            Nothing is running. When an agent runs tests or a build with progress reporting, it shows here with how far along it is and the time left.
          </div>
        )}
        {shown.map((r) => (
          <RunRow key={r.id} run={r} now={now} />
        ))}
        {recent.length > 0 && (
          <>
            <div className="progress-section">Recent</div>
            {recent.map((r) => (
              <RecentRow key={r.id} run={r} />
            ))}
          </>
        )}
      </div>
    </div>
  )
}

/** One run: who, what, a bar, the step, elapsed time and time left; a failed or stale one can be dismissed. */
function RunRow({ run: r, now }: { run: ProgressRun; now: number }) {
  const project = useStore((s) => (r.projectPath ? (findProject(s, r.projectPath)?.name ?? null) : null))
  const fraction = fractionDone(r)
  const left = r.state === 'running' ? timeLeft(r, now) : null
  const ended = r.finishedAt ?? now
  const step = r.total !== null ? `${Math.min((r.step ?? 0) + (r.state === 'running' && r.stepName ? 1 : 0), r.total)} of ${r.total}${r.stepName ? `: ${r.stepName}` : ''}` : r.stepName
  const status =
    r.state === 'passed'
      ? `Passed in ${shortDuration(ended - r.startedAt)}`
      : r.state === 'failed'
        ? `Failed after ${shortDuration(ended - r.startedAt)}`
        : r.state === 'stale'
          ? r.staleReason === 'agent-stopped'
            ? 'Its agent stopped before it finished'
            : `Stopped reporting ${shortDuration(now - r.updatedAt)} ago`
          : `${shortDuration(now - r.startedAt)}${left !== null ? ` · about ${shortDuration(left)} left` : ''}`
  return (
    <div className={cx('progress-run', r.state)} data-run={r.id}>
      <div className="progress-run-top" onClick={() => showRunAgent(r)} title="Show the agent">
        {r.provider ? <ProviderIcon provider={r.provider} /> : <Icon name="terminal" />}
        <span className="progress-agent">{r.agentName}</span>
        {project && <span className="faint progress-project">{project}</span>}
        <div className="grow" />
        {r.state === 'passed' && <Icon name="pass" className="progress-ok" />}
        {r.state === 'failed' && <Icon name="error" className="progress-fail" />}
        {r.state === 'stale' && <Icon name="warning" className="progress-stale" />}
        {(r.state === 'failed' || r.state === 'stale') && (
          <IconButton
            icon="close"
            title="Dismiss (it stays under Recent)"
            onClick={(e) => {
              e.stopPropagation()
              void call('progress:dismiss', r.id)
            }}
          />
        )}
      </div>
      <Tooltip content={r.command ?? r.title}>
        <div className="progress-title">{r.title}</div>
      </Tooltip>
      <div className={cx('progress-bar', fraction === null && r.state === 'running' && 'indeterminate')} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)} aria-label={r.title}>
        <div style={{ width: `${fraction === null ? (r.state === 'running' ? 30 : 100) : Math.round(fraction * 100)}%` }} />
      </div>
      {step && <div className="progress-step faint">{step}</div>}
      <div className="progress-status faint">{status}</div>
      {r.summary && r.state === 'failed' && <div className="progress-summary">{r.summary}</div>}
    </div>
  )
}

/** A finished run under Recent: one line. */
function RecentRow({ run: r }: { run: ProgressRun }) {
  const took = r.finishedAt !== null ? shortDuration(r.finishedAt - r.startedAt) : ''
  const icon = r.state === 'passed' ? 'pass' : r.state === 'failed' ? 'error' : 'warning'
  const what = r.state === 'passed' ? 'passed' : r.state === 'failed' ? 'failed' : 'stopped reporting'
  return (
    <Tooltip content={`${r.agentName}: ${r.title} ${what}${took ? ` (${took})` : ''}${r.summary ? `\n${r.summary}` : ''}`}>
      <div className={cx('progress-recent', r.state)} onClick={() => showRunAgent(r)}>
        <Icon name={icon} /> <span className="progress-recent-text">{r.agentName} · {r.title}</span>
        <span className="faint">{took}</span>
      </div>
    </Tooltip>
  )
}

/** The folded panel: a strip down the right edge, with a small bar per run while anything runs. */
function ProgressRail({ runs }: { runs: ProgressRun[] }) {
  const kb = commandKeybinding('progress.toggle')
  const open = (): void => setProgressOpen(true)
  return (
    <div
      className="progress-rail"
      role="button"
      tabIndex={0}
      aria-label="Show the Progress panel"
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          open()
        }
      }}
    >
      <Tooltip content={`Show the Progress panel${kb ? ` (${formatKeybinding(kb)})` : ''}`}>
        <span className="rail-btn">
          <Icon name="chevron-left" />
        </span>
      </Tooltip>
      {runs.slice(0, 6).map((r) => {
        const f = fractionDone(r)
        return (
          <Tooltip key={r.id} content={`${r.agentName}: ${r.title}${f !== null ? ` (${Math.round(f * 100)}%)` : ''}`}>
            <span className={cx('progress-mini', r.state, f === null && r.state === 'running' && 'indeterminate')} data-run={r.id}>
              <span style={{ height: `${f === null ? (r.state === 'running' ? 40 : 100) : Math.max(4, Math.round(f * 100))}%` }} />
            </span>
          </Tooltip>
        )
      })}
      <span className="progress-rail-label">Progress</span>
    </div>
  )
}
