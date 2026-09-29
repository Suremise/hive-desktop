import { PERMISSION_MODES, canSwitchLive, permissionLabel } from '@shared/defaults'
import type { AgentInfo, AppSettings, PermissionMode, ProjectInfo } from '@shared/types'
import * as actions from '../actions'
import { call } from '../api'
import { commandKeybinding } from '../commands'
import { confirm, notify, set, useStore } from '../store'
import { cx, formatKeybinding } from '../util'
import { ContextMenu, Icon, Tooltip, type MenuEntry } from './ui'

/** The mode an agent's next session starts in: its own setting, else the project's, else the global default. */
export function configuredMode(project: ProjectInfo, a: AgentInfo | null | undefined, settings: AppSettings | null): PermissionMode {
  const fallback = settings?.claude.defaultPermissionMode ?? 'auto'
  let m: PermissionMode = a?.permissionMode ?? (project.config.permissionMode !== 'inherit' ? project.config.permissionMode : fallback)
  if (m === 'bypassPermissions' && !settings?.claude.enableBypassOption) m = fallback
  return m
}

/** What the agent is in now if it runs (as Claude Code reports it), else what it will start in. */
export function currentMode(project: ProjectInfo, a: AgentInfo | null | undefined, settings: AppSettings | null): PermissionMode {
  return a?.live?.permissionMode ?? configuredMode(project, a, settings)
}

/** Opens the permission mode menu for an agent, under an element (or at the window's centre). */
export function openModeMenu(projectPath: string, agentId: string, anchor?: Element | null): void {
  const r = anchor?.getBoundingClientRect()
  set({ modeMenu: { project: projectPath, agentId, x: r ? r.left : window.innerWidth / 2 - 150, y: r ? r.bottom + 4 : 120 } })
}

async function confirmBypass(where: string): Promise<boolean> {
  return confirm({
    title: 'Use bypass permissions?',
    message: `${where} will run every command, edit and network call without asking.`,
    detail: 'Only use this for disposable work where mistakes cannot do harm. Claude Code shows its own warning the first time; answer it in the terminal.',
    confirmLabel: 'Use bypass',
    danger: true
  })
}

async function switchLive(project: ProjectInfo, a: AgentInfo, mode: PermissionMode): Promise<void> {
  const live = a.live!
  if (mode === 'bypassPermissions' && !(await confirmBypass(a.name))) return
  if (canSwitchLive(mode, live.permissionMode, null) && mode !== 'bypassPermissions') {
    const r = await actions.attempt('Could not switch the permission mode', () => call('session:setMode', project.path, a.id, mode))
    if (!r || r.ok) return
    if (!r.restart) return notify('warning', 'Permission mode not switched', r.message)
  }
  const working = live.status === 'working'
  const ok = await confirm({
    title: `Restart in ${permissionLabel(mode)}?`,
    message: `${permissionLabel(mode)} can't be switched to inside a running session, so ${project.agents.length > 1 ? a.name : 'the session'} restarts in it. The conversation continues where it left off.`,
    detail: working ? 'The agent is working and will be interrupted.' : undefined,
    confirmLabel: 'Restart'
  })
  if (!ok) return
  await actions.attempt('Could not restart the session', () => call('session:restartInMode', project.path, a.id, mode))
}

async function setForNewSessions(project: ProjectInfo, a: AgentInfo, mode: PermissionMode | 'inherit'): Promise<void> {
  if (mode === 'bypassPermissions' && !(await confirmBypass(`New sessions of ${a.permissionMode ? a.name : project.name}`))) return
  if (a.permissionMode) await actions.attempt('Could not save', () => call('agents:update', project.path, a.id, { permissionMode: mode === 'inherit' ? undefined : mode }))
  else await actions.attempt('Could not save', () => call('project:updateConfig', project.path, { permissionMode: mode }))
  await actions.refreshWorkspace()
}

