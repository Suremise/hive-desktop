import { describe, expect, it } from 'vitest'
import { findPaths, joinPath, resolveLink, type LinkRoot } from '../src/shared/fileLinks'

const paths = (text: string) => findPaths(text).map((m) => [text.slice(m.start, m.end), m.path, m.line, m.col])

describe('file links: finding paths in terminal output', () => {
  it('finds relative paths with either slash, and names with an extension', () => {
    expect(paths('● Update(src/main/sessions.ts)')).toEqual([['src/main/sessions.ts', 'src/main/sessions.ts', undefined, undefined]])
    expect(paths('Edited src\\renderer\\App.tsx and package.json.')).toEqual([
      ['src\\renderer\\App.tsx', 'src\\renderer\\App.tsx', undefined, undefined],
      ['package.json', 'package.json', undefined, undefined]
    ])
    expect(paths('see ./docs/SPEC.md, ../other/x.md')).toEqual([
      ['./docs/SPEC.md', './docs/SPEC.md', undefined, undefined],
      ['../other/x.md', '../other/x.md', undefined, undefined]
    ])
  })

  it('takes the line and column in the usual forms', () => {
    expect(paths('FAIL tests/x.test.ts:42:7')).toEqual([['tests/x.test.ts:42:7', 'tests/x.test.ts', 42, 7]])
    expect(paths('at foo (src/a.ts:12)')).toEqual([['src/a.ts:12', 'src/a.ts', 12, undefined]])
    expect(paths('src/a.cs(10,5): error CS1002')).toEqual([['src/a.cs(10,5)', 'src/a.cs', 10, 5]])
    expect(paths('  File "tools/run.py", line 8, in main')).toEqual([['tools/run.py", line 8', 'tools/run.py', 8, undefined]])
    expect(paths('D:\\work\\app\\src\\a.ts:3')).toEqual([['D:\\work\\app\\src\\a.ts:3', 'D:\\work\\app\\src\\a.ts', 3, undefined]])
  })

  it('leaves out words, numbers, URLs and bare dots', () => {
    expect(paths('version 1.2.3 is out')).toEqual([])
    expect(paths('Thinking... done.')).toEqual([])
    expect(paths('https://github.com/x/y/blob/main/a.ts')).toEqual([])
    expect(paths('plain words only')).toEqual([])
  })
})

describe('file links: where a path leads', () => {
  const roots: LinkRoot[] = [
    { path: 'C:\\ws\\hive', project: 'C:\\ws\\hive', agentId: null },
    { path: 'C:\\ws\\web', project: 'C:\\ws\\web', agentId: null },
    { path: 'C:\\ws\\hive\\.hive\\worktrees\\two', project: 'C:\\ws\\hive', agentId: 'two' }
  ]

  it('joins and normalises', () => {
    expect(joinPath('C:\\ws\\hive', './src/../docs/x.md')).toBe('C:\\ws\\hive\\docs\\x.md')
    expect(joinPath('C:\\ws\\hive', 'D:/other/x.md')).toBe('D:\\other\\x.md')
  })

  it("an agent's relative path: its own folder", () => {
    expect(resolveLink('src/a.ts', 'C:\\ws\\hive', roots)).toEqual({ project: 'C:\\ws\\hive', agentId: null, root: 'C:\\ws\\hive', rel: 'src/a.ts' })
    expect(resolveLink('src\\a.ts', 'C:\\ws\\hive\\.hive\\worktrees\\two', roots)).toEqual({ project: 'C:\\ws\\hive', agentId: 'two', root: 'C:\\ws\\hive\\.hive\\worktrees\\two', rel: 'src/a.ts' })
  })

  it('another workspace project, and the Assistant (from the workspace)', () => {
    expect(resolveLink('..\\web\\index.html', 'C:\\ws\\hive', roots)?.project).toBe('C:\\ws\\web')
    expect(resolveLink('c:\\WS\\web\\index.html', 'C:\\ws\\hive', roots)?.rel).toBe('index.html')
    expect(resolveLink('hive/docs/SPEC.md', 'C:\\ws', roots)).toMatchObject({ project: 'C:\\ws\\hive', rel: 'docs/SPEC.md' })
  })

  it('nothing outside the projects, or in .git', () => {
    expect(resolveLink('C:\\Users\\me\\.claude\\settings.json', 'C:\\ws\\hive', roots)).toBeNull()
    expect(resolveLink('../notes.md', 'C:\\ws\\hive', roots)).toBeNull()
    expect(resolveLink('.git/config', 'C:\\ws\\hive', roots)).toBeNull()
  })
})
