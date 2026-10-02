import { useEffect, useRef } from 'react'
import type { HiveEvent } from '@shared/types'
import { call } from './api'
import { playChime } from './chime'
import { matchKeybinding, runCommand } from './commands'
import { AboutDialog, AgentSetupDialog, CommandPalette, CompactDialog, Dialogs, NotificationCenter, ProvidersBanner, QuitDialog, QuitPendingBanner, ShortcutsDialog, Toasts } from './components/Overlays'
import { AddAgentDialog, AgentSettingsDialog, HandOverDialog, MergeDialog } from './components/AgentDialogs'
import { BoardView, TaskDialog, TaskStartDialog } from './components/Board'
import { WorkspaceOverviewView } from './views/WorkspaceOverview'
import { RemoveProjectDialog } from './components/ProjectRemoval'
import { UpdateDialog } from './components/Updates'
import { ModeMenuHost } from './components/PermissionMode'
import { ActivityBar, StatusBar } from './components/Shell'
import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { isProviderEnabled } from '@shared/providers'
import { tipsState } from '@shared/tips'
import { TipCard, TipsDialog } from './components/Tips'
import { showTodaysTip } from './tips'
import { AssistantPanel, AssistantSettingsDialog } from './components/Assistant'
import { AssistantMain } from './components/AssistantView'
import { agentOnScreen, applyLiveState, assistantWasOpen, clearStartFailure, filesListeners, findProject, get, loadTasks, noteAgentAdded, notify, projectKey, projectState, pushToast, set, useStore } from './store'
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
      // Another workspace in this window: its Assistant panel shows as that workspace left it, and its board.
      const other = ws?.path !== get().workspace?.path
      if (other) set({ assistantOpen: assistantWasOpen(ws?.path), tasks: [], boardProject: null, taskOpen: null, taskStartFor: null })
      // Drop warnings about projects that belong to a workspace that is no longer open.
      set((s) => ({ workspace: ws, toasts: s.toasts.filter((t) => !t.id.startsWith('mcp-') || !!ws?.projects.some((p) => t.id === `mcp-${p.path}`)) }))
      if (ws && (!sel || !ws.projects.some((p) => p.path === sel))) set({ selectedProject: (ws.projects.find((p) => p.active) ?? ws.projects[0])?.path ?? null })
      if (!ws) set({ selectedProject: null })
      if (other) void loadTasks()
      noticeUnmanagedMcp()
      break
    }
    case 'session-status': {
      const path = findProject(get(), e.state.projectPath)?.path ?? e.state.projectPath
      // A new session (or its worktree setup) gets a fresh terminal. The setup command and Claude Code share one.
      const key = projectKey(path, e.state.agentId)
      const prev = findProject(get(), path)?.agents.find((a) => a.id === e.state.agentId)?.live
      if (e.state.status === 'starting' && !prev?.settingUp) set((s) => ({ sessionEpoch: { ...s.sessionEpoch, [key]: (s.sessionEpoch[key] ?? 0) + 1 } }))
      // A new launch: the last one's failure no longer applies.
      if (e.state.status === 'starting') clearStartFailure(path, e.state.agentId)
      applyLiveState(e.state)
      // Viewing the project that just finished counts as seeing it.
      if (e.state.unseen && get().selectedProject === path && get().windowFocused && get().activity === 'projects') void call('session:markSeen', path)
      break
    }
    case 'session-exit': {
      set((s) => ({ usageVersion: { ...s.usageVersion, [e.projectPath]: (s.usageVersion[e.projectPath] ?? 0) + 1 } }))
      if (!e.failure) break
      const p = findProject(get(), e.projectPath)
      const path = p?.path ?? e.projectPath
      const failure = e.failure
      set((s) => ({ startFailures: { ...s.startFailures, [projectKey(path, e.agentId)]: failure } }))
      // Its pane says why; a toast only when the pane isn't on screen.
      const name = p?.agents.find((a) => a.id === e.agentId)?.name ?? 'An agent'
      const shown = get().workspace?.projects.some((x) => x.path === path)
      if (!agentOnScreen(path, e.agentId))
        pushToast({
          id: `start-failed-${projectKey(path, e.agentId)}`,
          level: 'error',
          title: `${p ? `${p.name} · ` : ''}${name} couldn't start`,
          message: failure.hint ?? failure.reason,
          actions: shown ? [{ label: 'Show', command: 'agent.show', args: [path, e.agentId] }] : undefined,
          timestamp: failure.at
        })
      break
    }
    case 'usage-changed': {
      const path = findProject(get(), e.projectPath)?.path ?? e.projectPath
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
    case 'tasks-changed':
      if (e.workspacePath.toLowerCase() === get().workspace?.path.toLowerCase()) scheduleTasksLoad()
      break
    case 'skills-changed':
      set((s) => ({ skillsVersion: s.skillsVersion + 1 }))
      break
    case 'personas-changed':
      set((s) => ({ personasVersion: s.personasVersion + 1 }))
      break
    case 'assistant-activity':
      set((s) => ({ assistantActions: [...s.assistantActions, e.action].slice(-200) }))
      break
    case 'assistant-questions': {
      const before = get().assistantQuestions
      set({ assistantQuestions: e.questions })
      // With the panel hidden, the question comes as a notification the user can answer.
      if (!get().assistantOpen) {
        for (const q of e.questions.filter((x) => !before.some((b) => b.id === x.id))) {
          notify('warning', q.title, q.message, [
            { label: q.yes, command: 'assistant.answer', args: [q.id, true] },
            { label: q.no, command: 'assistant.answer', args: [q.id, false] }
          ])
        }
      }
      break
    }
    case 'agent-added':
      noteAgentAdded(e.projectPath, e.agentId)
      break
    case 'branch-status':
      set((st) => ({ branchStatus: { ...st.branchStatus, [projectKey(e.projectPath, e.agentId)]: e.status } }))
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

let tasksTimer: number | undefined
/** Reads the board again shortly (one change can come as several events: Hive's own and the folder watcher's). */
function scheduleTasksLoad(): void {
  window.clearTimeout(tasksTimer)
  tasksTimer = window.setTimeout(() => void loadTasks(), 120)
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
      set({ settings: s, sidebarWidth: ui.sidebarWidth, sidebarVisible: ui.sidebarVisible, sidebarCompact: !!ui.sidebarCompact, panes: ui.panes ?? {}, tips: tipsState(ui.tips), workspace: ws, recent, providers: ag, api, appInfo: info })
      set({ assistantOpen: assistantWasOpen(ws?.path) })
      if (ws) set({ selectedProject: (ws.projects.find((p) => p.active) ?? ws.projects[0])?.path ?? null })
      for (const l of live) applyLiveState(l)
      void loadTasks()
      void call('agents:branchStatuses').then((list) =>
        set((st) => ({ branchStatus: { ...Object.fromEntries(list.map((b) => [projectKey(b.projectPath, b.agentId), b.status])), ...st.branchStatus } }))
      )
      // A reloaded window picks up a quit dialog or pending quit that was already in progress.
      set({ planUsage: await call('app:planUsage'), update: await call('update:state') })
      const q = await call('app:quitState')
      set({ quitRequest: q.request, quitUnsaved: q.unsaved, quitScope: q.scope, quitPending: q.pending ? { working: q.working } : null })
      applyTheme()
      noticeUnmanagedMcp()
      // The day's tip, once the window has settled.
      setTimeout(showTodaysTip, 4000)
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
      case 'assistant':
        return <AssistantMain />
      case 'board':
        return <BoardView />
      case 'overview':
        return <WorkspaceOverviewView />
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
        {workspace && (
          <ErrorBoundary label="The Assistant">
            <AssistantPanel />
          </ErrorBoundary>
        )}
      </div>
      <StatusBar />
      <TipCard />
      <Toasts />
      <NotificationCenter />
      <CommandPalette />
      <QuitDialog />
      <CompactDialog />
      <AddAgentDialog />
      <AgentSettingsDialog />
      <AssistantSettingsDialog />
      <MergeDialog />
      <HandOverDialog />
      <TaskDialog />
      <TaskStartDialog />
      <RemoveProjectDialog />
      <AboutDialog />
      <UpdateDialog />
      <ModeMenuHost />
      <ShortcutsDialog />
      <TipsDialog />
      <AgentSetupDialog />
      {/* Last: its questions (confirm, choose, prompt) are often asked from another dialog, so they go on top. */}
      <Dialogs />
    </div>
  )
}
