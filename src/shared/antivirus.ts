/**
 * Antivirus scanning of a workspace (#316): whether Microsoft Defender scans the folders Hive's work goes through, and
 * the exclusions Hive can offer. Pure: main (main/antivirus.ts) runs the read-only probe and the elevated changes and
 * gives their output here; the renderer shows the status. Only Windows has anything to check: elsewhere the status is
 * "not applicable".
 *
 * The folders are worked out per workspace (computed in main, always resolved absolute paths): the workspace root (its
 * projects live in it), its worktrees folder once it exists, and Hive's test area for people developing Hive. Nothing
 * broader is ever offered (a drive, a share, the home folder or the profile, or a folder holding one of them), and
 * Hive only ever removes the exclusions it added itself.
 */

/** Which folder of the workspace's set a path is. */
export type AvPathKind = 'workspace' | 'worktrees' | 'tests'

/**
 * Whether Defender skips a folder: excluded or not (seen in Defender's list), unknown (Defender hides its list from
 * processes without administrator rights), or added by Hive and not seen since (the list is hidden).
 */
export type AvPathState = 'excluded' | 'not-excluded' | 'unknown' | 'added'

/**
 * Whether a folder is on a Dev Drive: confirmed trusted, or a Dev Drive that isn't trusted (scanned like any other),
 * both only from a check with administrator rights; a ReFS volume not checked (it may be one); not one; or unknown.
 */
export type AvDevDrive = 'trusted' | 'untrusted' | 'refs' | 'no' | 'unknown'

/** What scans the workspace. */
export type AvScan =
  /** Not Windows: nothing to check. */
  | 'not-applicable'
  /** A test copy of Hive without a fixture: it never asks Defender (tests stub it). */
  | 'test-copy'
  /** The status couldn't be read (PowerShell failed or took too long). */
  | 'unavailable'
  /** Microsoft Defender is the active antivirus. */
  | 'defender'
  /** Another antivirus is active instead: Hive can't manage it. */
  | 'other'
  /** No active antivirus was found. */
  | 'none'

export interface AvPath {
  path: string
  kind: AvPathKind
  state: AvPathState
  /** Hive added this exclusion (so Remove may take it away again). */
  addedByHive: boolean
  devDrive: AvDevDrive
  /** Why Hive won't offer to exclude it (too broad, or its real location couldn't be established). */
  unsafe?: string
}

export interface AntivirusStatus {
  workspacePath: string
  scan: AvScan
  /** Defender's real-time protection (null when not Defender, or unknown). */
  realTime: boolean | null
  /** Defender's performance mode for trusted Dev Drives (null when unknown). */
  performanceMode: boolean | null
  /** Where the exclusion states come from: Defender's list now, the last check with administrator rights, or neither. */
  exclusionsFrom: 'live' | 'admin-check' | null
  /** When the administrator check was made (exclusionsFrom 'admin-check'). */
  adminCheckedAt?: string
  /** The other active antivirus products, by name (scan 'other'). */
  others: string[]
  paths: AvPath[]
  checkedAt: string
  /** Why it couldn't be read (scan 'unavailable'). */
  error?: string
  /**
   * Whether scanning likely slows this workspace in a way Hive can help with: Defender with real-time protection on,
   * and a folder Hive may offer that isn't known to be excluded nor on a trusted Dev Drive in performance mode.
   */
  slowed: boolean
  /** The folders an offer is about (the slowed ones), as a key: an offer is made once for each set. */
  offerKey: string
}

/** The read-only probe's output (main/antivirus.ts probeScript), as untrusted JSON. */
export interface AvProbe {
  defender: { antivirus: boolean; realTime: boolean; mode: string } | null
  /** Null when Defender hides the list (no administrator rights), or it couldn't be read or isn't a list of paths. */
  exclusions: string[] | null
  /** Defender's PerformanceModeStatus: 0 on, 1 off; null when unknown. */
  performanceMode: boolean | null
  /** Security Center's antivirus products (null where there is none, e.g. Windows Server). */
  products: { name: string; state: number }[] | null
  /** Each drive's file system, by letter (upper case). */
  volumes: Record<string, string | null>
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v])
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/**
 * A list of paths as PowerShell prints one (an array, or a single string for one entry), or null when it isn't one:
 * anything else is unknown, never an empty list.
 */
