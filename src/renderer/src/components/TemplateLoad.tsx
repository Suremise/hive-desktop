import { useEffect, useMemo, useState } from 'react'
import { agentNameProblem, nameTaken, sameAgentName, workspaceAgentList } from '@shared/agentNames'
import { templateLoadView } from '@shared/templateLoad'
import type { TemplateScope } from '@shared/templates'
import type { TemplateLoadPlan } from '@shared/types'
import { call, errorMessage } from '../api'
import { set, useStore } from '../store'
import { TemplatePlan } from './TemplatePlan'

/**
 * The Load template dialog's plan with its agents' names to choose (#702, Darren's decision of 12 Oct): beside each of
 * the template's names (a reference, never changed) a box for the name the agent will get. A name another project's
 * agent has, one used twice or an empty one is marked, saying what it clashes with, and the dialog's button stays greyed
 * out (`dialogBlocked`) until none is; this project's own agents don't count, as the load replaces them. No patterns or
 * prefixes are filled in. The plan (worktrees reused or new, who replaces whom) is asked for again once typing pauses.
 * `onChange` hears the names the button loads.
 */
export function TemplateLoadNames({ path, scope, file, from, initial, onChange }: { path: string; scope: TemplateScope; file: string; from?: string; initial: TemplateLoadPlan; onChange: (names: string[]) => void }) {
  const project = useStore((s) => s.workspace?.projects.find((p) => p.path === path) ?? null)
  const projects = useStore((s) => s.workspace?.projects)
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const [plan, setPlan] = useState(initial)
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
  const blocked = problems.some(Boolean) ? 'Agent names are unique across the workspace: change the marked names first.' : planError
  const key = names.join('\n')
  useEffect(() => onChange(key.split('\n')), [key, onChange])
  useEffect(() => set({ dialogBlocked: blocked }), [blocked])
  useEffect(() => () => set({ dialogBlocked: null }), [])
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
  return (
    <>
      {initial.taken.length > 0 && (
        <p className="template-plan-note" data-names-taken>
          Agent names are unique across the workspace, and {[...new Set(initial.taken.map((t) => t.project))].join(', ')} already {initial.taken.length === 1 ? 'has an agent' : 'has agents'} called {initial.taken.map((t) => t.name).join(', ')}: give {initial.taken.length === 1 ? 'it' : 'them'} other names below.
        </p>
      )}
      <TemplatePlan view={view} edit={{ from: initial.templateNames, names, problems, onName: (i, v) => setNames((x) => x.map((n, j) => (j === i ? v : n))) }} />
      {planError && <div className="field-error">{planError}</div>}
    </>
  )
}
