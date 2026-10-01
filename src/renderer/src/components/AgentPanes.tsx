import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { MAX_AGENTS, PAGE_AGENTS, SESSION_LAYOUTS, agentPageCount, compactThreshold, effectiveModelLabel, effortLabel, layoutPanes, mostUrgent, pageAgents, pageLayout, sessionInAgentFolder } from '@shared/defaults'
import type { AgentInfo, ProjectInfo, SessionLayout, SessionListItem } from '@shared/types'
import * as actions from '../actions'
import { call } from '../api'
import { NO_IDS, NO_PROJECTS, agentPage, agentProviderOf, focusAgent, focusedAgentId, openInSessionsTab, paneAssignment, projectKey, revealAgent, seenAgents, set, setProjectTab, showAgent, showPage, useStore } from '../store'
import { useLiveUsage } from '../usage'
import { commandKeybinding } from '../commands'
import { cx, formatKeybinding, formatTokens, sessionLabel, timeAgo } from '../util'
import { TerminalView } from './TerminalView'
import { ModeBadge } from './PermissionMode'
import { ProviderIcon } from './ProviderIcon'
import { isProviderEnabled, projectDefaultProvider, projectProviderConfig, providerName, providerSettings } from '@shared/providers'
import { Icon, IconButton, statusText, StatusDot, Tooltip, useContextMenu, type MenuEntry } from './ui'

/** Height of an agent pane's header (who it is, its controls) and footer (its session's details). */
export const PANE_HEADER = 30
export const PANE_FOOTER = 24

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

function paneRect(count: number, i: number): Rect {
  if (count === 4) return { x: (i % 2) * 50, y: Math.floor(i / 2) * 50, w: 50, h: 50 }
  if (count === 6) return { x: ((i % 3) * 100) / 3, y: Math.floor(i / 3) * 50, w: 100 / 3, h: 50 }
  const w = 100 / count
  return { x: i * w, y: 0, w, h: 100 }
}

function rectStyle(r: Rect): CSSProperties {
  return { left: `${r.x}%`, top: `calc(${r.y}% + ${PANE_HEADER}px)`, width: `${r.w}%`, height: `calc(${r.h}% - ${PANE_HEADER + PANE_FOOTER}px)`, right: 'auto', bottom: 'auto' }
}

/** Which agent each pane of the selected project shows. */
export function usePanes(project: ProjectInfo | null): (string | null)[] {
  const focused = useStore((s) => (project ? s.focusedAgent[project.path] : undefined))
  const stored = useStore((s) => (project ? s.paneAgents[project.path] : undefined))
  if (!project) return []
  return paneAssignment(project, focused && project.agents.some((a) => a.id === focused) ? focused : focusedAgentId(project), stored)
}

/**
 * Terminals for every agent that has had a session in this run, in every project. Kept mounted so
 * switching projects is instant; the selected project's are placed in their panes.
 */
export function TerminalLayer({ visibleFor, panes }: { visibleFor: string | null; panes: (string | null)[] }) {
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  const epochs = useStore((s) => s.sessionEpoch)
  return (
    <>
      {projects.flatMap((p) =>
        p.agents.map((a) => {
          const key = projectKey(p.path, a.id)
          if (!a.live && epochs[key] === undefined) return null
          const i = visibleFor === p.path ? panes.indexOf(a.id) : -1
          return (
            <TerminalView
              key={`${key}:${epochs[key] ?? 0}`}
              ptyKey={key}
              visible={i >= 0}
              style={i >= 0 ? rectStyle(paneRect(panes.length, i)) : undefined}
              projectPath={p.path}
              agentId={a.id}
              provider={agentProviderOf(p, a)}
              autoFocus={i >= 0 && (panes.length === 1 || useStore.getState().focusedAgent[p.path] === a.id)}
              onFocus={() => focusAgent(p.path, a.id)}
            />
          )
        })
      )}
    </>
  )
}

