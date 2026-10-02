import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectInfo, SessionListItem } from '@shared/types'
import { PROVIDERS, isProviderEnabled } from '@shared/providers'
import { PERIODS, activeIn, money, periodFrom, stackedDaily, sumUsage, totalTokens, type DayTotal, type Totals, type UsageGroup } from '@shared/usageTotals'
import { call, errorMessage } from '../api'
import { selectProject } from '../actions'
import { NO_PROJECTS, get, revealAgent, set, setAssistantOpen, setProjectTab, showView, useStore } from '../store'
import { cx, formatNumber, formatTokens, timeAgo } from '../util'
import { useNow } from '../usage'
import { Icon, IconButton, InfoTip, LoadFailed, StaleNote, Tooltip } from '../components/ui'
import { ProviderIcon } from '../components/ProviderIcon'
import { cardStalled } from '../components/Board'
import { PlanLimits, RunningAgent } from './ProjectTabs'

/** Live updates come at most this often (each checks every project's transcripts against the usage cache). */
const LIVE_REFRESH_MS = 15_000

const COST_TIP =
  'What this work would have cost at API prices: reported by the provider where it does (Claude Code), else estimated by Hive from token counts and the prices in Settings → the provider. On a subscription you are not charged this; it shows how heavy the work was.'

/**
 * Loads the workspace's usage into the store while the Workspace Overview is shown. Updates follow Settings →
 * Sessions → Overview updates, like the project Overview: live (as sessions change, at most every 15 s), every
 * minute, or only on Refresh. Main reads each project's sessions file and takes usage from the usage cache.
 */
