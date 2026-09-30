import { useEffect, useRef } from 'react'
import type { HiveEvent } from '@shared/types'
import { call } from './api'
import { playChime } from './chime'
import { matchKeybinding, runCommand } from './commands'
import { AboutDialog, AgentSetupDialog, CommandPalette, CompactDialog, Dialogs, NotificationCenter, ProvidersBanner, QuitDialog, QuitPendingBanner, ShortcutsDialog, Toasts } from './components/Overlays'
import { AddAgentDialog, AgentSettingsDialog, ContinueDialog, MergeDialog } from './components/AgentDialogs'
import { UpdateDialog } from './components/Updates'
import { ModeMenuHost } from './components/PermissionMode'
import { ActivityBar, StatusBar } from './components/Shell'
import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { isProviderEnabled } from '@shared/providers'
import { applyLiveState, filesListeners, get, projectKey, projectState, pushToast, set, useStore } from './store'
import { DocsView, McpView, NotesView, SkillView, WelcomeView } from './views/OtherViews'
import { ProjectView } from './views/ProjectView'
import { SettingsView } from './views/SettingsView'
import { ErrorBoundary } from './components/ErrorBoundary'

function applyTheme(): void {
  const s = get().settings
  if (!s) return
  const t = s.appearance.theme === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : s.appearance.theme
  document.documentElement.dataset.theme = t
  document.documentElement.style.setProperty('--ui-font-size', `${s.appearance.uiFontSize}px`)
  void call('window:setTitleBarColors', t === 'dark' ? '#1f1f1f' : '#f3f3f3', t === 'dark' ? '#cccccc' : '#333333')
}

const noticedMcp = new Set<string>()

function noticeUnmanagedMcp(): void {
  for (const p of get().workspace?.projects ?? []) {
    if (!p.unmanagedMcp.length || noticedMcp.has(p.path)) continue
    noticedMcp.add(p.path)
    pushToast({
      id: `mcp-${p.path}`,
      level: 'warning',
      title: `${p.name}: MCP servers not in the workspace`,
      message: `${p.unmanagedMcp.join(', ')} ${p.unmanagedMcp.length === 1 ? 'is' : 'are'} defined in the project's .mcp.json and will stay disabled until copied to the workspace.`,
      actions: [{ label: 'Copy to workspace', command: 'mcp.import', args: [p.path, p.unmanagedMcp] }],
      timestamp: new Date().toISOString()
    })
  }
}

function handleEvent(e: HiveEvent): void {
  switch (e.type) {
    case 'workspace-changed': {
      const sel = get().selectedProject
      const ws = e.workspace
      // Drop warnings about projects that belong to a workspace that is no longer open.
      set((s) => ({ workspace: ws, toasts: s.toasts.filter((t) => !t.id.startsWith('mcp-') || !!ws?.projects.some((p) => t.id === `mcp-${p.path}`)) }))
      if (ws && (!sel || !ws.projects.some((p) => p.path === sel))) set({ selectedProject: (ws.projects.find((p) => p.active) ?? ws.projects[0])?.path ?? null })
      if (!ws) set({ selectedProject: null })
      noticeUnmanagedMcp()
      break
    }
    case 'session-status': {
      const path = get().workspace?.projects.find((p) => p.path.toLowerCase() === e.state.projectPath.toLowerCase())?.path ?? e.state.projectPath
      // A new session (or its worktree setup) gets a fresh terminal. The setup command and Claude Code share one.
      const key = projectKey(path, e.state.agentId)
      const prev = get().workspace?.projects.find((p) => p.path === path)?.agents.find((a) => a.id === e.state.agentId)?.live
      if (e.state.status === 'starting' && !prev?.settingUp) set((s) => ({ sessionEpoch: { ...s.sessionEpoch, [key]: (s.sessionEpoch[key] ?? 0) + 1 } }))
      applyLiveState(e.state)
      // Viewing the project that just finished counts as seeing it.
      if (e.state.unseen && get().selectedProject === path && get().windowFocused && get().activity === 'projects') void call('session:markSeen', path)
      break
    }
    case 'session-exit':
      set((s) => ({ usageVersion: { ...s.usageVersion, [e.projectPath]: (s.usageVersion[e.projectPath] ?? 0) + 1 } }))
      break
    case 'usage-changed': {
      const path = get().workspace?.projects.find((p) => p.path.toLowerCase() === e.projectPath.toLowerCase())?.path ?? e.projectPath
      set((s) => ({ usageVersion: { ...s.usageVersion, [path]: (s.usageVersion[path] ?? 0) + 1 } }))
      break
    }
    case 'toast':
      pushToast(e.toast)
      break
    case 'chime': {
      const n = get().settings?.notifications
      if (n) playChime(n.chimeSound, n.chimeVolume)
      break
    }
    case 'settings-changed':
      set({ settings: e.settings })
      applyTheme()
      setTimeout(() => void call('api:info').then((api) => set({ api })), 400)
      break
    case 'provider-install':
      set((st) => ({ providers: { ...st.providers, [e.provider]: e.info } }))
      break
    case 'menu-command':
      runCommand(e.command, ...(e.args ?? []))
      break
    case 'quit-request':
      set({ quitRequest: e.sessions, quitUnsaved: e.unsaved, quitScope: e.scope ?? 'app' })
      break
    case 'quit-pending':
      set({ quitPending: e.pending ? { working: e.working } : null })
      break
    case 'files-changed':
      filesListeners.forEach((l) => l(e.projectPath, e.dirs))
      break
    case 'plan-usage':
      set((st) => ({ planUsage: { ...st.planUsage, [e.provider]: e.usage } }))
      break
    case 'update-state':
      set({ update: e.state })
      break
    case 'notes-changed':
      set((s) => ({ notesVersion: s.notesVersion + 1 }))
      break
    case 'skills-changed':
      set((s) => ({ skillsVersion: s.skillsVersion + 1 }))
      break
    case 'window-state':
      set({ maximized: e.maximized, windowFocused: e.focused })
      if (e.focused) {
        const sel = get().selectedProject
        const p = get().workspace?.projects.find((x) => x.path === sel)
        if (projectState(p)?.unseen && get().activity === 'projects') void call('session:markSeen', p!.path)
      }
      break
  }
}

