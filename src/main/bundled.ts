import { existsSync } from 'original-fs'
import { lstat, readdir } from 'original-fs/promises'
import { join } from 'path'
import { cleanSwaps, contentHash, readJson, SwapAbandoned, swapIn, swapOut, withFileLock, writeJsonAtomic } from './fsutil'
import { createLogger, userText } from './logger'
import { resourcesDir } from './paths'
import { revisionOf } from './revisions'
import { workspace } from './workspace'
import HISTORY from './bundledHistory.json'
import { RETIRED_PERSONAS, projectAgents } from '../shared/defaults'
import { ASSISTANT_AGENT_ID } from '../shared/assistant'
import { toast } from './events'

/**
 * Keeps a workspace's copies of Hive's bundled skills and personas up to date, without overriding the user:
 * - a bundled item the workspace was never given is added (a new workspace, or one Hive added since);
 * - a copy the user never changed (a version Hive shipped, older than this one) is updated in place;
 * - a copy the user changed is kept as it is (the Skills and Personas views offer Revert, and say when the copy
 *   came from an older version);
 * - an item the user deleted stays deleted (the views offer Restore).
 * `.hive/bundled.json` records which items the workspace has been given and the version each copy came from.
 * bundledHistory.json lists every version Hive has shipped of each (scripts/bundled-history.mjs), oldest first.
 */

const log = createLogger('bundled')

export type BundledKind = 'skills' | 'personas'

/** What `.hive/bundled.json` holds: per item, the shipped version its copy was made from (null: not Hive's copy). */
interface Manifest {
  skills: Record<string, { from: string | null }>
  personas: Record<string, { from: string | null }>
}

/** Items that shipped before Hive kept a manifest: missing from a workspace without one, they were deleted by the user. */
const BEFORE_MANIFEST: Record<BundledKind, string[]> = {
  skills: ['handover', 'merge-ready', 'pick-up', 'review-agent-work', 'split-work', 'workspace-note'],
  personas: ['orchestrator', 'overseer', 'planner', 'reviewer']
}

const history = HISTORY as Record<BundledKind, Record<string, string[]>>

export function bundledDir(kind: BundledKind): string {
  return join(resourcesDir(), kind)
}

/** A bundled item's path: a skill's folder, a persona's file. */
const itemPath = (dir: string, kind: BundledKind, id: string): string => join(dir, kind === 'skills' ? id : `${id}.md`)

/** The items this version of Hive ships. */
export async function bundledIds(kind: BundledKind): Promise<string[]> {
  try {
    const entries = await readdir(bundledDir(kind), { withFileTypes: true })
    return kind === 'skills'
      ? entries.filter((e) => e.isDirectory() && existsSync(join(bundledDir(kind), e.name, 'SKILL.md'))).map((e) => e.name)
      : entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name.slice(0, -3))
  } catch {
    return []
  }
}

/** What to do with one bundled item in a workspace (pure: the rules above). */
export interface BundledInput {
  /** This version's hash. */
  shipped: string
  /** The workspace copy's hash, or null when it has none. */
  copy: string | null
  /** The manifest's entry: undefined when the workspace was never given it (or has no manifest yet). */
  given: { from: string | null } | undefined
  /** Whether the workspace has a manifest (one from before keeps none). */
  manifest: boolean
  /** Every shipped version, oldest first (this one included). */
  versions: string[]
  /** Whether it shipped before the manifest existed. */
  shippedBefore: boolean
  /** Whether the folder that holds these exists (a workspace from before personas has no personas folder). */
  folder: boolean
}

export type BundledAction = 'add' | 'update' | 'keep' | 'deleted'

export function bundledAction(i: BundledInput): BundledAction {
  if (i.copy === null) {
    if (i.given) return 'deleted'
    // Without a manifest, an item that shipped before was given to the workspace, so it was deleted; unless the
    // workspace never had the folder.
    if (!i.manifest && i.shippedBefore && i.folder) return 'deleted'
    return 'add'
  }
  if (i.copy === i.shipped) return 'keep'
  // Untouched: a version Hive shipped before this one (a copy of a newer one, from another Hive, is left alone).
  const was = i.versions.lastIndexOf(i.copy)
  return was >= 0 && was < i.versions.lastIndexOf(i.shipped) ? 'update' : 'keep'
}

/** How a workspace copy compares with what this Hive ships, for the Skills and Personas views. */
export interface BundledStatus {
  bundled: 'same' | 'changed'
  /** A changed copy made from an older version than this one: Revert also brings in the newer version. */
  updateAvailable?: true
}

const manifestPath = (): string => join(workspace.hiveDir, 'bundled.json')