function LayoutGlyph({ layout }: { layout: SessionLayout }) {
  const n = layoutPanes(layout)
  return (
    <span className={cx('layout-glyph', (layout === 'grid' || layout === 'grid6') && layout)}>
      {Array.from({ length: n }, (_, i) => (
        <span key={i} />
      ))}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Resuming: this agent's last session, or one picked from the list
// ---------------------------------------------------------------------------

const PICKER_MAX = 10

/** The picker's entries: sessions from the agent's folder, newest first; ones open in another agent are greyed and show that agent. */
function sessionPickerItems(project: ProjectInfo, a: AgentInfo, list: SessionListItem[]): MenuEntry[] {
  const holders = new Map(project.agents.filter((x) => x.live).map((x) => [x.live!.sessionId, x]))
  const many = project.agents.length > 1
  const all = list.filter((s) => s.source === 'hive' && !s.archived && sessionInAgentFolder(project.path, a, s))
  const items: MenuEntry[] = [{ header: true, label: many ? `Resume in ${a.name}` : 'Resume a session' }]
  if (!all.length) items.push({ label: 'No sessions to resume here yet', disabled: true })
  for (const s of all.slice(0, PICKER_MAX)) {
    const holder = holders.get(s.id)
    const ranBy = project.agents.find((x) => x.id === s.agentId)
    const bits = [timeAgo(s.lastActivity)]
    if (holder) bits.push(`open in ${holder.name} — click to show it`)
    else {
      if (many && !a.worktree && ranBy && ranBy.id !== a.id) bits.push(`last run by ${ranBy.name}`)
      if (s.recache && !s.recache.warm && s.recache.tokens > 20000) bits.push(`cache expired, ~${formatTokens(s.recache.tokens)} to re-cache`)
    }
    items.push({
      label: sessionLabel(s, project.name),
      detail: bits.join(' · '),
      icon: holder ? 'circle-filled' : s.id === a.resume?.id ? 'debug-continue' : 'history',
      muted: !!holder,
      onClick: () => (holder ? revealAgent(project, holder.id) : void actions.resumeSession(project.path, s, a.id))
    })
  }
  items.push({ separator: true }, { label: all.length > PICKER_MAX ? `All ${all.length} Sessions…` : 'Sessions Tab…', icon: 'history', onClick: () => setProjectTab(project.path, 'sessions') })
  return items
}

/** A menu listing the sessions an agent can resume. */
function useSessionPicker() {
  const menu = useContextMenu()
  const openAt = async (project: ProjectInfo, a: AgentInfo, x: number, y: number): Promise<void> => {
    const list = await actions.attempt('Could not list sessions', () => call('session:list', project.path))
    if (list) menu.openAt(x, y, sessionPickerItems(project, a, list))
  }
  const openBelow = (el: Element, project: ProjectInfo, a: AgentInfo): void => {
    const r = el.getBoundingClientRect()
    void openAt(project, a, r.left, r.bottom + 2)
  }
  return { openAt, openBelow, element: menu.element }
}

function resumeTip(project: ProjectInfo, a: AgentInfo): string {
  if (a.resume) return `Resume "${sessionLabel(a.resume, project.name)}", last active ${timeAgo(a.resume.lastActiveAt)}`
  return `${project.agents.length > 1 ? `${a.name} has` : 'There is'} no session of its own to resume. Choose one with ▾, or start a new one.`
}

/** Resume split button: the main part resumes the agent's last session, ▾ picks another. */
export function ResumeButton({ project, a, className, label = 'Resume' }: { project: ProjectInfo; a: AgentInfo; className?: string; label?: string }) {
  const picker = useSessionPicker()
  return (
    <span className="split-btn">
      <Tooltip content={resumeTip(project, a)}>
        <button className={cx('btn', className)} disabled={!a.resume} onClick={() => void actions.resumeLast(project.path, a.id)}>
          <Icon name="debug-continue" /> {label}
        </button>
      </Tooltip>
      <Tooltip content="Choose a session to resume">
        <button className={cx('btn split-caret', className)} onClick={(e) => picker.openBelow(e.currentTarget, project, a)} aria-label="Choose a session to resume">
          <Icon name="chevron-down" />
        </button>
      </Tooltip>
      {picker.element}
    </span>
  )
}

/** The session an agent is running: its name, with details on hover; click to read it in the Sessions tab. */
export function SessionTag({ project, a, badge }: { project: ProjectInfo; a: AgentInfo; badge?: boolean }) {
  const usage = useLiveUsage(project, a.id)
  const live = a.live
  if (!live || live.settingUp) return null
  const label = sessionLabel({ id: live.sessionId, name: live.sessionName, title: usage?.title }, project.name)
  const tip = `${label}\nRunning since ${new Date(live.startedAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}\nSession ${live.sessionId}\nClick to read it in the Sessions tab.`
  return (
    <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{tip}</span>}>
      <span className={cx('session-tag', badge && 'badge')} onClick={() => openInSessionsTab(project.path, live.sessionId)}>
        <Icon name="comment-discussion" /> <span className="session-tag-text">{label}</span>
      </span>
    </Tooltip>
  )
}

/** An agent's menu. `inHeader`: the pane's header shows the session and Merge buttons, so the menu leaves them out. */
function agentMenu(project: ProjectInfo, a: AgentInfo, pick: () => void, inHeader = false): MenuEntry[] {
  const worktree = !!a.worktree
  return [
    ...(inHeader
      ? []
      : a.live
      ? [
          { label: 'Stop', icon: 'debug-stop', onClick: () => void actions.stopSession(project.path, a.id) },
          { label: 'Compact…', icon: 'fold', disabled: !(a.live.status === 'ready' || a.live.status === 'finished'), onClick: () => set({ compactFor: { project: project.path, agentId: a.id } }) },
          { label: 'Archive Session and Start New', icon: 'archive', onClick: () => void actions.archiveCurrent(project.path, a.id) }
        ]
      : [
          { label: 'Resume', icon: 'debug-continue', disabled: !a.resume, onClick: () => void actions.resumeLast(project.path, a.id) },
          { label: 'Resume a Session…', icon: 'history', onClick: pick },
          { label: 'New Session', icon: 'add', onClick: () => void actions.newSession(project.path, a.id) }
        ]),
    { label: 'Hand Over to…', icon: 'arrow-swap', disabled: project.agents.length < 2, onClick: () => set({ handOverFor: { project: project.path, agentId: a.id } }) },
    { separator: true },
    { label: 'Agent Settings…', icon: 'settings', onClick: () => set({ agentSettingsFor: { project: project.path, agentId: a.id } }) },
    ...(worktree
      ? [
          { label: 'Review Changes', icon: 'git-compare', onClick: () => reviewChanges(project, a) },
          ...(inHeader ? [] : [{ label: 'Merge…', icon: 'git-merge', onClick: () => set({ mergeFor: { project: project.path, agentId: a.id } }) }]),
          { separator: true },
          { label: 'Remove Agent…', icon: 'close', onClick: () => void actions.removeAgent(project.path, a.id) },
          { label: 'Discard Worktree and Branch…', icon: 'trash', danger: true, onClick: () => void actions.discardAgent(project.path, a.id) }
        ]
      : [{ separator: true }, { label: 'Remove Agent…', icon: 'close', onClick: () => void actions.removeAgent(project.path, a.id) }])
  ]
}

/**
 * Add Agent split button: the main part adds an agent at once (the default provider with its default
 * settings, in the project folder); ▾ opens the dialog to choose the provider, where it works and its settings.
 */
export function AddAgentButton({ project, className, label = 'Add Agent' }: { project: ProjectInfo; className?: string; label?: string }) {
  const settings = useStore((s) => s.settings)
  const installed = useStore((s) => s.providers)
  const full = project.agents.length >= MAX_AGENTS
  const provider = projectDefaultProvider(project.config, settings)
  const ready = isProviderEnabled(settings, provider) && !!installed[provider]?.found
  const tip = full
    ? `A project can have up to ${MAX_AGENTS} agents`
    : ready
      ? `Add a ${providerName(provider)} agent with its default settings, working in the project folder. ▾ to choose the provider, a worktree and settings.`
      : 'Add an agent: choose its provider, where it works and its settings'
  return (
    <span className="split-btn">
      <Tooltip content={tip}>
        <button className={cx('btn', className)} disabled={full} onClick={() => void actions.quickAddAgent(project.path)}>
          <Icon name="add" /> {label}
        </button>
      </Tooltip>
      <Tooltip content="Add Agent… (choose the provider, where it works and its settings)">
        <button className={cx('btn split-caret', className)} disabled={full} onClick={() => set({ addAgentFor: project.path })} aria-label="Add Agent…">
          <Icon name="chevron-down" />
        </button>
      </Tooltip>
    </span>
  )
}

function reviewChanges(project: ProjectInfo, a: AgentInfo): void {
  set((s) => ({ changesRoot: { ...s.changesRoot, [project.path]: a.id } }))
  setProjectTab(project.path, 'changes')
}

function Locks({ a }: { a: AgentInfo }) {
  const files = a.live?.lockedFiles
  if (!files?.length) return null
  return (
    <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{`Editing (other agents in this folder wait for these):\n${files.slice(0, 20).join('\n')}${files.length > 20 ? `\n…and ${files.length - 20} more` : ''}`}</span>}>
      <span className="agent-locks">
        <Icon name="lock" /> {files.length}
      </span>
    </Tooltip>
  )
}

