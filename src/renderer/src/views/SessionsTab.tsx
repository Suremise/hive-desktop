import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ProjectInfo, SessionBulkAction, SessionBulkResult, SessionListItem, SessionSkipReason, Transcript, TranscriptImageRef, TranscriptItem, TranscriptSearchResult, TranscriptTool } from '@shared/types'
import { MAX_AGENTS, TRANSCRIPT_WINDOW } from '@shared/defaults'
import { formatDateTime } from '@shared/dates'
import { isProviderEnabled, providerDescriptor, providerName } from '@shared/providers'
import { buildSessionTree, countText, countsIn, pathTo, sessionKey, sessionsIn, type TreeNode } from '@shared/sessionTree'
import { removedAgentNote, resumeBlock, type ResumeContext } from '@shared/sessionResume'
import { ProviderIcon } from '../components/ProviderIcon'
import * as actions from '../actions'
import { call, errorMessage } from '../api'
import { PaneResizer, usePaneSize } from '../components/Resizer'
import { Icon, IconButton, InfoTip, LoadFailed, Markdown, Modal, StaleNote, Tooltip, useContextMenu, type MenuEntry } from '../components/ui'
import { agentProviderOf, confirm, focusedAgentId, get, notify, openInSessionsTab, prompt, revealAgent, set, setAssistantOpen, useDateStyle, useStore } from '../store'
import { cx, formatDuration, formatTokens, sessionLabel, timeAgo } from '../util'
import { useSessions } from './ProjectTabs'
import { useScopedLoad } from '../scopedLoad'
import { sessionOrigin, type SessionOrigin } from '@shared/sessionOrigin'

/**
 * Sessions tab: the project's sessions as a tree on the left (provider → agent → session → the sub-sessions it
 * started, like the Files tree: counts, actions on any branch, keyboard) and a read-only transcript on the right.
 * Search filters the tree across names, dates, providers and transcript text, with each session's matches under it.
 * The Hive Assistant's conversations use it too (`assistant`): its own words, no agent level, its panel instead of an
 * agent's pane.
 */

type Jump = { sessionId: string; itemId: number; nonce: number }
type Hit = TranscriptSearchResult['hits'][number]
type Row = { kind: 'node'; key: string; node: TreeNode; depth: number; parent: string | null } | { kind: 'hit'; key: string; sessionId: string; hit: Hit; depth: number; parent: string }

const copyText = (text: string): void => void navigator.clipboard.writeText(text)
const NO_PREFS: Record<string, boolean> = {}
/** Branches whose open or folded state is remembered per project (the most recently changed). */
const MAX_TREE_PREFS = 300

const SKIP_TEXT: Record<SessionSkipReason, string> = { live: 'running', 'in-use': 'in use', reading: 'being read by Hive', open: 'open in another Hive window', external: 'started outside Hive', failed: 'failed' }
const BULK_VERB: Record<SessionBulkAction, string> = { archive: 'Archived', unarchive: 'Unarchived', delete: 'Deleted' }

