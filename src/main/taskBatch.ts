// A batch card change (hive_update_tasks, #417): the request, checked, and the Hive Assistant's turn for it. The Agent
// API's route turns a refusal into its status; the rules live here, so the tests reach them without the API.
import { COLUMN_CHOICES, isTaskColumn } from '../shared/tasks'
import * as assistant from './assistantControl'
import { ChangeRefused } from './assistantControl'
import * as tasks from './tasks'

/**
 * The fields a batch takes besides its card numbers and reply. A title, comment, decision or link is one card's: a batch
 * never archives, edits a decision or deletes (those stay the user's, on one card).
 */
const BATCH_FIELDS = ['numbers', 'column', 'position', 'blocked', 'labels', 'agent', 'reply']

/** The card numbers and the fields of a batch request, checked before anything changes or is counted. */
export function batchRequest(body: any): { numbers: number[]; patch: tasks.BatchPatch } {
  const other = Object.keys(body ?? {}).filter((k) => !BATCH_FIELDS.includes(k))
  if (other.length) throw new ChangeRefused(400, `A batch sets column, position, blocked, labels or agent on its cards: ${other.join(', ')} goes on one card (hive_update_task).`)
  const numbers = tasks.batchNumbers(body?.numbers)
  const patch: tasks.BatchPatch = {}
  if (body.column !== undefined) {
    if (!isTaskColumn(body.column)) throw new ChangeRefused(400, `Unknown column "${String(body.column)}": ${COLUMN_CHOICES}.`)
    patch.column = body.column
  }
  if (body.position !== undefined && body.position !== null && body.position !== '') {
    if (body.position !== 'top' && body.position !== 'bottom') throw new ChangeRefused(400, `Unknown position "${String(body.position)}": top or bottom.`)
    patch.position = body.position
  }
  if (body.blocked !== undefined) {
    if (body.blocked !== null && typeof body.blocked !== 'string') throw new ChangeRefused(400, 'blocked is the reason as text, or empty to clear it.')
    patch.blocked = body.blocked
  }
  if (body.labels !== undefined) {
    if (!Array.isArray(body.labels) || !body.labels.every((x: unknown) => typeof x === 'string')) throw new ChangeRefused(400, 'labels is a list of text.')
    patch.labels = body.labels
  }
  if (body.agent !== undefined) patch.agent = body.agent ? String(body.agent) : null
  if (!Object.keys(patch).length) throw new ChangeRefused(400, 'Give what to change on the cards: column, position, blocked, labels or agent.')
  return { numbers, patch }
}

const clip = (s: string, max: number): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/**
 * A batch the Assistant asks for, through the Assistant's change boundary (assistantControl's admit, which assistantChange
 * uses for a single change too): its control level is checked and every card counts against this message's limit before
 * any card changes, all of them or none. Each card is then written only if the guard still passes after its last read,
 * under its own lock: the control level and the session that asked must still allow it (the user may have turned the
 * level down, or the Assistant been restarted, while the batch waited for a card). A card refused for any reason is left
 * as it was, and every card, changed or refused, is recorded in the activity list on its own. A counted card stays counted
 * when refused, as a refused single change does. Returns each card's outcome, in the order given.
 */
export async function assistantBatch(ws: string, token: string, numbers: number[], patch: tasks.BatchPatch, actor: tasks.TaskActor): Promise<tasks.BatchItem[]> {
  const guard = assistant.admit(ws, token, 'agents', `change ${numbers.length} card${numbers.length === 1 ? '' : 's'} on the board`, numbers.length)
  const items = await tasks.updateTasks(numbers, patch, actor, { commit: guard })
  for (const i of items) {
    if (i.card) assistant.record(ws, `#${i.number} ${clip(i.card.title, 60)}: ${i.said.join(', ') || 'no change'}`)
    else assistant.record(ws, `#${i.number}: change`, i.error ?? 'refused')
  }
  return items
}