/** The row above the Session tab: one tab per agent, Add Agent and the layout choice. */
function AgentTabTip({ project, a }: { project: ProjectInfo; a: AgentInfo }) {
  const usage = useLiveUsage(project, a.live ? a.id : undefined)
  const live = a.live
  const lines = [`${a.name} (${providerName(agentProviderOf(project, a))}): ${live ? statusText(live) : 'not running'}`]
  if (live) lines.push(`Session: ${sessionLabel({ id: live.sessionId, name: live.sessionName, title: usage?.title }, project.name)}`)
  else if (a.resume) lines.push(`Resume opens: ${sessionLabel(a.resume, project.name)} (${timeAgo(a.resume.lastActiveAt)})`)
  if (a.worktree) lines.push(`Worktree ${a.worktree.path} on ${a.worktree.branch}, branched from ${a.worktree.base}`)
  return <span style={{ whiteSpace: 'pre-line' }}>{lines.join('\n')}</span>
}

export function AgentStrip({ project }: { project: ProjectInfo }) {
  const panes = usePanes(project)
  const focused = useStore((s) => s.focusedAgent[project.path]) ?? project.agents[0]?.id
  const menu = useContextMenu()
  const picker = useSessionPicker()
  const page = agentPage(project, focused ?? null)
  const pages = agentPageCount(project.agents.length)
  const layout = pageLayout(project.config, page)
  const many = project.agents.length > 1
  const pageKb = commandKeybinding('agent.nextPage')
  const fresh = useStore((s) => s.newAgents[project.path] ?? NO_IDS)
  // Agents the Assistant added on the page shown are seen.
  useEffect(() => {
    const here = pageAgents(project.agents, page).map((a) => a.id).filter((id) => fresh.includes(id))
    if (here.length) seenAgents(project.path, here)
  }, [fresh, page, project.agents, project.path])
  // The focused agent's tab stays in view when the tabs don't all fit.
  const tabs = useRef<HTMLDivElement>(null)
  useEffect(() => {
    tabs.current?.querySelector('.agent-tab.focused')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [focused, project.agents.length])
  return (
    <div className="agent-strip">
      {/* Scrolls sideways (mouse wheel too) when a project's agents don't fit; a line marks where each page starts. */}
      <div className="agent-tabs" ref={tabs} onWheel={(e) => e.deltaY && (e.currentTarget.scrollLeft += e.deltaY)}>
      {project.agents.map((a, i) => (
        <Tooltip key={a.id} content={<AgentTabTip project={project} a={a} />}>
          <div
            data-page-start={i > 0 && i % PAGE_AGENTS === 0 ? '' : undefined}
            className={cx('agent-tab', focused === a.id && 'focused', panes.includes(a.id) && 'shown')}
            onClick={() => showAgent(project, a.id)}
            onDoubleClick={() => set({ agentSettingsFor: { project: project.path, agentId: a.id } })}
            onContextMenu={(e) => {
              const { clientX: x, clientY: y } = e
              menu.open(e, agentMenu(project, a, () => void picker.openAt(project, a, x, y)))
            }}
          >
            <span className={cx('dot', a.live?.status ?? (project.active ? 'idle' : 'stopped'), a.live?.unseen && 'unseen')} />
            <ProviderIcon provider={agentProviderOf(project, a)} />
            <span className="agent-name">{a.name}</span>
            {a.worktree && (
              <span className="agent-branch">
                <Icon name="git-branch" /> {a.worktree.branch}
              </span>
            )}
            <Locks a={a} />
          </div>
        </Tooltip>
      ))}
      </div>
      <AddAgentButton project={project} className="subtle small agent-add" />
      <div className="grow" />
      {pages > 1 && (
        <div className="segmented page-switch">
          {Array.from({ length: pages }, (_, i) => {
            const onPage = pageAgents(project.agents, i)
            // Another page's most urgent agent shows as a dot on its button, or one the Assistant added there.
            const state = page === i ? null : mostUrgent(onPage.map((a) => a.live))
            const added = page !== i && onPage.some((a) => fresh.includes(a.id))
            return (
              <Tooltip key={i} content={`Page ${i + 1}: agents ${i * PAGE_AGENTS + 1}–${i * PAGE_AGENTS + onPage.length}${added ? ', with an agent the Assistant added' : ''}${pageKb ? ` (${formatKeybinding(pageKb)} for the next page)` : ''}`}>
                <button className={cx(page === i && 'active')} onClick={() => showPage(project, i)} aria-label={`Agent page ${i + 1}`}>
                  {i + 1}
                  {state ? <span className={cx('dot', state.status, state.unseen && 'unseen')} /> : added && <span className="dot added" />}
                </button>
              </Tooltip>
            )
          })}
        </div>
      )}
      {(many || layout !== 'single') && (
        <div className="segmented layout-switch">
          {SESSION_LAYOUTS.map((l) => (
            <Tooltip key={l.value} content={`${l.label}${pages > 1 ? ` for page ${page + 1}` : ''}${l.panes > 2 ? ' (works best on a wide window, or with the sidebar hidden: Ctrl+B)' : ''}`}>
              <button className={cx(layout === l.value && 'active')} onClick={() => void actions.setLayout(project.path, page, l.value)} aria-label={l.label}>
                <LayoutGlyph layout={l.value} />
              </button>
            </Tooltip>
          ))}
        </div>
      )}
      {menu.element}
      {picker.element}
    </div>
  )
}

/** An element's width, kept up to date as it resizes (a callback ref, so it works for an element that mounts later). */
export function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [w, setW] = useState(0)
  const observer = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    observer.current = ro
    setW(el.clientWidth)
  }, [])
  return [ref, w]
}

