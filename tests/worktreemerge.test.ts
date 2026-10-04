// Merge… with the repo's own .gitattributes: two worktree branches that each add a CHANGELOG entry at the top of
// Unreleased merge one after the other with no conflict (merge-tree's check and both kinds of merge), both entries kept.
import { execFileSync } from 'child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorktree, mergeWorktree } from '../src/main/worktrees'

const CHANGELOG = '# Changelog\n\n## Unreleased\n\n- Earlier entry.\n\n## 0.3.1\n\n- Released.\n'
const run = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })
let root = ''

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
})

async function twoBranches(): Promise<{ project: string; a: { path: string; branch: string; base: string }; b: { path: string; branch: string; base: string } }> {
  root = mkdtempSync(join(tmpdir(), 'hive-merge-'))
  const project = join(root, 'project')
  run(root, 'init', '-q', '-b', 'main', project)
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) run(project, 'config', k, v)
  copyFileSync(join(__dirname, '..', '.gitattributes'), join(project, '.gitattributes'))
  writeFileSync(join(project, 'CHANGELOG.md'), CHANGELOG)
  run(project, 'add', '-A')
  run(project, 'commit', '-qm', 'base')
  const a = { path: join(root, 'wt', 'a'), branch: 'hive/a', base: 'main' }
  const b = { path: join(root, 'wt', 'b'), branch: 'hive/b', base: 'main' }
  for (const [wt, entry] of [[a, '- Entry from A.'], [b, '- Entry from B.']] as const) {
    await createWorktree(project, wt.path, wt.branch, 'main')
    writeFileSync(join(wt.path, 'CHANGELOG.md'), CHANGELOG.replace('- Earlier entry.', `${entry}\n- Earlier entry.`))
    run(wt.path, 'commit', '-qam', wt.branch)
  }
  return { project, a, b }
}

describe('merging CHANGELOG entries from two branches', () => {
  for (const squash of [false, true]) {
    it(`keeps both, with no conflict (${squash ? 'squash' : 'merge commit'})`, async () => {
      const { project, a, b } = await twoBranches()
      expect(await mergeWorktree(project, a, { squash, message: 'A' })).toEqual({ ok: true })
      expect(await mergeWorktree(project, b, { squash, message: 'B' })).toEqual({ ok: true })
      const text = readFileSync(join(project, 'CHANGELOG.md'), 'utf8')
      expect(text).toContain('- Entry from A.\n- Entry from B.\n- Earlier entry.\n')
      expect(run(project, 'status', '--porcelain')).toBe('')
    })
  }
})
