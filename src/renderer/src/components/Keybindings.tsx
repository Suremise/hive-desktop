import { useEffect, useMemo, useRef, useState } from 'react'
import { keybindingProblem, resolveKeybinding } from '@shared/defaults'
import { fmt, msg, tr, tRich } from '@shared/i18n'
import type { KeybindingOverrides, ProjectInfo } from '@shared/types'
import * as actions from '../actions'
import { call } from '../api'
import { commandCategory, commands, eventToKey, isProjectScoped, terminalReserved, type Command } from '../commands'
import { confirm, notify, set, useStore } from '../store'
import { formatKeybinding } from '../util'
import { otherUsers, shortcutUsers } from '../keyConflicts'
import { DottedId, Icon, IconButton, SearchInput, Tooltip } from './ui'
import { DataTable, type DataColumn } from './DataTable'

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

/** A message's <faint> part, greyed. */
const faint = (chunks: React.ReactNode[]): React.ReactNode => (
  <span key="faint" className="faint">
    {chunks}
  </span>
)

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
          <Kbd keys={first} /> <span className="faint">{tr(msg({ id: 'settings.keys.chordNext', defaultMessage: 'then another key for a chord…', description: 'While a shortcut is recorded, after its first key combination: press a second one for a chord (such as Ctrl+K Ctrl+S).' }))}</span>
        </>
      ) : (
        <span>{tRich(msg({ id: 'settings.keys.press', defaultMessage: 'Press the keys… <faint>(Esc to cancel)</faint>', description: 'While a shortcut is recorded, before any key. <faint> marks the part shown greyed; Esc is a key: keep it.' }), { faint })}</span>
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

  // Shortcuts used by more than one command (within what this editor shows plus, for a project, the global rest), by
  // command id: the commands are named when a clash is shown, in the language shown then (#795).
  const conflicts = useMemo(
    () =>
      shortcutUsers([
        ...rows.map((r) => ({ id: r.c.id, key: r.key })),
        ...(project ? commands.filter((c) => !c.internal && !isProjectScoped(c)).map((c) => ({ id: c.id, key: resolveKeybinding(c.id, c.keybinding, global, undefined) })) : [])
      ]),
    [rows, project, global]
  )

  const q = query.trim().toLowerCase()
  const shown = rows.filter((r) => !q || `${commandCategory(r.c)} ${r.c.label} ${r.c.id} ${r.key ? formatKeybinding(r.key) : ''}`.toLowerCase().includes(q))

  const save = async (id: string, key: string | null | undefined): Promise<void> => {
    if (project) {
      const next = { ...local }
      if (key === undefined) delete next[id]
      else next[id] = key
      await actions.attempt(tr(msg({ id: 'settings.keys.saveFailed', defaultMessage: 'Could not save the shortcut', description: "An error's title: saving a keyboard shortcut failed." })), () => call('project:updateConfig', project.path, { keybindings: next }))
      await actions.refreshWorkspace()
    } else {
      const s = await actions.attempt(tr(msg({ id: 'settings.keys.saveFailed', defaultMessage: 'Could not save the shortcut', description: "An error's title: saving a keyboard shortcut failed." })), () => call('settings:setKeybinding', id, key))
      if (s) set({ settings: s })
    }
  }

  const record = async (id: string, key: string): Promise<void> => {
    setRecording(null)
    const problem = keybindingProblem(key)
    if (problem) return notify('warning', tr(msg({ id: 'settings.keys.cantUse', defaultMessage: "{keys} can't be used", description: "Title of a warning when a recorded shortcut can't be used. {keys} is the shortcut (Ctrl+K)." }), { keys: formatKeybinding(key) }), problem)
    const others = otherUsers(conflicts, key, id).map(commandName)
    if (
      others.length &&
      !(await confirm({
        title: tr(msg({ id: 'settings.keys.inUseTitle', defaultMessage: 'Shortcut already in use', description: 'Title of the question when a recorded shortcut is already used by another command.' })),
        message: tr(msg({ id: 'settings.keys.inUseMessage', defaultMessage: '{keys} is used by {commands}. Use it here too?', description: 'The question when a recorded shortcut is already used. {keys} is the shortcut; {commands} lists the commands using it.' }), { keys: formatKeybinding(key), commands: fmt.list(others) }),
        detail: tr(msg({ id: 'settings.keys.inUseDetail', defaultMessage: 'When two commands share a shortcut, the first one listed that is available runs. Change the other one to avoid surprises.', description: 'More in the question when a recorded shortcut is already used.' })),
        confirmLabel: tr(msg({ id: 'settings.keys.useIt', defaultMessage: 'Use it', description: 'Button of the question when a recorded shortcut is already used: uses it for this command too.' }))
      }))
    )
      return
    await save(id, key)
  }

  const resetAll = async (): Promise<void> => {
    const n = rows.filter((r) => r.overridden).length
    if (!n) return
    if (
      !(await confirm({
        title: tr(msg({ id: 'settings.keys.resetAllTitle', defaultMessage: 'Reset all shortcuts?', description: 'Title of the question before every changed shortcut goes back.' })),
        message: project ? tr(msg({ id: 'settings.keys.resetAllProject', defaultMessage: "{n, plural, one {Remove {project}'s shortcut change; it uses the global shortcuts again.} other {Remove {project}'s # shortcut changes; it uses the global shortcuts again.}}", description: "The question before a project's own shortcuts are removed (Project Settings → Keyboard Shortcuts). {project} is its name; {n} how many it changed." }), { n, project: project.name }) : tr(msg({ id: 'settings.keys.resetAllGlobal', defaultMessage: '{n, plural, one {Return # changed shortcut to the defaults.} other {Return # changed shortcuts to the defaults.}}', description: 'The question before every changed shortcut goes back to its default (Settings → Keyboard Shortcuts). {n} is how many.' }), { n }),
        confirmLabel: tr(msg({ id: 'settings.keys.reset', defaultMessage: 'Reset', description: 'Button of the question before shortcuts go back to their defaults.' })),
        danger: true
      }))
    )
      return
    if (project) {
      await actions.attempt(tr(msg({ id: 'settings.keys.resetFailed', defaultMessage: 'Could not reset', description: "An error's title: resetting a project's shortcuts failed." })), () => call('project:updateConfig', project.path, { keybindings: {} }))
      await actions.refreshWorkspace()
    } else set({ settings: await call('settings:reset', 'keybindings') })
  }

  const columns = keyColumns({ project, recording, setRecording, record: (id, k) => void record(id, k), save: (id, k) => void save(id, k), conflicts })

  return (
    <div className="kb-editor">
      <div className="kb-toolbar">
        <Icon name="search" />
        <SearchInput placeholder={tr(msg({ id: 'settings.keys.search', defaultMessage: 'Search commands or keys', description: 'Placeholder of the search box of the keyboard shortcuts editor.' }))} value={query} onChange={setQuery} />
        <button className="btn subtle small" disabled={!rows.some((r) => r.overridden)} onClick={() => void resetAll()}>
          <Icon name="discard" /> {tr(msg({ id: 'settings.keys.resetAll', defaultMessage: 'Reset all', description: 'Button of the keyboard shortcuts editor: every changed shortcut goes back.' }))}
        </button>
      </div>
      {project && <p className="faint kb-note">{tr(msg({ id: 'settings.keys.projectNote', defaultMessage: 'Changes here apply while {project} is selected, over the global shortcuts. Other commands are set in Settings → Keyboard Shortcuts.', description: "Above a project's shortcuts (Project Settings → Keyboard Shortcuts). {project} is its name." }), { project: project.name })}</p>}
      {/* Every command on one page (a settings page scrolls): sorting and the Category and Source filters, no paging. */}
      <DataTable
        id={project ? 'shortcuts-project' : 'shortcuts'}
        className="kb-table"
        rows={shown}
        columns={columns}
        rowKey={(r) => r.c.id}
        pageSizes={ALL_ROWS}
        defaultPageSize={ALL_ROWS[0]}
        rowClassName={(r) => recording === r.c.id && 'recording'}
        empty={tr(msg({ id: 'settings.keys.noMatch', defaultMessage: 'No commands match.', description: 'The keyboard shortcuts editor when its search finds nothing.' }))}
      />
    </div>
  )
}

