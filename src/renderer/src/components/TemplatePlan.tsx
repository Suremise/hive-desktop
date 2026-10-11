import type { SettingShown, TemplateLoadView, PlaceShown } from '@shared/templateLoad'
import { isKnownProvider } from '@shared/providers'
import { ProviderIcon } from './ProviderIcon'
import { Tooltip } from './ui'

/**
 * The Load template dialog's plan (#511): who goes, then who comes as a table (agent, coding agent, model, effort,
 * mode, where), what the template leaves to the defaults shown as what it is here with a muted "(default)", a new
 * worktree by its branch with its folder on hover; then the notes. In the template's order.
 */
export function TemplatePlan({ view }: { view: TemplateLoadView }) {
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
          {view.created.map((a) => (
            <tr key={a.name} data-agent={a.name}>
              <td>
                <span className="template-plan-name">{a.name}</span>
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
