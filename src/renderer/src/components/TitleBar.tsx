import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import iconUrl from '../assets/icon.svg'
import { commandKeybinding, commands, runCommand } from '../commands'
import { useStore } from '../store'
import { basename, cx, formatKeybinding } from '../util'
import { Icon } from './ui'

type MenuDef = { label: string; items: (string | '-' | { submenu: 'recent' })[] }

const MENUS: MenuDef[] = [
  {
    label: 'File',
    items: ['project.new', '-', 'workspace.open', 'workspace.create', { submenu: 'recent' }, 'workspace.refresh', 'workspace.close', '-', 'settings.open', '-', 'app.quit']
  },
  { label: 'Edit', items: ['edit.undo', 'edit.redo', '-', 'edit.cut', 'edit.copy', 'edit.paste', '-', 'edit.selectAll'] },
  {
    label: 'View',
    items: ['palette.show', '-', 'view.projects', 'view.notes', 'view.skills', 'view.mcp', '-', 'view.toggleSidebar', 'view.notifications', '-', 'view.zoomIn', 'view.zoomOut', 'view.zoomReset', 'view.fullScreen']
  },
  {
    label: 'Project',
    items: ['project.toggleActive', 'project.next', 'project.previous', '-', 'project.openExplorer', 'project.openTerminal', '-', 'project.tab.overview', 'project.tab.files', 'project.tab.images', 'project.tab.changes', 'project.tab.memory', 'project.tab.settings']
  },
  { label: 'Session', items: ['session.new', 'session.resume', 'session.stop', '-', 'session.compact', 'session.archive', '-', 'project.tab.sessions'] },
  {
    label: 'Help',
    items: ['help.docs', 'help.api', 'help.shortcuts', 'help.releaseNotes', '-', 'claude.setup', 'claude.check', '-', 'view.devTools', 'view.reload', 'help.logs', '-', 'help.about']
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
    window.addEventListener('blur', () => setOpen(null))
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const openMenu = (i: number, el: HTMLElement): void => {
    const r = el.getBoundingClientRect()
    setAnchor({ x: r.left, y: r.bottom + 2 })
    setRecentOpen(false)
    setOpen(i)
  }

  const appName = useStore((s) => (s.appInfo && !s.appInfo.isPackaged ? 'Hive Dev' : 'Hive'))
  const title = [selected ? basename(selected) : null, workspace?.name, appName].filter(Boolean).join(' — ')

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
                  <Icon name="blank" />
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
