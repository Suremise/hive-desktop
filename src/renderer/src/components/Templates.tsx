import { useCallback, useEffect, useState } from 'react'
import { MAX_AGENTS, SESSION_LAYOUTS } from '@shared/defaults'
import { isKnownProvider, providerDescriptor, providerName } from '@shared/providers'
import { TEMPLATE_DESCRIPTION_MAX, TEMPLATE_NAME_MAX, uniqueName, unknownProviders, type TemplateAgent, type TemplateDest, type TemplateDeleted, type TemplateEntry, type TemplateRef } from '@shared/templates'
import type { PageLayout, ProjectInfo } from '@shared/types'
import * as actions from '../actions'
import { call } from '../api'
import { useScopedLoad } from '../scopedLoad'
import { choose, confirm, findProject, get, notify, prompt, set, showView, useStore } from '../store'
import { templateWorktreesHint } from '@shared/unusedWorktrees'
import { cx, timeAgo } from '../util'
import { PaneResizer, usePaneSize } from './Resizer'
import { BusyButton, Icon, IconButton, InfoTip, LoadFailed, StaleNote, Tooltip, useBusy } from './ui'

/**
 * Agent templates' own places (#127): the Templates view (activity bar: the workspace's templates and each project's)
 * and a project's Templates tab (its own and the workspace's). Both show what a template holds, edit it (#271: its
 * agents in the Agent Settings dialog), and load, rename, duplicate, delete, export and import them.
 */

export const TEMPLATES_TIP =
  "A template is a project's agents (settings and roles) and layout, saved under a name: the workspace's are for every project, a project's are its own (kept in its .hive, out of git). Export one to share it as a file."

/** A template's key, to select it (scope, project and file). */
export const templateKey = (t: TemplateRef): string => `${t.scope}|${(t.project ?? '').toLowerCase()}|${t.file}`
const refOf = (t: TemplateEntry): TemplateRef => (t.scope === 'project' ? { scope: 'project', project: t.project, file: t.file } : { scope: 'workspace', file: t.file })
export const layoutText = (l: PageLayout): string => (l === 'auto' ? 'Automatic' : (SESSION_LAYOUTS.find((x) => x.value === l)?.label ?? l))
const agentsText = (n: number): string => `${n} ${n === 1 ? 'agent' : 'agents'}`
const bump = (): void => set((s) => ({ templatesVersion: s.templatesVersion + 1 }))
const projectsNow = (): ProjectInfo[] => get().workspace?.projects ?? []
const sameProject = (a: string | undefined, b: string | undefined): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase()
const projectName = (path: string | undefined): string => projectsNow().find((p) => sameProject(p.path, path))?.name ?? path?.split(/[\\/]/).pop() ?? 'a project'
/** Where a template is kept, in words. */
export const placeText = (d: TemplateDest): string => (d.scope === 'workspace' ? 'the workspace' : projectName(d.project))
const unknownText = (ids: string[]): string => `It uses a coding agent this Hive doesn't know (${ids.join(', ')}): it can be kept, but not loaded until Hive knows it.`

/** Asks where to keep a template: the workspace, or a project. `initial`: a project's path, or '' for the workspace. */
async function pickPlace(title: string, message: string, confirmLabel: string, initial: string): Promise<TemplateDest | null> {
  let picked = initial
  const options = [{ label: 'The workspace (every project)', value: '' }, ...projectsNow().map((p) => ({ label: `${p.name} (this project only)`, value: p.path }))]
  const r = await choose({ title, message, select: { label: 'Keep it in', options, initial, set: (v) => (picked = v) }, choices: [{ label: confirmLabel, value: 'ok' }] })
  if (r !== 'ok') return null
  return picked ? { scope: 'project', project: picked } : { scope: 'workspace' }
}

/** Load into Project…: which project, then loading's own confirmation (who goes and who comes) and checks. */
async function loadInto(t: TemplateEntry, initial: string | null): Promise<void> {
  const projects = projectsNow()
  if (!projects.length) return notify('info', 'No projects', 'Add a project to the workspace first.')
  let picked = projects.find((p) => sameProject(p.path, initial ?? undefined))?.path ?? projects[0].path
  const r = await choose({
    title: `Load "${t.name}" into a project`,
    message: "It replaces every agent of the project you choose, and its layout. Hive lists who goes and who comes before anything changes.",
    select: { label: 'Project', options: projects.map((p) => ({ label: p.name, value: p.path })), initial: picked, set: (v) => (picked = v) },
    choices: [{ label: 'Continue', value: 'ok' }]
  })
  if (r === 'ok') await actions.loadTemplate(picked, t, t.scope === 'project' ? t.project : undefined)
}

