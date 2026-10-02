import { app, screen } from 'electron'
import { existsSync } from 'fs'
import { open } from 'fs/promises'
import { homedir, release, version as osVersion } from 'os'
import { join } from 'path'
import { redact, type RedactContext } from '../shared/redact'
import { providerName } from '../shared/providers'
import type { AgentInstallInfo, ProviderId } from '../shared/types'
import { config } from './config'
import { logsDir } from './logger'
import { providerService } from './providerService'
import { hiveWindows } from './windows'

/** How much of Hive's log a report carries. */
const LOG_LINES = 50

async function logTail(lines: number): Promise<string[]> {
  const file = join(logsDir(), 'hive.log')
  if (!existsSync(file)) return []
  const f = await open(file, 'r')
  try {
    const { size } = await f.stat()
    const length = Math.min(size, 64 * 1024)
    const buf = Buffer.alloc(length)
    await f.read(buf, 0, length, size - length)
    return buf.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-lines)
  } finally {
    await f.close()
  }
}

const yesNo = (v: boolean | null | undefined): string => (v === true ? 'yes' : v === false ? 'no' : 'unknown')

/**
 * Help → Copy Diagnostics: versions, each coding agent's state, counts, the settings that change how Hive
 * behaves and the end of its log, as Markdown for a bug report. Redacted (shared/redact.ts): no folder,
 * workspace, project or agent names, prompts or secrets.
 */
export async function diagnostics(): Promise<string> {
  const s = config.settings
  const windows = hiveWindows()
  const workspaces = windows.map((w) => w.ws.info()).filter((w) => !!w)
  const projects = workspaces.flatMap((w) => w.projects)
  const agents = projects.flatMap((p) => p.agents)
  const assistants = workspaces.map((w) => w.assistant).filter((a) => !!a)
  const display = screen.getPrimaryDisplay()

  const providers = providerService.all()
  const providerLines = (Object.entries(providers) as [ProviderId, AgentInstallInfo][]).flatMap(([id, info]) => {
    const set = s.providers[id]
    const head = `- **${providerName(id)}**: ${set?.enabled ? 'on' : 'off'}; ${info.found ? `${info.version ?? 'version unknown'} at \`${info.path ?? '?'}\`${info.source ? ` (${info.source})` : ''}` : 'not found'}; signed in: ${yesNo(info.loggedIn)}${info.updateAvailable && info.latestVersion ? `; ${info.latestVersion} available` : ''}`
    const extra = [
      ...(set?.executablePath ? ['  - its path is set in Settings'] : []),
      ...(set?.extraArgs ? ['  - extra arguments are set'] : []),
      ...(info.editorExtensionOnly ? ["  - only an editor extension's copy was found"] : []),
      ...(info.readiness ?? []).map((r) => `  - ${r.level}: ${r.message}`)
    ]
    return [head, ...extra]
  })

  const header = [
    '## Hive diagnostics',
    '',
    `- **Hive** ${app.getVersion()} (${app.isPackaged ? 'installed' : 'development build'}); updates: ${s.updates.prerelease ? 'beta' : 'stable'} channel, check ${s.updates.checkAutomatically ? 'automatically' : 'manually'}, install ${s.updates.install}`,
    `- **Electron** ${process.versions.electron}, Chromium ${process.versions.chrome}, Node ${process.versions.node}`,
    `- **Windows**: ${osVersion()} ${release()} (${process.arch}); display scaling ${Math.round(display.scaleFactor * 100)}%; locale ${app.getLocale()}`,
    '',
    '### Coding agents',
    '',
    ...providerLines,
    '',
    '### Counts',
    '',
    `- Windows: ${windows.length}; projects: ${projects.filter((p) => p.active).length} active of ${projects.length}`,
    `- Agents: ${agents.length}, ${agents.filter((a) => a.live).length} running, ${agents.filter((a) => a.worktree).length} in worktrees`,
    `- Hive Assistant: ${assistants.some((a) => a.agents.some((x) => x.live)) ? 'running' : 'not running'}`,
    '',
    '### Settings',
    '',
    `- File locks: ${s.agents.fileLocks}; merge style: ${s.agents.mergeStyle}; background task limit: ${s.agents.backgroundTaskMinutes} min`,
    `- Confirm before quitting: ${s.general.confirmOnQuit}; close to tray: ${s.general.closeToTray ? 'on' : 'off'}; minimise to tray: ${s.general.minimizeToTray ? 'on' : 'off'}; keep the PC awake: ${s.general.keepAwake}`,
    `- Transcript backups: ${s.sessions.backupTranscripts ? 'on' : 'off'}; cache TTL: ${s.sessions.cacheTtl}; Overview refresh: ${s.sessions.overviewRefresh}`,
    `- Agent API: ${s.agentApi.enabled ? 'on' : 'off'}; built-in hive MCP server: ${s.agentApi.provideHiveMcp ? 'on' : 'off'}; session input: ${s.agentApi.allowSessionInput ? 'allowed' : 'off'}`,
    `- Assistant control: ${typeof s.assistant.control === 'string' ? s.assistant.control : 'custom'}`,
    `- Notifications: ${s.notifications.desktopNotifications ? 'on' : 'off'}${s.notifications.onlyWhenUnfocused ? ' (only when Hive is in the background)' : ''}; chime ${s.notifications.chimeEnabled ? 'on' : 'off'}`,
    `- Theme: ${s.appearance.theme}`
  ].join('\n')

  const ctx: RedactContext = {
    home: homedir(),
    folders: [...workspaces.map((w) => w.path), ...agents.flatMap((a) => (a.worktree ? [a.worktree.path] : []))],
    names: [
      ...workspaces.map((w) => ({ name: w.name, as: '<workspace>' })),
      ...projects.map((p) => ({ name: p.name, as: '<project>' })),
      ...agents.flatMap((a) => [{ name: a.name, as: '<agent>' }, { name: a.id, as: '<agent>' }, ...(a.worktree ? [{ name: a.worktree.branch, as: '<branch>' }] : [])])
    ]
  }
  // Names are only taken out of the log: the summary above has none, and a project called "Hive" would take Hive's own name with it.
  const log = redact((await logTail(LOG_LINES)).join('\n'), ctx)
  return `${redact(header, { ...ctx, names: [] })}\n\n### Log (last ${LOG_LINES} lines)\n\n\`\`\`\n${log}\n\`\`\`\n`
}
