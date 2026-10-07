import { homedir } from 'os'
import type { AgentInstallInfo, ModelCatalog, ProviderId, ProviderTask } from '../shared/types'
import { observedEffortKey } from '../shared/models'
import { isProviderEnabled, providerSettings } from '../shared/providers'
import { toSpawnable } from './providers/common'
import { allProviders, provider } from './providers'
import type { KeySteps } from './providers/types'
import { config } from './config'
import { emit, toast } from './events'
import { createLogger } from './logger'
import { childEnv, hasPty, killPty, PTY_COLS, PTY_ROWS, spawnPty, writePty } from './ptyHost'
import { KeyGate } from './taskKeys'
import { PickNotFound, typeKeySteps } from './keySteps'
import { compareTested, noteSelectedCli, testedVersion } from './testedClis'

const log = createLogger('providers')
/** How many models' default efforts are kept per provider (observeDefaultEffort). */
const OBSERVED_EFFORTS = 50

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

  /**
   * The CLI's own default: its settings, else what its catalog says runs when no model is passed (Claude Code's
   * "default"), else the model last seen in a session started without a model choice.
   */
  private resolveDefaultModel(id: ProviderId, catalog?: ModelCatalog | null): string | null {
    return provider(id).configuredDefaultModel() ?? catalog?.defaultModel ?? config.get().observedDefaultModel[id] ?? null
  }

  /** The efforts sessions started without an effort choice ran with, per model (the CLI's own defaults). */
  private observedEfforts(id: ProviderId): Record<string, string> {
    return { ...config.get().observedDefaultEffort?.[id] }
  }

  /**
   * Records the effort a session started without an effort choice reports for its model: the CLI's default for that
   * model, which the footer then shows ("Medium (default)") for agents with no effort set (#125).
   */
  observeDefaultEffort(id: ProviderId, model: string, effort: string): void {
    const key = observedEffortKey(model)
    if (!key || !effort || config.get().observedDefaultEffort?.[id]?.[key] === effort) return
    config.update((c) => {
      // Bounded: the newest OBSERVED_EFFORTS models (custom model ids would otherwise add up for ever).
      const kept = Object.entries({ ...c.observedDefaultEffort?.[id] }).filter(([k]) => k !== key).slice(-(OBSERVED_EFFORTS - 1))
      c.observedDefaultEffort = { ...c.observedDefaultEffort, [id]: { ...Object.fromEntries(kept), [key]: effort } }
    })
    this.set(id, { ...this.info(id), observedEfforts: this.observedEfforts(id) })
  }

  /** The last good catalog this provider's CLI gave, as a cache (for its version only). */
  private cachedCatalog(id: ProviderId, version?: string | null): ModelCatalog | null {
    const c = config.get().modelCatalogs?.[id]
    if (!c || !Array.isArray(c.models) || !c.models.length) return null
    return version === undefined || c.version === version ? { ...c, source: 'cache' } : null
  }

  /** Records the model seen answering in a session started without a model choice. */
  observeDefaultModel(id: ProviderId, model: string): void {
    if (!provider(id).ownsModel(model) || config.get().observedDefaultModel[id] === model) return
    config.update((c) => {
      c.observedDefaultModel = { ...c.observedDefaultModel, [id]: model }
    })
    const cur = this.info(id)
    const next = this.resolveDefaultModel(id, cur.catalog)
    if (next !== cur.defaultModel) this.set(id, { ...cur, defaultModel: next })
  }

  setLiveSessionCounter(fn: (provider: ProviderId) => number): void {
    this.liveSessionCount = fn
  }

  private signedInListeners: ((provider: ProviderId) => void)[] = []

  /**
   * Called when a CLI is signed in again: its check says so after saying it wasn't, or its Sign in task ended well
   * (agents stopped by a refused sign-in can carry on, #309).
   */
  onSignedIn(fn: (provider: ProviderId) => void): void {
    this.signedInListeners.push(fn)
  }

  private signedIn(id: ProviderId): void {
    for (const fn of this.signedInListeners) fn(id)
  }

  private set(id: ProviderId, info: AgentInstallInfo): void {
    const was = this.infos.get(id)?.loggedIn
    this.infos.set(id, info)
    emit({ type: 'provider-install', provider: id, info })
    if (was === false && info.loggedIn === true) this.signedIn(id)
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
    // The last good catalog fills the pickers at once (on start), until this refresh has asked the CLI again.
    this.set(id, { ...prev, catalog: prev.catalog ?? this.cachedCatalog(id), checking: true })
    const latestWanted = checkLatest ?? (isProviderEnabled(config.settings, id) && providerSettings(config.settings, id).checkUpdatesOnLaunch)
    let next: AgentInstallInfo
    try {
      const found = await adapter.locate()
      const latest = latestWanted ? await adapter.latestVersion() : prev.latestVersion
      // The version this release was tested with, against the installed one (#365).
      const tested = await testedVersion(id)
      // The CLI's own models and what each can do, so new models show without a Hive update (#125). If it can't say,
      // its last good answer for this version, else none (the pickers then use the fallbacks in Settings).
      const read = found.path && adapter.listModels ? await adapter.listModels(found.path, childEnv()).catch(() => null) : null
      let catalog: ModelCatalog | null = null
      if (read) {
        catalog = { source: 'cli', version: found.version, models: read.models, ...(read.defaultModel ? { defaultModel: read.defaultModel } : {}), at: new Date().toISOString() }
        const keep = catalog
        // Only the latest refresh's answer is kept (an older one still running mustn't replace a newer one's).
        if (this.refreshes.get(id) === run)
          config.update((c) => {
            c.modelCatalogs = { ...c.modelCatalogs, [id]: keep }
          })
      } else {
        catalog = this.cachedCatalog(id, found.version)
        if (found.path && adapter.listModels) log.warn(`${adapter.descriptor.name} ${found.version ?? ''} didn't say which models it has: ${catalog ? 'using its last answer' : 'using the fallback list'}`)
      }
      next = {
        ...found,
        provider: id,
        defaultModel: this.resolveDefaultModel(id, catalog),
        latestVersion: latest,
        updateAvailable: !!(found.version && latest && adapter.isNewer(latest, found.version)),
        catalog,
        configuredEffort: adapter.configuredDefaultEffort?.() ?? null,
        observedEfforts: this.observedEfforts(id),
        tested: tested ? compareTested(tested, found.version, (a, b) => adapter.isNewer(a, b)) : null,
        checking: false
      }
    } catch (e) {
      log.error(`Failed to locate ${adapter.descriptor.name}`, e)
      next = { ...prev, checking: false }
    }
    next.readiness = adapter.readiness(next)
    if (this.refreshes.get(id) !== run) return this.info(id)
    this.set(id, next)
    await noteSelectedCli(next)
    return next
  }

  private runTask(id: ProviderId, task: ProviderTask, file: string, args: string[], label: string, typed?: { keys: KeySteps; ready?: RegExp; busyTitle?: RegExp; done?: () => boolean }): string {
    const key = `task:${id}:${task}`
    if (hasPty(key)) return key
    const s = toSpawnable(file, args)
    let sent = !typed
    let finished = false
    // Typed once its screen shows it ready (typeWhenIdle).
    // A key picked from the screen (a menu entry, #396) needs the screen after it is ready too.
    const picks = !!typed?.keys.some((k) => 'pick' in k)
    const gate = typed?.ready ? new KeyGate({ ready: typed.ready, busyTitle: typed.busyTitle, cols: PTY_COLS, rows: PTY_ROWS, onReady: () => typeWhenIdle(), keepScreen: picks }) : null
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
    const settled = (): boolean => !gate || gate.settled(500)
    const type = async (): Promise<void> => {
      if (sent || !typed) return
      sent = true
      try {
        await typeKeySteps(typed.keys, {
          write: (keys) => writePty(key, keys),
          screen: () => gate?.text() ?? null,
          // Each key waits while the program is busy (it can get busy again after showing its prompt): an Enter
          // typed then would queue the command rather than run it. At most 30 seconds, then it goes in anyway.
          ready: async () => {
            for (const t0 = Date.now(); !settled() && Date.now() - t0 < 30_000; ) await new Promise((r) => setTimeout(r, 200))
            return hasPty(key)
          }
        })
      } catch (e) {
        if (!(e instanceof PickNotFound)) throw e
        // The CLI doesn't show what the task needs (another version): the terminal stays open for the user to do it.
        log.warn(`${label}: couldn't find ${e.what}`)
        toast('warning', `${label}: Hive couldn't find ${e.what}. Do it in the terminal, or update Hive.`)
      } finally {
        if (picks) gate?.dispose()
      }
    }
    // Typed once the interface is ready and has been idle for a moment (or, failing that, after 30 seconds).
    const typeWhenIdle = (): void => {
      if (sent || typeTimer) return
      const wait = (): void => {
        typeTimer = null
        if (sent || !gate) return
        const idleFor = gate.idleFor()
        if (idleFor < 1000) typeTimer = setTimeout(wait, gate.busy ? 300 : 1000 - idleFor)
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
        if (gate && !finished) gate.feed(d)
      },
      onExit: (code) => {
        if (watch) clearInterval(watch)
        gate?.dispose()
        if (code === 0 || finished) toast('success', `${label} finished`)
        else toast('warning', `${label} exited with code ${code}`)
        if (task === 'login' && code === 0) this.signedIn(id)
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
