import { homedir } from 'os'
import type { AgentInstallInfo, ProviderId, ProviderTask } from '../shared/types'
import { isProviderEnabled, providerSettings } from '../shared/providers'
import { toSpawnable } from './providers/common'
import { allProviders, provider } from './providers'
import type { KeySteps } from './providers/types'
import { config } from './config'
import { emit, toast } from './events'
import { createLogger } from './logger'
import { childEnv, hasPty, killPty, spawnPty, writePty } from './ptyHost'
import { lastTitle } from './terminalTitle'

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

  /** Each provider's latest refresh: an older one still running when a newer starts (the path changed) is dropped. */
  private refreshes = new Map<ProviderId, number>()

  private async refreshOne(id: ProviderId, checkLatest?: boolean): Promise<AgentInstallInfo> {
    const adapter = provider(id)
    const prev = this.info(id)
    const run = (this.refreshes.get(id) ?? 0) + 1
    this.refreshes.set(id, run)
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
    if (this.refreshes.get(id) !== run) return this.info(id)
    this.set(id, next)
    return next
  }

  private runTask(id: ProviderId, task: ProviderTask, file: string, args: string[], label: string, typed?: { keys: KeySteps; ready?: RegExp; busyTitle?: RegExp; done?: () => boolean }): string {
    const key = `task:${id}:${task}`
    if (hasPty(key)) return key
    const s = toSpawnable(file, args)
    let seen = ''
    let sent = !typed
    let finished = false
    let ready = false
    let busy = false
    let titleCarry = ''
    /** When the program last showed or stopped showing that it is busy. */
    let busyChanged = 0
    let typeTimer: NodeJS.Timeout | null = null
    // A program that stays open after its job (Codex after its sandbox setup) is closed once the job is done.
    const watch = typed?.done
      ? setInterval(() => {
          if (!hasPty(key) || finished || !typed.done!()) return
          finished = true
          setTimeout(() => killPty(key), 1500)
        }, 1500)
      : null
    // Some tasks are keys typed into the CLI once its interface is ready (Codex's sandbox setup).
    /** Not busy, and not for half a second (the output changes as it settles). */
    const settled = (): boolean => !busy && Date.now() - busyChanged >= 500
    const type = async (): Promise<void> => {
      if (sent || !typed) return
      sent = true
      for (const step of typed.keys) {
        // Each key waits while the program is busy (it can get busy again after showing its prompt): an Enter
        // typed then would queue the command rather than run it. At most 30 seconds, then it goes in anyway.
        for (const t0 = Date.now(); !settled() && Date.now() - t0 < 30_000; ) await new Promise((r) => setTimeout(r, 200))
        if (!hasPty(key)) return
        writePty(key, step.keys)
        await new Promise((r) => setTimeout(r, step.waitMs ?? 60))
      }
    }
    // Typed once the interface is ready and has been idle for a moment (or, failing that, after 30 seconds).
    const typeWhenIdle = (): void => {
      if (sent || typeTimer) return
      const wait = (): void => {
        typeTimer = null
        if (sent) return
        const idleFor = Date.now() - busyChanged
        if (busy || idleFor < 1000) typeTimer = setTimeout(wait, busy ? 300 : 1000 - idleFor)
        else void type()
      }
      typeTimer = setTimeout(wait, 800)
    }
    if (typed) setTimeout(() => void type(), 30000)
    spawnPty(key, {
      file: s.file,
      args: s.args,
      cwd: homedir(),
      env: childEnv(),
      onData: (d) => {
        if (!typed?.ready || finished) return
        if (typed.busyTitle) {
          const { title, carry } = lastTitle(titleCarry, d)
          titleCarry = carry
          if (title !== null && typed.busyTitle.test(title) !== busy) {
            busy = !busy
            busyChanged = Date.now()
          }
        }
        if (sent) return
        seen = (seen + d.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ')).slice(-2000)
        if (!ready && typed.ready.test(seen)) ready = true
        if (ready) typeWhenIdle()
      },
      onExit: (code) => {
        if (watch) clearInterval(watch)
        if (code === 0 || finished) toast('success', `${label} finished`)
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
    return this.runTask(id, task, cmd.file, cmd.args, `${name} setup`, cmd.keys ? { keys: cmd.keys, ready: cmd.readyPattern, busyTitle: cmd.busyTitle, done: cmd.done } : undefined)
  }
}

export const providerService = new ProviderService()
