// Reading a Markdown document to outline it or read one section (#817): a project's file (in the folder the caller works
// in) or a shared note (`shared:<path>`). Only Markdown, only inside its folder (through junctions too), never Hive's
// own `.hive` or git's `.git` folder, and up to DOC_MAX: a reply never carries more than the section asked for.
import { readFile, stat } from 'original-fs/promises'
import { isAbsolute, relative, resolve } from 'path'
import { insideReal, realPath } from './fsutil'
import { parseDocRef } from '../shared/docRefs'
import { docOutline, findHeading, sectionText, type DocHeading } from '../shared/docSections'

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

/**
 * A context reference's section for the window to show (#818: the card dialog's links): its text (the whole document
 * when it names no heading), the line its heading is on, or why it doesn't resolve. `project`: null for a card about the
 * workspace, whose project files can't resolve.
 */
export async function docRefSection(project: string | null, shared: string, ref: string): Promise<{ ref: string; content: string; line: number } | { ref: string; problem: DocRefProblem; closest?: string[] }> {
  const parsed = parseDocRef(ref)
  if (!parsed) return { ref, problem: 'invalid' }
  const isShared = parsed.path.startsWith(SHARED_PREFIX)
  if (!isShared && !project) return { ref, problem: 'notFound' }
  const r = await readDoc(isShared ? shared : project!, isShared ? parsed.path.slice(SHARED_PREFIX.length) : parsed.path)
  if (!r.ok) return { ref, problem: r.code }
  if (!parsed.slug) return { ref, content: r.text, line: 1 }
  const outline = docOutline(r.text)
  const found = findHeading(outline, `#${parsed.slug}`)
  if ('heading' in found) return { ref, content: sectionText(r.text, found.heading), line: found.heading.line }
  return { ref, problem: 'noHeading', closest: ('closest' in found ? found.closest : found.ambiguous).slice(0, 3).map((h) => h.slug) }
}

/** What a card's context reference (#818) comes to: its section's size, or why it doesn't resolve (#819), with the closest headings. */
export type DocRefCheck = { ref: string; size: number; heading?: DocHeading } | { ref: string; problem: DocRefProblem; closest?: string[] }

/** Why a reference doesn't resolve: as reading its document found, not a reference at all, or no such heading in it. */
export type DocRefProblem = Extract<DocRead, { ok: false }>['code'] | 'invalid' | 'noHeading'

/**
 * Resolves a context reference: in the project's folder (`project`, the folder the card's project is in, never an
 * agent's worktree) or the shared notes (`shared`, for `shared:` references). Its size is its section's, or the whole
 * document's when it names no heading; a slug is matched exactly (`#slug`, as hive_read_section takes it).
 */
export async function resolveDocRef(project: string, shared: string, ref: string): Promise<DocRefCheck> {
  const parsed = parseDocRef(ref)
  if (!parsed) return { ref, problem: 'invalid' }
  const isShared = parsed.path.startsWith(SHARED_PREFIX)
  const r = await readDoc(isShared ? shared : project, isShared ? parsed.path.slice(SHARED_PREFIX.length) : parsed.path)
  if (!r.ok) return { ref, problem: r.code }
  if (!parsed.slug) return { ref, size: r.text.length }
  const outline = docOutline(r.text)
  const found = findHeading(outline, `#${parsed.slug}`)
  if ('heading' in found) return { ref, size: found.heading.size, heading: found.heading }
  return { ref, problem: 'noHeading', closest: ('closest' in found ? found.closest : found.ambiguous).slice(0, 3).map((h) => h.slug) }
}
