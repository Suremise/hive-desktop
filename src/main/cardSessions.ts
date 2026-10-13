// Which board cards a session worked on: each card in Doing for an agent is added to its running session's record
// (sessions.json `cards`, in order, with the title it had then), so the Sessions tab can say "Worked on #5 …"; and each
// card it reviews (TaskCard.review), marked as reviewed, for "Reviewed #5 …".
import { basename } from 'path'
import { agentDoingCards, agentReviewCards } from '../shared/tasks'
import type { LiveSessionState } from '../shared/types'
import { createLogger } from './logger'
import { allTasks, commentAsHive } from './tasks'
import { workspaceFor, type WorkspaceService } from './workspace'

const log = createLogger('cards')

/**
 * Adds the agent's Doing cards, and those it reviews, to its session's record (only one Hive has recorded). `still`, asked
 * under the file's lock as the record is written: whether that session is still the agent's (a launch's own, #650).
 */
export async function recordCards(ws: WorkspaceService, projectPath: string, agentId: string, sessionId: string, still?: () => boolean): Promise<void> {
  if (ws.isAssistantHome(projectPath)) return
  const all = await allTasks(ws)
  const project = basename(projectPath)
  const cards = [
    ...agentDoingCards(all, project, agentId).map((c) => ({ number: c.number, title: c.title })),
    ...agentReviewCards(all, project, agentId).map((c) => ({ number: c.number, title: c.title, review: true as const }))
  ]
  if (!cards.length) return
  // Worked on and reviewed are kept apart: an agent can review a card it once worked on.
  const has = (list: { number: number; review?: true }[] | undefined, c: { number: number; review?: true }): boolean => !!list?.some((h) => h.number === c.number && !!h.review === !!c.review)
  // Most board changes add nothing (a comment, another agent's card): check before taking the file's lock.
  const now = (await ws.sessionsFile(projectPath)).sessions.find((s) => s.id === sessionId)
  if (!now || cards.every((c) => has(now.cards, c))) return
  await ws.mutateSessions(projectPath, (f) => {
    const rec = f.sessions.find((s) => s.id === sessionId)
    if (!rec || (still && !still())) return
    const had = rec.cards ?? []
    const add = cards.filter((c) => !has(had, c))
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

/** A comment from Hive on each card an agent of a project has in Doing (#606: its model changed after a safeguard stop). */
export async function commentOnDoingCards(ws: WorkspaceService, projectPath: string, agentId: string, said: string): Promise<number[]> {
  if (ws.isAssistantHome(projectPath)) return []
  const project = basename(projectPath)
  const out: number[] = []
  // Each checked again under its lock: moved, reassigned or taken to another project meanwhile, it isn't the agent's now.
  for (const c of agentDoingCards(await allTasks(ws), project, agentId)) if (await commentAsHive(c.number, said, ws, (card) => agentDoingCards([card], project, agentId).length === 1)) out.push(c.number)
  return out
}
