import { useEffect, useState } from 'react'
import type { ProviderId, SkillAudience, SkillInfo, SkillLevel, SkillTarget } from '@shared/types'
import { providerDescriptor } from '@shared/providers'
import * as actions from '../actions'
import { call } from '../api'
import { clearEditorDraftsUnder } from '../editorDrafts'
import { DocEditor } from './DocEditor'
import { Icon, IconButton, Tooltip } from './ui'
import { confirm, notify, prompt, set, showView, useStore } from '../store'
import { cx } from '../util'

/**
 * Skills in Hive: the workspace's Hive skills (given to project agents, the Assistant or both, as each one's
 * metadata.audience says; edited in the Skills view), and, per
 * provider in a project, its local skills (editable in the project) and the user's own and plugin skills
 * (view only). Shared by the Skills view and the project's Skills tab.
 */

export const SKILL_LEVEL_LABEL: Record<SkillLevel, string> = { hive: 'Hive', machine: 'User', plugin: 'Plugin', local: 'Local (User Managed)' }

export const SKILL_LEVEL_TIP: Record<SkillLevel, string> = {
  hive: "Hive skills live in the workspace (.hive/skills). Each goes to the project agents (every agent in every project, of every provider), to the Hive Assistant, or to both, as the audience in its SKILL.md says (the project agents if it says none). Hive copies them for each session when it starts, so edits reach new sessions. Add, edit and delete them in the Skills view.",
  machine: "Skills in your user profile (~/.claude/skills for Claude Code, ~/.codex/skills for Codex). That provider's agents always load them, in every project. Listed for reference; manage them outside Hive.",
  plugin: "Skills from Claude Code plugins you've installed. Claude Code agents always load them. Listed for reference; manage plugins in Claude Code.",
  local: "Skills in the project folder for one provider (.claude/skills for Claude Code, .agents/skills for Codex). That provider's agents load them in this project. You manage them: add, edit and delete them here."
}

export const SKILL_ICON: Record<SkillLevel, string> = { hive: 'sparkle', machine: 'account', plugin: 'extensions', local: 'folder' }

/** Over the Hive skills view and a Hive skill being edited there: these skills steer the agents. */
export function HiveSkillsWarning() {
  return (
    <div className="banner warn skills-warning" role="note">
      <Icon name="warning" />
      <span>
        <strong>Warning:</strong> Editing these skills may change agent behaviour in Hive
      </span>
    </div>
  )
}

/** Who gets a Hive skill (SKILL.md's metadata.audience; none means the project agents), as a badge says it. */
export const AUDIENCE_LABEL: Record<SkillAudience, string> = { agents: 'Project agents', assistant: 'Assistant', all: 'Agents + Assistant' }

const AUDIENCE_TIP: Record<SkillAudience, string> = {
  agents: "For the project agents: every agent in every project of this workspace gets it. The Hive Assistant doesn't. This is the default; to change it, set audience under metadata: in its SKILL.md's header (assistant, or all for both).",
  assistant: "For the Hive Assistant only (audience: assistant in its SKILL.md's header). Project agents don't get it.",
  all: "For both the project agents (every agent in every project) and the Hive Assistant (audience: all in its SKILL.md's header)."
}

/** Who gets a Hive skill, in a sentence: "the project agents", "the Hive Assistant", "the project agents and the Hive Assistant". */
export function audienceWho(a: SkillAudience | undefined): string {
  return a === 'assistant' ? 'the Hive Assistant' : a === 'all' ? 'the project agents and the Hive Assistant' : 'the project agents'
}

/** A Hive skill nobody gets, because its header can't be read or names an audience Hive doesn't know: why, and how to fix it. */
export function ProblemBadge({ problem, small }: { problem: string; small?: boolean }) {
  return (
    <Tooltip content={`Nobody gets this skill until its header is fixed: ${problem}. A skill's header starts and ends with a --- line; for who gets it, put audience: agents, assistant or all under metadata:.`}>
      <span className={cx('badge warn', small && 'audience')} data-audience="none">
        <Icon name="warning" /> Not given
      </span>
    </Tooltip>
  )
}

/** A Hive skill's audience as a badge, with what it means. */
export function AudienceBadge({ audience, small }: { audience: SkillAudience | undefined; small?: boolean }) {
  const a = audience ?? 'agents'
  return (
    <Tooltip content={AUDIENCE_TIP[a]}>
      <span className={cx('badge', small && 'audience', a !== 'agents' && 'accent')} data-audience={a}>
        <Icon name={a === 'agents' ? 'folder' : a === 'assistant' ? 'hubot' : 'organization'} /> {AUDIENCE_LABEL[a]}
      </span>
    </Tooltip>
  )
}

const NAME_RULE = (v: string): string | null => (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(v.trim()) ? null : 'Use letters, numbers, "-" and "_" (max 64)')

function where(target: SkillTarget): string {
  return target.kind === 'hive' ? 'the workspace (.hive/skills)' : `${providerDescriptor(target.provider).name}'s local skills`
}

function bump(): void {
  set((s) => ({ skillsVersion: s.skillsVersion + 1 }))
}

