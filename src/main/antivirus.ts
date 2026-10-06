import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import { basename, join, resolve } from 'path'
import { appendFileSync } from 'original-fs'
import { mkdir, readFile, realpath, rm, stat } from 'original-fs/promises'
import { app } from 'electron'
import { changeOutcome, covered, emptyStatus, folderPlan, listed, normPath, parseProbe, statusOf, testsEligible, type AntivirusStatus, type AvAction, type AvChangeResult, type AvPathKind } from '../shared/antivirus'
import { config } from './config'
import { createLogger, userText } from './logger'
import { worktreesRoot } from './worktrees'
import { currentWorkspace, type WorkspaceService } from './workspace'

/**
 * Antivirus scanning of the window's workspace (#316, rules in shared/antivirus.ts). Reading the status runs a
 * read-only PowerShell probe (Get-MpComputerStatus, Get-MpPreference, Security Center, the volumes), with a time limit,
 * never on the UI's thread, cached per workspace and folder set. Changing exclusions is two steps: `prepare` works out
 * the exact operation (the workspace, its lifetime, the action and the resolved folders) for the user to confirm, and
 * `apply` runs exactly that one, after checking nothing changed meanwhile, in one elevated PowerShell (one UAC prompt).
 *
 * Test copies (an unpackaged build with a test profile) never ask Defender: HIVE_TEST_ANTIVIRUS names a fixture (the
 * probe's answer and what elevated changes do) and HIVE_TEST_ANTIVIRUS_LOG records every call; without a fixture the
 * status is "test copy" and changes are refused. So no test can change the machine's Defender settings.
 */

const log = createLogger('antivirus')

/** How long a probe may take, and how long its answer is kept. */
const PROBE_TIMEOUT_MS = 20_000
const CACHE_MS = 10 * 60_000
/** How long the elevated change may take, the UAC prompt included (the user may take a while to answer it). */
const ELEVATED_TIMEOUT_MS = 5 * 60_000
/** How long a prepared change waits for the user's answer, and how many may wait at once. */
const PREPARED_MS = 10 * 60_000
const PREPARED_MAX = 8

const isTestCopy = (): boolean => !app.isPackaged && !!process.env.HIVE_USER_DATA
const fixtureFile = (): string | null => (!app.isPackaged ? process.env.HIVE_TEST_ANTIVIRUS || null : null)

const POWERSHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** PowerShell's single-quoted string for a value (quotes doubled): paths and file names, never commands. */
const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`

/** A script as PowerShell's -EncodedCommand takes it (UTF-16LE, base64), with UTF-8 output and no progress bars. */
const encode = (script: string): string => Buffer.from(`[Console]::OutputEncoding = [Text.Encoding]::UTF8\n$ProgressPreference = 'SilentlyContinue'\n${script}`, 'utf16le').toString('base64')

/** Runs a script in a hidden, profile-less PowerShell, its output as text (UTF-8). */
function runPowerShell(script: string, timeout: number): Promise<string> {
  const encoded = encode(script)
  return new Promise((done, fail) => {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, timeout, maxBuffer: 1 << 20, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) fail(new Error(err.killed ? `PowerShell took longer than ${Math.round(timeout / 1000)} s` : (stderr || err.message).trim().slice(0, 300)))
      else done(stdout)
    })
  })
}

/** The read-only probe: Defender's state and (if visible) exclusions and performance mode, Security Center's products, the drives' file systems. */
export function probeScript(drives: string[]): string {
  return `
