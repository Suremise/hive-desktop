import { useState } from 'react'
import { msg, tr } from '@shared/i18n'

/**
 * The projects to turn a workspace MCP server on in, in its workspace enable dialog (#1093): a box per project, ticked
 * where it is on (the projects' own choices, kept while the workspace had it off, and the selected project), with All
 * and None. `onChange` hears every project's pick (path → on). `warnings`: what to know about its definition (a
 * literal secret), shown first, as the dialog's detail would.
 */
export function McpProjectPicker({ projects, initial, warnings, onChange }: { projects: readonly { path: string; name: string }[]; initial: readonly string[]; warnings: readonly string[]; onChange: (picks: Record<string, boolean>) => void }) {
  const [on, setOn] = useState<string[]>(() => projects.filter((p) => initial.includes(p.path)).map((p) => p.path))
  const pick = (next: string[]): void => {
    setOn(next)
    onChange(Object.fromEntries(projects.map((p) => [p.path, next.includes(p.path)])))
  }
  const said = warnings.map((w) => <p key={w}>{w}</p>)
  if (!projects.length)
    return (
      <div className="mcp-projects">
        {said}
        <p className="hint">{tr(msg({ id: 'mcp.enable.noProjects', defaultMessage: "The workspace has no projects yet: turn it on in a project's MCP tab once there is one.", description: 'The MCP server enable dialog when the workspace has no projects to choose.' }))}</p>
      </div>
    )
  return (
    <div className="mcp-projects">
      {said}
      <div className="flex">
        <strong>{tr(msg({ id: 'mcp.enable.projects', defaultMessage: 'Turn on in', description: 'The MCP server enable dialog: the label above the projects to tick.' }))}</strong>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn small subtle" onClick={() => pick(projects.map((p) => p.path))}>
          {tr(msg({ id: 'mcp.enable.all', defaultMessage: 'All', description: 'The MCP server enable dialog: a button that ticks every project.' }))}
        </button>
        <button type="button" className="btn small subtle" onClick={() => pick([])}>
          {tr(msg({ id: 'mcp.enable.none', defaultMessage: 'None', description: 'The MCP server enable dialog: a button that unticks every project.' }))}
        </button>
      </div>
      <div className="choice-list" role="group" aria-label={tr(msg({ id: 'mcp.enable.projectsLabel', defaultMessage: 'Projects to turn it on in', description: 'Accessible name of the list of projects to tick in the MCP server enable dialog.' }))}>
        {projects.map((p) => (
          <label key={p.path} className="flex" data-project={p.name}>
            <input type="checkbox" className="checkbox" checked={on.includes(p.path)} onChange={(e) => pick(e.target.checked ? [...on, p.path] : on.filter((x) => x !== p.path))} /> {p.name}
          </label>
        ))}
      </div>
    </div>
  )
}
