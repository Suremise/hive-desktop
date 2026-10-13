import { dirname, join } from 'path'
import { readdir, writeFile } from 'original-fs/promises'
import { existsSync } from 'original-fs'
import { HIVE_DIR } from '../shared/defaults'
import { FIRST_COMMIT_MESSAGE, gitignoreName, gitignoreText, isGitignoreChoice, type GitInitCheck, type GitInitOptions } from '../shared/gitInit'
import { identityProblem, type GitIdentityPart } from '../shared/gitRepo'
import { samePlace } from './fsutil'
import { git, type GitResult } from './git'
import { gitSays, oneAtATime, parseIdentity } from './gitRepo'
import { gitProblem } from './gitTool'
import { ensureHiveExcluded, otherVcsOf, vcsOf } from './hiveVcs'
import { createLogger, userText } from './logger'
import { excludeCopies } from './providers/common'
import { workspace, workspaceOf } from './workspace'

const log = createLogger('gitInit')

/**
 * Initialise repository (#701): makes a project folder that isn't a git repository one, from its Git tab. In order:
 * `git init -b main`; the project's .hive (and Hive's copies of skills) added to `.git/info/exclude` and git asked
 * whether it ignores .hive, before anything is staged, so .hive can never be in the first commit (#345); the starter
 * .gitignore the user chose (never over one the folder has); the identity asked for, saved to this repository's config
 * only; everything staged and committed (an empty commit for an empty folder); then the workspace refreshed, so worktrees
 * work at once. Refused where another version control system keeps the folder, and inside another repository's working
 * tree unless the user confirmed it. There is no undo: what it did, and where it stopped, is said in full. A repository
 * with no commits yet (one that stopped short, say for an identity only the new repository could tell was missing, or one
 * made with `git init` by hand) can be taken on from there: everything but `git init`, with its identity read from it.
 */

const IDENTITY = '^user\\.(name|email)$'

/**
 * The identity a new repository in the folder is sure to have: the system config, then the global one over it, with the
 * files they include (`--includes`: a scoped query leaves them out by default), read as if no repository held the folder
 * (`GIT_CEILING_DIRECTORIES` above it), so neither an outer repository's own config nor a conditional include that
 * matches only it counts. And whether either has conditional includes (`includeIf`), which may add to it for the new
 * repository: only the repository itself can say, once it exists.
 */
async function outsideIdentity(cwd: string): Promise<{ identity: GitIdentityPart; conditional: boolean }> {
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(cwd) }
  const read = (scope: string, re: string): Promise<GitResult> => git(cwd, ['config', scope, '--includes', '--get-regexp', re], undefined, undefined, { env })
  const [system, global, sysIf, globalIf] = await Promise.all([read('--system', IDENTITY), read('--global', IDENTITY), read('--system', '^includeif\\.'), read('--global', '^includeif\\.')])
  return { identity: { ...parseIdentity(system), ...parseIdentity(global) }, conditional: [sysIf, globalIf].some((r) => r.ok && !!r.out.trim()) }
}

/** The identity git commits as in the new repository: every config it reads, conditional includes resolved for it. */
async function repoIdentity(projectPath: string): Promise<GitIdentityPart> {
  return parseIdentity(await git(projectPath, ['config', '--get-regexp', IDENTITY]))
}

/** Whether the folder holds nothing but .hive (an empty first commit). */
async function isEmpty(projectPath: string): Promise<boolean> {
  const names = await readdir(projectPath).catch(() => [] as string[])
  return names.every((n) => n === HIVE_DIR || n === '.git')
}

/** What the Initialise dialog needs: whether it can be done here, the repository around the folder, the identity, the folder's .gitignore. */
export async function initCheck(projectPath: string): Promise<GitInitCheck> {
  projectPath = workspace.assertProject(projectPath)
  const base = { identity: {}, hasGitignore: existsSync(join(projectPath, '.gitignore')), empty: await isEmpty(projectPath) }
  const problem = gitProblem()
  if (problem) return { ...base, refused: `${problem}: Agent Setup says how to fix it.` }
  // Looked for at every level whatever git is there: a colocated Jujutsu repository has .git beside .jj.
  const other = otherVcsOf(projectPath)
  if (other) return { ...base, refused: `${other.name} keeps this folder (in ${other.root}): Hive makes a git repository only where no other version control system is.` }
  const found = vcsOf(projectPath)
  if (found && samePlace(found.root, projectPath)) {
    const head = await git(projectPath, ['rev-parse', '-q', '--verify', 'HEAD'])
    if (head.ok) return { ...base, refused: 'This folder is a git repository already.' }
    if (head.code !== 1) return { ...base, refused: `Git couldn't read this repository: ${gitProblem() ?? gitSays(head)}` }
    // No commit yet: taken on from there, its identity read from it (what it will commit as, exactly).
    return { ...base, refused: null, resume: true, identity: await repoIdentity(projectPath) }
  }
  const { identity, conditional } = await outsideIdentity(projectPath)
  return { ...base, refused: null, identity, ...(conditional ? { conditionalIdentity: true } : {}), ...(found ? { parentRepo: found.root } : {}) }
}

