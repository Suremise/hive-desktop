import { agentLaunchSettings, modeOption, offeredModes, permissionLabel, projectProviderConfig, providerDescriptor, providerSettings } from '@shared/providers'
import type { AgentInfo, AppSettings, PermissionMode, ProjectInfo, ProviderId } from '@shared/types'
import * as actions from '../actions'
import { call } from '../api'
import { commandKeybinding } from '../commands'
import { agentProviderOf, confirm, notify, set, useStore } from '../store'
import { cx, formatKeybinding } from '../util'
import { ContextMenu, Icon, Tooltip, type MenuEntry } from './ui'

/** The mode an agent's next session starts in: its own setting, else the project's, else the global default. */
export function configuredMode(project: ProjectInfo, a: AgentInfo | null | undefined, settings: AppSettings | null): PermissionMode {
  if (!settings) return providerDescriptor(agentProviderOf(project, a)).defaultPermissionMode
  return agentLaunchSettings(a ?? project.agents[0], project.config, settings).permissionMode
}

/** What the agent is in now if it runs (as its CLI reports it), else what it will start in. */
export function currentMode(project: ProjectInfo, a: AgentInfo | null | undefined, settings: AppSettings | null): PermissionMode {
  return a?.live?.permissionMode ?? configuredMode(project, a, settings)
}

/** Opens the permission mode menu for an agent, under an element (or at the window's centre). */
export function openModeMenu(projectPath: string, agentId: string, anchor?: Element | null): void {
  const r = anchor?.getBoundingClientRect()
  set({ modeMenu: { project: projectPath, agentId, x: r ? r.left : window.innerWidth / 2 - 150, y: r ? r.bottom + 4 : 120 } })
}

/** Confirms choosing a provider's no-guardrails mode (Claude Code's Bypass, Codex's Full Access). */
export async function confirmDangerousMode(provider: ProviderId, mode: PermissionMode, where: string): Promise<boolean> {
  const m = modeOption(provider, mode)
  if (!m?.danger) return true
  const name = providerDescriptor(provider).name
  return confirm({
    title: `Use ${m.label}?`,
    message: `${where} will run every command, edit and network call without asking.`,
    detail: `Only use this for disposable work where mistakes cannot do harm. ${name} may show its own warning the first time; answer it in the terminal.`,
    confirmLabel: `Use ${m.label}`,
    danger: true
  })
}

async function switchLive(project: ProjectInfo, a: AgentInfo, mode: PermissionMode): Promise<void> {
  const live = a.live!
  const p = live.provider
  const desc = providerDescriptor(p)
  const danger = !!modeOption(p, mode)?.danger
  if (!(await confirmDangerousMode(p, mode, a.name))) return
  if (desc.capabilities.liveModeSwitch !== 'none' && desc.canSwitchLive(mode, live.permissionMode, null) && !danger) {
    const r = await actions.attempt('Could not switch the permission mode', () => call('session:setMode', project.path, a.id, mode))
    if (!r || r.ok) return
    if (!r.restart) return notify('warning', 'Permission mode not switched', r.message)
  }
  const working = live.status === 'working'
  const label = permissionLabel(p, mode)
  const ok = await confirm({
    title: `Restart in ${label}?`,
    message: `${label} can't be switched to inside a running session, so ${project.agents.length > 1 ? a.name : 'the session'} restarts in it. The conversation continues where it left off.`,
    detail: working ? 'The agent is working and will be interrupted.' : undefined,
    confirmLabel: 'Restart'
  })
  if (!ok) return
  await actions.attempt('Could not restart the session', () => call('session:restartInMode', project.path, a.id, mode))
}

async function setForNewSessions(project: ProjectInfo, a: AgentInfo, provider: ProviderId, mode: PermissionMode | 'inherit'): Promise<void> {
  if (mode !== 'inherit' && !(await confirmDangerousMode(provider, mode, `New sessions of ${a.permissionMode ? a.name : project.name}`))) return
  if (a.permissionMode) {
    await actions.attempt('Could not save', () => call('agents:update', project.path, a.id, { permissionMode: mode === 'inherit' ? undefined : mode }))
    await actions.refreshWorkspace()
  } else await actions.updateProjectProvider(project.path, provider, { permissionMode: mode })
}

