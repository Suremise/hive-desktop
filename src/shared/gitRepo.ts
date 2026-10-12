// The Git view (#607): a project folder's branch, remotes, upstream, history, tags and commit identity, and what the
// window says about them. Shared by the main process, the window and their tests. Only the user changes these: there is
// no agent tool or Agent API route for any of it.

/** A merge, rebase or other operation git has in progress in the folder. */
export type GitRepoState = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect'

/** The branch the folder's branch tracks, with how far apart they are as of the last fetch. */
export interface GitUpstream {
  /** As git shows it: origin/main. */
  name: string
  /** The remote it is on, or null when it is a local branch. */
  remote: string | null
  ahead: number
  behind: number
  /** The remote branch no longer exists (deleted there, and a fetch noticed). */
  gone?: boolean
}

/** What the status bar shows, and the top of Branches & remotes. */
export interface GitRepoSummary {
  isRepo: boolean
  /** Git can't run (#346): said instead of "isn't a git repository". */
  gitProblem?: string
  /** The branch checked out, or null when HEAD is detached (or not a repository). */
  branch: string | null
  /** The commit checked out (short), or null before the first commit. */
  head: string | null
  state: GitRepoState | null
  upstream: GitUpstream | null
  /** The remotes' names. */
  remotes: string[]
  /** When the folder last fetched (FETCH_HEAD's time), or null if it never has. */
  fetchedAt: number | null
  /**
   * The folder isn't a repository's own top but inside one (a workspace kept in git): that repository's folder. The view
   * shows it, read-only: Hive changes only a project's own repository.
   */
  parentRepo?: string
}

export interface GitRemote {
  name: string
  /** Its password or token shows as ••• (`redactRemoteUrl`). */
  fetchUrl: string
  pushUrl: string
}

export interface GitBranchRow {
  name: string
  current: boolean
  upstream: string | null
  ahead: number
  behind: number
  gone: boolean
  /** Checked out in another worktree (an agent's, or an unused one): that folder. */
  worktree: string | null
  commit: string
  /** Its last commit's time (ms). */
  date: number
  subject: string
}

export interface GitWorktreeRow {
  path: string
  branch: string | null
  head: string | null
}

export interface GitIdentityPart {
  name?: string
  email?: string
}

/** Who commits are made as: this repository's own setting, the global one, and the one git uses (last wins). */
export interface GitIdentity {
  local: GitIdentityPart
  global: GitIdentityPart
  effective: GitIdentityPart
}

/** Branches & remotes. */
export interface GitRepoInfo {
  summary: GitRepoSummary
  branches: GitBranchRow[]
  /** Remote branches (origin/feature), newest first, without the remotes' HEAD. */
  remoteBranches: string[]
  remotes: GitRemote[]
  /** The repository's other worktrees (agents' and unused ones): shown, never changed here. */
  worktrees: GitWorktreeRow[]
  identity: GitIdentity
}

export interface GitCommitRow {
  hash: string
  short: string
  author: string
  email: string
  /** ms */
  date: number
  /** Branches and tags pointing at it, as git decorates them (HEAD -> main, tag: v1.0, origin/main). */
  refs: string[]
  subject: string
}

export interface GitTagRow {
  name: string
  /** The commit it points at (short). */
  commit: string
  /** ms: the tag's own date when annotated, else its commit's. */
  date: number
  /** An annotated tag's message, else the commit's subject. */
  subject: string
  annotated: boolean
}

export interface GitHistory {
  /** The project folder's last commits, newest first (HISTORY_COMMITS). */
  commits: GitCommitRow[]
  /** Newest first, at most HISTORY_TAGS. */
  tags: GitTagRow[]
  /** Tags not listed. */
  moreTags: number
}

export const HISTORY_COMMITS = 20
export const HISTORY_TAGS = 50
/** Branches listed (local and remote, each); the rest are counted. */
export const BRANCHES_SHOWN = 200

/** The Git tab's sections. */
export const GIT_SECTIONS = [
  { id: 'changes', label: 'Changes', icon: 'git-compare' },
  { id: 'history', label: 'History', icon: 'history' },
  { id: 'branches', label: 'Branches & remotes', icon: 'git-branch' }
] as const
export type GitSection = (typeof GIT_SECTIONS)[number]['id']

/** The actions refused while an agent works in the project folder or holds its merge slot. */
export type GitFolderAction = 'switch' | 'create' | 'pull'

const ACTION_TEXT: Record<GitFolderAction, string> = { switch: 'switch branches', create: 'create and switch to a branch', pull: 'pull' }

/** An agent working in the project folder (no worktree), with its session's status. */
export interface FolderAgent {
  name: string
  status?: string | null
}

/** A merge slot of the project folder: who holds it and who waits. */
export interface FolderSlot {
  branch: string
  /** The agent holding it; null when free or when it's the user's own merge (`byUser`). */
  holder: string | null
  byUser?: boolean
  waiting: string[]
}

