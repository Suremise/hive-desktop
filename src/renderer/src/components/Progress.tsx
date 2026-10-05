import { useEffect, useState } from 'react'
import { RECENT_RUNS, RUN_STATE_WORDS, fractionDone, inStrip, isListed, isOpenRun, isRecent, shortDuration, stripRuns, timeLeft, unseenTrouble } from '@shared/progress'
import { formatDateTime } from '@shared/dates'
import { providerName } from '@shared/providers'
import type { ProgressRun } from '@shared/types'
import { selectProject } from '../actions'
import { call } from '../api'
import { commandKeybinding } from '../commands'
import { findProject, flashPane, get, notify, projectKey, revealAgent, set, setAssistantOpen, setProgressOpen, useDateStyle, useProgressOpen, useStore } from '../store'
import { useNow } from '../usage'
import { cx, formatKeybinding } from '../util'
import { ProviderIcon } from './ProviderIcon'
import { PaneResizer, usePaneSize } from './Resizer'
import { Icon, IconButton, Tooltip } from './ui'

/**
 * The Progress panel: long runs agents report (tests, builds), each with its agent, how far along and the time left.
 * On the right, beside the Assistant's panel; folded, a strip with a small bar per run. It never opens by itself.
 * A run listed there, or under Recent, opens its details; its agent's name shows that agent.
 */

const NO_RUNS: ProgressRun[] = []

type StoreState = Parameters<typeof findProject>[0]

/** Why a run's agent can't be shown, or null when it can: the Assistant, or a project agent that is still there. */
function whyNotShown(s: StoreState, r: ProgressRun): string | null {
  if (r.source === 'assistant') return s.workspace?.assistant ? null : 'The Assistant is not in this workspace.'
  if (r.source === 'api') return 'A script reported it, not an agent: there is no agent to show.'
  const p = r.projectPath ? findProject(s, r.projectPath) : null
  if (!p) return `Its project is no longer in this workspace.`
  if (!r.agentId || !p.agents.some((a) => a.id === r.agentId)) return `${r.agentName} has been removed from ${p.name}.`
  return null
}

/**
 * Shows the agent that reported a run (the Assistant's panel for the Assistant), and says so: its pane is highlighted
 * for a moment and takes the keyboard, so showing an agent that was already on screen visibly does something.
 */
function showRunAgent(r: ProgressRun): void {
  const s = get()
  const why = whyNotShown(s, r)
  if (why) return void notify('info', `Can't show ${r.agentName}`, why)
  if (r.source === 'assistant') {
    setAssistantOpen(true)
    return flashPane(projectKey(s.workspace!.assistant!.path, 'assistant'))
  }
  const p = findProject(s, r.projectPath!)!
  selectProject(p.path)
  revealAgent(p, r.agentId!)
  flashPane(projectKey(p.path, r.agentId!))
}

/** What showing a run's agent is called, for its button. */
const showLabel = (r: ProgressRun): string => `Show ${r.source === 'assistant' ? 'the Assistant' : r.agentName}, which ran ${r.title}`

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
  // The run whose details are open.
  const [detail, setDetail] = useState<string | null>(null)
  const anyOpen = runs.some(isOpenRun)
  // Once a second while something runs or is about to fold into Recent (a passed run, a failure just seen), else now
  // and then.
  const folding = runs.some((r) => !r.dismissed && (r.state === 'passed' || r.seenAt !== null))
  const now = useNow(anyOpen || folding ? 1000 : 30000)
  const unseen = runs.some(unseenTrouble)
  // Looking at the open panel counts as seeing what failed or went stale: the taskbar's and the strip's red clear,
  // and those runs fold into Recent a few seconds later.
  useEffect(() => {
    if (on && open && focused && unseen) void call('progress:seen')
  }, [on, open, focused, unseen, runs])
  if (!on) return null
  if (!open) return <ProgressRail runs={runs.filter((r) => inStrip(r, now))} />
  const listed = runs.filter((r) => isListed(r, now))
  const recent = runs.filter((r) => isRecent(r, now)).slice(0, RECENT_RUNS)
  const kb = commandKeybinding('progress.toggle')
  const toggle = (id: string): void => setDetail((d) => (d === id ? null : id))

  return (
    <div
      className="progress-panel"
      style={{ width }}
      role="region"
      aria-label="Progress"
      onKeyDown={(e) => {
        // Escape closes a run's details (and goes no further).
        if (e.key === 'Escape' && detail) {
          e.stopPropagation()
          const id = detail
          setDetail(null)
          requestAnimationFrame(() => document.querySelector<HTMLElement>(`.progress-panel [data-run="${id}"] .progress-details-toggle`)?.focus())
        }
      }}
    >
      <PaneResizer paneKey="progress" edge="left" min={220} max={640} keep={300} />
      <div className="progress-header">
        <Icon name="pulse" /> Progress
        <div className="grow" />
        <IconButton icon="chevron-right" title={`Fold the Progress panel${kb ? ` (${formatKeybinding(kb)})` : ''}`} onClick={() => setProgressOpen(false)} />
      </div>
      <div className="progress-body">
        {listed.length === 0 && (
          <div className="pane-empty progress-empty">
            Nothing is running. When an agent runs tests or a build with progress reporting, it shows here with how far along it is and the time left.
          </div>
        )}
        {listed.map((r) => (
          <RunRow key={r.id} run={r} now={now} open={detail === r.id} onToggle={() => toggle(r.id)} />
        ))}
        {recent.length > 0 && (
          <>
            <div className="progress-section">Recent</div>
            {recent.map((r) => (
              <RecentRow key={r.id} run={r} now={now} open={detail === r.id} onToggle={() => toggle(r.id)} />
            ))}
          </>
        )}
      </div>
    </div>
  )
}

