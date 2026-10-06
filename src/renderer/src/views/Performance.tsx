import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectInfo } from '@shared/types'
import { providerName } from '@shared/providers'
import { LATENCY_BOUNDS_MS, percentile, type MetricsReport, type MetricsScope, type ProviderUsageSummary, type TrendPoint } from '@shared/metrics'
import { DEFAULT_PERF_FILTERS, PERF_RANGES, WORKSPACE_OWN, byRoute, byTool, isEmpty, pageQuery, providersIn, select, totals, type PerfFilters, type PerfRole, type PerfSelection } from '@shared/metricsView'
import { compareScopeKey, compareScopeOf } from '@shared/benchmark'
import { money } from '@shared/usageTotals'
import { formatDateTime, formatWeekdayTime } from '@shared/dates'
import { call } from '../api'
import { Icon, IconButton, InfoTip, LoadFailed, StaleNote, Tooltip } from '../components/ui'
import { CellLines } from '../components/DataTable'
import { notify, set, setActivity, useStore } from '../store'
import { useScopedLoad } from '../scopedLoad'
import { cx, formatBytes, formatTokens, timeAgo } from '../util'
import { ComparePanel } from './PerformanceCompare'
import { Card } from './WorkspaceOverview'

/**
 * Performance: what Hive's own parts cost (shared/metrics.ts, recorded by main/metrics.ts), for the whole workspace (the
 * activity bar's view, with a project filter) or one project (its Performance tab, fixed to it). One page for both:
 * the scope is explicit in every query, and a project's page asks for its project only, so it can't show another
 * project's work, the Assistant's or the workspace's own. It refreshes every minute while it is shown, through Hive's
 * window (not the Agent API, so reading it adds nothing to what it shows).
 */

const REFRESH_MS = 60_000

const ms = (v: number | null, count: number): string => (v === null ? (count ? `> ${LATENCY_BOUNDS_MS.at(-1)! / 1000} s` : '—') : v >= 1000 ? `≤ ${v / 1000} s` : `≤ ${v} ms`)
const num = (n: number): string => Math.round(n).toLocaleString()
const pct = (part: number, whole: number): string => (whole ? `${((part / whole) * 100).toFixed(part && part / whole < 0.01 ? 1 : 0)}%` : '—')

const ROLE_LABEL: Record<PerfRole, string> = { all: 'Everyone', agent: 'Project agents', assistant: 'The Assistant', api: 'Scripts' }

/** The activity bar's Performance view: the workspace, with the sidebar's (or the page's) project filter. */
export function PerformanceView() {
  const workspace = useStore((s) => s.workspace)
  const filters = useStore((s) => s.perfWorkspace)
  const activity = useStore((s) => s.activity)
  const setFilters = useCallback((f: Partial<PerfFilters>) => set((s) => ({ perfWorkspace: { ...s.perfWorkspace, ...f } })), [])
  if (!workspace) return <div className="empty-state">Open a workspace to see its performance.</div>
  // A project filter that isn't one of this workspace's projects (from before a switch): all of it.
  const projects = workspace.projects.map((p) => p.name)
  const project = filters.project && filters.project !== WORKSPACE_OWN && !projects.some((n) => n.toLowerCase() === filters.project.toLowerCase()) ? '' : filters.project
  const scope: MetricsScope = project && project !== WORKSPACE_OWN ? { kind: 'project', project } : { kind: 'workspace' }
  return <PerformancePage key={workspace.path} workspacePath={workspace.path} scope={scope} filters={{ ...filters, project }} setFilters={setFilters} projects={projects} active={activity === 'performance'} />
}

/** A project's Performance tab: fixed to that project (no workspace or other-project choice). */
export function PerformanceTab({ project }: { project: ProjectInfo }) {
  const workspace = useStore((s) => s.workspace)
  const filters = useStore((s) => s.perfProjects[project.path] ?? DEFAULT_PERF_FILTERS)
  const shown = useStore((s) => s.activity === 'projects' && s.selectedProject === project.path)
  const setFilters = useCallback((f: Partial<PerfFilters>) => set((s) => ({ perfProjects: { ...s.perfProjects, [project.path]: { ...(s.perfProjects[project.path] ?? DEFAULT_PERF_FILTERS), ...f, project: '' } } })), [project.path])
  if (!workspace) return null
  return <PerformancePage key={`${workspace.path}|${project.path}`} workspacePath={workspace.path} scope={{ kind: 'project', project: project.name }} filters={{ ...filters, project: '' }} setFilters={setFilters} active={shown} />
}

