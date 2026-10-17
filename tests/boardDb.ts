// The board's cards as tests read and change them by hand (#1017): in the workspace's database, as Hive keeps them now.
import { DatabaseSync } from 'node:sqlite'
import { boardChanged, boardFile, boardWrite, cardDoc, deleteCard, putCard } from '../src/main/boardStore'
import type { WorkspaceService } from '../src/main/workspace'

/** A card's document as saved (what its file held before 0.9); throws when there is no such card. */
export function readCard(ws: WorkspaceService, n: number): Record<string, unknown> {
  const doc = cardDoc(ws, n)
  if (!doc) throw new Error(`no card #${n}`)
  return doc
}

/** Saves a card's document as it is given, as an edit by hand or another program would: the board is told. */
export function writeCard(ws: WorkspaceService, n: number, doc: Record<string, unknown>): Promise<void> {
  return boardWrite(ws, async () => {
    putCard(ws, n, doc)
    boardChanged(ws)
  })
}

/** Changes a card's saved document. */
export async function editCard(ws: WorkspaceService, n: number, edit: (doc: Record<string, unknown>) => Record<string, unknown> | void): Promise<void> {
  const doc = readCard(ws, n)
  await writeCard(ws, n, edit(doc) ?? doc)
}

/** Removes a card as a program outside Hive would (no reference to it dropped). */
export function removeCard(ws: WorkspaceService, n: number): Promise<void> {
  return boardWrite(ws, async () => {
    deleteCard(ws, n)
    boardChanged(ws)
  })
}

/**
 * Saves a card's document from outside this Hive (another copy of Hive, a script): its own connection to the board's file,
 * past the board's lock in this process (a test holding it to make a change wait).
 */
export function writeCardOutside(workspacePath: string, n: number, doc: Record<string, unknown>): void {
  const db = new DatabaseSync(boardFile(workspacePath), { timeout: 5000 })
  try {
    db.prepare('INSERT INTO cards (number, doc) VALUES (?, ?) ON CONFLICT(number) DO UPDATE SET doc = excluded.doc').run(n, JSON.stringify(doc))
  } finally {
    db.close()
  }
}

/** The key of the board's lock in this process (a test holds it to make a change wait). */
export const boardLockKey = (workspacePath: string): string => `board-lock:${workspacePath}`

/** A card's document read from the board's file on its own connection (any workspace, open in this Hive or not). */
export function readCardIn(workspacePath: string, n: number): Record<string, unknown> {
  const db = new DatabaseSync(boardFile(workspacePath), { readOnly: true, timeout: 5000 })
  try {
    const row = db.prepare('SELECT doc FROM cards WHERE number = ?').get(n) as { doc: string } | undefined
    if (!row) throw new Error(`no card #${n}`)
    return JSON.parse(row.doc) as Record<string, unknown>
  } finally {
    db.close()
  }
}
