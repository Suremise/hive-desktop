import { app } from 'electron'
import { join } from 'path'
import { readFile } from 'original-fs/promises'
import type { MergeSlotInfo } from '../shared/types'
import { emit, toast } from './events'
import { hashText, withFileLock, writeTextAtomic } from './fsutil'
import { createLogger, userText } from './logger'
import { MergeSlots, parseSlotRecords, type SlotRecord } from './mergeSlots'
import { progress } from './progressService'
import { sessions } from './sessions'
import { workspace, workspaceOf } from './workspace'

const log = createLogger('mergeSlots')

/**
 * The app's merge slots (#350), wired to sessions (a launch's end releases its hold; status notes), Progress (a holder
 * still reporting keeps its hold), the windows (`merge-slots-changed`) and a small record per workspace in the app's
 * data (this machine's state, never the workspace's committed `.hive`), so a hold Hive closed under is reported when
 * the workspace opens again.
 */
export const mergeSlots = new MergeSlots({
  now: () => Date.now(),
  running: (a) => sessions.liveFor(a.projectPath, a.agentId)?.runId === a.runId,
  progressAt: (a) => progress.openRunOf(a.projectPath, a.agentId)?.updatedAt ?? null,
  changed: (projectPath) => changed(projectPath),
  note: (a, text) => sessions.setMergeSlotNote(a.projectPath, a.agentId, a.runId, text),
  warn: (projectPath, title, message) => toast('warning', title, message, undefined, projectPath),
  // Test builds can shorten a hold, to see one run out (HIVE_TEST_MERGE_HOLD_MS; never in an installed Hive).
  ...(!app.isPackaged && Number(process.env.HIVE_TEST_MERGE_HOLD_MS) > 0 ? { holdMs: Number(process.env.HIVE_TEST_MERGE_HOLD_MS) } : {})
})

/** A workspace's record of its agents' holds. */
const recordFile = (workspacePath: string): string => join(app.getPath('userData'), 'merge-slots', `${hashText(workspacePath.toLowerCase())}.json`)

/** A workspace's slots (each of its projects'), for its window and the Agent API. */
export function workspaceSlots(workspacePath: string): MergeSlotInfo[] {
  return mergeSlots.list(workspacePath)
}

/** The workspace a project belongs to, or null when none open has it. */
function workspacePathOf(projectPath: string): string | null {
  try {
    return workspaceOf(projectPath).path
  } catch {
    return null
  }
}

function changed(projectPath: string): void {
  const ws = workspacePathOf(projectPath)
  if (!ws) return
  emit({ type: 'merge-slots-changed', workspacePath: ws, slots: workspaceSlots(ws) })
  void save(ws).catch((e) => log.warn('saving the merge slots', e))
}

/** The record of this workspace's agents' holds, rewritten whole under its lock as it changes. */
async function save(workspacePath: string): Promise<void> {
  const file = recordFile(workspacePath)
  await withFileLock(file, async () => {
    const holds: SlotRecord[] = mergeSlots.heldByAgents().filter((h) => workspacePathOf(h.projectPath)?.toLowerCase() === workspacePath.toLowerCase())
    await writeTextAtomic(file, JSON.stringify({ version: 1, holds }, null, 2) + '\n')
  })
}

/**
 * A workspace opened: holds its record has that Hive no longer has (it closed or crashed while an agent held the slot)
 * are told to the user, since that merge may be half done, and dropped from the record.
 */
export async function recoverMergeSlots(workspacePath: string): Promise<void> {
  const file = recordFile(workspacePath)
  const gone = await withFileLock(file, async () => {
    const raw = await readFile(file, 'utf8').catch(() => null)
    if (raw === null) return []
    const live = new Set(mergeSlots.heldByAgents().map((h) => `${h.projectPath.toLowerCase()}#${h.branch}#${h.runId}`))
    const orphans = parseSlotRecords(raw).filter((h) => !live.has(`${h.projectPath.toLowerCase()}#${h.branch}#${h.runId}`))
    const holds = mergeSlots.heldByAgents().filter((h) => workspacePathOf(h.projectPath)?.toLowerCase() === workspacePath.toLowerCase())
    await writeTextAtomic(file, JSON.stringify({ version: 1, holds }, null, 2) + '\n')
    return orphans
  })
  for (const h of gone) {
    log.info(`Merge slot: Hive closed while ${userText(h.agentName)} held it for ${userText(h.branch)}`)
    toast('warning', `${h.agentName} was merging when Hive closed`, `It held the merge slot for ${h.branch}${h.cards.length ? ` (${h.cards.map((n) => `#${n}`).join(', ')})` : ''}. Check the project's main checkout for a merge left half done (git status there) before the next merge.`, undefined, h.projectPath)
  }
}

let started = false

/** Releases holds with their launches. Once, at startup (a workspace's record is recovered as it opens: ipc.ts). */
export function startMergeSlots(): void {
  if (started) return
  started = true
  sessions.onLaunchEnded.add((projectPath, agentId, runId) => mergeSlots.sessionEnded(projectPath, agentId, runId))
}

/** The branch a project folder is on: what Hive's Merge dialog merges into, and the slot a claim names by default. */
export async function currentBranch(projectPath: string): Promise<string | null> {
  return workspace.branch(projectPath)
}