/** The Performance view's sidebar: what to look at (the whole workspace, its own work, or one project). */
export function PerformancePanel() {
  const workspace = useStore((s) => s.workspace)
  const project = useStore((s) => s.perfWorkspace.project)
  const pick = (p: string): void => set((s) => ({ perfWorkspace: { ...s.perfWorkspace, project: p } }))
  const row = (value: string, icon: string, label: string, tip: string) => (
    <Tooltip key={value || 'all'} block content={tip}>
      <div className={cx('row', project.toLowerCase() === value.toLowerCase() && 'selected')} role="button" tabIndex={0} aria-pressed={project.toLowerCase() === value.toLowerCase()} onClick={() => pick(value)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick(value))}>
        <Icon name={icon} /> <span className="label">{label}</span>
      </div>
    </Tooltip>
  )
  return (
    <>
      <div className="pane-header">
        Performance
        <InfoTip text="What Hive's Agent API, its tools, the guidance it gives sessions and its skill service cost. Pick what to look at." />
      </div>
      <div className="pane-body">
        {!workspace && <div className="pane-empty">Open a workspace to see its performance.</div>}
        {workspace && (
          <>
            {row('', 'root-folder', 'Whole workspace', 'Every project and the workspace’s own work, each counted once.')}
            {row(WORKSPACE_OWN, 'hubot', 'Workspace’s own work', 'Work of no project: the Hive Assistant, scripts with the workspace token, and Hive’s shared work.')}
            <div className="section-header">Projects</div>
            {workspace.projects.map((p) => row(p.name, 'folder', p.name, `Only ${p.name}'s work. Its own Performance tab shows the same.`))}
          </>
        )}
      </div>
    </>
  )
}

