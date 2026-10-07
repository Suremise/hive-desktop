import { useCallback, useEffect, useRef, useState } from 'react'
import { DEV_DRIVE_URL, KIND_LABEL, type AntivirusStatus, type AvAction, type AvChangeResult, type AvDevDrive, type AvPath } from '@shared/antivirus'
import { formatDateTime } from '@shared/dates'
import { call, errorMessage } from '../api'
import { confirm, get, pushToast, set, setActivity, useStore } from '../store'
import { cx, timeAgo } from '../util'
import { Icon, LoadFailed } from './ui'

/**
 * Antivirus scanning of the workspace (#316; main/antivirus.ts): whether Microsoft Defender scans the folders Hive's work
 * goes through, the exclusions Hive can add (with consent, one UAC prompt) and remove, and Dev Drive. Settings →
 * Workspace shows it in full; Performance says when scanning likely slows the workspace; the window suggests it once
 * when it matters. Answers for a workspace the window no longer shows are dropped.
 */

const STATE: Record<AvPath['state'], { label: string; tone: string; tip: string }> = {
  excluded: { label: 'Excluded', tone: 'good-text', tip: 'Defender doesn’t scan it.' },
  'not-excluded': { label: 'Scanned', tone: 'warn-text', tip: 'Defender scans every file Hive’s work creates or opens here.' },
  unknown: { label: 'Unknown', tone: 'faint', tip: 'Defender shows its exclusions only to administrators: Check with administrator rights to see them.' },
  added: { label: 'Added by Hive', tone: 'good-text', tip: 'Hive added this exclusion; Defender hides its list without administrator rights, so it isn’t confirmed.' }
}

const DEV_DRIVE: Record<AvDevDrive, { label: string; tip: string }> = {
  trusted: { label: 'yes, trusted', tip: 'A trusted Dev Drive: with Defender’s performance mode on, it is scanned much more lightly.' },
  untrusted: { label: 'yes, not trusted', tip: 'A Dev Drive that isn’t trusted: Defender scans it like any other drive.' },
  refs: { label: 'maybe (ReFS)', tip: 'A ReFS volume, as Dev Drives are. Only a check with administrator rights can tell whether it is a trusted Dev Drive.' },
  no: { label: 'no', tip: 'Not a Dev Drive.' },
  unknown: { label: 'unknown', tip: 'Its volume couldn’t be read.' }
}

/** One line saying what scans the workspace. */
function scanLine(s: AntivirusStatus): string {
  switch (s.scan) {
    case 'defender':
      return s.realTime ? 'Microsoft Defender scans files as they are created and opened (real-time protection is on).' : 'Microsoft Defender is the antivirus, with real-time protection off: it doesn’t slow Hive’s work now.'
    case 'other':
      return `Another antivirus is active (${s.others.join(', ')}). Hive can only manage Microsoft Defender: see its own settings for exclusions.`
    case 'none':
      return 'No active antivirus was found.'
    case 'not-applicable':
      return 'Only Windows has Defender to check.'
    case 'test-copy':
      return 'A test copy of Hive: it never asks Defender.'
    default:
      return `Hive couldn’t read Defender’s status${s.error ? `: ${s.error}` : '.'}`
  }
}

