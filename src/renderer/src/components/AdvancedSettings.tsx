import { useEffect, useMemo, useState } from 'react'
import { ADVANCED_DEFS, advancedRow, advancedTakes, advancedText, checkAdvanced, cliFacing, groupName, type AdvancedDef, type AdvancedRow } from '@shared/advanced'
import type { ProviderId } from '@shared/types'
import { call, errorMessage } from '../api'
import { notify, set, useStore } from '../store'
import { NumberField } from './NumberField'
import { Icon, IconButton, InfoTip, SearchInput, Switch, Tooltip } from './ui'
import { cx } from '../util'

/**
 * Settings → Advanced's list (#367), in the manner of about:config: every overridable default, grouped by Hive and each
 * CLI, searchable, a modified one marked with its default beside it and Reset. A value that isn't valid says why (Hive
 * uses the default); a CLI's value that no longer finds what the CLI was recorded sending, or that was made for another
 * CLI version, says so, with Keep for the installed version. Values a workspace can set have a This workspace box too.
 * advanced.json holds the same values, Show developer features too: Open advanced.json edits them by hand, and the list
 * follows the file. `query` and `modifiedOnly` are Settings' own search and Modified only, on top of the list's.
 */
export function AdvancedSettings({ query, modifiedOnly: outerModified }: { query: string; modifiedOnly: boolean }) {
  const state = useStore((s) => s.advanced)
  const hasWorkspace = useStore((s) => !!s.workspace)
  const [filter, setFilter] = useState('')
  const [ownModified, setModifiedOnly] = useState(false)
  const modifiedOnly = outerModified || ownModified
  const words = `${query} ${filter}`.toLowerCase().split(/\s+/).filter(Boolean)
  const rows = useMemo(() => ADVANCED_DEFS.map((d) => advancedRow(d, state)), [state])
  const matches = (text: string): boolean => words.every((w) => text.toLowerCase().includes(w))
  const shown = rows.filter((r) => (!modifiedOnly || r.override !== undefined || r.workspaceValue !== undefined) && matches(`${r.def.id} ${r.def.setting ?? ''} ${groupName(r.def.group)} ${r.def.title} ${r.def.desc}`))
  const groups = [...new Set(ADVANCED_DEFS.map((d) => d.group))]
  if (!state) return null
  return (
    <div className="advanced-list">
      <div className="advanced-bar">
        <SearchInput placeholder="Filter advanced settings" aria-label="Filter advanced settings" value={filter} onChange={setFilter} />
        <label className="flex muted">
          <input type="checkbox" className="checkbox" checked={modifiedOnly} disabled={outerModified} onChange={(e) => setModifiedOnly(e.target.checked)} /> Modified only
        </label>
        <button className="btn subtle" onClick={() => void call('advanced:open').catch((e) => notify('error', 'Could not open advanced.json', errorMessage(e)))}>
          <Icon name="go-to-file" /> Open advanced.json
        </button>
      </div>
      {state.fileError && (
        <div className="advanced-note error" role="alert">
          <Icon name="warning" /> {state.fileError} Hive keeps using the values it read before; fix the file to change them.
        </div>
      )}
      {state.unknown.length > 0 && (
        <div className="advanced-note">
          <Icon name="info" /> advanced.json also names {state.unknown.join(', ')}, which this Hive doesn't know (a typo, or a newer Hive's): kept in the file, not used.
        </div>
      )}
      {groups.map((g) => {
        const list = shown.filter((r) => r.def.group === g)
        if (!list.length) return null
        return (
          <div key={g} className="advanced-group" role="group" aria-label={groupName(g)}>
            <h3>{groupName(g)}</h3>
            {list.map((r) => (
              <AdvancedItem key={r.def.id} row={r} cli={cliFacing(r.def) ? (state.cli[r.def.group as ProviderId] ?? null) : null} workspace={hasWorkspace} />
            ))}
          </div>
        )
      })}
      {!shown.length && <div className="empty-state">No advanced settings match.</div>}
    </div>
  )
}

function Modified() {
  return (
    <Tooltip content="Modified from the default">
      <span className="modified" />
    </Tooltip>
  )
}

/** Sets a value (null: back to the default, or a workspace's to Settings → Advanced's); a refusal shows its reason. */
async function save(def: AdvancedDef, value: unknown, scope: 'app' | 'workspace' = 'app'): Promise<string | null> {
  try {
    set({ advanced: await call('advanced:set', def.id, value, scope) })
    return null
  } catch (e) {
    return errorMessage(e)
  }
}

/**
 * What a box shows for a value as written (in advanced.json or workspace.json): as Hive reads it when it checks out (a
 * number written as text, "600", is 600), as written when it doesn't and the box can show text, else `fallback`.
 */
