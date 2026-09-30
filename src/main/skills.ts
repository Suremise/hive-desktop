import { join, basename, relative, sep } from 'path'
import { mkdir, readdir, readFile, writeFile } from 'fs/promises'
import { existsSync, type Dirent } from 'fs'
import type { SkillInfo } from '../shared/types'
import { allProviders } from './providers'
import { copyDir, isDir, isFile } from './fsutil'
import { workspace } from './workspace'

/** Reads `name` and `description` from a SKILL.md YAML frontmatter block. */
export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  const m = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return {}
  const out: Record<string, string> = {}
  const lines = m[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_-]+):\s*(.*)$/)
    if (!kv) continue
    let value = kv[2].trim()
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      const block: string[] = []
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) block.push(lines[++i].trim())
      value = block.join(value.startsWith('|') ? '\n' : ' ')
    }
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\(["\\])/g, '$1')
    else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/''/g, "'")
    out[kv[1]] = value
  }
  return { name: out.name, description: out.description }
}

async function readSkill(dir: string, level: SkillInfo['level'], plugin?: string): Promise<SkillInfo | null> {
  const f = join(dir, 'SKILL.md')
  if (!(await isFile(f))) return null
  const fm = parseSkillFrontmatter(await readFile(f, 'utf8').catch(() => ''))
  return { name: fm.name || basename(dir), description: fm.description ?? '', level, path: dir, plugin }
}

/** Recursively finds skill folders (containing SKILL.md) under a root, skipping dot-folders. */
async function findSkills(root: string, level: SkillInfo['level'], maxDepth: number): Promise<SkillInfo[]> {
  const out: SkillInfo[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return
    const s = await readSkill(dir, level)
    if (s) {
      out.push(s)
      return
    }
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') await walk(join(dir, e.name), depth + 1)
    }
  }
  await walk(root, 0)
  return out
}

let machineCache: { at: number; skills: SkillInfo[] } | null = null

/** Skills each provider's CLI loads from the user's profile and its installed plugins. */
async function machineSkills(): Promise<SkillInfo[]> {
  if (machineCache && Date.now() - machineCache.at < 30_000) return machineCache.skills
  const all: SkillInfo[] = []
  for (const p of allProviders()) {
    const roots = p.skillRoots()
    const skills: SkillInfo[] = []
    for (const dir of roots.machine) skills.push(...(await findSkills(dir, 'machine', 4)))
    const pluginSkills = roots.plugins ? await findSkills(roots.plugins, 'plugin', 7) : []
    for (const s of pluginSkills) {
      // .../<plugin>/[<version>/]skills/<skill> → the plugin name is the folder above "skills" (or above the version).
      const parts = relative(roots.plugins!, s.path).split(sep)
      const i = parts.lastIndexOf('skills')
      let plugin = i > 0 ? parts[i - 1] : parts[0]
      if (/^\d+\.\d+/.test(plugin) && i > 1) plugin = parts[i - 2]
      s.plugin = plugin
    }
    const seen = new Set<string>()
    for (const s of [...skills, ...pluginSkills]) {
      const k = `${s.level}:${s.plugin ?? ''}:${s.name}`
      if (seen.has(k)) continue
      seen.add(k)
      all.push({ ...s, provider: p.id })
    }
  }
  machineCache = { at: Date.now(), skills: all }
  return all
}

export async function hiveSkills(): Promise<SkillInfo[]> {
  if (!workspace.path) return []
  const enabled = new Set(workspace.config.skills.enabled)
  const out: SkillInfo[] = []
  let entries: Dirent[] = []
  try {
    entries = await readdir(workspace.skillsDir, { withFileTypes: true })
  } catch {
    return []
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const s = await readSkill(join(workspace.skillsDir, e.name), 'hive')
    if (s) {
      // The folder name is the identity Hive uses for enablement and copying.
      s.name = e.name
      s.globallyEnabled = enabled.has(e.name)
      out.push(s)
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Skills in the project's own folders for each provider (e.g. .claude/skills), without Hive's copies there. */
export async function localSkills(projectPath: string): Promise<SkillInfo[]> {
  const out: SkillInfo[] = []
  for (const p of allProviders()) {
    const roots = p.skillRoots()
    if (!roots.local) continue
    const dir = join(projectPath, roots.local)
    if (!(await isDir(dir))) continue
    for (const s of await findSkills(dir, 'local', 2)) {
      if (roots.hiveCopyPrefix && basename(s.path).startsWith(roots.hiveCopyPrefix)) continue
      out.push({ ...s, provider: p.id })
    }
  }
  return out
}

export async function listSkills(projectPath?: string): Promise<SkillInfo[]> {
  const out = [...(await hiveSkills()), ...(await machineSkills())]
  if (projectPath) out.push(...(await localSkills(projectPath)))
  return out
}

export function invalidateSkillCache(): void {
  machineCache = null
}

export async function setSkillGlobal(name: string, enabled: boolean): Promise<void> {
  const set = new Set(workspace.config.skills.enabled)
  if (enabled) set.add(name)
  else set.delete(name)
  workspace.config.skills.enabled = [...set].sort()
  await workspace.saveWorkspaceConfig()
}

export async function setSkillProject(projectPath: string, name: string, enabled: boolean): Promise<void> {
  await workspace.mutateProjectConfig(projectPath, (cfg) => {
    const set = new Set(cfg.skills.disabled)
    if (enabled) set.delete(name)
    else set.add(name)
    return { skills: { ...cfg.skills, disabled: [...set].sort() } }
  })
}

export function validSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)
}

export async function createSkill(name: string, description: string): Promise<SkillInfo> {
  if (!validSkillName(name)) throw new Error('Skill names may contain letters, numbers, "-" and "_" (max 64 characters).')
  const dir = join(workspace.skillsDir, name)
  if (existsSync(dir)) throw new Error(`A skill named "${name}" already exists`)
  await mkdir(dir, { recursive: true })
  const plain = description.trim().replace(/\s*\n\s*/g, ' ') || 'Describe when the agent should use this skill.'
  // Quoted when YAML would read it as something else ("Use for: x", "# notes", a leading quote…).
  const desc = /[:#]|^[\s'"&*!|>%@`{[\]-]/.test(plain) ? `"${plain.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : plain
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\nWrite the instructions the agent should follow when this skill applies.\n`
  )
  const s = (await readSkill(dir, 'hive'))!
  s.name = name
  s.globallyEnabled = false
  return s
}

/** Deploys a Local or Machine skill into the workspace so Hive can manage it. */
export async function copySkillToWorkspace(skillPath: string): Promise<SkillInfo> {
  const name = basename(skillPath)
  if (!validSkillName(name)) throw new Error(`"${name}" can't be a Hive skill name: use letters, numbers, "-" and "_" (rename the folder first).`)
  const dest = join(workspace.skillsDir, name)
  if (existsSync(dest)) throw new Error(`The workspace already has a skill named "${name}"`)
  if (!(await isFile(join(skillPath, 'SKILL.md')))) throw new Error('Not a skill folder (no SKILL.md)')
  await copyDir(skillPath, dest)
  const s = (await readSkill(dest, 'hive'))!
  s.name = name
  s.globallyEnabled = false
  return s
}