function PerformancePage({ workspacePath, scope, filters, setFilters, projects, active }: { workspacePath: string; scope: MetricsScope; filters: PerfFilters; setFilters: (f: Partial<PerfFilters>) => void; projects?: string[]; active: boolean }) {
  const settings = useStore((s) => s.settings)
  const range = PERF_RANGES.find((r) => r.value === filters.range) ?? PERF_RANGES[0]
  // One result per workspace, scope, range and role: a late answer for another (a switch while it loaded) is never shown.
  // Every provider's: the provider filter narrows only its own sections, here (select()), so its choices never shrink
  // to the one picked (#270).
  const own = scope.kind === 'workspace' && filters.project === WORKSPACE_OWN
  const key = `${workspacePath}|${scope.kind === 'project' ? `project:${scope.project.toLowerCase()}` : own ? 'own' : 'workspace'}|${range.value}|${filters.role}`
  const loaded = useScopedLoad<MetricsReport>(key)
  const { load } = loaded
  const inFlight = useRef<string | null>(null)
  const refresh = useCallback(() => {
    // Coalesced: one request at a time for this scope and range. Another scope's still going doesn't hold this one up
    // (its late answer is ignored by useScopedLoad).
    if (inFlight.current === key) return
    inFlight.current = key
    load(key, () => call('metrics:query', pageQuery(scope, filters, Date.now())).finally(() => inFlight.current === key && (inFlight.current = null)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, load])
  const comparing = filters.view === 'compare'
  useEffect(() => {
    // Not while comparing: the comparison reads kept files, not the live metrics.
    if (!active || comparing) return
    refresh()
    // Every minute while it is shown (and the window is visible); not at all while hidden or closed.
    const timer = setInterval(() => document.visibilityState === 'visible' && refresh(), REFRESH_MS)
    const visible = (): void => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', visible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [active, comparing, refresh])

  const report = loaded.data
  // Everything but the provider sections is every provider's (`all`); those two follow the provider filter (`sel`).
  const all = useMemo(() => (report ? select(report, { ...filters, provider: '' }) : null), [report, filters])
  const sel = useMemo(() => (report ? select(report, filters) : null), [report, filters])
  const t = useMemo(() => (all ? totals(all) : null), [all])
  const exportReport = async (sanitize: boolean): Promise<void> => {
    try {
      // The page's own query (scope, range and Who, every provider's), so the file holds what the page shows (#270).
      const path = await call('metrics:export', pageQuery(scope, filters, Date.now()), sanitize)
      if (path) notify('success', 'Performance metrics exported', path)
    } catch (e) {
      notify('error', 'Could not export the performance metrics', String((e as Error).message ?? e))
    }
  }
  const scopeLabel = scope.kind === 'project' ? `Project: ${scope.project}` : filters.project === WORKSPACE_OWN ? 'Workspace’s own work' : 'Whole workspace'
  const isTab = !projects
  const recording = settings?.sessions.recordPerformance !== false

  return (
    <div className="scroll-page performance-page" aria-label={`Performance, ${scopeLabel}`}>
      <div className="page-narrow">
        <div className="board-header">
          <h1>Performance</h1>
          <span className="badge accent perf-scope" title="What these numbers are about">
            <Icon name={scope.kind === 'project' ? 'folder' : filters.project === WORKSPACE_OWN ? 'hubot' : 'root-folder'} /> {scopeLabel}
          </span>
          <div className="grow" />
          <div className="segmented" role="group" aria-label="Now or compare">
            {(['now', 'compare'] as const).map((v) => (
              <button key={v} className={cx(filters.view === v && 'active')} aria-pressed={filters.view === v} onClick={() => setFilters({ view: v })}>
                {v === 'now' ? 'Now' : 'Compare'}
              </button>
            ))}
          </div>
        </div>
        <p className="hint">What Hive’s Agent API, its tools, the guidance it gives sessions{isTab ? '' : ' and its skill service'} cost, next to what the providers reported. {isTab ? 'Only this project’s work: the Assistant’s, scripts’ and other projects’ aren’t in it.' : ''}</p>

        <div className="overview-head perf-controls">
          {!comparing && (
          <div className="segmented" role="group" aria-label="Time range">
            {PERF_RANGES.map((r) => (
              <button key={r.value} className={cx(filters.range === r.value && 'active')} aria-pressed={filters.range === r.value} onClick={() => setFilters({ range: r.value })}>
                {r.label}
              </button>
            ))}
          </div>
          )}
          {projects && (
            <label className="perf-filter">
              Scope
              <select className="input" value={filters.project} onChange={(e) => setFilters({ project: e.target.value })} aria-label="Scope">
                <option value="">Whole workspace</option>
                <option value={WORKSPACE_OWN}>Workspace’s own work</option>
                {projects.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!comparing && (
          <>
          <div className="grow" />
          <Tooltip content={loaded.at ? `Updated ${timeAgo(new Date(loaded.at).toISOString())}; every minute while shown.` : 'Loading…'}>
            <span>
              <IconButton icon="refresh" title="Refresh" onClick={refresh} />
            </span>
          </Tooltip>
          <Tooltip content="Save what this page shows (its scope, range and Who; every provider’s, each named in its rows) as a JSON file, with units, coverage and Hive's version. Shift+click: with project names replaced (project-1, project-2…) and no workspace path.">
            <button className="btn small subtle" onClick={(e) => void exportReport(e.shiftKey)} disabled={!report}>
              <Icon name="desktop-download" /> Export
            </button>
          </Tooltip>
          </>
          )}
        </div>
        {comparing && <p className="hint perf-compare-hint">Compare puts two kept files side by side: each keeps the range and filters it was made with (shown below). The range and Who of Now only shape what <strong>Keep current view</strong> saves (every provider’s).</p>}

        {comparing && (
          <ComparePanel
            key={`${workspacePath}|${compareScopeKey(compareScopeOf(scope, own))}`}
            workspacePath={workspacePath}
            scope={compareScopeOf(scope, own)}
            query={() => pageQuery(scope, filters, Date.now())}
            keeps={`${range.label}, ${ROLE_LABEL[filters.role].toLowerCase()}, every provider`}
          />
        )}
        {filters.view !== 'compare' && !recording && (
          <div className="banner warn perf-banner">
            <Icon name="debug-pause" /> Hive isn’t recording performance metrics, so nothing new is added (what was recorded is still shown).{' '}
            <a onClick={() => (set({ settingsSection: 'sessions', settingsQuery: '' }), setActivity('settings'))}>Settings → Sessions</a>
          </div>
        )}
        {filters.view !== 'compare' && loaded.error && report && <StaleNote what="the performance metrics" error={loaded.error} at={loaded.at} onRetry={refresh} />}
        {filters.view !== 'compare' && !report && loaded.error && <LoadFailed what="the performance metrics" error={loaded.error} onRetry={refresh} />}
        {filters.view !== 'compare' && !report && !loaded.error && (
          <div className="empty-state">
            <Icon name="loading" spin /> Loading…
          </div>
        )}
        {filters.view !== 'compare' && report && all && sel && t && (
          <>
            <Coverage report={report} />
            {/* Who did the work: everything in this group follows it, and nothing outside does (#270). */}
            <section className="perf-group" aria-label="Filtered by who did the work">
              <div className="perf-group-head">
                <label className="perf-filter">
                  Who
                  <select className="input" value={filters.role} onChange={(e) => setFilters({ role: e.target.value as PerfRole })} aria-label="Who did the work">
                    {(isTab ? (['all', 'agent'] as PerfRole[]) : (['all', 'agent', 'assistant', 'api'] as PerfRole[])).map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="faint">{isTab || !report.skills ? 'Everything below follows it.' : 'Everything in this box follows it; the skill service below it is the whole workspace’s.'}</span>
              </div>
            {isEmpty(all) ? (
              <>
                <div className="empty-state perf-empty">
                  <Icon name="pulse" />
                  Nothing recorded {filters.role !== 'all' ? 'for this filter ' : ''}in the last {range.label}.
                </div>
                {/* Nothing to show isn't the same as nothing there: say when session history couldn't be read. */}
                {report.providersUnreadable ? <ProvidersTable sel={all} note={report.providersNote} unreadable={report.providersUnreadable} hosts={report.providersHosts} /> : null}
              </>
            ) : (
              <>
                <div className="cards">
                  <Card
                    accent
                    title="API requests"
                    value={num(t.requests)}
                    sub={`${report.coverage.observedMs >= 60_000 ? `${num(t.requests / (report.coverage.observedMs / 3_600_000))} an hour recorded · ` : ''}${pct(t.errors, t.requests)} failed · ${pct(t.cancelled, t.requests)} cancelled`}
                    tip="Agent API requests (agents’ tools, the Assistant, scripts). An hour: over the time Hive was recording, not the whole range. Failed: refused, client or server errors. Cancelled: the client went away before the reply."
                  />
                  <Card title="Latency" value={`p50 ${ms(t.p50, t.requests)}`} sub={`p95 ${ms(t.p95, t.requests)}`} tip="Request time in Hive, from the request to its reply, on a monotonic clock. Percentiles are the bounds of the histogram's buckets." />
                  <Card title="Data" value={formatBytes(t.responseBytes)} sub={`${formatBytes(t.requestBytes)} received`} tip="Bodies only, in UTF-8 bytes: what Hive's API sent and received. Not provider traffic: Hive isn't between the CLIs and their providers." />
                  <Card title="Tool replies" value={num(t.toolChars)} sub={`characters in ${num(t.toolCalls)} call${t.toolCalls === 1 ? '' : 's'} · ${formatBytes(t.toolBytes)}`} tip="The text Hive's tools gave the models (what goes into their context), exactly: characters (UTF-16 code units) and UTF-8 bytes. Not tokens." />
                  <Card
                    title="Guidance per launch"
                    value={formatBytes(t.avgGuidanceBytes + t.avgCustomBytes + t.avgRoleBytes + t.avgPersonaBytes + t.avgSkillCatalogBytes)}
                    sub={`${num(t.launches)} launch${t.launches === 1 ? '' : 'es'} · core ${formatBytes(t.avgGuidanceBytes)} · catalog ${formatBytes(t.avgSkillCatalogBytes)}`}
                    tip="What Hive gave each session at launch, on average: its session contract (core), what it adds for the project, the Assistant's role and persona, and its skills' catalog (names and descriptions). Skill bodies are separate: a model reads one only when it uses it."
                  />
                </div>

                {report.trend && report.trend.length > 0 && <Trend points={report.trend} step={report.trendStep ?? 'hour'} />}

                <ToolsTable sel={all} />
                <RoutesTable sel={all} />
                {(all.guidance.length > 0 || all.providers.length > 0 || !!report.providersNote || !!report.providersUnreadable || !!filters.provider) && (
                  <ByProvider report={report} sel={sel} rangeLabel={range.label} provider={filters.provider} setProvider={(provider) => setFilters({ provider })} />
                )}
                {/* Hive's tool list isn't per provider: outside the provider's group. */}
                <ToolList sel={all} />
              </>
            )}
            </section>
            {!isTab && report.skills && <SkillService report={report} filtered={filters.role !== 'all'} />}
            {!isTab && report.app && <AppWide report={report} />}
            <details className="perf-limits">
              <summary>What isn’t measured</summary>
              <ul>
                {report.notMeasured.map((m) => (
                  <li key={m}>{m}</li>
                ))}
                <li>This page reads through Hive’s window, not the Agent API: refreshing it adds nothing to these numbers.</li>
              </ul>
            </details>
          </>
        )}
      </div>
    </div>
  )
}

function Coverage({ report }: { report: MetricsReport }) {
  const when = (iso: string): string => formatDateTime(iso)
  const c = report.coverage
  const share = c.rangeMs ? c.observedMs / c.rangeMs : 0
  return (
    <div className="hint perf-coverage">
      <p>
        {when(report.from)} to {when(report.to)} · kept 30 days, hourly for the last 7.{' '}
        {!c.observedMs ? (
          <span className="warn-text">Hive wasn’t recording this workspace in this range, so there is nothing to show (no data, not zero).</span>
        ) : share < 0.99 ? (
          <span className={cx(share < 0.5 && 'warn-text')}>
            Recorded for {duration(c.observedMs)} of it ({pct(c.observedMs, c.rangeMs)}){Date.parse(c.observedSince!) - Date.parse(report.from) > 60_000 ? `, since ${when(c.observedSince!)}` : ''}
            {c.stretches > 1 ? `, in ${c.stretches} stretches` : ''}: before that and in the gaps (Hive closed, recording off, a reset) nothing was seen.
          </span>
        ) : (
          'Recorded throughout.'
        )}
        {report.dropped > 0 && (
          <>
            {' '}
            <span className="warn-text">{num(report.dropped)} measurement{report.dropped === 1 ? '' : 's'} not kept (a limit was full), so totals may be low.</span>
          </>
        )}
        {report.scope.kind === 'project' && report.lossesUnattributed && <span className="warn-text"> Some measurements couldn’t be attributed to a project: this project’s may be more than shown.</span>}
        {c.evictedThrough && <span className="warn-text"> History up to {when(c.evictedThrough)} was removed to keep the metrics file under its size limit: nothing before then is available.</span>}
      </p>
      {report.filters.notFiltered.length > 0 && (
        <ul className="perf-notes">
          {report.filters.notFiltered.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** A length of time, roughly: "3 h 10 min", "2 days 4 h". */
function duration(msValue: number): string {
  const min = Math.round(msValue / 60_000)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h} h${min % 60 ? ` ${min % 60} min` : ''}`
  return `${Math.floor(h / 24)} days${h % 24 ? ` ${h % 24} h` : ''}`
}

/** Requests per hour or day, failures in another colour; tool calls in the tooltip. */
function Trend({ points, step }: { points: TrendPoint[]; step: 'hour' | 'day' }) {
  const max = Math.max(1, ...points.map((p) => p.requests))
  const slotMs = step === 'hour' ? 3_600_000 : 86_400_000
  const label = (iso: string): string => (step === 'hour' ? formatWeekdayTime(iso) : new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }))
  return (
    <div className="daily-chart perf-trend">
      <h2 className="section">API requests by {step}</h2>
      <div className="daily-bars" role="img" aria-label={`API requests by ${step}, failures in a second colour`}>
        {points.map((p) => (
          <Tooltip
            key={p.start}
            content={
              <div className="stack-tip">
                <strong>{label(p.start)}</strong>:{' '}
                {!p.observedMs && !p.requests ? (
                  'not recorded (Hive closed, recording off, or before a reset)'
                ) : (
                  <>
                    {num(p.requests)} request{p.requests === 1 ? '' : 's'}
                    {p.failed ? `, ${num(p.failed)} failed${p.cancelled ? ` (${num(p.cancelled)} cancelled)` : ''}` : ''} · {num(p.toolCalls)} tool call{p.toolCalls === 1 ? '' : 's'} ({num(p.toolChars)} characters) · {num(p.launches)} launch{p.launches === 1 ? '' : 'es'}
                    {p.observedMs < slotMs - 60_000 ? ` · recorded for ${duration(p.observedMs)} of it` : ''}
                  </>
                )}
              </div>
            }
          >
            <div className={cx('daily-col', !p.observedMs && !p.requests && 'unobserved', p.observedMs > 0 && p.observedMs < slotMs - 60_000 && 'partial')}>
              <div className="stack-bar" style={{ height: `${p.requests ? Math.max(3, (p.requests / max) * 100) : 0}%` }}>
                {p.requests - p.failed > 0 && <div className="stack-part" style={{ flexGrow: p.requests - p.failed, background: 'var(--series-1)' }} />}
                {p.failed > 0 && <div className="stack-part" style={{ flexGrow: p.failed, background: 'var(--error)' }} />}
              </div>
            </div>
          </Tooltip>
        ))}
      </div>
      <div className="daily-axis">
        <span>{label(points[0].start)}</span>
        <span>{label(points[points.length - 1].start)}</span>
      </div>
      <div className="stack-legend">
        <span>
          <span className="swatch" style={{ background: 'var(--series-1)' }} /> Succeeded
        </span>
        <span>
          <span className="swatch" style={{ background: 'var(--error)' }} /> Failed
        </span>
        <span>
          <span className="swatch unobserved" /> Not recorded
        </span>
      </div>
    </div>
  )
}

function ToolsTable({ sel }: { sel: PerfSelection }) {
  const rows = byTool(sel.mcp)
  const [all, setAll] = useState(false)
  if (!rows.length) return null
  const shown = all ? rows : rows.slice(0, 12)
  return (
    <>
      <h2 className="section">
        Hive tools <InfoTip text="Each hive tool's replies as the models got them: characters and UTF-8 bytes, exactly. Detail: calls that asked for the full form. Sorted by characters, what costs a context most." />
      </h2>
      <div className="table-wrap">
        <table className="table">
        <thead>
          <tr>
            <th>Tool</th>
            <th className="num">Calls</th>
            <th className="num">Characters</th>
            <th className="num">Per call</th>
            <th className="num">Detail</th>
            <th className="num">Errors</th>
            <th className="num">p95</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.tool}>
              <td>{r.tool}</td>
              <td className="num">{num(r.calls)}</td>
              <td className="num">{num(r.chars)}</td>
              <td className="num">{num(r.avgChars)}</td>
              <td className="num">{r.detail ? num(r.detail) : '—'}</td>
              <td className="num">{r.errors ? num(r.errors) : '—'}</td>
              <td className="num">{ms(r.p95, r.calls)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {rows.length > 12 && (
        <button className="btn small subtle" onClick={() => setAll(!all)}>
          {all ? 'Fewer' : `All ${rows.length}`}
        </button>
      )}
    </>
  )
}

function RoutesTable({ sel }: { sel: PerfSelection }) {
  const rows = byRoute(sel.api)
  const [all, setAll] = useState(false)
  if (!rows.length) return null
  const shown = all ? rows : rows.slice(0, 12)
  return (
    <>
      <h2 className="section">
        Agent API <InfoTip text="Requests by route (its template, never the path asked for). The hive tools call these too; a tool call and its request are the same work, so don't add them up." />
      </h2>
      <div className="table-wrap">
        <table className="table">
        <thead>
          <tr>
            <th>Route</th>
            <th className="num">Requests</th>
            <th className="num">Failed</th>
            <th className="num">Cancelled</th>
            <th className="num">p50</th>
            <th className="num">p95</th>
            <th className="num">Sent</th>
            <th className="num">Received</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.key}>
              <td>
                <span className="faint">{r.method}</span> {r.route}
              </td>
              <td className="num">{num(r.requests)}</td>
              <td className="num">{r.failed - r.cancelled ? `${num(r.failed - r.cancelled)}\u00a0(${pct(r.failed - r.cancelled, r.requests)})` : '—'}</td>
              <td className="num">{r.cancelled ? `${num(r.cancelled)}\u00a0(${pct(r.cancelled, r.requests)})` : '—'}</td>
              <td className="num">{ms(r.p50, r.requests)}</td>
              <td className="num">{ms(r.p95, r.requests)}</td>
              <td className="num">{formatBytes(r.responseBytes)}</td>
              <td className="num">{formatBytes(r.requestBytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {rows.length > 12 && (
        <button className="btn small subtle" onClick={() => setAll(!all)}>
          {all ? 'Fewer' : `All ${rows.length}`}
        </button>
      )}
    </>
  )
}

/**
 * The sections the provider filter changes (launches' guidance and the providers' usage), under it; its choices are
 * every provider with data in the range and scope, and the current one (#270).
 */
function ByProvider({ report, sel, rangeLabel, provider, setProvider }: { report: MetricsReport; sel: PerfSelection; rangeLabel: string; provider: string; setProvider: (p: string) => void }) {
  const none = !sel.guidance.length && !sel.providers.length
  return (
    <section className="perf-group perf-by-provider" aria-label="Filtered by provider">
      <div className="perf-group-head">
        <label className="perf-filter">
          Provider
          <select className="input" value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Provider">
            <option value="">All providers</option>
            {providersIn(report, provider).map((p) => (
              <option key={p} value={p}>
                {providerName(p)}
              </option>
            ))}
          </select>
        </label>
        <span className="faint">Launches and the providers’ usage: the only parts recorded per provider.</span>
      </div>
      {provider && none && !report.providersUnreadable ? (
        <p className="hint perf-provider-empty">
          Nothing from {providerName(provider)} in the last {rangeLabel}{report.filters.role ? ' for this filter' : ''}.
        </p>
      ) : (
        <>
          <GuidanceTable sel={sel} unmeasured={totals(sel).skillsUnmeasured} />
          <ProvidersTable sel={sel} note={report.providersNote} unreadable={report.providersUnreadable} hosts={report.providersHosts} />
        </>
      )}
    </section>
  )
}

/** The hive tools' list as each session got it: every provider's (not recorded per provider). */
function ToolList({ sel }: { sel: PerfSelection }) {
  if (!sel.catalog.length) return null
  return <p className="hint">The hive tools’ list, as each session got it: {sel.catalog.map((c) => `${c.role === 'assistant' ? 'Assistant' : 'agents'} ${num(c.starts ? c.tools / c.starts : 0)} tools, ${formatBytes(c.starts ? c.toolsBytes / c.starts : 0)} a start`).join('; ')}.</p>
}

function GuidanceTable({ sel, unmeasured }: { sel: PerfSelection; unmeasured: number }) {
  if (!sel.guidance.length) return null
  const per = (n: number, launches: number): string => (launches && n ? formatBytes(n / launches) : '—')
  return (
    <>
      <h2 className="section">
        Guidance at launch{' '}
        <InfoTip text="What Hive gave sessions when they started, per launch on average, exactly. Core: Hive's session contract, the same for every session of a role. Project: what Hive adds for the project (the latest handover's pointer). Role and persona: the Assistant's. Catalog: the skills' names and descriptions (what a CLI lists); on disk: the delivered copies' bytes. A model reads a skill's body only when it uses it, which isn't observable." />
      </h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Who</th>
              <th className="num">Launches</th>
              <th className="num">Core</th>
              <th className="num">Project</th>
              <th className="num">Role</th>
              <th className="num">Persona</th>
              <th className="num">Skills</th>
              <th className="num">Catalog</th>
              <th className="num">On disk</th>
              <th className="num">Not given</th>
            </tr>
          </thead>
          <tbody>
            {sel.guidance.map((g) => (
              <tr key={`${g.provider} ${g.role}`}>
                <td className="nowrap">{providerName(g.provider)}</td>
                <td className="nowrap">{g.role === 'assistant' ? 'Assistant' : 'Agents'}</td>
                <td className="num">{num(g.launches)}</td>
                <td className="num">{per(g.guidanceBytes, g.launches)}</td>
                <td className="num">{per(g.customBytes, g.launches)}</td>
                <td className="num">{per(g.roleBytes, g.launches)}</td>
                <td className="num">{per(g.personaBytes, g.launches)}</td>
                <td className="num">{g.launches ? (g.skills / g.launches).toFixed(1) : '—'}</td>
                <td className="num">{per(g.skillCatalogBytes, g.launches)}</td>
                <td className="num">{per(g.skillBytes, g.launches)}</td>
                <td className="num">
                  {g.skillsNotDelivered || g.skillsUnmeasured ? (
                    <Tooltip content={`${g.skillsNotDelivered} asked for but not delivered; ${g.skillsUnmeasured} delivered but couldn't be measured (left out of the sizes, not counted as zero).`}>
                      <span>
                        {num(g.skillsNotDelivered)}
                        {g.skillsUnmeasured ? ` + ${num(g.skillsUnmeasured)} ?` : ''}
                      </span>
                    </Tooltip>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {unmeasured > 0 && <p className="hint">Skills marked ? couldn’t be measured.</p>}
    </>
  )
}

function ProvidersTable({ sel, note, unreadable, hosts }: { sel: PerfSelection; note?: string; unreadable?: number; hosts?: number }) {
  // Session history that couldn't be read: the totals are partial, or unknown if none could be (never shown as complete).
  const partial = unreadable ? (
    <p className="warn-text perf-partial">
      {unreadable === hosts
        ? 'Provider usage is unknown: the session history couldn’t be read.'
        : `The session history of ${unreadable} of ${hosts} ${hosts === 1 ? 'place' : 'places'} (projects, the Assistant) couldn’t be read, so these totals are partial.`}
    </p>
  ) : null
  if (!sel.providers.length)
    return note || partial ? (
      <>
        <h2 className="section">Provider usage</h2>
        {partial}
        {note && <p className="hint">{note}</p>}
      </>
    ) : null
  // Totals of sessions none of which reported usage are unknown, not zero.
  const tok = (p: ProviderUsageSummary, n: number): string => (p.unknown === p.sessions ? 'unknown' : formatTokens(n))
  return (
    <>
      <h2 className="section">
        Provider usage{' '}
        <InfoTip text="What the providers reported for the sessions active in the range, by whose sessions they were: each session's whole usage (so a long session counts in full). Reasoning is part of output, shown separately, not added. Context is a snapshot of each session's last request (average and largest), not a sum. Cost is API-equivalent (≈ estimated by Hive where the provider didn't report it); a subscription isn't billed per this. Sessions that reported nothing are unknown, left out of the totals." />
      </h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Who</th>
              <th className="num">Sessions</th>
              <th className="num">Input</th>
              <th className="num">Cache read</th>
              <th className="num">Cache write</th>
              <th className="num">Output</th>
              <th className="num">of it reasoning</th>
              <th className="num">Requests</th>
              <th className="num">Context</th>
              <th className="num">Compactions</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {sel.providers.map((p) => (
              <tr key={`${p.provider} ${p.role}`}>
                <td className="nowrap">{providerName(p.provider)}</td>
                <td className="nowrap">{p.role === 'assistant' ? 'Assistant' : 'Agents'}</td>
                <td className="num">
                  {/* Deliberate lines (#241): the count, then who is running and what is unknown. */}
                  <CellLines
                    main={num(p.sessions)}
                    sub={[p.running ? `${p.running} running` : '', p.unknown ? `${p.unknown} unknown` : ''].filter(Boolean).join(' · ')}
                    subWarn={!!p.unknown}
                  />
                </td>
                <td className="num">{tok(p, p.inputTokens)}</td>
                <td className="num">{tok(p, p.cacheReadTokens)}</td>
                <td className="num">{tok(p, p.cacheWriteTokens)}</td>
                <td className="num">{tok(p, p.outputTokens)}</td>
                <td className="num">{p.reasoningTokens ? formatTokens(p.reasoningTokens) : '—'}</td>
                <td className="num">{p.unknown === p.sessions ? 'unknown' : num(p.requests)}</td>
                <td className="num">
                  {p.contextSessions ? (
                    <Tooltip content={`Last request's context, over ${p.contextSessions} session${p.contextSessions === 1 ? '' : 's'}: average ${formatTokens(p.contextAvgTokens)}, largest ${formatTokens(p.contextMaxTokens)}${p.contextWindow ? ` of a ${formatTokens(p.contextWindow)} window` : ''}.`}>
                      <span>
                        <CellLines main={`${formatTokens(p.contextAvgTokens)} avg`} sub={`${formatTokens(p.contextMaxTokens)} max${p.contextWindow ? ` of ${formatTokens(p.contextWindow)}` : ''}`} />
                      </span>
                    </Tooltip>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="num">{p.unknown === p.sessions ? 'unknown' : num(p.compactions)}</td>
                <td className="num">
                  {p.costUnknown === p.sessions ? (
                    'unknown'
                  ) : (
                    // "≈ $25.87" as one unbreakable value; the unknown sessions under it (#241).
                    <CellLines main={`${p.costEstimated ? '≈\u00a0' : ''}${money(p.costUsd)}`} sub={p.costUnknown ? `+ ${p.costUnknown} unknown` : ''} subWarn />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {partial}
      {note && <p className="hint">{note}</p>}
    </>
  )
}

function SkillService({ report, filtered }: { report: MetricsReport; filtered: boolean }) {
  const s = report.skills!
  const lookups = s.hits + s.misses
  return (
    <>
      <h2 className="section">
        Skill service <InfoTip text="Hive's own disk and cache work to know its skills (the status, launches, the Skills view). Shared by the whole workspace, so it is in no project's numbers. A saving in guidance isn't the same as a saving here." />
        {filtered && <span className="faint perf-unfiltered"> all of it: not per role or provider</span>}
      </h2>
      <div className="cards">
        <Card title="Scans" value={num(s.scans.count)} sub={`p95 ${ms(percentile(s.scans, 0.95), s.scans.count)} · ${num(s.sharedScans)} shared`} />
        <Card title="Cache" value={pct(s.hits, lookups)} sub={`${num(s.hits)} hits · ${num(s.misses)} misses · ${num(s.invalidations)} changed`} tip="Hits: a skill unchanged since it was last read. Changed: read again because its files changed." />
        <Card title="Read" value={formatBytes(s.bytes)} sub={`${num(s.files)} files · ${formatBytes(s.headerBytes)} headers · ${num(s.entries)} entries`} />
        <Card title="Too big" value={num(s.tooLarge)} sub="over the limits (64 MB, 2000 files, 12 deep)" />
      </div>
    </>
  )
}

function AppWide({ report }: { report: MetricsReport }) {
  const a = report.app!
  return (
    <p className="hint">
      Hive-wide, not this workspace’s: {num(a.inFlight)} request{a.inFlight === 1 ? '' : 's'} in flight · {num(a.unauthenticated)} refused before Hive knew whose · event streams: {num(a.streams.connections)} connection{a.streams.connections === 1 ? '' : 's'}, {num(a.streams.events)} events, {formatBytes(a.streams.bytes)}.
    </p>
  )
}
