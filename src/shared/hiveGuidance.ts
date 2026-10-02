/**
 * What agents are told about Hive: the hive MCP server's instructions (Claude Code shows them to the
 * model), and the same text as developer instructions for providers that don't (Codex). Kept here so the
 * MCP server (bundled on its own, Node built-ins only) and the main process say the same thing.
 */

export function hiveInstructions(project: string): string {
  return [
    `Hive is the desktop app hosting this session${project ? ` (project "${project}")` : ''}. It manages a workspace: a folder of projects that share notes, skills and MCP servers.`,
    'Handovers and shared notes live in the workspace, not in the project folder. When the user mentions a handover, shared notes, instructions for all projects, or another project in the workspace, use these tools rather than searching the file system:',
    '- hive_read_latest_handover: the latest handover for this project. hive_list_shared_notes / hive_read_shared_note / hive_write_shared_note: everything else in the shared notes.',
    '- hive_create_handover: when the user wants to hand work over to a future session, or asks you to wrap up.',
    '- hive_list_projects / hive_project_status: other projects and their sessions. hive_session_usage: token and cache use.',
    '- hive_notify: flag something to the user in Hive.',
    `- hive_list_tasks / hive_read_task / hive_create_task / hive_update_task: ${project ? "your project's cards on the workspace's task board (other projects' cards are for their own agents, the Assistant and the user)" : "the workspace's task board"}. When you were given a card (#n), move it to doing before you start (also when it is back from review with follow-up work), keep it up to date, and move it to review with a comment saying what you did when the work is done; add cards for follow-up work rather than doing it unasked. A column's order is its priority: when asked to prioritise, put the cards in order on the board (hive_reorder_tasks, or hive_update_task with position or before) rather than only listing an order. Finished work goes to review; move a card to done when the user asks you to. Asked to check a card's latest comment, read just that (hive_read_task with latestComment).`
  ].join('\n')
}

export function withLatestHandover(instructions: string, relPath: string | null | undefined): string {
  return relPath ? `${instructions}\n\nThe latest handover for this project is "${relPath}". Read it with hive_read_latest_handover when the user asks you to pick up previous work.` : instructions
}

/** Who wrote a handover: Hive fills this in from the agent whose hive tools wrote it. */
export interface HandoverAuthor {
  /** "Claude (Claude Code)", or "Assistant". */
  author: string
  /** The conversation it was written in. */
  session?: string
}

/**
 * The header Hive puts at the top of every handover: its title, then project, author and session (when an
 * agent wrote it) and the date, in the machine's time with UTC in brackets.
 */
export function handoverHeader(title: string, project: string, by: HandoverAuthor | null, at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const local = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
  const lines = [`- **Project:** ${project || '(workspace)'}`]
  if (by) lines.push(`- **Author:** ${by.author}`)
  if (by?.session) lines.push(`- **Session:** ${by.session}`)
  lines.push(`- **Date:** ${local} (${at.toISOString().slice(0, 19)}Z)`)
  return `# ${title}\n\n${lines.join('\n')}\n\n`
}

/** The conversation a handover was written in, from its header (null when it doesn't say). */
export function handoverSession(text: string): string | null {
  return /^- \*\*Session:\*\* (\S+)\s*$/m.exec(text.slice(0, 2000))?.[1] ?? null
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** The fields of a shared-notes tree entry this needs (NoteFile, or the MCP server's copy of it). */
interface NoteLike {
  name: string
  relPath: string
  isDir: boolean
  modified?: string
  children?: NoteLike[]
}

/** The project a handover's header names (its "- **Project:**" line), or null without one. */
export function handoverProject(text: string): string | null {
  return /^- \*\*Project:\*\* (.+)$/m.exec(text.slice(0, 2000))?.[1]?.trim() ?? null
}

/**
 * A project's handovers, newest first. Files are named <date>-<project>-<title>.md, so the project is
 * matched on the name. One project's name can begin another's ("hive" and "hive-website"), and two names can
 * make the same slug ("foo_bar" and "foo-bar"): where another project could own the file, the file's
 * "- **Project:**" header decides (read with `read`), by the project's exact name when two share a slug.
 * `strict` (before moving or deleting them): a file only counts when its header names this project exactly, or it
 * has no header and no other project could own it.
 */
export async function projectHandovers<T extends NoteLike>(tree: T[], project: string | undefined, allProjects: string[], read: (relPath: string) => Promise<string>, opts: { strict?: boolean } = {}): Promise<T[]> {
  const files = ((tree.find((n) => n.isDir && n.name === 'handovers')?.children ?? []) as T[]).filter((f) => !f.isDir && f.name.endsWith('.md') && f.name !== 'README.md')
  const p = project ? slug(project) : ''
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
  // Other projects whose names overlap this one's ("hive" / "hive-website"), or make the same slug ("foo_bar" / "foo-bar").
  const others = p ? allProjects.filter((n) => !same(n, project!)) : []
  const twins = others.filter((n) => slug(n) === p)
  const overlapping = others.map(slug).filter((s) => s === p || s.startsWith(p + '-') || p.startsWith(s + '-'))
  const mine: T[] = []
  for (const f of files) {
    if (!p) {
      mine.push(f)
      continue
    }
    const rest = f.name.replace(/^\d{4}-\d{2}-\d{2}-/, '')
    if (!rest.startsWith(p + '-')) continue
    if (!opts.strict && !overlapping.some((s) => s === p || rest.startsWith(s + '-'))) {
      mine.push(f)
      continue
    }
    // "hive-website-plan" could be hive-website's "Plan", or hive's "Website plan": the header says which.
    try {
      const owner = handoverProject(await read(f.relPath))
      // Strictly, a header names its project exactly: a project that has gone ("foo-bar") may share this one's slug.
      const ours = owner === null ? !overlapping.some((s) => s === p || rest.startsWith(s + '-')) : opts.strict || twins.length ? same(owner, project!) : slug(owner) === p
      if (ours) mine.push(f)
    } catch {
      // Unreadable: leave it out.
    }
  }
  return mine.sort((a, b) => b.name.slice(0, 10).localeCompare(a.name.slice(0, 10)) || (b.modified ?? '').localeCompare(a.modified ?? ''))
}