$r = @{}
try { $s = Get-MpComputerStatus -ErrorAction Stop; $r.defender = @{ antivirus = [bool]$s.AntivirusEnabled; realTime = [bool]$s.RealTimeProtectionEnabled; mode = "$($s.AMRunningMode)" } } catch { $r.defender = $null }
try { $p = Get-MpPreference -ErrorAction Stop; $r.exclusions = @($p.ExclusionPath | Where-Object { $_ }); if ($null -ne $p.PerformanceModeStatus) { $r.perfMode = [int]$p.PerformanceModeStatus } } catch { $r.exclusions = $null }
try { $r.products = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop | ForEach-Object { @{ name = "$($_.displayName)"; state = [int]$_.productState } }) } catch { $r.products = $null }
$r.volumes = @(foreach ($d in @(${drives.map(psQuote).join(', ')})) { try { $v = Get-Volume -DriveLetter $d -ErrorAction Stop; @{ drive = $d; fs = "$($v.FileSystemType)" } } catch { @{ drive = $d; fs = $null } } })
ConvertTo-Json -InputObject $r -Compress -Depth 4
`
}

/**
 * The elevated change. It goes to the elevated PowerShell whole, as its encoded command (never a file another process
 * could change before the prompt is answered), its paths as quoted literals. It reads Defender's list first and asks
 * only for what is needed: Add skips folders an existing exclusion (the folder or a parent) already covers; Remove
 * takes only exact entries that are there, so a parent someone else added is never touched. It then reads the list
 * again, and each drive's Dev Drive state, and writes all of it to `output`.
 */
export function elevatedScript(action: AvAction, paths: string[], drives: string[], output: string): string {
  return `
$ErrorActionPreference = 'Stop'
$out = @{ ok = $false; listed = $false; requested = @() }
function Norm([string]$p) { return $p.Replace('/', '\\').TrimEnd('\\').ToLowerInvariant() }
function Covered([string]$p, $list) { $n = Norm $p; foreach ($e in $list) { $x = Norm $e; if ($x -and ($n -eq $x -or $n.StartsWith($x + '\\'))) { return $true } }; return $false }
function Listed([string]$p, $list) { $n = Norm $p; foreach ($e in $list) { if ((Norm $e) -eq $n) { return $true } }; return $false }
function Readable($list) { foreach ($e in $list) { if ("$e".Trim() -like 'N/A*') { return $false } }; return $true }
try {
  $paths = @(${paths.map(psQuote).join(', ')})
  $action = ${psQuote(action)}
  $before = @((Get-MpPreference).ExclusionPath | Where-Object { $_ })
  # Which exclusions already exist must be known before anything changes: otherwise nothing changes.
  if (-not (Readable $before)) { throw "Defender's exclusions couldn't be read even with administrator rights, so nothing was changed." }
  if ($action -eq 'add') { $need = @($paths | Where-Object { -not (Covered $_ $before) }); $out.requested = $need; if ($need.Count) { Add-MpPreference -ExclusionPath $need } }
  elseif ($action -eq 'remove') { $need = @($paths | Where-Object { Listed $_ $before }); $out.requested = $need; if ($need.Count) { Remove-MpPreference -ExclusionPath $need } }
  $out.ok = $true
} catch { $out.error = $_.Exception.Message }
try { $after = @((Get-MpPreference).ExclusionPath | Where-Object { $_ }); if (Readable $after) { $out.exclusions = $after; $out.listed = $true } } catch { $out.listError = $_.Exception.Message }
$out.devDrives = @{}
foreach ($d in @(${drives.map(psQuote).join(', ')})) { try { $out.devDrives[$d] = (& fsutil devdrv query ($d + ':') 2>&1 | Out-String) } catch { } }
ConvertTo-Json -InputObject $out -Compress -Depth 4 | Set-Content -LiteralPath ${psQuote(output)} -Encoding UTF8
`
}

/** Starts the elevated script (the UAC prompt) and waits for it; a declined prompt is "cancelled". */
export function launcherScript(script: string): string {
  return `
try {
  $p = Start-Process -FilePath ${psQuote(POWERSHELL)} -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ${psQuote(encode(script))})
  ConvertTo-Json -InputObject @{ started = $true } -Compress
} catch {
  $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }
  ConvertTo-Json -InputObject @{ started = $false; cancelled = ($e.NativeErrorCode -eq 1223 -or "$($_.Exception.Message)" -match 'cancel'); error = "$($_.Exception.Message)" } -Compress
}
`
}

// ------------------------------------------------------------------------------------------------ test fixtures

interface Fixture {
  /** 'other': not Windows (nothing to check). */
  platform?: 'win32' | 'other'
  /** The probe's answer (shared/antivirus.ts AvProbe's JSON), or why it failed. */
  probe?: unknown
  probeError?: string
  /**
   * Elevated changes: the prompt declined, or failing to start; Defender refusing (an error, after `partial` of the
   * needed folders), or ignoring them (policy); the list unreadable afterwards; the starting list (as administrator
   * rights see it) and each drive's `fsutil devdrv query` text.
   */
  elevated?: { cancelled?: boolean; launchError?: string; error?: string; partial?: number; policy?: boolean; unlisted?: boolean; redacted?: boolean; exclusions?: string[]; devDrives?: Record<string, string> }
  /** Holds the probe's answer this long (a slow probe, to overlap requests). */
  probeDelayMs?: number
}

/** Defender's answer for a hidden list, as a fixture's redacted administrator read gives it. */
const HIDDEN = 'N/A: Must be an administrator to view exclusions'

/** The exclusion list a fixture's elevated changes act on (as administrator rights would see it), per fixture file. */
const simulated = new Map<string, string[]>()

async function readFixture(): Promise<Fixture | null> {
  const file = fixtureFile()
  if (!file) return null
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Fixture
  } catch (e) {
    throw new Error(`The antivirus test fixture couldn't be read: ${(e as Error).message}`, { cause: e })
  }
}