export function pathList(v: unknown): string[] | null {
  if (typeof v === 'string') return v.trim() ? [v] : []
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return null
  return (v as string[]).filter((x) => x.trim() !== '')
}

/**
 * Defender's exclusion list as read, or null when it wasn't really read: not a list of paths, or Defender's answer for
 * a hidden list ("N/A: Must be an administrator to view exclusions"), whichever read produced it. A genuinely empty
 * list is a list.
 */
export function readableList(v: unknown): string[] | null {
  const l = pathList(v)
  return l && !l.some((x) => /^N\/A\b/i.test(x.trim())) ? l : null
}

/** The probe's JSON, checked: anything missing or of the wrong kind is unknown, never a guess. */
export function parseProbe(raw: unknown): AvProbe {
  const r = obj(raw) ?? {}
  const d = obj(r.defender)
  const defender = d && typeof d.antivirus === 'boolean' && typeof d.realTime === 'boolean' ? { antivirus: d.antivirus, realTime: d.realTime, mode: str(d.mode) ?? '' } : null
  // Without administrator rights Defender answers "N/A: Must be an administrator to view exclusions".
  const ex = readableList(r.exclusions)
  const products = r.products === null || r.products === undefined ? null : list(r.products).flatMap((p) => {
    const o = obj(p)
    return o && typeof o.name === 'string' && typeof o.state === 'number' ? [{ name: o.name, state: o.state }] : []
  })
  const volumes: Record<string, string | null> = {}
  for (const v of list(r.volumes)) {
    const o = obj(v)
    const drive = str(o?.drive)
    if (drive && /^[a-z]$/i.test(drive)) volumes[drive.toUpperCase()] = str(o?.fs)
  }
  return { defender, exclusions: ex, performanceMode: r.perfMode === 0 ? true : r.perfMode === 1 ? false : null, products, volumes }
}

/** Whether a Security Center product state says it is on (the second byte of 0xAABBCC: 0x10 or 0x11 on). */
export const productOn = (state: number): boolean => ((state >> 12) & 0xf) === 1

const isDefender = (name: string): boolean => /defender/i.test(name)

