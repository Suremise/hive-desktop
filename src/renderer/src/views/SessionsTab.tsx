import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ProjectInfo, SessionListItem, Transcript, TranscriptImageRef, TranscriptItem, TranscriptSearchResult, TranscriptTool } from '@shared/types'
import { TRANSCRIPT_WINDOW } from '@shared/defaults'
import { providerDescriptor, providerName } from '@shared/providers'
import { ProviderIcon } from '../components/ProviderIcon'
import * as actions from '../actions'
import { call, errorMessage } from '../api'
import { PaneResizer, usePaneSize } from '../components/Resizer'
import { Icon, IconButton, InfoTip, Markdown, Modal, Tooltip, useContextMenu } from '../components/ui'
import { confirm, notify, openInSessionsTab, prompt, revealAgent, set, setAssistantOpen, useStore } from '../store'
import { cx, formatDuration, formatTokens, sessionLabel, timeAgo } from '../util'
import { useSessions } from './ProjectTabs'

/**
 * Sessions tab: the project's sessions on the left and a read-only transcript on the right,
 * with search across one transcript or all of them. The Hive Assistant's conversations use it too
 * (`assistant`): its own words, Hive's conversations only, and its panel instead of an agent's pane.
 */

type Scope = 'this' | 'all'
type Jump = { sessionId: string; itemId: number; nonce: number }

const copyText = (text: string): void => void navigator.clipboard.writeText(text)