/** Header buttons with labels while the pane is wide, icons when narrower, and only in ⋯ (which has them all) when narrow. */
const LABELS_FROM = 620
const ICONS_FROM = 340

function PaneHeader({ project, a, focused }: { project: ProjectInfo; a: AgentInfo; focused: boolean }) {
  const menu = useContextMenu()
  const picker = useSessionPicker()
  const [ref, width] = useWidth<HTMLDivElement>()
  const settings = useStore((s) => s.settings)
  const usage = useLiveUsage(project, a.id)
  const live = a.live
  const idle = live && (live.status === 'ready' || live.status === 'finished')
  // Compact: while idle and there's a conversation; highlighted once the context passes the threshold.
  const threshold = compactThreshold(project.config, settings?.sessions.compactSuggestTokens ?? 0)
  const tokens = usage?.contextTokens ?? 0
  const suggested = threshold > 0 && tokens >= threshold
  const empty = !usage || usage.userMessages === 0 || tokens === 0
  const compacting = live?.status === 'working' && !!live.statusMessage?.startsWith('Compacting')
  const compactTip = compacting
    ? 'Compacting the conversation…'
    : idle && empty
      ? 'Nothing to compact yet: the conversation has no messages.'
      : !idle
        ? live?.status === 'waiting'
          ? 'The agent is waiting for your answer. Compact after it has finished.'
          : 'Available once the agent has finished.'
        : `Summarise the conversation to shrink its context${usage ? ` (now ${formatTokens(tokens)} tokens)` : ''}. The full history stays in the transcript.${suggested ? ' Recommended: the context is over your threshold.' : ''}`
  const pick = (x: number, y: number) => () => void picker.openAt(project, a, x, y)
  const size = width >= LABELS_FROM ? 'labels' : width >= ICONS_FROM ? 'icons' : 'menu'
  /** A header button: labelled or an icon with a tooltip, by the pane's width. */
  const btn = (icon: string, label: string, onClick: (e: React.MouseEvent<HTMLButtonElement>) => void, tone: string, opts: { disabled?: boolean; tip?: string } = {}) => (
    <Tooltip key={label} content={opts.tip ?? label}>
      <button type="button" className={cx('btn small pane-btn', tone, size === 'icons' && 'icon-only')} disabled={opts.disabled} aria-label={label} onClick={(e) => { e.stopPropagation(); onClick(e) }}>
        <Icon name={icon} />
        {size === 'labels' && <span>{label}</span>}
      </button>
    </Tooltip>
  )
  return (
    <div ref={ref} className={cx('pane-header-bar', focused && 'focused')} onMouseDown={() => focusAgent(project.path, a.id)} onContextMenu={(e) => menu.open(e, agentMenu(project, a, pick(e.clientX, e.clientY), size !== 'menu'))}>
      <StatusDot live={live} active={project.active} />
      <Tooltip content={providerName(agentProviderOf(project, a))}>
        <span>
          <ProviderIcon provider={agentProviderOf(project, a)} />
        </span>
      </Tooltip>
      <span className="agent-name">{a.name}</span>
      {a.worktree && (
        <Tooltip content={`Worktree ${a.worktree.path}, branched from ${a.worktree.base}`}>
          <span className="agent-branch">
            <Icon name="git-branch" /> {a.worktree.branch}
          </span>
        </Tooltip>
      )}
      <span className="faint pane-status">{live ? statusText(live) : 'Not running'}</span>
      <SessionTag project={project} a={a} />
      <Locks a={a} />
      <div className="grow" />
      {size !== 'menu' &&
        (live ? (
          <>
            {btn(compacting ? 'loading' : 'fold', 'Compact', () => set({ compactFor: { project: project.path, agentId: a.id } }), cx('subtle', suggested && idle && 'suggest'), { disabled: !idle || empty, tip: compactTip })}
            {btn('stop-circle', 'Stop', () => void actions.stopSession(project.path, a.id), 'tint-red', { tip: 'Stop this agent (the conversation is kept; resume it any time)' })}
            {btn('archive', 'Archive & New', () => void actions.archiveCurrent(project.path, a.id), 'subtle', { tip: 'Archive this session and start a new one' })}
          </>
        ) : (
          <>
            {btn('debug-continue', 'Resume', () => void actions.resumeLast(project.path, a.id), 'tint-amber', { disabled: !a.resume, tip: resumeTip(project, a) })}
            {btn('history', 'Resume a Session…', (e) => picker.openBelow(e.currentTarget, project, a), 'subtle')}
            {btn('add', 'New Session', () => void actions.newSession(project.path, a.id), 'primary')}
          </>
        ))}
      {a.worktree && size !== 'menu' && btn('git-merge', 'Merge…', () => set({ mergeFor: { project: project.path, agentId: a.id } }), 'subtle')}
      <IconButton icon="ellipsis" title="More" onClick={(e) => menu.open(e, agentMenu(project, a, pick(e.clientX, e.clientY), size !== 'menu'))} />
      {menu.element}
      {picker.element}
    </div>
  )
}