const ALL_ROWS = [1000]

/** A command's name in the language shown, by its id. */
const commandName = (id: string): string => commands.find((c) => c.id === id)?.label ?? id

/** Where a shortcut comes from, as the Set column shows it ('' for a default one). */
function sourceLabel(r: Row): string {
  switch (r.source) {
    case 'default':
      return ''
    case 'changed':
      return tr(msg({ id: 'settings.keys.source.changed', defaultMessage: 'Changed', description: "The Set column of the shortcuts editor: the user changed this command's shortcut." }))
    case 'project':
      return tr(msg({ id: 'settings.keys.source.project', defaultMessage: 'This project', description: "The Set column of a project's shortcuts: the project's own." }))
    case 'removed':
      return tr(msg({ id: 'settings.keys.source.removed', defaultMessage: 'Removed', description: "The Set column of the shortcuts editor: the user removed this command's shortcut." }))
    default:
      return globalLabel()
  }
}

const globalLabel = (): string => tr(msg({ id: 'settings.keys.source.global', defaultMessage: 'Global', description: "The Set column of a project's shortcuts: the global one (Settings)." }))
const defaultLabel = (): string => tr(msg({ id: 'settings.keys.source.default', defaultMessage: 'Default', description: "The Set column's filter, for the commands that keep their default shortcut." }))

interface KeyEditing {
  project?: ProjectInfo
  recording: string | null
  setRecording: (id: string | null) => void
  record: (id: string, key: string) => void
  save: (id: string, key: string | null | undefined) => void
  conflicts: Map<string, string[]>
}

