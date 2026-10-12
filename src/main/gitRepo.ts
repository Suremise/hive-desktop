import { join, resolve } from 'path'
import { stat } from 'original-fs/promises'
import { projectAgents } from '../shared/defaults'
import {
  BRANCHES_SHOWN,
  HISTORY_COMMITS,
  HISTORY_TAGS,
  folderBusy,
  identityProblem,
  parentRepoText,
  redactRemoteUrl,
  redactUrlsIn,
  scrubSecrets,
  urlSecrets,
  remoteNameProblem,
  remoteUrlProblem,
  type FolderSlot,
  type GitBranchRow,
  type GitFolderAction,
  type GitHistory,
  type GitIdentity,
  type GitIdentityPart,
  type GitRemote,
  type GitRepoInfo,
  type GitRepoState,
  type GitRepoSummary,
  type GitWorktreeRow
} from '../shared/gitRepo'
import { samePath } from '../shared/movePaths'
import { checkProject } from './branchWatch'
import { samePlace, withFileLock } from './fsutil'
import { git, type GitResult } from './git'
import { gitProblem } from './gitTool'
import { createLogger, userText } from './logger'
import { mergeSlots } from './mergeSlotHost'
import { sessions } from './sessions'
import { workspace, workspaceOf } from './workspace'

const log = createLogger('gitRepo')

/**
 * The Git view (#607): a project folder's branch, remotes, upstream, history, tags and identity, and the user's actions
 * on them. Everything here is the user's, from the window: no agent tool or Agent API route reaches it. Actions take
 * only a project folder (`assertProject`), never a worktree: agents' worktrees change through the merge flow. Nothing
 * fetches by itself: ahead/behind is as of the user's last fetch.
 */

/** Fetch, pull and push can wait on a sign-in window (Git Credential Manager): long, but never forever. */
const NETWORK_MS = 5 * 60_000

/** Commands that reach a remote never prompt in a terminal nobody sees: they fail instead (a credential helper's window still opens). */
function networkEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0' }
}

const net = (cwd: string, args: string[]): Promise<GitResult> => git(cwd, args, 16 * 1024 * 1024, undefined, { env: networkEnv(), timeout: NETWORK_MS })

/**
 * Git's own words for a failure, a few lines of them (a switch lists the files in the way), without its hints, and with
 * every URL it quotes shown without its password or token (`redactUrlsIn`): the message reaches the window and the log.
 */
export function gitSays(r: GitResult): string {
  if (r.timedOut) return `git gave up after ${NETWORK_MS / 60_000} minutes (no answer from the remote, or a sign-in left open).`
  const lines = `${r.err}\n${r.out}`
    .split(/\r?\n/)
    .map((l) => l.replace(/^(error|fatal): /, '').trimEnd())
    .filter((l) => l.trim() && !l.startsWith('hint:'))
  return redactUrlsIn(lines.slice(0, 8).join('\n')) || `exit code ${r.code}`
}

function failed(what: string, r: GitResult): Error {
  return new Error(`${what}: ${gitProblem() ?? gitSays(r)}`)
}

const EMPTY: GitRepoSummary = { isRepo: false, branch: null, head: null, state: null, upstream: null, remotes: [], fetchedAt: null }

/** ahead 2, behind 1 / gone / "" → counts. */
export function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  return { ahead: parseInt(/ahead (\d+)/.exec(track)?.[1] ?? '0', 10), behind: parseInt(/behind (\d+)/.exec(track)?.[1] ?? '0', 10), gone: /\bgone\b/.test(track) }
}

const STATE_FILES: [string, GitRepoState][] = [
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect']
]

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false)

/**
 * The folder's branch (or detached HEAD), any merge or rebase in progress, its upstream with ahead/behind as of the last
 * fetch, its remotes and when it last fetched. Cheap enough for the status bar: no working-tree scan.
 */
