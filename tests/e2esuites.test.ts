// The e2e suite list (tests/e2e/run.mjs): sorted by name, so suites added on different branches don't conflict,
// and each one names a suite that exists. Read as text: importing run.mjs would run the suites.
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const dir = join(__dirname, 'e2e')
const source = readFileSync(join(dir, 'run.mjs'), 'utf8')
const list = /const SUITES = \[\r?\n([\s\S]*?)\r?\n\]/.exec(source)?.[1] ?? ''
const names = [...list.matchAll(/^\s*\{ name: '([^']+)'/gm)].map((m) => m[1])

describe('the e2e suite list', () => {
  it('is sorted by name, without repeats', () => {
    expect(names.length).toBeGreaterThan(50)
    expect(names.length, 'a suite line the test could not read').toBe(list.split(/\r?\n/).filter((l) => l.trim()).length)
    expect(names).toEqual([...names].sort())
    expect(new Set(names).size).toBe(names.length)
  })

  it('names suites that exist', () => {
    for (const n of names) expect(existsSync(join(dir, `${n}.cjs`)), n).toBe(true)
  })
})