/**
 * Adds a skill: a new one from a starter SKILL.md, or from a .md or .zip file. `also` is the other provider's
 * local folder in the same project, offered as a tick box so a skill can be added for both at once.
 */
export async function addSkill(mode: 'new' | 'file', target: SkillTarget, also?: SkillTarget): Promise<SkillInfo | null> {
  let file: { path: string; name: string } | null = null
  if (mode === 'file') {
    file = (await actions.attempt('Could not read the file', () => call('skills:pickFile'))) ?? null
    if (!file) return null
  }
  let both = false
  const check = also?.kind === 'local' ? { label: `Also add it for ${providerDescriptor(also.provider).name}`, initial: false, set: (v: boolean) => (both = v) } : undefined
  const name = await prompt({
    title: mode === 'new' ? 'New Skill' : 'Add Skill from File',
    message:
      mode === 'new'
        ? `Creates <name>/SKILL.md in ${where(target)}. Use lowercase letters, numbers and dashes.`
        : `Adds ${file!.path.split(/[\\/]/).pop()} to ${where(target)}. A .md becomes the skill's SKILL.md; a .zip is unpacked as the skill's folder.`,
    placeholder: 'my-skill',
    initial: file?.name ?? '',
    confirmLabel: mode === 'new' ? 'Create' : 'Add',
    validate: NAME_RULE,
    check
  })
  if (!name) return null
  const targets = both && also ? [target, also] : [target]
  const s = await actions.attempt('Could not add the skill', () =>
    mode === 'new' ? call('skills:create', name.trim(), '', targets) : call('skills:addFromFile', file!.path, name.trim(), targets)
  )
  if (s) bump()
  return s ?? null
}

export async function deleteSkill(s: SkillInfo): Promise<boolean> {
  const hive = s.level === 'hive'
  const ok = await confirm({
    title: 'Delete skill?',
    message: `Move "${s.name}" to the Recycle Bin?`,
    detail: hive
      ? s.problem
        ? `It's removed from the workspace. Nobody gets it now (${s.problem}), so no session loses it.`
        : `It's removed from the workspace, so new sessions of ${audienceWho(s.audience)} no longer get it. A running Claude Code session keeps its own copy until it restarts. Codex sessions share the copy in their folder: a running one loses it when another Codex session in that folder starts.`
      : `${s.provider ? providerDescriptor(s.provider).name : 'The'} agents in this project no longer load it in new sessions.`,
    confirmLabel: 'Delete',
    danger: true
  })
  if (!ok) return false
  const ok2 = await actions.attempt('Could not delete the skill', async () => {
    await call('skills:delete', s.path)
    return true
  })
  // Unsaved edits of it would otherwise bring it back (Save All, or saving before quitting).
  if (ok2) clearEditorDraftsUnder(s.path)
  bump()
  return !!ok2
}

export async function restoreBundled(s: SkillInfo): Promise<SkillInfo | null> {
  if (s.bundled === 'changed') {
    const ok = await confirm({
      title: 'Revert to default?',
      message: `Replace the workspace's "${s.name}" with the version that ships with this version of Hive?`,
      detail: 'The current copy goes to the Recycle Bin, so edits made to it can still be recovered from there.',
      confirmLabel: 'Revert'
    })
    if (!ok) return null
  }
  const r = await actions.attempt('Could not restore the skill', () => call('skills:restoreBundled', s.name))
  if (r) {
    clearEditorDraftsUnder(r.path)
    notify('success', s.bundled === 'missing' ? `Restored "${s.name}"` : `Reverted "${s.name}" to default`)
    bump()
  }
  return r ?? null
}

async function copyToWorkspace(s: SkillInfo): Promise<void> {
  const r = await actions.attempt('Could not copy skill', () => call('skills:copyToWorkspace', s.path))
  if (!r) return
  const local = s.level === 'local' ? ` ${s.provider ? providerDescriptor(s.provider).name : 'The'} agents here also still load the local copy until you delete it.` : ''
  // Copied, but its header can't be read or names no audience Hive knows: nobody gets it until that's fixed.
  if (r.problem) {
    notify('warning', `Copied "${s.name}" to the workspace, but nobody gets it yet`, `Its header needs fixing first: ${r.problem}. Open it in the Skills view to edit it.${local}`)
  } else {
    const who = audienceWho(r.audience)
    notify('success', `Copied "${s.name}" to the workspace`, `${who[0].toUpperCase()}${who.slice(1)} now ${r.audience === 'assistant' ? 'gets' : 'get'} it as a Hive skill, from their next session.${local}`)
  }
  bump()
}

/** Opens a Hive skill for editing in the Skills view (from a project, where Hive skills are view only). */
export function editInWorkspace(s: SkillInfo): void {
  set({ selectedSkill: s.path, skillEdit: s.path })
  showView('skills')
}