function shownValue(def: AdvancedDef, raw: unknown, fallback: unknown): unknown {
  if (raw === undefined || raw === null) return fallback
  const checked = checkAdvanced(def, raw)
  if ('value' in checked) return checked.value
  return def.kind === 'number' || def.kind === 'boolean' ? fallback : raw
}

function AdvancedItem({ row, cli, workspace }: { row: AdvancedRow; cli: string | null; workspace: boolean }) {
  const { def } = row
  const modified = row.override !== undefined
  const [error, setError] = useState<string | null>(null)
  const commit = async (v: unknown, scope: 'app' | 'workspace' = 'app'): Promise<void> => {
    const err = await save(def, v, scope)
    setError(err)
    if (err) throw new Error(err)
  }
  const label = `${groupName(def.group)}: ${def.title}`
  const about = [
    advancedTakes(def),
    def.applies === 'sessions' ? 'Applies to sessions started afterwards.' : '',
    cliFacing(def) ? `It is ${groupName(def.group)}'s: a change records the version it was made for.` : '',
    def.setting ? `Hive's setting ${def.setting}, kept in advanced.json too.` : ''
  ].filter(Boolean)
  return (
    <div className={cx('setting advanced-row', row.problem && 'invalid')} data-advanced={def.id}>
      <div className="s-text">
        <div className="s-title">
          {modified && <Modified />}
          {def.title}
          <InfoTip text={<span style={{ whiteSpace: 'pre-line' }}>{about.join('\n')}</span>} />
          {modified && <IconButton icon="discard" title={`Reset to default (${advancedText(def, def.default)})`} onClick={() => void commit(null).catch(() => undefined)} />}
        </div>
        <div className="advanced-id">{def.id}</div>
        <div className="s-desc">{def.desc}</div>
        {modified && (
          <div className="s-desc">
            Default: <code>{advancedText(def, def.default)}</code>
          </div>
        )}
        {row.problem && (
          <div className="advanced-note error">
            <Icon name="error" /> Not valid, so Hive uses the default: {row.problem}
          </div>
        )}
        {row.miss && (
          <div className="advanced-note warn">
            <Icon name="warning" /> {row.miss}
          </div>
        )}
        {row.madeForOther && (
          <div className="advanced-note warn">
            <Icon name="warning" /> Made for {groupName(def.group)} {row.madeForOther}; {cli} is installed now. Check it still works, then keep it for {cli}.
            <button className="btn small subtle" onClick={() => void call('advanced:keep', def.id).then((s) => set({ advanced: s })).catch((e) => notify('error', 'Could not keep it', errorMessage(e)))}>
              Keep for {cli}
            </button>
          </div>
        )}
        {error && <div className="field-error">{error}</div>}
      </div>
      <div className="s-control advanced-control">
        {/* Settings' own value (not this workspace's). */}
        <ValueBox def={def} value={shownValue(def, row.override, def.default)} label={label} onCommit={(v) => commit(v)} />
        {def.workspace && workspace && (
          <div className="advanced-workspace">
            <span className="muted">This workspace</span>
            <ValueBox def={def} value={shownValue(def, row.workspaceValue, null)} label={`${label}, this workspace`} placeholder={`${advancedText(def, shownValue(def, row.override, def.default))} (Settings')`} onCommit={(v) => commit(v, 'workspace')} />
          </div>
        )}
      </div>
    </div>
  )
}

/** The value's box: a switch, a number field, or text saved on Enter or leaving it (empty: back to the default, or Settings'). */
function ValueBox({ def, value, label, placeholder, onCommit }: { def: AdvancedDef; value: unknown; label: string; placeholder?: string; onCommit: (v: unknown) => Promise<void> }) {
  const shown = (v: unknown): string => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v))
  const [draft, setDraft] = useState(shown(value))
  useEffect(() => setDraft(shown(value)), [value])
  if (def.kind === 'boolean') return <Switch checked={value === true} label={label} onChange={(v) => void onCommit(v).catch(() => undefined)} />
  if (def.kind === 'number')
    return <NumberField value={typeof value === 'number' ? value : null} min={def.min} max={def.max} step={1} inherit={placeholder} label={label} onCommit={(v) => onCommit(v)} />
  const commit = (): void => {
    const v = draft.trim()
    if (v === shown(value)) return
    void onCommit(v === '' ? null : def.kind === 'list' ? v : draft).catch(() => setDraft(shown(value)))
  }
  return (
    <input
      className="input mono"
      aria-label={label}
      spellCheck={false}
      value={draft}
      placeholder={placeholder ?? advancedText(def, def.default)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') setDraft(shown(value))
      }}
    />
  )
}
