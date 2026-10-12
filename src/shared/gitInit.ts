// Initialise repository (#701): a project that isn't a git repository becomes one from its Git tab, in one click: `git
// init -b main`, .hive excluded before anything is staged, an optional starter .gitignore, a first commit, then a
// refresh so worktrees work at once. Shared by the main process, the window and their tests.

import { identityProblem, type GitIdentityPart } from './gitRepo'

/** The starter .gitignore choices: none, a minimal one, or a template for a kind of project. */
export type GitignoreChoice = 'none' | 'minimal' | 'node' | 'python' | 'dotnet' | 'godot'

/** What the Initialise dialog needs to know first (`git:initCheck`). */
export interface GitInitCheck {
  /** Why it can't be done here (already a repository, another version control system, git missing), or null. */
  refused: string | null
  /**
   * The folder is a git repository with no commit yet (one that stopped short, or `git init` by hand): it is taken on
   * from there, everything but `git init`, and its identity is read from it, so it is exactly what it will commit as.
   */
  resume?: boolean
  /** The repository whose working tree holds the folder: initialising inside it needs the user's say. */
  parentRepo?: string
  /** The identity git would commit as, from the global and system config: a part missing is asked for. */
  identity: GitIdentityPart
  /**
   * The system or global config has conditional includes (`includeIf`), which may set the identity for the new
   * repository: only it can say, so what is entered is optional, used only for what git still lacks there.
   */
  conditionalIdentity?: boolean
  /** The folder has a .gitignore of its own: it is kept, and no starter one is offered. */
  hasGitignore: boolean
  /** The folder has nothing to commit (apart from .hive): the first commit is an empty one. */
  empty: boolean
}

/** What the user chose in the dialog (`git:init`). */
export interface GitInitOptions {
  gitignore: GitignoreChoice
  /** Asked for only when git has none: saved to this repository's config, never the global one. */
  name?: string
  email?: string
  /** The user confirmed initialising inside another repository's working tree. */
  nested?: boolean
}

/** OS and editor leftovers and logs: in every starter .gitignore. */
const MINIMAL = ['# OS and editor files', 'Thumbs.db', 'ehthumbs.db', 'desktop.ini', '.DS_Store', '*.swp', '*~', '', '# Logs', '*.log', 'logs/']

const TEMPLATES: Record<Exclude<GitignoreChoice, 'none' | 'minimal'>, string[]> = {
  node: ['# Node', 'node_modules/', 'dist/', 'build/', 'out/', 'coverage/', '.cache/', '.env', '.env.*', '!.env.example', 'npm-debug.log*', 'yarn-debug.log*', 'yarn-error.log*', 'pnpm-debug.log*'],
  python: ['# Python', '__pycache__/', '*.py[cod]', '.venv/', 'venv/', 'env/', '.env', 'build/', 'dist/', '*.egg-info/', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', '.coverage', 'htmlcov/', '.ipynb_checkpoints/'],
  dotnet: ['# .NET', '[Bb]in/', '[Oo]bj/', '.vs/', '*.user', '*.suo', '*.userprefs', 'TestResults/', '[Pp]ackages/', '*.nupkg', 'artifacts/'],
  godot: ['# Godot 4', '.godot/', '/android/', '', '# Godot 3', '.import/', 'export.cfg', 'export_presets.cfg', '*.translation', '.mono/', 'data_*/', 'mono_crash.*.json']
}

/** The dialog's choices, in order. */
export const GITIGNORE_CHOICES: { value: GitignoreChoice; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'minimal', label: 'Minimal (OS files, logs)' },
  { value: 'node', label: 'Node' },
  { value: 'python', label: 'Python' },
  { value: 'dotnet', label: '.NET' },
  { value: 'godot', label: 'Godot' }
]

/** The starter .gitignore in a sentence: "a Node .gitignore". */
export function gitignoreName(choice: GitignoreChoice): string {
  return choice === 'none' ? 'no .gitignore' : choice === 'minimal' ? 'a minimal .gitignore' : `a ${GITIGNORE_CHOICES.find((c) => c.value === choice)!.label} .gitignore`
}

export function isGitignoreChoice(v: unknown): v is GitignoreChoice {
  return GITIGNORE_CHOICES.some((c) => c.value === v)
}

/** The starter .gitignore's text for a choice (null for none). Never lists .hive: git's info/exclude keeps it out (#345). */
export function gitignoreText(choice: GitignoreChoice): string | null {
  if (choice === 'none') return null
  const lines = choice === 'minimal' ? MINIMAL : [...TEMPLATES[choice], '', ...MINIMAL]
  return `${lines.join('\n')}\n`
}

/** The first commit's message. */
export const FIRST_COMMIT_MESSAGE = 'Initial commit'

/** What the dialog says before the user initialises: what will happen, and the nested repository's warning. */
export function initAbout(name: string, check: GitInitCheck): string {
  if (check.resume) return `${name} is a git repository with no commits yet, and worktrees need one. This keeps its .hive out of git and commits ${check.empty ? 'nothing yet (an empty first commit)' : 'everything in the folder'} as the first commit.${check.hasGitignore ? ' Its own .gitignore is kept.' : ''}`
  const parts = [`Makes ${name} a git repository on a branch called main, keeps its .hive out of git, and commits ${check.empty ? 'nothing yet (an empty first commit)' : 'everything in the folder'} as the first commit, so agents can work in worktrees at once.`]
  if (check.hasGitignore) parts.push('Its own .gitignore is kept.')
  if (check.parentRepo) parts.push(`It is inside the git repository in ${check.parentRepo}: a repository inside another is usually a mistake, and that one will no longer see the files here as its own.`)
  return parts.join(' ')
}

/** Why the dialog's values can't be sent yet, or null: a missing name or email is needed for the first commit. */
export function initProblem(check: GitInitCheck, v: { name: string; email: string }): string | null {
  if (!check.conditionalIdentity && !check.identity.name && !v.name.trim()) return 'Enter the name your commits are made as'
  if (!check.conditionalIdentity && !check.identity.email && !v.email.trim()) return 'Enter the email your commits are made as'
  return identityProblem(v.name, v.email)
}
