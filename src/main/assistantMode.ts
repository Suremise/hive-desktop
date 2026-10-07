import { ASSISTANT_AGENT_ID, assistantPersona, modeMessage, modeSummary } from '../shared/assistant'
import { projectAgents } from '../shared/defaults'
import type { LiveSessionState } from '../shared/types'
import { config } from './config'
import { onHiveEvent } from './events'
import { createLogger, userText } from './logger'
import { readPersona } from './personas'
import { sessions } from './sessions'
import { inWorkspace, workspace, workspaceOf } from './workspace'

/**
 * Switching the Hive Assistant's mode (#259): the workspace keeps the choice (its next launch uses the mode's
 * instructions), and a running Assistant is told at once, without a restart: Hive types "[Hive] Mode: …" with the
 * mode's habits into its conversation, which keeps its context. Typed only while it is idle and the user isn't typing
 * there; otherwise when it next is (only the latest switch is told). Its session stopping drops the message.
 *
 * Each conversation records the mode it was last given (SessionRecord.persona: the one it started in, or the last one
 * it was told), and a resumed one in another mode, or with none recorded, is told that mode the same way, once (#334): a
 * stop with a message waiting, or a switch while it was stopped, reaches it when it is resumed. The CLI may also keep
 * the system prompt the conversation started with (Claude Code's adapter asks for the current one).
 */

const log = createLogger('assistant')
const AGENT = ASSISTANT_AGENT_ID

/**
 * A mode message waiting to be typed into a running Assistant, by its home (the latest only): the run it is for, and
 * the home's switch count when it was made (`rev`).
 */
const waiting = new Map<string, { home: string; runId: string; text: string; mode: string; persona: string; rev: number }>()

/**
 * How many switches each home has had (by key). A message, or a resume's check, made before the latest switch began is
 * stale: dropped after each wait and before it is typed, so an older mode never reaches the conversation after a newer
 * one, even one already typed (#334).
 */
const switches = new Map<string, number>()
const revision = (key: string): number => switches.get(key) ?? 0

const idle = (st: LiveSessionState | null): boolean => !!st && (st.status === 'ready' || st.status === 'finished' || st.status === 'watching')

/**
 * Makes a mode (a persona file) this workspace's Assistant's. Returns whether a running Assistant was told now, will be
 * when it is idle, or wasn't running (the mode applies when it starts); 'saved' too for a switch a newer one overtook
 * (the newer one is saved and told, and says so).
 */
export async function switchMode(personaId: string, save = true): Promise<'told' | 'later' | 'saved'> {
  const home = workspace.assistantHome
  const key = home.toLowerCase()
  // Switches count in the order they are made: the latest is the user's choice, however the reads and writes finish.
  const rev = revision(key) + 1
  switches.set(key, rev)
  const current = (): boolean => revision(key) === rev
  const persona = await readPersona(personaId)
  if (!persona) throw new Error(`There is no mode "${personaId}" in this workspace.`)
  if (!current()) return 'saved'
  // save=false: the choice is already saved (Assistant Settings, which can also choose "the default").
  if (save) {
    let overtaken = false
    await workspace.mutateProjectConfig(home, (cfg) => {
      // Checked inside the file's lock: a switch waiting for it never writes over a newer one's choice.
      if (!current()) {
        overtaken = true
        return {}
      }
      const agents = projectAgents(cfg)
      if (!agents.some((a) => a.id === AGENT)) throw new Error('The Assistant has no settings in this workspace.')
      return { agents: agents.map((a) => (a.id === AGENT ? { ...a, persona: personaId } : a)) }
    })
    if (overtaken) return 'saved'
  }
  const live = sessions.liveFor(home, AGENT)
  if (!live) return 'saved'
  if (!current()) return 'saved'
  waiting.set(key, { home, runId: live.runId, text: modeMessage(persona.name, modeSummary(persona)), mode: persona.name, persona: persona.id, rev })
  return (await tell(key)) ? 'told' : 'later'
}

/** A conversation resumed in the mode `personaId`: told it once it is idle, unless that is the mode it was last given. */
async function resumed(home: string, runId: string, sessionId: string, personaId: string): Promise<void> {
  const key = home.toLowerCase()
  const rev = revision(key)
  const ws = workspaceOf(home)
  const record = (await ws.sessionsFile(home)).sessions.find((s) => s.id === sessionId)
  if (record?.persona === personaId) return
  // The mode chosen now: one chosen since its launch read it is told by that switch.
  const agent = (await ws.projectConfig(home)).agents?.find((a) => a.id === AGENT)
  const persona = await inWorkspace(ws, () => readPersona(personaId))
  // Stopped meanwhile, or a switch since (the newer message): nothing to add.
  if (!persona || !agent || assistantPersona(agent, config.settings) !== personaId || revision(key) !== rev) return
  if (sessions.liveFor(home, AGENT)?.runId !== runId || waiting.get(key)?.runId === runId) return
  waiting.set(key, { home, runId, text: modeMessage(persona.name, modeSummary(persona)), mode: persona.name, persona: persona.id, rev })
  log.info(`The resumed Assistant was last given ${record?.persona ? userText(record.persona) : 'no recorded mode'}: it will be told ${userText(persona.name)}`)
  await tell(key)
}

/** Types a waiting mode message, if its Assistant is idle and the user isn't typing there; true once it is in. */
async function tell(key: string): Promise<boolean> {
  const w = waiting.get(key)
  if (!w) return false
  const live = sessions.liveFor(w.home, AGENT)
  // Stopped or restarted since (the launch it has, or will have, is in the mode already), or a newer switch began.
  if (!live || live.runId !== w.runId || w.rev !== revision(key)) {
    if (waiting.get(key) === w) waiting.delete(key)
    return false
  }
  if (!idle(live) || sessions.userMayBeTyping(w.home, AGENT)) return false
  waiting.delete(key)
  try {
    await sessions.sendPrompt(w.home, AGENT, w.text, () => {
      if (w.rev !== revision(key)) throw new Error('A newer mode was chosen.')
      if (!idle(sessions.liveFor(w.home, AGENT))) throw new Error('The Assistant got busy.')
      if (sessions.userMayBeTyping(w.home, AGENT)) throw new Error('The user is typing to the Assistant.')
    }, { confirm: true })
    log.info(`Told the Assistant its new mode, ${userText(w.mode)}`)
    await sessions.modeGiven(w.home, AGENT, w.runId, w.persona).catch((e) => log.warn('Could not record the mode the Assistant was told', e))
    return true
  } catch (e) {
    // Tried again at its next idle, unless a newer switch replaced it meanwhile.
    if (!waiting.has(key) && w.rev === revision(key) && sessions.liveFor(w.home, AGENT)?.runId === w.runId) waiting.set(key, w)
    log.info(`The Assistant will be told its mode when it is free: ${(e as Error).message}`)
    return false
  }
}

let started = false

/** Tells waiting Assistants their mode when they are next idle (and when the user's typing pause ends). */
export function initAssistantModes(): void {
  if (started) return
  started = true
  sessions.onAssistantResumed = (home, runId, sessionId, persona) => {
    resumed(home, runId, sessionId, persona).catch((e) => log.warn('Could not check the mode of the resumed Assistant', e))
  }
  onHiveEvent((e) => {
    if (e.type !== 'session-status' || e.state.agentId !== AGENT || !idle(e.state)) return
    const key = e.state.projectPath.toLowerCase()
    if (waiting.has(key)) setTimeout(() => void tell(key), 500)
  })
  const timer = setInterval(() => {
    for (const key of [...waiting.keys()]) void tell(key)
  }, 5000)
  timer.unref?.()
}
