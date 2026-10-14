/**
 * What a number setting's box holds when it is committed (blur or Enter). A blank box is an unfinished edit
 * (or, where the setting can inherit, a request to inherit), never 0: 0 turns some features off, and that is
 * chosen with their Off option instead.
 */
import { msg, tr } from './i18n'
export type NumberDraft = { kind: 'blank' } | { kind: 'value'; value: number } | { kind: 'invalid'; message: string }

/** The range's words (#767): shown when a box is committed, in the user's language. */
const RANGE = {
  between: msg({ id: 'settings.number.between', defaultMessage: 'Between {min, number} and {max, number}', description: "Under a number setting's box whose value is out of range. {min} and {max} are numbers." }),
  atLeast: msg({ id: 'settings.number.atLeast', defaultMessage: '{min, number} or more', description: "Under a number setting's box whose value is too small. {min} is a number." }),
  atMost: msg({ id: 'settings.number.atMost', defaultMessage: '{max, number} or less', description: "Under a number setting's box whose value is too big. {max} is a number." }),
  any: msg({ id: 'settings.number.any', defaultMessage: 'A number', description: "Under a number setting's box, when it takes any number." }),
  notNumber: msg({ id: 'settings.number.notNumber', defaultMessage: 'Enter a number. {range}.', description: "Under a number setting's box when what was typed isn't a number. {range} is the range it takes (\"Between 1,000 and 100,000\")." }),
  outOfRange: msg({ id: 'settings.number.outOfRange', defaultMessage: '{range}.', description: "Under a number setting's box when the number is out of range. {range} is the range (\"Between 1,000 and 100,000\"); keep the full stop as your language ends a sentence." })
}

export interface NumberRange {
  min?: number
  max?: number
}

/** The range in words, in the user's language: "Between 1,000 and 100,000", "1 or more". */
export function rangeText({ min, max }: NumberRange): string {
  if (min !== undefined && max !== undefined) return tr(RANGE.between, { min, max })
  if (min !== undefined) return tr(RANGE.atLeast, { min })
  if (max !== undefined) return tr(RANGE.atMost, { max })
  return tr(RANGE.any)
}

/**
 * Reads a draft. `badInput` is the box's validity.badInput: a number box reports text it can't read as "",
 * which must not count as blank. `off` means 0 is the setting's Off value, which is in range even when `min`
 * is above it.
 */
export function parseNumberDraft(draft: string, range: NumberRange, opts: { badInput?: boolean; off?: boolean } = {}): NumberDraft {
  const t = draft.trim()
  if (!t && !opts.badInput) return { kind: 'blank' }
  const n = Number(t)
  if (opts.badInput || !t || !Number.isFinite(n)) return { kind: 'invalid', message: tr(RANGE.notNumber, { range: rangeText(range) }) }
  const value = Math.round(n)
  if (value === 0 && opts.off) return { kind: 'value', value }
  if ((range.min !== undefined && value < range.min) || (range.max !== undefined && value > range.max)) return { kind: 'invalid', message: tr(RANGE.outOfRange, { range: rangeText(range) }) }
  return { kind: 'value', value }
}
