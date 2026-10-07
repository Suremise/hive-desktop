import { join, relative, resolve, sep, dirname, basename } from 'path'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'original-fs/promises'
import { shell } from 'electron'
import { existsSync } from 'original-fs'
import { handoverHeader, type HandoverAuthor } from '../shared/hiveGuidance'
import type { NoteFile } from '../shared/types'
import { hashText, insideReal, withFileLock, writeTextAtomic } from './fsutil'
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
    let entries: import('original-fs').Dirent[] = []
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
    await writeFile(abs, abs.endsWith('.md') ? `# ${title}\n\n` : '', { flag: 'wx' })
  }
  return abs
}

export async function deleteNote(p: string): Promise<void> {
  const abs = assertInShared(p)
  if (abs === resolve(workspace.sharedDir)) throw new Error('Cannot delete the shared folder itself')
  // To the Recycle Bin, like files, skills, personas and sessions.
  if (existsSync(abs)) await shell.trashItem(abs)
}

export async function renameNote(p: string, newName: string): Promise<string> {
  const abs = assertInShared(p)
  if (!newName.trim() || /[\\/:*?"<>|]/.test(newName)) throw new Error('Invalid name')
  const dest = assertInShared(join(dirname(abs), newName.trim()))
  if (existsSync(dest)) throw new Error(`"${newName}" already exists`)
  await rename(abs, dest)
  return dest
}

/** Writes a handover note into shared/handovers and returns its path; `by` is the agent that wrote it, for its header. */
export async function createHandover(project: string, title: string, content: string, by: HandoverAuthor | null = null): Promise<string> {
  const date = new Date().toISOString().slice(0, 10)
  const slug = `${title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'handover'
  const dir = join(workspace.sharedDir, 'handovers')
  await mkdir(dir, { recursive: true })
  // The same slug as hive-mcp's, which finds a project's handovers by this prefix.
  const projectSlug = project.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  let file = join(dir, `${date}-${projectSlug ? projectSlug + '-' : ''}${slug}.md`)
  const header = handoverHeader(title, project, by, new Date())
  // Created, never overwritten: two handovers with the same title at once get -2, -3…
  for (let n = 2; ; n++) {
    try {
      await writeFile(file, header + content.trim() + '\n', { flag: 'wx' })
      return file
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || n > 1000) throw e
      file = file.replace(/(-\d+)?\.md$/, `-${n}.md`)
    }
  }
}

/** A shared note's revision: a short hash of its text, which a write can name to be sure it changes what its writer read. */
export const noteRevision = (text: string): string => hashText(text).slice(0, 12)

/** A write naming a revision the note is no longer at: `current` is its revision now, null when it no longer exists. */
export class NoteConflict extends Error {
  constructor(
    rel: string,
    expected: string,
    public current: string | null
  ) {
    super(current ? `${rel} has changed since revision ${expected}: it is now at revision ${current}. Read it again, merge your change and write it with expectedRevision ${current}.` : `${rel} no longer exists. Write it without expectedRevision to create it again.`)
  }
}

export async function readNote(abs: string): Promise<{ content: string; revision: string }> {
  const content = await readFile(abs, 'utf8')
  return { content, revision: noteRevision(content) }
}

/**
 * Writes or appends to a note. Locked from read to write (the same lock as Hive's editors' saves), so two agents
 * appending at once both keep their text, and with `expectedRevision` the check and the write can't be split by
 * another write: the second of two writers that read the same text is refused rather than dropping the first's change.
 */
export async function writeNote(abs: string, rel: string, content: string, o: { append?: boolean; expectedRevision?: string } = {}): Promise<{ revision: string }> {
  return withFileLock(abs, async () => {
    const existing = await readFile(abs, 'utf8').catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : Promise.reject(e)))
    if (o.expectedRevision !== undefined) {
      const current = existing === null ? null : noteRevision(existing)
      if (current !== o.expectedRevision) throw new NoteConflict(rel, o.expectedRevision, current)
    }
    const text = o.append && existing ? existing + (existing.endsWith('\n') ? '' : '\n') + content : content
    await writeTextAtomic(abs, text)
    return { revision: noteRevision(text) }
  })
}

export { assertInShared }
