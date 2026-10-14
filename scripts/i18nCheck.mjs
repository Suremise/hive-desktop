// The blocking check of the translations (#768): `npm run i18n:check` fails (exit 1) on a translation that would show
// wrong, never on one that is missing (a missing message shows in English: `npm run i18n:coverage` reports those):
//   - an extra key: an id the English catalogue doesn't have (renamed or removed in the code);
//   - a message that isn't valid ICU, or whose structure differs from the English: a placeholder renamed or dropped
//     ({name} → {nazwa}), a plural without `other`, a tag that isn't the English's;
//   - a file that isn't an object of texts, or a message filed under another area's file.
// It runs `formatjs verify --source-locale en --extra-keys --structural-equality` (without --missing-keys) once per
// language, over every area's English (locales/en/<area>.json) and that language's files (locales/<code>/<area>.json).
// Where FormatJS's CLI has no native binding (Windows on Arm), or with --js, the same checks run here with FormatJS's
// own parser. tests/i18nCatalogues.test.ts runs this in `npm test` and CI, and checks the two ways agree.
import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { isStructurallySame, parse } from '@formatjs/icu-messageformat-parser'
import { areaOf, cliBin, EN_DIR, hasNativeCli, ROOT, rootArg } from './i18nExtract.mjs'

/** The languages with a folder in locales/, English and .source aside. */
export const translatedLanguages = (root = ROOT) =>
  existsSync(join(root, 'locales'))
    ? readdirSync(join(root, 'locales'), { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== 'en' && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort()
    : []

/** The English messages, every area merged: id → its English. */
export function englishMessages(root = ROOT) {
  const out = {}
  const dir = join(root, EN_DIR)
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort())
    for (const [id, m] of Object.entries(JSON.parse(readFileSync(join(dir, f), 'utf8')))) out[id] = m.defaultMessage
  return out
}

/** A language's translations, every area merged, and what's wrong with its files themselves (not an object, not text, a message in another area's file). */
export function readLanguage(root, code) {
  const messages = {}
  const problems = []
  const dir = join(root, 'locales', code)
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    let data
    try {
      data = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    } catch (e) {
      problems.push(`${code}/${f}: not JSON (${String(e.message).split(/\r?\n/)[0]})`)
      continue
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      problems.push(`${code}/${f}: not an object of messages (id → text)`)
      continue
    }
    const area = f.slice(0, -'.json'.length)
    for (const [id, text] of Object.entries(data)) {
      if (typeof text !== 'string') problems.push(`${code}/${f}: ${id} is not text`)
      else if (areaOf(id) !== area) problems.push(`${code}/${f}: ${id} belongs in ${code}/${areaOf(id)}.json`)
      else messages[id] = text
    }
  }
  return { messages, problems }
}

/** The checks with FormatJS's parser, as `formatjs verify --extra-keys --structural-equality` makes them. */
export function verifyWithJs(english, translated) {
  const problems = []
  for (const id of Object.keys(translated)) if (!(id in english)) problems.push(`${id}: an extra key (the English has no such message)`)
  for (const [id, source] of Object.entries(english)) {
    // An empty translation is a missing one: it shows in English.
    if (!translated[id]) continue
    try {
      const r = isStructurallySame(parse(source), parse(translated[id]))
      if (!r.success) problems.push(`${id}: ${r.error?.message ?? 'structurally different from the English'}`)
    } catch (e) {
      problems.push(`${id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return problems
}

/** The same checks by `formatjs verify`: each problem as a line of its report. */
export function verifyWithCli(code, english, translated) {
  const dir = mkdtempSync(join(tmpdir(), 'hive-i18n-check-'))
  try {
    writeFileSync(join(dir, 'en.json'), JSON.stringify(english))
    writeFileSync(join(dir, `${code}.json`), JSON.stringify(translated))
    // Relative names: verify takes each file's locale from its name, and its file patterns are globs, which a Windows path breaks.
    const r = spawnSync(process.execPath, [cliBin(), 'verify', '--source-locale', 'en', '--extra-keys', '--structural-equality', 'en.json', `${code}.json`], { cwd: dir, encoding: 'utf8' })
    if (r.status === 0) return []
    const lines = `${r.stderr}\n${r.stdout}`.split(/\r?\n/).filter((l) => l.trim() && !/^-+$/.test(l.trim()))
    return lines.length ? lines : [`formatjs verify failed (exit ${r.status})`]
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Every language's problems (code → lines), and which way they were checked. */
export function checkTranslations(root = ROOT, { js = !hasNativeCli() } = {}) {
  const english = englishMessages(root)
  const results = {}
  for (const code of translatedLanguages(root)) {
    const { messages, problems } = readLanguage(root, code)
    results[code] = [...problems, ...(js ? verifyWithJs(english, messages) : verifyWithCli(code, english, messages))]
  }
  return { results, engine: js ? 'js' : 'cli' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { results, engine } = checkTranslations(rootArg(), process.argv.includes('--js') ? { js: true } : undefined)
  let failed = false
  for (const [code, problems] of Object.entries(results)) {
    if (!problems.length) {
      console.log(`${code}: ok`)
      continue
    }
    failed = true
    console.log(`${code}: ${problems.length} to fix (they show in English until fixed)\n  ${problems.join('\n  ')}`)
  }
  console.log(`i18n:check: languages ${Object.keys(results).join(', ') || 'none'}, checked with ${engine === 'cli' ? 'formatjs verify' : "FormatJS's parser"}${failed ? '; FAILED' : ''}`)
  process.exit(failed ? 1 : 0)
}
