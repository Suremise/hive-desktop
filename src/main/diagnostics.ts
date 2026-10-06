import { app, screen } from 'electron'
import { existsSync } from 'original-fs'
import { open, readdir } from 'original-fs/promises'
import { homedir, release, version as osVersion } from 'os'
import { basename, join } from 'path'
import { redact, redactLog, type RedactContext } from '../shared/redact'
import { providerName } from '../shared/providers'
import type { AgentInstallInfo, ProviderId } from '../shared/types'
import { config } from './config'
import { logsDir } from './logger'
import { provider } from './providers'
import { providerService } from './providerService'
import { hiveWindows } from './windows'
import { GUIDANCE_REVISION } from './guidance'
import { hiveSkills } from './skills'
import { inWorkspace } from './workspace'

/** How much of Hive's log a report carries. */
const LOG_LINES = 50

/** The end of Hive's log (64 KB, whole lines). */
async function logTail(): Promise<string[]> {
  const file = join(logsDir(), 'hive.log')
  if (!existsSync(file)) return []
  const f = await open(file, 'r')
  try {
    const { size } = await f.stat()
    const length = Math.min(size, 64 * 1024)
    const buf = Buffer.alloc(length)
    await f.read(buf, 0, length, size - length)
    const lines = buf.toString('utf8').split(/\r?\n/)
    return (length < size ? lines.slice(1) : lines).filter(Boolean)
  } finally {
    await f.close()
  }
}

/** Workspaces opened before (Hive's recent list) and their project folders: the log names them too. */
async function earlierWork(): Promise<{ folders: string[]; names: string[] }> {
  const folders = config.get().recentWorkspaces
  const names: string[] = []
  for (const f of folders) {
    names.push(basename(f))
    const entries = await readdir(f, { withFileTypes: true }).catch(() => [])
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) names.push(e.name)
  }
  return { folders, names }
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
      ...(provider(id).diagnostics?.() ?? []).map((l) => `  - ${l}`),
      ...(info.readiness ?? []).map((r) => `  - ${r.level}: ${r.message}`)
    ]
    return [head, ...extra]
  })

  // Bundled skills: Hive's own names, so they are shown; the user's own skills only as a count.
  const skillLines: string[] = []
  for (const w of windows) {
    if (!w.ws.path) continue
    const list = await inWorkspace(w.ws, () => hiveSkills(true)).catch(() => [])
    const mark = (x: (typeof list)[number]): string => `${x.name} ${x.bundled}${x.updateAvailable ? ' (update available)' : ''}`
    skillLines.push(`- Workspace ${skillLines.length + 1}: ${list.filter((x) => x.bundled).map(mark).join(', ') || 'no bundled skills'}; ${list.filter((x) => !x.bundled).length} of its own`)
  }
  const running = agents.flatMap((a) => (a.live ? [a.live] : []))
  const older = running.filter((l) => l.launched && l.launched.guidance !== GUIDANCE_REVISION).length

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
    '### Guidance',
    '',
    `- Revision ${GUIDANCE_REVISION}${older ? `; ${older} running agent${older === 1 ? '' : 's'} launched with an older one` : ''}`,
    ...skillLines,
    '',
    '### Settings',
    '',
    `- File locks: ${s.agents.fileLocks}; merge style: ${s.agents.mergeStyle}; background task limit: ${s.agents.backgroundTaskMinutes} min`,
    `- Confirm before quitting: ${s.general.confirmOnQuit}; close to tray: ${s.general.closeToTray ? 'on' : 'off'}; minimise to tray: ${s.general.minimizeToTray ? 'on' : 'off'}; keep the PC awake: ${s.general.keepAwake}`,
    `- Transcript backups: ${s.sessions.backupTranscripts ? 'on' : 'off'}; cache TTL: ${s.sessions.cacheTtl}; Overview refresh: ${s.sessions.overviewRefresh}`,
    `- Agent API: ${s.agentApi.enabled ? 'on' : 'off'}; built-in hive MCP server: ${s.agentApi.provideHiveMcp ? 'on' : 'off'}; session input: ${s.agentApi.allowSessionInput ? 'allowed' : 'off'}`,
    `- Assistant control: ${typeof s.assistant.control === 'string' ? s.assistant.control : 'custom'}`,
    `- Notifications: ${s.notifications.desktopNotifications ? 'on' : 'off'}; while Hive is focused: ${{ inApp: 'in Hive', nothing: 'nothing', windows: 'Windows notifications' }[s.notifications.whileFocused]}${s.notifications.whileFocused === 'inApp' ? ` (banners for ${{ all: 'all workspaces', workspace: 'this workspace', project: 'this project' }[s.notifications.bannerScope]}, ${s.notifications.bannerPosition}, ${s.notifications.bannerSeconds} s; waiting banners ${s.notifications.waitingBannerStays ? 'stay' : 'close too'})` : ''}; chime ${s.notifications.chimeEnabled ? 'on' : 'off'}`,
    `- Theme: ${s.appearance.theme}`
  ].join('\n')

  // The log goes back further than what is open now: earlier workspaces and their projects are taken out too.
  // Hive marks the user's own text as it logs it (logger.ts userText()); this catches older lines and the rest.
  const earlier = await earlierWork()
  const ctx: RedactContext = {
    home: homedir(),
    app: app.isPackaged ? undefined : app.getAppPath(),
    folders: [...workspaces.map((w) => w.path), ...agents.flatMap((a) => (a.worktree ? [a.worktree.path] : [])), ...earlier.folders],
    names: [
      ...workspaces.map((w) => ({ name: w.name, as: '<workspace>' })),
      ...projects.map((p) => ({ name: p.name, as: '<project>' })),
      ...agents.flatMap((a) => [{ name: a.name, as: '<agent>' }, { name: a.id, as: '<agent>' }, ...(a.worktree ? [{ name: a.worktree.branch, as: '<branch>' }] : [])]),
      ...earlier.names.map((name) => ({ name, as: '<name>' }))
    ]
  }
  // Names are only taken out of the log: the summary above has none, and a project called "Hive" would take Hive's own name with it.
  // The whole tail is redacted first: which run of Hive a line is from depends on the start lines before it.
  const log = redactLog((await logTail()).join('\n'), ctx).split('\n').slice(-LOG_LINES).join('\n')
  return `${redact(header, { ...ctx, names: [] })}\n\n### Log (last ${LOG_LINES} lines)\n\n\`\`\`\n${log}\n\`\`\`\n`
}