/** A run's state in a line: how long it took, or has been going and how long is left; why a stale one is. */
function statusLine(r: ProgressRun, now: number): string {
  const ended = r.finishedAt ?? now
  const left = r.state === 'running' ? timeLeft(r, now) : null
  if (r.state === 'passed') return `Passed in ${shortDuration(ended - r.startedAt)}`
  if (r.state === 'failed') return `Failed after ${shortDuration(ended - r.startedAt)}`
  if (r.state === 'stale') return r.staleReason === 'agent-stopped' ? 'Its agent stopped before it finished' : `Stopped reporting ${shortDuration(now - r.updatedAt)} ago`
  return `${shortDuration(now - r.startedAt)}${left !== null ? ` · about ${shortDuration(left)} left` : ''}`
}

/** Its steps: "4 of 12: carddialog", or the step's name alone. */
function stepLine(r: ProgressRun): string | null {
  return r.total !== null ? `${Math.min((r.step ?? 0) + (r.state === 'running' && r.stepName ? 1 : 0), r.total)} of ${r.total}${r.stepName ? `: ${r.stepName}` : ''}` : r.stepName
}

/**
 * One run: who, what, a bar, the step, elapsed time and time left; a failed or stale one can be dismissed. A click on it
 * opens its details (and closes them); its agent's name shows the agent.
 */
function RunRow({ run: r, now, open, onToggle }: { run: ProgressRun; now: number; open: boolean; onToggle: () => void }) {
  const project = useStore((s) => (r.projectPath ? (findProject(s, r.projectPath)?.name ?? null) : null))
  const showable = useStore((s) => whyNotShown(s, r) === null)
  const fraction = fractionDone(r)
  const step = stepLine(r)
  return (
    <div
      className={cx('progress-run', r.state, open && 'open')}
      data-run={r.id}
      onClick={() => {
        // Not when the click ended a text selection (copying a failure's summary).
        if (!window.getSelection()?.toString()) onToggle()
      }}
    >
      <div className="progress-run-top">
        {showable ? (
          <button
            type="button"
            className="progress-run-show"
            title="Show the agent"
            aria-label={showLabel(r)}
            onClick={(e) => {
              e.stopPropagation()
              showRunAgent(r)
            }}
          >
            <RunWho run={r} project={project} />
          </button>
        ) : (
          <span className="progress-run-show">
            <RunWho run={r} project={project} />
          </span>
        )}
        <div className="grow" />
        {r.state === 'passed' && <Icon name="pass" className="progress-ok" />}
        {r.state === 'failed' && <Icon name="error" className="progress-fail" />}
        {r.state === 'stale' && <Icon name="warning" className="progress-stale" />}
        <DetailsToggle run={r} open={open} onToggle={onToggle} />
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
      <Tooltip block content={r.command ?? r.title}>
        <div className="progress-title">{r.title}</div>
      </Tooltip>
      <div className={cx('progress-bar', fraction === null && r.state === 'running' && 'indeterminate')} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)} aria-label={r.title}>
        <div style={{ width: `${fraction === null ? (r.state === 'running' ? 30 : 100) : Math.round(fraction * 100)}%` }} />
      </div>
      {step && <div className="progress-step faint">{step}</div>}
      <div className="progress-status faint">{statusLine(r, now)}</div>
      {r.summary && r.state === 'failed' && <div className="progress-summary">{r.summary}</div>}
      {open && <RunDetails run={r} now={now} />}
    </div>
  )
}