/**
 * The agent's session details: model and effort, permission mode, context used and cost. Clicking the model
 * opens the agent's settings (or `onSettings`), the context its project's Overview (or `onContext`).
 */
export function PaneFooter({ project, a, onSettings, onContext, settingsName = 'Agent Settings or Project Settings' }: { project: ProjectInfo; a: AgentInfo; onSettings?: () => void; onContext?: () => void; settingsName?: string }) {
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const usage = useLiveUsage(project, a.id)
  const provider = agentProviderOf(project, a)
  const pc = projectProviderConfig(project.config, provider)
  const ps = providerSettings(settings, provider)
  const live = a.live
  const model = effectiveModelLabel(provider, a.model || pc.model, ps.defaultModel, providers[provider]?.defaultModel ?? null)
  const effort = effortLabel(provider, live?.effort, a.effort ?? pc.effort, ps.defaultEffort)
  const threshold = compactThreshold(project.config, settings?.sessions.compactSuggestTokens ?? 0)
  const ctx = usage?.contextTokens ?? 0
  const over = threshold > 0 && ctx >= threshold
  const cost = live?.costUsd ?? usage?.costUsd ?? null
  const estimated = live?.costUsd !== undefined ? !!live.costEstimated : !!usage?.costEstimated
  return (
    <div className="pane-footer-bar" onMouseDown={() => focusAgent(project.path, a.id)}>
      <Tooltip content={`${providerName(provider)} model${effort ? ' and effort' : ''} ${live ? 'of this session' : 'for new sessions'}${live?.effort ? ' (effort as the session reports it)' : ''}. Change them in ${settingsName}.`}>
        <span className="pane-foot-item" onClick={() => (onSettings ? onSettings() : set({ agentSettingsFor: { project: project.path, agentId: a.id } }))}>
          {model}
          {effort && <span className="faint"> · {effort}</span>}
        </span>
      </Tooltip>
      <ModeBadge project={project} a={a} variant="pane" />
      <div className="grow" />
      {usage && (
        <Tooltip content={`Context: ${ctx.toLocaleString()} tokens${usage.contextWindow ? ` of ${usage.contextWindow.toLocaleString()}` : ''} · ${usage.compactions.length} compaction(s)${over ? ' — consider compacting' : ''}`}>
          <span className={cx('pane-foot-item', over && 'warn')} onClick={() => (onContext ? onContext() : setProjectTab(project.path, 'overview'))}>
            <Icon name="dashboard" /> {formatTokens(ctx)} ctx
          </span>
        </Tooltip>
      )}
      {cost !== null && cost > 0 && (
        <Tooltip content={estimated ? 'API-equivalent cost of this session, estimated by Hive from its tokens' : 'API-equivalent cost of this session, as the provider reports it'}>
          <span className="pane-foot-item faint">
            {estimated ? '≈' : ''}${cost < 0.01 ? '<0.01' : cost.toFixed(2)}
          </span>
        </Tooltip>
      )}
    </div>
  )
}

