import { useEffect, useMemo, useRef, useState } from 'react'
import iconUrl from '../assets/icon.svg'
import { call, errorMessage } from '../api'
import { commands, runCommand } from '../commands'
import { dismissToast, NO_PROJECTS, notify, set, setActivity, useStore } from '../store'
import { cacheState, useLiveUsage } from '../usage'
import { cx, formatKeybinding, formatTokens, timeAgo } from '../util'
import { TerminalView } from './TerminalView'
import type { QuitChoice, SessionStatus } from '@shared/types'
import { Icon, IconButton, Modal, STATUS_TEXT } from './ui'

const LEVEL_ICON = { info: 'info', success: 'pass', warning: 'warning', error: 'error' } as const

export function Dialogs() {
  const dialog = useStore((s) => s.dialog)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (dialog?.kind === 'prompt') {
      setValue(dialog.initial ?? '')
      setError(null)
      setTimeout(() => inputRef.current?.select(), 30)
    }
  }, [dialog])

  if (!dialog) return null
  const close = (result: boolean | string | null): void => {
    set({ dialog: null })
    if (dialog.kind === 'confirm') dialog.resolve(result === true)
    else dialog.resolve(typeof result === 'string' ? result : null)
  }

  if (dialog.kind === 'confirm') {
    return (
      <Modal
        title={dialog.title}
        icon={dialog.danger ? 'warning' : 'question'}
        onClose={() => close(false)}
        footer={
          <>
            <button className="btn subtle" onClick={() => close(false)}>
              {dialog.cancelLabel ?? 'Cancel'}
            </button>
            <button className={cx('btn', dialog.danger ? 'danger' : 'primary')} autoFocus onClick={() => close(true)}>
              {dialog.confirmLabel ?? 'OK'}
            </button>
          </>
        }
      >
        <div>{dialog.message}</div>
        {dialog.detail && <div className="detail">{dialog.detail}</div>}
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
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
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
    const cmdItems = commands
      .filter((c) => !['project.focus', 'notes.open', 'mcp.import'].includes(c.id) && (!c.when || c.when()))
      .map((c) => ({ id: c.id, label: `${c.category}: ${c.label}`, keybinding: c.keybinding, run: () => runCommand(c.id), icon: 'symbol-event' }))
    const projectItems = projects.map((p) => ({
      id: `project:${p.path}`,
      label: `Go to Project: ${p.name}`,
      keybinding: undefined as string | undefined,
      run: () => runCommand('project.focus', p.path),
      icon: 'folder'
    }))
    return [...projectItems, ...cmdItems]
      .map((i) => ({ ...i, s: score(i.label, q) }))
      .filter((i) => i.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
  }, [q, projects, open])

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
      <div className="palette">
        <input
          autoFocus
          className="input"
          placeholder="Type a command or project name"
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
              <Icon name={it.icon} />
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
  const agent = useStore((s) => s.agent)
  if (!open || !info) return null
  const rows: [string, string][] = [
    ['Version', info.version],
    ['Claude Code', agent?.found ? `CLI ${agent.version} (${agent.source})` : 'CLI not installed'],
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
          An agent-first workspace for AI-assisted coding. Run Claude Code across your projects, side by side.
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
        <p className="about-licence">
          Open source under the <a onClick={() => showDoc('license')}>MIT License</a>. Includes <a onClick={() => showDoc('notices')}>third-party software</a>
          {' '}and <a onClick={() => void call('app:openChromiumLicenses').then((ok) => ok || notify('info', 'Licences not found', 'The Chromium licence file is in the folder Hive is installed in.'))}>Chromium</a>.
        </p>
        <p className="faint" style={{ fontSize: 11, marginTop: 8 }}>
          © 2026 Darren Marshall. Claude and Claude Code are products of Anthropic. Hive is not affiliated with Anthropic.
        </p>
      </div>
    </Modal>
  )
}

export function ShortcutsDialog() {
  const open = useStore((s) => s.shortcutsOpen)
  if (!open) return null
  const withKeys = commands.filter((c) => c.keybinding)
  return (
    <Modal title="Keyboard Shortcuts" icon="keyboard" wide onClose={() => set({ shortcutsOpen: false })}>
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
            <td>Copy selection / paste</td>
            <td>
              <kbd>Ctrl+C</kbd> <kbd>Ctrl+V</kbd> or right-click
            </td>
          </tr>
        </tbody>
      </table>
      <p className="hint">Ctrl+B, Ctrl+K, Ctrl+O, Ctrl+R, Ctrl+T and Ctrl+G are left to Claude Code while the terminal has focus.</p>
    </Modal>
  )
}

