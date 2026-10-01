import { basename, join, resolve, sep } from 'path'
import { mkdir, readdir, readFile, writeFile, appendFile } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { AsyncLocalStorage } from 'async_hooks'
import type { BrowserWindow } from 'electron'
import chokidar, { type FSWatcher } from 'chokidar'
import { ASSISTANT_DIR, ASSISTANT_NAME, PERSONAS_DIR, assistantProjectConfig } from '../shared/assistant'
import { DEFAULT_PROJECT_CONFIG, DEFAULT_WORKSPACE_CONFIG, HIVE_DIR, mergeDefaults, migrateProjectConfig, projectAgents, withLegacyProjectFields } from '../shared/defaults'
import type { AgentDef, AgentInfo, HiveEvent, KeptUsage, LiveSessionState, ProjectConfig, ProjectInfo, SessionRecord, WorkspaceConfig, WorkspaceInfo } from '../shared/types'
import { config } from './config'
import { emit, emitTo } from './events'
import { insideReal, isDir, readKeptJson, removePath, withFileLock, writeKeptJson } from './fsutil'
import { createLogger } from './logger'
import { allProviders } from './providers'
import { worktreesRoot } from './worktrees'

const log = createLogger('workspace')

const WORKSPACE_README = `# .hive

This folder is managed by [Hive](https://github.com/) and is meant to be committed.

- \`shared/\` — notes, instructions and handovers shared across AI sessions and projects.
- \`skills/\` — Hive skills (one folder per skill, each with a \`SKILL.md\`). Every agent in every project gets them.
- \`mcp/\` — MCP server definitions (one \`<name>.json\` per server). Enable them in Hive.
- \`workspace.json\` — which MCP servers are enabled for all projects.

MCP definitions must not contain secrets. Reference environment variables instead, e.g. \`"\${GITHUB_TOKEN}"\`.
`

const HANDOVER_README = `# Handovers

Notes written at the end of a session so the next session (or another project) can pick up where it left off.
Agents can create these with the Hive MCP tool \`hive_create_handover\`.
`

export interface SessionsFile {
  version: 1
  sessions: SessionRecord[]
  /** Sessions deleted in Hive: their CLI transcripts are left alone, so Hive hides them from its lists. */
  deleted?: string[]
  /** What the deleted sessions used (by day too), which the project's totals still count. */
  deletedUsage?: KeptUsage[]
}

type LiveProvider = (projectPath: string, cfg: ProjectConfig) => Promise<{ live: LiveSessionState | null; restartNeeded: boolean; agents: AgentInfo[] }>

export class WorkspaceService {
  path: string | null = null
  private wsConfig: WorkspaceConfig = structuredClone(DEFAULT_WORKSPACE_CONFIG)
  private watcher: FSWatcher | null = null
  private refreshTimer: NodeJS.Timeout | null = null
  private static liveProvider: LiveProvider = async (_p, cfg) => ({ live: null, restartNeeded: false, agents: projectAgents(cfg).map((a) => ({ ...a, live: null, restartNeeded: false, resume: null })) })
  /** Called once for a new workspace (a folder Hive hadn't set up yet), after its .hive folder is made. */
  static onCreated: (() => Promise<unknown>) | null = null
  /** Called each time a workspace opens, in its context (e.g. to give an older workspace Hive's personas). */
  static onOpened: (() => Promise<unknown>) | null = null
  /** The window showing this workspace: its events go there. */
  window: BrowserWindow | null = null
  /** Agents' worktree folders (lower-cased) and the project each belongs to. */
  private roots = new Map<string, string>()
  private cached: WorkspaceInfo | null = null
  /** Goes up each time a workspace opens or closes, so work started for an earlier one doesn't touch this one. */
  private generation = 0
  /** Its agents are being stopped to close or switch it (or close its window): no new agent starts meanwhile. */
  closing = false

  setLiveProvider(p: LiveProvider): void {
    WorkspaceService.liveProvider = p
  }

  get hiveDir(): string {
    if (!this.path) throw new Error('No workspace is open')
    return join(this.path, HIVE_DIR)
  }

