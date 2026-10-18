import { existsSync } from 'original-fs'
import { join } from 'path'
import { ASSISTANT_AGENT_ID, ASSISTANT_DIR } from '../shared/assistant'
import { HIVE_DIR } from '../shared/defaults'
import { readKeptJson } from './fsutil'
import { journalSettings, inScope, type JournalSettings, type LinkType } from '../shared/journal'
import { closeJournal, deleteJournal, journalFile, journalFileBytes, journalSize, pruneJournal, writeEntry } from './journal'
import { createLogger } from './logger'
import type { WorkspaceService } from './workspace'

const log = createLogger('journal')
const HIVE = { kind: 'hive', name: 'Hive' } as const

/**
 * The journal as a workspace has it (#1031): its settings (workspace.json `journal`, Settings → Assistant → Journal),
 * Hive's own facts, and the Assistant told when the settings change while it may be running. The store is journal.ts.
 * Agent-facing words here stay English.
 */

/** A workspace's journal settings (defaults for what it hasn't set). */
export const journalSettingsOf = (ws: WorkspaceService): JournalSettings => journalSettings(ws.config.journal)

/** The settings, and the journal's size, for Settings. */
export function journalStatus(ws: WorkspaceService): { settings: JournalSettings; bytes: number; entries: number } {
  const settings = journalSettingsOf(ws)
  if (!ws.path) return { settings, bytes: 0, entries: 0 }
  const home = ws.assistantHome
  let entries = 0
  try {
    entries = journalSize(home)?.entries ?? 0
  } catch (e) {
    log.warn('reading the journal size', e)
  }
  return { settings, bytes: journalFileBytes(home), entries }
}

/** Changes the settings; the Assistant is told what changed (its tools follow a turn on or off at its next start). */
export async function setJournalSettings(ws: WorkspaceService, patch: Partial<JournalSettings>): Promise<JournalSettings> {
  const was = journalSettingsOf(ws)
  const next = journalSettings({ ...was, ...patch })
  await ws.saveWorkspaceConfigWith(() => ({ journal: next }))
  const said: string[] = []
  if (was.enabled !== next.enabled) said.push(next.enabled ? 'The journal is on again; its tools come with your next start (ask the user to restart you to use them now).' : 'The journal is off: nothing is written and its tools stop working (they leave at your next start). Its entries are kept.')
  if (next.enabled && was.scope.join() !== next.scope.join()) said.push(`The journal's scope changed: store only ${next.scope.length ? next.scope.join(', ') : 'digests'} entries from now on.`)
  if (said.length) await tellAssistant(ws, said.join(' '))
  // A tighter retention or cap applies now.
  if (next.enabled && (next.retentionDays < was.retentionDays || (next.capMB ?? Infinity) < (was.capMB ?? Infinity))) pruneNow(ws, next)
  return next
}

function pruneNow(ws: WorkspaceService, s: JournalSettings): void {
  try {
    if (existsSync(journalFile(ws.assistantHome))) pruneJournal(ws.assistantHome, s)
  } catch (e) {
    log.warn('pruning the journal after its settings changed', e)
  }
}

/** Tells the workspace's Assistant something (an inbox notice), if the workspace has one. */
async function tellAssistant(ws: WorkspaceService, body: string): Promise<void> {
  const home = ws.assistantHome
  if (!existsSync(join(home, '.hive', 'project.json'))) return
  // Loaded when used: sessions.ts reads the settings here, and deliveries.ts needs sessions loaded first.
  const { createDelivery } = await import('./deliveries')
  await createDelivery(home, { agentId: ASSISTANT_AGENT_ID, kind: 'control', from: HIVE, body }).catch((e) => log.warn('telling the Assistant its journal settings changed', e))
}

/** Deletes the workspace's journal (Settings: confirmed first); the Assistant is told. */
export async function deleteWorkspaceJournal(ws: WorkspaceService): Promise<void> {
  if (!ws.path) return
  await deleteJournal(ws.assistantHome)
  await tellAssistant(ws, 'The user deleted your journal: it starts again empty. Entries you recalled before are gone.')
}

/** Closes the workspace's journal (the workspace closes). */
export function closeWorkspaceJournal(ws: WorkspaceService): void {
  if (ws.path) closeJournal(ws.assistantHome)
}

/** A fact Hive records (#1031): an event, by Hive, small and linked. */
export interface Fact {
  summary: string
  project?: string | null
  importance?: number
  links?: { type: LinkType; ref: string }[]
  tags?: string[]
  detail?: string
}

/**
 * A fact for a workspace by its folder, open or not (an unexpected close is found before its workspace opens): its
 * settings read from its workspace.json.
 */
export async function journalFactAt(workspacePath: string, fact: Fact): Promise<void> {
  const saved = await readKeptJson<{ journal?: unknown }>(join(workspacePath, HIVE_DIR, 'workspace.json'), {})
  const s = journalSettings(saved.journal)
  if (!s.enabled || !inScope(s, 'event')) return
  try {
    writeEntry(join(workspacePath, HIVE_DIR, ASSISTANT_DIR), s, { kind: 'event', ...fact, tags: ['hive', ...(fact.tags ?? [])] }, 'hive')
  } catch (e) {
    log.warn('recording a fact in the journal', e)
  }
}

/**
 * Records a fact in the workspace's journal: only while it is on and its scope has events; never fails what it records
 * (a fact that can't be written is logged).
 */
export function journalFact(ws: WorkspaceService | null | undefined, fact: Fact): void {
  if (!ws?.path) return
  const s = journalSettingsOf(ws)
  if (!s.enabled || !inScope(s, 'event')) return
  try {
    writeEntry(ws.assistantHome, s, { kind: 'event', ...fact, tags: ['hive', ...(fact.tags ?? [])] }, 'hive')
  } catch (e) {
    log.warn('recording a fact in the journal', e)
  }
}
