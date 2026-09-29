import { useCallback, useEffect, useRef, useState } from 'react'
import type { McpServerInfo, NoteFile, ProjectInfo, SkillInfo } from '@shared/types'
import * as actions from '../actions'
import { call } from '../api'
import { commandKeybinding, runCommand } from '../commands'
import { confirm, get, notify, projectState, prompt, set, setProjectTab, toggleCompactSidebar, useStore } from '../store'
import { cx, formatKeybinding } from '../util'
import { Icon, IconButton, InfoTip, StatusDot, STATUS_TEXT, Switch, Tooltip, useContextMenu, type MenuEntry } from './ui'

/** Width of the compact Projects rail, and how narrow a drag has to go before the sidebar snaps to it. */
const RAIL_WIDTH = 48
const SNAP_WIDTH = 120

export function Sidebar() {
  const activity = useStore((s) => s.activity)
  const visible = useStore((s) => s.sidebarVisible)
  const width = useStore((s) => s.sidebarWidth)
  const compactSetting = useStore((s) => s.sidebarCompact)
  const last = useStore((s) => s.lastSideActivity)
  const [dragging, setDragging] = useState(false)
  if (!visible) return null
  const view = activity === 'docs' || activity === 'settings' ? last : activity
  // Only the Projects list has a compact form; the other panels always show at full width.
  const compact = compactSetting && view === 'projects'

  const startDrag = (e: React.MouseEvent): void => {
    e.preventDefault()
    setDragging(true)
    const startX = e.clientX
    const startW = compact ? RAIL_WIDTH : width
    const move = (ev: MouseEvent): void => {
      const w = startW + ev.clientX - startX
      // In the Projects view, dragging narrow snaps to the rail and dragging out again restores the list.
      // Snapping keeps the width from before the drag, so expanding again restores it.
      if (view === 'projects' && w < SNAP_WIDTH) set({ sidebarCompact: true, sidebarWidth: width })
      else set({ sidebarCompact: false, sidebarWidth: Math.max(200, Math.min(600, w)) })
    }
    const up = (): void => {
      setDragging(false)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      void call('ui:set', { sidebarWidth: get().sidebarWidth })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div className={cx('sidebar', compact && 'compact')} style={{ width: compact ? RAIL_WIDTH : width }}>
      {view === 'projects' && (compact ? <ProjectsRail /> : <ProjectsPanel />)}
      {view === 'notes' && <NotesPanel />}
      {view === 'skills' && <SkillsPanel />}
      {view === 'mcp' && <McpPanel />}
      <div className={cx('sidebar-resizer', dragging && 'dragging')} onMouseDown={startDrag} onDoubleClick={() => {
          set({ sidebarWidth: 280, sidebarCompact: false })
          void call('ui:set', { sidebarWidth: 280 })
        }} />
    </div>
  )
}

function NoWorkspace({ what }: { what: string }) {
  return (
    <div className="pane-empty">
      Open a workspace to see its {what}.
      <button className="btn primary" onClick={() => runCommand('workspace.open')}>
        <Icon name="folder-opened" /> Open Workspace
      </button>
      <button className="btn subtle" onClick={() => runCommand('workspace.create')}>
        <Icon name="new-folder" /> New Workspace
      </button>
    </div>
  )
}

function Section({ title, count, children, defaultOpen = true, tip }: { title: string; count?: number; children: React.ReactNode; defaultOpen?: boolean; tip?: string }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <>
      <div className="section-header" onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        {title}
        {tip && (
          <span onClick={(e) => e.stopPropagation()}>
            <InfoTip text={tip} />
          </span>
        )}
        {count !== undefined && <span className="count">{count}</span>}
      </div>
      {open && children}
    </>
  )
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

function compactTip(): string {
  const kb = commandKeybinding('view.compactSidebar')
  return kb ? ` (${formatKeybinding(kb)})` : ''
}

/** Right-click menu for a project, shared by the full list and the compact rail. */
function projectMenu(p: ProjectInfo): MenuEntry[] {
  const running = p.agents.filter((a) => a.live).length
  return [
    { label: 'New Session', icon: 'add', onClick: () => void actions.newSession(p.path) },
    { label: 'Resume Last Session', icon: 'debug-continue', onClick: () => void actions.resumeLast(p.path) },
    running > 1
      ? { label: 'Stop All Agents', icon: 'debug-stop', onClick: () => void actions.stopAllAgents(p.path) }
      : { label: 'Stop Session', icon: 'debug-stop', disabled: !running, onClick: () => void actions.stopSession(p.path, p.agents.find((a) => a.live)?.id) },
    { label: 'Add Agent…', icon: 'person-add', onClick: () => set({ addAgentFor: p.path }) },
    { separator: true },
    { label: p.active ? 'Mark as Not Working On' : 'Mark as Working On', icon: p.active ? 'circle-slash' : 'pass', onClick: () => void actions.setProjectActive(p.path, !p.active) },
    { separator: true },
    { label: 'Reveal in File Explorer', icon: 'folder-opened', onClick: () => void call('project:openInExplorer', p.path) },
    { label: 'Open External Terminal', icon: 'terminal', onClick: () => void call('project:openTerminal', p.path) },
    { separator: true },
    {
      label: 'Project Settings',
      icon: 'settings',
      onClick: () => {
        actions.selectProject(p.path)
        setProjectTab(p.path, 'settings')
      }
    }
  ]
}

/** Short label for the rail: the initials of a multi-word name ("web-dashboard" → "WD"), else its first two letters ("hive" → "Hi"). */
export function projectInitials(name: string): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s._-]+/)
    .filter((w) => /[a-z0-9]/i.test(w))
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  const w = words[0] ?? name
  return w.charAt(0).toUpperCase() + w.charAt(1).toLowerCase()
}

