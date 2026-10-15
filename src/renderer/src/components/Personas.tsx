import { DEFAULT_PERSONA, assistantPersona } from '@shared/assistant'
import type { PersonaInfo } from '@shared/types'
import * as actions from '../actions'
import { call } from '../api'
import { clearEditorDraftsUnder } from '../editorDrafts'
import { confirm, prompt, set, useStore } from '../store'
import { cx } from '../util'
import { choosePersona, personaDescription, personaName, usePersonas } from './Assistant'
import { DocEditor } from './DocEditor'
import { Icon, IconButton, Tooltip } from './ui'
import { msg, tr } from '@shared/i18n'

/**
 * The Hive Assistant's modes (personas in code): the workspace's Markdown files in .hive/personas, each how the
 * Assistant works, in its own words. Listed in the sidebar and edited in the main area; Hive's own four can be restored.
 */

export const PERSONAS_TIP = msg({ id: 'assistant.modes.tip', defaultMessage: "A mode is how the Hive Assistant works: what it puts first and how it hands things back, in a Markdown file in the workspace (.hive/personas). The panel's mode menu switches between them at once, keeping the conversation; Settings → Assistant sets the default.", description: 'Tooltip on the Modes section of the Assistant view. Keep .hive/personas as it is.' })

const M = {
  newTitle: msg({ id: 'assistant.modes.newTitle', defaultMessage: 'New Mode', description: "The title of the dialog that creates an Assistant mode (a Markdown file)." }),
  newMessage: msg({ id: 'assistant.modes.newMessage', defaultMessage: 'Creates {file} in the workspace, to describe in your own words how the Assistant should work.', description: 'The New Mode dialog. {file} is .hive/personas/<name>.md, <name> standing for the name you type.' }),
  namePlaceholder: msg({ id: 'assistant.modes.namePlaceholder', defaultMessage: 'Mode name', description: "The New Mode dialog: the name box's placeholder." }),
  create: msg({ id: 'assistant.modes.create', defaultMessage: 'Create', description: 'The New Mode dialog: its button.' }),
  lettersOrNumbers: msg({ id: 'assistant.modes.lettersOrNumbers', defaultMessage: 'Use letters or numbers.', description: "The New Mode dialog: a name with neither letters nor numbers can't be used." }),
  createFailed: msg({ id: 'assistant.modes.createFailed', defaultMessage: 'Could not create the mode', description: "An error notice: New Mode couldn't create the mode's file; the reason follows." }),
  deleteTitle: msg({ id: 'assistant.modes.deleteTitle', defaultMessage: 'Delete {name}?', description: "Confirmation before a mode is deleted; {name} is the mode's name." }),
  deleteMessage: msg({ id: 'assistant.modes.deleteMessage', defaultMessage: "{file} goes to the Recycle Bin.{bundled, select, yes { It ships with Hive, so you can restore it later.} other {}}", description: "Confirmation before a mode is deleted: {file} is its file (advisor.md). The second sentence when it is one of Hive's own." }),
  delete: msg({ id: 'assistant.modes.delete', defaultMessage: 'Delete', description: 'Confirmation before a mode is deleted: its button.' }),
  deleteFailed: msg({ id: 'assistant.modes.deleteFailed', defaultMessage: 'Could not delete the mode', description: "An error notice: a mode's file couldn't be deleted; the reason follows." }),
  revertTitle: msg({ id: 'assistant.modes.revertTitle', defaultMessage: "Revert {name} to Hive's version?", description: "Confirmation before an edited mode that ships with Hive is put back as Hive ships it." }),
  revertMessage: msg({ id: 'assistant.modes.revertMessage', defaultMessage: 'Your copy goes to the Recycle Bin and Hive puts back the mode as this version ships it.', description: "Confirmation before a mode is put back as Hive ships it." }),
  revert: msg({ id: 'assistant.modes.revert', defaultMessage: 'Revert', description: "Confirmation before a mode is put back as Hive ships it: its button." }),
  restoreFailed: msg({ id: 'assistant.modes.restoreFailed', defaultMessage: 'Could not restore the mode', description: "An error notice: a mode that ships with Hive couldn't be put back; the reason follows." }),
  inUseBadge: msg({ id: 'assistant.modes.inUseBadge', defaultMessage: 'In use', description: "A badge on the mode the workspace's Assistant uses now." }),
  defaultBadge: msg({ id: 'assistant.modes.defaultBadge', defaultMessage: 'Default', description: 'A badge on the mode a workspace uses until you choose one (Settings → Assistant).' }),
  shipsMissing: msg({ id: 'assistant.modes.shipsMissing', defaultMessage: 'Ships with Hive. Restore it to use it.', description: "Under a mode of Hive's own that was deleted from the workspace." }),
  restoreTip: msg({ id: 'assistant.modes.restoreTip', defaultMessage: 'Restore this mode that ships with Hive', description: "A button beside a deleted mode of Hive's own." }),
  deleteTip: msg({ id: 'assistant.modes.deleteTip', defaultMessage: 'Delete mode', description: "A trash button beside an Assistant mode and over an open one: deletes it." }),
  hint: msg({ id: 'assistant.modes.hint', defaultMessage: 'Choosing a mode switches a running Assistant at once and keeps its conversation. Default marks the one a workspace uses until you choose. Edit a mode to change how the Assistant works in it.', description: 'Under the list of modes. Default is the badge.' }),
  selectOne: msg({ id: 'assistant.modes.selectOne', defaultMessage: 'Select a mode to read or edit it.', description: "The Assistant view's main area with no mode selected." }),
  restoreHere: msg({ id: 'assistant.modes.restoreHere', defaultMessage: 'Restore to This Workspace', description: "A button on a deleted mode of Hive's own: puts it back in the workspace." }),
  updateTip: msg({ id: 'assistant.modes.updateTip', defaultMessage: "This copy was edited, so Hive didn't update it. This Hive ships a newer version: Revert to Default brings it in.", description: 'Tooltip on Update available, over an edited mode. Revert to Default is the button beside it.' }),
  updateBadge: msg({ id: 'assistant.modes.updateBadge', defaultMessage: 'Update available', description: "A badge on an edited mode of Hive's own when Hive ships a newer version." }),
  revertTip: msg({ id: 'assistant.modes.revertTip', defaultMessage: 'Put back the mode as Hive ships it (your copy goes to the Recycle Bin). Hive keeps edited copies as they are; unedited ones it updates itself.', description: "Tooltip on Revert to Default, over an edited mode that ships with Hive." }),
  revertButton: msg({ id: 'assistant.modes.revertButton', defaultMessage: 'Revert to Default', description: "A button on an edited mode of Hive's own: puts it back as Hive ships it." }),
  inUseTip: msg({ id: 'assistant.modes.inUseTip', defaultMessage: "This workspace's Assistant uses this mode", description: 'Tooltip on In Use, over the mode the Assistant uses.' }),
  makeItTip: msg({ id: 'assistant.modes.useTip', defaultMessage: "Make this the mode of this workspace's Assistant (a running Assistant is told at once, keeping its conversation)", description: 'Tooltip on Use in This Workspace.' }),
  inUse: msg({ id: 'assistant.modes.inUse', defaultMessage: 'In Use', description: 'A greyed button over the mode the Assistant uses.' }),
  chooseHere: msg({ id: 'assistant.modes.useHere', defaultMessage: 'Use in This Workspace', description: "A button that makes a mode the workspace Assistant's." })
}

