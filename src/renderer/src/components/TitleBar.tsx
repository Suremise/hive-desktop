import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import iconUrl from '../assets/icon.svg'
import { commandKeybinding, commands, runCommand, toggleAlwaysOnTop } from '../commands'
import { useStore } from '../store'
import { basename, cx, formatKeybinding } from '../util'
import { Icon, Tooltip } from './ui'
import { useInbox } from '../inbox'
import { badgeText, windowTitle } from '@shared/taskbar'
import { call } from '../api'

/** The taskbar badge: a red disc with the count, drawn at the screen's scale (Windows shows it at 16 px). */
function drawBadge(count: number, scale: number): string {
  const size = Math.round(16 * scale)
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  const r = size / 2
  g.beginPath()
  g.arc(r, r, r - 0.5 * scale, 0, Math.PI * 2)
  g.fillStyle = '#d13438'
  g.fill()
  // A light rim keeps it apart from the icon under it on dark and light taskbars.
  g.lineWidth = scale
  g.strokeStyle = 'rgba(255,255,255,0.9)'
  g.stroke()
  const text = badgeText(count)
  g.fillStyle = '#ffffff'
  g.font = `600 ${Math.round((text.length > 1 ? 8.5 : 11) * scale)}px "Segoe UI", sans-serif`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(text, r, r + 0.5 * scale)
  return c.toDataURL('image/png').split(',')[1]
}

/** The window title (Alt+Tab, the taskbar) and the taskbar badge, with how many agents need you in this window. */
function useTaskbarCount(title: string): void {
  const needYou = useInbox().needYou.length
  const on = useStore((s) => s.settings?.notifications.taskbarCount ?? true)
  const count = on ? needYou : 0
  useEffect(() => {
    document.title = windowTitle(title, count)
  }, [title, count])
  useEffect(() => {
    const scale = window.devicePixelRatio || 1
    void call('window:setBadge', count, count ? drawBadge(count, scale) : null, scale).catch(() => undefined)
  }, [count])
}

type MenuDef = { label: string; items: (string | '-' | { submenu: 'recent' })[] }

const MENUS: MenuDef[] = [
  {
    label: 'File',
    items: ['project.new', 'window.new', '-', 'workspace.open', 'workspace.create', { submenu: 'recent' }, 'workspace.refresh', 'workspace.close', '-', 'settings.open', '-', 'app.quit']
  },
  { label: 'Edit', items: ['edit.undo', 'edit.redo', '-', 'edit.cut', 'edit.copy', 'edit.paste', '-', 'edit.selectAll'] },
  {
    label: 'View',
    items: ['palette.show', '-', 'view.projects', 'view.overview', 'view.board', 'view.notes', 'view.skills', 'view.mcp', 'view.personas', '-', 'assistant.toggle', 'assistant.settings', 'view.toggleSidebar', 'view.notifications', '-', 'view.zoomIn', 'view.zoomOut', 'view.zoomReset', 'view.fullScreen', 'view.alwaysOnTop']
  },
  {
    label: 'Project',
    items: ['project.toggleActive', 'project.next', 'project.previous', '-', 'task.new', '-', 'project.openExplorer', 'project.openTerminal', '-', 'project.tab.session', 'project.tab.overview', 'project.tab.tasks', 'project.tab.sessions', 'project.tab.files', 'project.tab.images', 'project.tab.changes', 'project.tab.memory', 'project.tab.skills', 'project.tab.mcp', 'project.tab.settings', '-', 'project.remove']
  },
  { label: 'Session', items: ['session.new', 'session.resume', 'session.stop', '-', 'session.compact', 'session.archive', '-', 'project.tab.sessions'] },
  {
    label: 'Help',
    items: ['help.docs', 'help.api', 'help.shortcuts', 'help.tips', 'help.releaseNotes', '-', 'help.agentSetup', 'help.checkProviders', '-', 'view.devTools', 'view.reload', 'help.logs', 'help.diagnostics', '-', 'help.checkUpdates', 'help.about']
  }
]

const EDIT: Record<string, { label: string; key: string; role: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' }> = {
  'edit.undo': { label: 'Undo', key: 'Mod+Z', role: 'undo' },
  'edit.redo': { label: 'Redo', key: 'Mod+Y', role: 'redo' },
  'edit.cut': { label: 'Cut', key: 'Mod+X', role: 'cut' },
  'edit.copy': { label: 'Copy', key: 'Mod+C', role: 'copy' },
  'edit.paste': { label: 'Paste', key: 'Mod+V', role: 'paste' },
  'edit.selectAll': { label: 'Select All', key: 'Mod+A', role: 'selectAll' }
}

