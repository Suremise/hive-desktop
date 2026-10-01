import { execFile } from 'child_process'
import { resolve, sep } from 'path'
import { lstat, readFile, readlink } from 'fs/promises'
import { insideReal } from './fsutil'
import type { GitDiff, GitStatus } from '../shared/types'

const MAX_DIFF_BYTES = 2 * 1024 * 1024

export interface GitResult {
  out: string
  ok: boolean
  buf: Buffer
  /** Standard error, for messages to show when a command fails. */
  err: string
  code: number
}

export function git(cwd: string, args: string[], maxBuffer = 16 * 1024 * 1024): Promise<GitResult> {
  return new Promise((res) => {
    execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd, windowsHide: true, maxBuffer, encoding: 'buffer' }, (err, stdout, stderr) => {
      const buf = (stdout as unknown as Buffer) ?? Buffer.alloc(0)
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : 1) : 0
      res({ out: buf.toString('utf8'), ok: !err, buf, err: ((stderr as unknown as Buffer) ?? Buffer.alloc(0)).toString('utf8').trim(), code })
    })
  })
}

/** The commit where HEAD left base, or null if there is none. */
async function mergeBase(cwd: string, base: string): Promise<string | null> {
  const r = await git(cwd, ['merge-base', base, 'HEAD'])
  return r.ok ? r.out.trim() : null
}

/**
 * Changed files in a working tree. With base (a worktree agent's branch), lists everything that
 * differs from where the branch left base — its commits and uncommitted edits — rather than from HEAD.
 */
export async function gitStatus(projectPath: string, base?: string): Promise<GitStatus> {
  const status = await workingStatus(projectPath)
  if (!base || !status.isRepo) return status
  const mb = await mergeBase(projectPath, base)
  if (!mb) return status
  const r = await git(projectPath, ['diff', '--name-status', '--no-renames', '-z', mb])
  const files: GitStatus['files'] = []
  const parts = r.out.split('\0').filter(Boolean)
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const file = parts[i + 1]
    if (!file.startsWith('.hive/')) files.push({ path: file, status: parts[i][0], staged: false })
  }
  const seen = new Set(files.map((f) => f.path))
  for (const f of status.files) if (f.status === '?' && !seen.has(f.path)) files.push(f)
  return { ...status, files }
}

async function workingStatus(projectPath: string): Promise<GitStatus> {
  const r = await git(projectPath, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all'])
  if (!r.ok) return { isRepo: false, branch: null, ahead: 0, behind: 0, files: [] }
  const parts = r.out.split('\0').filter(Boolean)
  const status: GitStatus = { isRepo: true, branch: null, ahead: 0, behind: 0, files: [] }
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p.startsWith('## ')) {
      const head = p.slice(3)
      const m = head.match(/^(?:No commits yet on )?([^.\s]+)/)
      status.branch = m ? m[1] : head
      status.ahead = parseInt(head.match(/ahead (\d+)/)?.[1] ?? '0', 10)
      status.behind = parseInt(head.match(/behind (\d+)/)?.[1] ?? '0', 10)
      continue
    }
    const x = p[0]
    const y = p[1]
    const file = p.slice(3)
    if (x === 'R' || x === 'C') i++ // the next entry is the original path
    if (file.startsWith('.hive/')) continue
    const code = x === '?' ? '?' : y !== ' ' ? y : x
    status.files.push({ path: file, status: code, staged: x !== ' ' && x !== '?' })
  }
  return status
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

export async function gitDiff(projectPath: string, file: string, base?: string): Promise<GitDiff> {
  const abs = resolve(projectPath, file)
  if (!abs.toLowerCase().startsWith(resolve(projectPath).toLowerCase() + sep)) throw new Error('Path is outside the project')
  const ref = (base && (await mergeBase(projectPath, base))) || 'HEAD'
  const head = await git(projectPath, ['show', `${ref}:${file.replace(/\\/g, '/')}`], MAX_DIFF_BYTES * 2)
  const original = head.ok ? head.buf : Buffer.alloc(0)
  let modified = Buffer.alloc(0)
  try {
    const s = await lstat(abs)
    // A link is shown as git stores it (the path it points to), never followed: it could lead outside the project.
    if (s.isSymbolicLink()) modified = Buffer.from(await readlink(abs), 'utf8')
    else {
      // Nor a file reached through a linked folder that leads outside.
      if (!insideReal(abs, [projectPath])) throw Object.assign(new Error('Path is outside the project'), { outside: true })
      if (s.size > MAX_DIFF_BYTES) return { path: file, original: '', modified: `File is too large to diff (${Math.round(s.size / 1024)} KB).`, binary: true }
      modified = await readFile(abs)
    }
  } catch (e) {
    if ((e as { outside?: boolean }).outside) throw e
    // Deleted in the working tree.
  }
  if (isBinary(original) || isBinary(modified)) return { path: file, original: '', modified: '', binary: true }
  return { path: file, original: original.toString('utf8'), modified: modified.toString('utf8'), binary: false }
}
