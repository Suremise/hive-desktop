// The release's tested-with manifest (resources/tested-clis.json, #365): which version of each coding agent CLI this
// Hive was tested with. Made only from a real-tier e2e run record (tests/e2e/record.mjs, run-record.json), never typed
// by hand: `npm run tested-clis` (tested-clis.mjs) after `npm run e2e -- --all --real --build --record`, and
// `npm run release` refuses a manifest whose record isn't of the code being released (RELEASING.md).

import { REAL_CLIS } from '../tests/e2e/record.mjs'

/** The real CLIs of the e2e suites (`needs` in suites.mjs) and the provider each one is, by its id. */
export const CLI_PROVIDERS = REAL_CLIS

/** The manifest's file, relative to the repository. */
export const MANIFEST = 'resources/tested-clis.json'

/**
 * The manifest with what a run record shows (`current` kept for a CLI it can't vouch for): a CLI's entry is replaced
 * only when the record is valid, every real suite of that CLI ran and passed (none failed or skipped), and every one
 * of them says which of that CLI its Hive selected (the record's per-suite `clis`, from Hive's own detection), all the
 * same version. `updated` lists the provider ids replaced; `problems` says why each other one wasn't.
 */
export function manifestFromRecord(record, suites, current = {}) {
  const manifest = { ...current }
  const updated = []
  const problems = []
  if (!record || typeof record !== 'object' || !Array.isArray(record.results)) return { manifest, updated, problems: ["it isn't a run record (run-record.json)"] }
  if (!record.valid) return { manifest, updated, problems: [`the record isn't valid: ${(record.problems ?? []).join('; ') || 'it says so'}`] }
  for (const [need, { id, name }] of Object.entries(CLI_PROVIDERS)) {
    const real = suites.filter((s) => (s.needs ?? []).includes(need)).map((s) => s.name)
    const result = (n) => record.results.find((r) => r.name === n)
    const missing = real.filter((n) => !result(n))
    const notPassed = real.filter((n) => result(n) && (!result(n).ok || result(n).skipped))
    // What each suite's Hive selected of this CLI.
    const versionsOf = (n) => [...new Set((result(n)?.clis ?? []).filter((c) => c?.provider === id && typeof c.version === 'string').map((c) => c.version))]
    const unsaid = real.filter((n) => result(n) && !versionsOf(n).length)
    const versions = [...new Set(real.flatMap(versionsOf))].sort()
    const version = versions[0]
    if (missing.length === real.length) problems.push(`${name}: none of its real suites ran`)
    else if (missing.length) problems.push(`${name}: not all of its real suites ran (${missing.join(', ')} didn't)`)
    else if (notPassed.length) problems.push(`${name}: not all of its real suites passed (${notPassed.join(', ')})`)
    else if (unsaid.length) problems.push(`${name}: the record doesn't say which version Hive used in ${unsaid.join(', ')}`)
    else if (versions.length > 1) problems.push(`${name}: its real suites ran different versions (${versions.join(', ')})`)
    else {
      manifest[id] = { version, testedAt: String(record.when ?? '').slice(0, 10), record: record.code }
      updated.push(id)
    }
  }
  return { manifest, updated, problems }
}

/**
 * Why the manifest isn't of the code being released, or null: each entry must come from a record of a commit (not of
 * uncommitted changes) that differs from HEAD in nothing but the manifest itself. `changedSince(commit)` lists the
 * files changed from that commit to HEAD, or null when git doesn't know the commit.
 */
export function manifestStale(manifest, changedSince) {
  const entries = Object.entries(CLI_PROVIDERS).map(([, p]) => [p, manifest?.[p.id]])
  const missing = entries.filter(([, e]) => !e?.version).map(([p]) => p.name)
  if (missing.length) return `it has no tested version for ${missing.join(' and ')}`
  for (const [p, e] of entries) {
    if (!/^[0-9a-f]{7,40}$/.test(String(e.record ?? ''))) return `${p.name}'s entry comes from a run on uncommitted changes (${e.record})`
    const changed = changedSince(e.record)
    if (!changed) return `${p.name}'s entry comes from a commit git doesn't know (${e.record})`
    const other = changed.filter((f) => f !== MANIFEST)
    if (other.length) return `${p.name}'s entry was tested on ${e.record}, and ${other.length} file${other.length === 1 ? ' has' : 's have'} changed since (${other.slice(0, 3).join(', ')}${other.length > 3 ? ', …' : ''})`
  }
  return null
}