function menuItems(project: ProjectInfo, a: AgentInfo, settings: AppSettings): MenuEntry[] {
  const provider = agentProviderOf(project, a)
  const desc = providerDescriptor(provider)
  const modes = offeredModes(provider, settings)
  const many = project.agents.length > 1
  const live = a.live
  if (live && !live.settingUp) {
    const cur = live.permissionMode
    const asking = live.status === 'waiting'
    return [
      { header: true, label: `Permission mode${many ? ` — ${a.name}` : ''}` },
      ...(asking ? [{ label: 'The agent is asking you something: answer it first', icon: 'warning', disabled: true }] : []),
      ...modes.map((m): MenuEntry => {
        const liveOk = desc.capabilities.liveModeSwitch !== 'none' && desc.canSwitchLive(m.value, cur, null) && !m.danger
        return {
          label: m.label,
          icon: m.value === cur ? 'check' : 'blank',
          detail: m.value === cur ? 'Current mode' : liveOk ? m.description : 'Restarts the session; the conversation continues',
          disabled: m.value === cur || (asking && liveOk),
          onClick: () => void switchLive(project, a, m.value)
        }
      }),
      ...(desc.capabilities.planModeToggle
        ? [
            { separator: true } as MenuEntry,
            {
              label: 'Plan mode',
              icon: live.planMode ? 'check' : 'blank',
              detail: live.planMode ? 'On: the agent plans and asks before changing anything. Click to turn off.' : 'Plan first: the agent explores and proposes a plan without changing anything.',
              disabled: asking,
              onClick: () => void actions.attempt('Could not switch Plan mode', () => call('session:setPlanMode', project.path, a.id, !live.planMode))
            } as MenuEntry
          ]
        : []),
      { separator: true },
      { label: 'Switches this session only. Settings decide the mode new sessions start in.', disabled: true }
    ]
  }
  const configured = configuredMode(project, a, settings)
  const own = !!a.permissionMode
  const projectMode = projectProviderConfig(project.config, provider).permissionMode
  const projectShown = projectMode === 'inherit' ? providerSettings(settings, provider).defaultPermissionMode : projectMode
  const inheritLabel = own ? `Use the project's (${permissionLabel(provider, projectShown)})` : `Inherit (Settings: ${permissionLabel(provider, providerSettings(settings, provider).defaultPermissionMode)})`
  const isInherit = own ? false : projectMode === 'inherit'
  return [
    { header: true, label: own ? `${a.name}: mode for new sessions` : `${project.name}: ${desc.name} mode for new sessions` },
    { label: inheritLabel, icon: isInherit ? 'check' : 'blank', onClick: () => void setForNewSessions(project, a, provider, 'inherit') },
    ...modes.map((m): MenuEntry => ({
      label: m.label,
      icon: !isInherit && m.value === configured ? 'check' : 'blank',
      detail: m.description,
      onClick: () => void setForNewSessions(project, a, provider, m.value)
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
  const provider = agentProviderOf(project, a)
  const mode = currentMode(project, a, settings)
  const bypass = !!modeOption(provider, mode)?.danger
  const label = a.live?.modeSwitching ? `Switching to ${permissionLabel(provider, a.live.modeSwitching)}…` : `${permissionLabel(provider, mode)}${a.live?.planMode ? ' · Plan' : ''}`
  const kb = commandKeybinding('session.permissionMode')
  const cycles = providerDescriptor(provider).capabilities.liveModeSwitch === 'cycle'
  const tip = `${a.live ? 'Permission mode of the running session' : 'Permission mode new sessions start in'}: ${label}. Click to change${kb ? ` (${formatKeybinding(kb)})` : ''}.${a.live && cycles ? ' You can also press Shift+Tab in the terminal.' : ''}${a.live && providerDescriptor(provider).capabilities.planModeToggle ? ' Shift+Tab in the terminal turns Plan mode on and off.' : ''}`
  const open = (e: React.MouseEvent): void => {
    e.stopPropagation()
    openModeMenu(project.path, a.id, e.currentTarget)
  }
  const icon = bypass ? 'warning' : mode === 'plan' ? 'debug-pause' : mode === 'auto' ? 'sparkle' : 'shield'
  if (variant === 'status') {
    return (
      <Tooltip content={tip}>
        <div className={cx('status-item', bypass && 'warn')} onClick={open}>
          <Icon name={icon} /> {label}
        </div>
      </Tooltip>
    )
  }
  return (
    <Tooltip content={tip}>
      <button type="button" className={cx('mode-badge', variant === 'header' ? 'badge' : 'mode-chip', bypass && 'error', a.live && 'live')} onClick={open}>
        <Icon name={icon} /> {label}
        <Icon name="chevron-down" className="mode-caret" />
      </button>
    </Tooltip>
  )
}