/** What a pane shows when its agent has no terminal yet, or when the pane is empty. */
function PaneBody({ project, a, hasTerminal, single }: { project: ProjectInfo; a: AgentInfo | null; hasTerminal: boolean; single: boolean }) {
  if (!a) {
    return (
      <div className="pane-placeholder">
        <p className="faint">Empty pane</p>
        {project.agents.length < MAX_AGENTS && <AddAgentButton project={project} className="subtle small" />}
      </div>
    )
  }
  const setupPending = !!a.worktree && a.needsSetup && !!project.config.worktreeSetup.trim()
  if (a.live) return null
  if (hasTerminal) {
    // The session ended: its output stays visible above this bar.
    return (
      <div className={cx('session-ended', !single && 'compact')}>
        <Icon name="debug-disconnect" />
        <span className="grow">{setupPending ? 'Setup did not finish.' : single ? 'The session has ended. Resume it, or start a new one.' : 'Session ended.'}</span>
        {setupPending ? (
          <>
            <button className="btn small primary" onClick={() => void actions.newSession(project.path, a.id)}>
              <Icon name="refresh" /> Retry Setup
            </button>
            <button className="btn small subtle" onClick={() => void actions.newSession(project.path, a.id, { skipSetup: true })}>
              Start Without Setup
            </button>
          </>
        ) : (
          <>
            <ResumeButton project={project} a={a} className={cx('primary', !single && 'small')} />
            <button className={cx('btn subtle', !single && 'small')} onClick={() => void actions.newSession(project.path, a.id)}>
              <Icon name="add" /> New Session
            </button>
          </>
        )}
      </div>
    )
  }
  if (single) return null
  return (
    <div className="pane-placeholder">
      <p>
        <strong>{a.name}</strong> is not running.
      </p>
      {a.worktree && (
        <p className="faint">
          Works in its own worktree on <code>{a.worktree.branch}</code>.
        </p>
      )}
      {setupPending && <p className="faint">Its setup command runs first.</p>}
      <div className="btns">
        <button className="btn primary small" onClick={() => void actions.newSession(project.path, a.id)}>
          <Icon name="add" /> New Session
        </button>
        <ResumeButton project={project} a={a} className="tint-amber small" />
      </div>
    </div>
  )
}