export async function createPersona(): Promise<void> {
  const name = await prompt({
    title: tr(M.newTitle),
    message: tr(M.newMessage, { file: '.hive/personas/<name>.md' }),
    placeholder: tr(M.namePlaceholder),
    confirmLabel: tr(M.create),
    validate: (v) => (/[a-z0-9]/i.test(v) ? null : tr(M.lettersOrNumbers))
  })
  if (!name) return
  const p = await actions.attempt(tr(M.createFailed), () => call('personas:create', name))
  if (p) set((s) => ({ selectedPersona: p.path, assistantSection: 'personas', personasVersion: s.personasVersion + 1 }))
}

async function deletePersona(p: PersonaInfo): Promise<void> {
  const ok = await confirm({ title: tr(M.deleteTitle, { name: personaName(p) }), message: tr(M.deleteMessage, { file: `${p.id}.md`, bundled: p.bundled ? 'yes' : 'no' }), confirmLabel: tr(M.delete), danger: true })
  if (!ok) return
  if (!(await actions.attempt(tr(M.deleteFailed), () => call('personas:delete', p.id).then(() => true)))) return
  clearEditorDraftsUnder(p.path)
  set((s) => ({ selectedPersona: s.selectedPersona === p.path ? null : s.selectedPersona, personasVersion: s.personasVersion + 1 }))
}