function testLog(entry: Record<string, unknown>): void {
  const file = !app.isPackaged ? process.env.HIVE_TEST_ANTIVIRUS_LOG : undefined
  if (!file) return
  try {
    appendFileSync(file, `${JSON.stringify({ at: Date.now(), ...entry })}\n`)
  } catch {
    // A test log that can't be written mustn't break Hive.
  }
}

// ------------------------------------------------------------------------------------------------ the folders

/** A folder as Windows names it (links and drive mappings resolved), or null when it can't be resolved. */
const resolved = (p: string): Promise<string | null> => realpath(resolve(p)).catch(() => null)

const exists = (p: string): Promise<boolean> => stat(p).then((s) => s.isDirectory(), () => false)

/** Whether the workspace holds Hive's own repository (someone developing Hive). */
async function holdsHive(w: WorkspaceService): Promise<boolean> {
  for (const p of await w.listProjectPaths().catch(() => [] as string[])) {
    try {
      const pkg = JSON.parse(await readFile(join(p, 'package.json'), 'utf8')) as { name?: unknown; productName?: unknown }
      if (pkg.name === 'hive' && pkg.productName === 'Hive') return true
    } catch {
      // Not a Node project.
    }
  }
  return false
}

/** The folders no exclusion may be or hold: the home folder, the profile and Windows' own, as given and resolved. */
async function guardedFolders(): Promise<string[]> {
  const env = process.env
  const candidates = [app.getPath('home'), env.USERPROFILE, env.APPDATA, env.LOCALAPPDATA, env.SystemRoot, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData, env.PUBLIC].filter((p): p is string => !!p)
  const out: string[] = []
  for (const p of candidates) {
    out.push(resolve(p))
    const real = await resolved(p)
    if (real) out.push(real)
  }
  return [...new Set(out)]
}

/**
 * The workspace's folders to exclude, as resolved absolute paths: its root, its worktrees folder once it exists, and
 * Hive's test area (%LOCALAPPDATA%\hive-test) only for people developing Hive and once it exists. Each is resolved
 * (links followed) and checked after resolving: one that is, or holds, a drive, a share, the home folder, the profile
 * or a system folder is never offered, nor one whose real location can't be established.
 */
export async function workspaceFolders(w: WorkspaceService): Promise<{ path: string; kind: AvPathKind; unsafe?: string }[]> {
  const root = w.path
  if (!root) return []
  const rootReal = await resolved(root)
  const trees = worktreesRoot(root)
  const local = process.env.LOCALAPPDATA || join(app.getPath('home'), 'AppData', 'Local')
  const tests = join(local, 'hive-test')
  const wantTests = testsEligible({ packaged: app.isPackaged, holdsHive: app.isPackaged ? await holdsHive(w) : false }) && (await exists(tests))
  return folderPlan(
    {
      root: rootReal,
      ...(rootReal ? {} : { rootUnresolved: resolve(root) }),
      trees: (await exists(trees)) ? await resolved(trees) : null,
      tests: wantTests ? await resolved(tests) : null
    },
    await guardedFolders()
  )
}

// ------------------------------------------------------------------------------------------------ status

/** What Hive remembers (config.json, this machine's): what it added, the last administrator check, the offers. */
const remembered = () => config.get().antivirus ?? {}

/** The folder set, as a key: a status for another set (a worktrees folder appeared) is probed again. */
const folderKey = (folders: { path: string }[]): string => folders.map((f) => normPath(f.path)).join('|')

