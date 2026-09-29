import { useCallback, useEffect, useMemo, useState } from 'react'
import { KeybindingsEditor } from '../components/Keybindings'
import type { GitDiff, GitStatus, McpServerInfo, MemorySource, PermissionMode, PlanLimit, ProjectConfig, ProjectInfo, SessionListItem, SessionUsage, SkillInfo } from '@shared/types'
import { EFFORT_LEVELS, FILE_LOCK_MODES, MAIN_AGENT, MAX_AGENTS, PERMISSION_MODES, effectiveModelLabel, modelLabel, permissionLabel } from '@shared/defaults'
import { ModelPicker } from '../components/ModelPicker'
import * as actions from '../actions'
import { call, errorMessage } from '../api'
import { DocEditor } from '../components/DocEditor'
import { DiffView } from '../components/Editors'
import { PaneResizer, usePaneSize } from '../components/Resizer'
import { Icon, IconButton, InfoTip, StatusDot, Switch, Tooltip } from '../components/ui'
import { languageFor } from '../monacoLang'
import { SKILL_LEVEL_TIP } from '../components/Sidebar'
import { RootSelector } from './FilesTab'
import { confirm, notify, set, setActivity, useStore } from '../store'
import { cx, formatDuration, formatNumber, formatTokens, resetsIn, timeAgo } from '../util'
import { useNow } from '../usage'

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export function useSessions(project: ProjectInfo) {
  const usageVersion = useStore((s) => s.usageVersion[project.path] ?? 0)
  const [items, setItems] = useState<SessionListItem[] | null>(null)
  const load = useCallback(() => {
    void call('session:list', project.path)
      .then(setItems)
      .catch((e) => {
        setItems([])
        notify('error', 'Could not load sessions', errorMessage(e))
      })
  }, [project.path])
  useEffect(load, [load, usageVersion, project.live?.sessionId, project.live?.status])
  return { items, reload: load }
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

export function OverviewTab({ project }: { project: ProjectInfo }) {
  const { items } = useSessions(project)
  const settings = useStore((s) => s.settings)
  const now = useNow(10000)
  const current = useMemo(() => {
    if (!items) return null
    if (project.live) return items.find((i) => i.id === project.live!.sessionId) ?? null
    return items.find((i) => i.source === 'hive' && !i.archived) ?? null
  }, [items, project.live])
  const u: SessionUsage | null = current?.usage ?? null
  const hiveSessions = items?.filter((i) => i.source === 'hive') ?? []
  const totals = hiveSessions.reduce(
    (a, s) => ({
      input: a.input + (s.usage?.inputTokens ?? 0),
      output: a.output + (s.usage?.outputTokens ?? 0),
      cacheRead: a.cacheRead + (s.usage?.cacheReadTokens ?? 0),
      cacheWrite: a.cacheWrite + (s.usage?.cacheWriteTokens ?? 0)
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  )

  if (!items) return <div className="empty-state"><Icon name="loading" spin />Loading…</div>

  const ttl = u ? (settings?.sessions.cacheTtl === '5m' ? 300 : settings?.sessions.cacheTtl === '1h' ? 3600 : u.cacheTtlSeconds) : 300
  const elapsed = u?.lastActivity ? (now - Date.parse(u.lastActivity)) / 1000 : Infinity
  const warm = elapsed < ttl
  const totalIn = u ? u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens : 0
  const hitRate = u && totalIn ? Math.round((u.cacheReadTokens / totalIn) * 100) : 0
  const cost = (project.live && project.live.sessionId === current?.id ? project.live.costUsd : undefined) ?? u?.costUsd ?? null

  return (
    <div className="scroll-page">
      <div className="page-narrow">
        <h2 className="section">
          {project.live ? 'Current session' : 'Most recent session'}
          {current && <span className="muted" style={{ fontWeight: 400 }}>— {current.name || current.title || current.id.slice(0, 8)}</span>}
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
                tip="How many tokens the conversation currently occupies. This is what gets re-cached when a session resumes after the cache expires."
              />
              <Card
                title="Cache"
                value={warm ? 'Warm' : 'Expired'}
                sub={warm ? `≈ ${formatDuration(ttl - elapsed)} left of ${ttl === 3600 ? '1 h' : '5 min'} TTL` : `Last activity ${timeAgo(u.lastActivity)}`}
                tip="Anthropic's prompt cache keeps the conversation prefix for a limited time (5 minutes or 1 hour). While warm, each message reads the context cheaply from cache."
              />
              <Card
                title="Re-cache on resume"
                value={warm ? '—' : `≈ ${formatTokens(u.contextTokens)}`}
                sub={warm ? 'Cache is still warm' : 'tokens written to cache on the next message'}
                tip="Estimate: when the cache has expired, the first message after resuming writes the whole context to cache again. Archive and start a new session to avoid it."
              />
              <Card title="Compactions" value={u.compactions.length} sub={u.compactions.length ? `Last ${timeAgo(u.compactions[u.compactions.length - 1].timestamp)}` : 'None yet'} tip="Claude Code summarises the conversation when the context fills up. Each compaction frees space but loses detail." />
              <Card title="Output" value={formatTokens(u.outputTokens)} sub={`${u.requests} requests · ${u.userMessages} prompts`} />
              <Card title="Input" value={formatTokens(u.inputTokens + u.cacheWriteTokens + u.cacheReadTokens)} sub={`${hitRate}% read from cache`} tip="All input tokens: uncached input, cache writes and cache reads.">
                <div className="meter">
                  <div style={{ width: `${hitRate}%` }} />
                </div>
              </Card>
              <Card title="Cache writes" value={formatTokens(u.cacheWriteTokens)} sub="tokens written to cache" />
              <Card title="Cache reads" value={formatTokens(u.cacheReadTokens)} sub="tokens read from cache" />
              {cost !== null && (
                <Card
                  title="API-equivalent cost"
                  value={`${cost.toFixed(2)}`}
                  sub="this session, at API prices"
                  tip="What this session would have cost at Anthropic API prices, as Claude Code calculates it. On a Claude subscription you are not charged this; it shows how heavy the session has been."
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
                  <td className="muted">Claude Code version</td>
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
        <PlanUsageCards />
        <h2 className="section">All Hive sessions in this project</h2>
        <div className="cards">
          <Card title="Sessions" value={hiveSessions.length} sub={`${hiveSessions.filter((s) => s.archived).length} archived`} />
          <Card title="Output" value={formatTokens(totals.output)} sub="tokens, all sessions" />
          <Card title="Input" value={formatTokens(totals.input + totals.cacheRead + totals.cacheWrite)} sub={`${formatTokens(totals.cacheRead)} from cache`} />
        </div>
      </div>
    </div>
  )
}

/** The subscription's 5-hour and weekly limits (account-wide), as Claude Code last reported them. */
function PlanUsageCards() {
  const usage = useStore((s) => s.planUsage)
  useNow(60000)
  const card = (title: string, l: PlanLimit | null, tip: string): React.ReactNode =>
    l && (
      <Card title={title} value={`${Math.round(l.usedPercent)}%`} sub={l.resetsAt ? `used · resets ${resetsIn(l.resetsAt)}` : 'used'} tip={tip} accent={l.usedPercent >= 80}>
        <div className={cx('meter', l.usedPercent >= 95 ? 'danger' : l.usedPercent >= 80 && 'caution')}>
          <div style={{ width: `${Math.min(100, l.usedPercent)}%` }} />
        </div>
      </Card>
    )
  return (
    <>
      <h2 className="section">
        Plan usage
        {usage && <span className="muted" style={{ fontWeight: 400 }}>— as of {timeAgo(usage.updatedAt)}</span>}
      </h2>
      {usage && (usage.fiveHour || usage.sevenDay) ? (
        <div className="cards">
          {card('5-hour limit', usage.fiveHour, 'How much of your plan’s rolling 5-hour allowance is used, across all your Claude Code sessions (not just Hive).')}
          {card('Weekly limit', usage.sevenDay, 'How much of your plan’s weekly allowance is used, across all your Claude Code sessions.')}
        </div>
      ) : (
        <p className="hint">Claude Code reports your plan’s 5-hour and weekly limits while a session runs. They appear here after the next message in any session. Accounts that use an API key have no plan limits.</p>
      )}
    </>
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

const MEMORY_TIPS: Record<MemorySource['kind'], string> = {
  'claude-md': 'Project instructions Claude Code reads at the start of every session. Usually committed to git.',
  'local-md': 'Personal project instructions that are not committed.',
  'auto-memory': "Claude Code's own memory for this project — facts it chose to remember across sessions."
}

export function MemoryTab({ project }: { project: ProjectInfo }) {
  const listWidth = usePaneSize('memory', 280)
  const [sources, setSources] = useState<MemorySource[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const load = useCallback(() => {
    void call('memory:list', project.path).then((s) => {
      setSources(s)
      setSelected((cur) => cur ?? s.find((x) => x.exists)?.id ?? s[0]?.id ?? null)
    })
  }, [project.path])
  useEffect(load, [load])
  const sel = sources.find((s) => s.id === selected)
  const groups: [string, MemorySource[]][] = [
    ['Instructions', sources.filter((s) => s.kind !== 'auto-memory')],
    ['Auto memory', sources.filter((s) => s.kind === 'auto-memory')]
  ]
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
          {groups.map(([title, list]) => (
            <div key={title}>
              <div className="section-header" style={{ cursor: 'default' }}>{title}</div>
              {list.length === 0 && <div className="pane-empty" style={{ paddingTop: 6 }}>{title === 'Auto memory' ? 'Claude Code has not saved any memories for this project yet.' : ''}</div>}
              {list.map((s) => (
                <Tooltip block key={s.id} content={<span style={{ whiteSpace: 'pre-line' }}>{`${MEMORY_TIPS[s.kind]}\n${s.path}`}</span>}>
                  <div className={cx('row', selected === s.id && 'selected')} style={{ width: '100%' }} onClick={() => setSelected(s.id)}>
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
          createIfMissing={sel.exists ? undefined : `# ${project.name}\n\nInstructions for Claude Code in this project.\n`}
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
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const load = useCallback(() => void call('skills:list', project.path).then(setSkills), [project.path])
  useEffect(load, [load, version])
  const disabled = new Set(project.config.skills.disabled)
  const hive = skills.filter((s) => s.level === 'hive')
  const local = skills.filter((s) => s.level === 'local')
  const machine = skills.filter((s) => s.level === 'machine' || s.level === 'plugin')

  const toggle = async (name: string, enabled: boolean): Promise<void> => {
    await actions.attempt('Could not update skill', () => call('skills:setProject', project.path, name, enabled))
    await actions.refreshWorkspace()
  }
  const copy = async (s: SkillInfo): Promise<void> => {
    const r = await actions.attempt('Could not copy skill', () => call('skills:copyToWorkspace', s.path))
    if (r) notify('success', `Copied "${s.name}" to the workspace`, 'Enable it in Skills to use it. The local copy is still loaded by Claude Code until you remove it from .claude/skills.')
    load()
  }

  return (
    <div className="scroll-page">
      <div className="page-narrow">
        <h2 className="section">
          Hive skills <InfoTip text={SKILL_LEVEL_TIP.hive} />
        </h2>
        <ChangesApplyNote project={project} />
        {hive.length === 0 ? (
          <p className="hint">
            No Hive skills in this workspace. <a onClick={() => setActivity('skills')}>Manage skills</a>
          </p>
        ) : (
          <div className="toggle-list">
            {hive.map((s) => {
              const on = !!s.globallyEnabled && !disabled.has(s.name)
              return (
                <div key={s.name} className={cx('toggle-item', !s.globallyEnabled && 'disabled')}>
                  <Icon name="sparkle" />
                  <div className="ti-text">
                    <div className="ti-name">
                      {s.name} {!s.globallyEnabled && <span className="badge">disabled in workspace</span>}
                    </div>
                    <div className="ti-desc">{s.description}</div>
                  </div>
                  <Tooltip content={!s.globallyEnabled ? 'Enable this skill in the workspace first (Skills view).' : on ? 'On for this project. Click to turn off.' : 'Off for this project. Click to turn on.'}>
                    <Switch checked={on} disabled={!s.globallyEnabled} onChange={(v) => void toggle(s.name, v)} />
                  </Tooltip>
                </div>
              )
            })}
          </div>
        )}
        <h2 className="section">
          Local skills <InfoTip text={SKILL_LEVEL_TIP.local} />
        </h2>
        {local.length === 0 ? (
          <p className="hint">This project has no skills in .claude/skills.</p>
        ) : (
          <div className="toggle-list">
            {local.map((s) => (
              <div key={s.path} className="toggle-item">
                <Icon name="folder" />
                <div className="ti-text">
                  <div className="ti-name">
                    {s.name} <span className="badge">always on</span>
                  </div>
                  <div className="ti-desc">{s.description}</div>
                </div>
                <button className="btn small subtle" onClick={() => void copy(s)}>
                  <Icon name="cloud-upload" /> Copy to workspace
                </button>
              </div>
            ))}
          </div>
        )}
        <h2 className="section">
          Machine & plugin skills <InfoTip text={SKILL_LEVEL_TIP.machine} />
        </h2>
        <p className="hint">
          {machine.length} skill{machine.length === 1 ? '' : 's'} from your user profile and installed plugins are always available to Claude Code. <a onClick={() => setActivity('skills')}>View them</a>
        </p>
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
            <p className="hint">These servers are in the project's own .mcp.json. Hive starts sessions with only workspace servers, so they stay disabled until copied to the workspace.</p>
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

type ProjectSection = 'claude' | 'sessions' | 'agents' | 'keys' | 'advanced'

const PROJECT_SECTIONS: { id: ProjectSection; label: string; icon: string; desc: string }[] = [
  { id: 'claude', label: 'Claude Code', icon: 'hubot', desc: 'Model, effort and permissions for this project’s sessions. Agents can override these for themselves.' },
  { id: 'sessions', label: 'Sessions', icon: 'history', desc: 'Compacting and notifications for this project.' },
  { id: 'agents', label: 'Agents & Worktrees', icon: 'organization', desc: 'The project’s agents, file locks between them, and how new worktrees are set up.' },
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
  const claudeDefault = useStore((s) => s.agent?.defaultModel ?? null)
  const cfg = project.config
  return (
    <div className="agent-list">
      {project.agents.map((a) => {
        const model = a.model ? modelLabel(a.model) : effectiveModelLabel(cfg.model, settings?.claude.defaultModel ?? '', claudeDefault)
        const overrides = [a.model && `model ${modelLabel(a.model)}`, a.effort && `effort ${a.effort}`, a.permissionMode && permissionLabel(a.permissionMode)].filter(Boolean)
        return (
          <div key={a.id} className="agent-list-row">
            <StatusDot live={a.live} active={project.active} />
            <div className="grow">
              <div>
                <strong>{a.name}</strong>{' '}
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
            {a.id !== MAIN_AGENT && <IconButton icon="close" title="Remove agent…" onClick={() => void actions.removeAgent(project.path, a.id)} />}
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
  const [section, setSection] = useState<ProjectSection>('claude')
  const [query, setQuery] = useState('')
  const cfg = project.config
  if (!settings) return null
  const update = async (patch: Partial<ProjectConfig>): Promise<void> => {
    await actions.attempt('Could not save project settings', () => call('project:updateConfig', project.path, patch))
    await actions.refreshWorkspace()
  }
  const modes = PERMISSION_MODES.filter((m) => m.value !== 'bypassPermissions' || settings.claude.enableBypassOption)
  const defaultModeLabel = PERMISSION_MODES.find((m) => m.value === settings.claude.defaultPermissionMode)?.label
  const globalLock = FILE_LOCK_MODES.find((m) => m.value === settings.agents.fileLocks)
  const lockMode = cfg.fileLocks === 'inherit' ? settings.agents.fileLocks : cfg.fileLocks

  const setPermission = async (v: string): Promise<void> => {
    if (v === 'bypassPermissions') {
      const ok = await confirm({
        title: 'Use bypass permissions?',
        message: `Sessions in ${project.name} will run every command, edit and network call without asking.`,
        detail: 'Only use this for disposable work where mistakes cannot do harm. Running sessions keep their current mode until restarted.',
        confirmLabel: 'Enable bypass',
        danger: true
      })
      if (!ok) return
    }
    await update({ permissionMode: v as PermissionMode | 'inherit' })
  }

  const defs: ProjectSettingDef[] = [
    {
      section: 'claude',
      key: 'model',
      title: 'Model',
      desc: `Model for this project's sessions. Inherit uses the global default (${settings.claude.defaultModel ? modelLabel(settings.claude.defaultModel) : 'Claude Code default'}).`,
      tip: 'Passed to Claude Code as --model. Latest aliases always pick the newest model in that family; a pinned version stays on that model. 1M context uses the larger context window where the model has one.',
      modified: cfg.model !== 'inherit',
      render: () => <ModelPicker value={cfg.model} base={{ value: 'inherit', label: `Inherit (${settings.claude.defaultModel ? modelLabel(settings.claude.defaultModel) : 'Claude Code default'})` }} onChange={(v) => void update({ model: v })} />
    },
    {
      section: 'claude',
      key: 'effort',
      title: 'Effort',
      desc: 'How much reasoning effort the model uses. Higher is more thorough but slower and uses more tokens.',
      tip: 'Passed to Claude Code as --effort.',
      modified: cfg.effort !== 'inherit',
      render: () => (
        <select className="select" value={cfg.effort} onChange={(e) => void update({ effort: e.target.value as ProjectConfig['effort'] })}>
          <option value="inherit">Inherit ({settings.claude.defaultEffort || 'default'})</option>
          {EFFORT_LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      )
    },
    {
      section: 'claude',
      key: 'permissionMode',
      title: 'Permission mode',
      desc: PERMISSION_MODES.find((m) => m.value === (cfg.permissionMode === 'inherit' ? settings.claude.defaultPermissionMode : cfg.permissionMode))?.description ?? '',
      tip: 'The mode sessions start in. You can still switch modes inside a running session with Shift+Tab.',
      modified: cfg.permissionMode !== 'inherit',
      render: () => (
        <select className="select" value={cfg.permissionMode === 'bypassPermissions' && !settings.claude.enableBypassOption ? 'inherit' : cfg.permissionMode} onChange={(e) => void setPermission(e.target.value)}>
          <option value="inherit">Inherit ({defaultModeLabel})</option>
          {modes.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      )
    },
    {
      section: 'claude',
      key: 'extraArgs',
      title: 'Extra arguments',
      desc: 'Additional Claude Code command-line arguments for this project, added after the global ones.',
      tip: 'Example: --add-dir "../shared-lib"',
      modified: !!cfg.extraArgs,
      render: () => <DraftInput className="input mono" value={cfg.extraArgs} placeholder="--add-dir ../lib" onCommit={(v) => void update({ extraArgs: v })} />
    },
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
            if (await confirm({ title: 'Reset project settings?', message: 'Model, effort, permission mode, chime, extra arguments, the compact threshold, file locks and worktree setup go back to Inherit. Agents and skill and MCP opt-outs are kept.', confirmLabel: 'Reset' }))
              void update({ model: 'inherit', effort: 'inherit', permissionMode: 'inherit', chime: 'inherit', extraArgs: '', compactSuggestTokens: null, fileLocks: 'inherit', worktreeCopy: null, worktreeSetup: '' })
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
            set({ settingsSection: 'claude' })
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
              <Icon name={s.icon} /> <span className="label">{s.label}</span>
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
