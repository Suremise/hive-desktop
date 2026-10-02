/**
 * What a number setting's box holds when it is committed (blur or Enter). A blank box is an unfinished edit
 * (or, where the setting can inherit, a request to inherit), never 0: 0 turns some features off, and that is
 * chosen with their Off option instead.
 */
export type NumberDraft = { kind: 'blank' } | { kind: 'value'; value: number } | { kind: 'invalid'; message: string }

export interface NumberRange {
  min?: number
  max?: number
}

const fmt = (n: number): string => n.toLocaleString('en-US')

/** The range in words: "Between 1,000 and 100,000", "1 or more". */
export function rangeText({ min, max }: NumberRange): string {
  if (min !== undefined && max !== undefined) return `Between ${fmt(min)} and ${fmt(max)}`
  if (min !== undefined) return `${fmt(min)} or more`
  if (max !== undefined) return `${fmt(max)} or less`
  return 'A number'
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
  if (opts.badInput || !t || !Number.isFinite(n)) return { kind: 'invalid', message: `Enter a number. ${rangeText(range)}.` }
  const value = Math.round(n)
  if (value === 0 && opts.off) return { kind: 'value', value }
  if ((range.min !== undefined && value < range.min) || (range.max !== undefined && value > range.max)) return { kind: 'invalid', message: `${rangeText(range)}.` }
  return { kind: 'value', value }
}