async function renameTemplate(t: TemplateEntry): Promise<void> {
  const name = await prompt({
    title: `Rename "${t.name}"`,
    initial: t.name,
    placeholder: 'Template name',
    confirmLabel: 'Rename',
    validate: (v) => (!v.trim() ? 'Enter a name.' : v.trim().length > TEMPLATE_NAME_MAX ? `At most ${TEMPLATE_NAME_MAX} characters.` : null)
  })
  if (name === null || name.trim() === t.name) return
  if (await actions.attempt('Could not rename the template', () => call('templates:rename', refOf(t), name))) bump()
}

async function duplicateTemplate(t: TemplateEntry, initial: string): Promise<TemplateEntry | null> {
  const to = await pickPlace(`Duplicate "${t.name}"`, 'A copy to share or change on its own. A name already taken there gets a number.', 'Duplicate', initial)
  if (!to) return null
  const r = await actions.attempt('Could not duplicate the template', () => call('templates:duplicate', refOf(t), to))
  if (!r) return null
  bump()
  notify('success', 'Template duplicated', `"${r.name}", in ${placeText(r)}.`)
  return r
}

async function deleteTemplate(t: TemplateEntry): Promise<boolean> {
  let left: TemplateDeleted | null = null
  const ok = await confirm({
    title: `Delete "${t.name}"?`,
    message: `The template goes to the Recycle Bin (from ${placeText(t)}).`,
    confirmLabel: 'Delete',
    danger: true,
    busyLabel: 'Deleting…',
    run: async () => {
      left = await call('templates:delete', refOf(t))
    }
  })
  if (ok) bump()
  // Deleting it touches no worktree; but its worktree agents' worktrees, no agent's now, are worth a look (#353): once.
  const hint = ok && left ? templateWorktreesHint(left, (p) => findProject(get(), p)?.name ?? p) : null
  if (hint) notify('info', hint.title, hint.detail, [{ label: 'Review', command: 'project.unusedWorktrees', args: [hint.project] }])
  return ok
}

async function exportTemplate(t: TemplateEntry): Promise<void> {
  const path = await actions.attempt('Could not export the template', () => call('templates:export', refOf(t)))
  if (path) notify('success', 'Template exported', `${path}\nIt holds the agents' settings and roles and the layout: no paths, sessions or names. Import it into any Hive.`)
}

/** Import…: a file (checked first: an invalid one is refused, saying why), where to keep it, and a name already there. */
export async function importTemplate(initial: string): Promise<TemplateEntry | null> {
  const picked = await actions.attempt('Could not import the template', () => call('templates:pickImport'))
  if (!picked) return null
  const to = await pickPlace(`Import "${picked.name}"`, `${agentsText(picked.agents)}.${picked.unknown.length ? ` ${unknownText(picked.unknown)}` : ''} Where should it be kept?`, 'Import', initial)
  if (!to) return null
  let r = await actions.attempt('Could not import the template', () => call('templates:import', picked.path, to))
  if (r && 'clash' in r) {
    const how = await choose({
      title: 'A template of that name is already there',
      message: `${placeText(to).replace(/^t/, 'T')} already has "${r.clash}".`,
      detail: 'Replace it with the imported one, or keep both (the imported one gets a number).',
      choices: [
        { label: 'Replace', value: 'replace' },
        { label: 'Keep Both', value: 'keep' }
      ]
    })
    if (how !== 'replace' && how !== 'keep') return null
    r = await actions.attempt('Could not import the template', () => call('templates:import', picked.path, to, how))
  }
  if (!r || !('imported' in r)) return null
  bump()
  notify(picked.unknown.length ? 'warning' : 'success', 'Template imported', `"${r.imported.name}", in ${placeText(r.imported)}.${picked.unknown.length ? ` ${unknownText(picked.unknown)}` : ''}`)
  return r.imported
}

function ScopeBadge({ t }: { t: TemplateEntry }) {
  return t.scope === 'workspace' ? <span className="badge accent">Workspace</span> : <span className="badge">{projectName(t.project)}</span>
}