/** The Projects sidebar collapsed to one status dot per project. */
function ProjectsRail() {
  const workspace = useStore((s) => s.workspace)
  const selected = useStore((s) => s.selectedProject)
  const menu = useContextMenu()

  const expand = (
    <Tooltip content={`Expand Sidebar${compactTip()}`} side="right">
      <button className="rail-btn" onClick={() => toggleCompactSidebar(false)} aria-label="Expand Sidebar">
        <Icon name="chevron-right" />
      </button>
    </Tooltip>
  )
  if (!workspace) {
    return (
      <div className="rail">
        {expand}
        <Tooltip content="Open Workspace" side="right">
          <button className="rail-btn" onClick={() => runCommand('workspace.open')} aria-label="Open Workspace">
            <Icon name="folder-opened" />
          </button>
        </Tooltip>
      </div>
    )
  }

  const item = (p: ProjectInfo) => {
    const state = projectState(p)
    const status = state ? STATUS_TEXT[state.status] : p.active ? 'No session' : 'Inactive'
    const running = p.agents.filter((a) => a.live).length
    const tip = (
      <div className="rail-tip">
        <strong>{p.name}</strong>
        <div>
          {status}
          {state?.statusMessage ? ` — ${state.statusMessage}` : ''}
        </div>
        {p.branch && (
          <div className="desc">
            <Icon name="git-branch" /> {p.branch}
          </div>
        )}
        {running > 1 &&
          p.agents.map((a) => (
            <div key={a.id} className="desc">
              {`${a.name}: ${a.live ? STATUS_TEXT[a.live.status] : 'not running'}`}
            </div>
          ))}
      </div>
    )
    return (
      <Tooltip key={p.path} content={tip} side="right" block>
        <div
          className={cx('rail-project', selected === p.path && 'selected', !p.active && 'inactive')}
          onClick={() => actions.selectProject(p.path)}
          onDoubleClick={() => p.active && !state && void actions.newSession(p.path)}
          onContextMenu={(e) => menu.open(e, projectMenu(p))}
          aria-label={`${p.name}: ${status}`}
        >
          <span className="rail-initials">{projectInitials(p.name)}</span>
          <span className={cx('dot', state?.status ?? (p.active ? 'idle' : 'stopped'), state?.unseen && 'unseen')} />
        </div>
      </Tooltip>
    )
  }

  const active = workspace.projects.filter((p) => p.active)
  const inactive = workspace.projects.filter((p) => !p.active)
  return (
    <div className="rail">
      {expand}
      <Tooltip content={`Workspace: ${workspace.name}`} side="right">
        <span className="rail-workspace">
          <Icon name="root-folder" />
        </span>
      </Tooltip>
      <div className="rail-list">
        {active.map(item)}
        {active.length > 0 && inactive.length > 0 && <div className="rail-sep" />}
        {inactive.map(item)}
      </div>
      {menu.element}
    </div>
  )
}