/** One skill in a list: icon, name, description and its actions. */
export function SkillRow({ skill, selected, onSelect, actionsFor }: { skill: SkillInfo; selected: boolean; onSelect: () => void; actionsFor?: React.ReactNode }) {
  const missing = skill.bundled === 'missing'
  return (
    <div className={cx('row tall skill-row', selected && 'selected', missing && 'missing')} onClick={onSelect}>
      <Icon name={missing ? 'circle-slash' : SKILL_ICON[skill.level]} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="label" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {skill.name} {skill.plugin && <span className="desc">· {skill.plugin}</span>} {missing && <span className="badge">deleted</span>}{skill.updateAvailable && <span className="badge accent">update</span>}
          {skill.level === 'hive' && skill.problem && <ProblemBadge problem={skill.problem} small />}
          {skill.level === 'hive' && !skill.problem && skill.audience && skill.audience !== 'agents' && <AudienceBadge audience={skill.audience} small />}
        </div>
        {skill.description && (
          <div className="desc" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {skill.description}
          </div>
        )}
      </div>
      {actionsFor && (
        <div className="row-actions" onClick={(e) => e.stopPropagation()}>
          {actionsFor}
        </div>
      )}
    </div>
  )
}

/**
 * A skill's SKILL.md, previewed, with what can be done to it. `where` is 'workspace' (the Skills view, where
 * Hive skills are edited) or 'project' (where Hive skills are view only and local skills are edited).
 */
export function SkillDetail({ skill, where: place, onDeleted, onRestored }: { skill: SkillInfo; where: 'workspace' | 'project'; onDeleted?: () => void; onRestored?: (s: SkillInfo) => void }) {
  const workspace = useStore((s) => s.workspace)
  const editRequest = useStore((s) => s.skillEdit)
  const missing = skill.bundled === 'missing'
  const editable = !missing && ((skill.level === 'hive' && place === 'workspace') || skill.level === 'local')
  // "Edit in workspace" is for the Skills view's page: the project tab's, showing the same skill, leaves it be.
  const forMe = place === 'workspace' && editRequest === skill.path
  const [editing] = useState(() => forMe)
  useEffect(() => {
    if (forMe) set({ skillEdit: null })
  }, [forMe])

  return (
    <DocEditor
      key={`${skill.path}:${skill.bundled ?? ''}`}
      path={`${skill.path}\\SKILL.md`}
      title={skill.name}
      readOnly={!editable || !workspace}
      defaultPreview={!editing}
      editingNote={skill.level === 'hive' && place === 'workspace' ? <HiveSkillsWarning /> : undefined}
      toolbarExtra={
        <>
          <Tooltip content={SKILL_LEVEL_TIP[skill.level]}>
            <span className={cx('badge', skill.level === 'hive' ? 'accent' : '')}>
              {SKILL_LEVEL_LABEL[skill.level]}
              {skill.provider && skill.level !== 'hive' ? ` · ${providerDescriptor(skill.provider).name}` : ''}
              {skill.plugin ? ` · ${skill.plugin}` : ''}
            </span>
          </Tooltip>
          {skill.level === 'hive' && (skill.problem ? <ProblemBadge problem={skill.problem} /> : <AudienceBadge audience={skill.audience} />)}
          {missing && (
            <>
              <span className="badge warn">Deleted from this workspace</span>
              <button className="btn small primary" onClick={() => void restoreBundled(skill).then((s) => s && onRestored?.(s))}>
                <Icon name="history" /> Restore
              </button>
            </>
          )}
          {skill.bundled === 'changed' && place === 'workspace' && (
            <>
              {skill.updateAvailable && (
                <Tooltip content="This copy was edited, so Hive didn't update it. This Hive ships a newer version: Revert to default brings it in (your copy goes to the Recycle Bin).">
                  <span className="badge accent">Update available</span>
                </Tooltip>
              )}
              <Tooltip content="This skill ships with Hive, and this copy was edited. Hive keeps edited copies as they are; unedited ones it updates itself.">
                <button className="btn small subtle" onClick={() => void restoreBundled(skill).then((s) => s && onRestored?.(s))}>
                  <Icon name="discard" /> Revert to default
                </button>
              </Tooltip>
            </>
          )}
          {skill.level === 'hive' && place === 'project' && (
            <Tooltip content="Hive skills are edited in the workspace's Skills view, since every project shares them. This takes you there.">
              <button className="btn small subtle" onClick={() => editInWorkspace(skill)}>
                <Icon name="go-to-file" /> Edit in workspace
              </button>
            </Tooltip>
          )}
          {skill.level !== 'hive' && workspace && (
            <Tooltip content="Copy it into the workspace's Hive skills. The project agents in every project get it, unless its SKILL.md's header sets another audience.">
              <button className="btn small subtle" onClick={() => void copyToWorkspace(skill)}>
                <Icon name="cloud-upload" /> Copy to workspace
              </button>
            </Tooltip>
          )}
          {editable && <IconButton icon="trash" title="Delete skill" onClick={() => void deleteSkill(skill).then((ok) => ok && onDeleted?.())} />}
        </>
      }
    />
  )
}

/** The provider whose local folder is `target`'s counterpart, for "also add it for …". */
export function otherLocal(projectPath: string, provider: ProviderId, providers: ProviderId[]): SkillTarget | undefined {
  const other = providers.find((p) => p !== provider)
  return other ? { kind: 'local', projectPath, provider: other } : undefined
}
