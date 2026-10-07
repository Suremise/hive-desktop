/** What this needs of the page's document (named here, so the unit tests, which have none, can give their own). */
interface FocusDocument {
  readonly activeElement: unknown
  readonly body: unknown
  addEventListener(type: 'keydown' | 'pointerdown', listener: (e: { isTrusted: boolean }) => void, capture: boolean): void
}
/** An element a focus is for: what is in it already has the keyboard where the focus would put it. */
interface FocusTarget {
  contains(node: unknown): boolean
}
const page = (): FocusDocument | undefined => (globalThis as { document?: FocusDocument }).document

/** Choices of where the keyboard goes: the user's key and pointer presses, and each agent shown (flashPane). */
let choices = 0
let listening = false

function listen(): void {
  const doc = page()
  if (listening || !doc) return
  listening = true
  const chose = (e: { isTrusted: boolean }): void => {
    if (e.isTrusted) choices++
  }
  // Capture, so a press counts before what it does (a Show button's click) asks for a focus of its own.
  doc.addEventListener('keydown', chose, true)
  doc.addEventListener('pointerdown', chose, true)
}

/** A newer choice of where the keyboard goes than any deferred focus asked for until now (an agent shown). */
export function chooseFocus(): void {
  listen()
  choices++
}

/**
 * A focus done later (a timer, the next frame) applies only while it is still the latest choice (#327): no key or pointer
 * press and no other agent shown since it was asked for, and the keyboard still where it was then, on nothing, or
 * already in `target` (a dialog that took it meanwhile keeps it). Returns whether it may focus now.
 */
export function deferredFocus(target: () => FocusTarget | null | undefined): () => boolean {
  listen()
  const asked = choices
  const from = page()?.activeElement
  return () => {
    if (choices !== asked) return false
    const now = page()?.activeElement
    return !now || now === page()?.body || now === from || !!target()?.contains(now)
  }
}