export function App() {
  const workspace = useStore((s) => s.workspace)
  const activity = useStore((s) => s.activity)
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const selected = useStore((s) => s.selectedProject)
  const sidebarVisible = useStore((s) => s.sidebarVisible)
  const sidebarCompact = useStore((s) => s.sidebarCompact)
  const setupShown = useRef(false)

  useEffect(() => {
    const off = window.hive.onEvent(handleEvent)
    void (async () => {
      const [s, ui, ws, recent, ag, api, info, live] = await Promise.all([
        call('settings:get'),
        call('ui:get'),
        call('workspace:get'),
        call('workspace:recent'),
        call('provider:info'),
        call('api:info'),
        call('app:info'),
        call('session:live')
      ])
      set({ settings: s, sidebarWidth: ui.sidebarWidth, sidebarVisible: ui.sidebarVisible, sidebarCompact: !!ui.sidebarCompact, panes: ui.panes ?? {}, workspace: ws, recent, providers: ag, api, appInfo: info })
      if (ws) set({ selectedProject: (ws.projects.find((p) => p.active) ?? ws.projects[0])?.path ?? null })
      for (const l of live) applyLiveState(l)
      // A reloaded window picks up a quit dialog or pending quit that was already in progress.
      set({ planUsage: await call('app:planUsage'), update: await call('update:state') })
      const q = await call('app:quitState')
      set({ quitRequest: q.request, quitUnsaved: q.unsaved, quitScope: q.scope, quitPending: q.pending ? { working: q.working } : null })
      applyTheme()
      noticeUnmanagedMcp()
    })()
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', applyTheme)
    return () => {
      off()
      mq.removeEventListener('change', applyTheme)
    }
  }, [])

  // An enabled provider that isn't installed: offer its setup once detection has finished.
  useEffect(() => {
    if (setupShown.current || !settings) return
    const missing = Object.values(providers).find((p) => isProviderEnabled(settings, p.provider) && !p.checking && !p.found)
    if (missing) {
      setupShown.current = true
      set({ setupOpen: missing.provider })
    }
  }, [providers, settings])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (get().dialog || get().paletteOpen || get().recordingKeys) return
      const cmd = matchKeybinding(e)
      if (!cmd) return
      e.preventDefault()
      e.stopPropagation()
      runCommand(cmd.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (selected && activity === 'projects') void call('session:markSeen', selected)
  }, [selected, activity])

  useEffect(() => {
    void call('ui:set', { sidebarVisible })
  }, [sidebarVisible])

  useEffect(() => {
    void call('ui:set', { sidebarCompact })
  }, [sidebarCompact])

  if (!settings) return <div className="app" />

  const main = (() => {
    switch (activity) {
      case 'settings':
        return <SettingsView />
      case 'docs':
        return <DocsView />
      case 'notes':
        return <NotesView />
      case 'skills':
        return <SkillView />
      case 'mcp':
        return <McpView />
      default:
        return workspace ? null : <WelcomeView />
    }
  })()

  return (
    <div className="app">
      <TitleBar />
      <div className="workbench">
        <ActivityBar />
        <Sidebar />
        <div className="main-area">
          <QuitPendingBanner />
          <ProvidersBanner />
          {workspace && <ProjectView visible={activity === 'projects'} />}
          {main && (
            <div className="tab-body">
              <ErrorBoundary label="This view" resetKey={activity}>
                {main}
              </ErrorBoundary>
            </div>
          )}
        </div>
      </div>
      <StatusBar />
      <Toasts />
      <NotificationCenter />
      <CommandPalette />
      <Dialogs />
      <QuitDialog />
      <CompactDialog />
      <AddAgentDialog />
      <AgentSettingsDialog />
      <MergeDialog />
      <ContinueDialog />
      <AboutDialog />
      <UpdateDialog />
      <ModeMenuHost />
      <ShortcutsDialog />
      <AgentSetupDialog />
    </div>
  )
}
