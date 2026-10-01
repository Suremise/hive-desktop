import { RELEASES_URL } from '@shared/defaults'
import type { UpdateState } from '@shared/types'
import { call } from '../api'
import { commandKeybinding } from '../commands'
import { set, useStore } from '../store'
import { cx, formatKeybinding, timeAgo } from '../util'
import { Icon, Markdown, Modal, Tooltip } from './ui'

const mb = (bytes?: number): string => (bytes ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : '')

/** Checks now and shows the result in the update dialog. */
export async function checkForUpdates(): Promise<void> {
  set({ updateOpen: true })
  set({ update: await call('update:check') })
}

export function openReleaseNotes(version?: string): void {
  void call('app:openExternal', version ? `${RELEASES_URL}/tag/v${version}` : RELEASES_URL)
}

/** One line describing the update state, for Settings and About. */
export function updateSummary(u: UpdateState | null): string {
  if (!u) return ''
  switch (u.status) {
    case 'disabled':
      return u.error ?? 'Updates are off in this build.'
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return u.skipped ? `Version ${u.version} is available (skipped).` : `Version ${u.version} is available.`
    case 'downloading':
      return `Downloading version ${u.version}… ${Math.round(u.progress?.percent ?? 0)}%`
    case 'ready':
      return `Version ${u.version} is ready to install.`
    case 'up-to-date':
      return `Up to date${u.checkedAt ? `, checked ${timeAgo(u.checkedAt)}` : ''}.`
    case 'error':
      return u.error ?? 'The last check failed.'
    default:
      return 'Not checked yet.'
  }
}

/** Hive's mark as a line drawing in the text colour (hexagon, prompt and cursor), like the status bar's other icons. */
function HiveMark() {
  return (
    <svg className="status-hex" viewBox="0 0 512 512" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="44" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="478,256 367,448 145,448 34,256 145,64 367,64" />
      <polyline points="170,190 246,256 170,322" />
      <line x1="280" y1="322" x2="348" y2="322" />
    </svg>
  )
}

/** The status bar's version item: plain when there is nothing new, otherwise what the update is doing. */
export function UpdateStatusItem() {
  const info = useStore((s) => s.appInfo)
  const u = useStore((s) => s.update)
  if (!info) return null
  const label = info.isPackaged ? `Hive ${info.version}` : `Hive Dev ${info.version}`
  const open = (): void => set({ updateOpen: true })
  if (u && !u.skipped && (u.status === 'available' || u.status === 'downloading' || u.status === 'ready')) {
    const text =
      u.status === 'available' ? `Hive ${u.version} available` : u.status === 'downloading' ? `Downloading Hive ${u.version}… ${Math.round(u.progress?.percent ?? 0)}%` : `Restart to update to ${u.version}`
    const tip = u.status === 'ready' ? `Hive ${u.version} has been downloaded. Click to see what's new and restart.` : `You have Hive ${info.version}. Click for details.`
    return (
      <Tooltip content={tip}>
        <div className={cx('status-item update-item', u.status === 'ready' && 'ready')} onClick={open}>
          <Icon name={u.status === 'downloading' ? 'loading' : u.status === 'ready' ? 'debug-restart' : 'cloud-download'} spin={u.status === 'downloading'} /> {text}
        </div>
      </Tooltip>
    )
  }
  return (
    <Tooltip content={`Hive ${info.version}${info.isPackaged ? '' : ' (development build)'} · Electron ${info.electron}${u && u.status !== 'disabled' ? ` · ${updateSummary(u)}` : ''}`}>
      <div className="status-item" onClick={() => set({ aboutOpen: true })}>
        {u?.status === 'checking' ? <Icon name="loading" spin /> : <HiveMark />} {label}
      </div>
    </Tooltip>
  )
}

