import type { SettingShown, TemplateLoadView, PlaceShown } from '@shared/templateLoad'
import { isKnownProvider } from '@shared/providers'
import { ProviderIcon } from './ProviderIcon'
import { Icon, Tooltip } from './ui'
import { AGENT_NAME_MAX } from '@shared/agentNames'
import { cx } from '../util'
import { locale, msg, tr, tRich } from '@shared/i18n'
import { Children, type ReactNode } from 'react'

const M = {
  removed: msg({ id: 'assistant.templatePlan.removed', defaultMessage: 'Removed', description: 'Load template: the heading over the agents that go.' }),
  replaced: msg({ id: 'assistant.templatePlan.replaced', defaultMessage: '(replaced by a new agent with the same name)', description: 'Load template, after an agent that goes.' }),
  noteSentence: msg({ id: 'assistant.templatePlan.noteSentence', defaultMessage: '{note}.', description: "Load template, under an agent that goes: what happens to its worktree ({note}), as a sentence (its first letter made a capital). Use your language's full stop." }),
  created: msg({ id: 'assistant.templatePlan.created', defaultMessage: 'Created', description: "Load template: the heading over the template's agents." }),
  agent: msg({ id: 'assistant.templatePlan.agent', defaultMessage: 'Agent', description: "Load template's table: the column of the agents' names." }),
  codingAgent: msg({ id: 'assistant.templatePlan.codingAgent', defaultMessage: 'Coding agent', description: "Load template's table: the column of each agent's CLI (Claude Code, Codex…)." }),
  model: msg({ id: 'assistant.templatePlan.model', defaultMessage: 'Model', description: "Load template's table: a column." }),
  effort: msg({ id: 'assistant.templatePlan.effort', defaultMessage: 'Effort', description: "Load template's table: a column (the model's reasoning effort)." }),
  mode: msg({ id: 'assistant.templatePlan.mode', defaultMessage: 'Mode', description: "Load template's table: a column (the permission mode)." }),
  where: msg({ id: 'assistant.templatePlan.where', defaultMessage: 'Where', description: "Load template's table: a column (the folder or worktree each agent works in)." }),
  fromTip: msg({ id: 'assistant.templatePlan.fromTip', defaultMessage: 'Its name in the template', description: "Load template's table: tooltip on an agent's name as the template has it, beside the box for its new name." }),
  nameLabel: msg({ id: 'assistant.templatePlan.nameLabel', defaultMessage: 'Name of agent {n}', description: "Load template's table: the accessible name of the box for agent number {n}'s name." }),
  newBadge: msg({ id: 'assistant.templatePlan.newBadge', defaultMessage: 'new', description: 'Load template\'s table: a badge on an agent that replaces one of the same name.' }),
  withNote: msg({ id: 'assistant.templatePlan.withNote', defaultMessage: '{thing} <faint>{note}</faint>', description: "Load template: a name or a setting ({thing}), then a note about it in brackets ({note}, which brings its brackets: \"(default)\"), greyed. Keep the <faint> tags around {note}. Japanese and Chinese: no space before full-width brackets." }),
  isDefault: msg({ id: 'assistant.templatePlan.default', defaultMessage: '(default)', description: "Load template's table, after a model, effort or mode: the template leaves it to the project's or Hive's defaults." }),
  folder: msg({ id: 'assistant.templatePlan.folder', defaultMessage: 'project folder', description: "Load template's table, Where: the agent works in the project's folder." }),
  ownWorktree: msg({ id: 'assistant.templatePlan.ownWorktree', defaultMessage: 'own worktree', description: "Load template's table, Where: the agent gets a worktree of its own." }),
  reuses: msg({ id: 'assistant.templatePlan.reuses', defaultMessage: 'reuses {branch}', description: "Load template's table, Where: the agent works in an old worktree again, on branch {branch}." }),
  ownOn: msg({ id: 'assistant.templatePlan.ownOn', defaultMessage: 'own worktree {branch}', description: "Load template's table, Where: the agent's new worktree, on branch {branch}." }),
  reuseTip: msg({ id: 'assistant.templatePlan.reuseTip', defaultMessage: 'Works in its worktree again: {path} (clean; its branch is left as it is)', description: "Load template's table: tooltip on a worktree worked in again ({path}: its folder)." }),
  newTip: msg({ id: 'assistant.templatePlan.newTip', defaultMessage: 'A new worktree in {path}, from {base}', description: "Load template's table: tooltip on a new worktree ({path}: its folder; {base}: the branch it starts from)." })
}

/** A note's first letter as a capital, in the window's language. */
const capitalised = (s: string): string => s.charAt(0).toLocaleUpperCase(locale()) + s.slice(1)

