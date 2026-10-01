// Which board cards a session worked on: each card in Doing for an agent is added to its running session's record
// (sessions.json `cards`, in order, with the title it had then), so the Sessions tab can say "Worked on #5 …".
import { basename } from 'path'
import { agentDoingCards } from '../shared/tasks'
import type { LiveSessionState } from '../shared/types'
import { createLogger } from './logger'
import { allTasks } from './tasks'
import { workspaceFor, type WorkspaceService } from './workspace'

const log = createLogger('cards')

/** Adds the agent's Doing cards to its session's record (only an existing record: one Hive has recorded). */
export async function recordCards(ws: WorkspaceService, projectPath: string, agentId: string, sessionId: string): Promise<void> {
  if (ws.isAssistantHome(projectPath)) return
  const doing = agentDoingCards(await allTasks(ws), basename(projectPath), agentId)
  if (!doing.length) return
  // Most board changes add nothing (a comment, another agent's card): check before taking the file's lock.
  const now = (await ws.sessionsFile(projectPath)).sessions.find((s) => s.id === sessionId)
  if (!now || doing.every((c) => now.cards?.some((h) => h.number === c.number))) return
  await ws.mutateSessions(projectPath, (f) => {
    const rec = f.sessions.find((s) => s.id === sessionId)
    if (!rec) return
    const had = rec.cards ?? []
    const add = doing.filter((c) => !had.some((h) => h.number === c.number)).map((c) => ({ number: c.number, title: c.title }))
    if (add.length) rec.cards = [...had, ...add]
  })
}

/** After the board changed: records the Doing cards of every running agent in that workspace. */
export async function recordLiveCards(workspacePath: string, live: LiveSessionState[]): Promise<void> {
  const ws = workspaceFor(workspacePath)
  if (!ws?.path) return
  for (const s of live) {
    if (!s.sessionId || s.settingUp || workspaceFor(s.projectPath) !== ws) continue
    await recordCards(ws, s.projectPath, s.agentId, s.sessionId).catch((e) => log.warn(`Could not record the cards of session ${s.sessionId}`, e))
  }
}