function ProjectsPanel() {
  const workspace = useStore((s) => s.workspace)
  const selected = useStore((s) => s.selectedProject)
  const settings = useStore((s) => s.settings)
  const menu = useContextMenu()
  const [filter, setFilter] = useState('')

  if (!workspace) {
    return (
      <>
        <div className="pane-header">Projects</div>
        <NoWorkspace what="projects" />
      </>
    )
  }
  const list = workspace.projects.filter((p) => !filter || p.name.toLowerCase().includes(filter.toLowerCase()))
  const active = list.filter((p) => p.active)
  const inactive = list.filter((p) => !p.active)

  const row = (p: ProjectInfo) => {
    const bypass = p.config.permissionMode === 'bypassPermissions' && settings?.claude.enableBypassOption
    // One dot per project: the most urgent of its agents.
    const state = projectState(p)
    const running = p.agents.filter((a) => a.live).length
    const status = state ? STATUS_TEXT[state.status] : p.active ? 'No session' : 'Inactive'
    return (
      <div
        key={p.path}
        className={cx('row project-row', selected === p.path && 'selected', !p.active && 'inactive')}
        onClick={() => actions.selectProject(p.path)}
        onDoubleClick={() => p.active && !state && void actions.newSession(p.path)}
        onContextMenu={(e) => menu.open(e, projectMenu(p))}
      >
        <StatusDot live={state} active={p.active} />
        <div className="project-text">
          <div className="project-name">
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
            {bypass && (
              <Tooltip content="Bypass permissions: sessions run every action without asking.">
                <Icon name="warning" className="" />
              </Tooltip>
            )}
            {running > 1 && (
              <Tooltip content={p.agents.map((a) => `${a.name}: ${a.live ? STATUS_TEXT[a.live.status] : 'not running'}`).join('\n')}>
                <span className="agent-count">{running}</span>
              </Tooltip>
            )}
            {p.agents.some((a) => a.restartNeeded) && (
              <Tooltip content="Settings changed since this session started. Restart the session to apply them.">
                <Icon name="refresh" />
              </Tooltip>
            )}
            {p.unmanagedMcp.length > 0 && (
              <Tooltip content={`Project MCP servers not in the workspace (disabled): ${p.unmanagedMcp.join(', ')}`}>
                <Icon name="plug" />
              </Tooltip>
            )}
          </div>
          <div className="project-sub">
            {p.branch && (
              <>
                <Icon name="git-branch" /> {p.branch} ·
              </>
            )}{' '}
            {status}
          </div>
        </div>
        <Tooltip content={p.active ? 'Working on this project. Click to mark it as not being worked on.' : 'Mark as a project you are working on. Only active projects run sessions and show status.'}>
          <Switch small checked={p.active} onChange={(v) => void actions.setProjectActive(p.path, v)} label={`Active: ${p.name}`} />
        </Tooltip>
      </div>
    )
  }

  return (
    <>
      <div className="pane-header">
        {workspace.name}
        <div className="actions">
          <IconButton icon="new-folder" title="New Project…" onClick={() => runCommand('project.new')} />
          <IconButton icon="refresh" title="Refresh" onClick={() => void actions.refreshWorkspace()} />
          <IconButton icon="chevron-left" title={`Compact Sidebar${compactTip()}`} onClick={() => toggleCompactSidebar(true)} />
          <IconButton icon="folder-opened" title="Open Workspace Folder" onClick={() => void call('app:openPath', workspace.path)} />
        </div>
      </div>
      {workspace.projects.length > 6 && (
        <div style={{ padding: '0 8px 6px 12px' }}>
          <input className="input" style={{ width: '100%', height: 24 }} placeholder="Filter projects" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      )}
      <div className="pane-body">
        {workspace.projects.length === 0 ? (
          <div className="pane-empty">
            This workspace has no projects yet. Each folder in the workspace is a project.
            <button className="btn primary" onClick={() => runCommand('project.new')}>
              <Icon name="new-folder" /> New Project
            </button>
          </div>
        ) : (
          <>
            <Section title="Working on" count={active.length} tip="Active projects get a terminal session, status indicators and notifications.">
              {active.length === 0 && <div className="pane-empty" style={{ paddingTop: 8 }}>Toggle a project on to start working on it.</div>}
              {active.map(row)}
            </Section>
            <Section title="Other projects" count={inactive.length}>
              {inactive.map(row)}
            </Section>
          </>
        )}
      </div>
      {menu.element}
    </>
  )
}

// ---------------------------------------------------------------------------
// Shared notes
// ---------------------------------------------------------------------------

