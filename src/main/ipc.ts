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
import { allProviders } from './providers'
import { providerService } from './providerService'
import { config } from './config'
import { emit } from './events'
import { insideReal, writeTextAtomic } from './fsutil'
import { gitDiff, gitStatus } from './git'
import { logsDir } from './logger'
import * as files from './files'
import * as mcp from './mcp'
import * as notes from './notes'
import { killPty, ptyBuffer, resizePty, writePty } from './ptyHost'
import { apiInfo, regenerateToken } from './servers'
import * as projectAgents from './projectAgents'
import { sessions } from './sessions'
import { transcripts } from './transcripts'
import * as skills from './skills'
import { workspace } from './workspace'

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


export interface QuitControl {
  quit: () => void
  decide: (choice: QuitChoice, dontAskAgain: boolean) => void
  cancelPending: () => void
  state: () => ReturnType<HiveRequests['app:quitState']>
  setUnsaved: (paths: string[]) => void
}

export function registerIpc(getWindow: () => BrowserWindow | null, getAppInfo: () => ReturnType<HiveRequests['app:info']>, quitControl: QuitControl): void {
  // A new workspace starts with the skills that ship with Hive.
  workspace.onCreated = () => skills.addBundledSkills()
  const win = (): BrowserWindow => {
    const w = getWindow()
    if (!w) throw new Error('No window')
    return w
  }

  const impl: Impl = {
    'app:info': () => getAppInfo(),
    'app:planUsage': () => config.get().planUsage,
    'app:quit': () => quitControl.quit(),
    'app:quitDecision': (choice, dontAskAgain) => quitControl.decide(choice, dontAskAgain),
    'app:cancelPendingQuit': () => quitControl.cancelPending(),
    'app:quitState': () => quitControl.state(),
    'app:openExternal': (url) => {
      if (/^https?:\/\//i.test(url) || url.startsWith('mailto:')) void shell.openExternal(url)
    },
    'app:openPath': (p) => void shell.openPath(guardFile(p)),
    'app:showInFolder': (p) => shell.showItemInFolder(guardFile(p)),
    'app:openLogs': () => void shell.openPath(logsDir()),
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
    'window:toggleDevTools': () => win().webContents.toggleDevTools(),
    'window:zoom': (dir) => {
      const wc = win().webContents
      wc.setZoomLevel(dir === 'reset' ? 0 : Math.max(-3, Math.min(4, wc.getZoomLevel() + (dir === 'in' ? 0.5 : -0.5))))
    },
    'window:toggleFullScreen': () => win().setFullScreen(!win().isFullScreen()),
    'window:edit': (role) => {
      const wc = win().webContents
      ;({ undo: () => wc.undo(), redo: () => wc.redo(), cut: () => wc.cut(), copy: () => wc.copy(), paste: () => wc.paste(), selectAll: () => wc.selectAll() })[role]()
    },
    'window:setTitleBarColors': (color, symbolColor) => {
      try {
        win().setTitleBarOverlay({ color, symbolColor, height: 34 })
      } catch {
        // Not supported on this platform.
      }
    },

    'settings:get': () => config.settings,
    'settings:update': (patch) => config.updateSettings(patch),
    'settings:setKeybinding': (id, key) => config.setKeybinding(id, key),
    'settings:setProviderPrices': (provider, prices) => config.setProviderPrices(knownProvider(provider), prices),
    'settings:reset': (section) => config.resetSettings(section),
    'ui:get': () => config.get().ui,
    'ui:set': (ui) => config.update((c) => Object.assign(c.ui, ui)),

    'workspace:get': () => workspace.info(),
    'workspace:open': async (path) => {
      let target = path
      if (!target) {
        const r = await dialog.showOpenDialog(win(), { title: 'Open Workspace', properties: ['openDirectory'], buttonLabel: 'Open Workspace' })
        if (r.canceled || !r.filePaths[0]) return workspace.info()
        target = r.filePaths[0]
      }
      if (sessions.liveCount() > 0 && workspace.path && target.toLowerCase() !== workspace.path.toLowerCase()) {
        throw new Error('Stop all running sessions before switching workspace.')
      }
      return workspace.open(target)
    },
    'workspace:create': async () => {
      const r = await dialog.showOpenDialog(win(), {
        title: 'Choose or create a folder for the new workspace',
        properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
        buttonLabel: 'Create Workspace'
      })
      if (r.canceled || !r.filePaths[0]) return workspace.info()
      if (sessions.liveCount() > 0) throw new Error('Stop all running sessions before switching workspace.')
      const { mkdir } = await import('fs/promises')
      await mkdir(r.filePaths[0], { recursive: true })
      return workspace.open(r.filePaths[0])
    },
    'workspace:close': async () => {
      if (sessions.liveCount() > 0) throw new Error('Stop all running sessions before closing the workspace.')
      await workspace.close()
      config.update((c) => (c.lastWorkspace = null))
      emit({ type: 'workspace-changed', workspace: null })
    },
    'workspace:recent': () => config.get().recentWorkspaces,
    'workspace:removeRecent': (p) => {
      config.update((c) => (c.recentWorkspaces = c.recentWorkspaces.filter((x) => x !== p)))
      return config.get().recentWorkspaces
    },
    'workspace:refresh': async () => (workspace.path ? workspace.refresh() : null),

    'project:create': (name) => workspace.createProject(name),
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
    'session:stop': (p, agentId) => sessions.stop(workspace.assertProject(p), agentId),
    'session:archive': (p, id, archived) => sessions.archive(p, id, archived),
    'session:rename': (p, id, name) => sessions.rename(p, id, name),
    'session:adopt': (p, id) => sessions.adopt(p, id),
    'session:usage': (p, id) => sessions.usage(workspace.assertProject(p), id),
    'session:markSeen': (p) => sessions.markSeen(p),
    'session:live': () => sessions.liveStates(),
    'session:setMode': (p, agentId, mode) => sessions.setPermissionMode(p, agentId, mode),
    'session:restartInMode': (p, agentId, mode) => sessions.restartInMode(p, agentId, mode),
    'session:setPlanMode': (p, agentId, on) => sessions.setPlanMode(p, agentId, on),
    'session:continueWith': (p, from, to, opts) => sessions.continueWith(p, from, to, opts),
    'session:allowLockedEdit': (p, agentId, path) => sessions.allowLockedEdit(p, agentId, path),
    'session:applyModes': () => sessions.applyModeSettings(),
    'session:compact': (p, focus, agentId) => sessions.compact(p, focus, agentId),
    'session:saveImage': (p, sourceFile, agentId) => sessions.saveImage(p, sourceFile, agentId),

    'agents:add': (p, opts) => projectAgents.addAgent(p, opts),
    'agents:update': (p, id, patch) => projectAgents.updateAgent(p, id, patch),
    'agents:remove': (p, id, opts) => projectAgents.removeAgent(p, id, opts),
    'agents:gitInfo': (p) => projectAgents.gitInfo(p),
    'agents:branchStatus': (p, id) => projectAgents.branchStatus(p, id),
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
    'files:watch': (p) => files.watchProject(p),
    'files:setUnsaved': (paths) => quitControl.setUnsaved(Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : []),
    'files:unwatch': (p) => files.unwatchProject(p),

    'images:list': (p) => files.listImages(p),
    'images:trash': (p, path) => files.trashImage(p, path),
    'transcript:read': (p, id, opts) => transcripts.read(p, id, opts ?? {}),
    'transcript:tool': (p, id, itemId) => transcripts.tool(p, id, itemId),
    'transcript:image': (p, id, imageId) => transcripts.image(p, id, imageId),
    'transcript:search': (p, query, id) => transcripts.search(p, query, id),
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

    'pty:write': (key, data) => writePty(key, data),
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
    'mcp:save': async (name, text) => {
      const m = await mcp.saveMcp(name, text)
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

    'file:read': async (p) => readFile(guardFile(p), 'utf8').catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? '' : Promise.reject(e))),
    'file:write': (p, content) => writeTextAtomic(guardFile(p, true), content),

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

  for (const [channel, fn] of Object.entries(impl)) {
    ipcMain.handle(channel, async (e, ...args: unknown[]) => {
      // Only Hive's own page may call: not another window, and not a frame inside it (e.g. an HTML preview).
      const w = getWindow()
      if (!w || e.sender !== w.webContents || e.senderFrame?.parent) throw new Error('Not allowed')
      return (fn as (...a: unknown[]) => unknown)(...args)
    })
  }
}
