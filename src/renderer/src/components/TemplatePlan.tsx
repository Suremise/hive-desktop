import type { SettingShown, TemplateLoadView, PlaceShown } from '@shared/templateLoad'
import { isKnownProvider } from '@shared/providers'
import { ProviderIcon } from './ProviderIcon'
import { Tooltip } from './ui'
import { AGENT_NAME_MAX } from '@shared/agentNames'
import { cx } from '../util'

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
          <h4>Removed</h4>
          <ul className="template-plan-removed">
            {view.removed.map((a) => (
              <li key={a.name} data-agent={a.name}>
                <strong>{a.name}</strong>
                {a.replaced && <span className="faint"> (replaced by a new agent with the same name)</span>}
                {a.note && <div className="faint">{a.note[0].toUpperCase() + a.note.slice(1)}.</div>}
              </li>
            ))}
          </ul>
        </>
      )}
      <h4>Created</h4>
      <table className="table template-plan-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Coding agent</th>
            <th>Model</th>
            <th>Effort</th>
            <th>Mode</th>
            <th>Where</th>
          </tr>
        </thead>
        <tbody>
          {view.created.map((a, i) => (
            // By place while names are edited: a key that changed with each key press would lose the field's focus.
            <tr key={edit ? i : a.name} data-agent={a.name}>
              <td>
                {edit ? (
                  <>
                    <input className={cx('input template-plan-name-input', edit.problems[i] && 'invalid')} aria-label={`Name of agent ${i + 1}`} value={edit.names[i] ?? ''} maxLength={AGENT_NAME_MAX} onChange={(e) => edit.onName(i, e.target.value)} />
                    {edit.problems[i] && <div className="field-error">{edit.problems[i]}</div>}
                  </>
                ) : (
                  <span className="template-plan-name">{a.name}</span>
                )}
                {a.replaces && <span className="badge">new</span>}
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

/** The created agents' names, editable in the Load template dialog (#702), each with why it can't be used. */
export interface NameEdit {
  names: string[]
  problems: (string | null)[]
  onName: (index: number, name: string) => void
}

function Setting({ s }: { s: SettingShown }) {
  return (
    <>
      {s.text}
      {s.isDefault && <span className="faint template-plan-default"> (default)</span>}
    </>
  )
}

function Place({ w }: { w: PlaceShown }) {
  if (w.kind === 'folder') return <>project folder</>
  if (w.kind === 'own') return <>own worktree</>
  const text = w.kind === 'reuse' ? `reuses ${w.branch}` : `own worktree ${w.branch}`
  const tip = w.kind === 'reuse' ? `Works in its worktree again: ${w.path} (clean; its branch is left as it is)` : `A new worktree in ${w.path}, from ${w.base}`
  return (
    <Tooltip content={tip}>
      <span className="template-plan-place" data-path={w.path}>
        {text}
        {w.note && <div className="faint">{w.note}</div>}
      </span>
    </Tooltip>
  )
}
