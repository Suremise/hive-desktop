// THIRD_PARTY_NOTICES.md's text steps (scripts/licenseText.mjs): a build leaves an unchanged notice alone, whatever the
// line endings of the licence files it quotes or of the checkout (#148).
import { describe, expect, it } from 'vitest'
// @ts-expect-error: a plain .mjs module without types
import { licenceText, noticesToWrite, toLf } from '../scripts/licenseText.mjs'

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
