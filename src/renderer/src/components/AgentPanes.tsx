import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { CardChip, useAgentCards } from './CardChip'
import { MAX_AGENTS, PAGE_AGENTS, SESSION_LAYOUTS, agentPageCount, dropIndex, pageEndIndex, compactThreshold, contextPercent, effectiveModelLabel, effortLabel, formatBytes, layoutPanes, mergeBlocked, mostUrgent, pageAgents, pageLayout, sessionInAgentFolder, transcriptWarnLimit, unmergedWork } from '@shared/defaults'
import type { AgentInfo, LiveSessionState, ProjectInfo, SessionLayout, SessionListItem, SessionUsage } from '@shared/types'
import type { StartFailure } from '@shared/startFailure'
import * as actions from '../actions'
import { call } from '../api'
import { NO_IDS, NO_PROJECTS, agentPage, agentProviderOf, clearStartFailure, focusAgent, focusedAgentId, isAssistantPath, openInSessionsTab, paneAssignment, projectKey, prompt, revealAgent, seenAgents, set, setProjectTab, showAgent, showInOverview, showPage, useStore } from '../store'
import { useLiveUsage, useLiveUsageState } from '../usage'
import { commandKeybinding } from '../commands'
import { cx, formatKeybinding, formatTokens, sessionLabel, timeAgo } from '../util'
import { TerminalView } from './TerminalView'
import { offerTip } from '../tips'
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

/** A running session's name (see sessionLabel): the latest rename, else its title, else when it started. */
function liveSessionLabel(project: ProjectInfo, live: LiveSessionState, usage: SessionUsage | null | undefined): string {
  return sessionLabel({ id: live.sessionId, name: live.sessionName, title: usage?.title, customTitle: usage?.customTitle, titleAtRename: live.titleAtRename, startedAt: live.startedAt }, project.name)
}

async function renameSession(project: ProjectInfo, sessionId: string, current: string): Promise<void> {
  const name = (await prompt({ title: 'Rename session', initial: current, confirmLabel: 'Rename' }))?.trim()
  if (!name || name === current) return
  await actions.attempt('Could not rename', () => call('session:rename', project.path, sessionId, name))
}

/**
 * The session an agent is running, in its footer: its name, with details on hover. Click to read it in the
 * Sessions tab; right-click to rename it.
 */
function SessionName({ project, a, usage }: { project: ProjectInfo; a: AgentInfo; usage: SessionUsage | null | undefined }) {
  const menu = useContextMenu()
  const live = a.live
  if (!live || live.settingUp || !live.sessionId) return null
  const label = liveSessionLabel(project, live, usage)
  const tip = `${label}
Running since ${new Date(live.startedAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
Session ${live.sessionId}
Click to read it in the Sessions tab; right-click to rename it.`
  const open = (): void => openInSessionsTab(project.path, live.sessionId)
  return (
    <>
      <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{tip}</span>}>
        <span
          className="pane-foot-item session-tag"
          onClick={open}
          onContextMenu={(e) =>
            menu.open(e, [
              { label: 'Rename…', icon: 'tag', onClick: () => void renameSession(project, live.sessionId, label) },
              { label: 'Open in Sessions Tab', icon: 'history', onClick: open }
            ])
          }
        >
          <Icon name="comment-discussion" /> <span className="session-tag-text">{label}</span>
        </span>
      </Tooltip>
      {menu.element}
    </>
  )
}

// Dragging an agent (its strip tab or pane header) moves it in the project's order: dropped on a tab it goes before
// or after it, on a pane it takes that agent's place, on a page button to the end of that page.
const AGENT_DRAG = 'application/x-hive-agent'

function agentDragProps(project: ProjectInfo, a: AgentInfo) {
  if (project.agents.length < 2 || isAssistantPath(project.path)) return {}
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData(AGENT_DRAG, a.id)
      e.dataTransfer.setData('text/plain', a.name)
      // After the browser has taken its drag image: drop targets appear over the panes.
      setTimeout(() => set({ agentDrag: { project: project.path, id: a.id } }), 0)
    },
    onDragEnd: () => set({ agentDrag: null })
  }
}

