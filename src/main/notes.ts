import { join, relative, resolve, sep, dirname, basename } from 'path'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import type { NoteFile } from '../shared/types'
import { insideReal } from './fsutil'
import { workspace } from './workspace'

function assertInShared(p: string): string {
  const root = resolve(workspace.sharedDir)
  const abs = resolve(root, p)
  if (abs !== root && !abs.toLowerCase().startsWith(root.toLowerCase() + sep)) throw new Error('Path is outside the shared notes folder')
  if (!insideReal(abs, [root])) throw new Error('Path is outside the shared notes folder')
  return abs
}

export async function notesTree(): Promise<NoteFile[]> {
  if (!workspace.path) return []
  const root = workspace.sharedDir
  const walk = async (dir: string, depth: number): Promise<NoteFile[]> => {
    if (depth > 6) return []
    let entries: import('fs').Dirent[] = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const out: NoteFile[] = []
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const p = join(dir, e.name)
      const rel = relative(root, p).replace(/\\/g, '/')
      if (e.isDirectory()) out.push({ path: p, relPath: rel, name: e.name, isDir: true, children: await walk(p, depth + 1) })
      else if (e.isFile()) {
        const s = await stat(p).catch(() => null)
        out.push({ path: p, relPath: rel, name: e.name, isDir: false, modified: s?.mtime.toISOString() })
      }
    }
    return out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
  }
  return walk(root, 0)
}

export async function createNote(relPath: string, isDir: boolean): Promise<string> {
  let rel = relPath.trim().replace(/^[\\/]+/, '')
  if (!rel) throw new Error('Name is required')
  if (!isDir && !/\.[a-z0-9]+$/i.test(rel)) rel += '.md'
  const abs = assertInShared(rel)
  if (existsSync(abs)) throw new Error(`"${rel}" already exists`)
  if (isDir) await mkdir(abs, { recursive: true })
  else {
    await mkdir(dirname(abs), { recursive: true })
    const title = basename(abs).replace(/\.[^.]+$/, '')
    await writeFile(abs, abs.endsWith('.md') ? `# ${title}\n\n` : '')
  }
  return abs
}

export async function deleteNote(p: string): Promise<void> {
  const abs = assertInShared(p)
  if (abs === resolve(workspace.sharedDir)) throw new Error('Cannot delete the shared folder itself')
  await rm(abs, { recursive: true, force: true })
}

export async function renameNote(p: string, newName: string): Promise<string> {
  const abs = assertInShared(p)
  if (!newName.trim() || /[\\/:*?"<>|]/.test(newName)) throw new Error('Invalid name')
  const dest = assertInShared(join(dirname(abs), newName.trim()))
  if (existsSync(dest)) throw new Error(`"${newName}" already exists`)
  await rename(abs, dest)
  return dest
}

/** Writes a handover note into shared/handovers and returns its path. */
export async function createHandover(project: string, title: string, content: string): Promise<string> {
  const date = new Date().toISOString().slice(0, 10)
  const slug = `${title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'handover'
  const dir = join(workspace.sharedDir, 'handovers')
  await mkdir(dir, { recursive: true })
  // The same slug as hive-mcp's, which finds a project's handovers by this prefix.
  const projectSlug = project.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  let file = join(dir, `${date}-${projectSlug ? projectSlug + '-' : ''}${slug}.md`)
  let n = 2
  while (existsSync(file)) file = file.replace(/(-\d+)?\.md$/, `-${n++}.md`)
  const header = `# ${title}\n\n- **Project:** ${project || '(workspace)'}\n- **Date:** ${new Date().toISOString()}\n\n`
  await writeFile(file, header + content.trim() + '\n')
  return file
}

export { assertInShared }
