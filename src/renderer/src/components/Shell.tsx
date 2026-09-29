import hexUrl from '../assets/icon.svg'
import { compactThreshold, effectiveModelLabel, effortLabel, permissionLabel } from '@shared/defaults'
import type { PlanLimit } from '@shared/types'
import { useLiveUsage, useNow } from '../usage'
import { runCommand } from '../commands'
import { NO_PROJECTS, setActivity, set, useFocusedAgent, useStore, type Activity } from '../store'
import { cx, formatKeybinding, formatTokens, resetsIn, timeAgo } from '../util'
import { commandKeybinding } from '../commands'
import { Icon, Tooltip } from './ui'

const ACTIVITIES: { id: Activity; icon: string; label: string; command: string }[] = [
  { id: 'projects', icon: 'files', label: 'Projects', command: 'view.projects' },
  { id: 'notes', icon: 'notebook', label: 'Shared Notes', command: 'view.notes' },
  { id: 'skills', icon: 'sparkle', label: 'Skills', command: 'view.skills' },
  { id: 'mcp', icon: 'plug', label: 'MCP Servers', command: 'view.mcp' }
]

export function ActivityBar() {
  const activity = useStore((s) => s.activity)
  const sidebarVisible = useStore((s) => s.sidebarVisible)
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  const unread = useStore((s) => s.unread)
  const attention = projects.filter((p) => p.agents.some((a) => a.live?.unseen && (a.live.status === 'finished' || a.live.status === 'waiting'))).length

  const button = (id: Activity, icon: string, label: string, command: string, badge?: number) => {
    const kb = commandKeybinding(command)
    return (
      <Tooltip key={id} content={`${label}${kb ? ` (${formatKeybinding(kb)})` : ''}`}>
        <button className={cx('activity-btn', activity === id && (sidebarVisible || id === 'docs' || id === 'settings') && 'active')} onClick={() => setActivity(id)} aria-label={label}>
          <Icon name={icon} />
          {!!badge && <span className="activity-badge">{badge}</span>}
        </button>
      </Tooltip>
    )
  }

  return (
    <div className="activitybar">
      {ACTIVITIES.map((a) => button(a.id, a.icon, a.label, a.command, a.id === 'projects' ? attention : undefined))}
      <div className="activity-spacer" />
      <Tooltip content="Notifications">
        <button className="activity-btn" onClick={() => set((s) => ({ showNotifications: !s.showNotifications, unread: 0 }))} aria-label="Notifications">
          <Icon name={unread ? 'bell-dot' : 'bell'} />
        </button>
      </Tooltip>
      {button('docs', 'book', 'Documentation', 'help.docs')}
      {button('settings', 'settings-gear', 'Settings', 'settings.open')}
    </div>
  )
}

export function StatusBar() {
  const workspace = useStore((s) => s.workspace)
  const selected = useStore((s) => s.selectedProject)
  const agent = useStore((s) => s.agent)
  const api = useStore((s) => s.api)
  const settings = useStore((s) => s.settings)
  const project = workspace?.projects.find((p) => p.path === selected)
  const usage = useLiveUsage(project)
  const focused = useFocusedAgent(project)

  if (!workspace) {
    return (
      <div className="statusbar no-workspace">
        <div className="status-item" onClick={() => runCommand('workspace.open')}>
          <Icon name="folder-opened" /> Open a workspace
        </div>
        <div className="status-spacer" />
        <AgentStatus />
        <HiveVersion />
      </div>
    )
  }

  const live = workspace.projects.flatMap((p) => p.agents.map((a) => a.live).filter((l) => !!l))
  const working = live.filter((l) => l!.status === 'working').length
  const waiting = live.filter((l) => l!.status === 'waiting').length
  const cfg = project?.config
  const threshold = compactThreshold(cfg, settings?.sessions.compactSuggestTokens ?? 0)
  const overThreshold = !!usage && threshold > 0 && usage.contextTokens >= threshold
  const model = effectiveModelLabel(focused?.model || (cfg?.model ?? 'inherit'), settings?.claude.defaultModel ?? '', agent?.defaultModel ?? null)
  const effort = effortLabel(focused?.live?.effort, focused?.effort ?? cfg?.effort, settings?.claude.defaultEffort)
  let perm = focused?.permissionMode ?? (cfg && cfg.permissionMode !== 'inherit' ? cfg.permissionMode : settings?.claude.defaultPermissionMode ?? 'manual')
  if (perm === 'bypassPermissions' && !settings?.claude.enableBypassOption) perm = settings?.claude.defaultPermissionMode ?? 'manual'

  return (
    <div className="statusbar">
      <Tooltip content={`Workspace: ${workspace.path}`}>
        <div className="status-item" onClick={() => runCommand('view.projects')}>
          <Icon name="root-folder" /> {workspace.name}
        </div>
      </Tooltip>
      {project?.branch && (
        <Tooltip content="Git branch of the selected project">
          <div className="status-item" onClick={() => runCommand('project.tab.changes')}>
            <Icon name="git-branch" /> {project.branch}
          </div>
        </Tooltip>
      )}
      <Tooltip content={`${live.length} running session(s): ${working} working, ${waiting} waiting for input`}>
        <div className="status-item" onClick={() => runCommand('view.projects')}>
          <Icon name="pulse" /> {live.length}
          {waiting > 0 && (
            <>
              <Icon name="bell-dot" /> {waiting}
            </>
          )}
        </div>
      </Tooltip>
      <div className="status-spacer" />
      <PlanUsageStatus />
      {project && (
        <>
          {usage && (
            <Tooltip
              content={`Current context: ${usage.contextTokens.toLocaleString()} tokens · ${usage.compactions.length} compaction(s)${overThreshold ? ' — consider compacting (Session → Compact Conversation)' : ''}`}
            >
              <div className={cx('status-item', overThreshold && 'warn')} onClick={() => runCommand('project.tab.overview')}>
                <Icon name="dashboard" /> {formatTokens(usage.contextTokens)} ctx
              </div>
            </Tooltip>
          )}
          <Tooltip content={`Model${effort ? ' and effort' : ''} for this project's sessions${focused?.live?.effort ? ' (effort as reported by the running session)' : ''}${project.agents.length > 1 && focused ? ` — ${focused.name}` : ''}. Change them in Project Settings.`}>
            <div className="status-item" onClick={() => runCommand('project.tab.settings')}>
              <Icon name="hubot" /> {model}
              {effort && <span className="status-sub">· {effort}</span>}
            </div>
          </Tooltip>
          <Tooltip content="Permission mode new sessions start in. Change it in Project Settings.">
            <div className={cx('status-item', perm === 'bypassPermissions' && 'warn')} onClick={() => runCommand('project.tab.settings')}>
              <Icon name={perm === 'bypassPermissions' ? 'warning' : 'shield'} /> {permissionLabel(perm)}
            </div>
          </Tooltip>
        </>
      )}
      <Tooltip content={api?.running ? `Agent API listening on ${api.url}` : api?.error ? `Agent API: ${api.error}` : 'Agent API is off'}>
        <div className="status-item" onClick={() => {
            set({ settingsSection: 'agentApi' })
            setActivity('settings')
          }}>
          <Icon name={api?.running ? 'broadcast' : 'circle-slash'} /> API
        </div>
      </Tooltip>
      <AgentStatus />
      <HiveVersion />
    </div>
  )
}