/** The status of each workspace opened while Hive runs, by path in lower case, with its folder set, age and probe's order. */
const cache = new Map<string, { status: AntivirusStatus; folders: string; at: number; seq: number }>()
/** Probes under way, by workspace path and folder set: shared only by requests for the same set and workspace lifetime. */
const inFlight = new Map<string, { life: AbortSignal; seq: number; promise: Promise<AntivirusStatus> }>()
let probes = 0

/** The window's workspace's status: cached for ten minutes unless `refresh` or its folders changed. */
export function antivirusStatus(refresh = false): Promise<AntivirusStatus> {
  return statusFor(currentWorkspace(), refresh)
}

export async function statusFor(w: WorkspaceService, refresh = false): Promise<AntivirusStatus> {
  const root = w.path
  if (!root) throw new Error('No workspace is open')
  const key = root.toLowerCase()
  const folders = await workspaceFolders(w)
  const set = folderKey(folders)
  const hit = cache.get(key)
  if (!refresh && hit && hit.folders === set && Date.now() - hit.at < CACHE_MS) return hit.status
  const life = w.lifetime
  // A probe for another folder set (one started before a worktrees folder appeared) or an earlier lifetime of the
  // workspace answers another question: this request starts its own.
  const flightKey = `${key}|${set}`
  const running = inFlight.get(flightKey)
  if (running && running.life === life && !life.aborted) return running.promise
  const seq = ++probes
  const promise = probe(root, folders)
    .then((status) => {
      // A workspace closed meanwhile isn't cached (its window may show another), and an older probe finishing late
      // never replaces a newer one's answer.
      const now = cache.get(key)
      if (!life.aborted && w.path === root && (!now || now.seq < seq)) cache.set(key, { status, folders: set, at: Date.now(), seq })
      return status
    })
    .finally(() => {
      if (inFlight.get(flightKey)?.seq === seq) inFlight.delete(flightKey)
    })
  inFlight.set(flightKey, { life, seq, promise })
  return promise
}

const drivesOf = (paths: string[]): string[] => [...new Set(paths.map((p) => /^([a-z]):/i.exec(p)?.[1].toUpperCase()).filter((d): d is string => !!d))]

async function probe(root: string, folders: { path: string; kind: AvPathKind; unsafe?: string }[]): Promise<AntivirusStatus> {
  const now = new Date()
  const fixture = await readFixture()
  if (fixture ? fixture.platform === 'other' : process.platform !== 'win32') return emptyStatus(root, 'not-applicable', folders, now)
  if (!fixture && isTestCopy()) return emptyStatus(root, 'test-copy', folders, now)
  try {
    let raw: unknown
    if (fixture) {
      testLog({ call: 'probe', paths: folders.map((f) => f.path) })
      if (fixture.probeDelayMs) await new Promise((r) => setTimeout(r, Math.min(fixture.probeDelayMs!, 30_000)))
      if (fixture.probeError) throw new Error(fixture.probeError)
      raw = fixture.probe
    } else raw = JSON.parse((await runPowerShell(probeScript(drivesOf(folders.map((f) => f.path))), PROBE_TIMEOUT_MS)).trim() || 'null')
    const mem = remembered()
    return statusOf(root, parseProbe(raw), folders, { added: mem.added ?? [], adminCheck: mem.adminCheck ?? null, now })
  } catch (e) {
    log.warn(`antivirus status of ${userText(root)}: ${userText((e as Error).message)}`)
    return emptyStatus(root, 'unavailable', folders, now, (e as Error).message)
  }
}

// ------------------------------------------------------------------------------------------------ changes

interface Prepared {
  w: WorkspaceService
  life: AbortSignal
  root: string
  action: AvAction
  paths: string[]
  drives: string[]
  at: number
}

/** Changes waiting for the user's answer, by id: used once, within ten minutes, at most a few at a time. */
const prepared = new Map<string, Prepared>()

