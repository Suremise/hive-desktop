import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import iconUrl from '../assets/icon.svg'
import { call, errorMessage } from '../api'
import { commandKeybinding, commandLabel, commands, runCommand } from '../commands'
import { closeDialog, dismissToast, findProject, NO_PROJECTS, notify, set, setActivity, useStore } from '../store'
import { cacheState, useLiveUsage } from '../usage'
import { cx, formatKeybinding, formatTokens, timeAgo } from '../util'
import { TerminalView } from './TerminalView'
import { UpdateStatusRow } from './Updates'
import { discardDrafts, saveAllDrafts, unsavedFiles } from './FileView'
import type { ProviderId, ProviderTask, QuitChoice, QuitSession, SessionStatus } from '@shared/types'
import { PROVIDERS, enabledProviders, isProviderEnabled, providerDescriptor } from '@shared/providers'
import { distinguishingParents } from '@shared/folderLabels'
import { ProviderIcon } from './ProviderIcon'
import { BusyButton, Icon, IconButton, LoadFailed, Modal, STATUS_TEXT, useBackdrop, useBusy } from './ui'

const LEVEL_ICON = { info: 'info', success: 'pass', warning: 'warning', error: 'error' } as const

export function Dialogs() {
  const dialog = useStore((s) => s.dialog)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState(false)
  const [picked, setPicked] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const action = useBusy()
  const { setError: setActionError } = action

  useEffect(() => {
    setActionError(null)
    if (dialog?.kind === 'confirm') setChecked(dialog.check?.initial ?? false)
    if (dialog?.kind === 'prompt') {
      setValue(dialog.initial ?? '')
      setChecked(dialog.check?.initial ?? false)
      setError(null)
      setTimeout(() => inputRef.current?.select(), 30)
    }
    if (dialog?.kind === 'choice' && dialog.select) setPicked(dialog.select.initial)
  }, [dialog, setActionError])

  if (!dialog) return null
  const close = (result: boolean | string | null): void => {
    closeDialog()
    if (dialog.kind === 'confirm') {
      dialog.check?.set(checked)
      dialog.resolve(result === true)
    } else if (dialog.kind === 'prompt') {
      dialog.check?.set(checked)
      dialog.resolve(typeof result === 'string' ? result : null)
    }
  }

  if (dialog.kind === 'choice') {
    const answer = (v: string | null): void => {
      closeDialog()
      if (v !== null) dialog.select?.set(picked)
      dialog.resolve(v)
    }
    return (
      <Modal
        title={dialog.title}
        icon={dialog.danger ? 'warning' : 'question'}
        onClose={() => answer(null)}
        footer={
          <>
            <button className="btn subtle" onClick={() => answer(null)}>
              Cancel
            </button>
            {dialog.choices.map((c, i) => (
              <button key={c.value} className={cx('btn', i === dialog.choices.length - 1 ? (dialog.danger ? 'danger' : 'primary') : 'subtle')} autoFocus={i === dialog.choices.length - 1} onClick={() => answer(c.value)}>
                {c.label}
              </button>
            ))}
          </>
        }
      >
        <div>{dialog.message}</div>
        {dialog.detail && <div className="detail">{dialog.detail}</div>}
        {dialog.select && (
          <label className="dialog-select">
            {dialog.select.label}
            <select className="select" aria-label={dialog.select.label} value={picked} onChange={(e) => setPicked(e.target.value)}>
              {dialog.select.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </Modal>
    )
  }

  if (dialog.kind === 'confirm') {
    return (
      <Modal
        title={dialog.title}
        icon={dialog.danger ? 'warning' : 'question'}
        onClose={() => close(false)}
        busy={!!action.busy}
        error={action.error}
        footer={
          <>
            <button className="btn subtle" onClick={() => close(false)}>
              {dialog.cancelLabel ?? 'Cancel'}
            </button>
            <BusyButton
              className={dialog.danger ? 'danger' : 'primary'}
              autoFocus
              busy={action.busy === 'confirm'}
              busyLabel={dialog.busyLabel ?? 'Working…'}
              onClick={() => {
                const run = dialog.run
                if (!run) return close(true)
                // The tick box's answer first: the action may depend on it (a template load removing old worktrees, #289).
                dialog.check?.set(checked)
                void action.run('confirm', run).then((r) => r && close(true))
              }}
            >
              {action.error ? 'Try Again' : (dialog.confirmLabel ?? 'OK')}
            </BusyButton>
          </>
        }
      >
        <div>{dialog.message}</div>
        {dialog.detail && <div className={cx('detail', dialog.scrollDetail && 'scroll')}>{dialog.detail}</div>}
        {dialog.check && (
          <label className="flex dialog-check">
            <input type="checkbox" checked={checked} disabled={!!action.busy} onChange={(e) => setChecked(e.target.checked)} /> {dialog.check.label}
          </label>
        )}
      </Modal>
    )
  }

  const submit = (): void => {
    const err = dialog.validate?.(value) ?? null
    if (err) return setError(err)
    close(value)
  }
  return (
    <Modal
      title={dialog.title}
      onClose={() => close(null)}
      footer={
        <>
          <button className="btn subtle" onClick={() => close(null)}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit}>
            {dialog.confirmLabel ?? 'OK'}
          </button>
        </>
      }
    >
      {dialog.message && <p style={{ marginTop: 0 }} className="muted">{dialog.message}</p>}
      <input
        ref={inputRef}
        className={cx('input', error && 'invalid')}
        style={{ width: '100%' }}
        value={value}
        placeholder={dialog.placeholder}
        onChange={(e) => {
          setValue(e.target.value)
          setError(null)
        }}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      {error && <div className="field-error">{error}</div>}
      {dialog.check && (
        <label className="flex" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> {dialog.check.label}
        </label>
      )}
    </Modal>
  )
}

function score(text: string, q: string): number {
  if (!q) return 1
  const t = text.toLowerCase()
  const s = q.toLowerCase()
  if (t.includes(s)) return 100 - t.indexOf(s)
  let ti = 0
  for (const ch of s) {
    ti = t.indexOf(ch, ti)
    if (ti < 0) return 0
    ti++
  }
  return 10
}

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen)
  const mode = useStore((s) => s.paletteMode)
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  // Toggles' states as one string, so their rows' checkmarks follow live changes (pinning the window
  // while the palette is open) without rebuilding the item list; a string keeps the selector stable.
  useStore(() => commands.map((c) => (c.checked ? (c.checked() ? '1' : '0') : '')).join(''))
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setQ('')
      setActive(0)
    }
  }, [open])

  const items = useMemo(() => {
    const cmdItems = mode === 'projects' ? [] : commands
      .filter((c) => !c.internal && (!c.when || c.when()))
      .map((c) => ({ id: c.id, label: `${c.category}: ${commandLabel(c)}`, keybinding: commandKeybinding(c.id), run: () => runCommand(c.id), icon: 'symbol-event', checked: c.checked }))
    const projectItems = projects.map((p) => ({
      id: `project:${p.path}`,
      label: mode === 'projects' ? p.name : `Go to Project: ${p.name}`,
      keybinding: undefined as string | undefined,
      run: () => runCommand('project.focus', p.path),
      icon: 'folder',
      checked: undefined as (() => boolean) | undefined
    }))
    return [...projectItems, ...cmdItems]
      .map((i) => ({ ...i, s: score(i.label, q) }))
      .filter((i) => i.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
    // `open`: commands' availability (when()) is read again each time the palette opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, projects, open, mode])

  useEffect(() => {
    listRef.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null
  const close = (): void => set({ paletteOpen: false })
  const exec = (i: number): void => {
    const it = items[i]
    if (!it) return
    close()
    setTimeout(it.run, 0)
  }
  return (
    <div className="overlay" style={{ paddingTop: 60 }} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <Backdrop />
      <div className="palette">
        <input
          autoFocus
          className="input"
          placeholder={mode === 'projects' ? 'Go to project' : 'Type a command or project name'}
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setActive(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close()
            else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(items.length - 1, a + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(0, a - 1))
            } else if (e.key === 'Enter') exec(active)
          }}
        />
        <div className="palette-list" ref={listRef}>
          {items.length === 0 && <div className="pane-empty">No matching commands</div>}
          {items.map((it, i) => (
            <div key={it.id} className={cx('palette-item', i === active && 'active')} onMouseMove={() => setActive(i)} onClick={() => exec(i)}>
              <Icon name={it.checked?.() ? 'check' : it.icon} />
              <span>{it.label}</span>
              {it.keybinding && <kbd>{formatKeybinding(it.keybinding)}</kbd>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast', t.level)}>
          <Icon name={LEVEL_ICON[t.level]} className="lead" />
          <div className="toast-text">
            <div className="toast-title">{t.title}</div>
            {t.message && <div className="toast-msg">{t.message}</div>}
            {!!t.actions?.length && (
              <div className="toast-actions">
                {t.actions.map((a) => (
                  <button
                    key={a.label}
                    className="btn small primary"
                    onClick={() => {
                      dismissToast(t.id)
                      runCommand(a.command, ...(a.args ?? []))
                    }}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <IconButton icon="close" title="Dismiss" onClick={() => dismissToast(t.id)} />
        </div>
      ))}
    </div>
  )
}

/** The window is dimmed (its native buttons too) while this is shown. */
function Backdrop(): null {
  useBackdrop()
  return null
}

export function NotificationCenter() {
  const open = useStore((s) => s.showNotifications)
  const items = useStore((s) => s.notifications)
  if (!open) return null
  return (
    <div className="notif-panel">
      <div className="pane-header">
        Notifications
        <div className="actions">
          <IconButton icon="clear-all" title="Clear all" onClick={() => set({ notifications: [] })} />
          <IconButton icon="close" title="Close" onClick={() => set({ showNotifications: false })} />
        </div>
      </div>
      <div className="list">
        {items.length === 0 && <div className="empty-state">
          <Icon name="bell" />
          No notifications
        </div>}
        {items.map((t) => (
          <div key={t.id} className="notif-item">
            <Icon name={LEVEL_ICON[t.level]} className={cx('lead')} />
            <div className="toast-text">
              <div className="toast-title">{t.title}</div>
              {t.message && <div className="toast-msg">{t.message}</div>}
              <div className="time">{timeAgo(t.timestamp)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function AboutDialog() {
  const open = useStore((s) => s.aboutOpen)
  const info = useStore((s) => s.appInfo)
  const providers = useStore((s) => s.providers)
  if (!open || !info) return null
  const rows: [string, string][] = [
    ['Version', info.version],
    ...PROVIDERS.map((p): [string, string] => {
      const i = providers[p.id]
      return [p.name, i?.found ? `CLI ${i.version} (${i.source})` : 'CLI not installed']
    }),
    ['Electron', info.electron],
    ['Chromium', info.chrome],
    ['Node.js', info.node],
    ['V8', info.v8],
    ['OS', `${info.platform} ${info.arch}`],
    ['Data folder', info.userData]
  ]
  const showDoc = (page: string): void => {
    set({ aboutOpen: false, docsPage: page })
    setActivity('docs')
  }
  const copy = (): void => {
    void navigator.clipboard.writeText(rows.map(([k, v]) => `${k}: ${v}`).join('\n'))
    notify('success', 'Version information copied')
  }
  return (
    <Modal
      title="About Hive"
      onClose={() => set({ aboutOpen: false })}
      footer={
        <>
          <button className="btn subtle" onClick={copy}>
            <Icon name="copy" /> Copy
          </button>
          <button className="btn subtle" onClick={() => {
              set({ aboutOpen: false })
              runCommand('help.releaseNotes')
            }}>
            Release Notes
          </button>
          <button className="btn primary" onClick={() => set({ aboutOpen: false })}>
            OK
          </button>
        </>
      }
    >
      <div className="about">
        <img src={iconUrl} alt="Hive" />
        <h1>Hive</h1>
        <div className="version">Version {info.version}</div>
        <p className="muted" style={{ maxWidth: 360, margin: '10px auto 0' }}>
          An agent-first workspace for AI-assisted coding. Run coding agents such as {PROVIDERS.map((p) => p.name).join(' and ')} across your projects, side by side.
        </p>
        <table className="about-table">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td>{k}</td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="about-update">
          <UpdateStatusRow />
        </div>
        <p className="about-licence">
          Open source under the <a onClick={() => showDoc('license')}>MIT License</a>. Includes <a onClick={() => showDoc('notices')}>third-party software</a>
          {' '}and <a onClick={() => void call('app:openChromiumLicenses').then((ok) => ok || notify('info', 'Licences not found', 'The Chromium licence file is in the folder Hive is installed in.'))}>Chromium</a>.
        </p>
        <p className="faint" style={{ fontSize: 11, marginTop: 8 }}>
          © 2026 Darren Marshall. {PROVIDERS.map((p) => `${p.name} is a product of ${p.company}`).join('; ')}. Hive is not affiliated with {[...new Set(PROVIDERS.map((p) => p.company))].join(' or ')}.
        </p>
      </div>
    </Modal>
  )
}

/** Help → Copy Diagnostics: shows exactly what will be copied (redacted in main), then copies it. */
export function DiagnosticsDialog() {
  const open = useStore((s) => s.diagnosticsOpen)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!open) return
    setText(null)
    setError(null)
    let current = true
    void call('app:diagnostics').then(
      (t) => current && setText(t),
      (e) => current && setError(errorMessage(e))
    )
    return () => {
      current = false
    }
  }, [open, attempt])
  if (!open) return null
  const close = (): void => set({ diagnosticsOpen: false })
  const copy = (): void => {
    if (!text) return
    void navigator.clipboard.writeText(text).then(
      () => {
        notify('success', 'Diagnostics copied', 'Paste them into your bug report.')
        close()
      },
      (e) => notify('error', 'Could not copy the diagnostics', errorMessage(e))
    )
  }
  return (
    <Modal
      title="Copy Diagnostics"
      icon="bug"
      wide
      onClose={close}
      footer={
        <>
          <button className="btn subtle" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!text} onClick={copy}>
            <Icon name="copy" /> Copy
          </button>
        </>
      }
    >
      <p className="muted">
        For a bug report: Hive's version, your coding agents, counts, the settings that change how Hive behaves and the end of its log. Folders, workspace, project and agent names, and
        anything that looks like a key or token are taken out. This is exactly what will be copied.
      </p>
      {error ? (
        <LoadFailed what="the diagnostics" error={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : (
        <pre className="diagnostics-preview">{text ?? 'Collecting…'}</pre>
      )}
    </Modal>
  )
}

export function ShortcutsDialog() {
  const open = useStore((s) => s.shortcutsOpen)
  if (!open) return null
  const withKeys = commands.map((c) => ({ ...c, keybinding: commandKeybinding(c.id) })).filter((c) => c.keybinding)
  return (
    <Modal
      title="Keyboard Shortcuts"
      icon="keyboard"
      wide
      onClose={() => set({ shortcutsOpen: false })}
      footer={
        <>
          <button className="btn subtle" onClick={() => {
              set({ shortcutsOpen: false })
              runCommand('settings.keybindings')
            }}>
            <Icon name="settings" /> Customise…
          </button>
          <button className="btn primary" onClick={() => set({ shortcutsOpen: false })}>
            OK
          </button>
        </>
      }
    >
      <table className="table kbd-table">
        <tbody>
          {withKeys.map((c) => (
            <tr key={c.id}>
              <td className="muted">{c.category}</td>
              <td>{c.label}</td>
              <td>
                {c.keybinding!.split(' ').map((k, i) => (
                  <kbd key={i} style={{ marginLeft: 4 }}>
                    {formatKeybinding(k)}
                  </kbd>
                ))}
              </td>
            </tr>
          ))}
          <tr>
            <td className="muted">Terminal</td>
            <td>Switch mode inside the agent (Claude Code: permission mode)</td>
            <td>
              <kbd>Shift+Tab</kbd>
            </td>
          </tr>
          <tr>
            <td className="muted">Terminal</td>
            <td>Copy selection / paste</td>
            <td>
              <kbd>Ctrl+C</kbd> <kbd>Ctrl+V</kbd> or right-click
            </td>
          </tr>
        </tbody>
      </table>
      {PROVIDERS.filter((p) => p.reservedKeys.length).map((p) => (
        <p key={p.id} className="hint">
          {p.reservedKeys.map((k) => k.replace('MOD+', 'Ctrl+')).join(', ')} are left to {p.name} while its terminal has focus.
        </p>
      ))}
    </Modal>
  )
}

/** Text with `code` and **bold** spans, as provider notes are written. */
function CodeText({ text }: { text: string }) {
  const code = (s: string, k: number) => s.split('`').map((part, i) => (i % 2 ? <code key={`${k}.${i}`}>{part}</code> : <span key={`${k}.${i}`}>{part}</span>))
  return <>{text.split('**').map((part, k) => (k % 2 ? <strong key={k}>{code(part, k)}</strong> : code(part, k)))}</>
}

/** Installing, updating, signing in to and setting up each provider's CLI, one tab per provider. */
export function AgentSetupDialog() {
  const open = useStore((s) => s.setupOpen)
  const providers = useStore((s) => s.providers)
  const settings = useStore((s) => s.settings)
  const [tab, setTab] = useState<ProviderId>(PROVIDERS[0].id)
  const [task, setTask] = useState<{ key: string; kind: ProviderTask; issues: string[] } | null>(null)
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [finished, setFinished] = useState<string | null>(null)
  useEffect(() => {
    if (typeof open === 'string') setTab(open)
    else if (open) setTab(enabledProviders(settings)[0]?.id ?? PROVIDERS[0].id)
    // Only when the dialog opens: a settings change while it is open doesn't move the tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null
  const p = providerDescriptor(tab)
  const info = providers[tab]
  const on = isProviderEnabled(settings, tab)
  const start = async (kind: ProviderTask): Promise<void> => {
    try {
      const key = await call('provider:task', tab, kind)
      setTask({ key, kind, issues: (info?.readiness ?? []).filter((r) => r.action?.task === kind).map((r) => r.id) })
      setFinished(null)
      setRunning(true)
    } catch (e) {
      notify('error', 'Could not start', errorMessage(e))
    }
  }
  const recheck = async (): Promise<typeof providers | null> => {
    setBusy(true)
    try {
      const next = await call('provider:refresh', tab)
      set({ providers: next })
      return next
    } catch {
      return null
    } finally {
      setBusy(false)
    }
  }
  // When the issue the task was for is gone after it ends, it did its job: say so instead of leaving its last screen up.
  const taskEnded = async (): Promise<void> => {
    setRunning(false)
    const next = await recheck()
    const kind = task?.kind
    const after = next?.[tab]
    if (!kind || !after || after.checking) return
    const left = kind === 'update' ? after.updateAvailable : (after.readiness ?? []).some((r) => task.issues.includes(r.id))
    if (left) return
    const what: Record<ProviderTask, string> = { install: `${p.name} is installed.`, update: `${p.name} is up to date.`, login: `${p.name} is signed in.`, setup: `${p.name} is set up.` }
    setFinished(`${what[kind]} You can close this window.`)
    setTask(null)
  }
  const close = (): void => {
    if (task && running) void call('pty:kill', task.key)
    setTask(null)
    setFinished(null)
    set({ setupOpen: false })
  }
  const issues = (info?.readiness ?? []).filter((r) => r.id !== 'not-installed')

  return (
    <Modal
      title="Agent Setup"
      icon="hubot"
      wide
      onClose={close}
      footer={
        <>
          <button className="btn subtle" onClick={() => void call('app:openExternal', p.setupUrl)}>
            <Icon name="link-external" /> {p.name} docs
          </button>
          <div className="grow" />
          <button className="btn subtle" onClick={() => void recheck()} disabled={busy || running}>
            <Icon name={busy ? 'loading' : 'refresh'} spin={busy} /> Check again
          </button>
          <button className="btn primary" onClick={close}>
            {running ? 'Cancel' : 'Close'}
          </button>
        </>
      }
    >
      {PROVIDERS.length > 1 && (
        <div className="setup-tabs">
          {PROVIDERS.map((x) => (
            <button key={x.id} className={cx('setup-tab', tab === x.id && 'selected')} disabled={running} onClick={() => { setTab(x.id); setFinished(null) }}>
              <ProviderIcon provider={x.id} /> {x.name}
              {!isProviderEnabled(settings, x.id) && <span className="faint"> (off)</span>}
            </button>
          ))}
        </div>
      )}
      {!on && (
        <div className="banner info" style={{ borderRadius: 6, marginBottom: 10 }}>
          <Icon name="info" />
          <span>
            {p.name} is turned off, so Hive doesn't run it.{' '}
            <a onClick={() => void call('settings:update', { providers: { [tab]: { enabled: true } } }).then((ns) => set({ settings: ns }))}>Turn it on</a>
          </span>
        </div>
      )}
      {!info || info.checking ? (
        <div className="setup-status">
          <Icon name="loading" spin />
          <div>Looking for {p.name}…</div>
        </div>
      ) : info.found ? (
        <>
        <div className="setup-status">
          <Icon name="pass-filled" className="" />
          <div className="grow">
            <div>
              <strong>
                {p.name} {info.version}
              </strong>{' '}
              <span className="muted">— found via {info.source}</span>
            </div>
            <div className="muted mono" style={{ fontSize: 11 }}>
              {info.path}
            </div>
            <div style={{ marginTop: 4 }}>
              {info.loggedIn === true && (
                <span className="badge success">
                  <Icon name="account" /> Signed in{info.authMethod ? ` (${info.authMethod})` : ''}
                </span>
              )}{' '}
              {issues.map((r) => (
                <span key={r.id} className={cx('badge', r.level === 'error' ? 'warn' : r.level === 'warning' ? 'warn' : 'accent')}>
                  {r.message}
                </span>
              ))}{' '}
              {!info.updateAvailable && info.latestVersion && <span className="badge">Up to date</span>}
            </div>
          </div>
          <div className="flex">
            {issues
              .filter((r) => r.action)
              .map((r) => (
                <button key={r.id} className="btn primary" disabled={running} onClick={() => void start(r.action!.task)}>
                  {r.action!.label}
                </button>
              ))}
          </div>
        </div>
        {issues
          .filter((r) => r.detail?.length)
          .map((r) => (
            <div key={r.id} className="setup-detail">
              {r.detail!.map((para, i) => (
                <p key={i} className="hint">
                  <CodeText text={para} />
                </p>
              ))}
            </div>
          ))}
        </>
      ) : (
        <>
          <div className="setup-status">
            <Icon name="warning" />
            <div className="grow">
              <strong>{p.name} is not installed</strong>
              <div className="muted">
                Hive runs the standalone {p.name} command-line tool in each project. It isn't bundled with Hive — install it with {p.company}'s official installer.
              </div>
            </div>
            <button className="btn primary" disabled={running} onClick={() => void start('install')}>
              <Icon name="cloud-download" /> Install {p.name}
            </button>
          </div>
          {info.editorExtensionOnly && p.extensionNote && (
            <div className="banner info" style={{ borderRadius: 6, marginBottom: 10 }}>
              <Icon name="info" />
              <span>{p.extensionNote}</span>
            </div>
          )}
          {p.installNote && (
            <p className="hint">
              <CodeText text={p.installNote} />
            </p>
          )}
        </>
      )}
      {!!info?.rejected?.length && (
        <p className="hint">
          <Icon name="info" /> Ignored {info.rejected.length === 1 ? 'a copy' : 'copies'} bundled with an editor extension (<code>{info.rejected[0]}</code>). Hive only uses the standalone CLI.
        </p>
      )}
      {finished && (
        <div className="banner success" style={{ borderRadius: 6, marginTop: 10 }}>
          <Icon name="pass-filled" />
          <span>{finished}</span>
        </div>
      )}
      {task && (
        <div className="task-terminal">
          <TerminalView ptyKey={task.key} visible onExit={() => void taskEnded()} />
        </div>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Quit
// ---------------------------------------------------------------------------

const BUSY: SessionStatus[] = ['working', 'waiting', 'background', 'watching']

/**
 * Asks what to do with running sessions and unsaved files when Hive quits. Main waits for
 * app:quitDecision; unsaved files are saved (or discarded) here first.
 */
export function QuitDialog() {
  const sessions = useStore((s) => s.quitRequest)
  const unsaved = useStore((s) => s.quitUnsaved)
  const scope = useStore((s) => s.quitScope)
  const windows = useStore((s) => s.windowCount)
  const workspaceName = useStore((s) => s.workspace?.name)
  // Closing a window, closing its workspace or switching it: only this workspace's sessions stop.
  const closing = scope !== 'app'
  // Quitting with several windows open closes them all: it says so, groups the agents by workspace and offers this window alone.
  const allWindows = !closing && windows > 1
  const what = scope === 'workspace' ? 'Close workspace' : scope === 'switch' ? 'Switch workspace' : 'Close window'
  const stops = scope === 'workspace' ? 'Closing the workspace stops its' : scope === 'switch' ? 'Switching workspace stops this workspace\'s' : "Closing this window stops this workspace's"
  const [dontAsk, setDontAsk] = useState(false)
  const [keep, setKeep] = useState<'save' | 'discard'>('save')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    setDontAsk(false)
    setKeep('save')
  }, [sessions])
  if (!sessions) return null
  const decide = async (choice: QuitChoice): Promise<void> => {
    if (choice !== 'cancel' && unsaved.length) {
      if (keep === 'discard') discardDrafts()
      else {
        setSaving(true)
        const r = await saveAllDrafts()
        setSaving(false)
        // Something couldn't be saved: stay open, so nothing is lost.
        if (r.failed.length) {
          notify('error', `Couldn't save ${r.failed.length === 1 ? 'a file' : `${r.failed.length} files`}, so Hive is still open`, r.failed.map((f) => f.message).join('\n'))
          set({ quitUnsaved: r.failed.map((f) => f.abs) })
          return
        }
        // Edited while it was saving: those edits are unsaved again, so stay.
        const left = unsavedFiles()
        if (left.length) {
          notify('warning', 'Some files changed while they were being saved', 'Hive is still open, so your latest edits are kept. Save them, then try again.')
          set({ quitUnsaved: left.map((f) => f.abs) })
          return
        }
      }
    }
    set({ quitRequest: null, quitUnsaved: [] })
    void call('app:quitDecision', choice, dontAsk)
  }
  // What "when agents finish" waits for: working, background tasks, and a watcher whose card another agent is working on.
  const working = sessions.filter((s) => s.status === 'working' || s.status === 'background' || s.keepsQuitWaiting).length
  const busy = sessions.filter((s) => BUSY.includes(s.status)).length
  const verb = closing ? (unsaved.length && keep === 'save' ? 'Save and close' : what) : unsaved.length && keep === 'save' ? 'Save and quit' : 'Quit'
  const parts = (p: string): string[] => p.split(/[\\/]/)
  // Grouped by the workspace's full path; two with the same name also show the parent folders that tell them apart.
  const groups = new Map<string, { name: string; path: string; rows: QuitSession[] }>()
  for (const s of sessions) {
    const path = allWindows ? (s.workspacePath ?? s.workspace ?? '') : ''
    const g = groups.get(path.toLowerCase()) ?? { name: allWindows ? (s.workspace ?? '') : '', path, rows: [] }
    groups.set(path.toLowerCase(), { ...g, rows: [...g.rows, s] })
  }
  const parents = distinguishingParents([...groups.values()].map((g) => g.path).filter(Boolean))
  const stopsAll = allWindows ? `Quitting closes all ${windows} windows and stops` : 'Quitting stops'
  return (
    <Modal
      title={scope === 'workspace' ? 'Close this workspace?' : scope === 'switch' ? 'Switch workspace?' : closing ? 'Close this window?' : allWindows ? `Quit Hive and close all ${windows} windows?` : 'Quit Hive?'}
      icon={busy || unsaved.length ? 'warning' : 'sign-out'}
      onClose={() => void decide('cancel')}
      footer={
        <>
          {sessions.length > 0 && !closing && (
            <label className="quit-dontask" title={unsaved.length ? 'Hive always asks about unsaved files.' : undefined}>
              <input type="checkbox" className="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} /> Don't ask again about sessions
            </label>
          )}
          <button className="btn subtle" onClick={() => void decide('cancel')} disabled={saving}>
            Cancel
          </button>
          {working > 0 && !closing && (
            <button className="btn subtle" onClick={() => void decide('wait')} disabled={saving} title="Hide Hive and quit as soon as no agent is working">
              <Icon name="watch" /> {verb} when {working === 1 ? 'the agent finishes' : 'agents finish'}
            </button>
          )}
          <button className={cx('btn', busy || (unsaved.length > 0 && keep === 'discard') ? 'danger' : 'primary')} autoFocus onClick={() => void decide('now')} disabled={saving}>
            {saving ? 'Saving…' : sessions.length ? `${verb} now` : verb}
          </button>
        </>
      }
    >
      {unsaved.length > 0 && (
        <div className="quit-unsaved">
          <p style={{ marginTop: 0 }}>
            <strong>{unsaved.length === 1 ? '1 file has' : `${unsaved.length} files have`} unsaved changes.</strong>
          </p>
          <div className="quit-list">
            {unsaved.map((p) => (
              <div key={p} className="quit-row" title={p}>
                <Icon name="file" />
                <strong>{parts(p).pop()}</strong>
                <span className="faint">{parts(p).slice(-3, -1).join('/')}</span>
              </div>
            ))}
          </div>
          <div className="segmented quit-unsaved-choice">
            <button className={cx(keep === 'save' && 'active')} onClick={() => setKeep('save')}>
              <Icon name="save" /> Save them
            </button>
            <button className={cx(keep === 'discard' && 'active')} onClick={() => setKeep('discard')}>
              <Icon name="discard" /> Discard the changes
            </button>
          </div>
        </div>
      )}
      {sessions.length > 0 && (
        <p style={{ marginTop: unsaved.length ? undefined : 0 }}>
          {busy
            ? `${busy === 1 ? 'An agent is' : `${busy} agents are`} in the middle of something. ${closing ? stops : stopsAll} ${sessions.length === 1 ? 'session' : `${closing ? '' : 'all '}${sessions.length} sessions`}${allWindows ? ', in every workspace' : ''}.`
            : `${closing ? stops : stopsAll} ${sessions.length === 1 ? 'running session' : `${sessions.length} running sessions`}${allWindows ? ', in every workspace' : ''}.`}
        </p>
      )}
      <div className="quit-list" hidden={!sessions.length}>
        {[...groups].map(([key, { name, path, rows }]) => (
          <Fragment key={`ws:${key}`}>
            {name && (
              <div className="quit-group" title={path}>
                <Icon name="folder" /> {name}
                {parents.has(key) && <span className="quit-group-where">{parents.get(key)}</span>}
              </div>
            )}
            {rows.map((s) => (
              <div key={`${s.projectPath}:${s.agent ?? ''}`} className="quit-row">
                <span className={cx('dot', s.status)} />
                <strong>{s.project}</strong>{s.agent && <span className="muted">· {s.agent}</span>}
                <span className="faint">{s.status === 'watching' && s.watch ? s.watch : STATUS_TEXT[s.status]}</span>
                {s.status === 'working' && <span className="badge warn">Will be interrupted</span>}
                {s.status === 'background' && <span className="badge warn">Background tasks will stop</span>}
                {s.status === 'waiting' && <span className="badge warn">Waiting for you</span>}
                {s.status === 'watching' && <span className="badge warn">Its card loop pauses until it is resumed</span>}
              </div>
            ))}
          </Fragment>
        ))}
      </div>
      {allWindows && (
        // In the body, not the footer: beside Cancel, Quit when agents finish and Quit now it would push the footer out of the dialog.
        <div className="quit-window-only">
          <span className="grow">
            Meant to close only this window{workspaceName ? <> ({workspaceName})</> : null}? Its agents stop, and the other {windows === 2 ? 'window stays' : `${windows - 1} windows stay`} open, as with its X.
          </span>
          <button className="btn small subtle" onClick={() => void decide('window')} disabled={saving}>
            <Icon name="close" /> Close this window only
          </button>
        </div>
      )}
      {sessions.length > 0 && <div className="detail">Conversations are kept. Resume them from the project or its Sessions tab next time.</div>}
    </Modal>
  )
}

/** Shown if the window is opened while Hive waits for agents to finish before quitting. */
export function QuitPendingBanner() {
  const pending = useStore((s) => s.quitPending)
  if (!pending) return null
  return (
    <div className="banner info quit-pending">
      <Icon name="watch" /> Hive will quit when {pending.working === 1 ? 'the working agent finishes' : `${pending.working} working agents finish`}.
      <button className="btn small" onClick={() => void call('app:cancelPendingQuit')}>
        Cancel
      </button>
      <button className="btn small primary" style={{ marginLeft: 0 }} onClick={() => void call('app:quit')}>
        Quit now
      </button>
    </div>
  )
}

/**
 * What stands between you and running agents, until it is fixed: no provider turned on, or an enabled
 * provider that isn't installed, isn't signed in or needs its one-time setup. Not dismissable.
 */
export function ProvidersBanner() {
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  if (!settings) return null
  const on = enabledProviders(settings)
  if (!on.length) {
    return (
      <div className="banner warn providers-banner">
        <Icon name="hubot" /> No coding agents are turned on. Choose the ones you use (Claude Code, …) to run sessions.
        <button className="btn small primary" onClick={() => runCommand('settings.providers')}>
          Choose providers
        </button>
      </div>
    )
  }
  const issues = on.flatMap((p) => {
    const info = providers[p.id]
    if (!info || info.checking) return []
    return (info.readiness ?? []).filter((r) => r.level !== 'info').map((r) => ({ p, r }))
  })
  if (!issues.length) return null
  return (
    <>
      {issues.map(({ p, r }) => (
        <div key={`${p.id}:${r.id}`} className={cx('banner providers-banner', r.level === 'error' ? 'warn' : 'info')}>
          <ProviderIcon provider={p.id} /> {r.message}
          <button className="btn small primary" onClick={() => set({ setupOpen: p.id })}>
            {r.action?.label ?? 'Set up'}
          </button>
        </div>
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// Compact
// ---------------------------------------------------------------------------

/** Confirms a manual compaction, with an optional focus for the summary. */
export function CompactDialog() {
  const target = useStore((s) => s.compactFor)
  const path = target ? `${target.project}#${target.agentId}` : null
  const project = useStore((s) => findProject(s, s.compactFor?.project))
  const agent = project?.agents.find((a) => a.id === target?.agentId) ?? null
  const ttl = useStore((s) => s.settings?.sessions.cacheTtl ?? 'auto')
  const usage = useLiveUsage(project, target?.agentId)
  const provider = providerDescriptor(agent?.live?.provider)
  const [focus, setFocus] = useState('')
  const action = useBusy()
  const { setError: setCompactError } = action
  useEffect(() => {
    setFocus('')
    setCompactError(null)
  }, [path, setCompactError])
  if (!path || !project || !agent) return null
  const close = (): void => set({ compactFor: null })
  const live = agent.live
  // A watching agent can be compacted: its watch is kept, and a wake waits for the compaction to end.
  const idle = !!live && (live.status === 'ready' || live.status === 'finished' || live.status === 'watching')
  const cache = usage && provider.capabilities.promptCacheTtl ? cacheState(usage, ttl) : null
  const focusOk = provider.capabilities.compactFocus
  const run = async (): Promise<void> => {
    const r = await action.run('compact', () => call('session:compact', project.path, (focusOk && focus.trim()) || undefined, agent.id))
    if (r) close()
  }
  return (
    <Modal
      title={`Compact ${project.name}${project.agents.length > 1 ? ` · ${agent.name}` : ''}?`}
      icon="fold"
      onClose={close}
      busy={!!action.busy}
      error={action.error}
      footer={
        <>
          <button className="btn subtle" onClick={close}>
            Cancel
          </button>
          <BusyButton className="primary" disabled={!idle} busy={action.busy === 'compact'} busyLabel="Sending…" onClick={() => void run()}>
            <Icon name="fold" /> Compact
          </BusyButton>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        The agent summarises the conversation so far and continues from the summary, which makes every later message cheaper. The full history stays in the
        session's transcript.
      </p>
      {usage && (
        <div className="compact-facts">
          <span>
            <Icon name="dashboard" /> Context <strong>{formatTokens(usage.contextTokens)}</strong> tokens
          </span>
          {cache && (
            <span className={cx(cache.warm ? 'ok' : 'warn')}>
              <Icon name={cache.warm ? 'flame' : 'clock'} /> Cache {cache.warm ? `warm (${Math.ceil(cache.secondsLeft / 60)} min left), so compacting is cheap` : 'expired: compacting re-reads the whole context once'}
            </span>
          )}
          {usage.compactions.length > 0 && (
            <span>
              <Icon name="history" /> Compacted {usage.compactions.length} time{usage.compactions.length === 1 ? '' : 's'} before
            </span>
          )}
        </div>
      )}
      {focusOk && (
      <label className="compact-focus">
        <span>
          Focus <span className="faint">(optional)</span>
        </span>
        <textarea
          className="input"
          rows={3}
          value={focus}
          autoFocus
          placeholder="Leave empty and the agent decides what to keep. Or steer it, e.g. “keep the Files tab decisions and open bugs; drop the test runs”."
          onChange={(e) => setFocus(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && idle) void run()
          }}
        />
      </label>
      )}
      {!idle && <div className="detail">The agent is busy. Compact once it has finished.</div>}
      <div className="detail">Anything you had half-typed in the session is cleared first; press Ctrl+Y in the session to get it back.</div>
    </Modal>
  )
}
