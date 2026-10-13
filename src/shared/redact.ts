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

// ---------------------------------------------------------------------------
// Credentials in free text (#699; the Assistant's rule after round 3, extended after round 4): a credential's name
// anywhere in a string, bare or quoted (`password=`, `--api-key`, `"password":`, `'api key':`), masks everything after it
// to the end of that string. No parsing of quotes, escapes, continuations, options or JSON: a secret's value can't leave a
// fragment behind, and no container can hide one, when nothing after its name is kept. Losing what follows a secret (the
// flags after it, a JSON object's other fields) is the accepted cost. A payload Hive holds as an object is masked by its
// keys instead (devConsole.ts's redactPayload), not here.
// ---------------------------------------------------------------------------

type Step = (text: string) => string
const replacing =
  (re: RegExp, by: string): Step =>
  (text) =>
    text.replace(re, by)

/** The words in a name that make it a secret's or a sign-in's (a field, a key=value's key, a command-line option, a header). */
const SECRET_NAME = String.raw`token|secret|password|passwd|passphrase|passcode|pwd|api[\s._-]?key|apikey|credentials?|cookie|session[\s._-]?key|access[\s._-]?key|private[\s._-]?key|auth|device[\s._-]?code|user[\s._-]?code|otp|code[\s._-]?verifier`
const CREDENTIAL = new RegExp(SECRET_NAME, 'i')

/**
 * Where a credential's value starts in free text, or -1: after `-u` or `--user` with a user:password (quoted, escaped or
 * with spaces in the name: `-u "name with spaces:pw"`); a quoted name and its `:` or `=` (a JSON or Python key at any
 * depth, `"password":`, `'api key':`, `\"token\":` in a JSON string inside another; at most 100 characters); a
 * command-line option naming one and its separator (`--api-key k`, `--token=t`); a bare name and its `:` or `=` (`token=t`,
 * `password: p`, `Authorization: Bearer t`, `$env:API_KEY = k`); or `Bearer `. Each name is matched whole and then tested
 * (`CREDENTIAL`); an ordinary one is passed over and the search goes on after it, so it stays linear on any input.
 */
