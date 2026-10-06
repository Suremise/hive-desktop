import { describe, expect, it } from 'vitest'
import { changeOutcome, covered, devDriveOf, emptyStatus, folderPlan, normPath, parseProbe, pathList, productOn, readableList, statusOf, testsEligible, unsafeFolder, type AvPathKind } from '../src/shared/antivirus'

// Fixtures in the shape main/antivirus.ts's probe prints (Get-MpComputerStatus, Get-MpPreference, Security Center, Get-Volume).
const DEFENDER_ON = 397568 // 0x061100: Windows Defender, on
const NORTON_ON = 266240 // 0x041000: on
const DEFENDER_OFF = 393472 // 0x060100: off
const probe = (over: Record<string, unknown> = {}) => ({
  defender: { antivirus: true, realTime: true, mode: 'Normal' },
  exclusions: ['N/A: Must be an administrator to view exclusions'],
  perfMode: 1,
  products: [{ name: 'Windows Defender', state: DEFENDER_ON }],
  volumes: [{ drive: 'D', fs: 'NTFS' }, { drive: 'C', fs: 'NTFS' }],
  ...over
})
const folders: { path: string; kind: AvPathKind; unsafe?: string }[] = [
  { path: 'D:\\Development\\HIVE', kind: 'workspace' },
  { path: 'D:\\Development\\HIVE.worktrees', kind: 'worktrees' },
  { path: 'C:\\Users\\Dev\\AppData\\Local\\hive-test', kind: 'tests' }
]
const now = new Date('2026-10-06T18:00:00Z')
type Admin = { at: string; exclusions: string[]; devDrives?: Record<string, 'trusted' | 'untrusted' | 'no'> }
const status = (raw: unknown, opts: { added?: string[]; adminCheck?: Admin; folders?: typeof folders } = {}) => statusOf('D:\\Development\\HIVE', parseProbe(raw), opts.folders ?? folders, { added: opts.added ?? [], adminCheck: opts.adminCheck ?? null, now })
const GUARDED = ['C:\\Users\\Dev', 'C:\\Users\\Dev\\AppData\\Roaming', 'C:\\Users\\Dev\\AppData\\Local', 'C:\\Windows', 'C:\\Program Files', 'C:\\ProgramData', 'C:\\Users\\Public']