/** Settings → Workspace: the status, each folder's, and the actions. */
export function AntivirusPanel() {
  const workspace = useStore((s) => s.workspace?.path ?? null)
  const [status, setStatus] = useState<AntivirusStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<AvChangeResult | null>(null)
  const latest = useRef(0)
  // Each answer applies only if nothing newer was asked and the window still shows the workspace it was asked for.
  const current = (n: number, ws: string | null): boolean => n === latest.current && get().workspace?.path === ws
  const load = useCallback((refresh: boolean) => {
    const n = ++latest.current
    const ws = get().workspace?.path ?? null
    const now = (): boolean => n === latest.current && get().workspace?.path === ws
    setChecking(true)
    setError(null)
    call('antivirus:status', refresh)
      .then((s) => now() && setStatus(s), (e) => now() && setError(errorMessage(e)))
      .finally(() => now() && setChecking(false))
  }, [])
  useEffect(() => {
    latest.current++
    setStatus(null)
    setResult(null)
    setChecking(false)
    if (workspace) load(false)
  }, [workspace, load])

  const change = async (action: AvAction): Promise<void> => {
    const n = ++latest.current
    const ws = get().workspace?.path ?? null
    setChecking(true)
    setResult(null)
    try {
      // Main works out exactly what would change; the user confirms that, and only that is run.
      const op = await call('antivirus:prepare', action)
      if (!current(n, ws)) return
      if (action !== 'check') {
        const ok = await confirm(
          action === 'add'
            ? {
                title: 'Stop Defender scanning these folders?',
                message: 'Hive asks Defender to exclude:',
                list: op.paths,
                detail: 'Defender won’t scan anything in them, including node_modules and whatever agents download there. Windows asks for administrator rights once. You can remove them again here.',
                confirmLabel: 'Add Exclusions'
              }
            : { title: 'Remove the exclusions Hive added?', message: 'Hive asks Defender to scan again:', list: op.paths, detail:'Defender scans these folders again. Exclusions Hive didn’t add stay. Windows asks for administrator rights once.', confirmLabel: 'Remove Exclusions' }
        )
        if (!ok || !current(n, ws)) return
      }
      const r = await call('antivirus:apply', op.id)
      if (!current(n, ws)) return
      setResult(r.result)
      if (r.status) setStatus(r.status)
    } catch (e) {
      if (current(n, ws)) setResult({ outcome: 'error', message: errorMessage(e) })
    } finally {
      if (current(n, ws)) setChecking(false)
    }
  }

  if (!workspace) return <div className="faint">Open a workspace to check how Defender treats it.</div>
  if (error && !status) return <LoadFailed inline what="the antivirus status" error={error} onRetry={() => load(true)} />
  if (!status)
    return (
      <div className="faint">
        <Icon name="loading" spin /> Checking Defender…
      </div>
    )
  const defender = status.scan === 'defender'
  const offerable = status.paths.filter((p) => !p.unsafe)
  const toAdd = offerable.filter((p) => p.state !== 'excluded')
  const hiveAdded = offerable.some((p) => p.addedByHive)
  return (
    <div className="antivirus">
      <p className={cx('antivirus-scan', status.slowed && 'warn-text')}>
        <Icon name={status.slowed ? 'warning' : defender || status.scan === 'other' ? 'shield' : 'info'} /> {scanLine(status)}
      </p>
      {status.paths.length > 0 && status.scan !== 'not-applicable' && status.scan !== 'test-copy' && (
        <div className="table-wrap">
          <table className="table antivirus-folders">
            <thead>
              <tr>
                <th>Folder</th>
                <th>Scanning</th>
                <th>Dev Drive</th>
              </tr>
            </thead>
            <tbody>
              {status.paths.map((p) => (
                <tr key={p.path}>
                  <td>
                    {KIND_LABEL[p.kind]} <span className="faint small mono">{p.path}</span>
                    {p.unsafe && <div className="warn-text small">Not offered: {p.unsafe}.</div>}
                  </td>
                  <td className="nowrap">
                    <span className={STATE[p.state].tone} title={STATE[p.state].tip}>
                      {STATE[p.state].label}
                    </span>
                  </td>
                  <td className="nowrap faint" title={DEV_DRIVE[p.devDrive].tip}>
                    {DEV_DRIVE[p.devDrive].label}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {defender && (
        <p className="hint">
          {status.exclusionsFrom === 'live'
            ? 'As Defender lists its exclusions now.'
            : status.exclusionsFrom === 'admin-check'
              ? `As Defender listed its exclusions with administrator rights, ${formatDateTime(status.adminCheckedAt!)}.`
              : 'Defender shows its exclusions only to administrators, so Hive can’t see them without asking.'}{' '}
          Excluded folders aren’t scanned at all, so only exclude folders whose contents you trust. A trusted Dev Drive, with Defender’s performance mode{status.performanceMode === null ? '' : status.performanceMode ? ' (on here)' : ' (off here)'}, is the alternative Microsoft recommends for code.
        </p>
      )}
      {result && <p className={cx('antivirus-result', result.outcome === 'done' ? 'good-text' : 'warn-text')}>{result.message}</p>}
      <div className="storage-actions">
        <span className="faint small">{checking ? 'Checking…' : `Checked ${timeAgo(status.checkedAt)}`}</span>
        <button className="btn subtle small" disabled={checking} onClick={() => load(true)}>
          <Icon name="refresh" /> Check Again
        </button>
        {defender && (
          <button className="btn subtle small" disabled={checking} onClick={() => void change('check')}>
            <Icon name="shield" /> Check with Administrator Rights…
          </button>
        )}
        {defender && hiveAdded && (
          <button className="btn subtle small" disabled={checking} onClick={() => void change('remove')}>
            <Icon name="discard" /> Remove Hive’s Exclusions…
          </button>
        )}
        {defender && toAdd.length > 0 && (
          <button className="btn small" disabled={checking} onClick={() => void change('add')}>
            <Icon name="shield" /> Add Exclusions…
          </button>
        )}
        {(defender || status.scan === 'none') && (
          <button className="btn subtle small" onClick={() => void call('app:openExternal', DEV_DRIVE_URL)}>
            <Icon name="link-external" /> About Dev Drive
          </button>
        )}
      </div>
    </div>
  )
}

/** Shows Settings → Workspace, where the antivirus status is. */
export function showAntivirus(): void {
  set({ settingsSection: 'workspace', settingsQuery: '' })
  setActivity('settings')
}

/** Performance (the workspace): a line when Defender likely slows the workspace, linking to the status. */
export function AntivirusLine() {
  const workspace = useStore((s) => s.workspace?.path ?? null)
  const [status, setStatus] = useState<AntivirusStatus | null>(null)
  useEffect(() => {
    let live = true
    setStatus(null)
    if (workspace) call('antivirus:status', false).then((s) => live && setStatus(s), () => undefined)
    return () => {
      live = false
    }
  }, [workspace])
  if (!status?.slowed) return null
  return (
    <p className="hint perf-antivirus">
      <Icon name="shield" /> Microsoft Defender scans this workspace’s folders as Hive’s work changes them, which slows builds, tests and git. <a onClick={showAntivirus}>Antivirus scanning…</a>
    </p>
  )
}

/** Two or more agents running, or a command in the Progress panel that took this long: when scanning matters. */
const SLOW_RUN_MS = 2 * 60_000

type StoreState = ReturnType<typeof get>
const hostsOf = (s: StoreState) => [...(s.workspace?.projects ?? []), ...(s.workspace?.assistant ? [s.workspace.assistant] : [])]

/** A reminder's wait is checked at least this often, so a computer that slept doesn't push it back. */
const RECHECK_MS = 60 * 60_000

/**
 * Suggests the exclusions when scanning matters (#316): when several agents run at once, or a command in the Progress
 * panel took two minutes or more; and again, while that lasts, when an agent gets a worktree (its folder may be new).
 * Main decides (scanning slows the workspace, not declined for good, these folders not offered in the last day, #348)
 * and claims the offer: folders added since are suggested at once, the same ones again as a reminder at most once a day.
 * While agents keep running, the window asks again when main says a reminder may come; a long command is a reason once
 * (each new one asks again), not for a day later.
 */
export function useAntivirusOffer(): void {
  const workspace = useStore((s) => s.workspace?.path ?? null)
  const agents = useStore((s) => hostsOf(s).reduce((n, p) => n + p.agents.filter((a) => a.live && !a.live.settingUp).length, 0))
  // The workspace's worktree agents, as a count: a new one may have made the worktrees folder.
  const worktrees = useStore((s) => hostsOf(s).reduce((n, p) => n + p.agents.filter((a) => a.worktree).length, 0))
  // When the latest long command finished (0: none): each new one is a reason to ask.
  const slowRun = useStore((s) => s.progressRuns.reduce((t, r) => (r.finishedAt !== null && r.finishedAt - r.startedAt >= SLOW_RUN_MS ? Math.max(t, r.finishedAt) : t), 0))
  const reason = agents >= 2 ? 'agents' : slowRun ? 'slow' : null
  // Asks once per key: when the reason comes (back), the worktrees change, or another long command finishes.
  const key = workspace && reason ? `${workspace.toLowerCase()}|${reason}|${worktrees}|${reason === 'slow' ? slowRun : ''}` : null
  useEffect(() => {
    if (!key || !workspace || !reason) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const wait = (due: number): void => {
      timer = setTimeout(() => (Date.now() >= due ? ask() : wait(due)), Math.min(Math.max(due - Date.now(), 1000), RECHECK_MS))
    }
    const ask = (): void => {
      call('antivirus:suggestion').then(
        (r) => {
          // An answer for a workspace the window no longer shows is dropped. One that came after the reason went is
          // still shown (main has counted it), but asks nothing more.
          if (r.offer && get().workspace?.path === workspace) showOffer(r.offer.count, reason)
          if (live && reason === 'agents' && r.remindAt) wait(Date.parse(r.remindAt))
        },
        () => undefined
      )
    }
    ask()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [key, workspace, reason])
}

function showOffer(count: number, reason: 'agents' | 'slow'): void {
  const why = reason === 'agents' ? 'several agents are running' : 'a long command just ran'
  const reminder = count > 1
  pushToast({
    id: 'antivirus',
    level: 'info',
    title: reminder ? 'Defender is still scanning this workspace' : 'Defender is scanning this workspace',
    message: reminder
      ? `A reminder: Microsoft Defender still scans every file Hive’s work creates or opens (${why}). Excluding the workspace’s folders, or a Dev Drive, can make builds, tests and git much faster. Hive reminds you at most once a day; Don’t Ask Again stops it for this workspace.`
      : `Microsoft Defender scans every file Hive’s work creates or opens (${why}). Excluding the workspace’s folders, or a Dev Drive, can make builds, tests and git much faster.`,
    actions: [
      { label: 'Review…', command: 'antivirus.show' },
      { label: 'Don’t Ask Again', command: 'antivirus.dismiss' }
    ],
    timestamp: new Date().toISOString()
  })
}