function TemplateRow({ t, selected, onSelect, showScope }: { t: TemplateEntry; selected: boolean; onSelect: () => void; showScope?: boolean }) {
  const unknown = unknownProviders(t.agents)
  return (
    <div className={cx('row tall template-row', selected && 'selected')} role="button" tabIndex={0} aria-label={t.name} onClick={onSelect} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect())}>
      <Icon name="library" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="label">
          {t.name}
          {showScope && <ScopeBadge t={t} />}
          {(t.problem || unknown.length > 0) && (
            <Tooltip content={t.problem ?? unknownText(unknown)}>
              <span className="badge warn">{t.problem ? "Can't be used" : 'Unknown agent'}</span>
            </Tooltip>
          )}
        </div>
        <div className="desc" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {t.problem ?? `${agentsText(t.agents.length)} · ${layoutText(t.layout)} layout`}
        </div>
      </div>
    </div>
  )
}

function settingText(a: TemplateAgent, k: 'effort' | 'permissionMode'): string {
  if (!a[k]) return 'Default'
  if (!isKnownProvider(a.provider)) return a[k]!
  const d = providerDescriptor(a.provider)
  return k === 'effort' ? (d.effortLevels.find((e) => e.value === a.effort)?.label ?? a.effort!) : (d.permissionModes.find((m) => m.value === a.permissionMode)?.label ?? a.permissionMode!)
}

/** Opens the Agent Settings dialog for a template's agent (#271): the agent as saved there, or null (cancelled). */
let agentRequests = 0
function editTemplateAgent(template: string, agent: TemplateAgent | null, others: TemplateAgent[], project: string | undefined): Promise<TemplateAgent | null> {
  const taken = others.map((a) => a.name)
  return new Promise((resolve) => set({ templateAgentFor: { key: ++agentRequests, template, agent, suggestedName: uniqueName('Agent', taken), others, project, resolve } }))
}

type Draft = { name: string; description: string; layout: PageLayout; agents: TemplateAgent[] }

/**
 * Editing a template where it is kept (#271): its name, description and layout, and its agents (add, copy, remove,
 * reorder; each in the Agent Settings dialog). Saved whole, checked as an import is; refused if the template changed
 * meanwhile. A project loaded from it earlier is never touched.
 */