/** A path as Defender compares them: backslashes, no trailing separator, any case. */
export function normPath(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** Whether an exclusion list covers a folder: the folder itself or one of its parents (no wildcards or variables). */
export function covered(path: string, exclusions: string[]): boolean {
  const p = normPath(path)
  return exclusions.some((e) => {
    const x = normPath(e.trim())
    return !!x && (p === x || p.startsWith(`${x}\\`))
  })
}

/** Whether an exclusion list has this exact entry (what Hive may remove: never a parent someone else added). */
export const listed = (path: string, exclusions: string[]): boolean => exclusions.some((e) => normPath(e) === normPath(path))

const driveOf = (p: string): string | null => /^([a-z]):/i.exec(p)?.[1].toUpperCase() ?? null

/** What `fsutil devdrv query X:` says about a drive (run with administrator rights): a Dev Drive, trusted or not. */
export function devDriveOf(text: unknown): 'trusted' | 'untrusted' | 'no' | null {
  if (typeof text !== 'string' || !text.trim()) return null
  if (/not a (trusted )?developer volume/i.test(text) && !/is a (trusted )?developer volume/i.test(text)) return 'no'
  if (/untrusted developer volume|not trusted/i.test(text)) return 'untrusted'
  if (/trusted developer volume/i.test(text)) return 'trusted'
  if (/developer volume/i.test(text)) return 'untrusted'
  return null
}

/**
 * Why a folder must never be excluded, or null when it may be offered: a drive or a share's root, or a folder that is
 * (or holds) the home folder, the profile or a system folder. `guarded` are those folders, resolved.
 */
export function unsafeFolder(path: string, guarded: string[]): string | null {
  const p = normPath(path)
  if (!/^[a-z]:(\\|$)|^\\\\[^\\]+\\[^\\]+/i.test(path.replace(/\//g, '\\'))) return 'not an absolute folder'
  if (/^[a-z]:$/.test(p)) return 'a whole drive'
  if (/^\\\\[^\\]+\\[^\\]+$/.test(p)) return 'a whole network share'
  for (const g of guarded) {
    const x = normPath(g)
    if (x && (x === p || x.startsWith(`${p}\\`))) return 'it is, or holds, your home folder, profile or a system folder'
  }
  return null
}

/** Hive's test area is offered only to people developing Hive: a dev or test build, or a workspace holding Hive's repository. */
export const testsEligible = (opts: { packaged: boolean; holdsHive: boolean }): boolean => !opts.packaged || opts.holdsHive

/**
 * The workspace's folders from their resolved paths (null: absent, or couldn't be resolved): duplicates dropped, each
 * marked unsafe when it must never be excluded, the root's failure to resolve too (fail closed).
 */
export function folderPlan(input: { root: string | null; rootUnresolved?: string; trees: string | null; tests: string | null }, guarded: string[]): { path: string; kind: AvPathKind; unsafe?: string }[] {
  const out: { path: string; kind: AvPathKind; unsafe?: string }[] = []
  const add = (path: string | null, kind: AvPathKind, unresolved?: string): void => {
    if (unresolved) return void out.push({ path: unresolved, kind, unsafe: 'its real location couldn’t be established' })
    if (!path || out.some((f) => normPath(f.path) === normPath(path))) return
    const unsafe = unsafeFolder(path, guarded)
    out.push({ path, kind, ...(unsafe ? { unsafe } : {}) })
  }
  add(input.root, 'workspace', input.rootUnresolved)
  add(input.trees, 'worktrees')
  add(input.tests, 'tests')
  return out
}

/** What Hive last read with administrator rights: the exclusion list, and each drive's Dev Drive state. */
export interface AdminCheck {
  at: string
  exclusions: string[]
  devDrives?: Record<string, 'trusted' | 'untrusted' | 'no'>
}

/**
 * The status of a workspace's folders, from the probe. `added`: the exclusions Hive added; `adminCheck`: what was last
 * read with administrator rights, used while the live list is hidden (and for Dev Drives, which only it can confirm).
 */
export function statusOf(workspacePath: string, probe: AvProbe, folders: { path: string; kind: AvPathKind; unsafe?: string }[], opts: { added: string[]; adminCheck?: AdminCheck | null; now: Date }): AntivirusStatus {
  const others = (probe.products ?? []).filter((p) => productOn(p.state) && !isDefender(p.name)).map((p) => p.name)
  const d = probe.defender
  // Defender in passive mode (another antivirus is active) or switched off doesn't scan in real time.
  const defenderActive = !!d && d.antivirus && !/passive|edr/i.test(d.mode)
  const scan: AvScan = defenderActive ? 'defender' : others.length ? 'other' : !d && !probe.products ? 'unavailable' : 'none'
  const live = probe.exclusions
  // A kept administrator read counts only if it is a readable list (never Defender's hidden-list answer).
  const admin = !live && opts.adminCheck && readableList(opts.adminCheck.exclusions) ? opts.adminCheck : null
  const known = live ?? admin?.exclusions ?? null
  const added = opts.added.map(normPath)
  const paths: AvPath[] = folders.map((f) => {
    const addedByHive = added.includes(normPath(f.path))
    const state: AvPathState = known ? (covered(f.path, known) ? 'excluded' : 'not-excluded') : addedByHive ? 'added' : 'unknown'
    const drive = driveOf(f.path)
    const checked = drive ? opts.adminCheck?.devDrives?.[drive] : undefined
    const fs = drive ? probe.volumes[drive] : undefined
    const devDrive: AvDevDrive = checked ?? (fs === undefined || fs === null ? 'unknown' : /^refs$/i.test(fs) ? 'refs' : 'no')
    return { path: f.path, kind: f.kind, state, addedByHive, devDrive, ...(f.unsafe ? { unsafe: f.unsafe } : {}) }
  })
  const realTime = scan === 'defender' ? d!.realTime : null
  // A trusted Dev Drive in performance mode is scanned lightly; an untrusted one, or performance mode off, is scanned like any other.
  const light = (p: AvPath): boolean => p.devDrive === 'trusted' && probe.performanceMode === true
  const slowedPaths = scan === 'defender' && realTime ? paths.filter((p) => !p.unsafe && p.state !== 'excluded' && p.state !== 'added' && !light(p)) : []
  return {
    workspacePath,
    scan,
    realTime,
    performanceMode: probe.performanceMode,
    exclusionsFrom: live ? 'live' : admin ? 'admin-check' : null,
    ...(admin ? { adminCheckedAt: admin.at } : {}),
    others,
    paths,
    checkedAt: opts.now.toISOString(),
    slowed: slowedPaths.length > 0,
    offerKey: slowedPaths.map((p) => normPath(p.path)).sort().join('|')
  }
}

/** Hive's last suggestion for a workspace (#348): the folders it was about, when, and how many times for them. */
export interface AvOffer {
  offerKey: string
  /** For the wording (a reminder from the second) and diagnostics: never a limit. */
  count: number
  /** ISO time. */
  lastAt: string
}

/** A suggestion to show: the status, and which time it is for these folders (1, then reminders). */
export interface AvSuggestion {
  status: AntivirusStatus
  count: number
}

/**
 * The answer to "suggest now?": the suggestion to show, if any, and when a reminder for these folders may come (while
 * what makes scanning matter lasts, the window asks again then): null when nothing would be suggested (declined for
 * good, not slowed).
 */
export interface AvSuggestionReply {
  offer: AvSuggestion | null
  remindAt: string | null
}

/** A reminder for the same folders comes a day after the last suggestion at the earliest. */
export const REMIND_MS = 24 * 60 * 60_000

/** A remembered offer, also #316's form (only the folders' key: suggested once, when not known). Null: none, or not one. */
export function offerOf(v: unknown): AvOffer | null {
  if (typeof v === 'string') return v ? { offerKey: v, count: 1, lastAt: '' } : null
  if (!v || typeof v !== 'object') return null
  const o = v as Partial<AvOffer>
  if (typeof o.offerKey !== 'string' || !o.offerKey) return null
  return { offerKey: o.offerKey, count: typeof o.count === 'number' && o.count >= 1 ? Math.floor(o.count) : 1, lastAt: typeof o.lastAt === 'string' ? o.lastAt : '' }
}

/**
 * Whether to suggest now, for the folders a slowed status is about (`offerKey`, empty when nothing is slowed): the
 * offer to remember, or null. Folders not offered before are suggested at once (a new count); the same folders again
 * only `spacing` after the last time (when that isn't known, now), with no limit: "Don't ask again" is the user's stop.
 */
export function nextOffer(prev: AvOffer | null, offerKey: string, now: Date, spacing = REMIND_MS): AvOffer | null {
  if (!offerKey) return null
  if (!prev || prev.offerKey !== offerKey) return { offerKey, count: 1, lastAt: now.toISOString() }
  const last = Date.parse(prev.lastAt)
  if (Number.isFinite(last) && now.getTime() - last < spacing) return null
  return { offerKey, count: prev.count + 1, lastAt: now.toISOString() }
}

/** When a reminder for these folders may come after `offer` (the last suggestion): null when it was for other folders. */
export function remindAtOf(offer: AvOffer | null, offerKey: string, spacing = REMIND_MS): string | null {
  const last = offer && offerKey && offer.offerKey === offerKey ? Date.parse(offer.lastAt) : NaN
  return Number.isFinite(last) ? new Date(last + spacing).toISOString() : null
}

/** A status with nothing checked: not Windows, a test copy, or the probe failed. */
export function emptyStatus(workspacePath: string, scan: 'not-applicable' | 'test-copy' | 'unavailable', folders: { path: string; kind: AvPathKind; unsafe?: string }[], now: Date, error?: string): AntivirusStatus {
  return {
    workspacePath,
    scan,
    realTime: null,
    performanceMode: null,
    exclusionsFrom: null,
    others: [],
    paths: folders.map((f) => ({ path: f.path, kind: f.kind, state: 'unknown', addedByHive: false, devDrive: 'unknown', ...(f.unsafe ? { unsafe: f.unsafe } : {}) })),
    checkedAt: now.toISOString(),
    ...(error ? { error } : {}),
    slowed: false,
    offerKey: ''
  }
}

/** What an elevated change does: add or remove exclusions, or read the list with administrator rights. */
export type AvAction = 'add' | 'remove' | 'check'

export type AvOutcome = 'done' | 'refused' | 'policy' | 'error'

export interface AvChangeResult {
  outcome: AvOutcome
  /** A sentence for the user. */
  message: string
  /** The exclusion list as administrator rights see it after the change, only when it was read (never a guess). */
  exclusions?: string[]
  /** The entries this change added (Add), or removed (Remove), as Defender lists them afterwards. */
  added?: string[]
  removed?: string[]
  /** Each drive's Dev Drive state, read with administrator rights. */
  devDrives?: Record<string, 'trusted' | 'untrusted' | 'no'>
}

/**
 * The outcome of an elevated run. `launch`: whether the elevated PowerShell started (the UAC prompt was accepted);
 * `result`: what it wrote back (untrusted JSON), null if nothing was written. The elevated script reads Defender's
 * list first and asks only for what is needed (`requested`): Add skips a folder an existing exclusion already covers,
 * Remove takes only exact entries that are there.
 */
export function changeOutcome(action: AvAction, launch: { started: boolean; error?: string; cancelled?: boolean }, result: unknown): AvChangeResult {
  if (!launch.started) {
    if (launch.cancelled) return { outcome: 'refused', message: 'The administrator prompt was declined: nothing changed.' }
    return { outcome: 'error', message: `Windows couldn't start the administrator prompt${launch.error ? `: ${launch.error}` : '.'}` }
  }
  const r = obj(result)
  if (!r) return { outcome: 'error', message: 'The change ran with administrator rights but reported nothing: check again to see what Defender has.' }
  // Only a list that was read, and is a list, counts: a missing or malformed one stays unknown.
  const exclusions = r.listed === true ? (readableList(r.exclusions) ?? undefined) : undefined
  const requested = pathList(r.requested) ?? []
  const devDrives: Record<string, 'trusted' | 'untrusted' | 'no'> = {}
  for (const [drive, text] of Object.entries(obj(r.devDrives) ?? {})) {
    const v = devDriveOf(text)
    if (/^[a-z]$/i.test(drive) && v) devDrives[drive.toUpperCase()] = v
  }
  const extra = { ...(exclusions ? { exclusions } : {}), ...(Object.keys(devDrives).length ? { devDrives } : {}) }
  // What actually changed, as Defender lists it afterwards (unknown when it wasn't read: nothing claimed).
  const added = action === 'add' && exclusions ? requested.filter((p) => listed(p, exclusions)) : []
  const removed = action === 'remove' && exclusions ? requested.filter((p) => !listed(p, exclusions)) : []
  const changed = { ...(added.length ? { added } : {}), ...(removed.length ? { removed } : {}) }
  if (r.ok !== true) {
    const error = str(r.error) ?? 'unknown error'
    // Organisation-managed machines (group policy, Intune, tamper protection over exclusions) refuse local changes.
    if (/polic|managed|tamper|0x800106ba|access is denied/i.test(error)) return { outcome: 'policy', message: `Defender refused the change, probably because your organisation manages its settings: ${error}`, ...extra, ...changed }
    return { outcome: 'error', message: `Defender refused the change: ${error}`, ...extra, ...changed }
  }
  if (!exclusions) return { outcome: 'error', message: 'The change ran, but Defender’s list couldn’t be read afterwards: check again to see what it has.', ...extra }
  if (action === 'check') return { outcome: 'done', message: 'Read Defender’s exclusions with administrator rights.', ...extra }
  if (!requested.length) return { outcome: 'done', message: action === 'add' ? 'Defender already skips these folders (an existing exclusion covers them): nothing added.' : 'None of Hive’s exclusions is in Defender’s list any more: nothing removed.', ...extra }
  const missing = action === 'add' ? requested.length - added.length : requested.length - removed.length
  // A change Defender accepted but doesn't show: a policy keeps local exclusions from applying.
  if (missing) return { outcome: 'policy', message: `Defender accepted the change but ${action === 'add' ? "doesn't list" : 'still lists'} ${missing === 1 ? 'one folder' : `${missing} folders`}: your organisation's settings probably override local exclusions.`, ...extra, ...changed }
  const n = requested.length
  return { outcome: 'done', message: action === 'add' ? `Defender no longer scans ${n === 1 ? 'this folder' : `these ${n} folders`}.` : `Removed ${n === 1 ? 'the exclusion' : `${n} exclusions`} Hive added.`, ...extra, ...changed }
}

/** The folders' labels, as the status and the offer say them. */
export const KIND_LABEL: Record<AvPathKind, string> = { workspace: 'The workspace (every project in it)', worktrees: 'Its worktrees', tests: 'Hive’s test area (developing Hive)' }

/** Microsoft's Dev Drive documentation. */
export const DEV_DRIVE_URL = 'https://learn.microsoft.com/windows/dev-drive/'