export async function repoSummary(root: string): Promise<GitRepoSummary> {
  const problem = gitProblem()
  if (problem) return { ...EMPTY, gitProblem: problem }
  const dir = await git(root, ['rev-parse', '--absolute-git-dir', '--show-toplevel'])
  if (!dir.ok) {
    if (gitProblem()) return { ...EMPTY, gitProblem: gitProblem()! }
    if (/not a git repository/i.test(dir.err)) return EMPTY
    throw failed('git rev-parse', dir)
  }
  const [gitDir, top] = dir.out.split(/\r?\n/).map((l) => l.trim())
  // A folder inside another repository (a workspace kept in git) shows it, but changes nothing of it.
  const parentRepo = top && !samePlace(top, root) ? resolve(top) : undefined
  const [sym, head, remotes] = await Promise.all([git(root, ['symbolic-ref', '-q', '--short', 'HEAD']), git(root, ['rev-parse', '-q', '--verify', '--short', 'HEAD']), git(root, ['remote'])])
  // symbolic-ref says 1 for a detached HEAD; anything else is a failure, not "detached" (#346).
  if (!sym.ok && sym.code !== 1) throw failed('git symbolic-ref', sym)
  if (!remotes.ok) throw failed('git remote', remotes)
  const branch = sym.ok ? sym.out.trim() : null
  let upstream: GitRepoSummary['upstream'] = null
  if (branch) {
    const r = await git(root, ['for-each-ref', '--format=%(refname)%00%(upstream:short)%00%(upstream:remotename)%00%(upstream:track,nobracket)', `refs/heads/${branch}`])
    if (!r.ok) throw failed('git for-each-ref', r)
    const row = r.out.split('\n').map((l) => l.split('\0')).find((f) => f[0] === `refs/heads/${branch}`)
    if (row?.[1]) upstream = { name: row[1], remote: row[2] && row[2] !== '.' ? row[2] : null, ...parseTrack(row[3] ?? '') }
    if (upstream && !upstream.gone) delete upstream.gone
  }
  let state: GitRepoState | null = null
  for (const [file, s] of STATE_FILES) {
    if (await exists(join(gitDir, file))) {
      state = s
      break
    }
  }
  const fetched = await stat(join(gitDir, 'FETCH_HEAD')).catch(() => null)
  return { isRepo: true, branch, head: head.ok ? head.out.trim() || null : null, state, upstream, remotes: remotes.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean), fetchedAt: fetched ? fetched.mtimeMs : null, ...(parentRepo ? { parentRepo } : {}) }
}

/** `git remote -v`: each remote's fetch and push URL (passwords hidden). */
export function parseRemotes(out: string): GitRemote[] {
  const by = new Map<string, GitRemote>()
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\S+)\t(.*) \((fetch|push)\)$/.exec(line.trim())
    if (!m) continue
    const r = by.get(m[1]) ?? { name: m[1], fetchUrl: '', pushUrl: '' }
    if (m[3] === 'fetch') r.fetchUrl = redactRemoteUrl(m[2])
    else r.pushUrl = redactRemoteUrl(m[2])
    by.set(m[1], r)
  }
  return [...by.values()]
}

