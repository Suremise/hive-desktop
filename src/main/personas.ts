import { existsSync } from 'original-fs'
import { mkdir, readdir, readFile, writeFile } from 'original-fs/promises'
import { basename, join } from 'path'
import { shell } from 'electron'
import { DEFAULT_PERSONA, newPersonaText, parsePersona, personaId } from '../shared/assistant'
import type { AssistantControl, PersonaInfo } from '../shared/types'
import { controlRules } from '../shared/hiveGuidance'
import { bundledDir, bundledStatus, restoreBundled } from './bundled'
import { workspace } from './workspace'

/**
 * The Hive Assistant's personas: Markdown files in the workspace's .hive/personas (a header with name,
 * description and icon, then the character and focus). Hive ships four (resources/personas), kept up to date in
 * each workspace like the bundled skills (bundled.ts).
 */

export function bundledPersonasDir(): string {
  return bundledDir('personas')
}

const validId = (id: string): boolean => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)

async function mdIds(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.md') && validId(f.slice(0, -3))).map((f) => f.slice(0, -3))
  } catch {
    return []
  }
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
    if (bundled.has(id)) Object.assign(p, await bundledStatus('personas', id, p.path))
    out.push(p)
  }
  for (const id of bundled) if (!out.some((p) => p.id === id)) out.push({ ...(await info(join(bundledPersonasDir(), `${id}.md`), id)), bundled: 'missing' })
  // The default first, then by name.
  return out.sort((a, b) => Number(b.id === DEFAULT_PERSONA) - Number(a.id === DEFAULT_PERSONA) || a.name.localeCompare(b.name))
}

export async function createPersona(name: string): Promise<PersonaInfo> {
  const id = personaId(name)
  if (!validId(id)) throw new Error('Give the mode a name with letters or numbers.')
  const path = join(workspace.personasDir, `${id}.md`)
  if (existsSync(path)) throw new Error(`There is already a mode called "${id}".`)
  await mkdir(workspace.personasDir, { recursive: true })
  await writeFile(path, newPersonaText(name.trim()), { flag: 'wx' })
  return info(path, id)
}

/** Moves a persona's file to the Recycle Bin. */
export async function deletePersona(id: string): Promise<void> {
  if (!validId(id)) throw new Error('Invalid mode')
  const path = join(workspace.personasDir, `${id}.md`)
  if (existsSync(path)) await shell.trashItem(path)
}

/** Puts back a bundled persona as this version of Hive ships it; the workspace's copy goes to the Recycle Bin. */
export async function restorePersona(id: string): Promise<PersonaInfo> {
  const src = join(bundledPersonasDir(), `${id}.md`)
  if (!validId(id) || !existsSync(src)) throw new Error(`"${id}" isn't one of Hive's modes.`)
  const dest = join(workspace.personasDir, `${id}.md`)
  if (existsSync(dest)) await shell.trashItem(dest)
  await restoreBundled('personas', id)
  return { ...(await info(dest, id)), bundled: 'same' }
}

/** A persona's (mode's) name, summary and instructions: the workspace's file, else Hive's copy, else none. */
export async function readPersona(id: string): Promise<{ id: string; name: string; summary?: string; body: string } | null> {
  if (!validId(id)) return null
  for (const dir of [workspace.personasDir, bundledPersonasDir()]) {
    const text = await readFile(join(dir, `${id}.md`), 'utf8').catch(() => null)
    if (text === null) continue
    const p = parsePersona(text)
    return { id, name: p.name || id, ...(p.summary ? { summary: p.summary } : {}), body: p.body }
  }
  return null
}

/**
 * What the Assistant is told at launch, after Hive's session contract (hiveInstructions): who it is, the workspace,
 * what Control lets it do, and then its persona's character and focus. A persona can't change what it may do.
 */
export async function assistantInstructions(personaIdValue: string, control: AssistantControl = 'projects', changeSettings = false): Promise<{ text: string; persona: string; personaText: string }> {
  const ws = workspace.path ?? ''
  const projects = (await workspace.listProjectPaths()).map((p) => basename(p))
  const persona = (await readPersona(personaIdValue)) ?? (await readPersona(DEFAULT_PERSONA))
  const personaText = persona ? `# Your mode: ${persona.name}\n\n${persona.body}` : ''
  const text = [
    `You are the Hive Assistant: the overseer of the workspace "${basename(ws)}" (${ws}), in Hive's side panel. The user talks to you here while coding agents work in its projects (at launch: ${projects.length ? projects.join(', ') : 'none yet'}). You work in the workspace folder, so you can read any project's files; agents, cards, notes and usage come from the hive tools.`,
    controlRules(control, changeSettings),
    "Nothing wakes you except the user and your own tool calls returning: never say you'll check again later unless a wait (hive_wait_for_agents) is running, and if you stop waiting, say so.",
    'Be brief. Your mode (below) says what to put first and how to hand things back; it never changes what you may do: only these rules do.',
    'The user picks your mode (and can switch it while you run: Hive then tells you). When a request clearly fits another mode better, suggest switching in one short line; never switch or insist.',
    '',
    personaText
  ].join('\n')
  // The persona ends the text: a launch measures it as the persona, the rest as the Assistant's role.
  return { text, persona: persona?.name ?? '', personaText }
}