const BUSY: Record<string, string> = {
  starting: 'is starting',
  working: 'is working',
  waiting: 'is waiting for your answer',
  background: 'is waiting on background tasks it started',
  watching: 'is waiting for cards to change (a card watch)',
  signin: 'stopped in the middle of a task when its sign-in expired'
}

/**
 * Why switching branch or pulling in the project folder is refused now, or null: it moves the ground under an agent
 * that works there, and under a merge into its branch. Checked in the window (the buttons are disabled with this as the
 * reason) and again by the main process before it acts.
 */
export function folderBusy(agents: FolderAgent[], slots: FolderSlot[], action: GitFolderAction): string | null {
  const what = ACTION_TEXT[action]
  for (const a of agents) {
    const busy = a.status ? BUSY[a.status] : undefined
    if (busy) return `${a.name} ${busy} in the project folder: ${what} once it has finished.`
  }
  for (const s of slots) {
    if (s.byUser) return `Your merge into ${s.branch} is running: ${what} once it is done.`
    if (s.holder) return `${s.holder} holds the merge slot for ${s.branch}: ${what} once that merge is done.`
    if (s.waiting.length) return `${s.waiting.join(', ')} ${s.waiting.length === 1 ? 'is' : 'are'} waiting for the merge slot for ${s.branch}: ${what} once those merges are done.`
  }
  return null
}

const STATE_TEXT: Record<GitRepoState, string> = { merge: 'merging', rebase: 'rebasing', 'cherry-pick': 'cherry-picking', revert: 'reverting', bisect: 'bisecting' }

/** "merging" and so on, for a state git has in progress. */
export function gitStateText(state: GitRepoState): string {
  return STATE_TEXT[state]
}

/** What HEAD is: the branch, or "detached at abc1234" (or "no commits yet"). */
export function headText(s: Pick<GitRepoSummary, 'branch' | 'head'>): string {
  return s.branch ?? (s.head ? `detached at ${s.head}` : 'no commits yet')
}

/** ↑2 ↓0, or "upstream gone". */
export function aheadBehindText(u: Pick<GitUpstream, 'ahead' | 'behind' | 'gone'>): string {
  return u.gone ? 'upstream gone' : `↑${u.ahead} ↓${u.behind}`
}

/** Why the Git view doesn't change a folder inside another repository (`parentRepo`), or null. */
export function parentRepoText(s: Pick<GitRepoSummary, 'parentRepo'>): string | null {
  return s.parentRepo ? `This project is inside the git repository in ${s.parentRepo}, so the Git view only shows it: Hive changes only a project's own repository.` : null
}

/** The status bar's item: "main · origin · ↑2 ↓0", "main · no upstream", "detached at abc1234 · rebasing". Empty when not a repository. */
export function gitStatusText(s: GitRepoSummary): string {
  if (!s.isRepo) return ''
  const parts = [headText(s)]
  if (s.state) parts.push(gitStateText(s.state))
  if (s.upstream) parts.push(s.upstream.remote ?? s.upstream.name, aheadBehindText(s.upstream))
  else if (s.branch && s.remotes.length) parts.push('no upstream')
  return parts.join(' · ')
}

/** The status bar item's tooltip, with when the counts are from. */
export function gitStatusTip(s: GitRepoSummary, fetched: string | null): string {
  const lines = [s.branch ? `On ${s.branch}` : s.head ? `HEAD is detached at ${s.head}` : 'No commits yet']
  if (s.state) lines.push(`Git is ${gitStateText(s.state)}: finish or abort it in a terminal.`)
  if (s.upstream?.gone) lines.push(`It tracked ${s.upstream.name}, which is gone from the remote.`)
  else if (s.upstream) lines.push(`Tracks ${s.upstream.name}: ${count(s.upstream.ahead, 'commit')} to push, ${count(s.upstream.behind, 'commit')} to pull.`)
  else if (s.branch && s.remotes.length) lines.push(`It tracks no remote branch: Push sets one.`)
  else if (!s.remotes.length) lines.push('No remotes.')
  if (s.remotes.length) lines.push(fetched ? `As of the last fetch, ${fetched}. Hive never fetches by itself.` : 'Never fetched: Hive never fetches by itself.')
  lines.push('Click for Git → Branches & remotes.')
  return lines.join('\n')
}

function count(n: number, what: string): string {
  return n === 0 ? 'nothing' : `${n} ${what}${n === 1 ? '' : 's'}`
}

/** What stands for a hidden password or token. */
export const HIDDEN = '•••'

const URL_START = /^([a-z][a-z0-9+.-]*:\/\/)([\s\S]*)$/i
/** Schemes whose user name is often a token itself: all of their userinfo is hidden. */
const TOKEN_SCHEMES = /^(https?|ftps?):/i

/**
 * A remote URL with its password or token hidden (https://•••@github.com/x/y, ftp://•••@host/r, ssh://me:•••@host/r,
 * https://host/r.git?•••), wherever it is shown or logged. Others (git@github.com:x/y, a folder) as they are. It errs
 * towards hiding: the sign-in is everything before the last @ ahead of the query (a password may hold / or '), and the
 * whole query and fragment go (any value of them may be a token).
 */
