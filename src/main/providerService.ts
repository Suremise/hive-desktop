import { homedir } from 'os'
import type { AgentInstallInfo, ProviderId, ProviderTask } from '../shared/types'
import { isProviderEnabled, providerSettings } from '../shared/providers'
import { toSpawnable } from './providers/common'
import { allProviders, provider } from './providers'
import type { KeySteps } from './providers/types'
import { config } from './config'
import { emit, toast } from './events'
import { createLogger } from './logger'
import { childEnv, hasPty, spawnPty, writePty } from './ptyHost'

const log = createLogger('providers')

const blank = (id: ProviderId): AgentInstallInfo => ({
  provider: id,
  found: false,
  path: null,
  version: null,
  source: null,
  latestVersion: null,
  updateAvailable: false,
  loggedIn: null,
  authMethod: null,
  checking: true,
  defaultModel: null,
  readiness: []
})

/** Tracks each provider's installed CLI and runs its install, update, sign-in and setup tasks in visible terminals. */
class ProviderService {
  private infos = new Map<ProviderId, AgentInstallInfo>(allProviders().map((p) => [p.id, blank(p.id)]))
  private liveSessionCount: (provider: ProviderId) => number = () => 0

  info(id: ProviderId): AgentInstallInfo {
    return this.infos.get(id) ?? blank(id)
  }

  all(): Record<ProviderId, AgentInstallInfo> {
    return Object.fromEntries(this.infos)
  }

  /** The CLI's own default: its settings, else the model last seen in a session started without a model choice. */
  private resolveDefaultModel(id: ProviderId): string | null {
    return provider(id).configuredDefaultModel() ?? config.get().observedDefaultModel[id] ?? null
  }

  /** Records the model seen answering in a session started without a model choice. */
  observeDefaultModel(id: ProviderId, model: string): void {
    if (!provider(id).ownsModel(model) || config.get().observedDefaultModel[id] === model) return
    config.update((c) => {
      c.observedDefaultModel = { ...c.observedDefaultModel, [id]: model }
    })
    const next = this.resolveDefaultModel(id)
    const cur = this.info(id)
    if (next !== cur.defaultModel) this.set(id, { ...cur, defaultModel: next })
  }

  setLiveSessionCounter(fn: (provider: ProviderId) => number): void {
    this.liveSessionCount = fn
  }

  private set(id: ProviderId, info: AgentInstallInfo): void {
    this.infos.set(id, info)
    emit({ type: 'provider-install', provider: id, info })
  }

  /** Refreshes one provider, or all of them. Latest versions are only looked up for enabled providers. */
  async refresh(id?: ProviderId, checkLatest?: boolean): Promise<AgentInstallInfo[]> {
    const ids = id ? [id] : allProviders().map((p) => p.id)
    return Promise.all(ids.map((p) => this.refreshOne(p, checkLatest)))
  }

  private async refreshOne(id: ProviderId, checkLatest?: boolean): Promise<AgentInstallInfo> {
    const adapter = provider(id)
    const prev = this.info(id)
    this.set(id, { ...prev, checking: true })
    const latestWanted = checkLatest ?? (isProviderEnabled(config.settings, id) && providerSettings(config.settings, id).checkUpdatesOnLaunch)
    let next: AgentInstallInfo
    try {
      const found = await adapter.locate()
      const latest = latestWanted ? await adapter.latestVersion() : prev.latestVersion
      // The CLI's own model list, so new models show without a Hive update.
      const models = found.path && adapter.listModels ? await adapter.listModels(found.path).catch(() => null) : null
      next = {
        ...found,
        provider: id,
        defaultModel: this.resolveDefaultModel(id),
        latestVersion: latest,
        updateAvailable: !!(found.version && latest && adapter.isNewer(latest, found.version)),
        models: models ?? prev.models ?? null,
        checking: false
      }
    } catch (e) {
      log.error(`Failed to locate ${adapter.descriptor.name}`, e)
      next = { ...prev, checking: false }
    }
    next.readiness = adapter.readiness(next)
    this.set(id, next)
    return next
  }

  private runTask(id: ProviderId, task: ProviderTask, file: string, args: string[], label: string, typed?: { keys: KeySteps; ready?: RegExp }): string {
    const key = `task:${id}:${task}`
    if (hasPty(key)) return key
    const s = toSpawnable(file, args)
    let seen = ''
    let sent = !typed
    // Some tasks are keys typed into the CLI once its interface is ready (Codex's sandbox setup).
    const type = async (): Promise<void> => {
      if (sent || !typed) return
      sent = true
      for (const step of typed.keys) {
        if (!hasPty(key)) return
        writePty(key, step.keys)
        await new Promise((r) => setTimeout(r, step.waitMs ?? 60))
      }
    }
    if (typed) setTimeout(() => void type(), 15000)
    spawnPty(key, {
      file: s.file,
      args: s.args,
      cwd: homedir(),
      env: childEnv(),
      onData: (d) => {
        if (sent || !typed?.ready) return
        seen = (seen + d.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ')).slice(-2000)
        if (typed.ready.test(seen)) setTimeout(() => void type(), 800)
      },
      onExit: (code) => {
        if (code === 0) toast('success', `${label} finished`)
        else toast('warning', `${label} exited with code ${code}`)
        void this.refresh(id, true)
      }
    })
    return key
  }

  /** Starts a provider task in a terminal and returns its terminal key. */
  runProviderTask(id: ProviderId, task: ProviderTask): string {
    const adapter = provider(id)
    const name = adapter.descriptor.name
    const info = this.info(id)
    if (task === 'install') {
      const cmd = adapter.installCommand()
      return this.runTask(id, task, cmd.file, cmd.args, `${name} install`)
    }
    if (!info.path) throw new Error(`${name} is not installed.`)
    if (task === 'update') {
      if (this.liveSessionCount(id) > 0) throw new Error(`Stop all running ${name} agents before updating it.`)
      const cmd = adapter.updateCommand(info.path)
      return this.runTask(id, task, cmd.file, cmd.args, `${name} update`)
    }
    if (task === 'login') {
      const cmd = adapter.loginCommand(info.path)
      return this.runTask(id, task, cmd.file, cmd.args, `${name} sign-in`)
    }
    if (!adapter.setupCommand) throw new Error(`${name} has no setup task.`)
    const cmd = adapter.setupCommand(info.path)
    return this.runTask(id, task, cmd.file, cmd.args, `${name} setup`, cmd.keys ? { keys: cmd.keys, ready: cmd.readyPattern } : undefined)
  }
}

export const providerService = new ProviderService()
