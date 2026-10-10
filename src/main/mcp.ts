import { basename, dirname, extname, join } from 'path'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'original-fs/promises'
import { existsSync } from 'original-fs'
import { unzipSync } from 'fflate'
import type { McpFileServer, McpServerDef, McpServerInfo, McpShown } from '../shared/types'
import { writeTextUnlessChanged } from './fsutil'
import { findSecretWarnings } from './mcpSecrets'
import { allProviders } from './providers'
import { workspace } from './workspace'
import { trash } from './trash'

export { findSecretWarnings }

/** A whole `${VAR}` reference, shown as itself: what it holds comes from the environment when the server starts. */
const ENV_REF = /^\$\{[^}]+\}$/

/**
 * What a server runs, as lines to show before it is enabled (#550): the command and its arguments, or the URL it
 * connects to, its folder, and its environment variables and headers by name (a `${VAR}` reference shown as itself,
 * never a literal value).
 */
export function mcpRuns(def: McpServerDef): string[] {
  const quoted = (a: string): string => (/[\s"]/.test(a) || !a ? JSON.stringify(a) : a)
  const out: string[] = []
  if (typeof def.command === 'string') out.push(`Runs: ${[def.command, ...(Array.isArray(def.args) ? def.args : [])].map((a) => quoted(String(a))).join(' ')}`)
  if (typeof def.url === 'string') out.push(`Connects to: ${def.url}${typeof def.type === 'string' ? ` (${def.type})` : ''}`)
  if (typeof def.cwd === 'string') out.push(`In: ${def.cwd}`)
  const named = (label: string, rec: unknown): void => {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return
    const items = Object.entries(rec as Record<string, unknown>).map(([k, v]) => (typeof v === 'string' && ENV_REF.test(v.trim()) ? `${k}=${v.trim()}` : `${k} (set)`))
    if (items.length) out.push(`${label}: ${items.join(', ')}`)
  }
  named('Environment', def.env)
  named('Headers', def.headers)
  return out
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
      // Before the text: a revision never stands for newer text than what is shown.
      const revision = (await mcpRevision(path)) ?? undefined
      const def = JSON.parse(await readFile(path, 'utf8')) as McpServerDef
      if (!def || typeof def !== 'object' || Array.isArray(def)) throw new Error('Definition must be a JSON object')
      if (!def.command && !def.url) throw new Error('Definition needs a "command" (stdio) or a "url" (http/sse)')
      out.push({ name, path, def, revision, globallyEnabled: enabled.has(name), secretWarnings: findSecretWarnings(def), runs: mcpRuns(def) })
    } catch (e) {
      out.push({ name, path, def: null, error: (e as Error).message, globallyEnabled: enabled.has(name), secretWarnings: [], runs: [] })
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

/**
 * Adding, replacing and deleting servers and turning them on take turns (#550), so an enable can't land in the
 * middle of a replace and leave the new server on. Callers inside a turn use setGlobalNow.
 */
let mcpTurn: Promise<unknown> = Promise.resolve()
function inTurn<T>(fn: () => Promise<T>): Promise<T> {
  const run = mcpTurn.then(fn)
  mcpTurn = run.catch(() => undefined)
  return run
}

async function setGlobalNow(name: string, enabled: boolean): Promise<void> {
  const set = new Set(workspace.config.mcp.enabled)
  if (enabled) set.add(name)
  else set.delete(name)
  workspace.config.mcp.enabled = [...set].sort()
  await workspace.saveWorkspaceConfig()
}

/**
 * Turns a server on or off for every project. Turning it on with `expected`, the definition the user was shown what it
 * runs from: refused when the definition is no longer that one (replaced or edited meanwhile), so a server never goes
 * on with a definition the user hasn't seen.
 */
export function setMcpGlobal(name: string, enabled: boolean, expected?: McpShown): Promise<void> {
  return inTurn(async () => {
    if (enabled && expected) {
      const path = join(workspace.mcpDir, `${name}.json`)
      // The installation (a replace writes a new file, even with the same text and new code beside it) and the text.
      const revision = await mcpRevision(path)
      const now = await readFile(path, 'utf8').then((t) => JSON.parse(t) as unknown, () => null)
      if (!now || !revision || revision !== expected.revision || JSON.stringify(now) !== JSON.stringify(expected.def)) throw new Error(`${name} has changed since it was shown to you. Check what it runs and enable it again.`)
    }
    await setGlobalNow(name, enabled)
  })
}

/**
 * Which copy of a server's definition this is: its file's identity, modified time and size. Adding or replacing a
 * server writes a new file, so a replace changes it even when the definition's text is the same (an upgrade of the
 * code beside it); an edit changes it too. Null when there is no such file.
 */
async function mcpRevision(path: string): Promise<string | null> {
  const s = await stat(path, { bigint: true }).catch(() => null)
  return s ? `${s.ino}:${s.mtimeNs}:${s.size}` : null
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
  return inTurn(async () => {
    // To the Recycle Bin, like files, skills, personas and sessions.
    const file = join(workspace.mcpDir, `${name}.json`)
    // Its folder too, when its definition runs what is in it (a server added from a .zip, #550). A definition that
    // can't be read as one (broken JSON, not an object) says nothing about a folder: only the file goes.
    const folder = join(workspace.mcpDir, name)
    const def = await readFile(file, 'utf8').then(
      (t) => {
        try {
          const d = JSON.parse(t) as unknown
          return d && typeof d === 'object' && !Array.isArray(d) ? (d as McpServerDef) : null
        } catch {
          return null
        }
      },
      () => null
    )
    if (def && existsSync(folder) && usesFolder(def, name)) await trash(folder)
    if (existsSync(file)) await trash(file)
    await setGlobalNow(name, false)
  })
}

/** Whether a definition runs what is in `${HIVE_MCP_DIR}/<folder>/` (its command, arguments, environment or folder). */
function usesFolder(def: McpServerDef, folder: string): boolean {
  return mcpValues(def).some((v) => folderRef(folder).test(v))
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** `${HIVE_MCP_DIR}/<folder>` followed by a slash or the end, either slash, any case (Windows paths). */
const folderRef = (folder: string): RegExp => new RegExp(`\\$\\{HIVE_MCP_DIR\\}[\\\\/]${escapeRe(folder)}(?=[\\\\/]|$|["'\\s])`, 'gi')

/** The strings of a definition that can name its files. */
function mcpValues(def: McpServerDef): string[] {
  return [def.command, def.cwd, ...(Array.isArray(def.args) ? def.args : []), ...Object.values(def.env ?? {})].filter((v): v is string => typeof v === 'string')
}

// ---------------------------------------------------------------------------
// Add MCP Server from File (#550): a .json definition, or a .zip of a server's folder with its definition.
// ---------------------------------------------------------------------------

/** The definition a server .zip carries, the first found: Hive's own name, then the mcp repo's example (USER_GUIDE). */
export const MCP_ZIP_DEFINITIONS = ['hive-mcp.json', 'hive-mcp.example.json']
/** Limits, so a mistaken pick (a big archive) fails quickly instead of filling the disk. */
const MCP_ZIP_MAX_FILES = 5000
const MCP_ZIP_MAX_BYTES = 200 * 1024 * 1024
const MCP_JSON_MAX_BYTES = 1024 * 1024

/** A definition from a file, checked as launches need it, so a broken one is never added. */
export function checkMcpDef(raw: unknown): McpServerDef {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The definition must be a JSON object, as in .hive/mcp/<name>.json.')
  const def = raw as McpServerDef
  if (typeof def.command !== 'string' && typeof def.url !== 'string') throw new Error('The definition needs a "command" (a server Hive starts) or a "url" (an http or sse server).')
  if (def.command !== undefined && (typeof def.command !== 'string' || !def.command.trim())) throw new Error('"command" must be the program to run.')
  if (def.url !== undefined && (typeof def.url !== 'string' || !/^https?:\/\//i.test(def.url))) throw new Error('"url" must be an http:// or https:// address.')
  if (def.args !== undefined && (!Array.isArray(def.args) || def.args.some((a) => typeof a !== 'string'))) throw new Error('"args" must be a list of strings.')
  for (const k of ['env', 'headers'] as const) {
    const v = def[k]
    if (v !== undefined && (!v || typeof v !== 'object' || Array.isArray(v) || Object.values(v).some((x) => typeof x !== 'string'))) throw new Error(`"${k}" must be an object of strings.`)
  }
  if (def.cwd !== undefined && typeof def.cwd !== 'string') throw new Error('"cwd" must be a folder.')
  return def
}

/** Characters and names Windows can't have in a path part, and parts that leave the folder. */
function unsafePart(p: string): boolean {
  return !p || p === '.' || p === '..' || /[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p)
}

/** The names of a zip's entries that are symbolic links (a Unix mode in its central directory): one could point outside. */
export function zipLinks(data: Uint8Array): string[] {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let end = -1
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error("The .zip can't be read: it has no list of its files.")
  const count = v.getUint16(end + 10, true)
  let at = v.getUint32(end + 16, true)
  const links: string[] = []
  for (let n = 0; n < count && at + 46 <= data.length && v.getUint32(at, true) === 0x02014b50; n++) {
    const nameLength = v.getUint16(at + 28, true)
    // Made on Unix (3), with the file type in the high half of its attributes: a link (0o120000).
    if (v.getUint8(at + 5) === 3 && ((v.getUint32(at + 38, true) >>> 16) & 0o170000) === 0o120000) links.push(new TextDecoder().decode(data.subarray(at + 46, at + 46 + nameLength)))
    at += 46 + nameLength + v.getUint16(at + 30, true) + v.getUint16(at + 32, true)
  }
  return links
}

/**
 * A server .zip: its definition (MCP_ZIP_DEFINITIONS) at the top, or inside one folder (which is dropped), and the
 * other files, which become .hive/mcp/<name>/. Refused: links, paths that would land outside the folder or that
 * Windows can't hold, too many files or bytes. Nothing in it runs.
 */
export function serverFromZip(data: Uint8Array): { def: McpServerDef; files: Map<string, Uint8Array>; folder: string | null } {
  const links = zipLinks(data)
  if (links.length) throw new Error(`The .zip has a link, which Hive doesn't unpack: ${links[0]}`)
  let total = 0
  const entries = unzipSync(data, {
    filter: (f) => {
      total += f.originalSize
      if (total > MCP_ZIP_MAX_BYTES) throw new Error('The .zip is too large for an MCP server (over 200 MB unpacked).')
      return true
    }
  })
  const norm = (n: string): string => n.replace(/\\/g, '/')
  const names = Object.keys(entries).filter((n) => !norm(n).endsWith('/') && !/(^|\/)(__MACOSX|\.DS_Store)(\/|$)/.test(norm(n)))
  if (names.length > MCP_ZIP_MAX_FILES) throw new Error(`The .zip has too many files for an MCP server (over ${MCP_ZIP_MAX_FILES}).`)
  for (const n of names) {
    const rel = norm(n)
    if (/^[a-z]:|^\//i.test(rel) || rel.split('/').some(unsafePart)) throw new Error(`The .zip has a file with an unsafe path: ${n}`)
  }
  const at = (prefix: string): string | undefined => MCP_ZIP_DEFINITIONS.map((d) => prefix + d).find((d) => names.some((n) => norm(n) === d))
  let prefix = ''
  let folder: string | null = null
  let found = at('')
  if (!found) {
    const tops = new Set(names.map((n) => norm(n).split('/')[0]))
    const top = tops.size === 1 ? [...tops][0] : null
    found = top ? at(`${top}/`) : undefined
    if (!top || !found) throw new Error(`No ${MCP_ZIP_DEFINITIONS.join(' or ')} found. A server .zip has its definition at its top level, or inside one folder.`)
    prefix = `${top}/`
    folder = top
  }
  const defEntry = names.find((n) => norm(n) === found)!
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(entries[defEntry]))
  } catch (e) {
    throw new Error(`${found} isn't valid JSON (${(e as Error).message}).`, { cause: e })
  }
  const def = checkMcpDef(raw)
  const files = new Map<string, Uint8Array>()
  for (const n of names) if (n !== defEntry) files.set(norm(n).slice(prefix.length), entries[n])
  return { def, files, folder }
}

/** A name for a server from a file: letters, numbers, "-" and "_"; never "hive". */
function serverName(raw: string): string {
  const n = raw.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 64)
  return n && n.toLowerCase() !== 'hive' ? n : 'server'
}

/** A definition's references to its zip's folder, moved to the name it is added as. */
function retarget(def: McpServerDef, from: string, to: string): McpServerDef {
  if (from === to) return def
  const move = (v: string): string => v.replace(folderRef(from), `\${HIVE_MCP_DIR}/${to}`)
  const out: McpServerDef = { ...def }
  if (typeof out.command === 'string') out.command = move(out.command)
  if (typeof out.cwd === 'string') out.cwd = move(out.cwd)
  if (Array.isArray(out.args)) out.args = out.args.map(move)
  if (out.env) out.env = Object.fromEntries(Object.entries(out.env).map(([k, v]) => [k, move(v)]))
  return out
}

/** A server's file read and checked: its definition, and for a .zip its files and folder. */
async function readServerFile(file: string): Promise<{ def: McpServerDef; files: Map<string, Uint8Array> | null; folder: string | null; name: string }> {
  const ext = extname(file).toLowerCase()
  const size = (await stat(file)).size
  if (ext === '.json') {
    if (size > MCP_JSON_MAX_BYTES) throw new Error('The .json is too large for an MCP server definition (over 1 MB).')
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(file, 'utf8'))
    } catch (e) {
      throw new Error(`${basename(file)} isn't valid JSON (${(e as Error).message}).`, { cause: e })
    }
    const stem = basename(file, ext)
    // The mcp repo's hive-mcp.example.json is named after its folder.
    const name = MCP_ZIP_DEFINITIONS.includes(basename(file).toLowerCase()) ? basename(dirname(file)) : stem
    return { def: checkMcpDef(raw), files: null, folder: null, name: serverName(name) }
  }
  if (ext === '.zip') {
    if (size > MCP_ZIP_MAX_BYTES) throw new Error('The .zip is too large for an MCP server (over 200 MB).')
    const z = serverFromZip(await readFile(file))
    // A zip with its files at the top: their folder is named after the zip.
    const folder = z.folder ?? basename(file, ext)
    return { ...z, folder, name: serverName(folder) }
  }
  throw new Error('Choose a .json definition or a .zip of a server folder.')
}

/** What adding a file would add (the dialog shows it first): its name, what it runs, and whether the name is taken. */
export async function previewMcpFile(file: string): Promise<McpFileServer> {
  const r = await readServerFile(file)
  const def = r.folder ? retarget(r.def, r.folder, r.name) : r.def
  return { name: r.name, def, runs: mcpRuns(def), secretWarnings: findSecretWarnings(def), files: r.files?.size ?? 0, exists: serverExists(r.name, !!r.files) }
}

/** A server named so: its definition, or (for a .zip) its folder. */
function serverExists(name: string, folder: boolean): boolean {
  return existsSync(join(workspace.mcpDir, `${name}.json`)) || (folder && existsSync(join(workspace.mcpDir, name)))
}

/**
 * Adds a server from a .json or .zip as `name`, turned off: it runs nothing until the user enables it (which shows
 * what it runs first). A name in use is refused unless `replace`, which moves the old definition (and its folder) to
 * the Recycle Bin. Everything is read and checked before anything is written, and the change is one turn with
 * enables (inTurn): an enable waiting meanwhile was for the old definition, so it is refused (setMcpGlobal's expected).
 */
export async function addMcpFromFile(file: string, name: string, replace = false): Promise<McpServerInfo> {
  if (!validMcpName(name)) throw new Error('Server names may contain letters, numbers, "-" and "_" (max 64 characters). "hive" is reserved.')
  const r = await readServerFile(file)
  const def = r.folder ? retarget(r.def, r.folder, name) : r.def
  const taken = (): Error => new Error(`A server named "${name}" already exists: choose another name, or replace it.`)
  return inTurn(async () => {
    const dir = workspace.mcpDir
    const json = join(dir, `${name}.json`)
    const folder = join(dir, name)
    if (serverExists(name, !!r.files) && !replace) throw taken()
    await mkdir(dir, { recursive: true })
    // Off before it exists: a name enabled earlier (the old server, or a definition deleted by hand) mustn't turn it on.
    await setGlobalNow(name, false)
    if (replace) {
      // A .zip brings its own folder; a .json keeps the one there (its definition may run what is in it).
      if (r.files && existsSync(folder)) await trash(folder)
      if (existsSync(json)) await trash(json)
    }
    // The folder is claimed (created, never reused: two adds at once can't share one) and written in place, since the
    // workspace's watcher holds the folders under .hive, so Windows refuses to rename one into place. If anything
    // fails, what was written goes again, so a retry isn't blocked.
    let claimed = false
    try {
      if (r.files) {
        await mkdir(folder).catch((e: NodeJS.ErrnoException) => {
          throw e.code === 'EEXIST' ? taken() : e
        })
        claimed = true
        for (const [rel, data] of r.files) {
          const to = join(folder, ...rel.split('/'))
          await mkdir(dirname(to), { recursive: true })
          await writeFile(to, data, { flag: 'wx' })
        }
      }
      await writeFile(json, JSON.stringify(def, null, 2) + '\n', { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
        throw e.code === 'EEXIST' ? taken() : e
      })
    } catch (e) {
      if (claimed) await rm(folder, { recursive: true, force: true }).catch(() => undefined)
      throw e
    }
    return (await listMcp()).find((m) => m.name === name)!
  })
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