/** The agent being dragged in this project, if any. */
function useAgentDrag(project: ProjectInfo): string | null {
  return useStore((s) => (s.agentDrag?.project === project.path ? s.agentDrag.id : null))
}

function dropAgent(project: ProjectInfo, index: number): void {
  const id = useStore.getState().agentDrag?.id
  set({ agentDrag: null })
  if (id) void actions.moveAgent(project.path, id, index)
}

/** Move Left / Move Right, for a project with several agents (they cross pages at the edges). */
function moveItems(project: ProjectInfo, a: AgentInfo): MenuEntry[] {
  if (project.agents.length < 2 || isAssistantPath(project.path)) return []
  const i = project.agents.findIndex((x) => x.id === a.id)
  const kb = (id: string): string | undefined => {
    const k = commandKeybinding(id)
    return k ? formatKeybinding(k) : undefined
  }
  return [
    { separator: true },
    { label: 'Move Left', icon: 'arrow-left', disabled: i <= 0, keybinding: kb('agent.moveLeft'), onClick: () => actions.nudgeAgent(-1, project.path, a.id) },
    { label: 'Move Right', icon: 'arrow-right', disabled: i >= project.agents.length - 1, keybinding: kb('agent.moveRight'), onClick: () => actions.nudgeAgent(1, project.path, a.id) }
  ]
}

