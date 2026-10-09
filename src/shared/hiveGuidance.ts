/**
 * The session contract: what every session Hive starts is told about Hive, always. The hive MCP server sends it as
 * its instructions (Claude Code shows them to the model), and Hive passes the same text as developer instructions to
 * providers that don't (Codex). Kept here so the MCP server (bundled on its own, Node built-ins only) and the main
 * process say the same thing.
 *
 * It holds only what must hold whatever else is loaded: who and where the session is, where Hive's things live, the
 * board's boundaries, and which skill to use for which workflow. Procedures live in the skills (resources/skills),
 * arguments and side effects in the tools' descriptions, and enforcement in the Agent API. The boundaries are
 * repeated here in a line so a session without the skills (deleted, or a provider that didn't load them) still keeps
 * them.
 */

/** Settings → Assistant → Control (AssistantControl). */
type AssistantControlLevel = 'look' | 'agents' | 'projects'

export type HiveRole = 'agent' | 'assistant'

/**
 * When agents run a command through hive-progress (Settings → General → Agents show long commands, while the Progress
 * panel is on): long ones by default, or only when the user asks.
 */
export function progressRule(wrap: boolean): string {
  return wrap
    ? 'Run commands likely to take over 30 s (tests, builds), in the background too, as `hive-progress --title "<what and why, in a few words>" -- <command>`: Hive\'s Progress panel shows them to the user; output and exit code are unchanged.'
    : 'Use `hive-progress --title "<what and why, in a few words>" -- <command>` (Hive\'s Progress panel) only when the user asks.'
}

/** Whether agents are told to wrap long commands unasked: the setting, while the Progress panel is on (Settings → General). */
export const wrapsLongCommands = (general: { progressPanel?: boolean; progressCommands?: boolean } | undefined): boolean => general?.progressPanel !== false && general?.progressCommands !== false

/** `progress`: whether agents wrap long commands in hive-progress unasked (progressRule). */
export function hiveInstructions(project: string, role: HiveRole = 'agent', progress = true): string {
  if (role === 'assistant') {
    return [
      "Hive is the desktop app hosting this session; you are its Assistant for this workspace. Handovers, shared notes, the task board and the projects' agents are Hive's: use the hive tools for them, not the file system.",
      "Hive's skills cover your workflows: coordinate-agents for running agents and cards, split-work for planning, tune-settings for Hive's settings, handover, pick-up and workspace-note."
    ].join('\n')
  }
  return [
    `Hive is the desktop app hosting this session${project ? ` (project "${project}")` : ''}. Its workspace holds projects that share notes, skills and a task board. Handovers, shared notes, other projects and the board are Hive's: use the hive tools for them, not the file system.`,
    "The board shows your project's cards. Given a card (#n) to work on, fix or continue, use the work-on-card skill; asked to review or check one, use review-agent-work; asked to work through or review several cards in turn (a builder/reviewer loop), use card-loop. Hive's other skills cover handovers, picking work up, shared notes, merging, splitting work and its HTTP API.",
    progressRule(progress),
    // #476: Hive tracks the folder it gave the session (locks, Changes, merging, card tools); a worktree made here isn't.
    // One the user asks for is theirs (#482).
    "Hive sets your folder: make no git worktree to work in unless the user asks (else ask for an agent with its own). Merge or remove a subagent's worktree before you finish.",
    'Board rules, whatever a skill says, or if it is missing:',
    '- Working on a card: move it to doing first (also when it is back from review), then to review with a comment saying what you did.',
    '- Reviewing a card is not working on it: it stays in review with its agent (hive_update_task review start, then failed, or passed with column passed). If it leaves review meanwhile, your review is over: leave the card where it is (not back to review or on to passed).',
    "- Done means merged: move a card to done only once its work is merged, or when the user asks. On hold is the user's: never move cards in or out unasked. Add cards for follow-up work rather than doing it unasked. A column's order is its priority."
  ].join('\n')
}

/**
 * Hive's settings (Settings → Assistant → Control → Change settings): reading and explaining them always, changing them
 * only with the switch on and the user's say-so. Hive refuses the sensitive ones and the Assistant's own Control
 * (settingsChange in servers.ts); when and how to suggest one is the tune-settings skill's.
 */
export function settingsRule(changeSettings: boolean): string {
  return changeSettings
    ? "- Hive's settings: change one (hive_update_setting) only when the user asks or agrees; suggest first."
    : "- Hive's settings: read and explain them; changing one needs Settings → Assistant → Control → Change settings."
}

/**
 * What the Assistant may do, from Settings → Assistant → Control: the boundaries it keeps whatever else it reads.
 * Hive enforces them too (assistantChange in servers.ts); how to work within them is the coordinate-agents skill's.
 */
export function controlRules(control: AssistantControlLevel, changeSettings = false): string {
  if (control === 'look') {
    return [
      'Control (Settings → Assistant → Control): Look and advise. You read and advise; the user acts. Never edit or create files, run commands that change anything, change the task board, or start, stop or prompt agents, even if asked: say what you would do, and that Settings → Assistant can let you act. Writing shared notes and handovers is fine when the user asks.',
      settingsRule(changeSettings)
    ].join('\n')
  }
  return [
    `Control (Settings → Assistant → Control): ${control === 'projects' ? 'Control agents and create projects' : 'Control agents'}. Through Hive's tools you can add agents, change their settings, start and stop them, give idle ones tasks and change the task board${control === 'projects' ? ', and create projects when the user asks for one' : ''}.`,
    '- Act when the user asks, or agrees to a plan you proposed; otherwise say what you would do. Agents do the work: never edit or create project files or run commands that change anything yourself.',
    "- Never interrupt a working agent, answer a question an agent is asking the user (tell the user), or type into an agent the user has just typed in. Stopping a busy agent asks the user: give your reason.",
    '- Add a worktree only if the user asked for one or agreed when you asked; reassign or restart a stalled card only when the user agrees.',
    "- You can't remove agents, discard worktrees, archive or delete cards, or hide, remove or delete projects: tell the user how. Hive allows 30 changes per message from the user.",
    settingsRule(changeSettings),
    '- Use the coordinate-agents skill to run agents and cards. Afterwards, say briefly what you did.'
  ].join('\n')
}

export function withLatestHandover(instructions: string, relPath: string | null | undefined): string {
  return relPath ? `${instructions}\nThis project's latest handover is "${relPath}" (the pick-up skill, when the user asks to continue).` : instructions
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