export function SessionsTab({ project, assistant = false }: { project: ProjectInfo; assistant?: boolean }) {
  const { items, reload } = useSessions(project)
  const listWidth = usePaneSize('sessions', 320)
  const [showArchived, setShowArchived] = useState(false)
  const [showExternal, setShowExternal] = useState(!assistant)
  const noun = assistant ? 'conversation' : 'session'
  const newOne = (): void => {
    void actions.newSession(project.path)
    if (assistant) setAssistantOpen(true)
  }
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<Scope>('this')
  const [results, setResults] = useState<TranscriptSearchResult[] | null>(null)
  const [jump, setJump] = useState<Jump | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // Running sessions of all the project's agents, by session id.
  const liveById = new Map(project.agents.filter((a) => a.live).map((a) => [a.live!.sessionId, a.live!]))
  const liveId = project.live?.sessionId
  const isLive = (id: string): boolean => liveById.has(id)
  const many = project.agents.length > 1
  const sessionName = (s: Pick<SessionListItem, 'name' | 'title' | 'id'>): string => sessionLabel(s, project.name)
  const resumeMenu = useContextMenu()

  // Opened on a session from elsewhere (e.g. clicking the session name above an agent's terminal).
  const jumpTo = useStore((s) => (s.sessionsJump?.project === project.path ? s.sessionsJump : null))
  useEffect(() => {
    if (!jumpTo) return
    setSelectedId(jumpTo.id)
    set({ sessionsJump: null })
  }, [jumpTo])

  const list = useMemo(() => (items ?? []).filter((i) => (showArchived || !i.archived || i.id === selectedId) && (showExternal || i.source === 'hive')), [items, showArchived, showExternal, selectedId])
  const selected = items?.find((i) => i.id === selectedId) ?? null

  // Start on the running session, or the most recent one.
  useEffect(() => {
    if (!items || (selectedId && items.some((i) => i.id === selectedId))) return
    setSelectedId(items.find((i) => i.id === liveId)?.id ?? items.find((i) => !i.archived)?.id ?? items[0]?.id ?? null)
  }, [items, selectedId, liveId])

  // Search as you type (debounced). "This session" searches the selected transcript.
  const q = query.trim()
  useEffect(() => {
    if (!q || (scope === 'this' && !selectedId)) {
      setResults(null)
      return
    }
    let cancelled = false
    const t = setTimeout(() => {
      void call('transcript:search', project.path, q, scope === 'this' ? selectedId : null)
        .then((r) => !cancelled && setResults(r))
        .catch(() => !cancelled && setResults([]))
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [q, scope, selectedId, project.path])

  const open = (sessionId: string, itemId?: number): void => {
    setSelectedId(sessionId)
    setJump(itemId === undefined ? null : { sessionId, itemId, nonce: Date.now() })
  }

  const rename = async (s: SessionListItem): Promise<void> => {
    const name = await prompt({ title: 'Rename session', initial: s.name || s.title || '', confirmLabel: 'Rename' })
    if (name === null) return
    await actions.attempt('Could not rename', () => call('session:rename', project.path, s.id, name))
    reload()
  }
  const remove = async (s: SessionListItem): Promise<void> => {
    const who = providerName(s.provider)
    const ok = await confirm({
      title: `Delete ${noun}?`,
      message: `Delete "${sessionName(s)}" from Hive?`,
      detail:
        s.source === 'hive'
          ? `Hive's copies of its transcript go to the Recycle Bin and it no longer shows here; what it used stays in the totals. ${who} keeps its own transcript, so ${who}'s own resume list still has it.`
          : `Hive stops listing it. ${who} keeps its transcript, so ${who}'s own resume list still has it.`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    const done = await actions.attempt(`Could not delete the ${noun}`, () => call('session:delete', project.path, s.id).then(() => true))
    if (done && selectedId === s.id) setSelectedId(null)
    reload()
  }
  const archive = async (s: SessionListItem, archived: boolean): Promise<void> => {
    if (archived && !(await confirm({ title: 'Archive session?', message: 'The transcript is preserved in .hive/archive and hidden from this list. You can unarchive it at any time.', confirmLabel: 'Archive' }))) return
    await actions.attempt('Could not archive', () => call('session:archive', project.path, s.id, archived))
    reload()
  }

  if (!items) return <div className="empty-state"><Icon name="loading" spin />Loading…</div>

  const byId = new Map(items.map((i) => [i.id, i]))
  const hitCount = results?.reduce((n, r) => n + r.hits.length, 0) ?? 0

  return (
    <div
      className="split"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
          e.preventDefault()
          searchRef.current?.focus()
          searchRef.current?.select()
        }
      }}
    >
      <div className="split-list sessions-list" style={{ width: listWidth }}>
        <PaneResizer paneKey="sessions" />
        <div className="pane-header" style={{ paddingLeft: 14 }}>
          {assistant ? 'Conversations' : 'Sessions'}
          <InfoTip
            text={
              assistant
                ? "Every conversation of this workspace's Hive Assistant. Select one to read it in full, including what came before each compaction."
                : "Every session of this project. Select one to read its transcript: the whole conversation, including what came before each compaction. Transcripts Claude Code has deleted are read from Hive's backup."
            }
          />
          <div className="actions">
            <IconButton icon="add" title={assistant ? 'New Conversation' : 'New Session'} onClick={newOne} />
            <IconButton icon="refresh" title="Refresh" onClick={reload} />
          </div>
        </div>
        <div className="files-filter">
          <Icon name="search" />
          <input
            ref={searchRef}
            className="input"
            placeholder={scope === 'this' ? `Search this ${assistant ? 'conversation' : 'transcript'}` : `Search all ${noun}s`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('')
              if (e.key === 'Enter' && results?.[0]?.hits[0]) open(results[0].sessionId, results[0].hits[0].itemId)
            }}
          />
          {query && <IconButton icon="close" title="Clear" onClick={() => setQuery('')} />}
        </div>
        <div className="sessions-scope">
          <div className="segmented">
            <button className={cx(scope === 'this' && 'active')} onClick={() => setScope('this')}>
              This {noun}
            </button>
            <button className={cx(scope === 'all' && 'active')} onClick={() => setScope('all')}>
              All {noun}s
            </button>
          </div>
          {q && results && <span className="faint">{hitCount === 0 ? 'No matches' : `${hitCount}${results.some((r) => r.more) ? '+' : ''} match${hitCount === 1 ? '' : 'es'}`}</span>}
        </div>
        {q && results ? (
          <div className="pane-body search-results">
            {results.map((r) => {
              const s = byId.get(r.sessionId)
              return (
                <div key={r.sessionId}>
                  {scope === 'all' && (
                    <div className="section-header" style={{ cursor: 'default' }}>
                      <span className="label">{s ? sessionName(s) : r.sessionId.slice(0, 8)}</span>
                      <span className="count">{r.hits.length}{r.more ? '+' : ''}</span>
                    </div>
                  )}
                  {r.hits.map((h) => (
                    <div key={h.itemId} className={cx('search-hit', selectedId === r.sessionId && jump?.itemId === h.itemId && 'selected')} onClick={() => open(r.sessionId, h.itemId)}>
                      <span className="hit-kind">{HIT_KIND[h.kind]}</span>
                      <Highlight text={h.snippet} query={q} />
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        ) : (
          <>
            <div className="sessions-filters">
              {!assistant && (
                <label className="flex muted">
                  <input type="checkbox" className="checkbox" checked={showExternal} onChange={(e) => setShowExternal(e.target.checked)} /> Started outside Hive
                </label>
              )}
              <label className="flex muted">
                <input type="checkbox" className="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Archived
              </label>
            </div>
            <div className="pane-body">
              {list.length === 0 && <div className="pane-empty">No {noun}s yet.</div>}
              {list.map((s) => (
                <SessionRow
                  key={s.id}
                  s={s}
                  name={sessionName(s)}
                  live={liveById.get(s.id)?.status ?? null}
                  agent={many || s.cwd ? agentLabel(project, s) : null}
                  selected={s.id === selectedId}
                  onClick={() => open(s.id)}
                  buttons={
                    <>
                      {s.source === 'hive' && <IconButton icon="tag" title="Rename" onClick={() => void rename(s)} />}
                      {!isLive(s.id) && <IconButton icon="trash" title={`Delete ${noun}`} onClick={() => void remove(s)} />}
                    </>
                  }
                />
              ))}
            </div>
          </>
        )}
      </div>
      <div className="split-main">
        {selected ? (
          <TranscriptView
            key={`${project.path}|${selected.id}`}
            project={project}
            session={selected}
            live={isLive(selected.id)}
            jump={jump?.sessionId === selected.id ? jump : null}
            query={q}
            toolbar={
              <>
                {selected.source === 'external' && (
                  <button className="btn small subtle" onClick={() => void actions.attempt('Could not adopt', () => call('session:adopt', project.path, selected.id)).then(reload)}>
                    Adopt
                  </button>
                )}
                {selected.source === 'hive' && <IconButton icon="tag" title="Rename" onClick={() => void rename(selected)} />}
                {selected.source === 'hive' && !isLive(selected.id) && (
                  <IconButton icon={selected.archived ? 'unarchive' : 'archive'} title={selected.archived ? 'Unarchive' : 'Archive'} onClick={() => void archive(selected, !selected.archived)} />
                )}
                {!isLive(selected.id) && <IconButton icon="trash" title={`Delete ${noun}`} onClick={() => void remove(selected)} />}
                {isLive(selected.id) && (() => {
                  const holder = project.agents.find((a) => a.live?.sessionId === selected.id)!
                  return (
                    <Tooltip content={assistant ? 'The Assistant is running this conversation. Show its panel.' : `This conversation is running in ${holder.name}. Show its terminal.`}>
                      <button className="btn small" onClick={() => (assistant ? setAssistantOpen(true) : revealAgent(project, holder.id))}>
                        <Icon name="terminal" /> Show{many ? ` ${holder.name}` : ''}
                      </button>
                    </Tooltip>
                  )
                })()}
                {!selected.archived && !isLive(selected.id) && (() => {
                  const agents = actions.agentsForSession(project, selected)
                  const target = actions.resumeTarget(project, selected)
                  const targetName = agents.find((a) => a.id === target)?.name
                  if (agents.length < 2) {
                    return (
                      <button className="btn small tint-amber" onClick={() => void actions.resumeSession(project.path, selected)}>
                        <Icon name="debug-continue" /> Resume
                      </button>
                    )
                  }
                  return (
                    <span className="split-btn">
                      <Tooltip content={targetName ? `Resume in ${targetName}` : 'Resume (adds an agent if none can run it)'}>
                        <button className="btn small tint-amber" onClick={() => void actions.resumeSession(project.path, selected)}>
                          <Icon name="debug-continue" /> Resume{targetName ? ` in ${targetName}` : ''}
                        </button>
                      </Tooltip>
                      <Tooltip content="Resume in another agent">
                        <button
                          className="btn small tint-amber split-caret"
                          aria-label="Resume in another agent"
                          onClick={(e) => {
                            const r = e.currentTarget.getBoundingClientRect()
                            resumeMenu.openAt(r.left, r.bottom + 2, [
                              { header: true, label: 'Resume in' },
                              ...agents.map((a) => ({
                                label: a.name,
                                icon: a.id === target ? 'debug-continue' : 'person',
                                detail: a.live ? `running — its current session stops first` : a.worktree ? `worktree · ${a.worktree.branch}` : 'project folder',
                                onClick: () => void actions.resumeSession(project.path, selected, a.id)
                              }))
                            ])
                          }}
                        >
                          <Icon name="chevron-down" />
                        </button>
                      </Tooltip>
                      {resumeMenu.element}
                    </span>
                  )
                })()}
              </>
            }
          />
        ) : (
          <div className="empty-state">
            <Icon name="history" />
            {items.length ? 'Select a session to read its transcript.' : 'No sessions yet.'}
          </div>
        )}
      </div>
    </div>
  )
}

const HIT_KIND: Record<TranscriptItem['kind'], string> = {
  user: 'You',
  assistant: 'Reply',
  thinking: 'Thinking',
  tool: 'Tool',
  compaction: 'Summary',
  command: 'Command',
  notice: 'Notice'
}

function Highlight({ text, query }: { text: string; query: string }) {
  const at = text.toLowerCase().indexOf(query.toLowerCase())
  if (!query || at === -1) return <span className="hit-text">{text}</span>
  return (
    <span className="hit-text">
      {text.slice(0, at)}
      <mark>{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </span>
  )
}

/** Which agent ran a session: its worktree's agent, else the agent recorded for it (null when it no longer exists). */
function agentLabel(project: ProjectInfo, s: SessionListItem): string | null {
  if (s.source !== 'hive') return null
  if (s.cwd && s.cwd.toLowerCase() !== project.path.toLowerCase()) {
    const a = project.agents.find((x) => x.worktree?.path.toLowerCase() === s.cwd!.toLowerCase())
    return a ? `${a.name} · ${s.branch ?? a.worktree!.branch}` : s.branch ?? 'worktree'
  }
  return project.agents.find((a) => a.id === s.agentId)?.name ?? null
}

function SessionRow({ s, name, live, agent, selected, onClick, buttons }: { s: SessionListItem; name: string; live: string | null; agent: string | null; selected: boolean; onClick: () => void; buttons: React.ReactNode }) {
  return (
    <div className={cx('session-row', selected && 'selected', s.archived && 'archived')} onClick={onClick}>
      <div className="session-row-title">
        {live && <span className={cx('dot', live)} />}
        <Tooltip content={providerName(s.provider)}>
          <span>
            <ProviderIcon provider={s.provider} />
          </span>
        </Tooltip>
        <strong>{name}</strong>
      </div>
      <div className="session-row-meta">
        <span>{timeAgo(s.lastActivity)}</span>
        {s.usage && <span>{formatTokens(s.usage.contextTokens)} context</span>}
        {agent && <span className="badge">{agent}</span>}
        {s.source === 'external' && (
          <Tooltip content="Started outside Hive (e.g. in VS Code or a terminal). Adopt it to manage it here.">
            <span className="badge info">external</span>
          </Tooltip>
        )}
        {s.archived && <span className="badge">archived</span>}
        {!s.hasTranscript && s.hasBackup && (
          <Tooltip content={`${providerName(s.provider)} no longer has this transcript; Hive shows and resumes it from its backup.`}>
            <span className="badge warn">backup</span>
          </Tooltip>
        )}
      </div>
      <div className="row-actions" onClick={(e) => e.stopPropagation()}>
        {buttons}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Transcript viewer
// ---------------------------------------------------------------------------

/** Items grouped the way they are read: your message, then everything the agent did in reply. */
type Block =
  | { kind: 'user'; item: Extract<TranscriptItem, { kind: 'user' }> }
  | { kind: 'reply'; items: TranscriptItem[] }
  | { kind: 'other'; item: TranscriptItem }

function toBlocks(items: TranscriptItem[]): Block[] {
  const out: Block[] = []
  for (const item of items) {
    if (item.kind === 'user') out.push({ kind: 'user', item })
    else if (item.kind === 'assistant' || item.kind === 'thinking' || item.kind === 'tool') {
      const last = out[out.length - 1]
      if (last?.kind === 'reply') last.items.push(item)
      else out.push({ kind: 'reply', items: [item] })
    } else out.push({ kind: 'other', item })
  }
  return out
}

const time = (ts: string | null): string => (ts ? new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')

function TranscriptView({ project, session, live, jump, query, toolbar }: { project: ProjectInfo; session: SessionListItem; live: boolean; jump: Jump | null; query: string; toolbar: React.ReactNode }) {
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())
  const [allOpen, setAllOpen] = useState(false)
  const [viewing, setViewing] = useState<TranscriptImageRef | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const sizeRef = useRef<number | undefined>(undefined)
  /** The first item loaded: the latest TRANSCRIPT_WINDOW open first, earlier ones load as you scroll up. */
  const fromRef = useRef<number | undefined>(undefined)
  /** Scrolling up loaded earlier items: keep the view where it was (distance from the bottom). */
  const keepBottom = useRef<number | null>(null)
  const loadingEarlier = useRef(false)
  /** Whether the view follows the end of the transcript. */
  const pinned = useRef(jump === null)
  const followDefault = useStore((s) => s.settings?.sessions.followTranscripts ?? false)
  // A running session is followed only when switched on (Follow), else it updates with Refresh.
  const [follow, setFollow] = useState(followDefault)

  const load = useCallback(
    async (opts: { from?: number; force?: boolean } = {}) => {
      try {
        const from = opts.from ?? fromRef.current
        const same = from === fromRef.current && !opts.force
        const t = await call('transcript:read', project.path, session.id, { knownSize: same ? sizeRef.current : undefined, from })
        if (!t) return
        sizeRef.current = t.size
        fromRef.current = t.from
        setTranscript(t)
        setError(null)
      } catch (e) {
        setError(errorMessage(e))
      }
    },
    [project.path, session.id]
  )

  useEffect(() => {
    fromRef.current = undefined
    sizeRef.current = undefined
    void load()
  }, [load])
  // Follow a running session as its CLI appends to it (when switched on).
  useEffect(() => {
    if (!live || !follow) return
    void load()
    const t = setInterval(() => void load(), 2000)
    return () => clearInterval(t)
  }, [live, follow, load])

  /** Loads the TRANSCRIPT_WINDOW items before the first one shown, keeping the view where it is. */
  const loadEarlier = useCallback(async () => {
    const el = scroller.current
    const from = fromRef.current ?? 0
    if (!el || from <= 0 || loadingEarlier.current) return
    loadingEarlier.current = true
    keepBottom.current = el.scrollHeight - el.scrollTop
    await load({ from: Math.max(0, from - TRANSCRIPT_WINDOW) })
    loadingEarlier.current = false
  }, [load])

  // Open at the latest message and stay there while new messages arrive, unless you scroll up.
  // Blocks off screen are laid out lazily with estimated heights that settle as they render, so
  // the body is watched for size changes rather than scrolled once.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !transcript) return
    if (keepBottom.current !== null) {
      el.scrollTop = el.scrollHeight - keepBottom.current
      keepBottom.current = null
    } else if (pinned.current) el.scrollTop = el.scrollHeight
  }, [transcript])
  const hasTranscript = transcript !== null
  useEffect(() => {
    const el = scroller.current
    const body = el?.firstElementChild
    if (!el || !body) return
    const ro = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(body)
    return () => ro.disconnect()
  }, [hasTranscript])

  // Jump to a search hit: expand it if it's collapsed, then scroll it into the middle.
  useEffect(() => {
    if (!jump || !transcript) return
    // A hit before the loaded items: load from a little before it first.
    if (jump.itemId < transcript.from) {
      void load({ from: Math.max(0, jump.itemId - 50) })
      return
    }
    // Runs for a new jump, or once its items have loaded — not on every transcript update (it would scroll back).
    pinned.current = false
    setExpanded((s) => new Set(s).add(jump.itemId))
    let frames = 0
    const go = (): void => {
      const el = document.getElementById(`tx-${jump.itemId}`)
      el?.scrollIntoView({ block: 'center' })
      // Blocks around it render lazily and can shift it, so settle for a few frames.
      if (++frames < 4) requestAnimationFrame(go)
      else if (el) {
        el.classList.remove('flash')
        void el.offsetWidth
        el.classList.add('flash')
      }
    }
    requestAnimationFrame(go)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump, hasTranscript, transcript?.from])

  // Highlight the search text everywhere it's rendered (CSS Custom Highlight API).
  useEffect(() => {
    const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
    const H = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight
    if (!reg || !H) return
    const root = scroller.current
    if (!query || !root) {
      reg.delete('hive-search')
      return
    }
    const ranges: Range[] = []
    const q = query.toLowerCase()
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n && ranges.length < 2000; n = walker.nextNode()) {
      const text = n.textContent?.toLowerCase() ?? ''
      for (let at = text.indexOf(q); at !== -1; at = text.indexOf(q, at + q.length)) {
        const r = new Range()
        r.setStart(n, at)
        r.setEnd(n, at + q.length)
        ranges.push(r)
      }
    }
    reg.set('hive-search', new H(...ranges))
    return () => void reg.delete('hive-search')
  })

  const blocks = useMemo(() => (transcript ? toBlocks(transcript.items) : []), [transcript])
  const images = useMemo(() => transcript?.items.flatMap((i) => (i.kind === 'user' ? i.images : i.kind === 'tool' ? i.tool.images : [])) ?? [], [transcript])
  const toggle = useCallback((id: number) => setExpanded((s) => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    return n
  }), [])
  const isOpen = (id: number): boolean => allOpen !== expanded.has(id)

  const u = session.usage
  const exportMd = async (): Promise<void> => {
    const path = await actions.attempt('Could not export', () => call('transcript:export', project.path, session.id, sessionLabel(session, project.name)))
    if (path) notify('success', 'Transcript exported', path)
  }

  return (
    <>
      <div className="editor-toolbar transcript-toolbar">
        <Icon name="comment-discussion" />
        <span className="path">
          <strong>{sessionLabel(session, project.name)}</strong>
          {live && <span className="badge accent" style={{ marginLeft: 8 }}>Running</span>}
          {session.handedOverFrom && (
            <Tooltip content="Another agent's work was handed over to this session. Click to open that session.">
              <span className="badge link" style={{ marginLeft: 8 }} onClick={() => openInSessionsTab(project.path, session.handedOverFrom!)}>
                <Icon name="arrow-swap" /> handed over
              </span>
            </Tooltip>
          )}
          {u && (
            <span className="faint" style={{ marginLeft: 8 }}>
              {formatTokens(u.contextTokens)} context · {formatTokens(u.outputTokens)} output · {u.userMessages} prompt{u.userMessages === 1 ? '' : 's'}
              {u.compactions.length > 0 && ` · ${u.compactions.length} compaction${u.compactions.length === 1 ? '' : 's'}`}
              {session.recache && (session.recache.warm ? ` · cache warm ${formatDuration(session.recache.secondsLeft)}` : ' · cache expired')}
            </span>
          )}
        </span>
        <IconButton icon={allOpen ? 'collapse-all' : 'expand-all'} title={allOpen ? 'Collapse Tool Calls' : 'Expand Tool Calls'} onClick={() => {
          setAllOpen(!allOpen)
          setExpanded(new Set())
        }} />
        <IconButton icon="export" title="Export as Markdown…" disabled={!transcript} onClick={() => void exportMd()} />
        {live && (
          <Tooltip content={follow ? 'Following new messages as they arrive. Click to stop.' : 'Follow new messages as they arrive (Settings → Sessions sets the default)'}>
            <button className={cx('btn small subtle', follow && 'active')} onClick={() => setFollow(!follow)}>
              <Icon name={follow ? 'eye' : 'eye-closed'} /> Follow
            </button>
          </Tooltip>
        )}
        {!follow && <IconButton icon="refresh" title="Refresh (load new messages)" onClick={() => void load({ force: true })} />}
        {toolbar}
      </div>
      <WorkedOn cards={session.cards} />
      <div
        className="transcript"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
          if (el.scrollTop < 200) void loadEarlier()
        }}
      >
        {error ? (
          <div className="empty-state">{/no transcript/i.test(error) ? 'Nothing has been said in this session yet.' : error}</div>
        ) : !transcript ? (
          <div className="empty-state"><Icon name="loading" spin />Loading…</div>
        ) : blocks.length === 0 ? (
          <div className="empty-state">Nothing has been said in this session yet.</div>
        ) : (
          <div className="transcript-body">
            {transcript.from > 0 && (
              <div className="transcript-earlier faint">
                <button className="btn small subtle" onClick={() => void loadEarlier()}>
                  <Icon name="fold-up" /> {transcript.from} earlier item{transcript.from === 1 ? '' : 's'} — scroll up or click to load
                </button>
              </div>
            )}
            {blocks.map((b) =>
              b.kind === 'user' ? (
                <UserMessage key={b.item.id} item={b.item} project={project} sessionId={session.id} onImage={setViewing} />
              ) : b.kind === 'reply' ? (
                <Reply key={b.items[0].id} items={b.items} project={project} sessionId={session.id} assistant={providerDescriptor(session.provider).assistant} isOpen={isOpen} toggle={toggle} onImage={setViewing} />
              ) : (
                <OtherItem key={b.item.id} item={b.item} open={isOpen(b.item.id)} toggle={toggle} />
              )
            )}
            {live && follow && <div className="transcript-live faint"><Icon name="loading" spin /> Following the running session</div>}
          </div>
        )}
      </div>
      {viewing && <TranscriptImageViewer project={project} sessionId={session.id} image={viewing} images={images} onNavigate={setViewing} onClose={() => setViewing(null)} />}
    </>
  )
}

function CopyButton({ text, title = 'Copy' }: { text: string; title?: string }) {
  const [done, setDone] = useState(false)
  return (
    <IconButton
      icon={done ? 'check' : 'copy'}
      title={title}
      onClick={() => {
        copyText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    />
  )
}

const MemoMarkdown = memo(Markdown)

const UserMessage = memo(function UserMessage({ item, project, sessionId, onImage }: { item: Extract<TranscriptItem, { kind: 'user' }>; project: ProjectInfo; sessionId: string; onImage: (img: TranscriptImageRef) => void }) {
  return (
    <div className="tx-block tx-user" id={`tx-${item.id}`}>
      <div className="tx-head">
        <Icon name="person" />
        <strong>You</strong>
        <span className="faint">{time(item.timestamp)}</span>
        <div className="tx-actions">
          <CopyButton text={item.text} title="Copy Message" />
        </div>
      </div>
      {item.text.trim() && <div className="tx-user-text">{item.text}</div>}
      {item.images.length > 0 && (
        <div className="tx-images">
          {item.images.map((img) => (
            <TranscriptThumb key={img.id} project={project} sessionId={sessionId} image={img} onOpen={onImage} />
          ))}
        </div>
      )}
    </div>
  )
})

function Reply({ items, project, sessionId, assistant, isOpen, toggle, onImage }: { items: TranscriptItem[]; project: ProjectInfo; sessionId: string; assistant: string; isOpen: (id: number) => boolean; toggle: (id: number) => void; onImage: (img: TranscriptImageRef) => void }) {
  return (
    <div className="tx-block tx-reply">
      <div className="tx-head">
        <Icon name="sparkle" />
        <strong>{assistant}</strong>
        <span className="faint">{time(items[0].timestamp)}</span>
      </div>
      {items.map((item) =>
        item.kind === 'assistant' ? (
          <div key={item.id} id={`tx-${item.id}`} className="tx-text">
            <div className="tx-actions">
              <CopyButton text={item.text} title="Copy Reply" />
            </div>
            <MemoMarkdown source={item.text} />
          </div>
        ) : item.kind === 'thinking' ? (
          <Collapsible key={item.id} id={item.id} open={isOpen(item.id)} toggle={toggle} icon="lightbulb" label="Thinking" className="tx-thinking">
            <div className="tx-pre">{item.text}</div>
          </Collapsible>
        ) : item.kind === 'tool' ? (
          <ToolCall key={item.id} id={item.id} tool={item.tool} open={isOpen(item.id)} toggle={toggle} project={project} sessionId={sessionId} onImage={onImage} />
        ) : null
      )}
    </div>
  )
}

function Collapsible({ id, open, toggle, icon, label, detail, badge, className, children }: { id: number; open: boolean; toggle: (id: number) => void; icon: string; label: React.ReactNode; detail?: string; badge?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <div className={cx('tx-fold', open && 'open', className)} id={`tx-${id}`}>
      <div className="tx-fold-head" onClick={() => toggle(id)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        <Icon name={icon} />
        <span className="tx-fold-label">{label}</span>
        {detail && <span className="tx-fold-detail">{detail}</span>}
        {badge}
      </div>
      {open && <div className="tx-fold-body">{children}</div>}
    </div>
  )
}

const TOOL_ICON: Record<string, string> = { Bash: 'terminal', PowerShell: 'terminal', Read: 'go-to-file', Edit: 'edit', MultiEdit: 'edit', Write: 'edit', Glob: 'search', Grep: 'search', Agent: 'hubot', Task: 'hubot', WebFetch: 'globe', WebSearch: 'globe' }

function ToolCall({ id, tool, open, toggle, project, sessionId, onImage }: { id: number; tool: TranscriptTool; open: boolean; toggle: (id: number) => void; project: ProjectInfo; sessionId: string; onImage: (img: TranscriptImageRef) => void }) {
  const [full, setFull] = useState<TranscriptTool | null>(null)
  const t = full ?? tool
  const truncated = !full && (tool.inputLength !== undefined || tool.resultLength !== undefined)
  return (
    <Collapsible
      id={id}
      open={open}
      toggle={toggle}
      icon={TOOL_ICON[tool.name] ?? (tool.name.includes(' · ') ? 'plug' : 'tools')}
      label={tool.name}
      detail={tool.summary}
      badge={tool.isError ? <span className="badge error">error</span> : tool.result === null ? <span className="badge">no result</span> : null}
      className="tx-tool"
    >
      <div className="tx-io-label">
        Input <CopyButton text={t.input} title="Copy Input" />
      </div>
      <div className="tx-pre">{t.input}</div>
      {t.result !== null && (
        <>
          <div className="tx-io-label">
            {t.isError ? 'Error' : 'Result'} <CopyButton text={t.result} title="Copy Result" />
          </div>
          <div className={cx('tx-pre tx-result', t.isError && 'error')}>{t.result || <span className="faint">(empty)</span>}</div>
        </>
      )}
      {truncated && (
        <button className="btn small subtle" style={{ marginTop: 6 }} onClick={() => void actions.attempt('Could not load the tool call', () => call('transcript:tool', project.path, sessionId, id)).then((f) => f && setFull(f))}>
          Show all ({((tool.inputLength ?? 0) + (tool.resultLength ?? 0)).toLocaleString()} characters)
        </button>
      )}
      {t.images.length > 0 && (
        <div className="tx-images">
          {t.images.map((img) => (
            <TranscriptThumb key={img.id} project={project} sessionId={sessionId} image={img} onOpen={onImage} />
          ))}
        </div>
      )}
    </Collapsible>
  )
}

function OtherItem({ item, open, toggle }: { item: TranscriptItem; open: boolean; toggle: (id: number) => void }) {
  if (item.kind === 'compaction') {
    const freed = Math.max(0, item.preTokens - item.postTokens)
    return (
      <div className={cx('tx-compaction', open && 'open')} id={`tx-${item.id}`}>
        <div className="tx-compaction-line" onClick={() => item.summary && toggle(item.id)}>
          <span className="rule" />
          <span className="tx-compaction-label">
            <Icon name="fold" /> Conversation compacted <span className={cx('badge', item.trigger === 'auto' ? 'accent' : 'info')}>{item.trigger}</span>
            <span className="faint">
              {formatTokens(item.preTokens)} → {formatTokens(item.postTokens)}
              {item.nextRequestTokens !== null && ` (${formatTokens(item.nextRequestTokens)} with instructions)`} · freed {formatTokens(freed)} · {time(item.timestamp)}
            </span>
            {item.summary && <Icon name={open ? 'chevron-down' : 'chevron-right'} />}
          </span>
          <span className="rule" />
        </div>
        {open && item.summary && (
          <div className="tx-compaction-summary">
            <div className="tx-actions">
              <CopyButton text={item.summary} title="Copy Summary" />
            </div>
            <MemoMarkdown source={item.summary} />
          </div>
        )}
      </div>
    )
  }
  if (item.kind === 'command') {
    return (
      <div className="tx-command" id={`tx-${item.id}`}>
        <div className="tx-command-line">
          <Icon name="terminal-cmd" />
          <code>{item.name === '!' ? `! ${item.args}` : `${item.name}${item.args ? ` ${item.args}` : ''}`}</code>
          <span className="faint">{time(item.timestamp)}</span>
        </div>
        {item.output && <div className="tx-pre tx-command-output">{item.output}</div>}
      </div>
    )
  }
  if (item.kind === 'notice') {
    return (
      <div className={cx('tx-notice', item.level === 'error' && 'error')} id={`tx-${item.id}`}>
        <Icon name={item.level === 'error' ? 'warning' : 'info'} /> {item.text}
      </div>
    )
  }
  return null
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const imageCache = new Map<string, string>()

function useTranscriptImage(project: ProjectInfo, sessionId: string, id: number, enabled = true): string | null {
  const key = `${project.path}|${sessionId}|${id}`
  const [src, setSrc] = useState<string | null>(imageCache.get(key) ?? null)
  useEffect(() => {
    if (!enabled || imageCache.has(key)) {
      setSrc(imageCache.get(key) ?? null)
      return
    }
    let cancelled = false
    void call('transcript:image', project.path, sessionId, id)
      .then((url) => {
        imageCache.set(key, url)
        if (!cancelled) setSrc(url)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [key, enabled, project.path, sessionId, id])
  return src
}

function TranscriptThumb({ project, sessionId, image, onOpen }: { project: ProjectInfo; sessionId: string; image: TranscriptImageRef; onOpen: (img: TranscriptImageRef) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: '400px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  const src = useTranscriptImage(project, sessionId, image.id, visible)
  return (
    <div className="thumb" ref={ref} onClick={() => onOpen(image)} title={image.path ?? 'Image'}>
      {src ? <img src={src} alt="" draggable={false} /> : <Icon name="file-media" />}
    </div>
  )
}

function TranscriptImageViewer({ project, sessionId, image, images, onNavigate, onClose }: { project: ProjectInfo; sessionId: string; image: TranscriptImageRef; images: TranscriptImageRef[]; onNavigate: (img: TranscriptImageRef) => void; onClose: () => void }) {
  const src = useTranscriptImage(project, sessionId, image.id)
  const i = images.findIndex((x) => x.id === image.id)
  const prev = images[i - 1]
  const next = images[i + 1]
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowLeft' && prev) onNavigate(prev)
      else if (e.key === 'ArrowRight' && next) onNavigate(next)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prev, next, onNavigate])
  return (
    <Modal
      title={image.path ? image.path.split(/[\\/]/).pop()! : 'Image'}
      icon="file-media"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="faint" style={{ marginRight: 'auto' }}>
            {i + 1} of {images.length}
          </span>
          {image.path && (
            <>
              <button className="btn subtle" onClick={() => void call('app:showInFolder', image.path!)}>
                <Icon name="folder-opened" /> Reveal
              </button>
              <button className="btn subtle" onClick={() => copyText(image.path!)}>
                Copy Path
              </button>
            </>
          )}
        </>
      }
    >
      <div className="image-viewer">
        <IconButton icon="chevron-left" title="Earlier (←)" disabled={!prev} onClick={() => prev && onNavigate(prev)} />
        <div className="image-frame">{src ? <img src={src} alt="" /> : <Icon name="loading" spin />}</div>
        <IconButton icon="chevron-right" title="Later (→)" disabled={!next} onClick={() => next && onNavigate(next)} />
      </div>
    </Modal>
  )
}

/** "Worked on #5 Prompt snippets, #7 …": the board cards the session's agent had in Doing. A deleted card keeps its
 *  number and the title it had, without a link. */
function WorkedOn({ cards }: { cards: SessionListItem['cards'] }) {
  const tasks = useStore((s) => s.tasks)
  if (!cards?.length) return null
  return (
    <div className="worked-on faint">
      <Icon name="project" /> Worked on{' '}
      {cards.map((c, i) => {
        const card = tasks.find((t) => t.number === c.number)
        const text = `#${c.number} ${card?.title ?? c.title}`
        return (
          <span key={c.number}>
            {i > 0 && ', '}
            {card ? (
              <a className="link" data-task={c.number} onClick={() => set({ taskOpen: c.number })}>
                {text}
              </a>
            ) : (
              <Tooltip content="This card was deleted.">
                <span>{text}</span>
              </Tooltip>
            )}
          </span>
        )
      })}
    </div>
  )
}
