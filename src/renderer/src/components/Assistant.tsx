import { useEffect, useRef, useState } from 'react'
import { ASSISTANT_AGENT_ID, DEFAULT_PERSONA, assistantPersona, assistantStatusLine } from '@shared/assistant'
import { compactThreshold, isCompacting, mostUrgent } from '@shared/defaults'
import { formatDateTime, formatTime } from '@shared/dates'
import { agentOpenRun, runWords } from '@shared/progress'
import { columnLabel } from '@shared/tasks'
import { agentProvider, providerDescriptor } from '@shared/providers'
import type { AgentInfo, AgentPatch, AssistantAction, EffortLevel, PermissionMode, PersonaInfo, ProgressRun, ProjectInfo, ProviderId } from '@shared/types'
import * as actions from '../actions'
import { call } from '../api'
import { commandKeybinding } from '../commands'
import { agentProviderOf, confirm, get, notify, NO_PROJECTS, projectKey, revealAgent, runOnce, set, setActivity, setAssistantOpen, showAssistantView, showView, useDateStyle, useStore, assistantOnLeft, setAssistantSide } from '../store'
import { useInbox } from '../inbox'
import { rememberProjectPref } from '../projectPrefs'
import { useLiveUsage } from '../usage'
import { cx, formatKeybinding, formatTokens, sessionLabel, timeAgo } from '../util'
import { Overrides, ProviderChoice, contextChoice, contextValue, type ContextChoice } from './AgentDialogs'
import { PaneFooter, RESUME_TINT, useWidth } from './AgentPanes'
import { AssistantMark } from './AssistantMark'
import { CardChip, TaskChip, useAgentCards, useAgentReviews } from './CardChip'
import { confirmDangerousMode } from './PermissionMode'
import { ProviderIcon } from './ProviderIcon'
import { PaneResizer, usePaneSize } from './Resizer'
import { ShowAllList } from './ShowAllList'
import { TerminalView } from './TerminalView'
import { Icon, IconButton, Modal, ReviewMark, statusText, Tooltip, useContextMenu, type MenuEntry } from './ui'

/**
 * The Hive Assistant's side panel: the workspace's overseer. Its header (persona, controls) and status line, what is
 * happening in the workspace, its terminal, its footer (model, mode, context, cost) and what it has done. Everything about the
 * Assistant is here, apart from managing personas (their own view) and its defaults (Settings → Assistant).
 */

const AGENT = ASSISTANT_AGENT_ID

/** The workspace's personas, reloaded when they change. */
export function usePersonas(): PersonaInfo[] {
  const version = useStore((s) => s.personasVersion)
  const ws = useStore((s) => s.workspace?.path)
  const [list, setList] = useState<PersonaInfo[]>([])
  useEffect(() => {
    if (!ws) return setList([])
    // A newer load (another workspace, a change) replaces this one.
    let current = true
    void call('personas:list')
      .then((l) => current && setList(l))
      // Personas only add choices to the Assistant's menus: without them, it still works.
      .catch(() => current && setList([]))
    return () => {
      current = false
    }
  }, [version, ws])
  return list
}

/** Changes the Assistant's settings for this workspace; a change that needs a new conversation restarts it after asking. */
async function changeAssistant(patch: Omit<AgentPatch, 'name'>, restart: { title: string; message: string } | null): Promise<boolean> {
  const a = get().workspace?.assistant
  const agent = a?.agents[0]
  if (!a || !agent) return false
  const wasLive = !!agent.live && !!restart
  if (wasLive) {
    const ok = await confirm({ title: restart!.title, message: restart!.message, detail: 'You can resume the current conversation later from the Assistant\'s ⋯ menu.', confirmLabel: 'Restart the Assistant' })
    if (!ok) return false
    await actions.attempt('Could not stop the Assistant', () => call('session:stop', a.path, AGENT))
    await actions.waitForStop(a.path, AGENT)
  }
  const done = await actions.attempt('Could not save the Assistant\'s settings', () => call('agents:update', a.path, AGENT, patch))
  await actions.refreshWorkspace()
  if (done && wasLive) await actions.newSession(a.path, AGENT)
  return !!done
}

/**
 * Makes a mode (a persona file) this workspace's Assistant's, at once and without a restart (#259): a running Assistant
 * is told in its conversation (now, or when it has finished what it is doing), which keeps its context; its next
 * launch starts in the mode.
 */
export async function choosePersona(p: Pick<PersonaInfo, 'id' | 'name'>): Promise<void> {
  const agent = get().workspace?.assistant?.agents[0]
  if (!agent) return
  if (assistantPersona(agent, get().settings) === p.id && agent.persona === p.id) return
  const how = await actions.attempt('Could not switch the mode', () => call('assistant:switchMode', p.id))
  await actions.refreshWorkspace()
  if (how === 'told') notify('info', `Mode: ${p.name}`, 'The Assistant has been told, in this conversation.')
  else if (how === 'later') notify('info', `Mode: ${p.name}`, 'The Assistant will be told as soon as it has finished what it is doing.')
}

