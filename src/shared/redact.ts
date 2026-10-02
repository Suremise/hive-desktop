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
  // Longest first, so a worktree inside a workspace isn't half replaced.
  for (const f of [...ctx.folders].filter((x) => x.length > 3).sort((a, b) => b.length - a.length)) out = out.replace(folderRe(f), '<workspace>')
  if (ctx.home.length > 3) out = out.replace(folderRe(ctx.home), '~')
  for (const n of [...ctx.names].filter((x) => x.name.trim().length > 1).sort((a, b) => b.name.length - a.name.length)) {
    out = out.replace(new RegExp(String.raw`(?<![\w-])${escape(n.name.trim())}(?![\w-])`, 'gi'), n.as)
  }
  for (const [re, by] of SECRETS) out = out.replace(re, by)
  return out
}