async function restorePersona(p: PersonaInfo): Promise<void> {
  if (p.bundled === 'changed') {
    const ok = await confirm({ title: tr(M.revertTitle, { name: personaName(p) }), message: tr(M.revertMessage), confirmLabel: tr(M.revert) })
    if (!ok) return
  }
  const r = await actions.attempt(tr(M.restoreFailed), () => call('personas:restore', p.id))
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
          <div key={p.id} className={cx(/* i18n-ignore: class names */ 'row tall persona-row', selected === p.path && 'selected', p.bundled === 'missing' && 'missing')} data-persona={p.id} onClick={() => set({ selectedPersona: p.path, assistantSection: 'personas' })}>
            <span className="persona-icon">{p.icon || '🐝'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="label">
                {personaName(p)}
                {p.id === inUse && p.bundled !== 'missing' && <span className="badge success">{tr(M.inUseBadge)}</span>}
                {p.id === byDefault && <span className="badge">{tr(M.defaultBadge)}</span>}
              </div>
              <div className="desc" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {p.bundled === 'missing' ? tr(M.shipsMissing) : personaDescription(p)}
              </div>
            </div>
            <div className="row-actions" onClick={(e) => e.stopPropagation()}>
              {p.bundled === 'missing' ? (
                <IconButton icon="history" title={tr(M.restoreTip)} onClick={() => void restorePersona(p)} />
              ) : (
                <IconButton icon="trash" title={tr(M.deleteTip)} onClick={() => void deletePersona(p)} />
              )}
            </div>
          </div>
        ))}
      <p className="hint" style={{ padding: '4px 14px' }}>
        {tr(M.hint)}
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
        {tr(M.selectOne)}
      </div>
    )
  }
  if (p.bundled === 'missing') {
    return (
      <div className="empty-state" style={{ paddingTop: '18vh' }}>
        <span style={{ fontSize: 32 }}>{p.icon || '🐝'}</span>
        <strong>{personaName(p)}</strong>
        <span className="faint">{personaDescription(p)}</span>
        <button className="btn primary" onClick={() => void restorePersona(p)}>
          <Icon name="history" /> {tr(M.restoreHere)}
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
        title={`${p.icon ? `${p.icon} ` : ''}${personaName(p)}`}
        onSaved={() => set((s) => ({ personasVersion: s.personasVersion + 1 }))}
        toolbarExtra={
          <>
            {p.updateAvailable && (
              <Tooltip content={tr(M.updateTip)}>
                <span className="badge accent">{tr(M.updateBadge)}</span>
              </Tooltip>
            )}
            {p.bundled === 'changed' && (
              <Tooltip content={tr(M.revertTip)}>
                <button className="btn small subtle" onClick={() => void restorePersona(p)}>
                  <Icon name="discard" /> {tr(M.revertButton)}
                </button>
              </Tooltip>
            )}
            <Tooltip content={tr(inUse ? M.inUseTip : M.makeItTip)}>
              <button className="btn small subtle" disabled={inUse} onClick={() => void choosePersona(p)}>
                <Icon name={inUse ? 'check' : 'person'} /> {tr(inUse ? M.inUse : M.chooseHere)}
              </button>
            </Tooltip>
            <IconButton icon="trash" title={tr(M.deleteTip)} onClick={() => void deletePersona(p)} />
          </>
        }
      />
    </div>
  )
}