/**
 * Restart in This Mode: the Assistant stops and resumes the same conversation with the mode's full instructions (a
 * switch only tells it the mode's habits). Its whole conversation is cached again, so it asks first.
 */
export async function restartInMode(p: Pick<PersonaInfo, 'id' | 'name'>): Promise<void> {
  const a = get().workspace?.assistant
  const agent = a?.agents[0]
  const live = agent?.live
  if (!a || !agent || !live) return
  const ok = await confirm({
    title: `Restart in ${p.name} mode?`,
    message: `The Assistant stops and resumes this conversation with the ${p.name} mode's full instructions.`,
    detail: 'The whole conversation is cached again, which costs more than switching (switching keeps everything and only tells the Assistant the mode).',
    confirmLabel: 'Restart'
  })
  if (!ok) return
  if (!(await actions.attempt('Could not save the mode', () => call('agents:update', a.path, AGENT, { persona: p.id })))) return
  const item = (await call('session:list', a.path)).find((s) => s.id === live.sessionId)
  await actions.attempt('Could not stop the Assistant', () => call('session:stop', a.path, AGENT))
  await actions.waitForStop(a.path, AGENT)
  await actions.refreshWorkspace()
  await actions.resumeSession(a.path, { id: live.sessionId, recache: null, title: null, name: item?.name, agentId: AGENT, cwd: item?.cwd }, AGENT)
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export function AssistantPanel() {
  const open = useStore((s) => s.assistantOpen)
  // On the left (Settings → Assistant → Panel side) it is resized from its right edge.
  const left = useStore(assistantOnLeft)
  const a = useStore((s) => s.workspace?.assistant ?? null)
  const epochs = useStore((s) => s.sessionEpoch)
  const flash = useStore((s) => (a && s.paneFlash?.key === projectKey(a.path, AGENT) ? s.paneFlash.at : 0))
  const width = usePaneSize('assistant', 430)
  // The overview's share of the height once dragged; until then it takes what it needs (up to a third).
  const topShare = useStore((s) => s.panes.assistantTop)
  const body = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  // What the Assistant did and asks in this workspace (events keep them current).
  const ws = useStore((s) => s.workspace?.path)
  useEffect(() => {
    if (!ws) return
    // Another workspace opened before this loaded: its own load is on the way.
    let current = true
    void Promise.all([call('assistant:actions'), call('assistant:questions')]).then(([assistantActions, assistantQuestions]) => current && set({ assistantActions, assistantQuestions }))
    return () => {
      current = false
    }
  }, [ws])
  if (!a) return null
  if (!open) return <AssistantRail a={a.agents[0] ?? null} />
  const agent = a.agents[0]
  if (!agent) return null
  const key = projectKey(a.path, AGENT)
  const hasTerminal = !!agent.live || epochs[key] !== undefined

  // The line between the workspace overview and the terminal: drag to share the height.
  const startSplit = (e: React.MouseEvent): void => {
    if (e.button !== 0 || !body.current) return
    e.preventDefault()
    const box = body.current.getBoundingClientRect()
    setDragging(true)
    document.body.classList.add('pane-resizing-v')
    const move = (ev: MouseEvent): void => {
      const share = Math.max(0.12, Math.min(0.7, (ev.clientY - box.top) / box.height))
      set((s) => ({ panes: { ...s.panes, assistantTop: share } }))
    }
    const up = (): void => {
      setDragging(false)
      document.body.classList.remove('pane-resizing-v')
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      void call('ui:setPane', 'assistantTop', get().panes.assistantTop ?? null)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div className={cx('assistant-panel', left && 'on-left', !!flash && 'flash')} style={{ width }}>
      <PaneResizer paneKey="assistant" edge={left ? 'right' : 'left'} min={300} max={900} keep={380} />
      <AssistantHeader project={a} a={agent} />
      <AssistantStatus a={agent} />
      <AssistantQuestions />
      <AssistantActions />
      <div className="assistant-body" ref={body}>
        <div className={cx('assistant-top', topShare === undefined && 'auto')} style={topShare === undefined ? undefined : { height: `${topShare * 100}%` }}>
          <WorkspaceOverview />
        </div>
        <div
          className={cx('assistant-split', dragging && 'dragging')}
          onMouseDown={startSplit}
          onDoubleClick={() => {
            set((s) => {
              const panes = { ...s.panes }
              delete panes.assistantTop
              return { panes }
            })
            void call('ui:setPane', 'assistantTop', null)
          }}
        />
        <div className="assistant-terminal">
          {hasTerminal && (
            <TerminalView
              key={`${key}:${epochs[key] ?? 0}`}
              ptyKey={key}
              visible
              projectPath={a.path}
              agentId={AGENT}
              provider={agentProviderOf(a, agent)}
              autoFocus={!!agent.live}
            />
          )}
          {!agent.live && <AssistantIdle project={a} a={agent} ended={hasTerminal} />}
        </div>
      </div>
      <div className="assistant-footer">
        <PaneFooter
          project={a}
          a={agent}
          onSettings={() => set({ assistantSettingsOpen: true })}
          onContext={() => undefined}
          onTranscript={() => undefined}
          transcriptAdvice="Start a new conversation (⋯ → New Conversation) to keep things quick."
          settingsName="Assistant Settings"
          showSession={false}
        />
      </div>
    </div>
  )
}

/** The hidden panel: a strip down the right edge; click it to show the panel. Its mark (#399) shows what the Assistant is doing. */
function AssistantRail({ a }: { a: AgentInfo | null }) {
  const kb = commandKeybinding('assistant.toggle')
  const live = a?.live
  const asking = useStore((s) => s.assistantQuestions.length)
  const left = useStore(assistantOnLeft)
  return (
    <div
      className={cx('assistant-rail', left && 'on-left')}
      role="button"
      tabIndex={0}
      aria-label="Show the Hive Assistant"
      onClick={() => setAssistantOpen(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setAssistantOpen(true)
        }
      }}
    >
      <Tooltip content={`Show the Hive Assistant${kb ? ` (${formatKeybinding(kb)})` : ''}`}>
        <span className="rail-btn">
          <Icon name={left ? 'chevron-right' : 'chevron-left'} />
        </span>
      </Tooltip>
      {asking > 0 ? (
        <Icon name="bell-dot" className="assistant-rail-asking" title="The Assistant is asking you something" />
      ) : (
        <AssistantMark status={live?.status ?? 'stopped'} unseen={live?.unseen} title={live ? `The Assistant: ${statusText(live)}` : 'The Assistant is not running'} />
      )}
      <span className="assistant-rail-label">Hive Assistant</span>
    </div>
  )
}

/** Shown while the Assistant isn't running: start it, or resume a conversation. */
function AssistantIdle({ project, a, ended }: { project: ProjectInfo; a: AgentInfo; ended: boolean }) {
  const settings = useStore((s) => s.settings)
  const personas = usePersonas()
  const personaId = assistantPersona(a, settings)
  const persona = personas.find((p) => p.id === personaId)
  const picker = useConversationPicker()
  const resume = a.resume ? (
    <button className={cx('btn small', RESUME_TINT)} onClick={() => void actions.resumeLast(project.path, AGENT)} title={`Resume "${sessionLabel(a.resume, 'Assistant')}", ${timeAgo(a.resume.lastActiveAt)}`}>
      <Icon name="debug-continue" /> Resume
    </button>
  ) : null
  if (ended) {
    return (
      <div className="session-ended compact assistant-ended">
        <Icon name="debug-disconnect" />
        <span className="grow">The conversation has ended.</span>
        {resume}
        <button className="btn act-start solid small" onClick={() => void actions.newSession(project.path, AGENT)}>
          <Icon name="add" /> New
        </button>
      </div>
    )
  }
  return (
    <div className="assistant-idle">
      <div className="assistant-idle-mark">{persona?.icon || '🐝'}</div>
      <p>
        <strong>{persona?.name ?? 'The Assistant'}</strong> watches over this workspace: ask it what the agents are doing, about any project, or for a plan or a review.
      </p>
      <p className="faint">It doesn't edit files itself. Within Settings → Assistant → Control, it can run agents for you and create projects; everything it does is listed here.</p>
      <div className="btns">
        <button className="btn act-start solid" onClick={() => void actions.newSession(project.path, AGENT)}>
          <Icon name="play" /> Start Assistant
        </button>
        {resume}
        <button className="btn subtle small" onClick={(e) => picker.openBelow(e.currentTarget, project)}>
          <Icon name="history" /> Conversations
        </button>
      </div>
      {picker.element}
    </div>
  )
}

/** A menu of the Assistant's past conversations, newest first. */
function useConversationPicker() {
  const menu = useContextMenu()
  const openAt = async (project: ProjectInfo, x: number, y: number): Promise<void> => {
    const list = await actions.attempt('Could not list conversations', () => call('session:list', project.path))
    if (!list) return
    const open = project.agents[0]?.live?.sessionId
    const all = list.filter((s) => s.source === 'hive' && !s.archived && !s.sub)
    const items: MenuEntry[] = [{ header: true, label: 'Resume a conversation' }]
    if (!all.length) items.push({ label: 'No conversations yet', disabled: true })
    for (const s of all.slice(0, 12)) {
      items.push({
        label: sessionLabel(s, 'Assistant'),
        detail: [timeAgo(s.lastActivity), s.id === open ? 'open now' : null, s.provider ? providerDescriptor(s.provider).name : null].filter(Boolean).join(' · '),
        icon: s.id === open ? 'circle-filled' : 'history',
        disabled: s.id === open,
        onClick: () => void actions.resumeSession(project.path, s, AGENT)
      })
    }
    menu.openAt(x, y, items)
  }
  const openBelow = (el: Element, project: ProjectInfo): void => {
    const r = el.getBoundingClientRect()
    void openAt(project, r.left, r.bottom + 2)
  }
  return { openAt, openBelow, element: menu.element }
}

/** Below this header width Start, Compact and Stop fold into ⋯. */
const BUTTONS_FROM = 380

function AssistantHeader({ project, a }: { project: ProjectInfo; a: AgentInfo }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const buttons = width === 0 || width >= BUTTONS_FROM
  const settings = useStore((s) => s.settings)
  const left = useStore(assistantOnLeft)
  const personas = usePersonas()
  const menu = useContextMenu()
  const picker = useConversationPicker()
  const usage = useLiveUsage(project, AGENT)
  const live = a.live
  const idle = live && (live.status === 'ready' || live.status === 'finished')
  const empty = !usage || usage.userMessages === 0 || (usage.contextTokens ?? 0) === 0
  // Highlighted past Settings → Assistant's threshold (overlaid on its host's config), as an agent's past its project's.
  const threshold = compactThreshold(project.config, settings?.sessions.compactSuggestTokens ?? 0)
  const suggested = threshold > 0 && (usage?.contextTokens ?? 0) >= threshold
  const personaId = assistantPersona(a, settings)
  const persona = personas.find((p) => p.id === personaId)

  const personaMenu = (e: React.MouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const current = personas.find((p) => p.id === personaId)
    menu.openAt(r.left, r.bottom + 2, [
      { header: true, label: live ? 'Mode (switches now, keeping the conversation)' : 'Mode' },
      ...personas
        .filter((p) => p.bundled !== 'missing')
        .map(
          (p): MenuEntry => ({
            label: `${p.icon ? `${p.icon}  ` : ''}${p.name}`,
            detail: p.description,
            icon: p.id === personaId ? 'check' : undefined,
            onClick: () => void choosePersona(p)
          })
        ),
      { separator: true },
      ...(live && current ? [{ label: 'Restart in This Mode…', icon: 'refresh', onClick: () => void restartInMode(current) } as MenuEntry] : []),
      { label: 'Manage Modes…', icon: 'person', onClick: () => showAssistantView('personas') }
    ])
  }
  const start = (): void => void actions.newSession(project.path, AGENT)
  const resume = (): void => void actions.resumeLast(project.path, AGENT)
  const resumeTip = a.resume ? `Resume "${sessionLabel(a.resume, 'Assistant')}", ${timeAgo(a.resume.lastActiveAt)}` : ''
  const stop = (): void => void actions.stopSession(project.path, AGENT)
  const compact = (): void => set({ compactFor: { project: project.path, agentId: AGENT } })
  const compacting = isCompacting(live)
  const compactTip = compacting ? 'Compacting the conversation…' : empty ? 'Nothing to compact yet' : idle ? `Compact the conversation${usage ? ` (now ${formatTokens(usage.contextTokens ?? 0)} tokens)` : ''}.${suggested ? ' Recommended: the context is over your threshold.' : ''}` : 'Compact once the Assistant has finished'
  /** A header button: an icon with a tooltip, like an agent pane's in its icon size. */
  const btn = (icon: string, label: string, onClick: () => void, tone: string, tip: string, disabled = false, spin = false) => (
    <Tooltip content={tip}>
      <button type="button" className={cx('btn small pane-btn icon-only', tone)} disabled={disabled} aria-label={label} onClick={onClick}>
        <Icon name={icon} spin={spin} />
      </button>
    </Tooltip>
  )
  const moreMenu = (e: React.MouseEvent): void => {
    const { clientX: x, clientY: y } = e
    // Start, Compact and Stop are the header's buttons until it gets too narrow for them (Resume always is one).
    const folded: MenuEntry[] = buttons
      ? []
      : live
        ? [
            { label: 'Compact…', icon: 'fold', disabled: !idle || empty, onClick: compact },
            { label: 'Stop', icon: 'debug-stop', action: 'stop', onClick: stop }
          ]
        : [a.resume ? { label: 'New Conversation', icon: 'add', action: 'start', onClick: start } : { label: 'Start', icon: 'play', action: 'start', onClick: start }]
    menu.openAt(x, y, [
      ...folded,
      live
        ? { label: 'New Conversation', icon: 'add', action: 'start', onClick: start }
        : { label: 'Resume', icon: 'debug-continue', action: 'resume', disabled: !a.resume, onClick: resume },
      { label: 'Resume a Conversation…', icon: 'history', action: 'resume', onClick: () => void picker.openAt(project, x, y) },
      { label: 'All Conversations…', icon: 'comment-discussion', onClick: () => showAssistantView('conversations') },
      { separator: true },
      { label: 'Assistant Settings…', icon: 'settings', onClick: () => set({ assistantSettingsOpen: true }) },
      { label: 'Manage Modes…', icon: 'person', onClick: () => showAssistantView('personas') },
      { separator: true },
      { label: left ? 'Move Panel to the Right' : 'Move Panel to the Left', icon: left ? 'layout-sidebar-right' : 'layout-sidebar-left', onClick: () => void setAssistantSide(left ? 'right' : 'left') },
      { label: 'Hide the Assistant', icon: left ? 'layout-sidebar-left-off' : 'layout-sidebar-right-off', onClick: () => setAssistantOpen(false) }
    ])
  }
  const kb = commandKeybinding('assistant.toggle')
  return (
    <div className="assistant-header" ref={ref}>
      <Tooltip content={providerDescriptor(agentProviderOf(project, a)).name}>
        <span>
          <ProviderIcon provider={agentProviderOf(project, a)} />
        </span>
      </Tooltip>
      <strong className="assistant-title">Assistant</strong>
      <Tooltip content={persona ? `${persona.name}: ${persona.description}` : 'Choose a mode'}>
        <button className="btn subtle small assistant-persona" onClick={personaMenu}>
          <span className="assistant-persona-icon">{persona?.icon || '🐝'}</span>
          <span className="assistant-persona-name">{persona?.name ?? personaId}</span>
          <Icon name="chevron-down" />
        </button>
      </Tooltip>
      <div className="grow" />
      {live ? (
        buttons && (
          <>
            {btn(compacting ? 'loading' : 'fold', 'Compact', compact, cx('subtle', suggested && idle && 'suggest'), compactTip, !idle || empty, compacting)}
            {btn('stop-circle', 'Stop', stop, 'act-stop', 'Stop the Assistant (the conversation is kept)')}
          </>
        )
      ) : a.resume ? (
        // A conversation to go back to: Resume first, and stays when the header narrows; New folds into ⋯.
        <>
          {btn('debug-continue', 'Resume', resume, 'act-resume solid', resumeTip)}
          {buttons && btn('add', 'New conversation', start, 'act-start', 'Start a new conversation')}
        </>
      ) : (
        buttons && btn('play', 'Start', start, 'act-start solid', 'Start the Assistant')
      )}
      <IconButton icon="ellipsis" title="More" onClick={moreMenu} />
      <IconButton icon={left ? 'chevron-left' : 'chevron-right'} title={`Hide the Assistant (it keeps running)${kb ? ` (${formatKeybinding(kb)})` : ''}`} onClick={() => setAssistantOpen(false)} />
      {menu.element}
      {picker.element}
    </div>
  )
}

/** Questions the Assistant's actions wait on (e.g. stopping a busy agent): the user answers on the card. */
function AssistantQuestions() {
  const questions = useStore((s) => s.assistantQuestions)
  const answering = useStore((s) => s.running)
  if (!questions.length) return null
  return (
    <div className="assistant-questions">
      {questions.map((q) => (
        <div key={q.id} className="assistant-question" role="alertdialog" aria-label={q.title}>
          <div className="assistant-question-title">
            <Icon name="question" /> {q.title}
          </div>
          <div className="assistant-question-message">{q.message}</div>
          <div className="assistant-question-buttons">
            {/* Answered once: a second click while the answer goes is ignored. */}
            <button className="btn small subtle" disabled={!!answering[`answer:${q.id}`]} onClick={() => void runOnce(`answer:${q.id}`, () => call('assistant:answer', q.id, false))}>
              {q.no}
            </button>
            <button className="btn small danger" disabled={!!answering[`answer:${q.id}`]} onClick={() => void runOnce(`answer:${q.id}`, () => call('assistant:answer', q.id, true))}>
              {q.yes}
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * The Assistant's status in one line under the header (#312): its own status icon (#399: its mark in the status's
 * colour, with an agent's status dot on it), then "Status: Working", "Status: Waiting for #12 #13 → Review (watch until
 * 22:22)", the attention colour when it needs you, and each card it waits for the card chip used everywhere (its column's
 * colour; a click opens it). Cut short with "…" in a narrow panel, the whole line in its tooltip.
 */
function AssistantStatus({ a }: { a: AgentInfo }) {
  useDateStyle()
  const live = a.live
  // Hive's own questions its actions wait on (the cards under this line): the user is wanted first.
  const approvals = useStore((s) => s.assistantQuestions)
  const tasks = useStore((s) => s.tasks)
  const line = assistantStatusLine(live, (iso) => formatTime(iso), approvals.map((q) => q.title))
  const whole = `Status: ${line.text}${line.cards.map((n) => `#${n}`).join(', ')}${line.after}`
  const status = live?.status ?? 'stopped'
  return (
    <div className={cx('assistant-status', line.tone)} data-tone={line.tone}>
      <AssistantMark status={status} unseen={live?.unseen} title={`The Assistant: ${live ? statusText(live) : 'not running'}`} />
      <Tooltip content={whole}>
        <span className="assistant-status-text">
          Status: {line.text}
          {line.cards.map((n) => {
            const card = tasks.find((c) => c.number === n && !c.archived) ?? null
            return <TaskChip key={n} number={n} column={card?.column ?? null} short label={`Open card #${n}${card ? `, in ${columnLabel(card.column)}` : ''}`} />
          })}
          {line.after}
        </span>
      </Tooltip>
      <ReviewMark live={live} />
    </div>
  )
}

/** Whether a workspace's "Done by the Assistant" is folded to its header (remembered per workspace). */
const actionsFoldKey = (ws: string): string => `assistant-actions:${ws.toLowerCase()}`

/**
 * What the Assistant did in this workspace, newest first, under its status line (#312, moved there by #399): the last 3,
 * Show all scrolls every one inside the same height, and the header folds it all away to give the terminal the room.
 * Not shown until it has done something.
 */
function AssistantActions() {
  const list = useStore((s) => s.assistantActions)
  const reverting = useStore((s) => s.running)
  const ws = useStore((s) => s.workspace?.path ?? '')
  const folded = useStore((s) => s.panes[actionsFoldKey(ws)] === 1)
  useDateStyle()
  if (!list.length) return null
  const newest = [...list].reverse()
  const reverted = new Set(list.map((a) => a.revertOf).filter(Boolean))
  const toggle = (): void => {
    const key = actionsFoldKey(ws)
    set((s) => ({ panes: { ...s.panes, [key]: folded ? 0 : 1 } }))
    void call('ui:setPane', key, folded ? null : 1)
  }
  // A setting it changed (#186): Revert puts the old value back, through the same checks.
  const revert = (x: AssistantAction): void => void runOnce(`revert:${x.id}`, () => actions.attempt('Could not revert the setting', () => call('assistant:revertSetting', x.id)))
  const row = (x: AssistantAction) => (
    <Tooltip block content={`${formatDateTime(x.at)}${x.error ? `\nNot done: ${x.error}` : ''}${x.setting ? `\n${x.setting.path}: ${x.setting.oldText} → ${x.setting.newText}` : ''}`}>
      <div className={cx('assistant-action', !x.ok && 'failed')}>
        <Icon name={x.ok ? 'check' : 'circle-slash'} />
        <span className="assistant-action-text">{x.text}</span>
        {x.setting &&
          x.ok &&
          (reverted.has(x.id) ? (
            <span className="faint">reverted</span>
          ) : (
            <button
              className="btn small subtle assistant-revert"
              disabled={!!reverting[`revert:${x.id}`]}
              aria-label={`Revert ${x.setting.path} to ${x.setting.oldText}`}
              onClick={(e) => {
                e.stopPropagation()
                revert(x)
              }}
            >
              <Icon name="discard" /> Revert
            </button>
          ))}
        <span className="faint">{timeAgo(x.at)}</span>
      </div>
    </Tooltip>
  )
  return (
    <div className={cx('assistant-actions', folded && 'folded')}>
      <button type="button" className="assistant-actions-head" aria-expanded={!folded} onClick={toggle}>
        <Icon name={folded ? 'chevron-right' : 'chevron-down'} />
        <AssistantMark />
        Done by the Assistant
        <span className="faint">({list.length})</span>
      </button>
      {!folded && <ShowAllList items={newest} few={3} keyOf={(x) => x.id} renderItem={row} label="Done by the Assistant" className="assistant-actions-list" />}
    </div>
  )
}

/**
 * What an agent is doing, in a few words (#311): its status when it needs you, else its open progress run ("e2e: 12
 * suites 4/12"), else its status (background tasks, a card watch…). Nothing while it isn't running.
 */
function activityOf(live: AgentInfo['live'], run: ProgressRun | null): string | null {
  if (!live) return null
  const needsYou = live.status === 'waiting' || live.status === 'signin' || live.status === 'error' || !!live.question
  return run && !needsYou ? runWords(run) : statusText(live)
}

/**
 * How an agent's row in the workspace overview is backed (#399, after the Performance chart): a soft wash of its status's
 * colour while it runs something, the chart's faint hatch while it waits (on cards, or for you), plain otherwise.
 */
function rowBacking(live: AgentInfo['live']): { status: string; backing: 'wash' | 'hatch' | null } {
  if (!live) return { status: 'stopped', backing: null }
  // A question it works on beside is waiting for you too.
  const status = live.question && live.status !== 'waiting' ? 'waiting' : live.status
  if (status === 'working' || status === 'background' || status === 'starting') return { status, backing: 'wash' }
  if (status === 'watching' || status === 'waiting' || status === 'signin' || status === 'error') return { status, backing: 'hatch' }
  return { status, backing: null }
}

/**
 * One agent in the workspace overview: its dot, provider and name, the card it is on (#311: the short chip, its icon and
 * number, the eye when reviewing; a click opens the card) and what it is doing, cut short with "…" when the panel is
 * narrow. The tooltip has the rest: its status, every card it has in Doing or is reviewing, its progress and its
 * worktree's branch.
 */
function OverviewAgent({ project: p, a, onGo }: { project: ProjectInfo; a: AgentInfo; onGo: () => void }) {
  const doing = useAgentCards(p, a.id)
  const reviewing = useAgentReviews(p, a.id)
  const run = useStore((s) => agentOpenRun(s.progressRuns, p.path, a.id))
  const activity = activityOf(a.live, run)
  const row = rowBacking(a.live)
  const tip = [
    `${a.name}: ${a.live ? statusText(a.live) : 'not running'}`,
    ...doing.map((c) => `Working on #${c.number} ${c.title}`),
    ...reviewing.map((c) => `Reviewing #${c.number} ${c.title}`),
    ...(run ? [`Progress: ${runWords(run)}${run.stepName ? ` (${run.stepName})` : ''}`] : []),
    ...(a.worktree ? [`Worktree on ${a.worktree.branch}`] : [])
  ].join('\n')
  return (
    <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{tip}</span>}>
      <span className={cx('assistant-agent', row.backing && `row-${row.backing}`)} data-agent={a.id} data-status={row.status} onClick={onGo}>
        <span className={cx('dot', a.live?.status ?? 'stopped', a.live?.unseen && 'unseen')} />
        <ProviderIcon provider={agentProviderOf(p, a)} />
        <span className="assistant-agent-name">{a.name}</span>
        <CardChip project={p} a={a} short tip={false} />
        {activity && <span className="assistant-agent-status">{activity}</span>}
      </span>
    </Tooltip>
  )
}

/** Whether a workspace's overview shows its inactive projects (remembered per workspace). */
const inactiveKey = (ws: string): string => `assistant-inactive:${ws.toLowerCase()}`

/** Where a project's fold in the overview is remembered (#399): per workspace and project. */
const assistantFoldKey = (ws: string, project: string): string => `${ws}|${project}`.toLowerCase()

/**
 * A project in the workspace overview: its name, and its agents under it with a fixed indent (#240). Its chevron folds it
 * to one line (#399, remembered per workspace and project): the name, its most urgent agent's dot and how many run.
 */
function OverviewProject({ ws, project: p, go }: { ws: string; project: ProjectInfo; go: (p: ProjectInfo, id?: string) => void }) {
  const key = assistantFoldKey(ws, p.path)
  const folded = useStore((s) => s.assistantFold[key] === true)
  const running = p.agents.filter((a) => a.live).length
  const urgent = mostUrgent(p.agents.map((a) => a.live))
  const summary = p.agents.length === 0 ? 'no agents' : running ? `${running} running` : 'not running'
  const toggle = (): void => rememberProjectPref('assistantFold', key, folded ? null : true)
  return (
    <div className={cx('assistant-project', !p.active && 'inactive', folded && 'folded')} data-project={p.name}>
      <div className="assistant-project-head">
        <button type="button" className="assistant-project-fold" aria-expanded={!folded} aria-label={`${folded ? 'Show' : 'Fold'} ${p.name}'s agents`} onClick={toggle}>
          <Icon name={folded ? 'chevron-right' : 'chevron-down'} />
        </button>
        <span className="assistant-project-name" onClick={() => go(p)}>
          {p.name}
        </span>
        {folded && (
          <span className="assistant-project-summary" onClick={toggle}>
            {p.agents.length > 0 && <span className={cx('dot', urgent?.status ?? 'stopped', urgent?.unseen && 'unseen')} />}
            <span className="faint">{summary}</span>
          </span>
        )}
      </div>
      {!folded && (
        <div className="assistant-agents">
          {p.agents.length === 0 && <span className="faint">no agents</span>}
          {p.agents.map((a) => (
            <OverviewAgent key={a.id} project={p} a={a} onGo={() => go(p, a.id)} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * What is happening in the workspace: agents needing you first, then each project and its agents. Click one to go
 * to it. Inactive projects without a running agent fold into one row at the end.
 */
function WorkspaceOverview() {
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  const ws = useStore((s) => s.workspace?.path ?? '')
  const showInactive = useStore((s) => s.panes[inactiveKey(ws)] === 1)
  const toggleInactive = (): void => {
    const v = showInactive ? 0 : 1
    set((s) => ({ panes: { ...s.panes, [inactiveKey(ws)]: v } }))
    void call('ui:setPane', inactiveKey(ws), v)
  }
  const go = (p: ProjectInfo, id?: string): void => {
    set({ selectedProject: p.path })
    showView('projects')
    if (id) revealAgent(p, id)
  }
  // The inbox's agents that need you, oldest first (the Assistant itself isn't listed in its own panel).
  const needYou = useInbox().needYou
  const attention = needYou.flatMap((i) => {
    const p = projects.find((x) => x.path === i.projectPath)
    const a = p?.agents.find((x) => x.id === i.agentId)
    return p && a ? [{ i, p, a }] : []
  })
  const running = projects.reduce((n, p) => n + p.agents.filter((a) => a.live).length, 0)
  const shown = projects.filter((p) => p.active || p.agents.some((a) => a.live))
  const folded = projects.filter((p) => !shown.includes(p))
  const row = (p: ProjectInfo) => <OverviewProject key={p.path} ws={ws} project={p} go={go} />
  return (
    <div className="assistant-overview">
      <div className="assistant-section-title">
        Workspace
        <span className="faint">
          {running} running · {projects.length} project{projects.length === 1 ? '' : 's'}
        </span>
      </div>
      {attention.map(({ i, p, a }) => (
        <div key={`${p.path}#${a.id}`} className="assistant-attention" onClick={() => go(p, a.id)}>
          <Icon name={i.kind === 'finished' ? 'check' : 'bell-dot'} />
          <span>
            <strong>{p.name}</strong>
            {p.agents.length > 1 ? ` · ${a.name}` : ''} {i.kind === 'waiting' ? 'is waiting for you' : i.kind === 'question' ? 'has a question for you' : 'has finished'}
            {i.message ? `: ${i.message}` : ''}
          </span>
        </div>
      ))}
      {projects.length === 0 && <div className="faint assistant-empty">No projects in this workspace yet.</div>}
      {shown.map(row)}
      {folded.length > 0 && (
        <button type="button" className="assistant-fold" aria-expanded={showInactive} onClick={toggleInactive}>
          <Icon name={showInactive ? 'chevron-down' : 'chevron-right'} />
          {folded.length} inactive project{folded.length === 1 ? '' : 's'}
        </button>
      )}
      {showInactive && folded.map(row)}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Assistant Settings: this workspace's choices, over Settings → Assistant
// ---------------------------------------------------------------------------

export function AssistantSettingsDialog() {
  const openFlag = useStore((s) => s.assistantSettingsOpen)
  const a = useStore((s) => s.workspace?.assistant ?? null)
  const settings = useStore((s) => s.settings)
  const personas = usePersonas()
  const agent = a?.agents[0] ?? null
  const current: ProviderId = a && agent ? (agent.live?.provider ?? agentProvider(agent, a.config, settings)) : ''
  const [provider, setProvider] = useState<ProviderId>(current)
  const [persona, setPersona] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [permission, setPermission] = useState('')
  const [context, setContext] = useState<ContextChoice>('')
  useEffect(() => {
    setProvider(current)
    setPersona(agent?.persona ?? '')
    setModel(agent?.model ?? '')
    setEffort(agent?.effort ?? '')
    setPermission(agent?.permissionMode ?? '')
    setContext(contextChoice(agent?.use200kContext))
    // Reset each time the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFlag])
  if (!openFlag || !a || !agent) return null
  const close = (): void => set({ assistantSettingsOpen: false })
  const chooseProvider = (v: ProviderId): void => {
    setProvider(v)
    if (v !== provider) {
      setModel('')
      setEffort('')
      setPermission('')
      setContext('')
    }
  }
  const defaultPersona = personas.find((p) => p.id === (settings?.assistant.persona || DEFAULT_PERSONA))
  const save = async (): Promise<void> => {
    const providerChanged = provider !== current
    const personaChanged = assistantPersona({ persona }, settings) !== assistantPersona(agent, settings)
    if (permission && permission !== agent.permissionMode && !(await confirmDangerousMode(provider, permission, 'The Assistant'))) return
    const ok = await changeAssistant(
      {
        ...(providerChanged ? { provider } : {}),
        persona: persona || undefined,
        model: model || undefined,
        effort: (effort || undefined) as EffortLevel | undefined,
        permissionMode: (permission || undefined) as PermissionMode | undefined,
        use200kContext: contextValue(context)
      },
      providerChanged
        ? {
            title: 'Restart the Assistant?',
            message: `Switching to ${providerDescriptor(provider).name} stops this conversation (${providerDescriptor(current).name} conversations can't move to another provider) and starts a new one.`
          }
        : null
    )
    // A new mode needs no restart: the running Assistant is told it (#259).
    if (ok && personaChanged && !providerChanged && agent.live) await actions.attempt('Could not tell the Assistant its mode', () => call('assistant:switchMode', assistantPersona({ persona }, settings), false))
    if (ok) close()
  }
  return (
    <Modal
      title="Assistant Settings"
      icon="settings"
      onClose={close}
      footer={
        <>
          <button className="btn subtle" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <p className="hint">
        For this workspace. Anything left at <em>Default</em> follows{' '}
        <a
          onClick={() => {
            close()
            set({ settingsSection: 'assistant', settingsQuery: '' })
            setActivity('settings')
          }}
        >
          Settings → Assistant
        </a>
        .
      </p>
      <div className="agent-form">
        <label>Mode</label>
        <select className="select" value={persona} onChange={(e) => setPersona(e.target.value)}>
          <option value="">Default ({defaultPersona?.name ?? settings?.assistant.persona ?? 'Overseer'})</option>
          {personas
            .filter((p) => p.bundled !== 'missing')
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.icon ? `${p.icon} ` : ''}
                {p.name}
              </option>
            ))}
        </select>
      </div>
      <h3 className="agent-dialog-h">Coding agent</h3>
      <ProviderChoice value={provider} current={current} onChange={chooseProvider} />
      <h3 className="agent-dialog-h">Settings</h3>
      <Overrides project={a} provider={provider} model={model} effort={effort} permission={permission} context={context} onModel={setModel} onEffort={setEffort} onPermission={setPermission} onContext={setContext} inherit="Default" />
      {agent.live && <div className="detail">Model, effort, mode and context apply when the Assistant next starts. A new mode is told to it at once; a new provider restarts it now (after asking).</div>}
    </Modal>
  )
}