describe('antivirus (#316)', () => {
  it('reads the probe: Defender’s hidden list, or one that isn’t a list of paths, is unknown, never empty', () => {
    expect(parseProbe(probe()).exclusions).toBeNull()
    expect(parseProbe(probe({ exclusions: null })).exclusions).toBeNull()
    expect(parseProbe(probe({ exclusions: 'D:\\Development' })).exclusions).toEqual(['D:\\Development'])
    expect(parseProbe(probe({ exclusions: [] })).exclusions).toEqual([])
    expect(parseProbe(probe({ exclusions: 42 })).exclusions).toBeNull()
    expect(parseProbe(probe({ exclusions: ['D:\\A', 7] })).exclusions).toBeNull()
    expect(parseProbe(probe({ exclusions: { a: 1 } })).exclusions).toBeNull()
    expect(pathList(undefined)).toBeNull()
    expect(parseProbe(probe({ defender: { antivirus: 'yes' } })).defender).toBeNull()
    expect(parseProbe(null)).toEqual({ defender: null, exclusions: null, performanceMode: null, products: null, volumes: {} })
    expect(parseProbe(probe()).volumes).toEqual({ D: 'NTFS', C: 'NTFS' })
    expect([parseProbe(probe({ perfMode: 0 })).performanceMode, parseProbe(probe()).performanceMode, parseProbe(probe({ perfMode: 'x' })).performanceMode]).toEqual([true, false, null])
  })

  it('a Security Center product is on by its state’s second byte', () => {
    expect([productOn(DEFENDER_ON), productOn(NORTON_ON), productOn(DEFENDER_OFF)]).toEqual([true, true, false])
  })

  it('an exclusion covers its folder and what is inside it, in any case, but not a sibling with a longer name or a variable', () => {
    expect(covered('D:\\Development\\HIVE', ['d:\\development\\hive\\'])).toBe(true)
    expect(covered('D:\\Development\\HIVE.worktrees', ['D:\\Development'])).toBe(true)
    expect(covered('D:\\Development\\HIVE.worktrees', ['D:\\Development\\HIVE'])).toBe(false)
    expect(covered('D:/Development/HIVE', ['D:\\Development\\HIVE'])).toBe(true)
    // The 6 Oct manual entry kept "$env:LOCALAPPDATA" literally: it matches nothing.
    expect(covered('C:\\Users\\Dev\\AppData\\Local\\hive-test', ['$env:LOCALAPPDATA\\hive-test', '%LOCALAPPDATA%\\hive-test'])).toBe(false)
    expect(normPath('D:\\A\\B\\')).toBe('d:\\a\\b')
  })

  it('never offers a drive, a share, or a folder that is or holds the home folder, the profile or a system folder', () => {
    expect(unsafeFolder('D:\\', GUARDED)).toMatch(/whole drive/)
    expect(unsafeFolder('D:', GUARDED)).toMatch(/whole drive/)
    expect(unsafeFolder('\\\\server\\share', GUARDED)).toMatch(/network share/)
    expect(unsafeFolder('\\\\server\\share\\work', GUARDED)).toBeNull()
    expect(unsafeFolder('C:\\Users\\Dev', GUARDED)).toMatch(/home folder/)
    expect(unsafeFolder('C:\\Users', GUARDED)).toMatch(/home folder/)
    expect(unsafeFolder('c:\\users\\dev\\appdata\\local\\', GUARDED)).toMatch(/home folder/)
    expect(unsafeFolder('C:\\Windows', GUARDED)).toMatch(/system/)
    expect(unsafeFolder('relative\\path', GUARDED)).toMatch(/absolute/)
    // Inside the home folder is fine: a workspace, or the test area under %LOCALAPPDATA%.
    expect(unsafeFolder('C:\\Users\\Dev\\work', GUARDED)).toBeNull()
    expect(unsafeFolder('C:\\Users\\Dev\\AppData\\Local\\hive-test', GUARDED)).toBeNull()
  })

  it('the folder set: resolved paths, duplicates dropped, unsafe ones marked, an unresolved root failing closed', () => {
    // A workspace that is a junction to a drive root resolves to it: never offered.
    expect(folderPlan({ root: 'E:\\', trees: null, tests: null }, GUARDED)).toEqual([{ path: 'E:\\', kind: 'workspace', unsafe: 'a whole drive' }])
    expect(folderPlan({ root: 'C:\\Users\\Dev', trees: 'C:\\Users\\Dev.worktrees', tests: null }, GUARDED).map((f) => [f.kind, !!f.unsafe])).toEqual([['workspace', true], ['worktrees', false]])
    expect(folderPlan({ root: null, rootUnresolved: 'D:\\gone', trees: null, tests: null }, GUARDED)).toEqual([{ path: 'D:\\gone', kind: 'workspace', unsafe: 'its real location couldn’t be established' }])
    // The test area resolving to the workspace itself is listed once.
    expect(folderPlan({ root: 'D:\\W', trees: null, tests: 'd:\\w\\' }, GUARDED)).toEqual([{ path: 'D:\\W', kind: 'workspace' }])
  })

  it('Hive’s test area is for people developing Hive only: a dev build, or a workspace holding Hive’s repository', () => {
    expect([testsEligible({ packaged: false, holdsHive: false }), testsEligible({ packaged: true, holdsHive: true }), testsEligible({ packaged: true, holdsHive: false })]).toEqual([true, true, false])
  })

  it('Defender with real-time protection and a hidden list: every folder unknown, and the workspace likely slowed', () => {
    const s = status(probe())
    expect([s.scan, s.realTime, s.exclusionsFrom, s.slowed]).toEqual(['defender', true, null, true])
    expect(s.paths.map((p) => [p.kind, p.state, p.devDrive])).toEqual([['workspace', 'unknown', 'no'], ['worktrees', 'unknown', 'no'], ['tests', 'unknown', 'no']])
    expect(s.offerKey).toBe('c:\\users\\dev\\appdata\\local\\hive-test|d:\\development\\hive|d:\\development\\hive.worktrees')
  })

  it('an unsafe folder is listed but never offered or counted', () => {
    const s = status(probe(), { folders: [{ path: 'D:\\', kind: 'workspace', unsafe: 'a whole drive' }] })
    expect([s.paths[0].unsafe, s.slowed, s.offerKey]).toEqual(['a whole drive', false, ''])
  })

  it('a visible list says which folders are excluded; all of them excluded is not slowed', () => {
    const some = status(probe({ exclusions: ['D:\\Development\\HIVE'] }))
    expect([some.exclusionsFrom, some.paths.map((p) => p.state), some.slowed]).toEqual(['live', ['excluded', 'not-excluded', 'not-excluded'], true])
    const all = status(probe({ exclusions: ['D:\\Development', 'C:\\Users\\Dev\\AppData\\Local\\hive-test'] }))
    expect([all.paths.every((p) => p.state === 'excluded'), all.slowed, all.offerKey]).toEqual([true, false, ''])
  })

  it('with the list hidden: what Hive added counts as excluded (unconfirmed), and an administrator check is used', () => {
    const added = status(probe(), { added: folders.map((f) => f.path.toUpperCase()) })
    expect([added.paths.map((p) => [p.state, p.addedByHive]), added.slowed]).toEqual([[['added', true], ['added', true], ['added', true]], false])
    const checked = status(probe(), { adminCheck: { at: '2026-10-06T17:00:00Z', exclusions: ['D:\\Development\\HIVE'] } })
    expect([checked.exclusionsFrom, checked.adminCheckedAt, checked.paths.map((p) => p.state)]).toEqual(['admin-check', '2026-10-06T17:00:00Z', ['excluded', 'not-excluded', 'not-excluded']])
    expect(status(probe({ exclusions: [] }), { adminCheck: { at: 'x', exclusions: ['D:\\Development'] } }).paths[0].state).toBe('not-excluded')
  })

  it('Dev Drive: ReFS is only a maybe; only a trusted Dev Drive (checked with administrator rights) in performance mode isn’t slowed', () => {
    const refs = status(probe({ volumes: [{ drive: 'D', fs: 'ReFS' }, { drive: 'C', fs: 'ReFS' }] }))
    expect([refs.paths.map((p) => p.devDrive), refs.slowed]).toEqual([['refs', 'refs', 'refs'], true])
    const trusted = { at: 'x', exclusions: [], devDrives: { D: 'trusted' as const, C: 'trusted' as const } }
    expect(status(probe({ perfMode: 0 }), { adminCheck: trusted }).slowed).toBe(false)
    // Performance mode off, or an untrusted Dev Drive: scanned like any other.
    expect(status(probe({ perfMode: 1 }), { adminCheck: trusted }).slowed).toBe(true)
    expect(status(probe({ perfMode: 0 }), { adminCheck: { ...trusted, devDrives: { D: 'untrusted', C: 'untrusted' } } }).paths.map((p) => p.devDrive)).toEqual(['untrusted', 'untrusted', 'untrusted'])
    expect(status(probe({ perfMode: 0 }), { adminCheck: { ...trusted, devDrives: { D: 'untrusted', C: 'untrusted' } } }).slowed).toBe(true)
    expect(status(probe({ volumes: [] })).paths[0].devDrive).toBe('unknown')
    // fsutil devdrv query's answers.
    expect([devDriveOf('This is a trusted developer volume.\r\n'), devDriveOf('This is a developer volume, but it is not trusted.'), devDriveOf('This is not a developer volume.'), devDriveOf('Error 5: Access is denied.'), devDriveOf(null)]).toEqual(['trusted', 'untrusted', 'no', null, null])
  })

  it('another antivirus active, Defender passive or off, real-time off, or nothing readable: Hive offers nothing', () => {
    const other = status(probe({ defender: { antivirus: true, realTime: true, mode: 'Passive Mode' }, products: [{ name: 'Windows Defender', state: DEFENDER_OFF }, { name: 'Norton Security', state: NORTON_ON }] }))
    expect([other.scan, other.others, other.slowed, other.realTime]).toEqual(['other', ['Norton Security'], false, null])
    expect(status(probe({ defender: { antivirus: false, realTime: false, mode: 'Normal' }, products: [{ name: 'Windows Defender', state: DEFENDER_OFF }] })).scan).toBe('none')
    const off = status(probe({ defender: { antivirus: true, realTime: false, mode: 'Normal' } }))
    expect([off.scan, off.realTime, off.slowed]).toEqual(['defender', false, false])
    expect(status({ defender: null, products: null }).scan).toBe('unavailable')
    expect(emptyStatus('D:\\W', 'test-copy', folders, now)).toMatchObject({ scan: 'test-copy', slowed: false, paths: [{ state: 'unknown' }, { state: 'unknown' }, { state: 'unknown' }] })
  })

  it('an elevated change: declined, failing to start, refused by Defender or by policy, or done', () => {
    const ws = 'D:\\Development\\HIVE'
    const trees = 'D:\\Development\\HIVE.worktrees'
    expect(changeOutcome('add', { started: false, cancelled: true }, null).outcome).toBe('refused')
    expect(changeOutcome('add', { started: false, error: 'boom' }, null)).toMatchObject({ outcome: 'error', message: expect.stringContaining('boom') })
    expect(changeOutcome('add', { started: true }, null).outcome).toBe('error')
    expect(changeOutcome('add', { started: true }, { ok: false, error: 'Operation failed with the following error: 0x800106ba', requested: [ws], listed: true, exclusions: [] }).outcome).toBe('policy')
    expect(changeOutcome('add', { started: true }, { ok: false, error: 'Something else', requested: [ws], listed: true, exclusions: [] }).outcome).toBe('error')
    const done = changeOutcome('add', { started: true }, { ok: true, requested: [ws, trees], listed: true, exclusions: ['d:\\development\\hive', trees, 'E:\\Other'] })
    expect(done).toMatchObject({ outcome: 'done', added: [ws, trees], exclusions: ['d:\\development\\hive', trees, 'E:\\Other'] })
    // Accepted but not listed afterwards: a policy keeps local exclusions from applying; only what is listed counts as added.
    expect(changeOutcome('add', { started: true }, { ok: true, requested: [ws, trees], listed: true, exclusions: [ws] })).toMatchObject({ outcome: 'policy', added: [ws] })
    expect(changeOutcome('remove', { started: true }, { ok: true, requested: [ws], listed: true, exclusions: ['E:\\Other'] })).toMatchObject({ outcome: 'done', removed: [ws] })
    expect(changeOutcome('remove', { started: true }, { ok: true, requested: [ws], listed: true, exclusions: [ws] }).outcome).toBe('policy')
    expect(changeOutcome('check', { started: true }, { ok: true, listed: true, exclusions: 'D:\\Development', devDrives: { D: 'This is a trusted developer volume.', z: 'x', E: 'Access is denied' } })).toMatchObject({ outcome: 'done', exclusions: ['D:\\Development'], devDrives: { D: 'trusted' } })
  })

  it('pre-existing exclusions are the user’s: Add asks only for what isn’t covered, and only what Defender lists afterwards counts as Hive’s', () => {
    // The elevated script found the workspace's parent already excluded: it asked for nothing.
    expect(changeOutcome('add', { started: true }, { ok: true, requested: [], listed: true, exclusions: ['D:\\Development'] })).toMatchObject({ outcome: 'done', message: expect.stringContaining('already'), exclusions: ['D:\\Development'] })
    expect(changeOutcome('add', { started: true }, { ok: true, requested: [], listed: true, exclusions: ['D:\\Development'] }).added).toBeUndefined()
    // A partial failure: Defender listed one of the two before failing.
    const partial = changeOutcome('add', { started: true }, { ok: false, error: 'Something else', requested: ['D:\\A', 'D:\\B'], listed: true, exclusions: ['D:\\A'] })
    expect([partial.outcome, partial.added]).toEqual(['error', ['D:\\A']])
  })

  it('a list that wasn’t read afterwards stays unknown: no administrator list, nothing counted as added', () => {
    const failed = changeOutcome('add', { started: true }, { ok: false, error: 'Something else', requested: ['D:\\A'] })
    expect([failed.exclusions, failed.added]).toEqual([undefined, undefined])
    const unread = changeOutcome('add', { started: true }, { ok: true, requested: ['D:\\A'], listed: false, exclusions: [] })
    expect([unread.outcome, unread.exclusions, unread.added]).toEqual(['error', undefined, undefined])
    expect(changeOutcome('check', { started: true }, { ok: true, listed: true, exclusions: [1, 2] }).exclusions).toBeUndefined()
  })
})