// Linear by construction (#699 round 5): every run a quantifier reads starts only at that run's start (the lookbehinds:
// no word character or `-` before a name, no `\` before a quoted name's escapes), and no two quantifiers next to each
// other can read the same characters, so a failed match never reads the same run again from inside it; what looks ahead
// (`-u`'s user:password) reads at most 256 characters. (A bare name may follow a `\`: `"a\ntoken=x"` in a JSON string's
// text.)
const NAMED =
  /(?<![\w-])(?:(?:-u|--user)(?:=|\s+)(?=\\*"[^"]{0,256}:|\\*'[^']{0,256}:|[^\s:"']{0,256}:)|(?<!\\)\\*["']([^"'\\\r\n]{1,100})\\*["']\s*[:=]\s*|(--?[\w-]+)(?:=|\s+)|([\w-]+)(?:\\+["'])?\s*[:=]\s*|[Bb]earer\s+)/g
function credentialStart(text: string): number {
  NAMED.lastIndex = 0
  for (let m = NAMED.exec(text); m; m = NAMED.exec(text)) {
    const name = m[1] ?? m[2] ?? m[3]
    if (name === undefined || CREDENTIAL.test(name)) return m.index + m[0].length
  }
  return -1
}

/** Everything after a credential's name in the string, masked. */
const maskCredentialTail: Step = (text) => {
  const at = credentialStart(text)
  return at < 0 || at >= text.length ? text : `${text.slice(0, at)}<redacted>`
}

const SECRETS: Step[] = [
  maskCredentialTail,
  // A sign-in's codes and signatures in a URL (OAuth's code and state, a device login's one-time code, a signed URL's signature).
  replacing(/([?&#](?:code|state|code_challenge|id_token|refresh_token|otc|ticket|sig|signature|nonce)=)[^&#\s"']+/gi, '$1<redacted>'),
  // Well-known key formats.
  replacing(/\b(?:sk-ant-|sk-|ghp_|gho_|ghu_|ghs_|github_pat_|xox[abprs]-|glpat-|AKIA)[\w-]{8,}/g, '<redacted>'),
  // JWTs.
  // (Only where a run of its characters starts: `eyJ-eyJ-…` read the rest of the run from each `eyJ`.)
  replacing(/(?<![\w-])eyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}/g, '<redacted>'),
  // Long hex or base64 runs (keys, tokens, hashes).
  replacing(/\b[0-9a-f]{20,}\b/gi, '<redacted>'),
  // (Only where a run starts: `+` and `=` before it too, or `+a+a…` was read again from after every `+`.)
  replacing(/(?<![\w/\\.+=-])[A-Za-z0-9+/]{40,}={0,2}(?![\w/\\.-])/g, '<redacted>'),
  // Email addresses. Each starts only where a run of its characters starts, so a long run is read once (from every word
  // boundary in `x-x-x…` it was read again and again).
  replacing(/(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
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
  return maskText(out)
}

/**
 * Masks what looks like a secret: everything after a credential's name (bare or quoted, a JSON key's too), known key and token
 * formats, sign-in codes in URLs, long hex or base64 runs and emails; names and paths before them stay.
 */
export function maskSecrets(text: string): string {
  let out = text
  for (const step of SECRETS) out = step(out)
  return out
}

/**
 * Sign-in codes in free text, which no name announces: a device code standing alone (`ABCD-EFGH`, `WXYZ-12345`), and a
 * code after the words a sign-in uses ("enter ABCD12345", "code: QX7-PL2-9KD"). Erring towards masking.
 */
const SIGN_IN_CODES: [RegExp, string][] = [
  [/(?<![\w-])[A-Z0-9]{4}-[A-Z0-9]{4,5}(?![\w-])/g, '<redacted>'],
  // (One run of spaces, then an optional `:` and its spaces: two runs side by side made a long run of spaces slow.)
  [/(\b(?:[Cc]ode|CODE|[Ee]nter|ENTER|OTP|otp|[Pp]asscode|PIN)\b[^\S\r\n]*(?:[:=][^\S\r\n]*)?)[A-Z0-9][A-Z0-9-]{5,15}(?![\w-])/g, '$1<redacted>']
]

/**
 * Masks what may be a secret in free text (a prompt, a reply, a command, a log line): maskSecrets' rules, then sign-in
 * codes. Names and identifiers use maskSecrets alone (a code-shaped name is no sign-in).
 */
export function maskText(text: string): string {
  let out = maskSecrets(text)
  for (const [re, by] of SIGN_IN_CODES) out = out.replace(re, by)
  return out
}

/**
 * Text the log marked as the user's own (logger.ts userText()): a span between Unicode isolate marks. A span stops at the
 * next opening mark too, so a line of opening marks is read once (not again from each one); what such a line leaves goes
 * with the next step's rest-of-line rule.
 */
const USER_TEXT = /⁨([^⁨⁩\n]*)⁩/g
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
  // Each line is a string of its own: a credential masks the rest of its line, and of the lines a continuation carries
  // it onto (a line ending in PowerShell's backtick or a shell's backslash), so a continued command can't leak there.
  let carried = false
  const continues = (line: string): boolean => /[`\\][^\S\n]*$/.test(line)
  return lines
    .map((line) => {
      const start = START_LINE.exec(line)
      if (start) {
        marked = start[1].includes(MARKED_LOG)
        carried = false
        return line
      }
      if (carried) {
        carried = continues(line)
        return '<redacted>'
      }
      // A line's time, level and [scope] stay as they are: a project called "sessions" mustn't take the scope with it.
      const head = /^\S+ \[[A-Z]+\] \[[\w-]+\] /.exec(line)?.[0] ?? ''
      if (!marked) return line.trim() ? `${head}${OLDER_LINE}` : line
      const rest = redact(hideUserText(line.slice(head.length)), ctx).replace(ABSOLUTE_PATH, (p) => (PLAIN_FOLDER.test(p) ? p : '<path>'))
      carried = rest.endsWith('<redacted>') && continues(line)
      return head + rest
    })
    .join('\n')
}