export function ClaudeSetupDialog() {
  const open = useStore((s) => s.setupOpen)
  const agent = useStore((s) => s.agent)
  const [task, setTask] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!open) return null
  const start = async (kind: 'install' | 'update' | 'login'): Promise<void> => {
    try {
      const key = await call(kind === 'install' ? 'agent:install' : kind === 'update' ? 'agent:update' : 'agent:login')
      setTask(key)
      setRunning(true)
    } catch (e) {
      notify('error', 'Could not start', errorMessage(e))
    }
  }
  const recheck = async (): Promise<void> => {
    setBusy(true)
    try {
      set({ agent: await call('agent:refresh') })
    } finally {
      setBusy(false)
    }
  }
  const close = (): void => {
    if (task && running) void call('pty:kill', task)
    setTask(null)
    set({ setupOpen: false })
  }

  return (
    <Modal
      title="Claude Code Setup"
      icon="hubot"
      wide
      onClose={close}
      footer={
        <>
          <button className="btn subtle" onClick={() => void call('app:openExternal', 'https://code.claude.com/docs/en/setup')}>
            <Icon name="link-external" /> Installation docs
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
      {agent?.checking ? (
        <div className="setup-status">
          <Icon name="loading" spin />
          <div>Looking for Claude Code…</div>
        </div>
      ) : agent?.found ? (
        <div className="setup-status">
          <Icon name="pass-filled" className="" />
          <div className="grow">
            <div>
              <strong>Claude Code {agent.version}</strong> <span className="muted">— found via {agent.source}</span>
            </div>
            <div className="muted mono" style={{ fontSize: 11 }}>
              {agent.path}
            </div>
            <div style={{ marginTop: 4 }}>
              {agent.loggedIn === true && <span className="badge success"><Icon name="account" /> Signed in ({agent.authMethod})</span>}
              {agent.loggedIn === false && <span className="badge warn"><Icon name="account" /> Not signed in</span>}{' '}
              {agent.updateAvailable ? (
                <span className="badge accent"><Icon name="cloud-download" /> {agent.latestVersion} available</span>
              ) : agent.latestVersion ? (
                <span className="badge">Up to date</span>
              ) : null}
            </div>
          </div>
          <div className="flex">
            {agent.loggedIn === false && (
              <button className="btn primary" disabled={running} onClick={() => void start('login')}>
                Sign in
              </button>
            )}
            {agent.updateAvailable && (
              <button className="btn primary" disabled={running} onClick={() => void start('update')}>
                Update
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="setup-status">
            <Icon name="warning" />
            <div className="grow">
              <strong>The Claude Code CLI is required</strong>
              <div className="muted">Hive runs the standalone Claude Code command-line tool in each project. It isn't bundled with Hive — install it with Anthropic's official installer.</div>
            </div>
            <button className="btn primary" disabled={running} onClick={() => void start('install')}>
              <Icon name="cloud-download" /> Install Claude Code CLI
            </button>
          </div>
          {agent?.editorExtensionOnly && (
            <div className="banner info" style={{ borderRadius: 6, marginBottom: 10 }}>
              <Icon name="info" />
              <span>
                You have the Claude Code extension for VS Code (or a similar editor). Hive doesn't use it — the extension's built-in copy moves with every extension update and can't be updated
                on its own. Install the CLI; your extension keeps working as before.
              </span>
            </div>
          )}
          <p className="hint">
            The installer runs <code>irm https://claude.ai/install.ps1 | iex</code> in PowerShell and installs to <code>%USERPROFILE%\.local\bin</code>. After installing, start a session and sign
            in with your Claude account (Pro, Max, Team or Enterprise) or an Anthropic Console account. If the CLI is installed somewhere else, set its path in Settings → Claude Code.
          </p>
        </>
      )}
      {!!agent?.rejected?.length && (
        <p className="hint">
          <Icon name="info" /> Ignored {agent.rejected.length === 1 ? 'a copy' : 'copies'} bundled with an editor extension (<code>{agent.rejected[0]}</code>). Hive only uses the standalone CLI.
        </p>
      )}
      {task && (
        <div className="task-terminal">
          <TerminalView
            ptyKey={task}
            visible
            onExit={() => {
              setRunning(false)
              void recheck()
            }}
          />
        </div>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Quit
// ---------------------------------------------------------------------------

const BUSY: SessionStatus[] = ['working', 'waiting']

/** Asks what to do with running sessions when Hive quits. Main waits for app:quitDecision. */
export function QuitDialog() {
  const sessions = useStore((s) => s.quitRequest)
  const [dontAsk, setDontAsk] = useState(false)
  useEffect(() => setDontAsk(false), [sessions])
  if (!sessions) return null
  const decide = (choice: QuitChoice): void => {
    set({ quitRequest: null })
    void call('app:quitDecision', choice, dontAsk)
  }
  const working = sessions.filter((s) => s.status === 'working').length
  const busy = sessions.filter((s) => BUSY.includes(s.status)).length
  return (
    <Modal
      title="Quit Hive?"
      icon={busy ? 'warning' : 'sign-out'}
      onClose={() => decide('cancel')}
      footer={
        <>
          <label className="quit-dontask">
            <input type="checkbox" className="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} /> Don't ask again
          </label>
          <button className="btn subtle" onClick={() => decide('cancel')}>
            Cancel
          </button>
          {working > 0 && (
            <button className="btn subtle" onClick={() => decide('wait')} title="Hide Hive and quit as soon as no agent is working">
              <Icon name="watch" /> Quit when {working === 1 ? 'the agent finishes' : 'agents finish'}
            </button>
          )}
          <button className={cx('btn', busy ? 'danger' : 'primary')} autoFocus onClick={() => decide('now')}>
            Quit now
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        {busy
          ? `${busy === 1 ? 'An agent is' : `${busy} agents are`} in the middle of something. Quitting stops ${sessions.length === 1 ? 'the session' : `all ${sessions.length} sessions`}.`
          : `Quitting stops ${sessions.length === 1 ? 'the running session' : `${sessions.length} running sessions`}.`}
      </p>
      <div className="quit-list">
        {sessions.map((s) => (
          <div key={`${s.projectPath}:${s.agent ?? ''}`} className="quit-row">
            <span className={cx('dot', s.status)} />
            <strong>{s.project}</strong>{s.agent && <span className="muted">· {s.agent}</span>}
            <span className="faint">{STATUS_TEXT[s.status]}</span>
            {s.status === 'working' && <span className="badge warn">Will be interrupted</span>}
            {s.status === 'waiting' && <span className="badge warn">Waiting for you</span>}
          </div>
        ))}
      </div>
      <div className="detail">Conversations are kept. Resume them from the project or its Sessions tab next time.</div>
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

// ---------------------------------------------------------------------------
// Compact
// ---------------------------------------------------------------------------

/** Confirms a manual compaction, with an optional focus for the summary. */
export function CompactDialog() {
  const target = useStore((s) => s.compactFor)
  const path = target ? `${target.project}#${target.agentId}` : null
  const project = useStore((s) => s.workspace?.projects.find((p) => p.path === s.compactFor?.project) ?? null)
  const agent = project?.agents.find((a) => a.id === target?.agentId) ?? null
  const ttl = useStore((s) => s.settings?.sessions.cacheTtl ?? 'auto')
  const usage = useLiveUsage(project, target?.agentId)
  const [focus, setFocus] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setFocus('')
    setBusy(false)
  }, [path])
  if (!path || !project || !agent) return null
  const close = (): void => set({ compactFor: null })
  const live = agent.live
  const idle = !!live && (live.status === 'ready' || live.status === 'finished')
  const cache = usage ? cacheState(usage, ttl) : null
  const run = async (): Promise<void> => {
    setBusy(true)
    try {
      await call('session:compact', project.path, focus.trim() || undefined, agent.id)
      close()
    } catch (e) {
      notify('error', 'Could not compact', errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <Modal
      title={`Compact ${project.name}${project.agents.length > 1 ? ` · ${agent.name}` : ''}?`}
      icon="fold"
      onClose={close}
      footer={
        <>
          <button className="btn subtle" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!idle || busy} onClick={() => void run()}>
            <Icon name="fold" /> Compact
          </button>
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
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && idle && !busy) void run()
          }}
        />
      </label>
      {!idle && <div className="detail">The agent is busy. Compact once it has finished.</div>}
      <div className="detail">Anything you had half-typed in the session is cleared first; press Ctrl+Y in the session to get it back.</div>
    </Modal>
  )
}
