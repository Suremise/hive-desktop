import { useEffect, useRef, useState } from 'react'
import { ALL_PROJECTS, RECENT_RUNS, RUN_STATE_WORDS, SHOW_ALL, activeFilter, agentChoices, filterChoices, filterRuns, fractionDone, inStrip, isListed, isOpenRun, isRecent, runDetails, runDetailsText, shortDuration, stripRuns, timeLeft, unseenTrouble } from '@shared/progress'
import type { ProgressRun } from '@shared/types'
import { attempt, selectProject } from '../actions'
import { call } from '../api'
import { commandKeybinding } from '../commands'
import { findProject, flashPane, get, notify, projectKey, revealAgent, set, setAssistantOpen, setProgressFilter, setProgressOpen, useDateStyle, useProgressFilter, useProgressOpen, useStore } from '../store'
import { useNow } from '../usage'
import { cx, formatKeybinding } from '../util'
import { ProviderIcon } from './ProviderIcon'
import { PaneResizer, usePaneSize } from './Resizer'
import { MergeSlotList, useMergeSlots } from './MergeSlots'
import { ShowAllList } from './ShowAllList'
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
  const slots = useMergeSlots()
  const chosen = useProgressFilter()
  const workspace = useStore((s) => s.workspace)
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
  // The filter (#251): one project's runs (and one agent's), or all; offered when the runs span more than one project.
  const nameOf = (p: string): string => workspace?.projects.find((x) => x.path.toLowerCase() === p.toLowerCase())?.name ?? p.split(/[\\/]/).pop() ?? p
  const choices = filterChoices(runs, nameOf)
  const filter = activeFilter(runs, chosen)
  const shown = filterRuns(runs, filter)
  const filterName = filter === SHOW_ALL ? null : `${choices.find((c) => c.value === filter.project)?.label ?? ''}${filter.agent ? ` · ${shown[0]?.agentName ?? ''}` : ''}`
  if (!open) return <ProgressRail runs={shown.filter((r) => inStrip(r, now))} filtered={filterName ? { name: filterName, all: runs.filter((r) => inStrip(r, now)).length } : null} />
  const listed = shown.filter((r) => isListed(r, now))
  // Recent: the newest few, and Show all for the rest Hive keeps (#352).
  const recent = shown.filter((r) => isRecent(r, now))
  const agents = filter.project !== ALL_PROJECTS ? agentChoices(runs, filter.project) : []
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
      {choices.length > 1 && (
        <div className="progress-filter">
          <select className="select" aria-label="Show the runs of" value={filter.project} onChange={(e) => setProgressFilter({ project: e.target.value })}>
            <option value={ALL_PROJECTS}>All projects</option>
            {choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          {agents.length > 1 && (
            <select className="select" aria-label="…and of the agent" value={filter.agent ?? ''} onChange={(e) => setProgressFilter({ project: filter.project, ...(e.target.value ? { agent: e.target.value } : {}) })}>
              <option value="">All agents</option>
              {agents.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      <div className="progress-body">
        {slots.length > 0 && (
          <>
            <div className="progress-section">Merge slots</div>
            <MergeSlotList slots={slots} projectName={nameOf} showProject />
          </>
        )}
        {listed.length === 0 && !slots.length && (
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
            <ShowAllList
              items={recent}
              few={RECENT_RUNS}
              keyOf={(r) => r.id}
              renderItem={(r) => <RecentRow run={r} now={now} open={detail === r.id} onToggle={() => toggle(r.id)} />}
              label="Recent runs"
              foldKey={workspace ? `progress-recent-all:${workspace.path.toLowerCase()}` : undefined}
              className="progress-recent-list"
            />
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
      icon={open ? 'chevron-up' : 'chevron-down'}
      className="progress-details-toggle"
      title={`${open ? 'Hide' : 'Show'} details for ${r.title}`}
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

/**
 * A finished run under Recent: one line, red when it failed, with how long it took and a chevron after it (#251); a
 * click on the line, or the chevron (the keyboard's way), opens its details.
 */
function RecentRow({ run: r, now, open, onToggle }: { run: ProgressRun; now: number; open: boolean; onToggle: () => void }) {
  const item = useRef<HTMLDivElement>(null)
  // Opened in the scrolling box of all of them, its details scroll into view.
  useEffect(() => {
    if (open) item.current?.querySelector('.progress-details')?.scrollIntoView({ block: 'nearest' })
  }, [open])
  const took = r.finishedAt !== null ? shortDuration(r.finishedAt - r.startedAt) : ''
  const icon = r.state === 'passed' ? 'pass' : r.state === 'failed' ? 'error' : 'warning'
  const what = r.state === 'passed' ? 'passed' : r.state === 'failed' ? 'failed' : 'stopped reporting'
  return (
    <div ref={item} className={cx('progress-recent-item', r.state, open && 'open')} data-run={r.id}>
      <div
        className={cx('progress-recent', r.state)}
        onClick={() => {
          if (!window.getSelection()?.toString()) onToggle()
        }}
      >
        <Tooltip block content={`${r.agentName}: ${r.title} ${what}${took ? ` (${took})` : ''}${r.summary ? `\n${r.summary}` : ''}`}>
          <Icon name={icon} /> <span className="progress-recent-text">{r.agentName} · {r.title}</span>
          <span className="faint progress-recent-took">{took}</span>
        </Tooltip>
        <DetailsToggle run={r} open={open} onToggle={onToggle} />
      </div>
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
 * Everything Hive has for a run (`runDetails`): what ran (the command, copyable), who, when, how long, its steps, state,
 * exit code and the log the reporter named, which opens or shows in its folder (#251); the failure's summary; all of it
 * copyable at once (Copy details, to paste to the Assistant); and its agent, to show.
 */
function RunDetails({ run: r, now }: { run: ProgressRun; now: number }) {
  useDateStyle()
  const project = useStore((s) => (r.projectPath ? (findProject(s, r.projectPath)?.name ?? null) : null))
  const why = useStore((s) => whyNotShown(s, r))
  const rows = runDetails(r, project, now)
  return (
    <div className="progress-details" role="region" aria-label={`Details of ${r.title}`} onClick={(e) => e.stopPropagation()}>
      <dl>
        {rows.map((d) => (
          <div key={d.label} className="progress-detail-row">
            <dt>{d.label}</dt>
            <dd>{d.code ? <code>{d.text}</code> : d.text}</dd>
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
          <span className="progress-detail-why">{why}</span>
        )}
        {r.command && (
          <button type="button" className="btn small subtle" onClick={() => copy('Command', r.command!)}>
            <Icon name="copy" /> Copy command
          </button>
        )}
        <button type="button" className="btn small subtle" onClick={() => copy('Details', runDetailsText(r, project, now))}>
          <Icon name="copy" /> Copy details
        </button>
        {r.logPath && (
          <>
            <button type="button" className="btn small subtle" onClick={() => void attempt("Couldn't open the log", () => call('progress:openLog', r.id))}>
              <Icon name="go-to-file" /> Open log
            </button>
            <button type="button" className="btn small subtle" onClick={() => void attempt("Couldn't show the log", () => call('progress:showLog', r.id))}>
              <Icon name="folder-opened" /> Show in folder
            </button>
          </>
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
function ProgressRail({ runs, filtered }: { runs: ProgressRun[]; filtered: { name: string; all: number } | null }) {
  const kb = commandKeybinding('progress.toggle')
  const open = (): void => setProgressOpen(true)
  const { bars, more, moreState, summary } = stripRuns(runs)
  // Filtered (#251): it shows and counts that project's runs, and says how many there are in all.
  const what = filtered ? `${filtered.name} only: ${summary || 'no runs'}; ${filtered.all} in all` : summary
  return (
    <div
      className={cx('progress-rail', filtered && 'filtered')}
      role="button"
      tabIndex={0}
      aria-label={`Show the Progress panel${what ? ` (${what})` : ''}`}
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
      {filtered && (
        <Tooltip content={`Showing ${filtered.name} only (${runs.length} of ${filtered.all})`}>
          <span className="progress-rail-filter">
            <Icon name="filter" />
          </span>
        </Tooltip>
      )}
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
