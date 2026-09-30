import { useEffect, useState } from 'react'
import type { McpServerInfo, SkillInfo } from '@shared/types'
import { enabledProviders } from '@shared/providers'
import iconUrl from '../assets/icon.svg'
import guideMd from '@docs/USER_GUIDE.md?raw'
import apiMd from '@docs/AGENT_API.md?raw'
import changelogMd from '@root/CHANGELOG.md?raw'
import licenseTxt from '@root/LICENSE?raw'
import noticesMd from '@root/THIRD_PARTY_NOTICES.md?raw'
import * as actions from '../actions'
import { call, errorMessage } from '../api'
import { runCommand, commandKeybinding } from '../commands'
import { DocEditor } from '../components/DocEditor'
import { CodeEditor } from '../components/Editors'
import { PaneResizer, usePaneSize } from '../components/Resizer'
import { Icon, IconButton, Markdown, Switch } from '../components/ui'
import { SKILL_LEVEL_TIP } from '../components/Sidebar'
import { confirm, notify, set, useStore } from '../store'
import { basename, cx, formatKeybinding } from '../util'

// ---------------------------------------------------------------------------
// Welcome (no workspace open)
// ---------------------------------------------------------------------------

export function WelcomeView() {
  const recent = useStore((s) => s.recent)
  const providers = useStore((s) => s.providers)
  const settings = useStore((s) => s.settings)
  const on = enabledProviders(settings)
  const missing = on.filter((p) => providers[p.id] && !providers[p.id].checking && !providers[p.id].found)
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-hero">
          <img src={iconUrl} alt="" />
          <div>
            <h1>Hive</h1>
            <p>Run AI coding agents across your projects, side by side.</p>
          </div>
        </div>
        <div className="welcome-cols">
          <div>
            <h3>Start</h3>
            <div className="welcome-link" onClick={() => runCommand('workspace.open')}>
              <Icon name="folder-opened" /> Open Workspace… <span className="muted">{formatKeybinding(commandKeybinding('workspace.open') ?? '')}</span>
            </div>
            <div className="welcome-link" onClick={() => runCommand('workspace.create')}>
              <Icon name="new-folder" /> New Workspace…
            </div>
            {settings && !on.length && (
              <div className="welcome-link" onClick={() => runCommand('settings.providers')}>
                <Icon name="hubot" /> Choose your coding agents (Claude Code, …)
              </div>
            )}
            {missing.map((p) => (
              <div key={p.id} className="welcome-link" onClick={() => set({ setupOpen: p.id })}>
                <Icon name="cloud-download" /> Install {p.name}…
              </div>
            ))}
            <h3 style={{ marginTop: 28 }}>Recent</h3>
            {recent.length === 0 && <div className="muted">No recent workspaces.</div>}
            {recent.map((r) => (
              <div key={r} className="welcome-link" onClick={() => void actions.openWorkspace(r)}>
                <Icon name="root-folder" /> {basename(r)} <span className="muted">{r}</span>
              </div>
            ))}
            <h3 style={{ marginTop: 28 }}>Help</h3>
            <div className="welcome-link" onClick={() => runCommand('help.docs')}>
              <Icon name="book" /> User guide
            </div>
            <div className="welcome-link" onClick={() => runCommand('help.api')}>
              <Icon name="plug" /> Agent API reference
            </div>
            <div className="welcome-link" onClick={() => runCommand('help.shortcuts')}>
              <Icon name="keyboard" /> Keyboard shortcuts
            </div>
          </div>
          <div>
            <h3>How Hive works</h3>
            <div className="walkthrough">
              <Icon name="root-folder" />
              <div>
                <strong>Workspace</strong>
                <p>A folder of projects. Hive adds a <code>.hive</code> folder for shared notes, skills and MCP servers — commit it to share with your team.</p>
              </div>
            </div>
            <div className="walkthrough">
              <Icon name="folder" />
              <div>
                <strong>Projects</strong>
                <p>Each subfolder is a project. Toggle the ones you're working on; each gets its own coding agents, running side by side.</p>
              </div>
            </div>
            <div className="walkthrough">
              <Icon name="sparkle" />
              <div>
                <strong>Skills &amp; MCP</strong>
                <p>Deploy skills and MCP servers to the workspace, enable them globally, and turn them off per project. Changes apply to new sessions.</p>
              </div>
            </div>
            <div className="walkthrough">
              <Icon name="bell" />
              <div>
                <strong>Stay in flow</strong>
                <p>Hive chimes and notifies you when an agent finishes or needs input — even from the system tray.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared notes
// ---------------------------------------------------------------------------

export function NotesView() {
  const selected = useStore((s) => s.selectedNote)
  const workspace = useStore((s) => s.workspace)
  if (!workspace) return <WelcomeView />
  if (!selected) {
    return (
      <div className="empty-state" style={{ paddingTop: '18vh' }}>
        <Icon name="notebook" />
        Select a note, or create one. Shared notes live in <code>.hive/shared</code> and are available to every project and agent.
      </div>
    )
  }
  return (
    <div className="split">
      <DocEditor key={selected} path={selected} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Skill detail
// ---------------------------------------------------------------------------

export function SkillView() {
  const selected = useStore((s) => s.selectedSkill)
  const version = useStore((s) => s.skillsVersion)
  const selectedProject = useStore((s) => s.selectedProject)
  const workspace = useStore((s) => s.workspace)
  const [skill, setSkill] = useState<SkillInfo | null>(null)

  useEffect(() => {
    if (!selected) return setSkill(null)
    void call('skills:list', selectedProject ?? undefined).then((l) => setSkill(l.find((s) => s.path === selected) ?? null))
  }, [selected, version, selectedProject])

  if (!selected || !skill) {
    return (
      <div className="empty-state" style={{ paddingTop: '18vh' }}>
        <Icon name="sparkle" />
        Select a skill to view it. Hive skills can be edited here; Machine, Plugin and Local skills are read-only.
      </div>
    )
  }
  const editable = skill.level === 'hive'
  const levelLabel = { hive: 'Hive', machine: 'Machine', plugin: 'Plugin', local: 'Local' }[skill.level]
  return (
    <div className="split">
      <DocEditor
        key={skill.path}
        path={`${skill.path}\\SKILL.md`}
        title={skill.name}
        readOnly={!editable || !workspace}
        defaultPreview
        toolbarExtra={
          <>
            <span className={cx('badge', editable ? 'accent' : '')} title={SKILL_LEVEL_TIP[skill.level]}>
              {levelLabel}
              {skill.plugin ? ` · ${skill.plugin}` : ''}
            </span>
            {editable && (
              <label className="flex muted" style={{ fontSize: 12 }}>
                <Switch
                  small
                  checked={!!skill.globallyEnabled}
                  onChange={(v) =>
                    void actions.attempt('Could not update skill', () => call('skills:setGlobal', skill.name, v)).then(() => set((s) => ({ skillsVersion: s.skillsVersion + 1 })))
                  }
                />
                Enabled
              </label>
            )}
            {(skill.level === 'local' || skill.level === 'machine' || skill.level === 'plugin') && workspace && (
              <button
                className="btn small subtle"
                onClick={async () => {
                  const s = await actions.attempt('Could not copy skill', () => call('skills:copyToWorkspace', skill.path))
                  if (s) {
                    notify('success', `Copied "${skill.name}" to the workspace`, 'It is disabled until you enable it.')
                    set({ selectedSkill: s.path })
                  }
                }}
              >
                <Icon name="cloud-upload" /> Copy to workspace
              </button>
            )}
          </>
        }
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// MCP server detail
// ---------------------------------------------------------------------------

const MCP_HELP = `**Format** — one server per file, in Claude Code's .mcp.json format (Hive converts it for other providers) plus an optional \`description\`:

\`\`\`json
{
  "description": "GitHub issues and pull requests",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_TOKEN": "\${GITHUB_TOKEN}" }
}
\`\`\`

Remote servers use \`"type": "http"\` and \`"url"\`. Reference secrets as environment variables — this folder is meant to be committed.
Use \`\${HIVE_MCP_DIR}\` to point at server code stored in \`.hive/mcp\`.`

export function McpView() {
  const selected = useStore((s) => s.selectedMcp)
  const version = useStore((s) => s.skillsVersion)
  const api = useStore((s) => s.api)
  const [text, setText] = useState('')
  const [saved, setSaved] = useState('')
  const [info, setInfo] = useState<McpServerInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!selected || selected === '__hive') return
    void call('mcp:read', selected).then((t) => {
      setText(t)
      setSaved(t)
      setError(null)
    })
  }, [selected])
  useEffect(() => {
    if (!selected || selected === '__hive') return
    void call('mcp:list').then((l) => setInfo(l.find((m) => m.name === selected) ?? null))
  }, [selected, version])

  if (!selected) {
    return (
      <div className="empty-state" style={{ paddingTop: '18vh' }}>
        <Icon name="plug" />
        Select an MCP server to edit its definition.
      </div>
    )
  }
  if (selected === '__hive') {
    return (
      <div className="scroll-page">
        <div className="page-narrow">
          <h2 className="section">
            <Icon name="hubot" /> Built-in Hive MCP server
          </h2>
          <p className="hint">
            Every session started from Hive gets a <code>hive</code> MCP server that connects to the Agent API{api?.url ? ` at ${api.url}` : ''}. Turn it off in Settings → Agent API.
          </p>
          <Markdown
            source={`| Tool | What it does |
|---|---|
| \`hive_list_projects\` | List projects and their session status |
| \`hive_project_status\` | Status and settings of one project |
| \`hive_session_usage\` | Token use, cache and compactions for a session |
| \`hive_list_shared_notes\` | List notes in .hive/shared |
| \`hive_read_shared_note\` | Read a shared note |
| \`hive_write_shared_note\` | Create, overwrite or append to a shared note |
| \`hive_create_handover\` | Write a handover note for a future session |
| \`hive_notify\` | Show a notification to you in Hive |
| \`hive_list_skills\` | List skills available to a project |

Try asking an agent: *"Write a handover for the next session using the hive tools."*`}
          />
        </div>
      </div>
    )
  }

  const dirty = text !== saved
  const save = async (): Promise<void> => {
    try {
      JSON.parse(text)
    } catch (e) {
      setError(`Invalid JSON: ${errorMessage(e)}`)
      return
    }
    const r = await actions.attempt('Could not save', () => call('mcp:save', selected, text))
    if (r) {
      setSaved(text)
      setError(null)
      setInfo(r)
    }
  }
  const remove = async (): Promise<void> => {
    if (!(await confirm({ title: 'Delete MCP server?', message: `Delete ${selected}.json from the workspace? Projects will no longer be able to use it.`, confirmLabel: 'Delete', danger: true }))) return
    await actions.attempt('Could not delete', () => call('mcp:delete', selected))
    set({ selectedMcp: null })
  }

  return (
    <div className="split">
      <div className="split-main">
        <div className="editor-toolbar">
          <Icon name="plug" />
          <span className="path">
            <strong>{selected}</strong>
            {dirty && ' ●'} <span className="faint">{info?.path}</span>
          </span>
          {info && (
            <label className="flex muted" style={{ fontSize: 12 }}>
              <Switch
                small
                checked={info.globallyEnabled}
                disabled={!!info.error}
                onChange={(v) => void actions.attempt('Could not update', () => call('mcp:setGlobal', selected, v)).then(() => set((s) => ({ skillsVersion: s.skillsVersion + 1 })))}
              />
              Enabled
            </label>
          )}
          <IconButton icon="trash" title="Delete server" onClick={() => void remove()} />
          <button className="btn small primary" disabled={!dirty} onClick={() => void save()}>
            <Icon name="save" /> Save
          </button>
        </div>
        {(error || info?.error) && (
          <div className="banner danger">
            <Icon name="error" /> {error ?? info?.error}
          </div>
        )}
        {info?.secretWarnings.map((w) => (
          <div key={w} className="banner warn">
            <Icon name="warning" /> {w}
          </div>
        ))}
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <div className="editor-host" style={{ flex: 1 }}>
            <CodeEditor value={text} language="json" onChange={setText} onSave={() => void save()} wordWrap={false} />
          </div>
          <div style={{ width: 340, borderLeft: '1px solid var(--border-subtle)', overflow: 'auto', padding: '14px 16px', fontSize: 12 }}>
            <Markdown source={MCP_HELP} />
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Docs
// ---------------------------------------------------------------------------

const DOCS: { id: string; label: string; icon: string; source: string; file: string }[] = [
  { id: 'guide', label: 'User Guide', icon: 'book', source: guideMd, file: 'USER_GUIDE.md' },
  { id: 'api', label: 'Agent API', icon: 'plug', source: apiMd, file: 'AGENT_API.md' },
  { id: 'changelog', label: 'Release Notes', icon: 'history', source: changelogMd, file: 'CHANGELOG.md' },
  { id: 'license', label: 'License', icon: 'law', source: `# License\n\n\`\`\`text\n${licenseTxt.trim()}\n\`\`\`\n\nSee also the [third-party notices](THIRD_PARTY_NOTICES.md).\n`, file: 'LICENSE' },
  { id: 'notices', label: 'Third-Party Notices', icon: 'references', source: noticesMd, file: 'THIRD_PARTY_NOTICES.md' }
]

export function DocsView() {
  const page = useStore((s) => s.docsPage)
  const listWidth = usePaneSize('docs', 220)
  const doc = DOCS.find((d) => d.id === page) ?? DOCS[0]
  const api = useStore((s) => s.api)
  const source = api?.url ? doc.source.replace(/http:\/\/127\.0\.0\.1:47821/g, api.url) : doc.source
  return (
    <div className="split">
      <div className="split-list" style={{ width: listWidth }}>
        <PaneResizer paneKey="docs" max={500} />
        <div className="pane-header" style={{ paddingLeft: 14 }}>
          Documentation
        </div>
        <div className="pane-body">
          {DOCS.map((d) => (
            <div key={d.id} className={cx('row', d.id === doc.id && 'selected')} onClick={() => set({ docsPage: d.id })}>
              <Icon name={d.icon} /> <span className="label">{d.label}</span>
            </div>
          ))}
          <div className="row" onClick={() => set({ shortcutsOpen: true })}>
            <Icon name="keyboard" /> <span className="label">Keyboard Shortcuts</span>
          </div>
          <div className="row" onClick={() => set({ aboutOpen: true })}>
            <Icon name="info" /> <span className="label">About Hive</span>
          </div>
        </div>
      </div>
      <div className="split-main">
        <div className="scroll-page" style={{ position: 'relative', flex: 1 }}>
          <Markdown
            source={source}
            onLink={(href) => {
              const target = DOCS.find((d) => href === d.file || href.endsWith(`/${d.file}`))
              if (target) {
                set({ docsPage: target.id })
                return true
              }
              return false
            }}
          />
        </div>
      </div>
    </div>
  )
}