/** The button opening or closing a run's details (the row's click does the same; this is it for the keyboard). */
function DetailsToggle({ run: r, open, onToggle }: { run: ProgressRun; open: boolean; onToggle: () => void }) {
  return (
    <IconButton
      icon={open ? 'chevron-up' : 'info'}
      className="progress-details-toggle"
      title={open ? 'Close the details (Escape)' : `Details of ${r.title}`}
      expanded={open}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
    />
  )
}

/** Who ran it: the provider's icon, the agent and its project. */
function RunWho({ run: r, project }: { run: ProgressRun; project: string | null }) {
  return (
    <>
      {r.provider ? <ProviderIcon provider={r.provider} /> : <Icon name="terminal" />}
      <span className="progress-agent">{r.agentName}</span>
      {project && <span className="faint progress-project">{project}</span>}
    </>
  )
}

/** A finished run under Recent: one line, red when it failed; a click opens its details. */
function RecentRow({ run: r, now, open, onToggle }: { run: ProgressRun; now: number; open: boolean; onToggle: () => void }) {
  const took = r.finishedAt !== null ? shortDuration(r.finishedAt - r.startedAt) : ''
  const icon = r.state === 'passed' ? 'pass' : r.state === 'failed' ? 'error' : 'warning'
  const what = r.state === 'passed' ? 'passed' : r.state === 'failed' ? 'failed' : 'stopped reporting'
  return (
    <div className={cx('progress-recent-item', r.state, open && 'open')} data-run={r.id}>
      <Tooltip block content={`${r.agentName}: ${r.title} ${what}${took ? ` (${took})` : ''}${r.summary ? `\n${r.summary}` : ''}`}>
        <button type="button" className={cx('progress-recent', 'progress-details-toggle', r.state)} aria-expanded={open} aria-label={`${r.agentName}: ${r.title}, ${what}${took ? ` in ${took}` : ''}. Details`} onClick={onToggle}>
          <Icon name={icon} /> <span className="progress-recent-text">{r.agentName} · {r.title}</span>
          <span className="faint">{took}</span>
        </button>
      </Tooltip>
      {open && <RunDetails run={r} now={now} />}
    </div>
  )
}

/** Copies a text, saying so. */
function copy(what: string, text: string): void {
  void navigator.clipboard.writeText(text).then(
    () => notify('success', `${what} copied`),
    () => notify('error', `Could not copy the ${what.toLowerCase()}`)
  )
}

/**
 * Everything Hive has for a run: what ran (the command, copyable), who (agent, project, provider), when it started and
 * ended (in the user's date and time format), how long against what was expected, its steps, its state and why, the
 * exit code, a log the reporter named, and the failure's summary (copyable); and its agent, to show.
 */