function useWorkspaceUsage(): () => void {
  const mode = useStore((s) => s.settings?.sessions.overviewRefresh ?? 'live')
  const wsPath = useStore((s) => s.workspace?.path ?? null)
  // A string, so the selector returns nothing new while nothing changed.
  const liveKey = useStore(
    (s) =>
      `${Object.values(s.usageVersion).join(',')}|${[...(s.workspace?.projects ?? []), ...(s.workspace?.assistant ? [s.workspace.assistant] : [])]
        .flatMap((p) => p.agents.map((a) => `${a.live?.sessionId ?? ''}:${a.live?.status ?? ''}`))
        .join(',')}`
  )
  const last = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loads = useRef(0)
  const load = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    last.current = Date.now()
    const n = ++loads.current
    const asked = get().workspace?.path ?? ''
    call('workspace:usage')
      .then((u) => {
        // A newer load, or another workspace in this window meanwhile: not this one's to show.
        if (n !== loads.current || u.workspacePath !== get().workspace?.path) return
        set({ workspaceUsage: u, workspaceUsageAt: Date.now(), workspaceUsageError: null })
      })
      // Said in the view (in place of the figures, or over the last ones), not a toast on every live refresh.
      .catch((e) => n === loads.current && asked === get().workspace?.path && set({ workspaceUsageError: { workspacePath: asked, error: errorMessage(e) } }))
  }, [])
  useEffect(() => {
    load()
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [load, wsPath])
  useEffect(() => {
    if (mode !== 'live' || !last.current) return
    const wait = last.current + LIVE_REFRESH_MS - Date.now()
    if (wait <= 0) load()
    else if (!timer.current) timer.current = setTimeout(load, wait)
  }, [liveKey, mode, load])
  useEffect(() => {
    if (mode !== 'minute') return
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [mode, load])
  return load
}

/** The groups the overview adds up: each project, then the Assistant. */
function usageGroups(): UsageGroup[] {
  const u = get().workspaceUsage
  if (!u) return []
  return [...u.projects.map((p) => ({ key: p.path, label: p.name, items: p.items })), ...(u.assistant.length ? [{ key: 'assistant', label: 'Assistant', items: u.assistant }] : [])]
}

function openProjectOverview(path: string): void {
  if (path === 'assistant') return showView('assistant')
  selectProject(path)
  setProjectTab(path, 'overview')
}

/** The workspace's last activity in a group's sessions. */
const lastActive = (items: SessionListItem[]): string | null => items.reduce<string | null>((m, s) => (s.lastActivity && (!m || s.lastActivity > m) ? s.lastActivity : m), null)

function Card({ title, value, sub, tip, accent }: { title: string; value: React.ReactNode; sub?: React.ReactNode; tip?: string; accent?: boolean }) {
  return (
    <div className={cx('card', accent && 'accent')}>
      <h3>
        {title} {tip && <InfoTip text={tip} />}
      </h3>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  )
}

const costText = (t: Totals): string => `${t.estimated ? '≈ ' : ''}${money(t.cost)}`

/** Tokens per day, stacked by project (the top six, the rest as Other); hover a day for its numbers. */
function StackedChart({ series, days }: { series: { key: string; label: string }[]; days: (DayTotal & { parts: number[] })[] }) {
  const max = Math.max(1, ...days.map((d) => d.tokens))
  const label = (day: string): string => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  const colour = (i: number): string => (series[i].key ? `var(--series-${i + 1})` : 'var(--series-other)')
  return (
    <div className="daily-chart">
      <div className="daily-bars" role="img" aria-label="Tokens per day by project">
        {days.map((d) => (
          <Tooltip
            key={d.day}
            content={
              <div className="stack-tip">
                <div>
                  <strong>{label(d.day)}</strong>: {formatTokens(d.tokens)} tokens · {d.estimated ? '≈ ' : ''}
                  {money(d.cost)} · {d.prompts} prompt{d.prompts === 1 ? '' : 's'}
                </div>
                {series.map((s, i) =>
                  d.parts[i] ? (
                    <div key={s.key || 'other'} className="stack-tip-row">
                      <span className="swatch" style={{ background: colour(i) }} /> {s.label}: {formatTokens(d.parts[i])}
                    </div>
                  ) : null
                )}
              </div>
            }
          >
            <div className="daily-col">
              <div className="stack-bar" style={{ height: `${d.tokens ? Math.max(3, (d.tokens / max) * 100) : 0}%` }}>
                {d.parts.map((v, i) => (v ? <div key={i} className="stack-part" style={{ flexGrow: v, background: colour(i) }} /> : null))}
              </div>
            </div>
          </Tooltip>
        ))}
      </div>
      <div className="daily-axis">
        <span>{label(days[0].day)}</span>
        <span>Today</span>
      </div>
      <div className="stack-legend">
        {series.map((s, i) => (
          <span key={s.key || 'other'}>
            <span className="swatch" style={{ background: colour(i) }} /> {s.label}
          </span>
        ))}
      </div>
    </div>
  )
}

/** The board at a glance: each number opens the board. */
function BoardStrip() {
  const tasks = useStore((s) => s.tasks)
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  const open = tasks.filter((c) => !c.archived)
  if (!open.length) return null
  const count = (col: string): number => open.filter((c) => c.column === col).length
  const stalled = open.filter((c) => cardStalled(projects, c)).length
  const blocked = open.filter((c) => c.blocked && c.column !== 'done').length
  const items: { label: string; n: number; tone?: string }[] = [
    { label: 'Todo', n: count('todo') },
    { label: 'Doing', n: count('doing') },
    { label: 'Waiting for review', n: count('review'), tone: 'accent' },
    { label: 'Done', n: count('done') },
    { label: 'Stalled', n: stalled, tone: 'warning' },
    { label: 'Blocked', n: blocked, tone: 'error' }
  ]
  const toBoard = (): void => {
    set({ boardProject: null, boardArchived: false, boardQuery: '' })
    showView('board')
  }
  return (
    <div className="board-strip">
      <Icon name="project" />
      {items.map((x) => (
        <button key={x.label} className={cx('board-strip-item', x.n > 0 && x.tone)} onClick={toBoard}>
          <span className="n">{x.n}</span> {x.label}
        </button>
      ))}
    </div>
  )
}

type SortKey = 'name' | 'sessions' | 'tokens' | 'cost' | 'last'

/** The Workspace Overview (activity bar): the whole workspace's usage for a period, what runs now, each project and provider. */
export function WorkspaceOverviewView() {
  const reload = useWorkspaceUsage()
  const usage = useStore((s) => s.workspaceUsage)
  const loadedAt = useStore((s) => s.workspaceUsageAt)
  const failed = useStore((s) => (s.workspaceUsageError && s.workspaceUsageError.workspacePath === s.workspace?.path ? s.workspaceUsageError.error : null))
  const period = useStore((s) => s.overviewPeriod)
  const workspace = useStore((s) => s.workspace)
  const settings = useStore((s) => s.settings)
  const now = useNow(60000)
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'tokens', desc: true })
  const groups = useMemo(() => (usage ? usageGroups() : []), [usage])
  if (!workspace) return <div className="empty-state">Open a workspace to see its overview.</div>
  if (!usage || usage.workspacePath !== workspace.path) {
    if (failed) return <LoadFailed what="the workspace's usage" error={failed} onRetry={reload} />
    return (
      <div className="empty-state">
        <Icon name="loading" spin />
        Loading…
      </div>
    )
  }

  const from = periodFrom(period, now)
  const all = groups.flatMap((g) => g.items)
  const inPeriod = activeIn(all, from)
  const total = sumUsage(inPeriod, from)
  const hosts: ProjectInfo[] = [...workspace.projects, ...(workspace.assistant ? [workspace.assistant] : [])]
  const running = hosts.flatMap((p) => p.agents.filter((a) => a.live && !a.live.settingUp).map((a) => ({ p, a })))
  const used = new Set([...inPeriod.map((i) => i.provider), ...running.map((r) => r.a.live!.provider)])
  const providers = PROVIDERS.filter((p) => used.has(p.id) || isProviderEnabled(settings, p.id))
  const all$ = totalTokens(total)

  const rows = groups.map((g) => {
    const t = sumUsage(g.items, from)
    return { g, t, tokens: totalTokens(t), last: lastActive(g.items) }
  })
  const value = (r: (typeof rows)[number]): string | number => (sort.key === 'name' ? r.g.label.toLowerCase() : sort.key === 'sessions' ? r.t.sessions : sort.key === 'tokens' ? r.tokens : sort.key === 'cost' ? r.t.cost : (r.last ?? ''))
  const sorted = [...rows].sort((a, b) => {
    const x = value(a)
    const y = value(b)
    const c = x < y ? -1 : x > y ? 1 : a.g.label.localeCompare(b.g.label)
    return sort.desc ? -c : c
  })
  const header = (key: SortKey, label: string, num = true) => (
    <th className={cx(num && 'num', 'sortable')} onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== 'name' }))} aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : undefined}>
      {label}
      {sort.key === key && <Icon name={sort.desc ? 'chevron-down' : 'chevron-up'} />}
    </th>
  )
  const stack = from && period !== 'today' ? stackedDaily(groups, from, now) : null

  return (
    <div className="scroll-page">
      <div className="page-narrow">
        <div className="board-header">
          <h1>Workspace Overview</h1>
          <span className="faint">What every project and the Assistant used, what runs now, and the board at a glance.</span>
        </div>
        <BoardStrip />
        <div className="overview-head">
          <h2 className="section">Summary</h2>
          <Tooltip content={`Updated ${timeAgo(new Date(loadedAt).toISOString())}. How often it updates: Settings → Sessions → Overview updates.`}>
            <span>
              <IconButton icon="refresh" title="Refresh" onClick={reload} />
            </span>
          </Tooltip>
          <div className="grow" />
          <div className="segmented" role="group" aria-label="Period">
            {PERIODS.map((p) => (
              <button key={p.value} className={cx(period === p.value && 'active')} onClick={() => set({ overviewPeriod: p.value })}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
        {failed && <StaleNote what="the usage" error={failed} at={loadedAt} onRetry={reload} />}
        <p className="hint">Every project and the Assistant, by calendar day: a session that ran over several days counts only its part in the period.</p>
        <div className="cards">
          <Card accent title="Tokens" value={formatTokens(all$)} sub={`${formatTokens(total.input + total.cacheWrite)} in · ${formatTokens(total.cached)} cached · ${formatTokens(total.output)} out`} tip="All tokens: new input, cache writes, input read from cache, and output." />
          <Card title="API-equivalent cost" value={costText(total)} sub={total.unpriced ? `${total.unpriced} session${total.unpriced === 1 ? '' : 's'} without a price` : total.estimated ? 'partly estimated' : 'as reported'} tip={COST_TIP} />
          <Card title="Sessions" value={total.sessions} sub={`${running.length} running now`} />
          <Card title="Prompts" value={formatNumber(total.prompts)} sub={`${total.compactions} compaction${total.compactions === 1 ? '' : 's'}`} />
        </div>
        {stack && stack.series.length > 0 && <StackedChart series={stack.series} days={stack.days} />}

        {running.length > 0 && (
          <>
            <h2 className="section">Running now</h2>
            <div className="running-list">
              {running.map(({ p, a }) => {
                const isAssistant = p.path === workspace.assistant?.path
                return (
                  <RunningAgent
                    key={`${p.path}#${a.id}`}
                    project={p}
                    a={a}
                    label={isAssistant ? 'Assistant' : `${p.name} · ${a.name}`}
                    onOpen={() => {
                      if (isAssistant) return setAssistantOpen(true)
                      selectProject(p.path)
                      revealAgent(p, a.id)
                    }}
                  />
                )
              })}
            </div>
          </>
        )}

        <h2 className="section">By project</h2>
        <table className="table ws-projects">
          <thead>
            <tr>
              {header('name', 'Project', false)}
              {header('sessions', 'Sessions')}
              {header('tokens', 'Tokens')}
              {header('cost', 'Cost')}
              <th className="num">Share</th>
              {header('last', 'Last active')}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const share = all$ ? (r.tokens / all$) * 100 : 0
              return (
                <tr key={r.g.key} className="clickable" onClick={() => openProjectOverview(r.g.key)} title={r.g.key === 'assistant' ? 'Open the Assistant view' : `Open ${r.g.label}'s Overview`}>
                  <td>{r.g.key === 'assistant' ? <span className="muted">Assistant</span> : r.g.label}</td>
                  <td className="num">{r.t.sessions}</td>
                  <td className="num">{formatTokens(r.tokens)}</td>
                  <td className="num">{r.t.sessions ? costText(r.t) : '—'}</td>
                  <td className="num">
                    <span className="share">
                      <span className="share-bar" style={{ width: `${share}%` }} />
                    </span>
                    {r.tokens ? `${share < 1 ? '< 1' : Math.round(share)}%` : '—'}
                  </td>
                  <td className="num faint">{r.last ? timeAgo(r.last) : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {usage.hidden > 0 && (
          <p className="hint">
            {usage.hidden} hidden or removed project{usage.hidden === 1 ? " isn't" : "s aren't"} counted (Settings → Workspace).
          </p>
        )}

        {providers.map((p) => {
          const t = sumUsage(inPeriod.filter((i) => i.provider === p.id), from)
          return (
            <div key={p.id}>
              <h2 className="section">
                <ProviderIcon provider={p.id} /> {p.name}
                {!isProviderEnabled(settings, p.id) && <span className="muted" style={{ fontWeight: 400 }}> — turned off</span>}
              </h2>
              <div className="cards">
                <Card title="Tokens" value={formatTokens(totalTokens(t))} sub={`${formatTokens(t.output)} output`} />
                <Card title="API-equivalent cost" value={costText(t)} sub={t.unpriced ? `${t.unpriced} without a price` : !t.estimated ? 'as reported' : p.capabilities.reportsCost ? 'partly estimated' : 'estimated'} tip={COST_TIP} />
                <Card title="Sessions" value={t.sessions} sub={`${formatNumber(t.prompts)} prompts`} />
              </div>
              <PlanLimits provider={p.id} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** The Workspace Overview's sidebar: each project with what it used in the period; click opens its Overview. */
export function WorkspaceOverviewPanel() {
  const usage = useStore((s) => s.workspaceUsage)
  const period = useStore((s) => s.overviewPeriod)
  const workspace = useStore((s) => s.workspace)
  const now = useNow(60000)
  const from = periodFrom(period, now)
  // Another workspace's figures (opened in this window before) aren't this one's: none until this one's load.
  const mine = !!usage && usage.workspacePath === workspace?.path
  const groups = useMemo(() => (mine && usage ? usageGroups() : []), [usage, mine])
  const live = (key: string): number => [...(workspace?.projects ?? []), ...(workspace?.assistant ? [workspace.assistant] : [])].find((p) => (key === 'assistant' ? p.path === workspace?.assistant?.path : p.path === key))?.agents.filter((a) => a.live).length ?? 0
  return (
    <>
      <div className="pane-header">
        Workspace Overview
        <InfoTip text="What each project used in the period chosen in the overview. Click one for its own Overview." />
      </div>
      <div className="pane-body">
        <div className="section-header">{PERIODS.find((p) => p.value === period)?.label}</div>
        {groups.map((g) => {
          const t = sumUsage(g.items, from)
          const n = live(g.key)
          return (
            <Tooltip key={g.key} block content={`${formatTokens(totalTokens(t))} tokens · ${t.sessions} session${t.sessions === 1 ? '' : 's'}${n ? ` · ${n} running` : ''}`}>
              <div className="row" style={{ flex: 1 }} onClick={() => openProjectOverview(g.key)}>
                <Icon name={g.key === 'assistant' ? 'hubot' : 'folder'} /> <span className="label">{g.label}</span>
                {n > 0 && <span className="dot working" />}
                <span className="count">{t.sessions ? costText(t) : ''}</span>
              </div>
            </Tooltip>
          )
        })}
        {!usage && <div className="pane-empty faint">Loading…</div>}
      </div>
    </>
  )
}