/** The folders an action would change now: Add the safe ones not known to be excluded, Remove the safe ones Hive added. */
async function planFor(w: WorkspaceService, action: AvAction): Promise<{ status: AntivirusStatus; paths: string[] }> {
  const status = await statusFor(w, true)
  if (status.scan !== 'defender') throw new Error(status.scan === 'other' ? 'Another antivirus is active: Hive can only change Microsoft Defender’s exclusions.' : 'Microsoft Defender isn’t the active antivirus here.')
  const added = (remembered().added ?? []).map(normPath)
  const safe = status.paths.filter((p) => !p.unsafe)
  const paths = action === 'add' ? safe.filter((p) => p.state !== 'excluded').map((p) => p.path) : action === 'remove' ? safe.filter((p) => added.includes(normPath(p.path))).map((p) => p.path) : []
  if (action !== 'check' && !paths.length) throw new Error(action === 'add' ? 'Every folder Hive may offer is already excluded.' : 'Hive added no exclusions for this workspace.')
  return { status, paths }
}

/**
 * Works out a change for the window's workspace, for the user to confirm: the exact folders it would change. Nothing
 * runs until `applyAntivirus` gets its id back.
 */
export async function prepareAntivirus(action: AvAction): Promise<{ id: string; action: AvAction; paths: string[]; workspacePath: string }> {
  if (action !== 'add' && action !== 'remove' && action !== 'check') throw new Error('Not an antivirus action.')
  const w = currentWorkspace()
  const root = w.path
  if (!root) throw new Error('No workspace is open')
  const life = w.lifetime
  const { status, paths } = await planFor(w, action)
  if (life.aborted || w.path !== root) throw new Error('The workspace closed meanwhile.')
  const now = Date.now()
  for (const [id, p] of prepared) if (now - p.at > PREPARED_MS || p.life.aborted) prepared.delete(id)
  while (prepared.size >= PREPARED_MAX) prepared.delete(prepared.keys().next().value!)
  const id = randomUUID()
  prepared.set(id, { w, life, root, action, paths, drives: drivesOf(status.paths.map((p) => p.path)), at: now })
  return { id, action, paths, workspacePath: root }
}

/**
 * Runs a prepared change, exactly as confirmed: refused if it isn't the window's workspace's any more, or the folders
 * it would change now differ from those the user saw (they must confirm the new set). One elevated PowerShell, one UAC
 * prompt. What Hive added is remembered from what Defender lists afterwards, never from what was asked.
 */
export async function applyAntivirus(id: string): Promise<{ result: AvChangeResult; status: AntivirusStatus | null }> {
  const op = typeof id === 'string' ? prepared.get(id) : undefined
  if (!op) throw new Error('That change is no longer waiting: ask again.')
  prepared.delete(id)
  if (Date.now() - op.at > PREPARED_MS) throw new Error('That change waited too long for an answer: ask again.')
  if (op.life.aborted || currentWorkspace() !== op.w || op.w.path !== op.root) throw new Error('The workspace changed since you were asked: nothing was changed.')
  const { paths } = await planFor(op.w, op.action)
  if (op.life.aborted || op.w.path !== op.root) throw new Error('The workspace changed since you were asked: nothing was changed.')
  const same = paths.length === op.paths.length && paths.every((p) => op.paths.some((q) => normPath(q) === normPath(p)))
  if (!same) throw new Error('The folders changed since you were asked: review them again. Nothing was changed.')
  log.info(`antivirus ${op.action}: ${op.paths.map((p) => userText(p)).join(', ') || '(read the list)'}`)
  const result = await elevated(op.action, op.paths, op.drives)
  // What happened to Defender is the machine's, whatever the window shows now: remembered either way.
  config.update((c) => {
    const a = { ...c.antivirus }
    if (result.exclusions) a.adminCheck = { at: new Date().toISOString(), exclusions: result.exclusions, ...(result.devDrives ? { devDrives: result.devDrives } : {}) }
    if (result.added?.length) a.added = [...new Set([...(a.added ?? []), ...result.added])]
    if (result.removed?.length) a.added = (a.added ?? []).filter((p) => !result.removed!.some((x) => normPath(x) === normPath(p)))
    c.antivirus = a
  })
  log.info(`antivirus ${op.action}: ${result.outcome}`)
  const status = op.life.aborted || op.w.path !== op.root ? null : await statusFor(op.w, true)
  return { result, status }
}

