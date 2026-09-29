import { basename, join } from 'path'
import { readdir, readFile, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import type { McpServerDef, McpServerInfo } from '../shared/types'
import { readJson, writeTextAtomic } from './fsutil'
import { workspace } from './workspace'

const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|credential|private[_-]?key|authorization)/i
const SECRET_VALUE = /^(sk-[A-Za-z0-9]|ghp_|gho_|github_pat_|xox[abp]-|AKIA[0-9A-Z]{12}|AIza[0-9A-Za-z_-]{20}|glpat-)/

function isEnvRef(v: string): boolean {
  const t = v.trim()
  return /^\$\{[^}]+\}$/.test(t) || /^\$[A-Z_][A-Z0-9_]*$/.test(t)
}

/** Flags values that look like literal secrets rather than ${ENV} references. */
export function findSecretWarnings(def: McpServerDef): string[] {
  const warnings: string[] = []
  const check = (where: string, key: string, raw: unknown): void => {
    if (typeof raw !== 'string') return
    const value = raw.replace(/^Bearer\s+/i, '').trim()
    if (!value || isEnvRef(value) || value.includes('${')) return
    if (SECRET_VALUE.test(value) || (SECRET_KEY.test(key) && value.length >= 8)) {
      const envName = key.toUpperCase().replace(/[^A-Z0-9]/g, '_')
      warnings.push(`${where} "${key}" looks like a literal secret. Use an environment variable reference such as "\${${envName}}".`)
    }
  }
  for (const [k, v] of Object.entries(def.env ?? {})) check('env', k, v)
  for (const [k, v] of Object.entries(def.headers ?? {})) check('header', k, v)
  for (const a of def.args ?? []) {
    if (typeof a === 'string' && SECRET_VALUE.test(a.trim())) warnings.push(`An argument starting "${a.slice(0, 6)}…" looks like a literal secret.`)
  }
  return warnings
}

export async function listMcp(): Promise<McpServerInfo[]> {
  if (!workspace.path) return []
  const enabled = new Set(workspace.config.mcp.enabled)
  let files: string[] = []
  try {
    files = (await readdir(workspace.mcpDir)).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const out: McpServerInfo[] = []
  for (const f of files.sort()) {
    const name = f.slice(0, -5)
    const path = join(workspace.mcpDir, f)
    try {
      const def = JSON.parse(await readFile(path, 'utf8')) as McpServerDef
      if (!def || typeof def !== 'object' || Array.isArray(def)) throw new Error('Definition must be a JSON object')
      if (!def.command && !def.url) throw new Error('Definition needs a "command" (stdio) or a "url" (http/sse)')
      out.push({ name, path, def, globallyEnabled: enabled.has(name), secretWarnings: findSecretWarnings(def) })
    } catch (e) {
      out.push({ name, path, def: null, error: (e as Error).message, globallyEnabled: enabled.has(name), secretWarnings: [] })
    }
  }
  return out
}

/** Converts a stored definition into the entry written to launch/mcp.json. */
export function toLaunchDef(def: McpServerDef, mcpDir: string): McpServerDef {
  const { description: _description, ...rest } = def
  const dir = mcpDir.replace(/\\/g, '/')
  const expand = (v: string): string => v.replace(/\$\{HIVE_MCP_DIR\}/g, dir)
  const out: McpServerDef = { ...rest }
  if (typeof out.command === 'string') out.command = expand(out.command)
  if (Array.isArray(out.args)) out.args = out.args.map((a) => (typeof a === 'string' ? expand(a) : a))
  if (out.env) out.env = Object.fromEntries(Object.entries(out.env).map(([k, v]) => [k, typeof v === 'string' ? expand(v) : v]))
  if (typeof out.cwd === 'string') out.cwd = expand(out.cwd)
  return out
}

export async function setMcpGlobal(name: string, enabled: boolean): Promise<void> {
  const set = new Set(workspace.config.mcp.enabled)
  if (enabled) set.add(name)
  else set.delete(name)
  workspace.config.mcp.enabled = [...set].sort()
  await workspace.saveWorkspaceConfig()
}

export async function setMcpProject(projectPath: string, name: string, enabled: boolean): Promise<void> {
  await workspace.mutateProjectConfig(projectPath, (cfg) => {
    const set = new Set(cfg.mcp.disabled)
    if (enabled) set.delete(name)
    else set.add(name)
    return { mcp: { ...cfg.mcp, disabled: [...set].sort() } }
  })
}

export function validMcpName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name) && name !== 'hive'
}

export async function createMcp(name: string): Promise<McpServerInfo> {
  if (!validMcpName(name)) throw new Error('Server names may contain letters, numbers, "-" and "_" (max 64 characters). "hive" is reserved.')
  const path = join(workspace.mcpDir, `${name}.json`)
  if (existsSync(path)) throw new Error(`A server named "${name}" already exists`)
  const template: McpServerDef = {
    description: 'Describe what this server provides.',
    command: 'npx',
    args: ['-y', 'your-mcp-server-package'],
    env: { EXAMPLE_TOKEN: '${EXAMPLE_TOKEN}' }
  }
  await writeFile(path, JSON.stringify(template, null, 2) + '\n')
  return (await listMcp()).find((m) => m.name === name)!
}

export async function readMcp(name: string): Promise<string> {
  if (!validMcpName(name)) throw new Error('Invalid server name')
  return readFile(join(workspace.mcpDir, `${name}.json`), 'utf8')
}

export async function saveMcp(name: string, text: string): Promise<McpServerInfo> {
  if (!validMcpName(name)) throw new Error('Invalid server name')
  JSON.parse(text) // throws a useful message on invalid JSON
  await writeTextAtomic(join(workspace.mcpDir, `${name}.json`), text.endsWith('\n') ? text : text + '\n')
  return (await listMcp()).find((m) => m.name === name)!
}

export async function deleteMcp(name: string): Promise<void> {
  if (!validMcpName(name)) throw new Error('Invalid server name')
  await rm(join(workspace.mcpDir, `${name}.json`), { force: true })
  await setMcpGlobal(name, false)
}

/** Copies servers defined in a project's own .mcp.json into the workspace. Returns the names imported. */
export async function importFromProject(projectPath: string, names: string[]): Promise<string[]> {
  const j = await readJson<{ mcpServers?: Record<string, McpServerDef> }>(join(projectPath, '.mcp.json'), {})
  const imported: string[] = []
  for (const n of names) {
    const def = j.mcpServers?.[n]
    if (!def || !validMcpName(n)) continue
    const path = join(workspace.mcpDir, `${n}.json`)
    if (existsSync(path)) continue
    await writeFile(path, JSON.stringify({ description: `Imported from project ${basename(projectPath)}`, ...def }, null, 2) + '\n')
    imported.push(n)
  }
  return imported
}
