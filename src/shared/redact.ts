/**
 * Redaction for Help → Copy Diagnostics: what a bug report may carry from a user's machine. Folders
 * become placeholders, names of workspaces, projects and agents are removed, and anything that looks
 * like a secret is masked. It errs towards removing too much.
 */

export interface RedactContext {
  /** The user's home folder: becomes ~. */
  home: string
  /** Workspace folders, and other folders that name the user's work (worktrees): each becomes <workspace>. */
  folders: string[]
  /** Names to remove wherever they appear as a word: projects, agents, branches, workspaces. */
  names: { name: string; as: string }[]
  /** Hive's own folder (a development build's checkout): becomes <hive>, so its stack traces keep their file names. */
  app?: string
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A folder written with either slash, in any case. */
const folderRe = (p: string): RegExp => new RegExp(escape(p.replace(/[\\/]+$/, '')).replace(/\\\\|\//g, String.raw`[\\/]+`), 'gi')

const SECRETS: [RegExp, string][] = [
  // Authorization headers and bearer tokens.
  [/\b(authorization)(["']?\s*[:=]\s*["']?)[^\r\n"']+/gi, '$1$2<redacted>'],
  [/\bbearer\s+[\w.~+/=-]+/gi, 'Bearer <redacted>'],
  // key=value and "key": "value" where the key names a secret.
  [/\b([\w-]*(?:token|secret|password|passwd|api[_-]?key|apikey|credential|cookie|session[_-]?key|auth)[\w-]*)(["']?\s*[:=]\s*["']?)([^\s"'&,;}\]]+)/gi, '$1$2<redacted>'],
  // Well-known key formats.
  [/\b(?:sk-ant-|sk-|ghp_|gho_|ghu_|ghs_|github_pat_|xox[abprs]-|glpat-|AKIA)[\w-]{8,}/g, '<redacted>'],
  // JWTs.
  [/\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}/g, '<redacted>'],
  // Long hex or base64 runs (keys, tokens, hashes).
  [/\b[0-9a-f]{20,}\b/gi, '<redacted>'],
  [/(?<![\w/\\.-])[A-Za-z0-9+/]{40,}={0,2}(?![\w/\\.-])/g, '<redacted>'],
  // Email addresses.
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '<email>']
]

export function redact(text: string, ctx: RedactContext): string {
  let out = text
  if (ctx.app && ctx.app.length > 3) out = out.replace(folderRe(ctx.app), '<hive>')
  // Longest first, so a worktree inside a workspace isn't half replaced.
  for (const f of [...ctx.folders].filter((x) => x.length > 3).sort((a, b) => b.length - a.length)) out = out.replace(folderRe(f), '<workspace>')
  if (ctx.home.length > 3) out = out.replace(folderRe(ctx.home), '~')
  for (const n of [...ctx.names].filter((x) => x.name.trim().length > 1).sort((a, b) => b.name.length - a.name.length)) {
    out = out.replace(new RegExp(String.raw`(?<![\w-])${escape(n.name.trim())}(?![\w-])`, 'gi'), n.as)
  }
  for (const [re, by] of SECRETS) out = out.replace(re, by)
  return out
}

/** Text the log marked as the user's own (logger.ts userText()): a span between Unicode isolate marks. */
const USER_TEXT = /⁨([^⁩\n]*)⁩/g
const looksLikePath = (s: string): boolean => /^\s*(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/)/.test(s) || s.includes('\\')

/** Replaces the user's own text marked in log lines with <path> or <text>; a span cut off by the end of a line goes too. */
export function hideUserText(text: string): string {
  return text
    .replace(USER_TEXT, (_m, inner: string) => (looksLikePath(inner) ? '<path>' : '<text>'))
    .replace(/⁨[^\n]*/g, '<text>')
    .replace(/⁩/g, '')
}

/** Folders whose paths name nothing of the user's: app data, the CLIs' dot folders, Windows and installed programs. */
const PLAIN_FOLDER = /^(?:~[\\/](?:AppData|\.)|[A-Za-z]:[\\/](?:Program Files|Program Files \(x86\)|ProgramData|Windows)(?:[\\/]|$))/i
/** An absolute path, up to a space or a character that can't be in one (from a path with spaces, the words after the first space stay). */
const ABSOLUTE_PATH = /(?<![\w<>])(?:[A-Za-z]:[\\/](?:Program Files(?: \(x86\))?)?|~[\\/]|\\\\)[^\s"'<>|?*,;()[\]{}]*/gi

/** In the line Hive logs as it starts, once its log marks the user's own text. */
export const MARKED_LOG = 'your text marked'
const START_LINE = /^\S+ \[INFO\] \[main\] Hive \S+ starting \((.*)\)$/
/** What a line logged before Hive marked the user's text shows instead of its message. */
export const OLDER_LINE = '<message left out: logged by an older version of Hive>'

/**
 * Redaction for Hive's log: the user's own text it marked goes first, then redact(), then any absolute path left
 * that isn't one of Hive's or the CLIs' own (folders of workspaces no longer open) becomes <path>. Lines from a run
 * of Hive that didn't mark the user's text (its start line doesn't say so) keep only their time, level and scope:
 * card titles and names in them can't be told apart from the rest. `text` is the end of the log of the Hive that is
 * running: lines before the first start line in it are from an earlier run, unless there is none (then they all come
 * after the running Hive's own start line).
 */
export function redactLog(text: string, ctx: RedactContext): string {
  const lines = text.split('\n')
  let marked = !lines.some((l) => START_LINE.test(l))
  return lines
    .map((line) => {
      const start = START_LINE.exec(line)
      if (start) {
        marked = start[1].includes(MARKED_LOG)
        return line
      }
      // A line's time, level and [scope] stay as they are: a project called "sessions" mustn't take the scope with it.
      const head = /^\S+ \[[A-Z]+\] \[[\w-]+\] /.exec(line)?.[0] ?? ''
      if (!marked) return line.trim() ? `${head}${OLDER_LINE}` : line
      const rest = redact(hideUserText(line.slice(head.length)), ctx).replace(ABSOLUTE_PATH, (p) => (PLAIN_FOLDER.test(p) ? p : '<path>'))
      return head + rest
    })
    .join('\n')
}
