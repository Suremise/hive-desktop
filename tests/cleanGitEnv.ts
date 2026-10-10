// Unit tests' git never sees the shell's GIT_* variables (#425): a GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE left in the
// shell npm test was started from would point every git a test starts, and main's git helpers (src/main/git.ts, which
// run git with this process's environment), at another repository, and commit into it (#369). Run first of the setup
// files, in each worker before any test, so tests/noGlobalGit.ts's GIT_CONFIG_GLOBAL is set after it.

/** Deletes every GIT_* variable from `env` (any case: Windows' names are), and returns their names. */
export function stripGitEnv(env: NodeJS.ProcessEnv): string[] {
  const names = Object.keys(env).filter((k) => /^GIT_/i.test(k))
  for (const k of names) delete env[k]
  return names
}

stripGitEnv(process.env)
