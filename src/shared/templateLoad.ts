// What the Load template dialog says before a template replaces a project's agents (#126, #268): who goes (marking those
// a new agent of the same name replaces), who comes with their settings in short and, for a new worktree, its branch and
// folder in this project, the setup command those worktrees run, and what happens to the removed agents.
import type { AppSettings, OldWorktreeOutcome, ProjectConfig, ProviderId, TemplateLoadPlan } from './types'
import type { TemplateAgent } from './templates'
import { agentModelShown, effortLabel } from './defaults'
import { modelCaps, type ModelInfo } from './models'
import { agentLaunchSettings, permissionLabel, projectProviderConfig, providerName, providerSettings } from './providers'

/** A created agent's setting as the dialog shows it: what it resolves to here, and whether the template left it to the defaults. */
export interface SettingShown {
  text: string
  isDefault: boolean
}

/**
 * A created agent's settings, as its footer will show them: model, effort and mode. What the template leaves to the
 * project or Hive's defaults is shown as what it resolves to here, marked as the default.
 */
export function templateAgentParts(a: TemplateAgent, cfg: Pick<ProjectConfig, 'providers' | 'defaultProvider'>, settings: AppSettings | null, info: ModelInfo): { model: SettingShown; effort: SettingShown | null; mode: SettingShown | null } {
  const provider = a.provider
  const pc = projectProviderConfig(cfg, provider)
  const ps = providerSettings(settings, provider)
  const own = (v: string | undefined): v is string => !!v && v !== 'inherit'
  const bare = (s: string): string => s.replace(/ \(default\)$/, '')
  // What it resolves to here; marked the default whenever the template leaves it to the project or Hive, the project's own
  // choice included (#310), as its effort and mode are.
  const shownModel = agentModelShown(provider, own(a.model) ? a.model : pc.model, ps.defaultModel, info).label
  // ("Claude Code default", when nothing says which model, is one already: it isn't marked again.)
  const model = { text: bare(shownModel), isDefault: !own(a.model) && !shownModel.endsWith(' default') }
  const runModel = (own(a.model) ? a.model : own(pc.model) ? pc.model : ps.defaultModel) || info?.defaultModel || null
  const effortShown = effortLabel(provider, undefined, a.effort ?? pc.effort, ps.defaultEffort, modelCaps(provider, runModel, info, settings).defaultEffort, settings)
  const effort = effortShown ? { text: bare(effortShown), isDefault: !own(a.effort) || effortShown.endsWith('(default)') } : null
  const modeShown = settings ? permissionLabel(provider, agentLaunchSettings({ provider, model: a.model, effort: a.effort, permissionMode: a.permissionMode, use200kContext: a.use200kContext }, cfg, settings).permissionMode) : null
  const mode = modeShown ? { text: bare(modeShown), isDefault: !own(a.permissionMode) || modeShown.endsWith('(default)') } : null
  return { model, effort, mode }
}

const shownText = (s: SettingShown): string => (s.isDefault ? `${s.text} (default)` : s.text)

/** A created agent's settings in short, as its footer will show them: model · effort · mode ("Opus 5.5 · High · Auto"), defaults marked "(default)". */
export function templateAgentSettings(a: TemplateAgent, cfg: Pick<ProjectConfig, 'providers' | 'defaultProvider'>, settings: AppSettings | null, info: ModelInfo): string {
  const { model, effort, mode } = templateAgentParts(a, cfg, settings, info)
  return [model, effort, mode].filter((x): x is SettingShown => !!x).map(shownText).join(' · ')
}

type PlanIn = Pick<TemplateLoadPlan, 'remove' | 'create' | 'worktrees' | 'setup'> & Partial<Pick<TemplateLoadPlan, 'oldWorktrees' | 'mergedInto'>>

/**
 * Where a created agent works (#511): the project folder, a new worktree (its branch, folder and base), one it works in
 * again (#289), or its own worktree with no place known yet; a note on why it is new.
 */
export interface PlaceShown {
  kind: 'folder' | 'new' | 'reuse' | 'own'
  branch?: string
  path?: string
  base?: string
  note?: string
}

/** The Load template dialog's plan (#511, as a table): who goes and what happens to their worktrees, who comes, and the notes after. */
export interface TemplateLoadView {
  removed: { name: string; note: string; replaced: boolean }[]
  created: { name: string; role?: string; replaces: boolean; provider: ProviderId; providerName: string; model: SettingShown; effort: SettingShown | null; mode: SettingShown | null; where: PlaceShown }[]
  notes: string[]
}

