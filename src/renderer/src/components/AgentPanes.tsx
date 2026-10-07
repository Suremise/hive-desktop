import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { CardChip, useAgentCards, useAgentReviews } from './CardChip'
import { modelCaps } from '@shared/models'
import { MAX_AGENTS, SESSION_LAYOUTS, agentPageCount, agentsPerPage, dropIndex, pageEndIndex, compactThreshold, contextPercent, agentModelShown, effortLabel, formatBytes, isCompacting, layoutPanes, mergeBlocked, mostUrgent, pageAgents, projectLayout, sessionInAgentFolder, transcriptWarnLimit, unmergedWork } from '@shared/defaults'
import type { AgentInfo, LiveSessionState, PageLayout, ProjectInfo, SessionLayout, SessionListItem, SessionUsage } from '@shared/types'
import { TEMPLATE_SCOPES, type TemplateEntry, type TemplateScope } from '@shared/templates'
import type { StartFailure } from '@shared/startFailure'
import { formatDateTime, formatWhen } from '@shared/dates'
import * as actions from '../actions'
import { call, errorMessage } from '../api'
import { NO_IDS, NO_PROJECTS, agentPage, agentProviderOf, clearStartFailure, focusAgent, focusedAgentId, isAssistantPath, notify, openInSessionsTab, paneAssignment, projectKey, prompt, revealAgent, seenAgents, set, setProjectTab, showAgent, showInOverview, showPage, useDateStyle, useStore } from '../store'
import { useLiveUsage, useLiveUsageState } from '../usage'
import { commandKeybinding } from '../commands'
import { cx, formatKeybinding, formatTokens, sessionLabel, timeAgo } from '../util'
import { TerminalView } from './TerminalView'
import { offerTip } from '../tips'
import { onStripMenu, takeStripMenu, type StripMenu } from '../stripMenus'
import { ModeBadge } from './PermissionMode'
import { ProviderIcon } from './ProviderIcon'
import { contextLines, projectProviderConfig, providerName, providerSettings } from '@shared/providers'
import { unpricedModel, unpricedText } from '@shared/prices'
import { Icon, IconButton, ReviewMark, signInNote, statusText, StatusDot, Tooltip, useContextMenu, type MenuEntry } from './ui'

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
  if (!project) return []
  return paneAssignment(project, focused && project.agents.some((a) => a.id === focused) ? focused : focusedAgentId(project))
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
  // Conversations only: a sub-session (a Codex guardian review, say) is never resumed.
  const all = list.filter((s) => s.source === 'hive' && !s.archived && !s.sub && sessionInAgentFolder(project.path, a, s))
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

/** The colour every secondary Resume button wears (agent panes, the project header, the Assistant's panel): Resume's (#344). */
export const RESUME_TINT = 'act-resume'

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
 * The session an agent is running, in its footer: its icon, with its name and when it started on hover. Click to
 * read it in the Sessions tab; right-click to rename it.
 */
function SessionName({ project, a, usage }: { project: ProjectInfo; a: AgentInfo; usage: SessionUsage | null | undefined }) {
  const menu = useContextMenu()
  const live = a.live
  if (!live || live.settingUp || !live.sessionId) return null
  const label = liveSessionLabel(project, live, usage)
  const tip = `${label}
Running since ${formatDateTime(live.startedAt)}
Session ${live.sessionId}
Click to read it in the Sessions tab; right-click to rename it.`
  const open = (): void => openInSessionsTab(project.path, live.sessionId)
  return (
    <>
      <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{tip}</span>}>
        <span
          className="pane-foot-item session-tag"
          aria-label={`Session: ${label}`}
          onClick={open}
          onContextMenu={(e) =>
            menu.open(e, [
              { label: 'Rename…', icon: 'tag', onClick: () => void renameSession(project, live.sessionId, label) },
              { label: 'Open in Sessions Tab', icon: 'history', onClick: open }
            ])
          }
        >
          <Icon name="comment-discussion" />
        </span>
      </Tooltip>
      {menu.element}
    </>
  )
}

// Dragging an agent (its strip tab or pane header) changes the project's order, which the panes follow (#135): dropped
// on a tab it goes before or after it, on another agent's pane the two swap, on an empty pane to the end, on a page
// button to the end of that page (held over one, that page shows).
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

/** A dragged agent dropped on another's pane: they swap places (#135). */
function swapDrop(project: ProjectInfo, otherId: string): void {
  const id = useStore.getState().agentDrag?.id
  set({ agentDrag: null })
  if (id && id !== otherId) void actions.swapAgents(project.path, id, otherId)
}

/** How long a dragged agent hovers over a page button before that page shows, so it can be dropped on one of its panes. */
const PAGE_HOVER_MS = 600

/**
 * Ends a drag Hive is tracking when the browser's own end of it can't reach its source: a pane header dragged to another
 * page is no longer on screen to get `dragend` (Escape, or a drop outside any target). Ended at once by Escape (its
 * keyup: the browser's drag takes the keydown), the button's release with no drop to take it, a dragleave that nothing
 * follows, any drop or drag end in the window, or the mouse moving with no button down.
 */
