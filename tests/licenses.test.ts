// THIRD_PARTY_NOTICES.md's text steps (scripts/licenseText.mjs): a build leaves an unchanged notice alone, whatever the
// line endings of the licence files it quotes or of the checkout (#148); and the committed file is up to date with what
// ships (#386), so a dependency change merged without `npm run licenses` fails here, in CI.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: a plain .mjs module without types
import { licenceText, noticesDrift, noticesToWrite, staleNoticesMessage, toLf } from '../scripts/licenseText.mjs'
// @ts-expect-error: a plain .mjs module without types
import { generateNotices } from '../scripts/thirdPartyNotices.mjs'
import { tempDir } from './tempDir'

const repo = join(__dirname, '..')

describe('the notices text (scripts/licenseText.mjs)', () => {
  const lines = ['MIT License', '', 'Copyright (c) 2026 Someone', '', 'Permission is hereby granted…']

  it('quotes a licence file the same whether it has CRLF, LF, lone CR or mixed endings', () => {
    const want = lines.join('\n')
    for (const raw of [lines.join('\r\n'), lines.join('\n'), lines.join('\r'), `${lines[0]}\r\n${lines[1]}\n${lines[2]}\r${lines[3]}\r\n${lines[4]}\n`, `\r\n\n${lines.join('\r\n')}\r\n\r\n`])
      expect(licenceText(raw), JSON.stringify(raw.slice(0, 40))).toBe(want)
    expect(toLf('a\r\nb\rc\nd')).toBe('a\nb\nc\nd')
  })

  it('leaves the file alone when only line endings differ, as in a CRLF checkout of the LF file', () => {
    const text = `# Third-party notices\n\n${lines.join('\n')}\n`
    expect(noticesToWrite(text, text)).toBeNull()
    expect(noticesToWrite(text, text.replace(/\n/g, '\r\n'))).toBeNull()
    expect(noticesToWrite(text.replace(/\n/g, '\r\n'), text)).toBeNull()
  })

  it('writes a real change with the endings of the file on disk, and \\n for a new file', () => {
    const text = '# Third-party notices\n\n| react | 19.1.0 | MIT |\n'
    const old = '# Third-party notices\r\n\r\n| react | 19.0.0 | MIT |\r\n'
    expect(noticesToWrite(text, old)).toBe(text.replace(/\n/g, '\r\n'))
    expect(noticesToWrite(text, toLf(old))).toBe(text)
    expect(noticesToWrite(text, null)).toBe(text)
  })
})

describe('the committed notices are up to date (#386)', () => {
  it('THIRD_PARTY_NOTICES.md matches what scripts/licenses.mjs makes from the installed packages', () => {
    const { text } = generateNotices(repo)
    const drift = noticesDrift(text, readFileSync(join(repo, 'THIRD_PARTY_NOTICES.md'), 'utf8'))
    expect(drift && staleNoticesMessage(drift)).toBeNull()
  })

  it('finds a dependency whose version changed, one added and one gone, and says to regenerate', () => {
    const root = tempDir('hive-notices-')
    try {
      const pkg = (name: string, version: string, licence = 'MIT') => {
        mkdirSync(join(root, 'node_modules', name), { recursive: true })
        writeFileSync(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version, license: licence }))
        writeFileSync(join(root, 'node_modules', name, 'LICENSE'), `${licence} licence of ${name}\r\n`)
      }
      const deps = (names: string[]) => writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: Object.fromEntries(names.map((n) => [n, '*'])) }))
      const notices = join(repo, 'scripts', 'notices')
      pkg('alpha', '1.0.0')
      pkg('gamma', '3.0.0')
      deps(['alpha', 'gamma'])
      const committed = generateNotices(root, notices).text.replace(/\n/g, '\r\n')
      expect(noticesDrift(generateNotices(root, notices).text, committed)).toBeNull()

      pkg('alpha', '1.1.0')
      pkg('beta', '2.0.0')
      deps(['alpha', 'beta'])
      const drift = noticesDrift(generateNotices(root, notices).text, committed)
      expect(drift).toEqual({ packages: ['alpha 1.0.0 → 1.1.0', 'gone: gamma 3.0.0', 'new: beta 2.0.0'] })
      expect(staleNoticesMessage(drift)).toBe(
        'THIRD_PARTY_NOTICES.md is out of date: run `npm run licenses` and commit it. Changed: alpha 1.0.0 → 1.1.0; gone: gamma 3.0.0; new: beta 2.0.0.'
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails on a stale file whose packages are the same (a licence text changed), and on a missing file', () => {
    const text = '# Third-party notices\n\n| Package | Version | Licence |\n|---|---|---|\n| [react](https://github.com/facebook/react) | 19.1.0 | MIT |\n\nMIT licence\n'
    const drift = noticesDrift(text, text.replace('MIT licence', 'MIT licence, old'))
    expect(drift).toEqual({ packages: [] })
    expect(staleNoticesMessage(drift)).toBe('THIRD_PARTY_NOTICES.md is out of date: run `npm run licenses` and commit it.')
    expect(noticesDrift(text, null)).toEqual({ packages: ['new: react 19.1.0'] })
    expect(noticesDrift(text, text.replace(/\n/g, '\r\n'))).toBeNull()
  })
})