function NotesPanel() {
  const workspace = useStore((s) => s.workspace)
  const version = useStore((s) => s.notesVersion)
  const selected = useStore((s) => s.selectedNote)
  const [tree, setTree] = useState<NoteFile[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ handovers: true })
  const menu = useContextMenu()

  const load = useCallback(() => {
    if (workspace) void call('notes:tree').then(setTree)
  }, [workspace?.path])
  useEffect(load, [load, version])

  if (!workspace) {
    return (
      <>
        <div className="pane-header">Shared Notes</div>
        <NoWorkspace what="shared notes" />
      </>
    )
  }

  const create = async (isDir: boolean, parent = ''): Promise<void> => {
    const name = await prompt({
      title: isDir ? 'New Folder' : 'New Note',
      message: isDir ? 'Folder inside .hive/shared' : 'Markdown note inside .hive/shared. Agents can read it through the Hive MCP tools.',
      placeholder: isDir ? 'folder-name' : 'note-name.md',
      initial: parent ? `${parent}/` : '',
      confirmLabel: 'Create'
    })
    if (!name) return
    const path = await actions.attempt('Could not create', () => call('notes:create', name, isDir))
    if (path && !isDir) set({ selectedNote: path })
    load()
  }

  const renderNodes = (nodes: NoteFile[], depth: number): React.ReactNode =>
    nodes.map((n) => (
      <div key={n.path}>
        <div
          className={cx('row', selected === n.path && 'selected')}
          style={{ paddingLeft: 12 + depth * 14 }}
          onClick={() => (n.isDir ? setExpanded((e) => ({ ...e, [n.relPath]: !e[n.relPath] })) : set({ selectedNote: n.path }))}
          onContextMenu={(e) =>
            menu.open(e, [
              ...(n.isDir
                ? [
                    { label: 'New Note Here', icon: 'new-file', onClick: () => void create(false, n.relPath) },
                    { label: 'New Folder Here', icon: 'new-folder', onClick: () => void create(true, n.relPath) },
                    { separator: true }
                  ]
                : []),
              {
                label: 'Rename…',
                icon: 'edit',
                onClick: async () => {
                  const nn = await prompt({ title: 'Rename', initial: n.name, confirmLabel: 'Rename' })
                  if (nn && nn !== n.name) {
                    const np = await actions.attempt('Could not rename', () => call('notes:rename', n.path, nn))
                    if (np && selected === n.path) set({ selectedNote: np })
                    load()
                  }
                }
              },
              { label: 'Reveal in File Explorer', icon: 'folder-opened', onClick: () => void call('app:showInFolder', n.path) },
              { separator: true },
              {
                label: 'Delete',
                icon: 'trash',
                danger: true,
                onClick: async () => {
                  if (await confirm({ title: 'Delete?', message: `Delete "${n.relPath}"${n.isDir ? ' and everything in it' : ''}?`, confirmLabel: 'Delete', danger: true })) {
                    await actions.attempt('Could not delete', () => call('notes:delete', n.path))
                    if (selected === n.path) set({ selectedNote: null })
                    load()
                  }
                }
              }
            ])
          }
        >
          {n.isDir ? <Icon name={expanded[n.relPath] ? 'chevron-down' : 'chevron-right'} /> : <Icon name={n.name.endsWith('.md') ? 'markdown' : 'file'} />}
          {n.isDir && <Icon name={expanded[n.relPath] ? 'folder-opened' : 'folder'} />}
          <span className="label">{n.name}</span>
        </div>
        {n.isDir && expanded[n.relPath] && n.children && renderNodes(n.children, depth + 1)}
      </div>
    ))

  return (
    <>
      <div className="pane-header">
        Shared Notes
        <InfoTip text="Notes, instructions and handovers stored in the workspace's .hive/shared folder. Shared across every project and session." />
        <div className="actions">
          <IconButton icon="new-file" title="New Note…" onClick={() => void create(false)} />
          <IconButton icon="new-folder" title="New Folder…" onClick={() => void create(true)} />
          <IconButton icon="refresh" title="Refresh" onClick={load} />
          <IconButton icon="folder-opened" title="Open Folder" onClick={() => void call('app:openPath', `${workspace.path}\\.hive\\shared`)} />
        </div>
      </div>
      <div className="pane-body">
        {tree.length === 0 ? <div className="pane-empty">No notes yet. Create one, or ask an agent to write a handover with the Hive MCP tools.</div> : renderNodes(tree, 0)}
      </div>
      {menu.element}
    </>
  )
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export const SKILL_LEVEL_TIP: Record<SkillInfo['level'], string> = {
  hive: 'Hive skills live in the workspace (.hive/skills). Enable them here for all projects; projects can turn them off individually. Copied into each session at launch.',
  machine: 'Machine skills live in your user profile (~/.claude/skills). Claude Code always loads them. Hive lists them for reference only.',
  plugin: 'Skills from installed Claude Code plugins. Always loaded by Claude Code. Listed for reference only.',
  local: "Local skills live in the project's own .claude/skills folder. Claude Code always loads them in that project. Copy one to the workspace to manage it with Hive."
}