/** Initialises the project folder as a git repository with a first commit; replies with what it did, in a sentence or two. */
export async function initRepo(projectPath: string, opts: GitInitOptions): Promise<string> {
  projectPath = workspace.assertProject(projectPath)
  const choice = opts?.gitignore ?? 'none'
  if (!isGitignoreChoice(choice)) throw new Error(`There's no starter .gitignore ${String(choice)}.`)
  const name = typeof opts.name === 'string' ? opts.name.trim() : ''
  const email = typeof opts.email === 'string' ? opts.email.trim() : ''
  const problem = identityProblem(name, email)
  if (problem) throw new Error(problem)
  return oneAtATime(projectPath, async () => {
    // Checked again here: the folder may have changed since the dialog asked.
    const check = await initCheck(projectPath)
    if (check.refused) throw new Error(check.refused)
    if (check.parentRepo && opts.nested !== true) throw new Error(`This folder is inside the git repository in ${check.parentRepo}. Confirm that you want a repository of its own inside it.`)
    // With conditional includes, only the new repository knows its identity: checked once it exists, below.
    if (!check.conditionalIdentity && !check.identity.name && !name) throw new Error('Git has no name to make the first commit as: enter one.')
    if (!check.conditionalIdentity && !check.identity.email && !email) throw new Error('Git has no email to make the first commit as: enter one.')

    // Each step that worked, so a failure says plainly where it stopped (there's no undo).
    const done: string[] = []
    const stop = (what: string, why: string): Error => new Error(`${done.length ? `${done.join(', ')}, but ` : ''}${what}: ${why}`)

    if (!check.resume) {
      const init = await git(projectPath, ['init', '-q', '-b', 'main'])
      if (!init.ok) throw stop("couldn't initialise the repository", gitProblem() ?? gitSays(init))
      done.push('Initialised a git repository on main')
      log.info(`Initialised a git repository in ${userText(projectPath)}`)
    }

    // Before anything is staged: .hive is never in the first commit, whatever the folder's .gitignore says.
    let ex: Awaited<ReturnType<typeof ensureHiveExcluded>>
    try {
      ex = await ensureHiveExcluded(projectPath)
    } catch (e) {
      throw stop("couldn't keep .hive out of git", e instanceof Error ? e.message : String(e))
    }
    if (!ex?.excluded) throw stop('git still doesn\'t ignore .hive here (a rule in a .gitignore may bring it back), so nothing was committed', 'fix that, then choose Make first commit on the Git tab')
    await excludeCopies(projectPath).catch((e) => log.warn('excluding skill copies after git init', e))

    // What the user entered fills only what git still lacks in the new repository (its config as git reads it there,
    // includes and conditional includes too), saved to this repository's own config, never the global one.
    const has = await repoIdentity(projectPath)
    let saved = false
    for (const [key, part, value] of [['user.name', 'name', name], ['user.email', 'email', email]] as const) {
      if (has[part] || !value) continue
      const r = await git(projectPath, ['config', '--local', key, value])
      if (!r.ok) throw stop(`couldn't set ${key}`, gitSays(r))
      saved = true
    }
    if (saved) done.push("set this repository's commit identity")
    const now = saved ? await repoIdentity(projectPath) : has
    const lacking = (['name', 'email'] as const).filter((k) => !now[k])
    // Nothing else is written yet: the dialog asks for it, and taking the repository on from here finishes the job.
    if (lacking.length) throw stop(`git has no ${lacking.join(' or ')} to make the first commit as here`, `enter ${lacking.length > 1 ? 'them' : 'it'} and choose Make first commit`)

    const template = check.hasGitignore || existsSync(join(projectPath, '.gitignore')) ? null : gitignoreText(choice)
    if (template) {
      try {
        await writeFile(join(projectPath, '.gitignore'), template, { flag: 'wx' })
      } catch (e) {
        throw stop("couldn't write the .gitignore", (e as NodeJS.ErrnoException).code ?? String(e))
      }
      done.push(`added ${gitignoreName(choice)}`)
    }

    const add = await git(projectPath, ['add', '-A', '--', '.'])
    if (!add.ok) throw stop("couldn't stage the folder's files", gitSays(add))
    // A last check that git's ignore did its job: nothing of .hive staged.
    const staged = await git(projectPath, ['diff', '--cached', '--name-only', '-z', '--', HIVE_DIR])
    if (!staged.ok || staged.out.replace(/\0/g, '')) {
      await git(projectPath, ['reset', '-q'])
      throw stop('.hive was staged, so nothing was committed', 'check the .gitignore for a rule that brings .hive back')
    }
    const files = await git(projectPath, ['diff', '--cached', '--name-only', '-z'])
    const count = files.ok ? files.out.split('\0').filter(Boolean).length : 0
    const commit = await git(projectPath, ['commit', '-q', '--allow-empty', '-m', FIRST_COMMIT_MESSAGE])
    if (!commit.ok) throw stop("couldn't make the first commit", `${gitSays(commit)}. Commit in a terminal, or ask an agent to`)
    done.push(count ? `committed ${count} file${count === 1 ? '' : 's'}` : 'made an empty first commit')
    log.info(`Made the first commit in ${userText(projectPath)} (${count} files)`)

    await workspaceOf(projectPath)
      .refresh()
      .catch((e) => log.warn('refreshing after git init', e))
    const list = done.join(', ').replace(/, ([^,]*)$/, ' and $1')
    const said = list.charAt(0).toUpperCase() + list.slice(1)
    return `${said}. .hive stays out of git. Agents can work in worktrees now.`
  })
}