function TemplateEditor({ t, project, onDone }: { t: TemplateEntry; project?: ProjectInfo; onDone: () => void }) {
  // The template as the editor opened it, kept whatever the list shows later: what the draft is compared with, and the
  // revision a save expects (a newer one there refuses it, so a save made meanwhile is never overwritten).
  const [opened] = useState(() => ({ savedAt: t.savedAt, draft: { name: t.name, description: t.description ?? '', layout: t.layout, agents: t.agents.map((a) => ({ ...a })) } as Draft }))
  const [draft, setDraft] = useState<Draft>(opened.draft)
  const action = useBusy()
  const dirty = JSON.stringify(draft) !== JSON.stringify(opened.draft)
  // Saved again since it was opened (from a project, or another window): this draft would overwrite it, so it can't be saved.
  const stale = (t.savedAt ?? null) !== (opened.savedAt ?? null)
  const put = (patch: Partial<Draft>): void => setDraft((d) => ({ ...d, ...patch }))
  const agents = draft.agents
  const full = agents.length >= MAX_AGENTS
  const problem = !draft.name.trim() ? 'Enter a name for the template.' : !agents.length ? 'A template needs at least one agent.' : null
  const where = project?.path ?? (t.scope === 'project' ? t.project : undefined)
  const edit = async (i: number | null, copy = false): Promise<void> => {
    const base = i === null ? null : agents[i]
    const seed = copy && base ? { ...base, name: uniqueName(base.name, agents.map((a) => a.name)) } : base
    const others = agents.filter((_, j) => copy || j !== i)
    const got = await editTemplateAgent(draft.name.trim() || t.name, seed, others, where)
    if (!got) return
    setDraft((d) => {
      const next = [...d.agents]
      if (i === null || copy) next.splice(i === null ? next.length : i + 1, 0, got)
      else next[i] = got
      return { ...d, agents: next }
    })
  }
  const move = (i: number, by: number): void =>
    setDraft((d) => {
      const next = [...d.agents]
      const [a] = next.splice(i, 1)
      next.splice(i + by, 0, a)
      return { ...d, agents: next }
    })
  const remove = (i: number): void => setDraft((d) => ({ ...d, agents: d.agents.filter((_, j) => j !== i) }))
  const cancel = async (): Promise<void> => {
    if (dirty && !(await confirm({ title: 'Discard your changes?', message: `Your changes to "${opened.draft.name}" aren't saved.`, confirmLabel: 'Discard', danger: true }))) return
    onDone()
  }
  const save = async (): Promise<void> => {
    if (problem) return
    const ok = await action.run('save', async () => {
      const saved = await call('templates:update', refOf(t), { name: draft.name, description: draft.description.trim() || undefined, layout: draft.layout, agents: draft.agents }, opened.savedAt)
      bump()
      notify('success', 'Template saved', `"${saved.name}": ${agentsText(saved.agents.length)}, ${layoutText(saved.layout).toLowerCase()} layout.`)
    })
    if (ok) onDone()
  }
  return (
    <div className="template-detail template-editor">
      <div className="template-detail-head">
        <div className="template-detail-title">
          <Icon name="edit" />
          <h2>Edit "{t.name}"</h2>
          <ScopeBadge t={t} />
        </div>
        <div className="template-detail-actions">
          <button className="btn small subtle" disabled={!!action.busy} onClick={() => void cancel()}>
            Cancel
          </button>
          <BusyButton className="small primary" disabled={!!problem || !dirty} busy={action.busy === 'save'} busyLabel="Saving…" onClick={() => void save()}>
            <Icon name="save" /> Save Template
          </BusyButton>
        </div>
      </div>
      <div className="template-detail-body">
        {stale && (
          <p className="template-problem template-stale" role="alert">
            <Icon name="warning" /> "{t.name}" was saved again since you started editing it, so these changes can't be saved over it.
            <button className="btn small subtle" onClick={() => void cancel()}>
              Discard and Reload
            </button>
          </p>
        )}
        {action.error && (
          <p className="template-problem" role="alert">
            <Icon name="error" /> {action.error}
          </p>
        )}
        <div className="agent-form template-fields">
          <label htmlFor="template-name">Name</label>
          <input id="template-name" className="input" value={draft.name} maxLength={TEMPLATE_NAME_MAX} onChange={(e) => put({ name: e.target.value })} />
          <label htmlFor="template-description">Description</label>
          <textarea id="template-description" className="input" rows={2} value={draft.description} maxLength={TEMPLATE_DESCRIPTION_MAX} placeholder="Optional: what it is for" onChange={(e) => put({ description: e.target.value })} />
          <label htmlFor="template-layout">Layout</label>
          <select id="template-layout" className="select" value={draft.layout} onChange={(e) => put({ layout: e.target.value as PageLayout })}>
            <option value="auto">Automatic (shows all the agents, up to six)</option>
            {SESSION_LAYOUTS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        <div className="template-editor-agents-head">
          <h3 className="agent-dialog-h">
            Agents <span className="count">{agents.length}</span>
          </h3>
          <Tooltip content={full ? `A template can have up to ${MAX_AGENTS} agents` : 'Add an agent, in the Agent Settings dialog'}>
            <button className="btn small subtle" disabled={full} onClick={() => void edit(null)}>
              <Icon name="add" /> Add Agent…
            </button>
          </Tooltip>
        </div>
        {problem && <p className="hint">{problem}</p>}
        <table className="table template-agents">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Role</th>
              <th>Coding agent</th>
              <th>Model</th>
              <th>Effort</th>
              <th>Mode</th>
              <th>Works in</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {agents.map((a, i) => {
              const known = isKnownProvider(a.provider)
              return (
                <tr key={`${i}|${a.name}`} data-agent={a.name}>
                  <td>{a.name}</td>
                  <td>{a.role ?? <span className="faint">—</span>}</td>
                  <td>{known ? providerName(a.provider) : <span className="badge warn">{a.provider} (unknown)</span>}</td>
                  <td>{a.model ?? 'Default'}{a.use200kContext ? ' · 200K context' : ''}</td>
                  <td>{settingText(a, 'effort')}</td>
                  <td>{settingText(a, 'permissionMode')}</td>
                  <td>{a.worktree ? 'Its own worktree' : 'The project folder'}</td>
                  <td className="template-agent-actions">
                    <IconButton icon="edit" title={known ? `Edit ${a.name}…` : "This Hive doesn't know its coding agent: it can be moved or removed, not edited"} disabled={!known} onClick={() => void edit(i)} />
                    <IconButton icon="copy" title={`Copy ${a.name}`} disabled={!known || full} onClick={() => void edit(i, true)} />
                    <IconButton icon="arrow-up" title={`Move ${a.name} up`} disabled={i === 0} onClick={() => move(i, -1)} />
                    <IconButton icon="arrow-down" title={`Move ${a.name} down`} disabled={i === agents.length - 1} onClick={() => move(i, 1)} />
                    <IconButton icon="trash" title={`Remove ${a.name}`} onClick={() => remove(i)} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="hint">The order is the order of the agents in a project: the layout's pages hold them in turn. Saving changes this template only, never a project loaded from it earlier.</p>
      </div>
    </div>
  )
}

/**
 * What a template holds and what to do with it: Edit… (#271) opens the editor in its place. `project`: loading goes
 * into this project (a project's Templates tab); without it, Load into Project… asks which.
 */
export function TemplateDetail({ t, project, onGone, onSelect }: { t: TemplateEntry; project?: ProjectInfo; onGone: () => void; onSelect: (t: TemplateEntry) => void }) {
  const [editing, setEditing] = useState(false)
  const selectedProject = useStore((s) => s.selectedProject)
  // Duplicate offers the other place first: a project's into the workspace, the workspace's into a project.
  const otherPlace = t.scope === 'project' ? '' : (project?.path ?? selectedProject ?? projectsNow()[0]?.path ?? '')
  const unknown = unknownProviders(t.agents)
  if (editing && !t.problem) return <TemplateEditor t={t} project={project} onDone={() => setEditing(false)} />
  return (
    <div className="template-detail">
      <div className="template-detail-head">
        <div className="template-detail-title">
          <Icon name="library" />
          <h2>{t.name}</h2>
          <ScopeBadge t={t} />
        </div>
        <div className="template-detail-actions">
          {!t.problem && (
            <Tooltip content={project ? "Replace this project's agents and layout with the template's" : 'Choose a project; its agents and layout are replaced with the template’s'}>
              <button className="btn small primary" onClick={() => void (project ? actions.loadTemplate(project.path, t, t.scope === 'project' ? t.project : undefined) : loadInto(t, selectedProject))}>
                <Icon name="debug-start" /> {project ? 'Load into This Project…' : 'Load into Project…'}
              </button>
            </Tooltip>
          )}
          <Tooltip content="Change its agents (each in the Agent Settings dialog), their order, its name, description and layout">
            <button className="btn small subtle" disabled={!!t.problem} onClick={() => setEditing(true)}>
              <Icon name="settings" /> Edit…
            </button>
          </Tooltip>
          <button className="btn small subtle" disabled={!!t.problem} onClick={() => void renameTemplate(t)}>
            <Icon name="edit" /> Rename…
          </button>
          <button className="btn small subtle" disabled={!!t.problem} onClick={() => void duplicateTemplate(t, otherPlace).then((r) => r && onSelect(r))}>
            <Icon name="copy" /> Duplicate…
          </button>
          <button className="btn small subtle" disabled={!!t.problem} onClick={() => void exportTemplate(t)}>
            <Icon name="export" /> Export…
          </button>
          <IconButton icon="trash" title="Delete template" onClick={() => void deleteTemplate(t).then((ok) => ok && onGone())} />
        </div>
      </div>
      <div className="template-detail-body">
        {t.problem ? (
          <p className="template-problem">
            <Icon name="warning" /> This template can't be used: {t.problem}
          </p>
        ) : (
          <>
            {t.description && <p className="template-description">{t.description}</p>}
            <p className="muted">
              {agentsText(t.agents.length)}, {layoutText(t.layout).toLowerCase()} layout{t.savedAt ? `, saved ${timeAgo(t.savedAt)}` : ''}. Kept in {t.scope === 'workspace' ? 'the workspace, for every project' : `${projectName(t.project)}, for that project only`}. Change it with <strong>Edit…</strong>, or save a project's agents again under the same name.
            </p>
            {unknown.length > 0 && (
              <p className="template-problem">
                <Icon name="warning" /> {unknownText(unknown)}
              </p>
            )}
            <table className="table template-agents">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Role</th>
                  <th>Coding agent</th>
                  <th>Model</th>
                  <th>Effort</th>
                  <th>Mode</th>
                  <th>Works in</th>
                </tr>
              </thead>
              <tbody>
                {t.agents.map((a) => (
                  <tr key={a.name}>
                    <td>{a.name}</td>
                    <td>{a.role ?? <span className="faint">—</span>}</td>
                    <td>{isKnownProvider(a.provider) ? providerName(a.provider) : <span className="badge warn">{a.provider} (unknown)</span>}</td>
                    <td>{a.model ?? 'Default'}{a.use200kContext ? ' · 200K context' : ''}</td>
                    <td>{settingText(a, 'effort')}</td>
                    <td>{settingText(a, 'permissionMode')}</td>
                    <td>{a.worktree ? 'Its own worktree' : 'The project folder'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  )
}

/** The workspace's templates and each project's, kept fresh (a change anywhere in this window bumps templatesVersion). */
function useAllTemplates() {
  const wsPath = useStore((s) => s.workspace?.path ?? '')
  const version = useStore((s) => s.templatesVersion)
  const loaded = useScopedLoad<TemplateEntry[]>(wsPath)
  const { load: loadScoped } = loaded
  const load = useCallback(() => {
    if (wsPath) loadScoped(wsPath, () => call('templates:all'))
  }, [wsPath, loadScoped])
  useEffect(load, [load, version])
  return { ...loaded, load, wsPath }
}

const ALL = 'all'
const WORKSPACE = 'workspace'

/** The Templates view's sidebar: every template, grouped by where it is kept, with a filter (All, Workspace, a project). */
export function TemplatesPanel() {
  const { data, error, at, load, wsPath } = useAllTemplates()
  const selected = useStore((s) => s.selectedTemplate)
  const filter = useStore((s) => s.templateFilter)
  const projects = useStore((s) => s.workspace?.projects) ?? []
  const shownFilter = filter === ALL || filter === WORKSPACE || projects.some((p) => p.path === filter) ? filter : ALL
  const all = data ?? []
  const groups: { key: string; title: string; items: TemplateEntry[] }[] = [
    { key: WORKSPACE, title: 'Workspace', items: all.filter((t) => t.scope === 'workspace') },
    ...projects.map((p) => ({ key: p.path, title: p.name, items: all.filter((t) => t.scope === 'project' && sameProject(t.project, p.path)) }))
  ].filter((g) => (shownFilter === ALL ? g.key === WORKSPACE || g.items.length > 0 : g.key === shownFilter))
  const doImport = (): void =>
    void importTemplate(shownFilter !== ALL && shownFilter !== WORKSPACE ? shownFilter : '').then((t) => t && set({ selectedTemplate: templateKey(t), templateFilter: ALL }))
  return (
    <>
      <div className="pane-header">
        Templates <InfoTip text={TEMPLATES_TIP} />
        <div className="actions">
          <IconButton icon="cloud-download" title="Import Template…" onClick={doImport} disabled={!wsPath} />
          <IconButton icon="refresh" title="Refresh" onClick={load} disabled={!wsPath} />
        </div>
      </div>
      {wsPath && (
        <div style={{ padding: '0 8px 6px 12px' }}>
          <select className="select" style={{ width: '100%' }} aria-label="Show templates of" value={shownFilter} onChange={(e) => set({ templateFilter: e.target.value })}>
            <option value={ALL}>All templates</option>
            <option value={WORKSPACE}>Workspace</option>
            {projects.map((p) => (
              <option key={p.path} value={p.path}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="pane-body">
        {!wsPath && <div className="pane-empty">Open a workspace to see its templates.</div>}
        {wsPath && error && data && <StaleNote what="the templates" error={error} at={at} onRetry={load} />}
        {wsPath && error && !data && <LoadFailed inline what="the templates" error={error} onRetry={load} />}
        {wsPath && !error && !data && (
          <div className="pane-empty">
            <Icon name="loading" spin /> Loading…
          </div>
        )}
        {data &&
          groups.map((g) => (
            <div key={g.key} className="template-group">
              <div className="skill-group">
                {g.title} <span className="count">{g.items.length}</span>
              </div>
              {g.items.length === 0 && <div className="pane-empty">{g.key === WORKSPACE ? 'No workspace templates.' : 'No templates of its own.'}</div>}
              {g.items.map((t) => (
                <TemplateRow key={templateKey(t)} t={t} selected={selected === templateKey(t)} onSelect={() => set({ selectedTemplate: templateKey(t) })} />
              ))}
            </div>
          ))}
        {data && (
          <p className="hint" style={{ padding: '4px 14px' }}>
            Save a project's agents as a template from its Session tab (<strong>Save Template…</strong>). Export one to share it; Import brings one in.
          </p>
        )}
      </div>
    </>
  )
}

/** The Templates view's main area: the selected template. */
export function TemplatesView() {
  const { data } = useAllTemplates()
  const selected = useStore((s) => s.selectedTemplate)
  const t = selected ? data?.find((x) => templateKey(x) === selected) : undefined
  if (!t) {
    return (
      <div className="empty-state" style={{ paddingTop: '18vh' }}>
        <Icon name="library" />
        {selected && data ? 'That template is no longer there.' : "Select a template to see its agents and layout, load it into a project, or export it to share."}
      </div>
    )
  }
  return (
    <div className="split">
      <TemplateDetail key={templateKey(t)} t={t} onGone={() => set({ selectedTemplate: null })} onSelect={(x) => set({ selectedTemplate: templateKey(x) })} />
    </div>
  )
}

/** A project's Templates tab: its own templates and the workspace's, each with its scope; loading goes into this project. */
export function ProjectTemplatesTab({ project }: { project: ProjectInfo }) {
  const version = useStore((s) => s.templatesVersion)
  const listWidth = usePaneSize('projectTemplates', 300)
  const loaded = useScopedLoad<TemplateEntry[]>(project.path)
  const { load: loadScoped } = loaded
  const load = useCallback(() => {
    const path = project.path
    loadScoped(path, () => call('templates:list', path))
  }, [project.path, loadScoped])
  useEffect(load, [load, version])
  const [selected, setSelected] = useState<string | null>(null)
  const list = loaded.data
  const mine = (list ?? []).filter((t) => t.scope === 'project')
  const shared = (list ?? []).filter((t) => t.scope === 'workspace')
  const current = selected ? list?.find((t) => templateKey(t) === selected) : undefined
  const row = (t: TemplateEntry) => <TemplateRow key={templateKey(t)} t={t} showScope selected={selected === templateKey(t)} onSelect={() => setSelected(templateKey(t))} />
  return (
    <div className="split">
      <div className="split-list" style={{ width: listWidth }}>
        <PaneResizer paneKey="projectTemplates" max={600} />
        <div className="pane-header" style={{ paddingLeft: 14 }}>
          Templates <InfoTip text={TEMPLATES_TIP} />
          <div className="actions">
            <IconButton icon="cloud-download" title="Import Template…" onClick={() => void importTemplate(project.path).then((t) => t && setSelected(templateKey(t)))} />
            <IconButton icon="refresh" title="Refresh" onClick={load} />
          </div>
        </div>
        {loaded.error && list && <StaleNote what="the templates" error={loaded.error} at={loaded.at} onRetry={load} />}
        <div className="pane-body">
          {loaded.error && !list && <LoadFailed inline what="the templates" error={loaded.error} onRetry={load} />}
          {!loaded.error && !list && (
            <div className="pane-empty">
              <Icon name="loading" spin /> Loading…
            </div>
          )}
          {list && (
            <>
              <div className="skill-group">
                This project <span className="count">{mine.length}</span>
              </div>
              {mine.length === 0 && <div className="pane-empty">None of its own yet.</div>}
              {mine.map(row)}
              <div className="skill-group">
                Workspace <span className="count">{shared.length}</span>
              </div>
              {shared.length === 0 && <div className="pane-empty">No workspace templates.</div>}
              {shared.map(row)}
              <p className="hint" style={{ padding: '4px 14px' }}>
                <strong>Save Template…</strong> on the Session tab saves this project's agents and layout. All the workspace's templates are in the <a onClick={() => showView('templates')}>Templates view</a>.
              </p>
            </>
          )}
        </div>
      </div>
      <div className="split-main">
        {current ? (
          <TemplateDetail key={templateKey(current)} t={current} project={project} onGone={() => setSelected(null)} onSelect={(x) => setSelected(sameProject(x.project, project.path) || x.scope === 'workspace' ? templateKey(x) : null)} />
        ) : (
          <div className="empty-state" style={{ paddingTop: '18vh' }}>
            <Icon name="library" />
            Select a template to see its agents and layout, load it into this project, or export it to share.
          </div>
        )}
      </div>
    </div>
  )
}
