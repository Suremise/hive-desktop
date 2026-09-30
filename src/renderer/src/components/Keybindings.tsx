import { useEffect, useMemo, useRef, useState } from 'react'
import { keybindingProblem, resolveKeybinding } from '@shared/defaults'
import type { KeybindingOverrides, ProjectInfo } from '@shared/types'
import * as actions from '../actions'
import { call } from '../api'
import { commands, eventToKey, isProjectScoped, terminalReserved, type Command } from '../commands'
import { confirm, notify, set, useStore } from '../store'
import { cx, formatKeybinding } from '../util'
import { Icon, IconButton, Tooltip } from './ui'

/** Waits this long after the first combination for a second one, which makes a chord ("Ctrl+K Ctrl+S"). */
const CHORD_WAIT = 1200

/** Stable empty overrides, so the memos below don't recompute on every render. */
const NO_KEYS: KeybindingOverrides = {}

export function Kbd({ keys }: { keys: string | undefined }) {
  if (!keys) return <span className="faint">—</span>
  return (
    <span className="kbd-seq">
      {keys.split(' ').map((k, i) => (
        <kbd key={i}>{formatKeybinding(k)}</kbd>
      ))}
    </span>
  )
}

/** Records a key combination (or a two-step chord) while mounted. Esc cancels. */
function Recorder({ onDone, onCancel }: { onDone: (key: string) => void; onCancel: () => void }) {
  const [first, setFirst] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const firstRef = useRef<string | null>(null)
  useEffect(() => {
    set({ recordingKeys: true })
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const key = eventToKey(e)
      if (!key) return
      if (key === 'Escape') return onCancel()
      window.clearTimeout(timer.current)
      if (firstRef.current) return onDone(`${firstRef.current} ${key}`)
      firstRef.current = key
      setFirst(key)
      timer.current = window.setTimeout(() => onDone(key), CHORD_WAIT)
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.clearTimeout(timer.current)
      set({ recordingKeys: false })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <span className="kbd-recorder">
      {first ? (
        <>
          <Kbd keys={first} /> <span className="faint">then another key for a chord…</span>
        </>
      ) : (
        <span>Press the keys… <span className="faint">(Esc to cancel)</span></span>
      )}
    </span>
  )
}

interface Row {
  c: Command
  key: string | undefined
  /** default | changed | removed (global); inherited | project | removed (project). */
  source: 'default' | 'changed' | 'removed' | 'inherited' | 'project'
  overridden: boolean
}

/**
 * Keyboard shortcuts editor. Global: every command, stored in Settings. Project: the Project and
 * Session commands, stored in the project's .hive/project.json over the global ones.
 */
export function KeybindingsEditor({ project }: { project?: ProjectInfo }) {
  const settings = useStore((s) => s.settings)
  const [query, setQuery] = useState('')
  const [recording, setRecording] = useState<string | null>(null)
  const global: KeybindingOverrides = settings?.keybindings ?? NO_KEYS
  const local: KeybindingOverrides = project?.config.keybindings ?? NO_KEYS

  const rows = useMemo((): Row[] => {
    return commands
      .filter((c) => !c.internal && (!project || isProjectScoped(c)))
      .map((c) => {
        if (project) {
          const inherited = resolveKeybinding(c.id, c.keybinding, global, undefined)
          if (c.id in local) return { c, key: local[c.id] || undefined, source: local[c.id] ? 'project' : 'removed', overridden: true } as Row
          return { c, key: inherited, source: 'inherited', overridden: false } as Row
        }
        if (c.id in global) return { c, key: global[c.id] || undefined, source: global[c.id] ? 'changed' : 'removed', overridden: true } as Row
        return { c, key: c.keybinding, source: 'default', overridden: false } as Row
      })
  }, [project, global, local])

  // Shortcuts used by more than one command (within what this editor shows plus, for a project, the global rest).
  const conflicts = useMemo(() => {
    const byKey = new Map<string, string[]>()
    const add = (key: string | undefined, label: string): void => {
      if (!key) return
      const k = key.toUpperCase()
      byKey.set(k, [...(byKey.get(k) ?? []), label])
    }
    for (const r of rows) add(r.key, r.c.label)
    if (project) for (const c of commands) if (!c.internal && !isProjectScoped(c)) add(resolveKeybinding(c.id, c.keybinding, global, undefined), c.label)
    return byKey
  }, [rows, project, global])

  const q = query.trim().toLowerCase()
  const shown = rows.filter((r) => !q || `${r.c.category} ${r.c.label} ${r.c.id} ${r.key ? formatKeybinding(r.key) : ''}`.toLowerCase().includes(q))
  const categories = [...new Set(shown.map((r) => r.c.category))]

  const save = async (id: string, key: string | null | undefined): Promise<void> => {
    if (project) {
      const next = { ...local }
      if (key === undefined) delete next[id]
      else next[id] = key
      await actions.attempt('Could not save the shortcut', () => call('project:updateConfig', project.path, { keybindings: next }))
      await actions.refreshWorkspace()
    } else {
      const s = await actions.attempt('Could not save the shortcut', () => call('settings:setKeybinding', id, key))
      if (s) set({ settings: s })
    }
  }

  const record = async (id: string, key: string): Promise<void> => {
    setRecording(null)
    const problem = keybindingProblem(key)
    if (problem) return notify('warning', `${formatKeybinding(key)} can't be used`, problem)
    const others = (conflicts.get(key.toUpperCase()) ?? []).filter((l) => l !== rows.find((r) => r.c.id === id)?.c.label)
    if (others.length && !(await confirm({ title: 'Shortcut already in use', message: `${formatKeybinding(key)} is used by ${others.join(', ')}. Use it here too?`, detail: 'When two commands share a shortcut, the first one listed that is available runs. Change the other one to avoid surprises.', confirmLabel: 'Use it' }))) return
    await save(id, key)
  }

  const resetAll = async (): Promise<void> => {
    const n = rows.filter((r) => r.overridden).length
    if (!n) return
    if (!(await confirm({ title: 'Reset all shortcuts?', message: project ? `Remove ${project.name}'s ${n} shortcut change${n === 1 ? '' : 's'}; it uses the global shortcuts again.` : `Return ${n} changed shortcut${n === 1 ? '' : 's'} to the defaults.`, confirmLabel: 'Reset', danger: true }))) return
    if (project) {
      await actions.attempt('Could not reset', () => call('project:updateConfig', project.path, { keybindings: {} }))
      await actions.refreshWorkspace()
    } else set({ settings: await call('settings:reset', 'keybindings') })
  }

  const sourceLabel = (r: Row): string =>
    r.source === 'default' ? '' : r.source === 'changed' ? 'Changed' : r.source === 'project' ? 'This project' : r.source === 'removed' ? 'Removed' : 'Global'

  return (
    <div className="kb-editor">
      <div className="kb-toolbar">
        <Icon name="search" />
        <input className="input" placeholder="Search commands or keys" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="btn subtle small" disabled={!rows.some((r) => r.overridden)} onClick={() => void resetAll()}>
          <Icon name="discard" /> Reset all
        </button>
      </div>
      {project && <p className="faint kb-note">Changes here apply while {project.name} is selected, over the global shortcuts. Other commands are set in Settings → Keyboard Shortcuts.</p>}
      <table className="table kb-table">
        <tbody>
          {categories.map((cat) => (
            <FragmentRows key={cat} title={cat}>
              {shown
                .filter((r) => r.c.category === cat)
                .map((r) => {
                  const clash = r.key ? (conflicts.get(r.key.toUpperCase()) ?? []).filter((l) => l !== r.c.label) : []
                  const terminal = r.key && terminalReserved().has(r.key.toUpperCase())
                  return (
                    <tr key={r.c.id} className={cx(recording === r.c.id && 'recording')}>
                      <td className="kb-label">
                        {r.c.label}
                        <div className="faint kb-id">{r.c.id}</div>
                      </td>
                      <td className="kb-key" onDoubleClick={() => setRecording(r.c.id)}>
                        {recording === r.c.id ? (
                          <Recorder onDone={(k) => void record(r.c.id, k)} onCancel={() => setRecording(null)} />
                        ) : (
                          <>
                            <Kbd keys={r.key} />
                            {clash.length > 0 && (
                              <Tooltip content={`Also used by ${clash.join(', ')}`}>
                                <Icon name="warning" className="kb-warn" />
                              </Tooltip>
                            )}
                            {terminal && (
                              <Tooltip content="While an agent's terminal has focus this key goes to the agent, so the shortcut only works elsewhere.">
                                <Icon name="terminal" className="faint" />
                              </Tooltip>
                            )}
                          </>
                        )}
                      </td>
                      <td className="kb-source faint">{sourceLabel(r)}</td>
                      <td className="kb-actions">
                        <IconButton icon="edit" title="Change shortcut (or double-click it)" onClick={() => setRecording(r.c.id)} />
                        <IconButton icon="close" title="Remove shortcut" disabled={!r.key} onClick={() => void save(r.c.id, null)} />
                        <IconButton icon="discard" title={project ? 'Use the global shortcut' : `Reset to default${r.c.keybinding ? ` (${formatKeybinding(r.c.keybinding)})` : ''}`} disabled={!r.overridden} onClick={() => void save(r.c.id, undefined)} />
                      </td>
                    </tr>
                  )
                })}
            </FragmentRows>
          ))}
        </tbody>
      </table>
      {shown.length === 0 && <div className="pane-empty">No commands match.</div>}
    </div>
  )
}

function FragmentRows({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <tr className="kb-cat">
        <td colSpan={4}>{title}</td>
      </tr>
      {children}
    </>
  )
}