async function elevated(action: AvAction, paths: string[], drives: string[]): Promise<AvChangeResult> {
  const fixture = await readFixture()
  if (fixture) return fixtureChange(fixture, action, paths)
  if (isTestCopy()) throw new Error('Test copies of Hive never change Defender’s settings.')
  if (process.platform !== 'win32') throw new Error('Only Windows has Defender exclusions.')
  const dir = join(tmpdir(), `hive-antivirus-${randomUUID()}`)
  await mkdir(dir, { recursive: true })
  try {
    const output = join(dir, 'result.json')
    let launch: { started: boolean; cancelled?: boolean; error?: string }
    try {
      launch = JSON.parse((await runPowerShell(launcherScript(elevatedScript(action, paths, drives, output)), ELEVATED_TIMEOUT_MS)).trim()) as typeof launch
    } catch (e) {
      launch = { started: false, error: (e as Error).message }
    }
    const result = launch.started ? await readFile(output, 'utf8').then((t) => JSON.parse(t.replace(/^\ufeff/, '')) as unknown, () => null) : null
    return changeOutcome(action, launch, result)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** A fixture's elevated change: what the elevated script does, on a simulated exclusion list, every call logged. */
function fixtureChange(f: Fixture, action: AvAction, paths: string[]): AvChangeResult {
  testLog({ call: action, paths })
  const e = f.elevated ?? {}
  const file = fixtureFile()!
  if (!simulated.has(file)) simulated.set(file, [...(e.exclusions ?? [])])
  let current = simulated.get(file)!
  if (e.cancelled) return changeOutcome(action, { started: false, cancelled: true }, null)
  if (e.launchError) return changeOutcome(action, { started: false, error: e.launchError }, null)
  // A redacted list even with administrator rights: which exclusions exist can't be known, so nothing changes, and the
  // list it reports (Defender's "N/A" answer, as if it had slipped through) must count as unknown.
  if (e.redacted) return changeOutcome(action, { started: true }, { ok: action === 'check', ...(action === 'check' ? {} : { error: "Defender's exclusions couldn't be read even with administrator rights, so nothing was changed." }), requested: [], listed: true, exclusions: [HIDDEN] })
  const need = action === 'add' ? paths.filter((p) => !covered(p, current)) : action === 'remove' ? paths.filter((p) => listed(p, current)) : []
  const applied = e.policy ? [] : e.error ? need.slice(0, e.partial ?? 0) : need
  if (action === 'add') current = [...current, ...applied]
  if (action === 'remove') current = current.filter((x) => !applied.some((p) => normPath(p) === normPath(x)))
  simulated.set(file, current)
  testLog({ call: `${action}-requested`, paths: need })
  return changeOutcome(action, { started: true }, { ok: !e.error, ...(e.error ? { error: e.error } : {}), requested: need, ...(e.unlisted ? {} : { listed: true, exclusions: current }), devDrives: e.devDrives ?? {} })
}

// ------------------------------------------------------------------------------------------------ the offer

/**
 * Whether to suggest exclusions now (the window saw a reason: several agents running, a long command, or a new
 * worktrees folder while they run): when scanning likely slows this workspace, it wasn't declined for good, and these
 * folders weren't offered before. The check and the claim happen together after the status is known, so two requests
 * can't both offer, and one can't ignore a "Don't ask again" given meanwhile. Null: no suggestion.
 */
export async function antivirusSuggestion(): Promise<AntivirusStatus | null> {
  const w = currentWorkspace()
  const root = w.path
  if (!root) return null
  const life = w.lifetime
  const key = root.toLowerCase()
  if (remembered().dismissed?.[key]) return null
  const status = await statusFor(w)
  if (life.aborted || w.path !== root || !status.slowed) return null
  // From here to the claim nothing awaits: what is remembered now is what decides.
  const mem = remembered()
  if (mem.dismissed?.[key] || mem.offered?.[key] === status.offerKey) return null
  config.update((c) => {
    c.antivirus = { ...c.antivirus, offered: { ...c.antivirus?.offered, [key]: status.offerKey } }
  })
  log.info(`antivirus: suggested exclusions for ${userText(basename(root))}`)
  return status
}

/** "Don't ask again" for the window's workspace. */
export function dismissAntivirus(): void {
  const root = currentWorkspace().path
  if (!root) return
  config.update((c) => {
    c.antivirus = { ...c.antivirus, dismissed: { ...c.antivirus?.dismissed, [root.toLowerCase()]: true } }
  })
}