/** Pane frames (headers, borders, placeholders) over the terminals of the selected project. */
export function PaneChrome({ project, panes }: { project: ProjectInfo; panes: (string | null)[] }) {
  const epochs = useStore((s) => s.sessionEpoch)
  const focused = useStore((s) => s.focusedAgent[project.path]) ?? project.agents[0]?.id
  const single = panes.length === 1
  return (
    <>
      {panes.map((id, i) => {
        const a = project.agents.find((x) => x.id === id) ?? null
        const r = paneRect(panes.length, i)
        const hasTerminal = !!a && (!!a.live || epochs[projectKey(project.path, a.id)] !== undefined)
        return (
          <div
            key={`${i}:${id ?? ''}`}
            className={cx('agent-pane', !single && 'framed', !single && focused === id && 'focused', r.x > 0 && 'left-border', r.y > 0 && 'top-border')}
            style={{ left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` }}
          >
            {/* One agent or several: every agent pane has the same header and footer. */}
            {a && <PaneHeader project={project} a={a} focused={!single && focused === a.id} />}
            <div className="agent-pane-body" style={{ top: a ? PANE_HEADER : 0, bottom: a ? PANE_FOOTER : 0 }}>
              <PaneBody project={project} a={a} hasTerminal={hasTerminal} single={single} />
            </div>
            {a && <PaneFooter project={project} a={a} />}
          </div>
        )
      })}
    </>
  )
}
