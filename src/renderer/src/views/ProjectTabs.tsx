import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CardChip } from '../components/CardChip'
import { KeybindingsEditor } from '../components/Keybindings'
import type { CompactionEvent, GitDiff, GitStatus, McpServerInfo, MemorySource, PlanLimit, ProjectConfig, ProjectInfo, ProviderId, SessionListItem, SessionUsage, SkillInfo } from '@shared/types'
import { unpricedModel, unpricedText } from '@shared/prices'
import { formatDateTime } from '@shared/dates'
import { PERIODS, activeIn, costText, dailyTotals, money, periodFrom, sumUsage, type DayTotal, type Period, type Totals } from '@shared/usageTotals'
import { FILE_LOCK_MODES, MAX_AGENTS, contextPercent, turnPushedCompaction, effectiveModelLabel, mergeBlocked, modelLabel } from '@shared/defaults'
import { PROVIDERS, contextLines, isProviderEnabled, modeOption, offeredModes, permissionLabel, projectDefaultProvider, projectProviderConfig, providerDescriptor, providerName, providerSettings } from '@shared/providers'
import { EffortPicker, ModelPicker } from '../components/ModelPicker'
import { effortText, runsAsName } from '@shared/models'
import { PROJECT_SETTINGS_SECTIONS, settingEntry } from '@shared/settingsCatalog'
import { NumberField } from '../components/NumberField'
import { StorageView } from '../components/Storage'
import { TaskStrip } from '../components/Board'
import { ProviderIcon } from '../components/ProviderIcon'
import { confirmDangerousMode } from '../components/PermissionMode'
import * as actions from '../actions'
import { call, errorMessage } from '../api'
import { DocEditor } from '../components/DocEditor'
import { DiffView } from '../components/Editors'
import { PaneResizer, usePaneSize } from '../components/Resizer'
import { DataTable, useDateColumns, type DataColumn } from '../components/DataTable'
import { Icon, IconButton, InfoTip, LoadFailed, StaleNote, statusText, StatusDot, Switch, Tooltip } from '../components/ui'
import { languageFor } from '../monacoLang'
import { useScopedLoad } from '../scopedLoad'
import { addSkill, deleteSkill, editInWorkspace, otherLocal, SKILL_LEVEL_TIP, SkillDetail, SkillRow } from '../components/Skills'
import { RootSelector } from './FilesTab'
import { agentProviderOf, confirm, notify, openInSessionsTab, set, setActivity, showView, useDateStyle, useFocusedAgent, useStore } from '../store'
import { rememberProjectPref } from '../projectPrefs'
import { cx, formatDuration, formatNumber, formatTokens, resetsIn, timeAgo } from '../util'
import { useLiveUsage, useNow } from '../usage'

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

/** Live updates of the session list come at most this often (each reads the project's session files). */
const LIVE_REFRESH_MS = 15_000

/**
 * The project's sessions with their usage, for the Overview and the Sessions tab. Updates follow
 * Settings → Sessions → Overview updates: live (as sessions change, at most every 15 s), every minute, or
 * only on reload(). Only while a view using it is shown.
 */
const NO_SESSIONS: SessionListItem[] = []

