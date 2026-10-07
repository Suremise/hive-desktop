import type { ArchiveResult } from '@shared/types'
import { call, errorMessage } from './api'
import { loadTasks, notify, pushToast } from './store'

const cardsWord = (n: number): string => `${n} card${n === 1 ? '' : 's'}`
const numbers = (ns: number[]): string => (ns.length > 6 ? `${ns.slice(0, 6).map((n) => `#${n}`).join(', ')} and ${ns.length - 6} more` : ns.map((n) => `#${n}`).join(', '))

/**
 * Tells the user what an Archive All did (#351): Archived n cards with Undo, and the cards it left on the board after all
 * (an agent took one meanwhile, one moved), with why.
 */
export function reportArchived(r: ArchiveResult): void {
  const left = r.skipped.length
    ? `${r.skipped.length === 1 ? 'One card was' : `${r.skipped.length} cards were`} left on the board: ${r.skipped
        .slice(0, 4)
        .map((s) => `#${s.number} ${s.why}`)
        .join('; ')}${r.skipped.length > 4 ? '; …' : ''}.`
    : undefined
  if (!r.batch) return notify('warning', 'Nothing was archived', left)
  pushToast({
    id: `archived-${r.batch.id}`,
    level: 'success',
    title: `Archived ${cardsWord(r.archived.length)}`,
    message: left,
    actions: [{ label: 'Undo', command: 'task.undoArchive', args: [r.batch.id] }],
    timestamp: new Date().toISOString(),
    timeoutMs: 10_000
  })
}

/**
 * Brings a batch back (Undo, "Unarchive this batch") and says how it went: cards that couldn't come back stay archived
 * with the batch, which is kept so another try brings them. Returns whether every card came back.
 */
export async function unarchiveBatch(id: string): Promise<boolean> {
  try {
    const { restored, failed } = await call('tasks:unarchiveBatch', id)
    await loadTasks()
    if (failed.length) {
      notify(
        'error',
        restored.length ? `Brought back ${cardsWord(restored.length)}; ${numbers(failed)} couldn't be` : `Couldn't bring back ${numbers(failed)}`,
        "They stay archived with their batch: Unarchive this batch in Archived tries again (a card's file may be open in another program)."
      )
      return false
    }
    notify('success', `Brought back ${cardsWord(restored.length)}`)
    return true
  } catch (e) {
    notify('error', 'Could not bring the batch back', errorMessage(e))
    return false
  }
}
