import { useCallback, useEffect, useRef, useState } from 'react'
import type { CleanupItem, CleanupOptions, ProjectStorage, WorkspaceStorage } from '@shared/types'
import { DEFAULT_CLEANUP, formatSize } from '@shared/storage'
import { call, errorMessage } from '../api'
import { notify, openProjectSettings, useStore } from '../store'
import { cx, timeAgo } from '../util'
import { BusyButton, Icon, LoadFailed, Modal, useBusy } from './ui'

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/**
 * Measuring walks every file of every worktree, so the page abandons a call it no longer waits for (a newer one, the page
 * closed) and Hive stops measuring what nothing else waits for. `start` sends the call with its request; the earlier
 * one is abandoned after it, so a measurement both wait for carries on. `current` says whether a call is still the latest.
 */
function useStorageRequests(): <T>(start: (request: string) => Promise<T>) => { result: Promise<T>; current: () => boolean } {
  const latest = useRef<string | null>(null)
  useEffect(
    () => () => {
      if (latest.current) void call('storage:abandon', latest.current).catch(() => undefined)
      latest.current = null
    },
    []
  )
  return useCallback(<T,>(start: (request: string) => Promise<T>) => {
    const request = crypto.randomUUID()
    const result = start(request)
    if (latest.current) void call('storage:abandon', latest.current).catch(() => undefined)
    latest.current = request
    return { result, current: () => latest.current === request }
  }, [])
}

/** Project Settings → Storage (and the Assistant's in Settings → Workspace): what Hive keeps, Refresh and Clean Up…. */
export function StorageView({ path }: { path: string }) {
  const [data, setData] = useState<ProjectStorage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const request = useStorageRequests()
  const load = useCallback(
    (refresh: boolean) => {
      setMeasuring(true)
      setError(null)
      const { result, current } = request((r) => call('storage:project', path, refresh, r))
      result.then(
        (d) => current() && setData(d),
        (e) => current() && setError(errorMessage(e))
      ).finally(() => current() && setMeasuring(false))
    },
    [path, request]
  )
  useEffect(() => {
    setData(null)
    load(false)
  }, [load])

  if (error) return <LoadFailed inline what="the storage sizes" error={error} onRetry={() => load(true)} />
  const rows: { label: string; where: string; bytes: number }[] = data
    ? [
        { label: 'Transcript backups', where: '.hive/sessions', bytes: data.sessions },
        { label: 'Archive', where: '.hive/archive', bytes: data.archive },
        { label: 'Images', where: '.hive/images', bytes: data.images },
        ...data.worktrees.map((w) => ({ label: `${w.agent}'s worktree`, where: w.path, bytes: w.bytes }))
      ]
    : []
  return (
    <div className="storage">
      {!data ? (
        <div className="faint">
          <Icon name="loading" spin /> Measuring…
        </div>
      ) : (
        <table className="table storage-table">
          <tbody>
            {rows.map((r) => (
              <tr key={r.where}>
                <td>
                  {r.label} <span className="faint small mono">{r.where}</span>
                </td>
                <td className="num">{formatSize(r.bytes)}</td>
              </tr>
            ))}
            <tr className="storage-total">
              <td>Total</td>
              <td className="num">{formatSize(data.total)}</td>
            </tr>
          </tbody>
        </table>
      )}
      <div className="storage-actions">
        <span className="faint small">{measuring ? (data ? 'Measuring again…' : '') : data ? `Measured ${timeAgo(data.computedAt)}` : ''}</span>
        <button className="btn subtle small" disabled={measuring} onClick={() => load(true)}>
          <Icon name="refresh" /> Refresh
        </button>
        <button className="btn small" disabled={!data} onClick={() => setCleaning(true)}>
          <Icon name="trash" /> Clean Up…
        </button>
      </div>
      {cleaning && data && (
        <CleanupDialog
          path={path}
          name={data.name}
          onClose={() => setCleaning(false)}
          onDone={() => {
            setCleaning(false)
            load(true)
          }}
        />
      )}
    </div>
  )
}

const KIND_LABEL: Record<CleanupItem['kind'], string> = {
  'archived-images': 'Images of archived sessions',
  'orphan-images': 'Images of deleted sessions',
  'archived-backup': "Backups of archived sessions (the CLI still has them)",
  'gone-backup': 'Last copies of archived sessions (deletes them)'
}

