// A focus done later (Show agent's flash, a terminal shown) yields to a newer choice of where the keyboard goes (#327):
// the user pressing a key or clicking meanwhile, another agent shown, or something else taking the keyboard.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/** An element of the stub document: it contains itself and the elements given. */
type El = { name: string; contains: (x: unknown) => boolean }
function make(name: string, inside: El[] = []): El {
  const e: El = { name, contains: (x) => x === e || inside.includes(x as El) }
  return e
}

const body = make('body')
const listeners: Record<string, ((e: { isTrusted: boolean }) => void)[]> = {}
const doc = {
  body,
  activeElement: body as El | null,
  addEventListener: (type: string, fn: (e: { isTrusted: boolean }) => void) => (listeners[type] ??= []).push(fn)
}
const press = (type: 'keydown' | 'pointerdown', isTrusted = true): void => listeners[type]?.forEach((fn) => fn({ isTrusted }))

let mod: typeof import('../src/renderer/src/deferredFocus')
beforeAll(async () => {
  ;(globalThis as { document?: unknown }).document = doc
  mod = await import('../src/renderer/src/deferredFocus')
})
afterAll(() => {
  delete (globalThis as { document?: unknown }).document
})

describe('a deferred focus', () => {
  const textarea = make('textarea')
  const terminal = make('terminal', [textarea])
  const show = make('show-button')
  const details = make('details-toggle')
  const dialog = make('dialog-input')

  it('applies while nothing newer happened: focus where it was, on nothing, or already in its target', () => {
    doc.activeElement = show
    const current = mod.deferredFocus(() => terminal)
    expect(current()).toBe(true)
    doc.activeElement = body
    expect(current()).toBe(true)
    doc.activeElement = textarea
    expect(current()).toBe(true)
  })

  it('yields to a key or pointer press made after it was asked for, not to one before or a synthetic one', () => {
    doc.activeElement = show
    press('keydown')
    const current = mod.deferredFocus(() => terminal)
    press('keydown', false)
    expect(current()).toBe(true)
    // The user tabs or clicks to the details toggle meanwhile: its Escape is theirs.
    press('pointerdown')
    doc.activeElement = details
    expect(current()).toBe(false)
    const keyed = mod.deferredFocus(() => terminal)
    press('keydown')
    expect(keyed()).toBe(false)
  })

  it('yields to another control that took the keyboard meanwhile (a dialog opening)', () => {
    doc.activeElement = show
    const current = mod.deferredFocus(() => terminal)
    doc.activeElement = dialog
    expect(current()).toBe(false)
  })

  it('a newer agent shown supersedes an older one still waiting', () => {
    doc.activeElement = show
    mod.chooseFocus()
    const older = mod.deferredFocus(() => terminal)
    mod.chooseFocus()
    const newer = mod.deferredFocus(() => terminal)
    expect(older()).toBe(false)
    expect(newer()).toBe(true)
  })
})
