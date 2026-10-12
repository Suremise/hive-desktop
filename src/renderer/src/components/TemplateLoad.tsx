import { useEffect, useMemo, useState } from 'react'
import { agentNameProblem, nameTaken, prefixedNames, projectPrefix, sameAgentName, workspaceAgentList } from '@shared/agentNames'
import { templateLoadView } from '@shared/templateLoad'
import type { TemplateScope } from '@shared/templates'
import type { TemplateLoadPlan } from '@shared/types'
import { call, errorMessage } from '../api'
import { useStore } from '../store'
import { TemplatePlan } from './TemplatePlan'

/** What the Load template dialog's button loads with (#702): the names as they are now, or why they can't be used. */
export interface LoadNames {
  names: string[]
  problem: string | null
}

/**
 * The Load template dialog's plan with its agents' names to choose (#702): a prefix that goes in front of each of the
 * template's names ("AM" gives AMB1, AMR1), and each name editable. A name another project's agent has, one used twice
 * or an empty one is marked; the plan (worktrees reused or new, who replaces whom) is asked for again once typing
 * pauses. `onChange` hears what the dialog's button loads.
 */
export function TemplateLoadNames({ path, scope, file, from, initial, initialPrefix, onChange }: { path: string; scope: TemplateScope; file: string; from?: string; initial: TemplateLoadPlan; initialPrefix: string; onChange: (now: LoadNames) => void }) {
  const project = useStore((s) => s.workspace?.projects.find((p) => p.path === path) ?? null)
  const projects = useStore((s) => s.workspace?.projects)
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const [plan, setPlan] = useState(initial)
  const [prefix, setPrefix] = useState(initialPrefix)
  const [names, setNames] = useState(() => initial.create.map((a) => a.name))
  const [planError, setPlanError] = useState<string | null>(null)
  // This project's agents don't count: the load replaces them.
  const others = useMemo(() => workspaceAgentList(projects).filter((a) => a.project.toLowerCase() !== (project?.name ?? '').toLowerCase()), [projects, project])
  const problems = names.map((n, i) => {
    const why = agentNameProblem(n)
    if (why) return why
    if (names.findIndex((m) => sameAgentName(m, n)) !== i) return 'Another of its agents has this name.'
    const owner = nameTaken(n, others)
    return owner ? `${owner.project} has an agent called ${owner.name}.` : null
  })
  const problem = problems.find(Boolean) ?? planError
  const said = problem ? `${problem} Agent names are unique across the workspace: change it, or the prefix.` : null
  const key = names.join('\n')
  useEffect(() => onChange({ names: key.split('\n'), problem: said }), [key, said, onChange])
  useEffect(() => {
    if (key === initial.create.map((a) => a.name).join('\n')) return setPlan(initial)
    let live = true
    const t = setTimeout(() => {
      void call('templates:plan', path, scope, file, from, key.split('\n'))
        .then((p) => live && (setPlan(p), setPlanError(null)))
        .catch((e) => live && setPlanError(errorMessage(e)))
    }, 300)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [key, path, scope, file, from, initial])
  if (!project) return null
  const view = templateLoadView(plan, project.config, settings, (id) => providers[id])
  const example = prefixedNames(prefix || projectPrefix(project.name), plan.templateNames.slice(0, 2)).join(', ')
  return (
    <>
      <div className="template-load-prefix">
        <label htmlFor="template-prefix">Name prefix</label>
        <input
          id="template-prefix"
          className="input"
          value={prefix}
          maxLength={20}
          placeholder={`e.g. ${projectPrefix(project.name)}`}
          onChange={(e) => {
            setPrefix(e.target.value)
            setNames(prefixedNames(e.target.value, plan.templateNames))
          }}
        />
        <span className="faint">
          Goes in front of each name ({example}…). Agent names are unique across the workspace; each can be changed below too.
        </span>
      </div>
      <TemplatePlan view={view} edit={{ names, problems, onName: (i, v) => setNames((x) => x.map((n, j) => (j === i ? v : n))) }} />
      {planError && <div className="field-error">{planError}</div>}
    </>
  )
}
