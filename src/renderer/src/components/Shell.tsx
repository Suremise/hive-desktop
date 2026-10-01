import type { PlanLimit } from '@shared/types'
import { useNow } from '../usage'
import { runCommand } from '../commands'
import { NO_PROJECTS, setActivity, set, useStore, type Activity } from '../store'
import { enabledProviders } from '@shared/providers'
import { ProviderIcon } from './ProviderIcon'
import { cx, formatKeybinding, resetsIn, timeAgo } from '../util'
import { commandKeybinding } from '../commands'
import { Icon, Tooltip } from './ui'
import { UpdateStatusItem } from './Updates'

const ACTIVITIES: { id: Activity; icon: string; label: string; command: string }[] = [
  { id: 'projects', icon: 'files', label: 'Projects', command: 'view.projects' },
  { id: 'notes', icon: 'notebook', label: 'Shared Notes', command: 'view.notes' },
  { id: 'skills', icon: 'sparkle', label: 'Skills', command: 'view.skills' },
  { id: 'mcp', icon: 'plug', label: 'MCP Servers', command: 'view.mcp' },
  { id: 'assistant', icon: 'hubot', label: 'Hive Assistant', command: 'view.assistant' }
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
  const api = useStore((s) => s.api)
  const project = workspace?.projects.find((p) => p.path === selected)

  if (!workspace) {
    return (
      <div className="statusbar no-workspace">
        <div className="status-item" onClick={() => runCommand('workspace.open')}>
          <Icon name="folder-opened" /> Open a workspace
        </div>
        <div className="status-spacer" />
        <ProviderStatusItems />
        <UpdateStatusItem />
      </div>
    )
  }

  const live = workspace.projects.flatMap((p) => p.agents.map((a) => a.live).filter((l) => !!l))
  const working = live.filter((l) => l!.status === 'working').length
  const waiting = live.filter((l) => l!.status === 'waiting').length

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
      {/* App-wide items only: each agent's model, effort, mode and context are in its pane's footer. */}
      <PlanUsageStatus />
      <Tooltip content={api?.running ? `Agent API listening on ${api.url}` : api?.error ? `Agent API: ${api.error}` : 'Agent API is off'}>
        <div className="status-item" onClick={() => {
            set({ settingsSection: 'agentApi' })
            setActivity('settings')
          }}>
          <Icon name={api?.running ? 'broadcast' : 'circle-slash'} /> API
        </div>
      </Tooltip>
      <ProviderStatusItems />
      <UpdateStatusItem />
    </div>
  )
}

/** "5h" / "Week" for the status bar; other windows by their label. */
function shortLimit(l: PlanLimit): string {
  if (l.windowMinutes === 300) return '5h'
  if (l.windowMinutes === 10080) return 'Week'
  return l.label
}

/** Each enabled provider's plan limits, as its sessions last reported them: one item per provider. */
function PlanUsageStatus() {
  const all = useStore((s) => s.planUsage)
  const settings = useStore((s) => s.settings)
  useNow(60000)
  return (
    <>
      {enabledProviders(settings).map((p) => {
        const usage = all[p.id]
        if (!usage?.limits.length) return null
        const worst = Math.max(...usage.limits.map((l) => l.usedPercent))
        const lines = usage.limits.map((l) => `${l.label} limit: ${Math.round(l.usedPercent)}% used${l.resetsAt ? `, resets ${resetsIn(l.resetsAt)}` : ''}`)
        const tip = [`${p.name}${usage.plan ? ` (${usage.plan} plan)` : ''}`, ...lines, `As of ${timeAgo(usage.updatedAt)}. Updates while a session is running.`].join('\n')
        return (
          <Tooltip key={p.id} content={<span style={{ whiteSpace: 'pre-line' }}>{tip}</span>}>
            <div className={cx('status-item', worst >= 95 ? 'warn' : worst >= 80 && 'caution')} onClick={() => runCommand('project.tab.overview')}>
              <ProviderIcon provider={p.id} mono />
              {usage.limits.map((l, i) => (
                <span key={l.id}>
                  {i > 0 && <span className="status-sep">·</span>}
                  {shortLimit(l)} {Math.round(l.usedPercent)}%
                </span>
              ))}
            </div>
          </Tooltip>
        )
      })}
    </>
  )
}

/** One item per enabled provider: its CLI version, or what it still needs (install, sign-in, setup). */
function ProviderStatusItems() {
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  return (
    <>
      {enabledProviders(settings).map((p) => {
        const info = providers[p.id]
        if (!info || info.checking) {
          return (
            <div key={p.id} className="status-item">
              <Icon name="loading" spin /> {p.name}
            </div>
          )
        }
        const blocking = info.readiness?.find((r) => r.level === 'error')
        if (!info.found || blocking) {
          return (
            <Tooltip key={p.id} content={blocking?.message ?? `${p.name} is not installed.`}>
              <div className="status-item warn" onClick={() => set({ setupOpen: p.id })}>
                <Icon name="warning" /> {p.name}
              </div>
            </Tooltip>
          )
        }
        const warning = info.readiness?.find((r) => r.level === 'warning')
        const tip = `${p.name} ${info.version} (${info.source})${warning ? ` — ${warning.message}` : ''}${info.updateAvailable ? ` — ${info.latestVersion} available` : ''}`
        return (
          <Tooltip key={p.id} content={tip}>
            <div className={cx('status-item', warning && 'caution')} onClick={() => set({ setupOpen: p.id })}>
              <ProviderIcon provider={p.id} mono /> {info.version}
              {(info.updateAvailable || warning) && <Icon name={warning ? 'warning' : 'cloud-download'} />}
            </div>
          </Tooltip>
        )
      })}
    </>
  )
}

export { formatKeybinding }