export function UpdateDialog() {
  const open = useStore((s) => s.updateOpen)
  const u = useStore((s) => s.update)
  const settings = useStore((s) => s.settings)
  const working = useStore((s) => s.workspace?.projects.some((p) => p.agents.some((a) => a.live?.status === 'working' || a.live?.status === 'waiting' || a.live?.status === 'background')) ?? false)
  if (!open || !u) return null
  const close = (): void => set({ updateOpen: false })
  const auto = settings?.updates.install === 'auto'
  const title = u.status === 'ready' ? 'Update Ready' : u.status === 'available' || u.status === 'downloading' ? 'Update Available' : 'Software Update'

  let body: React.ReactNode
  let footer: React.ReactNode = (
    <button className="btn primary" onClick={close}>
      OK
    </button>
  )
  switch (u.status) {
    case 'checking':
    case 'idle':
      body = (
        <p className="update-line">
          <Icon name="loading" spin /> Checking for updates…
        </p>
      )
      break
    case 'up-to-date':
      body = (
        <p className="update-line">
          <Icon name="pass-filled" className="ok" /> Hive {u.current} is the latest version.
        </p>
      )
      break
    case 'disabled':
      body = (
        <p className="update-line">
          <Icon name="info" /> {u.error}
        </p>
      )
      break
    case 'error':
      body = (
        <p className="update-line">
          <Icon name="warning" className="warn" /> {u.error}
        </p>
      )
      footer = (
        <>
          <button className="btn subtle" onClick={() => openReleaseNotes()}>
            Releases Page
          </button>
          <button className="btn subtle" onClick={() => void checkForUpdates()}>
            Try Again
          </button>
          <button className="btn primary" onClick={close}>
            OK
          </button>
        </>
      )
      break
    default: {
      const pct = Math.round(u.progress?.percent ?? 0)
      body = (
        <>
          <div className="update-head">
            <Icon name={u.status === 'ready' ? 'debug-restart' : 'cloud-download'} />
            <div>
              <strong>
                {u.status === 'ready' ? `Hive ${u.version} is ready to install` : `Hive ${u.version} is available`}
                {u.releaseName && u.releaseName !== u.version && u.releaseName !== `v${u.version}` ? ` — ${u.releaseName}` : ''}
              </strong>
              <div className="faint">
                You have {u.current}
                {u.releaseDate ? ` · released ${new Date(u.releaseDate).toLocaleDateString()}` : ''}
                {u.size ? ` · ${mb(u.size)}` : ''}
              </div>
            </div>
          </div>
          {u.status === 'downloading' && (
            <div className="update-progress">
              <div className="bar">
                <span style={{ width: `${pct}%` }} />
              </div>
              <span className="faint">
                {pct}% · {mb(u.progress?.transferred)} of {mb(u.progress?.total || u.size)}
                {u.progress?.bytesPerSecond ? ` · ${mb(u.progress.bytesPerSecond)}/s` : ''}
              </span>
            </div>
          )}
          {u.releaseNotes ? (
            <div className="update-notes">
              <Markdown source={u.releaseNotes} />
            </div>
          ) : (
            <p className="faint">No release notes were published with this version.</p>
          )}
          {u.status === 'ready' && (
            <p className="faint update-note">
              {auto ? 'It installs automatically when you quit Hive. ' : ''}Restart and Update closes Hive, installs the update and opens Hive again.
              {working ? ' Some agents are busy: Hive asks before stopping them, and you can wait for them to finish.' : ' Running sessions are stopped and can be resumed afterwards.'}
            </p>
          )}
        </>
      )
      footer = (
        <>
          <button className="btn subtle" onClick={() => openReleaseNotes(u.version)}>
            <Icon name="link-external" /> On GitHub
          </button>
          {u.status === 'available' && !u.skipped && (
            <button
              className="btn subtle"
              onClick={() => {
                void call('update:skip', u.version!)
                close()
              }}
            >
              Skip This Version
            </button>
          )}
          <button className="btn subtle" onClick={close}>
            Later
          </button>
          {u.status === 'available' && (
            <button className="btn primary" onClick={() => void call('update:download')}>
              <Icon name="cloud-download" /> Download
            </button>
          )}
          {u.status === 'ready' && (
            <button
              className="btn primary"
              onClick={() => {
                close()
                void call('update:install')
              }}
            >
              <Icon name="debug-restart" /> Restart and Update
            </button>
          )}
        </>
      )
    }
  }
  return (
    <Modal title={title} icon="cloud-download" onClose={close} footer={footer} wide={!!u.releaseNotes && ['available', 'downloading', 'ready'].includes(u.status)}>
      <div className="update-dialog">{body}</div>
    </Modal>
  )
}

/** Status and a Check button, for Settings → Updates and About. */
export function UpdateStatusRow() {
  const u = useStore((s) => s.update)
  const kb = commandKeybinding('help.checkUpdates')
  return (
    <div className="flex" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      <span className={cx('badge', u?.status === 'ready' || u?.status === 'available' ? 'accent' : u?.status === 'up-to-date' ? 'success' : u?.status === 'error' ? 'error' : '')}>{updateSummary(u)}</span>
      {(u?.status === 'available' || u?.status === 'downloading' || u?.status === 'ready') && (
        <button className="btn small primary" onClick={() => set({ updateOpen: true })}>
          Details
        </button>
      )}
      <Tooltip content={`Check GitHub for a newer Hive now${kb ? ` (${formatKeybinding(kb)})` : ''}`}>
        <button className="btn small subtle" disabled={u?.status === 'disabled' || u?.status === 'checking' || u?.status === 'downloading'} onClick={() => void checkForUpdates()}>
          Check Now
        </button>
      </Tooltip>
    </div>
  )
}
