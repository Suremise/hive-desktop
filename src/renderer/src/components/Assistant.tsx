import { Children, useEffect, useRef, useState } from 'react'
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
import { msg, tr, tRich, type Msg } from '@shared/i18n'

/**
 * The Hive Assistant's side panel: the workspace's overseer. Its header (persona, controls) and status line, what is
 * happening in the workspace, its terminal, its footer (model, mode, context, cost) and what it has done. Everything about the
 * Assistant is here, apart from managing personas (their own view) and its defaults (Settings → Assistant).
 */

const AGENT = ASSISTANT_AGENT_ID
// i18n-ignore: the name Hive's own names for the Assistant's sessions start with (sessionLabel tells them apart), not text
const SESSION_NAMES = 'Assistant'

const M = {
  resumeLater: msg({ id: 'assistant.panel.resumeLater', defaultMessage: "You can resume the current conversation later from the Assistant's ⋯ menu.", description: "Under a confirmation that restarts the Assistant. ⋯ is the panel's More button." }),
  restartButton: msg({ id: 'assistant.panel.restartButton', defaultMessage: 'Restart the Assistant', description: "A confirmation's button: stops the Assistant and starts a new conversation." }),
  stopFailed: msg({ id: 'assistant.panel.stopFailed', defaultMessage: 'Could not stop the Assistant', description: "An error notice: the Assistant's session couldn't be stopped; the reason follows." }),
  saveFailed: msg({ id: 'assistant.panel.saveFailed', defaultMessage: "Could not save the Assistant's settings", description: "An error notice: the Assistant Settings dialog's choices couldn't be saved; the reason follows." }),
  switchFailed: msg({ id: 'assistant.panel.switchFailed', defaultMessage: 'Could not switch the mode', description: "An error notice: the Assistant's mode couldn't be switched; the reason follows." }),
  modeTitle: msg({ id: 'assistant.panel.modeTitle', defaultMessage: 'Mode: {name}', description: "A notice after the Assistant's mode was switched ({name}: the mode, Advisor…)." }),
  modeTold: msg({ id: 'assistant.panel.modeTold', defaultMessage: 'The Assistant has been told, in this conversation.', description: 'Under Mode: …, when the running Assistant was told at once.' }),
  modeLater: msg({ id: 'assistant.panel.modeLater', defaultMessage: 'The Assistant will be told as soon as it has finished what it is doing.', description: 'Under Mode: …, when the Assistant is busy.' }),
  restartTitle: msg({ id: 'assistant.panel.restartTitle', defaultMessage: 'Restart in {name} mode?', description: 'Confirmation before Restart in This Mode ({name}: the mode).' }),
  restartMessage: msg({ id: 'assistant.panel.restartMessage', defaultMessage: "The Assistant stops and resumes this conversation with the {name} mode's full instructions.", description: 'Confirmation before Restart in This Mode ({name}: the mode).' }),
  restartDetail: msg({ id: 'assistant.panel.restartDetail', defaultMessage: 'The whole conversation is cached again, which costs more than switching (switching keeps everything and only tells the Assistant the mode).', description: 'Confirmation before Restart in This Mode.' }),
  restart: msg({ id: 'assistant.panel.restart', defaultMessage: 'Restart', description: "Restart in This Mode's confirmation: its button." }),
  saveModeFailed: msg({ id: 'assistant.panel.saveModeFailed', defaultMessage: 'Could not save the mode', description: "An error notice: Restart in This Mode couldn't save the mode; the reason follows." }),
  transcriptAdvice: msg({ id: 'assistant.panel.transcriptAdvice', defaultMessage: 'Start a new conversation (⋯ → New Conversation) to keep things quick.', description: "The Assistant's footer, in the tooltip of a long conversation's size. ⋯ is the More button; New Conversation its menu item." }),
  settingsName: msg({ id: 'assistant.panel.settingsName', defaultMessage: 'Assistant Settings', description: "The Assistant's footer: its settings button, and the Assistant Settings dialog's title." }),
  show: msg({ id: 'assistant.panel.show', defaultMessage: 'Show the Hive Assistant', description: "The hidden Assistant panel's strip, for screen readers." }),
  showTip: msg({ id: 'assistant.panel.showTip', defaultMessage: '{hasKey, select, yes {Show the Hive Assistant ({key})} other {Show the Hive Assistant}}', description: 'Tooltip on the hidden Assistant panel\'s strip, with its shortcut ({key}: "Ctrl+Alt+I").' }),
  asking: msg({ id: 'assistant.panel.asking', defaultMessage: 'The Assistant is asking you something', description: "The hidden Assistant panel's bell: a question waits for you." }),
  statusTitle: msg({ id: 'assistant.panel.statusTitle', defaultMessage: '{running, select, yes {The Assistant: {status}} other {The Assistant is not running}}', description: "The Assistant's mark: what it is doing ({status}: Working, Waiting for you…)." }),
  railLabel: msg({ id: 'assistant.panel.railLabel', defaultMessage: 'Hive Assistant', description: "The hidden Assistant panel's strip, written down it. Hive's name stays as it is." }),
  resumeTip: msg({ id: 'assistant.panel.resumeTip', defaultMessage: 'Resume "{name}", {when}', description: 'Tooltip on Resume: the conversation and when it was last active ({when}: "3 hours ago").' }),
  resume: msg({ id: 'assistant.panel.resume', defaultMessage: 'Resume', description: "A button: resumes the Assistant's last conversation." }),
  ended: msg({ id: 'assistant.panel.ended', defaultMessage: 'The conversation has ended.', description: "The Assistant's panel after its conversation ended." }),
  new: msg({ id: 'assistant.panel.new', defaultMessage: 'New', description: 'A button after the conversation ended: starts a new one.' }),
  theAssistant: msg({ id: 'assistant.panel.theAssistant', defaultMessage: 'The Assistant', description: "The Assistant's name when its mode isn't known yet, at the start of a sentence; and who a no-guardrails mode would run as." }),
  watches: msg({ id: 'assistant.panel.watches', defaultMessage: '<b>{name}</b> watches over this workspace: ask it what the agents are doing, about any project, or for a plan or a review.', description: "The Assistant's panel before it starts. {name} is its mode (Overseer…) or The Assistant; <b> is bold." }),
  noEdits: msg({ id: 'assistant.panel.noEdits', defaultMessage: "It doesn't edit files itself. Within Settings → Assistant → Control, it can run agents for you and create projects; everything it does is listed here.", description: "The Assistant's panel before it starts. Keep the setting's path as Settings shows it." }),
  start: msg({ id: 'assistant.panel.start', defaultMessage: 'Start Assistant', description: "A button in the Assistant's panel before it starts." }),
  conversations: msg({ id: 'assistant.panel.conversations', defaultMessage: 'Conversations', description: "A button: a menu of the Assistant's past conversations." }),
  listFailed: msg({ id: 'assistant.panel.listFailed', defaultMessage: 'Could not list conversations', description: "An error notice: the Assistant's past conversations couldn't be listed; the reason follows." }),
  resumeOne: msg({ id: 'assistant.panel.resumeOne', defaultMessage: 'Resume a conversation', description: "The heading of the menu of the Assistant's past conversations." }),
  noConversations: msg({ id: 'assistant.panel.noConversations', defaultMessage: 'No conversations yet', description: "The menu of the Assistant's past conversations, when there are none." }),
  openNow: msg({ id: 'assistant.panel.openNow', defaultMessage: 'open now', description: "Beside a past conversation in the menu: it is the one running. Lower case: it follows when it was active." }),
  modeHeaderLive: msg({ id: 'assistant.panel.modeHeaderLive', defaultMessage: 'Mode (switches now, keeping the conversation)', description: "The heading of the Assistant's mode menu while it runs." }),
  modeHeader: msg({ id: 'assistant.panel.modeHeader', defaultMessage: 'Mode', description: "The heading of the Assistant's mode menu." }),
  restartInMode: msg({ id: 'assistant.panel.restartInMode', defaultMessage: 'Restart in This Mode…', description: "An item of the Assistant's mode menu: restarts it with the mode's full instructions." }),
  manageModes: msg({ id: 'assistant.panel.manageModes', defaultMessage: 'Manage Modes…', description: "The Assistant's mode and More menus: opens the modes in the Assistant view." }),
  compacting: msg({ id: 'assistant.panel.compacting', defaultMessage: 'Compacting the conversation…', description: 'Tooltip on Compact while the conversation is compacted.' }),
  nothingToCompact: msg({ id: 'assistant.panel.nothingToCompact', defaultMessage: 'Nothing to compact yet', description: 'Tooltip on Compact before anything was said.' }),
  compactTip: msg({ id: 'assistant.panel.compactTip', defaultMessage: '{hasTokens, select, yes {Compact the conversation (now {tokens} tokens).} other {Compact the conversation.}}{suggested, select, yes { Recommended: the context is over your threshold.} other {}}', description: 'Tooltip on Compact ({tokens}: "120K"). The second sentence when the context is over Settings → Sessions\' threshold.' }),
  compactLater: msg({ id: 'assistant.panel.compactLater', defaultMessage: 'Compact once the Assistant has finished', description: 'Tooltip on Compact while the Assistant works.' }),
  compactMenu: msg({ id: 'assistant.panel.compactMenu', defaultMessage: 'Compact…', description: "The Assistant's More menu, in a narrow panel." }),
  stop: msg({ id: 'assistant.panel.stop', defaultMessage: 'Stop', description: "The Assistant's Stop button and menu item." }),
  newConversation: msg({ id: 'assistant.panel.newConversation', defaultMessage: 'New Conversation', description: "An item of the Assistant panel's More (⋯) menu: starts a new conversation." }),
  startMenu: msg({ id: 'assistant.panel.startMenu', defaultMessage: 'Start', description: "The Assistant's Start button and menu item." }),
  resumeMenu: msg({ id: 'assistant.panel.resumeMenu', defaultMessage: 'Resume', description: "An item of the Assistant panel's More (⋯) menu: resumes its last conversation." }),
  resumeConversation: msg({ id: 'assistant.panel.resumeConversation', defaultMessage: 'Resume a Conversation…', description: "An item of the Assistant panel's More (⋯) menu: a list of past conversations to resume." }),
  allConversations: msg({ id: 'assistant.panel.allConversations', defaultMessage: 'All Conversations…', description: "The Assistant's More menu: opens its conversations in the Assistant view." }),
  settingsMenu: msg({ id: 'assistant.panel.settingsMenu', defaultMessage: 'Assistant Settings…', description: "An item of the Assistant panel's More (⋯) menu: opens the Assistant Settings dialog." }),
  moveRight: msg({ id: 'assistant.panel.moveRight', defaultMessage: 'Move Panel to the Right', description: "An item of the Assistant panel's More (⋯) menu: moves the panel to the window's right side." }),
  moveLeft: msg({ id: 'assistant.panel.moveLeft', defaultMessage: 'Move Panel to the Left', description: "An item of the Assistant panel's More (⋯) menu: moves the panel to the window's left side." }),
  hide: msg({ id: 'assistant.panel.hide', defaultMessage: 'Hide the Assistant', description: "An item of the Assistant panel's More (⋯) menu: hides the panel; the Assistant keeps running." }),
  title: msg({ id: 'assistant.panel.title', defaultMessage: 'Assistant', description: "The Assistant panel's title, beside its coding agent's icon. Keep it short." }),
  personaTip: msg({ id: 'assistant.panel.personaTip', defaultMessage: '{name}: {description}', description: "Tooltip on the Assistant's mode button: the mode and what it is for." }),
  chooseMode: msg({ id: 'assistant.panel.chooseMode', defaultMessage: 'Choose a mode', description: "Tooltip on the Assistant's mode button when it has none." }),
  compact: msg({ id: 'assistant.panel.compact', defaultMessage: 'Compact', description: "The Assistant's Compact button, for screen readers." }),
  stopTip: msg({ id: 'assistant.panel.stopTip', defaultMessage: 'Stop the Assistant (the conversation is kept)', description: "Tooltip on the Assistant panel's Stop button." }),
  newConversationLabel: msg({ id: 'assistant.panel.newConversationLabel', defaultMessage: 'New conversation', description: "The Assistant's New button, for screen readers." }),
  newConversationTip: msg({ id: 'assistant.panel.newConversationTip', defaultMessage: 'Start a new conversation', description: "Tooltip on the Assistant's New button." }),
  startTip: msg({ id: 'assistant.panel.startTip', defaultMessage: 'Start the Assistant', description: "Tooltip on the Assistant's Start button." }),
  more: msg({ id: 'assistant.panel.more', defaultMessage: 'More', description: "The Assistant panel's ⋯ button, which opens its More menu." }),
  hideTip: msg({ id: 'assistant.panel.hideTip', defaultMessage: '{hasKey, select, yes {Hide the Assistant (it keeps running) ({key})} other {Hide the Assistant (it keeps running)}}', description: 'Tooltip on the button that hides the Assistant panel, with its shortcut ({key}: "Ctrl+Alt+I").' }),
  status: msg({ id: 'assistant.panel.status', defaultMessage: 'Status: {text}', description: "The Assistant's status line under its header ({text}: \"Working\", \"Waiting for #12 → Review\")." }),
  openCard: msg({ id: 'assistant.panel.openCard', defaultMessage: '{known, select, yes {Open card #{number}, in {column}} other {Open card #{number}}}', description: 'A card chip in the Assistant\'s status line, for screen readers ({column}: "Review").' }),
  revertFailed: msg({ id: 'assistant.panel.revertFailed', defaultMessage: 'Could not revert the setting', description: "An error notice: a setting the Assistant changed couldn't be put back; the reason follows." }),
  notDone: msg({ id: 'assistant.panel.notDone', defaultMessage: 'Not done: {error}', description: "Tooltip on something the Assistant was refused, after when: why ({error}, from Hive's Agent API, in English)." }),
  reverted: msg({ id: 'assistant.panel.reverted', defaultMessage: 'reverted', description: 'Beside a setting the Assistant changed that was put back.' }),
  revertLabel: msg({ id: 'assistant.panel.revertLabel', defaultMessage: 'Revert {setting} to {value}', description: 'The Revert button, for screen readers ({setting}: the setting\'s path; {value}: its old value).' }),
  revert: msg({ id: 'assistant.panel.revert', defaultMessage: 'Revert', description: 'A button beside a setting the Assistant changed: puts the old value back.' }),
  doneBy: msg({ id: 'assistant.panel.doneBy', defaultMessage: 'Done by the Assistant', description: "The heading of the list of what the Assistant did (a count follows)." }),
  agentTip: msg({ id: 'assistant.panel.agentTip', defaultMessage: '{running, select, yes {{name}: {status}} other {{name}: not running}}', description: "The first line of an agent's tooltip in the Assistant's overview ({status}: Working…)." }),
  workingOn: msg({ id: 'assistant.panel.workingOn', defaultMessage: 'Working on #{number} {title}', description: "An agent's tooltip in the Assistant's overview: a card it works on." }),
  reviewing: msg({ id: 'assistant.panel.reviewing', defaultMessage: 'Reviewing #{number} {title}', description: "An agent's tooltip in the Assistant's overview: a card it reviews." }),
  progress: msg({ id: 'assistant.panel.progress', defaultMessage: '{hasStep, select, yes {Progress: {run} ({step})} other {Progress: {run}}}', description: "An agent's tooltip in the Assistant's overview: its test run ({run}: \"e2e: 12 suites 4/12\"; {step}: what it is on)." }),
  worktree: msg({ id: 'assistant.panel.worktree', defaultMessage: 'Worktree on {branch}', description: "An agent's tooltip in the Assistant's overview: its worktree's branch." }),
  noAgents: msg({ id: 'assistant.panel.noAgents', defaultMessage: 'no agents', description: "The Assistant's overview: a project with no agents. Lower case." }),
  running: msg({ id: 'assistant.panel.running', defaultMessage: '{count} running', description: "The Assistant's overview: how many of a folded project's agents run. Lower case." }),
  notRunning: msg({ id: 'assistant.panel.notRunning', defaultMessage: 'not running', description: "The Assistant's overview: none of a folded project's agents run. Lower case." }),
  foldLabel: msg({ id: 'assistant.panel.foldLabel', defaultMessage: "{folded, select, yes {Show {project}'s agents} other {Fold {project}'s agents}}", description: "The Assistant's overview: a project's chevron, for screen readers." }),
  workspace: msg({ id: 'assistant.panel.workspace', defaultMessage: 'Workspace', description: "The heading of the Assistant's overview of the workspace." }),
  counts: msg({ id: 'assistant.panel.counts', defaultMessage: '{running} running · {projects, plural, one {# project} other {# projects}}', description: "Beside Workspace in the Assistant's overview." }),
  attention: msg({ id: 'assistant.panel.attention', defaultMessage: '{kind, select, waiting {is waiting for you} question {has a question for you} safeguard {changed models after a safeguard stop} other {has finished}}', description: "The Assistant's overview: what an agent that needs you is doing, after its project and name. Lower case: it follows them." }),
  noProjects: msg({ id: 'assistant.panel.noProjects', defaultMessage: 'No projects in this workspace yet.', description: "The Assistant's overview with no projects." }),
  inactive: msg({ id: 'assistant.panel.inactive', defaultMessage: '{count, plural, one {# inactive project} other {# inactive projects}}', description: "The Assistant's overview: a row that shows the inactive projects folded into it." }),
  restartQuestion: msg({ id: 'assistant.panel.restartQuestion', defaultMessage: 'Restart the Assistant?', description: "Confirmation before the Assistant's coding agent is changed." }),
  switching: msg({ id: 'assistant.panel.switching', defaultMessage: "Switching to {to} stops this conversation ({from} conversations can't move to another provider) and starts a new one.", description: "Confirmation before the Assistant's coding agent is changed ({to}, {from}: Claude Code, Codex…)." }),
  tellFailed: msg({ id: 'assistant.panel.tellFailed', defaultMessage: 'Could not tell the Assistant its mode', description: "An error notice: the running Assistant couldn't be told its new mode; the reason follows." }),
  cancel: msg({ id: 'assistant.panel.cancel', defaultMessage: 'Cancel', description: "The Assistant Settings dialog's button that closes it without saving." }),
  save: msg({ id: 'assistant.panel.save', defaultMessage: 'Save', description: "The Assistant Settings dialog's button that saves the choices." }),
  forWorkspace: msg({ id: 'assistant.panel.forWorkspace', defaultMessage: 'For this workspace. Anything left at <i>Default</i> follows <link>Settings → Assistant</link>.', description: 'Assistant Settings, at the top. <i> is italic (the choice Default); <link> opens Settings → Assistant.' }),
  mode: msg({ id: 'assistant.panel.mode', defaultMessage: 'Mode', description: "Assistant Settings: the mode's label." }),
  defaultMode: msg({ id: 'assistant.panel.defaultMode', defaultMessage: 'Default ({name})', description: "Assistant Settings: the mode that follows Settings → Assistant ({name}: that mode)." }),
  codingAgent: msg({ id: 'assistant.panel.codingAgent', defaultMessage: 'Coding agent', description: 'Assistant Settings: a heading (Claude Code, Codex…).' }),
  settings: msg({ id: 'assistant.panel.settings', defaultMessage: 'Settings', description: 'Assistant Settings: the heading over model, effort, mode and context.' }),
  default: msg({ id: 'assistant.panel.default', defaultMessage: 'Default', description: "Assistant Settings: a model, effort, mode or context that follows Settings → Assistant (what it is follows in brackets)." }),
  appliesNext: msg({ id: 'assistant.panel.appliesNext', defaultMessage: 'Model, effort, mode and context apply when the Assistant next starts. A new mode is told to it at once; a new provider restarts it now (after asking).', description: 'Assistant Settings, at the bottom, while the Assistant runs.' })
}