describe('antivirus: Defender’s hidden-list answer (#316 round 3)', () => {
  const HIDDEN = 'N/A: Must be an administrator to view exclusions'
  it('is unknown whichever read produced it; a genuinely empty list is a list', () => {
    expect([readableList([HIDDEN]), readableList(HIDDEN), readableList([' n/a: hidden ']), readableList([]), readableList(['D:\\A'])]).toEqual([null, null, null, [], ['D:\\A']])
    // An administrator check that came back redacted: no list, nothing to keep.
    const check = changeOutcome('check', { started: true }, { ok: true, listed: true, exclusions: [HIDDEN] })
    expect([check.outcome, check.exclusions]).toEqual(['error', undefined])
    // A change refused because the starting list was redacted: nothing claimed, nothing kept.
    const add = changeOutcome('add', { started: true }, { ok: false, error: "Defender's exclusions couldn't be read even with administrator rights, so nothing was changed.", requested: [], listed: true, exclusions: [HIDDEN] })
    expect([add.outcome, add.exclusions, add.added]).toEqual(['error', undefined, undefined])
  })

  it('a kept administrator read holding it doesn’t turn unknown folders into scanned ones', () => {
    const s = status(probe(), { adminCheck: { at: 'x', exclusions: [HIDDEN] } })
    expect([s.exclusionsFrom, s.paths.map((p) => p.state)]).toEqual([null, ['unknown', 'unknown', 'unknown']])
    expect(status(probe(), { adminCheck: { at: 'x', exclusions: [] } }).paths.map((p) => p.state)).toEqual(['not-excluded', 'not-excluded', 'not-excluded'])
  })
})

