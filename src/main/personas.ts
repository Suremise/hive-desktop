import { existsSync } from 'fs'
import { mkdir, readdir, readFile, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import { shell } from 'electron'
import { DEFAULT_PERSONA, newPersonaText, parsePersona, personaId } from '../shared/assistant'
import type { AssistantControl, PersonaInfo } from '../shared/types'
import { resourcesDir } from './paths'
import { workspace } from './workspace'

/**
 * The Hive Assistant's personas: Markdown files in the workspace's .hive/personas (a header with name,
 * description and icon, then the instructions). Hive ships four (resources/personas), copied into new
 * workspaces and restorable like the bundled skills.
 */

export function bundledPersonasDir(): string {
  return join(resourcesDir(), 'personas')
}

const validId = (id: string): boolean => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)

async function mdIds(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.md') && validId(f.slice(0, -3))).map((f) => f.slice(0, -3))
  } catch {
    return []
  }
}

const same = async (a: string, b: string): Promise<boolean> => {
  const [x, y] = await Promise.all([readFile(a, 'utf8').catch(() => null), readFile(b, 'utf8').catch(() => null)])
  return x !== null && y !== null && x.replace(/\r\n/g, '\n') === y.replace(/\r\n/g, '\n')
}

async function info(path: string, id: string): Promise<PersonaInfo> {
  const p = parsePersona(await readFile(path, 'utf8').catch(() => ''))
  return { id, name: p.name || id, description: p.description ?? '', icon: p.icon ?? '', path }
}

/** The workspace's personas, then the bundled ones it doesn't have (greyed out, with Restore). */
export async function listPersonas(): Promise<PersonaInfo[]> {
  if (!workspace.path) return []
  const bundled = new Set(await mdIds(bundledPersonasDir()))
  const out: PersonaInfo[] = []
  for (const id of await mdIds(workspace.personasDir)) {
    const p = await info(join(workspace.personasDir, `${id}.md`), id)
    if (bundled.has(id)) p.bundled = (await same(p.path, join(bundledPersonasDir(), `${id}.md`))) ? 'same' : 'changed'
    out.push(p)
  }
  for (const id of bundled) if (!out.some((p) => p.id === id)) out.push({ ...(await info(join(bundledPersonasDir(), `${id}.md`), id)), bundled: 'missing' })
  // The default first, then by name.
  return out.sort((a, b) => Number(b.id === DEFAULT_PERSONA) - Number(a.id === DEFAULT_PERSONA) || a.name.localeCompare(b.name))
}

/** Copies the bundled personas the workspace doesn't have (a new workspace, or one from before personas). */
export async function addBundledPersonas(): Promise<void> {
  await mkdir(workspace.personasDir, { recursive: true })
  for (const id of await mdIds(bundledPersonasDir())) {
    const dest = join(workspace.personasDir, `${id}.md`)
    if (!existsSync(dest)) await writeFile(dest, await readFile(join(bundledPersonasDir(), `${id}.md`)))
  }
}

export async function createPersona(name: string): Promise<PersonaInfo> {
  const id = personaId(name)
  if (!validId(id)) throw new Error('Give the persona a name with letters or numbers.')
  const path = join(workspace.personasDir, `${id}.md`)
  if (existsSync(path)) throw new Error(`There is already a persona called "${id}".`)
  await mkdir(workspace.personasDir, { recursive: true })
  await writeFile(path, newPersonaText(name.trim()), { flag: 'wx' })
  return info(path, id)
}

/** Moves a persona's file to the Recycle Bin. */
export async function deletePersona(id: string): Promise<void> {
  if (!validId(id)) throw new Error('Invalid persona')
  const path = join(workspace.personasDir, `${id}.md`)
  if (existsSync(path)) await shell.trashItem(path)
}

/** Puts back a bundled persona as this version of Hive ships it; the workspace's copy goes to the Recycle Bin. */
export async function restorePersona(id: string): Promise<PersonaInfo> {
  const src = join(bundledPersonasDir(), `${id}.md`)
  if (!validId(id) || !existsSync(src)) throw new Error(`"${id}" isn't one of Hive's personas.`)
  const dest = join(workspace.personasDir, `${id}.md`)
  if (existsSync(dest)) await shell.trashItem(dest)
  await mkdir(workspace.personasDir, { recursive: true })
  await writeFile(dest, await readFile(src))
  return { ...(await info(dest, id)), bundled: 'same' }
}