const bold = (c: React.ReactNode[]): React.ReactNode => <strong>{c}</strong>
const italic = (c: React.ReactNode[]): React.ReactNode => <em>{c}</em>
/** Assistant Settings' link to Settings → Assistant: the dialog closes and Settings opens there. */
const settingsLink = (c: React.ReactNode[]): React.ReactNode => (
  <a
    onClick={() => {
      set({ assistantSettingsOpen: false, settingsSection: 'assistant', settingsQuery: '' })
      setActivity('settings')
    }}
  >
    {c}
  </a>
)

/**
 * The names of the modes Hive ships (resources/personas), as the window shows them (#806). Display only: the files keep
 * their names, and what the Assistant reads is the file.
 */
const SHIPPED_NAMES: Record<string, Msg> = {
  coordinator: msg({ id: 'assistant.modes.shipped.coordinator', defaultMessage: 'Coordinator', description: "The name of a mode of the Hive Assistant that ships with Hive: it runs the work across the agents. Shown in its menus and the Assistant view; keep it short." }),
  planner: msg({ id: 'assistant.modes.shipped.planner', defaultMessage: 'Planner', description: "The name of a mode of the Hive Assistant that ships with Hive: it shapes work before anyone starts it. Shown in its menus and the Assistant view; keep it short." }),
  'qa-triager': msg({ id: 'assistant.modes.shipped.qaTriager', defaultMessage: 'QA triager', description: "The name of a mode of the Hive Assistant that ships with Hive: it turns a bug report into a card with evidence. Shown in its menus and the Assistant view; keep it short." }),
  'release-manager': msg({ id: 'assistant.modes.shipped.releaseManager', defaultMessage: 'Release manager', description: "The name of a mode of the Hive Assistant that ships with Hive: it takes a release through its checklist. Shown in its menus and the Assistant view; keep it short." })
}