/** An agent's menu. `inHeader`: the pane's header shows the session and Merge buttons, so the menu leaves them out. */
function agentMenu(project: ProjectInfo, a: AgentInfo, pick: () => void, inHeader = false): MenuEntry[] {
  const worktree = !!a.worktree
  const archiveItem = { label: 'Archive and Start New…', icon: 'archive', onClick: () => void actions.archiveCurrent(project.path, a.id) }
  return [
    ...(inHeader
      ? // The header's buttons are Compact and Stop; archiving is used less often, so it's here.
        a.live
        ? [archiveItem]
        : []
      : a.live
      ? [
          { label: 'Stop', icon: 'debug-stop', onClick: () => void actions.stopSession(project.path, a.id) },
          { label: 'Compact…', icon: 'fold', disabled: !(a.live.status === 'ready' || a.live.status === 'finished'), onClick: () => set({ compactFor: { project: project.path, agentId: a.id } }) },
          archiveItem
        ]
      : [
          { label: 'Resume', icon: 'debug-continue', disabled: !a.resume, onClick: () => void actions.resumeLast(project.path, a.id) },
          { label: 'Resume a Session…', icon: 'history', onClick: pick },
          { label: 'New Session', icon: 'add', onClick: () => void actions.newSession(project.path, a.id) }
        ]),
    { label: 'Hand Over to…', icon: 'arrow-swap', onClick: () => set({ handOverFor: { project: project.path, agentId: a.id } }) },
    ...moveItems(project, a),
    { separator: true },
    { label: 'Agent Settings…', icon: 'settings', onClick: () => set({ agentSettingsFor: { project: project.path, agentId: a.id } }) },
    ...(worktree
      ? [
          { label: 'Review Changes', icon: 'git-compare', onClick: () => reviewChanges(project, a) },
          ...(inHeader ? [] : [{ label: 'Merge…', icon: 'git-merge', disabled: !!mergeBlocked(a.name, a.live?.status), detail: mergeBlocked(a.name, a.live?.status) ?? undefined, onClick: () => set({ mergeFor: { project: project.path, agentId: a.id } }) }]),
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

/** A worktree agent's work not merged into the project folder yet (null: not a worktree agent, or not checked yet). */
function useUnmerged(project: ProjectInfo, a: AgentInfo): ReturnType<typeof unmergedWork> {
  const st = useStore((s) => (a.worktree ? s.branchStatus[projectKey(project.path, a.id)] : undefined))
  return a.worktree ? unmergedWork(st) : null
}

/** On an agent's tab: ↑ and its unmerged commits (• for only uncommitted files). */
function UnmergedBadge({ project, a }: { project: ProjectInfo; a: AgentInfo }) {
  const work = useUnmerged(project, a)
  if (!work?.badge) return null
  return (
    <span className="agent-unmerged" aria-label={work.text}>
      {work.badge === '•' ? '•' : <><Icon name="arrow-up" />{work.badge}</>}
    </span>
  )
}

function Locks({ a }: { a: AgentInfo }) {
  const files = a.live?.lockedFiles
  if (!files?.length) return null
  // A worktree has one agent, so nobody waits for its files; in a shared folder the lock is what matters.
  const title = a.worktree ? 'Files it is editing this turn:' : 'Files it is editing this turn. Other agents in this folder wait until it finishes with them:'
  return (
    <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{`${title}\n${files.slice(0, 20).join('\n')}${files.length > 20 ? `\n…and ${files.length - 20} more` : ''}`}</span>}>
      <span className="agent-locks">
        <Icon name="lock" /> {files.length}
      </span>
    </Tooltip>
  )
}

/** The row above the Session tab: one tab per agent, Add Agent and the layout choice. */
function AgentTabTip({ project, a }: { project: ProjectInfo; a: AgentInfo }) {
  const usage = useLiveUsage(project, a.live ? a.id : undefined)
  const cards = useAgentCards(project, a.id)
  const unmerged = useUnmerged(project, a)
  const live = a.live
  const failure = useStartFailure(project, a)
  const lines = [`${a.name} (${providerName(agentProviderOf(project, a))}): ${live ? statusText(live) : failure ? `failed to start: ${failure.reason.split('\n')[0]}` : 'not running'}`]
  for (const c of cards) lines.push(`Working on #${c.number} ${c.title}`)
  if (live) lines.push(`Session: ${liveSessionLabel(project, live, usage)}`)
  else if (a.resume) lines.push(`Resume opens: ${sessionLabel(a.resume, project.name)} (${timeAgo(a.resume.lastActiveAt)})`)
  if (a.worktree) lines.push(`Worktree ${a.worktree.path} on ${a.worktree.branch}, branched from ${a.worktree.base}`)
  if (unmerged?.badge) lines.push(`To merge: ${unmerged.text}`)
  return <span style={{ whiteSpace: 'pre-line' }}>{lines.join('\n')}</span>
}

export function AgentStrip({ project }: { project: ProjectInfo }) {
  const panes = usePanes(project)
  // A second agent: the tip about layouts and file locks, the first time.
  const several = project.agents.length >= 2
  useEffect(() => void (several && offerTip('second-agent')), [several])
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
  const dragging = useAgentDrag(project)
  const removing = useStore((s) => s.running)
  // Where a dragged agent would land: before this agent (null: at the end).
  const [dropBefore, setDropBefore] = useState<string | null | undefined>(undefined)
  const [dropPage, setDropPage] = useState<number | null>(null)
  useEffect(() => {
    if (!dragging) {
      setDropBefore(undefined)
      setDropPage(null)
    }
  }, [dragging])
  const ids = project.agents.map((a) => a.id)
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
            className={cx('agent-tab', focused === a.id && 'focused', panes.includes(a.id) && 'shown', dragging === a.id && 'dragging', dragging && dropBefore === a.id && 'drop-before', dragging && dropBefore === null && i === project.agents.length - 1 && 'drop-after')}
            data-agent={a.id}
            {...agentDragProps(project, a)}
            onDragOver={(e) => {
              if (!dragging) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              const r = e.currentTarget.getBoundingClientRect()
              // The left half drops before this agent, the right half before the next one.
              setDropBefore(e.clientX < r.left + r.width / 2 ? a.id : (project.agents[i + 1]?.id ?? null))
              setDropPage(null)
            }}
            onDrop={(e) => {
              e.preventDefault()
              if (dragging && dropBefore !== undefined) dropAgent(project, dropIndex(ids, dragging, dropBefore))
            }}
            onClick={() => showAgent(project, a.id)}
            onDoubleClick={() => set({ agentSettingsFor: { project: project.path, agentId: a.id } })}
            onContextMenu={(e) => {
              const { clientX: x, clientY: y } = e
              menu.open(e, agentMenu(project, a, () => void picker.openAt(project, a, x, y)))
            }}
          >
            {removing[`removeAgent:${project.path}#${a.id}`] ? <Icon name="loading" spin title="Removing…" /> : <AgentDot project={project} a={a} />}
            <ProviderIcon provider={agentProviderOf(project, a)} />
            <span className="agent-name">{a.name}</span>
            {a.worktree && (
              <span className="agent-branch">
                <Icon name="git-branch" /> {a.worktree.branch}
              </span>
            )}
            <CardChip project={project} a={a} short tip={false} />
            <Locks a={a} />
            <UnmergedBadge project={project} a={a} />
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
                <button
                  className={cx(page === i && 'active', dragging && dropPage === i && 'drop-target')}
                  onClick={() => showPage(project, i)}
                  aria-label={`Agent page ${i + 1}`}
                  onDragOver={(e) => {
                    if (!dragging) return
                    e.preventDefault()
                    setDropPage(i)
                    setDropBefore(undefined)
                  }}
                  onDragLeave={() => setDropPage(null)}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (dragging) dropAgent(project, pageEndIndex(project.agents.length, i))
                  }}
                >
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
  const unmerged = useUnmerged(project, a)
  const live = a.live
  const failure = useStartFailure(project, a)
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
  /** A header button: labelled or an icon with a tooltip, by the pane's width (`iconOnly`: always an icon, like the Assistant's). */
  const btn = (icon: string, label: string, onClick: (e: React.MouseEvent<HTMLButtonElement>) => void, tone: string, opts: { disabled?: boolean; tip?: string; iconOnly?: boolean; count?: string | null } = {}) => (
    <Tooltip key={label} content={opts.tip ?? label}>
      <button type="button" className={cx('btn small pane-btn', tone, (size === 'icons' || opts.iconOnly) && 'icon-only')} disabled={opts.disabled} aria-label={label} onClick={(e) => { e.stopPropagation(); onClick(e) }}>
        <Icon name={icon} />
        {size === 'labels' && !opts.iconOnly && <span>{label}</span>}
        {opts.count && <span className="btn-count">{opts.count}</span>}
      </button>
    </Tooltip>
  )
  return (
    <div ref={ref} className={cx('pane-header-bar', focused && 'focused')} {...agentDragProps(project, a)} onMouseDown={() => focusAgent(project.path, a.id)} onContextMenu={(e) => menu.open(e, agentMenu(project, a, pick(e.clientX, e.clientY), size !== 'menu'))}>
      {!live && failure ? (
        <Tooltip content={`Failed to start: ${failure.reason}`}>
          <span className="dot error" />
        </Tooltip>
      ) : (
        <StatusDot live={live} active={project.active} />
      )}
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
      {live?.question ? (
        <Tooltip content={live.question.text ? `Asks: ${live.question.text}` : 'Asks you something'}>
          <span className="faint pane-status asks">{statusText(live)}</span>
        </Tooltip>
      ) : (
        <span className={cx('faint pane-status', !live && failure && 'failed')}>{live ? statusText(live) : failure ? 'Failed to start' : 'Not running'}</span>
      )}
      <CardChip project={project} a={a} short={size === 'menu'} />
      <Locks a={a} />
      <div className="grow" />
      {size !== 'menu' &&
        (live ? (
          <>
            {btn(compacting ? 'loading' : 'fold', 'Compact', () => set({ compactFor: { project: project.path, agentId: a.id } }), cx('subtle', suggested && idle && 'suggest'), { disabled: !idle || empty, tip: compactTip, iconOnly: true })}
            {btn('stop-circle', 'Stop', () => void actions.stopSession(project.path, a.id), 'tint-red', { tip: 'Stop this agent (the conversation is kept; resume it any time)', iconOnly: true })}
          </>
        ) : (
          <>
            {btn('debug-continue', 'Resume', () => void actions.resumeLast(project.path, a.id), 'tint-amber', { disabled: !a.resume, tip: resumeTip(project, a) })}
            {btn('history', 'Resume a Session…', (e) => picker.openBelow(e.currentTarget, project, a), 'subtle')}
            {btn('add', 'New Session', () => void actions.newSession(project.path, a.id), 'primary')}
          </>
        ))}
      {a.worktree &&
        size !== 'menu' &&
        btn('git-merge', 'Merge…', () => set({ mergeFor: { project: project.path, agentId: a.id } }), cx('subtle', unmerged?.badge && 'suggest'), {
          count: unmerged?.badge,
          // Not while it is in the middle of a task; the count still shows what is waiting to be merged.
          disabled: !!mergeBlocked(a.name, live?.status),
          tip: [mergeBlocked(a.name, live?.status), unmerged ? `Merge ${a.worktree.branch}: ${unmerged.text}` : `Merge ${a.worktree.branch} into the project folder`].filter(Boolean).join(' ')
        })}
      <IconButton icon="ellipsis" title="More" onClick={(e) => menu.open(e, agentMenu(project, a, pick(e.clientX, e.clientY), size !== 'menu'))} />
      {menu.element}
      {picker.element}
    </div>
  )
}

/**
 * The agent's session details: model and effort, permission mode, the session's name, context used and cost. Clicking the model
 * opens the agent's settings (or `onSettings`), the context its session in the project's Overview (or `onContext`), the
 * transcript size Hand Over to… (or `onTranscript`, with `transcriptAdvice` in its tooltip).
 */
export function PaneFooter({
  project,
  a,
  onSettings,
  onContext,
  onTranscript,
  transcriptAdvice = 'Hand it over to a new conversation: click for Hand Over to…, and choose the agent itself.',
  settingsName = 'Agent Settings or Project Settings',
  showSession = true
}: {
  project: ProjectInfo
  a: AgentInfo
  onSettings?: () => void
  onContext?: () => void
  onTranscript?: () => void
  transcriptAdvice?: string
  settingsName?: string
  /** The running session's name, right-aligned before the context (agents; the Assistant shows its own). */
  showSession?: boolean
}) {
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const { usage, pending } = useLiveUsageState(project, a.id)
  const provider = agentProviderOf(project, a)
  const pc = projectProviderConfig(project.config, provider)
  const ps = providerSettings(settings, provider)
  const live = a.live
  const model = effectiveModelLabel(provider, a.model || pc.model, ps.defaultModel, providers[provider]?.defaultModel ?? null)
  const effort = effortLabel(provider, live?.effort, a.effort ?? pc.effort, ps.defaultEffort)
  const threshold = compactThreshold(project.config, settings?.sessions.compactSuggestTokens ?? 0)
  const ctx = usage?.contextTokens ?? 0
  const pct = contextPercent(ctx, usage?.contextWindow)
  const over = threshold > 0 && ctx >= threshold
  const cost = live?.costUsd ?? usage?.costUsd ?? null
  const estimated = live?.costUsd !== undefined ? !!live.costEstimated : !!usage?.costEstimated
  const bytes = live?.transcriptBytes
  const sizeLimit = transcriptWarnLimit(project.config, settings?.sessions.transcriptWarnMB ?? 0)
  const long = bytes !== undefined && sizeLimit > 0 && bytes >= sizeLimit * 1024 * 1024
  // The first time either turns amber: the tip about what to do.
  useEffect(() => void (long && offerTip('transcript-long')), [long])
  useEffect(() => void (over && offerTip('compact-suggested')), [over])
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
      {showSession && <SessionName project={project} a={a} usage={usage} />}
      {usage ? (
        <Tooltip content={`Context: ${ctx.toLocaleString()} tokens${usage.contextWindow ? ` of ${usage.contextWindow.toLocaleString()}` : ''} · ${usage.compactions.length} compaction(s)${over ? ' — consider compacting' : ''}${usage.stale ? '\nCouldn’t read it again just now: this may be behind.' : ''}`}>
          <span className={cx('pane-foot-item', over && 'warn', usage.stale && 'stale')} onClick={() => (onContext ? onContext() : showInOverview(project.path, a.id))}>
            <Icon name="dashboard" />
            {pct === null ? (
              `${formatTokens(ctx)} ctx`
            ) : (
              // In a narrow footer the tokens give way and the percentage stays.
              <>
                <span className="ctx-tokens">{formatTokens(ctx)} · </span>
                {pct}%
              </>
            )}
          </span>
        </Tooltip>
      ) : (
        // A new or other conversation: its own numbers aren't read yet (the previous one's never show).
        pending && (
          <Tooltip content="Reading this conversation's usage…">
            <span className="pane-foot-item faint usage-pending">
              <Icon name="dashboard" /> – ctx
            </span>
          </Tooltip>
        )
      )}
      {bytes !== undefined && (
        <Tooltip
          content={`Transcript: ${formatBytes(bytes)}${sizeLimit > 0 ? ` (flagged over ${sizeLimit} MB: Settings → Sessions)` : ''}. A long conversation slows down the CLI and Hive, and compacting doesn't shrink the file: it keeps the whole history.${long ? ` ${transcriptAdvice}` : ''}`}
        >
          <span className={cx('pane-foot-item', long ? 'warn' : 'faint')} onClick={() => (onTranscript ? onTranscript() : set({ handOverFor: { project: project.path, agentId: a.id } }))}>
            <Icon name="file" /> {formatBytes(bytes)}
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

/** Why an agent's CLI exited before its session started, if it did (until its next launch or ✕). */
function useStartFailure(project: ProjectInfo, a: AgentInfo | null): StartFailure | undefined {
  return useStore((s) => (a ? s.startFailures[projectKey(project.path, a.id)] : undefined))
}

/** An agent tab's status dot: red when its last launch failed to start. */
function AgentDot({ project, a }: { project: ProjectInfo; a: AgentInfo }) {
  const failure = useStartFailure(project, a)
  return <span className={cx('dot', a.live?.status ?? (failure ? 'error' : project.active ? 'idle' : 'stopped'), a.live?.unseen && 'unseen')} />
}

/** In place of "Session ended": why the CLI didn't start, what to do about it, Retry. The terminal above keeps the full output. */
function StartFailedBar({ project, a, failure, single }: { project: ProjectInfo; a: AgentInfo; failure: StartFailure; single: boolean }) {
  const retry = (): void => void (failure.resumed ? actions.resumeLast(project.path, a.id) : actions.newSession(project.path, a.id))
  return (
    <div className={cx('session-ended start-failed', !single && 'compact')} role="alert">
      <Icon name="error" />
      <div className="grow start-failed-text">
        <div className="start-failed-reason">
          <strong>Couldn't start:</strong> {failure.reason}
        </div>
        {failure.hint && <div className="start-failed-hint">{failure.hint}</div>}
      </div>
      <div className="start-failed-actions">
        <button className="btn small primary" onClick={retry}>
          <Icon name="refresh" /> Retry
        </button>
        {failure.fix === 'agent-setup' ? (
          <button className="btn small subtle" onClick={() => set({ setupOpen: agentProviderOf(project, a) })}>
            Agent Setup…
          </button>
        ) : (
          <button className="btn small subtle" onClick={() => set({ agentSettingsFor: { project: project.path, agentId: a.id } })}>
            Agent Settings…
          </button>
        )}
        <IconButton icon="close" title="Dismiss (the terminal keeps the output)" onClick={() => clearStartFailure(project.path, a.id)} />
      </div>
    </div>
  )
}

/** What a pane shows when its agent has no terminal yet, or when the pane is empty. */
function PaneBody({ project, a, hasTerminal, single }: { project: ProjectInfo; a: AgentInfo | null; hasTerminal: boolean; single: boolean }) {
  const failure = useStartFailure(project, a)
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
  if (hasTerminal && failure && !setupPending) return <StartFailedBar project={project} a={a} failure={failure} single={single} />
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
  const dragging = useAgentDrag(project)
  const [over, setOver] = useState<string | null>(null)
  useEffect(() => setOver(null), [dragging])
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
            {/* While an agent is dragged: drop it here to put it in this agent's place. */}
            {dragging && a && a.id !== dragging && (
              <div
                className={cx('pane-drop', over === a.id && 'over')}
                onDragOver={(e) => {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  setOver(a.id)
                }}
                onDragLeave={() => setOver((o) => (o === a.id ? null : o))}
                onDrop={(e) => {
                  e.preventDefault()
                  dropAgent(project, project.agents.findIndex((x) => x.id === a.id))
                }}
              >
                <span>
                  <Icon name="arrow-swap" /> Move here
                </span>
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}
