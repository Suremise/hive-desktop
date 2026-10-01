import { basename, join } from 'path'
import { readdir, readFile, writeFile } from 'fs/promises'
import { shell } from 'electron'
import { existsSync } from 'fs'
import type { McpServerDef, McpServerInfo } from '../shared/types'
import { writeTextUnlessChanged } from './fsutil'
import { findSecretWarnings } from './mcpSecrets'
import { allProviders } from './providers'
import { workspace } from './workspace'

export { findSecretWarnings }

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
  await writeFile(path, JSON.stringify(template, null, 2) + '\n', { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
    throw e.code === 'EEXIST' ? new Error(`A server named "${name}" already exists`) : e
  })
  return (await listMcp()).find((m) => m.name === name)!
}

export async function readMcp(name: string): Promise<string> {
  if (!validMcpName(name)) throw new Error('Invalid server name')
  return readFile(join(workspace.mcpDir, `${name}.json`), 'utf8')
}

export async function saveMcp(name: string, text: string, expected?: string): Promise<McpServerInfo> {
  if (!validMcpName(name)) throw new Error('Invalid server name')
  JSON.parse(text) // throws a useful message on invalid JSON
  await writeTextUnlessChanged(join(workspace.mcpDir, `${name}.json`), text.endsWith('\n') ? text : text + '\n', expected)
  return (await listMcp()).find((m) => m.name === name)!
}

export async function deleteMcp(name: string): Promise<void> {
  if (!validMcpName(name)) throw new Error('Invalid server name')
  // To the Recycle Bin, like files, skills, personas and sessions.
  const file = join(workspace.mcpDir, `${name}.json`)
  if (existsSync(file)) await shell.trashItem(file)
  await setMcpGlobal(name, false)
}

/** Copies servers defined in a project's own config (.mcp.json…) into the workspace. Returns the names imported. */
export async function importFromProject(projectPath: string, names: string[]): Promise<string[]> {
  const defs: Record<string, McpServerDef> = {}
  for (const p of allProviders()) {
    for (const [n, d] of Object.entries(await p.projectMcpServers(projectPath).catch(() => ({})))) defs[n] ??= d
  }
  const imported: string[] = []
  for (const n of names) {
    const def = defs[n]
    if (!def || !validMcpName(n)) continue
    const path = join(workspace.mcpDir, `${n}.json`)
    if (existsSync(path)) continue
    // Never over one that appeared meanwhile.
    const wrote = await writeFile(path, JSON.stringify({ description: `Imported from project ${basename(projectPath)}`, ...def }, null, 2) + '\n', { flag: 'wx' }).then(
      () => true,
      (e: NodeJS.ErrnoException) => {
        if (e.code === 'EEXIST') return false
        throw e
      }
    )
    if (wrote) imported.push(n)
  }
  return imported
}