/**
 * A mode's name in the window: one Hive ships, in the window's language while its file still has Hive's name for it;
 * any other (the user's own, or one they renamed) as its file has it.
 */
export function personaName(p: Pick<PersonaInfo, 'id' | 'name' | 'bundled'>): string {
  const shipped = p.bundled ? SHIPPED_NAMES[p.id] : undefined
  return shipped && p.name === shipped.defaultMessage ? tr(shipped) : p.name
}

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
    const ok = await confirm({ title: restart!.title, message: restart!.message, detail: tr(M.resumeLater), confirmLabel: tr(M.restartButton) })
    if (!ok) return false
    await actions.attempt(tr(M.stopFailed), () => call('session:stop', a.path, AGENT))
    await actions.waitForStop(a.path, AGENT)
  }
  const done = await actions.attempt(tr(M.saveFailed), () => call('agents:update', a.path, AGENT, patch))
  await actions.refreshWorkspace()
  if (done && wasLive) await actions.newSession(a.path, AGENT)
  return !!done
}

/**
 * Makes a mode (a persona file) this workspace's Assistant's, at once and without a restart (#259): a running Assistant
 * is told in its conversation (now, or when it has finished what it is doing), which keeps its context; its next
 * launch starts in the mode.
 */
export async function choosePersona(p: Pick<PersonaInfo, 'id' | 'name' | 'bundled'>): Promise<void> {
  const agent = get().workspace?.assistant?.agents[0]
  if (!agent) return
  if (assistantPersona(agent, get().settings) === p.id && agent.persona === p.id) return
  const how = await actions.attempt(tr(M.switchFailed), () => call('assistant:switchMode', p.id))
  await actions.refreshWorkspace()
  if (how === 'told') notify('info', tr(M.modeTitle, { name: personaName(p) }), tr(M.modeTold))
  else if (how === 'later') notify('info', tr(M.modeTitle, { name: personaName(p) }), tr(M.modeLater))
}

