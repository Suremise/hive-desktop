import { join, basename, relative, sep } from 'path'
import { mkdir, readdir, readFile, writeFile } from 'fs/promises'
import { existsSync, type Dirent } from 'fs'
import type { SkillInfo } from '../shared/types'
import { claudeHome } from './agents/claude-code'
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
    out[kv[1]] = value.replace(/^["']|["']$/g, '')
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

async function machineSkills(): Promise<SkillInfo[]> {
  if (machineCache && Date.now() - machineCache.at < 30_000) return machineCache.skills
  const skills = await findSkills(join(claudeHome(), 'skills'), 'machine', 4)
  const pluginRoot = join(claudeHome(), 'plugins')
  const pluginSkills = await findSkills(pluginRoot, 'plugin', 7)
  for (const s of pluginSkills) {
    // .../<plugin>/[<version>/]skills/<skill> → the plugin name is the folder above "skills" (or above the version).
    const parts = relative(pluginRoot, s.path).split(sep)
    const i = parts.lastIndexOf('skills')
    let plugin = i > 0 ? parts[i - 1] : parts[0]
    if (/^\d+\.\d+/.test(plugin) && i > 1) plugin = parts[i - 2]
    s.plugin = plugin
  }
  const seen = new Set<string>()
  const all = [...skills, ...pluginSkills].filter((s) => {
    const k = `${s.level}:${s.plugin ?? ''}:${s.name}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
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

export async function localSkills(projectPath: string): Promise<SkillInfo[]> {
  const dir = join(projectPath, '.claude', 'skills')
  if (!(await isDir(dir))) return []
  return findSkills(dir, 'local', 2)
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
  const cfg = await workspace.projectConfig(projectPath)
  const set = new Set(cfg.skills.disabled)
  if (enabled) set.delete(name)
  else set.add(name)
  await workspace.updateProjectConfig(projectPath, { skills: { disabled: [...set].sort() } })
}

export function validSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)
}

export async function createSkill(name: string, description: string): Promise<SkillInfo> {
  if (!validSkillName(name)) throw new Error('Skill names may contain letters, numbers, "-" and "_" (max 64 characters).')
  const dir = join(workspace.skillsDir, name)
  if (existsSync(dir)) throw new Error(`A skill named "${name}" already exists`)
  await mkdir(dir, { recursive: true })
  const desc = description.trim().replace(/\n/g, ' ') || 'Describe when the agent should use this skill.'
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
  const dest = join(workspace.skillsDir, name)
  if (existsSync(dest)) throw new Error(`The workspace already has a skill named "${name}"`)
  if (!(await isFile(join(skillPath, 'SKILL.md')))) throw new Error('Not a skill folder (no SKILL.md)')
  await copyDir(skillPath, dest)
  const s = (await readSkill(dest, 'hive'))!
  s.name = name
  s.globallyEnabled = false
  return s
}