async function readManifest(): Promise<Manifest | null> {
  const m = await readJson<Partial<Manifest> | null>(manifestPath(), null)
  if (!m || typeof m !== 'object') return null
  const part = (v: unknown): Manifest['skills'] => (v && typeof v === 'object' ? (v as Manifest['skills']) : {})
  return { skills: part(m.skills), personas: part(m.personas) }
}

/** Changes the manifest under its lock (another window's sync or a Restore may be writing it). */
function changeManifest(fn: (m: Manifest) => void): Promise<void> {
  const path = manifestPath()
  return withFileLock(path, async () => {
    const m = (await readManifest()) ?? { skills: {}, personas: {} }
    fn(m)
    await writeJsonAtomic(path, m)
  })
}

const folderOf = (kind: BundledKind): string => (kind === 'skills' ? workspace.skillsDir : workspace.personasDir)

/**
 * Puts this Hive's version of an item in the workspace (swapIn: a skill's folder or a persona's file, all at once). An
 * automatic update or add passes what the copy was when it was decided (its contentHash, or null: none): if the user
 * changed, deleted or replaced it since, SwapAbandoned, and theirs stays. Restore and Revert, which the user asked for,
 * pass nothing.
 */
async function install(kind: BundledKind, id: string, expected?: string | null): Promise<void> {
  await swapIn(itemPath(bundledDir(kind), kind, id), itemPath(folderOf(kind), kind, id), { expected })
}

/** A swap's leftover old copy is disposable when it is a version Hive shipped of that item (nothing of the user's). */
function shippedVersion(kind: BundledKind): (old: string, name: string) => Promise<boolean> {
  return async (old, name) => (history[kind][kind === 'skills' ? name : name.replace(/\.md$/, '')] ?? []).includes(await contentHash(old))
}

/**
 * Brings the workspace's bundled skills and personas up to date (each time it opens; `fresh` for a workspace Hive has
 * just set up). One item that can't be updated (a file in it open) is left as it is until the next time; the others go
 * ahead.
 */
export async function syncBundled(opts: { fresh?: boolean } = {}): Promise<void> {
  await withFileLock(manifestPath(), async () => {
    const before = await readManifest()
    const m: Manifest = before ?? { skills: {}, personas: {} }
    for (const kind of ['skills', 'personas'] as const) {
      const folder = folderOf(kind)
      // A workspace Hive has just set up has empty folders: nothing in it was deleted.
      const hadFolder = !opts.fresh && existsSync(folder)
      // What a crash in a swap left: an old copy that isn't a shipped version (the user's) is kept, renamed beside it.
      await cleanSwaps(folder, shippedVersion(kind))
      for (const id of await bundledIds(kind)) {
        const dest = itemPath(folder, kind, id)
        const shipped = await contentHash(itemPath(bundledDir(kind), kind, id))
        // A dangling link is still the user's (lstat, not existsSync); a copy that can't be read counts as edited.
        const present = await lstat(dest).then(() => true, () => false)
        const copy = present ? await contentHash(dest).catch(() => 'unreadable') : null
        const action = bundledAction({ shipped, copy, given: m[kind][id], manifest: !!before, versions: history[kind][id] ?? [shipped], shippedBefore: BEFORE_MANIFEST[kind].includes(id), folder: hadFolder })
        try {
          if (action === 'add' || action === 'update') {
            // Only over the copy this was decided on (or into an empty place): a change of the user's meanwhile wins.
            await install(kind, id, copy)
            m[kind][id] = { from: shipped }
            log.info(`${action === 'add' ? 'Added' : 'Updated'} the bundled ${kind === 'skills' ? 'skill' : 'persona'} ${userText(id)}`)
          } else if (action === 'deleted') m[kind][id] ??= { from: null }
          else if (copy === shipped) m[kind][id] = { from: shipped }
          // A changed copy keeps the version it came from; one Hive never gave (a same-name folder of the user's) has none.
          else m[kind][id] ??= { from: (history[kind][id] ?? []).includes(copy!) ? copy : null }
        } catch (e) {
          // The user changed it meanwhile: it is theirs now, as the next scan will see; the manifest isn't changed.
          if (e instanceof SwapAbandoned) {
            log.info(`Left the bundled ${kind === 'skills' ? 'skill' : 'persona'} ${userText(id)} as it is: it changed while Hive was ${action === 'add' ? 'adding' : 'updating'} it`)
            continue
          }
          log.warn(`Could not ${action === 'add' ? 'add' : 'update'} the bundled ${kind === 'skills' ? 'skill' : 'persona'} ${userText(id)}; trying again next time`, e)
        }
      }
    }
    await retirePersonas(m)
    await writeJsonAtomic(manifestPath(), m)
  })
}

