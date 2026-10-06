import { randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { app } from 'electron'
import { dirname, join } from 'path'
import { mkdir } from 'original-fs/promises'
import { ASSISTANT_DIR } from '../shared/assistant'
import { controlAllows } from '../shared/assistantTools'
import { HIVE_DIR } from '../shared/defaults'
import type { AssistantAction, AssistantControl, AssistantQuestion, AssistantSettingChange } from '../shared/types'
import { config } from './config'
import { emit } from './events'
import { hashText, writeJsonAtomic } from './fsutil'
import { createLogger, userText } from './logger'

/**
 * What the Hive Assistant may do through the Agent API, and what it did. Each workspace's Assistant gets its own
 * token for each launch (in a file its hive MCP server reads), so the API knows a call is the Assistant's and
 * applies Settings → Assistant → Control instead of Settings → Agent API, scoped to its workspace.
 */

const log = createLogger('assistant')

/** Changes the Assistant may make for one message from the user; then it must ask the user to go on. */
export const MAX_ACTIONS_PER_TURN = 30
const MAX_LISTED = 200

interface Pending {
  question: AssistantQuestion
  resolve: (yes: boolean) => void
  timer: NodeJS.Timeout
}

interface WorkspaceState {
  token: string
  actions: AssistantAction[]
  turnActions: number
  pending: Map<string, Pending>
}

const states = new Map<string, WorkspaceState>()

function stateOf(workspacePath: string): WorkspaceState {
  const k = workspacePath.toLowerCase()
  let s = states.get(k)
  if (!s) states.set(k, (s = { token: '', actions: [], turnActions: 0, pending: new Map() }))
  return s
}

/** The Assistant's home in a workspace (events about it go to the window showing that workspace). */
export function assistantHome(workspacePath: string): string {
  return join(workspacePath, HIVE_DIR, ASSISTANT_DIR)
}

/** Where a workspace's Assistant finds its token: one file per workspace, so its launch settings don't change. */
export function assistantTokenFile(workspacePath: string): string {
  return join(app.getPath('userData'), 'assistant-api', `${hashText(workspacePath.toLowerCase())}.json`)
}

/** A new token for the Assistant's next launch in this workspace; the previous one stops working. */
export async function newAssistantToken(workspacePath: string): Promise<void> {
  const s = stateOf(workspacePath)
  s.token = randomBytes(32).toString('hex')
  const file = assistantTokenFile(workspacePath)
  await mkdir(dirname(file), { recursive: true })
  await writeJsonAtomic(file, { token: s.token, note: "The Hive Assistant's Agent API token for one workspace. Hive replaces it each time the Assistant starts." })
}

/** Whether a token is the workspace's Assistant's current one: its running session's, not one from before a restart. */
export function isCurrentToken(workspacePath: string, token: string): boolean {
  const now = stateOf(workspacePath).token
  const got = Buffer.from(token)
  const want = Buffer.from(now)
  return !!now && got.length === want.length && timingSafeEqual(got, want)
}

/** The Assistant stopped: its token stops working, and anything it was asking the user is answered no. */
export function endAssistant(workspacePath: string): void {
  const s = stateOf(workspacePath)
  s.token = ''
  for (const p of [...s.pending.values()]) p.resolve(false)
}

/** The workspace whose Assistant a token belongs to, or null. */
export function assistantForToken(token: string): string | null {
  const got = Buffer.from(token)
  for (const [k, s] of states) {
    const want = Buffer.from(s.token)
    if (s.token && got.length === want.length && timingSafeEqual(got, want)) return k
  }
  return null
}

export function controlLevel(): AssistantControl {
  return config.settings.assistant?.control ?? 'projects'
}

export function allows(need: AssistantControl): boolean {
  return controlAllows(controlLevel(), need)
}

/**
 * Records something the Assistant did (or was refused), in its panel's list and hive.log; with `more`, the setting it
 * changed (for Revert) or the change the user reverted.
 */
export function record(workspacePath: string, text: string, error?: string, more: { setting?: AssistantSettingChange; revertOf?: string } = {}): AssistantAction {
  const s = stateOf(workspacePath)
  const action: AssistantAction = { id: randomUUID(), at: new Date().toISOString(), text, ok: !error, ...(error ? { error } : {}), ...more }
  s.actions.push(action)
  if (s.actions.length > MAX_LISTED) s.actions.splice(0, s.actions.length - MAX_LISTED)
  log.info(`${userText(workspacePath)}: ${userText(text)}${error ? ` (refused: ${userText(error)})` : ''}`)
  emit({ type: 'assistant-activity', projectPath: assistantHome(workspacePath), action })
  return action
}

export function actions(workspacePath: string): AssistantAction[] {
  return stateOf(workspacePath).actions
}

/** Counts a change against this turn's limit; false once the limit is reached. */
export function countAction(workspacePath: string): boolean {
  const s = stateOf(workspacePath)
  if (s.turnActions >= MAX_ACTIONS_PER_TURN) return false
  s.turnActions++
  return true
}

/** The user sent the Assistant a message: a new turn, with a fresh limit. */
export function newTurn(workspacePath: string): void {
  stateOf(workspacePath).turnActions = 0
}

function emitQuestions(workspacePath: string): void {
  emit({ type: 'assistant-questions', projectPath: assistantHome(workspacePath), questions: questions(workspacePath) })
}

export function questions(workspacePath: string): AssistantQuestion[] {
  return [...stateOf(workspacePath).pending.values()].map((p) => p.question)
}

/** Asks the user in the Assistant's panel; resolves with their answer, or false after `timeoutMs`. */
export function ask(workspacePath: string, q: Omit<AssistantQuestion, 'id'>, timeoutMs = 10 * 60_000): Promise<boolean> {
  const s = stateOf(workspacePath)
  const id = randomUUID()
  return new Promise((resolve) => {
    const done = (yes: boolean): void => {
      const p = s.pending.get(id)
      if (!p) return
      clearTimeout(p.timer)
      s.pending.delete(id)
      emitQuestions(workspacePath)
      resolve(yes)
    }
    s.pending.set(id, { question: { ...q, id }, resolve: done, timer: setTimeout(() => done(false), timeoutMs) })
    emitQuestions(workspacePath)
  })
}

/** The user's answer to a question in the panel. */
export function answer(id: string, yes: boolean): void {
  for (const s of states.values()) s.pending.get(id)?.resolve(yes)
}