function useDragCleanup(): void {
  const dragging = useStore((s) => !!s.agentDrag)
  useEffect(() => {
    if (!dragging) return
    const clear = (): void => {
      if (useStore.getState().agentDrag) set({ agentDrag: null })
    }
    // Over: after the drop's own handlers.
    const end = (): void => void setTimeout(clear, 0)
    const move = (e: MouseEvent): void => {
      if (e.buttons === 0) end()
    }
    // Escape cancels at once (#135). The browser's own drag takes its keydown; the page gets the keyup.
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') clear()
    }
    // The button let go with no drop to take it (a cancelled drag): over, after any drop's own handlers.
    const up = (): void => void setTimeout(clear, 0)
    // A cancelled drag (Escape in the browser's own drag, a release outside the window) ends with a dragleave at the
    // element under the pointer and nothing after it; moving between elements sends the next one's dragenter just
    // before the dragleave. So a dragleave with no dragenter just before it, and no drag event after it, ends the drag.
    let entered = 0
    let pending: ReturnType<typeof setTimeout> | undefined
    const enter = (): void => {
      entered = Date.now()
      clearTimeout(pending)
    }
    const over = (): void => clearTimeout(pending)
    const leave = (): void => {
      if (Date.now() - entered < 50) return
      clearTimeout(pending)
      pending = setTimeout(clear, 100)
    }
    document.addEventListener('drop', end)
    document.addEventListener('dragend', end, true)
    document.addEventListener('mousemove', move)
    document.addEventListener('keydown', key, true)
    document.addEventListener('keyup', key, true)
    document.addEventListener('mouseup', up, true)
    document.addEventListener('pointerup', up, true)
    document.addEventListener('dragenter', enter, true)
    document.addEventListener('dragover', over, true)
    document.addEventListener('dragleave', leave, true)
    return () => {
      clearTimeout(pending)
      document.removeEventListener('drop', end)
      document.removeEventListener('dragend', end, true)
      document.removeEventListener('mousemove', move)
      document.removeEventListener('keydown', key, true)
      document.removeEventListener('keyup', key, true)
      document.removeEventListener('mouseup', up, true)
      document.removeEventListener('pointerup', up, true)
      document.removeEventListener('dragenter', enter, true)
      document.removeEventListener('dragover', over, true)
      document.removeEventListener('dragleave', leave, true)
    }
  }, [dragging])
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
  const archiveItem = { label: 'Archive and Start New…', icon: 'archive', action: 'archive-start' as const, onClick: () => void actions.archiveCurrent(project.path, a.id) }
  return [
    ...(inHeader
      ? // The header's buttons are Compact and Stop; archiving is used less often, so it's here.
        a.live
        ? [archiveItem]
        : []
      : a.live
      ? [
          { label: 'Stop', icon: 'debug-stop', action: 'stop' as const, onClick: () => void actions.stopSession(project.path, a.id) },
          { label: 'Compact…', icon: 'fold', disabled: !(a.live.status === 'ready' || a.live.status === 'finished' || a.live.status === 'watching'), onClick: () => set({ compactFor: { project: project.path, agentId: a.id } }) },
          archiveItem
        ]
      : [
          { label: 'Resume', icon: 'debug-continue', action: 'resume' as const, disabled: !a.resume, onClick: () => void actions.resumeLast(project.path, a.id) },
          { label: 'Resume a Session…', icon: 'history', action: 'resume' as const, onClick: pick },
          { label: 'New Session', icon: 'add', action: 'start' as const, onClick: () => void actions.newSession(project.path, a.id) }
        ]),
    // Also in the header; here too for a pane too narrow to show it.
    ...(a.live?.status === 'watching'
      ? [{ label: 'Cancel Card Watch', icon: 'eye-closed', onClick: () => void call('watch:cancel', project.path, a.id).catch((e) => notify('error', 'Could not cancel the watch', String((e as Error).message ?? e))) }]
      : []),
    { label: 'Hand Over to…', icon: 'arrow-swap', onClick: () => set({ handOverFor: { project: project.path, agentId: a.id } }) },
    ...moveItems(project, a),
    { separator: true },
    { label: 'Agent Settings…', icon: 'settings', onClick: () => set({ agentSettingsFor: { project: project.path, agentId: a.id } }) },
    ...(worktree
      ? [
          { label: 'Review Changes', icon: 'git-compare', onClick: () => reviewChanges(project, a) },
          ...(inHeader ? [] : [{ label: 'Merge…', icon: 'git-merge', disabled: !!mergeBlocked(a.name, a.live?.status), detail: mergeBlocked(a.name, a.live?.status) ?? undefined, onClick: () => set({ mergeFor: { project: project.path, agentId: a.id } }) }]),
          { separator: true },
          { label: 'Remove Agent…', icon: 'close', action: 'remove' as const, onClick: () => void actions.removeAgent(project.path, a.id) },
          { label: 'Discard Worktree and Branch…', icon: 'trash', danger: true, onClick: () => void actions.discardAgent(project.path, a.id) }
        ]
      : [{ separator: true }, { label: 'Remove Agent…', icon: 'close', action: 'remove' as const, onClick: () => void actions.removeAgent(project.path, a.id) }])
  ]
}

/**
 * Add Agent split button (#286): the main part is Configure Agent and Add… (the Add Agent dialog: provider, where it
 * works, settings); ▾ offers it too and, for a project, Add Agent from Template (one agent of a template). The quick add
 * with default settings is the palette's Add Agent (Ctrl+Alt+Shift+N). `strip`: the agent strip's, which also answers
 * the palette's Add Agent from Template….
 */