/** `git worktree list --porcelain`: each worktree but the first (the main one). */
export function parseWorktrees(out: string): GitWorktreeRow[] {
  const rows: GitWorktreeRow[] = []
  for (const block of out.split(/\r?\n\r?\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1]
    if (!path) continue
    rows.push({ path: path.replace(/\//g, '\\'), branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null, head: /^HEAD ([0-9a-f]+)$/m.exec(block)?.[1]?.slice(0, 8) ?? null })
  }
  return rows.slice(1)
}

/** `git config --get-regexp ^user\.(name|email)$` (one scope or all): the last of each wins, as git takes it. */
function parseIdentity(r: GitResult): GitIdentityPart {
  const out: GitIdentityPart = {}
  if (!r.ok) return out
  for (const line of r.out.split(/\r?\n/)) {
    const m = /^user\.(name|email) (.*)$/i.exec(line)
    if (m) out[m[1].toLowerCase() as 'name' | 'email'] = m[2]
  }
  return out
}

async function identity(root: string): Promise<GitIdentity> {
  const re = '^user\\.(name|email)$'
  // Exit 1 is "none set"; other failures leave that part empty too (the section then says it isn't set).
  const [local, global, effective] = await Promise.all([git(root, ['config', '--local', '--get-regexp', re]), git(root, ['config', '--global', '--get-regexp', re]), git(root, ['config', '--get-regexp', re])])
  return { local: parseIdentity(local), global: parseIdentity(global), effective: parseIdentity(effective) }
}

/** Branches & remotes: the summary, the branches (local and remote), remotes with their URLs, other worktrees, identity. */
export async function repoInfo(root: string): Promise<GitRepoInfo> {
  const summary = await repoSummary(root)
  const none: GitRepoInfo = { summary, branches: [], remoteBranches: [], remotes: [], worktrees: [], identity: { local: {}, global: {}, effective: {} } }
  if (!summary.isRepo) return none
  const fields = ['%(refname)', '%(refname:short)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(objectname:short)', '%(committerdate:unix)', '%(contents:subject)']
  const [refs, remotes, wts, id] = await Promise.all([
    git(root, ['for-each-ref', '--sort=-committerdate', `--format=${fields.join('%00')}`, 'refs/heads', 'refs/remotes']),
    git(root, ['remote', '-v']),
    git(root, ['worktree', 'list', '--porcelain']),
    identity(root)
  ])
  if (!refs.ok) throw failed('git for-each-ref', refs)
  if (!remotes.ok) throw failed('git remote', remotes)
  const worktrees = wts.ok ? parseWorktrees(wts.out) : []
  const branches: GitBranchRow[] = []
  const remoteBranches: string[] = []
  for (const line of refs.out.split('\n')) {
    const f = line.split('\0')
    if (f.length < 7) continue
    if (f[0].startsWith('refs/remotes/')) {
      if (!f[0].endsWith('/HEAD')) remoteBranches.push(f[1])
      continue
    }
    const wt = worktrees.find((w) => w.branch === f[1])
    branches.push({ name: f[1], current: f[1] === summary.branch, upstream: f[2] || null, ...parseTrack(f[3]), worktree: wt?.path ?? null, commit: f[4], date: Number(f[5]) * 1000, subject: f[6] })
  }
  return { summary, branches: branches.slice(0, BRANCHES_SHOWN), remoteBranches: remoteBranches.slice(0, BRANCHES_SHOWN), remotes: parseRemotes(remotes.out), worktrees, identity: id }
}

/** The project folder's last commits, and its tags, newest first. */
export async function repoHistory(root: string): Promise<GitHistory> {
  const summary = await repoSummary(root)
  if (!summary.isRepo || !summary.head) return { commits: [], tags: [], moreTags: 0 }
  const [log_, tags] = await Promise.all([
    git(root, ['log', '-n', String(HISTORY_COMMITS), '--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%D%x00%s%x1e', 'HEAD', '--']),
    git(root, ['for-each-ref', '--sort=-creatordate', '--format=%(refname:short)%00%(objecttype)%00%(*objectname:short)%00%(objectname:short)%00%(creatordate:unix)%00%(contents:subject)%00%(*subject)', 'refs/tags'])
  ])
  if (!log_.ok) throw failed('git log', log_)
  if (!tags.ok) throw failed('git for-each-ref', tags)
  const commits = log_.out
    .split('\x1e')
    .map((r) => r.replace(/^\r?\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const f = r.split('\0')
      return { hash: f[0], short: f[1], author: f[2], email: f[3], date: Number(f[4]) * 1000, refs: f[5] ? f[5].split(', ').filter(Boolean) : [], subject: f[6] ?? '' }
    })
  const all = tags.out
    .split('\n')
    .map((l) => l.split('\0'))
    .filter((f) => f.length >= 7 && f[0])
    .map((f) => {
      const annotated = f[1] === 'tag'
      return { name: f[0], commit: annotated ? f[2] : f[3], date: Number(f[4]) * 1000, subject: (annotated ? f[5] : f[5] || f[6]) ?? '', annotated }
    })
  return { commits, tags: all.slice(0, HISTORY_TAGS), moreTags: Math.max(0, all.length - HISTORY_TAGS) }
}

// ---------------------------------------------------------------------------
// The user's actions
// ---------------------------------------------------------------------------

/** One action at a time per project folder (a second click, or another window). */
const running = new Map<string, Promise<unknown>>()

function oneAtATime<T>(projectPath: string, fn: () => Promise<T>, urls: string[] = []): Promise<T> {
  const key = projectPath.toLowerCase()
  const prev = running.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn).catch(async (e: unknown) => {
    throw await scrubbed(projectPath, e, urls)
  })
  const tail = run.catch(() => undefined)
  running.set(key, tail)
  void tail.then(() => running.get(key) === tail && running.delete(key))
  return run
}

/**
 * An action's failure without any secret of the repository's remote URLs (and of `urls`, one being added), however the
 * message quotes them: `gitSays` hides what looks like a URL's password or query, and this the exact parts of every
 * configured one (`urlSecrets`), in case git quoted one some other way. The message reaches the window and the log.
 */
async function scrubbed(projectPath: string, e: unknown, urls: string[]): Promise<unknown> {
  if (!(e instanceof Error)) return e
  const r = await git(projectPath, ['config', '--get-regexp', String.raw`^remote\..*\.(push)?url$`])
  const configured = r.ok ? r.out.split(/\r?\n/).filter(Boolean).map((l) => l.slice(l.indexOf(' ') + 1)) : []
  const secrets = [...new Set([...configured, ...urls].flatMap(urlSecrets))].sort((a, b) => b.length - a.length)
  const message = scrubSecrets(e.message, secrets)
  return message === e.message ? e : new Error(message)
}

/** The project's agents working in its folder (not a worktree), with their sessions' status. */
async function folderAgents(projectPath: string): Promise<{ name: string; status: string | null }[]> {
  const cfg = await workspace.projectConfig(projectPath)
  return projectAgents(cfg)
    .filter((a) => !a.worktree)
    .map((a) => ({ name: a.name, status: sessions.liveFor(projectPath, a.id)?.status ?? null }))
}

function folderSlots(projectPath: string): FolderSlot[] {
  return mergeSlots
    .list(projectPath)
    .filter((s) => samePath(s.project, projectPath))
    .map((s) => ({ branch: s.branch, holder: s.holder && s.holder.kind !== 'user' ? s.holder.name : null, ...(s.holder?.kind === 'user' ? { byUser: true } : {}), waiting: s.waiting.map((w) => w.name) }))
}

/**
 * Switching branch or pulling moves the ground under the agents working in the folder and under a merge into its
 * branch: refused while one works there or the merge slot is held or waited for, saying why. The change itself runs
 * holding the slot of the branch it leaves and Hive's merge lock, so a merge can't start in the middle. An agent may
 * start working while it waits for them, so it is checked again once they are held, right before git runs (nothing is
 * awaited between that check and starting git).
 */
async function changeFolder<T>(projectPath: string, action: GitFolderAction, branch: string | null, fn: () => Promise<T>): Promise<T> {
  const why = folderBusy(await folderAgents(projectPath), folderSlots(projectPath), action)
  if (why) throw new Error(why)
  const locked = (): Promise<T> =>
    withFileLock(join(projectPath, '.git', 'hive-merge'), async () => {
      // The slot is this action's own now (asUser refuses when anyone else holds or waits for it); without a branch to
      // hold it for (a detached HEAD), the slots are checked again too.
      const now = folderBusy(await folderAgents(projectPath), branch ? [] : folderSlots(projectPath), action)
      if (now) throw new Error(now)
      return fn()
    })
  return branch ? mergeSlots.asUser(projectPath, branch, locked) : locked()
}

/** After the folder's branch or commit changed: the window's project info, and worktree agents' unmerged counts. */
async function changed(projectPath: string): Promise<void> {
  await workspaceOf(projectPath).refresh().catch((e) => log.warn('refreshing after a git change', e))
  void checkProject(projectPath)
}

async function summaryOf(projectPath: string): Promise<GitRepoSummary> {
  const s = await repoSummary(projectPath)
  if (s.gitProblem) throw new Error(s.gitProblem)
  if (!s.isRepo) throw new Error(`${projectPath} isn't a git repository.`)
  const parent = parentRepoText(s)
  if (parent) throw new Error(parent)
  return s
}

async function refFormatOk(projectPath: string, args: string[]): Promise<boolean> {
  return (await git(projectPath, ['check-ref-format', ...args])).ok
}

/** Switches the project folder to a local branch, or to a remote one (origin/x) as a new local branch tracking it. */
export async function switchBranch(projectPath: string, target: string): Promise<string> {
  projectPath = workspace.assertProject(projectPath)
  return oneAtATime(projectPath, async () => {
    const s = await summaryOf(projectPath)
    if (target === s.branch) return `Already on ${target}.`
    const info = await repoInfo(projectPath)
    const local = info.branches.find((b) => b.name === target) ?? ((await git(projectPath, ['show-ref', '--verify', '-q', `refs/heads/${target}`])).ok ? { worktree: null } : null)
    const remote = !local && info.remoteBranches.includes(target)
    if (!local && !remote) throw new Error(`There's no branch ${target}.`)
    if (local?.worktree) throw new Error(`${target} is checked out in another worktree (${local.worktree}): a branch can be in only one folder at a time.`)
    const r = await changeFolder(projectPath, 'switch', s.branch, () => git(projectPath, local ? ['checkout', '-q', target, '--'] : ['checkout', '-q', '--track', target, '--']))
    if (!r.ok) throw failed(`Couldn't switch to ${target}`, r)
    log.info(`Switched ${userText(projectPath)} to ${userText(target)}`)
    await changed(projectPath)
    return local ? `Switched to ${target}.` : `Switched to ${target.slice(target.indexOf('/') + 1)}, tracking ${target}.`
  })
}

/** Creates a branch at the folder's commit, switching to it unless `stay`. */
export async function createBranch(projectPath: string, name: string, stay = false): Promise<string> {
  projectPath = workspace.assertProject(projectPath)
  name = name.trim()
  return oneAtATime(projectPath, async () => {
    const s = await summaryOf(projectPath)
    if (!name || name.startsWith('-') || !(await refFormatOk(projectPath, ['--branch', name]))) throw new Error(`${name || 'That'} isn't a valid branch name.`)
    if (!s.head) throw new Error('The repository has no commits yet: commit something first.')
    if (stay) {
      const r = await git(projectPath, ['branch', '--no-track', name])
      if (!r.ok) throw failed(`Couldn't create ${name}`, r)
      log.info(`Created branch ${userText(name)} in ${userText(projectPath)}`)
      return `Created ${name} at ${s.head}.`
    }
    const r = await changeFolder(projectPath, 'create', s.branch, () => git(projectPath, ['checkout', '-q', '--no-track', '-b', name, '--']))
    if (!r.ok) throw failed(`Couldn't create ${name}`, r)
    log.info(`Created and switched to ${userText(name)} in ${userText(projectPath)}`)
    await changed(projectPath)
    return `Created ${name} and switched to it.`
  })
}

export async function addRemote(projectPath: string, name: string, url: string): Promise<string> {
  projectPath = workspace.assertProject(projectPath)
  name = name.trim()
  url = url.trim()
  const problem = remoteNameProblem(name) ?? remoteUrlProblem(url)
  if (problem) throw new Error(problem)
  return oneAtATime(projectPath, async () => {
    await summaryOf(projectPath)
    const r = await git(projectPath, ['remote', 'add', '--', name, url])
    if (!r.ok) throw failed(`Couldn't add ${name}`, r)
    log.info(`Added remote ${userText(name)} to ${userText(projectPath)}`)
    return `Added ${name}.`
  }, [url])
}

/** Changes a remote's URL (its fetch URL, and its push URL unless that is set separately). */
export async function setRemoteUrl(projectPath: string, name: string, url: string): Promise<string> {
  projectPath = workspace.assertProject(projectPath)
  url = url.trim()
  const problem = remoteUrlProblem(url)
  if (problem) throw new Error(problem)
  return oneAtATime(projectPath, async () => {
    await summaryOf(projectPath)
    const r = await git(projectPath, ['remote', 'set-url', '--', name, url])
    if (!r.ok) throw failed(`Couldn't change ${name}'s URL`, r)
    log.info(`Changed remote ${userText(name)}'s URL in ${userText(projectPath)}`)
    return `Changed ${name}'s URL.`
  }, [url])
}

/** Fetches every remote: the only way ahead/behind changes (Hive never fetches by itself). */
export async function fetchAll(projectPath: string): Promise<string> {
  projectPath = workspace.assertProject(projectPath)
  return oneAtATime(projectPath, async () => {
    const s = await summaryOf(projectPath)
    if (!s.remotes.length) throw new Error('This repository has no remotes to fetch from: add one first.')
    const r = await net(projectPath, ['fetch', '--all'])
    if (!r.ok) throw failed("Couldn't fetch", r)
    log.info(`Fetched ${userText(projectPath)}`)
    void checkProject(projectPath)
    return `Fetched ${s.remotes.join(', ')}.`
  })
}

/**
 * Fetches the branch's upstream, then brings the branch up to it only when that needs no merge (fast-forward): a
 * branch that has diverged is left as it is, with what to do.
 */
export async function pull(projectPath: string): Promise<string> {
  projectPath = workspace.assertProject(projectPath)
  return oneAtATime(projectPath, async () => {
    const s = await summaryOf(projectPath)
    if (!s.branch) throw new Error('HEAD is detached: switch to a branch to pull.')
    if (!s.upstream) throw new Error(`${s.branch} tracks no remote branch: push it first, or switch to one that does.`)
    if (s.state) throw new Error(`Git is in the middle of a ${s.state}: finish or abort it first.`)
    // Refused before the fetch too, so a pull that can't go ahead doesn't wait on the network first.
    const why = folderBusy(await folderAgents(projectPath), folderSlots(projectPath), 'pull')
    if (why) throw new Error(why)
    if (s.upstream.remote) {
      const f = await net(projectPath, ['fetch', '--', s.upstream.remote])
      if (!f.ok) throw failed("Couldn't fetch", f)
    }
    const now = await summaryOf(projectPath)
    const u = now.upstream
    if (!u || u.gone) throw new Error(`${s.upstream.name} is gone from the remote.`)
    if (u.behind === 0) return `${now.branch} is up to date with ${u.name}.`
    if (u.ahead > 0) throw new Error(`${now.branch} and ${u.name} have diverged (${u.ahead} commit${u.ahead === 1 ? '' : 's'} here, ${u.behind} there), so pulling needs a merge or rebase. Do that in a terminal, or ask an agent to.`)
    const r = await changeFolder(projectPath, 'pull', now.branch, () => git(projectPath, ['merge', '--ff-only', '@{upstream}']))
    if (!r.ok) throw failed("Couldn't pull", r)
    log.info(`Pulled ${userText(projectPath)}`)
    await changed(projectPath)
    return `Pulled ${u.behind} commit${u.behind === 1 ? '' : 's'} from ${u.name}.`
  })
}

/** Pushes the branch to its upstream, or to `remote` (setting it as the upstream) when it has none. Never forced. */
export async function push(projectPath: string, remote?: string): Promise<string> {
  projectPath = workspace.assertProject(projectPath)
  return oneAtATime(projectPath, async () => {
    const s = await summaryOf(projectPath)
    if (!s.branch) throw new Error('HEAD is detached: switch to a branch to push.')
    if (!s.head) throw new Error('The repository has no commits yet: nothing to push.')
    let args: string[]
    let to: string
    if (s.upstream?.remote && !s.upstream.gone && !remote) {
      const merge = (await git(projectPath, ['config', '--get', `branch.${s.branch}.merge`])).out.trim()
      const dest = merge.startsWith('refs/heads/') ? merge : `refs/heads/${s.branch}`
      args = ['push', '--', s.upstream.remote, `refs/heads/${s.branch}:${dest}`]
      to = s.upstream.name
    } else {
      const r = remote ?? (s.remotes.length === 1 ? s.remotes[0] : s.remotes.includes('origin') ? 'origin' : null)
      if (!r) throw new Error(s.remotes.length ? 'Choose the remote to push to.' : 'This repository has no remotes: add one first.')
      if (!s.remotes.includes(r)) throw new Error(`There's no remote ${r}.`)
      args = ['push', '--set-upstream', '--', r, `refs/heads/${s.branch}:refs/heads/${s.branch}`]
      to = `${r}/${s.branch}`
    }
    const r = await net(projectPath, args)
    if (!r.ok) {
      if (/\[rejected\]|non-fast-forward|fetch first/i.test(r.err)) throw new Error(`${to} has commits ${s.branch} hasn't, so the push was refused (Hive never forces a push). Pull first, or merge them in a terminal.`)
      throw failed(`Couldn't push to ${to}`, r)
    }
    log.info(`Pushed ${userText(projectPath)} to ${userText(to)}`)
    void checkProject(projectPath)
    return `Pushed ${s.branch} to ${to}.`
  })
}

/** Tags the folder's commit: annotated when there's a message. Pushes the tag to `pushTo` when given. */
export async function createTag(projectPath: string, name: string, message: string, pushTo?: string): Promise<string> {
  projectPath = workspace.assertProject(projectPath)
  name = name.trim()
  message = message.trim()
  return oneAtATime(projectPath, async () => {
    const s = await summaryOf(projectPath)
    if (!s.head) throw new Error('The repository has no commits yet: nothing to tag.')
    if (!name || name.startsWith('-') || !(await refFormatOk(projectPath, [`refs/tags/${name}`]))) throw new Error(`${name || 'That'} isn't a valid tag name.`)
    if (pushTo && !s.remotes.includes(pushTo)) throw new Error(`There's no remote ${pushTo}.`)
    const r = await git(projectPath, message ? ['tag', '-a', '-m', message, name, 'HEAD'] : ['tag', name, 'HEAD'])
    if (!r.ok) throw failed(`Couldn't create ${name}`, r)
    log.info(`Tagged ${userText(projectPath)} ${userText(name)}`)
    if (!pushTo) return `Tagged ${s.head} ${name}.`
    const p = await net(projectPath, ['push', '--', pushTo, `refs/tags/${name}:refs/tags/${name}`])
    if (!p.ok) throw failed(`Tagged ${s.head} ${name}, but couldn't push it to ${pushTo}`, p)
    return `Tagged ${s.head} ${name} and pushed it to ${pushTo}.`
  })
}

/** Sets this repository's own commit name and email (`git config --local`); an empty one is removed, so the global one applies. */
export async function setIdentity(projectPath: string, name: string, email: string): Promise<string> {
  projectPath = workspace.assertProject(projectPath)
  name = name.trim()
  email = email.trim()
  const problem = identityProblem(name, email)
  if (problem) throw new Error(problem)
  return oneAtATime(projectPath, async () => {
    await summaryOf(projectPath)
    for (const [key, value] of [['user.name', name], ['user.email', email]] as const) {
      const r = value ? await git(projectPath, ['config', '--local', key, value]) : await git(projectPath, ['config', '--local', '--unset-all', key])
      // --unset-all says 5 when there was none to remove.
      if (!r.ok && !(r.code === 5 && !value)) throw failed(`Couldn't set ${key}`, r)
    }
    log.info(`Set the commit identity of ${userText(projectPath)}`)
    return name || email ? 'Set this repository\'s commit identity.' : 'Removed this repository\'s own identity: your global one applies.'
  })
}