function menuItems(project: ProjectInfo, a: AgentInfo, settings: AppSettings): MenuEntry[] {
  const modes = PERMISSION_MODES.filter((m) => m.value !== 'bypassPermissions' || settings.claude.enableBypassOption)
  const many = project.agents.length > 1
  const live = a.live
  if (live && !live.settingUp) {
    const cur = live.permissionMode
    const asking = live.status === 'waiting'
    return [
      { header: true, label: `Permission mode${many ? ` — ${a.name}` : ''}` },
      ...(asking ? [{ label: 'The agent is asking you something: answer it first', icon: 'warning', disabled: true }] : []),
      ...modes.map((m): MenuEntry => {
        const liveOk = canSwitchLive(m.value, cur, null) && m.value !== 'bypassPermissions'
        return {
          label: m.label,
          icon: m.value === cur ? 'check' : 'blank',
          detail: m.value === cur ? 'Current mode' : liveOk ? m.description : 'Restarts the session; the conversation continues',
          disabled: m.value === cur || (asking && liveOk),
          onClick: () => void switchLive(project, a, m.value)
        }
      }),
      { separator: true },
      { label: 'Switches this session only. Settings decide the mode new sessions start in.', disabled: true }
    ]
  }
  const configured = configuredMode(project, a, settings)
  const own = !!a.permissionMode
  const inheritLabel = own ? `Use the project's (${permissionLabel(configuredMode(project, null, settings))})` : `Inherit (Settings: ${permissionLabel(settings.claude.defaultPermissionMode)})`
  const isInherit = own ? false : project.config.permissionMode === 'inherit'
  return [
    { header: true, label: own ? `${a.name}: mode for new sessions` : `${project.name}: mode for new sessions` },
    { label: inheritLabel, icon: isInherit ? 'check' : 'blank', onClick: () => void setForNewSessions(project, a, 'inherit') },
    ...modes.map((m): MenuEntry => ({
      label: m.label,
      icon: !isInherit && m.value === configured ? 'check' : 'blank',
      detail: m.description,
      onClick: () => void setForNewSessions(project, a, m.value)
    }))
  ]
}

/** Renders the menu opened by openModeMenu. Mounted once in App. */
export function ModeMenuHost() {
  const menu = useStore((s) => s.modeMenu)
  const project = useStore((s) => s.workspace?.projects.find((p) => p.path === s.modeMenu?.project) ?? null)
  const settings = useStore((s) => s.settings)
  if (!menu || !project || !settings) return null
  const a = project.agents.find((x) => x.id === menu.agentId)
  if (!a) return null
  return <ContextMenu x={menu.x} y={menu.y} items={menuItems(project, a, settings)} onClose={() => set({ modeMenu: null })} />
}

/** The permission mode as a clickable badge (project header), chip (pane header) or status bar item. */
export function ModeBadge({ project, a, variant }: { project: ProjectInfo; a: AgentInfo | null | undefined; variant: 'header' | 'pane' | 'status' }) {
  const settings = useStore((s) => s.settings)
  if (!a) return null
  const mode = currentMode(project, a, settings)
  const bypass = mode === 'bypassPermissions'
  const kb = commandKeybinding('session.permissionMode')
  const tip = `${a.live ? 'Permission mode of the running session' : 'Permission mode new sessions start in'}: ${permissionLabel(mode)}. Click to change${kb ? ` (${formatKeybinding(kb)})` : ''}.${a.live ? ' You can also press Shift+Tab in the terminal.' : ''}`
  const open = (e: React.MouseEvent): void => {
    e.stopPropagation()
    openModeMenu(project.path, a.id, e.currentTarget)
  }
  const icon = bypass ? 'warning' : mode === 'plan' ? 'debug-pause' : mode === 'auto' ? 'sparkle' : 'shield'
  if (variant === 'status') {
    return (
      <Tooltip content={tip}>
        <div className={cx('status-item', bypass && 'warn')} onClick={open}>
          <Icon name={icon} /> {permissionLabel(mode)}
        </div>
      </Tooltip>
    )
  }
  return (
    <Tooltip content={tip}>
      <button type="button" className={cx('mode-badge', variant === 'header' ? 'badge' : 'mode-chip', bypass && 'error', a.live && 'live')} onClick={open}>
        <Icon name={icon} /> {permissionLabel(mode)}
        <Icon name="chevron-down" className="mode-caret" />
      </button>
    </Tooltip>
  )
}