export function redactRemoteUrl(url: string): string {
  const m = URL_START.exec(url)
  if (!m) return url
  const [, scheme, rest] = m
  const q = rest.search(/[?#]/)
  let place = q < 0 ? rest : rest.slice(0, q)
  const at = place.lastIndexOf('@')
  if (at >= 0) {
    const info = place.slice(0, at)
    // All of it for http(s) and ftp(s); for other schemes (ssh://git@host) the user name stays and only a password goes.
    const shown = TOKEN_SCHEMES.test(scheme) ? HIDDEN : info.includes(':') ? `${info.slice(0, info.indexOf(':'))}:${HIDDEN}` : info
    place = `${shown}${place.slice(at)}`
  }
  return `${scheme}${place}${q < 0 ? '' : `${rest[q]}${HIDDEN}`}`
}

/**
 * Text that may quote remote URLs (git's own error messages): each URL in it, to the next whitespace (a quote or
 * apostrophe can be part of a password or query), as `redactRemoteUrl` shows it.
 */
export function redactUrlsIn(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, (u) => redactRemoteUrl(u))
}

/**
 * The secret parts of a remote URL as configured: its password (an http(s) or ftp(s) URL's whole userinfo too), its
 * query and each of its values, as written and decoded, so text that quotes them in any other way can be cleaned of
 * them (`scrubSecrets`). Parts shorter than four characters are left: replacing them would garble the text.
 */
export function urlSecrets(url: string): string[] {
  const m = URL_START.exec(url.trim())
  if (!m) return []
  const [, scheme, rest] = m
  const out: string[] = []
  const q = rest.search(/[?#]/)
  const place = q < 0 ? rest : rest.slice(0, q)
  const at = place.lastIndexOf('@')
  if (at >= 0) {
    const info = place.slice(0, at)
    if (TOKEN_SCHEMES.test(scheme)) out.push(info)
    if (info.includes(':')) out.push(info.slice(info.indexOf(':') + 1))
  }
  if (q >= 0) {
    const query = rest.slice(q + 1)
    out.push(query, ...query.split(/[&;#]/).map((p) => (p.includes('=') ? p.slice(p.indexOf('=') + 1) : p)))
  }
  const decoded = out.map((s) => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s
    }
  })
  return [...new Set([...out, ...decoded])].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length)
}

/** Text with each of `secrets` (longest first) replaced by •••. */
export function scrubSecrets(text: string, secrets: string[]): string {
  let out = text
  for (const s of secrets) out = out.split(s).join(HIDDEN)
  return out
}

/** A GitHub remote. */
export function isGitHubUrl(url: string): boolean {
  return /(^|[@/.])github\.com[:/]/i.test(url)
}

/** GitHub's no-reply address (12345+name@users.noreply.github.com, or name@users.noreply.github.com). */
export function isNoReplyEmail(email: string): boolean {
  return /@users\.noreply\.github\.com$/i.test(email.trim())
}

/**
 * What the identity section warns about: commits that would fail (no name or email), and a personal address on commits
 * that go to GitHub, where everyone can read it (GitHub's no-reply address keeps it private).
 */
export function identityWarnings(id: GitIdentity, remotes: Pick<GitRemote, 'fetchUrl' | 'pushUrl'>[]): string[] {
  const out: string[] = []
  const missing = [!id.effective.name && 'user.name', !id.effective.email && 'user.email'].filter(Boolean)
  if (missing.length) out.push(`Git has no ${missing.join(' or ')} for this repository, so commits fail. Set them here (or in your global git config).`)
  const email = id.effective.email
  if (email && !isNoReplyEmail(email) && remotes.some((r) => isGitHubUrl(r.fetchUrl) || isGitHubUrl(r.pushUrl))) {
    out.push(`Commits pushed to GitHub show ${email} to anyone who reads them. GitHub's no-reply address (…@users.noreply.github.com, in GitHub's email settings) keeps your address private.`)
  }
  return out
}

/** A remote's name as `git remote add` takes it here: letters, digits, . _ - (not starting with - or .). */
export function remoteNameProblem(name: string): string | null {
  if (!name.trim()) return 'Enter a name'
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(name.trim())) return 'Use letters, digits, ".", "_" and "-"'
  return null
}

/** A remote URL Hive passes to git: one line, not an option. */
export function remoteUrlProblem(url: string): string | null {
  const u = url.trim()
  if (!u) return 'Enter a URL'
  if (/\s/.test(u) || u.startsWith('-')) return "That isn't a URL or path"
  if (u.includes(HIDDEN)) return 'Type the whole URL: its password or token is hidden here'
  return null
}

/** Name and email for `git config user.*`: one line each; an email has an @. Empty clears this repository's own. */
export function identityProblem(name: string, email: string): string | null {
  if (/[\r\n<>]/.test(name)) return 'A name is one line, without < or >'
  if (email.trim() && (!/^[^\s<>@]+@[^\s<>@]+$/.test(email.trim()))) return "That isn't an email address"
  return null
}

/** The user guide's heading for this view. */
export const GIT_VIEW_GUIDE = 'Git view'