/**
 * Restart in This Mode: the Assistant stops and resumes the same conversation with the mode's full instructions (a
 * switch only tells it the mode's habits). Its whole conversation is cached again, so it asks first.
 */
export async function restartInMode(p: Pick<PersonaInfo, 'id' | 'name' | 'bundled'>): Promise<void> {
  const a = get().workspace?.assistant
  const agent = a?.agents[0]
  const live = agent?.live
  if (!a || !agent || !live) return
  const ok = await confirm({
    title: tr(M.restartTitle, { name: personaName(p) }),
    message: tr(M.restartMessage, { name: personaName(p) }),
    detail: tr(M.restartDetail),
    confirmLabel: tr(M.restart)
  })
  if (!ok) return
  if (!(await actions.attempt(tr(M.saveModeFailed), () => call('agents:update', a.path, AGENT, { persona: p.id })))) return
  const item = (await call('session:list', a.path)).find((s) => s.id === live.sessionId)
  await actions.attempt(tr(M.stopFailed), () => call('session:stop', a.path, AGENT))
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
          transcriptAdvice={tr(M.transcriptAdvice)}
          settingsName={tr(M.settingsName)}
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
      aria-label={tr(M.show)}
      onClick={() => setAssistantOpen(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setAssistantOpen(true)
        }
      }}
    >
      <Tooltip content={tr(M.showTip, { hasKey: kb ? 'yes' : 'no', key: kb ? formatKeybinding(kb) : '' })}>
        <span className="rail-btn">
          <Icon name={left ? 'chevron-right' : 'chevron-left'} />
        </span>
      </Tooltip>
      {asking > 0 ? (
        <Icon name="bell-dot" className="assistant-rail-asking" title={tr(M.asking)} />
      ) : (
        <AssistantMark status={live?.status ?? 'stopped'} unseen={live?.unseen} title={tr(M.statusTitle, { running: live ? 'yes' : 'no', status: live ? statusText(live) : '' })} />
      )}
      <span className="assistant-rail-label">{tr(M.railLabel)}</span>
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
    <button className={cx(/* i18n-ignore: class names */ 'btn small', RESUME_TINT)} onClick={() => void actions.resumeLast(project.path, AGENT)} title={tr(M.resumeTip, { name: sessionLabel(a.resume, SESSION_NAMES), when: timeAgo(a.resume.lastActiveAt) })}>
      <Icon name="debug-continue" /> {tr(M.resume)}
    </button>
  ) : null
  if (ended) {
    return (
      <div className="session-ended compact assistant-ended">
        <Icon name="debug-disconnect" />
        <span className="grow">{tr(M.ended)}</span>
        {resume}
        <button className="btn act-start solid small" onClick={() => void actions.newSession(project.path, AGENT)}>
          <Icon name="add" /> {tr(M.new)}
        </button>
      </div>
    )
  }
  return (
    <div className="assistant-idle">
      <div className="assistant-idle-mark">{persona?.icon || '🐝'}</div>
      <p>
        {Children.toArray(tRich<React.ReactNode>(M.watches, { name: persona ? personaName(persona) : tr(M.theAssistant), b: bold }))}
      </p>
      <p className="faint">{tr(M.noEdits)}</p>
      <div className="btns">
        <button className="btn act-start solid" onClick={() => void actions.newSession(project.path, AGENT)}>
          <Icon name="play" /> {tr(M.start)}
        </button>
        {resume}
        <button className="btn subtle small" onClick={(e) => picker.openBelow(e.currentTarget, project)}>
          <Icon name="history" /> {tr(M.conversations)}
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
    const list = await actions.attempt(tr(M.listFailed), () => call('session:list', project.path))
    if (!list) return
    const open = project.agents[0]?.live?.sessionId
    const all = list.filter((s) => s.source === 'hive' && !s.archived && !s.sub)
    const items: MenuEntry[] = [{ header: true, label: tr(M.resumeOne) }]
    if (!all.length) items.push({ label: tr(M.noConversations), disabled: true })
    for (const s of all.slice(0, 12)) {
      items.push({
        label: sessionLabel(s, SESSION_NAMES),
        detail: [timeAgo(s.lastActivity), s.id === open ? tr(M.openNow) : null, s.provider ? providerDescriptor(s.provider).name : null].filter(Boolean).join(' · '),
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
      { header: true, label: tr(live ? M.modeHeaderLive : M.modeHeader) },
      ...personas
        .filter((p) => p.bundled !== 'missing')
        .map(
          (p): MenuEntry => ({
            label: `${p.icon ? `${p.icon}  ` : ''}${personaName(p)}`,
            detail: p.description,
            icon: p.id === personaId ? 'check' : undefined,
            onClick: () => void choosePersona(p)
          })
        ),
      { separator: true },
      ...(live && current ? [{ label: tr(M.restartInMode), icon: 'refresh', onClick: () => void restartInMode(current) } as MenuEntry] : []),
      { label: tr(M.manageModes), icon: 'person', onClick: () => showAssistantView('personas') }
    ])
  }
  const start = (): void => void actions.newSession(project.path, AGENT)
  const resume = (): void => void actions.resumeLast(project.path, AGENT)
  const resumeTip = a.resume ? tr(M.resumeTip, { name: sessionLabel(a.resume, SESSION_NAMES), when: timeAgo(a.resume.lastActiveAt) }) : ''
  const stop = (): void => void actions.stopSession(project.path, AGENT)
  const compact = (): void => set({ compactFor: { project: project.path, agentId: AGENT } })
  const compacting = isCompacting(live)
  const compactTip = compacting
    ? tr(M.compacting)
    : empty
      ? tr(M.nothingToCompact)
      : idle
        ? tr(M.compactTip, { hasTokens: usage ? 'yes' : 'no', tokens: formatTokens(usage?.contextTokens ?? 0), suggested: suggested ? 'yes' : 'no' })
        : tr(M.compactLater)
  /** A header button: an icon with a tooltip, like an agent pane's in its icon size. */
  const btn = (icon: string, label: string, onClick: () => void, tone: string, tip: string, disabled = false, spin = false) => (
    <Tooltip content={tip}>
      <button type="button" className={cx(/* i18n-ignore: class names */ 'btn small pane-btn icon-only', tone)} disabled={disabled} aria-label={label} onClick={onClick}>
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
            { label: tr(M.compactMenu), icon: 'fold', disabled: !idle || empty, onClick: compact },
            { label: tr(M.stop), icon: 'debug-stop', action: 'stop', onClick: stop }
          ]
        : [a.resume ? { label: tr(M.newConversation), icon: 'add', action: 'start', onClick: start } : { label: tr(M.startMenu), icon: 'play', action: 'start', onClick: start }]
    menu.openAt(x, y, [
      ...folded,
      live
        ? { label: tr(M.newConversation), icon: 'add', action: 'start', onClick: start }
        : { label: tr(M.resumeMenu), icon: 'debug-continue', action: 'resume', disabled: !a.resume, onClick: resume },
      { label: tr(M.resumeConversation), icon: 'history', action: 'resume', onClick: () => void picker.openAt(project, x, y) },
      { label: tr(M.allConversations), icon: 'comment-discussion', onClick: () => showAssistantView('conversations') },
      { separator: true },
      { label: tr(M.settingsMenu), icon: 'settings', onClick: () => set({ assistantSettingsOpen: true }) },
      { label: tr(M.manageModes), icon: 'person', onClick: () => showAssistantView('personas') },
      { separator: true },
      { label: tr(left ? M.moveRight : M.moveLeft), icon: left ? 'layout-sidebar-right' : 'layout-sidebar-left', onClick: () => void setAssistantSide(left ? 'right' : 'left') },
      { label: tr(M.hide), icon: left ? 'layout-sidebar-left-off' : 'layout-sidebar-right-off', onClick: () => setAssistantOpen(false) }
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
      <strong className="assistant-title">{tr(M.title)}</strong>
      <Tooltip content={persona ? tr(M.personaTip, { name: personaName(persona), description: persona.description }) : tr(M.chooseMode)}>
        <button className="btn subtle small assistant-persona" onClick={personaMenu}>
          <span className="assistant-persona-icon">{persona?.icon || '🐝'}</span>
          <span className="assistant-persona-name">{persona ? personaName(persona) : personaId}</span>
          <Icon name="chevron-down" />
        </button>
      </Tooltip>
      <div className="grow" />
      {live ? (
        buttons && (
          <>
            {btn(compacting ? 'loading' : 'fold', tr(M.compact), compact, cx('subtle', suggested && idle && 'suggest'), compactTip, !idle || empty, compacting)}
            {btn('stop-circle', tr(M.stop), stop, 'act-stop', tr(M.stopTip))}
          </>
        )
      ) : a.resume ? (
        // A conversation to go back to: Resume first, and stays when the header narrows; New folds into ⋯.
        <>
          {btn('debug-continue', tr(M.resume), resume, /* i18n-ignore: class names */ 'act-resume solid', resumeTip)}
          {buttons && btn('add', tr(M.newConversationLabel), start, 'act-start', tr(M.newConversationTip))}
        </>
      ) : (
        buttons && btn('play', tr(M.startMenu), start, /* i18n-ignore: class names */ 'act-start solid', tr(M.startTip))
      )}
      <IconButton icon="ellipsis" title={tr(M.more)} onClick={moreMenu} />
      <IconButton icon={left ? 'chevron-left' : 'chevron-right'} title={tr(M.hideTip, { hasKey: kb ? 'yes' : 'no', key: kb ? formatKeybinding(kb) : '' })} onClick={() => setAssistantOpen(false)} />
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
  const whole = tr(M.status, { text: `${line.text}${line.cards.map((n) => `#${n}`).join(', ')}${line.after}` })
  const status = live?.status ?? 'stopped'
  return (
    <div className={cx('assistant-status', line.tone)} data-tone={line.tone}>
      <AssistantMark status={status} unseen={live?.unseen} title={tr(M.statusTitle, { running: live ? 'yes' : 'no', status: live ? statusText(live) : '' })} />
      <Tooltip content={whole}>
        <span className="assistant-status-text">
          {Children.toArray(
            tRich<React.ReactNode>(M.status, {
              text: (
                <>
                  {line.text}
                  {line.cards.map((n) => {
                    const card = tasks.find((c) => c.number === n && !c.archived) ?? null
                    return <TaskChip key={n} number={n} column={card?.column ?? null} short label={tr(M.openCard, { number: n, known: card ? 'yes' : 'no', column: card ? columnLabel(card.column) : '' })} />
                  })}
                  {line.after}
                </>
              )
            })
          )}
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
  const revert = (x: AssistantAction): void => void runOnce(`revert:${x.id}`, () => actions.attempt(tr(M.revertFailed), () => call('assistant:revertSetting', x.id)))
  const row = (x: AssistantAction) => (
    <Tooltip block content={[formatDateTime(x.at), ...(x.error ? [tr(M.notDone, { error: x.error })] : []), ...(x.setting ? [`${x.setting.path}: ${x.setting.oldText} → ${x.setting.newText}`] : [])].join('\n')}>
      <div className={cx('assistant-action', !x.ok && 'failed')}>
        <Icon name={x.ok ? 'check' : 'circle-slash'} />
        <span className="assistant-action-text">{x.text}</span>
        {x.setting &&
          x.ok &&
          (reverted.has(x.id) ? (
            <span className="faint">{tr(M.reverted)}</span>
          ) : (
            <button
              className="btn small subtle assistant-revert"
              disabled={!!reverting[`revert:${x.id}`]}
              aria-label={tr(M.revertLabel, { setting: x.setting.path, value: x.setting.oldText })}
              onClick={(e) => {
                e.stopPropagation()
                revert(x)
              }}
            >
              <Icon name="discard" /> {tr(M.revert)}
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
        {tr(M.doneBy)}
        <span className="faint">({list.length})</span>
      </button>
      {!folded && <ShowAllList items={newest} few={3} keyOf={(x) => x.id} renderItem={row} label={tr(M.doneBy)} className="assistant-actions-list" />}
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
    tr(M.agentTip, { name: a.name, running: a.live ? 'yes' : 'no', status: a.live ? statusText(a.live) : '' }),
    ...doing.map((c) => tr(M.workingOn, { number: c.number, title: c.title })),
    ...reviewing.map((c) => tr(M.reviewing, { number: c.number, title: c.title })),
    ...(run ? [tr(M.progress, { run: runWords(run), hasStep: run.stepName ? 'yes' : 'no', step: run.stepName ?? '' })] : []),
    ...(a.worktree ? [tr(M.worktree, { branch: a.worktree.branch })] : [])
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
  const summary = p.agents.length === 0 ? tr(M.noAgents) : running ? tr(M.running, { count: running }) : tr(M.notRunning)
  const toggle = (): void => rememberProjectPref('assistantFold', key, folded ? null : true)
  return (
    <div className={cx('assistant-project', !p.active && 'inactive', folded && 'folded')} data-project={p.name}>
      <div className="assistant-project-head">
        <button type="button" className="assistant-project-fold" aria-expanded={!folded} aria-label={tr(M.foldLabel, { folded: folded ? 'yes' : 'no', project: p.name })} onClick={toggle}>
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
          {p.agents.length === 0 && <span className="faint">{tr(M.noAgents)}</span>}
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
        {tr(M.workspace)}
        <span className="faint">{tr(M.counts, { running, projects: projects.length })}</span>
      </div>
      {attention.map(({ i, p, a }) => (
        <div key={`${p.path}#${a.id}`} className="assistant-attention" onClick={() => go(p, a.id)}>
          <Icon name={i.kind === 'finished' ? 'check' : 'bell-dot'} />
          <span>
            <strong>{p.name}</strong>
            {p.agents.length > 1 ? ` · ${a.name}` : ''} {tr(M.attention, { kind: i.kind })}
            {i.message ? `: ${i.message}` : ''}
          </span>
        </div>
      ))}
      {projects.length === 0 && <div className="faint assistant-empty">{tr(M.noProjects)}</div>}
      {shown.map(row)}
      {folded.length > 0 && (
        <button type="button" className="assistant-fold" aria-expanded={showInactive} onClick={toggleInactive}>
          <Icon name={showInactive ? 'chevron-down' : 'chevron-right'} />
          {tr(M.inactive, { count: folded.length })}
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
    if (permission && permission !== agent.permissionMode && !(await confirmDangerousMode(provider, permission, tr(M.theAssistant)))) return
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
            title: tr(M.restartQuestion),
            message: tr(M.switching, { to: providerDescriptor(provider).name, from: providerDescriptor(current).name })
          }
        : null
    )
    // A new mode needs no restart: the running Assistant is told it (#259).
    if (ok && personaChanged && !providerChanged && agent.live) await actions.attempt(tr(M.tellFailed), () => call('assistant:switchMode', assistantPersona({ persona }, settings), false))
    if (ok) close()
  }
  return (
    <Modal
      title={tr(M.settingsName)}
      icon="settings"
      onClose={close}
      footer={
        <>
          <button className="btn subtle" onClick={close}>
            {tr(M.cancel)}
          </button>
          <button className="btn primary" onClick={() => void save()}>
            {tr(M.save)}
          </button>
        </>
      }
    >
      <p className="hint">
        {Children.toArray(
          tRich<React.ReactNode>(M.forWorkspace, {
            i: italic,
            link: settingsLink
          })
        )}
      </p>
      <div className="agent-form">
        <label>{tr(M.mode)}</label>
        <select className="select" value={persona} onChange={(e) => setPersona(e.target.value)}>
          <option value="">{tr(M.defaultMode, { name: (defaultPersona && personaName(defaultPersona)) ?? settings?.assistant.persona ?? 'Overseer' /* i18n-ignore: the default mode's name, as Hive ships it */ })}</option>
          {personas
            .filter((p) => p.bundled !== 'missing')
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.icon ? `${p.icon} ` : ''}
                {personaName(p)}
              </option>
            ))}
        </select>
      </div>
      <h3 className="agent-dialog-h">{tr(M.codingAgent)}</h3>
      <ProviderChoice value={provider} current={current} onChange={chooseProvider} />
      <h3 className="agent-dialog-h">{tr(M.settings)}</h3>
      <Overrides project={a} provider={provider} model={model} effort={effort} permission={permission} context={context} onModel={setModel} onEffort={setEffort} onPermission={setPermission} onContext={setContext} inherit={tr(M.default)} />
      {agent.live && <div className="detail">{tr(M.appliesNext)}</div>}
    </Modal>
  )
}
