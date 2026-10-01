import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KeybindingsEditor } from '../components/Keybindings'
import type { GitDiff, GitStatus, McpServerInfo, MemorySource, PlanLimit, ProjectConfig, ProjectInfo, ProviderId, SessionListItem, SessionUsage, SkillInfo } from '@shared/types'
import { dayOffset, localDay, usageFrom } from '@shared/usageDays'
import { FILE_LOCK_MODES, MAX_AGENTS, effectiveModelLabel, modelLabel } from '@shared/defaults'
import { PROVIDERS, isProviderEnabled, modeOption, offeredModes, permissionLabel, projectProviderConfig, providerDescriptor, providerName, providerSettings } from '@shared/providers'
import { ModelPicker } from '../components/ModelPicker'
import { ProviderIcon } from '../components/ProviderIcon'
import { confirmDangerousMode } from '../components/PermissionMode'
import * as actions from '../actions'
import { call, errorMessage } from '../api'
import { DocEditor } from '../components/DocEditor'
import { DiffView } from '../components/Editors'
import { PaneResizer, usePaneSize } from '../components/Resizer'
import { Icon, IconButton, InfoTip, STATUS_TEXT, StatusDot, Switch, Tooltip } from '../components/ui'
import { languageFor } from '../monacoLang'
import { addSkill, deleteSkill, editInWorkspace, otherLocal, SKILL_LEVEL_TIP, SkillDetail, SkillRow } from '../components/Skills'
import { RootSelector } from './FilesTab'
import { agentProviderOf, confirm, notify, set, setActivity, useFocusedAgent, useStore } from '../store'
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
export function useSessions(project: ProjectInfo) {
  const mode = useStore((s) => s.settings?.sessions.overviewRefresh ?? 'live')
  const usageVersion = useStore((s) => s.usageVersion[project.path] ?? 0)
  const [items, setItems] = useState<SessionListItem[] | null>(null)
  // Deleted sessions' usage: totals count it, lists don't show it.
  const [kept, setKept] = useState<SessionListItem[]>([])
  const [loadedAt, setLoadedAt] = useState(0)
  const last = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const load = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    last.current = Date.now()
    void Promise.all([call('session:list', project.path), call('session:keptUsage', project.path).catch(() => [])])
      .then(([list, deleted]) => {
        setItems(list)
        setKept(deleted)
        setLoadedAt(Date.now())
      })
      .catch((e) => {
        setItems([])
        notify('error', 'Could not load sessions', errorMessage(e))
      })
  }, [project.path])
  useEffect(() => {
    load()
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [load])
  // Live: a change (usage, or an agent starting or stopping) reloads, at most every LIVE_REFRESH_MS.
  const liveKey = `${usageVersion}|${project.agents.map((a) => `${a.live?.sessionId ?? ''}:${a.live?.status ?? ''}`).join(',')}`
  useEffect(() => {
    if (mode !== 'live' || !last.current) return
    const wait = last.current + LIVE_REFRESH_MS - Date.now()
    if (wait <= 0) load()
    else if (!timer.current) timer.current = setTimeout(load, wait)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey, mode])
  useEffect(() => {
    if (mode !== 'minute') return
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [mode, load])
  return { items, kept, reload: load, loadedAt }
}


function Card({ title, value, sub, tip, accent, children }: { title: string; value: React.ReactNode; sub?: React.ReactNode; tip?: string; accent?: boolean; children?: React.ReactNode }) {
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

export type Period = 'today' | 'week' | 'month' | 'all'
export const PERIODS: { value: Period; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: '7 days' },
  { value: 'month', label: '30 days' },
  { value: 'all', label: 'All time' }
]

/** A period's first local day (calendar days: "7 days" is today and the six before); null for all time. */
export function periodFrom(p: Period, now: number): string | null {
  if (p === 'all') return null
  return dayOffset(now, p === 'today' ? 0 : p === 'week' ? -6 : -29)
}

/** Sessions with activity in a period (on or after its first day). */
export function activeIn(list: SessionListItem[], fromDay: string | null): SessionListItem[] {
  if (!fromDay) return list
  return list.filter((s) => (s.usage ? usageFrom(s.usage, fromDay).active : localDay(s.lastActivity ?? s.lastActiveAt) >= fromDay))
}

export interface Totals {
  sessions: number
  prompts: number
  compactions: number
  input: number
  cached: number
  cacheWrite: number
  output: number
  cost: number
  /** Some of the cost is Hive's estimate. */
  estimated: boolean
  /** Sessions with no cost at all (no price known for their model). */
  unpriced: number
}

/** What sessions used, all of it or from a day on (only what happened then, a day at a time). */
export function sumUsage(list: SessionListItem[], fromDay: string | null = null): Totals {
  const t: Totals = { sessions: 0, prompts: 0, compactions: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, cost: 0, estimated: false, unpriced: 0 }
  for (const s of activeIn(list, fromDay)) {
    t.sessions++
    if (!s.usage) continue
    const u = usageFrom(s.usage, fromDay)
    t.prompts += u.prompts
    t.compactions += u.compactions
    t.input += u.inputTokens
    t.cached += u.cacheReadTokens
    t.cacheWrite += u.cacheWriteTokens
    t.output += u.outputTokens
    if (u.costUsd === null) t.unpriced++
    else {
      t.cost += u.costUsd
      if (u.costEstimated) t.estimated = true
    }
  }
  return t
}

/** Each day's tokens, cost and prompts across sessions, from `fromDay` to today (days without use included). */
export function dailyTotals(list: SessionListItem[], fromDay: string, now: number): { day: string; tokens: number; cost: number; estimated: boolean; prompts: number }[] {
  const out: { day: string; tokens: number; cost: number; estimated: boolean; prompts: number }[] = []
  for (let i = 0; ; i++) {
    const day = dayOffset(Date.parse(`${fromDay}T12:00:00`), i)
    if (day > localDay(now)) break
    out.push({ day, tokens: 0, cost: 0, estimated: false, prompts: 0 })
  }
  const byDay = new Map(out.map((d) => [d.day, d]))
  for (const s of list) {
    for (const [day, d] of Object.entries(s.usage?.days ?? {})) {
      const o = byDay.get(day)
      if (!o) continue
      o.tokens += d.inputTokens + d.outputTokens + d.cacheWriteTokens + d.cacheReadTokens
      o.prompts += d.prompts
      if (d.costUsd !== null) o.cost += d.costUsd
      if (d.costEstimated) o.estimated = true
    }
  }
  return out
}

/** A small bar per day (tokens), for the 7- and 30-day periods; hover a day for its numbers. */
export function DailyChart({ days }: { days: ReturnType<typeof dailyTotals> }) {
  const max = Math.max(1, ...days.map((d) => d.tokens))
  const label = (day: string): string => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  return (
    <div className="daily-chart" role="img" aria-label="Tokens per day">
      <div className="daily-bars">
        {days.map((d) => (
          <Tooltip key={d.day} content={`${label(d.day)}: ${formatTokens(d.tokens)} tokens · ${d.estimated ? '≈ ' : ''}${money(d.cost)} · ${d.prompts} prompt${d.prompts === 1 ? '' : 's'}`}>
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

export const money = (n: number): string => (n >= 100 ? `$${Math.round(n)}` : n > 0 && n < 0.01 ? '< $0.01' : `$${n.toFixed(2)}`)

/** The agent a session belongs to: its worktree's agent, else the agent recorded for it ('?' when none). */
function sessionAgent(project: ProjectInfo, s: SessionListItem): string {
  if (s.cwd && s.cwd.toLowerCase() !== project.path.toLowerCase()) return project.agents.find((a) => a.worktree?.path.toLowerCase() === s.cwd!.toLowerCase())?.id ?? '?'
  return s.agentId ?? '?'
}

/** The project's usage for a period: one summary, what runs now, each provider, each agent, then the focused agent's session. */
export function OverviewTab({ project }: { project: ProjectInfo }) {
  const { items, kept, reload, loadedAt } = useSessions(project)
  const settings = useStore((s) => s.settings)
  const [period, setPeriod] = useState<Period>('all')
  const now = useNow(60000)
  if (!items) return <div className="empty-state"><Icon name="loading" spin />Loading…</div>

  const from = periodFrom(period, now)
  const inPeriod = activeIn([...items.filter((i) => i.source === 'hive'), ...kept], from)
  const total = sumUsage(inPeriod, from)
  const running = project.agents.filter((a) => a.live && !a.live.settingUp)
  const used = new Set([...inPeriod.map((i) => i.provider), ...running.map((a) => a.live!.provider)])
  const providers = PROVIDERS.filter((p) => used.has(p.id) || isProviderEnabled(settings, p.id))
  const tokens = (t: Totals): number => t.input + t.cached + t.cacheWrite + t.output
  const costTip = 'What this work would have cost at API prices: reported by the provider where it does (Claude Code), else estimated by Hive from token counts and the prices in Settings → the provider. On a subscription you are not charged this; it shows how heavy the work was.'

  return (
    <div className="scroll-page">
      <div className="page-narrow">
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
        <p className="hint">What was used in the period across every provider, by calendar day: a session that ran over several days counts only its part in the period.</p>
        <div className="cards">
          <Card accent title="Tokens" value={formatTokens(tokens(total))} sub={`${formatTokens(total.input + total.cacheWrite)} in · ${formatTokens(total.cached)} cached · ${formatTokens(total.output)} out`} tip="All tokens: new input, cache writes, input read from cache, and output." />
          <Card
            title="API-equivalent cost"
            value={`${total.estimated ? '≈ ' : ''}${money(total.cost)}`}
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
                <Card title="API-equivalent cost" value={`${t.estimated ? '≈ ' : ''}${money(t.cost)}`} sub={t.unpriced ? `${t.unpriced} without a price` : !t.estimated ? 'as reported' : p.capabilities.reportsCost ? 'partly estimated' : 'estimated'} tip={costTip} />
                <Card title="Sessions" value={t.sessions} sub={`${formatNumber(t.prompts)} prompts`} />
              </div>
              <PlanLimits provider={p.id} />
            </div>
          )
        })}

        {project.agents.length > 1 && (
          <>
            <h2 className="section">By agent</h2>
            <table className="table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Provider</th>
                  <th className="num">Sessions</th>
                  <th className="num">Tokens</th>
                  <th className="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {project.agents.map((a) => {
                  const t = sumUsage(inPeriod.filter((i) => sessionAgent(project, i) === a.id), from)
                  const prov = agentProviderOf(project, a)
                  return (
                    <tr key={a.id}>
                      <td>{a.name}</td>
                      <td>
                        <ProviderIcon provider={prov} /> {providerName(prov)}
                      </td>
                      <td className="num">{t.sessions}</td>
                      <td className="num">{formatTokens(tokens(t))}</td>
                      <td className="num">{t.sessions ? `${t.estimated ? '≈ ' : ''}${money(t.cost)}` : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </>
        )}

        <SessionDetails project={project} items={items} />
      </div>
    </div>
  )
}

/** One running agent: provider, model, mode, status, context used and cost so far. */
function RunningAgent({ project, a }: { project: ProjectInfo; a: ProjectInfo['agents'][number] }) {
  const live = a.live!
  const usage = useLiveUsage(project, a.id)
  const window = usage?.contextWindow ?? null
  const ctx = usage?.contextTokens ?? 0
  const pct = window ? Math.min(100, (ctx / window) * 100) : null
  const cost = live.costUsd ?? usage?.costUsd ?? null
  const estimated = live.costUsd !== undefined ? !!live.costEstimated : !!usage?.costEstimated
  return (
    <div className="running-row">
      <StatusDot live={live} active={project.active} />
      <ProviderIcon provider={live.provider} />
      <div className="grow">
        <div>
          <strong>{a.name}</strong> <span className="faint">{live.statusMessage ?? STATUS_TEXT[live.status]}</span>
        </div>
        <div className="faint small">
          {[live.modelName ?? usage?.model ?? null, live.permissionMode ? permissionLabel(live.provider, live.permissionMode) : null, live.planMode ? 'Plan' : null].filter(Boolean).join(' · ')}
        </div>
      </div>
      <Tooltip content={window ? `${ctx.toLocaleString()} of ${window.toLocaleString()} tokens of context` : `${ctx.toLocaleString()} tokens of context`}>
        <div className="running-ctx">
          <span className="small">{formatTokens(ctx)} context{pct !== null ? ` · ${Math.round(pct)}%` : ''}</span>
          {pct !== null && (
            <div className={cx('meter', pct >= 90 ? 'danger' : pct >= 75 && 'caution')}>
              <div style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      </Tooltip>
      <span className="running-cost small">{cost !== null ? `${estimated ? '≈ ' : ''}${money(cost)}` : ''}</span>
    </div>
  )
}

/** The focused agent's running session, else the project's most recent one, in detail. */
function SessionDetails({ project, items }: { project: ProjectInfo; items: SessionListItem[] }) {
  const settings = useStore((s) => s.settings)
  const now = useNow(10000)
  const focused = useFocusedAgent(project)
  const liveState = focused?.live ?? project.live
  const current = useMemo(() => {
    if (liveState?.sessionId) return items.find((i) => i.id === liveState.sessionId) ?? null
    return items.find((i) => i.source === 'hive' && !i.archived) ?? null
  }, [items, liveState?.sessionId])
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
        <h2 className="section">
          {liveState ? 'Current session' : 'Most recent session'}
          {current && <span className="muted" style={{ fontWeight: 400 }}>— {current.name || current.title || current.id.slice(0, 8)} · {provider.name}</span>}
        </h2>
        {!u ? (
          <p className="hint">No session data yet. Start a session and its token use, cache and compaction history will appear here.</p>
        ) : (
          <>
            <div className="cards">
              <Card
                accent
                title="Context"
                value={formatTokens(u.contextTokens)}
                sub={`${formatNumber(u.contextTokens)} tokens in the last request`}
                tip="How many tokens the conversation currently occupies."
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
            </div>
            <table className="table" style={{ marginBottom: 20 }}>
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
                  <td>{u.firstActivity ? new Date(u.firstActivity).toLocaleString() : '—'}</td>
                </tr>
                <tr>
                  <td className="muted">Last activity</td>
                  <td>{u.lastActivity ? `${new Date(u.lastActivity).toLocaleString()} (${timeAgo(u.lastActivity)})` : '—'}</td>
                </tr>
                {u.lastPrompt && (
                  <tr>
                    <td className="muted">Last prompt</td>
                    <td style={{ whiteSpace: 'pre-wrap' }}>{u.lastPrompt.slice(0, 400)}</td>
                  </tr>
                )}
              </tbody>
            </table>
            {u.compactions.length > 0 && (
              <>
                <h2 className="section">Compaction history</h2>
                <table className="table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Trigger</th>
                      <th className="num">Before</th>
                      <th className="num">After</th>
                      <th className="num">Freed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {u.compactions.map((c, i) => (
                      <tr key={i}>
                        <td>{c.timestamp ? new Date(c.timestamp).toLocaleString() : '—'}</td>
                        <td>
                          <span className={cx('badge', c.trigger === 'auto' ? 'accent' : 'info')}>{c.trigger}</span>
                        </td>
                        <td className="num">{formatTokens(c.preTokens)}</td>
                        <td className="num">{formatTokens(c.postTokens)}</td>
                        <td className="num">{formatTokens(Math.max(0, c.preTokens - c.postTokens))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}
    </>
  )
}

/** One provider's subscription limits (account-wide), as its sessions last reported them. */
function PlanLimits({ provider }: { provider: ProviderId }) {
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
  const [diff, setDiff] = useState<GitDiff | null>(null)
  const [inline, setInline] = useState(false)
  // A worktree agent's changes are everything on its branch since it left its base branch.
  const agent = owner.agents.find((a) => a.id === rootId && a.worktree)
  const root = agent?.worktree?.path ?? owner.path
  const base = agent?.worktree?.base
  const project = agent ? { ...owner, path: root } : owner

  const load = useCallback(() => {
    void call('git:status', root, base).then((s) => {
      setStatus(s)
      setFile((f) => (f && s.files.some((x) => x.path === f) ? f : s.files[0]?.path ?? null))
    })
  }, [root, base])
  useEffect(load, [load, usageVersion])

  useEffect(() => {
    if (!file) return setDiff(null)
    void call('git:diff', root, file, base).then(setDiff).catch((e) => notify('error', 'Could not load diff', errorMessage(e)))
  }, [file, root, base, status])
  const selector = <RootSelector project={owner} value={rootId} onChange={(id) => set((s) => ({ changesRoot: { ...s.changesRoot, [owner.path]: id } }))} />

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
            {agent && <IconButton icon="git-merge" title={`Merge ${agent.name}'s work…`} onClick={() => set({ mergeFor: { project: owner.path, agentId: agent.id } })} />}
            <IconButton icon="refresh" title="Refresh" onClick={load} />
          </div>
        </div>
        {selector}
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
            <div className="editor-host">
              {diff.binary ? (
                <div className="empty-state">{diff.modified || 'Binary file — no text diff.'}</div>
              ) : (
                <DiffView original={diff.original} modified={diff.modified} language={languageFor(diff.path)} inline={inline} />
              )}
            </div>
          </>
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

export function MemoryTab({ project }: { project: ProjectInfo }) {
  const listWidth = usePaneSize('memory', 280)
  const [sources, setSources] = useState<MemorySource[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const load = useCallback(() => {
    void call('memory:list', project.path).then((s) => {
      setSources(s)
      const key = (x: MemorySource): string => `${x.provider}:${x.id}`
      setSelected((cur) => cur ?? (s.find((x) => x.exists) ?? s[0] ? key(s.find((x) => x.exists) ?? s[0]) : null))
    })
  }, [project.path])
  useEffect(load, [load])
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
        <div className="pane-body">
          {!shared && (
            <div className="memory-share">
              <Icon name="info" /> Each provider reads its own instructions file.
              <button className="btn subtle small" onClick={() => void share()}>
                Share one AGENTS.md…
              </button>
            </div>
          )}
          {groups.map(([title, list]) => (
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
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const load = useCallback(() => void call('skills:list', project.path).then(setSkills).catch(() => setSkills([])), [project.path])
  useEffect(load, [load, version])

  const providers = PROVIDERS.filter((p) => isProviderEnabled(settings, p.id))
  const ids = providers.map((p) => p.id)
  const all = skills ?? []
  const hive = all.filter((s) => s.level === 'hive')
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
        <div className="pane-body">
          {group('Hive', SKILL_LEVEL_TIP.hive, hive, undefined, 'No Hive skills in this workspace.')}
          {hive.map((sk) =>
            row(
              sk,
              <IconButton icon="go-to-file" title="Edit in the workspace's Skills view (Hive skills are shared by every project)" onClick={() => editInWorkspace(sk)} />
            )
          )}
          {providers.map((p) => {
            const mine = all.filter((sk) => sk.provider === p.id)
            const local = mine.filter((sk) => sk.level === 'local')
            const user = mine.filter((sk) => sk.level === 'machine')
            const plugin = mine.filter((sk) => sk.level === 'plugin')
            return (
              <div key={p.id} className="skill-provider">
                <div className="skill-provider-title">
                  <ProviderIcon provider={p.id} /> {p.name}
                </div>
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
              Select a skill to view it. <strong>Hive</strong> skills reach every agent and are edited in the workspace's Skills view; <strong>local</strong> skills belong to this project and one provider, and you can add, edit and delete them here.
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
  const [servers, setServers] = useState<McpServerInfo[]>([])
  const load = useCallback(() => void call('mcp:list').then(setServers), [])
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
        {servers.length === 0 ? (
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

type ProjectSection = 'agents' | 'sessions' | 'keys' | 'advanced' | `provider:${string}`

const PROJECT_SECTIONS: { id: ProjectSection; label: string; icon: string; desc: string; provider?: ProviderId }[] = [
  { id: 'agents', label: 'Agents & Worktrees', icon: 'organization', desc: 'The project’s agents and their providers, file locks between them, and how new worktrees are set up.' },
  ...PROVIDERS.map((p) => ({ id: `provider:${p.id}` as ProjectSection, label: p.name, icon: 'blank', provider: p.id, desc: `Model, effort and permissions for this project’s ${p.name} agents. Agents can override these for themselves.` })),
  { id: 'sessions', label: 'Sessions', icon: 'history', desc: 'Compacting and notifications for this project.' },
  { id: 'keys', label: 'Keyboard Shortcuts', icon: 'keyboard', desc: 'Shortcuts for project and session commands while this project is selected, over the global ones.' },
  { id: 'advanced', label: 'Advanced', icon: 'tools', desc: 'Where the settings are stored, and resetting them.' }
]

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
        const model = a.model ? modelLabel(a.model, provider) : effectiveModelLabel(provider, projectProviderConfig(cfg, provider).model, providerSettings(settings, provider).defaultModel, providers[provider]?.defaultModel ?? null)
        const overrides = [a.model && `model ${modelLabel(a.model, provider)}`, a.effort && `effort ${a.effort}`, a.permissionMode && permissionLabel(provider, a.permissionMode)].filter(Boolean)
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
            {a.worktree && <IconButton icon="git-merge" title="Merge…" onClick={() => set({ mergeFor: { project: project.path, agentId: a.id } })} />}
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
  const [section, setSection] = useState<ProjectSection>('agents')
  const [query, setQuery] = useState('')
  const cfg = project.config
  if (!settings) return null
  const update = async (patch: Partial<ProjectConfig>): Promise<void> => {
    await actions.attempt('Could not save project settings', () => call('project:updateConfig', project.path, patch))
    await actions.refreshWorkspace()
  }
  const globalLock = FILE_LOCK_MODES.find((m) => m.value === settings.agents.fileLocks)
  const lockMode = cfg.fileLocks === 'inherit' ? settings.agents.fileLocks : cfg.fileLocks
  const globalDefault = providerName(settings.defaultProvider)

  /** A project's model, effort, mode and arguments for one provider. */
  const providerDefs = (id: ProviderId): ProjectSettingDef[] => {
    const p = providerDescriptor(id)
    const pc = projectProviderConfig(cfg, id)
    const g = providerSettings(settings, id)
    const sect = `provider:${id}` as ProjectSection
    const save = (patch: Partial<typeof pc>): Promise<void> => actions.updateProjectProvider(project.path, id, patch)
    const globalModel = g.defaultModel ? modelLabel(g.defaultModel, id) : `${p.name} default`
    const globalEffort = g.defaultEffort ? p.effortLevels.find((l) => l.value === g.defaultEffort)?.label ?? g.defaultEffort : 'default'
    const modes = offeredModes(id, settings)
    const mode = pc.permissionMode === 'inherit' ? g.defaultPermissionMode : pc.permissionMode
    return [
      {
        section: sect,
        key: `${id}.model`,
        title: 'Model',
        desc: `Model for this project's ${p.name} agents. Inherit uses the global default (${globalModel}).`,
        tip: `Passed to ${p.name} when a session starts. Agents can choose their own.`,
        modified: pc.model !== 'inherit',
        render: () => <ModelPicker provider={id} value={pc.model} base={{ value: 'inherit', label: `Inherit (${globalModel})` }} onChange={(v) => void save({ model: v })} />
      },
      {
        section: sect,
        key: `${id}.effort`,
        title: 'Effort',
        desc: 'How much reasoning effort the model uses. Higher is more thorough but slower and uses more tokens.',
        tip: `Passed to ${p.name} when a session starts.`,
        modified: pc.effort !== 'inherit',
        render: () => (
          <select className="select" value={pc.effort} onChange={(e) => void save({ effort: e.target.value })}>
            <option value="inherit">Inherit ({globalEffort})</option>
            {p.effortLevels.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        )
      },
      {
        section: sect,
        key: `${id}.permissionMode`,
        title: 'Permission mode',
        desc: modeOption(id, mode)?.description ?? '',
        tip: `The mode sessions start in.${p.capabilities.liveModeSwitch === 'cycle' ? ' You can still switch modes inside a running session with Shift+Tab.' : ''}`,
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
      {
        section: sect,
        key: `${id}.extraArgs`,
        title: 'Extra arguments',
        desc: `Additional ${p.cliName} command-line arguments for this project, added after the global ones.`,
        tip: 'Split like a command line; quote arguments with spaces.',
        modified: !!pc.extraArgs,
        render: () => <DraftInput className="input mono" value={pc.extraArgs} placeholder="--add-dir ../lib" onCommit={(v) => void save({ extraArgs: v })} />
      }
    ]
  }

  const defs: ProjectSettingDef[] = [
    {
      section: 'agents',
      key: 'defaultProvider',
      title: 'Default provider',
      desc: `The provider Add Agent uses for this project's new agents (the dialog can choose another). Inherit uses the global default (${globalDefault}).`,
      tip: 'Each agent keeps the provider it was given; change it in the agent’s settings.',
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
      title: 'Suggest compacting above',
      desc: `Context size (tokens) at which Compact is highlighted for this project. Empty inherits the global value (${settings.sessions.compactSuggestTokens.toLocaleString()}); 0 never suggests it.`,
      tip: 'Only changes when the Compact button turns orange; compacting is always available once the agent has finished.',
      modified: cfg.compactSuggestTokens !== null,
      render: () => (
        <DraftInput
          className="input"
          type="number"
          min={0}
          step={10000}
          value={cfg.compactSuggestTokens === null ? '' : String(cfg.compactSuggestTokens)}
          placeholder={`Inherit (${settings.sessions.compactSuggestTokens.toLocaleString()})`}
          onCommit={(t) => {
            const v = t.trim() === '' ? null : Math.max(0, Math.round(Number(t)))
            if (v === null || Number.isFinite(v)) void update({ compactSuggestTokens: v })
          }}
        />
      )
    },
    {
      section: 'sessions',
      key: 'chime',
      title: 'Completion chime',
      desc: 'Play a sound when an agent in this project finishes or needs input.',
      tip: 'Inherit follows Settings → Notifications.',
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
      section: 'keys',
      key: 'keybindings',
      title: 'Shortcuts',
      desc: 'Change one to give this project its own; Reset returns it to the global shortcut. Stored in the project’s .hive folder, which is not committed.',
      wide: true,
      render: () => <KeybindingsEditor project={project} />
    },
    {
      section: 'agents',
      key: 'agents',
      title: 'Agents',
      desc: `Up to ${MAX_AGENTS} agents can work on the project at once, each in the project folder or its own worktree. Agents without their own settings use this project's.`,
      wide: true,
      render: () => <AgentList project={project} />
    },
    {
      section: 'agents',
      key: 'fileLocks',
      title: 'File locks',
      desc: FILE_LOCK_MODES.find((m) => m.value === lockMode)?.description ?? '',
      tip: 'Applies to agents sharing a folder (agents in their own worktrees never collide). An agent claims a file when it edits it and releases it when its turn ends. Edits made through shell commands are not covered.',
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
      title: 'Copy into new worktrees',
      desc: `Git-ignored files to copy from the project folder into a new worktree, such as .env files. One pattern per line; empty inherits the global list (${settings.agents.worktreeCopy.replace(/\n/g, ', ') || 'nothing'}).`,
      tip: 'A new worktree only gets the files git tracks. Patterns without a slash match a file or folder name anywhere (e.g. .env*); with a slash they match a path from the project root (e.g. config/local.json). Large folders such as node_modules are better recreated by the setup command.',
      modified: cfg.worktreeCopy !== null,
      render: () => (
        <DraftTextarea className="input mono" rows={3} value={cfg.worktreeCopy ?? ''} placeholder={`Inherit:\n${settings.agents.worktreeCopy}`} onCommit={(v) => void update({ worktreeCopy: v.trim() ? v : null })} />
      )
    },
    {
      section: 'agents',
      key: 'worktreeSetup',
      title: 'Setup command',
      desc: "Runs in a new worktree before its agent's first session, e.g. npm install. Its output shows in the agent's pane.",
      tip: 'Runs with cmd.exe in the worktree folder. If it fails, the pane offers to retry or to start the agent without it.',
      modified: !!cfg.worktreeSetup,
      render: () => <DraftInput className="input mono" value={cfg.worktreeSetup} placeholder="npm install" onCommit={(v) => void update({ worktreeSetup: v.trim() })} />
    },
    {
      section: 'advanced',
      key: 'metadata',
      title: 'Settings file',
      desc: `Stored in ${project.name}/.hive/project.json (excluded from git). Changes apply to new sessions; restart a running session to apply them.`,
      render: () => (
        <button className="btn subtle" onClick={() => void call('app:openPath', `${project.path}\\.hive`)}>
          <Icon name="folder-opened" /> Open .hive folder
        </button>
      )
    },
    {
      section: 'advanced',
      key: 'reset',
      title: 'Reset project settings',
      desc: 'Everything on this page goes back to Inherit. Agents, and skill and MCP opt-outs, are kept.',
      render: () => (
        <button
          className="btn subtle"
          onClick={async () => {
            if (await confirm({ title: 'Reset project settings?', message: 'The default provider, each provider’s model, effort, permission mode and extra arguments, the chime, the compact threshold, file locks and worktree setup go back to Inherit. Agents and skill and MCP opt-outs are kept.', confirmLabel: 'Reset' }))
              void update({ defaultProvider: 'inherit', providers: {}, chime: 'inherit', compactSuggestTokens: null, fileLocks: 'inherit', worktreeCopy: null, worktreeSetup: '' })
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