export function useSessions(project: ProjectInfo) {
  const mode = useStore((s) => s.settings?.sessions.overviewRefresh ?? 'live')
  const usageVersion = useStore((s) => s.usageVersion[project.path] ?? 0)
  // A project's tabs stay mounted while another view (Notes, Settings…) is shown: they don't update then.
  const shown = useStore((s) => s.activity === 'projects' || s.workspace?.assistant?.path === project.path)
  // This project's sessions, and deleted sessions' usage (totals count it, lists don't show it). A failed load: views
  // say so (with this project's sessions from before, if any), not "no sessions".
  const sessions = useScopedLoad<{ list: SessionListItem[]; kept: SessionListItem[] }>(project.path)
  const last = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { load: loadScoped } = sessions
  const load = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    last.current = Date.now()
    const path = project.path
    // Deleted sessions' usage only adds to the totals: without it they are a little low, which beats no list.
    loadScoped(path, () => Promise.all([call('session:list', path), call('session:keptUsage', path).catch(() => [])]).then(([list, kept]) => ({ list, kept })))
  }, [project.path, loadScoped])
  useEffect(() => {
    load()
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [load])
  // Live: a change (usage, or an agent starting or stopping) reloads, at most every LIVE_REFRESH_MS.
  // A card moving into an agent's Doing too: its session records it ("Worked on #5").
  const doingKey = useStore((s) => s.tasks.filter((c) => c.column === 'doing' && c.agent && c.project.toLowerCase() === project.name.toLowerCase()).map((c) => `${c.number}:${c.agent}`).join(','))
  const liveKey = `${usageVersion}|${doingKey}|${project.agents.map((a) => `${a.live?.sessionId ?? ''}:${a.live?.status ?? ''}:${a.live?.sessionName ?? ''}`).join(',')}`
  useEffect(() => {
    if (mode !== 'live' || !last.current || !shown) return
    const wait = last.current + LIVE_REFRESH_MS - Date.now()
    if (wait <= 0) load()
    else if (!timer.current) timer.current = setTimeout(load, wait)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey, mode, shown])
  useEffect(() => {
    if (mode !== 'minute' || !shown) return
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [mode, load, shown])
  return { items: sessions.data?.list ?? null, kept: sessions.data?.kept ?? NO_SESSIONS, reload: load, loadedAt: sessions.at, error: sessions.error }
}


function Card({ title, value, sub, tip, accent, children }: { title: string; value: React.ReactNode; sub?: React.ReactNode; tip?: React.ReactNode; accent?: boolean; children?: React.ReactNode }) {
  return (
    <div className={cx('card', accent && 'accent')}>
      <h3>
        {title} {tip && <InfoTip text={tip} />}
      </h3>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
      {children}
    </div>
  )
}

export { PERIODS, activeIn, costText, dailyTotals, money, periodFrom, sumUsage, type Period, type Totals } from '@shared/usageTotals'

/** A small bar per day (tokens), for the 7- and 30-day periods; hover a day for its numbers. */
export function DailyChart({ days }: { days: DayTotal[] }) {
  const max = Math.max(1, ...days.map((d) => d.tokens))
  const label = (day: string): string => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  return (
    <div className="daily-chart" role="img" aria-label="Tokens per day">
      <div className="daily-bars">
        {days.map((d) => (
          <Tooltip key={d.day} content={`${label(d.day)}: ${formatTokens(d.tokens)} tokens · ${costText(d)} · ${d.prompts} prompt${d.prompts === 1 ? '' : 's'}`}>
            <div className="daily-col">
              <div className="daily-bar" style={{ height: `${d.tokens ? Math.max(3, (d.tokens / max) * 100) : 0}%` }} />
            </div>
          </Tooltip>
        ))}
      </div>
      <div className="daily-axis">
        <span>{label(days[0].day)}</span>
        <span>Today</span>
      </div>
    </div>
  )
}

/** The agent a session belongs to: its worktree's agent, else the agent recorded for it ('?' when none). */
function sessionAgent(project: ProjectInfo, s: SessionListItem): string {
  if (s.cwd && s.cwd.toLowerCase() !== project.path.toLowerCase()) return project.agents.find((a) => a.worktree?.path.toLowerCase() === s.cwd!.toLowerCase())?.id ?? '?'
  return s.agentId ?? '?'
}

/** The project's usage for a period: one summary, what runs now, each provider, each agent, then one agent's session. */
export function OverviewTab({ project }: { project: ProjectInfo }) {
  const { items, kept, reload, loadedAt, error } = useSessions(project)
  const settings = useStore((s) => s.settings)
  const [period, setPeriod] = useState<Period>('all')
  const now = useNow(60000)
  if (!items) return error ? <LoadFailed what="the sessions" error={error} onRetry={reload} /> : <div className="empty-state"><Icon name="loading" spin />Loading…</div>

  const from = periodFrom(period, now)
  const inPeriod = activeIn([...items.filter((i) => i.source === 'hive'), ...kept], from)
  const total = sumUsage(inPeriod, from)
  const running = project.agents.filter((a) => a.live && !a.live.settingUp)
  const used = new Set([...inPeriod.map((i) => i.provider), ...running.map((a) => a.live!.provider)])
  const providers = PROVIDERS.filter((p) => used.has(p.id) || isProviderEnabled(settings, p.id))
  const tokens = (t: Totals): number => t.input + t.cached + t.cacheWrite + t.output
  const costTip = 'What this work would have cost at API prices: reported by the provider where it does (Claude Code), else estimated by Hive from token counts and the prices in Settings → the provider. On a subscription you are not charged this; it shows how heavy the work was.'

  return (
    <div className="scroll-page overview-page">
      <div className="page-narrow">
        <TaskStrip project={project} />
        <div className="overview-head">
          <h2 className="section">Project summary</h2>
          <Tooltip content={`Updated ${timeAgo(new Date(loadedAt).toISOString())}. How often it updates: Settings → Sessions → Overview updates.`}>
            <span>
              <IconButton icon="refresh" title="Refresh" onClick={reload} />
            </span>
          </Tooltip>
          <div className="grow" />
          <div className="segmented" role="group" aria-label="Period">
            {PERIODS.map((p) => (
              <button key={p.value} className={cx(period === p.value && 'active')} onClick={() => setPeriod(p.value)}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
        {error && <StaleNote what="the sessions" error={error} at={loadedAt} onRetry={reload} />}
        <p className="hint">What was used in the period across every provider, by calendar day: a session that ran over several days counts only its part in the period.</p>
        <div className="cards">
          <Card accent title="Tokens" value={formatTokens(tokens(total))} sub={`${formatTokens(total.input + total.cacheWrite)} in · ${formatTokens(total.cached)} cached · ${formatTokens(total.output)} out`} tip="All tokens: new input, cache writes, input read from cache, and output." />
          <Card
            title="API-equivalent cost"
            value={costText(total)}
            sub={total.unpriced ? `${total.unpriced} session${total.unpriced === 1 ? '' : 's'} without a price` : total.estimated ? 'partly estimated' : 'as reported'}
            tip={costTip}
          />
          <Card title="Sessions" value={total.sessions} sub={`${running.length} running now`} />
          <Card title="Prompts" value={formatNumber(total.prompts)} sub={`${total.compactions} compaction${total.compactions === 1 ? '' : 's'}`} />
        </div>
        {from && period !== 'today' && <DailyChart days={dailyTotals(inPeriod, from, now)} />}

        {running.length > 0 && (
          <>
            <h2 className="section">Running now</h2>
            <div className="running-list">
              {running.map((a) => (
                <RunningAgent key={a.id} project={project} a={a} />
              ))}
            </div>
          </>
        )}

        {providers.map((p) => {
          const list = inPeriod.filter((i) => i.provider === p.id)
          const t = sumUsage(list, from)
          return (
            <div key={p.id}>
              <h2 className="section">
                <ProviderIcon provider={p.id} /> {p.name}
                {!isProviderEnabled(settings, p.id) && <span className="muted" style={{ fontWeight: 400 }}> — turned off</span>}
              </h2>
              <div className="cards">
                <Card title="Tokens" value={formatTokens(tokens(t))} sub={`${formatTokens(t.output)} output`} />
                <Card title="API-equivalent cost" value={costText(t)} sub={t.unpriced ? `${t.unpriced} without a price` : !t.estimated ? 'as reported' : p.capabilities.reportsCost ? 'partly estimated' : 'estimated'} tip={costTip} />
                <Card title="Sessions" value={t.sessions} sub={`${formatNumber(t.prompts)} prompts`} />
              </div>
              <PlanLimits provider={p.id} />
            </div>
          )
        })}

        {project.agents.length > 1 && (
          <>
            <h2 className="section">By agent</h2>
            <DataTable
              id="overview-agents"
              rows={project.agents.map((a) => ({ id: a.id, name: a.name, provider: agentProviderOf(project, a), t: sumUsage(inPeriod.filter((i) => sessionAgent(project, i) === a.id), from) }))}
              columns={AGENT_COLUMNS}
              rowKey={(r) => r.id}
              empty="No agents."
            />
          </>
        )}

        <SessionDetails project={project} items={items} />
      </div>
    </div>
  )
}

/** A row of the Overview's table by agent: what it used in the period. */
interface AgentRow {
  id: string
  name: string
  provider: ProviderId
  t: Totals
}
const allTokens = (t: Totals): number => t.input + t.cached + t.cacheWrite + t.output
const AGENT_COLUMNS: DataColumn<AgentRow>[] = [
  { key: 'agent', header: 'Agent', cell: (r) => r.name, sortValue: (r) => r.name },
  {
    key: 'provider',
    header: 'Provider',
    className: 'nowrap',
    cell: (r) => (
      <>
        <ProviderIcon provider={r.provider} /> {providerName(r.provider)}
      </>
    ),
    sortValue: (r) => providerName(r.provider)
  },
  { key: 'sessions', header: 'Sessions', num: true, descFirst: true, cell: (r) => r.t.sessions, sortValue: (r) => r.t.sessions },
  { key: 'tokens', header: 'Tokens', num: true, descFirst: true, cell: (r) => formatTokens(allTokens(r.t)), sortValue: (r) => allTokens(r.t) },
  { key: 'cost', header: 'Cost', num: true, descFirst: true, cell: (r) => (r.t.sessions ? costText(r.t) : '—'), sortValue: (r) => (r.t.sessions ? r.t.cost : null) }
]

/** One running agent: provider, model, mode, status, context used and cost so far. `onOpen` makes it a link. */
export function RunningAgent({ project, a, label, onOpen }: { project: ProjectInfo; a: ProjectInfo['agents'][number]; label?: string; onOpen?: () => void }) {
  const live = a.live!
  const usage = useLiveUsage(project, a.id)
  const settings = useStore((s) => s.settings)
  const window = usage?.contextWindow ?? null
  const ctx = usage?.contextTokens ?? 0
  const pct = contextPercent(ctx, window)
  const cost = live.costUsd ?? usage?.costUsd ?? null
  const estimated = live.costUsd !== undefined ? !!live.costEstimated : !!usage?.costEstimated
  return (
    <div className={cx('running-row', onOpen && 'clickable')} onClick={onOpen} role={onOpen ? 'button' : undefined}>
      <StatusDot live={live} active={project.active} />
      <ProviderIcon provider={live.provider} />
      <div className="grow">
        <div>
          <strong>{label ?? a.name}</strong> <span className="faint">{statusText(live)}</span> <CardChip project={project} a={a} />
        </div>
        <div className="faint small">
          {[live.modelName ?? usage?.model ?? null, live.permissionMode ? permissionLabel(live.provider, live.permissionMode) : null, live.planMode ? 'Plan' : null].filter(Boolean).join(' · ')}
        </div>
      </div>
      <Tooltip content={window ? `${ctx.toLocaleString()} of ${window.toLocaleString()} tokens of context` : `${ctx.toLocaleString()} tokens of context`}>
        <div className="running-ctx">
          <span className="small">{formatTokens(ctx)} context{pct !== null ? ` · ${pct}%` : ''}</span>
          {pct !== null && (
            <div className={cx('meter', pct >= 90 ? 'danger' : pct >= 75 && 'caution')}>
              <div style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      </Tooltip>
      {cost === null && usage && unpricedModel(usage.provider, usage.model, settings) ? (
        <Tooltip content={unpricedText(usage.model!, providerName(usage.provider))}>
          <span className="running-cost small faint">Unknown</span>
        </Tooltip>
      ) : (
        <span className="running-cost small">{cost !== null ? `${estimated ? '≈ ' : ''}${money(cost)}` : ''}</span>
      )}
    </div>
  )
}

/** A compaction, with its place among the session's (oldest first), which opens it in the transcript. */
type CompactionRow = CompactionEvent & { n: number }

const COMPACTION_COLUMNS: DataColumn<CompactionRow>[] = [
  { key: 'when', header: 'When', cell: (c) => (c.timestamp ? formatDateTime(c.timestamp) : '—'), sortValue: (c) => c.timestamp || null, descFirst: true, filter: { kind: 'text', value: (c) => (c.timestamp ? formatDateTime(c.timestamp) : '') } },
  { key: 'trigger', header: 'Trigger', cell: (c) => <span className={cx('badge', c.trigger === 'auto' ? 'accent' : 'info')}>{c.trigger}</span>, sortValue: (c) => c.trigger, filter: { kind: 'choice', value: (c) => c.trigger } },
  { key: 'before', header: 'Before', num: true, descFirst: true, cell: (c) => formatTokens(c.preTokens), sortValue: (c) => c.preTokens },
  { key: 'after', header: 'After', num: true, descFirst: true, cell: (c) => formatTokens(c.postTokens), sortValue: (c) => c.postTokens },
  { key: 'freed', header: 'Freed', num: true, descFirst: true, cell: (c) => formatTokens(Math.max(0, c.preTokens - c.postTokens)), sortValue: (c) => Math.max(0, c.preTokens - c.postTokens) },
  { key: 'turn', header: 'Last turn', num: true, descFirst: true, cell: (c) => <LastTurn c={c} />, sortValue: (c) => c.lastOutputTokens ?? null }
]

/** What the last turn before a compaction added, said when it explains the compaction. */
function LastTurn({ c }: { c: CompactionEvent }) {
  if (c.lastOutputTokens === undefined) return <span className="faint">—</span>
  const text = `+${formatTokens(c.lastOutputTokens)}`
  if (!turnPushedCompaction(c)) return <span className="faint">{text}</span>
  return (
    <Tooltip content={`The last turn added ${formatTokens(c.lastOutputTokens)} of output (thinking included) to the ${formatTokens(c.lastInputTokens ?? 0)} the context showed before it, so it reached ${formatTokens(c.preTokens)} and was compacted.`}>
      <span className="badge warn compaction-turn">
        turn added {formatTokens(c.lastOutputTokens)} output
      </span>
    </Tooltip>
  )
}

/**
 * A session's compactions as a data table (newest first, filters, pages). A row opens that compaction in the Sessions
 * tab's transcript, at its divider, when the transcript (or Hive's backup of it) is there to read.
 */
function CompactionHistory({ project, session, compactions }: { project: ProjectInfo; session: SessionListItem; compactions: CompactionEvent[] }) {
  // Its When filter matches the dates as shown, in the current format.
  const columns = useDateColumns(COMPACTION_COLUMNS)
  const rows = useMemo(() => compactions.map((c, n) => ({ ...c, n })), [compactions])
  const readable = session.hasTranscript || session.hasBackup
  return (
    <DataTable
      id="compactions"
      className="compaction-history"
      rows={rows}
      columns={columns}
      rowKey={(c) => String(c.n)}
      defaultSort={{ key: 'when', desc: true }}
      defaultPageSize={10}
      empty="No compactions yet."
      onRowClick={readable ? (c) => openInSessionsTab(project.path, session.id, c.n) : undefined}
      rowLabel={(c) => `Open the ${c.trigger} compaction of ${c.timestamp ? formatDateTime(c.timestamp) : 'unknown time'} in the transcript`}
    />
  )
}

/** One agent's running session, else its most recent one, in detail: the agent picked here, else the focused one. */
function SessionDetails({ project, items }: { project: ProjectInfo; items: SessionListItem[] }) {
  const settings = useStore((s) => s.settings)
  useDateStyle()
  const now = useNow(10000)
  const focused = useFocusedAgent(project)
  const [pickedId, setPickedId] = useState<string | null>(null)
  const agent = project.agents.find((a) => a.id === pickedId) ?? focused
  // The footer's context count: this agent's session, scrolled to.
  const jump = useStore((s) => s.overviewJump)
  const head = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!jump || jump.project !== project.path) return
    setPickedId(jump.agentId)
    set({ overviewJump: null })
    // The footer's context: at its compaction history when it has one, else its details; its cost: at its details.
    const to = jump.target === 'session' ? null : document.getElementById('compaction-history')
    setTimeout(() => (to ?? head.current)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60)
  }, [jump, project.path])
  const liveState = agent ? agent.live : project.live
  const current = useMemo(() => {
    if (liveState?.sessionId) return items.find((i) => i.id === liveState.sessionId) ?? null
    const own = items.filter((i) => i.source === 'hive' && (!agent || sessionAgent(project, i) === agent.id))
    return own.find((i) => !i.archived) ?? own[0] ?? null
  }, [items, liveState?.sessionId, agent, project])
  const u: SessionUsage | null = current?.usage ?? null

  const provider = providerDescriptor(u?.provider ?? current?.provider)
  const cacheTtl = provider.capabilities.promptCacheTtl
  const ttl = u ? (settings?.sessions.cacheTtl === '5m' ? 300 : settings?.sessions.cacheTtl === '1h' ? 3600 : u.cacheTtlSeconds) : 300
  const elapsed = u?.lastActivity ? (now - Date.parse(u.lastActivity)) / 1000 : Infinity
  const warm = elapsed < ttl
  const totalIn = u ? u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens : 0
  const hitRate = u && totalIn ? Math.round((u.cacheReadTokens / totalIn) * 100) : 0
  const liveCost = liveState && liveState.sessionId === current?.id ? liveState.costUsd : undefined
  const cost = liveCost ?? u?.costUsd ?? null
  const costEstimated = liveCost !== undefined ? !!liveState?.costEstimated : !!u?.costEstimated

  return (
    <>
        <div className="overview-head session-head" ref={head}>
          <h2 className="section">
            {liveState ? 'Current session' : 'Most recent session'}
            {current && <span className="muted" style={{ fontWeight: 400 }}>— {current.name || current.title || current.id.slice(0, 8)} · {provider.name}</span>}
          </h2>
          {project.agents.length > 1 && agent && (
            <Tooltip content="Whose session to show. It follows the focused agent until you pick one.">
              <span>
              <select className="select" aria-label="Agent" value={agent.id} onChange={(e) => setPickedId(e.target.value)}>
                {project.agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {providerName(agentProviderOf(project, a))}
                  </option>
                ))}
              </select>
              </span>
            </Tooltip>
          )}
        </div>
        {!u ? (
          <p className="hint">{project.agents.length > 1 && agent ? `${agent.name} has no session data yet.` : 'No session data yet.'} Start a session and its token use, cache and compaction history will appear here.</p>
        ) : (
          <>
            <div className="cards">
              <Card
                accent
                title="Context"
                value={formatTokens(u.contextTokens)}
                sub={u.contextInputTokens !== undefined && u.lastOutputTokens ? `${formatTokens(u.contextInputTokens)} input + ${formatTokens(u.lastOutputTokens)} output of the last turn` : `${formatNumber(u.contextTokens)} tokens in the last request`}
                tip={<span style={{ whiteSpace: 'pre-line' }}>{`How many tokens the conversation occupies now: the last request's input and its output (thinking included), which stays in the context.\n${contextLines(u, liveState && liveState.sessionId === current?.id ? liveState.autoCompact : undefined).slice(1).join('\n')}`.trim()}</span>}
              >
                {u.contextWindow ? (
                  <div className="meter">
                    <div style={{ width: `${Math.min(100, (u.contextTokens / u.contextWindow) * 100)}%` }} />
                  </div>
                ) : null}
              </Card>
              {cacheTtl && (
                <>
                  <Card
                    title="Cache"
                    value={warm ? 'Warm' : 'Expired'}
                    sub={warm ? `≈ ${formatDuration(ttl - elapsed)} left of ${ttl === 3600 ? '1 h' : '5 min'} TTL` : `Last activity ${timeAgo(u.lastActivity)}`}
                    tip={`${provider.company}'s prompt cache keeps the conversation prefix for a limited time (5 minutes or 1 hour). While warm, each message reads the context cheaply from cache.`}
                  />
                  <Card
                    title="Re-cache on resume"
                    value={warm ? '—' : `≈ ${formatTokens(u.contextTokens)}`}
                    sub={warm ? 'Cache is still warm' : 'tokens written to cache on the next message'}
                    tip="Estimate: when the cache has expired, the first message after resuming writes the whole context to cache again. Archive and start a new session to avoid it."
                  />
                </>
              )}
              <Card title="Compactions" value={u.compactions.length} sub={u.compactions.length ? `Last ${timeAgo(u.compactions[u.compactions.length - 1].timestamp)}` : 'None yet'} tip={`${provider.name} summarises the conversation when the context fills up. Each compaction frees space but loses detail.`} />
              <Card title="Output" value={formatTokens(u.outputTokens)} sub={`${u.requests} requests · ${u.userMessages} prompts`} />
              <Card title="Input" value={formatTokens(u.inputTokens + u.cacheWriteTokens + u.cacheReadTokens)} sub={`${hitRate}% read from cache`} tip="All input tokens: uncached input, cache writes and cache reads.">
                <div className="meter">
                  <div style={{ width: `${hitRate}%` }} />
                </div>
              </Card>
              {cacheTtl && <Card title="Cache writes" value={formatTokens(u.cacheWriteTokens)} sub="tokens written to cache" />}
              <Card title="Cache reads" value={formatTokens(u.cacheReadTokens)} sub="tokens read from cache" />
              {cost !== null && (
                <Card
                  title="API-equivalent cost"
                  value={`${costEstimated ? '≈ ' : ''}${money(cost)}`}
                  sub={costEstimated ? 'this session, estimated at API prices' : 'this session, at API prices'}
                  tip={`What this session would have cost at ${provider.company} API prices${costEstimated ? ', estimated by Hive from its token counts' : `, as ${provider.name} calculates it`}. On a subscription you are not charged this; it shows how heavy the session has been.`}
                />
              )}
              {cost === null && unpricedModel(u.provider, u.model, settings) && (
                <Card title="API-equivalent cost" value="Unknown" sub={`no price for ${u.model}`} tip={unpricedText(u.model!, provider.name)} />
              )}
            </div>
            {/* Its own sideways scroll in a very narrow page (#307), as the Overview's other tables have. */}
            <div className="table-wrap session-meta" style={{ marginBottom: 20 }}>
              <table className="table">
                <tbody>
                  <tr>
                    <td className="muted" style={{ width: 180 }}>Model</td>
                    <td className="mono">{u.model ?? '—'}</td>
                  </tr>
                  <tr>
                    <td className="muted">{provider.name} version</td>
                    <td>{u.cliVersion ?? '—'}</td>
                  </tr>
                  <tr>
                    <td className="muted">Started</td>
                    <td>{u.firstActivity ? formatDateTime(u.firstActivity) : '—'}</td>
                  </tr>
                  <tr>
                    <td className="muted">Last activity</td>
                    <td>{u.lastActivity ? `${formatDateTime(u.lastActivity)} (${timeAgo(u.lastActivity)})` : '—'}</td>
                  </tr>
                  {u.lastPrompt && (
                    <tr>
                      <td className="muted">Last prompt</td>
                      <td style={{ whiteSpace: 'pre-wrap' }}>{u.lastPrompt.slice(0, 400)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {u.compactions.length > 0 && current && (
              <>
                <h2 className="section" id="compaction-history">
                  Compaction history
                </h2>
                <CompactionHistory project={project} session={current} compactions={u.compactions} />
              </>
            )}
          </>
        )}
    </>
  )
}

/** One provider's subscription limits (account-wide), as its sessions last reported them. */
export function PlanLimits({ provider }: { provider: ProviderId }) {
  const usage = useStore((s) => s.planUsage[provider])
  useNow(60000)
  const p = providerDescriptor(provider)
  const card = (id: ProviderId, l: PlanLimit): React.ReactNode => (
    <Card key={l.id} title={`${l.label.charAt(0).toUpperCase()}${l.label.slice(1)} limit`} value={`${Math.round(l.usedPercent)}%`} sub={l.resetsAt ? `used · resets ${resetsIn(l.resetsAt)}` : 'used'} tip={`How much of your plan’s ${l.label} allowance is used, across all your ${providerName(id)} sessions (not just Hive).`} accent={l.usedPercent >= 80}>
      <div className={cx('meter', l.usedPercent >= 95 ? 'danger' : l.usedPercent >= 80 && 'caution')}>
        <div style={{ width: `${Math.min(100, l.usedPercent)}%` }} />
      </div>
    </Card>
  )
  return usage?.limits.length ? (
    <>
      <div className="faint small overview-plan">
        Plan limits{usage.plan ? ` (${usage.plan})` : ''}, account-wide, as of {timeAgo(usage.updatedAt)}
      </div>
      <div className="cards">{usage.limits.map((l) => card(provider, l))}</div>
    </>
  ) : (
    <p className="hint">{p.name} reports your plan’s limits while a session runs; they appear here after the next message in any {p.name} session. Accounts that use an API key have no plan limits.</p>
  )
}

// ---------------------------------------------------------------------------
// Changes (git)
// ---------------------------------------------------------------------------

const GIT_LABEL: Record<string, string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Conflict', '?': 'Untracked' }

export function ChangesTab({ project: owner }: { project: ProjectInfo }) {
  const usageVersion = useStore((s) => s.usageVersion[owner.path] ?? 0)
  const rootId = useStore((s) => s.changesRoot[owner.path])
  const listWidth = usePaneSize('changes', 280)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [file, setFile] = useState<string | null>(null)
  // The diff and its failure, each with the file (and folder) it is for.
  const [diffOf, setDiffOf] = useState<{ for: string; diff: GitDiff } | null>(null)
  const [diffErrorOf, setDiffErrorOf] = useState<{ for: string; error: string } | null>(null)
  const [inline, setInline] = useState(false)
  // A worktree agent's changes are everything on its branch since it left its base branch.
  const agent = owner.agents.find((a) => a.id === rootId && a.worktree)
  const root = agent?.worktree?.path ?? owner.path
  const base = agent?.worktree?.base
  const project = agent ? { ...owner, path: root } : owner

  const [statusError, setStatusError] = useState<string | null>(null)
  const [diffTry, setDiffTry] = useState(0)
  // Each answer is for the folder (and base) it was asked about: an older one arriving late is dropped.
  const statusFor = useRef('')
  const statusLoads = useRef(0)
  const key = `${root}\n${base ?? ''}`
  const load = useCallback(() => {
    const n = ++statusLoads.current
    void call('git:status', root, base).then(
      (s) => {
        if (n !== statusLoads.current) return
        statusFor.current = `${root}\n${base ?? ''}`
        setStatus(s)
        setStatusError(null)
        setFile((f) => (f && s.files.some((x) => x.path === f) ? f : s.files[0]?.path ?? null))
      },
      (e) => n === statusLoads.current && setStatusError(errorMessage(e))
    )
  }, [root, base])
  // Another folder: its files aren't these, so nothing shows until its own status arrives.
  useEffect(() => {
    setStatus(null)
    setStatusError(null)
    setFile(null)
  }, [root, base])
  useEffect(load, [load, usageVersion])

  // A refresh of the same file keeps showing its diff until the new one arrives; another file's never shows.
  const wanted = `${key}\n${file ?? ''}`
  const diff = diffOf?.for === wanted ? diffOf.diff : null
  const diffError = diffErrorOf?.for === wanted ? diffErrorOf.error : null
  useEffect(() => {
    if (!file || statusFor.current !== key) return
    const asked = `${key}\n${file}`
    let current = true
    void call('git:diff', root, file, base).then(
      (d) => {
        if (!current) return
        setDiffOf({ for: asked, diff: d })
        setDiffErrorOf(null)
      },
      (e) => current && setDiffErrorOf({ for: asked, error: errorMessage(e) })
    )
    return () => {
      current = false
    }
  }, [file, root, base, status, key, diffTry])
  const selector = <RootSelector project={owner} value={rootId} onChange={(id) => set((s) => ({ changesRoot: { ...s.changesRoot, [owner.path]: id } }))} />

  if (!status && statusError) {
    return (
      <div className="empty-state">
        <Icon name="error" /> Could not read the changes: {statusError}
        <button className="btn small" style={{ marginTop: 10 }} onClick={load}>
          <Icon name="refresh" /> Retry
        </button>
      </div>
    )
  }
  if (!status) return <div className="empty-state"><Icon name="loading" spin />Loading…</div>
  if (!status.isRepo) {
    return (
      <div className="empty-state" style={{ paddingTop: '15vh' }}>
        <Icon name="source-control" />
        {project.name} is not a git repository, so there are no changes to review.
        <p className="hint">Ask the agent to run <code>git init</code>, or initialise it yourself, to review its changes here.</p>
      </div>
    )
  }
  return (
    <div className="split">
      <div className="split-list" style={{ width: listWidth }}>
        <PaneResizer paneKey="changes" />
        <div className="pane-header" style={{ paddingLeft: 14 }}>
          Changes <span className="badge" style={{ marginLeft: 6 }}>{status.files.length}</span>
          <div className="actions">
            {agent && <IconButton icon="git-merge" title={mergeBlocked(agent.name, agent.live?.status) ?? `Merge ${agent.name}'s work…`} disabled={!!mergeBlocked(agent.name, agent.live?.status)} onClick={() => set({ mergeFor: { project: owner.path, agentId: agent.id } })} />}
            <IconButton icon="refresh" title="Refresh" onClick={load} />
          </div>
        </div>
        {selector}
        {statusError && (
          <div className="banner warn">
            <Icon name="warning" /> Could not refresh: {statusError}
            <button className="btn small" onClick={load}>
              Retry
            </button>
          </div>
        )}
        <div className="muted" style={{ padding: '0 14px 8px', fontSize: 12 }}>
          <Icon name="git-branch" /> {status.branch} {agent ? <span className="faint">since it left {base}</span> : <>{status.ahead > 0 && `↑${status.ahead}`} {status.behind > 0 && `↓${status.behind}`}</>}
        </div>
        <div className="pane-body">
          {status.files.length === 0 && <div className="pane-empty">{agent ? `No changes on ${agent.worktree!.branch} yet.` : 'Working tree clean.'}</div>}
          {status.files.map((f) => (
            <Tooltip block key={f.path} content={`${GIT_LABEL[f.status] ?? f.status}${f.staged ? ' (staged)' : ''}: ${f.path}`}>
              <div className={cx('row', file === f.path && 'selected')} style={{ width: '100%' }} onClick={() => setFile(f.path)}>
                <span className="label">{f.path.split('/').pop()}</span>
                <span className="desc" style={{ flex: 1, minWidth: 0 }}>{f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}</span>
                <span className={cx('git-status', f.status === '?' ? 'U' : f.status)}>{f.status === '?' ? 'U' : f.status}</span>
              </div>
            </Tooltip>
          ))}
        </div>
      </div>
      <div className="split-main">
        {diff ? (
          <>
            <div className="editor-toolbar">
              <Icon name="git-compare" />
              <span className="path">
                <strong>{diff.path}</strong> <span className="faint">{agent ? `${base} ↔ ${agent.name}'s worktree` : 'HEAD ↔ working tree'}</span>
              </span>
              <IconButton icon={inline ? 'split-horizontal' : 'list-flat'} title={inline ? 'Side by side' : 'Inline'} onClick={() => setInline(!inline)} />
              <IconButton icon="go-to-file" title="Open file" onClick={() => void call('app:openPath', `${project.path}\\${diff.path.replace(/\//g, '\\')}`)} />
            </div>
            {/* A refresh of the shown file failed: its last diff stays, but it may be out of date. */}
            {diffError && (
              <div className="banner warn">
                <Icon name="warning" /> Could not refresh the diff, so this may be out of date: {diffError}
                <button className="btn small" onClick={() => setDiffTry((n) => n + 1)}>
                  Retry
                </button>
              </div>
            )}
            <div className="editor-host">
              {diff.binary ? (
                <div className="empty-state">{diff.modified || 'Binary file — no text diff.'}</div>
              ) : (
                <DiffView original={diff.original} modified={diff.modified} language={languageFor(diff.path)} inline={inline} />
              )}
            </div>
          </>
        ) : diffError ? (
          <div className="empty-state">
            <Icon name="error" /> Could not load the diff: {diffError}
            <button className="btn small" style={{ marginTop: 10 }} onClick={() => setDiffTry((n) => n + 1)}>
              <Icon name="refresh" /> Retry
            </button>
          </div>
        ) : file ? (
          <div className="empty-state">
            <Icon name="loading" spin /> Loading the diff…
          </div>
        ) : (
          <div className="empty-state">Select a file to see its changes.</div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

const memoryTip = (s: MemorySource): string => {
  const name = providerName(s.provider)
  if (s.kind === 'local-md') return `Personal project instructions ${name} reads that are not committed.`
  if (s.kind === 'auto-memory') return `${name}'s own memory for this project — facts it chose to remember across sessions.`
  return `Project instructions ${name} reads at the start of every session. Usually committed to git.`
}

const NO_SOURCES: MemorySource[] = []

export function MemoryTab({ project }: { project: ProjectInfo }) {
  const listWidth = usePaneSize('memory', 280)
  // This project's files only: another project's never show (or open for editing) here, even while this one loads.
  const memory = useScopedLoad<MemorySource[]>(project.path)
  const sources = memory.data ?? NO_SOURCES
  const error = memory.error
  const [selected, setSelected] = useState<string | null>(null)
  const { load: loadScoped } = memory
  const load = useCallback(() => {
    const path = project.path
    loadScoped(path, () => call('memory:list', path))
  }, [project.path, loadScoped])
  useEffect(load, [load])
  // Start on the first file that exists.
  useEffect(() => {
    const s = memory.data
    const first = s?.find((x) => x.exists) ?? s?.[0]
    if (first) setSelected((cur) => cur ?? `${first.provider}:${first.id}`)
  }, [memory.data])
  const sel = sources.find((s) => `${s.provider}:${s.id}` === selected)
  // One pair of groups per provider the project uses (or, with none yet, every enabled provider).
  const settings = useStore((s) => s.settings)
  const used = new Set(project.agents.map((a) => agentProviderOf(project, a)))
  const providers = PROVIDERS.filter((p) => used.has(p.id) || (isProviderEnabled(settings, p.id) && sources.some((s) => s.provider === p.id && s.exists)))
  // With agents of more than one provider: one shared AGENTS.md instead of a file per CLI.
  const usedIds = [...used].sort()
  const [shared, setShared] = useState(true)
  useEffect(() => {
    if (usedIds.length < 2) return setShared(true)
    // Only decides whether to offer sharing one AGENTS.md: unknown, it isn't offered.
    void call('memory:instructionsShared', project.path, usedIds).then(setShared).catch(() => setShared(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.path, usedIds.join(), sources])
  const share = async (): Promise<void> => {
    const names = usedIds.map((id) => providerName(id)).join(' and ')
    const importers = PROVIDERS.filter((p) => used.has(p.id) && p.instructionsImport && p.instructionsFile !== 'AGENTS.md')
    const ok = await confirm({
      title: 'Share instructions',
      message: `${names} will read the same AGENTS.md.`,
      detail: `${importers.map((p) => `${p.instructionsFile} gets an "${p.instructionsImport}" line that includes AGENTS.md; anything else in it still applies to ${p.name} only.`).join(' ')} If there's no AGENTS.md yet, the current instructions move into it, so nothing is lost.${sources.some((x) => x.id === 'project-dot' && x.exists) ? ' Your .claude/CLAUDE.md stays as it is and applies to Claude Code only: move anything the other agents should know into AGENTS.md.' : ''} Running sessions read the change when they next start.`,
      confirmLabel: 'Share'
    })
    if (!ok) return
    const written = await actions.attempt('Could not share the instructions', () => call('memory:shareInstructions', project.path, usedIds))
    if (written) {
      notify('success', 'Instructions shared', written.length ? `Updated ${written.join(', ')}.` : undefined)
      load()
    }
  }
  const groups: [string, MemorySource[]][] = providers.flatMap((p): [string, MemorySource[]][] => [
    [`${p.name}: instructions`, sources.filter((s) => s.provider === p.id && s.kind !== 'auto-memory')],
    [`${p.name}: memory`, sources.filter((s) => s.provider === p.id && s.kind === 'auto-memory')]
  ])
  return (
    <div className="split">
      <div className="split-list" style={{ width: listWidth }}>
        <PaneResizer paneKey="memory" />
        <div className="pane-header" style={{ paddingLeft: 14 }}>
          Memory
          <div className="actions">
            <IconButton icon="refresh" title="Refresh" onClick={load} />
          </div>
        </div>
        {error && memory.data && <StaleNote what="the instructions and memory" error={error} at={memory.at} onRetry={load} />}
        <div className="pane-body">
          {error && !memory.data && <LoadFailed inline what="the instructions and memory" error={error} onRetry={load} />}
          {!error && !memory.data && (
            <div className="pane-empty">
              <Icon name="loading" spin /> Loading…
            </div>
          )}
          {!shared && (
            <div className="memory-share">
              <Icon name="info" /> Each provider reads its own instructions file.
              <button className="btn subtle small" onClick={() => void share()}>
                Share one AGENTS.md…
              </button>
            </div>
          )}
          {memory.data &&
            groups.map(([title, list]) => (
            <div key={title}>
              <div className="section-header" style={{ cursor: 'default' }}>{title}</div>
              {list.length === 0 && <div className="pane-empty" style={{ paddingTop: 6 }}>{title.endsWith('memory') ? 'Nothing saved for this project yet.' : ''}</div>}
              {list.map((s) => (
                <Tooltip block key={`${s.provider}:${s.id}`} content={<span style={{ whiteSpace: 'pre-line' }}>{`${memoryTip(s)}\n${s.path}`}</span>}>
                  <div className={cx('row', selected === `${s.provider}:${s.id}` && 'selected')} style={{ width: '100%' }} onClick={() => setSelected(`${s.provider}:${s.id}`)}>
                    <Icon name={s.kind === 'auto-memory' ? 'lightbulb' : 'book'} />
                    <span className="label" style={!s.exists ? { color: 'var(--fg-faint)' } : undefined}>{s.label}</span>
                    {!s.exists && <span className="desc">create</span>}
                  </div>
                </Tooltip>
              ))}
            </div>
          ))}
        </div>
      </div>
      {sel ? (
        <DocEditor
          key={sel.path}
          path={sel.path}
          title={sel.label}
          createIfMissing={sel.exists ? undefined : `# ${project.name}\n\nInstructions for ${providerName(sel.provider)} in this project.\n`}
          onSaved={load}
        />
      ) : (
        <div className="split-main">
          <div className="empty-state">Select a memory file.</div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Project skills & MCP
// ---------------------------------------------------------------------------

function ChangesApplyNote({ project }: { project: ProjectInfo }) {
  return (
    <p className="hint">
      Changes apply to new sessions{project.live ? ' — restart the running session to apply them' : ''}. Items must be enabled in the workspace before a project can use them.
    </p>
  )
}

export function ProjectSkillsTab({ project }: { project: ProjectInfo }) {
  const version = useStore((s) => s.skillsVersion)
  const settings = useStore((s) => s.settings)
  const listWidth = usePaneSize('projectSkills', 320)
  // This project's skills only. A failed read: said, with Retry (and this project's skills from before, if any),
  // rather than looking like no skills.
  const loaded = useScopedLoad<SkillInfo[]>(project.path)
  const skills = loaded.data
  const error = loaded.error
  const [selected, setSelected] = useState<string | null>(null)
  const { load: loadScoped } = loaded
  const load = useCallback(() => {
    const path = project.path
    loadScoped(path, () => call('skills:list', path))
  }, [project.path, loadScoped])
  useEffect(load, [load, version])

  const providers = PROVIDERS.filter((p) => isProviderEnabled(settings, p.id))
  const ids = providers.map((p) => p.id)
  // One provider's skills at a time (#118): the one last shown for this project, else the project's default provider,
  // else the first turned on.
  const key = project.path.toLowerCase()
  const remembered = useStore((s) => s.skillsProvider[key])
  const fallback = projectDefaultProvider(project.config, settings)
  const shown = providers.find((p) => p.id === remembered) ?? providers.find((p) => p.id === fallback) ?? providers[0]
  const showProvider = (id: ProviderId): void => rememberProjectPref('skillsProvider', key, id)
  // Hive skills (the workspace's, the same in every project) start open at the top; the provider's skills folded under
  // the dropdown. Opening or folding either is remembered for the project (Darren, 5 Oct).
  const fold = useStore((s) => s.skillsFold[key])
  const hiveOpen = fold?.hive ?? true
  const providerOpen = fold?.provider ?? false
  const setFold = (patch: { hive?: boolean; provider?: boolean }): void => rememberProjectPref('skillsFold', key, { hive: hiveOpen, provider: providerOpen, ...patch })
  const setHiveOpen = (open: boolean): void => setFold({ hive: open })
  const all = skills ?? []
  // This project's agents get the Hive skills for them; those for the Assistant alone are left out, and counted.
  const hive = all.filter((s) => s.level === 'hive' && s.audience !== 'assistant')
  const assistantOnly = all.filter((s) => s.level === 'hive' && s.audience === 'assistant').length
  const current = selected ? all.find((s) => s.path === selected) : undefined

  const add = async (mode: 'new' | 'file', provider: ProviderId): Promise<void> => {
    const r = await addSkill(mode, { kind: 'local', projectPath: project.path, provider }, otherLocal(project.path, provider, ids))
    if (r) setSelected(r.path)
  }
  const row = (sk: SkillInfo, actionsFor?: React.ReactNode) => <SkillRow key={sk.path} skill={sk} selected={selected === sk.path} onSelect={() => setSelected(sk.path)} actionsFor={actionsFor} />
  const group = (title: string, tip: string, items: SkillInfo[], extra?: React.ReactNode, empty?: string) => (
    <>
      <div className="skill-group">
        {title} <InfoTip text={tip} />
        {extra && <div className="actions">{extra}</div>}
      </div>
      {items.length === 0 && empty && <div className="pane-empty">{empty}</div>}
    </>
  )

  return (
    <div className="split">
      <div className="split-list" style={{ width: listWidth }}>
        <PaneResizer paneKey="projectSkills" max={600} />
        <div className="pane-header" style={{ paddingLeft: 14 }}>
          Skills available to agents
          <div className="actions">
            <IconButton icon="refresh" title="Refresh" onClick={load} />
          </div>
        </div>
        {error && skills && <StaleNote what="the skills" error={error} at={loaded.at} onRetry={load} />}
        <div className="pane-body">
          {error && !skills && <LoadFailed inline what="the skills" error={error} onRetry={load} />}
          {!error && !skills && (
            <div className="pane-empty">
              <Icon name="loading" spin /> Loading…
            </div>
          )}
          {skills && (
            <div className="skill-group skill-group-toggle" role="button" tabIndex={0} aria-expanded={hiveOpen} onClick={() => setHiveOpen(!hiveOpen)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setHiveOpen(!hiveOpen))}>
              <Icon name={hiveOpen ? 'chevron-down' : 'chevron-right'} /> Hive <span className="count">{hive.length}</span> <InfoTip text={SKILL_LEVEL_TIP.hive} />
            </div>
          )}
          {skills && hiveOpen && hive.length === 0 && <div className="pane-empty">No Hive skills in this workspace.</div>}
          {hiveOpen &&
            hive.map((sk) =>
              row(
                sk,
                <IconButton icon="go-to-file" title="Edit in the workspace's Skills view (Hive skills are shared by every project)" onClick={() => editInWorkspace(sk)} />
              )
            )}
          {skills && hiveOpen && assistantOnly > 0 && (
            <div className="pane-empty assistant-only-note">
              {assistantOnly === 1 ? "1 Hive skill is for the Hive Assistant only, so it isn't listed: this project's agents don't get it." : `${assistantOnly} Hive skills are for the Hive Assistant only, so they aren't listed: this project's agents don't get them.`}{' '}
              <a onClick={() => showView('skills')}>See them in the Skills view</a>
            </div>
          )}
          {skills && providers.length > 0 && (
            <div className="skill-provider-pick">
              <select className="select" aria-label="Show the skills of" value={shown?.id ?? ''} onChange={(e) => showProvider(e.target.value)}>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({all.filter((sk) => sk.provider === p.id).length})
                  </option>
                ))}
              </select>
            </div>
          )}
          {skills &&
            providers.filter((p) => p.id === shown?.id).map((p) => {
            const mine = all.filter((sk) => sk.provider === p.id)
            const local = mine.filter((sk) => sk.level === 'local')
            const user = mine.filter((sk) => sk.level === 'machine')
            const plugin = mine.filter((sk) => sk.level === 'plugin')
            return (
              <div key={p.id} className="skill-provider">
                <div className="skill-group skill-group-toggle skill-provider-toggle" role="button" tabIndex={0} aria-expanded={providerOpen} onClick={() => setFold({ provider: !providerOpen })} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setFold({ provider: !providerOpen }))}>
                  <Icon name={providerOpen ? 'chevron-down' : 'chevron-right'} /> <ProviderIcon provider={p.id} /> {p.name} skills <span className="count">{mine.length}</span>
                </div>
                {providerOpen && (
                <>
                {group(
                  'Local (User Managed)',
                  SKILL_LEVEL_TIP.local,
                  local,
                  <>
                    <IconButton icon="add" title={`New local skill for ${p.name}…`} onClick={() => void add('new', p.id)} />
                    <IconButton icon="file-add" title={`Add a local skill for ${p.name} from a file (.md or .zip)…`} onClick={() => void add('file', p.id)} />
                  </>,
                  `None yet. Add one with +, or from a .md or .zip.`
                )}
                {local.map((sk) => row(sk, <IconButton icon="trash" title="Delete skill" onClick={() => void deleteSkill(sk).then((ok) => ok && selected === sk.path && setSelected(null))} />))}
                {group('User', SKILL_LEVEL_TIP.machine, user, undefined, 'None in your user profile.')}
                {user.map((sk) => row(sk))}
                {plugin.length > 0 && group('Plugins', SKILL_LEVEL_TIP.plugin, plugin)}
                {plugin.map((sk) => row(sk))}
                </>
                )}
              </div>
            )
          })}
          {providers.length === 0 && <div className="pane-empty">Turn on a coding agent in Settings → Providers to see its skills.</div>}
        </div>
      </div>
      <div className="split-main">
        {current ? (
          <SkillDetail key={current.path} skill={current} where="project" onDeleted={() => setSelected(null)} />
        ) : (
          <div className="empty-state" style={{ paddingTop: '14vh' }}>
            <Icon name="sparkle" />
            <div>
              Select a skill to view it. <strong>Hive</strong> skills reach every project's agents (those for the Hive Assistant alone aren't listed here) and are edited in the workspace's Skills view; <strong>local</strong> skills belong to this project and one provider, and you can add, edit and delete them here.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export function ProjectMcpTab({ project }: { project: ProjectInfo }) {
  const version = useStore((s) => s.skillsVersion)
  const settings = useStore((s) => s.settings)
  const api = useStore((s) => s.api)
  // The workspace's servers (the window's workspace): before they load, nothing is said about them.
  const wsPath = useStore((s) => s.workspace?.path ?? '')
  const loaded = useScopedLoad<McpServerInfo[]>(wsPath)
  const servers = loaded.data
  const error = loaded.error
  const { load: loadScoped } = loaded
  const load = useCallback(() => loadScoped(wsPath, () => call('mcp:list')), [wsPath, loadScoped])
  useEffect(load, [load, version])
  const disabled = new Set(project.config.mcp.disabled)
  const toggle = async (name: string, enabled: boolean): Promise<void> => {
    await actions.attempt('Could not update server', () => call('mcp:setProject', project.path, name, enabled))
    await actions.refreshWorkspace()
  }
  const hiveOn = !!(settings?.agentApi.enabled && settings.agentApi.provideHiveMcp && api?.running)
  return (
    <div className="scroll-page">
      <div className="page-narrow">
        <h2 className="section">Workspace MCP servers</h2>
        <ChangesApplyNote project={project} />
        {error && servers && <StaleNote what="the workspace's MCP servers" error={error} at={loaded.at} onRetry={load} />}
        {!servers ? (
          error ? (
            <LoadFailed inline what="the workspace's MCP servers" error={error} onRetry={load} />
          ) : (
            <p className="hint">
              <Icon name="loading" spin /> Loading…
            </p>
          )
        ) : servers.length === 0 ? (
          <p className="hint">
            No MCP servers in this workspace. <a onClick={() => setActivity('mcp')}>Manage MCP servers</a>
          </p>
        ) : (
          <div className="toggle-list">
            {servers.map((m) => {
              const on = m.globallyEnabled && !disabled.has(m.name)
              return (
                <div key={m.name} className={cx('toggle-item', !m.globallyEnabled && 'disabled')}>
                  <Icon name={m.def?.url ? 'globe' : 'plug'} />
                  <div className="ti-text">
                    <div className="ti-name">
                      {m.name} {!m.globallyEnabled && <span className="badge">disabled in workspace</span>} {m.error && <span className="badge error">invalid</span>}
                    </div>
                    <div className="ti-desc">{m.error ?? m.def?.description ?? m.def?.command}</div>
                  </div>
                  <Switch checked={on} disabled={!m.globallyEnabled || !!m.error} onChange={(v) => void toggle(m.name, v)} />
                </div>
              )
            })}
          </div>
        )}
        {project.unmanagedMcp.length > 0 && (
          <>
            <h2 className="section">Defined by the project (disabled)</h2>
            <p className="hint">These servers are in the project's own agent config (such as .mcp.json). Hive starts sessions with only workspace servers, so they stay disabled until copied to the workspace.</p>
            <div className="toggle-list">
              {project.unmanagedMcp.map((n) => (
                <div key={n} className="toggle-item disabled">
                  <Icon name="plug" />
                  <div className="ti-text">
                    <div className="ti-name">{n}</div>
                  </div>
                  <button className="btn small subtle" onClick={() => void actions.importProjectMcp(project.path, [n])}>
                    <Icon name="cloud-upload" /> Copy to workspace
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
        <h2 className="section">Built-in</h2>
        <div className="toggle-list">
          <div className="toggle-item">
            <Icon name="hubot" />
            <div className="ti-text">
              <div className="ti-name">hive</div>
              <div className="ti-desc">Lets agents see other projects, read and write shared notes, create handovers and notify you.</div>
            </div>
            <span className={cx('badge', hiveOn ? 'success' : '')}>{hiveOn ? 'On for all sessions' : 'Off'}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Project settings
// ---------------------------------------------------------------------------

function SettingRow({ title, desc, tip, children, modified }: { title: string; desc: string; tip?: string; children: React.ReactNode; modified?: boolean }) {
  return (
    <div className="setting">
      <div className="s-text">
        <div className="s-title">
          {modified && <Tooltip content="Overrides the global default"><span className="modified" /></Tooltip>}
          {title} {tip && <InfoTip text={tip} />}
        </div>
        <div className="s-desc">{desc}</div>
      </div>
      <div className="s-control">{children}</div>
    </div>
  )
}

type ProjectSection = 'agents' | 'sessions' | 'storage' | 'keys' | 'advanced' | `provider:${string}`

const PROJECT_SECTION_ICONS: Record<string, string> = { agents: 'organization', sessions: 'history', storage: 'database', keys: 'keyboard', advanced: 'tools' }

const PROJECT_SECTIONS: { id: ProjectSection; label: string; icon: string; desc: string; provider?: ProviderId }[] = PROJECT_SETTINGS_SECTIONS.map((s) => ({ ...s, id: s.id as ProjectSection, icon: PROJECT_SECTION_ICONS[s.id] ?? 'blank' }))

/** A row's text from the settings catalog (settingsCatalog.ts), which Settings, Project Settings and the Assistant's settings tools share. */
function rowText(id: string): { title: string; desc: string; tip?: string; wide?: boolean } {
  const e = settingEntry(id)
  if (!e) throw new Error(`No settings catalog entry ${id}`)
  return { title: e.title, desc: e.desc, ...(e.tip ? { tip: e.tip } : {}), ...(e.wide ? { wide: true } : {}) }
}

interface ProjectSettingDef {
  section: ProjectSection
  key: string
  title: string
  desc: string
  tip?: string
  modified?: boolean
  wide?: boolean
  render: () => React.ReactNode
}

/** A text or number field that saves when it loses focus (or on Enter). */
function DraftInput({ value, onCommit, ...rest }: { value: string; onCommit: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return <input {...rest} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft !== value && onCommit(draft)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
}

function DraftTextarea({ value, onCommit, ...rest }: { value: string; onCommit: (v: string) => void } & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return <textarea {...rest} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft !== value && onCommit(draft)} />
}

function AgentList({ project }: { project: ProjectInfo }) {
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const cfg = project.config
  return (
    <div className="agent-list">
      {project.agents.map((a) => {
        const provider = agentProviderOf(project, a)
        const model = effectiveModelLabel(provider, a.model || projectProviderConfig(cfg, provider).model, providerSettings(settings, provider).defaultModel, providers[provider])
        const overrides = [a.model && `model ${modelLabel(a.model, provider)}`, a.effort && `effort ${a.effort}`, a.permissionMode && permissionLabel(provider, a.permissionMode), a.use200kContext !== undefined && `200K context ${a.use200kContext ? 'on' : 'off'}`].filter(Boolean)
        const off = !isProviderEnabled(settings, provider)
        return (
          <div key={a.id} className={cx('agent-list-row', off && 'off')}>
            <StatusDot live={a.live} active={project.active} />
            <Tooltip content={off ? `${providerName(provider)} is turned off in Settings → Providers` : providerName(provider)}>
              <span>
                <ProviderIcon provider={provider} />
              </span>
            </Tooltip>
            <div className="grow">
              <div>
                <strong>{a.name}</strong> <span className="faint">{providerName(provider)}{off ? ' (off)' : ''}</span>{' '}
                {a.worktree ? (
                  <span className="agent-branch">
                    <Icon name="git-branch" /> {a.worktree.branch}
                  </span>
                ) : (
                  <span className="faint">project folder</span>
                )}
              </div>
              <div className="faint small">
                {overrides.length ? `Own settings: ${overrides.join(', ')}` : `Project settings (${model})`}
                {a.worktree && <> · {a.worktree.path}</>}
              </div>
            </div>
            <IconButton icon="settings" title="Agent settings…" onClick={() => set({ agentSettingsFor: { project: project.path, agentId: a.id } })} />
            {a.worktree && <IconButton icon="git-merge" title={mergeBlocked(a.name, a.live?.status) ?? 'Merge…'} disabled={!!mergeBlocked(a.name, a.live?.status)} onClick={() => set({ mergeFor: { project: project.path, agentId: a.id } })} />}
            <IconButton icon="close" title="Remove agent…" onClick={() => void actions.removeAgent(project.path, a.id)} />
          </div>
        )
      })}
      <button className="btn subtle small" disabled={project.agents.length >= MAX_AGENTS} onClick={() => set({ addAgentFor: project.path })}>
        <Icon name="add" /> Add Agent
      </button>
    </div>
  )
}

export function ProjectSettingsTab({ project }: { project: ProjectInfo }) {
  const settings = useStore((s) => s.settings)
  const installs = useStore((s) => s.providers)
  const [section, setSection] = useState<ProjectSection>('agents')
  const [query, setQuery] = useState('')
  // Opened on a section from elsewhere (Settings → Workspace's Storage links).
  const jump = useStore((s) => s.projectSettingsJump)
  useEffect(() => {
    if (!jump || jump.project.toLowerCase() !== project.path.toLowerCase()) return
    if (PROJECT_SECTIONS.some((x) => x.id === jump.section)) setSection(jump.section as ProjectSection)
    setQuery('')
    set({ projectSettingsJump: null })
  }, [jump, project.path])
  const cfg = project.config
  if (!settings) return null
  const update = async (patch: Partial<ProjectConfig>): Promise<void> => {
    await actions.attempt('Could not save project settings', () => call('project:updateConfig', project.path, patch))
    await actions.refreshWorkspace()
  }
  const globalLock = FILE_LOCK_MODES.find((m) => m.value === settings.agents.fileLocks)
  const lockMode = cfg.fileLocks === 'inherit' ? settings.agents.fileLocks : cfg.fileLocks
  const globalDefault = providerName(settings.defaultProvider)
  const globalCompact = settings.sessions.compactSuggestTokens ? settings.sessions.compactSuggestTokens.toLocaleString() : 'never'
  const globalWarn = settings.sessions.transcriptWarnMB ? `${settings.sessions.transcriptWarnMB} MB` : 'never'

  /** A project's model, effort, mode and arguments for one provider. */
  const providerDefs = (id: ProviderId): ProjectSettingDef[] => {
    const p = providerDescriptor(id)
    const pc = projectProviderConfig(cfg, id)
    const g = providerSettings(settings, id)
    const sect = `provider:${id}` as ProjectSection
    const save = (patch: Partial<typeof pc>): Promise<void> => actions.updateProjectProvider(project.path, id, patch)
    const globalModel = g.defaultModel ? runsAsName(id, g.defaultModel, installs[id]) : `${p.name} default`
    // The model this project's agents run unless they choose one, whose effort levels the picker offers (#125).
    const runModel = (pc.model && pc.model !== 'inherit' ? pc.model : g.defaultModel) || installs[id]?.defaultModel || null
    const globalEffort = effortText(id, g.defaultEffort, runModel, installs[id], settings)
    const modes = offeredModes(id, settings)
    const mode = pc.permissionMode === 'inherit' ? g.defaultPermissionMode : pc.permissionMode
    return [
      {
        section: sect,
        key: `${id}.model`,
        ...rowText(`project.${id}.model`),
        modified: pc.model !== 'inherit',
        render: () => <ModelPicker provider={id} value={pc.model} base={{ value: 'inherit', label: `Inherit (${globalModel})` }} onChange={(v) => void save({ model: v })} />
      },
      {
        section: sect,
        key: `${id}.effort`,
        ...rowText(`project.${id}.effort`),
        modified: pc.effort !== 'inherit',
        render: () => <EffortPicker provider={id} model={runModel} value={pc.effort} base={{ value: 'inherit', label: `Inherit (${globalEffort})` }} onChange={(v) => void save({ effort: v })} />
      },
      {
        section: sect,
        key: `${id}.permissionMode`,
        ...rowText(`project.${id}.permissionMode`),
        // What the mode in use does, after what the setting is.
        desc: `${rowText(`project.${id}.permissionMode`).desc} Now: ${modeOption(id, mode)?.description ?? permissionLabel(id, mode)}`,
        modified: pc.permissionMode !== 'inherit',
        render: () => (
          <select
            className="select"
            value={modes.some((m) => m.value === pc.permissionMode) ? pc.permissionMode : 'inherit'}
            onChange={async (e) => {
              const v = e.target.value
              if (v !== 'inherit' && !(await confirmDangerousMode(id, v, `Sessions in ${project.name}`))) return
              await save({ permissionMode: v })
            }}
          >
            <option value="inherit">Inherit ({permissionLabel(id, g.defaultPermissionMode)})</option>
            {modes.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        )
      },
      ...(p.capabilities.contextLimit
        ? [
            {
              section: sect,
              key: `${id}.use200kContext`,
              ...rowText(`project.${id}.use200kContext`),
              modified: (pc.use200kContext ?? 'inherit') !== 'inherit',
              render: () => (
                <select className="select" value={pc.use200kContext ?? 'inherit'} onChange={(e) => void save({ use200kContext: e.target.value as 'inherit' | 'on' | 'off' })}>
                  <option value="inherit">Inherit ({g.use200kContext ? 'On' : 'Off'})</option>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              )
            }
          ]
        : []),
      {
        section: sect,
        key: `${id}.extraArgs`,
        ...rowText(`project.${id}.extraArgs`),
        modified: !!pc.extraArgs,
        render: () => <DraftInput className="input mono" value={pc.extraArgs} placeholder="--add-dir ../lib" onCommit={(v) => void save({ extraArgs: v })} />
      }
    ]
  }

  const defs: ProjectSettingDef[] = [
    {
      section: 'agents',
      key: 'defaultProvider',
      ...rowText('project.defaultProvider'),
      modified: cfg.defaultProvider !== 'inherit',
      render: () => (
        <select className="select" value={cfg.defaultProvider} onChange={(e) => void update({ defaultProvider: e.target.value })}>
          <option value="inherit">Inherit ({globalDefault})</option>
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {isProviderEnabled(settings, p.id) ? '' : ' (off)'}
            </option>
          ))}
        </select>
      )
    },
    ...PROVIDERS.flatMap((p) => providerDefs(p.id)),
    {
      section: 'sessions',
      key: 'compactSuggestTokens',
      ...rowText('project.compactSuggestTokens'),
      modified: cfg.compactSuggestTokens !== null,
      render: () => (
        <NumberField
          value={cfg.compactSuggestTokens}
          min={1000}
          max={2000000}
          step={10000}
          label="Suggest compacting above"
          inherit={`Inherit (${globalCompact})`}
          off={{ label: 'Never', restore: null }}
          onCommit={(v) => update({ compactSuggestTokens: v })}
        />
      )
    },
    {
      section: 'sessions',
      key: 'transcriptWarnMB',
      ...rowText('project.transcriptWarnMB'),
      modified: cfg.transcriptWarnMB !== null,
      render: () => (
        <NumberField
          value={cfg.transcriptWarnMB ?? null}
          min={1}
          max={2000}
          step={10}
          label="Warn when a transcript is over"
          inherit={`Inherit (${globalWarn})`}
          off={{ label: 'Never', restore: null }}
          onCommit={(v) => update({ transcriptWarnMB: v })}
        />
      )
    },
    {
      section: 'sessions',
      key: 'chime',
      ...rowText('project.chime'),
      modified: cfg.chime !== 'inherit',
      render: () => (
        <select className="select" value={cfg.chime} onChange={(e) => void update({ chime: e.target.value as ProjectConfig['chime'] })}>
          <option value="inherit">Inherit ({settings.notifications.chimeEnabled ? 'on' : 'off'})</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
      )
    },
    {
      section: 'storage',
      key: 'storage',
      ...rowText('project.storage'),
      wide: true,
      render: () => <StorageView path={project.path} />
    },
    {
      section: 'keys',
      key: 'keybindings',
      ...rowText('project.keybindings'),
      wide: true,
      render: () => <KeybindingsEditor project={project} />
    },
    {
      section: 'agents',
      key: 'agents',
      ...rowText('project.agents'),
      wide: true,
      render: () => <AgentList project={project} />
    },
    {
      section: 'agents',
      key: 'fileLocks',
      ...rowText('project.fileLocks'),
      desc: `${rowText('project.fileLocks').desc} Now: ${FILE_LOCK_MODES.find((m) => m.value === lockMode)?.description ?? lockMode}`,
      modified: cfg.fileLocks !== 'inherit',
      render: () => (
        <select className="select" value={cfg.fileLocks} onChange={(e) => void update({ fileLocks: e.target.value as ProjectConfig['fileLocks'] })}>
          <option value="inherit">Inherit ({globalLock?.label})</option>
          {FILE_LOCK_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      )
    },
    {
      section: 'agents',
      key: 'worktreeCopy',
      ...rowText('project.worktreeCopy'),
      modified: cfg.worktreeCopy !== null,
      render: () => (
        <DraftTextarea className="input mono" rows={3} value={cfg.worktreeCopy ?? ''} placeholder={`Inherit:\n${settings.agents.worktreeCopy}`} onCommit={(v) => void update({ worktreeCopy: v.trim() ? v : null })} />
      )
    },
    {
      section: 'agents',
      key: 'worktreeSetup',
      ...rowText('project.worktreeSetup'),
      modified: !!cfg.worktreeSetup,
      render: () => <DraftInput className="input mono" value={cfg.worktreeSetup} placeholder="npm install" onCommit={(v) => void update({ worktreeSetup: v.trim() })} />
    },
    {
      section: 'advanced',
      key: 'metadata',
      ...rowText('project.metadata'),
      render: () => (
        <button className="btn subtle" onClick={() => void call('app:openPath', `${project.path}\\.hive`)}>
          <Icon name="folder-opened" /> Open .hive folder
        </button>
      )
    },
    {
      section: 'advanced',
      key: 'reset',
      ...rowText('project.reset'),
      render: () => (
        <button
          className="btn subtle"
          onClick={async () => {
            if (await confirm({ title: 'Reset project settings?', message: 'The default provider, each provider’s model, effort, permission mode, context and extra arguments, the chime, the compact threshold, the transcript size warning, file locks and worktree setup go back to Inherit. Agents and skill and MCP opt-outs are kept.', confirmLabel: 'Reset' }))
              void update({ defaultProvider: 'inherit', providers: {}, chime: 'inherit', compactSuggestTokens: null, transcriptWarnMB: null, fileLocks: 'inherit', worktreeCopy: null, worktreeSetup: '' })
          }}
        >
          <Icon name="discard" /> Reset to defaults
        </button>
      )
    }
  ]

  const q = query.trim().toLowerCase()
  const visible = defs.filter((d) => (q ? `${d.title} ${d.desc} ${d.tip ?? ''} ${d.key}`.toLowerCase().includes(q) : d.section === section))
  const groups = PROJECT_SECTIONS.map((s) => ({ ...s, items: visible.filter((d) => d.section === s.id) })).filter((g) => g.items.length)

  return (
    <div className="settings">
      <div className="settings-top">
        <Icon name="search" />
        <input className="input" placeholder={`Search ${project.name} settings`} value={query} onChange={(e) => setQuery(e.target.value)} />
        <a
          className="muted"
          onClick={() => {
            set({ settingsSection: 'providers' })
            setActivity('settings')
          }}
        >
          Global settings
        </a>
      </div>
      <div className="settings-body">
        <div className="settings-nav">
          {PROJECT_SECTIONS.map((s) => (
            <div
              key={s.id}
              className={cx('row', !q && section === s.id && 'selected')}
              onClick={() => {
                setSection(s.id)
                setQuery('')
              }}
            >
              {s.provider ? <ProviderIcon provider={s.provider} /> : <Icon name={s.icon} />} <span className={cx('label', s.provider && 'settings-sub')}>{s.label}</span>
            </div>
          ))}
        </div>
        <div className="settings-content">
          {groups.length === 0 && <div className="empty-state">No settings match.</div>}
          {groups.map((g) => (
            <div key={g.id} className="settings-group">
              <h2>{g.label}</h2>
              <p>{g.desc}</p>
              {g.items.map((d) =>
                d.wide ? (
                  <div key={d.key} className="setting wide">
                    <div className="s-text">
                      <div className="s-title">{d.title}</div>
                      <div className="s-desc">{d.desc}</div>
                      {d.render()}
                    </div>
                  </div>
                ) : (
                  <SettingRow key={d.key} title={d.title} desc={d.desc} tip={d.tip} modified={d.modified}>
                    {d.render()}
                  </SettingRow>
                )
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