function RunDetails({ run: r, now }: { run: ProgressRun; now: number }) {
  useDateStyle()
  const project = useStore((s) => (r.projectPath ? (findProject(s, r.projectPath)?.name ?? null) : null))
  const why = useStore((s) => whyNotShown(s, r))
  const took = (r.finishedAt ?? now) - r.startedAt
  const steps = r.total !== null ? `${Math.min(r.step ?? 0, r.total)} of ${r.total} done${r.stepName ? ` · last: ${r.stepName}` : ''}` : r.stepName ? `Last: ${r.stepName}` : null
  const state =
    r.state === 'stale'
      ? `Stopped reporting: ${r.staleReason === 'agent-stopped' ? 'its agent stopped before it finished' : `no report for ${shortDuration(now - r.updatedAt)}`}`
      : `${RUN_STATE_WORDS[r.state][0].toUpperCase()}${RUN_STATE_WORDS[r.state].slice(1)}${r.dismissed ? ' (dismissed)' : ''}`
  const rows: [string, React.ReactNode][] = [
    ['Run', r.title],
    ...(r.command ? [['Command', <code key="c">{r.command}</code>] as [string, React.ReactNode]] : []),
    ['Agent', `${r.agentName}${project ? ` · ${project}` : ''}`],
    ...(r.provider ? [['Provider', providerName(r.provider)] as [string, React.ReactNode]] : []),
    ['Started', formatDateTime(r.startedAt)],
    ...(r.finishedAt !== null ? [['Ended', formatDateTime(r.finishedAt)] as [string, React.ReactNode]] : []),
    ['Took', `${shortDuration(took)}${r.finishedAt === null ? ' so far' : ''}${r.expectedMs !== null ? ` · expected about ${shortDuration(r.expectedMs)}` : ''}`],
    ...(steps ? [['Steps', steps] as [string, React.ReactNode]] : []),
    ['State', state],
    ...(r.exitCode !== null ? [['Exit code', String(r.exitCode)] as [string, React.ReactNode]] : []),
    ...(r.logPath ? [['Log', <code key="l">{r.logPath}</code>] as [string, React.ReactNode]] : [])
  ]
  return (
    <div className="progress-details" role="region" aria-label={`Details of ${r.title}`} onClick={(e) => e.stopPropagation()}>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k} className="progress-detail-row">
            <dt className="faint">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {r.summary && <div className={cx('progress-summary', r.state !== 'failed' && 'plain')}>{r.summary}</div>}
      <div className="progress-detail-actions">
        {why === null ? (
          <button type="button" className="btn small" onClick={() => showRunAgent(r)} aria-label={showLabel(r)}>
            <Icon name="eye" /> Show the agent
          </button>
        ) : (
          <span className="faint progress-detail-why">{why}</span>
        )}
        {r.command && (
          <button type="button" className="btn small subtle" onClick={() => copy('Command', r.command!)}>
            <Icon name="copy" /> Copy command
          </button>
        )}
        {r.summary && (
          <button type="button" className="btn small subtle" onClick={() => copy('Summary', r.summary!)}>
            <Icon name="copy" /> Copy summary
          </button>
        )}
        {r.logPath && (
          <button type="button" className="btn small subtle" onClick={() => void call('app:showInFolder', r.logPath!)}>
            <Icon name="folder-opened" /> Show log
          </button>
        )}
      </div>
    </div>
  )
}

/** At most this many of the runs past the strip's bars are listed in its "+N" tooltip. */
const MORE_LISTED = 12

/**
 * The folded panel: a strip down the right edge, with a small bar per run (the newest few) while anything runs, and
 * "+N" for the rest, listed on hover and coloured for a failed or stale one among them. Its name counts every run.
 */
function ProgressRail({ runs }: { runs: ProgressRun[] }) {
  const kb = commandKeybinding('progress.toggle')
  const open = (): void => setProgressOpen(true)
  const { bars, more, moreState, summary } = stripRuns(runs)
  return (
    <div
      className="progress-rail"
      role="button"
      tabIndex={0}
      aria-label={`Show the Progress panel${summary ? ` (${summary})` : ''}`}
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
      {bars.map((r) => {
        const f = fractionDone(r)
        return (
          <Tooltip key={r.id} content={`${r.agentName}: ${r.title}${f !== null ? ` (${Math.round(f * 100)}%)` : ''}`}>
            <span className={cx('progress-mini', r.state, f === null && r.state === 'running' && 'indeterminate')} data-run={r.id}>
              <span style={{ height: `${f === null ? (r.state === 'running' ? 40 : 100) : Math.max(4, Math.round(f * 100))}%` }} />
            </span>
          </Tooltip>
        )
      })}
      {more.length > 0 && (
        <Tooltip
          content={
            <>
              <div>{more.length} more:</div>
              {more.slice(0, MORE_LISTED).map((r) => (
                <div key={r.id}>
                  {r.agentName}: {r.title} ({RUN_STATE_WORDS[r.state]})
                </div>
              ))}
              {more.length > MORE_LISTED && <div className="faint">and {more.length - MORE_LISTED} others: open the panel to see them</div>}
            </>
          }
        >
          <span className={cx('progress-more', moreState)} data-more={more.length}>
            +{more.length}
          </span>
        </Tooltip>
      )}
      <span className="progress-rail-label">Progress</span>
    </div>
  )
}
