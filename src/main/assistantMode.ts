import { ASSISTANT_AGENT_ID, modeMessage, modeSummary } from '../shared/assistant'
import type { LiveSessionState } from '../shared/types'
import { onHiveEvent } from './events'
import { createLogger, userText } from './logger'
import { readPersona } from './personas'
import { sessions } from './sessions'
import { workspace } from './workspace'

/**
 * Switching the Hive Assistant's mode (#259): the workspace keeps the choice (its next launch uses the mode's
 * instructions), and a running Assistant is told at once, without a restart: Hive types "[Hive] Mode: …" with the
 * mode's habits into its conversation, which keeps its context. Typed only while it is idle and the user isn't typing
 * there; otherwise when it next is (only the latest switch is told). Its session stopping drops the message: the next
 * launch starts in the mode anyway.
 */

const log = createLogger('assistant')
const AGENT = ASSISTANT_AGENT_ID

/** A mode message waiting to be typed into a running Assistant, by its home (the latest only), and the run it is for. */
const waiting = new Map<string, { home: string; runId: string; text: string; mode: string }>()

const idle = (st: LiveSessionState | null): boolean => !!st && (st.status === 'ready' || st.status === 'finished' || st.status === 'watching')

/**
 * Makes a mode (a persona file) this workspace's Assistant's. Returns whether a running Assistant was told now, will be
 * when it is idle, or wasn't running (the mode applies when it starts).
 */
export async function switchMode(personaId: string, save = true): Promise<'told' | 'later' | 'saved'> {
  const home = workspace.assistantHome
  const persona = await readPersona(personaId)
  if (!persona) throw new Error(`There is no mode "${personaId}" in this workspace.`)
  // save=false: the choice is already saved (Assistant Settings, which can also choose "the default").
  if (save) await workspace.updateAgent(home, AGENT, { persona: personaId })
  const live = sessions.liveFor(home, AGENT)
  if (!live) return 'saved'
  const key = home.toLowerCase()
  waiting.set(key, { home, runId: live.runId, text: modeMessage(persona.name, modeSummary(persona)), mode: persona.name })
  return (await tell(key)) ? 'told' : 'later'
}

/** Types a waiting mode message, if its Assistant is idle and the user isn't typing there; true once it is in. */
async function tell(key: string): Promise<boolean> {
  const w = waiting.get(key)
  if (!w) return false
  const live = sessions.liveFor(w.home, AGENT)
  // Stopped or restarted since: the launch it has (or will have) is in the mode already.
  if (!live || live.runId !== w.runId) {
    waiting.delete(key)
    return false
  }
  if (!idle(live) || sessions.userMayBeTyping(w.home, AGENT)) return false
  waiting.delete(key)
  try {
    await sessions.sendPrompt(w.home, AGENT, w.text, () => {
      if (!idle(sessions.liveFor(w.home, AGENT))) throw new Error('The Assistant got busy.')
      if (sessions.userMayBeTyping(w.home, AGENT)) throw new Error('The user is typing to the Assistant.')
    })
    log.info(`Told the Assistant its new mode, ${userText(w.mode)}`)
    return true
  } catch (e) {
    // Tried again at its next idle, unless a newer switch replaced it meanwhile.
    if (!waiting.has(key) && sessions.liveFor(w.home, AGENT)?.runId === w.runId) waiting.set(key, w)
    log.info(`The Assistant will be told its mode when it is free: ${(e as Error).message}`)
    return false
  }
}

let started = false

/** Tells waiting Assistants their mode when they are next idle (and when the user's typing pause ends). */
export function initAssistantModes(): void {
  if (started) return
  started = true
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