function SkillsPanel() {
  const workspace = useStore((s) => s.workspace)
  const version = useStore((s) => s.skillsVersion)
  const selectedSkill = useStore((s) => s.selectedSkill)
  const selectedProject = useStore((s) => s.selectedProject)
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [filter, setFilter] = useState('')

  const load = useCallback(() => {
    void call('skills:list', selectedProject ?? undefined).then(setSkills).catch(() => setSkills([]))
  }, [selectedProject, workspace?.path])
  useEffect(load, [load, version])

  const create = async (): Promise<void> => {
    if (!workspace) return notify('warning', 'Open a workspace first')
    const name = await prompt({
      title: 'New Hive Skill',
      message: 'Creates .hive/skills/<name>/SKILL.md in the workspace. Use lowercase letters, numbers and dashes.',
      placeholder: 'my-skill',
      confirmLabel: 'Create',
      validate: (v) => (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(v.trim()) ? null : 'Use letters, numbers, "-" and "_" (max 64)')
    })
    if (!name) return
    const s = await actions.attempt('Could not create skill', () => call('skills:create', name.trim(), ''))
    if (s) set({ selectedSkill: s.path })
    load()
  }

  const f = (s: SkillInfo): boolean => !filter || `${s.name} ${s.description}`.toLowerCase().includes(filter.toLowerCase())
  const hive = skills.filter((s) => s.level === 'hive' && f(s))
  const machine = skills.filter((s) => s.level === 'machine' && f(s))
  const plugin = skills.filter((s) => s.level === 'plugin' && f(s))
  const local = skills.filter((s) => s.level === 'local' && f(s))
  const projectName = workspace?.projects.find((p) => p.path === selectedProject)?.name

  const row = (s: SkillInfo) => (
    <div key={`${s.level}:${s.path}`} className={cx('row tall', selectedSkill === s.path && 'selected')} onClick={() => set({ selectedSkill: s.path })}>
      <Icon name={s.level === 'hive' ? 'sparkle' : s.level === 'local' ? 'folder' : s.level === 'plugin' ? 'extensions' : 'device-desktop'} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="label" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {s.name} {s.plugin && <span className="desc">· {s.plugin}</span>}
        </div>
        {s.description && (
          <div className="desc" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {s.description}
          </div>
        )}
      </div>
      {s.level === 'hive' && (
        <Tooltip content={s.globallyEnabled ? 'Enabled for all projects (new sessions). Click to disable.' : 'Disabled. Click to enable for all projects (new sessions).'}>
          <Switch
            small
            checked={!!s.globallyEnabled}
            onChange={(v) => void actions.attempt('Could not update skill', () => call('skills:setGlobal', s.name, v)).then(load)}
          />
        </Tooltip>
      )}
    </div>
  )

  return (
    <>
      <div className="pane-header">
        Skills
        <div className="actions">
          <IconButton icon="add" title="New Hive Skill…" onClick={() => void create()} disabled={!workspace} />
          <IconButton icon="refresh" title="Refresh" onClick={load} />
          <IconButton icon="folder-opened" title="Open Hive Skills Folder" onClick={() => void call('skills:openFolder')} disabled={!workspace} />
        </div>
      </div>
      <div style={{ padding: '0 8px 6px 12px' }}>
        <input className="input" style={{ width: '100%', height: 24 }} placeholder="Filter skills" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="pane-body">
        <Section title="Hive" count={hive.length} tip={SKILL_LEVEL_TIP.hive}>
          {!workspace && <div className="pane-empty">Open a workspace to manage Hive skills.</div>}
          {workspace && hive.length === 0 && <div className="pane-empty">No Hive skills yet. Add a folder with a SKILL.md to .hive/skills, or create one.</div>}
          {hive.map(row)}
        </Section>
        {selectedProject && (
          <Section title={`Local · ${projectName ?? ''}`} count={local.length} tip={SKILL_LEVEL_TIP.local}>
            {local.length === 0 && <div className="pane-empty">No local skills in this project.</div>}
            {local.map(row)}
          </Section>
        )}
        <Section title="Machine (Claude)" count={machine.length} tip={SKILL_LEVEL_TIP.machine} defaultOpen={false}>
          {machine.map(row)}
        </Section>
        <Section title="Plugins (Claude)" count={plugin.length} tip={SKILL_LEVEL_TIP.plugin} defaultOpen={false}>
          {plugin.map(row)}
        </Section>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

function McpPanel() {
  const workspace = useStore((s) => s.workspace)
  const version = useStore((s) => s.skillsVersion)
  const selected = useStore((s) => s.selectedMcp)
  const api = useStore((s) => s.api)
  const settings = useStore((s) => s.settings)
  const [servers, setServers] = useState<McpServerInfo[]>([])
  const loaded = useRef(false)

  const load = useCallback(() => {
    if (!workspace) return
    void call('mcp:list').then((l) => {
      setServers(l)
      loaded.current = true
    })
  }, [workspace?.path])
  useEffect(load, [load, version])

  if (!workspace) {
    return (
      <>
        <div className="pane-header">MCP Servers</div>
        <NoWorkspace what="MCP servers" />
      </>
    )
  }

  const create = async (): Promise<void> => {
    const name = await prompt({
      title: 'New MCP Server',
      message: 'Creates .hive/mcp/<name>.json in the workspace from a template you can edit.',
      placeholder: 'server-name',
      confirmLabel: 'Create',
      validate: (v) => (/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v.trim()) && v.trim() !== 'hive' ? null : 'Use letters, numbers, "-" and "_". "hive" is reserved.')
    })
    if (!name) return
    const m = await actions.attempt('Could not create server', () => call('mcp:create', name.trim()))
    if (m) set({ selectedMcp: m.name })
    load()
  }

  const hiveOn = !!(settings?.agentApi.enabled && settings.agentApi.provideHiveMcp && api?.running)

  return (
    <>
      <div className="pane-header">
        MCP Servers
        <InfoTip text="MCP servers deployed to the workspace (.hive/mcp). Enable them for all projects here; turn them off per project in the project's MCP tab. Changes apply to new sessions." />
        <div className="actions">
          <IconButton icon="add" title="New MCP Server…" onClick={() => void create()} />
          <IconButton icon="refresh" title="Refresh" onClick={load} />
          <IconButton icon="folder-opened" title="Open MCP Folder" onClick={() => void call('mcp:openFolder')} />
        </div>
      </div>
      <div className="pane-body">
        <Section title="Workspace" count={servers.length}>
          {loaded.current && servers.length === 0 && <div className="pane-empty">No MCP servers yet. Create one, or drop a &lt;name&gt;.json definition into .hive/mcp.</div>}
          {servers.map((m) => (
            <div key={m.name} className={cx('row tall', selected === m.name && 'selected')} onClick={() => set({ selectedMcp: m.name })}>
              <Icon name={m.error ? 'error' : m.def?.url ? 'globe' : 'plug'} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="label">
                  {m.name}{' '}
                  {m.secretWarnings.length > 0 && (
                    <Tooltip content={m.secretWarnings.join('\n')}>
                      <Icon name="warning" />
                    </Tooltip>
                  )}
                </div>
                <div className="desc" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {m.error ?? m.def?.description ?? m.def?.command ?? m.def?.url}
                </div>
              </div>
              <Tooltip content={m.globallyEnabled ? 'Enabled for all projects (new sessions). Click to disable.' : 'Disabled. Click to enable for all projects (new sessions).'}>
                <Switch small checked={m.globallyEnabled} disabled={!!m.error} onChange={(v) => void actions.attempt('Could not update server', () => call('mcp:setGlobal', m.name, v)).then(load)} />
              </Tooltip>
            </div>
          ))}
        </Section>
        <Section title="Built-in" count={1}>
          <div className={cx('row tall', selected === '__hive' && 'selected')} onClick={() => set({ selectedMcp: '__hive' })}>
            <Icon name="hubot" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="label">hive</div>
              <div className="desc">Hive tools for agents: projects, shared notes, handovers, notifications</div>
            </div>
            <Tooltip content="Controlled in Settings → Agent API">
              <span className={cx('badge', hiveOn ? 'success' : '')}>{hiveOn ? 'On' : 'Off'}</span>
            </Tooltip>
          </div>
        </Section>
      </div>
    </>
  )
}