export function SessionsTab({ project, assistant = false }: { project: ProjectInfo; assistant?: boolean }) {
  const { items, reload, error: listError, loadedAt } = useSessions(project)
  const listWidth = usePaneSize('sessions', 320)
  const [showArchived, setShowArchived] = useState(false)
  const noun = assistant ? 'conversation' : 'session'
  const newOne = (): void => {
    void actions.newSession(project.path)
    if (assistant) setAssistantOpen(true)
  }
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // This tab's transcript view, as main knows it (transcript:viewing): a session open in it isn't archived or deleted.
  const [viewId] = useState(() => `v${Math.random().toString(36).slice(2, 12)}`)
  // The keyboard's place in the tree (a branch, session or match), apart from the session shown.
  const [cursor, setCursor] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [searchTry, setSearchTry] = useState(0)
  const [jump, setJump] = useState<Jump | null>(null)
  // Branches opened to show a session (the one selected at first, or opened from elsewhere): not remembered.
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set())
  const searchRef = useRef<HTMLInputElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const settings = useStore((s) => s.settings)
  const installs = useStore((s) => s.providers)
  const prefKey = project.path.toLowerCase()
  const explicit = useStore((s) => s.sessionsTree[prefKey]) ?? NO_PREFS
  // Running sessions of all the project's agents, by session id.
  const liveById = new Map(project.agents.filter((a) => a.live).map((a) => [a.live!.sessionId, a.live!]))
  const liveId = project.live?.sessionId
  const isLive = (id: string): boolean => liveById.has(id)
  const many = project.agents.length > 1
  // Where each session ran and whose it was, as it recorded (the Assistant's conversations have one place to run).
  const origin = (s: SessionListItem): SessionOrigin | null => (assistant ? null : sessionOrigin(project.path, project.agents, s))
  const sessionName = (s: SessionListItem): string => sessionLabel(s, project.name)
  const menu = useContextMenu()
  const resumeMenu = useContextMenu()
  useDateStyle() // session names and times follow the date format

  // Search as you type (debounced), across every session: names, dates, providers and transcript text. Results belong
  // to their project and query: never shown for another. A search that failed is said in place of the count, with Retry.
  const q = query.trim()
  const searchKey = q ? JSON.stringify([project.path, q]) : ''
  const search = useScopedLoad<TranscriptSearchResult[]>(searchKey)
  const results = q ? search.data : null
  const searchError = q ? search.error : null
  const { load: loadSearch } = search
  useEffect(() => {
    if (!searchKey) return
    const path = project.path
    const t = setTimeout(() => loadSearch(searchKey, () => call('transcript:search', path, q, null)), 250)
    return () => clearTimeout(t)
    // The key holds the project and query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchKey, searchTry, loadSearch])

  // The Assistant's list is its own conversations (and what they started).
  const shown = useMemo(() => (items ?? []).filter((i) => !assistant || i.source === 'hive' || !!i.sub?.parentId), [items, assistant])
  const byId = useMemo(() => new Map((items ?? []).map((i) => [i.id, i])), [items])
  const hitsById = new Map((results ?? []).map((r) => [r.sessionId, r]))
  const low = q.toLowerCase()
  const matches = (s: SessionListItem): boolean =>
    hitsById.has(s.id) || [sessionName(s), s.title ?? '', providerName(s.provider), s.lastActivity ? formatDateTime(s.lastActivity) : '', origin(s)?.label ?? '', s.sub?.kind ?? ''].some((t) => t.toLowerCase().includes(low))
  const tree = buildSessionTree(shown, { agents: project.agents, byAgent: !assistant, showArchived, selectedId, match: q ? matches : null })
  const treeNow = useRef(tree)
  treeNow.current = tree

  // Branches start folded except the focused agent's (the Assistant's: its provider's); what the user opens or folds is
  // remembered for the project.
  const focused = assistant ? null : focusedAgentId(project)
  const focusedProvider = assistant ? agentProviderOf(project, project.agents[0]) : focused ? agentProviderOf(project, project.agents.find((a) => a.id === focused)) : null
  const defaultOpen = (n: TreeNode): boolean =>
    n.kind === 'provider' ? n.provider === focusedProvider && (assistant || n.children.some((c) => c.kind === 'agent' && c.agentId === focused)) : n.kind === 'agent' ? !!focused && n.agentId === focused : false
  const isOpen = (n: TreeNode): boolean => !!q || revealed.has(n.key) || (explicit[n.key] ?? defaultOpen(n))
  const setOpen = (keys: string[], open: boolean): void => {
    const next = { ...explicit }
    for (const k of keys) {
      delete next[k]
      next[k] = open
    }
    const prefs = Object.fromEntries(Object.entries(next).slice(-MAX_TREE_PREFS))
    const all = { ...get().sessionsTree }
    delete all[prefKey]
    all[prefKey] = prefs
    const kept = Object.fromEntries(Object.entries(all).slice(-200))
    set({ sessionsTree: kept })
    void call('ui:set', { sessionsTree: kept }).catch(() => undefined)
    setRevealed((r) => {
      if (!keys.some((k) => r.has(k))) return r
      const x = new Set(r)
      for (const k of keys) x.delete(k)
      return x
    })
  }
  const branchKeys = (nodes: readonly TreeNode[]): string[] => nodes.flatMap((n) => (n.children.length ? [n.key, ...branchKeys(n.children)] : []))
  /** Opens the branches down to a session, so it shows; false when it isn't in the tree (yet). */
  const reveal = (id: string): boolean => {
    const path = pathTo(treeNow.current, id)
    if (path?.length) setRevealed((r) => (path.every((k) => r.has(k)) ? r : new Set([...r, ...path])))
    return !!path
  }

  const open = (sessionId: string, itemId?: number): void => {
    setSelectedId(sessionId)
    setJump(itemId === undefined ? null : { sessionId, itemId, nonce: Date.now() })
  }

  // Opened on a session from elsewhere (e.g. clicking the session name above an agent's terminal).
  const jumpTo = useStore((s) => (s.sessionsJump?.project === project.path ? s.sessionsJump : null))
  useEffect(() => {
    if (!jumpTo) return
    setSelectedId(jumpTo.id)
    setCursor(sessionKey(jumpTo.id))
    set({ sessionsJump: null })
    // At one of its compactions (the Overview's compaction history): its divider, with the summary open.
    if (jumpTo.compaction !== undefined) {
      const n = jumpTo.compaction
      void call('transcript:compactions', project.path, jumpTo.id)
        .then((ids) => ids[n] !== undefined && setJump({ sessionId: jumpTo.id, itemId: ids[n], nonce: jumpTo.nonce }))
        .catch(() => undefined)
    }
  }, [jumpTo, project.path])

  const selected = items?.find((i) => i.id === selectedId) ?? null

  // Start on the running session, or the most recent conversation (not while an action has closed the view: moving).
  const moving = useRef(false)
  useEffect(() => {
    if (!items || moving.current || (selectedId && items.some((i) => i.id === selectedId))) return
    const first = items.find((i) => i.id === liveId) ?? items.find((i) => !i.archived && !i.sub) ?? items[0]
    setSelectedId(first?.id ?? null)
    if (first) setCursor(sessionKey(first.id))
  }, [items, selectedId, liveId])
  // The session shown has its branches open: once each time it changes (or once the list has it), so a branch folded
  // later stays folded when the list refreshes.
  const revealedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedId || revealedFor.current === selectedId) return
    if (reveal(selectedId)) revealedFor.current = selectedId
    // reveal reads the tree as it is now (treeNow); this runs when the session shown changes, or the list arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, items])

  const rename = async (s: SessionListItem): Promise<void> => {
    const current = sessionName(s)
    const name = (await prompt({ title: 'Rename session', initial: current, confirmLabel: 'Rename' }))?.trim()
    if (!name || name === current) return
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
    const closed = await closeView([s.id])
    const done = await actions.attempt(`Could not delete the ${noun}`, () => call('session:delete', project.path, s.id).then(() => true))
    moving.current = false
    // Still there (it couldn't be deleted): open it again.
    if (!done && closed) setSelectedId(closed)
    reload()
  }
  const archive = async (s: SessionListItem, archived: boolean): Promise<void> => {
    if (archived && !(await confirm({ title: 'Archive session?', message: 'The transcript is preserved in .hive/archive and hidden from this list. You can unarchive it at any time.', confirmLabel: 'Archive' }))) return
    const closed = await closeView([s.id])
    await actions.attempt('Could not archive', () => call('session:archive', project.path, s.id, archived))
    moving.current = false
    // Its files have moved (or stayed): open it again from where they are.
    if (closed) setSelectedId(closed)
    reload()
  }

  /**
   * Closes this tab's view of a transcript about to be archived or deleted, before main moves its files (main counts an
   * open view as in use): its id, when it was one of them, once main knows the view is closed.
   */
  const closeView = async (ids: string[]): Promise<string | null> => {
    if (!selectedId || !ids.includes(selectedId)) return null
    const closed = selectedId
    moving.current = true
    setSelectedId(null)
    setJump(null)
    await call('transcript:viewing', viewId, project.path, null).catch(() => undefined)
    return closed
  }

  // ---- branch actions: everything under a provider, an agent, or a session and its sub-sessions ----
  const branchName = (n: TreeNode): string => (n.kind === 'session' ? `"${sessionName(n.item)}"` : n.kind === 'agent' ? `${n.label} (${providerName(n.provider)})` : n.label)
  const bulkList = (n: TreeNode, action: SessionBulkAction): SessionListItem[] =>
    // Archiving keeps Hive's copy: only Hive's own sessions have one (a sub-session started outside Hive goes with its session).
    sessionsIn(n).filter((s) => (action === 'delete' ? true : action === 'archive' ? !s.archived && s.source === 'hive' : !!s.archived))
  const runBulk = async (n: TreeNode, action: SessionBulkAction): Promise<void> => {
    const list = bulkList(n, action)
    if (!list.length) return
    const what = countText({ sessions: list.filter((s) => !s.sub).length, subs: list.filter((s) => !!s.sub).length })
    const running = list.filter((s) => isLive(s.id)).length
    const skipNote = `${running ? `${running} running now ${running === 1 ? 'is' : 'are'} skipped, as are` : 'Running sessions are skipped, and'} any whose files are in use; the result says which.`
    const ok =
      action === 'unarchive' ||
      (await confirm(
        action === 'delete'
          ? {
              title: `Delete ${what}?`,
              message: `Delete ${what} under ${branchName(n)} from Hive?`,
              detail: `Hive's copies of their transcripts go to the Recycle Bin (restore them from there) and Hive stops listing them; what they used stays in the totals. Claude Code and Codex keep their own transcripts. ${skipNote}`,
              confirmLabel: 'Delete All',
              danger: true
            }
          : {
              title: `Archive ${what}?`,
              message: `Archive ${what} under ${branchName(n)}?`,
              detail: `Their transcripts are kept in .hive/archive and hidden from this list: tick Archived to see them, and unarchive any at any time. ${skipNote}`,
              confirmLabel: 'Archive All'
            }
      ))
    if (!ok) return
    // The transcript open here, if it is one of them, closes first (an open one is in use); it opens again if its
    // session was left alone, and the result says when it stays closed.
    const closed = await closeView(list.map((s) => s.id))
    const r = await actions.attempt(`Could not ${action} the ${noun}s`, () => call('session:bulk', project.path, action, list.map((s) => s.id)))
    moving.current = false
    if (closed && (!r || !r.done.includes(closed))) setSelectedId(closed)
    if (!r) return
    reportBulk(
      action,
      r,
      (id) => {
        const s = byId.get(id)
        return s ? sessionName(s) : id.slice(0, 8)
      },
      !!closed && r.done.includes(closed)
    )
    reload()
  }

  const resumeCtx = (s: SessionListItem): ResumeContext => {
    const install = installs[s.provider]
    return {
      live: isLive(s.id),
      providerEnabled: isProviderEnabled(settings, s.provider),
      providerInstalled: install && !install.checking ? install.found : null,
      runners: actions.agentsForSession(project, s),
      canAddAgent: !assistant && (!s.cwd || s.cwd.toLowerCase() === project.path.toLowerCase()) && project.agents.length < MAX_AGENTS,
      ...(assistant ? { assistantProvider: agentProviderOf(project, project.agents[0]) } : {})
    }
  }
  const whyNot = (s: SessionListItem): string | null => resumeBlock(s, resumeCtx(s))

  const sessionMenu = (n: Extract<TreeNode, { kind: 'session' }>): MenuEntry[] => {
    const s = n.item
    const live = isLive(s.id)
    const block = whyNot(s)
    const entries: MenuEntry[] = []
    if (live) {
      const holder = project.agents.find((a) => a.live?.sessionId === s.id)
      if (holder) entries.push({ label: assistant ? 'Show the Assistant' : `Show ${holder.name}`, icon: 'terminal', onClick: () => (assistant ? setAssistantOpen(true) : revealAgent(project, holder.id)) })
    } else if (!s.archived) entries.push({ label: 'Resume', icon: 'debug-continue', disabled: !!block, detail: block ?? undefined, onClick: () => void actions.resumeSession(project.path, s) })
    if (s.source === 'external' && !s.sub) entries.push({ label: 'Adopt', icon: 'add', onClick: () => void actions.attempt('Could not adopt', () => call('session:adopt', project.path, s.id)).then(reload) })
    if (s.source === 'hive') entries.push({ label: 'Rename…', icon: 'tag', keybinding: 'F2', onClick: () => void rename(s) })
    entries.push({ separator: true })
    if (s.source === 'hive' && !live) entries.push({ label: s.archived ? 'Unarchive' : 'Archive', icon: s.archived ? 'unarchive' : 'archive', onClick: () => void archive(s, !s.archived) })
    entries.push({ label: `Delete ${noun === 'session' ? 'Session' : 'Conversation'}…`, icon: 'trash', keybinding: 'Del', danger: true, disabled: live, onClick: () => void remove(s) })
    if (n.children.length) entries.push({ separator: true }, ...branchEntries(n))
    entries.push({ separator: true }, { label: 'Copy Session ID', icon: 'copy', onClick: () => copyText(s.id) })
    return entries
  }
  const branchEntries = (n: TreeNode): MenuEntry[] => {
    const keys = [n.key, ...branchKeys(n.children)]
    const count = (action: SessionBulkAction): number => bulkList(n, action).length
    const archiving = count('archive')
    const unarchiving = count('unarchive')
    const deleting = count('delete')
    const scope = n.kind === 'session' ? ' with Its Sub-sessions' : ' All'
    return [
      { label: 'Expand All', icon: 'expand-all', onClick: () => setOpen(keys, true) },
      { label: 'Collapse All', icon: 'collapse-all', onClick: () => setOpen(keys, false) },
      { separator: true },
      { label: `Archive${scope}… (${archiving})`, icon: 'archive', disabled: !archiving, detail: archiving ? undefined : "Nothing of Hive's to archive here", onClick: () => void runBulk(n, 'archive') },
      ...(unarchiving ? [{ label: `Unarchive${scope} (${unarchiving})`, icon: 'unarchive', onClick: () => void runBulk(n, 'unarchive') }] : []),
      { label: `Delete${scope}… (${deleting})`, icon: 'trash', danger: true, disabled: !deleting, onClick: () => void runBulk(n, 'delete') }
    ]
  }
  const menuFor = (n: TreeNode): MenuEntry[] => (n.kind === 'session' ? sessionMenu(n) : branchEntries(n))

  if (!items) return listError ? <LoadFailed what={`the ${noun}s`} error={listError} onRetry={reload} /> : <div className="empty-state"><Icon name="loading" spin />Loading…</div>

  // The tree's rows as shown: open branches' children, and while searching each session's matches under it.
  const rows: Row[] = []
  const walk = (nodes: readonly TreeNode[], depth: number, parent: string | null): void => {
    for (const n of nodes) {
      rows.push({ kind: 'node', key: n.key, node: n, depth, parent })
      if (n.kind === 'session' && q) for (const h of hitsById.get(n.item.id)?.hits ?? []) rows.push({ kind: 'hit', key: `h:${n.item.id}:${h.itemId}`, sessionId: n.item.id, hit: h, depth: depth + 1, parent: n.key })
      if (n.children.length && isOpen(n)) walk(n.children, depth + 1, n.key)
    }
  }
  walk(tree, 0, null)
  const hitCount = results?.reduce((n, r) => n + r.hits.length, 0) ?? 0
  const matched = q ? tree.flatMap(sessionsIn).length : 0

  const activate = (r: Row): void => {
    setCursor(r.key)
    if (r.kind === 'hit') open(r.sessionId, r.hit.itemId)
    else if (r.node.kind === 'session') open(r.node.item.id)
  }
  const toggle = (n: TreeNode): void => setOpen([n.key], !isOpen(n))

  const onKeyDown = (ev: React.KeyboardEvent): void => {
    if ((ev.target as HTMLElement).tagName === 'INPUT') return
    const idx = cursor ? rows.findIndex((r) => r.key === cursor) : -1
    const cur = idx >= 0 ? rows[idx] : null
    const node = cur?.kind === 'node' ? cur.node : null
    const moveTo = (i: number): void => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, i))]
      if (!r) return
      activate(r)
      treeRef.current?.querySelector(`[data-key="${CSS.escape(r.key)}"]`)?.scrollIntoView({ block: 'nearest' })
    }
    let handled = true
    if (ev.key === 'ArrowDown') moveTo(idx + 1)
    else if (ev.key === 'ArrowUp') moveTo(idx < 0 ? 0 : idx - 1)
    else if (ev.key === 'Home') moveTo(0)
    else if (ev.key === 'End') moveTo(rows.length - 1)
    else if (ev.key === 'ArrowRight' && node?.children.length && !q) {
      if (!isOpen(node)) setOpen([node.key], true)
      else moveTo(idx + 1)
    } else if (ev.key === 'ArrowLeft' && cur) {
      if (node?.children.length && isOpen(node) && !q) setOpen([node.key], false)
      else if (cur.parent) moveTo(rows.findIndex((r) => r.key === cur.parent))
    } else if (ev.key === 'Enter' && cur) {
      if (node && node.kind !== 'session') toggle(node)
      else activate(cur)
    } else if (ev.key === 'F2' && node?.kind === 'session' && node.item.source === 'hive') void rename(node.item)
    else if (ev.key === 'Delete' && node) {
      if (node.kind === 'session') {
        if (!isLive(node.item.id)) void remove(node.item)
      } else void runBulk(node, 'delete')
    } else handled = false
    if (handled) {
      ev.preventDefault()
      ev.stopPropagation()
    }
  }

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
                ? "Every conversation of this workspace's Hive Assistant, by provider. Select one to read it in full, including what came before each compaction."
                : "Every session of this project, by provider and agent, with the sessions each one started (such as Codex's guardian reviews) under it. Select one to read its transcript, including what came before each compaction; right-click a branch to archive or delete everything in it. Transcripts a CLI has deleted are read from Hive's backup."
            }
          />
          <div className="actions">
            <IconButton icon="add" title={assistant ? 'New Conversation' : 'New Session'} onClick={newOne} />
            <IconButton icon="refresh" title="Refresh" onClick={reload} />
            <IconButton icon="expand-all" title="Expand All" onClick={() => setOpen(branchKeys(tree), true)} />
            <IconButton icon="collapse-all" title="Collapse All" onClick={() => setOpen(branchKeys(tree), false)} />
          </div>
        </div>
        <div className="files-filter">
          <Icon name="search" />
          <input
            ref={searchRef}
            className="input"
            placeholder={`Search ${noun}s: names, dates, transcripts`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('')
              if (e.key === 'Enter') {
                const first = rows.find((r) => r.kind === 'hit') ?? rows.find((r) => r.kind === 'node' && r.node.kind === 'session')
                if (first) activate(first)
              }
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                treeRef.current?.focus()
                const first = rows.find((r) => r.kind === 'hit' || r.node.kind === 'session') ?? rows[0]
                if (first) activate(first)
              }
            }}
          />
          {query && <IconButton icon="close" title="Clear" onClick={() => setQuery('')} />}
        </div>
        <div className="sessions-filters">
          <label className="flex muted">
            <input type="checkbox" className="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Archived
          </label>
          {q && (
            <span className="sessions-scope faint">
              {searchError ? null : !results ? (
                <>
                  <Icon name="loading" spin /> Searching…
                </>
              ) : matched === 0 ? (
                'No matches'
              ) : (
                `${matched} ${noun}${matched === 1 ? '' : 's'}${hitCount ? ` · ${hitCount}${results.some((r) => r.more) ? '+' : ''} match${hitCount === 1 ? '' : 'es'}` : ''}`
              )}
            </span>
          )}
        </div>
        {listError && <StaleNote what={`the ${noun}s`} error={listError} at={loadedAt} onRetry={reload} />}
        {q && searchError && <LoadFailed inline what="the search results" error={searchError} onRetry={() => setSearchTry((n) => n + 1)} />}
        <div className="pane-body file-tree sessions-tree" tabIndex={0} ref={treeRef} onKeyDown={onKeyDown}>
          {items.length === 0 && <div className="pane-empty">No {noun}s yet.</div>}
          {items.length > 0 && rows.length === 0 && !q && <div className="pane-empty">No {noun}s here: tick Archived to see archived ones.</div>}
          {rows.map((r) => {
            if (r.kind === 'hit') {
              return (
                <div
                  key={r.key}
                  data-key={r.key}
                  className={cx('search-hit', cursor === r.key && 'cursor', selectedId === r.sessionId && jump?.itemId === r.hit.itemId && 'selected')}
                  style={{ paddingLeft: 28 + r.depth * 14 }}
                  onClick={() => activate(r)}
                >
                  <span className="hit-kind">{HIT_KIND[r.hit.kind]}</span>
                  <Highlight text={r.hit.snippet} query={q} />
                </div>
              )
            }
            const n = r.node
            const onContextMenu = (e: React.MouseEvent): void => {
              setCursor(r.key)
              menu.open(e, menuFor(n))
            }
            const more = (e: React.MouseEvent): void => {
              const b = e.currentTarget.getBoundingClientRect()
              setCursor(r.key)
              menu.openAt(b.left, b.bottom + 2, menuFor(n))
            }
            if (n.kind !== 'session') {
              return <BranchRow key={r.key} n={n} depth={r.depth} open={isOpen(n)} cursor={cursor === r.key} onClick={() => (setCursor(r.key), toggle(n))} onContextMenu={onContextMenu} onMore={more} />
            }
            const s = n.item
            return (
              <SessionRow
                key={r.key}
                s={s}
                name={sessionName(s)}
                depth={r.depth}
                open={isOpen(n)}
                kids={n.children}
                orphan={n.orphan}
                live={liveById.get(s.id)?.status ?? null}
                origin={origin(s)}
                block={whyNot(s)}
                selected={s.id === selectedId}
                cursor={cursor === r.key}
                onClick={() => activate(r)}
                onToggle={() => toggle(n)}
                onContextMenu={onContextMenu}
                buttons={
                  <>
                    {s.source === 'hive' && <IconButton icon="tag" title="Rename" onClick={() => void rename(s)} />}
                    {!isLive(s.id) && <IconButton icon="trash" title={`Delete ${noun}`} onClick={() => void remove(s)} />}
                    <IconButton icon="ellipsis" title="More Actions" onClick={more} />
                  </>
                }
              />
            )
          })}
        </div>
      </div>
      <div className="split-main">
        {selected ? (
          <TranscriptView
            key={`${project.path}|${selected.id}`}
            project={project}
            session={selected}
            origin={origin(selected)}
            live={isLive(selected.id)}
            jump={jump?.sessionId === selected.id ? jump : null}
            query={q}
            viewId={viewId}
            marker={<SessionMarker s={selected} block={whyNot(selected)} live={isLive(selected.id)} orphan={!!selected.sub && !byId.has(selected.sub.parentId ?? '')} />}
            toolbar={
              <>
                {selected.source === 'external' && !selected.sub && (
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
                  const block = whyNot(selected)
                  // Can't be resumed: the buttons stay, disabled, and say why.
                  if (block) {
                    return (
                      <Tooltip content={block}>
                        <span className="resume-blocked">
                          <button className="btn small tint-amber" disabled>
                            <Icon name="debug-continue" /> Resume
                          </button>
                        </span>
                      </Tooltip>
                    )
                  }
                  const agents = actions.agentsForSession(project, selected)
                  const target = actions.resumeTarget(project, selected)
                  const targetAgent = agents.find((a) => a.id === target) ?? null
                  const targetName = targetAgent?.name
                  const note = removedAgentNote(selected, project.agents, targetAgent)
                  if (agents.length < 2) {
                    const button = (
                      <button className="btn small tint-amber" onClick={() => void actions.resumeSession(project.path, selected)}>
                        <Icon name="debug-continue" /> Resume
                      </button>
                    )
                    return note ? <Tooltip content={note}>{button}</Tooltip> : button
                  }
                  return (
                    <span className="split-btn">
                      <Tooltip content={note ?? (targetName ? `Resume in ${targetName}` : 'Resume (adds an agent if none can run it)')}>
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
                                detail: `${a.worktree ? `worktree · ${a.worktree.branch}` : 'project folder'}${a.live ? ' · running, its current session stops first' : ''}`,
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
            {items.length ? `Select a ${noun} to read its transcript.` : `No ${noun}s yet.`}
          </div>
        )}
      </div>
      {menu.element}
    </div>
  )
}

/** What a bulk action did: one line, and what it skipped and why. */
function reportBulk(action: SessionBulkAction, r: SessionBulkResult, name: (id: string) => string, closedView: boolean): void {
  const n = r.done.length
  const head = `${BULK_VERB[action]} ${n} session${n === 1 ? '' : 's'}`
  const closed = closedView ? 'The transcript you were reading was one of them: it was closed first.' : undefined
  if (!r.skipped.length) return notify('success', `${head}.`, closed)
  const reasons = new Map<SessionSkipReason, number>()
  for (const s of r.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1)
  const why = [...reasons].map(([k, v]) => `${v} ${SKIP_TEXT[k]}`).join(', ')
  const shown = r.skipped.slice(0, 6).map((s) => `• ${name(s.id)}: ${SKIP_TEXT[s.reason]}${s.message ? ` (${s.message})` : ''}`)
  if (r.skipped.length > shown.length) shown.push(`…and ${r.skipped.length - shown.length} more`)
  if (closed) shown.push(closed)
  notify(n ? 'warning' : 'error', `${head}; ${r.skipped.length} skipped: ${why}`, shown.join('\n'))
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

/** A provider or agent in the tree: like a folder in the Files tree, with its count and ⋯ for its actions. */
function BranchRow({ n, depth, open, cursor, onClick, onContextMenu, onMore }: { n: Exclude<TreeNode, { kind: 'session' }>; depth: number; open: boolean; cursor: boolean; onClick: () => void; onContextMenu: (e: React.MouseEvent) => void; onMore: (e: React.MouseEvent) => void }) {
  const c = countsIn(n)
  return (
    <div data-key={n.key} className={cx('row file-row session-branch', `session-branch-${n.kind}`, cursor && 'cursor')} style={{ paddingLeft: 8 + depth * 14 }} onClick={onClick} onContextMenu={onContextMenu}>
      <Icon name={open ? 'chevron-down' : 'chevron-right'} className="twistie" />
      {n.kind === 'provider' ? <ProviderIcon provider={n.provider} /> : <Icon name={n.agentId ? 'person' : 'circle-slash'} className="file-icon" />}
      <span className={cx('label', n.removed && 'removed')}>{n.label}</span>
      <Tooltip content={countText(c)}>
        <span className="tree-count">
          {c.sessions}
          {c.subs > 0 && <span className="faint"> + {c.subs}</span>}
        </span>
      </Tooltip>
      <div className="row-actions" onClick={(e) => e.stopPropagation()}>
        <IconButton icon="ellipsis" title="More Actions" onClick={onMore} />
      </div>
    </div>
  )
}

/** A sub-session's kind, or why a session can't be resumed (shown in the tree and over its transcript). */
function SessionMarker({ s, block, live, orphan }: { s: SessionListItem; block: string | null; live: boolean; orphan: boolean }) {
  if (s.sub) {
    return (
      <Tooltip content={`${block ?? ''}${orphan ? `\nThe session that started it isn't listed (deleted, or not from this project).` : ''}`.trim()}>
        <span className="badge sub-kind">
          <Icon name="type-hierarchy-sub" /> {s.sub.kind}
        </span>
      </Tooltip>
    )
  }
  if (!block || live || s.archived) return null
  return (
    <Tooltip content={block}>
      <span className="badge cant-resume">
        <Icon name="debug-disconnect" /> can't resume
      </span>
    </Tooltip>
  )
}

function SessionRow(props: {
  s: SessionListItem
  name: string
  depth: number
  open: boolean
  kids: readonly TreeNode[]
  orphan: boolean
  live: string | null
  origin: SessionOrigin | null
  block: string | null
  selected: boolean
  cursor: boolean
  onClick: () => void
  onToggle: () => void
  onContextMenu: (e: React.MouseEvent) => void
  buttons: React.ReactNode
}) {
  const { s, name, live, origin, kids } = props
  const kinds = new Set(kids.map((k) => (k.kind === 'session' ? k.item.sub?.kind : null)))
  const kind = kinds.size === 1 ? [...kinds][0] : null
  return (
    <div
      data-key={sessionKey(s.id)}
      className={cx('session-row', props.selected && 'selected', props.cursor && 'cursor', s.archived && 'archived', s.sub && 'sub')}
      style={{ paddingLeft: 8 + props.depth * 14 }}
      onClick={props.onClick}
      onContextMenu={props.onContextMenu}
    >
      <div className="session-row-title">
        {kids.length ? (
          <span
            className="twistie"
            onClick={(e) => {
              e.stopPropagation()
              props.onToggle()
            }}
          >
            <Icon name={props.open ? 'chevron-down' : 'chevron-right'} />
          </span>
        ) : (
          <span className="twistie" />
        )}
        {live && <span className={cx('dot', live)} />}
        <Tooltip content={providerName(s.provider)}>
          <span>
            <ProviderIcon provider={s.provider} />
          </span>
        </Tooltip>
        <strong>{name}</strong>
      </div>
      <div className="session-row-meta">
        {s.lastActivity ? (
          <Tooltip content={`Last active ${formatDateTime(s.lastActivity)}`}>
            <span className="session-row-when">{timeAgo(s.lastActivity)}</span>
          </Tooltip>
        ) : (
          <span>{timeAgo(s.lastActivity)}</span>
        )}
        {s.usage && <span>{formatTokens(s.usage.contextTokens)} context</span>}
        {origin && (
          <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{origin.detail}</span>}>
            <span className="badge session-origin">{origin.location}</span>
          </Tooltip>
        )}
        {s.source === 'external' && !s.sub && (
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
        <SessionMarker s={s} block={props.block} live={!!live} orphan={props.orphan} />
        {kids.length > 0 && (
          <Tooltip content={`Sessions ${providerName(s.provider)} started for this one: ${kids.length}`}>
            <span className="badge sub-count">
              {kids.length} {kind ? `${kind}${kids.length === 1 ? '' : 's'}` : `sub-session${kids.length === 1 ? '' : 's'}`}
            </span>
          </Tooltip>
        )}
      </div>
      <div className="row-actions" onClick={(e) => e.stopPropagation()}>
        {props.buttons}
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

const time = (ts: string | null): string => (ts ? formatDateTime(ts) : '')

function TranscriptView({ project, session, origin, live, jump, query, viewId, marker, toolbar }: { project: ProjectInfo; session: SessionListItem; origin: SessionOrigin | null; live: boolean; jump: Jump | null; query: string; viewId: string; marker: React.ReactNode; toolbar: React.ReactNode }) {
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  // Main knows this transcript is open here: archiving or deleting it skips it (this tab closes it first: closeView).
  useEffect(() => {
    void call('transcript:viewing', viewId, project.path, session.id).catch(() => undefined)
    return () => void call('transcript:viewing', viewId, project.path, null).catch(() => undefined)
  }, [viewId, project.path, session.id])
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
  useDateStyle()
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
          {marker && <span style={{ marginLeft: 8 }}>{marker}</span>}
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
      {origin && (
        <div className="session-ran-in faint">
          <Icon name={origin.location === 'Project folder' ? 'folder' : 'git-branch'} /> Ran in{' '}
          <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{origin.detail}</span>}>
            <span>{origin.label}</span>
          </Tooltip>
        </div>
      )}
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
      // The transcript says an image was there; without its copy, the placeholder stays.
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
      // Sized to the image, with its own controls: it stays put (#133).
      movable={false}
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
/** The cards a session worked on, and those it reviewed (each a line, when it has any). */
function WorkedOn({ cards }: { cards: SessionListItem['cards'] }) {
  if (!cards?.length) return null
  return (
    <>
      <CardsLine icon="project" label="Worked on" cards={cards.filter((c) => !c.review)} />
      <CardsLine icon="eye" label="Reviewed" cards={cards.filter((c) => c.review)} />
    </>
  )
}

function CardsLine({ icon, label, cards }: { icon: string; label: string; cards: NonNullable<SessionListItem['cards']> }) {
  const tasks = useStore((s) => s.tasks)
  if (!cards.length) return null
  return (
    <div className="worked-on faint">
      <Icon name={icon} /> {label}{' '}
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