/** The editor's columns: the command, its category, its shortcut (recorded in place), where it comes from, and its actions. */
function keyColumns({ project, recording, setRecording, record, save, conflicts }: KeyEditing): DataColumn<Row>[] {
  return [
    {
      key: 'command',
      header: tr(msg({ id: 'settings.keys.column.command', defaultMessage: 'Command', description: 'A column of the keyboard shortcuts editor: the command.' })),
      className: 'kb-label',
      cell: (r) => (
        <>
          {r.c.label}
          <div className="faint kb-id">
            <DottedId id={r.c.id} />
          </div>
        </>
      ),
      sortValue: (r) => r.c.label
    },
    { key: 'category', header: tr(msg({ id: 'settings.keys.column.category', defaultMessage: 'Category', description: "A column of the keyboard shortcuts editor: the command's category (Project, Session…)." })), className: 'kb-category faint', cell: (r) => commandCategory(r.c), sortValue: (r) => commandCategory(r.c), filter: { kind: 'choice', value: (r) => commandCategory(r.c) } }, // i18n-ignore: class names
    {
      key: 'key',
      header: tr(msg({ id: 'settings.keys.column.shortcut', defaultMessage: 'Shortcut', description: 'A column of the keyboard shortcuts editor: the keys.' })),
      className: 'kb-key',
      cell: (r) => {
        if (recording === r.c.id) return <Recorder onDone={(k) => record(r.c.id, k)} onCancel={() => setRecording(null)} />
        const clash = otherUsers(conflicts, r.key, r.c.id).map(commandName)
        const terminal = r.key && terminalReserved().has(r.key.toUpperCase())
        return (
          <span className="kb-key-value" onDoubleClick={() => setRecording(r.c.id)}>
            <Kbd keys={r.key} />
            {clash.length > 0 && (
              <Tooltip content={tr(msg({ id: 'settings.keys.alsoUsed', defaultMessage: 'Also used by {commands}', description: 'Tooltip of the warning beside a shortcut other commands use too. {commands} lists them.' }), { commands: fmt.list(clash) })}>
                <Icon name="warning" className="kb-warn" />
              </Tooltip>
            )}
            {terminal && (
              <Tooltip content={tr(msg({ id: 'settings.keys.terminalKey', defaultMessage: "While an agent's terminal has focus this key goes to the agent, so the shortcut only works elsewhere.", description: "Tooltip of the terminal icon beside a shortcut that agents' terminals keep." }))}>
                <Icon name="terminal" className="faint" />
              </Tooltip>
            )}
          </span>
        )
      },
      // Commands without a shortcut sort last.
      sortValue: (r) => (r.key ? formatKeybinding(r.key) : null)
    },
    {
      key: 'source',
      header: tr(msg({ id: 'settings.keys.column.set', defaultMessage: 'Set', description: 'A column of the keyboard shortcuts editor: where the shortcut comes from (changed, removed, this project…). Keep it short.' })),
      className: 'kb-source faint', // i18n-ignore: class names
      cell: sourceLabel,
      sortValue: (r) => sourceLabel(r) || null,
      filter: { kind: 'choice', value: (r) => sourceLabel(r) || (project ? globalLabel() : defaultLabel()) },
      choiceLabel: (v) => v
    },
    {
      key: 'actions',
      header: '',
      className: 'kb-actions',
      cell: (r) => (
        <>
          <IconButton icon="edit" action="edit-shortcut" title={tr(msg({ id: 'settings.keys.change', defaultMessage: 'Change shortcut (or double-click it)', description: "Button on a command's row of the shortcuts editor: records a new shortcut." }))} onClick={() => setRecording(r.c.id)} />
          <IconButton icon="close" title={tr(msg({ id: 'settings.keys.remove', defaultMessage: 'Remove shortcut', description: "Button on a command's row of the shortcuts editor: removes its shortcut." }))} disabled={!r.key} onClick={() => save(r.c.id, null)} />
          <IconButton
            icon="discard"
            title={project ? tr(msg({ id: 'settings.keys.useGlobal', defaultMessage: 'Use the global shortcut', description: "Button on a command's row of a project's shortcuts: goes back to the global one." })) : r.c.keybinding ? tr(msg({ id: 'settings.keys.resetToKeys', defaultMessage: 'Reset to default ({keys})', description: "Button on a command's row of the shortcuts editor: goes back to its default. {keys} is the default shortcut." }), { keys: formatKeybinding(r.c.keybinding) }) : tr(msg({ id: 'settings.keys.resetToNone', defaultMessage: 'Reset to default', description: "Button on a command's row of the shortcuts editor: goes back to its default (none)." }))}
            disabled={!r.overridden}
            onClick={() => save(r.c.id, undefined)}
          />
        </>
      )
    }
  ]
}