/**
 * The Load template dialog's plan (#511): who goes, then who comes as a table (agent, coding agent, model, effort,
 * mode, where), what the template leaves to the defaults shown as what it is here with a muted "(default)", a new
 * worktree by its branch with its folder on hover; then the notes. In the template's order.
 */
export function TemplatePlan({ view, edit }: { view: TemplateLoadView; edit?: NameEdit }) {
  return (
    <div className="template-plan">
      {view.removed.length > 0 && (
        <>
          <h4>{tr(M.removed)}</h4>
          <ul className="template-plan-removed">
            {view.removed.map((a) => (
              <li key={a.name} data-agent={a.name}>
                {a.replaced ? withNote(<strong>{a.name}</strong>, tr(M.replaced), 'faint') : <strong>{a.name}</strong>}
                {a.note && <div className="faint">{tr(M.noteSentence, { note: capitalised(a.note) })}</div>}
              </li>
            ))}
          </ul>
        </>
      )}
      <h4>{tr(M.created)}</h4>
      <table className="table template-plan-table">
        <thead>
          <tr>
            <th>{tr(M.agent)}</th>
            <th>{tr(M.codingAgent)}</th>
            <th>{tr(M.model)}</th>
            <th>{tr(M.effort)}</th>
            <th>{tr(M.mode)}</th>
            <th>{tr(M.where)}</th>
          </tr>
        </thead>
        <tbody>
          {view.created.map((a, i) => (
            // By place while names are edited: a key that changed with each key press would lose the field's focus.
            <tr key={edit ? i : a.name} data-agent={a.name}>
              <td>
                {edit ? (
                  <>
                    <span className="template-plan-from" title={tr(M.fromTip)}>
                      {edit.from[i]}
                    </span>
                    <Icon name="arrow-right" className="template-plan-arrow" />
                    <input className={cx(/* i18n-ignore: class names */ 'input template-plan-name-input', edit.problems[i] && 'invalid')} aria-label={tr(M.nameLabel, { n: i + 1 })} value={edit.names[i] ?? ''} maxLength={AGENT_NAME_MAX} onChange={(e) => edit.onName(i, e.target.value)} />
                    {edit.problems[i] && <div className="field-error">{edit.problems[i]}</div>}
                  </>
                ) : (
                  <span className="template-plan-name">{a.name}</span>
                )}
                {a.replaces && <span className="badge">{tr(M.newBadge)}</span>}
                {a.role && <div className="faint">{a.role}</div>}
              </td>
              <td>
                <span className="badge template-plan-provider">
                  {isKnownProvider(a.provider) && <ProviderIcon provider={a.provider} />}
                  {a.providerName}
                </span>
              </td>
              <td>
                <Setting s={a.model} />
              </td>
              <td>{a.effort ? <Setting s={a.effort} /> : <span className="faint">—</span>}</td>
              <td>{a.mode ? <Setting s={a.mode} /> : <span className="faint">—</span>}</td>
              <td>
                <Place w={a.where} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {view.notes.map((n) => (
        <p key={n} className="template-plan-note">
          {n}
        </p>
      ))}
    </div>
  )
}

/** The created agents' names, editable in the Load template dialog (#702) beside the template's own (`from`), each with why it can't be used. */
export interface NameEdit {
  from: string[]
  names: string[]
  problems: (string | null)[]
  onName: (index: number, name: string) => void
}

/** A name or setting with a note in brackets after it, spaced as the language does (#893: none before （ in Japanese). */
function withNote(thing: ReactNode, note: string, className: string): ReactNode[] {
  return Children.toArray(tRich<ReactNode>(M.withNote, { thing, note, faint: (chunks) => <span className={className}>{chunks}</span> }))
}

function Setting({ s }: { s: SettingShown }) {
  return <>{s.isDefault ? withNote(s.text, tr(M.isDefault), 'faint template-plan-default') : s.text}</> // i18n-ignore: class names
}

function Place({ w }: { w: PlaceShown }) {
  if (w.kind === 'folder') return <>{tr(M.folder)}</>
  if (w.kind === 'own') return <>{tr(M.ownWorktree)}</>
  const text = tr(w.kind === 'reuse' ? M.reuses : M.ownOn, { branch: w.branch ?? '' })
  const tip = w.kind === 'reuse' ? tr(M.reuseTip, { path: w.path ?? '' }) : tr(M.newTip, { path: w.path ?? '', base: w.base ?? '' })
  return (
    <Tooltip content={tip}>
      <span className="template-plan-place" data-path={w.path}>
        {text}
        {w.note && <div className="faint">{w.note}</div>}
      </span>
    </Tooltip>
  )
}