/** A persona's name and instructions: the workspace's file, else Hive's copy, else none. */
export async function readPersona(id: string): Promise<{ id: string; name: string; body: string } | null> {
  if (!validId(id)) return null
  for (const dir of [workspace.personasDir, bundledPersonasDir()]) {
    const text = await readFile(join(dir, `${id}.md`), 'utf8').catch(() => null)
    if (text === null) continue
    const p = parsePersona(text)
    return { id, name: p.name || id, body: p.body }
  }
  return null
}

/**
 * What the Assistant is told at launch, before its persona: who it is, what it looks after, and that for
 * now it only looks. The persona's instructions follow.
 */
/** What the Assistant may do, from Settings → Assistant → Control. It overrides anything a persona says about it. */
export function controlRules(control: AssistantControl): string {
  if (control === 'look') {
    return [
      'The user has set you to look and advise (Settings → Assistant → Control). Never edit or create files, run commands that change anything, or start, stop or prompt agents, even if asked: say what you would do and let the user do it, and mention that Settings → Assistant can let you act. (Writing to the shared notes with hive_write_shared_note or hive_create_handover is fine when the user asks.)'
    ].join('\n')
  }
  return [
    `You can run the agents for the user: add them (hive_add_agent), change their settings (hive_update_agent), start and stop them, and give idle ones tasks (hive_prompt_agent)${control === 'projects' ? ', and create projects (hive_create_project) when the user asks for one' : ''}. Act when the user asks you to, or agrees to a plan you proposed; otherwise say what you would do.`,
    '- Hive\'s tools are how you act. Never edit or create project files or run commands that change anything yourself: the agents do the work.',
    '- Write each task in full. An agent sees only what you give it: what to do, where, what done looks like, and to report back when finished.',
    '- Give tasks only to idle agents. Never interrupt one that is working, never answer a question an agent is asking the user (tell the user), and leave alone an agent the user has just typed in. hive_wait_for_agents waits for them; hive_agent_activity shows what one is doing.',
    '- Agents sharing a folder must not edit the same files: split the work by files, or give one its own worktree. Add a worktree only if the user asked for one, or after asking them.',
    "- To pass one agent's work to another (e.g. a review to the agent that fixes it), use hive_hand_over: Hive has the first write a handover, waits for it, and starts the second on it.",
    "- The task board is the shared list of work. Plan multi-step work as cards (hive_create_task, with a project and a description complete enough to work from), start them on agents with hive_start_task, and keep them current (hive_update_task). Only the user moves cards to Done: you can ask, and Hive puts the question to them.",
    '- Stopping a busy agent asks the user first: give your reason. An agent asking to trust its folder is waiting for the user: tell them.',
    "- You can't remove agents, discard worktrees, archive or delete cards, or hide, remove or delete projects: tell the user how if it's needed. Hive allows 30 changes for one message from the user.",
    '- Afterwards, say briefly what you did.',
    'These rules come from the user\'s settings and replace anything your persona says about what you may do.'
  ].join('\n')
}

export async function assistantInstructions(personaIdValue: string, control: AssistantControl = 'projects'): Promise<{ text: string; persona: string }> {
  const ws = workspace.path ?? ''
  const projects = (await workspace.listProjectPaths()).map((p) => basename(p))
  const persona = (await readPersona(personaIdValue)) ?? (await readPersona(DEFAULT_PERSONA))
  const text = [
    `You are the Hive Assistant: the overseer of the workspace "${basename(ws)}" (${ws}), running in Hive's side panel. The user talks to you here while coding agents work in the workspace's projects.`,
    `The projects are the folders in the workspace: ${projects.length ? projects.join(', ') : '(none yet)'}. Each can run up to twelve agents (Claude Code or Codex), some in their own git worktrees. You work in the workspace folder, so you can read any project's files.`,
    "Use the hive tools to see the workspace: hive_list_projects and hive_project_status for projects, agents and what they are doing; hive_list_tasks and hive_read_task for the task board (the work planned, in progress, waiting for review and done); hive_session_usage for tokens and cost; the shared notes and handovers for decisions and hand-offs. Read files when you need more.",
    "Waiting: an agent waiting on background tasks it started (such as a test run) shows as background, not finished, and carries on by itself when they end; hive_wait_for_agents waits through that. Nothing wakes you except the user and your own tool calls returning, so never say you'll check again later unless a wait is actually running. To follow a long job, call hive_wait_for_agents again each time it returns still working (never sleep). If you stop waiting, say so plainly and that the user will need to ask you to look again.",
    controlRules(control),
    'Be brief. Your character is flavour: clarity comes first. Drop it and speak plainly for errors, security problems, anything risky, and anything the user must decide.',
    '',
    persona ? `# Your persona: ${persona.name}\n\n${persona.body}` : ''
  ].join('\n')
  return { text, persona: persona?.name ?? '' }
}
