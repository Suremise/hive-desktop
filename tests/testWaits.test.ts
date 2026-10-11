// `npm run test:waits` (#524): a fixed sleep a check follows, with no comment saying why, is found; one whose check
// itself waits for its condition, or with a comment, is not. The samples build the word so this file isn't one.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: plain .mjs modules without types
import { findWaits } from '../scripts/testWaits.mjs'

const ctx = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }
const S = ['sle', 'ep'].join('')
const T = ['setTime', 'out'].join('')
const lines = (...l: string[]): string => l.join('\r\n')

describe('test waits (#524)', () => {
  it('finds a sleep a check follows, and where', () => {
    const found = findWaits(lines('  await click()', `  await lib.${S}(500)`, '  const n = await rows.count()', "  check('three rows', n === 3)"))
    expect(found).toEqual([{ line: 2, code: `await lib.${S}(500)`, commented: false }])
  })

  it('finds the other forms: a promise around setTimeout, waitForTimeout, a sleep on the line of the action', () => {
    expect(findWaits(lines(`  await new Promise((r) => ${T}(r, 300))`, '  expect(seen).toHaveLength(1)'))).toHaveLength(1)
    expect(findWaits(lines(`  await page.waitFor${T.slice(3)}(800)`, "  check('open', ok)"))).toHaveLength(1)
    expect(findWaits(lines(`  await btn.click(); await ${S}(400)`, "  check('done', await done())"))).toHaveLength(1)
  })

  it('marks a sleep with a comment beside or above it as meant', () => {
    expect(findWaits(lines(`  await lib.${S}(4000) // on purpose: no second line comes`, "  check('one line', n === 1)"))[0].commented).toBe(true)
    expect(findWaits(lines('  // Nothing to observe: the absence of a wake is the point.', `  await lib.${S}(4000)`, "  check('one line', n === 1)"))[0].commented).toBe(true)
  })

  it('leaves a sleep whose next check waits for its condition, one with no check after it, and the helper itself', () => {
    expect(findWaits(lines(`  await lib.${S}(300)`, "  check('opens', !!(await lib.until(async () => (await dlg.count()) === 1, 5000)))"))).toEqual([])
    expect(findWaits(lines(`  await ${S}(300)`, '  await expect.poll(() => n).toBe(1)'))).toEqual([])
    expect(findWaits(lines(`  await lib.${S}(300)`, '  await page.keyboard.type(text)', '  await page.keyboard.press("Enter")', '  await other()', "  check('late', ok)"))).toEqual([])
    expect(findWaits(lines(`const ${S} = (ms) => new Promise((r) => ${T}(r, ms))`, '  expect(1).toBe(1)'))).toEqual([])
  })

  it("doesn't let a later check's wait cover the check the sleep is for", () => {
    const found = findWaits(lines(`  await ${S}(500)`, "  check('saved', saved)", "  check('dialog', await lib.until(() => open, 1000))"))
    expect(found).toEqual([{ line: 1, code: `await ${S}(500)`, commented: false }])
  })

  it('finds a short sleep too: only a comment says why it is meant', () => {
    expect(findWaits(lines(`  await ${S}(5)`, "  check('ready', ready)"))).toHaveLength(1)
    expect(findWaits(lines(`  await new Promise((r) => ${T}(r, 5)) // later timestamps differ`, '  expect(b.at).toBeGreaterThan(a.at)'))[0].commented).toBe(true)
  })

  it("takes a polling loop's own pause for the poll it is: a loop that polls state and the check after it", () => {
    const poll = ['  const end = Date.now() + 5000', '  while (Date.now() < end) {', "    if (fs.existsSync(file) && read().includes('hello')) break", `    await new Promise((r) => ${T}(r, 10))`, '  }', '  assert.match(read(), /hello/)']
    expect(findWaits(lines(...poll))).toEqual([])
    expect(findWaits(lines('  for (let i = 0; i < 50; i++) {', '    if (done()) break', `    await ${S}(20)`, '  }', "  check('done', done())"))).toEqual([])
    expect(findWaits(lines(`  while (!done()) await ${S}(20)`, "  check('done', done())"))).toEqual([])
    expect(findWaits(lines('  do {', `    await ${S}(20)`, '  } while (!(await done()))', "  check('done', await done())"))).toEqual([])
  })

  it('finds a sleep in a loop that only repeats actions, counted or timed, whether its check is in the loop or after it', () => {
    const counted = (...after: string[]): string[] => ['  for (let i = 0; i < 3; i++) {', '    await button.click()', `    await ${S}(500)`, ...after]
    expect(findWaits(lines(...counted("    check('open', open)", '  }')))).toHaveLength(1)
    expect(findWaits(lines(...counted('  }', "  check('open', open)")))).toHaveLength(1)
    expect(findWaits(lines('  for (const b of buttons) {', '    await b.click()', `    await ${S}(300)`, '  }', "  check('all on', allOn())"))).toHaveLength(1)
    expect(findWaits(lines('  const end = Date.now() + 2000', '  while (Date.now() < end) {', '    await type(key)', `    await ${S}(100)`, '  }', "  check('typed', typed())"))).toHaveLength(1)
    expect(findWaits(lines(`  for (let i = 0; i < 5; i++) await ${S}(100)`, "  check('done', done())"))).toHaveLength(1)
    // A polling loop whose check sits in its body, after the pause, reads once after a fixed time all the same.
    expect(findWaits(lines('  while (!done()) {', `    await ${S}(20)`, "    check('step', step())", '  }'))).toHaveLength(1)
  })

  it("ignores what a string says: a test's text naming a sleep or a check isn't one", () => {
    expect(findWaits(lines(`  const sample = 'await page.waitFor${T.slice(3)}(500)'`, '  expect(scan(sample)).toHaveLength(1)'))).toEqual([])
    expect(findWaits(lines(`  await lib.${S}(300)`, '  const label = "check(it)"', '  log(label)'))).toEqual([])
  })

  it("fails when it can't compare with the base: nothing was checked", () => {
    const run = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'testWaits.mjs'), '--base', 'no-such-ref-524'], { encoding: 'utf8', env: ctx.baseEnv() })
    expect(run.status).toBe(2)
    expect(run.stderr).toMatch(/Can't compare with no-such-ref-524/)
  })
})