  get skillsDir(): string {
    return join(this.hiveDir, 'skills')
  }

  get mcpDir(): string {
    return join(this.hiveDir, 'mcp')
  }

  get sharedDir(): string {
    return join(this.hiveDir, 'shared')
  }

  /** The Hive Assistant's personas. */
  get personasDir(): string {
    return join(this.hiveDir, PERSONAS_DIR)
  }

  /** The Hive Assistant's home: its one-agent config, sessions and backups (its agent works in the workspace folder). */
  get assistantHome(): string {
    return join(this.hiveDir, ASSISTANT_DIR)
  }

  /** Whether a path is this workspace's Assistant home. */
  isAssistantHome(p: string): boolean {
    return !!this.path && resolve(p).toLowerCase() === this.assistantHome.toLowerCase()
  }

  /** A folder sessions can run for: a project of the open workspace, or its Assistant's home. */
  assertSessionHost(p: string): string {
    if (this.isAssistantHome(p)) return this.assistantHome
    return this.assertProject(p)
  }

  /** Where new worktrees are created, next to the workspace folder. */
  get worktreesRoot(): string {
    if (!this.path) throw new Error('No workspace is open')
    return worktreesRoot(this.path)
  }

  get config(): WorkspaceConfig {
    return this.wsConfig
  }

  async open(path: string): Promise<WorkspaceInfo> {
    const abs = resolve(path)
    if (!(await isDir(abs))) throw new Error(`Folder not found: ${abs}`)
    // One workspace inside another would make its projects belong to both. Windows claim their folders one
    // at a time, so two opening at once can't both pass the check before either has claimed its own.
    const admit = admission.then(async () => {
      const inside = (a: string, b: string): boolean => a.toLowerCase().startsWith(b.toLowerCase() + sep)
      for (const w of services) {
        if (w === this || !w.path) continue
        if (inside(abs, w.path)) throw new Error(`${abs} is inside the workspace ${w.path}, which is open in another window. Close that workspace first, or open this folder's projects from there.`)
        if (inside(w.path, abs)) throw new Error(`The workspace ${w.path}, open in another window, is inside ${abs}. Close it first to open ${basename(abs)} as a workspace.`)
      }
      await this.close()
      this.generation++
      this.path = abs
    })
    admission = admit.catch(() => undefined)
    await admit
    const isNew = !existsSync(join(abs, HIVE_DIR))
    await this.ensureWorkspaceStructure()
    if (isNew) await inWorkspace(this, async () => WorkspaceService.onCreated?.()).catch((e) => log.warn('setting up the new workspace', e))
    this.wsConfig = mergeDefaults(structuredClone(DEFAULT_WORKSPACE_CONFIG), await readKeptJson(join(this.hiveDir, 'workspace.json'), {}))
    config.update((c) => {
      c.lastWorkspace = abs
      c.recentWorkspaces = [abs, ...c.recentWorkspaces.filter((p) => p.toLowerCase() !== abs.toLowerCase())].slice(0, 12)
      c.activeProjects[abs] ??= []
    })
    for (const p of await this.listProjectPaths()) await this.ensureProject(p).catch((e) => log.warn(`ensureProject ${p}`, e))
    try {
      await this.ensureProject(this.assistantHome)
      // The Assistant's conversations and backups are this machine's: kept out of git if the workspace is a repository.
      const ignore = join(this.assistantHome, '.gitignore')
      if (!existsSync(ignore)) await writeFile(ignore, "# Hive Assistant: this machine's sessions (added by Hive)\n*\n")
    } catch (e) {
      log.warn('setting up the Assistant', e)
    }
    await inWorkspace(this, async () => WorkspaceService.onOpened?.()).catch((e) => log.warn('opening the workspace', e))
    this.startWatching()
    log.info(`Opened workspace ${abs}`)
    return this.refresh()
  }

  async close(): Promise<void> {
    this.generation++
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    await this.watcher?.close()
    this.watcher = null
    this.path = null
    this.cached = null
    // The closed workspace's agent worktrees and settings must not route to (or be allowed by) the next one.
    this.roots.clear()
    this.wsConfig = structuredClone(DEFAULT_WORKSPACE_CONFIG)
  }

