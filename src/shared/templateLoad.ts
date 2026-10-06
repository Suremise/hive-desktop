// What the Load template dialog says before a template replaces a project's agents (#126, #268): who goes (marking those
// a new agent of the same name replaces), who comes with their settings in short and, for a new worktree, its branch and
// folder in this project, the setup command those worktrees run, and what happens to the removed agents.
import type { AppSettings, ProjectConfig, ProviderId, TemplateLoadPlan } from './types'
import type { TemplateAgent } from './templates'
import { agentModelShown, effortLabel } from './defaults'
import { modelCaps, type ModelInfo } from './models'
import { agentLaunchSettings, permissionLabel, projectProviderConfig, providerName, providerSettings } from './providers'

/**
 * A created agent's settings in short, as its footer will show them: model · effort · mode ("Opus 5.5 · High · Auto").
 * What the template leaves to the project or Hive's defaults is shown as what it resolves to here, marked "(default)".
 */
export function templateAgentSettings(a: TemplateAgent, cfg: Pick<ProjectConfig, 'providers' | 'defaultProvider'>, settings: AppSettings | null, info: ModelInfo): string {
  const provider = a.provider
  const pc = projectProviderConfig(cfg, provider)
  const ps = providerSettings(settings, provider)
  const own = (v: string | undefined): v is string => !!v && v !== 'inherit'
  const model = agentModelShown(provider, own(a.model) ? a.model : pc.model, ps.defaultModel, info).label
  const runModel = (own(a.model) ? a.model : own(pc.model) ? pc.model : ps.defaultModel) || info?.defaultModel || null
  const def = (s: string): string => (s.endsWith('(default)') ? s : `${s} (default)`)
  const effortShown = effortLabel(provider, undefined, a.effort ?? pc.effort, ps.defaultEffort, modelCaps(provider, runModel, info, settings).defaultEffort, settings)
  const effort = effortShown && (own(a.effort) ? effortShown : def(effortShown))
  const mode = settings ? permissionLabel(provider, agentLaunchSettings({ provider, model: a.model, effort: a.effort, permissionMode: a.permissionMode, use200kContext: a.use200kContext }, cfg, settings).permissionMode) : null
  return [model, effort, mode && (own(a.permissionMode) ? mode : def(mode))].filter(Boolean).join(' · ')
}

/** The dialog's detail: Removed and Created, the setup command, and what happens to the removed agents. */
export function templateLoadDetail(plan: Pick<TemplateLoadPlan, 'remove' | 'create' | 'worktrees' | 'setup'>, cfg: Pick<ProjectConfig, 'providers' | 'defaultProvider'>, settings: AppSettings | null, info: (p: ProviderId) => ModelInfo): string {
  const coming = new Set(plan.create.map((a) => a.name.toLowerCase()))
  const replaced = plan.remove.filter((a) => coming.has(a.name.toLowerCase())).map((a) => a.name.toLowerCase())
  // Worktrees a created agent works in again (#289): a removed agent's goes on with the new one rather than staying behind.
  const reused = new Set(plan.worktrees.flatMap((w) => (w?.reuse ? [w.path.toLowerCase()] : [])))
  const lines: string[] = []
  if (plan.remove.length) {
    lines.push('Removed:')
    for (const a of plan.remove) lines.push(`• ${a.name}${a.worktree ? (reused.has(a.worktree.path.toLowerCase()) ? ` (its worktree on ${a.worktree.branch} goes on with the new ${a.name})` : ` (its worktree and branch ${a.worktree.branch} stay)`) : ''}${replaced.includes(a.name.toLowerCase()) ? ': replaced by a new agent with the same name' : ''}`)
    lines.push('')
  }
  lines.push('Created:')
  plan.create.forEach((a, i) => {
    lines.push(`• ${a.name}${a.role ? ` — ${a.role}` : ''}${replaced.includes(a.name.toLowerCase()) ? ' (new)' : ''}: ${providerName(a.provider)}, ${templateAgentSettings(a, cfg, settings, info(a.provider))}`)
    const w = plan.worktrees[i]
    if (w?.reuse) lines.push(`    reuses its worktree on ${w.branch} in ${w.path} (clean; its branch is left as it is)`)
    else if (w) lines.push(`    own worktree on ${w.branch} (from ${w.base}) in ${w.path}${w.notReused ? ` (new: ${w.notReused})` : ''}`)
    else if (a.worktree) lines.push('    own worktree')
  })
  lines.push('')
  if (plan.setup && plan.worktrees.some((w) => w && !w.reuse)) lines.push(`Each new worktree runs the project's setup command (${plan.setup}) before its agent first starts.`)
  lines.push(`${plan.remove.length ? 'Their conversations stay in the Sessions tab, and their open cards go back (Doing ones to Todo). ' : ''}The layout becomes the template's.`)
  return lines.join('\n')
}