/**
 * Personas Hive no longer ships (working modes replaced them, #259): a workspace copy that is a version Hive shipped,
 * never changed, goes (nothing of the user's is lost); one the user changed is theirs and stays. A workspace whose
 * Assistant used one that went moves to its mode, and is told once (this happens once: afterwards there is no copy).
 */
async function retirePersonas(m: Manifest): Promise<void> {
  const moved: string[] = []
  const name = (id: string): string => (id === 'qa-triager' ? 'QA triager' : id.charAt(0).toUpperCase() + id.slice(1))
  for (const [id, mode] of Object.entries(RETIRED_PERSONAS)) {
    const dest = itemPath(workspace.personasDir, 'personas', id)
    const present = await lstat(dest).then(() => true, () => false)
    if (present) {
      const copy = await contentHash(dest).catch(() => 'unreadable')
      if (!(history.personas[id] ?? []).includes(copy)) continue
      try {
        // Only while it is still that copy: an edit or a replacement of the user's meanwhile stays (swapOut).
        await swapOut(dest, copy)
        log.info(`Removed the retired persona ${userText(id)}: it is now the ${userText(mode)} mode`)
      } catch (e) {
        if (e instanceof SwapAbandoned) log.info(`Kept the retired persona ${userText(id)}: it changed while Hive was removing it, so it is the user's`)
        else log.warn(`Could not remove the retired persona ${userText(id)}; trying again next time`, e)
        continue
      }
    }
    delete m.personas[id]
    // One of the user's in its place meanwhile (made while it was being removed): theirs, and the choice of it stays.
    if (await lstat(dest).then(() => true, () => false)) continue
    if (await chooseModeFor(id, mode)) moved.push(`${name(id)} → ${name(mode)}`)
    else if (present) moved.push(`${name(id)} → ${name(mode)}`)
  }
  if (moved.length) toast('info', "The Assistant's personas are now working modes", `Coordinator, Planner, QA triager and Release manager replace Hive's character personas (${moved.join(', ')}). Switch modes from the Assistant's header; your own personas are unchanged.`)
}

/**
 * The workspace's Assistant chose a persona that went: its mode instead. Decided under the Assistant home's config lock
 * on the choice as it is then, so a choice the user made meanwhile stays; true when it moved.
 */
async function chooseModeFor(id: string, mode: string): Promise<boolean> {
  const home = workspace.assistantHome
  // Most workspaces never chose it: nothing is written then.
  if ((await workspace.projectConfig(home).catch(() => null))?.agents?.find((a) => a.id === ASSISTANT_AGENT_ID)?.persona !== id) return false
  let moved = false
  await workspace
    .mutateProjectConfig(home, (cfg) => {
      const agents = projectAgents(cfg)
      if (agents.find((a) => a.id === ASSISTANT_AGENT_ID)?.persona !== id) return {}
      moved = true
      return { agents: agents.map((a) => (a.id === ASSISTANT_AGENT_ID ? { ...a, persona: mode } : a)) }
    })
    .catch((e) => log.warn('moving the Assistant to its mode', e))
  return moved
}

/** Puts back an item as this Hive ships it (Restore, Revert), and records that the copy is Hive's again. */
export async function restoreBundled(kind: BundledKind, id: string): Promise<void> {
  await install(kind, id)
  const shipped = await contentHash(itemPath(bundledDir(kind), kind, id))
  await changeManifest((m) => {
    m[kind][id] = { from: shipped }
  })
}

/** How the workspace's copy of a bundled item compares with this Hive's. */
export async function bundledStatus(kind: BundledKind, id: string, copyPath: string): Promise<BundledStatus> {
  const [copy, shipped] = await Promise.all([revisionOf(copyPath).catch(() => ''), revisionOf(itemPath(bundledDir(kind), kind, id))])
  if (copy === shipped) return { bundled: 'same' }
  // Only a copy made from a version older than this one has an update here: one from a newer Hive (sharing the
  // workspace) or an unknown one doesn't, and Revert would take it back.
  const from = (await readManifest())?.[kind][id]?.from
  return from && olderThan(kind, id, from, shipped) ? { bundled: 'changed', updateAvailable: true } : { bundled: 'changed' }
}

/** Whether `version` is a version Hive shipped before `shipped` (bundledHistory.json's order). */
export function olderThan(kind: BundledKind, id: string, version: string, shipped: string): boolean {
  const versions = history[kind][id] ?? []
  const at = versions.lastIndexOf(version)
  return at >= 0 && at < versions.lastIndexOf(shipped)
}