describe('antivirus scripts (#316)', () => {
  // Parsed by PowerShell's own parser, never run: a syntax error would only show on a user's machine otherwise.
  it.skipIf(process.platform !== 'win32')('the probe, the elevated change and its launcher are valid PowerShell, with awkward paths quoted', async () => {
    const { probeScript, elevatedScript, launcherScript } = await import('../src/main/antivirus')
    const { spawnSync } = await import('child_process')
    const odd = ["D:\\It's here\\$env:X", 'C:\\Users\\Dév\\`tick`; Remove-Item x']
    for (const script of [probeScript(['C', 'D']), elevatedScript('add', odd, ['C', 'D'], 'C:\\Temp\\o.json'), launcherScript(elevatedScript('remove', odd, ['D'], 'C:\\Temp\\o.json'))]) {
      const b64 = Buffer.from(script, 'utf16le').toString('base64')
      const parse = `$s = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${b64}')); $e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($s, [ref]$null, [ref]$e); $e.Count`
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', parse], { encoding: 'utf8', windowsHide: true })
      expect(r.stdout.trim()).toBe('0')
    }
    // The paths are single-quoted literals: nothing in them is expanded or run.
    expect(elevatedScript('add', odd, [], 'o')).toContain("'D:\\It''s here\\$env:X'")
  })
})
