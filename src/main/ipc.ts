import { BrowserWindow, ClipboardItem, app, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { basename, dirname, join } from 'path'
import { readFile } from 'fs/promises'
import type { HiveChannel, HiveRequests } from '../shared/api'
import * as updater from './updater'
import type { ProviderId, QuitChoice } from '../shared/types'
import { instructionFiles, instructionsShared, shareInstructions, SHARED_INSTRUCTIONS, type InstructionsFile } from '../shared/instructions'
import { isKnownProvider, projectProviderConfig, providerDescriptor } from '../shared/providers'
import { applyBoardFold } from '../shared/tasks'
import { allProviders } from './providers'
import { providerService } from './providerService'
import { config } from './config'
import { clearRecent, recentChanged, recentFor, removeRecent } from './recentWorkspaces'
import { emit, emitTo } from './events'
import { setPinned } from './pin'
import { presentWindow } from './testQuiet'
import { insideReal, isFile, writeTextAtomic, writeTextUnlessChanged } from './fsutil'
import { gitDiff, gitStatus } from './git'
import { createLogger, logsDir } from './logger'
import { diagnostics } from './diagnostics'
import { keepAwakeCount } from './power'
import { progress } from './progressService'
import { badgeDescription } from '../shared/taskbar'
import * as files from './files'
import * as mcp from './mcp'
import * as notes from './notes'
import * as removal from './projectRemoval'
import * as tasks from './tasks'
import { startTask } from './taskStart'
import * as assistantControl from './assistantControl'
import * as personas from './personas'
import { syncBundled } from './bundled'
import { checkMoved, finishPending, movePlan, repairMove } from './workspaceMove'
import { missingWorktree, recreateWorktree, unlinkMissingWorktree } from './agentWorktree'
import { projectAgents as agentsOf } from '../shared/defaults'
import type { MoveOptions } from '../shared/types'
import { killPty, ptyBuffer, resizePty, writePty } from './ptyHost'
import { apiInfo, regenerateToken } from './servers'
import * as projectAgents from './projectAgents'
import * as templates from './templates'
import * as branchWatch from './branchWatch'
import { sessions } from './sessions'
import { transcripts } from './transcripts'
import * as skills from './skills'
import * as storage from './storage'
import { contextWorkspace, currentWorkspace, inWorkspace, workspace, workspaceFor, workspaceOf, WorkspaceService } from './workspace'
import { hiveWindows, windowForPath, windowOf, windowShowing } from './windows'
import { setTitleBarBackdrops, setTitleBarColors } from './titleBar'
import { showWindow } from './tray'
import { resetMetrics } from './metrics'
import { metricsExport, metricsReport } from './metricsUsage'
import { cancelWatch } from './watches'
import { benchContext, importBenchmark, keepReport, listBenchmarks, pinBenchmark, readBenchmark, removeBenchmark, selectBenchmarks } from './benchmarks'

/** The instruction files of the given providers in a project, with their content. */
async function projectInstructions(project: string, ids: ProviderId[]): Promise<InstructionsFile[]> {
  const descriptors = ids.map(providerDescriptor)
  const content = new Map<string, string | null>()
  for (const d of descriptors) content.set(d.instructionsFile, await readFile(join(project, d.instructionsFile), 'utf8').catch(() => null))
  return instructionFiles(descriptors, (f) => content.get(f) ?? null)
}

type Impl = { [C in HiveChannel]: (...args: Parameters<HiveRequests[C]>) => ReturnType<HiveRequests[C]> | Promise<ReturnType<HiveRequests[C]>> }

function spawnDetached(file: string, args: string[], cwd?: string): boolean {
  try {
    const child = spawn(file, args, { cwd, detached: true, stdio: 'ignore', shell: process.platform === 'win32', windowsHide: false })
    child.on('error', () => undefined)
    child.unref()
    return true
  } catch {
    return false
  }
}

/** A provider id this version knows; anything else is refused (it would become a settings key). */
function knownProvider(id: unknown): ProviderId {
  if (typeof id !== 'string' || !isKnownProvider(id)) throw new Error(`Unknown provider "${String(id)}".`)
  return id
}

function guardFile(path: string, write = false): string {
  if (workspace.isAllowedPath(path) || allProviders().some((p) => p.fileAllowed(path, write))) return path
  // The skills that ship with Hive, to view one the workspace doesn't have.
  if (!write && insideReal(path, [skills.bundledSkillsDir()])) return path
  throw new Error("Hive can only read and write files inside the workspace, and the agents' instruction, memory and skill files.")
}


/** Quitting and closing windows (index.ts): each call names the window it came from. */
export interface QuitControl {
  quit: () => void
  decide: (from: BrowserWindow, choice: QuitChoice, dontAskAgain: boolean) => void
  cancelPending: () => void
  state: (from: BrowserWindow) => ReturnType<HiveRequests['app:quitState']>
  setUnsaved: (from: BrowserWindow, paths: string[]) => void
  newWindow: (from: BrowserWindow) => void
  /** Before closing or switching a window's workspace: asks (per Confirm on quit) and stops its agents; false if cancelled. */
  stopWorkspaceAgents: (from: BrowserWindow, scope: 'workspace' | 'switch') => Promise<boolean>
}

/** Whether any agent of this workspace is running or starting. */
function workspaceLive(ws: WorkspaceService): boolean {
  return [...sessions.liveStates().map((s) => s.projectPath), ...sessions.pendingStarts()].some((p) => workspaceFor(p) === ws)
}

/** Opens a workspace in this window. Its old workspace's agents were stopped for it: starts are allowed again either way. */
async function openHere(path: string): ReturnType<WorkspaceService['open']> {
  const ws = contextWorkspace()!
  try {
    return await workspace.open(path)
  } finally {
    ws.closing = false
  }
}

const log = createLogger('ipc')

/** Repair…'s choices as the window sent them, with anything else dropped (#146). */
function moveOptions(o: unknown): MoveOptions {
  const v = (o ?? {}) as Record<string, unknown>
  const locate = v.locate && typeof v.locate === 'object' ? Object.fromEntries(Object.entries(v.locate as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string' && !!e[1])) : undefined
  const list = (x: unknown): string[] | undefined => (Array.isArray(x) ? x.filter((y): y is string => typeof y === 'string') : undefined)
  const unlink = list(v.unlink)
  const recreate = list(v.recreate)
  return { ...(locate ? { locate } : {}), ...(unlink ? { unlink } : {}), ...(recreate ? { recreate } : {}) }
}

export function registerIpc(getAppInfo: () => ReturnType<HiveRequests['app:info']>, quitControl: QuitControl): void {
  // Each time a workspace opens: Hive's bundled skills and personas it hasn't got, or has untouched older copies of.
  WorkspaceService.onOpened = async (fresh) => {
    await syncBundled({ fresh }).catch((e) => log.warn("updating the workspace's bundled skills and personas", e))
    const ws = workspace
    void tasks.archiveOldDone(ws).catch((e) => log.warn('archiving old Done cards', e))
    // Moved since it was last opened (#146)? In the background: the window opens meanwhile, and a banner follows.
    void checkMoved(contextWorkspace()!).catch((e) => log.warn('checking whether the workspace moved', e))
  }
  /** The window the current request came from. */
  const win = (): BrowserWindow => {
    const w = contextWorkspace()?.window
    if (!w || w.isDestroyed()) throw new Error('No window')
    return w
  }
  /** Opening a workspace another window shows brings that window forward instead (as VS Code does). */
  const shownElsewhere = (target: string): boolean => {
    const other = windowShowing(target)
    if (!other || other.win === win()) return false
    showWindow(other.win)
    return true
  }

  const impl: Impl = {
    'app:info': () => getAppInfo(),
    'app:planUsage': () => config.get().planUsage,
    'app:quit': () => quitControl.quit(),
    'app:quitDecision': (choice, dontAskAgain) => quitControl.decide(win(), choice, dontAskAgain),
    'app:cancelPendingQuit': () => quitControl.cancelPending(),
    'app:quitState': () => quitControl.state(win()),
    'app:openExternal': (url) => {
      if (/^https?:\/\//i.test(url) || url.startsWith('mailto:')) void shell.openExternal(url)
    },
    'app:openPath': (p) => void shell.openPath(guardFile(p)),
    'app:showInFolder': (p) => shell.showItemInFolder(guardFile(p)),
    'app:openLogs': () => void shell.openPath(logsDir()),
    'app:diagnostics': () => diagnostics(),
    'app:keepAwake': () => keepAwakeCount(),
    'update:state': () => updater.updateState(),
    'update:check': () => updater.check(true),
    'update:download': () => updater.download(),
    'update:install': () => updater.restartAndInstall(),
    'update:skip': (version) => updater.skip(version),
    'app:openChromiumLicenses': () => {
      const file = join(dirname(process.execPath), 'LICENSES.chromium.html')
      if (!existsSync(file)) return false
      void shell.openPath(file)
      return true
    },

    'window:minimize': () => win().minimize(),
    'window:toggleMaximize': () => (win().isMaximized() ? win().unmaximize() : win().maximize()),
    'window:close': () => win().close(),
    'window:count': () => hiveWindows().length,
    'window:new': () => quitControl.newWindow(win()),
    'window:toggleDevTools': () => win().webContents.toggleDevTools(),
    'window:zoom': (dir) => {
      const wc = win().webContents
      wc.setZoomLevel(dir === 'reset' ? 0 : Math.max(-3, Math.min(4, wc.getZoomLevel() + (dir === 'in' ? 0.5 : -0.5))))
    },
    'window:toggleFullScreen': () => win().setFullScreen(!win().isFullScreen()),
    'window:setAlwaysOnTop': (on) => {
      const w = win()
      const now = setPinned(w, contextWorkspace()?.path ?? null, on)
      emitTo(w, { type: 'window-state', maximized: w.isMaximized(), focused: w.isFocused(), alwaysOnTop: now })
      return now
    },
    'window:getAlwaysOnTop': () => win().isAlwaysOnTop(),
    'window:showing': (projectPath) => {
      const e = hiveWindows().find((x) => x.win === win())
      if (e) e.showing = projectPath
    },
    'notice:open': (projectPath) => {
      const target = (projectPath ? windowForPath(projectPath)?.win : null) ?? win()
      presentWindow(target)
      if (projectPath) emitTo(target, { type: 'menu-command', command: 'project.focus', args: [projectPath] })
    },
    'window:edit': (role) => {
      const wc = win().webContents
      ;({ undo: () => wc.undo(), redo: () => wc.redo(), cut: () => wc.cut(), copy: () => wc.copy(), paste: () => wc.paste(), selectAll: () => wc.selectAll() })[role]()
    },
    'window:setBadge': (count, png, scale) => {
      const w = win()
      if (w.isDestroyed()) return
      const img = count > 0 && typeof png === 'string' ? nativeImage.createFromBuffer(Buffer.from(png, 'base64'), { scaleFactor: Number(scale) || 1 }) : null
      w.setOverlayIcon(img && !img.isEmpty() ? img : null, count > 0 ? badgeDescription(count) : '')
    },
    'window:setTitleBarColors': (color, symbolColor) => setTitleBarColors(win(), { color, symbolColor }),
    'window:setBackdrops': (count) => setTitleBarBackdrops(win(), count),

    'settings:get': () => config.settings,
    'settings:update': (patch) => config.updateSettings(patch),
    'settings:setKeybinding': (id, key) => config.setKeybinding(id, key),
    'settings:setProviderPrices': (provider, prices, removed) => config.setProviderPrices(knownProvider(provider), prices, removed),
    'settings:setProviderFallback': (provider, kind, list) => config.setProviderFallback(knownProvider(provider), kind === 'efforts' ? 'efforts' : 'models', list),
    'settings:reset': (section) => config.resetSettings(section),
    'ui:get': () => config.get().ui,
    'ui:set': (ui) => config.update((c) => Object.assign(c.ui, ui)),
    'ui:setPane': (key, size) =>
      config.update((c) => {
        c.ui.panes ??= {}
        if (typeof size === 'number' && Number.isFinite(size)) c.ui.panes[String(key)] = size
        else delete c.ui.panes[String(key)]
      }),
    'ui:changeBoardFold': (change) => {
      // This window's workspace only, applied to what is saved now: another window's folds stay as they are.
      const ws = workspace.path
      if (ws && change && typeof change === 'object') config.update((c) => void (c.ui.boardFold = applyBoardFold(c.ui.boardFold, ws, change)))
      return config.get().ui.boardFold ?? {}
    },

    'workspace:get': () => workspace.info(),
    'workspace:open': async (path) => {
      let target = path
      if (!target) {
        const r = await dialog.showOpenDialog(win(), { title: 'Open Workspace', properties: ['openDirectory'], buttonLabel: 'Open Workspace' })
        if (r.canceled || !r.filePaths[0]) return workspace.info()
        target = r.filePaths[0]
      }
      if (shownElsewhere(target)) return workspace.info()
      // A recent workspace whose folder was deleted or moved (#144): said plainly, so the window can offer to forget it.
      if (!existsSync(target)) throw new Error(`The workspace folder ${target} can't be found. It may have been moved or deleted, or be on a drive that isn't connected.`)
      if (workspace.path && target.toLowerCase() !== workspace.path.toLowerCase() && workspaceLive(contextWorkspace()!)) {
        if (!(await quitControl.stopWorkspaceAgents(win(), 'switch'))) return workspace.info()
      }
      return openHere(target)
    },
    'workspace:create': async () => {
      const r = await dialog.showOpenDialog(win(), {
        title: 'Choose or create a folder for the new workspace',
        properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
        buttonLabel: 'Create Workspace'
      })
      if (r.canceled || !r.filePaths[0]) return workspace.info()
      if (shownElsewhere(r.filePaths[0])) return workspace.info()
      if (workspace.path && workspaceLive(contextWorkspace()!)) {
        if (!(await quitControl.stopWorkspaceAgents(win(), 'switch'))) return workspace.info()
      }
      const { mkdir } = await import('fs/promises')
      await mkdir(r.filePaths[0], { recursive: true })
      return openHere(r.filePaths[0])
    },
    'workspace:close': async () => {
      if (workspaceLive(contextWorkspace()!) && !(await quitControl.stopWorkspaceAgents(win(), 'workspace'))) return false
      const ws = contextWorkspace()!
      try {
        await workspace.close()
      } finally {
        ws.closing = false
      }
      emitTo(win(), { type: 'workspace-changed', workspace: null })
      // Other windows' lists no longer say it is open here.
      recentChanged()
      return true
    },
    'workspace:recent': () => recentFor(workspace.path),
    'workspace:usage': async () => {
      const ws = workspace
      if (!ws.path) throw new Error('No workspace is open')
      // One project at a time: each reads its sessions file and checks its transcripts against the usage cache.
      const projects = []
      for (const p of await ws.listProjectPaths()) projects.push({ name: basename(p), path: p, items: await sessions.usageItems(p).catch(() => []) })
      const assistant = existsSync(ws.assistantHome) ? await sessions.usageItems(ws.assistantHome).catch(() => []) : []
      return { workspacePath: ws.path, projects, assistant, hidden: ws.hiddenProjects().length }
    },
    'metrics:query': (q) => metricsReport(currentWorkspace(), q),
    'metrics:reset': () => resetMetrics(currentWorkspace()),
    'metrics:export': async (q, sanitize) => {
      // The report is taken before the dialog: the workspace this window shows now, not whatever it shows later.
      const report = await metricsReport(currentWorkspace(), { ...q, trend: true })
      const scope = q.scope.kind === 'project' && !sanitize ? q.scope.project.replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').trim().slice(0, 60) : q.own ? 'own-work' : q.scope.kind
      const r = await dialog.showSaveDialog(win(), {
        title: 'Export Performance Metrics',
        defaultPath: join(app.getPath('downloads'), `hive-performance-${scope}-${new Date().toISOString().slice(0, 10)}.json`),
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
      if (r.canceled || !r.filePath) return null
      await writeTextAtomic(r.filePath, JSON.stringify(metricsExport(report, app.getVersion(), sanitize), null, 2) + '\n')
      return r.filePath
    },
    // Each takes the workspace's folder and lifetime before awaiting anything (benchContext): work whose workspace closes
    // or switches meanwhile (a dialog left open, a slow read) is refused, never written into the next one.
    'watch:cancel': (projectPath, agentId) => cancelWatch(workspaceOf(projectPath), projectPath, agentId),
    'benchmarks:list': (scope) => listBenchmarks(benchContext(currentWorkspace()), scope),
    'benchmarks:import': async (scope, answer) => {
      const ctx = benchContext(currentWorkspace())
      if (answer) return importBenchmark(ctx, scope, { token: answer.token, useProjectPart: answer.useProjectPart })
      const r = await dialog.showOpenDialog(win(), { title: 'Import a Benchmark or Performance Export', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
      if (r.canceled || !r.filePaths[0]) return null
      return importBenchmark(ctx, scope, { path: r.filePaths[0] })
    },
    'benchmarks:keep': async (q, label) => {
      const w = currentWorkspace()
      const ctx = benchContext(w)
      return keepReport(ctx, await metricsReport(w, q), app.getVersion(), label)
    },
    'benchmarks:read': (scope, id) => readBenchmark(benchContext(currentWorkspace()), scope, id),
    'benchmarks:remove': (scope, id) => removeBenchmark(benchContext(currentWorkspace()), scope, id),
    'benchmarks:pin': (scope, id, pinned) => pinBenchmark(benchContext(currentWorkspace()), scope, id, pinned),
    'benchmarks:select': (scope, base, run) => selectBenchmarks(benchContext(currentWorkspace()), scope, base, run),
    'workspace:removeRecent': (p) => {
      removeRecent(String(p ?? ''))
      return recentFor(workspace.path)
    },
    'workspace:clearRecent': () => {
      clearRecent()
      return recentFor(workspace.path)
    },
    'workspace:refresh': async () => (workspace.path ? workspace.refresh() : null),
    'workspace:movePlan': (opts) => movePlan(currentWorkspace(), moveOptions(opts)),
    'workspace:moveRepair': (opts) => repairMove(currentWorkspace(), moveOptions(opts)),
    'workspace:moveLocate': async (projectPath, agentId) => {
      const agent = agentsOf(await workspace.projectConfig(workspace.assertProject(projectPath))).find((a) => a.id === agentId)
      const r = await dialog.showOpenDialog(win(), { title: `Locate ${agent?.name ?? 'the agent'}'s worktree`, properties: ['openDirectory'], buttonLabel: 'Use This Folder' })
      if (r.canceled || !r.filePaths[0]) return null
      if (!(await isFile(join(r.filePaths[0], '.git')))) throw new Error(`${r.filePaths[0]} isn't a git worktree (it has no .git file). Choose the folder the worktree was moved to.`)
      return r.filePaths[0]
    },

    'project:create': (name) => workspace.createProject(name),
    'project:removalInfo': (p) => removal.removalInfo(p),
    'project:remove': (p, how) => {
      if (!['hide', 'remove', 'delete'].includes(how)) throw new Error(`Unknown way to remove a project: ${String(how)}`)
      return removal.removeProject(p, how)
    },
    'project:hidden': () => workspace.hiddenProjects(),
    'project:restore': (name) => removal.restoreProject(name),
    'project:forget': (name) => removal.forgetHidden(name),
    'project:takeRemovedData': (p, keep) => removal.takeRemovedData(p, keep),
    'tasks:list': () => tasks.allTasks(),
    'tasks:create': (input) => tasks.createTask(input, { kind: 'user' }),
    'tasks:update': (n, patch) => tasks.updateTask(n, patch, { kind: 'user' }),
    'tasks:comment': (n, text) => tasks.commentTask(n, text, { kind: 'user' }),
    'tasks:archive': (n, archived) => tasks.archiveTask(n, archived),
    'tasks:delete': (n) => tasks.deleteTask(n),
    'tasks:start': async (n, target) => {
      const r = await startTask(n, target, { kind: 'user' })
      return { agentId: r.agentId, agentName: r.agentName, added: r.added }
    },
    'project:setActive': async (p, active) => {
      p = workspace.assertProject(p)
      if (!active && sessions.liveFor(p)) throw new Error('Stop the running session before deactivating this project.')
      if (active) await workspace.ensureProject(p)
      workspace.setActive(p, active)
      return workspace.refresh()
    },
    'project:updateConfig': (p, patch) => workspace.updateProjectConfig(workspace.assertProject(p), patch),
    'project:updateProvider': (p, provider, patch) => {
      const id = knownProvider(provider)
      return workspace.mutateProjectConfig(workspace.assertProject(p), (cfg) => ({ providers: { ...cfg.providers, [id]: { ...projectProviderConfig(cfg, id), ...patch } } }))
    },
    'project:openInExplorer': (p) => void shell.openPath(workspace.assertProject(p)),
    'project:openTerminal': (p) => {
      const dir = workspace.assertProject(p)
      if (process.platform === 'win32') {
        if (!spawnDetached('wt.exe', ['-d', `"${dir}"`])) spawnDetached('cmd.exe', ['/c', 'start', 'cmd.exe'], dir)
      } else spawnDetached('x-terminal-emulator', [], dir)
    },

    'session:list': (p) => sessions.list(p),
    'session:start': (p, opts) => sessions.start(p, opts),
    'session:stop': (p, agentId) => sessions.stop(workspace.assertSessionHost(p), agentId),
    'session:archive': (p, id, archived) => sessions.archive(p, id, archived),
    'session:rename': (p, id, name) => sessions.rename(p, id, name),
    'session:delete': (p, id) => sessions.delete(p, id),
    'session:bulk': (p, action, ids) => sessions.bulk(p, action, ids),
    'session:keptUsage': (p) => sessions.keptUsage(p),
    'storage:project': (p, refresh) => storage.projectStorage(p, refresh),
    'storage:workspace': (refresh) => storage.workspaceStorage(refresh),
    'storage:cleanupPreview': (p, opts) => storage.cleanupPreview(p, opts),
    'storage:cleanup': (p, opts, listed) => storage.cleanup(p, opts, listed),
    'session:clearUsageCache': () => sessions.forgetUsageCache(),
    'session:adopt': (p, id) => sessions.adopt(p, id),
    'session:usage': (p, id) => sessions.usage(workspace.assertSessionHost(p), id),
    'session:markSeen': (p, ids) => sessions.markSeen(p, ids),
    'session:live': () => sessions.liveStates(),
    'session:setMode': (p, agentId, mode) => sessions.setPermissionMode(p, agentId, mode),
    'session:restartInMode': (p, agentId, mode) => sessions.restartInMode(p, agentId, mode),
    'session:setPlanMode': (p, agentId, on) => sessions.setPlanMode(p, agentId, on),
    'session:stopBackgroundAndResume': (p, agentId, jobId, sessionId) => sessions.stopBackgroundAndResume(p, agentId, jobId, sessionId),
    'session:handOver': (p, from, to, opts) => sessions.handOver(p, from, to, opts),
    'session:allowLockedEdit': (p, agentId, path) => sessions.allowLockedEdit(p, agentId, path),
    'session:applyModes': () => sessions.applyModeSettings(),
    'session:compact': (p, focus, agentId) => sessions.compact(p, focus, agentId),
    'session:saveImage': (p, sourceFile, agentId) => sessions.saveImage(p, sourceFile, agentId),

    'agents:add': (p, opts) => projectAgents.addAgent(p, opts),
    'agents:update': (p, id, patch) => projectAgents.updateAgent(p, id, patch),
    'agents:remove': (p, id, opts) => projectAgents.removeAgent(p, id, opts),
    'agents:missingWorktree': (p, id) => missingWorktree(workspace.assertProject(p), String(id)),
    'agents:recreateWorktree': async (p, id) => {
      const project = workspace.assertProject(p)
      const def = await recreateWorktree(project, String(id))
      // At a new place: its sessions and data follow it now (or, if that fails, Repair… does).
      await finishPending(currentWorkspace(), project)
      await workspace.refresh()
      return def
    },
    'agents:unlinkWorktree': async (p, id) => {
      const def = await unlinkMissingWorktree(workspace.assertProject(p), String(id))
      await workspace.refresh()
      return def
    },
    'agents:move': (p, id, index) => projectAgents.moveAgent(p, id, index),
    'agents:swap': (p, id, other) => projectAgents.swapAgents(p, id, other),
    'templates:list': (p) => templates.listTemplates(p),
    'templates:save': (p, scope, name, overwrite) => templates.saveTemplate(p, scope, name, overwrite),
    'templates:plan': (p, scope, file, from) => templates.templatePlan(p, scope, file, from),
    'templates:load': (p, scope, file, expected, from) => templates.loadTemplate(p, scope, file, expected, from),
    'templates:addAgent': (p, scope, file, index, from) => templates.addAgentFromTemplate(p, scope, file, index, from),
    'templates:all': () => templates.listAllTemplates(),
    'templates:rename': (ref, name) => templates.renameTemplate(ref, name),
    'templates:duplicate': (ref, to) => templates.duplicateTemplate(ref, to),
    'templates:delete': (ref) => templates.deleteTemplate(ref),
    'templates:export': async (ref) => {
      // Checked before the dialog: a template that is gone or can't be used is said at once.
      const name = await templates.exportName(ref)
      const r = await dialog.showSaveDialog(win(), { title: 'Export Template', defaultPath: join(app.getPath('downloads'), name), filters: [{ name: 'Hive template', extensions: ['json'] }] })
      if (r.canceled || !r.filePath) return null
      await templates.exportTemplate(ref, r.filePath)
      return r.filePath
    },
    'templates:pickImport': async () => {
      const r = await dialog.showOpenDialog(win(), { title: 'Import a Template', properties: ['openFile'], filters: [{ name: 'Hive template', extensions: ['json'] }] })
      if (r.canceled || !r.filePaths[0]) return null
      return templates.inspectImport(r.filePaths[0])
    },
    'templates:import': (path, to, onClash) => templates.importTemplate(path, to, onClash),
    'agents:gitInfo': (p) => projectAgents.gitInfo(p),
    'agents:branchStatus': async (p, id) => {
      const st = await projectAgents.branchStatus(p, id)
      branchWatch.record(p, id, st)
      return st
    },
    'agents:branchStatuses': () => branchWatch.statuses(),
    'agents:merge': (p, id, opts) => projectAgents.merge(p, id, opts),

    'files:list': (p, rel) => files.listDir(p, rel),
    'files:create': (p, parent, name, isDir) => files.create(p, parent, name, isDir),
    'files:rename': (p, rel, name) => files.renameEntry(p, rel, name),
    'files:move': (p, rels, dest) => files.move(p, rels, dest),
    'files:copy': (p, rels, dest) => files.copy(p, rels, dest),
    'files:import': (p, sources, dest) => files.importPaths(p, sources, dest),
    'files:trash': (p, rels) => files.trash(p, rels),
    'files:find': (p, q) => files.find(p, q),
    'files:read': (p, rel) => files.readText(p, rel),
    'files:write': (p, rel, text, expected, bom) => files.writeText(p, rel, text, expected, bom),
    'files:open': async (p, rel) => {
      const err = await shell.openPath(files.absPath(p, rel))
      if (err) throw new Error(err)
    },
    'files:reveal': (p, rel) => shell.showItemInFolder(files.absPath(p, rel)),
    'files:linkFiles': (p, rels) => files.linkFiles(p, rels),
    'files:watch': (p) => files.watchProject(p),
    'files:setUnsaved': (paths) => quitControl.setUnsaved(win(), Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : []),
    'files:unwatch': (p) => files.unwatchProject(p),

    'images:list': (p) => files.listImages(p),
    'images:trash': (p, path) => files.trashImage(p, path),
    'images:trashGroup': (p, id) => files.trashImageGroup(p, id),
    'transcript:read': (p, id, opts) => transcripts.read(p, id, opts ?? {}),
    'transcript:tool': (p, id, itemId) => transcripts.tool(p, id, itemId),
    'transcript:image': (p, id, imageId) => transcripts.image(p, id, imageId),
    'transcript:search': (p, query, id) => transcripts.search(p, query, id),
    'transcript:compactions': (p, id) => transcripts.compactions(p, id),
    'transcript:viewing': (view, p, id) => transcripts.viewing(win().webContents.id, view, p, id),
    'transcript:export': async (p, id, title) => {
      const safe = title.replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || id
      const r = await dialog.showSaveDialog(win(), {
        title: 'Export Transcript as Markdown',
        defaultPath: join(app.getPath('downloads'), `${safe}.md`),
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (r.canceled || !r.filePath) return null
      await writeTextAtomic(r.filePath, await transcripts.markdown(p, id, title))
      return r.filePath
    },
    'images:copy': async (path) => {
      const img = nativeImage.createFromPath(guardFile(path))
      if (img.isEmpty()) throw new Error('Not an image')
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(img.toPNG())], { type: 'image/png' }) })])
    },

    'pty:write': (key, data) => {
      sessions.noteUserInput(key, data)
      writePty(key, data)
    },
    'pty:resize': (key, cols, rows) => resizePty(key, cols, rows),
    'pty:buffer': (key) => ptyBuffer(key),
    'pty:kill': (key) => {
      if (key.startsWith('task:')) killPty(key)
    },

    'skills:list': (p) => {
      skills.invalidateSkillCache()
      return skills.listSkills(p ? workspace.assertProject(p) : undefined)
    },
    'skills:workspace': () => skills.hiveSkills(true),
    'skills:create': async (name, description, targets) => {
      const s = await skills.createSkill(name, description, targets)
      emit({ type: 'skills-changed' })
      return s
    },
    'skills:pickFile': async () => {
      const r = await dialog.showOpenDialog(win(), {
        title: 'Add a skill from a file',
        properties: ['openFile'],
        filters: [{ name: 'Skill (.md or .zip)', extensions: ['md', 'markdown', 'zip'] }]
      })
      if (r.canceled || !r.filePaths[0]) return null
      return { path: r.filePaths[0], name: await skills.suggestSkillName(r.filePaths[0]) }
    },
    'skills:addFromFile': async (file, name, targets) => {
      const s = await skills.addSkillFromFile(file, name, targets)
      emit({ type: 'skills-changed' })
      return s
    },
    'skills:delete': async (path) => {
      await skills.deleteSkill(path)
      emit({ type: 'skills-changed' })
    },
    'skills:restoreBundled': async (name) => {
      const s = await skills.restoreBundledSkill(name)
      emit({ type: 'skills-changed' })
      return s
    },
    'skills:copyToWorkspace': async (path) => {
      const s = await skills.copySkillToWorkspace(path)
      skills.invalidateSkillCache()
      emit({ type: 'skills-changed' })
      return s
    },
    'skills:openFolder': () => void shell.openPath(workspace.skillsDir),

    'mcp:list': () => mcp.listMcp(),
    'mcp:setGlobal': async (name, enabled) => {
      await mcp.setMcpGlobal(name, enabled)
      emit({ type: 'skills-changed' })
      workspace.scheduleRefresh()
    },
    'mcp:setProject': async (p, name, enabled) => {
      await mcp.setMcpProject(workspace.assertProject(p), name, enabled)
      emit({ type: 'skills-changed' })
    },
    'mcp:create': async (name) => {
      const m = await mcp.createMcp(name)
      emit({ type: 'skills-changed' })
      return m
    },
    'mcp:read': (name) => mcp.readMcp(name),
    'mcp:save': async (name, text, expected) => {
      const m = await mcp.saveMcp(name, text, expected)
      emit({ type: 'skills-changed' })
      workspace.scheduleRefresh()
      return m
    },
    'mcp:delete': async (name) => {
      await mcp.deleteMcp(name)
      emit({ type: 'skills-changed' })
      workspace.scheduleRefresh()
    },
    'mcp:importFromProject': async (p, names) => {
      const imported = await mcp.importFromProject(workspace.assertProject(p), names)
      emit({ type: 'skills-changed' })
      workspace.scheduleRefresh()
      return imported
    },
    'mcp:openFolder': () => void shell.openPath(workspace.mcpDir),

    'notes:tree': () => notes.notesTree(),
    'notes:create': (rel, isDir) => notes.createNote(rel, isDir),
    'notes:delete': (p) => notes.deleteNote(p),
    'notes:rename': (p, n) => notes.renameNote(p, n),

    'assistant:actions': () => (workspace.path ? assistantControl.actions(workspace.path) : []),
    'assistant:questions': () => (workspace.path ? assistantControl.questions(workspace.path) : []),
    'assistant:answer': (id, yes) => assistantControl.answer(id, yes),
    'progress:list': () => (workspace.path ? progress.list(workspace.path) : []),
    'progress:dismiss': (id) => {
      if (workspace.path) progress.dismiss(workspace.path, String(id))
    },
    'progress:seen': () => {
      if (workspace.path) progress.seen(workspace.path)
    },
    'personas:list': () => personas.listPersonas(),
    'personas:create': async (name) => {
      const p = await personas.createPersona(name)
      workspace.emit({ type: 'personas-changed' })
      return p
    },
    'personas:delete': async (id) => {
      await personas.deletePersona(id)
      workspace.emit({ type: 'personas-changed' })
    },
    'personas:restore': async (id) => {
      const p = await personas.restorePersona(id)
      workspace.emit({ type: 'personas-changed' })
      return p
    },

    'file:read': async (p) => readFile(guardFile(p), 'utf8').catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? '' : Promise.reject(e))),
    'file:write': (p, content, expected) => writeTextUnlessChanged(guardFile(p, true), content, expected),

    'memory:list': async (p) => {
      const project = workspace.assertProject(p)
      return (await Promise.all(allProviders().map((a) => a.memorySources(project)))).flat()
    },
    'memory:instructionsShared': async (p, ids) => {
      const project = workspace.assertProject(p)
      return instructionsShared(await projectInstructions(project, ids.map(knownProvider)))
    },
    'memory:shareInstructions': async (p, ids) => {
      const project = workspace.assertProject(p)
      const list = await projectInstructions(project, ids.map(knownProvider))
      const shared = await readFile(join(project, SHARED_INSTRUCTIONS), 'utf8').catch(() => null)
      const writes = shareInstructions(list, shared, basename(project))
      for (const [file, text] of Object.entries(writes)) await writeTextAtomic(join(project, file), text)
      return Object.keys(writes)
    },

    'git:status': (root, base) => gitStatus(workspace.assertRoot(root), base),
    'git:diff': (root, f, base) => gitDiff(workspace.assertRoot(root), f, base),

    'provider:info': () => providerService.all(),
    'provider:refresh': async (id) => {
      await providerService.refresh(id, true)
      return providerService.all()
    },
    'provider:task': (id, task) => providerService.runProviderTask(id, task),
    'provider:stopAgents': (id) => sessions.stopProvider(id),

    'api:info': () => apiInfo(),
    'api:regenerateToken': async () => {
      await regenerateToken()
      return apiInfo()
    }
  }

  // Tests only (unpackaged builds), so a suite can see what the window does while an action runs or fails:
  // HIVE_TEST_SLOW_IPC="tasks:start=1500,git:diff=1500*1" delays those calls (`*n`: only the first n), and
  // HIVE_TEST_FAIL_IPC="git:status*1" makes them fail.
  // A suite may change them while Hive runs (in the main process): they are read again when they change.
  type TestCalls = { from: string; calls: Map<string, { ms: number; left: number }> }
  const testCalls = (name: string, held: TestCalls): TestCalls => {
    const from = app.isPackaged ? '' : (process.env[name] ?? '')
    if (from === held.from) return held
    const calls = new Map(
      from
        .split(',')
        .map((x) => x.trim().match(/^([^=*]+)(?:=(\d+))?(?:\*(\d+))?$/))
        .filter((m): m is RegExpMatchArray => !!m)
        .map((m) => [m[1], { ms: Number(m[2] ?? 0), left: m[3] ? Number(m[3]) : Infinity }] as const)
    )
    return { from, calls }
  }
  let slow: TestCalls = { from: '', calls: new Map() }
  let failing: TestCalls = { from: '', calls: new Map() }
  const take = (t: TestCalls, channel: string): { ms: number } | null => {
    const c = t.calls.get(channel)
    if (!c || c.left <= 0) return null
    c.left--
    return c
  }
  for (const [channel, fn] of Object.entries(impl)) {
    ipcMain.handle(channel, async (e, ...args: unknown[]) => {
      // Only Hive's own pages may call: not another window, and not a frame inside one (e.g. an HTML preview).
      const w = windowOf(e.sender)
      if (!w || e.senderFrame?.parent) throw new Error('Not allowed')
      slow = testCalls('HIVE_TEST_SLOW_IPC', slow)
      failing = testCalls('HIVE_TEST_FAIL_IPC', failing)
      const delay = take(slow, channel)
      if (delay?.ms) await new Promise((r) => setTimeout(r, delay.ms))
      if (take(failing, channel)) throw new Error(`${channel} failed (HIVE_TEST_FAIL_IPC)`)
      // Everything the call does is for that window's workspace.
      return inWorkspace(w.ws, () => (fn as (...a: unknown[]) => unknown)(...args))
    })
  }
}