/** The plan's 5-hour and weekly limits, as last reported by a Claude Code session. */
function PlanUsageStatus() {
  const usage = useStore((s) => s.planUsage)
  useNow(60000)
  if (!usage || (!usage.fiveHour && !usage.sevenDay)) return null
  const worst = Math.max(usage.fiveHour?.usedPercent ?? 0, usage.sevenDay?.usedPercent ?? 0)
  const line = (name: string, l: PlanLimit | null): string | null => (l ? `${name}: ${Math.round(l.usedPercent)}% used${l.resetsAt ? `, resets ${resetsIn(l.resetsAt)}` : ''}` : null)
  const tip = [line('5-hour limit', usage.fiveHour), line('Weekly limit', usage.sevenDay), `As of ${timeAgo(usage.updatedAt)}, from Claude Code. Updates while a session is running.`].filter(Boolean).join('\n')
  return (
    <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{tip}</span>}>
      <div className={cx('status-item', worst >= 95 ? 'warn' : worst >= 80 && 'caution')} onClick={() => runCommand('project.tab.overview')}>
        <Icon name="graph" />
        {usage.fiveHour && <span>5h {Math.round(usage.fiveHour.usedPercent)}%</span>}
        {usage.fiveHour && usage.sevenDay && <span className="status-sub">·</span>}
        {usage.sevenDay && <span>Week {Math.round(usage.sevenDay.usedPercent)}%</span>}
      </div>
    </Tooltip>
  )
}

/** Hive's own version; opens About. Dev builds say so, since they run beside the installed app. */
function HiveVersion() {
  const info = useStore((s) => s.appInfo)
  if (!info) return null
  return (
    <Tooltip content={`Hive ${info.version}${info.isPackaged ? '' : ' (development build)'} · Electron ${info.electron}`}>
      <div className="status-item" onClick={() => set({ aboutOpen: true })}>
        <img src={hexUrl} className="status-hex" alt="" /> {info.isPackaged ? `Hive ${info.version}` : `Hive Dev ${info.version}`}
      </div>
    </Tooltip>
  )
}

function AgentStatus() {
  const agent = useStore((s) => s.agent)
  if (!agent || agent.checking) {
    return (
      <div className="status-item">
        <Icon name="loading" spin /> Claude Code
      </div>
    )
  }
  if (!agent.found) {
    return (
      <div className="status-item warn" onClick={() => set({ setupOpen: true })}>
        <Icon name="warning" /> Claude Code CLI required
      </div>
    )
  }
  const tip = `Claude Code ${agent.version} (${agent.source})${agent.loggedIn === false ? ' — not signed in' : ''}${agent.updateAvailable ? ` — ${agent.latestVersion} available` : ''}`
  return (
    <Tooltip content={tip}>
      <div className="status-item" onClick={() => set({ setupOpen: true })}>
        <Icon name={agent.updateAvailable ? 'cloud-download' : agent.loggedIn === false ? 'account' : 'check'} /> Claude Code {agent.version}
      </div>
    </Tooltip>
  )
}

export { formatKeybinding }