export function TitleBar() {
  const [open, setOpen] = useState<number | null>(null)
  const [anchor, setAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [recentOpen, setRecentOpen] = useState(false)
  const workspace = useStore((s) => s.workspace)
  const selected = useStore((s) => s.selectedProject)
  const recent = useStore((s) => s.recent)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open === null) return
    const onDown = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest('.menubar')) setOpen(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(null)
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    const onBlur = (): void => setOpen(null)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [open])

  const openMenu = (i: number, el: HTMLElement): void => {
    const r = el.getBoundingClientRect()
    setAnchor({ x: r.left, y: r.bottom + 2 })
    setRecentOpen(false)
    setOpen(i)
  }

  const appName = useStore((s) => (s.appInfo && !s.appInfo.isPackaged ? 'Hive Dev' : 'Hive'))
  const pinned = useStore((s) => s.alwaysOnTop)
  const pinKey = commandKeybinding('view.alwaysOnTop')
  const title = [selected ? basename(selected) : null, workspace?.name, appName].filter(Boolean).join(' — ')
  useTaskbarCount(title)

  return (
    <div className="titlebar" onDoubleClick={(e) => e.target === e.currentTarget && void window.hive.invoke('window:toggleMaximize')}>
      <div className="titlebar-logo">
        <img src={iconUrl} alt="" />
      </div>
      <div className="menubar">
        {MENUS.map((m, i) => (
          <div
            key={m.label}
            className={cx('menubar-item', open === i && 'open')}
            onMouseDown={(e) => (open === i ? setOpen(null) : openMenu(i, e.currentTarget))}
            onMouseEnter={(e) => open !== null && open !== i && openMenu(i, e.currentTarget)}
          >
            {m.label}
          </div>
        ))}
      </div>
      <div className="titlebar-title">{title}</div>
      {/* Always on Top, just left of the window controls: lit while the window stays above other apps. */}
      <div className="titlebar-actions">
        <Tooltip content={`Always on Top (${pinned ? 'on' : 'off'})${pinKey ? `  ${formatKeybinding(pinKey)}` : ''}`}>
          <button className={cx('titlebar-pin', pinned && 'on')} aria-label="Always on Top" aria-pressed={pinned} onClick={toggleAlwaysOnTop}>
            <Icon name={pinned ? 'pinned' : 'pin'} />
          </button>
        </Tooltip>
      </div>
      {open !== null &&
        createPortal(
          <div className="menu" ref={menuRef} style={{ left: anchor.x, top: anchor.y }}>
            {MENUS[open].items.map((item, idx) => {
              if (item === '-') return <div key={idx} className="menu-sep" />
              if (typeof item === 'object') {
                return (
                  <div key={idx} style={{ position: 'relative' }} onMouseEnter={() => setRecentOpen(true)} onMouseLeave={() => setRecentOpen(false)}>
                    <div className="menu-item">
                      <Icon name="history" />
                      <span>Open Recent</span>
                      <span className="menu-key">
                        <Icon name="chevron-right" />
                      </span>
                    </div>
                    {recentOpen && (
                      <div className="menu" style={{ position: 'absolute', left: '100%', top: -4 }}>
                        {recent.length === 0 && <div className="menu-item disabled">No recent workspaces</div>}
                        {recent.map((r) => (
                          <div
                            key={r}
                            className="menu-item"
                            onClick={() => {
                              setOpen(null)
                              runCommand('workspace.open', r)
                            }}
                          >
                            <Icon name="folder" />
                            <span>{basename(r)}</span>
                            <span className="menu-key">{r}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              }
              if (EDIT[item]) {
                const e = EDIT[item]
                return (
                  <div
                    key={idx}
                    className="menu-item"
                    onMouseDown={(ev) => ev.preventDefault()}
                    onClick={() => {
                      setOpen(null)
                      void window.hive.invoke('window:edit', e.role)
                    }}
                  >
                    <Icon name="blank" />
                    <span>{e.label}</span>
                    <span className="menu-key">{formatKeybinding(e.key)}</span>
                  </div>
                )
              }
              const c = commands.find((x) => x.id === item)
              if (!c) return null
              const enabled = !c.when || c.when()
              const kb = commandKeybinding(item)
              return (
                <div
                  key={idx}
                  className={cx('menu-item', !enabled && 'disabled')}
                  onClick={() => {
                    if (!enabled) return
                    setOpen(null)
                    runCommand(item)
                  }}
                >
                  <Icon name={c.checked?.() ? 'check' : 'blank'} />
                  <span>{c.label}</span>
                  {kb && <span className="menu-key">{formatKeybinding(kb)}</span>}
                </div>
              )
            })}
          </div>,
          document.body
        )}
    </div>
  )
}