export function templateLoadView(plan: PlanIn, cfg: Pick<ProjectConfig, 'providers' | 'defaultProvider'>, settings: AppSettings | null, info: (p: ProviderId) => ModelInfo): TemplateLoadView {
  const coming = new Set(plan.create.map((a) => a.name.toLowerCase()))
  const replaced = new Set(plan.remove.filter((a) => coming.has(a.name.toLowerCase())).map((a) => a.name.toLowerCase()))
  // Worktrees a created agent works in again (#289): a removed agent's goes on with the new one rather than staying behind.
  const reused = new Set(plan.worktrees.flatMap((w) => (w?.reuse ? [w.path.toLowerCase()] : [])))
  // What happens to each removed agent's worktree: worked in again, removable (merged and clean: the tick box), or kept, why (#289).
  const old = (a: TemplateLoadPlan['remove'][number]): string => {
    if (!a.worktree) return ''
    if (reused.has(a.worktree.path.toLowerCase())) return `its worktree on ${a.worktree.branch} goes on with the new ${a.name}`
    const o = plan.oldWorktrees?.find((w) => w.path.toLowerCase() === a.worktree!.path.toLowerCase())
    if (o?.removable) return `its worktree and branch ${a.worktree.branch}, merged into ${plan.mergedInto ?? 'the main branch'} and clean, stay unless you tick below`
    return `its worktree and branch ${a.worktree.branch} stay${o?.why ? `: ${o.why}` : ''}`
  }
  const removed = plan.remove.map((a) => ({ name: a.name, note: old(a), replaced: replaced.has(a.name.toLowerCase()) }))
  const created = plan.create.map((a, i) => {
    const w = plan.worktrees[i]
    const where: PlaceShown = w?.reuse
      ? { kind: 'reuse', branch: w.branch, path: w.path }
      : w
        ? { kind: 'new', branch: w.branch, path: w.path, base: w.base, ...(w.notReused ? { note: `new: ${w.notReused}` } : {}) }
        : { kind: a.worktree ? 'own' : 'folder' }
    return { name: a.name, ...(a.role ? { role: a.role } : {}), replaces: replaced.has(a.name.toLowerCase()), provider: a.provider, providerName: providerName(a.provider), ...templateAgentParts(a, cfg, settings, info(a.provider)), where }
  })
  const notes: string[] = []
  if (plan.setup && plan.worktrees.some((w) => w && !w.reuse)) notes.push(`Each new worktree runs the project's setup command (${plan.setup}) before its agent first starts.`)
  notes.push(`${plan.remove.length ? 'Their conversations stay in the Sessions tab, and their open cards go back (Doing ones to Todo). ' : ''}The layout becomes the template's.`)
  return { removed, created, notes }
}

/** The dialog's detail as text: Removed and Created, the setup command, and what happens to the removed agents. */
export function templateLoadDetail(plan: PlanIn, cfg: Pick<ProjectConfig, 'providers' | 'defaultProvider'>, settings: AppSettings | null, info: (p: ProviderId) => ModelInfo): string {
  const v = templateLoadView(plan, cfg, settings, info)
  const lines: string[] = []
  if (v.removed.length) {
    lines.push('Removed:')
    for (const a of v.removed) lines.push(`• ${a.name}${a.note ? ` (${a.note})` : ''}${a.replaced ? ': replaced by a new agent with the same name' : ''}`)
    lines.push('')
  }
  lines.push('Created:')
  for (const a of v.created) {
    lines.push(`• ${a.name}${a.role ? ` — ${a.role}` : ''}${a.replaces ? ' (new)' : ''}: ${a.providerName}, ${[a.model, a.effort, a.mode].filter((x): x is SettingShown => !!x).map(shownText).join(' · ')}`)
    const w = a.where
    if (w.kind === 'reuse') lines.push(`    reuses its worktree on ${w.branch} in ${w.path} (clean; its branch is left as it is)`)
    else if (w.kind === 'new') lines.push(`    own worktree on ${w.branch} (from ${w.base}) in ${w.path}${w.note ? ` (${w.note})` : ''}`)
    else if (w.kind === 'own') lines.push('    own worktree')
  }
  lines.push('')
  lines.push(...v.notes)
  return lines.join('\n')
}

/**
 * The notice after a load that removed old worktrees (#289, #313): those that went with their branches, those whose
 * folder went but whose branch stayed (why), and those kept (why). Success only when every one went whole; null when
 * none were asked for.
 */
export function oldWorktreesNotice(outcomes: readonly OldWorktreeOutcome[]): { level: 'success' | 'warning'; title: string; detail: string } | null {
  if (!outcomes.length) return null
  const whole = outcomes.filter((w) => w.removed && !w.branchKept)
  const branchStayed = outcomes.filter((w) => w.removed && w.branchKept)
  const kept = outcomes.filter((w) => !w.removed)
  const n = (k: number, one: string, many: string): string => (k === 1 ? one : `${k} ${many}`)
  if (!branchStayed.length && !kept.length) return { level: 'success', title: `Removed ${n(whole.length, 'an old worktree', 'old worktrees')}`, detail: `${whole.map((w) => w.branch).join(', ')}, with ${whole.length === 1 ? 'its branch' : 'their branches'}: merged and clean.` }
  const title = kept.length ? `${kept.length === 1 ? 'An old worktree was' : `${kept.length} old worktrees were`} kept` : `${branchStayed.length === 1 ? "An old worktree's branch was" : `${branchStayed.length} old worktrees' branches were`} kept`
  const detail = [
    ...(whole.length ? [`Removed with ${whole.length === 1 ? 'its branch' : 'their branches'}: ${whole.map((w) => w.branch).join(', ')}.`] : []),
    ...branchStayed.map((w) => `${w.branch}: its folder was removed, but the branch was kept${w.why ? ` (${w.why})` : ''}.`),
    ...kept.map((w) => `${w.branch}: kept${w.why ? ` (${w.why})` : ''}.`)
  ].join('\n')
  return { level: 'warning', title, detail }
}