  private async ensureWorkspaceStructure(): Promise<void> {
    const h = this.hiveDir
    for (const d of [h, join(h, 'shared'), join(h, 'shared', 'handovers'), join(h, 'skills'), join(h, 'mcp')]) {
      await mkdir(d, { recursive: true })
    }
    if (!existsSync(join(h, 'workspace.json'))) await writeKeptJson(join(h, 'workspace.json'), DEFAULT_WORKSPACE_CONFIG)
    if (!existsSync(join(h, 'README.md'))) await writeFile(join(h, 'README.md'), WORKSPACE_README)
    const hr = join(h, 'shared', 'handovers', 'README.md')
    if (!existsSync(hr)) await writeFile(hr, HANDOVER_README)
  }

  async saveWorkspaceConfig(): Promise<void> {
    await writeKeptJson(join(this.hiveDir, 'workspace.json'), this.wsConfig)
  }

  private startWatching(): void {
    if (!this.path) return
    // Watch only the workspace root (projects appearing/disappearing) and the .hive folder.
    this.watcher = chokidar.watch(this.path, {
      depth: 6,
      ignoreInitial: true,
      ignored: (p: string) => {
        if (!this.path) return true
        const rel = p.slice(this.path.length + 1)
        if (!rel) return false
        const parts = rel.split(/[\\/]/)
        // The Assistant's home changes with every launch; nothing in it is shown from the file system.
        if (parts[0] === HIVE_DIR) return parts[1] === ASSISTANT_DIR
        return parts.length > 1 // project internals are not our business
      }
    })
    this.watcher.on('all', (evt, p) => {
      const rel = this.path ? p.slice(this.path.length + 1).replace(/\\/g, '/') : ''
      if (rel.startsWith(`${HIVE_DIR}/shared`)) this.emit({ type: 'notes-changed' })
      else if (rel.startsWith(`${HIVE_DIR}/skills`) || rel.startsWith(`${HIVE_DIR}/mcp`)) this.emit({ type: 'skills-changed' })
      else if (rel.startsWith(`${HIVE_DIR}/${PERSONAS_DIR}`)) this.emit({ type: 'personas-changed' })
      else if (rel === `${HIVE_DIR}/workspace.json`) void this.reloadConfig()
      else if (evt === 'addDir' || evt === 'unlinkDir') this.scheduleRefresh()
    })
    this.watcher.on('error', (e) => log.warn('watcher error', e))
  }

  private async reloadConfig(): Promise<void> {
    if (!this.path) return
    this.wsConfig = mergeDefaults(structuredClone(DEFAULT_WORKSPACE_CONFIG), await readKeptJson(join(this.hiveDir, 'workspace.json'), {}))
    this.emit({ type: 'skills-changed' })
    this.scheduleRefresh()
  }

  /** An event about this workspace, for its window (and the Agent API's event stream). */
  emit(event: HiveEvent): void {
    if (this.window) emitTo(this.window, event)
    else emit(event)
  }

  scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    // A window closed meanwhile (its agents stopping afterwards) has nothing to refresh.
    this.refreshTimer = setTimeout(() => void (this.path ? this.refresh().catch((e) => log.warn('refresh failed', e)) : undefined), 250)
  }

  async listProjectPaths(): Promise<string[]> {
    if (!this.path) return []
    const entries = await readdir(this.path, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$'))
      .map((e) => join(this.path!, e.name))
      .sort((a, b) => basename(a).localeCompare(basename(b), undefined, { sensitivity: 'base' }))
  }

  isProjectPath(p: string): boolean {
    if (!this.path) return false
    const abs = resolve(p)
    return abs.toLowerCase().startsWith(this.path.toLowerCase() + sep) && !basename(abs).startsWith('.') && abs.split(sep).length === this.path.split(sep).length + 1
  }

  assertProject(p: string): string {
    if (!this.isProjectPath(p)) throw new Error(`Not a project in the open workspace: ${p}`)
    return resolve(p)
  }

  /** A project folder, or the worktree of one of a project's agents (for the Files and Changes tabs). */
  assertRoot(p: string): string {
    if (this.isProjectPath(p)) return resolve(p)
    if (this.roots.has(resolve(p).toLowerCase())) return resolve(p)
    throw new Error(`Not a project or agent worktree in the open workspace: ${p}`)
  }

  /** Whether an absolute, lower-cased path is (inside) one of this workspace's agent worktrees. */
  ownsRoot(abs: string): boolean {
    for (const r of this.roots.keys()) if (abs === r || abs.startsWith(r + sep)) return true
    return false
  }

  /** The project a worktree belongs to, or the project itself. */
  projectForRoot(p: string): string | null {
    if (this.isProjectPath(p)) return resolve(p)
    return this.roots.get(resolve(p).toLowerCase()) ?? null
  }

  /** Records a project's agent worktrees, from a config read in generation `gen` (none once the workspace has closed or switched since). */
  private registerRoots(projectPath: string, cfg: ProjectConfig, gen: number): void {
    if (gen !== this.generation) return
    for (const [k, v] of this.roots) if (v.toLowerCase() === projectPath.toLowerCase()) this.roots.delete(k)
    for (const a of cfg.agents ?? []) if (a.worktree?.path) this.roots.set(resolve(a.worktree.path).toLowerCase(), projectPath)
  }

  /** Changes one agent's definition. */
  async updateAgent(projectPath: string, agentId: string, patch: Partial<AgentDef>): Promise<AgentDef> {
    let next: AgentDef | undefined
    await this.mutateProjectConfig(projectPath, (cfg) => {
      const current = projectAgents(cfg).find((a) => a.id === agentId)
      if (!current) throw new Error('That agent no longer exists.')
      const def: AgentDef = { ...current, ...patch, id: agentId }
      next = def
      return { agents: projectAgents(cfg).map((a) => (a.id === agentId ? def : a)) }
    })
    return next!
  }

  /** Creates <project>/.hive with defaults and excludes it from git. Idempotent. */
  async ensureProject(projectPath: string): Promise<void> {
    const h = join(projectPath, HIVE_DIR)
    await mkdir(join(h, 'sessions'), { recursive: true })
    await mkdir(join(h, 'archive'), { recursive: true })
    if (!existsSync(join(h, 'project.json'))) await writeKeptJson(join(h, 'project.json'), DEFAULT_PROJECT_CONFIG)
    if (!existsSync(join(h, 'sessions.json'))) await writeKeptJson(join(h, 'sessions.json'), { version: 1, sessions: [] })
    // 0.1's launch folder for Agent 1; every agent now has launch-<id>.
    if (existsSync(join(h, 'launch'))) await removePath(join(h, 'launch')).catch(() => undefined)
    await this.ensureGitExclude(projectPath)
  }

  private async gitDir(projectPath: string): Promise<string | null> {
    const g = join(projectPath, '.git')
    if (!existsSync(g)) return null
    try {
      if (statSync(g).isDirectory()) return g
      const m = (await readFile(g, 'utf8')).match(/gitdir:\s*(.+)/)
      if (!m) return null
      const gd = resolve(projectPath, m[1].trim())
      // Worktrees keep info/exclude in the common dir.
      const common = join(gd, 'commondir')
      if (existsSync(common)) return resolve(gd, (await readFile(common, 'utf8')).trim())
      return gd
    } catch {
      return null
    }
  }

  async ensureGitExclude(projectPath: string): Promise<void> {
    const gd = await this.gitDir(projectPath)
    if (!gd) return
    const f = join(gd, 'info', 'exclude')
    let text = ''
    try {
      text = await readFile(f, 'utf8')
    } catch {
      await mkdir(join(gd, 'info'), { recursive: true })
    }
    if (text.split(/\r?\n/).some((l) => l.trim() === `${HIVE_DIR}/` || l.trim() === `/${HIVE_DIR}/`)) return
    const prefix = text && !text.endsWith('\n') ? '\n' : ''
    await appendFile(f, `${prefix}# Hive project metadata (added by Hive)\n/${HIVE_DIR}/\n`)
    log.info(`Excluded .hive from git in ${projectPath}`)
  }

  async branch(projectPath: string): Promise<string | null> {
    const gd = await this.gitDir(projectPath)
    if (!gd) return null
    try {
      // For worktrees HEAD lives in the worktree gitdir, not the common dir.
      const gfile = join(projectPath, '.git')
      let headDir = gd
      if (statSync(gfile).isFile()) {
        const m = (await readFile(gfile, 'utf8')).match(/gitdir:\s*(.+)/)
        if (m) headDir = resolve(projectPath, m[1].trim())
      }
      const head = (await readFile(join(headDir, 'HEAD'), 'utf8')).trim()
      const m = head.match(/^ref: refs\/heads\/(.+)$/)
      return m ? m[1] : head.slice(0, 8)
    } catch {
      return null
    }
  }

  async projectConfig(projectPath: string): Promise<ProjectConfig> {
    const raw = await readKeptJson<Record<string, unknown>>(join(projectPath, HIVE_DIR, 'project.json'), {})
    const cfg = mergeDefaults(structuredClone(DEFAULT_PROJECT_CONFIG), migrateProjectConfig(raw))
    // The Assistant's "project" settings are Settings → Assistant; its file keeps the workspace's own choices.
    return this.isAssistantHome(projectPath) ? assistantProjectConfig(cfg, config.settings) : cfg
  }

  async updateProjectConfig(projectPath: string, patch: Partial<ProjectConfig>): Promise<ProjectConfig> {
    return this.mutateProjectConfig(projectPath, () => patch)
  }

  /**
   * Changes project.json from its current content: fn gets the config as it is now and returns the
   * fields to change. Changes to one project's config never overlap, so none is lost.
   */
  async mutateProjectConfig(projectPath: string, fn: (cfg: ProjectConfig) => Partial<ProjectConfig>): Promise<ProjectConfig> {
    const gen = this.generation
    await this.ensureProject(projectPath)
    const file = join(projectPath, HIVE_DIR, 'project.json')
    const next = await withFileLock(file, async () => {
      const cfg = await this.projectConfig(projectPath)
      const updated = { ...cfg, ...fn(cfg) }
      await writeKeptJson(file, withLegacyProjectFields(updated))
      return updated
    })
    this.registerRoots(projectPath, next, gen)
    this.scheduleRefresh()
    return next
  }

  async sessionsFile(projectPath: string): Promise<SessionsFile> {
    return readKeptJson<SessionsFile>(join(projectPath, HIVE_DIR, 'sessions.json'), { version: 1, sessions: [] })
  }

  /** Changes sessions.json from its current content, one change at a time. */
  async mutateSessions<T>(projectPath: string, fn: (f: SessionsFile) => T): Promise<T> {
    const file = join(projectPath, HIVE_DIR, 'sessions.json')
    return withFileLock(file, async () => {
      const f = await this.sessionsFile(projectPath)
      const result = fn(f)
      await writeKeptJson(file, f)
      return result
    })
  }

  async upsertSession(projectPath: string, rec: Partial<SessionRecord> & { id: string }): Promise<SessionRecord> {
    return this.mutateSessions(projectPath, (f) => {
      let existing = f.sessions.find((s) => s.id === rec.id)
      if (existing) Object.assign(existing, rec)
      else {
        const now = new Date().toISOString()
        // Callers name the provider; records from before providers are Claude Code's.
        existing = { agent: 'claude-code', name: '', createdAt: now, lastActiveAt: now, archived: false, ...rec }
        f.sessions.push(existing)
        // A deleted session that runs again (e.g. resumed inside the CLI) is Hive's again.
        if (f.deleted?.includes(rec.id)) f.deleted = f.deleted.filter((id) => id !== rec.id)
        // Counted from its transcript again, not twice.
        if (f.deletedUsage?.some((k) => k.id === rec.id)) f.deletedUsage = f.deletedUsage.filter((k) => k.id !== rec.id)
      }
      return existing
    })
  }

  activeNames(): string[] {
    if (!this.path) return []
    return config.get().activeProjects[this.path] ?? []
  }

  setActive(projectPath: string, active: boolean): void {
    if (!this.path) return
    const name = basename(projectPath)
    config.update((c) => {
      const list = new Set(c.activeProjects[this.path!] ?? [])
      if (active) list.add(name)
      else list.delete(name)
      c.activeProjects[this.path!] = [...list]
    })
  }

  /** MCP servers the project defines in a provider's own config (.mcp.json…) that aren't deployed to the workspace. */
  async unmanagedMcp(projectPath: string): Promise<string[]> {
    const names = new Set<string>()
    for (const p of allProviders()) for (const n of Object.keys(await p.projectMcpServers(projectPath).catch(() => ({})))) names.add(n)
    if (!names.size || !this.path) return []
    const deployed = new Set(
      (await readdir(this.mcpDir).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
    )
    return [...names].filter((n) => !deployed.has(n))
  }

  async projectInfo(projectPath: string): Promise<ProjectInfo> {
    const active = new Set(this.activeNames())
    const gen = this.generation
    const cfg = await this.projectConfig(projectPath)
    this.registerRoots(projectPath, cfg, gen)
    const { live, restartNeeded, agents } = await WorkspaceService.liveProvider(projectPath, cfg)
    return {
      name: basename(projectPath),
      path: projectPath,
      active: active.has(basename(projectPath)),
      isGitRepo: existsSync(join(projectPath, '.git')),
      branch: await this.branch(projectPath),
      config: cfg,
      live,
      restartNeeded,
      agents,
      unmanagedMcp: await this.unmanagedMcp(projectPath)
    }
  }

  async refresh(): Promise<WorkspaceInfo> {
    if (!this.path) throw new Error('No workspace is open')
    const gen = this.generation
    const projects: ProjectInfo[] = []
    for (const p of await this.listProjectPaths()) projects.push(await this.projectInfo(p))
    const assistant = await this.projectInfo(this.assistantHome).catch((e) => (log.warn('the Assistant', e), null))
    // Closed or switched meanwhile: the new workspace's own refresh reports it.
    if (gen !== this.generation || !this.path) throw new Error('The workspace was closed')
    // Worktrees of projects that are gone (deleted, renamed) no longer belong to this workspace.
    const known = new Set(projects.map((p) => p.path.toLowerCase()))
    for (const [k, v] of this.roots) if (!known.has(v.toLowerCase())) this.roots.delete(k)
    this.cached = { path: this.path, name: basename(this.path), config: this.wsConfig, projects, assistant: assistant && { ...assistant, name: ASSISTANT_NAME, active: true, unmanagedMcp: [] } }
    this.emit({ type: 'workspace-changed', workspace: this.cached })
    return this.cached
  }

  info(): WorkspaceInfo | null {
    return this.cached
  }

  async createProject(name: string): Promise<WorkspaceInfo> {
    if (!this.path) throw new Error('No workspace is open')
    const clean = name.trim()
    if (!clean || /[<>:"/\\|?*\x00-\x1f]/.test(clean) || clean.startsWith('.') || /[. ]$/.test(clean)) {
      throw new Error('Project names cannot start with "." or contain < > : " / \\ | ? *')
    }
    const p = join(this.path, clean)
    if (existsSync(p)) throw new Error(`A folder named "${clean}" already exists`)
    await mkdir(p)
    await this.ensureProject(p)
    return this.refresh()
  }

  /** True if the path is inside the open workspace, its worktrees or extraRoots — used to guard file IPC. */
  isAllowedPath(p: string, extraRoots: string[] = []): boolean {
    const roots = [this.path, this.path ? worktreesRoot(this.path) : null, ...this.roots.keys(), ...extraRoots].filter((r): r is string => !!r)
    // By its real location too, so a link inside the workspace can't reach files outside it.
    return insideReal(p, roots)
  }
}

// ---------------------------------------------------------------------------
// Several windows, each with its own workspace. The rest of Hive imports `workspace`, which stands for
// the workspace the current work is for: the calling window's (IPC), an Agent API request's, or the one
// owning the project path a call names.
// ---------------------------------------------------------------------------

const services = new Set<WorkspaceService>()
/** Workspaces being opened, one at a time (see open()). */
let admission: Promise<void> = Promise.resolve()
const context = new AsyncLocalStorage<WorkspaceService>()
let fallback: () => WorkspaceService | null = () => null

/** A new, empty workspace service (for a new window). */
export function createWorkspaceService(): WorkspaceService {
  const w = new WorkspaceService()
  services.add(w)
  return w
}

/** Closes a window's workspace and forgets its service. */
export async function disposeWorkspaceService(w: WorkspaceService): Promise<void> {
  await w.close()
  services.delete(w)
}

/** Runs fn with `workspace` standing for w. */
export function inWorkspace<T>(w: WorkspaceService, fn: () => T): T {
  return context.run(w, fn)
}

/** The workspace set for the current work by inWorkspace (a window's request, an API request), if any. */
export function contextWorkspace(): WorkspaceService | undefined {
  return context.getStore()
}

/** The workspace used when no window, request or path says which (the last focused window's). */
export function setWorkspaceFallback(fn: () => WorkspaceService | null): void {
  fallback = fn
}

/** The workspaces open in windows. */
export function openWorkspaces(): WorkspaceService[] {
  return [...services].filter((w) => !!w.path)
}

/** The open workspace a folder or file belongs to: a project, a file in one, or an agent's worktree. */
export function workspaceFor(p: string): WorkspaceService | null {
  const abs = resolve(p).toLowerCase()
  for (const w of services) {
    if (!w.path) continue
    const root = w.path.toLowerCase()
    if (abs === root || abs.startsWith(root + sep)) return w
    const wt = worktreesRoot(w.path).toLowerCase()
    if (abs === wt || abs.startsWith(wt + sep) || w.ownsRoot(abs)) return w
  }
  return null
}

let warned = false
/** The workspace the current work is for. */
export function currentWorkspace(): WorkspaceService {
  const inCtx = context.getStore()
  if (inCtx) return inCtx
  const open = openWorkspaces()
  if (open.length === 1) return open[0]
  if (services.size === 1) return [...services][0]
  const f = fallback()
  if (open.length > 1 && !warned) {
    warned = true
    log.warn('A workspace was used without saying which; using the last focused window\'s', new Error('no workspace context').stack)
  }
  return f ?? open[0] ?? [...services][0] ?? createWorkspaceService()
}

/** The workspace owning a project (or worktree) path, else the current one. */
export function workspaceOf(p: string): WorkspaceService {
  return workspaceFor(p) ?? currentWorkspace()
}

/** Methods whose first argument is a project or worktree path: they go to the workspace owning it. */
const BY_PATH = new Set<string>([
  'isProjectPath', 'assertProject', 'assertRoot', 'projectForRoot', 'updateAgent', 'ensureProject', 'ensureGitExclude', 'branch',
  'projectConfig', 'updateProjectConfig', 'mutateProjectConfig', 'sessionsFile', 'mutateSessions', 'upsertSession', 'setActive',
  'unmanagedMcp', 'projectInfo', 'isAssistantHome', 'assertSessionHost'
])

export const workspace: WorkspaceService = new Proxy({} as WorkspaceService, {
  get(_t, key: string) {
    // Any open workspace's files may be read (hive-img:, file IPC) — each window only shows its own.
    if (key === 'isAllowedPath') return (p: string, extra?: string[]) => [...services].some((w) => w.isAllowedPath(p, extra))
    if (BY_PATH.has(key)) {
      return (p: string, ...rest: unknown[]) => {
        const w = workspaceFor(p) ?? currentWorkspace()
        return (w as unknown as Record<string, (...a: unknown[]) => unknown>)[key](p, ...rest)
      }
    }
    const w = currentWorkspace()
    const v = (w as unknown as Record<string, unknown>)[key]
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(w) : v
  },
  set(_t, key: string, value) {
    if (key === 'onCreated') WorkspaceService.onCreated = value
    else (currentWorkspace() as unknown as Record<string, unknown>)[key] = value
    return true
  }
})
