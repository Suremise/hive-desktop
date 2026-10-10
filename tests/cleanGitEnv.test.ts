// The unit tests' git environment (#425): tests/cleanGitEnv.ts is Vitest's first setup file and strips the shell's GIT_*
// variables from each worker, so neither a test's own git nor main's git helpers can reach a repository the shell points at.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { stripGitEnv } from './cleanGitEnv'

describe("the shell's GIT_* variables (#425)", () => {
  it('cleanGitEnv.ts is the first setup file, before noGlobalGit.ts sets GIT_CONFIG_GLOBAL', () => {
    const config = readFileSync(join(__dirname, '..', 'vitest.config.ts'), 'utf8')
    const setup = /setupFiles:\s*\[([^\]]*)\]/.exec(config)?.[1].match(/'[^']+'/g)?.map((s) => s.slice(1, -1))
    expect(setup?.[0]).toBe('tests/cleanGitEnv.ts')
    expect(setup).toContain('tests/noGlobalGit.ts')
  })

  it('strips every GIT_* variable, whatever its case, and nothing else', () => {
    const env: NodeJS.ProcessEnv = { GIT_DIR: 'D:\\decoy\\.git', GIT_WORK_TREE: 'D:\\decoy', git_index_file: 'D:\\decoy\\index', GIT_CONFIG_GLOBAL: 'x', PATH: 'C:\\bin', MY_GIT_THING: '1', GITHUB_TOKEN: 't' }
    expect(stripGitEnv(env).sort()).toEqual(['GIT_CONFIG_GLOBAL', 'GIT_DIR', 'GIT_WORK_TREE', 'git_index_file'])
    expect(env).toEqual({ PATH: 'C:\\bin', MY_GIT_THING: '1', GITHUB_TOKEN: 't' })
  })

  it('this worker has none of them left but the setup files’ own null global config', () => {
    expect(Object.keys(process.env).filter((k) => /^GIT_/i.test(k))).toEqual(['GIT_CONFIG_GLOBAL'])
    expect(process.env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
  })
})
