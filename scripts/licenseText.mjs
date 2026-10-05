// The text steps of scripts/licenses.mjs, kept pure so tests/licenses.test.ts can check them: a licence file's text
// with one kind of line ending, and whether (and how) to write THIRD_PARTY_NOTICES.md over what is on disk (#148).

/** Text with every line ending as \n: CRLF (Windows), lone CR (old Mac) and LF alike. */
export const toLf = (text) => text.replace(/\r\n?/g, '\n')

/** A licence file's text as the notices quote it: \n endings, no blank lines around it. */
export const licenceText = (raw) => toLf(raw).trim()

/**
 * What to write over the notices file on disk (`existing`, null when there is none), or null to leave it alone: when
 * the content is the same but for line endings, so a build never rewrites it (a CRLF checkout of an LF file showed as
 * changed in git, and its timestamp moved). A real change is written with the file's own line endings: CRLF if the
 * file on disk has them (a checkout with core.autocrlf), else \n.
 */
export function noticesToWrite(text, existing) {
  const body = toLf(text)
  if (existing != null && toLf(existing) === body) return null
  return existing != null && existing.includes('\r\n') ? body.replace(/\n/g, '\r\n') : body
}