/** A days field that commits a whole number from 1 to 3650 (keeps the last good one while typing). */
function DaysInput({ value, disabled, onChange, label }: { value: number; disabled: boolean; onChange: (n: number) => void; label: string }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  return (
    <input
      className="input days-input"
      type="number"
      min={1}
      max={3650}
      aria-label={label}
      disabled={disabled}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value)
        const n = Math.floor(Number(e.target.value))
        if (n >= 1 && n <= 3650) onChange(n)
      }}
    />
  )
}

/** Clean Up…: choose what goes, see exactly which files and how much, then move them to the Recycle Bin. */
export function CleanupDialog({ path, name, onClose, onDone }: { path: string; name: string; onClose: () => void; onDone: () => void }) {
  const [imagesOn, setImagesOn] = useState(DEFAULT_CLEANUP.archivedImagesDays !== null)
  const [imageDays, setImageDays] = useState(DEFAULT_CLEANUP.archivedImagesDays ?? 90)
  const [orphans, setOrphans] = useState(DEFAULT_CLEANUP.orphanImages)
  const [backupsOn, setBackupsOn] = useState(DEFAULT_CLEANUP.archivedBackupsDays !== null)
  const [backupDays, setBackupDays] = useState(DEFAULT_CLEANUP.archivedBackupsDays ?? 90)
  const [gone, setGone] = useState(DEFAULT_CLEANUP.goneBackups)
  const [items, setItems] = useState<CleanupItem[] | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const action = useBusy()
  const opts: CleanupOptions = { archivedImagesDays: imagesOn ? imageDays : null, orphanImages: orphans, archivedBackupsDays: backupsOn ? backupDays : null, goneBackups: gone }
  const key = JSON.stringify(opts)

  // The preview follows the options (a moment after the last change).
  useEffect(() => {
    let live = true
    setItems(null)
    setPreviewError(null)
    const t = setTimeout(() => {
      call('storage:cleanupPreview', path, JSON.parse(key) as CleanupOptions).then(
        (r) => live && setItems(r),
        (e) => live && setPreviewError(errorMessage(e))
      )
    }, 250)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [path, key])

  const total = items?.reduce((n, i) => n + i.bytes, 0) ?? 0
  const go = async (): Promise<void> => {
    if (!items?.length) return
    const r = await action.run('clean', () => call('storage:cleanup', path, opts, items.map((i) => i.path)))
    if (!r) return
    const { removed, bytes, skipped } = r.value
    notify(removed ? 'success' : 'info', removed ? `Moved ${plural(removed, 'item')} (${formatSize(bytes)}) to the Recycle Bin` : 'Nothing was removed', skipped.length ? `${plural(skipped.length, 'item')} skipped:\n${skipped.join('\n')}` : undefined)
    onDone()
  }

  const busy = !!action.busy
  const option = (on: boolean, set: (v: boolean) => void, title: React.ReactNode, desc: string, danger = false) => (
    <label className={cx('choice', on && 'selected', danger && on && 'danger')}>
      <input type="checkbox" checked={on} disabled={busy} onChange={(e) => set(e.target.checked)} />
      <div>
        <strong>{title}</strong>
        <div className="faint">{desc}</div>
      </div>
    </label>
  )
  const groups = (Object.keys(KIND_LABEL) as CleanupItem['kind'][]).map((k) => ({ kind: k, list: items?.filter((i) => i.kind === k) ?? [] })).filter((g) => g.list.length)

  return (
    <Modal
      title={`Clean Up ${name}`}
      icon="trash"
      wide
      onClose={onClose}
      busy={busy}
      error={action.error}
      footer={
        <>
          <button className="btn subtle" onClick={onClose}>
            Cancel
          </button>
          <BusyButton className={gone ? 'danger' : 'primary'} disabled={!items?.length} busy={action.busy === 'clean'} busyLabel="Moving to the Recycle Bin…" onClick={() => void go()}>
            {items?.length ? `Move ${plural(items.length, 'item')} (${formatSize(total)}) to the Recycle Bin` : 'Move to the Recycle Bin'}
          </BusyButton>
        </>
      }
    >
      <p className="faint" style={{ marginTop: 0 }}>
        Running sessions and sessions that aren't archived are never touched, nor the coding agents' own transcripts (in ~/.claude and ~/.codex). What the sessions used still counts in the totals.
      </p>
      <div className="choice-list cleanup-options">
        {option(
          imagesOn,
          setImagesOn,
          <>
            Images of archived sessions last active more than <DaysInput label="Image age in days" value={imageDays} disabled={busy || !imagesOn} onChange={setImageDays} /> days ago
          </>,
          'Images pasted or dropped into those sessions (.hive/images).'
        )}
        {option(orphans, setOrphans, 'Images of deleted sessions', "Images whose session was deleted, or whose launch never got a session (folders named run-…).")}
        {option(
          backupsOn,
          setBackupsOn,
          <>
            Hive's backups of archived sessions last active more than <DaysInput label="Backup age in days" value={backupDays} disabled={busy || !backupsOn} onChange={setBackupDays} /> days ago
          </>,
          "Only where Claude Code or Codex still has the transcript: the session stays, and can be resumed and read from the CLI's copy for as long as the CLI keeps it."
        )}
        {option(gone, setGone, "Backups of archived sessions the CLI no longer has", "Hive's copy is the last one: the sessions are deleted, as Delete Session does.", true)}
      </div>
      {gone && (
        <div className="banner danger">
          <Icon name="warning" /> These sessions can't be resumed or read afterwards: Hive's backup is the only copy left. They leave the Sessions tab; what they used still counts in the totals.
        </div>
      )}
      <div className="agent-dialog-h">What goes to the Recycle Bin</div>
      {previewError ? (
        <div className="field-error">{previewError}</div>
      ) : !items ? (
        <div className="faint">
          <Icon name="loading" spin /> Looking…
        </div>
      ) : !items.length ? (
        <div className="faint">Nothing matches.</div>
      ) : (
        <div className="cleanup-preview">
          {groups.map((g) => (
            <div key={g.kind}>
              <div className="cleanup-kind">
                {KIND_LABEL[g.kind]} <span className="faint">· {plural(g.list.length, 'item')}, {formatSize(g.list.reduce((n, i) => n + i.bytes, 0))}</span>
              </div>
              <table className="table">
                <tbody>
                  {g.list.map((i) => (
                    <tr key={i.path} title={i.path}>
                      <td>
                        {i.label} <span className="faint small mono">{i.path.split(/[\\/]/).slice(-2).join('/')}</span>
                      </td>
                      <td className="num">{formatSize(i.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

/** Settings → Workspace: the workspace's total and its biggest projects, each linked to its Storage page. */
export function WorkspaceStorageList() {
  const workspace = useStore((s) => s.workspace?.path ?? null)
  const [data, setData] = useState<WorkspaceStorage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const request = useStorageRequests()
  const load = useCallback(
    (refresh: boolean) => {
      if (!workspace) return
      setMeasuring(true)
      setError(null)
      const { result, current } = request((r) => call('storage:workspace', refresh, r))
      result
        .then(
          (d) => current() && setData(d),
          (e) => current() && setError(errorMessage(e))
        )
        .finally(() => current() && setMeasuring(false))
    },
    [workspace, request]
  )
  useEffect(() => {
    setData(null)
    load(false)
  }, [load])
  if (!workspace) return <div className="faint">Open a workspace to see what Hive keeps for it.</div>
  if (error) return <LoadFailed inline what="the storage sizes" error={error} onRetry={() => load(true)} />
  const assistant = data?.projects.find((p) => p.assistant)
  return (
    <div className="storage">
      {!data ? (
        <div className="faint">
          <Icon name="loading" spin /> Measuring the projects…
        </div>
      ) : (
        <table className="table storage-table">
          <tbody>
            {data.projects.slice(0, 8).map((p) => (
              <tr key={p.path}>
                <td>{p.assistant ? 'Hive Assistant' : p.name}</td>
                <td className="num">{formatSize(p.total)}</td>
                <td className="actions">
                  {p.assistant ? (
                    <button className="btn small subtle" onClick={() => setAssistantOpen((o) => !o)}>
                      {assistantOpen ? 'Hide' : 'Storage'}
                    </button>
                  ) : (
                    <button className="btn small subtle" onClick={() => openProjectSettings(p.path, 'storage')}>
                      Storage
                    </button>
                  )}
                </td>
              </tr>
            ))}
            <tr className="storage-total">
              <td>
                Workspace{data.projects.length > 8 ? <span className="faint"> ({plural(data.projects.length - 8, 'smaller project')} not shown)</span> : null}
              </td>
              <td className="num">{formatSize(data.total)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      )}
      <div className="storage-actions">
        <span className="faint small">{measuring && data ? 'Measuring again…' : ''}</span>
        <button className="btn subtle small" disabled={measuring} onClick={() => load(true)}>
          <Icon name="refresh" /> Refresh
        </button>
      </div>
      {assistantOpen && assistant && (
        <div className="storage-assistant">
          <div className="agent-dialog-h">Hive Assistant</div>
          <StorageView path={assistant.path} />
        </div>
      )}
    </div>
  )
}
