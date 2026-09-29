import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { AgentInstallInfo } from '../shared/types'
import { claudeCode } from './agents/claude-code'
import { claudeHome, toSpawnable } from './agents/claude-code'
import { config } from './config'
import { emit, toast } from './events'
import { createLogger } from './logger'
import { childEnv, hasPty, spawnPty } from './ptyHost'

const log = createLogger('agent')

/** Tracks the installed Claude Code CLI and runs install/update/login tasks in visible terminals. */
class AgentService {
  info: AgentInstallInfo = {
    found: false,
    path: null,
    version: null,
    source: null,
    latestVersion: null,
    updateAvailable: false,
    loggedIn: null,
    authMethod: null,
    checking: true,
    defaultModel: null
  }
  private liveSessionCount: () => number = () => 0

  /** Claude Code's own default: "model" in ~/.claude/settings.json, else what sessions have shown. */
  private resolveDefaultModel(): string | null {
    try {
      const m = JSON.parse(readFileSync(join(claudeHome(), 'settings.json'), 'utf8')).model
      if (typeof m === 'string' && m.trim()) return m.trim()
    } catch {
      // no settings file, or no model in it
    }
    return config.get().observedDefaultModel
  }

  /** Records the model seen answering in a session started without --model. */
  observeDefaultModel(model: string): void {
    if (!/^claude-/i.test(model) || config.get().observedDefaultModel === model) return
    config.update((c) => {
      c.observedDefaultModel = model
    })
    const next = this.resolveDefaultModel()
    if (next !== this.info.defaultModel) {
      this.info = { ...this.info, defaultModel: next }
      emit({ type: 'agent-install', info: this.info })
    }
  }

  setLiveSessionCounter(fn: () => number): void {
    this.liveSessionCount = fn
  }

  async refresh(checkLatest = config.settings.claude.checkUpdatesOnLaunch): Promise<AgentInstallInfo> {
    this.info = { ...this.info, checking: true }
    emit({ type: 'agent-install', info: this.info })
    try {
      const found = await claudeCode.locate()
      const latest = checkLatest ? await claudeCode.latestVersion() : this.info.latestVersion
      this.info = {
        ...found,
        defaultModel: this.resolveDefaultModel(),
        latestVersion: latest,
        updateAvailable: !!(found.version && latest && claudeCode.isNewer(latest, found.version)),
        checking: false
      }
    } catch (e) {
      log.error('Failed to locate Claude Code', e)
      this.info = { ...this.info, checking: false }
    }
    emit({ type: 'agent-install', info: this.info })
    return this.info
  }

  private runTask(key: string, file: string, args: string[], label: string): string {
    if (hasPty(key)) return key
    const s = toSpawnable(file, args)
    spawnPty(key, {
      file: s.file,
      args: s.args,
      cwd: homedir(),
      env: childEnv(),
      onExit: (code) => {
        if (code === 0) toast('success', `${label} finished`)
        else toast('warning', `${label} exited with code ${code}`)
        void this.refresh(true)
      }
    })
    return key
  }

  install(): string {
    const cmd = claudeCode.installCommand()
    return this.runTask('task:install', cmd.file, cmd.args, 'Claude Code install')
  }

  update(): string {
    if (!this.info.path) throw new Error('The Claude Code CLI is not installed')
    if (this.liveSessionCount() > 0) throw new Error('Stop all running sessions before updating Claude Code')
    const cmd = claudeCode.updateCommand(this.info.path)
    return this.runTask('task:update', cmd.file, cmd.args, 'Claude Code update')
  }

  login(): string {
    if (!this.info.path) throw new Error('The Claude Code CLI is not installed')
    const cmd = claudeCode.loginCommand(this.info.path)
    return this.runTask('task:login', cmd.file, cmd.args, 'Claude Code sign-in')
  }
}

export const agentService = new AgentService()