export function AddAgentButton({ project, className, label = 'Add Agent', strip }: { project: ProjectInfo; className?: string; label?: string; strip?: boolean }) {
  const menu = useContextMenu()
  const caret = useRef<HTMLButtonElement>(null)
  const full = project.agents.length >= MAX_AGENTS
  const templates = !isAssistantPath(project.path)
  const configure = (): void => set({ addAgentFor: project.path })
  const tip = full ? `A project can have up to ${MAX_AGENTS} agents` : 'Configure Agent and Add…: choose its provider, where it works and its settings'
  const fromTemplate = async (keyboard: boolean): Promise<void> => {
    const at = caret.current && below(caret.current)
    const all = await templateList(project.path)
    if (at && all) menu.openAt(...at, addFromTemplateItems(project, all), keyboard)
  }
  const open = (keyboard: boolean): void => {
    if (!caret.current) return
    menu.openAt(
      ...below(caret.current),
      [
        { label: 'Configure Agent and Add…', icon: 'settings-gear', disabled: full, onClick: configure },
        ...(templates ? [{ label: 'Add Agent from Template', icon: 'library', more: true, disabled: full, onClick: (k: boolean) => void fromTemplate(k) }] : [])
      ],
      keyboard
    )
  }
  useStripMenu(strip ? project.path : null, 'addFromTemplate', () => void fromTemplate(true))
  return (
    <span className="split-btn">
      <Tooltip content={tip}>
        <button className={cx('btn', className)} disabled={full} onClick={configure}>
          <Icon name="add" /> {label}
        </button>
      </Tooltip>
      <Tooltip content={templates ? 'Configure Agent and Add…, or Add Agent from Template' : 'Configure Agent and Add… (choose the provider, where it works and its settings)'}>
        <button ref={caret} className={cx('btn split-caret', className)} disabled={full} onClick={(e) => open(e.detail === 0)} aria-label="Add Agent…" aria-haspopup="menu">
          <Icon name="chevron-down" />
        </button>
      </Tooltip>
      {menu.element}
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

/**
 * A worktree agent's mark on its tab and pane header (#287): the worktree icon only; its branch, folder, base and what
 * is left to merge are in its tooltip (on hover, or keyboard focus) and its accessible name.
 */
function WorktreeMark({ project, a }: { project: ProjectInfo; a: AgentInfo }) {
  const work = useUnmerged(project, a)
  if (!a.worktree) return null
  const { branch, path, base } = a.worktree
  const tip = [`Worktree: ${branch}`, `in ${path}`, `branched from ${base}`, ...(work?.badge ? [`To merge: ${work.text}`] : [])].join('\n')
  return (
    <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{tip}</span>} focus>
      <span className="agent-branch" role="img" tabIndex={0} aria-label={`Worktree: ${branch} in ${path}`}>
        <Icon name="worktree" />
      </span>
    </Tooltip>
  )
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

/** Where a menu opens under a button. */
const below = (el: Element): [number, number] => {
  const r = el.getBoundingClientRect()
  return [r.left, r.bottom + 2]
}

const layoutName = (l: PageLayout): string => (l === 'auto' ? 'automatic layout' : (SESSION_LAYOUTS.find((x) => x.value === l)?.label ?? l).toLowerCase())
const scopeName = (s: TemplateScope): string => (s === 'workspace' ? 'Workspace' : 'This project')

/** The templates a project can use (the workspace's and its own), or null after saying why they couldn't be listed. */
const templateList = (path: string): Promise<TemplateEntry[] | null> =>
  call('templates:list', path).catch((e) => {
    notify('error', 'Could not list the templates', errorMessage(e))
    return null
  })

/** Add Agent from Template: each usable template's agents, under its name and scope (#126). */
function addFromTemplateItems(project: ProjectInfo, list: TemplateEntry[]): MenuEntry[] {
  const all = list.filter((t) => !t.problem)
  const full = project.agents.length >= MAX_AGENTS
  return all.length
    ? all.flatMap((t) => [
        { header: true, label: `${t.name} · ${scopeName(t.scope).toLowerCase()}` },
        ...t.agents.map((a, i) => ({
          label: a.name,
          icon: 'person-add',
          detail: [a.role, providerName(a.provider), a.worktree ? 'own worktree' : ''].filter(Boolean).join(' · '),
          disabled: full,
          onClick: () => void actions.addAgentFromTemplate(project.path, t, i)
        }))
      ])
    : [{ label: 'No templates yet: Template ▾ → Save Template… first', disabled: true }]
}

/** Template ▾: Save Template…, then the templates to load, by scope (loading replaces the agents, after saying who goes and who comes). */
function templateMenuItems(project: ProjectInfo, all: TemplateEntry[]): MenuEntry[] {
  const load: MenuEntry[] = all.length
    ? TEMPLATE_SCOPES.flatMap((scope) => {
        const here = all.filter((t) => t.scope === scope)
        return here.length
          ? [
              { header: true, label: `${scopeName(scope)} templates` },
              ...here.map((t) => ({ label: t.name, icon: 'library', detail: t.problem ?? `${t.agents.length} ${t.agents.length === 1 ? 'agent' : 'agents'} · ${layoutName(t.layout)}`, disabled: !!t.problem, onClick: () => void actions.loadTemplate(project.path, t) }))
            ]
          : []
      })
    : [{ label: 'No templates saved yet', disabled: true }]
  return [{ label: 'Save Template…', icon: 'save', disabled: !project.agents.length, onClick: () => void actions.saveTemplate(project.path) }, { separator: true }, ...load]
}

/** Opens a strip menu the palette asked for, now or once this strip shows (`project` null: not the strip's). */
function useStripMenu(project: string | null, which: StripMenu, open: () => void): void {
  const run = useRef(open)
  run.current = open
  useEffect(() => {
    if (!project) return
    const check = (): void => void (takeStripMenu(project, which) && run.current())
    check()
    return onStripMenu(check)
  }, [project, which])
}

/**
 * The agent strip's Template ▾ (#126, #286): Save Template…, then the workspace's and the project's templates to load.
 * Labelled when there's room, its icon when less; the agent tabs give way first (they scroll).
 */
function TemplateButton({ project, labelled }: { project: ProjectInfo; labelled: boolean }) {
  const menu = useContextMenu()
  const button = useRef<HTMLButtonElement>(null)
  const open = async (keyboard: boolean): Promise<void> => {
    const at = button.current && below(button.current)
    const all = await templateList(project.path)
    if (at && all) menu.openAt(...at, templateMenuItems(project, all), keyboard)
  }
  useStripMenu(project.path, 'loadTemplate', () => void open(true))
  return (
    <div className="template-controls">
      <Tooltip content="Templates: save this project's agents and layout as one, or load one (it replaces the agents and layout)">
        <button ref={button} className="btn subtle small" aria-label="Template" aria-haspopup="menu" onClick={(e) => void open(e.detail === 0)}>
          <Icon name="library" />
          {labelled && ' Template'} <Icon name="chevron-down" />
        </button>
      </Tooltip>
      {menu.element}
    </div>
  )
}

/** The pane header's status, with what to do when a refused sign-in stopped the agent (#309). */
function SignInTip({ live, children }: { live: LiveSessionState | null; children: ReactNode }) {
  const note = signInNote(live)
  return note ? <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{note}</span>}>{children}</Tooltip> : <>{children}</>
}

function AgentTabTip({ project, a }: { project: ProjectInfo; a: AgentInfo }) {
  const usage = useLiveUsage(project, a.live ? a.id : undefined)
  const cards = useAgentCards(project, a.id)
  const reviewing = useAgentReviews(project, a.id)
  const unmerged = useUnmerged(project, a)
  const live = a.live
  const failure = useStartFailure(project, a)
  const lines = [`${a.name} (${providerName(agentProviderOf(project, a))}): ${live ? statusText(live) : failure ? `failed to start: ${failure.reason.split('\n')[0]}` : 'not running'}`]
  const signIn = signInNote(live)
  if (signIn) lines.push(signIn)
  if (a.role) lines.push(`Role: ${a.role}`)
  for (const c of cards) lines.push(`Working on #${c.number} ${c.title}`)
  for (const c of reviewing) lines.push(`Reviewing #${c.number} ${c.title}`)
  if (live) lines.push(`Session: ${liveSessionLabel(project, live, usage)}`)
  else if (a.resume) lines.push(`Resume opens: ${sessionLabel(a.resume, project.name)} (${timeAgo(a.resume.lastActiveAt)})`)
  if (a.worktree) lines.push(`Worktree ${a.worktree.path} on ${a.worktree.branch}, branched from ${a.worktree.base}`)
  if (unmerged?.badge) lines.push(`To merge: ${unmerged.text}`)
  return <span style={{ whiteSpace: 'pre-line' }}>{lines.join('\n')}</span>
}

/** The strip's width from which Template ▾ is labelled (else its icon). */
const TEMPLATE_LABEL_FROM = 720

/** The row above the Session tab: one tab per agent, Add Agent, Template ▾, the pages and the layout choice. */
export function AgentStrip({ project }: { project: ProjectInfo }) {
  const panes = usePanes(project)
  const [stripRef, stripWidth] = useWidth<HTMLDivElement>()
  // A second agent: the tip about layouts and file locks, the first time.
  const several = project.agents.length >= 2
  useEffect(() => void (several && offerTip('second-agent')), [several])
  const focused = useStore((s) => s.focusedAgent[project.path]) ?? project.agents[0]?.id
  const menu = useContextMenu()
  const picker = useSessionPicker()
  const page = agentPage(project, focused ?? null)
  // One layout for the project; a page holds as many agents as it has panes (#134).
  const layout = projectLayout(project.config)
  const perPage = agentsPerPage(layout)
  const pages = agentPageCount(project.agents.length, perPage)
  const many = project.agents.length > 1
  const pageKb = commandKeybinding('agent.nextPage')
  const fresh = useStore((s) => s.newAgents[project.path] ?? NO_IDS)
  // Agents the Assistant added on the page shown are seen.
  useEffect(() => {
    const here = pageAgents(project.agents, page, perPage).map((a) => a.id).filter((id) => fresh.includes(id))
    if (here.length) seenAgents(project.path, here)
  }, [fresh, page, perPage, project.agents, project.path])
  const dragging = useAgentDrag(project)
  const removing = useStore((s) => s.running)
  // Where a dragged agent would land: before this agent (null: at the end).
  const [dropBefore, setDropBefore] = useState<string | null | undefined>(undefined)
  const [dropPage, setDropPage] = useState<number | null>(null)
  // A page button being held over while dragging: its page shows after PAGE_HOVER_MS.
  const pageHover = useRef<{ page: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  useDragCleanup()
  useEffect(() => {
    if (!dragging) {
      setDropBefore(undefined)
      setDropPage(null)
      if (pageHover.current) clearTimeout(pageHover.current.timer)
      pageHover.current = null
    }
  }, [dragging])
  const ids = project.agents.map((a) => a.id)
  // The focused agent's tab stays in view when the tabs don't all fit.
  const tabs = useRef<HTMLDivElement>(null)
  useEffect(() => {
    tabs.current?.querySelector('.agent-tab.focused')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [focused, project.agents.length])
  return (
    <div className="agent-strip" ref={stripRef}>
      {/* Scrolls sideways (mouse wheel too) when a project's agents don't fit; a line marks where each page starts. */}
      <div className="agent-tabs" ref={tabs} onWheel={(e) => e.deltaY && (e.currentTarget.scrollLeft += e.deltaY)}>
      {project.agents.map((a, i) => (
        <Tooltip key={a.id} content={<AgentTabTip project={project} a={a} />}>
          <div
            data-page-start={i > 0 && i % perPage === 0 ? '' : undefined}
            className={cx('agent-tab', focused === a.id && 'focused', panes.includes(a.id) && 'shown', dragging === a.id && 'dragging', dragging && dropBefore === a.id && 'drop-before', dragging && dropBefore === null && i === project.agents.length - 1 && 'drop-after')}
            data-agent={a.id}
            {...agentDragProps(project, a)}
            onDragOver={(e) => {
              if (!dragging) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              const r = e.currentTarget.getBoundingClientRect()
              // The left half drops before this agent, the right half before the next one; no marker where the agent
              // would stay where it is (#135: a highlight only where a drop does something).
              const before = e.clientX < r.left + r.width / 2 ? a.id : (project.agents[i + 1]?.id ?? null)
              setDropBefore(dropIndex(ids, dragging, before) === ids.indexOf(dragging) ? undefined : before)
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
            <WorktreeMark project={project} a={a} />
            <CardChip project={project} a={a} short tip={false} />
            <Locks a={a} />
            <UnmergedBadge project={project} a={a} />
          </div>
        </Tooltip>
      ))}
      </div>
      <AddAgentButton project={project} className="subtle small agent-add" strip />
      <div className="grow" />
      {/* On the right: Template ▾, then the pages beside the layouts they follow from (#292). */}
      {!isAssistantPath(project.path) && <TemplateButton project={project} labelled={stripWidth >= TEMPLATE_LABEL_FROM} />}
      {pages > 1 && (
        <div className="segmented page-switch">
          {Array.from({ length: pages }, (_, i) => {
            const onPage = pageAgents(project.agents, i, perPage)
            // Another page's most urgent agent shows as a dot on its button, or one the Assistant added there.
            const state = page === i ? null : mostUrgent(onPage.map((a) => a.live))
            const added = page !== i && onPage.some((a) => fresh.includes(a.id))
            // A drop here moves the agent to this page's last place: not a target where it already is (#238). Held over,
            // the button still shows its page, to drop on a pane there.
            const moves = !!dragging && pageEndIndex(project.agents.length, i, perPage) !== project.agents.findIndex((a) => a.id === dragging)
            return (
              <Tooltip key={i} content={`Page ${i + 1}: ${onPage.length === 1 ? `agent ${i * perPage + 1}` : `agents ${i * perPage + 1}–${i * perPage + onPage.length}`}${added ? ', with an agent the Assistant added' : ''}${pageKb ? ` (${formatKeybinding(pageKb)} for the next page)` : ''}`}>
                <button
                  className={cx(page === i && 'active', moves && dropPage === i && 'drop-target')}
                  onClick={() => showPage(project, i)}
                  aria-label={`Agent page ${i + 1}`}
                  onDragOver={(e) => {
                    if (!dragging) return
                    if (moves) e.preventDefault()
                    setDropPage(moves ? i : null)
                    setDropBefore(undefined)
                    // Held over another page's button for a moment, that page shows, to drop on one of its panes (#135).
                    if (i !== page && pageHover.current?.page !== i) {
                      if (pageHover.current) clearTimeout(pageHover.current.timer)
                      pageHover.current = { page: i, timer: setTimeout(() => showPage(project, i), PAGE_HOVER_MS) }
                    }
                  }}
                  onDragLeave={() => {
                    setDropPage(null)
                    if (pageHover.current?.page === i) {
                      clearTimeout(pageHover.current.timer)
                      pageHover.current = null
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (pageHover.current) clearTimeout(pageHover.current.timer)
                    pageHover.current = null
                    if (moves) dropAgent(project, pageEndIndex(project.agents.length, i, perPage))
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
            <Tooltip key={l.value} content={`${l.label}${l.panes > 2 ? ' (works best on a wide window, or with the sidebar hidden: Ctrl+B)' : ''}`}>
              <button className={cx(layout === l.value && 'active')} onClick={() => void actions.setLayout(project.path, l.value)} aria-label={l.label}>
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

/**
 * Header buttons with labels while the pane is wide, icons when narrower, and only in ⋯ (which has them all) when narrow.
 * The mode follows the header's width both ways. The agent's details (name, branch, status, card) give way to the buttons,
 * so each mode only has to fit its widest set of buttons: a stopped worktree agent's, with a four-digit Merge count, and room
 * for the status dot and provider icon (tests/e2e/paneheader.cjs measures it at both widths).
 */
const LABELS_FROM = 565
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
  // Idle for Compact: a watching agent too (its watch is kept; a wake waits for the compaction to end).
  const idle = live && (live.status === 'ready' || live.status === 'finished' || live.status === 'watching')
  // Compact: while idle and there's a conversation; highlighted once the context passes the threshold.
  const threshold = compactThreshold(project.config, settings?.sessions.compactSuggestTokens ?? 0)
  const tokens = usage?.contextTokens ?? 0
  const suggested = threshold > 0 && tokens >= threshold
  const empty = !usage || usage.userMessages === 0 || tokens === 0
  const compacting = isCompacting(live)
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
  /**
   * A header button: labelled or an icon with a tooltip, by the pane's width (`iconOnly`: always an icon, like the Assistant's).
   * A count stays inside the button, which widens for it; `spin` turns the icon while its action runs.
   */
  const btn = (icon: string, label: string, onClick: (e: React.MouseEvent<HTMLButtonElement>) => void, tone: string, opts: { disabled?: boolean; tip?: string; iconOnly?: boolean; count?: string | null; spin?: boolean } = {}) => (
    <Tooltip key={label} content={opts.tip ?? label}>
      <button type="button" className={cx('btn small pane-btn', tone, (size === 'icons' || opts.iconOnly) && 'icon-only')} disabled={opts.disabled} aria-label={label} onClick={(e) => { e.stopPropagation(); onClick(e) }}>
        <Icon name={icon} spin={opts.spin} />
        {size === 'labels' && !opts.iconOnly && <span>{label}</span>}
        {opts.count && <span className="btn-count">{opts.count}</span>}
      </button>
    </Tooltip>
  )
  return (
    <div ref={ref} className={cx('pane-header-bar', focused && 'focused')} data-buttons={size} {...agentDragProps(project, a)} onMouseDown={() => focusAgent(project.path, a.id)} onContextMenu={(e) => menu.open(e, agentMenu(project, a, pick(e.clientX, e.clientY), size !== 'menu'))}>
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
      <span className="agent-name" title={a.name}>
        {a.name}
      </span>
      <WorktreeMark project={project} a={a} />
      {live?.question ? (
        <Tooltip content={live.question.text ? `Asks: ${live.question.text}` : 'Asks you something'}>
          <span className="faint pane-status asks">{statusText(live)}</span>
        </Tooltip>
      ) : live?.status === 'watching' && live.watch ? (
        // Waiting on cards (a watch): what for, until when, and Cancel (it takes no other work while it waits).
        <span className="pane-status watching">
          <Tooltip content={`${live.watch.label}: Hive types a line into it when ${live.watch.cards.length === 1 ? 'the card changes' : 'one of them changes'}, or at ${formatWhen(live.watch.limitAt)} if nothing does. Nothing runs meanwhile, and it takes no other work.`}>
            <span className="watch-label">
              <Icon name="eye" /> {live.watch.label}
            </span>
          </Tooltip>
          <button className="btn small subtle watch-cancel" aria-label="Cancel the card watch" onClick={() => void call('watch:cancel', project.path, a.id).catch((e) => notify('error', 'Could not cancel the watch', String((e as Error).message ?? e)))}>
            Cancel
          </button>
        </span>
      ) : (
        <SignInTip live={live}>
          <span className={cx('faint pane-status', !live && failure && 'failed', live?.status === 'signin' && 'signin')}>{live ? statusText(live) : failure ? 'Failed to start' : 'Not running'}</span>
        </SignInTip>
      )}
      <ReviewMark live={live} />
      <CardChip project={project} a={a} short={size === 'menu'} />
      <Locks a={a} />
      <div className="grow" />
      {size !== 'menu' &&
        (live ? (
          <>
            {btn(compacting ? 'loading' : 'fold', 'Compact', () => set({ compactFor: { project: project.path, agentId: a.id } }), cx('subtle', suggested && idle && 'suggest'), { disabled: !idle || empty, tip: compactTip, iconOnly: true, spin: compacting })}
            {btn('stop-circle', 'Stop', () => void actions.stopSession(project.path, a.id), 'act-stop', { tip: 'Stop this agent (the conversation is kept; resume it any time)', iconOnly: true })}
          </>
        ) : (
          <>
            {btn('debug-continue', 'Resume', () => void actions.resumeLast(project.path, a.id), 'act-resume', { disabled: !a.resume, tip: resumeTip(project, a) })}
            {btn('history', 'Resume a Session…', (e) => picker.openBelow(e.currentTarget, project, a), 'act-resume')}
            {btn('add', 'New Session', () => void actions.newSession(project.path, a.id), 'act-start solid')}
          </>
        ))}
      {a.worktree &&
        size !== 'menu' &&
        btn('git-merge', 'Merge…', () => set({ mergeFor: { project: project.path, agentId: a.id } }), cx('subtle', unmerged?.badge && 'suggest'), {
          // Its icon and count only, like Compact and Stop: the tooltip says what it merges.
          iconOnly: true,
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

/** What a click on the footer's cost does, as its tooltip says. */
const COST_CLICK = "Click to see this session's details in the Overview"

/** Between an item's icon and its text (.fit-text's margin in app.css). */
const FIT_TEXT_GAP = 4

/**
 * How many of the footer's items show just their icon to make room: 0 none, 1 the transcript size, 2 and the
 * context's tokens (its percentage stays), 3 and the whole context (the session's is always just its icon). Worked
 * out from what every item would take in full, so a level never flips back and forth. Past 3 the permission mode's
 * label shortens, then the model's, and only then is the cost cut off at the right (CSS).
 */
function useFooterFit(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [level, setLevel] = useState(0)
  const measure = useCallback(() => {
    const el = ref.current
    if (!el || !el.clientWidth) return
    const cs = getComputedStyle(el)
    const avail = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    const gap = parseFloat(cs.columnGap) || 0
    const kids = [...el.children] as HTMLElement[]
    // The row as it is: every item (the spacer takes no room of its own) and the gaps between them...
    let row = gap * Math.max(0, kids.length - 1)
    for (const k of kids) if (!k.classList.contains('grow')) row += k.offsetWidth
    // ...with any text the layout has cut short in full (the model, the mode's label).
    for (const c of el.querySelectorAll<HTMLElement>('.fit-clip')) row += Math.max(0, c.scrollWidth - c.clientWidth)
    // The texts that give way, in full whatever is shown now.
    const size = el.querySelector<HTMLElement>('.size-text')
    const ctx = el.querySelector<HTMLElement>('.ctx-text')
    const tokens = el.querySelector<HTMLElement>('.ctx-tokens')
    const sizeW = size ? size.scrollWidth + FIT_TEXT_GAP : 0
    const tokensW = tokens?.scrollWidth ?? 0
    const pctW = ctx ? ctx.scrollWidth - (tokens?.offsetWidth ?? 0) + FIT_TEXT_GAP : 0
    const shown = (l: number): number => (l >= 1 ? 0 : sizeW) + (l >= 3 ? 0 : pctW + (l >= 2 ? 0 : tokensW))
    const base = row - shown(level)
    let next = 0
    while (next < 3 && base + shown(next) > avail + 0.5) next++
    // Back to more text only with room to spare: widths read at different levels round differently (at 125%, say),
    // and without this a footer on the edge would flip between two levels.
    while (next < level && base + shown(next) > avail - 2) next++
    // The mode chip never shrinks past its icon and caret.
    const chip = el.querySelector<HTMLElement>('.mode-chip')
    const label = chip?.querySelector<HTMLElement>('.mode-label')
    if (chip && label) el.style.setProperty('--mode-chip-min', `${chip.offsetWidth - label.offsetWidth}px`)
    if (next !== level) setLevel(next)
  }, [level])
  // After every render (the texts may have changed), and when the pane or anything in the row changes size or text.
  useLayoutEffect(measure)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const resize = new ResizeObserver(() => measure())
    resize.observe(el)
    const mutate = new MutationObserver(() => measure())
    mutate.observe(el, { subtree: true, childList: true, characterData: true })
    return () => {
      resize.disconnect()
      mutate.disconnect()
    }
  }, [measure])
  return [ref, level]
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
  // What runs (#248): the session's reported model while it runs (status line, else its transcript), else what the choice
  // resolves to; the choice itself in the tooltip when it reads differently (an alias).
  const shown = agentModelShown(provider, a.model || pc.model, ps.defaultModel, providers[provider], live ? live.modelId || usage?.model || null : null)
  const model = shown.label
  // With no effort set or reported, the model's own default when the CLI said what it is ("Medium (default)", #125).
  const runModel = a.model || (pc.model && pc.model !== 'inherit' ? pc.model : ps.defaultModel) || providers[provider]?.defaultModel || null
  const effort = effortLabel(provider, live?.effort, a.effort ?? pc.effort, ps.defaultEffort, modelCaps(provider, runModel, providers[provider], settings).defaultEffort, settings)
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
  useDateStyle() // the session's tooltip says when it started
  // The cost opens the session's details in the Overview (an agent's: the Assistant's footer has nowhere to go).
  const costClick = onContext ? undefined : (): void => showInOverview(project.path, a.id, 'session')
  const [footerRef, fit] = useFooterFit()
  return (
    <div ref={footerRef} className="pane-footer-bar" data-fit={fit} onMouseDown={() => focusAgent(project.path, a.id)}>
      <Tooltip content={`${shown.chosenAs ? `${model} · chosen as ${shown.chosenAs}. ` : ''}${providerName(provider)} model${effort ? ' and effort' : ''} ${live ? 'of this session' : 'for new sessions'}${live?.effort ? ' (effort as the session reports it)' : ''}. Change them in ${settingsName}.`}>
        <span className="pane-foot-item foot-model fit-clip" onClick={() => (onSettings ? onSettings() : set({ agentSettingsFor: { project: project.path, agentId: a.id } }))}>
          {model}
          {effort && <span className="faint"> · {effort}</span>}
        </span>
      </Tooltip>
      <ModeBadge project={project} a={a} variant="pane" />
      <div className="grow" />
      {showSession && <SessionName project={project} a={a} usage={usage} />}
      {usage ? (
        <Tooltip
          content={
            // A click opens the session in the Overview, with its compaction history (the Assistant's footer opens nothing).
            <span className="ctx-tip" style={{ whiteSpace: 'pre-line' }}>
              {`${contextLines(usage, live?.autoCompact).join('\n')}\n${usage.compactions.length} compaction${usage.compactions.length === 1 ? '' : 's'} so far${over ? ' — consider compacting' : ''}${usage.stale ? '\nCouldn’t read it again just now: this may be behind.' : ''}${onContext ? '' : '\n\nClick to view compaction history'}`}
            </span>
          }
        >
          <span className={cx('pane-foot-item', over && 'warn', usage.stale && 'stale')} onClick={() => (onContext ? onContext() : showInOverview(project.path, a.id))}>
            <Icon name="dashboard" />
            {/* Short of room the tokens give way, then the percentage (useFooterFit): the tooltip has them. */}
            <span className="fit-text ctx-text">
              {pct === null ? (
                `${formatTokens(ctx)} ctx`
              ) : (
                <>
                  <span className="ctx-tokens">{formatTokens(ctx)} · </span>
                  {pct}%
                </>
              )}
            </span>
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
            <Icon name="file" />
            <span className="fit-text size-text">{formatBytes(bytes)}</span>
          </span>
        </Tooltip>
      )}
      {cost !== null && cost > 0 && (
        <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{`${estimated ? 'API-equivalent cost of this session, estimated by Hive from its tokens' : 'API-equivalent cost of this session, as the provider reports it'}${costClick ? `\n\n${COST_CLICK}` : ''}`}</span>}>
          <span className="pane-foot-item faint foot-cost" onClick={costClick}>
            {estimated ? '≈' : ''}${cost < 0.01 ? '<0.01' : cost.toFixed(2)}
          </span>
        </Tooltip>
      )}
      {cost === null && usage && unpricedModel(usage.provider, usage.model, settings) && (
        <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{`${unpricedText(usage.model!, providerName(usage.provider))}${costClick ? `\n\n${COST_CLICK}` : ''}`}</span>}>
          <span className="pane-foot-item faint foot-cost" onClick={costClick}>
            $?
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
        <button className={cx('btn small solid', failure.resumed ? 'act-resume' : 'act-start')} onClick={retry}>
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
    // A single empty pane is a project without agents: its "No agents yet" (SessionEmpty) shows, not covered (#227).
    if (single) return null
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
            <button className="btn small act-start solid" onClick={() => void actions.newSession(project.path, a.id)}>
              <Icon name="refresh" /> Retry Setup
            </button>
            <button className="btn small act-start" onClick={() => void actions.newSession(project.path, a.id, { skipSetup: true })}>
              Start Without Setup
            </button>
          </>
        ) : (
          <>
            <ResumeButton project={project} a={a} className={cx('act-resume solid', !single && 'small')} />
            <button className={cx('btn act-start', !single && 'small')} onClick={() => void actions.newSession(project.path, a.id)}>
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
        <button className="btn act-start solid small" onClick={() => void actions.newSession(project.path, a.id)}>
          <Icon name="add" /> New Session
        </button>
        <ResumeButton project={project} a={a} className={cx(RESUME_TINT, 'small')} />
      </div>
    </div>
  )
}

/** Pane frames (headers, borders, placeholders) over the terminals of the selected project. */
export function PaneChrome({ project, panes }: { project: ProjectInfo; panes: (string | null)[] }) {
  const epochs = useStore((s) => s.sessionEpoch)
  const focused = useStore((s) => s.focusedAgent[project.path]) ?? project.agents[0]?.id
  // A pane something just asked to show (a run's agent in the Progress panel): highlighted for a moment.
  const flash = useStore((s) => s.paneFlash)
  const single = panes.length === 1
  const dragging = useAgentDrag(project)
  const [over, setOver] = useState<string | null>(null)
  useEffect(() => setOver(null), [dragging])
  // An empty pane moves the dragged agent to the end: nothing to do for the last one (#238).
  const draggingLast = !!dragging && project.agents.at(-1)?.id === dragging
  return (
    <>
      {panes.map((id, i) => {
        const a = project.agents.find((x) => x.id === id) ?? null
        const r = paneRect(panes.length, i)
        const hasTerminal = !!a && (!!a.live || epochs[projectKey(project.path, a.id)] !== undefined)
        return (
          <div
            key={`${i}:${id ?? ''}`}
            className={cx('agent-pane', !single && 'framed', !single && focused === id && 'focused', r.x > 0 && 'left-border', r.y > 0 && 'top-border', !!a && flash?.key === projectKey(project.path, a.id) && 'flash')}
            style={{ left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` }}
          >
            {/* One agent or several: every agent pane has the same header and footer. */}
            {a && <PaneHeader project={project} a={a} focused={!single && focused === a.id} />}
            <div className="agent-pane-body" style={{ top: a ? PANE_HEADER : 0, bottom: a ? PANE_FOOTER : 0 }}>
              <PaneBody project={project} a={a} hasTerminal={hasTerminal} single={single} />
            </div>
            {a && <PaneFooter project={project} a={a} />}
            {/*
              While an agent is dragged (#135): drop it on another agent's pane to swap their places, or on an empty pane
              (the last page's spare ones) to move it there. Not where it would do nothing: its own pane, or an empty one
              when it is already last.
            */}
            {dragging && a?.id !== dragging && (a || !draggingLast) && (
              <div
                className={cx('pane-drop', over === (a?.id ?? `empty:${i}`) && 'over')}
                onDragOver={(e) => {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  setOver(a?.id ?? `empty:${i}`)
                }}
                onDragLeave={() => setOver((o) => (o === (a?.id ?? `empty:${i}`) ? null : o))}
                onDrop={(e) => {
                  e.preventDefault()
                  if (a) swapDrop(project, a.id)
                  else dropAgent(project, project.agents.length - 1)
                }}
              >
                <span>
                  <Icon name="arrow-swap" /> {a ? `Swap with ${a.name}` : 'Move here'}
                </span>
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}
