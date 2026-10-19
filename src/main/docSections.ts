// Reading a Markdown document to outline it or read one section (#817): a project's file (in the folder the caller works
// in) or a shared note (`shared:<path>`). Only Markdown, only inside its folder (through junctions too), never Hive's
// own `.hive` or git's `.git` folder, and up to DOC_MAX: a reply never carries more than the section asked for.
import { readFile, stat } from 'original-fs/promises'
import { isAbsolute, relative, resolve } from 'path'
import { insideReal, realPath } from './fsutil'

/** A shared note's reference starts with this: `shared:plans/i18n.md`. */
export const SHARED_PREFIX = 'shared:'

/** The largest document read by section. */
export const DOC_MAX = 4 * 1024 * 1024

/** What reading a document found: its text, or why not. */
export type DocRead = { ok: true; text: string } | { ok: false; code: 'outside' | 'hidden' | 'notMarkdown' | 'notFound' | 'tooBig' }

const MARKDOWN = /\.(md|markdown|mdx)$/i

/** Whether a path inside the folder goes into Hive's own `.hive` or git's `.git`. */
const hidden = (inside: string): boolean => inside.split(/[\\/]/).some((part) => part.toLowerCase() === '.hive' || part.toLowerCase() === '.git')

/**
 * Reads a document: `path` relative to `root` (a project's folder, or the shared notes' folder for `shared:` paths).
 * A path outside it, into `.hive` or `.git`, or not Markdown is refused before anything is read.
 */
export async function readDoc(root: string, path: string): Promise<DocRead> {
  const rel = path.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!rel || isAbsolute(rel) || /^[a-z]:/i.test(rel)) return { ok: false, code: 'outside' }
  const abs = resolve(root, rel)
  const inside = relative(resolve(root), abs)
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return { ok: false, code: 'outside' }
  if (hidden(inside)) return { ok: false, code: 'hidden' }
  if (!MARKDOWN.test(abs)) return { ok: false, code: 'notMarkdown' }
  if (!insideReal(abs, [root])) return { ok: false, code: 'outside' }
  // Where it really is, through junctions and links: one inside the folder may still lead into .hive or .git.
  if (hidden(relative(realPath(root), realPath(abs)))) return { ok: false, code: 'hidden' }
  const s = await stat(abs).catch(() => null)
  if (!s?.isFile()) return { ok: false, code: 'notFound' }
  if (s.size > DOC_MAX) return { ok: false, code: 'tooBig' }
  const text = await readFile(abs, 'utf8').catch(() => null)
  return text === null ? { ok: false, code: 'notFound' } : { ok: true, text: text.replace(/^﻿/, '') }
}
