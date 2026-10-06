import { DEFAULT_PERSONA, assistantPersona } from '@shared/assistant'
import type { PersonaInfo } from '@shared/types'
import * as actions from '../actions'
import { call } from '../api'
import { clearEditorDraftsUnder } from '../editorDrafts'
import { confirm, prompt, set, useStore } from '../store'
import { cx } from '../util'
import { choosePersona, usePersonas } from './Assistant'
import { DocEditor } from './DocEditor'
import { Icon, IconButton, Tooltip } from './ui'

/**
 * The Hive Assistant's personas: the workspace's Markdown files in .hive/personas, each a role and a character
 * in its own words. Listed in the sidebar and edited in the main area; Hive's own four can be restored.
 */

export const PERSONAS_TIP =
  "A mode is how the Hive Assistant works: what it puts first and how it hands things back, in a Markdown file in the workspace (.hive/personas). The panel's mode menu switches between them at once, keeping the conversation; Settings → Assistant sets the default."

export async function createPersona(): Promise<void> {
  const name = await prompt({
    title: 'New Mode',
    message: 'Creates .hive/personas/<name>.md in the workspace, to describe in your own words how the Assistant should work.',
    placeholder: 'Mode name',
    confirmLabel: 'Create',
    validate: (v) => (/[a-z0-9]/i.test(v) ? null : 'Use letters or numbers.')
  })
  if (!name) return
  const p = await actions.attempt('Could not create the persona', () => call('personas:create', name))
  if (p) set((s) => ({ selectedPersona: p.path, assistantSection: 'personas', personasVersion: s.personasVersion + 1 }))
}

async function deletePersona(p: PersonaInfo): Promise<void> {
  const ok = await confirm({ title: `Delete ${p.name}?`, message: `${p.id}.md goes to the Recycle Bin.${p.bundled ? ' It ships with Hive, so you can restore it later.' : ''}`, confirmLabel: 'Delete', danger: true })
  if (!ok) return
  if (!(await actions.attempt('Could not delete the persona', () => call('personas:delete', p.id).then(() => true)))) return
  clearEditorDraftsUnder(p.path)
  set((s) => ({ selectedPersona: s.selectedPersona === p.path ? null : s.selectedPersona, personasVersion: s.personasVersion + 1 }))
}

async function restorePersona(p: PersonaInfo): Promise<void> {
  if (p.bundled === 'changed') {
    const ok = await confirm({ title: `Revert ${p.name} to Hive's version?`, message: 'Your copy goes to the Recycle Bin and Hive puts back the mode as this version ships it.', confirmLabel: 'Revert' })
    if (!ok) return
  }
  const r = await actions.attempt('Could not restore the persona', () => call('personas:restore', p.id))
  if (r) clearEditorDraftsUnder(p.path)
  if (r) set((s) => ({ selectedPersona: r.path, personasVersion: s.personasVersion + 1 }))
}

/** The personas, in the Assistant view's sidebar: select one to read or edit it in the main area. */
export function PersonaList() {
  const selected = useStore((s) => (s.assistantSection === 'personas' ? s.selectedPersona : null))
  const settings = useStore((s) => s.settings)
  const agent = useStore((s) => s.workspace?.assistant?.agents[0] ?? null)
  const personas = usePersonas()
  const inUse = assistantPersona(agent, settings)
  const byDefault = settings?.assistant.persona || DEFAULT_PERSONA
  return (
    <>
      {personas.map((p) => (
          <div key={p.id} className={cx('row tall persona-row', selected === p.path && 'selected', p.bundled === 'missing' && 'missing')} onClick={() => set({ selectedPersona: p.path, assistantSection: 'personas' })}>
            <span className="persona-icon">{p.icon || '🐝'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="label">
                {p.name}
                {p.id === inUse && p.bundled !== 'missing' && <span className="badge success">In use</span>}
                {p.id === byDefault && <span className="badge">Default</span>}
              </div>
              <div className="desc" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {p.bundled === 'missing' ? 'Ships with Hive. Restore it to use it.' : p.description}
              </div>
            </div>
            <div className="row-actions" onClick={(e) => e.stopPropagation()}>
              {p.bundled === 'missing' ? (
                <IconButton icon="history" title="Restore this mode that ships with Hive" onClick={() => void restorePersona(p)} />
              ) : (
                <IconButton icon="trash" title="Delete mode" onClick={() => void deletePersona(p)} />
              )}
            </div>
          </div>
        ))}
      <p className="hint" style={{ padding: '4px 14px' }}>
        The Assistant takes one persona per conversation. Edit one to change its role or character; the next conversation uses it.
      </p>
    </>
  )
}

/** The selected persona's file, in the editor (unsaved edits are kept like any other editor's). */
export function PersonaView() {
  const selected = useStore((s) => s.selectedPersona)
  const personas = usePersonas()
  const agent = useStore((s) => s.workspace?.assistant?.agents[0] ?? null)
  const settings = useStore((s) => s.settings)
  const p = personas.find((x) => x.path === selected)
  if (!selected || !p) {
    return (
      <div className="empty-state" style={{ paddingTop: '18vh' }}>
        <Icon name="person" />
        Select a persona to read or edit it. The Hive Assistant takes one in each conversation.
      </div>
    )
  }
  if (p.bundled === 'missing') {
    return (
      <div className="empty-state" style={{ paddingTop: '18vh' }}>
        <span style={{ fontSize: 32 }}>{p.icon || '🐝'}</span>
        <strong>{p.name}</strong>
        <span className="faint">{p.description}</span>
        <button className="btn primary" onClick={() => void restorePersona(p)}>
          <Icon name="history" /> Restore to This Workspace
        </button>
      </div>
    )
  }
  const inUse = assistantPersona(agent, settings) === p.id
  return (
    <div className="split">
      <DocEditor
        key={p.path}
        path={p.path}
        title={`${p.icon ? `${p.icon} ` : ''}${p.name}`}
        onSaved={() => set((s) => ({ personasVersion: s.personasVersion + 1 }))}
        toolbarExtra={
          <>
            {p.updateAvailable && (
              <Tooltip content="This copy was edited, so Hive didn't update it. This Hive ships a newer version: Revert to Default brings it in.">
                <span className="badge accent">Update available</span>
              </Tooltip>
            )}
            {p.bundled === 'changed' && (
              <Tooltip content="Put back the mode as Hive ships it (your copy goes to the Recycle Bin). Hive keeps edited copies as they are; unedited ones it updates itself.">
                <button className="btn small subtle" onClick={() => void restorePersona(p)}>
                  <Icon name="discard" /> Revert to Default
                </button>
              </Tooltip>
            )}
            <Tooltip content={inUse ? "This workspace's Assistant uses this mode" : "Make this the mode of this workspace's Assistant (a running Assistant is told at once, keeping its conversation)"}>
              <button className="btn small subtle" disabled={inUse} onClick={() => void choosePersona(p)}>
                <Icon name={inUse ? 'check' : 'person'} /> {inUse ? 'In Use' : 'Use in This Workspace'}
              </button>
            </Tooltip>
            <IconButton icon="trash" title="Delete mode" onClick={() => void deletePersona(p)} />
          </>
        }
      />
    </div>
  )
}
